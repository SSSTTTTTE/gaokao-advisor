import { Pool } from "pg";
import type {
  AdmissionLookupResult,
  AdmissionScorePoint,
  AdmissionScoreRow,
  AdmissionSource,
} from "./gaokao-data";

const QUERY_TIMEOUT_MS = 8_000;
const VAULT_REPO_URL = "https://github.com/lifefloating/gaokao-vault";

type VaultGlobal = typeof globalThis & {
  __gaokaoVaultPool?: Pool;
  __gaokaoVaultDsn?: string;
};

type AdmissionLookupArgs = {
  schoolName: string;
  province: string;
  subjectTrack: string;
  yearRange?: number[];
  queryType?: "overallTrend" | "groupComparison";
};

type RankLookupArgs = {
  province: string;
  year: number;
  subjectTrack: string;
  score: number;
};

type VaultAdmissionRow = {
  year: number;
  school_name: string | null;
  province: string | null;
  subject_track: string | null;
  major_name: string | null;
  group_name: string | null;
  max_score: number | string | null;
  min_score: number | string | null;
  average_score: number | string | null;
  rank: number | string | null;
  source_url: string | null;
  data_source: string | null;
};

type VaultRankRow = {
  matched_score: number | string | null;
  cumulative_count: number | string | null;
  province: string | null;
  subject_track: string | null;
};

type VaultInstitutionAdmissionLineRow = {
  year: number;
  province_name: string;
  subject_track: string;
  batch: string | null;
  school_code: string | null;
  school_name: string;
  group_code: string | null;
  group_name: string | null;
  major_code: string | null;
  major_name: string | null;
  min_score: number | string | null;
  min_score_text: string | null;
  min_rank: number | string | null;
  source_title: string;
  source_url: string;
  source_publisher: string;
  data_scope: string | null;
};

export function getGaokaoVaultDsn() {
  return process.env.GAOKAO_VAULT_DATABASE_URL || process.env.GAOKAO_DB__DSN || "";
}

export function isGaokaoVaultConfigured() {
  return Boolean(getGaokaoVaultDsn());
}

export function getGaokaoVaultPool() {
  const dsn = getGaokaoVaultDsn();
  if (!dsn) return null;

  const globalForVault = globalThis as VaultGlobal;
  if (!globalForVault.__gaokaoVaultPool || globalForVault.__gaokaoVaultDsn !== dsn) {
    globalForVault.__gaokaoVaultPool?.end().catch(() => undefined);
    globalForVault.__gaokaoVaultPool = new Pool({
      connectionString: dsn,
      max: 3,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 3_000,
      query_timeout: QUERY_TIMEOUT_MS,
      statement_timeout: QUERY_TIMEOUT_MS,
      ssl:
        process.env.GAOKAO_VAULT_DATABASE_SSL === "true"
          ? { rejectUnauthorized: false }
          : undefined,
    });
    globalForVault.__gaokaoVaultDsn = dsn;
  }

  return globalForVault.__gaokaoVaultPool;
}

function normalizeProvinceName(province: string) {
  return province
    .trim()
    .replace(/(壮族自治区|回族自治区|维吾尔自治区|自治区|省|市)$/, "");
}

function subjectVariants(subjectTrack: string) {
  const value = subjectTrack.trim();
  const lower = value.toLowerCase();
  const variants = new Set<string>([value]);

  if (/physics|物理|理科|science/.test(lower)) {
    variants.add("物理类");
    variants.add("物理");
    variants.add("理科");
  }
  if (/history|历史|文科|liberal|arts/.test(lower)) {
    variants.add("历史类");
    variants.add("历史");
    variants.add("文科");
  }
  if (/综合|3\+3|zonghe|comprehensive/.test(lower)) {
    variants.add("综合改革");
    variants.add("综合");
    variants.add("3+3综合");
  }
  if (/美术|艺术|设计|书法|音乐|舞蹈|播音|编导|表演/.test(value)) {
    variants.add("艺术类");
    variants.add("美术类");
  }

  const withoutSuffix = value.replace(/类$/, "");
  if (withoutSuffix && withoutSuffix !== value) variants.add(withoutSuffix);

  return Array.from(variants).filter(Boolean);
}

function uniqueYears(yearRange: number[] | undefined) {
  const years = yearRange?.length ? yearRange : [2023, 2024, 2025];
  return Array.from(new Set(years))
    .filter((year) => Number.isInteger(year) && year >= 2000 && year <= 2030)
    .sort((a, b) => a - b);
}

