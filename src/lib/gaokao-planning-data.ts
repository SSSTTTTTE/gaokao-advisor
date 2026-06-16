import { getGaokaoVaultPool } from "./gaokao-vault-data";
import type { StudentProfile } from "./agent/types";

const VAULT_REPO_URL = "https://github.com/lifefloating/gaokao-vault";

type Source = {
  id: string;
  title: string;
  url: string;
  publisher: string;
  kind: "official" | "gaokao_vault";
};

type EnrollmentPlanArgs = {
  province: string;
  year: number;
  subjectTrack: string;
  schoolName?: string;
  majorName?: string;
  batch?: string;
};

type AdmissionRequirementsArgs = {
  schoolName: string;
  year: number;
  province?: string;
  majorName?: string;
  groupName?: string;
};

type AdmissionRankTrendArgs = {
  schoolName: string;
  province: string;
  subjectTrack: string;
  yearRange: number[];
  queryType?: "overallTrend" | "groupComparison";
};

export type VolunteerPlanItem = {
  schoolName: string;
  groupName?: string;
  majorName?: string;
  majorDirection?: string;
  tier?: "冲" | "稳" | "保" | string;
};

type VolunteerListValidationArgs = {
  profile: StudentProfile;
  items: VolunteerPlanItem[];
};

type EnrollmentPlanRow = {
  year: number;
  school_name: string;
  province: string;
  subject_track: string | null;
  batch: string | null;
  major_name: string | null;
  plan_count: number | string | null;
  duration: string | null;
  tuition: string | null;
  note: string | null;
  major_group_code: string | null;
  major_code_raw: string | null;
  campus: string | null;
  education_location: string | null;
  selection_requirement: string | null;
  physical_exam_limit: string | null;
  single_subject_limit: string | null;
  adjustment_rule: string | null;
  program_type: string | null;
  eligibility_requirements: string | null;
  physical_exam_or_political_review: string | null;
  political_review_requirement: string | null;
  service_obligation: string | null;
  data_source: string | null;
  source_url: string | null;
};

type EnrollmentPlanOutputRow = {
  year: number;
  schoolName: string;
  province: string;
  subjectTrack: string;
  batch: string;
  groupCode: string;
  majorCode: string;
  majorName: string;
  planCount: number | null;
  duration: string;
  tuition: string;
  campus: string;
  selectionRequirement: string;
  physicalExamLimit: string;
  singleSubjectLimit: string;
  adjustmentRule: string;
  programType: string;
  eligibilityRequirements: string;
  politicalReviewRequirement: string;
  serviceObligation: string;
  note: string;
  sourceId: string;
};

type CharterRow = {
  school_name: string;
  year: number;
  title: string;
  content: string | null;
  publish_date: string | null;
  source_url: string | null;
};

type InstitutionLineRow = {
  year: number;
  province_name: string;
  subject_track: string;
  batch: string | null;
  school_name: string;
  group_name: string | null;
  major_name: string | null;
  min_score: number | string | null;
  min_rank: number | string | null;
  source_title: string;
  source_url: string;
  source_publisher: string;
};

type ScoreRankRow = {
  rank: number | string | null;
};

type AdmissionRankTrendPoint = {
  year: number;
  schoolName: string;
  province: string;
  subjectTrack: string;
  batch: string;
  groupName: string;
  majorName: string;
  score: number;
  rank: number | null;
  rankSource: "official_line" | "score_segments" | "missing";
  sourceId: string;
};

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

function numberOrNull(value: number | string | null | undefined) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function vaultSource(url?: string | null): Source {
  return {
    id: "gaokao-vault",
    title: "gaokao-vault 官方结构化入库数据",
    url: url || VAULT_REPO_URL,
    publisher: "lifefloating/gaokao-vault",
    kind: "gaokao_vault",
  };
}

function officialSource(title: string, url?: string | null, publisher = "官方来源"): Source {
  return {
    id: `official-${url || title}`.replace(/[^\w-]/g, "-").slice(0, 96),
    title,
    url: url || "",
    publisher,
    kind: "official",
  };
}

