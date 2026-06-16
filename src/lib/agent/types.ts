export type GraduatePlan = "就业" | "读研" | "不确定" | "本科就业优先" | "倾向读研/保研";

export type StudentProfile = {
  province?: string;
  year?: number;
  subjectTrack?: string;
  score?: number;
  rank?: number;
  targetCities?: string[];
  preferredMajors?: string[];
  avoidMajors?: string[];
  familyBudget?: string;
  riskPreference?: "冲刺" | "稳妥" | "保守";
  acceptPrivate?: boolean;
  acceptSinoForeign?: boolean;
  graduatePlan?: GraduatePlan | string;
  familyType?: "普通家庭" | "预算充足" | "不确定" | string;

  // Backward-compatible aliases already used by the current UI.
  budget?: string;
  cityPreference?: string;
  canLeaveProvince?: boolean;
  majorPreference?: string[];
  updatedAt?: string;
};

export type AgentIntent =
  | "profile_collection"
  | "score_line_lookup"
  | "rank_lookup"
  | "enrollment_plan_lookup"
  | "admission_requirements_lookup"
  | "admission_rank_trend"
  | "volunteer_list_validation"
  | "volunteer_plan"
  | "school_comparison"
  | "major_comparison"
  | "major_risk"
  | "policy_research"
  | "general_explanation";

export type AgentTask = "volunteer_plan" | "score_line_lookup" | "rank_lookup";

export type ToolName =
  | "lookupAdmissionScores"
  | "lookupRankByScore"
  | "lookupEnrollmentPlan"
  | "lookupAdmissionRequirements"
  | "lookupAdmissionRankTrend"
  | "validateVolunteerList"
  | "researchGaokaoData"
  | "buildVolunteerPlan"
  | "explainAdmissionRisk"
  | "compareSchools"
  | "genericComparisonCard";

export type UiComponentName =
  | "studentProfileSummary"
  | "followUpQuestionOptions"
  | "scoreLineTrendChart"
  | "volunteerPlanCards"
  | "admissionRiskCards"
  | "schoolComparisonCard"
  | "genericComparisonCard";

export type FollowUpOption = {
  label: string;
  value?: string;
  prompt?: string;
};

export type FollowUpQuestion = {
  field?: string;
  question: string;
  options: FollowUpOption[];
};

export type ProfileValidationResult =
  | {
      ok: true;
      missingFields: string[];
      suggestedFields: string[];
      nextQuestions: FollowUpQuestion[];
      warnings: string[];
    }
  | {
      ok: false;
      missingFields: string[];
      suggestedFields: string[];
      nextQuestions: FollowUpQuestion[];
      warnings: string[];
    };

export type ScoreLineLookupSlots = {
  schoolName?: string;
  province?: string;
  subjectTrack?: string;
  yearRange?: number[];
};

export type RouterDecision = {
  detectedIntent: AgentIntent;
  selectedTool?: ToolName;
  requiredTools: ToolName[];
  requiredUiComponents: UiComponentName[];
  missingFields: string[];
  suggestedFields: string[];
  nextQuestions: FollowUpQuestion[];
  mustAskFollowUp: boolean;
  reason: string;
  profilePatch: Partial<StudentProfile>;
  profileSnapshot: StudentProfile;
  schools: string[];
  majors: string[];
  scoreLineLookup?: ScoreLineLookupSlots;
  warnings: string[];
};