function isSpecificSchoolName(schoolName: string) {
  const value = schoolName.trim();
  if (value.length < 3) return false;
  if (/^(大学|学校|院校|高校|本科|专科|全部|所有|任意)$/i.test(value)) return false;
  return /大学|学院|学校|职业技术|师范|医科|理工|传媒|交通|财经|政法|农业|工业|航空|航天|中医药|外国语/.test(
    value,
  );
}

function numberOrFallback(value: number | string | null | undefined, fallback: number) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
}

function vaultSource(sourceUrl?: string | null): AdmissionSource {
  return {
    id: "gaokao-vault",
    title: "gaokao-vault 结构化录取数据",
    url: sourceUrl || VAULT_REPO_URL,
    publisher: "lifefloating/gaokao-vault",
    kind: "gaokao_vault",
  };
}

function examAuthoritySource(row: VaultInstitutionAdmissionLineRow): AdmissionSource {
  return {
    id: `vault-exam-authority-${row.province_name}-${row.year}-${row.subject_track}-${row.source_url}`,
    title: row.source_title,
    url: row.source_url,
    publisher: row.source_publisher,
    kind: "official_exam_authority",
  };
}

function uniqueSourcesFromInstitutionLines(rows: VaultInstitutionAdmissionLineRow[]) {
  const byUrl = new Map<string, AdmissionSource>();
  for (const row of rows) {
    if (!byUrl.has(row.source_url)) byUrl.set(row.source_url, examAuthoritySource(row));
  }
  return Array.from(byUrl.values());
}

function sourceIdForInstitutionLine(row: VaultInstitutionAdmissionLineRow) {
  return `vault-exam-authority-${row.province_name}-${row.year}-${row.subject_track}-${row.source_url}`;
}

function toAdmissionRows(
  rows: VaultAdmissionRow[],
  args: Required<AdmissionLookupArgs>,
): AdmissionScoreRow[] {
  return rows
    .map((row) => {
      const minScore = numberOrFallback(row.min_score, NaN);
      if (!Number.isFinite(minScore)) return null;

      return {
        year: Number(row.year),
        schoolName: row.school_name || args.schoolName,
        province: row.province || args.province,
        subjectTrack: row.subject_track || args.subjectTrack,
        groupName: row.group_name || "录取结果",
        majorName: row.major_name || "",
        maxScore: numberOrFallback(row.max_score, minScore),
        minScore,
        averageScore: numberOrFallback(row.average_score, minScore),
        rank: numberOrFallback(row.rank, -1),
        sourceId: "gaokao-vault",
      };
    })
    .filter((row): row is AdmissionScoreRow => Boolean(row));
}

function toInstitutionAdmissionRows(
  rows: VaultInstitutionAdmissionLineRow[],
): AdmissionScoreRow[] {
  return rows
    .map((row) => {
      const minScore = numberOrFallback(row.min_score, NaN);
      if (!Number.isFinite(minScore)) return null;

      const schoolName = row.school_name;
      const groupName =
        row.group_name ||
        [schoolName, row.group_code ? `${row.group_code}专业组` : "", row.batch || ""]
          .filter(Boolean)
          .join(" · ");

      return {
        year: Number(row.year),
        schoolName,
        province: row.province_name,
        subjectTrack: row.subject_track,
        groupName,
        majorName: row.major_name || "省考试院投档线",
        maxScore: minScore,
        minScore,
        averageScore: minScore,
        rank: numberOrFallback(row.min_rank, -1),
        sourceId: sourceIdForInstitutionLine(row),
      };
    })
    .filter((row): row is AdmissionScoreRow => Boolean(row));
}

function pointsForOverallTrend(rows: AdmissionScoreRow[]): AdmissionScorePoint[] {
  const groups = new Map<number, AdmissionScoreRow[]>();
  for (const row of rows) {
    groups.set(row.year, [...(groups.get(row.year) ?? []), row]);
  }

  return Array.from(groups.values())
    .map((groupRows) => [...groupRows].sort((a, b) => a.minScore - b.minScore)[0])
    .map((row) => ({
      year: row.year,
      score: row.minScore,
      rank: row.rank,
      groupName: row.groupName,
      majorName: row.majorName,
      sourceId: row.sourceId,
    }))
    .sort((a, b) => a.year - b.year || a.score - b.score);
}

function pointsForGroupComparison(rows: AdmissionScoreRow[]): AdmissionScorePoint[] {
  return rows
    .map((row) => ({
      year: row.year,
      score: row.minScore,
      rank: row.rank,
      groupName: row.groupName,
      majorName: row.majorName,
      sourceId: row.sourceId,
    }))
    .sort((a, b) => b.year - a.year || b.score - a.score);
}

