import { NextRequest, NextResponse } from "next/server";

const serviceUrl = process.env.INKOS_SERVICE_URL ?? "http://127.0.0.1:4010";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const bookId = request.nextUrl.searchParams.get("bookId");
  const target = new URL(`${serviceUrl}/api/review/pending`);
  if (bookId) target.searchParams.set("bookId", bookId);
  const response = await fetch(target, { cache: "no-store" });
  const data = await response.json();
  return NextResponse.json(data, { status: response.status });
}
