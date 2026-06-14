#!/usr/bin/env node

import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { Client } from "pg";
import { PDFParse } from "pdf-parse";
import XLSX from "xlsx";

const DEFAULT_DSN = "postgresql://gaokao:gaokao@localhost:5432/gaokao_vault";
const DSN = process.env.GAOKAO_VAULT_DATABASE_URL || process.env.GAOKAO_DB__DSN || DEFAULT_DSN;
const YEAR = 2025;
const BATCH = "普通类本科批";
const DATA_SCOPE = "examAuthorityGroupLine";
const SOURCE_DISCOVERY_URL = "https://www.eol.cn/e_html/gk/gktoudang/index.shtml";

const KNOWN_SOURCES = [
  {
    provinceName: "北京",
    subjectTrack: "综合改革",
    title: "2025年北京市高招本科普通批录取投档线",
    url: "https://www.bjeea.cn/uploads/soft/250720/178-250H0201058.pdf",
    publisher: "北京教育考试院",
    parser: "beijingPdf",
  },
  {
    provinceName: "河北",
    subjectTrack: "历史类",
    title: "2025年河北省普通高校招生本科批-历史科目组合平行志愿投档情况统计",
    url: "http://file.hebeea.edu.cn/files/article/2025/07/20250722214851_332.xlsx",
    publisher: "河北省教育考试院",
    parser: "hebeiXlsx",
  },
  {
    provinceName: "河北",
    subjectTrack: "物理类",
    title: "2025年河北省普通高校招生本科批-物理科目组合平行志愿投档情况统计",
    url: "http://file.hebeea.edu.cn/files/article/2025/07/20250722214852_210.xlsx",
    publisher: "河北省教育考试院",
    parser: "hebeiXlsx",
  },
  {
    provinceName: "江苏",
    subjectTrack: "历史类",
    title: "江苏省2025年普通高校招生普通类本科批次平行志愿投档线（历史等科目类）",
    url: "https://www.jseea.cn/webfile/upload/2025/07-18/09-33-380724-1917118608.pdf",
    publisher: "江苏省教育考试院",
    parser: "jiangsuPdf",
  },
  {
    provinceName: "江苏",
    subjectTrack: "物理类",
    title: "江苏省2025年普通高校招生普通类本科批次平行志愿投档线（物理等科目类）",
    url: "https://www.jseea.cn/webfile/upload/2025/07-18/09-33-5302461102655621.pdf",
    publisher: "江苏省教育考试院",
    parser: "jiangsuPdf",
  },
  {
    provinceName: "上海",
    subjectTrack: "综合改革",
    title: "上海市2025年普通高校招生本科普通批次平行志愿院校专业组投档分数线",
    url: "https://www.shmeea.edu.cn/download/20250719/186.pdf",
    publisher: "上海市教育考试院",
    parser: "shanghaiPdf",
  },
  {
    provinceName: "广东",
    subjectTrack: "历史类",
    title: "广东省2025年本科普通类（历史）投档情况",
    url: "https://eea.gd.gov.cn/attachment/0/585/585885/4746781.pdf",
    publisher: "广东省教育考试院",
    parser: "guangdongPdf",
  },
  {
    provinceName: "广东",
    subjectTrack: "物理类",
    title: "广东省2025年本科普通类（物理）投档情况",
    url: "https://eea.gd.gov.cn/attachment/0/585/585886/4746781.pdf",
    publisher: "广东省教育考试院",
    parser: "guangdongPdf",
  },
  {
    provinceName: "贵州",
    subjectTrack: "物理类",
    title: "贵州省2025年高考普通类本科批投档情况（首选科目物理）",
    url: "https://zsksy.guizhou.gov.cn/ygpt/tdqk/202507/P020250722698227709890.pdf",
    publisher: "贵州省招生考试院",
    parser: "guizhouPdf",
  },
  {
    provinceName: "贵州",
    subjectTrack: "历史类",
    title: "贵州省2025年高考普通类本科批投档情况（首选科目历史）",
    url: "https://zsksy.guizhou.gov.cn/ygpt/tdqk/202507/P020250723361496543916.pdf",
    publisher: "贵州省招生考试院",
    parser: "guizhouPdf",
  },
  {
    provinceName: "山东",
    subjectTrack: "综合改革",
    title: "山东省2025年普通类常规批第1次志愿投档情况表",
    url: "https://www.sdzk.cn/Floadup/file/20250719/6388855130412530367357143.xls",
    publisher: "山东省教育招生考试院",
    parser: "shandongXls",
  },
  {
    provinceName: "海南",
    subjectTrack: "综合改革",
    title: "2025年海南省普通高校招生录取本科普通批(含少数民族班)平行志愿院校专业组投档分数线",
    url: "https://ea.hainan.gov.cn/ywdt/ptgkyjszsb/202507/t20250722_3901088.html",
    publisher: "海南省考试局",
    parser: "hainanHtml",
  },
  {
    provinceName: "天津",
    subjectTrack: "综合改革",
    title: "2025年普通高校在津招生录取最低分统计表（普通类本科批A阶段）",
    url: "https://cdn.zizzs.com/zixunzhan/1752901279489天津2025本科批A段投档线.pdf",
    publisher: "天津市教育招生考试院",
    parser: "tianjinDocx",
    batch: "普通类本科批A阶段",
    localPath:
      process.env.TIANJIN_2025_BATCH_A_DOCX_PATH ||
      "/Users/hooked4st/Desktop/1752901279489天津2025本科批A段投档线.docx",
    discoveryUrl: "https://www.zizzs.com/gk/gaokao/204319.html",
  },
];

