import { getSupabaseClient } from "@/lib/supabaseClient";

// ---------------------------------------------------------------------------
// Supabase-backed replacement for the MaintenanceTasks section of
// lib/sheets.ts (MaintenanceTask / getMaintenanceTasks /
// createMaintenanceTasks / updateMaintenanceTask / deleteMaintenanceTask).
// Parallel implementation — does NOT touch lib/sheets.ts.
//
// taskId was already a real uuid in the Sheets version (randomUUID()) —
// preserved as-is at migration, so it now maps 1:1 onto maintenance_tasks.id
// (see supabase/schema.sql's comment on that table). That means, unlike
// equipmentDb.ts, there's no "resolve a legacy number back to a real id"
// step needed here: callers already pass the real id as `taskId`.
//
// actionsTaken/inspectionChecks/plannedActions/actionDetails were one-cell
// JSON strings in the Sheets version; they're native jsonb columns here, so
// no JSON.stringify/parse round-trip is needed at this layer — Supabase's
// client already returns/accepts actual arrays/objects for jsonb columns.
// ---------------------------------------------------------------------------

export type MaintenanceTaskStatus = "in_progress" | "done";
export type InspectionCheck = "ปกติ" | "ส่งซ่อม" | "เปลี่ยนอะไหล่" | "อื่นๆ";

export interface MaintenanceTask {
  taskId: string;
  createdAt: string;
  equipmentRowNumber: number;
  assetNumber: string;
  equipmentType: string;
  brandModel: string;
  department: string;
  location: string;
  assignedToUsername: string;
  assignedToDisplayName: string;
  status: MaintenanceTaskStatus;
  actionsTaken: string[];
  inspectionChecks: InspectionCheck[];
  partsChanged: string;
  otherDetail: string;
  notes: string;
  completedAt: string;
  completedByUsername: string;
  plannedActions: string[];
  actionDetails: Record<string, string>;
}

interface MaintenanceTaskTableRow {
  id: string;
  created_at: string;
  legacy_equipment_row_number: number | null;
  asset_number: string | null;
  equipment_type: string | null;
  brand_model: string | null;
  department: string | null;
  location: string | null;
  assigned_to_username: string | null;
  assigned_to_display_name: string | null;
  status: MaintenanceTaskStatus;
  actions_taken: string[];
  inspection_checks: InspectionCheck[];
  parts_changed: string;
  other_detail: string;
  notes: string;
  completed_at: string | null;
  completed_by_username: string | null;
  planned_actions: string[];
  action_details: Record<string, string>;
}

function rowToTask(row: MaintenanceTaskTableRow): MaintenanceTask {
  return {
    taskId: row.id,
    createdAt: row.created_at,
    equipmentRowNumber: row.legacy_equipment_row_number ?? 0,
    assetNumber: row.asset_number ?? "",
    equipmentType: row.equipment_type ?? "",
    brandModel: row.brand_model ?? "",
    department: row.department ?? "",
    location: row.location ?? "",
    assignedToUsername: row.assigned_to_username ?? "",
    assignedToDisplayName: row.assigned_to_display_name ?? "",
    status: row.status,
    actionsTaken: row.actions_taken ?? [],
    inspectionChecks: row.inspection_checks ?? [],
    partsChanged: row.parts_changed ?? "",
    otherDetail: row.other_detail ?? "",
    notes: row.notes ?? "",
    completedAt: row.completed_at ?? "",
    completedByUsername: row.completed_by_username ?? "",
    plannedActions: row.planned_actions ?? [],
    actionDetails: row.action_details ?? {},
  };
}

/** Every task, oldest first — same ordering contract as the Sheets
 * version. */
export async function getMaintenanceTasks(): Promise<MaintenanceTask[]> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("maintenance_tasks")
    .select("*")
    .order("created_at", { ascending: true });
  if (error) throw new Error(`อ่านรายการงานบำรุงรักษาไม่สำเร็จ: ${error.message}`);
  return (data ?? []).map(rowToTask);
}

/** Supabase equivalent of createMaintenanceTasks(): same signature/
 * defaults (status "in_progress", every other field blank/empty). */
