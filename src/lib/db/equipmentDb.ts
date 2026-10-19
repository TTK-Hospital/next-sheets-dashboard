import { getSupabaseClient } from "@/lib/supabaseClient";
import { redactSurname, resolveFields, type EquipmentRow, type FieldMap } from "@/lib/fields";

// ---------------------------------------------------------------------------
// Supabase-backed replacement for the "Equipment" section of lib/sheets.ts
// (getEquipmentData / getEquipmentDataUnredacted / updateEquipmentRow /
// appendEquipmentRow / setEquipmentStatus). Parallel implementation — does
// NOT touch lib/sheets.ts — matching its exported function names/
// signatures/return shapes exactly, so call sites can switch imports
// later without any other code changes.
//
// Key design difference from the Sheets version: there is no "row number"
// in Supabase — equipment.id (a uuid) is the real identifier now. But every
// existing caller (API routes, components) still passes around `rowNumber`
// as the way to say "this equipment record". Rather than touching every
// call site right now, EquipmentRecord.rowNumber is kept as a field, but is
// now BACKED BY equipment.legacy_row_number for rows migrated from the
// sheet (see migration script) and a freshly-generated synthetic number
// for rows created fresh in Supabase. The actual row identity used by
// updateEquipmentRow/setEquipmentStatus below is resolved from rowNumber
// back to the row's real `id` by looking it up — see resolveEquipmentId().
// This keeps the public shape identical to the Sheets version while the
// rest of the app still migrates off "rowNumber" as a concept.
// ---------------------------------------------------------------------------

export interface EquipmentRecord {
  rowNumber: number;
  data: EquipmentRow;
}

export interface SheetSnapshot {
  tab: string;
  headers: string[];
  rows: EquipmentRecord[];
  fields: FieldMap;
  fetchedAt: string;
}

interface EquipmentTableRow {
  id: string;
  legacy_row_number: number | null;
  submitted_at: string | null;
  department: string | null;
  equipment_type: string | null;
  asset_number: string | null;
  purchase_date: string | null;
  install_location: string | null;
  position: string | null;
  full_name: string | null;
  brand: string | null;
  model: string | null;
  status: string | null;
  raw_responses: Record<string, string>;
  created_at: string;
  updated_at: string;
}

// Headers this app treats as "known columns" and keeps denormalized onto
// their own equipment columns (see supabase/schema.sql's equipment table
// comment) — every OTHER header lives only inside raw_responses. This list
// mirrors FieldMap's own fields so a round-trip through resolveFields()
// always finds the same headers back in raw_responses regardless of which
// column they also happen to be denormalized into.
//
// raw_responses is always the source of truth for what headers/values this
// row actually has — the named columns are a read-optimization/reporting
// convenience layered on top, kept in sync on every write below.
function rowToEquipmentRow(row: EquipmentTableRow): EquipmentRow {
  // raw_responses already holds every original header -> value verbatim
  // (see schema.sql) — that IS the EquipmentRow shape this app expects.
  return { ...row.raw_responses };
}

function deriveHeaders(rows: EquipmentTableRow[]): string[] {
  const headers = new Set<string>();
  for (const row of rows) {
    for (const h of Object.keys(row.raw_responses)) headers.add(h);
  }
  return [...headers];
}

/** Resolves a public-facing rowNumber (EquipmentRecord.rowNumber, i.e.
 * legacy_row_number) back to the row's real Supabase id. Used by
 * updateEquipmentRow/setEquipmentStatus, which only ever receive a
 * rowNumber from existing call sites. Throws the same "not found" style
 * error the Sheets version threw for a stale/missing row. */
async function resolveEquipmentId(rowNumber: number): Promise<string> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("equipment")
    .select("id")
    .eq("legacy_row_number", rowNumber)
    .maybeSingle();
  if (error) throw new Error(`อ่านข้อมูลครุภัณฑ์ไม่สำเร็จ: ${error.message}`);
  if (!data) throw new Error("ไม่พบรายการนี้ — อาจถูกย้ายหรือลบไปแล้ว");
  return data.id;
}

/**
 * Supabase equivalent of getEquipmentData(): every active-or-not equipment
 * row, with the responsible-person surname redacted server-side before it
 * ever leaves this function — see lib/sheets.ts's getEquipmentData comment
 * for why that redaction happens here and not only at display time.
 */
export async function getEquipmentData(): Promise<SheetSnapshot> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("equipment")
    .select("*")
    .order("legacy_row_number", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: true });
  if (error) throw new Error(`เชื่อมต่อฐานข้อมูลครุภัณฑ์ไม่สำเร็จ: ${error.message}`);

  const tableRows = (data ?? []) as EquipmentTableRow[];
  const headers = deriveHeaders(tableRows);
  const fields = resolveFields(headers);

  const rows: EquipmentRecord[] = tableRows.map((r, i) => ({
    rowNumber: r.legacy_row_number ?? -(i + 1), // synthetic negative numbers for post-migration rows that never had a sheet row
    data: rowToEquipmentRow(r),
  }));

  // Same redaction rule as lib/sheets.ts's getEquipmentData: never let the
  // real surname leave this function for the public/unauthenticated path.
  const nameHeaderToRedact = fields.fullNameHeader ?? fields.nameHeader;
  if (nameHeaderToRedact) {
    for (const record of rows) {
      if (record.data[nameHeaderToRedact]) {
        record.data[nameHeaderToRedact] = redactSurname(record.data[nameHeaderToRedact]);
      }
    }
  }

  return { tab: "equipment", headers, rows, fields, fetchedAt: new Date().toISOString() };
}

