import { NextRequest, NextResponse } from "next/server";

const serviceUrl = process.env.INKOS_SERVICE_URL ?? "http://127.0.0.1:4010";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ scope: string; sessionKey: string }> },
): Promise<NextResponse> {
  const { scope, sessionKey } = await params;
  const response = await fetch(`${serviceUrl}/api/chat-sessions/${encodeURIComponent(scope)}/${encodeURIComponent(sessionKey)}`, { cache: "no-store" });
  const data = await response.json();
  return NextResponse.json(data, { status: response.status });
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ scope: string; sessionKey: string }> },
): Promise<NextResponse> {
  const { scope, sessionKey } = await params;
  const body = await request.text();
  const response = await fetch(`${serviceUrl}/api/chat-sessions/${encodeURIComponent(scope)}/${encodeURIComponent(sessionKey)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body,
    cache: "no-store",
  });
  const data = await response.json();
  return NextResponse.json(data, { status: response.status });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ scope: string; sessionKey: string }> },
): Promise<NextResponse> {
  const { scope, sessionKey } = await params;
  const response = await fetch(`${serviceUrl}/api/chat-sessions/${encodeURIComponent(scope)}/${encodeURIComponent(sessionKey)}`, {
    method: "DELETE",
    cache: "no-store",
  });
  const data = await response.json();
  return NextResponse.json(data, { status: response.status });
}
