import { getSupabaseClient } from "@/lib/supabaseClient";
import type { MaintenanceLogEntry } from "@/lib/maintenanceLog";

// ---------------------------------------------------------------------------
// Supabase-backed replacement for the MaintenanceLog section of
// lib/sheets.ts (getMaintenanceLog / appendMaintenanceLogEntry). Parallel
// implementation — does NOT touch lib/sheets.ts. Re-uses MaintenanceLogEntry
// from lib/maintenanceLog.ts (the same dependency-free module the Sheets
// version re-exports it from), so both layers share one type definition —
// that module has no Google/Supabase dependency either way, so importing it
// here doesn't pull in anything Sheets-specific.
//
// Unlike the Sheets tab (append-only, no fallback-tolerant-missing-tab
// concept applies to a real table), reading an empty table here naturally
// returns [] with no special-case needed — the "tab doesn't exist yet"
// branch in the old getMaintenanceLog() has no Supabase equivalent.
// ---------------------------------------------------------------------------

interface MaintenanceLogTableRow {
  timestamp: string;
  asset_number: string;
  recorded_by: string;
  software: string;
  maintenance_date: string | null;
  manual_spec_status: "" | "ปกติ" | "ต่ำกว่ามาตรฐาน";
  notes: string;
}

function rowToEntry(row: MaintenanceLogTableRow): MaintenanceLogEntry {
  return {
    timestamp: row.timestamp,
    assetNumber: row.asset_number,
    recordedBy: row.recorded_by,
    software: row.software,
    maintenanceDate: row.maintenance_date ?? "",
    manualSpecStatus: row.manual_spec_status,
    notes: row.notes,
  };
}

/** Every logged maintenance visit, oldest first — same ordering contract
 * as the Sheets version (append order), via an explicit ORDER BY. */
export async function getMaintenanceLog(): Promise<MaintenanceLogEntry[]> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("maintenance_log")
    .select("*")
    .order("timestamp", { ascending: true });
  if (error) throw new Error(`อ่านประวัติการบำรุงรักษาไม่สำเร็จ: ${error.message}`);
  return (data ?? []).map(rowToEntry);
}

/** Supabase equivalent of appendMaintenanceLogEntry() — same optional
 * `timestamp` (defaults to now, same as the Sheets version) and the same
 * field set otherwise. */
export async function appendMaintenanceLogEntry(
  entry: Omit<MaintenanceLogEntry, "timestamp"> & { timestamp?: string }
): Promise<void> {
  const supabase = getSupabaseClient();
  const timestamp = entry.timestamp ?? new Date().toISOString();
  const { error } = await supabase.from("maintenance_log").insert({
    timestamp,
    asset_number: entry.assetNumber,
    recorded_by: entry.recordedBy,
    software: entry.software,
    maintenance_date: entry.maintenanceDate || null,
    manual_spec_status: entry.manualSpecStatus,
    notes: entry.notes,
  });
  if (error) throw new Error(`บันทึกประวัติการบำรุงรักษาไม่สำเร็จ: ${error.message}`);
}
