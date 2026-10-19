import { getSupabaseClient } from "@/lib/supabaseClient";
import { DEFAULT_SPEC_STANDARDS, type SpecStandards } from "@/lib/specEvaluation";

// ---------------------------------------------------------------------------
// Supabase-backed replacement for the SpecStandards section of
// lib/sheets.ts (getSpecStandards / updateSpecStandards). Parallel
// implementation — does NOT touch lib/sheets.ts. Re-uses SpecStandards and
// DEFAULT_SPEC_STANDARDS from lib/specEvaluation.ts (the same
// dependency-free module the Sheets version re-exports them from), so both
// layers share one type/defaults definition.
//
// spec_standards is a singleton table, same pattern and same rationale as
// report_settings — see reportSettingsDb.ts's file header comment, which
// applies here identically.
// ---------------------------------------------------------------------------

interface SpecStandardsTableRow {
  min_ram_capacity_gb: string;
  min_ram_type: string;
  require_ssd: string;
  ram_capacity_options: string[];
  ram_speed_options: string[];
  storage_type_options: string[];
  storage_capacity_options: string[];
}

function rowToStandards(row: SpecStandardsTableRow): SpecStandards {
  return {
    minRamCapacityGb: row.min_ram_capacity_gb,
    minRamType: row.min_ram_type,
    requireSsd: row.require_ssd,
    ramCapacityOptions: row.ram_capacity_options,
    ramSpeedOptions: row.ram_speed_options,
    storageTypeOptions: row.storage_type_options,
    storageCapacityOptions: row.storage_capacity_options,
  };
}

/** Supabase equivalent of getSpecStandards(): reads the single
 * spec_standards row, falling back to defaults if it hasn't been seeded
 * yet (pre-migration-script state), same tolerant behavior as the Sheets
 * version's "tab missing -> defaults". */
export async function getSpecStandards(): Promise<SpecStandards> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.from("spec_standards").select("*").eq("id", true).maybeSingle();
  if (error) throw new Error(`อ่านมาตรฐานสเปกไม่สำเร็จ: ${error.message}`);
  return data ? rowToStandards(data as SpecStandardsTableRow) : { ...DEFAULT_SPEC_STANDARDS };
}

/** Supabase equivalent of updateSpecStandards(): merges `updates` into the
 * current standards and upserts the single row back. */
export async function updateSpecStandards(updates: Partial<SpecStandards>): Promise<SpecStandards> {
  const current = await getSpecStandards();
  const merged: SpecStandards = { ...current, ...updates };

  const supabase = getSupabaseClient();
  const { error } = await supabase.from("spec_standards").upsert({
    id: true,
    min_ram_capacity_gb: merged.minRamCapacityGb,
    min_ram_type: merged.minRamType,
    require_ssd: merged.requireSsd,
    ram_capacity_options: merged.ramCapacityOptions,
    ram_speed_options: merged.ramSpeedOptions,
    storage_type_options: merged.storageTypeOptions,
    storage_capacity_options: merged.storageCapacityOptions,
  });
  if (error) throw new Error(`บันทึกมาตรฐานสเปกไม่สำเร็จ: ${error.message}`);

  return merged;
}
