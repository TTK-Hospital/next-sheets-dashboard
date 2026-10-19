import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, canAccessItDashboard, verifySessionToken } from "@/lib/auth";
import { deleteMaintenanceTask, updateMaintenanceTask, type InspectionCheck, type MaintenanceTask } from "@/lib/sheets";

export const dynamic = "force-dynamic";

const INSPECTION_CHECKS: InspectionCheck[] = ["ปกติ", "ส่งซ่อม", "เปลี่ยนอะไหล่", "อื่นๆ"];

type UpdatePayload = Partial<
  Pick<
    MaintenanceTask,
    "status" | "actionsTaken" | "inspectionChecks" | "partsChanged" | "otherDetail" | "notes" | "actionDetails"
  >
>;

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/** actionDetails is a plain object of string -> string (action name -> IT's
 * free-text detail, see MaintenanceTask.actionDetails) — trims each value
 * and drops any that end up empty, same "don't store noise" rule as
 * actionsTaken's trim+filter above. Rejects the whole payload (returns null)
 * if any value isn't a string, same strictness as isStringArray. */
function isStringRecord(v: unknown): v is Record<string, string> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  return Object.values(v as Record<string, unknown>).every((x) => typeof x === "string");
}

function readPayload(body: unknown): UpdatePayload | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const out: UpdatePayload = {};

  if (b.status !== undefined) {
    if (b.status !== "in_progress" && b.status !== "done") return null;
    out.status = b.status;
  }
  if (b.actionsTaken !== undefined) {
    if (!isStringArray(b.actionsTaken)) return null;
    out.actionsTaken = b.actionsTaken.map((s) => s.trim()).filter(Boolean);
  }
  if (b.inspectionChecks !== undefined) {
    if (!isStringArray(b.inspectionChecks)) return null;
    const checks = b.inspectionChecks.filter((s): s is InspectionCheck =>
      INSPECTION_CHECKS.includes(s as InspectionCheck)
    );
    out.inspectionChecks = checks;
  }
  if (b.partsChanged !== undefined) {
    if (typeof b.partsChanged !== "string") return null;
    out.partsChanged = b.partsChanged.trim();
  }
  if (b.otherDetail !== undefined) {
    if (typeof b.otherDetail !== "string") return null;
    out.otherDetail = b.otherDetail.trim();
  }
  if (b.notes !== undefined) {
    if (typeof b.notes !== "string") return null;
    out.notes = b.notes.trim();
  }
  if (b.actionDetails !== undefined) {
    if (!isStringRecord(b.actionDetails)) return null;
    const trimmed: Record<string, string> = {};
    for (const [k, v] of Object.entries(b.actionDetails)) {
      const value = v.trim();
      if (value) trimmed[k] = value;
    }
    out.actionDetails = trimmed;
  }
  // Reject a genuinely empty payload (no recognized field at all) — anything
  // else, including a status-only "mark done" call, is valid.
  if (Object.keys(out).length === 0) return null;
  return out;
}

/** Updates one task — saving a draft (การดำเนินการ/ผลการตรวจสอบ/หมายเหตุ
 * while still "in_progress") or closing it ("เสร็จสิ้น", status: "done").
 * Any IT-dashboard account can update any task, not just the one it was
 * assigned to — a small IT team covering for a colleague on leave shouldn't
 * be blocked, matching this app's "informational, not a lock" concurrency
 * choice for tasks in general. Closing (status "done") always stamps
 * completedAt/completedByUsername server-side from the current session,
 * never from the request body. */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  const session = verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value);
  if (!session) {
    return NextResponse.json({ error: "กรุณาเข้าสู่ระบบ" }, { status: 401 });
  }
  if (!canAccessItDashboard(session)) {
    return NextResponse.json({ error: "ไม่มีสิทธิ์เข้าถึงหน้านี้" }, { status: 403 });
  }

  const { taskId } = await params;
  if (!taskId) {
    return NextResponse.json({ error: "ไม่พบงานนี้" }, { status: 400 });
  }

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
  const finalUpdates: Parameters<typeof updateMaintenanceTask>[1] = { ...updates };
  if (updates.status === "done") {
    finalUpdates.completedAt = new Date().toISOString();
    finalUpdates.completedByUsername = session.username;
  }

  try {
    const task = await updateMaintenanceTask(taskId, finalUpdates);
    return NextResponse.json({ task });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** Deletes one task outright — for a mistakenly-created task (wrong
 * equipment selected, duplicate print), not a normal "close this task"
 * action (that's PATCH status:"done"). Same access rule as PATCH: any
 * IT-dashboard account, not just the one who created it. */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ taskId: string }> }) {
  const session = verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value);
  if (!session) {
    return NextResponse.json({ error: "กรุณาเข้าสู่ระบบ" }, { status: 401 });
  }
  if (!canAccessItDashboard(session)) {
    return NextResponse.json({ error: "ไม่มีสิทธิ์เข้าถึงหน้านี้" }, { status: 403 });
  }

  const { taskId } = await params;
  if (!taskId) {
    return NextResponse.json({ error: "ไม่พบงานนี้" }, { status: 400 });
  }

  try {
    await deleteMaintenanceTask(taskId);
    return NextResponse.json({ ok: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
