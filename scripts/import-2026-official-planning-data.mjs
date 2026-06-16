#!/usr/bin/env node

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { Client } from "pg";
import XLSX from "xlsx";

const DEFAULT_DSN = "postgresql://gaokao:gaokao@localhost:5432/gaokao_vault";
const DSN = process.env.GAOKAO_VAULT_DATABASE_URL || process.env.GAOKAO_DB__DSN || DEFAULT_DSN;
const DEFAULT_MANIFEST = new URL("./official-planning-sources-2026.json", import.meta.url).pathname;
const OFFICIAL_HOST_PATTERNS = [
  /(^|\.)chsi\.com\.cn$/,
  /(^|\.)edu\.cn$/,
  /(^|\.)gov\.cn$/,
  /(^|\.)jseea\.cn$/,
  /(^|\.)bjeea\.cn$/,
  /(^|\.)shmeea\.edu\.cn$/,
  /(^|\.)eea\.gd\.gov\.cn$/,
  /(^|\.)zsksy\.guizhou\.gov\.cn$/,
  /(^|\.)sdzk\.cn$/,
  /(^|\.)ea\.hainan\.gov\.cn$/,
  /(^|\.)hebeea\.edu\.cn$/,
];

function parseArgs(argv) {
  const args = {
    dryRun: false,
    manifest: DEFAULT_MANIFEST,
    sourceFilter: "",
    provinceFilter: "",
  };

  for (let index = 2; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--dry-run") args.dryRun = true;
    else if (item === "--manifest") args.manifest = argv[++index] || args.manifest;
    else if (item.startsWith("--manifest=")) args.manifest = item.slice("--manifest=".length);
    else if (item === "--source-filter") args.sourceFilter = argv[++index] || "";
    else if (item.startsWith("--source-filter=")) args.sourceFilter = item.slice("--source-filter=".length);
    else if (item === "--province-filter") args.provinceFilter = argv[++index] || "";
    else if (item.startsWith("--province-filter=")) args.provinceFilter = item.slice("--province-filter=".length);
    else if (item === "--help" || item === "-h") {
      console.log(`Usage: node scripts/import-2026-official-planning-data.mjs [--dry-run] [--manifest file] [--source-filter text] [--province-filter text]`);
      process.exit(0);
    }
  }

  return args;
}

function compact(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
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

function contentHash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function isOfficialUrl(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return OFFICIAL_HOST_PATTERNS.some((pattern) => pattern.test(hostname));
  } catch {
    return false;
  }
}

async function fetchBuffer(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X) gaokao-major-advisor/1.0 official-planning-importer",
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

async function fetchText(url) {
  const buffer = await fetchBuffer(url);
  const text = buffer.toString("utf8");
  if (text.includes("\uFFFD")) return buffer.toString("latin1");
  return text;
}

function htmlTables(html) {
  return Array.from(html.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi)).map((match) => {
    return Array.from(match[0].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi))
      .map((rowMatch) =>
        Array.from(rowMatch[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)).map((cell) =>
          stripTags(cell[1]),
        ),
      )
      .filter((row) => row.some(Boolean));
  });
}

function workbookRows(buffer) {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  return workbook.SheetNames.flatMap((sheetName) =>
    XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: "" }),
  );
}

function rowObjectFromHeaders(headers, row) {
  const object = {};
  headers.forEach((header, index) => {
    if (header) object[header] = compact(row[index]);
  });
  return object;
}

function normalizePlanRecord(record, source) {
  const get = (...names) => names.map((name) => record[name]).find((value) => compact(value));
  const schoolName = compact(get("schoolName", "院校名称", "学校名称", "院校", "学校") || source.schoolName);
  const majorName = compact(get("majorName", "专业名称", "专业", "招生专业"));
  const provinceName = compact(get("provinceName", "招生省份", "省份", "地区") || source.provinceName);
  const subjectTrack = compact(get("subjectTrack", "科类", "选科", "首选科目") || source.subjectTrack);
  const planCountText = compact(get("planCount", "招生人数", "计划数", "人数"));
  const planCount = Number(planCountText.replace(/[^\d]/g, ""));

  if (!schoolName || !majorName || !provinceName) return null;

  return {
    schoolName,
    provinceName,
    year: Number(source.year || record.year || 2026),
    subjectTrack,
    batch: compact(get("batch", "批次") || source.batch || ""),
    majorName,
    planCount: Number.isFinite(planCount) && planCount > 0 ? planCount : null,
    duration: compact(get("duration", "学制")),
    tuition: compact(get("tuition", "学费", "收费标准")),
    note: compact(get("note", "备注", "说明")),
    majorGroupCode: compact(get("majorGroupCode", "专业组", "专业组代码")),
    majorCodeRaw: compact(get("majorCode", "专业代码", "代码")),
    campus: compact(get("campus", "校区")),
    educationLocation: compact(get("educationLocation", "培养地点")),
    selectionRequirement: compact(get("selectionRequirement", "选科要求", "再选科目要求", "科目要求")),
    physicalExamLimit: compact(get("physicalExamLimit", "体检要求", "身体要求")),
    singleSubjectLimit: compact(get("singleSubjectLimit", "单科要求")),
    adjustmentRule: compact(get("adjustmentRule", "调剂规则")),
    programType: compact(get("programType", "项目类型")),
    eligibilityRequirements: compact(get("eligibilityRequirements", "报考条件")),
    physicalExamOrPoliticalReview: compact(get("physicalExamOrPoliticalReview", "体检政审")),
    politicalReviewRequirement: compact(get("politicalReviewRequirement", "政审要求")),
    serviceObligation: compact(get("serviceObligation", "服务期", "定向要求")),
    sourceUrl: source.url,
    dataSource: source.title,
  };
}

