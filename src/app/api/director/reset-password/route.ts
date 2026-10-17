import { NextRequest, NextResponse, after } from "next/server";
import { hashPassword, verifyPassword, clientIp, requestAuditTag } from "@/lib/auth";
import {
  isDirectorLockedOut,
  recordDirectorFailedAttempt,
  clearDirectorAttempts,
  clearDirectorSessionCookie,
} from "@/lib/directorAuth";
import { appendEditLog, getDirectorPasswordHash, setDirectorPasswordHash } from "@/lib/sheets";

export const dynamic = "force-dynamic";

async function logResetAttempt(auditTag: string, outcome: "สำเร็จ" | "ล้มเหลว", reason?: string): Promise<void> {
  try {
    await appendEditLog({
      timestamp: new Date().toISOString(),
      action: outcome === "สำเร็จ" ? "ผอ. รีเซ็ตรหัสผ่านสำเร็จ" : "ผอ. รีเซ็ตรหัสผ่านล้มเหลว",
      actor: "ผอ.",
      department: "",
      oldValue: "",
      newValue: [outcome === "ล้มเหลว" ? `เหตุผล: ${reason ?? "ไม่ทราบ"}` : null, auditTag]
        .filter((p): p is string => p !== null)
        .join(" "),
    });
  } catch (err: unknown) {
    console.error("appendEditLog failed (director reset-password):", err);
  }
}

/**
 * รีเซ็ตรหัสผ่านหน้า /director เอง — ตามที่ขอ "มีฟังก์ชันรีเซ็ตรหัสผ่านที่
 * ผอ.ท่านสามารถรีเซ็ตด้วยตัวเองได้" รูปแบบเดียวกับ
 * api/auth/reset-password/route.ts เดิม: พิสูจน์ตัวเองด้วยรหัสผ่านปัจจุบัน
 * (ไม่ใช่คุกกี้ — จะได้ใช้ได้แม้ตอนนั้นไม่มี session ค้างอยู่เลย) ไม่ต้องมี
 * username เพราะมีบัญชีเดียว. เขียนทับ DirectorSettings tab ตรงๆ (ดู
 * setDirectorPasswordHash ใน lib/sheets.ts) แทนการแก้ env var ซึ่งทำตอน
 * runtime บน Vercel ไม่ได้.
 */
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "คำขอไม่ถูกต้อง" }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const currentPassword = typeof b.currentPassword === "string" ? b.currentPassword : "";
  const newPassword = typeof b.newPassword === "string" ? b.newPassword : "";
  if (!currentPassword || !newPassword || newPassword.length < 4) {
    return NextResponse.json(
      { error: "ข้อมูลไม่ครบ — ต้องมีรหัสผ่านปัจจุบันและรหัสผ่านใหม่ (อย่างน้อย 4 ตัวอักษร)" },
      { status: 400 }
    );
  }
  if (newPassword === currentPassword) {
    return NextResponse.json({ error: "รหัสผ่านใหม่ต้องไม่เหมือนกับรหัสผ่านปัจจุบัน" }, { status: 400 });
  }

  const auditTag = requestAuditTag(request);
  const rateLimitKey = `director-reset:${clientIp(request)}`;
  if (isDirectorLockedOut(rateLimitKey)) {
    after(() => logResetAttempt(auditTag, "ล้มเหลว", "ถูกล็อกชั่วคราว (พยายามผิดหลายครั้ง)"));
    return NextResponse.json(
      { error: "ลองรหัสผ่านปัจจุบันผิดหลายครั้งเกินไป กรุณารอ 5 นาทีแล้วลองใหม่" },
      { status: 429 }
    );
  }

  try {
    let storedHash: string;
    try {
      storedHash = await getDirectorPasswordHash();
    } catch (err: unknown) {
      console.error("getDirectorPasswordHash failed during director reset-password:", err);
      storedHash = "";
    }
    if (!storedHash) storedHash = process.env.DIRECTOR_BOOTSTRAP_PASSWORD_HASH ?? "";

    if (!storedHash || !verifyPassword(currentPassword, storedHash)) {
      recordDirectorFailedAttempt(rateLimitKey);
      after(() => logResetAttempt(auditTag, "ล้มเหลว", "รหัสผ่านปัจจุบันไม่ถูกต้อง"));
      return NextResponse.json({ error: "รหัสผ่านปัจจุบันไม่ถูกต้อง" }, { status: 401 });
    }
    clearDirectorAttempts(rateLimitKey);

    await setDirectorPasswordHash(hashPassword(newPassword));
    after(() => logResetAttempt(auditTag, "สำเร็จ"));

    // ใครก็ตามที่ล็อกอินอยู่ (session เก่า) ตั้งขึ้นภายใต้รหัสผ่านเดิม — เตะ
    // ออกให้ล็อกอินใหม่ด้วยรหัสผ่านใหม่ เหมือน reset-password เดิม
    // (clearActiveSession) แม้หน้านี้จะไม่มีที่เก็บ session กลางแบบนั้นก็ตาม
    // (session ของ /director ไม่ผ่าน sessionStore.ts เลย — ดูคอมเมนต์หัวไฟล์
    // lib/directorAuth.ts) — ลบคุกกี้ของเบราว์เซอร์ที่กำลังกดรีเซ็ตเองตรงนี้
    // ก็เพียงพอ เพราะมีผู้ใช้หน้านี้แค่คนเดียวอยู่แล้ว
    const response = NextResponse.json({ ok: true });
    clearDirectorSessionCookie(response);
    return response;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
