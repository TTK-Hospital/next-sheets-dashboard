import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, requestAuditTag, verifySessionToken } from "@/lib/auth";
import { canApproveCarBooking, formatBookingDateTime } from "@/lib/booking";
import { appendEditLog, createTripOrder, getBookingResources, getTripOrders } from "@/lib/sheets";
import { directorApprovalUrl, driverCalendarUrl, notifyDirector, notifyDriverGroup } from "@/lib/lineNotify";

// Always live — see the identical comment on ../bookings/route.ts: a
// dispatch changes what's still "pending" for every viewer, so this must
// never be cached.
export const dynamic = "force-dynamic";

// No explicit return type here — see ../resources/route.ts's doc comment
// on the identical helper for why that matters for Next's route-handler
// type checking.
function requireSession(request: NextRequest) {
  const session = verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value);
  if (!session) {
    return { session: null, response: NextResponse.json({ error: "กรุณาเข้าสู่ระบบ" }, { status: 401 }) };
  }
  return { session, response: null };
}

/** Every dispatch record ever issued — any logged-in account can see who
 * was assigned which car/driver for which bookings, same "read-only is
 * open to everyone" shape as GET /api/booking/bookings. */
export async function GET(request: NextRequest) {
  const { session, response } = requireSession(request);
  if (!session) return response;

  try {
    const tripOrders = await getTripOrders();
    return NextResponse.json({ tripOrders });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

interface TripOrderPayload {
  resourceId: string;
  driverName: string;
  startTime: string;
  endTime: string;
  notes: string;
  bookingIds: string[];
}

function readTripOrderPayload(body: unknown): TripOrderPayload | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (typeof b.resourceId !== "string" || !b.resourceId.trim()) return null;
  if (typeof b.driverName !== "string" || !b.driverName.trim()) return null;
  if (typeof b.startTime !== "string" || !b.startTime.trim()) return null;
  if (typeof b.endTime !== "string" || !b.endTime.trim()) return null;
  if (typeof b.notes !== "string" && typeof b.notes !== "undefined") return null;
  if (!Array.isArray(b.bookingIds) || b.bookingIds.length === 0) return null;
  if (!b.bookingIds.every((id) => typeof id === "string" && id.trim())) return null;

  const start = new Date(b.startTime).getTime();
  const end = new Date(b.endTime).getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || start >= end) return null;

  return {
    resourceId: b.resourceId.trim(),
    driverName: b.driverName.trim(),
    startTime: b.startTime,
    endTime: b.endTime,
    notes: typeof b.notes === "string" ? b.notes.trim() : "",
    bookingIds: (b.bookingIds as string[]).map((id) => id.trim()),
  };
}

/** Dispatches one or more pending car bookings at once: this is how a car
 * booking becomes "approved" now, and covering >1 bookingId here IS the
 * "combine into one trip" (carpool) feature — see createTripOrder's doc
 * comment in lib/sheets.ts. Reachable only by an account with
 * canApproveCarBooking (dispatch-only now — see that function's doc comment
 * in lib/booking.ts for why rejecting a pending car booking outright is no
 * longer possible at this level at all).
 *
 * Deliberately never edits the original booking rows' own fields (purpose,
 * destination, participants, etc.) — only approvalStatus and tripOrderId
 * are touched, inside createTripOrder itself — per the hospital's explicit
 * "ข้อมูลคำขอเดิมไม่ถูกแก้ไข" requirement. */
