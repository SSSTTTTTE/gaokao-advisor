export type QuarkCollege = {
  id?: string | number;
  name: string;
  province: string;
  city: string;
  type: string;
  year: number;
  tags: string[];
  rankScore: number | null;
  averageMonthlySalary: number | null;
  icon: string;
  raw: Record<string, unknown>;
};

export type QuarkCollegeListResult = {
  status: "ok" | "error";
  colleges: QuarkCollege[];
  totalCount: number;
  source: {
    id: "quark-public-college-list";
    title: string;
    url: string;
    publisher: "夸克高考";
    kind: "third_party_public_endpoint";
  };
  warning: string;
  message?: string;
};

type QueryOptions = {
  keyword?: string;
  province?: string;
  city?: string;
  type?: string;
  tag?: string;
  limit?: number;
};

type QuarkCollegeRaw = {
  id?: string | number;
  school_id?: string | number;
  name?: string;
  school_name?: string;
  city?: string;
  prov?: string;
  type?: string;
  year?: number;
  tags?: string[];
  rank_score?: number;
  avg_msalary?: number;
  icon?: string;
  [key: string]: unknown;
};

const QUARK_COLLEGE_LIST_URL = "https://gk.quark.cn/api/tools/college/getCollegeListV2";

function fetchWithTimeout(input: string, timeoutMs = 12_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new Error(`Request timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  return fetch(input, {
    headers: {
      accept: "application/json,text/plain,*/*",
    },
    signal: controller.signal,
  }).finally(() => {
    clearTimeout(timeout);
  });
}

function asString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function asNumberOrNull(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function normalizeCollege(raw: QuarkCollegeRaw): QuarkCollege | null {
  const name = asString(raw.name) || asString(raw.school_name);
  if (!name) return null;

  return {
    id: raw.id ?? raw.school_id,
    name,
    province: asString(raw.prov),
    city: asString(raw.city),
    type: asString(raw.type),
    year: typeof raw.year === "number" ? raw.year : new Date().getFullYear(),
    tags: Array.isArray(raw.tags) ? raw.tags.filter((tag): tag is string => typeof tag === "string") : [],
    rankScore: asNumberOrNull(raw.rank_score),
    averageMonthlySalary: asNumberOrNull(raw.avg_msalary),
    icon: asString(raw.icon),
    raw,
  };
}

function includesText(value: string, expected?: string) {
  if (!expected) return true;
  return value.toLowerCase().includes(expected.trim().toLowerCase());
}

function matchesCollege(college: QuarkCollege, options: QueryOptions) {
  return (
    includesText(college.name, options.keyword) &&
    includesText(college.province, options.province) &&
    includesText(college.city, options.city) &&
    includesText(college.type, options.type) &&
    (!options.tag || college.tags.some((tag) => includesText(tag, options.tag)))
  );
}

export async function lookupQuarkPublicColleges(
  options: QueryOptions = {},
): Promise<QuarkCollegeListResult> {
  const source = {
    id: "quark-public-college-list" as const,
    title: "夸克高考公开高校列表接口",
    url: QUARK_COLLEGE_LIST_URL,
    publisher: "夸克高考" as const,
    kind: "third_party_public_endpoint" as const,
  };
  const warning =
    "This uses a publicly reachable, undocumented Quark endpoint. Do not use it for final volunteer-filling decisions without confirming against official admissions sources.";

  try {
    const response = await fetchWithTimeout(QUARK_COLLEGE_LIST_URL);
    if (!response.ok) {
      return {
        status: "error",
        colleges: [],
        totalCount: 0,
        source,
        warning,
        message: `Quark public college list returned HTTP ${response.status}.`,
      };
    }

    const payload = await response.json();
    const rawColleges = Array.isArray(payload?.data?.colleges) ? payload.data.colleges : [];
    const colleges = rawColleges
      .map((college: QuarkCollegeRaw) => normalizeCollege(college))
      .filter((college: QuarkCollege | null): college is QuarkCollege => Boolean(college))
      .filter((college: QuarkCollege) => matchesCollege(college, options))
      .slice(0, Math.min(Math.max(options.limit ?? 30, 1), 100));

    return {
      status: "ok",
      colleges,
      totalCount: typeof payload?.data?.total_count === "number" ? payload.data.total_count : rawColleges.length,
      source,
      warning,
    };
  } catch (error) {
    return {
      status: "error",
      colleges: [],
      totalCount: 0,
      source,
      warning,
      message: error instanceof Error ? error.message : "Unknown Quark public college list error.",
    };
  }
}
