import type { StudentProfile } from "./types";

export const DEFAULT_RANK_REFERENCE_YEAR = 2025;

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

const DEFAULT_COMPREHENSIVE_PROVINCES = new Set(["北京", "天津", "上海", "浙江", "山东", "海南"]);

const CITY_CANDIDATES = [
  "南京",
  "苏州",
  "无锡",
  "常州",
  "上海",
  "杭州",
  "宁波",
  "北京",
  "天津",
  "广州",
  "深圳",
  "武汉",
  "成都",
  "重庆",
  "西安",
  "合肥",
  "长沙",
  "郑州",
  "青岛",
  "厦门",
  "福州",
  "长三角",
  "珠三角",
  "北上广深",
  "省会",
];

const MAJOR_CANDIDATES = [
  "计算机",
  "软件工程",
  "软件",
  "人工智能",
  "电子信息",
  "电子",
  "电气",
  "自动化",
  "通信",
  "机械",
  "医学",
  "临床医学",
  "口腔医学",
  "师范",
  "法学",
  "会计",
  "金融",
  "数学",
  "统计",
  "数据科学",
  "网络安全",
  "土木",
  "材料",
  "化工",
  "生物",
];

function uniqueTextItems(items: string[], limit = 8) {
  return Array.from(new Set(items.map((item) => item.trim()).filter(Boolean))).slice(0, limit);
}

export function normalizeProvinceForAgent(province: string | undefined) {
  return province?.trim().replace(/(壮族自治区|回族自治区|维吾尔自治区|自治区|省|市)$/, "") ?? "";
}

