import { describe, expect, it } from "vitest";
import { extractStudentProfilePatch } from "../profile-extractor";
import { routeAgentTurn } from "../tool-router";

describe("gaokao agent tool router", () => {
  it("does not recommend directly when the profile lacks province and subject track", () => {
    const decision = routeAgentTurn({ userMessage: "我 580 分能上什么大学？" });

    expect(decision.detectedIntent).toBe("volunteer_plan");
    expect(decision.mustAskFollowUp).toBe(true);
    expect(decision.requiredTools).not.toContain("buildVolunteerPlan");
    expect(decision.requiredUiComponents).toEqual(["studentProfileSummary", "followUpQuestionOptions"]);
    expect(decision.missingFields).toEqual(expect.arrayContaining(["province", "subjectTrack"]));
    expect(decision.nextQuestions.map((item) => item.field)).toEqual(
      expect.arrayContaining(["province", "subjectTrack", "year", "rank"]),
    );
  });

  it("routes school score-line trend lookups to admission lookup and trend chart", () => {
    const decision = routeAgentTurn({ userMessage: "苏州大学江苏物理类近三年分数线" });

    expect(decision.detectedIntent).toBe("score_line_lookup");
    expect(decision.selectedTool).toBe("lookupAdmissionScores");
    expect(decision.requiredUiComponents).toContain("scoreLineTrendChart");
    expect(decision.scoreLineLookup).toMatchObject({
      schoolName: "苏州大学",
      province: "江苏",
      subjectTrack: "物理类",
      yearRange: [2023, 2024, 2025],
    });
  });

  it("routes score-to-rank questions to lookupRankByScore", () => {
    const decision = routeAgentTurn({ userMessage: "江苏物理类 2025 年 590 分大概多少位次？" });

    expect(decision.detectedIntent).toBe("rank_lookup");
    expect(decision.selectedTool).toBe("lookupRankByScore");
    expect(decision.profileSnapshot).toMatchObject({
      province: "江苏",
      year: 2025,
      subjectTrack: "物理类",
      score: 590,
    });
  });

  it("extracts exam province from compact score phrasing", () => {
    const patch = extractStudentProfilePatch("海南考了610，帮我看看位次和学校");
    const decision = routeAgentTurn({ userMessage: "海南考了610，帮我看看位次和学校" });

    expect(patch).toMatchObject({
      province: "海南",
      score: 610,
    });
    expect(decision.profileSnapshot).toMatchObject({
      province: "海南",
      subjectTrack: "综合改革",
      score: 610,
    });
  });

  it("extracts province from assistant-style rank result text", () => {
    const patch = extractStudentProfilePatch("海南2025年 610分 → 参考位次约10420名");

    expect(patch).toMatchObject({
      province: "海南",
      year: 2025,
      score: 610,
      rank: 10420,
    });
  });

  it("extracts profile and schedules rank hydration before volunteer planning", () => {
    const patch = extractStudentProfilePatch("我是江苏物理类 590 分，想去南京，帮我做志愿方案。");
    const decision = routeAgentTurn({ userMessage: "我是江苏物理类 590 分，想去南京，帮我做志愿方案。" });

    expect(patch).toMatchObject({
      province: "江苏",
      subjectTrack: "物理类",
      score: 590,
      targetCities: ["南京"],
    });
    expect(decision.detectedIntent).toBe("volunteer_plan");
    expect(decision.selectedTool).toBe("lookupRankByScore");
    expect(decision.requiredTools).toEqual(["lookupRankByScore", "buildVolunteerPlan"]);
    expect(decision.requiredUiComponents).toContain("volunteerPlanCards");
  });

  it("routes 2-school comparisons to compareSchools and schoolComparisonCard", () => {
    const decision = routeAgentTurn({ userMessage: "苏州大学和南京邮电大学哪个更适合我？" });

    expect(decision.detectedIntent).toBe("school_comparison");
    expect(decision.selectedTool).toBe("compareSchools");
    expect(decision.requiredUiComponents).toContain("schoolComparisonCard");
    expect(decision.schools).toEqual(["苏州大学", "南京邮电大学"]);
  });

  it("routes major comparisons to genericComparisonCard", () => {
    const decision = routeAgentTurn({ userMessage: "计算机、软件工程、人工智能怎么选？" });

    expect(decision.detectedIntent).toBe("major_comparison");
    expect(decision.selectedTool).toBe("genericComparisonCard");
    expect(decision.requiredUiComponents).toContain("genericComparisonCard");
  });

  it("routes ordinary-family risk questions to admission risk cards", () => {
    const decision = routeAgentTurn({ userMessage: "普通家庭有哪些专业不建议碰？" });

    expect(decision.detectedIntent).toBe("major_risk");
    expect(decision.selectedTool).toBe("explainAdmissionRisk");
    expect(decision.requiredUiComponents).toContain("admissionRiskCards");
  });

  it("routes enrollment-plan questions to lookupEnrollmentPlan", () => {
    const decision = routeAgentTurn({ userMessage: "2026 苏州大学江苏物理类招几人？学费多少？" });

    expect(decision.detectedIntent).toBe("enrollment_plan_lookup");
    expect(decision.selectedTool).toBe("lookupEnrollmentPlan");
    expect(decision.requiredTools).toContain("lookupEnrollmentPlan");
    expect(decision.profileSnapshot).toMatchObject({
      province: "江苏",
      year: 2026,
      subjectTrack: "物理类",
    });
  });

  it("routes admission restriction questions to lookupAdmissionRequirements", () => {
    const decision = routeAgentTurn({ userMessage: "苏州大学计算机专业有色盲限制吗？招生章程怎么说？" });

    expect(decision.detectedIntent).toBe("admission_requirements_lookup");
    expect(decision.selectedTool).toBe("lookupAdmissionRequirements");
    expect(decision.requiredTools).toContain("lookupAdmissionRequirements");
  });

  it("routes minimum-rank trend questions to lookupAdmissionRankTrend", () => {
    const decision = routeAgentTurn({ userMessage: "苏州大学江苏物理类近三年最低位次趋势" });

    expect(decision.detectedIntent).toBe("admission_rank_trend");
    expect(decision.selectedTool).toBe("lookupAdmissionRankTrend");
    expect(decision.requiredTools).toContain("lookupAdmissionRankTrend");
    expect(decision.scoreLineLookup).toMatchObject({
      schoolName: "苏州大学",
      province: "江苏",
      subjectTrack: "物理类",
      yearRange: [2023, 2024, 2025],
    });
  });

  it("routes volunteer-list validation requests to validateVolunteerList", () => {
    const decision = routeAgentTurn({
      userMessage: "我是江苏物理类 590 分，帮我检查这份志愿表：苏州大学、江苏大学、南通大学。",
    });

    expect(decision.detectedIntent).toBe("volunteer_list_validation");
    expect(decision.selectedTool).toBe("validateVolunteerList");
    expect(decision.requiredTools).toContain("validateVolunteerList");
  });
});
