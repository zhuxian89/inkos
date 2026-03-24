import { NextRequest, NextResponse } from "next/server";

const serviceUrl = process.env.INKOS_SERVICE_URL ?? "http://127.0.0.1:4010";

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = await request.text();
    const response = await fetch(`${serviceUrl}/api/writing/next`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      cache: "no-store",
    });
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { ok: false, error: `后端服务不可达: ${message}` },
      { status: 502 },
    );
  }
}
