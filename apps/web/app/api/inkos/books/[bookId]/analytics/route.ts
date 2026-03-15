import { NextResponse } from "next/server";

const serviceUrl = process.env.INKOS_SERVICE_URL ?? "http://127.0.0.1:4010";

export async function GET(
  _request: Request,
  context: { params: Promise<{ bookId: string }> },
): Promise<NextResponse> {
  const { bookId } = await context.params;
  const response = await fetch(`${serviceUrl}/api/books/${encodeURIComponent(bookId)}/analytics`, {
    cache: "no-store",
  });
  const data = await response.json();
  return NextResponse.json(data, { status: response.status });
}
