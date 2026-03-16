import { NextRequest, NextResponse } from "next/server";

const serviceUrl = process.env.INKOS_SERVICE_URL ?? "http://127.0.0.1:4010";

interface Params {
  readonly params: Promise<{ readonly id: string }>;
}

export async function PUT(request: NextRequest, context: Params): Promise<NextResponse> {
  const { id } = await context.params;
  const body = await request.text();
  const response = await fetch(`${serviceUrl}/api/llm-profiles/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body,
    cache: "no-store",
  });
  const data = await response.json();
  return NextResponse.json(data, { status: response.status });
}

export async function DELETE(_request: NextRequest, context: Params): Promise<NextResponse> {
  const { id } = await context.params;
  const response = await fetch(`${serviceUrl}/api/llm-profiles/${encodeURIComponent(id)}`, {
    method: "DELETE",
    cache: "no-store",
  });
  const data = await response.json();
  return NextResponse.json(data, { status: response.status });
}
