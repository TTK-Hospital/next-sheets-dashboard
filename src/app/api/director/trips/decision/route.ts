import { NextRequest, NextResponse, after } from "next/server";
import { DIRECTOR_SESSION_COOKIE, setDirectorSessionCookie, verifyDirectorSessionToken } from "@/lib/directorAuth";
import { appendEditLog, getTripOrders, setDirectorDecision } from "@/lib/sheets";
import { formatBookingDateTime, type Booking } from "@/lib/booking";
import { driverCalendarUrl, notifyDriverGroup } from "@/lib/lineNotify";

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
    const { updatedBookingIds, bookings } = await setDirectorDecision(bookingIds, decision, comment);
    after(() => logDecision(updatedBookingIds.length, decision, comment));

    // แจ้งเตือนกลุ่ม LINE คนขับ — ย้ายมาอยู่ที่นี่ (จุดที่ ผอ. อนุมัติจริง) ตาม
    // ลำดับขั้นตอนจริงที่โรงพยาบาลยืนยัน (ผู้จอง → ผู้จัด/ฝ่ายบริหารจัดรถแต่ไม่มี
    // อำนาจตัดสินใจ → ผอ. ตัดสินใจ → คนขับรับงานจากรายการที่ผอ.อนุมัติแล้ว
    // เท่านั้น) — ก่อนหน้านี้แจ้งทันทีที่ฝ่ายบริหารจัดรถ (ก่อน ผอ. อนุมัติ) ซึ่งไม่
    // ตรงกับลำดับจริง ดูคอมเมนต์ที่ getDriverTrips ใน lib/sheets.ts ด้วย — ไม่
    // อนุมัติ (rejected) ไม่ต้องแจ้งคนขับเลย (งานนั้นไม่เกิดขึ้น)
    if (decision === "approved" && bookings.length > 0) {
      void notifyApprovedBookings(bookings, request.nextUrl.origin);
    }

    const response = NextResponse.json({ ok: true, updatedBookingIds });
    setDirectorSessionCookie(response);
    return response;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** จัดกลุ่มคำขอที่ ผอ. อนุมัติผ่านมารอบนี้ตาม tripOrderId แล้วแจ้งกลุ่ม LINE
 * คนขับทีละใบสั่งงาน — ต้องจัดกลุ่มเพราะการอนุมัติครั้งเดียว ("คลิ๊กไม่กี่คลิ๊ก
 * ...ในครั้งเดียว") อาจครอบคลุมหลายใบสั่งงานพร้อมกันได้ ไม่อยากให้คนขับของ
 * ใบสั่งงาน A ได้รับข้อความที่จริงๆ เป็นของใบสั่งงาน B ปนกัน — ดึงรายละเอียด
 * รถ/คนขับ/เวลาจาก TripOrder เอง (ไม่ใช่จาก Booking) เพราะ Booking.resourceName
 * ของคำขอที่ผ่านมือฝ่ายบริหารแล้วเป็นแค่ placeholder ไม่ใช่รถจริงที่จัดให้ (ดู
 * คอมเมนต์ที่ createTripOrder ใน lib/sheets.ts) best-effort ล้วนๆ เหมือนทุก
 * จุดที่เรียก notifyDriverGroup — ไม่ throw ออกไปเอง จึงไม่ต้องครอบ try/catch
 * เพิ่มตรงนี้ */
async function notifyApprovedBookings(bookings: Booking[], origin: string): Promise<void> {
  const byTripOrder = new Map<string, Booking[]>();
  for (const b of bookings) {
    if (!b.tripOrderId) continue; // กันพลาด — ไม่ควรเกิดขึ้น (ผ่าน createTripOrder มาแล้วเสมอ)
    const list = byTripOrder.get(b.tripOrderId) ?? [];
    list.push(b);
    byTripOrder.set(b.tripOrderId, list);
  }
  if (byTripOrder.size === 0) return;

  let tripOrders;
  try {
    tripOrders = await getTripOrders();
  } catch (err: unknown) {
    console.error("getTripOrders failed (director decision → notify driver):", err);
    return;
  }
  const tripOrderById = new Map(tripOrders.map((t) => [t.tripOrderId, t]));

  for (const [tripOrderId, covered] of byTripOrder) {
    const tripOrder = tripOrderById.get(tripOrderId);
    if (!tripOrder) continue; // กันพลาด — ไม่ควรเกิดขึ้น
    const totalParticipants = covered.reduce((sum, b) => sum + b.participants, 0);
    void notifyDriverGroup(
      `🚐 มีงานใหม่ (ผอ. อนุมัติแล้ว)\n` +
        `รถ: ${tripOrder.resourceName}\n` +
        `คนขับ: ${tripOrder.driverName || "—"}\n` +
        `ออกเดินทาง: ${formatBookingDateTime(tripOrder.startTime)}\n` +
        `ผู้โดยสาร: ${totalParticipants.toLocaleString("th-TH")} คน\n` +
        `ดูรายละเอียด: ${driverCalendarUrl(origin)}`
    );
  }
}
