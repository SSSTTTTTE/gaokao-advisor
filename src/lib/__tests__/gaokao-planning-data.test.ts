import { afterEach, describe, expect, it } from "vitest";
import {
  lookupAdmissionRankTrendFromVault,
  lookupAdmissionRequirementsFromVault,
  lookupEnrollmentPlanFromVault,
  validateVolunteerListWithVault,
} from "../gaokao-planning-data";

const originalVaultDsn = process.env.GAOKAO_VAULT_DATABASE_URL;
const originalLegacyDsn = process.env.GAOKAO_DB__DSN;

afterEach(() => {
  if (originalVaultDsn === undefined) delete process.env.GAOKAO_VAULT_DATABASE_URL;
  else process.env.GAOKAO_VAULT_DATABASE_URL = originalVaultDsn;
  if (originalLegacyDsn === undefined) delete process.env.GAOKAO_DB__DSN;
  else process.env.GAOKAO_DB__DSN = originalLegacyDsn;
});

function disableVaultDsn() {
  delete process.env.GAOKAO_VAULT_DATABASE_URL;
  delete process.env.GAOKAO_DB__DSN;
}

describe("gaokao planning data", () => {
  it("returns needs_data_source for enrollment plans without a configured database", async () => {
    disableVaultDsn();

    const result = await lookupEnrollmentPlanFromVault({
      province: "江苏",
      year: 2026,
      subjectTrack: "物理类",
      schoolName: "苏州大学",
    });

    expect(result.status).toBe("needs_data_source");
    expect("rows" in result ? result.rows : []).toEqual([]);
    expect(result.warnings.join("")).toContain("不能编造");
  });

  it("returns needs_data_source for admission requirements without a configured database", async () => {
    disableVaultDsn();

    const result = await lookupAdmissionRequirementsFromVault({
      schoolName: "苏州大学",
      year: 2026,
      majorName: "计算机",
    });

    expect(result.status).toBe("needs_data_source");
    expect(result.sources).toEqual([]);
  });

  it("returns needs_data_source for rank trends without a configured database", async () => {
    disableVaultDsn();

    const result = await lookupAdmissionRankTrendFromVault({
      schoolName: "苏州大学",
      province: "江苏",
      subjectTrack: "物理类",
      yearRange: [2023, 2024, 2025],
    });

    expect(result.status).toBe("needs_data_source");
    expect(result.sources).toEqual([]);
  });

  it("falls back to profile-only validation without a configured database", async () => {
    disableVaultDsn();

    const result = await validateVolunteerListWithVault({
      profile: { province: "江苏", subjectTrack: "物理类", score: 590 },
      items: [{ schoolName: "苏州大学", tier: "冲" }],
    });

    expect(result.status).toBe("needs_data_source");
    expect(result.issues.map((issue) => issue.title)).not.toContain("志愿清单为空");
    expect(result.warnings.join("")).toContain("只能做画像完整性检查");
  });
});
