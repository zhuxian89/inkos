import { NextRequest, NextResponse } from "next/server";

const serviceUrl = process.env.INKOS_SERVICE_URL ?? "http://127.0.0.1:4010";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const body = await request.text();
  const response = await fetch(`${serviceUrl}/api/books`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    cache: "no-store",
  });
  const data = await response.json();
  return NextResponse.json(data, { status: response.status });
}

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const bookId = request.nextUrl.searchParams.get("bookId");
  if (!bookId) {
    return NextResponse.json({ ok: false, error: "bookId is required" }, { status: 400 });
  }

  const response = await fetch(`${serviceUrl}/api/books/${encodeURIComponent(bookId)}`, {
    method: "DELETE",
    cache: "no-store",
  });
  const data = await response.json();
  return NextResponse.json(data, { status: response.status });
}
