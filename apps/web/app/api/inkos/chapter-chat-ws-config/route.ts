import { NextResponse } from "next/server";

export async function GET(): Promise<NextResponse> {
  const serviceUrl = process.env.INKOS_PUBLIC_SERVICE_URL
    ?? process.env.INKOS_SERVICE_URL
    ?? "http://127.0.0.1:4010";
  const url = new URL("/api/chapter-chat/ws", serviceUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return NextResponse.json({ url: url.toString() });
}
