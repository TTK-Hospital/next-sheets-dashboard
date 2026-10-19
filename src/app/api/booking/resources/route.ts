import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, canManageBookingResources, requestAuditTag, verifySessionToken } from "@/lib/auth";
import { appendEditLog, createBookingResource, getBookingResources } from "@/lib/sheets";
import { isValidResourceImageDataUrl, type BookingResourceType } from "@/lib/booking";

// Always live — resources can be added by any logged-in account at any
// time and the list is small, so caching isn't worth the staleness.
export const dynamic = "force-dynamic";

/** Every logged-in account, any role — resource management was explicitly
 * opened up equally, see lib/booking.ts's top comment. Only "must be
 * logged in" is required, same shape as requireItAccess in
 * /api/manage/it/tasks but without the extra role check.
 *
 * No explicit return type annotation here on purpose — leaving it to be
 * inferred keeps the two branches a true discriminated union (session:
 * null paired with a real response, vs. session: SessionPayload paired
 * with response: null), which is what lets `if (!session) return
 * response;` below narrow `response` to a non-null NextResponse. An
 * explicit `{ session: ...; response: NextResponse | null }` annotation
 * would flatten that into one shape and make `response` look possibly
 * null everywhere, which Next's route-handler type (Response, never null)
 * rejects. */
function requireSession(request: NextRequest) {
  const session = verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value);
  if (!session) {
    return { session: null, response: NextResponse.json({ error: "กรุณาเข้าสู่ระบบ" }, { status: 401 }) };
  }
  return { session, response: null };
}

export async function GET(request: NextRequest) {
  const { session, response } = requireSession(request);
  if (!session) return response;

  try {
    const resources = await getBookingResources();
    return NextResponse.json({ resources });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

function readResourcePayload(
  body: unknown
): { type: BookingResourceType; name: string; detail: string; imageDataUrl: string; seatCount: number } | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (b.type !== "car" && b.type !== "room") return null;
  if (typeof b.name !== "string" || !b.name.trim()) return null;
  if (typeof b.detail !== "string" && typeof b.detail !== "undefined") return null;
  if (typeof b.imageDataUrl !== "string" && typeof b.imageDataUrl !== "undefined") return null;
  const imageDataUrl = typeof b.imageDataUrl === "string" ? b.imageDataUrl : "";
  if (!isValidResourceImageDataUrl(imageDataUrl)) return null;
  // seatCount is only meaningful for a car — accepted here regardless (kept
  // simple) but createBookingResource always stores 0 for a room, so a
  // stray value sent for a room is silently dropped rather than rejected.
  if (typeof b.seatCount !== "number" && typeof b.seatCount !== "undefined") return null;
  const seatCount = typeof b.seatCount === "number" ? b.seatCount : 0;
  if (!Number.isFinite(seatCount) || seatCount < 0) return null;
  return {
    type: b.type,
    name: b.name.trim(),
    detail: typeof b.detail === "string" ? b.detail.trim() : "",
    imageDataUrl,
    seatCount,
  };
}

/** Adds one new vehicle or meeting room — reachable only by the "it" role
 * or the single env-configured bootstrap superadmin account, per the
 * hospital's explicit request — see canManageBookingResources in
 * lib/auth.ts. *Making a booking* (POST /api/booking/bookings) stays open
 * to every logged-in account; only resource management is restricted. */
export async function POST(request: NextRequest) {
  const { session, response } = requireSession(request);
  if (!session) return response;
  if (!canManageBookingResources(session)) {
    return NextResponse.json(
      { error: "เพิ่มรถ/ห้องประชุมได้เฉพาะสิทธิ์ IT และ Superadmin ที่ระบบสร้างให้เท่านั้น" },
      { status: 403 }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "คำขอไม่ถูกต้อง" }, { status: 400 });
  }
  const payload = readResourcePayload(body);
  if (!payload) {
    return NextResponse.json(
      { error: "ข้อมูลที่ส่งมาไม่ถูกต้อง — กรุณาระบุประเภทและชื่อ (รูปภาพต้องมีขนาดไม่เกินที่กำหนด)" },
      { status: 400 }
    );
  }

  try {
    const resource = await createBookingResource({ ...payload, createdByUsername: session.username });
    await appendEditLog({
      timestamp: new Date().toISOString(),
      action: "เพิ่มทรัพยากรจอง",
      actor: session.username,
      department: session.department,
      oldValue: "",
      newValue: `${payload.type === "car" ? "รถ" : "ห้องประชุม"}: ${payload.name} ${requestAuditTag(request)}`,
    });
    return NextResponse.json({ resource });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
