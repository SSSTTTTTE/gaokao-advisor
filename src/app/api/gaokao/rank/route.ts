import { NextResponse } from "next/server";
import { z } from "zod";

import { lookupRankByScoreFromVault } from "@/lib/gaokao-vault-data";

export const dynamic = "force-dynamic";

const requestSchema = z.object({
  province: z.string().min(2),
  year: z.number().int().min(2000).max(2030).default(2025),
  subjectTrack: z.string().min(1),
  score: z.number().int().min(0).max(750),
});

function normalizeProvince(province: string) {
  return province.trim().replace(/(省|市)$/, "");
}

function normalizeSubjectTrack(subjectTrack: string, province: string) {
  const value = subjectTrack.trim();
  const lower = value.toLowerCase();
  if (/综合|3\+3|zonghe|comprehensive/.test(lower)) return "综合改革";
  if (/物理|理科|physics|science/.test(lower)) return value.includes("理科") ? "理科" : "物理类";
  if (/历史|文科|history|liberal|arts/.test(lower)) return value.includes("文科") ? "文科" : "历史类";
  if (normalizeProvince(province) === "天津" && /^(普通类|不限|)$/.test(value)) return "综合改革";
  return value;
}

export async function POST(request: Request) {
  let input: z.infer<typeof requestSchema>;
  try {
    input = requestSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ status: "error", message: "Invalid rank request." }, { status: 400 });
  }

  const province = normalizeProvince(input.province);
  const subjectTrack = normalizeSubjectTrack(input.subjectTrack, province);
  const result = await lookupRankByScoreFromVault({
    province,
    year: input.year,
    subjectTrack,
    score: input.score,
  });

  if (!result) {
    return NextResponse.json({
      status: "not_found",
      request: { ...input, province, subjectTrack },
    });
  }

  return NextResponse.json({
    status: "ok",
    rank: result.rank,
    matchedScore: result.matchedScore,
    province: result.province,
    subjectTrack: result.subjectTrack,
    source: result.source,
  });
}
