import { NextRequest, NextResponse } from "next/server";

const serviceUrl = process.env.INKOS_SERVICE_URL ?? "http://127.0.0.1:4010";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ bookId: string }> },
): Promise<NextResponse> {
  const { bookId } = await context.params;
  const body = await request.text();
  const response = await fetch(`${serviceUrl}/api/books/${encodeURIComponent(bookId)}/style-import`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    cache: "no-store",
  });
  const data = await response.json();
  return NextResponse.json(data, { status: response.status });
}