function compact(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function asInteger(value) {
  const match = String(value ?? "").replace(/,/g, "").match(/\d+/);
  return match ? Number(match[0]) : null;
}

function normalizeSchoolName(value) {
  return compact(value).replace(/\[[^\]]+\]/g, "").replace(/（[^）]*市）/g, "").replace(/\([^)]*市\)/g, "");
}

function sourceId(source) {
  return `${source.provinceName}-${source.subjectTrack}-${source.url}`.replace(/\s+/g, "");
}

async function fetchBuffer(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X) gaokao-major-advisor/1.0 official-data-crawler",
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

async function pdfText(url) {
  const buffer = await fetchBuffer(url);
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return result.text;
  } finally {
    await parser.destroy();
  }
}

async function workbookRows(url) {
  const buffer = await fetchBuffer(url);
  const workbook = XLSX.read(buffer, { type: "buffer" });
  return workbook.SheetNames.flatMap((sheetName) =>
    XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: "" }),
  );
}

async function htmlText(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X) gaokao-major-advisor/1.0 official-data-crawler",
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.text();
}

function decodeXmlText(value) {
  return String(value ?? "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'");
}

function extractDocxText(xmlChunk) {
  return compact(
    decodeXmlText(
      Array.from(xmlChunk.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g))
        .map((match) => match[1])
        .join(""),
    ),
  );
}

function docxTableRows(localPath) {
  const xml = execFileSync("unzip", ["-p", localPath, "word/document.xml"], {
    encoding: "utf8",
    maxBuffer: 40 * 1024 * 1024,
  });

  return Array.from(xml.matchAll(/<w:tr(?:\s[^>]*)?>[\s\S]*?<\/w:tr>/g))
    .map((rowMatch) =>
      Array.from(rowMatch[0].matchAll(/<w:tc(?:\s[^>]*)?>[\s\S]*?<\/w:tc>/g)).map((cellMatch) =>
        extractDocxText(cellMatch[0]),
      ),
    )
    .filter((row) => row.some(Boolean));
}

function parseJiangsuPdf(text, source) {
  const rows = [];
  for (const line of text.split(/\n+/).map(compact)) {
    const match = line.match(/^(\d{4})\s+(.+?\d{2}专业组(?:\([^)]+\))?)\s+(\d{3})\b/);
    if (!match) continue;
    const groupName = match[2];
    rows.push({
      schoolCode: match[1],
      schoolName: normalizeSchoolName(groupName.replace(/\d{2}专业组.*$/, "")),
      groupCode: groupName.match(/(\d{2})专业组/)?.[1] ?? null,
      groupName,
      majorCode: null,
      majorName: null,
      minScore: Number(match[3]),
      minScoreText: match[3],
      minRank: null,
      source,
    });
  }
  return rows;
}

