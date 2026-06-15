import type { AgentTask, FollowUpQuestion, ProfileValidationResult, ScoreLineLookupSlots, StudentProfile } from "./types";

const FIELD_LABELS: Record<string, string> = {
  province: "高考省份",
  year: "年份",
  subjectTrack: "科类/选科",
  score: "分数",
  rank: "位次",
  targetCities: "目标城市",
  preferredMajors: "专业偏好",
  familyBudget: "家庭预算",
  riskPreference: "风险偏好",
  acceptPrivate: "是否接受民办",
  acceptSinoForeign: "是否接受中外合作",
  graduatePlan: "读研/就业计划",
  schoolName: "院校名称",
  yearRange: "年份范围",
};

const FOLLOW_UP_OPTIONS: Record<string, FollowUpQuestion["options"]> = {
  province: [
    { label: "江苏", prompt: "我的高考省份是：江苏" },
    { label: "浙江", prompt: "我的高考省份是：浙江" },
    { label: "广东", prompt: "我的高考省份是：广东" },
  ],
  subjectTrack: [
    { label: "物理类", prompt: "我的科类/选科是：物理类" },
    { label: "历史类", prompt: "我的科类/选科是：历史类" },
    { label: "综合改革", prompt: "我的科类/选科是：综合改革" },
  ],
  year: [
    { label: "2025参考", prompt: "请先按 2025 年一分一段和录取数据参考。" },
    { label: "2026", prompt: "我是 2026 年考生。" },
  ],
  score: [
    { label: "补分数", prompt: "我的高考分数是：" },
    { label: "模拟分", prompt: "这是我的模拟/预估分：" },
  ],
  rank: [
    { label: "补位次", prompt: "我的全省位次是：" },
    { label: "先查位次", prompt: "我暂时没有位次，请按我的省份、科类和分数先查询位次。" },
  ],
  targetCities: [
    { label: "留本省", prompt: "我更想留在本省读大学。" },
    { label: "南京", prompt: "我想去的城市是：南京" },
    { label: "不限地区", prompt: "城市和地区不限。" },
  ],
  preferredMajors: [
    { label: "计算机/软件", prompt: "我偏好的专业方向是：计算机、软件工程、人工智能。" },
    { label: "电子/电气", prompt: "我偏好的专业方向是：电子信息、电气、自动化。" },
    { label: "还不确定", prompt: "专业方向还不确定，请先按稳妥就业路径建议。" },
  ],
  familyBudget: [
    { label: "预算从严", prompt: "家里预算比较严格，优先公办和低学费。" },
    { label: "可看中外", prompt: "可以接受中外合作，但要说明学费和回报风险。" },
    { label: "预算充足", prompt: "预算暂时不是主要限制。" },
  ],
  riskPreference: [
    { label: "稳妥", prompt: "风险偏好是：稳妥。" },
    { label: "冲刺", prompt: "风险偏好是：冲刺。" },
    { label: "保守", prompt: "风险偏好是：保守。" },
  ],
  acceptPrivate: [
    { label: "只要公办", prompt: "不接受民办，只考虑公办。" },
    { label: "可接受民办", prompt: "可以接受民办，但要说明费用和风险。" },
  ],
  acceptSinoForeign: [
    { label: "不接受中外", prompt: "不接受中外合作办学。" },
    { label: "可接受中外", prompt: "可以接受中外合作办学，但要看学费和证书。" },
  ],
  graduatePlan: [
    { label: "就业优先", prompt: "本科后倾向直接就业。" },
    { label: "倾向读研", prompt: "本科后倾向读研/保研。" },
    { label: "不确定", prompt: "就业还是读研还不确定。" },
  ],
};

function hasValue(value: unknown) {
  return value !== undefined && value !== "" && (!Array.isArray(value) || value.length > 0);
}

function missingProfileFields(profile: StudentProfile, fields: string[]) {
  return fields.filter((field) => !hasValue(profile[field as keyof StudentProfile]));
}

function makeQuestion(field: string): FollowUpQuestion {
  const label = FIELD_LABELS[field] ?? field;
  const questionByField: Record<string, string> = {
    province: "你是哪个省份参加高考/投档？",
    subjectTrack: "你的科类或选科是什么？",
    year: "这次判断按哪一年数据口径？",
    score: "你的高考分数是多少？",
    rank: "你有全省位次吗？如果没有，我可以先按分数查询参考位次。",
    targetCities: "目标城市或地区有没有偏好？",
    preferredMajors: "你更倾向哪些专业方向？",
    familyBudget: "家庭预算和学费承受能力大概怎样？",
    riskPreference: "志愿方案想偏冲刺、稳妥还是保守？",
    acceptPrivate: "能接受民办院校吗？",
    acceptSinoForeign: "能接受中外合作办学吗？",
    graduatePlan: "本科后更倾向就业、读研，还是还不确定？",
    schoolName: "你要查哪所院校？",
    yearRange: "你想查哪几年？例如近三年或 2025 年。",
  };

  return {
    field,
    question: questionByField[field] ?? `请补充${label}。`,
    options: FOLLOW_UP_OPTIONS[field] ?? [{ label: `补充${label}`, prompt: `我的${label}是：` }],
  };
}

export function buildFollowUpQuestions(fields: string[], limit = 4) {
  return fields.slice(0, limit).map(makeQuestion);
}

export function validateProfileForTask(
  profile: StudentProfile,
  task: AgentTask,
  slots: ScoreLineLookupSlots = {},
): ProfileValidationResult {
  const warnings: string[] = [];
  const suggestedFields: string[] = [];
  let missingFields: string[] = [];

  if (task === "volunteer_plan") {
    missingFields = missingProfileFields(profile, ["province", "subjectTrack"]);
    if (!hasValue(profile.score) && !hasValue(profile.rank)) missingFields.push("score");
    suggestedFields.push(
      ...missingProfileFields(profile, [
        "year",
        "targetCities",
        "preferredMajors",
        "riskPreference",
        "acceptPrivate",
        "acceptSinoForeign",
        "graduatePlan",
        "familyBudget",
      ]),
    );
    if (!hasValue(profile.rank) && hasValue(profile.score)) suggestedFields.unshift("rank");
  }

  if (task === "score_line_lookup") {
    if (!slots.schoolName) missingFields.push("schoolName");
    if (!(slots.province ?? profile.province)) missingFields.push("province");
    if (!(slots.subjectTrack ?? profile.subjectTrack)) missingFields.push("subjectTrack");
    if (!slots.yearRange?.length) missingFields.push("yearRange");
  }

  if (task === "rank_lookup") {
    missingFields = missingProfileFields(profile, ["province", "subjectTrack", "score"]);
    if (!hasValue(profile.year)) {
      warnings.push("未提供年份时，自动补位次只能按 2025 一分一段参考口径处理。");
      suggestedFields.push("year");
    }
  }

  const orderedMissing = Array.from(new Set(missingFields));
  const orderedSuggested = Array.from(new Set(suggestedFields.filter((field) => !orderedMissing.includes(field))));
  const questionFields =
    task === "volunteer_plan"
      ? [...orderedMissing, ...orderedSuggested.filter((field) => field === "year" || field === "rank")]
      : orderedMissing;

  return {
    ok: orderedMissing.length === 0,
    missingFields: orderedMissing,
    suggestedFields: orderedSuggested,
    nextQuestions: buildFollowUpQuestions(questionFields),
    warnings,
  };
}

export function fieldLabel(field: string) {
  return FIELD_LABELS[field] ?? field;
}
