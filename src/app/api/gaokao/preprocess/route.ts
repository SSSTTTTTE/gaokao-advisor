import { NextResponse } from "next/server";
import { z } from "zod";
import { buildProfileKeyFacts, extractStudentProfilePatch, mergeStudentProfile, withDerivedStudentProfile } from "@/lib/agent/profile-extractor";
import { routeAgentTurn } from "@/lib/agent/tool-router";
import type { StudentProfile } from "@/lib/agent/types";

export const dynamic = "force-dynamic";

const TIME_ZONE = "Asia/Shanghai";

function getCurrentDateForPrompt() {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "long",
  }).format(new Date());
}

function timeContext() {
  return `当前日期是 ${getCurrentDateForPrompt()}，时区 ${TIME_ZONE}。2026 年全国统考已于 2026-06-07 至 2026-06-08 举行；新高考地区可能延续到 2026-06-09 或 2026-06-10。现在是高考后查分/志愿准备阶段。`;
}

const profileSchema = z.object({
  province: z.string().optional(),
  year: z.number().optional(),
  subjectTrack: z.string().optional(),
  score: z.number().optional(),
  rank: z.number().optional(),
  targetCities: z.array(z.string()).optional(),
  preferredMajors: z.array(z.string()).optional(),
  familyBudget: z.string().optional(),
  riskPreference: z.enum(["冲刺", "稳妥", "保守"]).optional(),
  acceptPrivate: z.boolean().optional(),
  acceptSinoForeign: z.boolean().optional(),
  budget: z.string().optional(),
  cityPreference: z.string().optional(),
  canLeaveProvince: z.boolean().optional(),
  graduatePlan: z.string().optional(),
  majorPreference: z.array(z.string()).optional(),
  avoidMajors: z.array(z.string()).optional(),
  familyType: z.string().optional(),
  updatedAt: z.string().optional(),
});

const requestSchema = z.object({
  threadId: z.string(),
  rawPrompt: z.string().min(1).max(2000),
  profile: profileSchema.default({}),
  previousSummary: z.string().max(1000).optional().default(""),
  lastAssistantText: z.string().max(2000).optional().default(""),
});

const responseSchema = z.object({
  keyFacts: z.array(z.string()).default([]),
  profilePatch: profileSchema.partial().default({}),
  missingPriority: z.array(z.string()).default([]),
  sessionSummary: z.string().default(""),
  suggestions: z.array(z.string()).default([]),
  ambiguityWarnings: z.array(z.string()).default([]),
});

function fallbackResponse(input: z.infer<typeof requestSchema>, warning?: string) {
  const profilePatch = extractStudentProfilePatch(input.rawPrompt);
  const mergedProfile = withDerivedStudentProfile(
    mergeStudentProfile(input.profile as StudentProfile, profilePatch),
  );
  const route = routeAgentTurn({ userMessage: input.rawPrompt, profile: mergedProfile });
  const suggestions = route.nextQuestions
    .flatMap((question) => question.options.map((option) => option.prompt ?? option.label))
    .filter(Boolean)
    .slice(0, 8);
  const keyFacts = buildProfileKeyFacts(profilePatch, input.rawPrompt);

  return {
    keyFacts: [timeContext(), ...keyFacts].slice(0, 8),
    profilePatch,
    missingPriority: [...route.missingFields, ...route.suggestedFields].slice(0, 8),
    sessionSummary: [input.previousSummary, input.rawPrompt].filter(Boolean).join("；").slice(-220),
    suggestions,
    ambiguityWarnings: warning ? [warning] : [],
  };
}

function safeParseJson(text: string) {
  const direct = text.trim();
  try {
    return JSON.parse(direct);
  } catch {
    const match = direct.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("No JSON object in preprocess response.");
    return JSON.parse(match[0]);
  }
}

export async function POST(request: Request) {
  let input: z.infer<typeof requestSchema>;
  try {
    input = requestSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid preprocess request." }, { status: 400 });
  }

  if (!process.env.DEEPSEEK_API_KEY) {
    return NextResponse.json(fallbackResponse(input, "DeepSeek key missing; used local preprocessing."));
  }

  try {
    const response = await fetch("https://api.deepseek.com/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.DEEPSEEK_MODEL || "deepseek-chat",
        temperature: 0.1,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "你是高考志愿填报 agent 的预处理器，只输出 JSON。不要给建议长文，不要编造分数线。高考省份是投档省份，目标城市/地区是想去读大学的地方，二者不能混用。" +
              timeContext(),
          },
          {
            role: "user",
            content: JSON.stringify({
              task:
                "从本轮用户输入中提取关键信息，给画像补丁、待补字段优先级、会话摘要和下一轮建议回复。字段名优先使用 province, year, subjectTrack, score, rank, targetCities, preferredMajors, avoidMajors, familyBudget, riskPreference, acceptPrivate, acceptSinoForeign, graduatePlan, familyType；兼容旧字段 budget, cityPreference, canLeaveProvince, majorPreference。",
              rawPrompt: input.rawPrompt,
              currentProfile: input.profile,
              previousSummary: input.previousSummary,
              lastAssistantText: input.lastAssistantText,
              outputShape: {
                keyFacts: ["短事实"],
                profilePatch: {},
                missingPriority: ["rank"],
                sessionSummary: "不超过 120 字",
                suggestions: ["我的位次是："],
                ambiguityWarnings: [],
              },
            }),
          },
        ],
      }),
    });

    if (!response.ok) {
      return NextResponse.json(
        fallbackResponse(input, `DeepSeek preprocess HTTP ${response.status}; used local preprocessing.`),
      );
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content ?? "{}";
    const parsed = responseSchema.parse(safeParseJson(content));

    return NextResponse.json({
      ...parsed,
      keyFacts: [timeContext(), ...parsed.keyFacts].slice(0, 8),
    });
  } catch (error) {
    return NextResponse.json(
      fallbackResponse(
        input,
        `Remote preprocess failed: ${error instanceof Error ? error.message : "unknown error"}.`,
      ),
    );
  }
}