async function parseEnrollmentSource(source) {
  if (Array.isArray(source.records)) {
    return source.records.map((record) => normalizePlanRecord(record, source)).filter(Boolean);
  }

  if (!source.url) return [];
  const lowerUrl = source.url.toLowerCase();
  if (lowerUrl.endsWith(".xlsx") || lowerUrl.endsWith(".xls")) {
    const rows = workbookRows(await fetchBuffer(source.url));
    const headerIndex = rows.findIndex((row) => row.some((cell) => /专业|院校|学校|计划|人数/.test(String(cell))));
    if (headerIndex < 0) return [];
    const headers = rows[headerIndex].map(compact);
    return rows
      .slice(headerIndex + 1)
      .map((row) => normalizePlanRecord(rowObjectFromHeaders(headers, row), source))
      .filter(Boolean);
  }

  const html = await fetchText(source.url);
  return htmlTables(html)
    .flatMap((table) => {
      const headerIndex = table.findIndex((row) => row.some((cell) => /专业|院校|学校|计划|人数/.test(cell)));
      if (headerIndex < 0) return [];
      const headers = table[headerIndex].map(compact);
      return table
        .slice(headerIndex + 1)
        .map((row) => normalizePlanRecord(rowObjectFromHeaders(headers, row), source))
        .filter(Boolean);
    });
}

async function parseCharterSource(source) {
  if (source.content) {
    return {
      schoolName: source.schoolName,
      year: Number(source.year || 2026),
      title: source.title,
      content: compact(source.content),
      publishDate: source.publishDate || null,
      sourceUrl: source.url,
    };
  }

  if (!source.url) throw new Error("charter source requires url or content");
  const html = await fetchText(source.url);
  const title = stripTags(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || source.title);
  const content = stripTags(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " "),
  );
  return {
    schoolName: source.schoolName,
    year: Number(source.year || 2026),
    title: title || source.title,
    content,
    publishDate: source.publishDate || null,
    sourceUrl: source.url,
  };
}

async function idForName(client, table, name) {
  if (!name) return null;
  const result = await client.query(`SELECT id FROM ${table} WHERE name = $1 OR name ILIKE $2 LIMIT 1`, [
    name,
    `%${name}%`,
  ]);
  return result.rows[0]?.id ?? null;
}

async function provinceId(client, name) {
  const result = await client.query(
    `
      SELECT id FROM provinces
      WHERE regexp_replace(name, '(壮族自治区|回族自治区|维吾尔自治区|自治区|省|市)$', '') =
            regexp_replace($1, '(壮族自治区|回族自治区|维吾尔自治区|自治区|省|市)$', '')
      LIMIT 1
    `,
    [name],
  );
  return result.rows[0]?.id ?? null;
}

async function subjectId(client, name) {
  if (!name) return null;
  return idForName(client, "subject_categories", name);
}

async function majorId(client, name) {
  if (!name) return null;
  return idForName(client, "majors", name);
}

async function upsertCharter(client, charter, dryRun) {
  const schoolId = await idForName(client, "schools", charter.schoolName);
  if (!schoolId) return { status: "skipped", reason: `missing school: ${charter.schoolName}` };
  if (dryRun) return { status: "dry_run", rows: 1 };

  await client.query(
    `DELETE FROM admission_charters WHERE school_id = $1 AND year = $2 AND source_url = $3`,
    [schoolId, charter.year, charter.sourceUrl],
  );
  await client.query(
    `
      INSERT INTO admission_charters (
        school_id, year, title, content, publish_date, source_url, content_hash, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
    `,
    [
      schoolId,
      charter.year,
      charter.title,
      charter.content,
      charter.publishDate,
      charter.sourceUrl,
      contentHash(charter),
    ],
  );
  return { status: "ok", rows: 1 };
}