function parseGuangdongPdf(text, source) {
  const rows = [];
  for (const line of text.split(/\n+/).map(compact)) {
    const match = line.match(/^(\d{5})\s+(.+?)\s+(\d{3})\s+\d+\s+\d+\s+(\d{3})\s+(\d+)\b/);
    if (!match) continue;
    rows.push({
      schoolCode: match[1],
      schoolName: normalizeSchoolName(match[2]),
      groupCode: match[3],
      groupName: `${normalizeSchoolName(match[2])}${match[3]}专业组`,
      majorCode: null,
      majorName: null,
      minScore: Number(match[4]),
      minScoreText: match[4],
      minRank: Number(match[5]),
      source,
    });
  }
  return rows;
}

function parseShanghaiPdf(text, source) {
  const rows = [];
  for (const line of text.split(/\n+/).map(compact)) {
    const match = line.match(/^(\d{5})\s+(.+?\(\d{2}\))\s+((?:\d{3})|(?:580分及以上))\b/);
    if (!match) continue;
    const score = asInteger(match[3]);
    const groupName = match[2];
    rows.push({
      schoolCode: match[1].slice(0, 3),
      schoolName: normalizeSchoolName(groupName.replace(/\(\d{2}\).*$/, "")),
      groupCode: match[1],
      groupName,
      majorCode: null,
      majorName: null,
      minScore: score,
      minScoreText: match[3],
      minRank: null,
      source,
    });
  }
  return rows;
}

function parseBeijingPdf(text, source) {
  const rows = [];
  for (const line of text.split(/\n+/).map(compact)) {
    const match = line.match(/^\d+\s+(\d{4})\s+(.+?)\s+(\d{2})\s+(.+?)\s+(\d{3})\b/);
    if (!match) continue;
    rows.push({
      schoolCode: match[1],
      schoolName: normalizeSchoolName(match[2]),
      groupCode: match[3],
      groupName: `${normalizeSchoolName(match[2])}${match[3]}专业组(${match[4]})`,
      majorCode: null,
      majorName: null,
      minScore: Number(match[5]),
      minScoreText: match[5],
      minRank: null,
      source,
    });
  }
  return rows;
}

function parseHebeiXlsx(rows, source) {
  return rows
    .slice(5)
    .map((row) => {
      const schoolCode = compact(row[0]);
      const schoolName = normalizeSchoolName(row[1]);
      const majorCode = compact(row[2]);
      const majorName = compact(row[3]);
      const minScore = asInteger(row[4]);
      if (!schoolCode || !schoolName || !majorCode || !majorName || !minScore) return null;
      return {
        schoolCode,
        schoolName,
        groupCode: majorCode,
        groupName: `${schoolName} ${majorCode}`,
        majorCode,
        majorName,
        minScore,
        minScoreText: String(minScore),
        minRank: null,
        source,
      };
    })
    .filter(Boolean);
}

function parseShandongXls(rows, source) {
  return rows
    .slice(2)
    .map((row) => {
      const major = compact(row[0]);
      const school = compact(row[1]);
      const rank = asInteger(row[3]);
      const schoolMatch = school.match(/^([A-Z0-9]+)(.+)$/);
      const majorMatch = major.match(/^([A-Z0-9]+)(.+)$/);
      if (!schoolMatch || !majorMatch || !rank) return null;
      return {
        schoolCode: schoolMatch[1],
        schoolName: normalizeSchoolName(schoolMatch[2]),
        groupCode: majorMatch[1],
        groupName: `${normalizeSchoolName(schoolMatch[2])} ${majorMatch[1]}`,
        majorCode: majorMatch[1],
        majorName: majorMatch[2],
        minScore: null,
        minScoreText: null,
        minRank: rank,
        source,
      };
    })
    .filter(Boolean);
}

function parseGuizhouPdf(text, source) {
  const rows = [];
  for (const line of text.split(/\n+/).map(compact)) {
    const match = line.match(
      /^\d+\s+([A-Z0-9]{4,})\s+(.+?)\s+([A-Z0-9]{3})\s+(.+?)\s+一般统考生\s+\d+\s+\d+\s+(\d{3})\s+(\d+)\b/,
    );
    if (!match) continue;
    rows.push({
      schoolCode: match[1],
      schoolName: normalizeSchoolName(match[2]),
      groupCode: match[3],
      groupName: `${normalizeSchoolName(match[2])} ${match[3]}`,
      majorCode: match[3],
      majorName: compact(match[4]),
      minScore: Number(match[5]),
      minScoreText: match[5],
      minRank: Number(match[6]),
      source,
    });
  }
  return rows;
}

