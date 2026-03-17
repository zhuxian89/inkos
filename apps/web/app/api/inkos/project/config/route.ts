import { NextRequest, NextResponse } from "next/server";

const serviceUrl = process.env.INKOS_SERVICE_URL ?? "http://127.0.0.1:4010";

export async function GET(): Promise<NextResponse> {
  const response = await fetch(`${serviceUrl}/api/project/config`, { cache: "no-store" });
  const data = await response.json();
  return NextResponse.json(data, { status: response.status });
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  const body = await request.text();
  const response = await fetch(`${serviceUrl}/api/project/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body,
    cache: "no-store",
  });
  const data = await response.json();
  return NextResponse.json(data, { status: response.status });
}
