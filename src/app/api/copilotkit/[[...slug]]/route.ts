import {
  BuiltInAgent,
  CopilotRuntime,
  InMemoryAgentRunner,
  createCopilotRuntimeHandler,
  defineTool,
} from "@copilotkit/runtime/v2";
import { createOpenAI } from "@ai-sdk/openai";
import { spawn } from "node:child_process";
import { z } from "zod";
import { lookupAdmissionScores as lookupOfficialAdmissionScores } from "@/lib/gaokao-data";
import { lookupRankByScoreFromVault } from "@/lib/gaokao-vault-data";

const TIME_ZONE = "Asia/Shanghai";
const GAOKAO_STAGE_CONTEXT =
  "当前日期按服务端真实日期处理。2026 年全国统考已于 2026-06-07 至 2026-06-08 举行；新高考地区可能延续到 2026-06-09 或 2026-06-10。现在应按高考后查分/志愿准备阶段处理，具体省份安排以省考试院为准。";
const SO_SEARCH_ENDPOINT = "https://www.so.com/s";
const SOGOU_SEARCH_ENDPOINT = "https://www.sogou.com/web";
const BING_SEARCH_ENDPOINT = "https://www.bing.com/search";
const PUBLIC_SEARCH_TIMEOUT_MS = 5_000;
const TAVILY_TIMEOUT_MS = 15_000;
const MODEL_FETCH_TIMEOUT_MS = 60_000;

