import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, canAccessItDashboard, verifySessionToken } from "@/lib/auth";
import { appendMaintenanceLogEntry, getMaintenanceLog, type MaintenanceLogEntry } from "@/lib/sheets";

// Always live — this is a small append-only log, not worth caching.
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

/** Full maintenance-visit history — every logged entry, oldest first,
 * optionally narrowed to one เลขครุภัณฑ์ via ?assetNumber=. The dashboard
 * derives "current status per machine" from this itself
 * (getLatestMaintenanceLogByAsset) rather than the API doing it, so a single
 * fetch on page load covers both the table's status column and each row's
 * full-history view. */
export async function GET(request: NextRequest) {
  const { session, response } = requireItAccess(request);
  if (!session) return response;

  try {
    const entries = await getMaintenanceLog();
    const assetNumber = request.nextUrl.searchParams.get("assetNumber")?.trim();
    const filtered = assetNumber ? entries.filter((e) => e.assetNumber === assetNumber) : entries;
    return NextResponse.json({ entries: filtered });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

type LogPostPayload = Omit<MaintenanceLogEntry, "timestamp" | "recordedBy">;

function readPayload(body: unknown): LogPostPayload | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;

  if (typeof b.assetNumber !== "string" || !b.assetNumber.trim()) return null;
  if (typeof b.software !== "string") return null;
  if (typeof b.maintenanceDate !== "string") return null;
  if (typeof b.notes !== "string") return null;
  const manualSpecStatus = b.manualSpecStatus;
  if (manualSpecStatus !== "" && manualSpecStatus !== "ปกติ" && manualSpecStatus !== "ต่ำกว่ามาตรฐาน") {
    return null;
  }
  // A visit with nothing at all to say (no software change, no cleaning
  // date, no manual assessment, no note) is almost certainly a client bug —
  // reject it rather than logging an empty row.
  if (!b.software.trim() && !b.maintenanceDate.trim() && !manualSpecStatus && !b.notes.trim()) {
    return null;
  }

  return {
    assetNumber: b.assetNumber.trim(),
    software: b.software.trim(),
    maintenanceDate: b.maintenanceDate.trim(),
    manualSpecStatus,
    notes: b.notes.trim(),
  };
}

/** Appends one maintenance-visit row. recordedBy is always the logged-in
 * session's own username — never taken from the request body — so the audit
 * trail can't be spoofed to say a different IT staff member did the work.
 * Requires the MaintenanceLog tab to already exist (see
 * appendMaintenanceLogEntry). */
export async function POST(request: NextRequest) {
  const { session, response } = requireItAccess(request);
  if (!session) return response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "คำขอไม่ถูกต้อง" }, { status: 400 });
  }
  const payload = readPayload(body);
  if (!payload) {
    return NextResponse.json({ error: "ข้อมูลที่ส่งมาไม่ถูกต้อง" }, { status: 400 });
  }

  try {
    await appendMaintenanceLogEntry({ ...payload, recordedBy: session.username });
    const entries = await getMaintenanceLog();
    return NextResponse.json({ entries: entries.filter((e) => e.assetNumber === payload.assetNumber) });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
