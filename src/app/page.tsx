"use client";

import {
  CopilotChat,
  CopilotKitProvider,
  defineToolCallRenderer,
  useAgentContext,
  useAgent,
  useComponent,
  useCopilotKit,
} from "@copilotkit/react-core/v2";
import {
  AcademicCapIcon,
  AdjustmentsHorizontalIcon,
  ArrowDownTrayIcon,
  BookOpenIcon,
  BuildingLibraryIcon,
  CheckBadgeIcon,
  CpuChipIcon,
  MapPinIcon,
  PaperAirplaneIcon,
  PencilSquareIcon,
  RocketLaunchIcon,
  ShieldCheckIcon,
  StarIcon,
  TrophyIcon,
  WalletIcon,
} from "@heroicons/react/24/outline";
import type { ToolsMenuItem } from "@copilotkit/react-core/v2";
import type { MutableRefObject, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { z } from "zod";
import { buildAgentRouterContext } from "@/lib/agent/context-builder";
import {
  DEFAULT_RANK_REFERENCE_YEAR,
  buildProfileKeyFacts,
  extractStudentProfilePatch,
  mergeStudentProfile,
  normalizeProvinceForAgent,
  withDerivedStudentProfile,
} from "@/lib/agent/profile-extractor";
import { routeAgentTurn } from "@/lib/agent/tool-router";
import type { RouterDecision, StudentProfile as AgentStudentProfile } from "@/lib/agent/types";

export const dynamic = "force-dynamic";

const SESSION_STORAGE_KEY = "gaokao-advisor.sessions";
const ACTIVE_SESSION_STORAGE_KEY = "gaokao-advisor.activeSessionId";
const PROFILE_STORAGE_KEY = "gaokao-advisor.profileBySession";
const SUMMARY_STORAGE_KEY = "gaokao-advisor.summaryBySession";
const TURN_CONTEXT_STORAGE_KEY = "gaokao-advisor.turnContextBySession";
const SUGGESTIONS_STORAGE_KEY = "gaokao-advisor.suggestionsBySession";
const IGNORED_MISSING_STORAGE_KEY = "gaokao-advisor.ignoredMissingBySession";
const PROFILE_PANEL_COLLAPSED_STORAGE_KEY = "gaokao-advisor.profilePanelCollapsedBySession";
const RANK_META_STORAGE_KEY = "gaokao-advisor.rankMetaBySession";
const COMPOSER_DRAFT_EVENT = "gaokao:set-composer-draft";
const COPILOT_CHAT_TEXTAREA_SELECTOR = '[data-testid="copilot-chat-textarea"]';
const COPILOT_SEND_BUTTON_SELECTOR = '[data-testid="copilot-send-button"]';

const CURRENT_AGENT_DATE = "2026-06-13";
const GAOKAO_STAGE_CONTEXT =
  "当前日期是 2026-06-13，时区 Asia/Shanghai。2026 年全国统考已于 2026-06-07 至 2026-06-08 举行；新高考地区可能延续到 2026-06-09 或 2026-06-10。现在应按高考后查分/志愿准备阶段处理，具体省份安排以省考试院为准。";

const installBoundFetchShim = () => {
  if (typeof window === "undefined") return;
  const currentFetch = window.fetch;
  if (!currentFetch || Reflect.get(currentFetch, "__gaokaoBoundFetch")) return;

  const boundFetch = currentFetch.bind(window);
  Reflect.set(boundFetch, "__gaokaoBoundFetch", true);
  window.fetch = boundFetch;
};

installBoundFetchShim();

const scoreLinePointSchema = z.object({
  year: z.number().int().describe("录取年份"),
  score: z.number().describe("最低投档分或录取最低分"),
  rank: z.number().describe("最低位次；未知时传 -1"),
  groupName: z.string().describe("专业组或趋势标签，例如 23专业组(物理+化学)、最低门槛"),
  majorName: z.string().describe("触发该最低分的专业或代表专业；未知时传空字符串"),
  sourceId: z.string().describe("来源 id，对应 sources[].id"),
});

const scoreLineTrendChartSchema = z.object({
  schoolName: z.string().describe("院校名称，例如 苏州大学"),
  province: z.string().describe("招生省份，例如 江苏"),
  subjectTrack: z.string().describe("科类或选科，例如 物理类"),
  dataScope: z
    .enum(["examAuthorityGroupLine", "schoolMajorScore", "thirdPartyAggregate", "mixed"])
    .optional()
    .describe("数据口径：考试院专业组投档线、学校专业录取分、第三方聚合或混合口径"),
  mode: z
    .enum(["overallTrend", "groupComparison"])
    .describe("overallTrend 展示多年最低门槛趋势；groupComparison 展示单年专业组对比"),
  points: z.array(scoreLinePointSchema).min(1).describe("图表数据点"),
  sources: z
    .array(
      z.object({
        id: z.string().describe("来源 id"),
        title: z.string(),
        url: z.string().describe("来源链接；没有链接时传空字符串"),
        publisher: z.string().optional(),
        kind: z.string().optional(),
      }),
    )
    .min(1)
    .describe("图表数据来源"),
  analysisSummary: z.string().describe("用一两句话总结趋势和报考含义"),
  warnings: z.array(z.string()).optional().describe("数据限制，例如位次缺失、来源解析不足"),
});

type ScoreLineTrendChartArgs = Partial<z.infer<typeof scoreLineTrendChartSchema>> & {
  years?: number[];
  scores?: number[];
  ranks?: number[];
};

const studentProfileSchema = z.object({
  province: z.string().optional().describe("高考省份"),
  year: z.number().optional().describe("高考年份或参考年份"),
  subjectTrack: z.string().optional().describe("科类或选科"),
  score: z.number().optional().describe("高考分数"),
  rank: z.number().optional().describe("位次"),
  targetCities: z.array(z.string()).optional().describe("目标城市/地区"),
  preferredMajors: z.array(z.string()).optional().describe("偏好的专业方向"),
  familyBudget: z.string().optional().describe("家庭预算或学费承受能力"),
  riskPreference: z.enum(["冲刺", "稳妥", "保守"]).optional().describe("风险偏好"),
  acceptPrivate: z.boolean().optional().describe("是否接受民办"),
  acceptSinoForeign: z.boolean().optional().describe("是否接受中外合作"),
  budget: z.string().optional().describe("家庭预算或学费承受能力"),
  cityPreference: z.string().optional().describe("城市偏好"),
  canLeaveProvince: z.boolean().optional().describe("是否接受出省"),
  graduatePlan: z.string().optional().describe("读研/保研/就业倾向"),
  majorPreference: z.array(z.string()).optional().describe("偏好的专业方向"),
  avoidMajors: z.array(z.string()).optional().describe("明确避开的专业方向"),
  familyType: z.string().optional().describe("家庭约束，例如普通家庭"),
  updatedAt: z.string().optional(),
});

const studentProfileSummarySchema = z.object({
  profile: studentProfileSchema.optional(),
  missingFields: z.array(z.string()).optional(),
  nextQuestions: z.array(z.string()).optional(),
});

const followUpQuestionOptionsSchema = z.object({
  questions: z
    .array(
      z.object({
        field: z.string().optional().describe("关联画像字段，例如 rank、budget、cityPreference"),
        question: z.string().describe("要追问用户的问题"),
        options: z
          .array(
            z.object({
              label: z.string().describe("按钮文案"),
              value: z.string().optional().describe("选项值"),
              prompt: z.string().optional().describe("点击后提交给 agent 的完整回复"),
            }),
          )
          .min(1)
          .max(6),
      }),
    )
    .min(1)
    .max(5),
});

const cardSourceSchema = z.object({
  id: z.string(),
  title: z.string(),
  url: z.string().optional(),
  publisher: z.string().optional(),
  kind: z.string().optional(),
});

const volunteerPlanCardsSchema = z.object({
  profile: studentProfileSchema.optional(),
  tiers: z.array(
    z.object({
      tier: z.enum(["冲", "稳", "保"]),
      items: z.array(
        z.object({
          schoolName: z.string(),
          groupName: z.string().optional(),
          majorDirection: z.string(),
          evidence: z.string(),
          riskLevel: z.string(),
          reason: z.string(),
          sourceIds: z.array(z.string()).optional(),
        }),
      ),
    }),
  ).optional().default([]),
  warnings: z.array(z.string()).optional(),
  sources: z.array(cardSourceSchema).optional(),
});

const admissionRiskCardsSchema = z.object({
  targetUserType: z.string().optional(),
  avoid: z.array(z.object({ title: z.string(), reason: z.string() })).optional(),
  cautious: z.array(z.object({ title: z.string(), reason: z.string() })).optional(),
  suitable: z.array(z.object({ title: z.string(), reason: z.string() })).optional(),
  summary: z.string().optional(),
});

const schoolComparisonCardSchema = z.object({
  profile: studentProfileSchema.optional(),
  schools: z.array(
    z.object({
      schoolName: z.string(),
      scoreRisk: z.string(),
      cityValue: z.string(),
      majorFit: z.string(),
      employmentView: z.string(),
      familyFit: z.string(),
      verdict: z.string(),
    }),
  ).optional().default([]),
  sources: z.array(cardSourceSchema).optional(),
  warnings: z.array(z.string()).optional(),
});

type StudentProfile = z.infer<typeof studentProfileSchema>;
type StudentProfileSummaryArgs = z.infer<typeof studentProfileSummarySchema>;
type FollowUpQuestionOptionsArgs = z.infer<typeof followUpQuestionOptionsSchema>;
type VolunteerPlanCardsArgs = z.infer<typeof volunteerPlanCardsSchema>;
type AdmissionRiskCardsArgs = z.infer<typeof admissionRiskCardsSchema>;
type SchoolComparisonCardArgs = z.infer<typeof schoolComparisonCardSchema>;

type RankMeta = {
  year: number;
  source: "user" | "auto2025";
  matchedScore?: number;
  note?: string;
  sourceTitle?: string;
};

type TurnContext = {
  rawPrompt: string;
  keyFacts: string[];
  profilePatch: Partial<StudentProfile>;
  profileAfterTurn: StudentProfile;
  toolRoute: RouterDecision;
  missingPriority: Array<keyof StudentProfile>;
  sessionSummary: string;
  suggestions: string[];
  ambiguityWarnings: string[];
  updatedAt: string;
};

type PreprocessResponse = {
  keyFacts?: string[];
  profilePatch?: Partial<StudentProfile>;
  missingPriority?: string[];
  sessionSummary?: string;
  suggestions?: string[];
  ambiguityWarnings?: string[];
};

type RankHydrationResponse =
  | {
      status: "ok";
      rank: number;
      matchedScore: number;
      year?: number;
      province: string;
      subjectTrack: string;
      source?: { title?: string; url?: string };
      rankSourceLabel?: string;
    }
  | {
      status: "not_found" | "error";
      message?: string;
    };

type LocalSession = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  titleSource?: "default" | "auto" | "manual";
};

const DEFAULT_SESSION: LocalSession = {
  id: "gaokao-thread-default",
  title: "志愿填报",
  createdAt: "2026-06-13T00:00:00.000+08:00",
  updatedAt: "2026-06-13T00:00:00.000+08:00",
  titleSource: "default",
};

function Icon({
  name,
  className = "h-4 w-4",
}: {
  name: "plus" | "trash" | "edit" | "search" | "chart" | "message" | "clock" | "send" | "check";
  className?: string;
}) {
  const common = {
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };

  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={className} {...common}>
      {name === "plus" ? (
        <>
          <path d="M12 5v14" />
          <path d="M5 12h14" />
        </>
      ) : name === "trash" ? (
        <>
          <path d="M3 6h18" />
          <path d="M8 6V4h8v2" />
          <path d="M19 6l-1 14H6L5 6" />
        </>
      ) : name === "edit" ? (
        <>
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
        </>
      ) : name === "search" ? (
        <>
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </>
      ) : name === "chart" ? (
        <>
          <path d="M4 19V5" />
          <path d="M4 19h16" />
          <path d="m7 15 4-5 3 3 5-7" />
        </>
      ) : name === "clock" ? (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </>
      ) : name === "send" ? (
        <>
          <path d="M12 19V5" />
          <path d="m5 12 7-7 7 7" />
        </>
      ) : name === "check" ? (
        <path d="M20 6 9 17l-5-5" />
      ) : (
        <>
          <path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z" />
        </>
      )}
    </svg>
  );
}

function formatRank(rank: number | null | undefined) {
  if (typeof rank !== "number" || Number.isNaN(rank) || rank < 0) return "未披露";
  return rank.toLocaleString("zh-CN");
}

function formatScore(score: number | null | undefined) {
  if (typeof score !== "number" || Number.isNaN(score)) return "--";
  return score.toLocaleString("zh-CN");
}

function normalizeIgnoredKeys(items: Array<string | keyof StudentProfile> | undefined) {
  return normalizePriorityKeys(items);
}

function profileCompletion(
  profile: StudentProfile | undefined,
  ignoredFields: Array<string | keyof StudentProfile> = [],
) {
  const ignored = new Set(normalizeIgnoredKeys(ignoredFields));
  const effectiveFields = PROFILE_FIELDS.filter(({ key }) => !ignored.has(key));
  if (effectiveFields.length === 0) return 100;
  const filled = effectiveFields.filter(({ key }) => {
    const value = profile?.[key];
    return value !== undefined && value !== "" && (!Array.isArray(value) || value.length > 0);
  }).length;
  return Math.round((filled / effectiveFields.length) * 100);
}

function compactProfileValue(value: unknown) {
  if (Array.isArray(value)) return value.filter(Boolean).join("、");
  if (typeof value === "boolean") return value ? "可出省" : "不出省";
  if (typeof value === "number") return value.toLocaleString("zh-CN");
  if (typeof value === "string") return value.trim();
  return "";
}

function asArray<T>(value: T[] | undefined | null): T[] {
  return Array.isArray(value) ? value : [];
}

function profileLabelValue(profile: StudentProfile | undefined, key: keyof StudentProfile) {
  const labels: Record<keyof StudentProfile, string> = {
    province: "高考省份",
    year: "年份",
    subjectTrack: "科类",
    score: "分数",
    rank: "位次",
    targetCities: "目标城市",
    preferredMajors: "专业偏好",
    familyBudget: "预算",
    riskPreference: "风险偏好",
    acceptPrivate: "接受民办",
    acceptSinoForeign: "接受中外合作",
    budget: "预算",
    cityPreference: "意向城市",
    canLeaveProvince: "出省",
    graduatePlan: "读研",
    majorPreference: "偏好",
    avoidMajors: "避雷",
    familyType: "家庭",
    updatedAt: "更新",
  };
  const value = compactProfileValue(profile?.[key]);
  return value ? `${labels[key]}：${value}${key === "score" ? "分" : ""}` : "";
}

const PROFILE_FIELDS: Array<{
  key: keyof StudentProfile;
  label: string;
  question: string;
}> = [
  { key: "province", label: "高考省份", question: "我的高考省份是：" },
  { key: "subjectTrack", label: "科类", question: "我的科类/选科是：" },
  { key: "score", label: "分数", question: "我的高考分数是：" },
  { key: "rank", label: "位次", question: "我的全省位次是：" },
  { key: "budget", label: "预算", question: "我家里每年学费和生活费大概能接受：" },
  { key: "cityPreference", label: "意向城市", question: "我更想去的城市或区域是：" },
  { key: "canLeaveProvince", label: "出省", question: "我能否接受出省读大学：" },
  { key: "graduatePlan", label: "读研", question: "我本科后更倾向就业、考研还是保研：" },
  { key: "majorPreference", label: "专业偏好", question: "我感兴趣的专业方向是：" },
  { key: "avoidMajors", label: "避雷", question: "我明确不想碰的专业方向是：" },
];

function getMissingProfileFields(
  profile: StudentProfile | undefined,
  ignoredFields: Array<string | keyof StudentProfile> = [],
) {
  const ignored = new Set(normalizeIgnoredKeys(ignoredFields));
  return PROFILE_FIELDS.filter(({ key }) => {
    if (ignored.has(key)) return false;
    const value = profile?.[key];
    return value === undefined || value === "" || (Array.isArray(value) && value.length === 0);
  });
}

const FIELD_BY_LABEL = new Map<string, keyof StudentProfile>(
  PROFILE_FIELDS.flatMap((field) => [
    [field.label, field.key],
    [`${field.label}待补`, field.key],
  ]),
);

const SUGGESTION_TEMPLATE_BY_FIELD: Partial<Record<keyof StudentProfile, string[]>> = {
  province: ["我的高考省份是："],
  subjectTrack: ["我的科类/选科是："],
  score: ["我的高考分数是："],
  rank: ["我的位次是："],
  budget: ["家里每年预算大概是："],
  cityPreference: ["我想去的城市/地区是："],
  canLeaveProvince: ["可以接受出省", "不想出省"],
  graduatePlan: ["本科后倾向读研", "本科就业优先"],
  majorPreference: ["我偏好的专业方向是："],
  avoidMajors: ["我想避开的专业是："],
};

const FALLBACK_SUGGESTIONS = ["我想冲 211", "帮我做稳妥方案", "不想出省", "想读计算机", "需要保研机会"];

const FOLLOW_UP_OPTIONS_BY_FIELD: Partial<
  Record<keyof StudentProfile, Array<{ label: string; prompt: string }>>
> = {
  province: [
    { label: "我是天津考生", prompt: "我的高考省份是：天津" },
    { label: "我是海南考生", prompt: "我的高考省份是：海南" },
    { label: "我是河北考生", prompt: "我的高考省份是：河北" },
  ],
  subjectTrack: [
    { label: "物理类", prompt: "我的科类/选科是：物理类" },
    { label: "历史类", prompt: "我的科类/选科是：历史类" },
    { label: "综合改革", prompt: "我的科类/选科是：综合改革" },
  ],
  score: [
    { label: "补高考分数", prompt: "我的高考分数是：" },
    { label: "这是模拟分", prompt: "这是我的模拟/预估分：" },
  ],
  rank: [
    { label: "先用2025参考位次", prompt: "我暂时没有正式位次，请先用2025一分一段参考位次判断。" },
    { label: "稍后补正式位次", prompt: "我稍后再补正式位次，当前先不要把位次作为硬性条件。" },
  ],
  budget: [
    { label: "预算从严", prompt: "家里每年预算比较严格，优先公办和低学费。" },
    { label: "可接受中外合作", prompt: "家里可接受中外合作，但要看学费和就业回报。" },
    { label: "预算无上限", prompt: "预算暂时不是主要限制。" },
  ],
  cityPreference: [
    { label: "留本省", prompt: "我更想留在本省读大学。" },
    { label: "想去的城市/地区是：", prompt: "我想去的城市/地区是：" },
    { label: "地区不限", prompt: "城市和地区无所谓，哪里都可以。" },
  ],
  canLeaveProvince: [
    { label: "可以接受出省", prompt: "可以接受出省读大学。" },
    { label: "不想出省", prompt: "不想出省，优先省内。" },
    { label: "出省无所谓", prompt: "出省无所谓，哪里合适去哪里。" },
  ],
  graduatePlan: [
    { label: "本科就业优先", prompt: "本科后倾向直接就业。" },
    { label: "倾向读研/保研", prompt: "本科后倾向读研/保研。" },
    { label: "还没想好", prompt: "本科后就业还是读研还没想好，请先按稳妥路径建议。" },
  ],
  majorPreference: [
    { label: "计算机/软件", prompt: "我偏好的专业方向是：计算机、软件、人工智能。" },
    { label: "电子/电气", prompt: "我偏好的专业方向是：电子信息、电气、自动化。" },
    { label: "专业方向是：", prompt: "我偏好的专业方向是：" },
  ],
  avoidMajors: [
    { label: "不想学医学", prompt: "我想避开的专业是：医学。" },
    { label: "不想当老师", prompt: "我想避开的专业是：师范。" },
    { label: "避雷专业是：", prompt: "我想避开的专业是：" },
  ],
};

