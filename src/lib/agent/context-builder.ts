import type { RouterDecision, StudentProfile } from "./types";

function compactProfile(profile: StudentProfile) {
  return {
    province: profile.province,
    year: profile.year,
    subjectTrack: profile.subjectTrack,
    score: profile.score,
    rank: profile.rank,
    targetCities: profile.targetCities ?? (profile.cityPreference ? [profile.cityPreference] : undefined),
    preferredMajors: profile.preferredMajors ?? profile.majorPreference,
    avoidMajors: profile.avoidMajors,
    familyBudget: profile.familyBudget ?? profile.budget,
    riskPreference: profile.riskPreference,
    acceptPrivate: profile.acceptPrivate,
    acceptSinoForeign: profile.acceptSinoForeign,
    graduatePlan: profile.graduatePlan,
    familyType: profile.familyType,
  };
}

export function buildAgentRouterContext(decision: RouterDecision) {
  return JSON.stringify({
    detectedIntent: decision.detectedIntent,
    selectedTool: decision.selectedTool ?? null,
    requiredTools: decision.requiredTools,
    requiredUiComponents: decision.requiredUiComponents,
    missingFields: decision.missingFields,
    suggestedFields: decision.suggestedFields,
    nextQuestions: decision.nextQuestions,
    mustAskFollowUp: decision.mustAskFollowUp,
    reason: decision.reason,
    profileSnapshot: compactProfile(decision.profileSnapshot),
    scoreLineLookup: decision.scoreLineLookup,
    schools: decision.schools,
    majors: decision.majors,
    warnings: decision.warnings,
  });
}
