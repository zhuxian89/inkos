import { NextRequest, NextResponse } from "next/server";

const serviceUrl = process.env.INKOS_SERVICE_URL ?? "http://127.0.0.1:4010";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ bookId: string; chapter: string }> },
): Promise<NextResponse> {
  const { bookId, chapter } = await context.params;
  const body = await request.text();
  const response = await fetch(
    `${serviceUrl}/api/books/${encodeURIComponent(bookId)}/chapters/${encodeURIComponent(chapter)}/chat-stream`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      cache: "no-store",
    },
  );

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    return new NextResponse(response.body, {
      status: response.status,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      },
    });
  }

  const data = await response.json();
  return NextResponse.json(data, { status: response.status });
}
