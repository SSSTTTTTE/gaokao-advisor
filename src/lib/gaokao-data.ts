import { lookupAdmissionScoresFromVault } from "./gaokao-vault-data";

export type AdmissionScoreRow = {
  year: number;
  schoolName: string;
  province: string;
  subjectTrack: string;
  groupName: string;
  majorName: string;
  maxScore: number;
  minScore: number;
  averageScore: number;
  rank: number;
  sourceId: string;
};

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

export type AdmissionScorePoint = {
  year: number;
  score: number;
  rank: number;
  groupName: string;
  majorName: string;
  sourceId: string;
};

export type AdmissionSource = {
  id: string;
  title: string;
  url: string;
  publisher: string;
  kind: "official_school" | "official_exam_authority" | "mcp" | "search" | "gaokao_vault";
};

export type AdmissionLookupResult = {
  status: "ok" | "partial" | "needs_data_source" | "error";
  schoolName: string;
  province: string;
  subjectTrack: string;
  yearRange: number[];
  queryType: "overallTrend" | "groupComparison";
  rows: AdmissionScoreRow[];
  chartPoints: AdmissionScorePoint[];
  sources: AdmissionSource[];
  freshness: string;
  warnings: string[];
  message?: string;
};

const SUZHOU_UNIVERSITY_HISTORY_URL = "https://zsb.suda.edu.cn/markHistory.aspx";
const JIANGSU_2025_PHYSICS_URL =
  "https://www.jseea.cn/webfile/index/index_zkxx/2025-07-18/7351781448019349504.html";
const JIANGSU_2025_PHYSICS_PDF_URL =
  "https://www.jseea.cn/webfile/upload/2025/07-18/09-33-5302461102655621.pdf";
const JIANGSU_2025_HISTORY_URL =
  "https://www.jseea.cn/webfile/index/index_zkxx/2025-07-18/7351781284785426432.html";
const JIANGSU_2025_HISTORY_PDF_URL =
  "https://www.jseea.cn/webfile/upload/2025/07-18/09-33-380724-1917118608.pdf";
const SOUTHEAST_UNIVERSITY_SCORE_LIST_URL = "https://zsb.seu.edu.cn/23657/listm.htm";
const JIANGSU_UNIVERSITY_SCORE_LIST_URL = "https://zb.ujs.edu.cn/lnfs.htm";
const JIANGSU_UNIVERSITY_JIANGSU_LIST_URL =
  "https://zb.ujs.edu.cn/list.jsp?urltype=tree.TreeTempUrl&wbtreeid=1110";
const NJUST_SCORE_URL = "https://zsb.njust.edu.cn/lqjh_fsx";
const NJUST_SCORE_API_URL = "https://zsb.njust.edu.cn/lqScore/initDateWebCon";
const BING_SEARCH_ENDPOINT = "https://www.bing.com/search";
const SO_SEARCH_ENDPOINT = "https://www.so.com/s";

const PROVINCE_NAMES = [
  "北京市",
  "天津市",
  "河北省",
  "山西省",
  "内蒙古自治区",
  "辽宁省",
  "吉林省",
  "黑龙江省",
  "上海市",
  "江苏省",
  "浙江省",
  "安徽省",
  "福建省",
  "江西省",
  "山东省",
  "河南省",
  "湖北省",
  "湖南省",
  "广东省",
  "广西壮族自治区",
  "海南省",
  "重庆市",
  "四川省",
  "贵州省",
  "云南省",
  "西藏自治区",
  "陕西省",
  "甘肃省",
  "青海省",
  "宁夏回族自治区",
  "新疆维吾尔自治区",
];

const SOUTHEAST_UNIVERSITY_SCORE_PAGES: Record<number, string> = {
  2024: "https://zsb.seu.edu.cn/2025/0407/c23657a524104/pagem.htm",
  2023: "https://zsb.seu.edu.cn/2024/0312/c23657a483794/pagem.htm",
};

const JIANGSU_UNIVERSITY_SCORE_PAGES: Record<number, string> = {
  2025: "https://zb.ujs.edu.cn/info/1110/15268.htm",
  2024: "https://zb.ujs.edu.cn/info/1110/13748.htm",
  2023: "https://zb.ujs.edu.cn/info/1110/11858.htm",
};

type SupportedSchool = "苏州大学" | "东南大学" | "江苏大学" | "南京理工大学";

const pdfTextCache = new Map<string, Promise<string>>();

