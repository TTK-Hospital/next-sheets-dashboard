import { NextRequest, NextResponse, after } from "next/server";
import { DIRECTOR_SESSION_COOKIE, setDirectorSessionCookie, verifyDirectorSessionToken } from "@/lib/directorAuth";
import { appendEditLog, setDirectorDecision } from "@/lib/sheets";

export const dynamic = "force-dynamic";

async function logDecision(count: number, decision: "approved" | "rejected"): Promise<void> {
  try {
    await appendEditLog({
      timestamp: new Date().toISOString(),
      action: decision === "approved" ? "ผอ. รับทราบการเดินทาง" : "ผอ. ไม่รับทราบการเดินทาง",
      actor: "ผอ.",
      department: "",
      oldValue: "",
      newValue: `${count} รายการ`,
    });
  } catch (err: unknown) {
    console.error("appendEditLog failed (director decision):", err);
  }
}

/** ผอ. กดรับทราบ/ไม่รับทราบ — ทีละรายการหรือหลายรายการพร้อมกัน (ตามที่ขอ
 * "คลิ๊กไม่กี่คลิ๊กสามารถอนุมัติรายการเดินทางหลายรายการได้ในครั้งเดียว") ดู
 * setDirectorDecision ใน lib/sheets.ts สำหรับ logic จริง — ไม่กระทบ
 * approvalStatus/TripOrder เดิมเลย เป็นแค่ชั้นรับทราบเพิ่มเติม. */
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
  if (bookingIds.length === 0 || !decision) {
    return NextResponse.json({ error: "กรุณาเลือกรายการและระบุผลการพิจารณา" }, { status: 400 });
  }

  try {
    const { updatedBookingIds } = await setDirectorDecision(bookingIds, decision);
    after(() => logDecision(updatedBookingIds.length, decision));
    const response = NextResponse.json({ ok: true, updatedBookingIds });
    setDirectorSessionCookie(response);
    return response;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
