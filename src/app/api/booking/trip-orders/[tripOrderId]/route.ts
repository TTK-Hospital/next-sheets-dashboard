import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, requestAuditTag, verifySessionToken } from "@/lib/auth";
import { canApproveCarBooking, formatBookingDateTime } from "@/lib/booking";
import { appendEditLog, getBookingResources, splitBookingFromTripOrder, updateTripOrder } from "@/lib/sheets";
import { directorApprovalUrl, driverCalendarUrl, notifyDirector, notifyDriverGroup } from "@/lib/lineNotify";

export const dynamic = "force-dynamic";

// No explicit return type here — see ../../resources/route.ts's doc comment
// on the identical helper for why that matters for Next's route-handler
// type checking.
function requireSession(request: NextRequest) {
  const session = verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value);
  if (!session) {
    return { session: null, response: NextResponse.json({ error: "กรุณาเข้าสู่ระบบ" }, { status: 401 }) };
  }
  return { session, response: null };
}

interface TripOrderEditPayload {
  resourceId?: string;
  driverName?: string;
  startTime?: string;
  endTime?: string;
  notes?: string;
  /** เพิ่มคำขอจองรถ "รออนุมัติ" อื่นเข้าใบสั่งงานนี้ — ตามที่โรงพยาบาลขอเพิ่ม
   * ภายหลัง (เผื่อกรณีอนุมัติไปแล้วแต่มีกลุ่มอื่นอยากเดินทางไปด้วย) ดูคอมเมนต์
   * เต็มที่ updateTripOrder ใน lib/sheets.ts */
  addBookingIds?: string[];
}

/** แยกคำขอจองรถหนึ่งรายการออกจากใบสั่งงานนี้ — ฟิลด์ตรงข้ามกับ addBookingIds
 * ด้านบน (เพิ่ม vs เอาออก) ตั้งใจแยก payload กันคนละชนิดชัดเจน ไม่ผสมกับการ
 * แก้รถ/คนขับ/เวลา/หมายเหตุในคำขอเดียวกัน — ดูคอมเมนต์เต็มที่ readSplitPayload
 * ด้านล่างว่าทำไมต้องแยก */
interface TripOrderSplitPayload {
  removeBookingId: string;
}

/** ตรวจว่า body เป็นคำขอ "แยกรายการออก" หรือไม่ — ตั้งใจให้เป็น action แยก
 * ต่างหากจากการแก้ไขรถ/คนขับ/เวลา/หมายเหตุ/addBookingIds ข้างบน (คนละความ
 * หมาย คนละผลลัพธ์ต่อคำขอเดิม) ไม่ให้ client ส่งปนกันมาในคำขอเดียวเพื่อกัน
 * ความกำกวมว่าจะประมวลผลอันไหนก่อน — ถ้ามี removeBookingId ต้องเป็นคำขอนี้
 * เท่านั้น ห้ามมีฟิลด์อื่นปนมาด้วย */
function readSplitPayload(body: unknown): TripOrderSplitPayload | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (!("removeBookingId" in b)) return null;
  if (typeof b.removeBookingId !== "string" || !b.removeBookingId.trim()) return null;
  const otherKeys = Object.keys(b).filter((k) => k !== "removeBookingId");
  if (otherKeys.length > 0) return null;
  return { removeBookingId: b.removeBookingId.trim() };
}

function readEditPayload(body: unknown): TripOrderEditPayload | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const result: TripOrderEditPayload = {};

  if ("resourceId" in b) {
    if (typeof b.resourceId !== "string" || !b.resourceId.trim()) return null;
    result.resourceId = b.resourceId.trim();
  }
  if ("driverName" in b) {
    if (typeof b.driverName !== "string" || !b.driverName.trim()) return null;
    result.driverName = b.driverName.trim();
  }
  if ("notes" in b) {
    if (typeof b.notes !== "string") return null;
    result.notes = b.notes.trim();
  }
  const hasStart = "startTime" in b;
  const hasEnd = "endTime" in b;
  if (hasStart !== hasEnd) return null; // ต้องแก้คู่กันเสมอ — กันช่วงเวลาที่เริ่ม>=จบโดยไม่ตั้งใจ
  if (hasStart && hasEnd) {
    if (typeof b.startTime !== "string" || !b.startTime.trim()) return null;
    if (typeof b.endTime !== "string" || !b.endTime.trim()) return null;
    const start = new Date(b.startTime).getTime();
    const end = new Date(b.endTime).getTime();
    if (Number.isNaN(start) || Number.isNaN(end) || start >= end) return null;
    result.startTime = b.startTime;
    result.endTime = b.endTime;
  }
  if ("addBookingIds" in b) {
    if (!Array.isArray(b.addBookingIds) || !b.addBookingIds.every((id) => typeof id === "string" && id.trim())) {
      return null;
    }
    result.addBookingIds = (b.addBookingIds as string[]).map((id) => id.trim());
  }

  return Object.keys(result).length > 0 ? result : null;
}

