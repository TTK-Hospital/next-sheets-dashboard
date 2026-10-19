import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, canAccessItDashboard, verifySessionToken } from "@/lib/auth";
import { createMaintenanceTasks, getMaintenanceTasks, getUsers } from "@/lib/sheets";

// Always live — task status changes constantly while IT is out doing
// rounds, and this list is small, so caching isn't worth the staleness.
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

/** Every maintenance task (in progress + done) — the task-list/dashboard
 * page filters and aggregates this itself, same as MaintenanceLog. */
export async function GET(request: NextRequest) {
  const { session, response } = requireItAccess(request);
  if (!session) return response;

  try {
    const tasks = await getMaintenanceTasks();
    return NextResponse.json({ tasks });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

interface TaskItemPayload {
  equipmentRowNumber: number;
  assetNumber: string;
  equipmentType: string;
  brandModel: string;
  department: string;
  location: string;
}

function readItemsPayload(body: unknown): TaskItemPayload[] | null {
  if (!body || typeof body !== "object") return null;
  const items = (body as Record<string, unknown>).items;
  if (!Array.isArray(items) || items.length === 0) return null;

  const out: TaskItemPayload[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== "object") return null;
    const it = raw as Record<string, unknown>;
    if (typeof it.equipmentRowNumber !== "number" || !Number.isInteger(it.equipmentRowNumber)) return null;
    if (typeof it.assetNumber !== "string") return null;
    if (typeof it.equipmentType !== "string") return null;
    if (typeof it.brandModel !== "string") return null;
    if (typeof it.department !== "string") return null;
    if (typeof it.location !== "string") return null;
    out.push({
      equipmentRowNumber: it.equipmentRowNumber,
      assetNumber: it.assetNumber,
      equipmentType: it.equipmentType,
      brandModel: it.brandModel,
      department: it.department,
      location: it.location,
    });
  }
  return out;
}

/** The รายการ "การดำเนินการ" selected and printed on this round's report —
 * one shared snapshot applied to every task created from this POST (see
 * MaintenanceTask.plannedActions). Optional/defaults to [] so an older
 * client build that doesn't send it yet still creates tasks, just without
 * the snapshot (same as any other pre-existing task). */
function readPlannedActions(body: unknown): string[] {
  if (!body || typeof body !== "object") return [];
  const raw = (body as Record<string, unknown>).plannedActions;
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === "string");
}

/** Creates one "in progress" task per equipment item — called from the
 * report page the moment an IT account prints/saves the maintenance report,
 * so the equipment list can show "กำลังบำรุงรักษาโดย {ชื่อ}" right away.
 * assignedTo is always the logged-in session's own username/display name —
 * never taken from the request body, same rule as maintenance-log's
 * recordedBy — so a task can't be created and attributed to someone else.
 *
 * Skips any item that already has an in-progress task — printing the same
 * equipment's report a second time (a second copy, a reprint after a
 * mistake, re-selecting it alongside other items) used to always insert
 * another "in progress" row, so the same equipment could end up with two+
 * open tasks for the same visit, both showing up separately (and both
 * "ยังไม่ได้บันทึกรายละเอียดการดำเนินการ" until someone updates one) in the
 * month-strip popup on /manage/it/report. One open task per equipment is
 * enough — printing again just means printing again, not starting a second
 * maintenance round on top of one already in flight. Does not skip when the
 * existing task is already "done": that one's finished, so printing again
 * legitimately starts a new round and gets a fresh task, same as before. */
export async function POST(request: NextRequest) {
  const { session, response } = requireItAccess(request);
  if (!session) return response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "คำขอไม่ถูกต้อง" }, { status: 400 });
  }
  const items = readItemsPayload(body);
  if (!items) {
    return NextResponse.json({ error: "ข้อมูลที่ส่งมาไม่ถูกต้อง" }, { status: 400 });
  }
  const plannedActions = readPlannedActions(body);

  try {
    // Best-effort — a Users tab hiccup shouldn't stop task creation, it
    // just means the task shows the bare login string instead of a Thai
    // display name until the tab is reachable again.
    let displayName = session.username;
    try {
      const users = await getUsers();
      displayName = users.find((u) => u.username === session.username)?.displayName || session.username;
    } catch {
      // fall through with the username
    }

    const existingTasks = await getMaintenanceTasks();
    const alreadyInProgress = new Set(
      existingTasks.filter((t) => t.status === "in_progress").map((t) => t.equipmentRowNumber)
    );
    const itemsToCreate = items.filter((it) => !alreadyInProgress.has(it.equipmentRowNumber));

    const tasks = await createMaintenanceTasks(
      itemsToCreate.map((it) => ({
        ...it,
        assignedToUsername: session.username,
        assignedToDisplayName: displayName,
      })),
      plannedActions
    );
    return NextResponse.json({ tasks, skippedAlreadyInProgress: items.length - itemsToCreate.length });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