function getProfileValue(profile: StudentProfile, key: keyof StudentProfile, fallback = "待补") {
  const value = compactProfileValue(profile[key]);
  return value || fallback;
}

function buildStrategySummary(
  profile: StudentProfile,
  missingFields: Array<keyof StudentProfile>,
  ignoredFields: Array<keyof StudentProfile> = [],
) {
  const score = typeof profile.score === "number" ? profile.score : null;
  const hasRank = typeof profile.rank === "number" && profile.rank > 0;
  const risk = !hasRank || missingFields.includes("rank") ? "位次待补全" : "可进入精算";
  const intro = score
    ? `当前分数 ${score} 分具备较高院校匹配空间，`
    : "当前画像仍在收集中，";
  const blocker = missingFields.length
    ? `但缺少${missingFields.slice(0, 3).map((key) => PROFILE_FIELDS.find((field) => field.key === key)?.label ?? key).join("、")}等关键项，暂不能生成最终冲稳保方案。`
    : ignoredFields.length
    ? `已按你的选择忽略${ignoredFields.length}项待补信息，可以先基于已知画像生成初步意见。`
    : "关键画像已补齐，可以继续生成更精确的冲稳保方案。";
  const nextStep = missingFields.length
    ? "建议先补齐最前面的缺口，以获得更稳定的推荐结果。"
    : ignoredFields.length
    ? "后续如果补充城市、预算或专业偏好，我会再把方案精修。"
    : "下一步可以直接生成冲稳保方案或查看目标学校分数线。";

  return {
    risk,
    body: `${intro}${blocker}${nextStep}`,
  };
}

function buildReportMarkdown({
  profile,
  missingFields,
  summary,
}: {
  profile: StudentProfile;
  missingFields: Array<keyof StudentProfile>;
  summary: string;
}) {
  const profileRows = PROFILE_FIELDS.filter((field) => field.key !== "updatedAt")
    .map((field) => `- ${field.label}: ${getProfileValue(profile, field.key, "未填写")}`)
    .join("\n");

  return [
    "# 高考志愿填报 Agent 报告",
    "",
    `生成时间: ${new Date().toLocaleString("zh-CN")}`,
    "",
    "## 考生画像",
    profileRows,
    "",
    "## 待补信息",
    missingFields.length
      ? missingFields.map((key) => `- ${PROFILE_FIELDS.find((field) => field.key === key)?.label ?? key}`).join("\n")
      : "- 关键项已补齐",
    "",
    "## 当前策略摘要",
    summary,
    "",
    "## 对话图表",
    "- 录取趋势图表在聊天中按需生成，不固定写入主页报告。",
  ].join("\n");
}

const DEFAULT_COMPREHENSIVE_PROVINCES = new Set(["北京", "天津", "上海", "浙江", "山东", "海南"]);

function normalizeProvinceForProfile(province: string | undefined) {
  return normalizeProvinceForAgent(province);
}

function isDefaultComprehensiveProvince(province: string | undefined) {
  return DEFAULT_COMPREHENSIVE_PROVINCES.has(normalizeProvinceForProfile(province));
}

function withDerivedProfile(profile: StudentProfile | undefined): StudentProfile {
  return withDerivedStudentProfile(profile as AgentStudentProfile | undefined) as StudentProfile;
}

function mergeProfile(base: StudentProfile | undefined, patch: Partial<StudentProfile> | undefined) {
  return mergeStudentProfile(base as AgentStudentProfile | undefined, patch as Partial<AgentStudentProfile> | undefined) as StudentProfile;
}

function normalizePriorityKeys(items: Array<string | keyof StudentProfile> | undefined) {
  return uniqueTextItems(
    (items ?? [])
      .map((item) => String(item).trim())
      .map((item) => String(FIELD_BY_LABEL.get(item) ?? item)),
  ).filter((item): item is keyof StudentProfile =>
    PROFILE_FIELDS.some((field) => field.key === item),
  );
}

function prioritizeMissingFields(
  profile: StudentProfile | undefined,
  prompt = "",
  preferred: Array<string | keyof StudentProfile> = [],
  ignoredFields: Array<string | keyof StudentProfile> = [],
) {
  const text = prompt.replace(/\s+/g, "");
  const missingKeys = getMissingProfileFields(profile, ignoredFields).map((field) => field.key);
  const priority: Array<keyof StudentProfile> = [];
  const push = (key: keyof StudentProfile) => {
    if (missingKeys.includes(key) && !priority.includes(key)) priority.push(key);
  };

  normalizePriorityKeys(preferred).forEach(push);

  if (/能去|能上|报什么|怎么选|学校|大学|专业|志愿|冲稳保|方案|够不够/.test(text)) {
    push("rank");
    push("province");
    push("subjectTrack");
    push("score");
  }
  if (/普通家庭|家里普通|预算|中外|学费|生活费|钱/.test(text)) push("budget");
  if (/城市|地区|想去|留在|出省|新疆|南京|苏州|上海|北京|广州|深圳|杭州|成都|武汉|西安/.test(text)) {
    push("cityPreference");
    push("canLeaveProvince");
  }
  if (/读研|保研|就业|本科毕业|考研/.test(text)) push("graduatePlan");
  if (/专业|方向|计算机|电子|电气|医学|师范|法学|金融/.test(text)) push("majorPreference");

  missingKeys.forEach(push);
  return priority;
}

function buildKeyFacts(patch: Partial<StudentProfile>, prompt: string) {
  return buildProfileKeyFacts(patch as Partial<AgentStudentProfile>, prompt);
}

function compactSessionSummary(previousSummary: string, prompt: string, facts: string[]) {
  const updatingLabels = facts
    .map((fact) => fact.split("：")[0]?.trim())
    .filter(Boolean);
  const cleanedSummary = previousSummary
    .split("；")
    .map((item) => item.trim())
    .filter(
      (item) =>
        item &&
        !updatingLabels.some((label) => item.startsWith(`${label}：`)),
    )
    .join("；");
  const addition = facts.length ? facts.join("，") : prompt.replace(/\s+/g, " ").trim();
  const next = [cleanedSummary, addition].filter(Boolean).join("；");
  return next.length > 220 ? next.slice(next.length - 220) : next;
}

function buildSuggestions(
  profile: StudentProfile | undefined,
  missingPriority: Array<keyof StudentProfile>,
  lastAssistantText = "",
  ignoredFields: Array<string | keyof StudentProfile> = [],
) {
  const suggestions: string[] = [];
  const ignored = new Set(normalizeIgnoredKeys(ignoredFields));
  const pushMany = (items: string[] | undefined) => {
    items?.forEach((item) => {
      if (item && !suggestions.includes(item)) suggestions.push(item);
    });
  };

  missingPriority.forEach((key) => {
    if (!ignored.has(key)) pushMany(SUGGESTION_TEMPLATE_BY_FIELD[key]);
  });

  if (!ignored.has("rank") && /位次|排名|排位/.test(lastAssistantText)) pushMany(SUGGESTION_TEMPLATE_BY_FIELD.rank);
  if (!ignored.has("budget") && /预算|学费|生活费|中外合作|费用/.test(lastAssistantText)) pushMany(SUGGESTION_TEMPLATE_BY_FIELD.budget);
  if (!ignored.has("cityPreference") && /城市|地区|想去|哪里读|省份/.test(lastAssistantText)) pushMany(SUGGESTION_TEMPLATE_BY_FIELD.cityPreference);
  if (!ignored.has("canLeaveProvince") && /出省|外省|省内/.test(lastAssistantText)) pushMany(SUGGESTION_TEMPLATE_BY_FIELD.canLeaveProvince);
  if (!ignored.has("graduatePlan") && /读研|保研|就业/.test(lastAssistantText)) pushMany(SUGGESTION_TEMPLATE_BY_FIELD.graduatePlan);

  if (!ignored.has("rank") && !profile?.rank && profile?.score) suggestions.unshift("我的位次是：");
  return uniqueTextItems(suggestions).slice(0, 8);
}

function buildLocalTurnContext({
  prompt,
  profile,
  previousSummary,
  lastAssistantText,
}: {
  prompt: string;
  profile: StudentProfile;
  previousSummary: string;
  lastAssistantText: string;
}): TurnContext {
  const initialToolRoute = routeAgentTurn({
    userMessage: prompt,
    profile: profile as AgentStudentProfile,
  });
  const profilePatch = initialToolRoute.profilePatch as Partial<StudentProfile>;
  const rawMergedProfile = mergeProfile(profile, profilePatch);
  const mergedProfile = withDerivedProfile(rawMergedProfile);
  if (!mergedProfile.year && initialToolRoute.profileSnapshot.year) {
    mergedProfile.year = initialToolRoute.profileSnapshot.year;
  }
  const derivedSubjectTrack =
    !rawMergedProfile.subjectTrack && mergedProfile.subjectTrack ? mergedProfile.subjectTrack : undefined;
  const enrichedProfilePatch = derivedSubjectTrack
    ? mergeProfile(profilePatch as StudentProfile, { subjectTrack: derivedSubjectTrack })
    : profilePatch;
  const missingPriority = prioritizeMissingFields(mergedProfile, prompt);
  const keyFacts = buildKeyFacts(enrichedProfilePatch, prompt);
  const sessionSummary = compactSessionSummary(previousSummary, prompt, keyFacts);
  const suggestions = buildSuggestions(mergedProfile, missingPriority, lastAssistantText);
  const toolRoute: RouterDecision = {
    ...initialToolRoute,
    profilePatch: enrichedProfilePatch as Partial<AgentStudentProfile>,
    profileSnapshot: mergedProfile as AgentStudentProfile,
  };

  return {
    rawPrompt: prompt,
    keyFacts,
    profilePatch: enrichedProfilePatch,
    profileAfterTurn: mergedProfile,
    toolRoute,
    missingPriority,
    sessionSummary,
    suggestions,
    ambiguityWarnings: [],
    updatedAt: new Date().toISOString(),
  };
}

function shouldUseRemotePreprocess(prompt: string) {
  const compact = prompt.replace(/\s+/g, "");
  const provinceHits = PROVINCE_CANDIDATES.filter((item) => compact.includes(item)).length;
  return (
    compact.length > 42 ||
    provinceHits > 1 ||
    /对比|比较|纠结|同时|但是|如果|普通家庭|城市|地区|预算|读研|就业|能去什么学校/.test(compact)
  );
}

function readLastAssistantText() {
  if (typeof document === "undefined") return "";
  const messages = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="copilot-assistant-message"]'));
  return messages.at(-1)?.innerText.trim() ?? "";
}

async function requestRemotePreprocess({
  threadId,
  rawPrompt,
  profile,
  previousSummary,
  lastAssistantText,
}: {
  threadId: string;
  rawPrompt: string;
  profile: StudentProfile;
  previousSummary: string;
  lastAssistantText: string;
}) {
  const response = await fetch("/api/gaokao/preprocess", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      threadId,
      rawPrompt,
      profile,
      previousSummary,
      lastAssistantText,
    }),
  });

  if (!response.ok) throw new Error(`preprocess failed: ${response.status}`);
  return (await response.json()) as PreprocessResponse;
}

function normalizeRankHydrationSubject(profile: StudentProfile) {
  const subjectTrack = profile.subjectTrack?.trim();
  if (subjectTrack) return subjectTrack;
  return isDefaultComprehensiveProvince(profile.province) ? "综合改革" : "";
}

function canAutoHydrateRank(profile: StudentProfile) {
  const hasRank = typeof profile.rank === "number" && Number.isFinite(profile.rank) && profile.rank > 0;
  const hasScore = typeof profile.score === "number" && Number.isFinite(profile.score);
  return Boolean(!hasRank && hasScore && profile.province && normalizeRankHydrationSubject(profile));
}

async function requestRankHydration(profile: StudentProfile) {
  if (!canAutoHydrateRank(profile)) return null;
  const response = await fetch("/api/gaokao/rank", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      province: profile.province,
      year: profile.year ?? DEFAULT_RANK_REFERENCE_YEAR,
      subjectTrack: normalizeRankHydrationSubject(profile),
      score: profile.score,
    }),
  });
  if (!response.ok) return null;
  const result = (await response.json()) as RankHydrationResponse;
  return result.status === "ok" ? result : null;
}

function mergeRankHydrationIntoTurnContext(
  turnContext: TurnContext,
  rankResult: Extract<RankHydrationResponse, { status: "ok" }>,
  lastAssistantText: string,
) {
  const rankPatch: Partial<StudentProfile> = {
    rank: rankResult.rank,
    year: rankResult.year ?? turnContext.profileAfterTurn.year ?? DEFAULT_RANK_REFERENCE_YEAR,
    subjectTrack: turnContext.profileAfterTurn.subjectTrack || rankResult.subjectTrack,
    updatedAt: new Date().toISOString(),
  };
  const profilePatch = mergeProfile(turnContext.profilePatch as StudentProfile, rankPatch);
  const profileAfterTurn = mergeProfile(turnContext.profileAfterTurn, rankPatch);
  const rankFacts = buildKeyFacts(rankPatch, turnContext.rawPrompt);
  const missingPriority = prioritizeMissingFields(
    profileAfterTurn,
    turnContext.rawPrompt,
    turnContext.missingPriority.filter((key) => key !== "rank"),
  );
  const suggestions = buildSuggestions(profileAfterTurn, missingPriority, lastAssistantText);
  const toolRoute = routeAgentTurn({
    userMessage: turnContext.rawPrompt,
    profile: profileAfterTurn as AgentStudentProfile,
  });
  const warnings =
    rankResult.matchedScore !== profileAfterTurn.score
      ? [`一分一段未精确命中 ${profileAfterTurn.score} 分，已按不高于该分数的 ${rankResult.matchedScore} 分匹配。`]
      : [];

  return {
    ...turnContext,
    keyFacts: uniqueTextItems([...turnContext.keyFacts, ...rankFacts]),
    profilePatch,
    profileAfterTurn,
    toolRoute,
    missingPriority,
    sessionSummary: compactSessionSummary(turnContext.sessionSummary, "", rankFacts),
    suggestions,
    ambiguityWarnings: uniqueTextItems([...turnContext.ambiguityWarnings, ...warnings]),
    updatedAt: new Date().toISOString(),
  };
}

function mergeRemoteTurnContext(
  localTurn: TurnContext,
  remote: PreprocessResponse,
  baseProfile: StudentProfile,
): TurnContext {
  const remotePatch = remote.profilePatch && typeof remote.profilePatch === "object" ? remote.profilePatch : {};
  const profilePatch = mergeProfile(localTurn.profilePatch as StudentProfile, remotePatch);
  const rawMergedProfile = mergeProfile(baseProfile, profilePatch);
  const mergedProfile = withDerivedProfile(rawMergedProfile);
  const remoteToolRouteSeed = routeAgentTurn({
    userMessage: localTurn.rawPrompt,
    profile: mergedProfile as AgentStudentProfile,
  });
  if (!mergedProfile.year && remoteToolRouteSeed.profileSnapshot.year) {
    mergedProfile.year = remoteToolRouteSeed.profileSnapshot.year;
  }
  const derivedSubjectTrack =
    !rawMergedProfile.subjectTrack && mergedProfile.subjectTrack ? mergedProfile.subjectTrack : undefined;
  const enrichedProfilePatch = derivedSubjectTrack
    ? mergeProfile(profilePatch as StudentProfile, { subjectTrack: derivedSubjectTrack })
    : profilePatch;
  const missingPriority = prioritizeMissingFields(
    mergedProfile,
    localTurn.rawPrompt,
    remote.missingPriority,
  );
  const suggestions = uniqueTextItems([...(remote.suggestions ?? []), ...localTurn.suggestions]).slice(0, 8);
  const toolRoute = routeAgentTurn({
    userMessage: localTurn.rawPrompt,
    profile: mergedProfile as AgentStudentProfile,
  });

  return {
    ...localTurn,
    keyFacts: uniqueTextItems([...(remote.keyFacts ?? []), ...localTurn.keyFacts]),
    profilePatch: enrichedProfilePatch,
    profileAfterTurn: mergedProfile,
    toolRoute,
    missingPriority,
    sessionSummary: remote.sessionSummary?.trim() || localTurn.sessionSummary,
    suggestions: suggestions.length ? suggestions : localTurn.suggestions,
    ambiguityWarnings: uniqueTextItems([
      ...(remote.ambiguityWarnings ?? []),
      ...localTurn.ambiguityWarnings,
    ]),
    updatedAt: new Date().toISOString(),
  };
}

const PROVINCE_CANDIDATES = [
  "北京",
  "天津",
  "上海",
  "重庆",
  "河北",
  "山西",
  "辽宁",
  "吉林",
  "黑龙江",
  "江苏",
  "浙江",
  "安徽",
  "福建",
  "江西",
  "山东",
  "河南",
  "湖北",
  "湖南",
  "广东",
  "海南",
  "四川",
  "贵州",
  "云南",
  "陕西",
  "甘肃",
  "青海",
  "内蒙古",
  "广西",
  "西藏",
  "宁夏",
  "新疆",
];

function uniqueTextItems(items: string[]) {
  return Array.from(new Set(items.map((item) => item.trim()).filter(Boolean))).slice(0, 6);
}

function hasDestinationContext(text: string, candidate: string) {
  const index = text.indexOf(candidate);
  if (index < 0) return false;
  const before = text.slice(Math.max(0, index - 8), index);
  const after = text.slice(index + candidate.length, index + candidate.length + 10);
  return (
    /(想去|要去|想在|希望去|希望在|考虑去|接受去|能去|去|留在|目标|偏好|想去的城市(?:是|为)?|目标城市(?:是|为)?|目标地区(?:是|为)?|城市偏好(?:是|为)?|地区偏好(?:是|为)?|城市(?:是|为)?|地区(?:是|为)?)$/.test(before) ||
    /^(读|读书|上大学|大学|发展|就业|读研|生活)/.test(after)
  );
}

function hasExamProvinceContext(text: string, candidate: string) {
  const index = text.indexOf(candidate);
  if (index < 0 || hasDestinationContext(text, candidate)) return false;
  const before = text.slice(Math.max(0, index - 10), index);
  const after = text.slice(index + candidate.length, index + candidate.length + 12);
  return (
    /(高考省份(?:是|为)?|考试省份(?:是|为)?|生源地(?:是|为)?|考籍(?:是|为)?|学籍(?:是|为)?|户籍(?:是|为)?|我在|我是|来自|本省|省份(?:是|为)?|高考在|在)$/.test(before) ||
    /^(考生|高考|物理|历史|理科|文科|选科|综合|位次|排名|分|全省)/.test(after)
  );
}

function extractProfileFromPrompt(prompt: string): Partial<StudentProfile> {
  return extractStudentProfilePatch(prompt) as Partial<StudentProfile>;
}

function isOfficialAdmissionSource(source: {
  url?: string;
  kind?: string;
  publisher?: string;
  title?: string;
}) {
  const sourceText = `${source.kind ?? ""} ${source.publisher ?? ""} ${source.title ?? ""}`;
  if (/official|考试院|招生办公室|招生网|教育考试院/.test(sourceText)) return true;

  try {
    const hostname = new URL(source.url ?? "").hostname.toLowerCase();
    return (
      hostname.endsWith(".edu.cn") ||
      hostname.endsWith(".gov.cn") ||
      hostname === "jseea.cn" ||
      hostname.endsWith(".jseea.cn") ||
      hostname === "chsi.com.cn" ||
      hostname.endsWith(".chsi.com.cn")
    );
  } catch {
    return false;
  }
}

