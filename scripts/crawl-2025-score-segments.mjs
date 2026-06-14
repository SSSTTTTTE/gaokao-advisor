#!/usr/bin/env node

import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { Client } from "pg";
import { PDFParse } from "pdf-parse";

const DEFAULT_DSN = "postgresql://gaokao:gaokao@localhost:5432/gaokao_vault";
const DSN = process.env.GAOKAO_VAULT_DATABASE_URL || process.env.GAOKAO_DB__DSN || DEFAULT_DSN;
const YEAR = 2025;

const SOURCES = [
  {
    provinceName: "天津",
    subjectTrack: "综合改革",
    title: "天津市2025年普通高考总成绩分数档（含政策加分）",
    url:
      "https://cdn.zizzs.com/zixunzhan/1750669778784%E5%A4%A9%E6%B4%A5%E4%B8%80%E5%88%86%E4%B8%80%E6%AE%B5%E8%A1%A8.pdf",
    publisher: "天津市教育招生考试院",
    parser: "tianjinPdf",
  },
  {
    provinceName: "江西",
    subjectTrack: "物理类+历史类",
    title: "2025江西高考一分一段表（物理类+历史类）",
    url: "https://www.dxsbb.com/news/117667.html",
    publisher: "大学生必备网转载整理",
    parser: "jiangxiDxsbbHtml",
  },
];

function compact(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function asInteger(value) {
  const match = String(value ?? "").replace(/,/g, "").match(/\d+/);
  return match ? Number(match[0]) : null;
}

function contentHash(row, source) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        provinceName: source.provinceName,
        year: YEAR,
        subjectTrack: row.subjectTrack,
        score: row.score,
        segmentCount: row.segmentCount,
        cumulativeCount: row.cumulativeCount,
        sourceUrl: source.url,
      }),
    )
    .digest("hex");
}

async function fetchBuffer(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X) gaokao-major-advisor/1.0 score-segment-crawler",
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X) gaokao-major-advisor/1.0 score-segment-crawler",
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.text();
}

async function pdfText(url) {
  const parser = new PDFParse({ data: await fetchBuffer(url) });
  try {
    const result = await parser.getText();
    return result.text;
  } finally {
    await parser.destroy();
  }
}

function parseTianjinPdfText(text, source) {
  const rows = [];
  let previousCumulative = 0;

  for (const rawLine of text.split(/\n+/)) {
    const line = compact(rawLine);
    const match = line.match(/^(\d{3})(?:\s+及以上)?\s+(\d+)\s+(\d+)/);
    if (!match) continue;

    const score = Number(match[1]);
    const segmentCount = Number(match[2]);
    let cumulativeCount = Number(match[3]);
    const expectedCumulative = previousCumulative + segmentCount;

    if (cumulativeCount > 200_000 && String(cumulativeCount).startsWith(String(expectedCumulative))) {
      cumulativeCount = expectedCumulative;
    }

    if (
      score < 100 ||
      score > 750 ||
      segmentCount <= 0 ||
      cumulativeCount <= 0 ||
      cumulativeCount < previousCumulative
    ) {
      continue;
    }

    rows.push({
      subjectTrack: source.subjectTrack,
      score,
      segmentCount,
      cumulativeCount,
      source,
    });
    previousCumulative = cumulativeCount;
  }

  return rows;
}

