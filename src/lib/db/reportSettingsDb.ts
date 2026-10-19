import { getSupabaseClient } from "@/lib/supabaseClient";
import { resolveColorOrder } from "@/lib/actionColors";

// ---------------------------------------------------------------------------
// Supabase-backed replacement for the ReportSettings section of
// lib/sheets.ts (ReportSettings / DEFAULT_REPORT_SETTINGS /
// getReportSettings / updateReportSettings). Parallel implementation — does
// NOT touch lib/sheets.ts.
//
// report_settings is a singleton table (id boolean PRIMARY KEY DEFAULT true
// CHECK (id) — see supabase/schema.sql), seeded with exactly one row at
// migration. That replaces the Sheets version's "tab missing -> return
// defaults" fallback entirely: the row always exists once migrated, so
// getReportSettings below is a plain select of that one row, no
// tolerant-missing-tab branch needed. updateReportSettings still recomputes
// actionColorOrder server-side exactly like the Sheets version, for the
// same anti-tamper/color-stability reason (see that function's comment in
// lib/sheets.ts).
// ---------------------------------------------------------------------------

export interface ReportSettings {
  orgName: string;
  maintenanceFormTitle: string;
  fiscalYearLabel: string;
  acknowledgerName: string;
  acknowledgerPosition: string;
  acknowledgerDepartment: string;
  printFontSizePt: string;
  printHeaderFontSizePt: string;
  printTableFontSizePx: string;
  printLineHeight: string;
  printSignatureGapPx: string;
  actionOptions: string[];
  hiddenActionOptions: string[];
  detailRequiredActionOptions: string[];
  lockedActionOptions: string[];
  actionColorOrder: string[];
}

export const DEFAULT_REPORT_SETTINGS: ReportSettings = {
  orgName: "โรงพยาบาลท่าตะเกียบ",
  maintenanceFormTitle: "แบบฟอร์มการบำรุงรักษาเชิงป้องกันเครื่องคอมพิวเตอร์และครุภัณฑ์คอมพิวเตอร์",
  fiscalYearLabel: "ประจำปีงบประมาณ 2569",
  acknowledgerName: "นางขนัญธร เสียงล้ำ",
  acknowledgerPosition: "เจ้าพนักงานเวชสถิติชำนาญงาน",
  acknowledgerDepartment: "กลุ่มงานประกันสุขภาพและกลุ่มงานสุขภาพดิจิทัล",
  printFontSizePt: "14",
  printHeaderFontSizePt: "16",
  printTableFontSizePx: "11",
  printLineHeight: "0.9",
  printSignatureGapPx: "16",
  actionOptions: ["บำรุงรักษา"],
  hiddenActionOptions: [],
  detailRequiredActionOptions: [],
  lockedActionOptions: [],
  actionColorOrder: ["บำรุงรักษา"],
};

interface ReportSettingsTableRow {
  org_name: string;
  maintenance_form_title: string;
  fiscal_year_label: string;
  acknowledger_name: string;
  acknowledger_position: string;
  acknowledger_department: string;
  print_font_size_pt: string;
  print_header_font_size_pt: string;
  print_table_font_size_px: string;
  print_line_height: string;
  print_signature_gap_px: string;
  action_options: string[];
  hidden_action_options: string[];
  detail_required_action_options: string[];
  locked_action_options: string[];
  action_color_order: string[];
}

function rowToSettings(row: ReportSettingsTableRow): ReportSettings {
  return {
    orgName: row.org_name,
    maintenanceFormTitle: row.maintenance_form_title,
    fiscalYearLabel: row.fiscal_year_label,
    acknowledgerName: row.acknowledger_name,
    acknowledgerPosition: row.acknowledger_position,
    acknowledgerDepartment: row.acknowledger_department,
    printFontSizePt: row.print_font_size_pt,
    printHeaderFontSizePt: row.print_header_font_size_pt,
    printTableFontSizePx: row.print_table_font_size_px,
    printLineHeight: row.print_line_height,
    printSignatureGapPx: row.print_signature_gap_px,
    actionOptions: row.action_options.length > 0 ? row.action_options : [...DEFAULT_REPORT_SETTINGS.actionOptions],
    hiddenActionOptions: row.hidden_action_options,
    detailRequiredActionOptions: row.detail_required_action_options,
    lockedActionOptions: row.locked_action_options,
    actionColorOrder: row.action_color_order,
  };
}

/** Supabase equivalent of getReportSettings(): reads the single
 * report_settings row. Self-heals actionColorOrder on every read, same as
 * the Sheets version, via the same resolveColorOrder helper. */
export async function getReportSettings(): Promise<ReportSettings> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.from("report_settings").select("*").eq("id", true).maybeSingle();
  if (error) throw new Error(`อ่านการตั้งค่ารายงานไม่สำเร็จ: ${error.message}`);
  // Singleton row should always exist post-migration — but fall back to
  // defaults rather than throw, mirroring the Sheets version's tolerant
  // "tab missing -> defaults" behavior for the one case this hasn't been
  // seeded yet (e.g. a fresh Supabase project before the migration script
  // has run).
  const result = data ? rowToSettings(data as ReportSettingsTableRow) : { ...DEFAULT_REPORT_SETTINGS };
  result.actionColorOrder = resolveColorOrder(result.actionOptions, result.actionColorOrder);
  return result;
}

/** Supabase equivalent of updateReportSettings(): merges `updates` into
 * the current settings and writes the single row back (upsert, in case the
 * singleton hasn't been seeded yet). actionColorOrder is always
 * server-recomputed here too, same anti-tamper rule as the Sheets
 * version — never taken from `updates` directly. */
export async function updateReportSettings(updates: Partial<ReportSettings>): Promise<ReportSettings> {
  const current = await getReportSettings();
  const merged: ReportSettings = { ...current, ...updates };
  merged.actionColorOrder = resolveColorOrder(merged.actionOptions, current.actionColorOrder);

  const supabase = getSupabaseClient();
  const { error } = await supabase.from("report_settings").upsert({
    id: true,
    org_name: merged.orgName,
    maintenance_form_title: merged.maintenanceFormTitle,
    fiscal_year_label: merged.fiscalYearLabel,
    acknowledger_name: merged.acknowledgerName,
    acknowledger_position: merged.acknowledgerPosition,
    acknowledger_department: merged.acknowledgerDepartment,
    print_font_size_pt: merged.printFontSizePt,
    print_header_font_size_pt: merged.printHeaderFontSizePt,
    print_table_font_size_px: merged.printTableFontSizePx,
    print_line_height: merged.printLineHeight,
    print_signature_gap_px: merged.printSignatureGapPx,
    action_options: merged.actionOptions,
    hidden_action_options: merged.hiddenActionOptions,
    detail_required_action_options: merged.detailRequiredActionOptions,
    locked_action_options: merged.lockedActionOptions,
    action_color_order: merged.actionColorOrder,
  });
  if (error) throw new Error(`บันทึกการตั้งค่ารายงานไม่สำเร็จ: ${error.message}`);

  return merged;
}