function normalizeChartPoints(args: ScoreLineTrendChartArgs) {
  if (Array.isArray(args.points) && args.points.length > 0) {
    return args.points
      .filter((point) => typeof point.year === "number" && typeof point.score === "number")
      .map((point) => ({
        year: point.year,
        score: point.score,
        rank: point.rank ?? -1,
        groupName: point.groupName || "最低门槛",
        majorName: point.majorName || "",
        sourceId: point.sourceId || "",
      }));
  }

  if (Array.isArray(args.years) && Array.isArray(args.scores)) {
    return args.years
      .map((year, index) => ({
        year,
        score: args.scores?.[index],
        rank: args.ranks?.[index] ?? -1,
        groupName: "最低门槛",
        majorName: "",
        sourceId: "",
      }))
      .filter((point): point is z.infer<typeof scoreLinePointSchema> => {
        return typeof point.year === "number" && typeof point.score === "number";
      });
  }

  return [];
}

function ScoreLineTrendChart(args: ScoreLineTrendChartArgs) {
  const points = normalizeChartPoints(args);
  const mode = args.mode ?? (points.length > 1 ? "overallTrend" : "groupComparison");
  const schoolName = args.schoolName || "院校";
  const province = args.province || "省份";
  const subjectTrack = args.subjectTrack || "科类";
  const sources = Array.isArray(args.sources) ? args.sources : [];
  const warnings = Array.isArray(args.warnings) ? args.warnings : [];
  const isDemoSource = sources.some((source) => source.kind === "demo" || source.id === "demo");
  const hasOfficialSource = sources.some(isOfficialAdmissionSource);
  const inferredScope = args.dataScope ?? (hasOfficialSource ? "mixed" : "thirdPartyAggregate");
  const scopeLabel =
    inferredScope === "examAuthorityGroupLine"
      ? "考试院投档线"
      : inferredScope === "schoolMajorScore"
        ? "学校专业分"
        : inferredScope === "thirdPartyAggregate"
          ? "第三方聚合"
          : "混合口径";
  const sourceLabel = hasOfficialSource ? scopeLabel : "辅助参考";

  const width = 360;
  const trendHeight = 210;
  const visibleBars = [...points].sort((a, b) => b.score - a.score).slice(0, 14);
  const barHeight = Math.max(230, Math.min(470, visibleBars.length * 30 + 76));
  const height = mode === "groupComparison" ? barHeight : trendHeight;
  const padding =
    mode === "groupComparison"
      ? { top: 24, right: 48, bottom: 42, left: 126 }
      : { top: 30, right: 24, bottom: 44, left: 42 };
  const scoreValues = points.map((point) => point.score);
  const minScore = scoreValues.length ? Math.min(...scoreValues) : 0;
  const maxScore = scoreValues.length ? Math.max(...scoreValues) : 0;
  const scoreRange = Math.max(maxScore - minScore, 1);
  const latestPoint = points.at(-1);
  const previousPoint = points.at(-2);
  const delta = latestPoint && previousPoint ? latestPoint.score - previousPoint.score : null;

  // 按年份升序排列，确保横坐标从左到右是时间递增
  const sortedPoints = [...points].sort((a, b) => a.year - b.year);
  
  const trendPoints = sortedPoints.map((point, index) => {
    const plotWidth = width - padding.left - padding.right;
    const plotHeight = trendHeight - padding.top - padding.bottom;
    const x =
      padding.left +
      (sortedPoints.length === 1 ? plotWidth / 2 : (index / (sortedPoints.length - 1)) * plotWidth);
    const y = padding.top + ((maxScore - point.score) / scoreRange) * plotHeight;
    return { ...point, x, y };
  });

  const linePath = trendPoints
    .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`)
    .join(" ");
  const analysisText =
    args.analysisSummary ||
    `${schoolName} 的分数线已经进入可视化分析，建议结合位次、专业组和选科要求继续判断。`;
  const analysisLines = analysisText
    .replace(/([。；;])\s*/g, "$1\n")
    .replace(/，\s*(但|不过|建议|如果|你的|正式填报)/g, "，\n$1")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 5);

  return (
    <div className="gaokao-score-chart my-3 w-full max-w-full overflow-hidden rounded-[20px] border border-blue-100 bg-white text-slate-950 shadow-[0_18px_45px_rgba(15,23,42,0.08)]">
      <div className="px-4 pb-2 pt-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="break-words text-[18px] font-black leading-7">
              {schoolName}{mode === "groupComparison" ? "分数对比" : "录取趋势分析"}
            </h3>
            <p className="mt-0.5 text-xs font-medium text-slate-500">
              {province} · {subjectTrack} · {points[0]?.year ?? "近年"}-{points.at(-1)?.year ?? "趋势"}
            </p>
          </div>
          <span className="shrink-0 rounded-xl border border-blue-100 bg-blue-50 px-2.5 py-1 text-xs font-semibold text-blue-700">
            {sourceLabel}
          </span>
        </div>
      </div>

      <div className="px-4 pb-4 pt-2">
        {!hasOfficialSource && !isDemoSource ? (
          <div className="mb-3 rounded-xl border border-amber-100 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">
            非官方来源会有口径差异，正式填报前请以省考试院和院校招生网核验。
          </div>
        ) : null}

        {inferredScope === "mixed" && !isDemoSource ? (
          <div className="mb-3 rounded-xl border border-amber-100 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">
            当前为混合口径，可能包含投档线、专业分或聚合数据，不建议直接横向硬比。
          </div>
        ) : null}

        {points.length > 0 ? (
          <div className="mb-4 grid grid-cols-3 gap-2">
            <div className="rounded-xl bg-blue-50 px-2 py-3 text-center">
              <p className="text-lg font-black text-blue-700">
                {minScore} - {maxScore}
              </p>
              <p className="mt-0.5 text-[11px] text-slate-500">近年分数区间</p>
            </div>
            <div className="rounded-xl bg-orange-50 px-2 py-3 text-center">
              <p className="text-lg font-black text-orange-600">
                {delta === null ? "--" : `${delta >= 0 ? "+" : ""}${delta}`}
                <span className="text-xs"> 分</span>
              </p>
              <p className="mt-0.5 text-[11px] text-slate-500">最近年度变化</p>
            </div>
            <div className="rounded-xl bg-red-50 px-2 py-3 text-center">
              <p className="text-lg font-black text-red-600">
                {delta !== null && delta >= 35 ? "中高" : delta !== null && delta >= 15 ? "中" : "可控"}
              </p>
              <p className="mt-0.5 text-[11px] text-slate-500">风险等级</p>
            </div>
          </div>
        ) : null}

        {points.length > 0 ? (
          <svg
            className="block h-auto w-full"
            viewBox={`0 0 ${width} ${height}`}
            role="img"
            aria-label={`${schoolName}${province}${subjectTrack}分数线图表`}
          >
            {mode === "groupComparison" ? (
              <>
                {visibleBars.map((point, index) => {
                  const barTop = padding.top + index * 30;
                  const plotWidth = width - padding.left - padding.right;
                  const scoreRatio =
                    maxScore === minScore ? 1 : (point.score - minScore) / scoreRange;
                  const barWidth = Math.max(
                    22,
                    18 + scoreRatio * (plotWidth - 18),
                  );
                  const label = point.groupName.replace(/\s+/g, "").slice(0, 13);
                  return (
                    <g key={`${point.year}-${point.groupName}-${point.score}`}>
                      <title>{point.groupName}</title>
                      <text x="4" y={barTop + 14} className="fill-zinc-500 text-[9px]">
                        {label}
                      </text>
                      <rect
                        x={padding.left}
                        y={barTop}
                        width={barWidth}
                        height="18"
                        rx="9"
                        fill={index === 0 ? "#2563eb" : "#60a5fa"}
                        opacity={index === 0 ? 0.95 : 0.78}
                      />
                      <text
                        x={Math.min(width - 30, padding.left + barWidth + 6)}
                        y={barTop + 13}
                        className="fill-slate-900 text-[10px] font-semibold"
                      >
                        {point.score}
                      </text>
                    </g>
                  );
                })}
                <text x="4" y={height - 12} className="fill-zinc-500 text-[10px]">
                  按专业组最低分展示，最多显示 14 组
                </text>
              </>
            ) : (
              <>
                {[0, 0.5, 1].map((ratio) => {
                  const y = padding.top + ratio * (trendHeight - padding.top - padding.bottom);
                  return (
                    <line
                      key={ratio}
                      x1={padding.left}
                      y1={y}
                      x2={width - padding.right}
                      y2={y}
                      stroke="#e2e8f0"
                      strokeDasharray={ratio === 1 ? undefined : "4 5"}
                    />
                  );
                })}
                <line
                  x1={padding.left}
                  y1={padding.top}
                  x2={padding.left}
                  y2={trendHeight - padding.bottom}
                  stroke="#cbd5e1"
                />
                <line
                  x1={padding.left}
                  y1={trendHeight - padding.bottom}
                  x2={width - padding.right}
                  y2={trendHeight - padding.bottom}
                  stroke="#cbd5e1"
                />
                <text x="4" y={padding.top + 4} className="fill-slate-500 text-[10px]">
                  {maxScore}
                </text>
                <text x="4" y={trendHeight - padding.bottom} className="fill-slate-500 text-[10px]">
                  {minScore}
                </text>
                <path d={linePath} fill="none" stroke="#2563eb" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                {trendPoints.map((point) => (
                  <g key={`${point.year}-${point.groupName}-${point.score}`}>
                    <circle cx={point.x} cy={point.y} r="6" fill="#bfdbfe" />
                    <circle cx={point.x} cy={point.y} r="3.8" fill="#2563eb" />
                    <text
                      x={point.x}
                      y={Math.max(12, point.y - 9)}
                      textAnchor="middle"
                      className={point === latestPoint ? "fill-red-600 text-[10px] font-bold" : "fill-slate-700 text-[10px] font-semibold"}
                    >
                      {point.score}
                    </text>
                    <text
                      x={point.x}
                      y={trendHeight - 12}
                      textAnchor="middle"
                      className="fill-slate-500 text-[10px]"
                    >
                      {point.year}
                    </text>
                  </g>
                ))}
              </>
            )}
          </svg>
        ) : (
          <div className="rounded-xl border border-dashed border-blue-200 bg-blue-50/60 p-3 text-sm leading-6 text-slate-600">
            暂无可绘制的分数线数据。需要至少查到年份、分数和来源；第三方数据会被明确标注，不能用猜测数据画图。
          </div>
        )}

        <div className="mt-4 rounded-2xl border border-blue-100 bg-blue-50/80 px-4 py-3">
          <div className="flex items-start gap-3">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-600 text-white">
              <CpuChipIcon className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-black text-blue-950">趋势解读</p>
              <div className="mt-1 space-y-1.5 text-sm leading-6 text-slate-700">
                {analysisLines.map((line, index) => (
                  <p key={`${line}-${index}`} className="break-words">
                    {line}
                  </p>
                ))}
              </div>
            </div>
          </div>
        </div>

        {warnings.length > 0 ? (
          <div className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">
            {warnings.slice(0, 2).map((warning) => (
              <p key={warning}>{warning}</p>
            ))}
          </div>
        ) : null}

        {sources.length > 0 ? (
          <div className="mt-3 border-t border-blue-50 pt-2">
            <p className="text-xs font-semibold text-slate-500">来源</p>
            <div className="mt-1 grid gap-1">
              {sources.slice(0, 4).map((source, index) =>
                source.url?.trim() ? (
                  <a
                    key={`${source.title}-${index}`}
                    href={source.url}
                    target="_blank"
                    rel="noreferrer"
                    className="break-words text-xs text-blue-700 underline underline-offset-2"
                  >
                    {source.title}
                  </a>
                ) : (
                  <span
                    key={`${source.title}-${index}`}
                    className="break-words text-xs text-slate-600"
                  >
                    {source.title}
                  </span>
                ),
              )}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ProfilePill({
  children,
  muted = false,
  highlight = false,
  onClick,
}: {
  children: ReactNode;
  muted?: boolean;
  highlight?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`shrink-0 rounded-md border px-2 py-1 text-[11px] leading-4 ${
        highlight
          ? "border-red-300 bg-red-50 font-semibold text-red-800 shadow-sm"
          : muted
          ? "border-dashed border-zinc-300 bg-zinc-50 text-zinc-500"
          : "border-zinc-200 bg-white text-zinc-800"
      }`}
    >
      {children}
    </button>
  );
}

function StudentProfileSummary({ profile, missingFields = [], nextQuestions = [] }: StudentProfileSummaryArgs) {
  const safeProfile = withDerivedProfile(profile);
  const knownItems = PROFILE_FIELDS.map(({ key }) => profileLabelValue(safeProfile, key)).filter(Boolean);
  const actualMissingLabels = new Set(getMissingProfileFields(safeProfile).map((field) => field.label));
  const missing = missingFields.length
    ? missingFields.filter((field) => actualMissingLabels.has(field))
    : getMissingProfileFields(safeProfile).slice(0, 4).map((field) => field.label);

  return (
    <div className="my-3 w-full rounded-lg border border-zinc-200 bg-white p-3 text-zinc-950 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-xs font-semibold text-red-700">当前画像</p>
          <h3 className="mt-1 text-base font-semibold">填报判断依据</h3>
        </div>
        <span className="rounded border border-zinc-200 px-2 py-1 text-xs text-zinc-500">
          本地会话
        </span>
      </div>
      <div className="mt-3 grid gap-2">
        <div className="min-w-0 rounded-md border border-zinc-200 bg-zinc-50 px-2 py-2">
          <p className="mb-2 text-[11px] font-semibold text-zinc-500">当前画像</p>
          <div className="flex min-w-0 gap-1.5 overflow-x-auto pb-1">
            {knownItems.length ? (
              knownItems.map((item) => <ProfilePill key={item}>{item}</ProfilePill>)
            ) : (
              <span className="text-xs leading-5 text-zinc-500">还没收集到足够画像。</span>
            )}
          </div>
        </div>
        <div className="min-w-0 rounded-md border border-dashed border-zinc-300 bg-white px-2 py-2">
          <p className="mb-2 text-[11px] font-semibold text-zinc-500">待补画像</p>
          <div className="flex min-w-0 gap-1.5 overflow-x-auto pb-1">
            {missing.length ? (
              missing.map((item, index) => (
                <ProfilePill key={`missing-${item}`} muted highlight={index === 0}>
                  {item}待补
                </ProfilePill>
              ))
            ) : (
              <span className="text-xs leading-5 text-zinc-500">关键项已补齐</span>
            )}
          </div>
        </div>
      </div>
      {nextQuestions.length > 0 ? (
        <div className="mt-3 rounded-md bg-zinc-50 px-3 py-2 text-xs leading-5 text-zinc-700">
          {nextQuestions.slice(0, 3).map((question) => (
            <p key={question}>{question}</p>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function FollowUpQuestionOptions({
  questions = [],
  onSelect,
  onDeselect,
}: FollowUpQuestionOptionsArgs & {
  onSelect: (prompt: string) => void;
  onDeselect: (prompt: string) => void;
}) {
  const markerRef = useRef<HTMLSpanElement | null>(null);
  const instanceIdRef = useRef(`followup-${Math.random().toString(36).slice(2)}`);

  useEffect(() => {
    const marker = markerRef.current;
    if (!marker) return;
    const visibleQuestions = dedupeFollowUpQuestions(questions).slice(0, 5);
    if (!visibleQuestions.length) return;

    const assistantMessages = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="copilot-assistant-message"], .copilotKitAssistantMessage'),
    );
    const parent =
      marker.closest<HTMLElement>('[data-testid="copilot-assistant-message"], .copilotKitAssistantMessage') ??
      assistantMessages.at(-1) ??
      marker.parentElement;
    if (!parent) return;
    assistantMessages.slice(0, -1).forEach((message) => {
      message.querySelectorAll(".gaokao-inline-followup-options").forEach((node) => node.remove());
    });

    parent.querySelectorAll(`[data-followup-instance="${instanceIdRef.current}"]`).forEach((node) => node.remove());

    const container = document.createElement("div");
    container.className = "gaokao-followup-options my-3 grid gap-3";
    container.dataset.followupInstance = instanceIdRef.current;

    visibleQuestions.forEach((question, index) => {
      const group = document.createElement("div");
      group.className = "rounded-2xl border border-blue-100 bg-white px-3 py-3 shadow-sm";

      const label = document.createElement("p");
      label.className = "text-sm font-black leading-6 text-slate-900";
      label.textContent = question.question;
      group.append(label);

      const row = document.createElement("div");
      row.className = "mt-2 flex gap-2 overflow-x-auto pb-1";

      question.options.slice(0, 6).forEach((option) => {
        const normalizedOption = normalizeFollowUpOption(option);
        if (!normalizedOption) return;
        const { label: optionLabel, prompt } = normalizedOption;
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = optionLabel;
        applyFollowUpButtonState(button, composerDraftIncludesPrompt(prompt));
        button.addEventListener("click", () => {
          const selected = button.dataset.selected === "true";
          if (selected) {
            applyFollowUpButtonState(button, false);
            onDeselect(prompt);
            return;
          }
          applyFollowUpButtonState(button, true);
          onSelect(prompt);
        });
        row.append(button);
      });

      group.dataset.followupField = String(normalizeFollowUpField(question.field, question.question));
      group.dataset.followupOrder = String(index);
      group.append(row);
      container.append(group);
    });

    parent.append(container);
    return undefined;
  }, [onDeselect, onSelect, questions]);

  return <span ref={markerRef} className="gaokao-followup-options-marker hidden" />;
}

function VolunteerPlanCards({ profile, tiers, warnings = [], sources = [] }: VolunteerPlanCardsArgs) {
  const safeTiers = asArray(tiers).map((tier) => ({
    ...tier,
    items: asArray(tier?.items),
  }));
  const safeWarnings = asArray(warnings);
  const safeSources = asArray(sources);
  const tierTone: Record<string, string> = {
    冲: "border-red-200 bg-red-50 text-red-800",
    稳: "border-zinc-300 bg-white text-zinc-900",
    保: "border-emerald-200 bg-emerald-50 text-emerald-800",
  };

  return (
    <div className="my-3 w-full rounded-lg border border-zinc-200 bg-white p-3 text-zinc-950 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold text-red-700">冲稳保方案</p>
          <h3 className="mt-1 text-base font-semibold">按风险分层看，不按感觉报</h3>
        </div>
        {profile?.score ? (
          <span className="rounded border border-zinc-200 px-2 py-1 text-xs text-zinc-600">
            {profile.score}分
          </span>
        ) : null}
      </div>

      <div className="mt-3 grid gap-3">
        {safeTiers.length ? (
          safeTiers.map((tier) => (
          <section key={tier.tier} className="rounded-md border border-zinc-200">
            <div className={`border-b px-3 py-2 text-sm font-semibold ${tierTone[tier.tier] ?? tierTone["稳"]}`}>
              {tier.tier} · {tier.items.length} 个方向
            </div>
            <div className="grid gap-2 p-2">
              {tier.items.map((item) => (
                <article
                  key={`${tier.tier}-${item.schoolName}-${item.majorDirection}`}
                  className="rounded-md bg-zinc-50 px-3 py-2"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                        <h4 className="break-words text-sm font-semibold">{item.schoolName}</h4>
                        {item.schoolName ? (
                          <button
                            type="button"
                            onClick={() => submitSchoolTrendPrompt(item.schoolName, profile)}
                            className="gaokao-school-score-button shrink-0 rounded-full border border-blue-100 bg-blue-50 px-2 py-0.5 text-[11px] font-black text-blue-700"
                          >
                            查看分数线
                          </button>
                        ) : null}
                      </div>
                      <p className="mt-1 break-words text-xs leading-5 text-zinc-600">
                        {item.groupName || "专业组待核验"} · {item.majorDirection}
                      </p>
                    </div>
                    <span className="shrink-0 rounded border border-zinc-200 bg-white px-2 py-0.5 text-xs text-zinc-700">
                      {item.riskLevel}
                    </span>
                  </div>
                  <p className="mt-2 text-xs leading-5 text-zinc-700">{item.reason}</p>
                  <p className="mt-1 text-xs leading-5 text-zinc-500">{item.evidence}</p>
                </article>
              ))}
            </div>
          </section>
          ))
        ) : (
          <p className="rounded-md bg-zinc-50 px-3 py-2 text-xs leading-5 text-zinc-600">
            方案数据不足，请先补充分数、位次、科类和城市/预算偏好。
          </p>
        )}
      </div>

      {safeWarnings.length > 0 ? (
        <div className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">
          {safeWarnings.slice(0, 2).map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
        </div>
      ) : null}

      {safeSources.length > 0 ? <SourceList sources={safeSources} /> : null}
    </div>
  );
}

function AdmissionRiskCards({
  targetUserType = "普通家庭考生",
  avoid = [],
  cautious = [],
  suitable = [],
  summary,
}: AdmissionRiskCardsArgs) {
  const groups = [
    { title: "不建议碰", items: asArray(avoid), tone: "border-red-200 bg-red-50 text-red-800" },
    { title: "谨慎选择", items: asArray(cautious), tone: "border-amber-200 bg-amber-50 text-amber-900" },
    { title: "可考虑", items: asArray(suitable), tone: "border-emerald-200 bg-emerald-50 text-emerald-800" },
  ];

  return (
    <div className="my-3 rounded-lg border border-zinc-200 bg-white p-3 text-zinc-950 shadow-sm">
      <p className="text-xs font-semibold text-red-700">专业风险</p>
      <h3 className="mt-1 text-base font-semibold">{targetUserType}优先看确定性</h3>
      {summary ? <p className="mt-2 text-sm leading-6 text-zinc-700">{summary}</p> : null}
      <div className="mt-3 grid gap-2">
        {groups.map((group) => (
          <section key={group.title} className="rounded-md border border-zinc-200">
            <div className={`border-b px-3 py-2 text-sm font-semibold ${group.tone}`}>{group.title}</div>
            <div className="grid gap-2 p-2">
              {group.items.length ? (
                group.items.map((item) => (
                  <div key={`${group.title}-${item.title}`} className="rounded-md bg-zinc-50 px-3 py-2">
                    <p className="text-sm font-semibold">{item.title}</p>
                    <p className="mt-1 text-xs leading-5 text-zinc-600">{item.reason}</p>
                  </div>
                ))
              ) : (
                <p className="px-1 py-1 text-xs text-zinc-500">暂无明确项。</p>
              )}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

function SchoolComparisonCard({ schools, sources = [], warnings = [] }: SchoolComparisonCardArgs) {
  const safeSchools = asArray(schools);
  const safeSources = asArray(sources);
  const safeWarnings = asArray(warnings);

  return (
    <div className="my-3 rounded-lg border border-zinc-200 bg-white p-3 text-zinc-950 shadow-sm">
      <p className="text-xs font-semibold text-red-700">院校对比</p>
      <h3 className="mt-1 text-base font-semibold">按普通学生路径比较</h3>
      <div className="mt-3 grid gap-3">
        {safeSchools.length ? (
          safeSchools.map((school) => (
          <article key={school.schoolName} className="rounded-md border border-zinc-200 bg-zinc-50 p-3">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <h4 className="text-sm font-semibold">{school.schoolName}</h4>
                  {school.schoolName ? (
                    <button
                      type="button"
                      onClick={() => submitSchoolTrendPrompt(school.schoolName)}
                      className="gaokao-school-score-button shrink-0 rounded-full border border-blue-100 bg-blue-50 px-2 py-0.5 text-[11px] font-black text-blue-700"
                    >
                      查看分数线
                    </button>
                  ) : null}
                </div>
              </div>
              <span className="shrink-0 rounded border border-zinc-200 bg-white px-2 py-0.5 text-xs text-zinc-700">
                {school.scoreRisk}
              </span>
            </div>
            <div className="mt-2 grid gap-1 text-xs leading-5 text-zinc-700">
              <p>城市：{school.cityValue || "待补充"}</p>
              <p>专业：{school.majorFit || "待补充"}</p>
              <p>就业：{school.employmentView || "待补充"}</p>
              <p>家庭适配：{school.familyFit || "待补充"}</p>
            </div>
            <p className="mt-2 rounded-md bg-white px-2 py-1.5 text-xs font-medium leading-5 text-zinc-900">
              {school.verdict}
            </p>
          </article>
          ))
        ) : (
          <p className="rounded-md bg-zinc-50 px-3 py-2 text-xs leading-5 text-zinc-600">
            对比数据不足，请至少给出 2 所学校和你的高考省份、科类、位次。
          </p>
        )}
      </div>
      {safeWarnings.length > 0 ? (
        <div className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">
          {safeWarnings.slice(0, 2).map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
        </div>
      ) : null}
      {safeSources.length > 0 ? <SourceList sources={safeSources} /> : null}
    </div>
  );
}

// 通用对比卡片组件（用于非院校对比场景，如专业、城市、职业路径等）
function GenericComparisonCard({
  title,
  items,
  summary,
  sources = [],
  warnings = [],
}: {
  title: string;
  items: Array<{
    name: string;           // 对比项名称，如"计算机科学与技术"
    icon?: string;          // 图标（可选）
    dimensions: Array<{     // 对比维度列表
      label: string;        // 维度名称，如"学习内容"
      value: string;        // 该维度的值
    }>;
    verdict?: string;       // 总结性判断（可选）
  }>;
  summary?: string;
  sources?: Array<{ id: string; title: string; url?: string; publisher?: string; kind?: string }>;
  warnings?: Array<string>;
}) {
  const clampText = (value: string, max = 110) => {
    const normalized = value.replace(/\s+/g, " ").trim();
    return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
  };
  const safeItems = (Array.isArray(items) ? items : [])
    .map((item) => {
      const dimensions = asArray(item?.dimensions)
        .map((dim) => ({
          label: clampText(String(dim?.label ?? ""), 10),
          value: clampText(String(dim?.value ?? ""), 110),
        }))
        .filter((dim) => dim.label && dim.value);
      return {
        ...item,
        name: clampText(String(item?.name ?? ""), 24),
        verdict: clampText(String(item?.verdict ?? ""), 110),
        dimensions,
      };
    })
    .filter((item) => item.name && (item.dimensions.length > 0 || item.verdict));
  const safeSources = Array.isArray(sources) ? sources : [];
  const safeWarnings = Array.isArray(warnings) ? warnings : [];

  // 清理 Markdown 格式标记，但保留 **粗体** 并转换为 <strong> 标签
  const processMarkdown = (text: string): string => {
    if (!text) return "";
    return text
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")  // **粗体** → <strong>粗体</strong>
      .replace(/\*(.+?)\*/g, "$1")      // 移除 *斜体*
      .replace(/__(.+?)__/g, "<strong>$1</strong>")  // __粗体__ → <strong>粗体</strong>
      .replace(/_(.+?)_/g, "$1");       // 移除 _斜体_
  };

  // 将文本按换行符分割为数组，用于渲染多行文本（同时处理 Markdown）
  const splitTextByLines = (text: string): string[] => {
    if (!text) return [];
    // 按 \n 或 \r\n 分割，过滤空行
    return text.split(/\r?\n/).filter(line => line.trim());
  };

  return (
    <div className="gaokao-generic-comparison-card my-3 rounded-lg border border-blue-100 bg-white p-3 text-zinc-950 shadow-sm">
      <p className="text-xs font-semibold text-blue-700">对比分析</p>
      <h3 className="mt-1 text-base font-semibold">{title}</h3>
      
      {/* 对比项卡片网格 */}
      <div className="mt-3 grid gap-3">
        {safeItems.length ? (
          safeItems.map((item, itemIndex) => (
            <article key={`${item.name}-${itemIndex}`} className="rounded-md border border-zinc-200 bg-zinc-50 p-3">
              {/* 标题栏 */}
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <h4 className="break-words text-sm font-semibold whitespace-normal">
                    {item.icon && <span className="mr-1">{item.icon}</span>}
                    {item.name}
                  </h4>
                </div>
              </div>
              
              {/* 对比维度列表 */}
              {item.dimensions.length ? (
                <div className="mt-2 grid gap-1.5 text-xs leading-5 text-zinc-700">
                  {item.dimensions.map((dim, idx) => (
                    <div key={idx} className="grid grid-cols-[70px_1fr] gap-2">
                      <span className="font-medium text-zinc-600">{processMarkdown(dim.label)}：</span>
                      <span className="min-w-0 break-words">{processMarkdown(dim.value)}</span>
                    </div>
                  ))}
                </div>
              ) : null}
              
              {/* 总结性判断 */}
              {item.verdict ? (
                <p className="mt-2 rounded-md bg-white px-2 py-1.5 text-xs font-medium leading-5 text-zinc-900">
                  {processMarkdown(item.verdict)}
                </p>
              ) : null}
            </article>
          ))
        ) : (
          <p className="rounded-md bg-zinc-50 px-3 py-2 text-xs leading-5 text-zinc-600">
            对比数据不足，请至少给出 2 个对比项。
          </p>
        )}
      </div>

      {/* 总结建议 */}
      {summary ? (
        <div className="mt-3 rounded-md bg-blue-50 px-3 py-2 text-xs leading-5 text-blue-900">
          <p className="font-semibold">总结：</p>
          <div className="mt-1 space-y-1">
            {splitTextByLines(summary).map((line, idx) => {
              const processedLine = processMarkdown(line);
              // 如果包含 HTML 标签，使用 dangerouslySetInnerHTML
              if (processedLine.includes('<strong>')) {
                return <p key={idx} dangerouslySetInnerHTML={{ __html: processedLine }} />;
              }
              return <p key={idx}>{processedLine}</p>;
            })}
          </div>
        </div>
      ) : null}

      {/* 警告信息 */}
      {safeWarnings.length > 0 ? (
        <div className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">
          {safeWarnings.slice(0, 2).map((warning) => (
            <p key={warning}>{processMarkdown(warning)}</p>
          ))}
        </div>
      ) : null}

      {/* 来源列表 */}
      {safeSources.length > 0 ? <SourceList sources={safeSources} /> : null}
    </div>
  );
}

function SourceList({ sources }: { sources: Array<z.infer<typeof cardSourceSchema>> }) {
  const safeSources = asArray(sources);

  return (
    <div className="mt-3 border-t border-zinc-100 pt-2">
      <p className="text-xs font-semibold text-zinc-500">来源</p>
      <div className="mt-1 grid gap-1">
        {safeSources.slice(0, 4).map((source, index) =>
          source.url?.trim() ? (
            <a
              key={`${source.title}-${index}`}
              href={source.url}
              target="_blank"
              rel="noreferrer"
              className="break-words text-xs text-red-700 underline underline-offset-2"
            >
              {source.title}
            </a>
          ) : (
            <span key={`${source.title}-${index}`} className="break-words text-xs text-zinc-600">
              {source.title}
            </span>
          ),
        )}
      </div>
    </div>
  );
}

function ToolReasoning({
  name,
  args,
  status,
}: {
  name: string;
  args?: unknown;
  status: string;
}) {
  const isInternalGenerativeUiTool =
    name === "AGUISendStateDelta" ||
    name.startsWith("AGUI") ||
    name.startsWith("agui") ||
    name.includes("AGUI");

  if (
    isInternalGenerativeUiTool ||
    name === "scoreLineTrendChart" ||
    name === "studentProfileSummary" ||
    name === "volunteerPlanCards" ||
    name === "admissionRiskCards" ||
    name === "schoolComparisonCard" ||
    name === "genericComparisonCard" ||
    name === "render_a2ui" ||
    name === "generate_a2ui"
  ) {
    return null;
  }

  const isRunning = status === "executing" || status === "inProgress";
  const entries =
    args && typeof args === "object" && !Array.isArray(args) ? Object.entries(args) : [];
  const toolArgObject = args && typeof args === "object" && !Array.isArray(args) ? args as Record<string, unknown> : {};
  const queriedSchool =
    typeof toolArgObject.schoolName === "string"
      ? toolArgObject.schoolName
      : typeof toolArgObject.target === "object" &&
          toolArgObject.target &&
          "schoolName" in toolArgObject.target &&
          typeof (toolArgObject.target as { schoolName?: unknown }).schoolName === "string"
        ? (toolArgObject.target as { schoolName: string }).schoolName
        : "";
  const label =
    name === "lookupAdmissionScores"
      ? queriedSchool
        ? `${isRunning ? "查询" : "已查询"}${queriedSchool}`
        : "官方分数线查询"
      : name === "lookupRankByScore"
        ? "位次查询"
        : name === "researchGaokaoData"
          ? "联网检索"
          : name === "buildVolunteerPlan"
            ? "冲稳保方案"
            : name === "explainAdmissionRisk"
              ? "风险解释"
              : name === "compareSchools"
                ? "院校对比"
                : name;
  const processLabel =
    name === "researchGaokaoData"
      ? "检索过程"
      : name === "lookupAdmissionScores" || name === "lookupRankByScore"
        ? "思考过程"
        : "工具过程";
  const formatToolValue = (value: unknown) => {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  };

  return (
    <details
      open={isRunning}
      className="my-2 px-3 text-xs"
      data-gaokao-process-kind="agent-thinking"
      data-gaokao-tool-type={name}
      data-gaokao-school={queriedSchool || undefined}
      data-gaokao-running={isRunning ? "true" : "false"}
    >
      <summary className={`flex cursor-pointer list-none items-center gap-2 rounded-xl px-3 py-2 font-medium ring-1 transition-colors ${
        isRunning
          ? "bg-white/50 text-zinc-600 ring-zinc-200/80 hover:bg-white/70"
          : "bg-white/50 text-zinc-400 ring-zinc-100/50"
      }`}>
        <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full ring-1 ${
          isRunning
            ? "bg-blue-50 text-blue-500 ring-blue-200"
            : "bg-emerald-50 text-emerald-500 ring-emerald-200"
        }`}>
          {isRunning ? (
            <span className="gaokao-spin inline-block">
              <Icon
                name={name === "lookupAdmissionScores" || name === "researchGaokaoData" ? "search" : "clock"}
                className="h-3 w-3"
              />
            </span>
          ) : (
            <Icon name="check" className="h-3 w-3" />
          )}
        </span>
        <span className={`min-w-0 flex-1 truncate ${isRunning ? "text-zinc-600" : "text-zinc-400"}`}>
          {processLabel} · {label}
        </span>
        <span
          className={`shrink-0 rounded border px-1.5 py-0.5 text-[11px] ${
            isRunning
              ? "border-red-100 bg-red-50 text-red-700"
              : "border-emerald-100 bg-emerald-50 text-emerald-700"
          }`}
        >
          {isRunning ? "进行中" : "已完成"}
        </span>
      </summary>
      {entries.length > 0 ? (
        <div className={`ml-7 grid max-h-48 gap-2 overflow-y-auto border-l px-3 py-1.5 ${
          isRunning ? "border-zinc-200/50" : "border-zinc-100/50"
        }`}>
          {entries.slice(0, 5).map(([key, value]) => (
            <div key={key} className={`min-w-0 rounded-lg px-2 py-1.5 ring-1 ${
              isRunning ? "bg-white/50 ring-zinc-200/50" : "bg-white/50 ring-zinc-100/50"
            }`}>
              <span className="block text-[11px] font-black text-zinc-500">{key}</span>
              <pre className="mt-1 max-w-full whitespace-pre-wrap break-words font-sans text-[11px] leading-4 text-zinc-700">
                {formatToolValue(value)}
              </pre>
            </div>
          ))}
        </div>
      ) : null}
    </details>
  );
}

