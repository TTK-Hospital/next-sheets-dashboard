import { NextResponse } from "next/server";
import { clearDirectorSessionCookie } from "@/lib/directorAuth";

export const dynamic = "force-dynamic";

export async function POST() {
  const response = NextResponse.json({ ok: true });
  clearDirectorSessionCookie(response);
  return response;
}
