import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, requestAuditTag, verifySessionToken } from "@/lib/auth";
import { canCancelBooking, canEditBookingByManagement, formatBookingDateTime } from "@/lib/booking";
import { appendEditLog, cancelBooking, editBookingByManagement, getBookings, getTripOrders } from "@/lib/sheets";
import { driverCalendarUrl, notifyDriverGroup } from "@/lib/lineNotify";

export const dynamic = "force-dynamic";

// No explicit return type here — see the identical helper's doc comment in
// ../../resources/route.ts for why that matters for Next's route-handler
// type checking.
function requireSession(request: NextRequest) {
  const session = verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value);
  if (!session) {
    return { session: null, response: NextResponse.json({ error: "กรุณาเข้าสู่ระบบ" }, { status: 401 }) };
  }
  return { session, response: null };
}

/** Cancels (soft — never deletes) one booking. Only the account that made
 * it, or any superadmin, may cancel — see lib/booking.ts canCancelBooking.
 * Every other logged-in account can see the booking but not cancel it. */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ bookingId: string }> }) {
  const { session, response } = requireSession(request);
  if (!session) return response;
  const { bookingId } = await params;

  try {
    const bookings = await getBookings();
    const booking = bookings.find((b) => b.bookingId === bookingId);
    if (!booking) {
      return NextResponse.json({ error: "ไม่พบรายการจองนี้ — อาจถูกยกเลิกไปแล้ว" }, { status: 404 });
    }
    if (!canCancelBooking(booking, session)) {
      return NextResponse.json(
        { error: "ยกเลิกได้เฉพาะผู้จองเองหรือผู้ดูแลระบบ (superadmin) เท่านั้น" },
        { status: 403 }
      );
    }

    const cancelled = await cancelBooking(bookingId, session.username);
    await appendEditLog({
      timestamp: new Date().toISOString(),
      action: "ยกเลิกการจอง",
      actor: session.username,
      department: session.department,
      oldValue: "",
      newValue: `${cancelled.resourceName}: ${cancelled.startTime} - ${cancelled.endTime} ${requestAuditTag(request)}`,
    });

    // แจ้งเตือนกลุ่ม LINE คนขับ — best-effort (ดูคอมเมนต์หัวไฟล์
    // lib/lineNotify.ts) เฉพาะตอนคำขอที่ถูกยกเลิกเป็นการจองรถที่คนขับ "รู้จัก
    // อยู่แล้ว" จริงๆ เท่านั้น — คือมี tripOrderId (จ่ายรถแล้ว) **และ** ตัวมันเอง
    // หรือคำขออื่นที่เหลือในเที่ยวเดียวกันมีอย่างน้อย 1 รายการที่ ผอ. อนุมัติไป
    // แล้ว (directorApprovalStatus === "approved") ตามลำดับขั้นตอนจริงที่
    // โรงพยาบาลยืนยัน (คนขับรับงานจากรายการที่ ผอ. อนุมัติแล้วเท่านั้น — ดู
    // คอมเมนต์ที่ getDriverTrips ใน lib/sheets.ts) ถ้ายังรอ ผอ. อนุมัติ/ถูก
    // ปฏิเสธ/ตีกลับไปแล้วไม่ต้องแจ้ง เพราะไม่เคยเป็นงานจริงของคนขับตั้งแต่แรก —
    // cancelBooking ไม่แตะ directorApprovalStatus/tripOrderId เลย (ดูคอมเมนต์
    // ที่ฟังก์ชันนั้นใน lib/sheets.ts) จึงยังอ่านค่าเดิมของ cancelled ได้ตรงนี้
    // ส่วน `bookings` (โหลดไว้ก่อนยกเลิกด้านบน) ใช้เช็คคำขออื่นที่เหลือในเที่ยว
    // เดียวกันได้โดยไม่ต้องยิง Sheets API เพิ่ม
    const knownToDriver =
      cancelled.directorApprovalStatus === "approved" ||
      bookings.some(
        (b) =>
          b.bookingId !== cancelled.bookingId &&
          b.tripOrderId === cancelled.tripOrderId &&
          b.directorApprovalStatus === "approved"
      );
    if (cancelled.resourceType === "car" && cancelled.tripOrderId && knownToDriver) {
      // resourceName บนตัว Booking เองยังเป็นชื่อ placeholder ("รอบริหาร
      // จัดสรร") เสมอ แม้จะจ่ายรถไปแล้ว — ชื่อรถ/คนขับจริงอยู่ที่ TripOrder
      // เท่านั้น (ดูคอมเมนต์ที่ createTripOrder ใน lib/sheets.ts) จึงต้องดึง
      // ใบสั่งงานมาประกอบข้อความ ไม่ใช้ cancelled.resourceName ตรงๆ
      void (async () => {
        try {
          const tripOrders = await getTripOrders();
          const trip = tripOrders.find((t) => t.tripOrderId === cancelled.tripOrderId);
          if (!trip) return;
          const remaining = trip.bookingIds.filter((id) => id !== cancelled.bookingId).length;
          await notifyDriverGroup(
            `❌ มีการยกเลิกคำขอในเที่ยว\n` +
              `รถ: ${trip.resourceName}\n` +
              `คนขับ: ${trip.driverName || "—"}\n` +
              `${cancelled.department || cancelled.bookedByDisplayName || cancelled.bookedByUsername} ` +
              `(${formatBookingDateTime(cancelled.startTime)} – ${formatBookingDateTime(
                cancelled.endTime
              )}) ถูกยกเลิก — เหลือ ${remaining.toLocaleString("th-TH")} คำขอในเที่ยวนี้\n` +
              `ดูรายละเอียด: ${driverCalendarUrl(request.nextUrl.origin)}`
          );
        } catch (err: unknown) {
          // Best-effort เหมือนกัน — อ่านใบสั่งงานเพิ่มล้มเหลวไม่ควรกระทบการ
          // ยกเลิกที่สำเร็จไปแล้ว
          console.error("[lineNotify] เตรียมข้อความแจ้งยกเลิกไม่สำเร็จ:", err);
        }
      })();
    }

    return NextResponse.json({ booking: cancelled });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

interface BookingEditPayload {
  purpose?: string;
  destination?: string;
  participants?: number;
  contactPhone?: string;
  companions?: string;
}

/** Reads the `edit` payload shape — every field is optional (only the ones
 * present get changed, see editBookingByManagement in lib/sheets.ts), but a
 * field that *is* present must still be well-formed, and at least one field
 * must be present at all (an empty `edit: {}` is rejected rather than
 * silently doing nothing). */
function readEditPayload(body: unknown): BookingEditPayload | null {
  if (!body || typeof body !== "object") return null;
  const edit = (body as Record<string, unknown>).edit;
  if (!edit || typeof edit !== "object") return null;
  const e = edit as Record<string, unknown>;
  const result: BookingEditPayload = {};

  if ("purpose" in e) {
    if (typeof e.purpose !== "string" || !e.purpose.trim()) return null;
    result.purpose = e.purpose.trim();
  }
  if ("destination" in e) {
    if (typeof e.destination !== "string") return null;
    result.destination = e.destination.trim();
  }
  if ("participants" in e) {
    if (typeof e.participants !== "number" || !Number.isFinite(e.participants) || e.participants < 0) return null;
    result.participants = e.participants;
  }
  if ("contactPhone" in e) {
    if (typeof e.contactPhone !== "string" || !e.contactPhone.trim()) return null;
    result.contactPhone = e.contactPhone.trim();
  }
  if ("companions" in e) {
    if (typeof e.companions !== "string") return null;
    result.companions = e.companions.trim();
  }

  return Object.keys(result).length > 0 ? result : null;
}

/** One thing a superadmin/management account can PATCH a booking for now —
 * `{ edit: { purpose?, destination?, participants?, contactPhone?,
 * companions? } }`, correcting one or more of that fixed, narrow set of
 * fields on the booking itself, gated by canEditBookingByManagement. This
 * is the one deliberate, later-added exception to "the original request is
 * never edited": the hospital explicitly asked for it, so every edit is
 * stamped and shown as "แก้ไขโดยฝ่ายบริหาร" (see editBookingByManagement's
 * doc comment) — it's a visible correction, never a silent rewrite. Who
 * asked, which resource, and when are never editable this way; reassigning
 * the actual car/driver/time is TripOrder's job, not this one's.
 *
 * There used to be a second thing here — `{ approvalStatus: "rejected" }`,
 * letting a superadmin reject a pending car booking outright — removed per
 * the hospital's later explicit request ("ด้วยความที่ผู้อนุมัติรถมีเพียงผอ.
 * ดังนั้น เดิมที่ให้ฝ่ายบริหารผู้จัดรถมีสิทธิ ไม่อนุมัติ ต้องเอา[ออก]"): only the
 * director may ever reject a car booking now, and only after it's been
 * dispatched (see setDirectorDecision in lib/sheets.ts, via /director) —
 * ฝ่ายบริหาร/ผู้จัดรถเหลือแค่จัดรถให้ (POST /api/booking/trip-orders) หรือเฉย
 * ไว้ (หรือยกเลิกถ้าเป็นเจ้าของ/superadmin — DELETE ด้านบน, "ยกเลิก" ไม่ใช่
 * "ปฏิเสธ") ไม่มีทางปฏิเสธคำขอที่ยังไม่จัดรถได้จากชั้นนี้อีกต่อไป. Any request
 * sent here without an `edit` payload is now rejected outright, pointing at
 * where the real decision now lives. */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ bookingId: string }> }) {
  const { session, response } = requireSession(request);
  if (!session) return response;
  const { bookingId } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "คำขอไม่ถูกต้อง" }, { status: 400 });
  }

  const isEditRequest = !!body && typeof body === "object" && "edit" in (body as Record<string, unknown>);

  if (!isEditRequest) {
    return NextResponse.json(
      {
        error:
          "ฝ่ายบริหาร/ผู้จัดรถไม่มีสิทธิ์ปฏิเสธคำขอจองรถแล้ว — มีผู้อนุมัติ/ไม่อนุมัติได้เพียง ผอ. เท่านั้น (ผ่านหน้า /director หลังจัดรถแล้ว) ทำได้แค่จัดรถให้หรือยกเลิกคำขอเท่านั้น",
      },
      { status: 400 }
    );
  }

  if (!canEditBookingByManagement(session)) {
    return NextResponse.json(
      { error: "แก้ไขข้อมูลการจองได้เฉพาะผู้มีสิทธิ์นี้เท่านั้น" },
      { status: 403 }
    );
  }
  const edits = readEditPayload(body);
  if (!edits) {
    return NextResponse.json(
      { error: "ข้อมูลที่ส่งมาไม่ถูกต้อง — กรุณากรอกข้อมูลที่ต้องการแก้ไขให้ถูกต้องอย่างน้อย 1 รายการ" },
      { status: 400 }
    );
  }
  try {
    const updated = await editBookingByManagement(bookingId, edits, session.username);
    await appendEditLog({
      timestamp: new Date().toISOString(),
      action: "แก้ไขข้อมูลการจองโดยฝ่ายบริหาร",
      actor: session.username,
      department: session.department,
      oldValue: "",
      newValue: `${updated.resourceName}: ${updated.startTime} - ${updated.endTime} — แก้ไข: ${Object.keys(
        edits
      ).join(", ")} ${requestAuditTag(request)}`,
    });
    return NextResponse.json({ booking: updated });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