function createSession(title = "新会话"): LocalSession {
  const now = new Date().toISOString();
  const randomId =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return {
    id: `gaokao-thread-${randomId}`,
    title,
    createdAt: now,
    updatedAt: now,
    titleSource: "default",
  };
}

function findFirstMatch(text: string, candidates: string[]) {
  return candidates.find((candidate) => text.includes(candidate));
}

function isGenericSessionTitle(title: string) {
  return ["新会话", "志愿填报", "高考咨询", "志愿咨询"].includes(title.trim());
}

function deriveSessionTitleFromPrompt(prompt: string) {
  const text = prompt.replace(/\s+/g, "");
  if (!text) return "";

  const schoolMatch = text.match(
    /([\u4e00-\u9fa5]{2,16}(?:大学|学院|医科大学|师范大学|工业大学|理工大学|交通大学|航空航天大学|农业大学|财经大学|政法大学))/,
  );
  const schoolName = schoolMatch?.[1];
  if (schoolName) {
    if (/趋势|近三年|三年|历年|走势/.test(text)) return `${schoolName}趋势`.slice(0, 14);
    if (/分数线|投档线|录取|最低分|专业组/.test(text)) return `${schoolName}分数线`.slice(0, 14);
    return `${schoolName}咨询`.slice(0, 14);
  }

  const englishProvinceMap: Record<string, string> = {
    beijing: "北京",
    tianjin: "天津",
    shanghai: "上海",
    chongqing: "重庆",
    jiangsu: "江苏",
    zhejiang: "浙江",
    guangdong: "广东",
    shandong: "山东",
    henan: "河南",
    hubei: "湖北",
    hunan: "湖南",
    sichuan: "四川",
    shaanxi: "陕西",
  };
  const lowerPrompt = prompt.toLowerCase();
  const englishProvince = Object.entries(englishProvinceMap).find(([key]) =>
    lowerPrompt.includes(key),
  )?.[1];
  const province = englishProvince ?? findFirstMatch(text, [
    "北京",
    "天津",
    "上海",
    "重庆",
    "河北",
    "山西",
    "辽宁",
    "吉林",
    "黑龙江",
    "江苏",
    "浙江",
    "安徽",
    "福建",
    "江西",
    "山东",
    "河南",
    "湖北",
    "湖南",
    "广东",
    "海南",
    "四川",
    "贵州",
    "云南",
    "陕西",
    "甘肃",
    "青海",
    "内蒙古",
    "广西",
    "西藏",
    "宁夏",
    "新疆",
  ]);

  if (
    province &&
    (/选科|选考|物理|历史|物化|文科|理科|科类|综合|专业|志愿|报考|位次|冲稳保|分/.test(text) ||
      /physics|history|score|rank|volunteer|advice|major|college|application/.test(lowerPrompt))
  ) {
    return `${province}选考意见`;
  }

  const scoreMatch = text.match(/(\d{3})分?/);
  if (scoreMatch) return `${scoreMatch[1]}分志愿建议`;

  const compact = prompt.replace(/[|#*_`~>\[\](){}]/g, "").replace(/\s+/g, " ").trim();
  if (!compact) return "";
  return compact.slice(0, 12);
}

function useLocalSessions() {
  const [hydrated, setHydrated] = useState(false);
  const [sessions, setSessions] = useState<LocalSession[]>([DEFAULT_SESSION]);
  const [activeSessionId, setActiveSessionId] = useState(DEFAULT_SESSION.id);

  useEffect(() => {
    try {
      const storedSessions = localStorage.getItem(SESSION_STORAGE_KEY);
      const parsedSessions = storedSessions ? (JSON.parse(storedSessions) as LocalSession[]) : null;
      const validSessions =
        Array.isArray(parsedSessions) && parsedSessions.length > 0
          ? parsedSessions.filter((session) => session.id && session.title)
          : [DEFAULT_SESSION];
      const activeId = localStorage.getItem(ACTIVE_SESSION_STORAGE_KEY);
      setSessions(validSessions.length ? validSessions : [DEFAULT_SESSION]);
      setActiveSessionId(
        activeId && validSessions.some((session) => session.id === activeId)
          ? activeId
          : validSessions[0]?.id ?? DEFAULT_SESSION.id,
      );
    } catch {
      setSessions([DEFAULT_SESSION]);
      setActiveSessionId(DEFAULT_SESSION.id);
    } finally {
      setHydrated(true);
    }
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(sessions));
    localStorage.setItem(ACTIVE_SESSION_STORAGE_KEY, activeSessionId);
  }, [activeSessionId, hydrated, sessions]);

  const createNewSession = useCallback(() => {
    const nextSession = createSession("新会话");
    setSessions((current) => [nextSession, ...current]);
    setActiveSessionId(nextSession.id);
  }, []);

  const renameSession = useCallback((sessionId: string, title: string) => {
    const cleanedTitle = title.trim().slice(0, 24);
    if (!cleanedTitle) return;

    setSessions((items) =>
      items.map((session) =>
        session.id === sessionId
          ? {
              ...session,
              title: cleanedTitle,
              titleSource: "manual",
              updatedAt: new Date().toISOString(),
            }
          : session,
      ),
    );
  }, []);

  const autoRenameSessionFromPrompt = useCallback((sessionId: string, prompt: string) => {
    const title = deriveSessionTitleFromPrompt(prompt);
    if (!title) return;

    setSessions((items) =>
      items.map((session) => {
        if (session.id !== sessionId || session.titleSource === "manual" || session.titleSource === "auto") return session;
        if (!isGenericSessionTitle(session.title)) return session;
        if (session.title === title) return session;

        return {
          ...session,
          title: title.slice(0, 24),
          titleSource: "auto",
          updatedAt: new Date().toISOString(),
        };
      }),
    );
  }, []);

  const deleteSession = useCallback(
    (sessionId: string) => {
      setSessions((items) => {
        const remaining = items.filter((session) => session.id !== sessionId);
        if (remaining.length === 0) {
          const fallback = createSession("新会话");
          setActiveSessionId(fallback.id);
          return [fallback];
        }
        if (activeSessionId === sessionId) {
          setActiveSessionId(remaining[0].id);
        }
        return remaining;
      });
    },
    [activeSessionId],
  );

  return {
    activeSessionId,
    autoRenameSessionFromPrompt,
    createNewSession,
    deleteSession,
    renameSession,
    sessions,
    setActiveSessionId,
  };
}

function useLocalProfiles(activeSessionId: string) {
  const [hydrated, setHydrated] = useState(false);
  const [profilesBySession, setProfilesBySession] = useState<Record<string, StudentProfile>>({});

  useEffect(() => {
    try {
      const storedProfiles = localStorage.getItem(PROFILE_STORAGE_KEY);
      const parsedProfiles = storedProfiles ? (JSON.parse(storedProfiles) as Record<string, StudentProfile>) : {};
      setProfilesBySession(parsedProfiles && typeof parsedProfiles === "object" ? parsedProfiles : {});
    } catch {
      setProfilesBySession({});
    } finally {
      setHydrated(true);
    }
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(profilesBySession));
  }, [hydrated, profilesBySession]);

  const updateProfileFromPatch = useCallback((sessionId: string, patch: Partial<StudentProfile>) => {
    if (Object.keys(patch).length === 0) return;
    setProfilesBySession((current) => ({
      ...current,
      [sessionId]: {
        ...(current[sessionId] ?? {}),
        ...patch,
        majorPreference: patch.majorPreference ?? current[sessionId]?.majorPreference,
        avoidMajors: patch.avoidMajors ?? current[sessionId]?.avoidMajors,
      },
    }));
  }, []);

  const updateProfileFromPrompt = useCallback(
    (sessionId: string, prompt: string) => {
      updateProfileFromPatch(sessionId, extractProfileFromPrompt(prompt));
    },
    [updateProfileFromPatch],
  );

  const activeProfile = profilesBySession[activeSessionId] ?? {};

  return {
    activeProfile,
    updateProfileFromPatch,
    updateProfileFromPrompt,
  };
}

