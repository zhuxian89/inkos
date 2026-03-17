import { NextRequest, NextResponse } from "next/server";

const serviceUrl = process.env.INKOS_SERVICE_URL ?? "http://127.0.0.1:4010";

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const payload = await request.json();
  const response = await fetch(`${serviceUrl}/api/llm-profiles/${encodeURIComponent(id)}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    cache: "no-store",
  });
  const data = await response.json();
  return NextResponse.json(data, { status: response.status });
}