function uniqueSources(sources: Source[]) {
  const byUrl = new Map<string, Source>();
  for (const source of sources) {
    const key = source.url || source.id;
    if (!byUrl.has(key)) byUrl.set(key, source);
  }
  return Array.from(byUrl.values());
}

function missingDataResult(kind: string, request: unknown, message: string) {
  return {
    status: "needs_data_source",
    kind,
    request,
    rows: [],
    sources: [],
    warnings: [
      "当前只允许使用官方来源；未命中官方结构化数据时不能编造招生计划、章程规则或录取概率。",
    ],
    message,
  };
}

function hasRiskKeyword(value: string | null | undefined) {
  return Boolean(
    value &&
      /色盲|色弱|体检|政审|口试|外语|英语|单科|身高|视力|听力|嗅觉|肝功能|转氨酶|不宜|限报|只招|男生|女生|服务期|定向/.test(
        value,
      ),
  );
}

function makeRequirementSnippets(content: string | null | undefined) {
  if (!content) return [];
  const text = content.replace(/\s+/g, " ").trim();
  const snippets: string[] = [];
  const patterns = [
    /(?:录取规则|专业录取|分数优先|专业优先|专业级差|调剂)[^。；;]{0,160}/g,
    /(?:体检|色盲|色弱|限报|不宜|政审)[^。；;]{0,160}/g,
    /(?:外语|英语|口试|单科成绩)[^。；;]{0,160}/g,
    /(?:中外合作|学费|收费|培养地点|证书)[^。；;]{0,160}/g,
  ];

  for (const pattern of patterns) {
    for (const match of Array.from(text.matchAll(pattern))) {
      const snippet = match[0]?.trim();
      if (snippet && !snippets.includes(snippet)) snippets.push(snippet);
      if (snippets.length >= 8) return snippets;
    }
  }
  return snippets;
}