async function upsertEnrollmentPlans(client, records, dryRun) {
  let inserted = 0;
  let skipped = 0;
  const reasons = [];

  for (const record of records) {
    const schoolId = await idForName(client, "schools", record.schoolName);
    const pId = await provinceId(client, record.provinceName);
    const sId = await subjectId(client, record.subjectTrack);
    const mId = await majorId(client, record.majorName);
    if (!schoolId || !pId) {
      skipped += 1;
      reasons.push(`missing school/province: ${record.schoolName}/${record.provinceName}`);
      continue;
    }

    if (dryRun) {
      inserted += 1;
      continue;
    }

    await client.query(
      `
        DELETE FROM enrollment_plans
        WHERE school_id = $1
          AND province_id = $2
          AND year = $3
          AND COALESCE(major_name, '') = COALESCE($4, '')
          AND COALESCE(major_group_code, '') = COALESCE($5, '')
          AND COALESCE(source_url, '') = COALESCE($6, '')
      `,
      [schoolId, pId, record.year, record.majorName, record.majorGroupCode, record.sourceUrl],
    );

    await client.query(
      `
        INSERT INTO enrollment_plans (
          school_id, province_id, year, subject_category_id, batch, major_name, major_id,
          plan_count, duration, tuition, note, major_group_code, major_code_raw, campus,
          education_location, selection_requirement, physical_exam_limit, single_subject_limit,
          adjustment_rule, program_type, eligibility_requirements,
          physical_exam_or_political_review, political_review_requirement, service_obligation,
          data_source, source_url, source_updated_at, content_hash, updated_at
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7,
          $8, $9, $10, $11, $12, $13, $14,
          $15, $16, $17, $18,
          $19, $20, $21,
          $22, $23, $24,
          $25, $26, NOW(), $27, NOW()
        )
      `,
      [
        schoolId,
        pId,
        record.year,
        sId,
        record.batch,
        record.majorName,
        mId,
        record.planCount,
        record.duration,
        record.tuition,
        record.note,
        record.majorGroupCode,
        record.majorCodeRaw,
        record.campus,
        record.educationLocation,
        record.selectionRequirement,
        record.physicalExamLimit,
        record.singleSubjectLimit,
        record.adjustmentRule,
        record.programType,
        record.eligibilityRequirements,
        record.physicalExamOrPoliticalReview,
        record.politicalReviewRequirement,
        record.serviceObligation,
        record.dataSource,
        record.sourceUrl,
        contentHash(record),
      ],
    );
    inserted += 1;
  }

  return { status: "ok", rows: inserted, skipped, reasons: Array.from(new Set(reasons)).slice(0, 8) };
}

function loadSources(manifestPath) {
  if (!existsSync(manifestPath)) {
    console.warn(`Manifest not found: ${manifestPath}`);
    return [];
  }
  const parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  return Array.isArray(parsed) ? parsed : parsed.sources || [];
}

function sourceMatches(source, args) {
  const haystack = `${source.id || ""} ${source.title || ""} ${source.schoolName || ""} ${source.url || ""}`;
  if (args.sourceFilter && !haystack.includes(args.sourceFilter)) return false;
  if (args.provinceFilter && !`${source.provinceName || ""} ${source.title || ""}`.includes(args.provinceFilter)) {
    return false;
  }
  return true;
}

async function processSource(client, source, args) {
  if (!source.kind || !["charter", "enrollmentPlan"].includes(source.kind)) {
    return { id: source.id, kind: source.kind, status: "skipped", reason: "unsupported kind" };
  }
  if (source.url && !isOfficialUrl(source.url)) {
    return { id: source.id, kind: source.kind, status: "skipped", reason: "non-official url" };
  }

  if (source.kind === "charter") {
    const charter = await parseCharterSource(source);
    const result = await upsertCharter(client, charter, args.dryRun);
    return { id: source.id, kind: source.kind, title: source.title, ...result };
  }

  const records = await parseEnrollmentSource(source);
  if (!records.length) {
    return { id: source.id, kind: source.kind, title: source.title, status: "skipped", reason: "no parseable enrollment rows" };
  }
  const result = await upsertEnrollmentPlans(client, records, args.dryRun);
  return { id: source.id, kind: source.kind, title: source.title, ...result };
}

async function main() {
  const args = parseArgs(process.argv);
  const sources = loadSources(args.manifest).filter((source) => sourceMatches(source, args));
  const client = new Client({ connectionString: DSN });
  await client.connect();

  const summary = [];
  for (const source of sources) {
    try {
      summary.push(await processSource(client, source, args));
    } catch (error) {
      summary.push({
        id: source.id,
        kind: source.kind,
        title: source.title,
        status: "failed",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  console.table(summary);
  console.log(
    JSON.stringify(
      {
        dryRun: args.dryRun,
        manifest: args.manifest,
        sources: sources.length,
        ok: summary.filter((item) => item.status === "ok" || item.status === "dry_run").length,
        skipped: summary.filter((item) => item.status === "skipped").length,
        failed: summary.filter((item) => item.status === "failed").length,
      },
      null,
      2,
    ),
  );

  await client.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
