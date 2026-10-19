import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, canAccessItDashboard, verifySessionToken } from "@/lib/auth";
import { getSpecStandards, updateSpecStandards, type SpecStandards } from "@/lib/sheets";

// Always live — a low-traffic settings screen, not a hot path.
export const dynamic = "force-dynamic";

function requireItAccess(request: NextRequest) {
  const session = verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value);
  if (!session) {
    return { session: null, response: NextResponse.json({ error: "กรุณาเข้าสู่ระบบ" }, { status: 401 }) };
  }
  if (!canAccessItDashboard(session)) {
    return {
      session: null,
      response: NextResponse.json({ error: "ไม่มีสิทธิ์เข้าถึงหน้านี้" }, { status: 403 }),
    };
  }
  return { session, response: null };
}

/** Current automatic spec-evaluation thresholds — falls back to sensible
 * defaults if the SpecStandards tab doesn't exist yet (see
 * getSpecStandards). */
export async function GET(request: NextRequest) {
  const { session, response } = requireItAccess(request);
  if (!session) return response;

  try {
    const standards = await getSpecStandards();
    return NextResponse.json({ standards });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

function readStandardsPayload(body: unknown): Partial<SpecStandards> | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  // Deliberately excludes ramCapacityOptions/ramSpeedOptions/
  // storageTypeOptions/storageCapacityOptions — those four are edited
  // through the more broadly reachable /api/manage/spec-options instead
  // (see that route's own comment for why), not this it-only route.
  const allowedKeys: Exclude<
    keyof SpecStandards,
    "ramCapacityOptions" | "ramSpeedOptions" | "storageTypeOptions" | "storageCapacityOptions"
  >[] = ["minRamCapacityGb", "minRamType", "requireSsd"];
  const out: Partial<SpecStandards> = {};
  for (const key of allowedKeys) {
    if (b[key] === undefined) continue;
    if (typeof b[key] !== "string") return null;
    out[key] = (b[key] as string).trim();
  }
  return out;
}

/** Updates one or more thresholds — requires the SpecStandards tab to
 * already exist (see updateSpecStandards), unlike GET which tolerates a
 * missing tab by returning defaults. */
export async function PATCH(request: NextRequest) {
  const { session, response } = requireItAccess(request);
  if (!session) return response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "คำขอไม่ถูกต้อง" }, { status: 400 });
  }
  const updates = readStandardsPayload(body);
  if (!updates) {
    return NextResponse.json({ error: "ข้อมูลที่ส่งมาไม่ถูกต้อง" }, { status: 400 });
  }

  try {
    const standards = await updateSpecStandards(updates);
    return NextResponse.json({ standards });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