function useSessionInsights(activeSessionId: string) {
  const [hydrated, setHydrated] = useState(false);
  const [summaryBySession, setSummaryBySession] = useState<Record<string, string>>({});
  const [turnContextBySession, setTurnContextBySession] = useState<Record<string, TurnContext>>({});
  const [suggestionsBySession, setSuggestionsBySession] = useState<Record<string, string[]>>({});

  useEffect(() => {
    try {
      const storedSummary = localStorage.getItem(SUMMARY_STORAGE_KEY);
      const storedTurnContext = localStorage.getItem(TURN_CONTEXT_STORAGE_KEY);
      const storedSuggestions = localStorage.getItem(SUGGESTIONS_STORAGE_KEY);
      setSummaryBySession(storedSummary ? JSON.parse(storedSummary) : {});
      setTurnContextBySession(storedTurnContext ? JSON.parse(storedTurnContext) : {});
      setSuggestionsBySession(storedSuggestions ? JSON.parse(storedSuggestions) : {});
    } catch {
      setSummaryBySession({});
      setTurnContextBySession({});
      setSuggestionsBySession({});
    } finally {
      setHydrated(true);
    }
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    localStorage.setItem(SUMMARY_STORAGE_KEY, JSON.stringify(summaryBySession));
    localStorage.setItem(TURN_CONTEXT_STORAGE_KEY, JSON.stringify(turnContextBySession));
    localStorage.setItem(SUGGESTIONS_STORAGE_KEY, JSON.stringify(suggestionsBySession));
  }, [hydrated, summaryBySession, suggestionsBySession, turnContextBySession]);

  const upsertTurnContext = useCallback((sessionId: string, turnContext: TurnContext) => {
    setTurnContextBySession((current) => ({ ...current, [sessionId]: turnContext }));
    setSummaryBySession((current) => ({ ...current, [sessionId]: turnContext.sessionSummary }));
    setSuggestionsBySession((current) => ({ ...current, [sessionId]: turnContext.suggestions }));
  }, []);

  const upsertSuggestions = useCallback((sessionId: string, suggestions: string[]) => {
    setSuggestionsBySession((current) => ({ ...current, [sessionId]: uniqueTextItems(suggestions).slice(0, 8) }));
  }, []);

  return {
    activeSessionSummary: summaryBySession[activeSessionId] ?? "",
    activeTurnContext: turnContextBySession[activeSessionId],
    activeSuggestions: suggestionsBySession[activeSessionId] ?? [],
    upsertTurnContext,
    upsertSuggestions,
  };
}

function useSessionUiState(activeSessionId: string) {
  const [hydrated, setHydrated] = useState(false);
  const [ignoredBySession, setIgnoredBySession] = useState<Record<string, Array<keyof StudentProfile>>>({});
  const [collapsedBySession, setCollapsedBySession] = useState<Record<string, boolean>>({});
  const [rankMetaBySession, setRankMetaBySession] = useState<Record<string, RankMeta>>({});

  useEffect(() => {
    try {
      const storedIgnored = localStorage.getItem(IGNORED_MISSING_STORAGE_KEY);
      const storedCollapsed = localStorage.getItem(PROFILE_PANEL_COLLAPSED_STORAGE_KEY);
      const storedRankMeta = localStorage.getItem(RANK_META_STORAGE_KEY);
      setIgnoredBySession(storedIgnored ? JSON.parse(storedIgnored) : {});
      setCollapsedBySession(storedCollapsed ? JSON.parse(storedCollapsed) : {});
      setRankMetaBySession(storedRankMeta ? JSON.parse(storedRankMeta) : {});
    } catch {
      setIgnoredBySession({});
      setCollapsedBySession({});
      setRankMetaBySession({});
    } finally {
      setHydrated(true);
    }
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    localStorage.setItem(IGNORED_MISSING_STORAGE_KEY, JSON.stringify(ignoredBySession));
    localStorage.setItem(PROFILE_PANEL_COLLAPSED_STORAGE_KEY, JSON.stringify(collapsedBySession));
    localStorage.setItem(RANK_META_STORAGE_KEY, JSON.stringify(rankMetaBySession));
  }, [collapsedBySession, hydrated, ignoredBySession, rankMetaBySession]);

  const setIgnoredFields = useCallback((sessionId: string, fields: Array<string | keyof StudentProfile>) => {
    const normalized = normalizeIgnoredKeys(fields);
    setIgnoredBySession((current) => ({ ...current, [sessionId]: normalized }));
  }, []);

  const clearIgnoredFields = useCallback((sessionId: string) => {
    setIgnoredBySession((current) => {
      const next = { ...current };
      delete next[sessionId];
      return next;
    });
  }, []);

  const setProfilePanelCollapsed = useCallback((sessionId: string, collapsed: boolean) => {
    setCollapsedBySession((current) => ({ ...current, [sessionId]: collapsed }));
  }, []);

  const upsertRankMeta = useCallback((sessionId: string, meta: RankMeta) => {
    setRankMetaBySession((current) => ({ ...current, [sessionId]: meta }));
  }, []);

  const clearRankMeta = useCallback((sessionId: string) => {
    setRankMetaBySession((current) => {
      const next = { ...current };
      delete next[sessionId];
      return next;
    });
  }, []);

  return {
    activeIgnoredFields: ignoredBySession[activeSessionId] ?? [],
    activeProfilePanelCollapsed: collapsedBySession[activeSessionId] ?? false,
    activeRankMeta: rankMetaBySession[activeSessionId],
    clearIgnoredFields,
    clearRankMeta,
    setIgnoredFields,
    setProfilePanelCollapsed,
    upsertRankMeta,
  };
}

function useMobileVisualViewport() {
  useEffect(() => {
    if (typeof window === "undefined") return;

    const root = document.documentElement;
    let animationFrame = 0;
    let focusTimeout = 0;
    let layoutViewportHeight = Math.round(window.visualViewport?.height ?? window.innerHeight);

    const updateKeyboardInset = () => {
      if (animationFrame) window.cancelAnimationFrame(animationFrame);

      animationFrame = window.requestAnimationFrame(() => {
        const viewport = window.visualViewport;
        const viewportHeight = viewport?.height ?? window.innerHeight;
        const offsetTop = viewport?.offsetTop ?? 0;
        const activeElement = document.activeElement;
        const isTextInputFocused =
          activeElement instanceof HTMLTextAreaElement ||
          activeElement instanceof HTMLInputElement;

        if (!isTextInputFocused) {
          layoutViewportHeight = Math.max(
            layoutViewportHeight,
            Math.round(viewportHeight + offsetTop),
            window.innerHeight,
          );
          root.style.setProperty("--gaokao-layout-height", `${layoutViewportHeight}px`);
        }

        const keyboardInset = Math.max(
          0,
          Math.round(layoutViewportHeight - viewportHeight - offsetTop),
        );

        root.style.setProperty("--gaokao-keyboard-inset", `${keyboardInset}px`);
        root.classList.toggle("gaokao-keyboard-open", isTextInputFocused);
        window.scrollTo(0, 0);
      });
    };

    const scheduleViewportUpdate = (event?: Event) => {
      updateKeyboardInset();
      window.clearTimeout(focusTimeout);
      focusTimeout = window.setTimeout(() => {
        updateKeyboardInset();
        if (event?.target instanceof HTMLTextAreaElement) window.scrollTo(0, 0);
      }, 250);
    };

    updateKeyboardInset();
    root.style.setProperty("--gaokao-layout-height", `${layoutViewportHeight}px`);
    window.addEventListener("resize", updateKeyboardInset);
    window.addEventListener("orientationchange", scheduleViewportUpdate);
    window.addEventListener("focusin", scheduleViewportUpdate);
    window.addEventListener("focusout", scheduleViewportUpdate);
    window.visualViewport?.addEventListener("resize", updateKeyboardInset);
    window.visualViewport?.addEventListener("scroll", updateKeyboardInset);

    return () => {
      if (animationFrame) window.cancelAnimationFrame(animationFrame);
      window.clearTimeout(focusTimeout);
      window.removeEventListener("resize", updateKeyboardInset);
      window.removeEventListener("orientationchange", scheduleViewportUpdate);
      window.removeEventListener("focusin", scheduleViewportUpdate);
      window.removeEventListener("focusout", scheduleViewportUpdate);
      window.visualViewport?.removeEventListener("resize", updateKeyboardInset);
      window.visualViewport?.removeEventListener("scroll", updateKeyboardInset);
      root.style.removeProperty("--gaokao-keyboard-inset");
      root.style.removeProperty("--gaokao-layout-height");
      root.classList.remove("gaokao-keyboard-open");
    };
  }, []);
}

function useAssistantSuggestionRefresh({
  activeSessionId,
  profile,
  missingPriority,
  ignoredFields = [],
  upsertSuggestions,
}: {
  activeSessionId: string;
  profile: StudentProfile;
  missingPriority?: Array<keyof StudentProfile>;
  ignoredFields?: Array<keyof StudentProfile>;
  upsertSuggestions: (sessionId: string, suggestions: string[]) => void;
}) {
  useEffect(() => {
    if (typeof window === "undefined") return;
    let timer = 0;
    let lastText = "";

    const refreshSuggestions = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const latestAssistantText = readLastAssistantText();
        if (!latestAssistantText || latestAssistantText === lastText) return;
        lastText = latestAssistantText;
        const nextMissing = prioritizeMissingFields(profile, "", missingPriority, ignoredFields).slice(0, 8);
        const nextSuggestions = buildSuggestions(profile, nextMissing, latestAssistantText, ignoredFields);
        if (nextSuggestions.length) upsertSuggestions(activeSessionId, nextSuggestions);
      }, 900);
    };

    refreshSuggestions();
    const observer = new MutationObserver(refreshSuggestions);
    const messageList = document.querySelector('[data-testid="copilot-message-list"]') ?? document.body;
    observer.observe(messageList, {
      childList: true,
      subtree: true,
    });

    return () => {
      window.clearTimeout(timer);
      observer.disconnect();
    };
  }, [activeSessionId, ignoredFields, missingPriority, profile, upsertSuggestions]);
}

function buildInlineFollowUpQuestions(
  text: string,
  profile: StudentProfile,
  ignoredFields: Array<keyof StudentProfile>,
) {
  const asksForMore =
    /需要(?:告诉|补充|确认|说)|请(?:补充|告诉|确认)|能接受.*吗|能不能|有没有|更倾向|还是|方向(?:是|吗)|城市.*(?:是|吗)|预算.*多少|位次.*吗|吗[？?]|[？?]/.test(text);
  if (!asksForMore) return [];

  const ignored = new Set(normalizeIgnoredKeys(ignoredFields));
  const hasProfileValue = (field: keyof StudentProfile) => {
    const value = profile[field];
    if (value !== undefined && value !== "" && (!Array.isArray(value) || value.length > 0)) return true;
    if (field === "budget") return Boolean(profile.familyBudget || profile.budget);
    if (field === "cityPreference") return Boolean(profile.cityPreference || profile.targetCities?.length);
    if (field === "majorPreference") return Boolean(profile.majorPreference?.length || profile.preferredMajors?.length);
    return false;
  };
  const hasDraftAnswer = (field: keyof StudentProfile) => {
    const options = FOLLOW_UP_OPTIONS_BY_FIELD[field] ?? [];
    return options.some((option) => composerDraftIncludesPrompt(option.prompt));
  };
  const shouldAskField = (field: keyof StudentProfile) => {
    if (ignored.has(field)) return false;
    if (hasProfileValue(field)) return false;
    if (hasDraftAnswer(field)) return false;
    return true;
  };
  const questions: Array<{ field: keyof StudentProfile; question: string }> = [];
  const push = (field: keyof StudentProfile, question: string) => {
    if (!shouldAskField(field)) return;
    if (questions.some((item) => item.field === field)) return;
    questions.push({ field, question });
  };

  if (/位次|排名|排位|全省/.test(text)) push("rank", "你的全省位次查到了吗？");
  if (/预算|学费|生活费|中外合作|费用/.test(text)) push("budget", "家里每年预算大概能接受多少？");
  if (/城市|地区|想去|哪里读|留在/.test(text)) push("cityPreference", "你更想去哪个城市或地区？");
  if (/出省|外省|省内/.test(text)) push("canLeaveProvince", "能接受出省读大学吗？");
  if (/专升本|升本|读研|保研|就业|本科毕业|毕业后/.test(text)) push("graduatePlan", "毕业后更倾向直接就业、升学，还是还不确定？");
  if (/专业|方向|计算机|电气|机械|医学|师范/.test(text)) push("majorPreference", "专业方向能再具体一点吗？");

  return dedupeFollowUpQuestions(questions.map((question) => ({
    ...question,
    options: question.field === "graduatePlan" && /专升本|升本/.test(text)
      ? [
          { label: "直接就业", prompt: "毕业后倾向直接就业。" },
          { label: "想专升本", prompt: "毕业后想专升本。" },
          { label: "还没想好", prompt: "毕业后就业还是专升本还没想好。" },
        ]
      : FOLLOW_UP_OPTIONS_BY_FIELD[question.field] ?? [],
  }))).slice(0, 4);
}

function normalizeFollowUpField(field: string | undefined, question = "") {
  const value = `${field ?? ""} ${question}`.replace(/\s+/g, "");
  const mapped = FIELD_BY_LABEL.get(field ?? "");
  if (mapped) return mapped;
  if (/rank|位次|排名|排位|全省/.test(value)) return "rank";
  if (/budget|预算|学费|生活费|中外|费用|钱/.test(value)) return "budget";
  if (/city|城市|地区|想去|哪里读|留在|京津冀|长三角/.test(value)) return "cityPreference";
  if (/leave|出省|外省|省内/.test(value)) return "canLeaveProvince";
  if (/graduate|读研|保研|就业|本科毕业|专升本|升本/.test(value)) return "graduatePlan";
  if (/majorPreference|专业偏好|专业方向|选科组合|选科|物理|化学/.test(value)) return "majorPreference";
  if (/avoid|避雷|避开|不想学|别碰/.test(value)) return "avoidMajors";
  if (/subject|科类|文科|理科|历史|综合改革/.test(value)) return "subjectTrack";
  if (/province|高考省份|考生|生源/.test(value)) return "province";
  if (/score|分数|成绩/.test(value)) return "score";
  return value || question;
}

