import { NextRequest, NextResponse, after } from "next/server";
import { DIRECTOR_SESSION_COOKIE, setDirectorSessionCookie, verifyDirectorSessionToken } from "@/lib/directorAuth";
import { appendEditLog } from "@/lib/db/editLogDb";
import { returnTripToDispatch } from "@/lib/db/tripOrdersDb";

export const dynamic = "force-dynamic";

async function logReturn(tripOrderId: string, resourceName: string, driverName: string, comment: string): Promise<void> {
  try {
    await appendEditLog({
      timestamp: new Date().toISOString(),
      action: "ผอ. ตีกลับใบสั่งงานเดินทาง",
      actor: "ผอ.",
      department: "",
      oldValue: "",
      newValue: `${resourceName} คนขับ: ${driverName || "—"}${comment ? ` — ข้อความถึงผู้จัดรถ: ${comment}` : ""}`,
    });
  } catch (err: unknown) {
    console.error("appendEditLog failed (director return):", err);
  }
}

/** ผอ. กด "ตีกลับ" — ยกเลิกการจัดรถ/คนขับเดิมทั้งใบสั่งงาน คืนทุกคำขอที่
 * ครอบคลุมกลับไปเป็น "รอจัดรถ" พร้อมข้อความถึงฝ่ายบริหารผู้จัดรถ (ตามที่ขอ
 * "ปุ่มตีกลับ สำหรับส่งให้ฝ่ายบริหารผู้จัดรถพิจารณาการจัดรถให้ พร้อมมีช่อง
 * คอมเม้น") — ดู returnTripToDispatch ใน lib/sheets.ts สำหรับ logic จริง. ต่าง
 * จาก POST .../decision ตรงที่รับ tripOrderId (ทั้งใบ) ไม่ใช่ bookingIds
 * รายคำขอ เพราะ "ตีกลับ" คือยกเลิกการจัดรถทั้งใบสั่งงาน ไม่ใช่แค่ปรับสถานะ
 * รายคำขอ. */
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
  const tripOrderId = typeof b.tripOrderId === "string" ? b.tripOrderId.trim() : "";
  const comment = typeof b.comment === "string" ? b.comment.trim().slice(0, 1000) : "";
  if (!tripOrderId) {
    return NextResponse.json({ error: "ไม่พบใบสั่งงานที่ต้องการตีกลับ" }, { status: 400 });
  }

  try {
    const { tripOrder, bookings } = await returnTripToDispatch(tripOrderId, comment, "ผอ.");
    after(() => logReturn(tripOrder.tripOrderId, tripOrder.resourceName, tripOrder.driverName, comment));

    // *ไม่* แจ้งกลุ่ม LINE คนขับที่จุดนี้ — returnTripToDispatch ปฏิเสธ (throw)
    // ทันทีถ้ามีคำขอใดในใบสั่งงานนี้ถูก ผอ. อนุมัติไปแล้ว (ดูคอมเมนต์ที่
    // returnTripToDispatch ใน lib/sheets.ts) แปลว่า "ตีกลับ" ทำได้เฉพาะใบ
    // สั่งงานที่ยังไม่ผ่าน ผอ. อนุมัติเลยแม้แต่คำขอเดียวเท่านั้น — คนขับจึงไม่
    // เคยรู้จักเที่ยวนี้มาก่อน ไม่มีอะไรต้องแจ้ง (ดูคอมเมนต์ที่ getDriverTrips ใน
    // lib/sheets.ts และจุดแจ้งกลุ่มคนขับจริงใน .../trips/decision/route.ts)
    const response = NextResponse.json({ ok: true, tripOrder, bookings });
    setDirectorSessionCookie(response);
    return response;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