export async function createMaintenanceTasks(
  entries: {
    equipmentRowNumber: number;
    assetNumber: string;
    equipmentType: string;
    brandModel: string;
    department: string;
    location: string;
    assignedToUsername: string;
    assignedToDisplayName: string;
  }[],
  plannedActions: string[] = []
): Promise<MaintenanceTask[]> {
  if (entries.length === 0) return [];
  const supabase = getSupabaseClient();

  const insertRows = entries.map((e) => ({
    legacy_equipment_row_number: e.equipmentRowNumber,
    asset_number: e.assetNumber,
    equipment_type: e.equipmentType,
    brand_model: e.brandModel,
    department: e.department,
    location: e.location,
    assigned_to_username: e.assignedToUsername,
    assigned_to_display_name: e.assignedToDisplayName,
    status: "in_progress" as const,
    actions_taken: [],
    inspection_checks: [],
    parts_changed: "",
    other_detail: "",
    notes: "",
    completed_at: null,
    completed_by_username: null,
    planned_actions: [...plannedActions],
    action_details: {},
  }));

  const { data, error } = await supabase.from("maintenance_tasks").insert(insertRows).select("*");
  if (error) throw new Error(`บันทึกงานบำรุงรักษาไม่สำเร็จ: ${error.message}`);
  return (data ?? []).map(rowToTask);
}

/** Supabase equivalent of updateMaintenanceTask(): merges `updates` into
 * the row identified by taskId (= equipment_tasks.id directly here, no
 * scan-by-value needed the way the Sheets version had to scan for a
 * matching cell — Postgres can just filter on the primary key). */
export async function updateMaintenanceTask(
  taskId: string,
  updates: Partial<
    Pick<
      MaintenanceTask,
      | "status"
      | "actionsTaken"
      | "inspectionChecks"
      | "partsChanged"
      | "otherDetail"
      | "notes"
      | "completedAt"
      | "completedByUsername"
      | "actionDetails"
    >
  >
): Promise<MaintenanceTask> {
  const supabase = getSupabaseClient();

  const patch: Record<string, unknown> = {};
  if (updates.status !== undefined) patch.status = updates.status;
  if (updates.actionsTaken !== undefined) patch.actions_taken = updates.actionsTaken;
  if (updates.inspectionChecks !== undefined) patch.inspection_checks = updates.inspectionChecks;
  if (updates.partsChanged !== undefined) patch.parts_changed = updates.partsChanged;
  if (updates.otherDetail !== undefined) patch.other_detail = updates.otherDetail;
  if (updates.notes !== undefined) patch.notes = updates.notes;
  if (updates.completedAt !== undefined) patch.completed_at = updates.completedAt || null;
  if (updates.completedByUsername !== undefined) patch.completed_by_username = updates.completedByUsername || null;
  if (updates.actionDetails !== undefined) patch.action_details = updates.actionDetails;

  const { data, error } = await supabase
    .from("maintenance_tasks")
    .update(patch)
    .eq("id", taskId)
    .select("*")
    .maybeSingle();
  if (error) throw new Error(`บันทึกงานบำรุงรักษาไม่สำเร็จ: ${error.message}`);
  if (!data) throw new Error("ไม่พบงานนี้ในระบบ — อาจถูกลบหรือแก้ไขไปแล้ว");
  return rowToTask(data);
}

/** Supabase equivalent of deleteMaintenanceTask(): hard-deletes the row,
 * same "done" tasks are never deletable guard as the Sheets version (also
 * still enforced by the caller/API route — kept here too so any other
 * caller gets the same guarantee, matching the old function's own
 * comment). */
export async function deleteMaintenanceTask(taskId: string): Promise<void> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("maintenance_tasks")
    .select("status")
    .eq("id", taskId)
    .maybeSingle();
  if (error) throw new Error(`อ่านรายการงานบำรุงรักษาไม่สำเร็จ: ${error.message}`);
  if (!data) throw new Error("ไม่พบงานนี้ในระบบ — อาจถูกลบไปแล้ว");
  if (data.status === "done") throw new Error("งานนี้เสร็จสิ้นแล้ว ไม่สามารถลบได้");

  const { error: deleteError } = await supabase.from("maintenance_tasks").delete().eq("id", taskId);
  if (deleteError) throw new Error(`ลบงานบำรุงรักษาไม่สำเร็จ: ${deleteError.message}`);
}