export async function POST(request: NextRequest) {
  const { session, response } = requireSession(request);
  if (!session) return response;
  if (!canApproveCarBooking(session)) {
    return NextResponse.json(
      { error: "ออกใบสั่งงานเดินทางได้เฉพาะสิทธิ์ Superadmin เท่านั้น" },
      { status: 403 }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "คำขอไม่ถูกต้อง" }, { status: 400 });
  }
  const payload = readTripOrderPayload(body);
  if (!payload) {
    return NextResponse.json(
      { error: "ข้อมูลที่ส่งมาไม่ถูกต้อง — กรุณาระบุรถ ชื่อคนขับ เวลา และเลือกรายการจองอย่างน้อย 1 รายการ" },
      { status: 400 }
    );
  }

  try {
    const resources = await getBookingResources();
    const resource = resources.find((r) => r.resourceId === payload.resourceId);
    if (!resource) {
      return NextResponse.json({ error: "ไม่พบรถนี้ — อาจถูกลบไปแล้ว" }, { status: 404 });
    }
    if (resource.type !== "car") {
      return NextResponse.json({ error: "ออกใบสั่งงานเดินทางได้เฉพาะการจองรถเท่านั้น" }, { status: 400 });
    }

    const { tripOrder, bookings } = await createTripOrder({
      resourceId: resource.resourceId,
      resourceName: resource.name,
      driverName: payload.driverName,
      startTime: payload.startTime,
      endTime: payload.endTime,
      notes: payload.notes,
      bookingIds: payload.bookingIds,
      createdByUsername: session.username,
    });

    await appendEditLog({
      timestamp: new Date().toISOString(),
      action: "ออกใบสั่งงานเดินทาง",
      actor: session.username,
      department: session.department,
      oldValue: "",
      newValue: `${resource.name} คนขับ: ${payload.driverName} (${bookings.length} รายการจอง) ${requestAuditTag(
        request
      )}`,
    });

    // แจ้งเตือนกลุ่ม LINE คนขับ — best-effort ล้วนๆ (ดูคอมเมนต์หัวไฟล์
    // lib/lineNotify.ts) ไม่ await ผลลัพธ์เพื่อตัดสินใจอย่างอื่นต่อ และไม่
    // เคย throw ออกมาเองอยู่แล้ว จึงไม่ต้องครอบ try/catch เพิ่มตรงนี้
    const totalParticipants = bookings.reduce((sum, b) => sum + b.participants, 0);
    void notifyDriverGroup(
      `🚐 มีงานใหม่\n` +
        `รถ: ${tripOrder.resourceName}\n` +
        `คนขับ: ${tripOrder.driverName || "—"}\n` +
        `ออกเดินทาง: ${formatBookingDateTime(tripOrder.startTime)}\n` +
        `ผู้โดยสารรวม: ${totalParticipants.toLocaleString("th-TH")} คน\n` +
        `ดูรายละเอียด: ${driverCalendarUrl(request.nextUrl.origin)}`
    );

    // แจ้งเตือน ผอ. ว่ามีรายการจัดรถใหม่เข้ามารออนุมัติ — best-effort เหมือนกัน
    // (ดูคอมเมนต์หัวไฟล์ lib/lineNotify.ts) ตามที่ขอ "อยากให้มีการแจ้งเตือนทาง
    // line ให้กับผอ.ได้รับทราบว่ามีการขอรถเข้ามาด้วยครับ" — จ่ายรถเสร็จแล้ว
    // ทุกคำขอใน bookings กลายเป็น "รอ ผอ. อนุมัติ" ทันที (ดู createTripOrder ใน
    // lib/sheets.ts) จึงแจ้งทุกครั้งที่ endpoint นี้สำเร็จ ไม่ต้องกรองเพิ่ม
    void notifyDirector(
      `🔔 มีรายการจัดรถรออนุมัติ\n` +
        `รถ: ${tripOrder.resourceName}\n` +
        `คนขับ: ${tripOrder.driverName || "—"}\n` +
        `ออกเดินทาง: ${formatBookingDateTime(tripOrder.startTime)}\n` +
        `${bookings.length.toLocaleString("th-TH")} คำขอรออนุมัติ\n` +
        `ดูรายละเอียด: ${directorApprovalUrl(request.nextUrl.origin)}`
    );

    return NextResponse.json({ tripOrder, bookings });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
