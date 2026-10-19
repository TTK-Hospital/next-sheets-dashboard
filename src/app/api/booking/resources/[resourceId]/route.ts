import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, canManageBookingResources, requestAuditTag, verifySessionToken } from "@/lib/auth";
import { appendEditLog, updateBookingResource } from "@/lib/sheets";
import { isValidResourceImageDataUrl } from "@/lib/booking";

export const dynamic = "force-dynamic";

// No explicit return type here — see the identical helper's doc comment in
// ../route.ts for why that matters for Next's route-handler type checking.
function requireSession(request: NextRequest) {
  const session = verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value);
  if (!session) {
    return { session: null, response: NextResponse.json({ error: "กรุณาเข้าสู่ระบบ" }, { status: 401 }) };
  }
  return { session, response: null };
}

interface ResourceUpdatePayload {
  name?: string;
  detail?: string;
  active?: boolean;
  imageDataUrl?: string;
  seatCount?: number;
}

function readUpdatePayload(body: unknown): ResourceUpdatePayload | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const out: ResourceUpdatePayload = {};
  if (typeof b.name === "string") {
    if (!b.name.trim()) return null;
    out.name = b.name.trim();
  }
  if (typeof b.detail === "string") out.detail = b.detail.trim();
  if (typeof b.active === "boolean") out.active = b.active;
  if (typeof b.imageDataUrl === "string") {
    if (!isValidResourceImageDataUrl(b.imageDataUrl)) return null;
    out.imageDataUrl = b.imageDataUrl;
  }
  if (typeof b.seatCount === "number") {
    if (!Number.isFinite(b.seatCount) || b.seatCount < 0) return null;
    out.seatCount = b.seatCount;
  }
  if (Object.keys(out).length === 0) return null;
  return out;
}

/** Edits a vehicle/meeting room's name/detail/photo, or toggles it
 * active/inactive (soft-deactivate — never hard-deleted, so past bookings
 * keep their meaning). Reachable only by the "it" role or the single
 * env-configured bootstrap superadmin account, per the hospital's explicit
 * request — see canManageBookingResources in lib/auth.ts. */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ resourceId: string }> }) {
  const { session, response } = requireSession(request);
  if (!session) return response;
  if (!canManageBookingResources(session)) {
    return NextResponse.json(
      { error: "แก้ไขรถ/ห้องประชุมได้เฉพาะสิทธิ์ IT และ Superadmin ที่ระบบสร้างให้เท่านั้น" },
      { status: 403 }
    );
  }
  const { resourceId } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "คำขอไม่ถูกต้อง" }, { status: 400 });
  }
  const updates = readUpdatePayload(body);
  if (!updates) {
    return NextResponse.json(
      { error: "ข้อมูลที่ส่งมาไม่ถูกต้อง (รูปภาพต้องมีขนาดไม่เกินที่กำหนด)" },
      { status: 400 }
    );
  }

  try {
    const resource = await updateBookingResource(resourceId, updates);
    // imageDataUrl can be tens of thousands of characters — log that a
    // photo changed, never the data itself, so the audit log stays legible
    // and doesn't balloon in size.
    const changeSummary = Object.entries(updates)
      .map(([k, v]) => (k === "imageDataUrl" ? `imageDataUrl=${v ? "(updated)" : "(removed)"}` : `${k}=${v}`))
      .join(", ");
    await appendEditLog({
      timestamp: new Date().toISOString(),
      action: "แก้ไขทรัพยากรจอง",
      actor: session.username,
      department: session.department,
      oldValue: "",
      newValue: `${resource.name}: ${changeSummary} ${requestAuditTag(request)}`,
    });
    return NextResponse.json({ resource });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