function parseHainanHtml(html, source) {
  const rows = [];
  const rowMatches = html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi);
  for (const rowMatch of rowMatches) {
    const cells = Array.from(rowMatch[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)).map((cell) =>
      compact(cell[1].replace(/<[^>]+>/g, " ")),
    );
    if (cells.length < 4 || cells[0].includes("院校专业组代码")) continue;
    const groupCode = compact(cells[0]);
    const groupName = compact(cells[1]);
    const subjectRequirement = compact(cells[2]);
    const minScore = asInteger(cells[3]);
    if (!groupCode || !groupName || !minScore) continue;
    const schoolName = normalizeSchoolName(groupName.replace(/[（(]\d{2}[）)].*$/, ""));
    rows.push({
      schoolCode: groupCode.slice(0, 4),
      schoolName,
      groupCode,
      groupName: subjectRequirement ? `${groupName}(${subjectRequirement})` : groupName,
      majorCode: null,
      majorName: null,
      minScore,
      minScoreText: String(minScore),
      minRank: null,
      source,
    });
  }
  return rows;
}

function parseTianjinDocx(rows, source) {
  return rows
    .map((row) => {
      const serial = asInteger(row[0]);
      const groupCode = compact(row[1]).replace(/\D/g, "");
      const schoolName = normalizeSchoolName(row[2]);
      const minScoreText = compact(row[3]);
      const minScore = asInteger(minScoreText);
      const remark = compact(row[7]);

      if (!serial || groupCode.length !== 6 || !schoolName || !minScore) return null;

      return {
        schoolCode: groupCode.slice(0, 4),
        schoolName,
        groupCode,
        groupName: remark ? `${schoolName} ${groupCode}专业组（${remark}）` : `${schoolName} ${groupCode}专业组`,
        majorCode: null,
        majorName: null,
        minScore,
        minScoreText,
        minRank: null,
        source,
      };
    })
    .filter(Boolean);
}

async function parseSource(source) {
  if (source.parser.endsWith("Xlsx") || source.parser.endsWith("Xls")) {
    const rows = await workbookRows(source.url);
    if (source.parser === "hebeiXlsx") return parseHebeiXlsx(rows, source);
    if (source.parser === "shandongXls") return parseShandongXls(rows, source);
    return [];
  }

  if (source.parser === "hainanHtml") return parseHainanHtml(await htmlText(source.url), source);
  if (source.parser === "tianjinDocx") return parseTianjinDocx(docxTableRows(source.localPath), source);

  const text = await pdfText(source.url);
  if (source.parser === "jiangsuPdf") return parseJiangsuPdf(text, source);
  if (source.parser === "guangdongPdf") return parseGuangdongPdf(text, source);
  if (source.parser === "shanghaiPdf") return parseShanghaiPdf(text, source);
  if (source.parser === "beijingPdf") return parseBeijingPdf(text, source);
  if (source.parser === "guizhouPdf") return parseGuizhouPdf(text, source);
  return [];
}

