import { NextResponse } from "next/server";
import { z } from "zod";

export const dynamic = "force-dynamic";

const TIME_CONTEXT =
  "当前日期是 2026-06-13，时区 Asia/Shanghai。2026 年全国统考已于 2026-06-07 至 2026-06-08 举行；新高考地区可能延续到 2026-06-09 或 2026-06-10。现在是高考后查分/志愿准备阶段。";

const profileSchema = z.object({
  province: z.string().optional(),
  subjectTrack: z.string().optional(),
  score: z.number().optional(),
  rank: z.number().optional(),
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
  const suggestions: string[] = [];
  if (!input.profile.rank && /能去|能上|报什么|怎么选|学校|大学|志愿|680|分/.test(input.rawPrompt)) {
    suggestions.push("我的位次是：");
  }
  if (!input.profile.budget && /普通家庭|预算|学费|中外|费用/.test(input.rawPrompt)) {
    suggestions.push("家里每年预算大概是：");
  }
  if (!input.profile.cityPreference && /城市|地区|想去|哪里读/.test(input.rawPrompt)) {
    suggestions.push("我想去的城市/地区是：");
  }

  return {
    keyFacts: [TIME_CONTEXT],
    profilePatch: {},
    missingPriority: suggestions.includes("我的位次是：") ? ["rank"] : [],
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
              TIME_CONTEXT,
          },
          {
            role: "user",
            content: JSON.stringify({
              task:
                "从本轮用户输入中提取关键信息，给画像补丁、待补字段优先级、会话摘要和下一轮建议回复。字段名必须使用 province, subjectTrack, score, rank, budget, cityPreference, canLeaveProvince, graduatePlan, majorPreference, avoidMajors, familyType。",
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
      keyFacts: [TIME_CONTEXT, ...parsed.keyFacts].slice(0, 8),
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
