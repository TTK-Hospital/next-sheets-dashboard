import { NextRequest, NextResponse, after } from "next/server";
import { DIRECTOR_SESSION_COOKIE, setDirectorSessionCookie, verifyDirectorSessionToken } from "@/lib/directorAuth";
import { appendEditLog, setDirectorDecision } from "@/lib/sheets";

export const dynamic = "force-dynamic";

async function logDecision(count: number, decision: "approved" | "rejected", comment: string): Promise<void> {
  try {
    await appendEditLog({
      timestamp: new Date().toISOString(),
      action: decision === "approved" ? "ผอ. อนุมัติการเดินทาง" : "ผอ. ไม่อนุมัติการเดินทาง",
      actor: "ผอ.",
      department: "",
      oldValue: "",
      newValue: comment ? `${count} รายการ — เหตุผล: ${comment}` : `${count} รายการ`,
    });
  } catch (err: unknown) {
    console.error("appendEditLog failed (director decision):", err);
  }
}

/** ผอ. กดอนุมัติ/ไม่อนุมัติ — ทีละรายการหรือหลายรายการพร้อมกัน (ตามที่ขอ
 * "คลิ๊กไม่กี่คลิ๊กสามารถอนุมัติรายการเดินทางหลายรายการได้ในครั้งเดียว") ดู
 * setDirectorDecision ใน lib/sheets.ts สำหรับ logic จริง — ไม่กระทบ
 * approvalStatus/TripOrder เดิมเลย เป็นแค่ชั้นอนุมัติเพิ่มเติม.
 *
 * `comment` (optional) — เหตุผลของ ผอ. ตอนไม่อนุมัติ ให้ผู้จองเห็นว่าทำไมถึง
 * ไม่ให้ (ดู Booking.directorNote ใน lib/booking.ts) — ปล่อยว่างได้เสมอ. */
export async function POST(request: NextRequest) {
  const token = request.cookies.get(DIRECTOR_SESSION_COOKIE)?.value;
  if (!verifyDirectorSessionToken(token)) {
    return NextResponse.json({ error: "กรุณาเข้าสู่ระบบ" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "คำขอไม่ถูกต้อง" }, { status: 400 });
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const bookingIds = Array.isArray(b.bookingIds) ? b.bookingIds.filter((x): x is string => typeof x === "string") : [];
  const decision = b.decision === "approved" || b.decision === "rejected" ? b.decision : null;
  const comment = typeof b.comment === "string" ? b.comment.trim().slice(0, 1000) : "";
  if (bookingIds.length === 0 || !decision) {
    return NextResponse.json({ error: "กรุณาเลือกรายการและระบุผลการพิจารณา" }, { status: 400 });
  }

  try {
    const { updatedBookingIds } = await setDirectorDecision(bookingIds, decision, comment);
    after(() => logDecision(updatedBookingIds.length, decision, comment));
    const response = NextResponse.json({ ok: true, updatedBookingIds });
    setDirectorSessionCookie(response);
    return response;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