function dedupeFollowUpQuestions(questions: FollowUpQuestionOptionsArgs["questions"]) {
  const seen = new Set<string>();
  return questions.filter((question) => {
    if (!question.question?.trim() || !question.options?.length) return false;
    const key = String(normalizeFollowUpField(question.field, question.question));
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const FOLLOWUP_BUTTON_BASE_CLASS =
  "shrink-0 rounded-xl border px-3.5 py-2 text-sm font-black active:scale-[0.98]";
const FOLLOWUP_BUTTON_IDLE_CLASS = `${FOLLOWUP_BUTTON_BASE_CLASS} border-blue-100 bg-blue-50 text-blue-700`;
const FOLLOWUP_BUTTON_SELECTED_CLASS = `${FOLLOWUP_BUTTON_BASE_CLASS} border-blue-600 bg-blue-600 text-white shadow-sm`;

function splitComposerDraft(value: string) {
  return value
    .split("；")
    .map((item) => item.trim())
    .filter(Boolean);
}

function getCurrentComposerDraft() {
  const visibleTextarea = document.querySelector<HTMLTextAreaElement>(".gaokao-text-composer textarea");
  const hiddenTextarea = document.querySelector<HTMLTextAreaElement>(COPILOT_CHAT_TEXTAREA_SELECTOR);
  return visibleTextarea?.value || hiddenTextarea?.value || "";
}

function composerDraftIncludesPrompt(prompt: string) {
  return splitComposerDraft(getCurrentComposerDraft()).includes(prompt.trim());
}

function applyFollowUpButtonState(button: HTMLButtonElement, selected: boolean) {
  button.dataset.selected = selected ? "true" : "false";
  button.setAttribute("aria-pressed", selected ? "true" : "false");
  button.className = selected ? FOLLOWUP_BUTTON_SELECTED_CLASS : FOLLOWUP_BUTTON_IDLE_CLASS;
}

type FollowUpOption = FollowUpQuestionOptionsArgs["questions"][number]["options"][number];

function normalizeFollowUpOption(option: FollowUpOption | undefined) {
  const label = typeof option?.label === "string" ? option.label.trim() : "";
  const value = typeof option?.value === "string" ? option.value.trim() : "";
  const prompt = typeof option?.prompt === "string" ? option.prompt.trim() : "";
  const safePrompt = prompt || value || label;
  const safeLabel = label || value || prompt;
  if (!safePrompt || !safeLabel) return null;
  return { label: safeLabel, prompt: safePrompt };
}

function useInlineFollowUpOptions({
  activeSessionId,
  profile,
  ignoredFields,
  onSelect,
  onDeselect,
}: {
  activeSessionId: string;
  profile: StudentProfile;
  ignoredFields: Array<keyof StudentProfile>;
  onSelect: (prompt: string) => void;
  onDeselect: (prompt: string) => void;
}) {
  useEffect(() => {
    if (typeof document === "undefined") return;

    let frame = 0;
    const timers = new Set<number>();
    const clearTimers = () => {
      timers.forEach((timerId) => window.clearTimeout(timerId));
      timers.clear();
    };
    const enhance = () => {
      if (frame) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const messages = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="copilot-assistant-message"], .copilotKitAssistantMessage'));
        const latestMessage = messages.at(-1);
        messages.slice(0, -1).forEach((message) => {
          message.querySelectorAll(".gaokao-inline-followup-options").forEach((node) => node.remove());
        });
        if (!latestMessage) return;
        const existingFollowUps = Array.from(
          latestMessage.querySelectorAll<HTMLElement>(".gaokao-followup-options"),
        );
        if (existingFollowUps.length) {
          existingFollowUps.forEach((node) => latestMessage.append(node));
          return;
        }
        if (latestMessage.querySelector('[data-gaokao-running="true"]')) return;
        const text = latestMessage.innerText.trim();
        const questions = buildInlineFollowUpQuestions(text, profile, ignoredFields);
        latestMessage.querySelectorAll(".gaokao-inline-followup-options").forEach((node) => node.remove());
        if (!questions.length) return;
        const container = document.createElement("div");
        container.className = "gaokao-inline-followup-options mt-3 grid gap-2";
        container.dataset.gaokaoInlineFollowup = "true";
        questions.forEach((question) => {
          const group = document.createElement("div");
          group.className = "rounded-2xl border border-blue-100 bg-white px-3 py-3 shadow-sm";

          const label = document.createElement("p");
          label.className = "text-sm font-black leading-6 text-slate-900";
          label.textContent = question.question;
          group.append(label);

          const buttonRow = document.createElement("div");
          buttonRow.className = "mt-2 flex gap-2 overflow-x-auto pb-1";
          question.options.slice(0, 5).forEach((option) => {
            const normalizedOption = normalizeFollowUpOption(option);
            if (!normalizedOption) return;
            const { label: optionLabel, prompt } = normalizedOption;
            const button = document.createElement("button");
            button.type = "button";
            button.textContent = optionLabel;
            applyFollowUpButtonState(button, composerDraftIncludesPrompt(prompt));
            button.addEventListener("click", () => {
              if (button.dataset.selected === "true") {
                applyFollowUpButtonState(button, false);
                onDeselect(prompt);
                timers.add(window.setTimeout(enhance, 80));
                return;
              }
              applyFollowUpButtonState(button, true);
              onSelect(prompt);
              timers.add(window.setTimeout(enhance, 80));
            });
            buttonRow.append(button);
          });
          group.append(buttonRow);
          container.append(group);
        });

        latestMessage.append(container);
      });
    };
    const scheduleEnhance = () => {
      clearTimers();
      [250, 1100, 2200].forEach((delay) => {
        const timerId = window.setTimeout(enhance, delay);
        timers.add(timerId);
      });
    };

    scheduleEnhance();
    const observer = new MutationObserver(scheduleEnhance);
    const messageList = document.querySelector('[data-testid="copilot-message-list"]') ?? document.body;
    observer.observe(messageList, { childList: true, subtree: true, characterData: true });

    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      clearTimers();
      observer.disconnect();
    };
  }, [activeSessionId, ignoredFields, onDeselect, onSelect, profile]);
}

function syncHiddenCopilotPrompt(message: string, focusHidden = false) {
  const textarea = document.querySelector<HTMLTextAreaElement>(COPILOT_CHAT_TEXTAREA_SELECTOR);
  if (textarea) {
    const previousValue = textarea.value;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(textarea, message);
    const valueTracker = (textarea as HTMLTextAreaElement & { _valueTracker?: { setValue: (value: string) => void } })
      ._valueTracker;
    valueTracker?.setValue(previousValue);
    if (focusHidden) textarea.focus();
    textarea.dispatchEvent(
      new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        data: message,
        inputType: "insertText",
      }),
    );
    textarea.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        data: message,
        inputType: "insertText",
      }),
    );
    textarea.dispatchEvent(new Event("change", { bubbles: true }));
  }
}

function insertPrompt(message: string) {
  window.dispatchEvent(new CustomEvent(COMPOSER_DRAFT_EVENT, { detail: message }));
}

function appendPromptToComposer(message: string) {
  window.dispatchEvent(
    new CustomEvent(COMPOSER_DRAFT_EVENT, {
      detail: { mode: "append", value: message },
    }),
  );
}

function removePromptFromComposer(message: string) {
  window.dispatchEvent(
    new CustomEvent(COMPOSER_DRAFT_EVENT, {
      detail: { mode: "remove", value: message },
    }),
  );
}

function buildSchoolTrendPrompt(schoolName: string, profile?: StudentProfile) {
  const province = profile?.province ? `${profile.province}` : "";
  const subjectTrack = profile?.subjectTrack ? `${profile.subjectTrack}` : "";
  const scope = [province, subjectTrack].filter(Boolean).join("");
  return `查看${schoolName}近三年${scope ? `在${scope}` : ""}录取分数线趋势，并绘制曲线。`;
}

function submitSchoolTrendPrompt(schoolName: string, profile?: StudentProfile) {
  const prompt = buildSchoolTrendPrompt(schoolName, profile);
  insertPrompt(prompt);
  window.setTimeout(() => submitHiddenCopilotPrompt(prompt), 80);
}

function submitHiddenCopilotPrompt(message: string) {
  syncHiddenCopilotPrompt(message, true);
  let attempts = 0;
  const trySend = () => {
    const { sendButton, textarea } = getCopilotChatInputElements();
    if (!sendButton || !textarea || !textarea.value.trim()) {
      if (attempts++ < 20) {
        syncHiddenCopilotPrompt(message, true);
        window.setTimeout(trySend, 60);
      }
      return;
    }
    if (sendButton.disabled) {
      if (attempts++ < 20) {
        syncHiddenCopilotPrompt(message, true);
        window.setTimeout(trySend, 60);
      }
      return;
    }
    syncHiddenCopilotPrompt(message, true);
    sendButton.click();
  };
  window.setTimeout(trySend, 50);
}

async function waitForRuntimeAgent(
  copilotkit: ReturnType<typeof useCopilotKit>["copilotkit"],
  fallbackAgent: ReturnType<typeof useAgent>["agent"],
) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const runtimeAgent = copilotkit.getAgent("default");
    if (runtimeAgent) return runtimeAgent;
    await new Promise((resolve) => window.setTimeout(resolve, 80));
  }
  return fallbackAgent;
}

function getCopilotChatInputElements() {
  return {
    sendButton: document.querySelector<HTMLButtonElement>(COPILOT_SEND_BUTTON_SELECTOR),
    textarea: document.querySelector<HTMLTextAreaElement>(COPILOT_CHAT_TEXTAREA_SELECTOR),
  };
}

function useAutoSessionTitle(
  activeSessionId: string,
  onPromptSubmitted: (sessionId: string, prompt: string) => void,
  manuallySubmittedPromptRef?: MutableRefObject<{ prompt: string; submittedAt: number } | null>,
) {
  const lastPromptRef = useRef("");
  const lastCapturedAtRef = useRef(0);

  useEffect(() => {
    if (typeof window === "undefined") return;

    let attachedTextarea: HTMLTextAreaElement | null = null;
    let attachedButton: HTMLButtonElement | null = null;
    let detachHandlers: (() => void)[] = [];

    const capturePrompt = () => {
      const { textarea } = getCopilotChatInputElements();
      const prompt = textarea?.value.trim();
      if (!prompt) return;

      const now = Date.now();
      if (prompt === lastPromptRef.current && now - lastCapturedAtRef.current < 1000) return;
      const manual = manuallySubmittedPromptRef?.current;
      if (manual?.prompt === prompt && now - manual.submittedAt < 1500) {
        lastPromptRef.current = prompt;
        lastCapturedAtRef.current = now;
        return;
      }
      lastPromptRef.current = prompt;
      lastCapturedAtRef.current = now;
      flushSync(() => {
        onPromptSubmitted(activeSessionId, prompt);
      });
    };

    const attach = () => {
      const { sendButton, textarea } = getCopilotChatInputElements();
      if (attachedTextarea === textarea && attachedButton === sendButton) return;

      detachHandlers.forEach((detach) => detach());
      detachHandlers = [];
      attachedTextarea = textarea;
      attachedButton = sendButton;

      if (!textarea || !sendButton) return;

      const handleSendClick = () => capturePrompt();
      const handleKeyDown = (event: KeyboardEvent) => {
        if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
        capturePrompt();
      };

      sendButton.addEventListener("click", handleSendClick, true);
      textarea.addEventListener("keydown", handleKeyDown, true);

      detachHandlers.push(
        () => sendButton.removeEventListener("click", handleSendClick, true),
        () => textarea.removeEventListener("keydown", handleKeyDown, true),
      );
    };

    const attachTimer = window.setTimeout(attach, 0);
    const observer = new MutationObserver(attach);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });

    return () => {
      window.clearTimeout(attachTimer);
      observer.disconnect();
      detachHandlers.forEach((detach) => detach());
    };
  }, [activeSessionId, manuallySubmittedPromptRef, onPromptSubmitted]);
}

function useMobileSendBridge(activeSessionId: string) {
  const lastMobileSubmitAtRef = useRef(0);

  const triggerMobileSend = useCallback(() => {
    if (typeof window === "undefined") return false;

    const { sendButton, textarea } = getCopilotChatInputElements();
    if (!sendButton || !textarea || sendButton.disabled || textarea.value.trim().length === 0) {
      return false;
    }

    const now = Date.now();
    if (now - lastMobileSubmitAtRef.current < 700) {
      return false;
    }
    lastMobileSubmitAtRef.current = now;

    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    sendButton.click();
    textarea.focus({ preventScroll: true });
    window.scrollTo(0, 0);
    return true;
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;

    let attachedTextarea: HTMLTextAreaElement | null = null;
    let attachedButton: HTMLButtonElement | null = null;
    let detachHandlers: (() => void)[] = [];

    const isCoarsePointer = () =>
      window.matchMedia?.("(hover: none) and (pointer: coarse)").matches ?? false;

    const attach = () => {
      const { sendButton, textarea } = getCopilotChatInputElements();
      if (attachedTextarea === textarea && attachedButton === sendButton) {
        return;
      }

      detachHandlers.forEach((detach) => detach());
      detachHandlers = [];
      attachedTextarea = textarea;
      attachedButton = sendButton;

      if (!textarea || !sendButton) {
        return;
      }

      textarea.enterKeyHint = "send";
      textarea.setAttribute("enterkeyhint", "send");
      textarea.setAttribute("autocomplete", "off");
      textarea.setAttribute("autocapitalize", "sentences");

      const handleMobileSendPointer = (event: Event) => {
        if (!isCoarsePointer()) return;
        event.preventDefault();
        event.stopPropagation();
        triggerMobileSend();
      };

      sendButton.addEventListener("touchend", handleMobileSendPointer, { passive: false });
      sendButton.addEventListener("pointerup", handleMobileSendPointer);

      detachHandlers.push(
        () => sendButton.removeEventListener("touchend", handleMobileSendPointer),
        () => sendButton.removeEventListener("pointerup", handleMobileSendPointer),
      );
    };

    const attachTimer = window.setTimeout(attach, 0);
    const observer = new MutationObserver(attach);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });

    return () => {
      window.clearTimeout(attachTimer);
      observer.disconnect();
      detachHandlers.forEach((detach) => detach());
    };
  }, [activeSessionId, triggerMobileSend]);

  return { triggerMobileSend };
}

function PanelAgentBadge({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2 py-1 text-[11px] font-bold text-blue-700">
      <CpuChipIcon className="h-3.5 w-3.5" />
      {label}
    </span>
  );
}

function AppHeader({
  onCreate,
  onExport,
}: {
  onCreate: () => void;
  onExport: () => void;
}) {
  return (
    <header className="px-4 pb-3 pt-4">
      <div className="flex items-center gap-3">
        <div className="flex h-[52px] w-[52px] shrink-0 items-center justify-center rounded-2xl bg-blue-600 text-white shadow-lg shadow-blue-500/25">
          <AcademicCapIcon className="h-8 w-8" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-[22px] font-black leading-7 tracking-normal text-slate-950">
              高考志愿填报 Agent
            </h1>
            <span className="rounded-lg bg-blue-100 px-2 py-0.5 text-xs font-black text-blue-700">AI</span>
          </div>
          <p className="mt-0.5 truncate text-[13px] font-medium text-slate-500">
            院校录取趋势 · 位次匹配 · 志愿方案生成
          </p>
        </div>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3">
        <button
          type="button"
          onClick={onCreate}
          className="flex h-12 items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-white text-sm font-bold text-slate-900 shadow-sm"
        >
          <PencilSquareIcon className="h-5 w-5 text-blue-700" />
          新建方案
        </button>
        <button
          type="button"
          onClick={onExport}
          className="flex h-12 items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-white text-sm font-bold text-slate-900 shadow-sm"
        >
          <ArrowDownTrayIcon className="h-5 w-5 text-blue-700" />
          导出报告
        </button>
      </div>
    </header>
  );
}

