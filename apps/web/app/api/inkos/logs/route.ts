import { NextRequest, NextResponse } from "next/server";

const serviceUrl = process.env.INKOS_SERVICE_URL ?? "http://127.0.0.1:4010";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const query = searchParams.toString();
  const response = await fetch(`${serviceUrl}/api/logs${query ? `?${query}` : ""}`, { cache: "no-store" });
  const data = await response.json();
  return NextResponse.json(data, { status: response.status });
}
