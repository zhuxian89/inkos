import { NextRequest, NextResponse } from "next/server";

const serviceUrl = process.env.INKOS_SERVICE_URL ?? "http://127.0.0.1:4010";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ bookId: string }> },
): Promise<NextResponse> {
  const { bookId } = await context.params;
  const { searchParams } = new URL(request.url);
  const query = searchParams.toString();
  const response = await fetch(
    `${serviceUrl}/api/books/${encodeURIComponent(bookId)}/export${query ? `?${query}` : ""}`,
    { cache: "no-store" },
  );

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  }

  const headers = new Headers();
  const disposition = response.headers.get("content-disposition");
  if (disposition) headers.set("content-disposition", disposition);
  headers.set("content-type", contentType || "application/octet-stream");
  headers.set("cache-control", "no-store");

  return new NextResponse(response.body, {
    status: response.status,
    headers,
  });
}