export async function lookupEnrollmentPlanFromVault(args: EnrollmentPlanArgs): Promise<{
  status: string;
  kind: string;
  request: unknown;
  rows: EnrollmentPlanOutputRow[];
  sources: Source[];
  warnings: string[];
  message?: string;
  error?: string;
}> {
  const pool = getGaokaoVaultPool();
  if (!pool) {
    return missingDataResult("enrollment_plan", args, "GAOKAO_VAULT_DATABASE_URL 未配置，无法查询官方招生计划入库数据。");
  }

  const province = normalizeProvinceName(args.province);
  const variants = subjectVariants(args.subjectTrack);

  try {
    const result = await pool.query<EnrollmentPlanRow>(
      `
        SELECT
          ep.year,
          s.name AS school_name,
          p.name AS province,
          sc.name AS subject_track,
          ep.batch,
          ep.major_name,
          ep.plan_count,
          ep.duration,
          ep.tuition,
          ep.note,
          ep.major_group_code,
          ep.major_code_raw,
          ep.campus,
          ep.education_location,
          ep.selection_requirement,
          ep.physical_exam_limit,
          ep.single_subject_limit,
          ep.adjustment_rule,
          ep.program_type,
          ep.eligibility_requirements,
          ep.physical_exam_or_political_review,
          ep.political_review_requirement,
          ep.service_obligation,
          ep.data_source,
          ep.source_url
        FROM enrollment_plans ep
        JOIN schools s ON s.id = ep.school_id
        JOIN provinces p ON p.id = ep.province_id
        LEFT JOIN subject_categories sc ON sc.id = ep.subject_category_id
        WHERE
          regexp_replace(p.name, '(壮族自治区|回族自治区|维吾尔自治区|自治区|省|市)$', '') = $1
          AND ep.year = $2
          AND (sc.name = ANY($3::text[]) OR ep.subject_category_id IS NULL OR $4 = '')
          AND ($5 = '' OR s.name = $5 OR s.name ILIKE $6)
          AND ($7 = '' OR ep.major_name ILIKE $8)
          AND ($9 = '' OR ep.batch ILIKE $10)
        ORDER BY
          CASE WHEN s.name = $5 THEN 0 ELSE 1 END,
          s.name,
          ep.major_group_code NULLS LAST,
          ep.major_name NULLS LAST
        LIMIT 160
      `,
      [
        province,
        args.year,
        variants,
        args.subjectTrack,
        args.schoolName?.trim() ?? "",
        `%${args.schoolName?.trim() ?? ""}%`,
        args.majorName?.trim() ?? "",
        `%${args.majorName?.trim() ?? ""}%`,
        args.batch?.trim() ?? "",
        `%${args.batch?.trim() ?? ""}%`,
      ],
    );

    if (!result.rows.length) {
      return missingDataResult("enrollment_plan", args, "未命中 2026 官方招生计划入库数据；请补充阳光高考、省考试院或高校招生网官方来源。");
    }

    return {
      status: "ok",
      kind: "enrollment_plan",
      request: args,
      rows: result.rows.map((row): EnrollmentPlanOutputRow => ({
        year: row.year,
        schoolName: row.school_name,
        province: row.province,
        subjectTrack: row.subject_track || args.subjectTrack,
        batch: row.batch || "",
        groupCode: row.major_group_code || "",
        majorCode: row.major_code_raw || "",
        majorName: row.major_name || "",
        planCount: numberOrNull(row.plan_count),
        duration: row.duration || "",
        tuition: row.tuition || "",
        campus: row.campus || row.education_location || "",
        selectionRequirement: row.selection_requirement || "",
        physicalExamLimit: row.physical_exam_limit || row.physical_exam_or_political_review || "",
        singleSubjectLimit: row.single_subject_limit || "",
        adjustmentRule: row.adjustment_rule || "",
        programType: row.program_type || "",
        eligibilityRequirements: row.eligibility_requirements || "",
        politicalReviewRequirement: row.political_review_requirement || "",
        serviceObligation: row.service_obligation || "",
        note: row.note || "",
        sourceId: row.source_url ? `official-${row.source_url}` : "gaokao-vault",
      })),
      sources: uniqueSources(
        result.rows.map((row) =>
          row.source_url
            ? officialSource(row.data_source || "官方招生计划", row.source_url, "官方招生计划来源")
            : vaultSource(),
        ),
      ),
      warnings: [
        "招生计划以 2026 官方入库数据为准；正式填报时仍需核对省考试院志愿填报系统。",
      ],
    };
  } catch (error) {
    return {
      ...missingDataResult("enrollment_plan", args, "招生计划表查询失败。"),
      status: "error",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function lookupAdmissionRequirementsFromVault(args: AdmissionRequirementsArgs) {
  const pool = getGaokaoVaultPool();
  if (!pool) {
    return missingDataResult("admission_requirements", args, "GAOKAO_VAULT_DATABASE_URL 未配置，无法查询招生章程入库数据。");
  }

  try {
    const charterResult = await pool.query<CharterRow>(
      `
        SELECT s.name AS school_name, ac.year, ac.title, ac.content, ac.publish_date, ac.source_url
        FROM admission_charters ac
        JOIN schools s ON s.id = ac.school_id
        WHERE (s.name = $1 OR s.name ILIKE $2)
          AND ac.year = $3
        ORDER BY CASE WHEN s.name = $1 THEN 0 ELSE 1 END, ac.publish_date DESC NULLS LAST
        LIMIT 3
      `,
      [args.schoolName.trim(), `%${args.schoolName.trim()}%`, args.year],
    );

    const planResult =
      args.province || args.majorName || args.groupName
        ? await lookupEnrollmentPlanFromVault({
            province: args.province || "",
            year: args.year,
            subjectTrack: "",
            schoolName: args.schoolName,
            majorName: args.majorName,
          })
        : null;

    const planRows: EnrollmentPlanOutputRow[] =
      planResult && "rows" in planResult && Array.isArray(planResult.rows)
        ? planResult.rows.filter((row) => {
            const groupName = "groupCode" in row ? String(row.groupCode) : "";
            return !args.groupName || groupName.includes(args.groupName) || String(row.majorName).includes(args.groupName);
          })
        : [];

    if (!charterResult.rows.length && !planRows.length) {
      return missingDataResult("admission_requirements", args, "未命中 2026 官方招生章程或专业限制入库数据。");
    }

    const requirementRows = planRows.map((row) => ({
      schoolName: row.schoolName,
      majorName: row.majorName,
      groupCode: row.groupCode,
      selectionRequirement: row.selectionRequirement,
      physicalExamLimit: row.physicalExamLimit,
      singleSubjectLimit: row.singleSubjectLimit,
      adjustmentRule: row.adjustmentRule,
      eligibilityRequirements: row.eligibilityRequirements,
      politicalReviewRequirement: row.politicalReviewRequirement,
      serviceObligation: row.serviceObligation,
      riskFlags: [
        hasRiskKeyword(row.physicalExamLimit) ? "体检/限报要求" : "",
        hasRiskKeyword(row.singleSubjectLimit) ? "单科/外语要求" : "",
        hasRiskKeyword(row.politicalReviewRequirement) ? "政审要求" : "",
        hasRiskKeyword(row.serviceObligation) ? "定向/服务期要求" : "",
      ].filter(Boolean),
    }));

    return {
      status: "ok",
      kind: "admission_requirements",
      request: args,
      charters: charterResult.rows.map((row) => ({
        schoolName: row.school_name,
        year: row.year,
        title: row.title,
        publishDate: row.publish_date,
        snippets: makeRequirementSnippets(row.content),
        sourceId: row.source_url ? `official-${row.source_url}` : "gaokao-vault",
      })),
      requirementRows,
      sources: uniqueSources([
        ...charterResult.rows.map((row) =>
          officialSource(row.title, row.source_url, `${row.school_name}招生办公室`),
        ),
        ...(planResult && "sources" in planResult && Array.isArray(planResult.sources)
          ? planResult.sources
          : []),
      ]),
      warnings: [
        "章程摘要只截取关键规则片段；涉及体检、调剂、中外合作和证书时必须打开原文复核。",
      ],
    };
  } catch (error) {
    return {
      ...missingDataResult("admission_requirements", args, "招生章程查询失败。"),
      status: "error",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function rankForScore(args: {
  province: string;
  year: number;
  subjectTrack: string;
  score: number;
}) {
  const pool = getGaokaoVaultPool();
  if (!pool) return null;
  const variants = subjectVariants(args.subjectTrack);
  const province = normalizeProvinceName(args.province);
  const result = await pool.query<ScoreRankRow>(
    `
      SELECT ss.cumulative_count AS rank
      FROM score_segments ss
      JOIN provinces p ON p.id = ss.province_id
      LEFT JOIN subject_categories sc ON sc.id = ss.subject_category_id
      WHERE regexp_replace(p.name, '(壮族自治区|回族自治区|维吾尔自治区|自治区|省|市)$', '') = $1
        AND ss.year = $2
        AND (sc.name = ANY($3::text[]) OR ss.subject_category_id IS NULL OR $4 = '')
        AND ss.score <= $5
      ORDER BY
        CASE WHEN sc.name = ANY($3::text[]) THEN 0 WHEN ss.subject_category_id IS NULL THEN 1 ELSE 2 END,
        ss.score DESC
      LIMIT 1
    `,
    [province, args.year, variants, args.subjectTrack, args.score],
  );
  return numberOrNull(result.rows[0]?.rank);
}

export async function lookupAdmissionRankTrendFromVault(args: AdmissionRankTrendArgs) {
  const pool = getGaokaoVaultPool();
  if (!pool) {
    return missingDataResult("admission_rank_trend", args, "GAOKAO_VAULT_DATABASE_URL 未配置，无法查询投档位次趋势。");
  }

  const province = normalizeProvinceName(args.province);
  const variants = subjectVariants(args.subjectTrack);
  const years = Array.from(new Set(args.yearRange)).filter((year) => year >= 2000 && year <= 2030);

  try {
    const result = await pool.query<InstitutionLineRow>(
      `
        SELECT
          year,
          province_name,
          subject_track,
          batch,
          school_name,
          group_name,
          major_name,
          min_score,
          min_rank,
          source_title,
          source_url,
          source_publisher
        FROM institution_admission_lines
        WHERE regexp_replace(province_name, '(壮族自治区|回族自治区|维吾尔自治区|自治区|省|市)$', '') = $1
          AND year = ANY($2::int[])
          AND (school_name = $3 OR school_name ILIKE $4 OR group_name ILIKE $4)
          AND (subject_track = ANY($5::text[]) OR $6 = '')
          AND min_score IS NOT NULL
        ORDER BY year ASC, min_rank ASC NULLS LAST, min_score ASC
        LIMIT 180
      `,
      [province, years, args.schoolName.trim(), `%${args.schoolName.trim()}%`, variants, args.subjectTrack],
    );

    if (!result.rows.length) {
      return missingDataResult("admission_rank_trend", args, "未命中可计算位次趋势的官方投档线入库数据。");
    }

    const representativeRows =
      args.queryType === "groupComparison"
        ? result.rows
        : Array.from(
            result.rows
              .reduce((groups, row) => {
                const current = groups.get(row.year);
                const currentScore = numberOrNull(current?.min_score) ?? Number.POSITIVE_INFINITY;
                const rowScore = numberOrNull(row.min_score) ?? Number.POSITIVE_INFINITY;
                if (!current || rowScore < currentScore) groups.set(row.year, row);
                return groups;
              }, new Map<number, InstitutionLineRow>())
              .values(),
          );

    const points: AdmissionRankTrendPoint[] = [];
    for (const row of representativeRows) {
      const score = numberOrNull(row.min_score);
      if (score === null) continue;
      const directRank = numberOrNull(row.min_rank);
      const derivedRank = directRank ?? (await rankForScore({
        province: row.province_name,
        year: row.year,
        subjectTrack: row.subject_track,
        score,
      }));
      points.push({
        year: row.year,
        schoolName: row.school_name,
        province: row.province_name,
        subjectTrack: row.subject_track,
        batch: row.batch || "",
        groupName: row.group_name || "最低门槛",
        majorName: row.major_name || "",
        score,
        rank: derivedRank,
        rankSource: directRank ? "official_line" : derivedRank ? "score_segments" : "missing",
        sourceId: `official-${row.source_url}`,
      });
    }

    const sorted = points.sort((a, b) => a.year - b.year || a.score - b.score);
    const rankValues = sorted.map((point) => point.rank).filter((rank): rank is number => typeof rank === "number");
    const latest = sorted.at(-1);
    const previous = sorted.at(-2);
    const rankDelta = latest?.rank && previous?.rank ? latest.rank - previous.rank : null;
    const riskSignal =
      rankDelta === null
        ? "位次缺口较多，只能按分数和专业组口径辅助判断。"
        : rankDelta < -3000
          ? "最低位次明显前移，报考风险上升。"
          : rankDelta > 3000
            ? "最低位次后移，历史门槛有所下降。"
            : "最低位次波动不大，仍需结合 2026 招生计划判断。";

    return {
      status: rankValues.length ? "ok" : "partial",
      kind: "admission_rank_trend",
      request: args,
      points: sorted,
      riskSignal,
      sources: uniqueSources(
        result.rows.map((row) => officialSource(row.source_title, row.source_url, row.source_publisher)),
      ),
      warnings: [
        "2026 最终录取线尚未形成；这里用历史投档线和一分一段估算位次趋势。",
        "省考试院投档线不等同于学校专业最终录取最低分。",
      ],
    };
  } catch (error) {
    return {
      ...missingDataResult("admission_rank_trend", args, "投档位次趋势查询失败。"),
      status: "error",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function validateVolunteerListWithVault(args: VolunteerListValidationArgs) {
  const profile = args.profile;
  const items = args.items.slice(0, 60);
  const issues: Array<{
    severity: "error" | "warning" | "info";
    itemIndex?: number;
    schoolName?: string;
    title: string;
    detail: string;
  }> = [];

  if (!profile.province) issues.push({ severity: "error", title: "缺少高考省份", detail: "无法判断投档省份和招生计划适配。" });
  if (!profile.subjectTrack) issues.push({ severity: "error", title: "缺少科类/选科", detail: "无法校验专业组选科要求。" });
  if (!profile.score && !profile.rank) issues.push({ severity: "warning", title: "缺少分数或位次", detail: "只能做规则校验，不能判断冲稳保梯度。" });
  if (!items.length) issues.push({ severity: "error", title: "志愿清单为空", detail: "请至少提供一个院校或专业组。" });

  const pool = getGaokaoVaultPool();
  if (!pool) {
    return {
      status: "needs_data_source",
      kind: "volunteer_list_validation",
      profile,
      items,
      issues,
      sources: [],
      warnings: ["GAOKAO_VAULT_DATABASE_URL 未配置，只能做画像完整性检查。"],
    };
  }

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!item.schoolName) {
      issues.push({ severity: "error", itemIndex: index, title: "缺少院校名称", detail: "每个志愿项必须有院校名称。" });
      continue;
    }

    if (profile.province && profile.subjectTrack) {
      const plan = await lookupEnrollmentPlanFromVault({
        province: profile.province,
        year: profile.year ?? 2026,
        subjectTrack: profile.subjectTrack,
        schoolName: item.schoolName,
        majorName: item.majorName || item.majorDirection,
      });

      if (plan.status === "needs_data_source") {
        issues.push({
          severity: "warning",
          itemIndex: index,
          schoolName: item.schoolName,
          title: "缺少 2026 官方招生计划",
          detail: "不能确认该院校/专业是否在本省招生、招几人或是否有选科/体检限制。",
        });
      } else if ("rows" in plan && plan.rows.length) {
        const riskyRows = plan.rows.filter(
          (row) =>
            hasRiskKeyword(row.physicalExamLimit) ||
            hasRiskKeyword(row.singleSubjectLimit) ||
            hasRiskKeyword(row.eligibilityRequirements) ||
            hasRiskKeyword(row.politicalReviewRequirement),
        );
        if (riskyRows.length) {
          issues.push({
            severity: "warning",
            itemIndex: index,
            schoolName: item.schoolName,
            title: "存在限报或附加要求",
            detail: `${riskyRows.slice(0, 3).map((row) => row.majorName || row.groupCode || "专业组").join("、")} 有体检、单科、政审或资格要求。`,
          });
        }
        if (plan.rows.some((row) => row.planCount !== null && row.planCount <= 2)) {
          issues.push({
            severity: "info",
            itemIndex: index,
            schoolName: item.schoolName,
            title: "招生人数偏少",
            detail: "部分专业计划数不超过 2 人，波动风险较高，保底项不宜依赖。",
          });
        }
      }
    }
  }

  const tiers = items.map((item) => item.tier).filter(Boolean);
  if (tiers.length && (!tiers.includes("稳") || !tiers.includes("保"))) {
    issues.push({
      severity: "warning",
      title: "冲稳保结构不完整",
      detail: "志愿表至少应保留稳妥和保底层，不能只堆冲刺项。",
    });
  }

  const status = issues.some((issue) => issue.severity === "error") ? "error" : "ok";
  return {
    status,
    kind: "volunteer_list_validation",
    profile,
    items,
    issues,
    sources: [vaultSource()],
    warnings: [
      "校验结果只排查明显规则风险，不代表录取承诺。",
      "正式填报前必须以省考试院志愿填报系统和院校招生章程原文为准。",
    ],
  };
}
