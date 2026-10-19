import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, canManageDrivers, requestAuditTag, verifySessionToken } from "@/lib/auth";
import { appendEditLog, updateDriver } from "@/lib/sheets";

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

interface DriverUpdatePayload {
  name?: string;
  phone?: string;
  active?: boolean;
}

function readUpdatePayload(body: unknown): DriverUpdatePayload | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const out: DriverUpdatePayload = {};
  if (typeof b.name === "string") {
    if (!b.name.trim()) return null;
    out.name = b.name.trim();
  }
  if (typeof b.phone === "string") out.phone = b.phone.trim();
  if (typeof b.active === "boolean") out.active = b.active;
  if (Object.keys(out).length === 0) return null;
  return out;
}

/** Edits a driver's name/phone, or toggles it active/inactive
 * (soft-deactivate — never hard-deleted, so a past TripOrder's driverName
 * snapshot keeps its meaning). Reachable only by an account granted the
 * "manageDrivers" permission — see canManageDrivers in lib/auth.ts. */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ driverId: string }> }) {
  const { session, response } = requireSession(request);
  if (!session) return response;
  if (!canManageDrivers(session)) {
    return NextResponse.json({ error: "แก้ไขคนขับรถได้เฉพาะบัญชีที่ได้รับสิทธิ์เท่านั้น" }, { status: 403 });
  }
  const { driverId } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "คำขอไม่ถูกต้อง" }, { status: 400 });
  }
  const updates = readUpdatePayload(body);
  if (!updates) {
    return NextResponse.json({ error: "ข้อมูลที่ส่งมาไม่ถูกต้อง" }, { status: 400 });
  }

  try {
    const driver = await updateDriver(driverId, updates);
    const changeSummary = Object.entries(updates)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    await appendEditLog({
      timestamp: new Date().toISOString(),
      action: "แก้ไขคนขับรถ",
      actor: session.username,
      department: session.department,
      oldValue: "",
      newValue: `${driver.name}: ${changeSummary} ${requestAuditTag(request)}`,
    });
    return NextResponse.json({ driver });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
