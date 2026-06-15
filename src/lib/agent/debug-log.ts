import type { AgentIntent, StudentProfile, ToolName } from "./types";

type BeforePayload = {
  conversationId?: string;
  userMessage?: string;
  detectedIntent?: AgentIntent | string;
  selectedTool?: ToolName | string;
  missingFields?: string[];
  reason?: string;
  profileSnapshot?: StudentProfile | Record<string, unknown>;
};

type AfterPayload = {
  selectedTool?: ToolName | string;
  success: boolean;
  resultCount?: number;
  hasSources?: boolean;
  warnings?: string[];
  fallbackUsed?: boolean;
};

function isDebugEnabled() {
  return typeof process !== "undefined" && process.env.AGENT_DEBUG === "true";
}

function sanitizeProfile(profile: BeforePayload["profileSnapshot"]) {
  if (!profile || typeof profile !== "object") return undefined;
  const value = profile as StudentProfile;
  return {
    province: value.province,
    year: value.year,
    subjectTrack: value.subjectTrack,
    score: value.score,
    rank: value.rank,
    targetCities: value.targetCities ?? value.cityPreference,
    preferredMajors: value.preferredMajors ?? value.majorPreference,
    familyBudget: value.familyBudget ?? value.budget,
    riskPreference: value.riskPreference,
    acceptPrivate: value.acceptPrivate,
    acceptSinoForeign: value.acceptSinoForeign,
    graduatePlan: value.graduatePlan,
    familyType: value.familyType,
  };
}

export function logAgentToolCallBefore(payload: BeforePayload) {
  if (!isDebugEnabled()) return;
  console.info("[gaokao-agent][tool:before]", {
    conversationId: payload.conversationId ?? "unknown",
    userMessage: payload.userMessage?.slice(0, 500) ?? "",
    detectedIntent: payload.detectedIntent ?? "unknown",
    selectedTool: payload.selectedTool ?? "unknown",
    missingFields: payload.missingFields ?? [],
    reason: payload.reason ?? "",
    profileSnapshot: sanitizeProfile(payload.profileSnapshot),
  });
}

export function logAgentToolCallAfter(payload: AfterPayload) {
  if (!isDebugEnabled()) return;
  console.info("[gaokao-agent][tool:after]", {
    selectedTool: payload.selectedTool ?? "unknown",
    success: payload.success,
    resultCount: payload.resultCount ?? 0,
    hasSources: Boolean(payload.hasSources),
    warnings: payload.warnings ?? [],
    fallbackUsed: Boolean(payload.fallbackUsed),
  });
}

export function summarizeToolResult(result: unknown): Pick<AfterPayload, "success" | "resultCount" | "hasSources" | "warnings" | "fallbackUsed"> {
  const object = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
  const rows = Array.isArray(object.rows) ? object.rows : undefined;
  const chartPoints = Array.isArray(object.chartPoints) ? object.chartPoints : undefined;
  const results = Array.isArray(object.results) ? object.results : undefined;
  const tiers = Array.isArray(object.tiers) ? object.tiers : undefined;
  const schools = Array.isArray(object.schools) ? object.schools : undefined;
  const sources = Array.isArray(object.sources) ? object.sources : undefined;
  const warnings = Array.isArray(object.warnings)
    ? object.warnings.filter((item): item is string => typeof item === "string")
    : [];
  const status = typeof object.status === "string" ? object.status : "";
  const resultCount =
    rows?.length ??
    chartPoints?.length ??
    results?.length ??
    tiers?.length ??
    schools?.length ??
    0;

  return {
    success: !/error|needs_profile|needs_data|rate_limited/.test(status),
    resultCount,
    hasSources: Boolean(sources?.length || (object.source && typeof object.source === "object")),
    warnings,
    fallbackUsed: Boolean(object.fallbackUsed || object.fallbackFromAdapterError || object.tavilyConfigured === false),
  };
}