function fetchWithTimeout(
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1] = {},
  timeoutMs = 12_000,
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new Error(`Request timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  const externalSignal = init?.signal;

  if (externalSignal) {
    if (externalSignal.aborted) controller.abort(externalSignal.reason);
    else {
      externalSignal.addEventListener(
        "abort",
        () => controller.abort(externalSignal.reason),
        { once: true },
      );
    }
  }

  return fetch(input, { ...init, signal: controller.signal }).finally(() => {
    clearTimeout(timeout);
  });
}

function getCurrentDateForPrompt() {
  const now = new Date();
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "long",
  }).format(now);
}

const admissionLookupSchema = z.object({
  schoolName: z.string().min(2).describe("院校名称，例如：苏州大学"),
  province: z.string().min(2).describe("招生省份，例如：江苏"),
  subjectTrack: z.string().min(2).describe("科类或选科，例如：物理类、历史类"),
  yearRange: z
    .array(z.number().int().min(2000).max(2030))
    .min(1)
    .max(5)
    .optional()
    .describe("要查询的年份。单年如 [2025]；近三年如 [2023, 2024, 2025]。"),
  queryType: z
    .enum(["overallTrend", "groupComparison"])
    .optional()
    .describe("overallTrend 用于多年趋势；groupComparison 用于单年专业组对比。"),
});

const lookupAdmissionScores = defineTool({
  name: "lookupAdmissionScores",
  description:
    "Official-first lookup for Gaokao admission scores. Use this before answering questions about a specific school's recent score lines. It tries the local gaokao-vault structured database first, including imported 2025 provincial institution admission lines such as 天津普通类本科批A阶段, then falls back to official parsers/search. Only use it for clearly specified school/province/subject/year queries; do not use it for broad all-school scans.",
  parameters: admissionLookupSchema,
  execute: async (args) => lookupOfficialAdmissionScores(args),
});

function resolveUvxCommand() {
  if (process.env.MCP_GAOKAO_UVX_COMMAND) return process.env.MCP_GAOKAO_UVX_COMMAND;
  if (process.env.UVX_COMMAND) return process.env.UVX_COMMAND;

  if (process.env.HOME) return `${process.env.HOME}/.local/bin/uvx`;

  return "uvx";
}

function extractRankFromMcpResponse(response: unknown) {
  const result = response as {
    result?: {
      content?: Array<{ text?: string; type?: string }>;
      structuredContent?: { result?: unknown };
      isError?: boolean;
    };
    error?: { message?: string };
  };

  if (result.error?.message) throw new Error(result.error.message);
  if (result.result?.isError) {
    const message =
      result.result.content?.find((item) => item.type === "text")?.text ?? "MCP rank tool failed.";
    throw new Error(message);
  }

  const structuredRank = result.result?.structuredContent?.result;
  if (typeof structuredRank === "number") return structuredRank;

  const textRank = result.result?.content?.find((item) => item.type === "text")?.text;
  const parsedRank = textRank?.match(/\d+/)?.[0];
  if (parsedRank) return Number(parsedRank);

  throw new Error("MCP rank response did not contain a numeric rank.");
}

async function callGaokaoRankMcp(args: {
  province: string;
  year: string;
  subjectTrack: string;
  score: number;
}) {
  const command = resolveUvxCommand();

  return new Promise<{ rank: number; raw: unknown; command: string }>((resolve, reject) => {
    const child = spawn(command, ["mcp-gaokao-rank"], {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdoutBuffer = "";
    let stderrBuffer = "";
    let didSendCall = false;

    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`mcp-gaokao-rank timed out. ${stderrBuffer.trim()}`.trim()));
    }, 30_000);

    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.removeAllListeners();
      child.stderr.removeAllListeners();
      child.removeAllListeners();
      child.kill();
    };

    const writeJson = (payload: unknown) => {
      child.stdin.write(`${JSON.stringify(payload)}\n`);
    };

    const handleMessage = (message: { id?: number; result?: unknown; error?: unknown }) => {
      if (message.id === 1 && !didSendCall) {
        didSendCall = true;
        writeJson({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
        writeJson({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "get_rank",
            arguments: {
              province: args.province,
              year: args.year,
              category: args.subjectTrack,
              score: args.score,
            },
          },
        });
        return;
      }

      if (message.id === 2) {
        try {
          const rank = extractRankFromMcpResponse(message);
          cleanup();
          resolve({ rank, raw: message, command });
        } catch (error) {
          cleanup();
          reject(error);
        }
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString("utf8");
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          handleMessage(JSON.parse(line));
        } catch {
          stderrBuffer += `\nUnparseable MCP stdout: ${line.slice(0, 200)}`;
        }
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrBuffer += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      cleanup();
      reject(error);
    });

    child.on("close", (code) => {
      if (code === 0) return;
      cleanup();
      reject(new Error(`mcp-gaokao-rank exited with code ${code}. ${stderrBuffer.trim()}`.trim()));
    });

    writeJson({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: {
          name: "gaokao-major-advisor",
          version: "1.0.0",
        },
      },
    });
  });
}

function normalizeRankProvince(province: string) {
  const value = province.trim();
  const provinceMap: Record<string, string> = {
    Jiangsu: "江苏",
    jiangsu: "江苏",
    JS: "江苏",
    js: "江苏",
  };
  return provinceMap[value] ?? value.replace(/省$/, "");
}

function normalizeRankSubjectTrack(subjectTrack: string) {
  const value = subjectTrack.trim();
  const lower = value.toLowerCase();
  if (/physics|物理|理科|science/.test(lower)) return value.includes("理科") ? "理科" : "物理类";
  if (/history|历史|文科|arts|liberal/.test(lower)) return value.includes("文科") ? "文科" : "历史类";
  if (/综合|3\+3|zonghe|comprehensive/.test(lower)) return "综合改革";
  return value;
}

const lookupRankByScore = defineTool({
  name: "lookupRankByScore",
  description:
    "Query score-to-rank data through gaokao-vault or the mcp-gaokao rank service. Use it only for rank supplementation, not as the authority for university admission score lines.",
  parameters: z.object({
    province: z.string().min(2).describe("省份，例如：江苏"),
    year: z.string().min(4).describe("年份，例如：2025、2024本科"),
    subjectTrack: z.string().min(2).describe("科类，例如：物理类、历史类"),
    score: z.number().int().min(0).max(750).describe("高考分数"),
  }),
  execute: async ({ province, year, subjectTrack, score }) => {
    const normalizedProvince = normalizeRankProvince(province);
    const normalizedSubjectTrack = normalizeRankSubjectTrack(subjectTrack);
    const normalizedYear = year.trim();
    const numericYear = Number(normalizedYear.match(/\d{4}/)?.[0]);
    let adapterError: string | undefined;

    if (Number.isInteger(numericYear)) {
      const vaultResult = await lookupRankByScoreFromVault({
        province: normalizedProvince,
        year: numericYear,
        subjectTrack: normalizedSubjectTrack,
        score,
      });

      if (vaultResult) {
        return {
          status: "ok",
          provider: "lifefloating/gaokao-vault",
          transport: "postgres",
          rank: vaultResult.rank,
          result: {
            rank: vaultResult.rank,
            matchedScore: vaultResult.matchedScore,
          },
          request: { province, year, subjectTrack, score },
          normalizedRequest: {
            province: normalizedProvince,
            year: normalizedYear,
            subjectTrack: normalizedSubjectTrack,
            score,
          },
          source: vaultResult.source,
          note: "Rank comes from gaokao-vault score_segments and is for reference only.",
        };
      }
    }

    if (process.env.MCP_GAOKAO_RANK_ENDPOINT) {
      try {
        const response = await fetchWithTimeout(
          process.env.MCP_GAOKAO_RANK_ENDPOINT,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              tool: "get_rank",
              arguments: {
                province: normalizedProvince,
                year: normalizedYear,
                category: normalizedSubjectTrack,
                score,
              },
            }),
          },
          12_000,
        );

        if (response.ok) {
          return {
            status: "ok",
            provider: "iefnaf/mcp-gaokao",
            transport: "http-adapter",
            result: await response.json(),
            request: { province, year, subjectTrack, score },
            normalizedRequest: {
              province: normalizedProvince,
              year: normalizedYear,
              subjectTrack: normalizedSubjectTrack,
              score,
            },
          };
        }

        adapterError = `HTTP adapter returned ${response.status}`;
      } catch (error) {
        adapterError = error instanceof Error ? error.message : String(error);
      }
    }

    try {
      const mcpResult = await callGaokaoRankMcp({
        province: normalizedProvince,
        year: normalizedYear,
        subjectTrack: normalizedSubjectTrack,
        score,
      });
      return {
        status: "ok",
        provider: "iefnaf/mcp-gaokao",
        transport: "stdio-uvx",
        rank: mcpResult.rank,
        result: {
          rank: mcpResult.rank,
        },
        request: { province, year, subjectTrack, score },
        normalizedRequest: {
          province: normalizedProvince,
          year: normalizedYear,
          subjectTrack: normalizedSubjectTrack,
          score,
        },
        note: "Rank comes from mcp-gaokao local historical score segment data and is for reference only.",
        fallbackFromAdapterError: adapterError,
      };
    } catch (error) {
      return {
        status: "error",
        provider: "iefnaf/mcp-gaokao",
        transport: "stdio-uvx",
        message: error instanceof Error ? error.message : String(error),
        adapterError,
        request: { province, year, subjectTrack, score },
        normalizedRequest: {
          province: normalizedProvince,
          year: normalizedYear,
          subjectTrack: normalizedSubjectTrack,
          score,
        },
        configHint: {
          mcpServers: {
            "mcp-gaokao-rank": {
              command: resolveUvxCommand(),
              args: ["mcp-gaokao-rank"],
            },
          },
        },
      };
    }
  },
});

const advisorProfileSchema = z.object({
  province: z.string().optional().describe("高考省份/投档省份，不是想去读大学的目标地区"),
  subjectTrack: z.string().optional().describe("科类或选科，例如物理类、历史类、理科、文科"),
  score: z.number().optional().describe("高考分数"),
  rank: z.number().optional().describe("全省位次"),
  budget: z.string().optional().describe("家庭预算或成本约束"),
  cityPreference: z.string().optional().describe("目标城市/地区偏好，例如想去新疆、南京、长三角读大学"),
  canLeaveProvince: z.boolean().optional().describe("是否接受离开高考省份去外省读大学"),
  graduatePlan: z.string().optional().describe("读研、保研或本科就业倾向"),
  majorPreference: z.array(z.string()).optional().describe("专业偏好"),
  avoidMajors: z.array(z.string()).optional().describe("明确避雷的专业"),
  familyType: z.string().optional().describe("家庭类型或决策约束，例如普通家庭"),
});

const cardSourceSchema = z.object({
  id: z.string(),
  title: z.string(),
  url: z.string().optional(),
  publisher: z.string().optional(),
  kind: z.string().optional(),
});

function missingAdvisorFields(profile: z.infer<typeof advisorProfileSchema>) {
  const missing: string[] = [];
  if (!profile.province) missing.push("高考省份");
  if (!profile.subjectTrack) missing.push("科类");
  if (!profile.score) missing.push("分数");
  if (!profile.rank) missing.push("位次");
  if (!profile.budget) missing.push("预算");
  if (!profile.cityPreference) missing.push("城市偏好");
  if (!profile.graduatePlan) missing.push("读研/就业意愿");
  return missing;
}

const buildVolunteerPlan = defineTool({
  name: "buildVolunteerPlan",
  description:
    "Build a structured Gaokao volunteer plan with 冲/稳/保 tiers. Use only after key profile facts and score evidence are available, or return missing fields.",
  parameters: z.object({
    profile: advisorProfileSchema,
    candidateSchools: z.array(z.string()).optional(),
    preferences: z.array(z.string()).optional(),
    scoreEvidence: z.array(z.string()).optional(),
    sources: z.array(cardSourceSchema).optional(),
  }),
  execute: async ({ profile, candidateSchools = [], preferences = [], scoreEvidence = [], sources = [] }) => {
    const missing = missingAdvisorFields(profile);
    const schools = candidateSchools.length
      ? candidateSchools.slice(0, 9)
      : ["目标院校A", "目标院校B", "目标院校C", "匹配院校A", "匹配院校B", "保底院校A"];
    const majorDirection =
      preferences[0] ?? profile.majorPreference?.[0] ?? "计算机/电子/电气等确定性较强方向";

    return {
      status: missing.includes("位次") || missing.includes("分数") ? "needs_profile" : "ok",
      profile,
      missingFields: missing,
      tiers: [
        {
          tier: "冲",
          items: schools.slice(0, 3).map((schoolName) => ({
            schoolName,
            groupName: "需核验目标专业组",
            majorDirection,
            evidence: scoreEvidence[0] ?? "需要结合近三年分数线、位次和招生计划确认。",
            riskLevel: "高风险",
            reason: "适合放在前排冲刺，但不能占用稳妥名额。",
            sourceIds: sources.map((source) => source.id),
          })),
        },
        {
          tier: "稳",
          items: schools.slice(3, 5).map((schoolName) => ({
            schoolName,
            groupName: "优先选择强专业组",
            majorDirection,
            evidence: scoreEvidence[1] ?? "分数/位次应接近或略高于近年最低门槛。",
            riskLevel: "中风险",
            reason: "作为主力选择，重点看专业方向和城市资源。",
            sourceIds: sources.map((source) => source.id),
          })),
        },
        {
          tier: "保",
          items: schools.slice(5, 8).map((schoolName) => ({
            schoolName,
            groupName: "避开高收费和弱适配专业组",
            majorDirection,
            evidence: scoreEvidence[2] ?? "保底项需要留出位次安全垫。",
            riskLevel: "低风险",
            reason: "保证有学上，同时尽量不牺牲专业和城市底线。",
            sourceIds: sources.map((source) => source.id),
          })),
        },
      ].filter((tier) => tier.items.length > 0),
      warnings: [
        missing.length ? `画像仍缺：${missing.join("、")}，方案只能作为草案。` : "冲稳保是辅助分层，不是最终录取承诺。",
        "正式填报前必须按省考试院、院校招生章程和当年招生计划核验。",
      ],
      sources,
    };
  },
});

const explainAdmissionRisk = defineTool({
  name: "explainAdmissionRisk",
  description:
    "Explain admission and major-selection risks for a Gaokao profile, especially ordinary-family constraints.",
  parameters: z.object({
    profile: advisorProfileSchema.optional(),
    target: z.string().optional(),
    scoreEvidence: z.array(z.string()).optional(),
  }),
  execute: async ({ profile, target, scoreEvidence = [] }) => {
    const targetUserType = profile?.familyType ?? "普通家庭考生";
    return {
      targetUserType,
      target,
      scoreEvidence,
      avoid: [
        {
          title: "高收费但就业确定性弱的方向",
          reason: "普通家庭要先看投入产出，学费高但路径不清晰的项目要谨慎。",
        },
        {
          title: "泛管理、泛文科且无明确升学/考公路径",
          reason: "如果学校层次和城市资源不够强，本科直接就业会比较吃力。",
        },
      ],
      cautious: [
        {
          title: "医学、法学、师范等长周期方向",
          reason: "不是不能选，但要确认读研、资格证、地域编制和家庭承受能力。",
        },
        {
          title: "中外合作办学",
          reason: "必须核验学费、培养地点、证书和转专业政策，不能只看最低分低。",
        },
      ],
      suitable: [
        {
          title: "计算机、电子、电气、自动化等工科方向",
          reason: "更适合普通家庭用技术壁垒换就业确定性，但要避开明显弱校弱专业。",
        },
        {
          title: "城市资源强、产业匹配度高的学校",
          reason: "普通学生更依赖实习、校招和本地产业，不只看学校名气。",
        },
      ],
      summary: "普通家庭的核心不是追最热，而是控制成本、提高就业确定性、保留升学空间。",
    };
  },
});

const compareSchools = defineTool({
  name: "compareSchools",
  description:
    "Return a structured comparison for 2-3 universities from score risk, city value, major fit, employment path, and family fit.",
  parameters: z.object({
    profile: advisorProfileSchema.optional(),
    schools: z.array(z.string()).min(2).max(3),
    province: z.string().optional(),
    subjectTrack: z.string().optional(),
    sources: z.array(cardSourceSchema).optional(),
    warnings: z.array(z.string()).optional(),
  }),
  execute: async ({ profile, schools, province, subjectTrack, sources = [], warnings = [] }) => {
    return {
      profile: {
        ...profile,
        province: profile?.province ?? province,
        subjectTrack: profile?.subjectTrack ?? subjectTrack,
      },
      schools: schools.map((schoolName, index) => ({
        schoolName,
        scoreRisk: index === 0 ? "分数风险需优先核验" : "可作为对照项",
        cityValue: "看所在城市产业、实习和校招资源，不只看学校名气。",
        majorFit: "优先比较目标专业组和可接受专业，不用学校均值替代专业判断。",
        employmentView: "重点看普通学生去向、校招质量和读研/保研通道。",
        familyFit:
          profile?.familyType === "普通家庭"
            ? "普通家庭优先低试错成本和确定性。"
            : "结合预算和长期规划判断。",
        verdict: index === 0 ? "可作为主比较对象，但先补分数线和位次证据。" : "适合作为备选或横向参照。",
      })),
      sources,
      warnings: warnings.length
        ? warnings
        : ["学校对比必须结合分数线、专业组、招生计划和城市资源；缺数据时只做方向判断。"],
    };
  },
});

// 通用对比卡片工具（用于非院校对比场景）
const genericComparisonCard = defineTool({
  name: "genericComparisonCard",
  description:
    "Render structured comparison cards for any 2-5 items (e.g., majors, cities, career paths, policies). Use this instead of Markdown tables for mobile-friendly display. Do NOT use for school comparisons; use compareSchools + schoolComparisonCard instead.",
  parameters: z.object({
    title: z.string().describe("对比主题，例如：计算机 vs 软件工程 vs 人工智能"),
    items: z.array(
      z.object({
        name: z.string().describe("对比项名称，如'计算机科学与技术'"),
        icon: z.string().optional().describe("图标（可选）"),
        dimensions: z.array(
          z.object({
            label: z.string().describe("维度名称，如'学习内容'、'学习难度'、'就业前景'"),
            value: z.string().describe("该维度的值"),
          })
        ).min(1).max(10).describe("对比维度列表"),
        verdict: z.string().optional().describe("总结性判断（可选）"),
      })
    ).min(2).max(5).describe("对比项列表"),
    summary: z.string().optional().describe("总结性建议"),
    sources: z.array(cardSourceSchema).optional().default([]),
    warnings: z.array(z.string()).optional().default([]),
  }),
  execute: async ({ title, items, summary, sources, warnings }) => {
    return {
      title,
      items,
      summary: summary ?? "以上对比仅供参考，请结合个人情况综合判断。",
      sources: sources || [],
      warnings: warnings || [],
    };
  },
});

function decodeHtmlEntities(value: string) {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");
}

function safeDecodeURIComponent(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function stripHtml(value: string) {
  return decodeHtmlEntities(value)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractBingResults(html: string) {
  const results: Array<{ title: string; url: string; content: string }> = [];
  const blocks = html.match(/<li class="b_algo"[\s\S]*?<\/li>/gi) ?? [];

  for (const block of blocks) {
    const linkMatch = block.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h2>/i);
    if (!linkMatch) continue;

    const rawUrl = decodeHtmlEntities(linkMatch[1]);
    if (!/^https?:\/\//.test(rawUrl)) continue;

    const snippetMatch =
      block.match(/<p[^>]*>([\s\S]*?)<\/p>/i) ??
      block.match(/<div[^>]*class="[^"]*b_caption[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    const title = stripHtml(linkMatch[2]);
    const content = snippetMatch ? stripHtml(snippetMatch[1]) : "";

    if (title && !results.some((result) => result.url === rawUrl)) {
      results.push({ title, url: rawUrl, content });
    }

    if (results.length >= 6) break;
  }

  return results;
}

function normalizeSearchUrl(url: string, baseUrl: string) {
  const decoded = decodeHtmlEntities(url);
  if (/^https?:\/\//.test(decoded)) return decoded;
  if (decoded.startsWith("/")) return new URL(decoded, baseUrl).toString();
  return "";
}

function resultLooksRelevant(
  result: { title: string; url: string; content: string },
  query: string,
) {
  const haystack = `${result.title} ${result.url} ${result.content}`.toLowerCase();
  const requiredSignals = ["高考", "招生", "录取", "分数", "投档", "位次", "专业", "大学"];
  const querySignals = query
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
  const hasDomainOrEducationSignal = requiredSignals.some((signal) => haystack.includes(signal));
  const matchedQuerySignals = querySignals.filter((signal) =>
    haystack.includes(signal.toLowerCase()),
  ).length;
  const noisy = /menshealth|healthline|medicalnewstoday|breakfast|cereal|baike\.baidu\.com\/item\/2025|stats\.gov\.cn\/sj\/zxfbhjd/.test(
    haystack,
  );

  return !noisy && hasDomainOrEducationSignal && matchedQuerySignals >= Math.min(2, querySignals.length);
}

function extractSoResults(html: string, query: string) {
  const results: Array<{ title: string; url: string; content: string }> = [];
  const blocks = html.match(/<li[^>]*class="[^"]*(?:res-list|result)[^"]*"[\s\S]*?<\/li>/gi) ?? [];
  const candidates =
    blocks.length > 0
      ? blocks
      : (html.match(/<h3[\s\S]*?<\/h3>[\s\S]{0,1200}/gi) ?? []);

  for (const block of candidates) {
    const linkMatch = block.match(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;

    const realUrlMatch = block.match(/data-mdurl="([^"]+)"/i);
    const url = normalizeSearchUrl(realUrlMatch?.[1] ?? linkMatch[1], SO_SEARCH_ENDPOINT);
    if (!url || url.includes("javascript:")) continue;

    const title = stripHtml(linkMatch[2]);
    const content = stripHtml(block.replace(linkMatch[0], " ")).slice(0, 360);
    const result = { title, url, content };

    if (title && resultLooksRelevant(result, query) && !results.some((item) => item.url === url)) {
      results.push(result);
    }

    if (results.length >= 6) break;
  }

  return results;
}

function extractSogouResults(html: string, query: string) {
  const results: Array<{ title: string; url: string; content: string }> = [];
  const dataUrlBlocks = html.match(/<div[^>]*data-url="[^"]+"[\s\S]*?<\/div>/gi) ?? [];
  const normalBlocks = html.match(/<div[^>]+class="[^"]*vrwrap[^"]*"[\s\S]*?<\/div>/gi) ?? [];

  for (const block of [...dataUrlBlocks, ...normalBlocks]) {
    const dataUrlMatch = block.match(/data-url="([^"]+)"/i);
    const linkMatch = block.match(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    const realUrlMatch = block.match(/data-mdurl="([^"]+)"/i);
    const rawUrl = realUrlMatch?.[1] ?? dataUrlMatch?.[1] ?? linkMatch?.[1] ?? "";
    const url = normalizeSearchUrl(rawUrl, SOGOU_SEARCH_ENDPOINT);
    if (!url || url.includes("javascript:")) continue;

    const dataTitleMatch = block.match(/data-title="([^"]+)"/i);
    const title = stripHtml(
      dataTitleMatch ? safeDecodeURIComponent(dataTitleMatch[1]) : (linkMatch?.[2] ?? ""),
    );
    const content = stripHtml(block.replace(linkMatch?.[0] ?? "", " ")).slice(0, 360);
    const result = { title, url, content };

    if (title && resultLooksRelevant(result, query) && !results.some((item) => item.url === url)) {
      results.push(result);
    }

    if (results.length >= 6) break;
  }

  return results;
}

async function publicWebSearch(query: string) {
  const enrichedQuery = /高考|招生|录取|分数|投档|位次|专业|大学/.test(query)
    ? query
    : `${query} 高考 招生 录取分数 官方`;
  const providers = [
    {
      name: "so-html",
      searchUrl: `${SO_SEARCH_ENDPOINT}?q=${encodeURIComponent(enrichedQuery)}`,
      extract: (html: string) => extractSoResults(html, enrichedQuery),
    },
    {
      name: "sogou-html",
      searchUrl: `${SOGOU_SEARCH_ENDPOINT}?query=${encodeURIComponent(enrichedQuery)}`,
      extract: (html: string) => extractSogouResults(html, enrichedQuery),
    },
    {
      name: "bing-html",
      searchUrl: `${BING_SEARCH_ENDPOINT}?q=${encodeURIComponent(enrichedQuery)}&setlang=zh-CN&mkt=zh-CN`,
      extract: (html: string) =>
        extractBingResults(html).filter((result) => resultLooksRelevant(result, enrichedQuery)),
    },
  ];

  const attempted: Array<{ provider: string; searchUrl: string; status: number | "error"; error?: string }> =
    [];

  for (const provider of providers) {
    try {
      const response = await fetchWithTimeout(
        provider.searchUrl,
        {
          cache: "no-store",
          headers: {
            "accept-language": "zh-CN,zh;q=0.9,en;q=0.7",
            "user-agent":
              "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
          },
        },
        PUBLIC_SEARCH_TIMEOUT_MS,
      );

      attempted.push({
        provider: provider.name,
        searchUrl: provider.searchUrl,
        status: response.status,
      });

      if (!response.ok) continue;

      const html = await response.text();
      const results = provider.extract(html);

      if (results.length > 0) {
        return {
          status: "ok",
          provider: provider.name,
          searchUrl: provider.searchUrl,
          attempted,
          answer:
            "Public web search returned candidate sources. Prefer official school/provincial sources; if using third-party aggregated score-line data, label it clearly and recommend official verification before final decisions.",
          results,
        };
      }
    } catch (error) {
      attempted.push({
        provider: provider.name,
        searchUrl: provider.searchUrl,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    status: "partial",
    provider: "public-search",
    searchUrl: providers[0].searchUrl,
    attempted,
    answer:
      "Public search providers were reachable or attempted, but no relevant structured results were parsed. Ask the user for an official source or configure Tavily.",
    results: [],
  };
}

const researchGaokaoData = defineTool({
  name: "researchGaokaoData",
  description:
    "Fallback live search for current Gaokao major, university, score-line, employment, salary, policy, or industry facts when official structured parsers are not enough.",
  parameters: z.object({
    query: z
      .string()
      .min(4)
      .describe(
        "Focused Chinese search query with year, province, major, university, score line, employment, salary, or policy keywords.",
      ),
    reason: z.string().min(4).describe("Why this data is needed."),
  }),
  execute: async ({ query, reason }) => {
    if (!process.env.TAVILY_API_KEY) {
      const publicSearch = await publicWebSearch(query);
      return {
        ...publicSearch,
        query,
        reason,
        tavilyConfigured: false,
        message:
          publicSearch.status === "ok"
            ? "TAVILY_API_KEY is not configured, so a public search fallback was used. Prefer official school/provincial sources when available; third-party aggregated score-line data may be charted only when the source clearly states year, school, province, subject track, and score, and must be labeled as third-party."
            : "TAVILY_API_KEY is not configured and public search did not produce parseable results. Ask the user for an official source or configure Tavily.",
        chartDataGuidance:
          "You may call scoreLineTrendChart from clearly labeled third-party aggregated sources when each chart point has an explicit year, school, province, subject track, and score. Mark the source as third-party in sources/warnings and say official verification is required. If rank is not disclosed, pass -1. Do not infer missing scores.",
      };
    }

    let response: Response;
    try {
      response = await fetchWithTimeout(
        "https://api.tavily.com/search",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            api_key: process.env.TAVILY_API_KEY,
            query,
            search_depth: "basic",
            include_answer: true,
            include_raw_content: false,
            max_results: 8,
          }),
        },
        TAVILY_TIMEOUT_MS,
      );
    } catch (error) {
      return {
        status: "error",
        query,
        reason,
        message: `Research provider timed out or failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }

    if (!response.ok) {
      return {
        status: "error",
        query,
        reason,
        message: `Research provider returned ${response.status}`,
      };
    }

    const data = await response.json();
    return {
      status: "ok",
      query,
      reason,
      answer: data.answer,
      chartDataGuidance:
        "You may call scoreLineTrendChart from clearly labeled third-party aggregated sources when each chart point has an explicit year, school, province, subject track, and score. Mark the source as third-party in sources/warnings and say official verification is required. If rank is not disclosed, pass -1. Do not infer missing scores.",
      results: data.results?.map(
        (result: { title?: string; url?: string; content?: string }) => ({
          title: result.title,
          url: result.url,
          content: result.content,
        }),
      ),
    };
  },
});

