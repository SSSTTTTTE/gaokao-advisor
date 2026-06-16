import { DEFAULT_RANK_REFERENCE_YEAR, extractStudentProfilePatch, mergeStudentProfile, withDerivedStudentProfile } from "./profile-extractor";
import { validateProfileForTask } from "./tool-policy";
import type { AgentIntent, RouterDecision, ScoreLineLookupSlots, StudentProfile, ToolName, UiComponentName } from "./types";

const SCHOOL_PATTERN = /[\u4e00-\u9fa5]{2,24}(?:大学|学院|职业技术大学|职业学院|高等专科学校|学校)/g;

const MAJOR_KEYWORDS = [
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

function unique(items: string[], limit = 8) {
  return Array.from(new Set(items.map((item) => item.trim()).filter(Boolean))).slice(0, limit);
}

export function extractSchools(message: string) {
  const segmentMatches = message
    .split(/和|跟|与|、|,|，|vs|VS|哪个|哪所|更适合|更好|比较|对比|还是/)
    .flatMap((segment) => segment.match(SCHOOL_PATTERN) ?? []);
  const matches = segmentMatches.length ? segmentMatches : (message.match(SCHOOL_PATTERN) ?? []);
  return unique(matches.map((item) => item.replace(/^(和|跟|与|对比)/, "")), 4);
}

export function extractMajorItems(message: string) {
  const compact = message.replace(/\s+/g, "");
  return unique(MAJOR_KEYWORDS.filter((item) => compact.includes(item)), 5);
}

function extractYearRange(message: string, profile: StudentProfile): number[] | undefined {
  const compact = message.replace(/\s+/g, "");
  if (/近三年|最近三年|三年|3年/.test(compact)) return [2023, 2024, 2025];
  if (/近五年|最近五年|五年|5年/.test(compact)) return [2021, 2022, 2023, 2024, 2025];
  const years = unique((compact.match(/20\d{2}/g) ?? [])).map(Number).filter((year) => year >= 2000 && year <= 2030);
  if (years.length) return years;
  if (profile.year && /分数线|投档线|录取线|最低分|趋势|走势|历年/.test(compact)) return [profile.year];
  if (/2025|本科A|本科批|今年/.test(compact)) return [2025];
  return undefined;
}

function detectScoreLineSlots(message: string, profile: StudentProfile): ScoreLineLookupSlots {
  const schools = extractSchools(message);
  const patch = extractStudentProfilePatch(message);
  const yearRange = extractYearRange(message, profile);
  return {
    schoolName: schools[0],
    province: patch.province ?? profile.province,
    subjectTrack: patch.subjectTrack ?? profile.subjectTrack,
    yearRange,
  };
}

export function detectAgentIntent(message: string, profile: StudentProfile = {}): AgentIntent {
  const compact = message.replace(/\s+/g, "");
  const schools = extractSchools(message);
  const majors = extractMajorItems(message);
  if (/(检查志愿表|校验志愿|志愿表检查|帮我检查|看看这份志愿|志愿清单|志愿梯度)/.test(compact)) {
    return "volunteer_list_validation";
  }

  const hasSchoolCompareSignal = schools.length >= 2 && /(哪个|哪所|比较|对比|适合|更好|怎么选|还是|和|跟|与|vs|VS)/.test(compact);
  if (hasSchoolCompareSignal) return "school_comparison";

  if (/(普通家庭|家里普通|避坑|避雷|不建议|别碰|慎选|哪些专业不建议|不要碰)/.test(compact)) {
    return "major_risk";
  }

  if (schools.length >= 1 && /(位次趋势|最低位次趋势|近三年位次|近五年位次|位次线|排位趋势)/.test(compact)) {
    return "admission_rank_trend";
  }

  if (/(招生章程|录取规则|专业级差|分数优先|专业优先|调剂规则|服从调剂|体检|色盲|色弱|限报|政审|口试|单科|外语要求|选科要求)/.test(compact)) {
    return "admission_requirements_lookup";
  }

  if (/(招生计划|招几人|招多少人|计划数|招生人数|学费|学制|校区|专业代码|院校代码)/.test(compact)) {
    return "enrollment_plan_lookup";
  }

  const hasScoreLineSignal = /(分数线|投档线|录取线|最低分|最低位次|近三年|近五年|历年|趋势|走势|多少分|够不够)/.test(compact);
  if (schools.length >= 1 && hasScoreLineSignal) return "score_line_lookup";

  const hasRankSignal = /(位次|排名|排位|名次|多少名|排多少|一分一段)/.test(compact);
  if (hasRankSignal && (typeof profile.score === "number" || /\d{3}分?/.test(compact))) return "rank_lookup";

  if (/(推荐学校|推荐大学|能上什么大学|能去什么大学|能上哪|能去哪|帮我做志愿|志愿方案|冲稳保|报什么大学|怎么报志愿|做方案)/.test(compact)) {
    return "volunteer_plan";
  }

  if (majors.length >= 2 && /(怎么选|哪个|比较|对比|区别|还是|和|跟|与|vs|VS)/.test(compact)) {
    return "major_comparison";
  }

  if (/(政策|招生章程|就业|薪资|工资|最新|官方|阳光高考|招生计划|选科要求)/.test(compact)) {
    return "policy_research";
  }

  if (!profile.province || !profile.subjectTrack || (!profile.score && !profile.rank)) {
    if (/\d{3}分?|我是|考生|想去|想学|不接受|预算|普通家庭/.test(compact)) return "profile_collection";
  }

  return "general_explanation";
}

function decisionForMissing(
  detectedIntent: AgentIntent,
  profilePatch: Partial<StudentProfile>,
  profileSnapshot: StudentProfile,
  schools: string[],
  majors: string[],
  validation: ReturnType<typeof validateProfileForTask>,
  reason: string,
): RouterDecision {
  return {
    detectedIntent,
    selectedTool: undefined,
    requiredTools: [],
    requiredUiComponents: ["studentProfileSummary", "followUpQuestionOptions"],
    missingFields: validation.missingFields,
    suggestedFields: validation.suggestedFields,
    nextQuestions: validation.nextQuestions,
    mustAskFollowUp: true,
    reason,
    profilePatch,
    profileSnapshot,
    schools,
    majors,
    warnings: validation.warnings,
  };
}

function completeDecision(args: {
  detectedIntent: AgentIntent;
  selectedTool?: ToolName;
  requiredTools?: ToolName[];
  requiredUiComponents?: UiComponentName[];
  missingFields?: string[];
  suggestedFields?: string[];
  nextQuestions?: RouterDecision["nextQuestions"];
  reason: string;
  profilePatch: Partial<StudentProfile>;
  profileSnapshot: StudentProfile;
  schools: string[];
  majors: string[];
  scoreLineLookup?: ScoreLineLookupSlots;
  warnings?: string[];
}): RouterDecision {
  return {
    detectedIntent: args.detectedIntent,
    selectedTool: args.selectedTool,
    requiredTools: args.requiredTools ?? (args.selectedTool ? [args.selectedTool] : []),
    requiredUiComponents: args.requiredUiComponents ?? [],
    missingFields: args.missingFields ?? [],
    suggestedFields: args.suggestedFields ?? [],
    nextQuestions: args.nextQuestions ?? [],
    mustAskFollowUp: Boolean(args.missingFields?.length),
    reason: args.reason,
    profilePatch: args.profilePatch,
    profileSnapshot: args.profileSnapshot,
    schools: args.schools,
    majors: args.majors,
    scoreLineLookup: args.scoreLineLookup,
    warnings: args.warnings ?? [],
  };
}

export function routeAgentTurn({
  userMessage,
  profile,
}: {
  userMessage: string;
  profile?: StudentProfile;
}): RouterDecision {
  const profilePatch = extractStudentProfilePatch(userMessage);
  const mergedProfile = withDerivedStudentProfile(mergeStudentProfile(profile, profilePatch));

  const schools = extractSchools(userMessage);
  const majors = extractMajorItems(userMessage);
  const detectedIntent = detectAgentIntent(userMessage, mergedProfile);
  const scoreLineLookup = detectScoreLineSlots(userMessage, mergedProfile);

  if (detectedIntent === "volunteer_plan") {
    const validation = validateProfileForTask(mergedProfile, "volunteer_plan");
    if (!validation.ok) {
      return decisionForMissing(
        detectedIntent,
        profilePatch,
        mergedProfile,
        schools,
        majors,
        validation,
        "生成志愿方案前缺少省份、科类或分数/位次，必须先追问。",
      );
    }

    if (!mergedProfile.rank && mergedProfile.score && mergedProfile.province && mergedProfile.subjectTrack) {
      const profileSnapshot = {
        ...mergedProfile,
        year: mergedProfile.year ?? DEFAULT_RANK_REFERENCE_YEAR,
      };
      return completeDecision({
        detectedIntent,
        selectedTool: "lookupRankByScore",
        requiredTools: ["lookupRankByScore", "buildVolunteerPlan"],
        requiredUiComponents: ["volunteerPlanCards"],
        suggestedFields: validation.suggestedFields,
        nextQuestions: validation.nextQuestions,
        reason: "画像达到推荐最低要求，但缺位次；先用 lookupRankByScore 补位次，再生成冲稳保方案。",
        profilePatch,
        profileSnapshot,
        schools,
        majors,
        warnings: validation.warnings,
      });
    }

    return completeDecision({
      detectedIntent,
      selectedTool: "buildVolunteerPlan",
      requiredTools: ["buildVolunteerPlan"],
      requiredUiComponents: ["volunteerPlanCards"],
      suggestedFields: validation.suggestedFields,
      nextQuestions: validation.nextQuestions,
      reason: "画像满足志愿方案最低要求，使用结构化冲稳保工具输出。",
      profilePatch,
      profileSnapshot: mergedProfile,
      schools,
      majors,
      warnings: validation.warnings,
    });
  }

  if (detectedIntent === "score_line_lookup") {
    const validation = validateProfileForTask(mergedProfile, "score_line_lookup", scoreLineLookup);
    if (!validation.ok) {
      return decisionForMissing(
        detectedIntent,
        profilePatch,
        mergedProfile,
        schools,
        majors,
        validation,
        "分数线查询必须明确院校、省份、科类和年份范围。",
      );
    }
    return completeDecision({
      detectedIntent,
      selectedTool: "lookupAdmissionScores",
      requiredTools: ["lookupAdmissionScores"],
      requiredUiComponents: ["scoreLineTrendChart"],
      reason: "涉及分数线、投档线或趋势，必须优先查结构化分数线工具并渲染趋势图。",
      profilePatch,
      profileSnapshot: mergedProfile,
      schools,
      majors,
      scoreLineLookup,
    });
  }

  if (detectedIntent === "rank_lookup") {
    const validation = validateProfileForTask(mergedProfile, "rank_lookup");
    if (!validation.ok) {
      return decisionForMissing(
        detectedIntent,
        profilePatch,
        mergedProfile,
        schools,
        majors,
        validation,
        "分数转位次必须明确省份、科类和分数。",
      );
    }
    return completeDecision({
      detectedIntent,
      selectedTool: "lookupRankByScore",
      requiredTools: ["lookupRankByScore"],
      reason: "用户询问分数对应位次，使用一分一段/结构化位次工具。",
      profilePatch,
      profileSnapshot: mergedProfile,
      schools,
      majors,
      warnings: validation.warnings,
    });
  }

  if (detectedIntent === "enrollment_plan_lookup") {
    return completeDecision({
      detectedIntent,
      selectedTool: "lookupEnrollmentPlan",
      requiredTools: ["lookupEnrollmentPlan"],
      reason: "用户询问招生计划、招生人数、学费、学制、校区或专业代码，必须查询官方招生计划入库数据。",
      profilePatch,
      profileSnapshot: mergedProfile,
      schools,
      majors,
      scoreLineLookup,
    });
  }

  if (detectedIntent === "admission_requirements_lookup") {
    return completeDecision({
      detectedIntent,
      selectedTool: "lookupAdmissionRequirements",
      requiredTools: ["lookupAdmissionRequirements"],
      reason: "用户询问招生章程、录取规则、选科、体检、单科、外语或限报要求，必须查询官方章程/计划规则。",
      profilePatch,
      profileSnapshot: mergedProfile,
      schools,
      majors,
    });
  }

  if (detectedIntent === "admission_rank_trend") {
    return completeDecision({
      detectedIntent,
      selectedTool: "lookupAdmissionRankTrend",
      requiredTools: ["lookupAdmissionRankTrend"],
      reason: "用户询问院校历史最低位次或位次趋势，使用历史投档线和一分一段补齐趋势。",
      profilePatch,
      profileSnapshot: mergedProfile,
      schools,
      majors,
      scoreLineLookup,
    });
  }

  if (detectedIntent === "volunteer_list_validation") {
    return completeDecision({
      detectedIntent,
      selectedTool: "validateVolunteerList",
      requiredTools: ["validateVolunteerList"],
      reason: "用户要求检查志愿表或志愿清单，校验梯度、招生计划、选科和限报风险。",
      profilePatch,
      profileSnapshot: mergedProfile,
      schools,
      majors,
    });
  }

  if (detectedIntent === "school_comparison") {
    return completeDecision({
      detectedIntent,
      selectedTool: "compareSchools",
      requiredTools: ["compareSchools"],
      requiredUiComponents: ["schoolComparisonCard"],
      reason: "用户比较 2-3 所院校，必须使用院校对比工具和卡片组件。",
      profilePatch,
      profileSnapshot: mergedProfile,
      schools,
      majors,
    });
  }

  if (detectedIntent === "major_comparison") {
    return completeDecision({
      detectedIntent,
      selectedTool: "genericComparisonCard",
      requiredTools: ["genericComparisonCard"],
      requiredUiComponents: ["genericComparisonCard"],
      reason: "用户比较专业/路径等非院校内容，必须使用通用对比卡片。",
      profilePatch,
      profileSnapshot: mergedProfile,
      schools,
      majors,
    });
  }

  if (detectedIntent === "major_risk") {
    return completeDecision({
      detectedIntent,
      selectedTool: "explainAdmissionRisk",
      requiredTools: ["explainAdmissionRisk"],
      requiredUiComponents: ["admissionRiskCards"],
      reason: "普通家庭或专业避坑问题必须使用风险分析工具和风险卡片。",
      profilePatch,
      profileSnapshot: mergedProfile,
      schools,
      majors,
    });
  }

  if (detectedIntent === "policy_research") {
    return completeDecision({
      detectedIntent,
      selectedTool: "researchGaokaoData",
      requiredTools: ["researchGaokaoData"],
      reason: "涉及最新政策、就业、薪资或官方信息，结构化库不足时使用联网研究。",
      profilePatch,
      profileSnapshot: mergedProfile,
      schools,
      majors,
    });
  }

  if (detectedIntent === "profile_collection") {
    const validation = validateProfileForTask(mergedProfile, "volunteer_plan");
    return decisionForMissing(
      detectedIntent,
      profilePatch,
      mergedProfile,
      schools,
      majors,
      validation,
      "用户正在补充画像或画像不足，优先展示画像和追问选项。",
    );
  }

  return completeDecision({
    detectedIntent,
    reason: "未命中强工具意图，按一般解释处理；不得编造分数线、位次或录取概率。",
    profilePatch,
    profileSnapshot: mergedProfile,
    schools,
    majors,
  });
}
