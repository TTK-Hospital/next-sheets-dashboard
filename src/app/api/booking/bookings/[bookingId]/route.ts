import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, requestAuditTag, verifySessionToken } from "@/lib/auth";
import { canApproveCarBooking, canCancelBooking, canEditBookingByManagement, formatBookingDateTime } from "@/lib/booking";
import {
  appendEditLog,
  cancelBooking,
  editBookingByManagement,
  getBookings,
  getTripOrders,
  rejectCarBooking,
} from "@/lib/sheets";
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
    // lib/lineNotify.ts) เฉพาะตอนคำขอที่ถูกยกเลิกเป็นการจองรถที่ "จ่ายรถแล้ว"
    // จริงๆ (มี tripOrderId อยู่ — ยังรออนุมัติ/ถูกปฏิเสธไปแล้วไม่ต้องแจ้ง เพราะ
    // ไม่เคยเป็นงานจริงของคนขับตั้งแต่แรก) — cancelBooking ไม่แตะ tripOrderId
    // เลย (ดูคอมเมนต์ที่ฟังก์ชันนั้นใน lib/sheets.ts) จึงยังอ่านค่าเดิมได้ตรงนี้
    if (cancelled.resourceType === "car" && cancelled.tripOrderId) {
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

function readApprovalPayload(body: unknown): "approved" | "rejected" | null {
  if (!body || typeof body !== "object") return null;
  const v = (body as Record<string, unknown>).approvalStatus;
  return v === "approved" || v === "rejected" ? v : null;
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

/** Two distinct things a superadmin/management account can PATCH a booking
 * for now — each gated by its own permission key in lib/permissions.ts
 * (split apart per a later, explicit hospital request — see
 * canEditBookingByManagement's doc comment in lib/booking.ts for why),
 * neither narrowed to the bootstrap account only:
 *
 * 1. `{ approvalStatus: "rejected" }` — rejects a pending car booking
 *    outright, gated by canApproveCarBooking. "Approving" is no longer a
 *    status flip here at all — approving means dispatching via a separate
 *    TripOrder (car + driver + unified time, possibly covering several
 *    bookings at once — see POST /api/booking/trip-orders and
 *    createTripOrder in lib/sheets.ts). Sending approvalStatus: "approved"
 *    here is rejected with a message pointing at that endpoint, rather than
 *    silently accepted.
 *
 * 2. `{ edit: { purpose?, destination?, participants?, contactPhone?,
 *    companions? } }` — corrects one or more of that fixed, narrow set of
 *    fields on the booking itself, gated by canEditBookingByManagement.
 *    This is the one deliberate, later-added exception to "the original
 *    request is never edited": the hospital explicitly asked for it, so
 *    every edit is stamped and shown as "แก้ไขโดยฝ่ายบริหาร" (see
 *    editBookingByManagement's doc comment) — it's a visible correction,
 *    never a silent rewrite. Who asked, which resource, and when are never
 *    editable this way; reassigning the actual car/driver/time is still
 *    TripOrder's job, not this one's. */
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

  if (isEditRequest) {
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

  if (!canApproveCarBooking(session)) {
    return NextResponse.json(
      { error: "แก้ไข/ปฏิเสธการจองรถได้เฉพาะสิทธิ์ Superadmin เท่านั้น" },
      { status: 403 }
    );
  }
  const approvalStatus = readApprovalPayload(body);
  if (!approvalStatus) {
    return NextResponse.json({ error: "ข้อมูลที่ส่งมาไม่ถูกต้อง" }, { status: 400 });
  }
  if (approvalStatus === "approved") {
    return NextResponse.json(
      {
        error:
          "การจัดรถต้องออกใบสั่งงานเดินทาง (ระบุรถ/คนขับ/เวลา) ผ่านหน้าจัดรถ ไม่สามารถจัดรถตรงนี้ได้อีกต่อไป",
      },
      { status: 400 }
    );
  }

  try {
    const updated = await rejectCarBooking(bookingId, session.username);
    await appendEditLog({
      timestamp: new Date().toISOString(),
      action: "ปฏิเสธการจองรถ",
      actor: session.username,
      department: session.department,
      oldValue: "",
      newValue: `${updated.resourceName}: ${updated.startTime} - ${updated.endTime} ${requestAuditTag(request)}`,
    });
    return NextResponse.json({ booking: updated });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