async function ensureSchema(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS institution_admission_lines (
      id BIGSERIAL PRIMARY KEY,
      province_id INTEGER REFERENCES provinces(id),
      province_name VARCHAR(40) NOT NULL,
      year SMALLINT NOT NULL,
      subject_track VARCHAR(80) NOT NULL,
      batch VARCHAR(120) NOT NULL,
      school_code VARCHAR(80),
      school_name VARCHAR(240) NOT NULL,
      group_code VARCHAR(120),
      group_name VARCHAR(360),
      major_code VARCHAR(120),
      major_name VARCHAR(360),
      min_score INTEGER,
      min_score_text VARCHAR(80),
      min_rank INTEGER,
      source_title VARCHAR(360) NOT NULL,
      source_url TEXT NOT NULL,
      source_publisher VARCHAR(160) NOT NULL,
      source_discovery_url TEXT,
      data_scope VARCHAR(80) NOT NULL DEFAULT 'examAuthorityGroupLine',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (
        province_name,
        year,
        subject_track,
        batch,
        school_code,
        group_code,
        major_code,
        school_name,
        source_url
      )
    );
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_institution_admission_lines_lookup
    ON institution_admission_lines (province_name, year, subject_track, school_name);
  `);
}

async function upsertRows(client, rows) {
  const firstSource = rows[0]?.source;
  if (firstSource) {
    await client.query(
      `
        DELETE FROM institution_admission_lines
        WHERE province_name = $1
          AND year = $2
          AND subject_track = $3
          AND source_url = $4
      `,
      [firstSource.provinceName, YEAR, firstSource.subjectTrack, firstSource.url],
    );
  }

  let inserted = 0;
  for (const row of rows) {
    const source = row.source;
    const provinceId = await client.query(
      `
        SELECT id FROM provinces
        WHERE regexp_replace(name, '(壮族自治区|回族自治区|维吾尔自治区|自治区|省|市)$', '') = $1
        LIMIT 1
      `,
      [source.provinceName],
    );
    await client.query(
      `
        INSERT INTO institution_admission_lines (
          province_id,
          province_name,
          year,
          subject_track,
          batch,
          school_code,
          school_name,
          group_code,
          group_name,
          major_code,
          major_name,
          min_score,
          min_score_text,
          min_rank,
          source_title,
          source_url,
          source_publisher,
          source_discovery_url,
          data_scope,
          updated_at
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
          $11, $12, $13, $14, $15, $16, $17, $18, $19, NOW()
        )
        ON CONFLICT (
          province_name,
          year,
          subject_track,
          batch,
          school_code,
          group_code,
          major_code,
          school_name,
          source_url
        )
        DO UPDATE SET
          group_name = EXCLUDED.group_name,
          major_name = EXCLUDED.major_name,
          min_score = EXCLUDED.min_score,
          min_score_text = EXCLUDED.min_score_text,
          min_rank = EXCLUDED.min_rank,
          source_title = EXCLUDED.source_title,
          source_publisher = EXCLUDED.source_publisher,
          source_discovery_url = EXCLUDED.source_discovery_url,
          data_scope = EXCLUDED.data_scope,
          updated_at = NOW()
      `,
      [
        provinceId.rows[0]?.id ?? null,
        source.provinceName,
        YEAR,
        source.subjectTrack,
        source.batch || BATCH,
        row.schoolCode,
        row.schoolName,
        row.groupCode,
        row.groupName,
        row.majorCode,
        row.majorName,
        row.minScore,
        row.minScoreText,
        row.minRank,
        source.title,
        source.url,
        source.publisher,
        source.discoveryUrl || SOURCE_DISCOVERY_URL,
        DATA_SCOPE,
      ],
    );
    inserted += 1;
  }
  return inserted;
}

async function main() {
  const client = new Client({ connectionString: DSN });
  await client.connect();
  await ensureSchema(client);

  const seen = new Set();
  const sourceFilter = compact(process.env.GAOKAO_SOURCE_FILTER);
  const sources = KNOWN_SOURCES.filter((source) => {
    if (sourceFilter && !`${source.provinceName} ${source.subjectTrack} ${source.title}`.includes(sourceFilter)) return false;
    const key = sourceId(source);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const summary = [];
  for (const source of sources) {
    try {
      const rows = await parseSource(source);
      const count = await upsertRows(client, rows);
      summary.push({ source: source.title, province: source.provinceName, subject: source.subjectTrack, rows: count });
      console.log(`OK ${source.provinceName} ${source.subjectTrack}: ${count} rows`);
    } catch (error) {
      summary.push({
        source: source.title,
        province: source.provinceName,
        subject: source.subjectTrack,
        rows: 0,
        error: error instanceof Error ? error.message : String(error),
      });
      console.warn(`FAIL ${source.provinceName} ${source.subjectTrack}:`, error instanceof Error ? error.message : error);
    }
  }

  const totals = await client.query(`
    SELECT province_name, subject_track, COUNT(*)::int AS rows, COUNT(min_score)::int AS score_rows
    FROM institution_admission_lines
    WHERE year = $1
    GROUP BY province_name, subject_track
    ORDER BY province_name, subject_track
  `, [YEAR]);
  console.table(totals.rows);
  await client.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