async function lookupInstitutionAdmissionLinesFromVault(
  args: Required<AdmissionLookupArgs>,
  variants: string[],
  normalizedProvince: string,
): Promise<AdmissionLookupResult | null> {
  const pool = getGaokaoVaultPool();
  if (!pool) return null;

  try {
    const result = await pool.query<VaultInstitutionAdmissionLineRow>(
      `
        SELECT
          year,
          province_name,
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
          data_scope
        FROM institution_admission_lines
        WHERE
          regexp_replace(
            province_name,
            '(壮族自治区|回族自治区|维吾尔自治区|自治区|省|市)$',
            ''
          ) = $4
          AND year = ANY($5::int[])
          AND (
            school_name = $1
            OR school_name ILIKE $2
            OR group_name ILIKE $2
          )
          AND (
            subject_track = ANY($6::text[])
            OR $3 = ''
            OR ($3 ~ '艺术|美术|设计|播音|编导|音乐|舞蹈|表演' AND subject_track = ANY($6::text[]))
          )
        ORDER BY
          year DESC,
          CASE
            WHEN school_name = $1 THEN 0
            WHEN school_name ILIKE $2 THEN 1
            ELSE 2
          END,
          min_score ASC NULLS LAST,
          min_rank ASC NULLS LAST
        LIMIT 180
      `,
      [args.schoolName, `%${args.schoolName}%`, args.subjectTrack, normalizedProvince, args.yearRange, variants],
    );

    if (!result.rows.length) return null;

    const admissionRows = toInstitutionAdmissionRows(result.rows);
    if (!admissionRows.length) {
      return {
        status: "partial",
        schoolName: args.schoolName,
        province: args.province,
        subjectTrack: args.subjectTrack,
        yearRange: args.yearRange,
        queryType: args.queryType,
        rows: [],
        chartPoints: [],
        sources: uniqueSourcesFromInstitutionLines(result.rows),
        freshness: "已命中 gaokao-vault 本地省考试院投档线表，但该来源未公开可绘图的最低分字段。",
        warnings: [
          "当前命中的官方表可能只有最低位次或专业投档信息，不足以直接绘制分数曲线。",
          "省考试院投档线不等同于院校各专业最终录取最低分。",
        ],
        message: "命中官方考试院投档信息，但缺少可绘图的最低分。",
      };
    }

    const chartPoints =
      args.queryType === "groupComparison"
        ? pointsForGroupComparison(admissionRows)
        : pointsForOverallTrend(admissionRows);

    return {
      status: "ok",
      schoolName: args.schoolName,
      province: args.province,
      subjectTrack: args.subjectTrack,
      yearRange: args.yearRange,
      queryType: args.queryType,
      rows: admissionRows,
      chartPoints,
      sources: uniqueSourcesFromInstitutionLines(result.rows),
      freshness: "已从 gaokao-vault 本地省考试院 2025 本科批投档线表读取。",
      warnings: [
        "这是省考试院公布的院校专业组/专业投档线口径，不等同于院校各专业最终录取最低分。",
      ],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/institution_admission_lines/.test(message)) return null;
    console.warn("[gaokao-vault] institution admission line lookup failed:", message);
    return null;
  }
}