function buildAdvisorPrompt() {
  return `
你是一个高考志愿填报 agent，采用“张雪峰视角”的公开方法论和表达风格，但不要声称自己是真人本人。
首次回复说明：这是基于公开言论抽象出的择校择业视角，不代表本人。

当前真实日期：${getCurrentDateForPrompt()}，时区：${TIME_ZONE}。
高考阶段：${GAOKAO_STAGE_CONTEXT}
重要时间判断：现在已经是 2026 年。用户问 2025 年录取分数线时，默认这是已经发布的历史录取数据，必须先查官方数据；不要回答“2025 还没出来”。如果用户问 2026 年录取线，才说明录取未完成前没有最终录取线。
如果用户问“今年高考还没考吗”“现在能不能按高考后判断”等，必须明确：以当前真实日期 ${getCurrentDateForPrompt()} 计，全国统考已经过去，多数地区已进入查分和志愿准备阶段；不要说 2026 年高考还没开始。

产品形态：手机端高考志愿聊天 agent。不要让用户填表，不要输出复杂后台说明，用自然对话推进。手机端禁止输出 Markdown 表格、HTML 表格、CSV 风格列对齐或用空格模拟表格（不要写 | 学校 | 建议 |，也不要输出 <table>）；录取分数线必须优先使用 scoreLineTrendChart，文字明细只用短列表，不要把 rows 复述成表格。凡是推荐 2 所及以上学校、多个专业组、冲稳保清单或学校对比，必须先调用受控 UI：volunteerPlanCards 或 schoolComparisonCard；正文只写最终判断，不得用表格承载学校清单。工具调用、检索动作、数据整理动作会由前端折叠成“思考过程/检索过程”，不要在正文里复述这些过程。关键决策输出优先使用受控 UI：studentProfileSummary、volunteerPlanCards、admissionRiskCards、schoolComparisonCard。

**重要规则：凡是对比类问题（非院校对比），必须使用 genericComparisonCard + GenericComparisonCard 组件输出卡片式对比 UI。**
- 适用场景：专业对比（如计算机 vs 软件工程）、城市对比（如南京 vs 杭州）、职业路径对比（如读研 vs 直接就业）、政策对比等
- 不适用场景：院校对比（已有 schoolComparisonCard 专用组件）
- 工作流程：先调用 genericComparisonCard 生成结构化对比数据，前端会自动渲染为卡片式 UI，每个对比项用独立卡片展示，包含多个维度的详细信息
- 禁止行为：不要用 Markdown 表格、不要用纯文本罗列对比项、不要省略对比直接给结论

工作方式：
1. 先自然问清楚高考省份、科类/选科、分数、位次、家庭预算、目标城市/地区偏好、能不能读研、能否接受医学/军警/师范/出省。
1a. 高考省份是考生参加高考和被投档的省份；目标城市/地区是想去读大学的地方。用户说“我是海南考生，想去新疆读”时，海南是高考省份，新疆是城市/地区偏好，不能把目标地区写成高考省份。
1b. 每个 threadId 是独立会话记忆。只能使用当前会话消息、当前本地画像和本轮工具结果，不要引用或合并其他会话的画像、偏好、院校结论。
1c. 分数线和位次数据源优先级：省考试院/院校招生网 > gaokao-vault 结构化库 > mcp-gaokao 位次补充 > 联网搜索/第三方聚合。gaokao-vault 来自第三方开源入库，必须标注“结构化库/辅助参考”，不能冒充官方来源。gaokao-vault 只用于明确学校、投档省份、科类/类别和年份范围的定向查询，或明确省份/科类/分数/年份的一分一段位次查询；不要请求“全部学校/所有院校”的全量数据。
1c. 前端会在隐藏上下文中提供“当前权威画像”和“本轮关键信息/profileAfterTurn”。这些字段优先级高于历史聊天文本、会话摘要和旧工具结果；如果用户把分数从 590 改为 530，当前权威画像里的 530 必须覆盖历史里的 590，生成方案和调用工具时也必须使用 530。
2. 用户缺少位次、预算、城市偏好、读研意愿等关键条件时，先追问，不要直接给确定院校清单。追问 2 个以上问题时必须使用逐行 Markdown 有序列表。
3. 对“我某省某科类某分，怎么选专业/学校”这类规划问题，如果用户只给分数没给位次：若当前权威画像或本轮信息已经有高考省份、科类/类别和分数，必须先调用 lookupRankByScore 自动补位次，再继续判断；若仍缺省份或科类，才追问缺口。
3a. 用户明确问“多少名/位次/排名/一分一段/这个分在某省排多少”，或当前画像缺位次但已有省份、科类/类别和分数时，必须调用 lookupRankByScore。lookupRankByScore 已接入 gaokao-vault 的 score_segments，返回结果时说明这是结构化库/辅助参考，正式填报前仍以省考试院原表为准。
4. 涉及最新院校分数线、专业录取、就业、政策或薪资时，必须先调用工具或让用户提供权威数据，不能凭空编。
5. 院校分数线优先调用 lookupAdmissionScores。它会先尝试本地 gaokao-vault 定向结构化查询（已接入 2025 北京、天津、河北、江苏、上海、广东、贵州、山东、海南等省份/直辖市的本科批投档数据；其中天津为普通类本科批A阶段），再走省考试院/学校招生网解析，并会发现学校招生网历年分数入口。返回 ok/partial 且有 chartPoints 时，再调用 scoreLineTrendChart。若返回 sources 中有 official_school 但 rows/chartPoints 为空，下一步必须调用 researchGaokaoData，query 里带上学校名、年份、省份、科类和该官方招生网 URL/标题，优先围绕学校招生网提取数据。其他学校或官方解析不足时，再用 researchGaokaoData 兜底；如果第三方聚合页清楚给出年份、学校、省份、科类和分数，可以调用 scoreLineTrendChart 画图，但回答和 warnings 必须先说明“第三方聚合数据，正式填报前以官方核验”。
6. 用户问“2025 某大学江苏物理类/历史类分数线是什么”时，调用 lookupAdmissionScores({ schoolName:"某大学", province:"江苏", subjectTrack:"物理类", yearRange:[2025], queryType:"groupComparison" })，有 chartPoints 再调用 scoreLineTrendChart，最后用 3-5 句话总结；没有结构化行就继续调用 researchGaokaoData，不要直接放弃。
6a. 用户问“2025 某大学天津综合改革/天津本科A段/天津投档线是什么”时，调用 lookupAdmissionScores({ schoolName:"某大学", province:"天津", subjectTrack:"综合改革", yearRange:[2025], queryType:"groupComparison" })；命中后必须说明口径是“天津普通类本科批A阶段院校专业组投档线”，并调用 scoreLineTrendChart。
7. 用户问“某大学近三年江苏物理类趋势”时，调用 lookupAdmissionScores({ schoolName:"某大学", province:"江苏", subjectTrack:"物理类", yearRange:[2023,2024,2025], queryType:"overallTrend" })，有 chartPoints 再调用 scoreLineTrendChart；只拿到部分年份时要说明缺口。
7a. 不要把 scoreLineTrendChart 当成用户显式要求“画图/曲线”之后才使用的能力。凡是用户询问分数线、录取线、投档线、近三年、历年、趋势、走势或具体分数，且能识别学校/多个学校、投档省份和科类/类别时，必须先查数据并主动调用 scoreLineTrendChart。科类/类别包括物理类、历史类、文科、理科、艺术类、美术类、编导类、播音类、综合分等。
7b. 对“杭师大或浙传在河北美术类近三年具体分数线趋势”这类非江苏、艺术类或多个学校问题：先调用 lookupAdmissionScores 尝试官方结构化；若不支持该省份/类别，立刻调用 researchGaokaoData 检索学校招生网、省考试院和可核验第三方聚合页。只要结果包含明确年份、学校、省份、类别和分数，就必须用 scoreLineTrendChart 绘图；来源不是官方时设置 dataScope:"thirdPartyAggregate" 并在 warnings 中说明第三方参考。
7c. 多学校趋势问题优先用 overallTrend 分学校/年份展示；如果模型只能稳定抽取同一年多条专业组或学校数据，则用 groupComparison，并在 analysisSummary 中说明缺了哪些年份或口径。
7d. 严格说“一分一段”是省级同分位次表，不属于某个学校。用户说“某个学校的一分一段/位次线/分数对应位次”时，如果上下文是学校录取，按该校录取分数与最低位次调用 lookupAdmissionScores；如果用户给出具体分数并问“这个分在某省多少名”，才调用 lookupRankByScore。
8. scoreLineTrendChart 的 points 必须来自 lookupAdmissionScores.chartPoints、lookupAdmissionScores.rows、官方院校/考试院页面正文、可核验第三方聚合页，或用户明确提供的数据；未知位次用 -1，不要估算。只有搜索片段含糊、来源互相矛盾或缺少年份/科类/分数时，才不要调用 scoreLineTrendChart。
8a. 用户问“近五年/近三年/历年趋势”时，一次性查询整个年份范围，不要按年份循环调用多次搜索。若只查到 2-3 年有效数据，也要先画可核验数据并说明缺少年份；不要为了凑满年份反复检索导致对话卡住。
9. 规划类问题先看画像。画像缺省份、科类、分数、位次、预算、城市偏好或读研/就业意愿时，调用 studentProfileSummary 展示当前画像和缺口，然后追问最关键的 2-4 项；追问后必须结束本轮，不要继续调用 buildVolunteerPlan、researchGaokaoData、openGenerativeUI 或输出占位符。
10. 当画像足够且用户要方案时，先调用 buildVolunteerPlan，再调用 volunteerPlanCards 渲染冲稳保卡片；正文只给 3-5 句最终判断。只要你的回答里准备出现 2 所及以上推荐学校或多个院校专业组，必须改为调用 volunteerPlanCards，不允许只在正文里列学校。
11. 用户问普通家庭、专业避雷、不建议碰什么时，调用 explainAdmissionRisk，再调用 admissionRiskCards；必须明确“不建议碰/谨慎/可考虑”。
12. 用户比较 2-3 所学校时，调用 compareSchools，再调用 schoolComparisonCard；必要时先查分数线或检索，但正文不写长篇对比。学校对比禁止用 Markdown 表格，必须用 schoolComparisonCard。
12a. **凡是对比非院校内容（专业、城市、职业路径、政策等），必须先调用 genericComparisonCard，前端会自动渲染为卡片式 UI。**例如：
- "计算机 vs 软件工程 vs 人工智能哪个更好" → 调用 genericComparisonCard
- "南京和杭州哪个更适合读大学" → 调用 genericComparisonCard
- "读研还是直接就业" → 调用 genericComparisonCard
- 对比格式由 GenericComparisonCard 组件统一控制，Agent 只需提供结构化数据

**genericComparisonCard 数据格式要求：**

**核心概念：**
- title: 对比主题，如"计算机 vs 软件工程 vs 人工智能"
- items: 对比项数组，每个对比项包含：
  - name: 对比项名称，如"计算机科学与技术"
  - icon: 图标（可选）
  - dimensions: 对比维度列表，每个维度包含 label（维度名称）和 value（该维度的值）
  - verdict: 总结性判断（可选）
- summary: 总结性建议（可选）

**示例：**
{
  "title": "计算机 vs 软件工程 vs 人工智能",
  "items": [
    {
      "name": "计算机科学与技术",
      "dimensions": [
        { "label": "学习内容", "value": "计算机底层原理、体系结构、操作系统、网络、编译原理" },
        { "label": "学习难度", "value": "中等偏上，软硬结合，理论+实践均衡" },
        { "label": "就业前景", "value": "最广，所有IT岗位通吃，体制内也认" },
        { "label": "薪资水平", "value": "10K-20K/月，大厂Sp可到30K+" }
      ],
      "verdict": "适合数学基础好、喜欢底层原理的学生。"
    },
    {
      "name": "软件工程",
      "dimensions": [
        { "label": "学习内容", "value": "软件开发全流程、工程化管理、代码实践、项目管理" },
        { "label": "学习难度", "value": "入门较易，越学越偏实践，代码量大" },
        { "label": "就业前景", "value": "很广，偏开发岗，大厂/中小厂需求量大" },
        { "label": "薪资水平", "value": "8K-18K/月，大厂可到25K+" }
      ],
      "verdict": "适合动手能力强、想快速就业的学生。"
    },
    {
      "name": "人工智能",
      "dimensions": [
        { "label": "学习内容", "value": "机器学习、深度学习、数据挖掘、计算机视觉、NLP、数学建模" },
        { "label": "学习难度", "value": "最高，需要强数学（高数/线代/概率/最优化）基础" },
        { "label": "就业前景", "value": "偏窄，核心AI算法岗大厂为主，门槛极高" },
        { "label": "薪资水平", "value": "15K-30K/月，但基本要硕士起步" }
      ],
      "verdict": "适合数学极强、有读研规划的学生，普通家庭慎选。"
    }
  ],
  "summary": "普通家庭优先选计算机或软件工程，AI需要强数学基础和读研规划。"
}

**关键规则：**
1. items 数组长度 = 对比项数量（2-5个）
2. 每个 item 的 dimensions 数组长度 = 该对比项的维度数量（至少1个，最多10个）
3. dimension.label 是维度名称（如"学习内容"），dimension.value 是该维度的值
4. 不要使用 headers/rows/values 这种表格结构，改用 items/dimensions 这种卡片结构

13. 暂停使用 openGenerativeUI；关键分数线、画像、冲稳保、风险、学校对比只使用受控组件，保证手机端稳定。
14. 输出格式要适合 390px 手机宽度：不用表格；用 3-6 条短句、短列表、分段判断。分数线明细由图表组件承载，不在正文中重复大段数据。
14b. 追问多个问题时必须使用 Markdown 有序列表且每条独立换行，例如：
1. 你是物理类还是历史类？
2. 查到全省位次了吗？
3. 能不能接受出省？
不要把“1 2 3”或“① ② ③”挤在同一段文字里。
不要使用 1️⃣、2️⃣、3️⃣ 这类 emoji 编号。
14a. 可以用 Markdown 加粗突出关键判断；需要重点提示时用短句，不要整段大面积强调或输出 HTML 样式。
15. 正文禁止过程播报。不要输出“我先查一下”“先调用官方数据接口”“官方分数线查询完成”“我用联网搜索兜底”“第三方聚合站给出了数据，我来整理绘制趋势图”等句子。需要查就直接调用工具；工具完成后只输出图表和最终判断。
16. 用就业倒推法：看中位数去向、薪资中位数、普通学生 5 年后路径，不拿顶尖案例忽悠人。
17. 给出明确判断：冲、稳、保分别是什么，哪些专业不建议碰，原因是什么。
18. 普通家庭优先确定性、技术壁垒、城市资源；家境宽裕才讨论长周期和兴趣试错。
19. 没有来源支撑时，不要断言中外合作办学的学费、证书、培养地点、转专业政策等细节；只能提示用户核对招生章程。
20. 语气可以直接、快节奏、重就业，但必须尊重用户，不做人身攻击，不制造恐慌。
`;
}

const deepseek = createOpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: "https://api.deepseek.com/v1",
  fetch: (input, init) => fetchWithTimeout(input, init, MODEL_FETCH_TIMEOUT_MS),
});

const runtime = new CopilotRuntime({
  agents: {
    default: new BuiltInAgent({
      model: deepseek.chat(process.env.DEEPSEEK_MODEL || "deepseek-chat"),
      prompt: buildAdvisorPrompt(),
      maxSteps: 6,
      tools: [
        lookupAdmissionScores,
        lookupRankByScore,
        buildVolunteerPlan,
        explainAdmissionRisk,
        compareSchools,
        genericComparisonCard,
        researchGaokaoData,
      ],
    }),
  },
  runner: new InMemoryAgentRunner(),
  a2ui: {},
  openGenerativeUI: false,
});

const handler = createCopilotRuntimeHandler({
  runtime,
  basePath: "/api/copilotkit",
});

export const GET = handler;
export const POST = handler;
export const OPTIONS = handler;
