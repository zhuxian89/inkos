import { NextRequest, NextResponse } from "next/server";

const serviceUrl = process.env.INKOS_SERVICE_URL ?? "http://127.0.0.1:4010";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const { id } = await context.params;
    const body = await request.text();
    const response = await fetch(`${serviceUrl}/api/commands/${id}/run`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body,
      cache: "no-store",
    });
    const raw = await response.text();
    const data = raw ? safeParseJson(raw) : null;

    if (data !== null) {
      return NextResponse.json(data, { status: response.status });
    }

    return NextResponse.json(
      {
        ok: false,
        error: "Command service returned a non-JSON response.",
        raw,
      },
      { status: response.status || 502 },
    );
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 502 },
    );
  }
}

function safeParseJson(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