function decodeHtml(text: string) {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function htmlToLines(html: string) {
  return decodeHtml(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<(br|\/p|\/tr|\/td|\/th|\/li|\/div|\/a|\/h\d)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function asScore(value: string | undefined) {
  if (!value || !/^\d+(\.\d+)?$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : null;
}

function normalizeSubjectTrack(value: string) {
  if (value.includes("物理")) return "物理类";
  if (value.includes("历史")) return "历史类";
  if (value.includes("文")) return "历史类";
  if (value.includes("理")) return "物理类";
  return value.trim();
}

function matchesSubject(rowSubject: string, requestedSubject: string) {
  const normalizedRequest = normalizeSubjectTrack(requestedSubject);
  const trimmedRow = rowSubject.trim();

  if (normalizedRequest === "物理类") {
    return trimmedRow === "物理类" || trimmedRow === "物理" || trimmedRow === "理科";
  }

  if (normalizedRequest === "历史类") {
    return trimmedRow === "历史类" || trimmedRow === "历史" || trimmedRow === "文科";
  }

  return normalizeSubjectTrack(trimmedRow) === normalizedRequest;
}

function identifySupportedSchool(schoolName: string): SupportedSchool | null {
  if (schoolName.includes("苏州大学")) return "苏州大学";
  if (schoolName.includes("东南大学")) return "东南大学";
  if (schoolName.includes("江苏大学")) return "江苏大学";
  if (schoolName.includes("南京理工大学")) return "南京理工大学";
  return null;
}

function sourceUrlForSubject(subjectTrack: string) {
  if (normalizeSubjectTrack(subjectTrack) === "历史类") {
    return {
      pageUrl: JIANGSU_2025_HISTORY_URL,
      pdfUrl: JIANGSU_2025_HISTORY_PDF_URL,
      title: "江苏省教育考试院：2025 普通类本科批次投档线（历史等科目类）",
      pdfTitle: "江苏省教育考试院 2025 历史类投档线 PDF",
    };
  }

  return {
    pageUrl: JIANGSU_2025_PHYSICS_URL,
    pdfUrl: JIANGSU_2025_PHYSICS_PDF_URL,
    title: "江苏省教育考试院：2025 普通类本科批次投档线（物理等科目类）",
    pdfTitle: "江苏省教育考试院 2025 物理类投档线 PDF",
  };
}

function jiangsuExamAuthoritySources(subjectTrack: string): AdmissionSource[] {
  const subjectSource = sourceUrlForSubject(subjectTrack);
  return [
    {
      id: "jseea-2025-batch-line",
      title: subjectSource.title,
      url: subjectSource.pageUrl,
      publisher: "江苏省教育考试院",
      kind: "official_exam_authority",
    },
    {
      id: "jseea-2025-batch-line-pdf",
      title: subjectSource.pdfTitle,
      url: subjectSource.pdfUrl,
      publisher: "江苏省教育考试院",
      kind: "official_exam_authority",
    },
  ];
}

function inferSubjectFromMajor(majorName: string) {
  if (/文科|英语|法学|公共事业管理|工商管理|国际经济|汉语|汉语言|会计学|金融学|人力资源|日语|物流|知识产权|社会工作|语言学|政治/.test(majorName)) {
    return "历史类";
  }

  return "物理类";
}

function isOrdinaryBatch(batchName: string) {
  return /普通批|本科一批|本科批|普通类/.test(batchName);
}

function provinceSegment(lines: string[], province: string) {
  const normalizedProvince = province.endsWith("省") || province.endsWith("市") ? province : `${province}省`;
  const start = lines.findIndex((line) => line === normalizedProvince || line === province);
  if (start < 0) return [];

  const end = lines.findIndex((line, index) => {
    return index > start && PROVINCE_NAMES.includes(line);
  });

  return lines.slice(start + 1, end > start ? end : lines.length);
}

function isScoreToken(value: string | undefined) {
  return asScore(value) !== null;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function suzhouMajorScoreUrl(year: number, province: string) {
  const provinceId = province.includes("江苏") ? 10 : 10;
  const title = `${year}年${province}各专业录取分数一览表`;
  return `https://zsb.suda.edu.cn/view_markhistory.aspx?aa=${encodeURIComponent(
    title,
  )}&aid=${provinceId}&ay=${year}`;
}

function splitMajorAndGroup(rawName: string) {
  const [majorPart, groupPart = ""] = rawName.split("--");
  const cleanedGroup = groupPart
    .replace(/选考/g, "")
    .replace(/[，。]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return {
    majorName: majorPart.trim(),
    groupName: cleanedGroup || "未标明专业组",
  };
}

async function fetchText(url: string) {
  const response = await fetchWithTimeout(url, {
    cache: "no-store",
    headers: {
      "user-agent":
        "Mozilla/5.0 (compatible; GaokaoMajorAdvisor/1.0; +https://github.com/CopilotKit/CopilotKit)",
    },
  });

  if (!response.ok) {
    throw new Error(`Official source returned ${response.status}: ${url}`);
  }

  return response.text();
}

function stripSearchHtml(value: string) {
  return decodeHtml(value)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeSearchUrl(url: string, baseUrl: string) {
  const decoded = decodeHtml(url);
  if (/^https?:\/\//.test(decoded)) return decoded;
  if (decoded.startsWith("/")) return new URL(decoded, baseUrl).toString();
  return "";
}

function extractBingResults(html: string) {
  const results: Array<{ title: string; url: string; content: string }> = [];
  const blocks = html.match(/<li class="b_algo"[\s\S]*?<\/li>/gi) ?? [];

  for (const block of blocks) {
    const linkMatch = block.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h2>/i);
    if (!linkMatch) continue;
    const url = decodeHtml(linkMatch[1]);
    if (!/^https?:\/\//.test(url)) continue;

    const snippetMatch =
      block.match(/<p[^>]*>([\s\S]*?)<\/p>/i) ??
      block.match(/<div[^>]*class="[^"]*b_caption[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    results.push({
      title: stripSearchHtml(linkMatch[2]),
      url,
      content: snippetMatch ? stripSearchHtml(snippetMatch[1]) : "",
    });
    if (results.length >= 8) break;
  }

  return results;
}

function extractSoResults(html: string) {
  const results: Array<{ title: string; url: string; content: string }> = [];
  const blocks =
    html.match(/<li[^>]*class="[^"]*(?:res-list|result)[^"]*"[\s\S]*?<\/li>/gi) ??
    html.match(/<h3[\s\S]*?<\/h3>[\s\S]{0,1200}/gi) ??
    [];

  for (const block of blocks) {
    const linkMatch = block.match(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;
    const realUrlMatch = block.match(/data-mdurl="([^"]+)"/i);
    const url = normalizeSearchUrl(realUrlMatch?.[1] ?? linkMatch[1], SO_SEARCH_ENDPOINT);
    if (!url || url.includes("javascript:")) continue;

    results.push({
      title: stripSearchHtml(linkMatch[2]),
      url,
      content: stripSearchHtml(block.replace(linkMatch[0], " ")).slice(0, 360),
    });
    if (results.length >= 8) break;
  }

  return results;
}

function looksLikeOfficialAdmissionHistorySource(
  result: { title: string; url: string; content: string },
  schoolName: string,
) {
  const haystack = `${result.title} ${result.url} ${result.content}`.toLowerCase();
  if (!/录取|分数|历年|往年|投档|招生/.test(haystack)) return false;
  if (!haystack.includes(schoolName.toLowerCase()) && !/zsb|bkzs|zs\.|admission|zhaosheng|benke/.test(haystack)) {
    return false;
  }

  try {
    const url = new URL(result.url);
    const hostAndPath = `${url.hostname}${url.pathname}`.toLowerCase();
    const thirdParty =
      /eol\.cn|dxsbb\.com|gaokao\.cn|gaokao\.com|gaosan\.com|gk100\.com|zhiyuan|youzy|baidu\.com|so\.com|sogou\.com/.test(
        hostAndPath,
      );
    if (thirdParty) return false;
    return /\.edu\.cn$|\.edu\.cn\//.test(url.hostname) || /zsb|bkzs|zs\.|admission|zhaosheng|benke/.test(hostAndPath);
  } catch {
    return false;
  }
}

async function discoverOfficialAdmissionHistorySources(args: {
  schoolName: string;
  province: string;
  yearRange: number[];
}) {
  const cacheKey = `${args.schoolName}|${args.province}|${args.yearRange.join(",")}`;
  const queryYear = args.yearRange[args.yearRange.length - 1] ?? 2025;
  const query = `${args.schoolName} 本科招生网 历年分数 ${queryYear} ${args.province} 录取分数线`;
  const providers = [
    {
      endpoint: `${BING_SEARCH_ENDPOINT}?q=${encodeURIComponent(query)}&setlang=zh-CN&mkt=zh-CN`,
      baseUrl: BING_SEARCH_ENDPOINT,
      extract: extractBingResults,
    },
    {
      endpoint: `${SO_SEARCH_ENDPOINT}?q=${encodeURIComponent(query)}`,
      baseUrl: SO_SEARCH_ENDPOINT,
      extract: extractSoResults,
    },
  ];
  const discovered: AdmissionSource[] = [];

  for (const provider of providers) {
    try {
      const response = await fetchWithTimeout(
        provider.endpoint,
        {
          cache: "no-store",
          headers: {
            "accept-language": "zh-CN,zh;q=0.9,en;q=0.7",
            "user-agent":
              "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
          },
        },
        6_000,
      );
      if (!response.ok) continue;

      for (const result of provider.extract(await response.text())) {
        if (!looksLikeOfficialAdmissionHistorySource(result, args.schoolName)) continue;
        if (discovered.some((source) => source.url === result.url)) continue;
        discovered.push({
          id: `official-school-history-${cacheKey}-${discovered.length}`.replace(/[^\w-]/g, "-"),
          title: result.title || `${args.schoolName}招生网历年分数入口`,
          url: result.url,
          publisher: `${args.schoolName}招生网`,
          kind: "official_school",
        });
        if (discovered.length >= 4) break;
      }
    } catch {
      continue;
    }
    if (discovered.length > 0) break;
  }

  return discovered;
}

async function fetchPdfText(url: string) {
  const cached = pdfTextCache.get(url);
  if (cached) return cached;

  const promise = (async () => {
    const response = await fetchWithTimeout(url, {
      cache: "no-store",
      headers: {
        "user-agent":
          "Mozilla/5.0 (compatible; GaokaoMajorAdvisor/1.0; +https://github.com/CopilotKit/CopilotKit)",
      },
    });
    if (!response.ok) throw new Error(`Official PDF returned ${response.status}: ${url}`);

    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: Buffer.from(await response.arrayBuffer()) });
    try {
      const result = await parser.getText();
      return result.text;
    } finally {
      await parser.destroy();
    }
  })();

  pdfTextCache.set(url, promise);
  return promise;
}

async function fetchJiangsuExamAuthorityGroupRows(
  year: number,
  schoolName: string,
  province: string,
  subjectTrack: string,
  sourceId: string,
) {
  if (year !== 2025) return [];

  const pdfUrl = sourceUrlForSubject(subjectTrack).pdfUrl;
  const text = await fetchPdfText(pdfUrl);
  const exactSchoolName = identifySupportedSchool(schoolName) ?? schoolName.trim();
  const rowPattern = new RegExp(
    `^\\d{4}\\s+(${escapeRegExp(exactSchoolName)}\\d{2}专业组[^\\s]*)\\s+(\\d{3})\\b`,
  );
  const rows: AdmissionScoreRow[] = [];

  for (const line of text
    .split(/\n+/)
    .map((item) => item.replace(/\s+/g, " ").trim())
    .filter(Boolean)) {
    const match = line.match(rowPattern);
    if (!match) continue;

    const minScore = asScore(match[2]);
    if (minScore === null) continue;

    rows.push({
      year,
      schoolName: exactSchoolName,
      province,
      subjectTrack,
      groupName: match[1],
      majorName: "院校专业组投档线",
      maxScore: minScore,
      minScore,
      averageScore: -1,
      rank: -1,
      sourceId,
    });
  }

  return rows;
}

async function fetchSuzhouJiangsuMajorRows(
  year: number,
  province: string,
  subjectTrack: string,
  sourceId: string,
) {
  const url = suzhouMajorScoreUrl(year, province);
  const html = await fetchText(url);
  const lines = htmlToLines(html);
  const rows: AdmissionScoreRow[] = [];

  for (let index = 0; index < lines.length - 5; index += 1) {
    const rawName = lines[index];
    const studyLength = lines[index + 1];
    const rowSubject = lines[index + 2];
    const maxScore = asScore(lines[index + 3]);
    const minScore = asScore(lines[index + 4]);
    const averageScore = asScore(lines[index + 5]);

    if (
      !rawName.includes("--") ||
      !/^\d+$/.test(studyLength) ||
      maxScore === null ||
      minScore === null ||
      averageScore === null ||
      !matchesSubject(rowSubject, subjectTrack)
    ) {
      continue;
    }

    const { majorName, groupName } = splitMajorAndGroup(rawName);
    rows.push({
      year,
      schoolName: "苏州大学",
      province,
      subjectTrack: normalizeSubjectTrack(rowSubject),
      groupName,
      majorName,
      maxScore,
      minScore,
      averageScore,
      rank: -1,
      sourceId,
    });
  }

  return rows;
}

async function fetchSoutheastJiangsuMajorRows(
  year: number,
  province: string,
  subjectTrack: string,
  sourceId: string,
) {
  const url = SOUTHEAST_UNIVERSITY_SCORE_PAGES[year];
  if (!url) return [];

  const html = await fetchText(url);
  const lines = provinceSegment(htmlToLines(html), province);
  const rows: AdmissionScoreRow[] = [];

  let index = 0;
  while (index < lines.length - 2) {
    const majorName = lines[index];
    const maxScore = asScore(lines[index + 1]);
    const minScore = asScore(lines[index + 2]);
    if (!majorName || maxScore === null || minScore === null) {
      index += 1;
      continue;
    }

    const inferredSubject = inferSubjectFromMajor(majorName);
    if (!matchesSubject(inferredSubject, subjectTrack)) {
      index += 3;
      continue;
    }

    rows.push({
      year,
      schoolName: "东南大学",
      province,
      subjectTrack: inferredSubject,
      groupName: inferredSubject === "历史类" ? "历史类专业" : "物理类专业",
      majorName,
      maxScore,
      minScore,
      averageScore: -1,
      rank: -1,
      sourceId,
    });

    index += 3;
  }

  return rows;
}

async function fetchJiangsuUniversityJiangsuMajorRows(
  year: number,
  province: string,
  subjectTrack: string,
  sourceId: string,
) {
  const url = JIANGSU_UNIVERSITY_SCORE_PAGES[year];
  if (!url) return [];

  const html = await fetchText(url);
  const lines = htmlToLines(html);
  const headerIndex = lines.findIndex(
    (line, index) =>
      line === "批次" &&
      lines[index + 1] === "专业组" &&
      lines[index + 2] === "专业",
  );
  if (headerIndex < 0) return [];

  const rows: AdmissionScoreRow[] = [];
  let currentBatch = "";
  let currentGroup = "";
  let index = headerIndex + 8;

  while (index < lines.length - 4) {
    const line = lines[index];

    if (/批|专项|中外|地方/.test(line) && !isScoreToken(lines[index + 1])) {
      currentBatch = line;
      index += 1;
      continue;
    }

    if (/^\d{2}（.+）$/.test(line)) {
      currentGroup = line;
      index += 1;
      continue;
    }

    const count = asScore(lines[index + 1]);
    const maxScore = asScore(lines[index + 2]);
    const minScore = asScore(lines[index + 3]);
    const averageScore = asScore(lines[index + 4]);

    if (
      line &&
      currentGroup &&
      count !== null &&
      maxScore !== null &&
      minScore !== null &&
      averageScore !== null
    ) {
      const rowSubject = currentGroup.includes("历史") ? "历史类" : "物理类";
      if (matchesSubject(rowSubject, subjectTrack) && isOrdinaryBatch(currentBatch || "普通批")) {
        rows.push({
          year,
          schoolName: "江苏大学",
          province,
          subjectTrack: rowSubject,
          groupName: currentGroup,
          majorName: line,
          maxScore,
          minScore,
          averageScore,
          rank: -1,
          sourceId,
        });
      }
      index += 5;
      continue;
    }

    index += 1;
  }

  return rows;
}

async function fetchNjustJiangsuMajorRows(
  yearRange: number[],
  province: string,
  subjectTrack: string,
  sourceId: string,
) {
  const url = `${NJUST_SCORE_API_URL}?pageSize=200&rowoffset=0&val1=${encodeURIComponent(
    province,
  )}`;
  const response = await fetchWithTimeout(url, {
    cache: "no-store",
    headers: {
      "user-agent":
        "Mozilla/5.0 (compatible; GaokaoMajorAdvisor/1.0; +https://github.com/CopilotKit/CopilotKit)",
      "x-requested-with": "XMLHttpRequest",
    },
  });
  if (!response.ok) throw new Error(`Official source returned ${response.status}: ${url}`);

  const payload = (await response.json()) as {
    data?: {
      list?: Array<{
        class_name?: string;
        province?: string;
        professional_name?: string;
        year1?: string;
        year2?: string;
        year3?: string;
      }>;
    };
    rows?: Array<{
      class_name?: string;
      province?: string;
      professional_name?: string;
      year1?: string;
      year2?: string;
      year3?: string;
    }>;
  };
  const list = payload.data?.list ?? payload.rows ?? [];
  const yearField: Record<number, "year1" | "year2" | "year3"> = {
    2023: "year1",
    2024: "year2",
    2025: "year3",
  };
  const rows: AdmissionScoreRow[] = [];

  for (const item of list) {
    if (!isOrdinaryBatch(item.class_name ?? "本科一批")) continue;
    const majorName = item.professional_name?.trim();
    if (!majorName) continue;

    const inferredSubject = inferSubjectFromMajor(majorName);
    if (!matchesSubject(inferredSubject, subjectTrack)) continue;

    for (const year of yearRange) {
      const field = yearField[year];
      if (!field) continue;
      const minScore = asScore(item[field]);
      if (minScore === null) continue;

      rows.push({
        year,
        schoolName: "南京理工大学",
        province,
        subjectTrack: inferredSubject,
        groupName: item.class_name || "本科一批",
        majorName,
        maxScore: minScore,
        minScore,
        averageScore: -1,
        rank: -1,
        sourceId,
      });
    }
  }

  return rows;
}

function pointsForOverallTrend(rows: AdmissionScoreRow[]) {
  const rowsByYear = new Map<number, AdmissionScoreRow[]>();
  for (const row of rows) {
    rowsByYear.set(row.year, [...(rowsByYear.get(row.year) ?? []), row]);
  }

  return Array.from(rowsByYear.entries())
    .sort(([a], [b]) => a - b)
    .map(([year, yearRows]) => {
      const lowest = [...yearRows].sort((a, b) => a.minScore - b.minScore)[0];
      return {
        year,
        score: lowest.minScore,
        rank: lowest.rank,
        groupName: "最低门槛",
        majorName: lowest.majorName,
        sourceId: lowest.sourceId,
      };
    });
}

function pointsForGroupComparison(rows: AdmissionScoreRow[]) {
  const groups = new Map<string, AdmissionScoreRow[]>();
  for (const row of rows) {
    const key = `${row.year}-${row.groupName}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }

  return Array.from(groups.values())
    .map((groupRows) => {
      const lowest = [...groupRows].sort((a, b) => a.minScore - b.minScore)[0];
      return {
        year: lowest.year,
        score: lowest.minScore,
        rank: lowest.rank,
        groupName: lowest.groupName,
        majorName: lowest.majorName,
        sourceId: lowest.sourceId,
      };
    })
    .sort((a, b) => a.year - b.year || a.score - b.score || a.groupName.localeCompare(b.groupName));
}

function uniqueYears(yearRange: number[] | undefined) {
  const years = yearRange?.filter((year) => Number.isInteger(year)) ?? [2023, 2024, 2025];
  return Array.from(new Set(years))
    .filter((year) => year >= 2000 && year <= 2030)
    .sort((a, b) => a - b);
}

export async function lookupAdmissionScores(args: {
  schoolName: string;
  province: string;
  subjectTrack: string;
  yearRange?: number[];
  queryType?: "overallTrend" | "groupComparison";
}): Promise<AdmissionLookupResult> {
  const schoolName = args.schoolName.trim();
  const province = args.province.trim() || "江苏";
  const subjectTrack = normalizeSubjectTrack(args.subjectTrack || "物理类");
  const yearRange = uniqueYears(args.yearRange);
  const queryType =
    args.queryType ?? (yearRange.length === 1 ? "groupComparison" : "overallTrend");
  const vaultResult = await lookupAdmissionScoresFromVault({
    schoolName,
    province,
    subjectTrack,
    yearRange,
    queryType,
  });
  if (vaultResult) return vaultResult;

  const supportedSchool = identifySupportedSchool(schoolName);
  const discoveredOfficialSources =
    !supportedSchool || !province.includes("江苏")
      ? await discoverOfficialAdmissionHistorySources({ schoolName, province, yearRange })
      : [];

  if (!province.includes("江苏")) {
    return {
      status: discoveredOfficialSources.length ? "partial" : "needs_data_source",
      schoolName,
      province,
      subjectTrack,
      yearRange,
      queryType,
      rows: [],
      chartPoints: [],
      sources: discoveredOfficialSources,
      freshness: discoveredOfficialSources.length
        ? "已尝试发现院校招生网历年分数官方入口；当前还未对该页面做结构化解析。"
        : "第一阶段官方结构化解析只覆盖江苏普通本科批。",
      warnings: [
        discoveredOfficialSources.length
          ? "已找到疑似学校招生网官方历年分数入口；应继续围绕这些官方页面检索/解析，不要直接使用无来源聚合数据。"
          : "该省份暂未接入结构化解析；可先走联网检索兜底。",
        "学校招生网口径可能是专业录取分，省考试院口径可能是院校专业组投档线，二者不可直接混同。",
      ],
      message: discoveredOfficialSources.length
        ? "Official school admission-history pages were discovered, but no structured rows were parsed yet."
        : "Only Jiangsu province is implemented for the first official parser batch.",
    };
  }

  const sources: AdmissionSource[] = jiangsuExamAuthoritySources(subjectTrack);
  const rows: AdmissionScoreRow[] = [];
  const warnings: string[] = [];

  for (const year of yearRange) {
    if (year !== 2025) {
      continue;
    }

    try {
      rows.push(
        ...(await fetchJiangsuExamAuthorityGroupRows(
          year,
          schoolName,
          province,
          subjectTrack,
          "jseea-2025-batch-line-pdf",
        )),
      );
    } catch (error) {
      warnings.push(
        `${year} 年江苏考试院 ${subjectTrack} 投档线 PDF 解析失败：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  if (!supportedSchool) {
    const chartPoints =
      queryType === "groupComparison"
        ? pointsForGroupComparison(rows)
        : pointsForOverallTrend(rows);

    if (rows.length > 0) {
      return {
        status: warnings.length ? "partial" : "ok",
        schoolName,
        province,
        subjectTrack,
        yearRange,
        queryType,
        rows,
        chartPoints,
        sources: [...sources, ...discoveredOfficialSources],
        freshness:
          "实时读取江苏省教育考试院 2025 普通类本科批次投档线 PDF；这是院校专业组投档线口径。",
        warnings: [
          ...warnings,
          "暂未内置该学校招生网专业录取分解析；当前图表只代表江苏考试院院校专业组投档线，不等同于各专业录取最低分。",
          "考试院 PDF 不披露最低位次，rank 使用 -1。",
        ],
      };
    }

    return {
      status: discoveredOfficialSources.length ? "partial" : "needs_data_source",
      schoolName,
      province,
      subjectTrack,
      yearRange,
      queryType,
      rows: [],
      chartPoints: [],
      sources: [...sources, ...discoveredOfficialSources],
      freshness:
        discoveredOfficialSources.length
          ? "已接入江苏省教育考试院 2025 投档线入口，并发现疑似学校招生网历年分数入口；学校官网页面尚未结构化解析。"
          : "已接入江苏省教育考试院 2025 投档线入口作为官方优先来源；该学校官网结构化解析尚未适配。",
      warnings: [
        discoveredOfficialSources.length
          ? "暂未内置该学校的招生网结构化解析器；应继续调用 researchGaokaoData 围绕 sources 中的学校招生网入口提取可核验分数。"
          : "暂未内置该学校的招生网结构化解析器，应继续调用 researchGaokaoData 检索学校招生网、江苏考试院 PDF 或可核验第三方聚合页。",
        "江苏考试院口径是院校专业组投档线，不等同于学校各专业录取最低分。",
      ],
      message: "No school-specific parser is currently available for this school.",
    };
  }

  if (supportedSchool === "苏州大学") {
    sources.push({
      id: "suda-history",
      title: "苏州大学本科招生网：历年分数查询",
      url: SUZHOU_UNIVERSITY_HISTORY_URL,
      publisher: "苏州大学本科招生办公室",
      kind: "official_school",
    });

    for (const year of yearRange) {
      const sourceId = `suda-jiangsu-major-${year}`;
      sources.push({
        id: sourceId,
        title: `苏州大学本科招生网：${year}年${province}各专业录取分数一览表`,
        url: suzhouMajorScoreUrl(year, province),
        publisher: "苏州大学本科招生办公室",
        kind: "official_school",
      });

      try {
        rows.push(...(await fetchSuzhouJiangsuMajorRows(year, province, subjectTrack, sourceId)));
      } catch (error) {
        warnings.push(
          `${year} 年苏州大学 ${province}${subjectTrack} 官方分数解析失败：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  if (supportedSchool === "东南大学") {
    sources.push({
      id: "seu-score-list",
      title: "东南大学本科招生网：往年分数",
      url: SOUTHEAST_UNIVERSITY_SCORE_LIST_URL,
      publisher: "东南大学本科招生办公室",
      kind: "official_school",
    });

    for (const year of yearRange) {
      const pageUrl = SOUTHEAST_UNIVERSITY_SCORE_PAGES[year];
      if (!pageUrl) {
        warnings.push(
          `${year} 年东南大学 ${province}${subjectTrack} 学校官网结构化页面暂未适配；应结合江苏考试院投档线或联网检索兜底。`,
        );
        continue;
      }

      const sourceId = `seu-jiangsu-major-${year}`;
      sources.push({
        id: sourceId,
        title: `东南大学本科招生网：${year}年${province}专业录取分数`,
        url: pageUrl,
        publisher: "东南大学本科招生办公室",
        kind: "official_school",
      });

      try {
        rows.push(...(await fetchSoutheastJiangsuMajorRows(year, province, subjectTrack, sourceId)));
      } catch (error) {
        warnings.push(
          `${year} 年东南大学 ${province}${subjectTrack} 官方分数解析失败：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  if (supportedSchool === "江苏大学") {
    sources.push(
      {
        id: "ujs-score-list",
        title: "江苏大学本科招生网：历年分数",
        url: JIANGSU_UNIVERSITY_SCORE_LIST_URL,
        publisher: "江苏大学本科招生办公室",
        kind: "official_school",
      },
      {
        id: "ujs-jiangsu-score-list",
        title: "江苏大学本科招生网：江苏省历年录取分数",
        url: JIANGSU_UNIVERSITY_JIANGSU_LIST_URL,
        publisher: "江苏大学本科招生办公室",
        kind: "official_school",
      },
    );

    for (const year of yearRange) {
      const pageUrl = JIANGSU_UNIVERSITY_SCORE_PAGES[year];
      if (!pageUrl) {
        warnings.push(`${year} 年江苏大学 ${province}${subjectTrack} 学校官网页面暂未适配。`);
        continue;
      }

      const sourceId = `ujs-jiangsu-major-${year}`;
      sources.push({
        id: sourceId,
        title: `江苏大学本科招生网：${year}年${province}录取分数`,
        url: pageUrl,
        publisher: "江苏大学本科招生办公室",
        kind: "official_school",
      });

      try {
        rows.push(
          ...(await fetchJiangsuUniversityJiangsuMajorRows(
            year,
            province,
            subjectTrack,
            sourceId,
          )),
        );
      } catch (error) {
        warnings.push(
          `${year} 年江苏大学 ${province}${subjectTrack} 官方分数解析失败：${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  if (supportedSchool === "南京理工大学") {
    const sourceId = "njust-jiangsu-major-2023-2025";
    sources.push(
      {
        id: "njust-score",
        title: "南京理工大学本科招生网：录取计划与分数线",
        url: NJUST_SCORE_URL,
        publisher: "南京理工大学本科招生办公室",
        kind: "official_school",
      },
      {
        id: sourceId,
        title: "南京理工大学本科招生网：录取分数接口",
        url: `${NJUST_SCORE_API_URL}?pageSize=200&rowoffset=0&val1=${encodeURIComponent(
          province,
        )}`,
        publisher: "南京理工大学本科招生办公室",
        kind: "official_school",
      },
    );

    try {
      rows.push(...(await fetchNjustJiangsuMajorRows(yearRange, province, subjectTrack, sourceId)));
    } catch (error) {
      warnings.push(
        `南京理工大学 ${province}${subjectTrack} 官方分数解析失败：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  const chartPoints =
    queryType === "groupComparison" ? pointsForGroupComparison(rows) : pointsForOverallTrend(rows);

  if (rows.length === 0) {
    return {
      status: "needs_data_source",
      schoolName: supportedSchool,
      province,
      subjectTrack,
      yearRange,
      queryType,
      rows: [],
      chartPoints: [],
      sources,
      freshness:
        "已尝试官方来源，但没有解析到可绘图的结构化分数行；应继续用联网检索兜底，不要编造分数。",
      warnings: warnings.length
        ? [
            ...warnings,
            "江苏考试院口径是院校专业组投档线；学校官网口径可能是专业录取分，二者不能混同。",
          ]
        : ["官方页面结构可能变化，或查询条件没有匹配数据。"],
      message: "Official source was reachable, but no rows matched the query.",
    };
  }

  return {
    status: warnings.length ? "partial" : "ok",
    schoolName: supportedSchool,
    province,
    subjectTrack,
    yearRange,
    queryType,
    rows,
    chartPoints,
    sources,
    freshness:
      "实时读取学校招生网结构化页面；江苏省教育考试院 2025 投档线页面/PDF作为官方兜底口径来源。",
    warnings: [
      ...warnings,
      "学校招生网专业录取分与江苏考试院院校专业组投档线口径不同，正式填报前应按招生章程和考试院数据核验。",
      "当前学校官网结构化页多数不披露最低位次，rank 使用 -1。",
      "同一学校多专业组不要强行合并；单年问题优先展示专业组对比，多年问题展示最低门槛趋势。",
    ],
  };
}