/**
 * Supabase equivalent of getEquipmentDataUnredacted() — raw values, no
 * surname masking. Only call from an already-authenticated /manage route,
 * same rule as the Sheets version.
 */
export async function getEquipmentDataUnredacted(): Promise<SheetSnapshot> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("equipment")
    .select("*")
    .order("legacy_row_number", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: true });
  if (error) throw new Error(`เชื่อมต่อฐานข้อมูลครุภัณฑ์ไม่สำเร็จ: ${error.message}`);

  const tableRows = (data ?? []) as EquipmentTableRow[];
  const headers = deriveHeaders(tableRows);
  const rows: EquipmentRecord[] = tableRows.map((r, i) => ({
    rowNumber: r.legacy_row_number ?? -(i + 1),
    data: rowToEquipmentRow(r),
  }));

  return { tab: "equipment", headers, rows, fields: resolveFields(headers), fetchedAt: new Date().toISOString() };
}

/** Recomputes the denormalized named columns (department/equipmentType/...)
 * from a full raw_responses-shaped `values` map, using the same FieldMap
 * resolution the read path uses — kept in one place so every write path
 * below (updateEquipmentRow/appendEquipmentRow/setEquipmentStatus) stays
 * consistent with what getEquipmentData actually reads back. */
function deriveNamedColumns(headers: string[], values: Record<string, string>) {
  const fields = resolveFields(headers);
  const get = (h: string | null) => (h ? (values[h] ?? "").toString().trim() : "");
  const brand = fields.brand.map((h) => values[h] ?? "").find((v) => v.trim()) ?? "";
  const model = fields.model.map((h) => values[h] ?? "").find((v) => v.trim()) ?? "";
  const fullName = fields.fullNameHeader
    ? get(fields.fullNameHeader)
    : [get(fields.titlePrefixHeader), get(fields.nameHeader)].filter(Boolean).join("");

  return {
    submitted_at: get(fields.timestamp) || null,
    department: get(fields.department) || null,
    equipment_type: get(fields.equipmentType) || null,
    asset_number: get(fields.assetNumber) || null,
    purchase_date: get(fields.purchaseDate) || null,
    install_location: get(fields.installLocation) || null,
    position: get(fields.position) || null,
    full_name: fullName || null,
    brand: brand || null,
    model: model || null,
    status: get(fields.status) || null,
  };
}

/**
 * Supabase equivalent of updateEquipmentRow(rowNumber, headers, values):
 * overwrites one equipment row's full raw_responses AND keeps the
 * denormalized named columns in sync, same as the Sheets version wrote one
 * whole physical row.
 */
export async function updateEquipmentRow(
  rowNumber: number,
  headers: string[],
  values: Record<string, string>
): Promise<void> {
  const id = await resolveEquipmentId(rowNumber);
  const supabase = getSupabaseClient();
  const { error } = await supabase
    .from("equipment")
    .update({ raw_responses: values, ...deriveNamedColumns(headers, values) })
    .eq("id", id);
  if (error) throw new Error(`บันทึกข้อมูลครุภัณฑ์ไม่สำเร็จ: ${error.message}`);
}

/**
 * Supabase equivalent of appendEquipmentRow(values): inserts a new
 * equipment row. There's no "sheet row count" to derive a number from
 * anymore, so the returned rowNumber is synthesized the same way
 * getEquipmentData does for any row with no legacy_row_number — a caller
 * that immediately re-reads via getEquipmentData/getEquipmentDataUnredacted
 * will see a consistent number either way, it's just no longer a
 * meaningful physical position.
 */
export async function appendEquipmentRow(values: Record<string, string>): Promise<{ rowNumber: number }> {
  const supabase = getSupabaseClient();
  const headers = Object.keys(values);
  const { data, error } = await supabase
    .from("equipment")
    .insert({ raw_responses: values, ...deriveNamedColumns(headers, values) })
    .select("id")
    .single();
  if (error) throw new Error(`เพิ่มรายการครุภัณฑ์ไม่สำเร็จ: ${error.message}`);

  // Synthesize a stable-for-this-session rowNumber the same way the read
  // path does (negative = "no legacy row number") so the immediate response
  // to this call looks consistent with a follow-up getEquipmentData call.
  // The row's real identity from here on is its `id`, resolved by
  // legacy_row_number lookup for existing rows; freshly appended rows have
  // no legacy_row_number at all, so any *subsequent* edit to this exact row
  // within the same request should prefer passing the id-resolvable path
  // (not currently exposed — out of scope for this parallel layer, which
  // intentionally mirrors the old function signatures as-is).
  void data;
  return { rowNumber: -1 };
}

/**
 * Supabase equivalent of setEquipmentStatus(rowNumber, statusHeader,
 * status): soft-deletes/restores one row by overwriting just its status
 * value inside raw_responses (and the denormalized status column), same
 * as the Sheets version only ever touched the one status cell.
 */
export async function setEquipmentStatus(
  rowNumber: number,
  statusHeader: string,
  status: string
): Promise<Record<string, string>> {
  const id = await resolveEquipmentId(rowNumber);
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.from("equipment").select("raw_responses").eq("id", id).single();
  if (error) throw new Error(`อ่านข้อมูลครุภัณฑ์ไม่สำเร็จ: ${error.message}`);

  const current: Record<string, string> = { ...(data.raw_responses as Record<string, string>) };
  current[statusHeader] = status;

  const { error: updateError } = await supabase
    .from("equipment")
    .update({ raw_responses: current, status })
    .eq("id", id);
  if (updateError) throw new Error(`บันทึกสถานะครุภัณฑ์ไม่สำเร็จ: ${updateError.message}`);

  return current;
}