function CandidateProfileCard({
  profile,
  completion,
  missingCount,
  missingFields,
  ignoredCount,
  isCollapsed,
  rankMeta,
  strategySummary,
  onToggleCollapsed,
  onIgnoreMissing,
  onRestoreMissing,
}: {
  profile: StudentProfile;
  completion: number;
  missingCount: number;
  missingFields: Array<keyof StudentProfile>;
  ignoredCount: number;
  isCollapsed: boolean;
  rankMeta?: RankMeta;
  strategySummary: ReturnType<typeof buildStrategySummary>;
  onToggleCollapsed: () => void;
  onIgnoreMissing: () => void;
  onRestoreMissing: () => void;
}) {
  const rankValue = formatRank(profile.rank);
  const rankLabel = profile.rank
    ? rankMeta?.source === "auto2025"
      ? `2025参考：${rankValue}`
      : `位次：${rankValue}`
    : "位次待补";

  if (isCollapsed) {
    return (
      <section className="mx-4 rounded-[22px] border border-blue-100 bg-white px-4 py-3 shadow-[0_14px_32px_rgba(15,23,42,0.07)]">
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-black leading-none text-blue-600">{formatScore(profile.score)}</span>
              <span className="text-xs font-black text-slate-500">分</span>
              <span className="truncate text-sm font-bold text-slate-700">{rankLabel}</span>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <span className="text-xs font-bold text-slate-500">完整度 {completion}%</span>
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-200">
                <div className="h-full rounded-full bg-blue-600" style={{ width: `${completion}%` }} />
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={onToggleCollapsed}
            className="h-10 shrink-0 rounded-xl border border-blue-100 bg-blue-50 px-3 text-xs font-black text-blue-700"
          >
            展开画像
          </button>
        </div>
      </section>
    );
  }

  const chips = [
    { icon: MapPinIcon, label: "省份", value: getProfileValue(profile, "province") },
    { icon: BookOpenIcon, label: "科类", value: getProfileValue(profile, "subjectTrack") },
    { icon: AcademicCapIcon, label: "升学倾向", value: getProfileValue(profile, "graduatePlan", "读研 / 保研") },
    { icon: TrophyIcon, label: "目标层次", value: profile.score && profile.score >= 620 ? "211 / 双一流" : "待判断" },
    { icon: BuildingLibraryIcon, label: "意向城市", value: getProfileValue(profile, "cityPreference") },
    { icon: CheckBadgeIcon, label: "当前状态", value: missingCount ? "待补全关键信息" : "可生成方案", danger: missingCount > 0 },
  ];
  const missingByKey = new Map(PROFILE_FIELDS.map((field) => [field.key, field]));
  const icons: Partial<Record<keyof StudentProfile, typeof BookOpenIcon>> = {
    rank: TrophyIcon,
    subjectTrack: BookOpenIcon,
    budget: WalletIcon,
    canLeaveProvince: RocketLaunchIcon,
    majorPreference: StarIcon,
    cityPreference: MapPinIcon,
    graduatePlan: AcademicCapIcon,
  };
  const strategyCards = [
    { title: "冲刺方案", subtitle: "冲高目标院校", icon: RocketLaunchIcon, tone: "bg-red-50 text-red-600" },
    { title: "稳妥方案", subtitle: "匹配稳妥院校", icon: ShieldCheckIcon, tone: "bg-blue-50 text-blue-700" },
    { title: "保底方案", subtitle: "确保录取院校", icon: StarIcon, tone: "bg-emerald-50 text-emerald-600" },
  ];
  const strategyBody =
    strategySummary?.body ||
    "当前画像仍在收集中，建议先补齐关键项；也可以忽略待补信息，直接生成一版初步意见摘要。";

  return (
    <section className="mx-4 rounded-[22px] border border-blue-100 bg-white p-4 shadow-[0_18px_45px_rgba(15,23,42,0.08)]">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h2 className="text-[19px] font-black text-slate-950">考生画像</h2>
          <ShieldCheckIcon className="h-5 w-5 text-blue-600" />
        </div>
        <div className="flex items-center gap-2">
          <PanelAgentBadge label="画像子 agent" />
          <button
            type="button"
            onClick={onToggleCollapsed}
            className="rounded-xl border border-blue-100 bg-blue-50 px-2.5 py-1.5 text-xs font-black text-blue-700"
          >
            折叠
          </button>
        </div>
      </div>
      <div className="mt-3 flex items-center gap-3">
        <span className="text-sm font-semibold text-slate-500">信息完整度</span>
        <span className="text-sm font-black text-blue-700">{completion}%</span>
        <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-200">
          <div className="h-full rounded-full bg-blue-600" style={{ width: `${completion}%` }} />
        </div>
      </div>
      <div className="mt-5 grid grid-cols-[1fr_auto] items-end gap-3">
        <div>
          <p className="text-[54px] font-black leading-none text-blue-600">{formatScore(profile.score)}</p>
          <p className="mt-1 text-sm font-bold text-slate-950">
            {profile.score ? "分" : "分数待补"}
            <span className="ml-2 text-slate-400">/ 750</span>
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <span className="rounded-xl bg-blue-50 px-3 py-1.5 text-sm font-black text-blue-700">
            {getProfileValue(profile, "province", "省份待补")}考生
          </span>
          <span
            className={`rounded-xl px-3 py-1.5 text-sm font-black ${
              profile.rank ? "bg-blue-50 text-blue-700" : "bg-red-50 text-red-600"
            }`}
          >
            {rankLabel}
          </span>
        </div>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-x-3 gap-y-3 rounded-2xl border border-blue-50 bg-white/80 p-3">
        {chips.map((chip) => {
          const IconComponent = chip.icon;
          return (
            <div key={chip.label} className="grid grid-cols-[20px_1fr] gap-2">
              <IconComponent className="mt-0.5 h-4 w-4 text-slate-500" />
              <div className="min-w-0">
                <p className="text-xs font-semibold text-slate-500">{chip.label}</p>
                <p className={`truncate text-sm font-black ${chip.danger ? "text-red-600" : "text-slate-950"}`}>
                  {chip.value}
                </p>
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-4 border-t border-blue-50 pt-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <p className="text-sm font-black text-slate-950">待补信息</p>
          <span className="text-xs font-black text-blue-700">
            {missingFields.length ? `${missingFields.length} 项待补充` : ignoredCount ? `已忽略 ${ignoredCount} 项` : "关键项已补齐"}
          </span>
        </div>
        <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
          {missingFields.length ? (
            missingFields.map((key, index) => {
              const field = missingByKey.get(key);
              if (!field) return null;
              const IconComponent = icons[key] ?? AdjustmentsHorizontalIcon;
              return (
                <button
                  key={field.key}
                  type="button"
                  onClick={() => insertPrompt(field.question)}
                  className={`flex h-9 min-w-max shrink-0 items-center gap-1.5 whitespace-nowrap rounded-xl border px-3.5 text-left ${
                    index === 0
                      ? "border-red-200 bg-red-50 text-red-600"
                      : "border-blue-100 bg-blue-50/70 text-slate-700"
                  }`}
                >
                  <IconComponent className="h-4 w-4 shrink-0" />
                  <span className="text-xs font-black leading-none">{field.label}</span>
                </button>
              );
            })
          ) : (
            <span className="h-9 shrink-0 rounded-xl bg-emerald-50 px-3.5 py-2.5 text-xs font-bold leading-none text-emerald-700">
              {ignoredCount ? "待补信息已忽略，按已知画像分析" : "关键画像已补齐"}
            </span>
          )}
        </div>
      </div>
      <div className="mt-4 border-t border-blue-50 pt-4">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-[17px] font-black text-slate-950">当前策略摘要</h3>
          <PanelAgentBadge label="策略子 agent" />
        </div>
        <p className="mt-3 text-sm leading-6 text-slate-600">{strategyBody}</p>
        <div className="mt-4 grid grid-cols-3 gap-3">
          {strategyCards.map((card) => {
            const IconComponent = card.icon;
            return (
              <button
                key={card.title}
                type="button"
                onClick={() => insertPrompt(`请生成我的${card.title}，并说明依据。`)}
                className={`rounded-xl px-2 py-4 text-center ${card.tone}`}
              >
                <IconComponent className="mx-auto h-7 w-7" />
                <p className="mt-2 text-sm font-black">{card.title}</p>
                <p className="mt-0.5 text-xs font-semibold text-slate-600">{card.subtitle}</p>
              </button>
            );
          })}
        </div>
        <div className="mt-3 grid gap-2">
          {missingFields.length ? (
            <button
              type="button"
              onClick={onIgnoreMissing}
              className="flex h-11 w-full items-center justify-center rounded-xl border border-slate-200 bg-slate-950 px-3 text-sm font-black text-white shadow-sm"
            >
              忽略待补信息，直接给意见摘要
            </button>
          ) : null}
          {ignoredCount ? (
            <button
              type="button"
              onClick={onRestoreMissing}
              className="flex h-10 w-full items-center justify-center rounded-xl border border-blue-100 bg-blue-50 px-3 text-sm font-black text-blue-700"
            >
              恢复待补信息
            </button>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function StrategySummaryCard({
  summary,
}: {
  summary: ReturnType<typeof buildStrategySummary>;
}) {
  const cards = [
    { title: "冲刺方案", subtitle: "冲高目标院校", icon: RocketLaunchIcon, tone: "bg-red-50 text-red-600" },
    { title: "稳妥方案", subtitle: "匹配稳妥院校", icon: ShieldCheckIcon, tone: "bg-blue-50 text-blue-700" },
    { title: "保底方案", subtitle: "确保录取院校", icon: StarIcon, tone: "bg-emerald-50 text-emerald-600" },
  ];

  return (
    <section className="mx-4 rounded-[22px] border border-slate-200 bg-white p-4 shadow-[0_14px_36px_rgba(15,23,42,0.06)]">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[19px] font-black text-slate-950">当前策略摘要</h2>
        <PanelAgentBadge label="策略子 agent" />
      </div>
      <p className="mt-3 text-sm leading-6 text-slate-600">{summary.body}</p>
      <div className="mt-4 grid grid-cols-3 gap-3">
        {cards.map((card) => {
          const IconComponent = card.icon;
          return (
            <button
              key={card.title}
              type="button"
              onClick={() => insertPrompt(`请生成我的${card.title}，并说明依据。`)}
              className={`rounded-xl px-2 py-4 text-center ${card.tone}`}
            >
              <IconComponent className="mx-auto h-7 w-7" />
              <p className="mt-2 text-sm font-black">{card.title}</p>
              <p className="mt-0.5 text-xs font-semibold text-slate-600">{card.subtitle}</p>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function PromptSuggestions({ suggestions }: { suggestions: string[] }) {
  const items = suggestions.length ? suggestions : FALLBACK_SUGGESTIONS;

  return (
    <div className="gaokao-floating-suggestions" aria-label="你可能想问">
      <div className="flex gap-2 overflow-x-auto px-3 py-2">
        {items.slice(0, 7).map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            onClick={() => insertPrompt(suggestion)}
            className="shrink-0 rounded-xl border border-blue-100 bg-blue-50 px-3.5 py-2 text-sm font-bold text-slate-700"
          >
            {suggestion}
          </button>
        ))}
      </div>
    </div>
  );
}

function AgentConversationPanel({
  activeSessionId,
  activeSuggestions,
  toolsMenu,
}: {
  activeSessionId: string;
  activeSuggestions: string[];
  toolsMenu: (ToolsMenuItem | "-")[];
}) {
  return (
    <section className="gaokao-chat-layer mx-4">
      <div className="gaokao-visible-chat-wrap">
        <CopilotChat
          agentId="default"
          className="gaokao-chat gaokao-visible-chat h-full"
          threadId={activeSessionId}
          key={activeSessionId}
          labels={{
            chatInputPlaceholder: activeSuggestions[0] || "直接问：海南高考 680 分能去什么学校？",
            chatDisclaimerText: "重要志愿决策请以省考试院和院校官方数据为准。",
            welcomeMessageText:
              "我是志愿填报 agent，会先聊清楚省份、科类、分数、位次和家庭约束。问分数线时我会先查官方数据，再用图表说话。",
            modalHeaderTitle: "高考志愿填报 Agent",
          }}
          input={{
            showDisclaimer: true,
            autoFocus: false,
            toolsMenu,
          }}
          welcomeScreen={{
            className: "px-4",
          }}
        />
      </div>
    </section>
  );
}

function TextComposerDock({ onSubmit }: { onSubmit: (prompt: string) => void }) {
  const [draft, setDraft] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const dockRef = useRef<HTMLDivElement | null>(null);

  const resizeTextarea = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "44px";
    textarea.style.height = `${Math.min(112, Math.max(44, textarea.scrollHeight))}px`;
    window.requestAnimationFrame(() => {
      const height = dockRef.current?.getBoundingClientRect().height ?? 88;
      document.documentElement.style.setProperty("--gaokao-composer-height", `${Math.ceil(height)}px`);
    });
  }, []);

  useEffect(() => {
    const handleDraft = (event: Event) => {
      const customEvent = event as CustomEvent<string | { mode?: string; value?: string }>;
      const detail = customEvent.detail;
      if (typeof detail === "object" && detail?.mode === "append") {
        const value = detail.value?.trim();
        if (!value) return;
        setDraft((current) => {
          const existing = current.trim();
          const parts = existing.split("；").map((item) => item.trim()).filter(Boolean);
          if (parts.includes(value)) return current;
          const next = existing ? `${existing}；${value}` : value;
          syncHiddenCopilotPrompt(next);
          return next;
        });
        textareaRef.current?.focus({ preventScroll: true });
        return;
      }
      if (typeof detail === "object" && detail?.mode === "remove") {
        const value = detail.value?.trim();
        if (!value) return;
        setDraft((current) => {
          const next = current
            .split("；")
            .map((item) => item.trim())
            .filter((item) => item && item !== value)
            .join("；");
          syncHiddenCopilotPrompt(next);
          return next;
        });
        textareaRef.current?.focus({ preventScroll: true });
        return;
      }
      setDraft(typeof detail === "string" ? detail : "");
    };
    window.addEventListener(COMPOSER_DRAFT_EVENT, handleDraft);
    return () => window.removeEventListener(COMPOSER_DRAFT_EVENT, handleDraft);
  }, []);

  useEffect(() => {
    resizeTextarea();
  }, [draft, resizeTextarea]);

  const submitDraft = useCallback(() => {
    const prompt = draft.trim();
    if (!prompt) return;
    onSubmit(prompt);
    setDraft("");
  }, [draft, onSubmit]);

  return (
    <div ref={dockRef} className="gaokao-text-composer">
      <div className="flex items-center gap-3 rounded-[22px] bg-white p-3 shadow-[0_20px_45px_rgba(15,23,42,0.12)] ring-1 ring-slate-200">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-blue-50 text-blue-700">
          <CpuChipIcon className="h-6 w-6" />
        </div>
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            syncHiddenCopilotPrompt(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submitDraft();
            }
          }}
          rows={1}
          className="max-h-28 min-h-11 flex-1 resize-none overflow-y-auto rounded-2xl border border-slate-200 bg-white px-4 py-3 text-base leading-5 text-slate-900 outline-none placeholder:text-slate-400 focus:border-blue-300 focus:ring-2 focus:ring-blue-100"
          placeholder="输入你的位次、目标专业、预算或出省意愿..."
        />
        <button
          type="button"
          onClick={submitDraft}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-blue-600 text-white shadow-lg shadow-blue-500/25 disabled:bg-slate-300 disabled:shadow-none"
          disabled={!draft.trim()}
          aria-label="发送"
        >
          <PaperAirplaneIcon className="h-5 w-5" />
        </button>
      </div>
    </div>
  );
}

function usePanelAgentContexts({
  activeSessionId,
  profile,
  toolRoute,
  missingFields,
  ignoredFields,
  rankMeta,
  summary,
  suggestions,
}: {
  activeSessionId: string;
  profile: StudentProfile;
  toolRoute?: RouterDecision;
  missingFields: Array<keyof StudentProfile>;
  ignoredFields: Array<keyof StudentProfile>;
  rankMeta?: RankMeta;
  summary: ReturnType<typeof buildStrategySummary>;
  suggestions: string[];
}) {
  const compactProfile = {
    province: profile.province,
    year: profile.year,
    subjectTrack: profile.subjectTrack,
    score: profile.score,
    rank: profile.rank,
    familyBudget: profile.familyBudget ?? profile.budget,
    targetCities: profile.targetCities ?? (profile.cityPreference ? [profile.cityPreference] : undefined),
    cityPreference: profile.cityPreference,
    preferredMajors: profile.preferredMajors ?? profile.majorPreference?.slice(0, 4),
    riskPreference: profile.riskPreference,
    acceptPrivate: profile.acceptPrivate,
    acceptSinoForeign: profile.acceptSinoForeign,
    canLeaveProvince: profile.canLeaveProvince,
    graduatePlan: profile.graduatePlan,
    majorPreference: profile.majorPreference?.slice(0, 4),
    avoidMajors: profile.avoidMajors?.slice(0, 4),
  };
  useAgentContext({
    description: "高考画像短上下文",
    value:
      `thread=${activeSessionId}; profile=${JSON.stringify(compactProfile)}; ` +
      `missing=${missingFields.slice(0, 6).join(",") || "none"}; ignored=${ignoredFields.join(",") || "none"}; ` +
      `rankMeta=${rankMeta ? JSON.stringify(rankMeta) : "none"}; risk=${summary.risk}; ` +
      `next=${suggestions.slice(0, 4).join("；") || "none"}; ` +
      `toolRoute=${toolRoute ? buildAgentRouterContext(toolRoute) : "none"}; ` +
      "规则：当前画像优先于历史聊天；省份=投档省份，城市=就读偏好；自动位次按rankMeta年份或2025参考。",
  });
}

function useCompactAdmissionScoreToolGroups(activeSessionId: string) {
  useEffect(() => {
    if (typeof document === "undefined") return;

    let frame = 0;
    let suppressObserver = false;

    // 定义所有需要被分组的工具类型
    const PROCESS_TOOL_TYPES = [
      "lookupAdmissionScores",      // 分数线查询
      "lookupRankByScore",          // 位次查询
      "researchGaokaoData",         // 联网检索
      "compareSchools",             // 院校对比
      "buildVolunteerPlan",         // 冲稳保方案
      "explainAdmissionRisk",       // 风险解释
    ];

    const compact = () => {
      suppressObserver = true;
      const assistantMessages = Array.from(document.querySelectorAll<HTMLElement>(".copilotKitAssistantMessage"));

      assistantMessages.forEach((message) => {
        // 收集所有需要分组的 tool details（包括已存在的分组和原始节点）
        const allProcessDetails = Array.from(
          message.querySelectorAll<HTMLDetailsElement>('details[data-gaokao-process-kind="agent-thinking"]'),
        );

        // 少于 2 个不需要分组，但需要确保它们都是折叠状态（非运行中）
        if (allProcessDetails.length < 2) {
          allProcessDetails.forEach((detail) => {
            // 跳过已经是分组面板的节点
            if (detail.classList.contains('gaokao-tool-process-group')) return;
            
            const isRunning = detail.dataset.gaokaoRunning === "true";
            detail.open = isRunning; // 只有运行中的才展开
            detail.style.display = ""; // 恢复显示
          });
          return;
        }

        // 检查是否有正在运行的工具调用
        const runningDetail = allProcessDetails.find((detail) => detail.dataset.gaokaoRunning === "true");
        const anchorDetail = runningDetail ?? allProcessDetails[0];
        
        // 统计各类型的数量
        const typeCounts: Record<string, number> = {};
        allProcessDetails.forEach(detail => {
          const type = detail.dataset.gaokaoToolType || 'unknown';
          typeCounts[type] = (typeCounts[type] || 0) + 1;
        });
        
        // 构建标题文本
        const typeLabels: Record<string, string> = {
          lookupAdmissionScores: "分数线查询",
          lookupRankByScore: "位次查询",
          researchGaokaoData: "联网检索",
          compareSchools: "院校对比",
          buildVolunteerPlan: "冲稳保方案",
          explainAdmissionRisk: "风险解释",
        };
        
        const titleParts = Object.entries(typeCounts)
          .filter(([_, count]) => count > 0)
          .map(([type, count]) => `${typeLabels[type] || type}${count > 1 ? `×${count}` : ''}`)
          .join("、");
        
        const groupTitle = runningDetail
          ? `思考中 · ${titleParts}`
          : `思考过程 · ${titleParts}`;
        
        // 创建或复用分组面板
        let group = message.querySelector<HTMLDetailsElement>(".gaokao-tool-process-group");
        if (!group) {
          group = document.createElement("details");
          group.className = "gaokao-tool-process-group my-2 px-3 text-xs";
          // 只有在有运行中的工具时才展开分组，完成后自动折叠
          if (runningDetail) group.open = true;
          
          const summary = document.createElement("summary");
          summary.className = "flex cursor-pointer list-none items-center gap-2 rounded-xl bg-white/50 px-3 py-2 font-medium text-zinc-600 ring-1 ring-zinc-200/80 hover:bg-white/70 transition-colors";
          
          const icon = document.createElement("span");
          icon.className = "flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-50 text-blue-500 ring-1 ring-blue-200";
          icon.innerHTML = `<svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v4m0 12v4M4.93 4.93l2.83 2.83m8.48 8.48l2.83 2.83M2 12h4m12 0h4M4.93 19.07l2.83-2.83m8.48-8.48l2.83-2.83"/></svg>`;
          
          const title = document.createElement("span");
          title.className = "min-w-0 flex-1 truncate";
          title.dataset.gaokaoGroupTitle = "true";
          title.textContent = groupTitle;
          
          const badge = document.createElement("span");
          badge.dataset.gaokaoGroupBadge = "true";
          badge.className = runningDetail
            ? "shrink-0 rounded border border-red-100 bg-red-50 px-1.5 py-0.5 text-[11px] text-red-700"
            : "shrink-0 rounded border border-emerald-100 bg-emerald-50 px-1.5 py-0.5 text-[11px] text-emerald-700";
          badge.textContent = runningDetail ? "进行中" : "已完成";
          
          summary.append(icon, title, badge);
          
          const body = document.createElement("div");
          body.className = "ml-7 grid max-h-96 gap-2 overflow-y-auto border-l border-zinc-200/50 px-3 py-1.5";
          
          group.append(summary, body);
          anchorDetail.parentElement?.insertBefore(group, allProcessDetails[0]);
        } else {
          // 更新现有分组的标题和状态
          const summary = group.querySelector("summary");
          if (summary) {
            const titleEl = summary.querySelector<HTMLElement>("[data-gaokao-group-title]");
            if (titleEl) titleEl.textContent = groupTitle;
            
            const badgeEl = summary.querySelector<HTMLElement>("[data-gaokao-group-badge]");
            if (badgeEl) {
              badgeEl.textContent = runningDetail ? "进行中" : "已完成";
              badgeEl.className = runningDetail
                ? "shrink-0 rounded border border-red-100 bg-red-50 px-1.5 py-0.5 text-[11px] text-red-700"
                : "shrink-0 rounded border border-emerald-100 bg-emerald-50 px-1.5 py-0.5 text-[11px] text-emerald-700";
            }
          }
          
          // 更新展开状态
          if (runningDetail && !group.open) {
            group.open = true;
          } else if (!runningDetail && group.open) {
            // 只有在用户没有手动展开的情况下才自动折叠
            // 这里简化处理：完成后始终折叠
            group.open = false;
          }
        }
        
        // 更新分组内容
        const body = group.querySelector("div.ml-7");
        if (body) {
          // 清空旧内容
          body.innerHTML = "";
          
          // 添加每个工具调用的子项
          allProcessDetails.forEach((detail, index) => {
            // 跳过分组面板本身
            if (detail.classList.contains('gaokao-tool-process-group')) return;
            
            const toolType = detail.dataset.gaokaoToolType || 'unknown';
            const school = detail.dataset.gaokaoSchool;
            const isRunning = detail.dataset.gaokaoRunning === "true";
            
            const item = document.createElement("details");
            item.className = "rounded-lg bg-white/50 px-2 py-1.5 ring-1 ring-zinc-200/50";
            item.open = isRunning;
            
            const itemSummary = document.createElement("summary");
            itemSummary.className = "cursor-pointer list-none text-[11px] font-black text-zinc-700";
            
            let label = typeLabels[toolType] || toolType;
            if (school) {
              label = isRunning ? `查询${school}中` : `已查询${school}`;
            } else {
              label = isRunning ? `${label}中` : label;
            }
            itemSummary.textContent = label;
            
            const content = detail.querySelector<HTMLElement>(":scope > div");
            item.append(itemSummary);
            if (content) item.append(content.cloneNode(true));
            body.append(item);
          });
        }
        
        // 隐藏所有原始的 tool details，只显示分组面板
        allProcessDetails.forEach((detail) => {
          // 跳过分组面板本身
          if (detail.classList.contains('gaokao-tool-process-group')) return;
          
          detail.style.display = "none";
          detail.style.visibility = "hidden";
          detail.style.height = "0";
          detail.style.overflow = "hidden";
          detail.style.margin = "0";
          detail.style.padding = "0";
        });
      });

      window.setTimeout(() => {
        suppressObserver = false;
      }, 0);
    };

    const scheduleCompact = (mutations?: MutationRecord[]) => {
      if (suppressObserver) return;
      
      // 如果是属性变化（如 data-gaokao-running），用短延迟合并批量状态更新
      const hasAttributeChange = mutations?.some(m => m.type === 'attributes');
      
      if (hasAttributeChange) {
        if (frame) window.cancelAnimationFrame(frame);
        frame = window.requestAnimationFrame(compact);
      } else {
        // DOM 结构变化使用 RAF 防抖
        if (frame) window.cancelAnimationFrame(frame);
        frame = window.requestAnimationFrame(compact);
      }
    };

    compact();
    const observer = new MutationObserver(scheduleCompact);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true, // 监听属性变化（如 data-gaokao-running 从 true 变为 false）
      attributeFilter: ["data-gaokao-running"], // 只关注工具运行状态，避免 open 自触发
    });

    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [activeSessionId]);
}

function AdvisorChatSurface() {
  useMobileVisualViewport();
  const { copilotkit } = useCopilotKit();
  const { agent } = useAgent({ agentId: "default" });
  const dashboardScrollRef = useRef<HTMLElement | null>(null);

  const {
    activeSessionId,
    autoRenameSessionFromPrompt,
    createNewSession,
  } = useLocalSessions();
  useCompactAdmissionScoreToolGroups(activeSessionId);
  const { activeProfile, updateProfileFromPatch } = useLocalProfiles(activeSessionId);
  const {
    activeSessionSummary,
    activeTurnContext,
    activeSuggestions,
    upsertTurnContext,
    upsertSuggestions,
  } = useSessionInsights(activeSessionId);
  const {
    activeIgnoredFields,
    activeProfilePanelCollapsed,
    activeRankMeta,
    clearIgnoredFields,
    clearRankMeta,
    setIgnoredFields,
    setProfilePanelCollapsed,
    upsertRankMeta,
  } = useSessionUiState(activeSessionId);
  const rankHydrationKeyRef = useRef("");
  const manuallySubmittedPromptRef = useRef<{ prompt: string; submittedAt: number } | null>(null);
  const submittingPromptRef = useRef(false);
  const hydrateRankForTurnContext = useCallback(
    (sessionId: string, turnContext: TurnContext, lastAssistantText: string) => {
      if (!canAutoHydrateRank(turnContext.profileAfterTurn)) return;
      void requestRankHydration(turnContext.profileAfterTurn)
        .then((rankResult) => {
          if (!rankResult) return;
          const nextTurnContext = mergeRankHydrationIntoTurnContext(
            turnContext,
            rankResult,
            lastAssistantText,
          );
          updateProfileFromPatch(sessionId, {
            rank: rankResult.rank,
            subjectTrack: turnContext.profileAfterTurn.subjectTrack || rankResult.subjectTrack,
            updatedAt: nextTurnContext.updatedAt,
          });
          upsertRankMeta(sessionId, {
            year: rankResult.year ?? 2025,
            source: "auto2025",
            matchedScore: rankResult.matchedScore,
            note: rankResult.rankSourceLabel ?? "2025一分一段参考",
            sourceTitle: rankResult.source?.title,
          });
          upsertTurnContext(sessionId, nextTurnContext);
        })
        .catch(() => undefined);
    },
    [updateProfileFromPatch, upsertRankMeta, upsertTurnContext],
  );
  const handlePromptSubmitted = useCallback(
    (sessionId: string, prompt: string) => {
      const lastAssistantText = readLastAssistantText();
      const localTurnContext = buildLocalTurnContext({
        prompt,
        profile: activeProfile,
        previousSummary: activeSessionSummary,
        lastAssistantText,
      });
      const scoreChanged =
        typeof localTurnContext.profilePatch.score === "number" &&
        localTurnContext.profilePatch.score !== activeProfile.score &&
        typeof localTurnContext.profilePatch.rank !== "number";
      if (scoreChanged) {
        localTurnContext.profilePatch = { ...localTurnContext.profilePatch, rank: undefined };
        localTurnContext.profileAfterTurn = { ...localTurnContext.profileAfterTurn, rank: undefined };
        localTurnContext.toolRoute = routeAgentTurn({
          userMessage: prompt,
          profile: localTurnContext.profileAfterTurn as AgentStudentProfile,
        });
        clearRankMeta(sessionId);
      }
      if (typeof localTurnContext.profilePatch.rank === "number") {
        upsertRankMeta(sessionId, {
          year: 2025,
          source: "user",
          note: "用户提供位次，择校时对比2025投档/录取数据",
        });
      }
      autoRenameSessionFromPrompt(sessionId, prompt);
      updateProfileFromPatch(sessionId, localTurnContext.profilePatch);
      upsertTurnContext(sessionId, localTurnContext);
      hydrateRankForTurnContext(sessionId, localTurnContext, lastAssistantText);

      if (shouldUseRemotePreprocess(prompt)) {
        void requestRemotePreprocess({
          threadId: sessionId,
          rawPrompt: prompt,
          profile: mergeProfile(activeProfile, localTurnContext.profilePatch),
          previousSummary: activeSessionSummary,
          lastAssistantText,
        })
          .then((remote) => {
            const mergedTurnContext = mergeRemoteTurnContext(localTurnContext, remote, activeProfile);
            const remoteScoreChanged =
              typeof mergedTurnContext.profilePatch.score === "number" &&
              mergedTurnContext.profilePatch.score !== activeProfile.score &&
              typeof mergedTurnContext.profilePatch.rank !== "number";
            if (remoteScoreChanged) {
              mergedTurnContext.profilePatch = { ...mergedTurnContext.profilePatch, rank: undefined };
              mergedTurnContext.profileAfterTurn = { ...mergedTurnContext.profileAfterTurn, rank: undefined };
              mergedTurnContext.toolRoute = routeAgentTurn({
                userMessage: prompt,
                profile: mergedTurnContext.profileAfterTurn as AgentStudentProfile,
              });
              clearRankMeta(sessionId);
            }
            if (typeof mergedTurnContext.profilePatch.rank === "number") {
              upsertRankMeta(sessionId, {
                year: 2025,
                source: "user",
                note: "用户提供位次，择校时对比2025投档/录取数据",
              });
            }
            updateProfileFromPatch(sessionId, mergedTurnContext.profilePatch);
            upsertTurnContext(sessionId, mergedTurnContext);
            hydrateRankForTurnContext(sessionId, mergedTurnContext, lastAssistantText);
          })
          .catch(() => {
            upsertTurnContext(sessionId, {
              ...localTurnContext,
              ambiguityWarnings: uniqueTextItems([
                ...localTurnContext.ambiguityWarnings,
                "远程预处理暂不可用，已使用本地规则画像。",
              ]),
            });
          });
      }
    },
    [
      activeProfile,
      activeSessionSummary,
      autoRenameSessionFromPrompt,
      clearRankMeta,
      hydrateRankForTurnContext,
      updateProfileFromPatch,
      upsertRankMeta,
      upsertTurnContext,
    ],
  );
  useAutoSessionTitle(activeSessionId, handlePromptSubmitted, manuallySubmittedPromptRef);
  const authoritativeProfile = withDerivedProfile(activeTurnContext?.profileAfterTurn ?? activeProfile);
  const missingFields = prioritizeMissingFields(
    authoritativeProfile,
    "",
    activeTurnContext?.missingPriority,
    activeIgnoredFields,
  ).slice(0, 8);
  const completion = profileCompletion(authoritativeProfile, activeIgnoredFields);
  const strategySummary = buildStrategySummary(authoritativeProfile, missingFields, activeIgnoredFields);
  const ignoredSuggestions = new Set(
    activeIgnoredFields.flatMap((key) => SUGGESTION_TEMPLATE_BY_FIELD[key] ?? []),
  );
  const dashboardSuggestions = uniqueTextItems(
    [...activeSuggestions, ...FALLBACK_SUGGESTIONS].filter((item) => !ignoredSuggestions.has(item)),
  ).slice(0, 7);
  const handleSubmitPrompt = useCallback(async (prompt: string) => {
    if (submittingPromptRef.current) return;
    submittingPromptRef.current = true;
    manuallySubmittedPromptRef.current = { prompt, submittedAt: Date.now() };
    handlePromptSubmitted(activeSessionId, prompt);
    try {
      const runtimeAgent = await waitForRuntimeAgent(copilotkit, agent);
      if ((runtimeAgent as { isRunning?: boolean }).isRunning) return;
      runtimeAgent.addMessage({
        id:
          typeof crypto !== "undefined" && "randomUUID" in crypto
            ? crypto.randomUUID()
            : `user-${Date.now()}`,
        role: "user",
        content: prompt,
      });
      copilotkit.clearSuggestions("default");
      await copilotkit.runAgent({ agent: runtimeAgent });
    } catch (error) {
      console.error("[Gaokao Advisor] failed to submit prompt", error);
    } finally {
      submittingPromptRef.current = false;
    }
    window.setTimeout(() => {
      dashboardScrollRef.current?.scrollTo({
        top: dashboardScrollRef.current.scrollHeight,
        behavior: "smooth",
      });
    }, 120);
  }, [activeSessionId, agent, copilotkit, handlePromptSubmitted]);

  useAssistantSuggestionRefresh({
    activeSessionId,
    profile: authoritativeProfile,
    missingPriority: activeTurnContext?.missingPriority,
    ignoredFields: activeIgnoredFields,
    upsertSuggestions,
  });
  useInlineFollowUpOptions({
    activeSessionId,
    profile: authoritativeProfile,
    ignoredFields: activeIgnoredFields,
    onSelect: appendPromptToComposer,
    onDeselect: removePromptFromComposer,
  });

  useEffect(() => {
    const hydrationKey = [
      activeSessionId,
      authoritativeProfile.province ?? "",
      normalizeRankHydrationSubject(authoritativeProfile),
      authoritativeProfile.score ?? "",
      authoritativeProfile.rank ?? "",
    ].join(":");

    if (!canAutoHydrateRank(authoritativeProfile) || rankHydrationKeyRef.current === hydrationKey) return;
    rankHydrationKeyRef.current = hydrationKey;

    void requestRankHydration(authoritativeProfile)
      .then((rankResult) => {
        if (!rankResult) return;
        const baseTurnContext =
          activeTurnContext ??
          buildLocalTurnContext({
            prompt: "",
            profile: authoritativeProfile,
            previousSummary: activeSessionSummary,
            lastAssistantText: readLastAssistantText(),
          });
        const nextTurnContext = mergeRankHydrationIntoTurnContext(
          baseTurnContext,
          rankResult,
          readLastAssistantText(),
        );
        updateProfileFromPatch(activeSessionId, {
          rank: rankResult.rank,
          subjectTrack: authoritativeProfile.subjectTrack || rankResult.subjectTrack,
          updatedAt: nextTurnContext.updatedAt,
        });
        upsertRankMeta(activeSessionId, {
          year: rankResult.year ?? 2025,
          source: "auto2025",
          matchedScore: rankResult.matchedScore,
          note: rankResult.rankSourceLabel ?? "2025一分一段参考",
          sourceTitle: rankResult.source?.title,
        });
        upsertTurnContext(activeSessionId, nextTurnContext);
      })
      .catch(() => undefined);
  }, [
    activeSessionId,
    activeSessionSummary,
    activeTurnContext,
    authoritativeProfile.province,
    authoritativeProfile.rank,
    authoritativeProfile.score,
    authoritativeProfile.subjectTrack,
    updateProfileFromPatch,
    upsertRankMeta,
    upsertTurnContext,
  ]);

  useAgentContext({
    description: "会话边界与全局规则",
    value:
      `thread=${activeSessionId}; ${GAOKAO_STAGE_CONTEXT}` +
      "当前画像优先于历史聊天；高考省份=投档省份，目标城市=就读偏好。" +
      `rankMeta=${activeRankMeta ? JSON.stringify(activeRankMeta) : "none"}; ` +
      `ignoredMissingFields=${activeIgnoredFields.join(",") || "none"}; ` +
      `router=${activeTurnContext?.toolRoute ? buildAgentRouterContext(activeTurnContext.toolRoute) : "none"}; ` +
      "位次按rankMeta年份或2025参考口径与投档/录取数据对比；回答尽量短，关键内容交给受控UI。",
  });
  usePanelAgentContexts({
    activeSessionId,
    profile: authoritativeProfile,
    toolRoute: activeTurnContext?.toolRoute,
    missingFields,
    ignoredFields: activeIgnoredFields,
    rankMeta: activeRankMeta,
    summary: strategySummary,
    suggestions: dashboardSuggestions,
  });

  useComponent({
    name: "studentProfileSummary",
    description: "展示当前考生画像、缺失字段和下一步追问。适合在规划类问题追问前或补齐画像后使用。",
    parameters: studentProfileSummarySchema,
    render: StudentProfileSummary,
    followUp: true,
  });

  useComponent({
    name: "followUpQuestionOptions",
    description:
      "展示需要用户补充的问题和可点击选项。凡是追问省份、科类、分数、位次、预算、城市、出省、读研、专业偏好时，优先调用本组件；用户可多选，选项会填入输入框，最后由用户点击发送。",
    parameters: followUpQuestionOptionsSchema,
    render: (args) => (
      <FollowUpQuestionOptions
        {...args}
        onSelect={appendPromptToComposer}
        onDeselect={removePromptFromComposer}
      />
    ),
    followUp: true,
  });

  useComponent({
    name: "scoreLineTrendChart",
    description:
      "在聊天中展示院校分数线趋势或专业组对比。用户问分数线、录取线、投档线、近三年、趋势、走势、历年或具体分数时，若能查到年份、分数和来源，就应主动渲染本组件，不必等待用户说画图。支持普通类、艺术类、美术类和综合分；数据可来自官方来源、可核验第三方聚合来源或用户明确提供的数据；第三方数据必须在 sources/warnings 中标注，不能用猜测数据绘图。",
    parameters: scoreLineTrendChartSchema,
    render: ScoreLineTrendChart,
    followUp: true,
  });

  useComponent({
    name: "volunteerPlanCards",
    description: "展示高考志愿冲稳保分层方案。卡片必须基于画像、分数线证据或明确说明缺口，不输出表格。",
    parameters: volunteerPlanCardsSchema,
    render: VolunteerPlanCards,
    followUp: true,
  });

  useComponent({
    name: "admissionRiskCards",
    description: "展示普通家庭或特定考生的专业/院校风险：不建议碰、谨慎、可考虑。",
    parameters: admissionRiskCardsSchema,
    render: AdmissionRiskCards,
    followUp: true,
  });

  useComponent({
    name: "schoolComparisonCard",
    description: "对比 2-3 所学校的分数风险、城市价值、专业适配、就业路径和家庭适配。",
    parameters: schoolComparisonCardSchema,
    render: SchoolComparisonCard,
    followUp: true,
  });

  useComponent({
    name: "genericComparisonCard",
    description: "通用对比卡片。用于专业/城市/职业路径对比。每项短句，不要长段。",
    parameters: z.object({
      title: z.string().max(40).describe("对比主题，例如：计算机 vs 软件工程 vs 人工智能"),
      items: z.array(
        z.object({
          name: z.string().max(20).describe("对比项名称，如'计算机科学与技术'"),
          icon: z.string().max(4).optional().describe("图标（可选）"),
          dimensions: z.array(
            z.object({
              label: z.string().max(8).describe("维度名称，如'学习内容'"),
              value: z.string().max(90).describe("该维度的短句值，不要长段"),
            })
          ).min(3).max(5).describe("每项 3-5 个短维度，不允许空维度"),
          verdict: z.string().max(80).describe("一句话结论，必须给出"),
        })
      ).min(2).max(4).describe("对比项列表；最多 4 项，禁止空卡片"),
      summary: z.string().max(120).optional().describe("一句总结"),
      sources: z.array(cardSourceSchema).optional(),
      warnings: z.array(z.string()).optional(),
    }),
    render: GenericComparisonCard,
    followUp: true,
  });

  const toolsMenu = useMemo<(ToolsMenuItem | "-")[]>(
    () => [
      {
        label: "查 2025 苏州大学江苏物理类",
        action: () =>
          insertPrompt("2025 苏州大学江苏物理类分数线是什么？请先查官方数据，再画图。"),
      },
      {
        label: "看苏州大学近三年趋势",
        action: () => insertPrompt("苏州大学近三年江苏物理类最低门槛趋势怎么样？"),
      },
      "-",
      {
        label: "按普通家庭追问画像",
        action: () => insertPrompt("我江苏物理类 580，家里普通，怎么选专业？"),
      },
    ],
    [],
  );

  const handleExportReport = useCallback(() => {
    const markdown = buildReportMarkdown({
      profile: authoritativeProfile,
      missingFields,
      summary: strategySummary.body,
    });
    const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `gaokao-advisor-${new Date().toISOString().slice(0, 10)}.md`;
    link.click();
    URL.revokeObjectURL(url);
  }, [authoritativeProfile, missingFields, strategySummary.body]);

  const handleIgnoreMissing = useCallback(() => {
    setIgnoredFields(activeSessionId, missingFields);
    const prompt =
      `忽略这些待补信息：${missingFields.join("、") || "无"}。` +
      "请直接基于当前画像给出志愿填报意见摘要；明确说明这是信息不完整时的初步参考，并优先使用当前画像和2025投档/位次口径。";
    handleSubmitPrompt(prompt);
  }, [activeSessionId, handleSubmitPrompt, missingFields, setIgnoredFields]);
  const handleRestoreMissing = useCallback(() => {
    clearIgnoredFields(activeSessionId);
  }, [activeSessionId, clearIgnoredFields]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const scrollRoot = dashboardScrollRef.current;
    if (!scrollRoot) return;

    const messageList = document.querySelector('[data-testid="copilot-message-list"]');
    if (!messageList) return;

    let frame = 0;
    let lastScrollAt = 0;
    const scrollToLatest = () => {
      const now = Date.now();
      if (now - lastScrollAt < 180) return;
      lastScrollAt = now;
      if (frame) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        scrollRoot.scrollTo({
          top: scrollRoot.scrollHeight,
          behavior: "auto",
        });
      });
    };

    const observer = new MutationObserver(scrollToLatest);
    observer.observe(messageList, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [activeSessionId]);

  return (
    <div className="gaokao-agent-shell mx-auto flex h-dvh min-h-0 w-full max-w-[480px] flex-col overflow-hidden bg-[#f6f9ff] text-slate-950 shadow-2xl shadow-slate-200/70">
      <main ref={dashboardScrollRef} className="gaokao-dashboard-scroll min-h-0 flex-1 overflow-y-auto pb-52">
        <AppHeader onCreate={createNewSession} onExport={handleExportReport} />
        <div className="grid gap-4">
          <CandidateProfileCard
            profile={authoritativeProfile}
            completion={completion}
            missingCount={missingFields.length}
            missingFields={missingFields}
            ignoredCount={activeIgnoredFields.length}
            isCollapsed={activeProfilePanelCollapsed}
            rankMeta={activeRankMeta}
            strategySummary={strategySummary}
            onToggleCollapsed={() => setProfilePanelCollapsed(activeSessionId, !activeProfilePanelCollapsed)}
            onIgnoreMissing={handleIgnoreMissing}
            onRestoreMissing={handleRestoreMissing}
          />
          <AgentConversationPanel
            activeSessionId={activeSessionId}
            activeSuggestions={activeSuggestions}
            toolsMenu={toolsMenu}
          />
        </div>
      </main>

      <PromptSuggestions suggestions={dashboardSuggestions} />
      <TextComposerDock onSubmit={handleSubmitPrompt} />
    </div>
  );
}

export default function Home() {
  const wildcardRenderer = defineToolCallRenderer({
    name: "*",
    render: ({ name, args, status }) => <ToolReasoning name={name} args={args} status={status} />,
  });

  return (
    <CopilotKitProvider
      runtimeUrl="/api/copilotkit"
      renderToolCalls={[wildcardRenderer]}
      showDevConsole={false}
      onError={({ error }) => {
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (/AbortError|BodyStreamBuffer was aborted/i.test(message)) return;
        console.error("[Gaokao Advisor] CopilotKit error", error);
      }}
    >
      <AdvisorChatSurface />
    </CopilotKitProvider>
  );
}