function decodeHtml(value) {
  return String(value ?? "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

function stripTags(value) {
  return compact(decodeHtml(String(value ?? "").replace(/<[^>]+>/g, " ")));
}

function parseDxsbbTable(tableHtml, subjectTrack, source) {
  const rows = [];
  for (const rowMatch of tableHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = Array.from(rowMatch[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)).map((cell) =>
      stripTags(cell[1]),
    );
    if (cells.length < 3 || cells[0].includes("分数")) continue;

    const score = asInteger(cells[0]);
    const segmentCount = asInteger(cells[1]);
    const cumulativeCount = asInteger(cells[2]);
    if (!score || !segmentCount || !cumulativeCount) continue;

    rows.push({
      subjectTrack,
      score,
      segmentCount,
      cumulativeCount,
      source,
    });
  }
  return rows;
}

function parseJiangxiHtml(html, source) {
  const tables = Array.from(html.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi)).map((match) => match[0]);
  if (tables.length < 2) {
    throw new Error(`Expected at least 2 score segment tables, found ${tables.length}`);
  }

  return [
    ...parseDxsbbTable(tables[0], "物理类", source),
    ...parseDxsbbTable(tables[1], "历史类", source),
  ];
}

async function parseSource(source) {
  if (source.parser === "tianjinPdf") return parseTianjinPdfText(await pdfText(source.url), source);
  if (source.parser === "jiangxiDxsbbHtml") return parseJiangxiHtml(await fetchText(source.url), source);
  return [];
}

async function idForName(client, table, name) {
  const result = await client.query(`SELECT id FROM ${table} WHERE name = $1 LIMIT 1`, [name]);
  if (!result.rows[0]) throw new Error(`Missing ${table} row for ${name}`);
  return result.rows[0].id;
}

async function upsertRows(client, rows, source) {
  const provinceId = await idForName(client, "provinces", source.provinceName);
  const subjectIds = new Map();

  let count = 0;
  for (const row of rows) {
    if (!subjectIds.has(row.subjectTrack)) {
      subjectIds.set(row.subjectTrack, await idForName(client, "subject_categories", row.subjectTrack));
    }
    await client.query(
      `
        INSERT INTO score_segments (
          province_id,
          year,
          subject_category_id,
          score,
          segment_count,
          cumulative_count,
          content_hash,
          crawl_task_id,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, NOW())
        ON CONFLICT (province_id, year, subject_category_id, score)
        DO UPDATE SET
          segment_count = EXCLUDED.segment_count,
          cumulative_count = EXCLUDED.cumulative_count,
          content_hash = EXCLUDED.content_hash,
          updated_at = NOW()
      `,
      [
        provinceId,
        YEAR,
        subjectIds.get(row.subjectTrack),
        row.score,
        row.segmentCount,
        row.cumulativeCount,
        contentHash(row, source),
      ],
    );
    count += 1;
  }

  return count;
}

function selectedSources() {
  const filter = compact(process.env.GAOKAO_SCORE_SEGMENT_FILTER || process.env.GAOKAO_SOURCE_FILTER);
  if (!filter) return SOURCES;
  return SOURCES.filter((source) => `${source.provinceName} ${source.subjectTrack} ${source.title}`.includes(filter));
}

async function main() {
  const client = new Client({ connectionString: DSN });
  await client.connect();

  const summary = [];
  for (const source of selectedSources()) {
    try {
      const rows = await parseSource(source);
      const count = await upsertRows(client, rows, source);
      summary.push({
        province: source.provinceName,
        subject: source.subjectTrack,
        rows: count,
        minScore: Math.min(...rows.map((row) => row.score)),
        maxScore: Math.max(...rows.map((row) => row.score)),
        maxRank: Math.max(...rows.map((row) => row.cumulativeCount)),
      });
      console.log(`OK ${source.provinceName} ${source.subjectTrack}: ${count} rows`);
    } catch (error) {
      summary.push({
        province: source.provinceName,
        subject: source.subjectTrack,
        rows: 0,
        error: error instanceof Error ? error.message : String(error),
      });
      console.warn(`FAIL ${source.provinceName} ${source.subjectTrack}:`, error instanceof Error ? error.message : error);
    }
  }

  console.table(summary);
  const totals = await client.query(
    `
      SELECT p.name AS province,
             ss.year,
             COALESCE(sc.name, '综合改革') AS subject_track,
             COUNT(*)::int AS rows,
             MIN(ss.score)::int AS min_score,
             MAX(ss.score)::int AS max_score,
             MAX(ss.cumulative_count)::int AS max_rank
      FROM score_segments ss
      JOIN provinces p ON p.id = ss.province_id
      LEFT JOIN subject_categories sc ON sc.id = ss.subject_category_id
      WHERE ss.year = $1 AND p.name IN ('天津', '江西')
      GROUP BY p.name, ss.year, sc.name
      ORDER BY p.name, sc.name
    `,
    [YEAR],
  );
  console.table(totals.rows);
  await client.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
