import { NextRequest, NextResponse, after } from "next/server";
import { verifyPassword, clientIp, requestAuditTag } from "@/lib/auth";
import {
  isDirectorLockedOut,
  recordDirectorFailedAttempt,
  clearDirectorAttempts,
  setDirectorSessionCookie,
} from "@/lib/directorAuth";
import { appendEditLog } from "@/lib/db/editLogDb";
import { getDirectorPasswordHash } from "@/lib/db/directorSettingsDb";

// Never cache/prerender — checks live rate-limit + password state.
export const dynamic = "force-dynamic";

async function logDirectorAttempt(auditTag: string, outcome: "สำเร็จ" | "ล้มเหลว", reason?: string): Promise<void> {
  try {
    await appendEditLog({
      timestamp: new Date().toISOString(),
      action: outcome === "สำเร็จ" ? "ผอ. เข้าสู่ระบบสำเร็จ" : "ผอ. เข้าสู่ระบบล้มเหลว",
      actor: "ผอ.",
      department: "",
      oldValue: "",
      newValue: [outcome === "ล้มเหลว" ? `เหตุผล: ${reason ?? "ไม่ทราบ"}` : null, auditTag]
        .filter((p): p is string => p !== null)
        .join(" "),
    });
  } catch (err: unknown) {
    console.error("appendEditLog failed (director login):", err);
  }
}

/**
 * ล็อกอินหน้า /director — รหัสผ่านอย่างเดียว ไม่มี username (ตามที่ขอ "ไม่
 * ต้องกรอก user เนื่องจากมีผู้ใช้งานหน้านี้เพียงท่านเดียวคือผอ.") ดูคอมเมนต์
 * หัวไฟล์ lib/directorAuth.ts สำหรับที่มาของ session scheme ที่แยกจาก
 * manage_session โดยสิ้นเชิง.
 *
 * ตรวจรหัสผ่านที่ตั้งเองผ่าน /api/director/reset-password ก่อน
 * (DirectorSettings tab — getDirectorPasswordHash) ถ้ายังไม่เคยตั้งเลย (แท็บ
 * ยังไม่มี/ยังไม่มีแถว) fallback ไปใช้ DIRECTOR_BOOTSTRAP_PASSWORD_HASH (env
 * var) แทน — รูปแบบเดียวกับ bootstrap superadmin ใน
 * api/auth/login/route.ts's checkBootstrapAccount — มีทางเข้าได้เสมอตั้งแต่
 * วันแรกที่ deploy แม้ยังไม่เคยกด "เปลี่ยนรหัสผ่าน" เลย.
 */
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "คำขอไม่ถูกต้อง" }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const password = typeof b.password === "string" ? b.password : "";
  if (!password) {
    return NextResponse.json({ error: "กรุณาระบุรหัสผ่าน" }, { status: 400 });
  }

  const auditTag = requestAuditTag(request);
  const rateLimitKey = `director-login:${clientIp(request)}`;
  if (isDirectorLockedOut(rateLimitKey)) {
    after(() => logDirectorAttempt(auditTag, "ล้มเหลว", "ถูกล็อกชั่วคราว (พยายามผิดหลายครั้ง)"));
    return NextResponse.json(
      { error: "ลองรหัสผ่านผิดหลายครั้งเกินไป กรุณารอ 5 นาทีแล้วลองใหม่" },
      { status: 429 }
    );
  }

  let storedHash: string;
  try {
    storedHash = await getDirectorPasswordHash();
  } catch (err: unknown) {
    console.error("getDirectorPasswordHash failed during director login:", err);
    storedHash = "";
  }
  if (!storedHash) storedHash = process.env.DIRECTOR_BOOTSTRAP_PASSWORD_HASH ?? "";

  if (!storedHash || !verifyPassword(password, storedHash)) {
    recordDirectorFailedAttempt(rateLimitKey);
    after(() => logDirectorAttempt(auditTag, "ล้มเหลว", "รหัสผ่านไม่ถูกต้อง"));
    return NextResponse.json({ error: "รหัสผ่านไม่ถูกต้อง" }, { status: 401 });
  }

  clearDirectorAttempts(rateLimitKey);
  after(() => logDirectorAttempt(auditTag, "สำเร็จ"));

  const response = NextResponse.json({ ok: true });
  setDirectorSessionCookie(response);
  return response;
}
