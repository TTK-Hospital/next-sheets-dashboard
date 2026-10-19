import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";
import { getSpecStandards, updateSpecStandards, type SpecOptionLists } from "@/lib/sheets";

// Always live — a low-traffic settings screen, not a hot path.
export const dynamic = "force-dynamic";

const OPTION_KEYS: (keyof SpecOptionLists)[] = [
  "ramCapacityOptions",
  "ramSpeedOptions",
  "storageTypeOptions",
  "storageCapacityOptions",
];

function requireSession(request: NextRequest) {
  const session = verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value);
  if (!session) {
    return { session: null, response: NextResponse.json({ error: "กรุณาเข้าสู่ระบบ" }, { status: 401 }) };
  }
  return { session, response: null };
}

/**
 * Dropdown choices for "ความจุ RAM"/"ความเร็ว RAM"/"ประเภทหน่วยจัดเก็บ"/
 * "ความจุจัดเก็บ" — shown in BulkEditSpecModal and EquipmentFormModal via
 * EditableSelect. Stored in the same SpecStandards tab as /manage/it's
 * auto-evaluation thresholds (see getSpecStandards/updateSpecStandards,
 * lib/sheets.ts) but this route is deliberately open to every logged-in
 * account, not just canAccessItDashboard — EquipmentFormModal is the shared
 * add/edit form reachable from the general /manage table too
 * (admin/superadmin), and the hospital asked that anyone filling in these
 * fields can add a new choice on the spot, not just IT. It only ever
 * reads/writes these four list fields — the numeric thresholds
 * (minRamCapacityGb, minRamType, requireSsd) stay editable through
 * /api/manage/it/spec-standards alone, which keeps its existing
 * canAccessItDashboard gate untouched.
 */
export async function GET(request: NextRequest) {
  const { session, response } = requireSession(request);
  if (!session) return response;

  try {
    const standards = await getSpecStandards();
    const options: SpecOptionLists = {
      ramCapacityOptions: standards.ramCapacityOptions,
      ramSpeedOptions: standards.ramSpeedOptions,
      storageTypeOptions: standards.storageTypeOptions,
      storageCapacityOptions: standards.storageCapacityOptions,
    };
    return NextResponse.json(options);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

function readPayload(body: unknown): Partial<SpecOptionLists> | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const out: Partial<SpecOptionLists> = {};
  for (const key of OPTION_KEYS) {
    if (b[key] === undefined) continue;
    if (!Array.isArray(b[key]) || !(b[key] as unknown[]).every((x) => typeof x === "string")) return null;
    // Dedup — the client always sends "current list + the one new value",
    // so a double-submit or a value that already exists never produces a
    // duplicate entry.
    const cleaned = Array.from(new Set((b[key] as string[]).map((s) => s.trim()).filter(Boolean)));
    out[key] = cleaned;
  }
  if (Object.keys(out).length === 0) return null;
  return out;
}

/** Adds/updates one or more of the four option lists — requires the
 * SpecStandards tab to already exist (see updateSpecStandards), unlike GET
 * which tolerates a missing tab by returning defaults. */
export async function PATCH(request: NextRequest) {
  const { session, response } = requireSession(request);
  if (!session) return response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "คำขอไม่ถูกต้อง" }, { status: 400 });
  }
  const updates = readPayload(body);
  if (!updates) {
    return NextResponse.json({ error: "ข้อมูลที่ส่งมาไม่ถูกต้อง" }, { status: 400 });
  }

  try {
    const standards = await updateSpecStandards(updates);
    const options: SpecOptionLists = {
      ramCapacityOptions: standards.ramCapacityOptions,
      ramSpeedOptions: standards.ramSpeedOptions,
      storageTypeOptions: standards.storageTypeOptions,
      storageCapacityOptions: standards.storageCapacityOptions,
    };
    return NextResponse.json(options);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