export async function lookupAdmissionScoresFromVault(
  rawArgs: AdmissionLookupArgs,
): Promise<AdmissionLookupResult | null> {
  const pool = getGaokaoVaultPool();
  if (!pool) return null;

  const schoolName = rawArgs.schoolName.trim();
  const province = rawArgs.province.trim();
  const subjectTrack = rawArgs.subjectTrack.trim();
  if (!isSpecificSchoolName(schoolName)) return null;

  const yearRange = uniqueYears(rawArgs.yearRange);
  const queryType =
    rawArgs.queryType ?? (yearRange.length === 1 ? "groupComparison" : "overallTrend");
  const variants = subjectVariants(subjectTrack);
  const normalizedProvince = normalizeProvinceName(province);
  const normalizedArgs = { schoolName, province, subjectTrack, yearRange, queryType };

  const institutionResult = await lookupInstitutionAdmissionLinesFromVault(
    normalizedArgs,
    variants,
    normalizedProvince,
  );
  if (institutionResult) return institutionResult;

  try {
    const result = await pool.query<VaultAdmissionRow>(
      `
        SELECT
          mar.year,
          COALESCE(NULLIF(mar.school_name_raw, ''), s.name) AS school_name,
          p.name AS province,
          COALESCE(NULLIF(sc.name, ''), NULLIF(mar.subject_category_raw, ''), $3) AS subject_track,
          COALESCE(NULLIF(mar.major_name_raw, ''), m.name, '') AS major_name,
          NULLIF(
            concat_ws(
              ' · ',
              NULLIF(mar.batch, ''),
              NULLIF(mar.major_group_code, '')
            ),
            ''
          ) AS group_name,
          COALESCE(mar.max_score, mar.min_score, mar.avg_score) AS max_score,
          mar.min_score,
          COALESCE(mar.avg_score, mar.min_score) AS average_score,
          mar.min_rank AS rank,
          mar.source_url,
          mar.data_source
        FROM major_admission_results mar
        JOIN schools s ON s.id = mar.school_id
        JOIN provinces p ON p.id = mar.province_id
        LEFT JOIN subject_categories sc ON sc.id = mar.subject_category_id
        LEFT JOIN majors m ON m.id = mar.major_id
        WHERE
          (s.name = $1 OR s.name ILIKE $2 OR mar.school_name_raw ILIKE $2)
          AND regexp_replace(
            p.name,
            '(壮族自治区|回族自治区|维吾尔自治区|自治区|省|市)$',
            ''
          ) = $4
          AND mar.year = ANY($5::int[])
          AND (
            sc.name = ANY($6::text[])
            OR mar.subject_category_raw = ANY($6::text[])
            OR $3 = ''
          )
          AND mar.min_score IS NOT NULL
        ORDER BY mar.year DESC, mar.min_score ASC, mar.min_rank NULLS LAST
        LIMIT 120
      `,
      [schoolName, `%${schoolName}%`, subjectTrack, normalizedProvince, yearRange, variants],
    );

    if (!result.rows.length) return null;

    const admissionRows = toAdmissionRows(result.rows, {
      schoolName,
      province,
      subjectTrack,
      yearRange,
      queryType,
    });
    if (!admissionRows.length) return null;

    const chartPoints =
      queryType === "groupComparison"
        ? pointsForGroupComparison(admissionRows)
        : pointsForOverallTrend(admissionRows);
    const sourceUrl = result.rows.find((row) => row.source_url)?.source_url;

    return {
      status: "ok",
      schoolName,
      province,
      subjectTrack,
      yearRange,
      queryType,
      rows: admissionRows,
      chartPoints,
      sources: [vaultSource(sourceUrl)],
      freshness: "已从 gaokao-vault PostgreSQL 结构化库读取录取结果。",
      warnings: [
        "gaokao-vault 是第三方开源结构化数据仓库；正式填报前仍需核对省考试院和院校招生网。",
      ],
    };
  } catch (error) {
    console.warn(
      "[gaokao-vault] admission lookup failed:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

export async function lookupRankByScoreFromVault(args: RankLookupArgs) {
  const pool = getGaokaoVaultPool();
  if (!pool) return null;

  const normalizedProvince = normalizeProvinceName(args.province);
  const variants = subjectVariants(args.subjectTrack);

  try {
    const result = await pool.query<VaultRankRow>(
      `
        SELECT
          ss.score AS matched_score,
          ss.cumulative_count,
          p.name AS province,
          COALESCE(sc.name, $3) AS subject_track
        FROM score_segments ss
        JOIN provinces p ON p.id = ss.province_id
        LEFT JOIN subject_categories sc ON sc.id = ss.subject_category_id
        WHERE
          regexp_replace(
            p.name,
            '(壮族自治区|回族自治区|维吾尔自治区|自治区|省|市)$',
            ''
          ) = $1
          AND ss.year = $2
          AND (sc.name = ANY($4::text[]) OR ss.subject_category_id IS NULL OR $3 = '')
          AND ss.score <= $5
        ORDER BY
          CASE
            WHEN sc.name = ANY($4::text[]) THEN 0
            WHEN ss.subject_category_id IS NULL THEN 1
            ELSE 2
          END,
          ss.score DESC
        LIMIT 1
      `,
      [normalizedProvince, args.year, args.subjectTrack, variants, args.score],
    );

    const row = result.rows[0];
    if (!row) return null;

    const rank = numberOrFallback(row.cumulative_count, NaN);
    if (!Number.isFinite(rank)) return null;

    return {
      rank,
      matchedScore: numberOrFallback(row.matched_score, args.score),
      province: row.province || args.province,
      subjectTrack: row.subject_track || args.subjectTrack,
      source: vaultSource(),
    };
  } catch (error) {
    console.warn(
      "[gaokao-vault] rank lookup failed:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}
