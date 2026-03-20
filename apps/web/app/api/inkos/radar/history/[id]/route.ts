import { NextRequest, NextResponse } from "next/server";

const serviceUrl = process.env.INKOS_SERVICE_URL ?? "http://127.0.0.1:4010";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const response = await fetch(`${serviceUrl}/api/radar/history/${encodeURIComponent(id)}`, { cache: "no-store" });
  const data = await response.json();
  return NextResponse.json(data, { status: response.status });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const response = await fetch(`${serviceUrl}/api/radar/history/${encodeURIComponent(id)}`, {
    method: "DELETE",
    cache: "no-store",
  });
  const data = await response.json();
  return NextResponse.json(data, { status: response.status });
}
