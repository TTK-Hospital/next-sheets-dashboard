import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, canManageDrivers, requestAuditTag, verifySessionToken } from "@/lib/auth";
import { appendEditLog, createDriver, getDrivers } from "@/lib/sheets";

// Always live — same reasoning as /api/booking/resources: the list is small
// and can change at any time, so caching isn't worth the staleness.
export const dynamic = "force-dynamic";

// No explicit return type here — see the identical helper's doc comment in
// /api/booking/resources/route.ts for why that matters for Next's
// route-handler type checking.
function requireSession(request: NextRequest) {
  const session = verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value);
  if (!session) {
    return { session: null, response: NextResponse.json({ error: "กรุณาเข้าสู่ระบบ" }, { status: 401 }) };
  }
  return { session, response: null };
}

/** Every logged-in account, any role — reading the driver list stays open to
 * whoever can reach the car-dispatch flow at all (TripOrderModal needs the
 * active list to populate its dropdown); only *managing* it is restricted,
 * see canManageDrivers in lib/auth.ts. */
export async function GET(request: NextRequest) {
  const { session, response } = requireSession(request);
  if (!session) return response;

  try {
    const drivers = await getDrivers();
    return NextResponse.json({ drivers });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

function readDriverPayload(body: unknown): { name: string; phone: string } | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (typeof b.name !== "string" || !b.name.trim()) return null;
  if (typeof b.phone !== "string" && typeof b.phone !== "undefined") return null;
  return {
    name: b.name.trim(),
    phone: typeof b.phone === "string" ? b.phone.trim() : "",
  };
}

/** Adds one new driver — reachable only by an account granted the
 * "manageDrivers" permission (bootstrap always; any other superadmin only
 * when specifically granted through /manage/users), per the hospital's
 * explicit request — see canManageDrivers in lib/auth.ts. *Dispatching* a
 * trip order (picking a driver from the dropdown) stays open to every
 * account that can reach that flow; only adding/editing the driver list
 * itself is restricted. */
export async function POST(request: NextRequest) {
  const { session, response } = requireSession(request);
  if (!session) return response;
  if (!canManageDrivers(session)) {
    return NextResponse.json({ error: "เพิ่มคนขับรถได้เฉพาะบัญชีที่ได้รับสิทธิ์เท่านั้น" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "คำขอไม่ถูกต้อง" }, { status: 400 });
  }
  const payload = readDriverPayload(body);
  if (!payload) {
    return NextResponse.json({ error: "ข้อมูลที่ส่งมาไม่ถูกต้อง — กรุณาระบุชื่อคนขับ" }, { status: 400 });
  }

  try {
    const driver = await createDriver({ ...payload, createdByUsername: session.username });
    await appendEditLog({
      timestamp: new Date().toISOString(),
      action: "เพิ่มคนขับรถ",
      actor: session.username,
      department: session.department,
      oldValue: "",
      newValue: `${payload.name} ${requestAuditTag(request)}`,
    });
    return NextResponse.json({ driver });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