function hasDestinationContext(text: string, candidate: string) {
  const index = text.indexOf(candidate);
  if (index < 0) return false;
  const before = text.slice(Math.max(0, index - 8), index);
  const after = text.slice(index + candidate.length, index + candidate.length + 10);
  return (
    /(想去|要去|想在|希望去|希望在|考虑去|接受去|能去|去|留在|目标|偏好|城市|地区)$/.test(before) ||
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

function extractYear(text: string) {
  const yearMatch = text.match(/(20\d{2})\s*年?/);
  if (yearMatch) {
    const year = Number(yearMatch[1]);
    if (year >= 2000 && year <= 2030) return year;
  }
  if (/今年|本届|应届|2026届/.test(text)) return 2026;
  return undefined;
}

function normalizeSubjectTrack(prompt: string) {
  const lower = prompt.toLowerCase();
  if (/综合|3\+3|zonghe|comprehensive/.test(lower)) return "综合改革";
  if (/物理|理科|physics|science/.test(lower)) return /理科/.test(prompt) ? "理科" : "物理类";
  if (/历史|文科|history|liberal|arts/.test(lower)) return /文科/.test(prompt) ? "文科" : "历史类";
  if (/美术|艺术|设计|书法|音乐|舞蹈|播音|编导|表演/.test(prompt)) {
    const category = prompt.match(/(?:美术|艺术|设计|书法|音乐|舞蹈|播音|编导|表演)[\u4e00-\u9fa5]{0,4}类?/);
    return category?.[0] ?? "艺术类";
  }
  return undefined;
}

function extractDelimitedList(prompt: string, leadPattern: RegExp) {
  const match = prompt.match(leadPattern);
  if (!match?.[1]) return [];
  return uniqueTextItems(
    match[1]
      .split(/[、,，/和或\s]+/)
      .map((item) => item.replace(/方向|专业|城市|地区/g, "").trim())
      .filter((item) => item.length >= 2),
  );
}

export function extractStudentProfilePatch(prompt: string): Partial<StudentProfile> {
  const text = prompt.replace(/\s+/g, "");
  const patch: Partial<StudentProfile> = {};
  const mentionedProvinces = PROVINCE_CANDIDATES.filter((item) => text.includes(item));
  const destinationProvinces = mentionedProvinces.filter((item) => hasDestinationContext(text, item));
  const examProvince = mentionedProvinces.find((item) => hasExamProvinceContext(text, item));
  if (examProvince) patch.province = examProvince;

  const year = extractYear(text);
  if (year) patch.year = year;

  const subjectTrack = normalizeSubjectTrack(prompt);
  if (subjectTrack) patch.subjectTrack = subjectTrack;

  const scoreMatch = text.match(/(?:^|[^\d])(\d{3})(?:分|$|[^\d])/);
  if (scoreMatch) patch.score = Number(scoreMatch[1]);

  const rankMatch = text.match(/(?:位次|排名|排位|名次)[约大概是为:]?(\d{3,8})|(\d{3,8})(?:名|位)/);
  const rankValue = rankMatch?.[1] ?? rankMatch?.[2];
  if (rankValue) patch.rank = Number(rankValue);

  const citySignals = uniqueTextItems([
    ...destinationProvinces,
    ...CITY_CANDIDATES.filter((item) => text.includes(item) && (hasDestinationContext(text, item) || /城市|地区|想去|留在|目标|偏好/.test(text))),
  ]);
  const explicitCities = extractDelimitedList(prompt, /(?:目标城市|目标地区|想去的城市|想去的地区|城市偏好|地区偏好)(?:是|为|:|：)?([^。！？!?]+)/);
  const targetCities = uniqueTextItems([...citySignals, ...explicitCities]);
  if (targetCities.length) {
    patch.targetCities = targetCities;
    patch.cityPreference = targetCities.join("、");
  }
  if (/城市(?:无所谓|都行|不限|不限制)|地区(?:无所谓|都行|不限|不限制)|哪里都行|去哪都行/.test(text)) {
    patch.targetCities = ["不限地区"];
    patch.cityPreference = "不限地区";
  }

  const majorSignals = MAJOR_CANDIDATES.filter((item) => text.includes(item) && !/(不想|别碰|避开|不喜欢|不报|不接受)/.test(text.slice(Math.max(0, text.indexOf(item) - 6), text.indexOf(item) + item.length + 4)));
  const explicitMajors = extractDelimitedList(prompt, /(?:偏好|想学|想读|目标|最好|专业方向是|专业是|方向是)(?:专业|方向)?(?:是|为|:|：)?([^。！？!?]+)/);
  const preferredMajors = uniqueTextItems([...majorSignals, ...explicitMajors].filter((item) => MAJOR_CANDIDATES.some((major) => item.includes(major)) || item.length <= 12));
  if (preferredMajors.length) {
    patch.preferredMajors = preferredMajors;
    patch.majorPreference = preferredMajors;
  }

  const avoidMatches = prompt.match(/(?:避开|别碰|不想学|不喜欢|不报|不建议|不要)([^。！？!?，,]{2,30})/g);
  if (avoidMatches?.length) {
    patch.avoidMajors = uniqueTextItems(
      avoidMatches.map((item) => item.replace(/^(避开|别碰|不想学|不喜欢|不报|不建议|不要)/, "")),
    );
  }

  if (/普通家庭|家里普通|工薪|预算有限|农村|县城/.test(text)) patch.familyType = "普通家庭";
  if (/预算充足|预算够|家里条件还可以|费用不是问题/.test(text)) patch.familyType = "预算充足";
  if (/预算|学费|生活费|中外|合作|钱|费用/.test(text)) {
    const budgetMatch = prompt.match(/(?:预算|学费|生活费|一年|每年|费用)[^，。,.!?？]{0,18}/);
    patch.familyBudget = budgetMatch?.[0]?.trim() || "需控制成本";
    patch.budget = patch.familyBudget;
  }

  if (/不出省|不想出省|留本省|留省内/.test(text)) patch.canLeaveProvince = false;
  if (/可出省|能出省|接受出省|外省|出省无所谓|哪里都行|去哪都行/.test(text)) patch.canLeaveProvince = true;
  if (/不接受民办|不要民办|民办不考虑|不考虑民办|只要公办/.test(text)) patch.acceptPrivate = false;
  if (/接受民办|民办也行|可以民办/.test(text)) patch.acceptPrivate = true;
  if (/不接受中外|不要中外|中外不考虑|不考虑中外/.test(text)) patch.acceptSinoForeign = false;
  if (/接受中外|中外合作也行|可以中外/.test(text)) patch.acceptSinoForeign = true;

  if (/保守|保底|稳妥优先|稳一点/.test(text)) patch.riskPreference = /保守|保底/.test(text) ? "保守" : "稳妥";
  if (/冲刺|想冲|冲一冲/.test(text)) patch.riskPreference = "冲刺";

  if (/考研|读研|保研|研究生/.test(text)) patch.graduatePlan = "读研";
  if (/就业|本科毕业工作|直接工作/.test(text)) patch.graduatePlan = "就业";
  if (/不确定|没想好|还没想好/.test(text)) patch.graduatePlan = "不确定";

  if (Object.keys(patch).length > 0) patch.updatedAt = new Date().toISOString();
  return patch;
}

export function mergeStudentProfile(
  base: StudentProfile | undefined,
  patch: Partial<StudentProfile> | undefined,
): StudentProfile {
  const next: StudentProfile = {
    ...(base ?? {}),
    ...(patch ?? {}),
  };

  const targetCities = patch?.targetCities ?? (patch?.cityPreference ? patch.cityPreference.split(/[、,，]/) : undefined);
  if (targetCities?.length) {
    next.targetCities = uniqueTextItems(targetCities);
    next.cityPreference = next.targetCities.join("、");
  } else if (base?.targetCities?.length) {
    next.targetCities = base.targetCities;
  }

  const preferredMajors = patch?.preferredMajors ?? patch?.majorPreference;
  if (preferredMajors?.length) {
    next.preferredMajors = uniqueTextItems(preferredMajors);
    next.majorPreference = next.preferredMajors;
  } else if (base?.preferredMajors?.length || base?.majorPreference?.length) {
    next.preferredMajors = base.preferredMajors ?? base.majorPreference;
    next.majorPreference = base.majorPreference ?? base.preferredMajors;
  }

  if (patch?.familyBudget || patch?.budget) {
    next.familyBudget = patch.familyBudget ?? patch.budget;
    next.budget = patch.budget ?? patch.familyBudget;
  } else if (base?.familyBudget || base?.budget) {
    next.familyBudget = base.familyBudget ?? base.budget;
    next.budget = base.budget ?? base.familyBudget;
  }

  if (patch?.avoidMajors?.length) next.avoidMajors = uniqueTextItems(patch.avoidMajors);
  else if (base?.avoidMajors?.length) next.avoidMajors = base.avoidMajors;

  return next;
}

export function withDerivedStudentProfile(profile: StudentProfile | undefined): StudentProfile {
  const next = mergeStudentProfile(profile, undefined);
  if (!next.subjectTrack && DEFAULT_COMPREHENSIVE_PROVINCES.has(normalizeProvinceForAgent(next.province))) {
    next.subjectTrack = "综合改革";
  }
  return next;
}

export function buildProfileKeyFacts(patch: Partial<StudentProfile>, prompt: string) {
  const facts: string[] = [];
  if (patch.province) facts.push(`省份：${patch.province}`);
  if (patch.year) facts.push(`年份：${patch.year}`);
  if (patch.subjectTrack) facts.push(`科类：${patch.subjectTrack}`);
  if (typeof patch.score === "number") facts.push(`分数：${patch.score}`);
  if (typeof patch.rank === "number") facts.push(`位次：${patch.rank}`);
  if (patch.targetCities?.length || patch.cityPreference) facts.push(`目标城市：${patch.targetCities?.join("、") ?? patch.cityPreference}`);
  if (patch.preferredMajors?.length || patch.majorPreference?.length) facts.push(`专业偏好：${(patch.preferredMajors ?? patch.majorPreference)?.join("、")}`);
  if (patch.familyBudget || patch.budget) facts.push(`预算：${patch.familyBudget ?? patch.budget}`);
  if (patch.riskPreference) facts.push(`风险偏好：${patch.riskPreference}`);
  if (typeof patch.acceptPrivate === "boolean") facts.push(`接受民办：${patch.acceptPrivate ? "是" : "否"}`);
  if (typeof patch.acceptSinoForeign === "boolean") facts.push(`接受中外合作：${patch.acceptSinoForeign ? "是" : "否"}`);
  if (patch.graduatePlan) facts.push(`毕业计划：${patch.graduatePlan}`);
  if (patch.familyType) facts.push(`家庭类型：${patch.familyType}`);
  if (/今年|高考|2026/.test(prompt)) facts.unshift("时间阶段：2026 高考后志愿准备期");
  return uniqueTextItems(facts);
}

export function getProfileValue(profile: StudentProfile, field: keyof StudentProfile) {
  const value = profile[field];
  if (Array.isArray(value)) return value.join("、");
  if (typeof value === "boolean") return value ? "是" : "否";
  return value === undefined || value === null ? "" : String(value);
}
