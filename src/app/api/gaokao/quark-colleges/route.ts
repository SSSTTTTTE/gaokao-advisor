import { NextResponse } from "next/server";

import { lookupQuarkPublicColleges } from "@/lib/quark-gaokao-public-data";

export const dynamic = "force-dynamic";

function readSearchParam(url: URL, key: string) {
  return url.searchParams.get(key)?.trim() || undefined;
}

function readLimit(url: URL) {
  const parsed = Number(url.searchParams.get("limit") || 30);
  return Number.isFinite(parsed) ? parsed : 30;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const result = await lookupQuarkPublicColleges({
    keyword: readSearchParam(url, "keyword"),
    province: readSearchParam(url, "province"),
    city: readSearchParam(url, "city"),
    type: readSearchParam(url, "type"),
    tag: readSearchParam(url, "tag"),
    limit: readLimit(url),
  });

  return NextResponse.json(result, { status: result.status === "ok" ? 200 : 502 });
}
