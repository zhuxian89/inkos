import { NextRequest, NextResponse } from "next/server";

const serviceUrl = process.env.INKOS_SERVICE_URL ?? "http://127.0.0.1:4010";

interface Params {
  readonly params: Promise<{ readonly id: string }>;
}

export async function POST(_request: NextRequest, context: Params): Promise<NextResponse> {
  const { id } = await context.params;
  const response = await fetch(`${serviceUrl}/api/llm-profiles/${encodeURIComponent(id)}/test`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    cache: "no-store",
  });
  const data = await response.json();
  return NextResponse.json(data, { status: response.status });
}