/** Edits an already-issued TripOrder's own car/driver/time/notes, OR splits
 * one already-covered booking back out of it — two distinct actions on the
 * same endpoint, told apart by body shape (see readEditPayload vs
 * readSplitPayload above), same "one endpoint per resource, verb via body
 * shape" convention already used for addBookingIds below. Same permission
 * gate as everything else in the car-booking review flow — see
 * canApproveCarBooking in lib/booking.ts.
 *
 * The edit path never edits the bookings this TripOrder already covers, and
 * never *removes* any of them — the one exception there is `addBookingIds`,
 * a later explicit request letting management add other still-pending car
 * bookings into an already-approved trip (e.g. another department wants to
 * ride along after the fact) — see updateTripOrder's doc comment in
 * lib/sheets.ts for the full story and its validation.
 *
 * The split path (`removeBookingId`) is the one place that *does* remove a
 * covered booking — added later per an explicit hospital request ("อยากให้
 * สามารถแยกรายการการเดินทางที่อนุมัติไปแล้วได้") — see
 * splitBookingFromTripOrder's doc comment in lib/sheets.ts for what happens
 * to the split-out booking (reverts fully to "รออนุมัติ", needs a fresh
 * TripOrder of its own). */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ tripOrderId: string }> }) {
  const { session, response } = requireSession(request);
  if (!session) return response;
  if (!canApproveCarBooking(session)) {
    return NextResponse.json(
      { error: "แก้ไขใบสั่งงานเดินทางได้เฉพาะสิทธิ์ Superadmin เท่านั้น" },
      { status: 403 }
    );
  }
  const { tripOrderId } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "คำขอไม่ถูกต้อง" }, { status: 400 });
  }

  const splitPayload = readSplitPayload(body);
  if (splitPayload) {
    try {
      const { tripOrder: updated, booking: splitBooking } = await splitBookingFromTripOrder(
        tripOrderId,
        splitPayload.removeBookingId,
        session.username
      );
      await appendEditLog({
        timestamp: new Date().toISOString(),
        action: "แยกรายการออกจากใบสั่งงานเดินทาง",
        actor: session.username,
        department: session.department,
        oldValue: "",
        newValue: `${splitBooking.resourceName || splitBooking.bookedByDisplayName} (${formatBookingDateTime(
          splitBooking.startTime
        )} – ${formatBookingDateTime(splitBooking.endTime)}) ออกจากใบสั่งงาน ${updated.resourceName} คนขับ: ${
          updated.driverName || "—"
        } — กลับเป็นรอจัดรถแล้ว ${requestAuditTag(request)}`,
      });

      // แจ้งเตือนกลุ่ม LINE คนขับ — best-effort (ดูคอมเมนต์หัวไฟล์
      // lib/lineNotify.ts)
      void notifyDriverGroup(
        `⚠️ มีรายการถูกแยกออกจากเที่ยว\n` +
          `รถ: ${updated.resourceName}\n` +
          `คนขับ: ${updated.driverName || "—"}\n` +
          `${splitBooking.department || splitBooking.bookedByDisplayName || splitBooking.bookedByUsername} ` +
          `(${formatBookingDateTime(splitBooking.startTime)} – ${formatBookingDateTime(
            splitBooking.endTime
          )}) ถูกแยกออก — เหลือ ${updated.bookingIds.length.toLocaleString("th-TH")} คำขอในเที่ยวนี้\n` +
          `ดูรายละเอียด: ${driverCalendarUrl(request.nextUrl.origin)}`
      );

      return NextResponse.json({ tripOrder: updated, booking: splitBooking });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return NextResponse.json({ error: message }, { status: 500 });
    }
  }

  const edits = readEditPayload(body);
  if (!edits) {
    return NextResponse.json(
      { error: "ข้อมูลที่ส่งมาไม่ถูกต้อง — กรุณากรอกข้อมูลที่ต้องการแก้ไขให้ถูกต้องอย่างน้อย 1 รายการ" },
      { status: 400 }
    );
  }

  try {
    // resourceId ถูกส่งมาแยกจาก resourceName เสมอ (เหมือน POST
    // /api/booking/trip-orders) — resolve ชื่อรถปัจจุบันจากรายการทรัพยากรจริง
    // แทนการเชื่อใจชื่อที่ client ส่งมา
    let resourceName: string | undefined;
    if (edits.resourceId) {
      const resources = await getBookingResources();
      const resource = resources.find((r) => r.resourceId === edits.resourceId);
      if (!resource) {
        return NextResponse.json({ error: "ไม่พบรถนี้ — อาจถูกลบไปแล้ว" }, { status: 404 });
      }
      if (resource.type !== "car") {
        return NextResponse.json({ error: "ใบสั่งงานเดินทางใช้ได้กับรถเท่านั้น" }, { status: 400 });
      }
      resourceName = resource.name;
    }

    const { tripOrder: updated, addedBookings } = await updateTripOrder(tripOrderId, { ...edits, resourceName }, session.username);
    await appendEditLog({
      timestamp: new Date().toISOString(),
      action: "แก้ไขใบสั่งงานเดินทาง",
      actor: session.username,
      department: session.department,
      oldValue: "",
      newValue: `${updated.resourceName} คนขับ: ${updated.driverName} (${updated.bookingIds.length} รายการจอง${
        addedBookings.length > 0 ? ` — เพิ่มเข้ามาใหม่ ${addedBookings.length} รายการ` : ""
      }) ${requestAuditTag(request)}`,
    });

    // แจ้งเตือนกลุ่ม LINE คนขับ — best-effort (ดูคอมเมนต์หัวไฟล์
    // lib/lineNotify.ts) แจ้งทุกครั้งที่แก้ไขสำเร็จ (รถ/คนขับ/เวลา/หมายเหตุ/
    // เพิ่มคำขอ) ไม่แยกกรองว่าแก้ฟิลด์ไหนบ้าง ตามขอบเขตที่ตกลงกันไว้ — "ทุก
    // เหตุการณ์ที่กระทบงานของคนขับ" ดู docs/line-driver-notify-plan.md
    void notifyDriverGroup(
      `✏️ แก้ไขงาน\n` +
        `รถ: ${updated.resourceName}\n` +
        `คนขับ: ${updated.driverName || "—"}\n` +
        `เวลาออกเดินทาง: ${formatBookingDateTime(updated.startTime)}\n` +
        (addedBookings.length > 0
          ? `เพิ่มคำขอใหม่เข้ามา ${addedBookings.length.toLocaleString("th-TH")} รายการ\n`
          : "") +
        `ดูรายละเอียด: ${driverCalendarUrl(request.nextUrl.origin)}`
    );

    // แจ้ง ผอ. เฉพาะตอนมีคำขอใหม่ถูกเพิ่มเข้าใบสั่งงานนี้เท่านั้น (addedBookings)
    // — เพราะเฉพาะคำขอที่เพิ่มใหม่เท่านั้นที่กลายเป็น "รอ ผอ. อนุมัติ" รอบใหม่
    // (ดู updateTripOrder ใน lib/sheets.ts) การแก้แค่รถ/คนขับ/เวลา/หมายเหตุของ
    // ใบสั่งงานเดิมไม่กระทบ directorApprovalStatus ของคำขอที่ครอบคลุมอยู่แล้ว
    // เลย (มันรออยู่แบบเดิมอยู่แล้ว ไม่ใช่รายการใหม่ที่ ผอ. ยังไม่เคยรับรู้) ดู
    // คอมเมนต์เต็มที่ notifyDirector ใน lib/lineNotify.ts
    if (addedBookings.length > 0) {
      void notifyDirector(
        `🔔 มีรายการจัดรถรออนุมัติเพิ่มเติม\n` +
          `รถ: ${updated.resourceName}\n` +
          `คนขับ: ${updated.driverName || "—"}\n` +
          `ออกเดินทาง: ${formatBookingDateTime(updated.startTime)}\n` +
          `เพิ่มคำขอใหม่เข้ามารออนุมัติ ${addedBookings.length.toLocaleString("th-TH")} รายการ\n` +
          `ดูรายละเอียด: ${directorApprovalUrl(request.nextUrl.origin)}`
      );
    }

    return NextResponse.json({ tripOrder: updated, addedBookings });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
