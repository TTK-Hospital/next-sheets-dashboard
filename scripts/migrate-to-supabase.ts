/**
 * One-time data migration: Google Sheets -> Supabase.
 *
 * Run with:  npx tsx scripts/migrate-to-supabase.ts
 * Requires .env.local to have both the Google Sheets credentials
 * (GOOGLE_SHEET_ID / GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_PRIVATE_KEY) AND
 * the Supabase credentials (NEXT_PUBLIC_SUPABASE_URL /
 * SUPABASE_SERVICE_ROLE_KEY) already set.
 *
 * SAFE TO RE-RUN: every table except the three settings singletons is
 * migrated as "delete everything currently in this Supabase table, then
 * re-insert fresh from the current Google Sheet". This means running the
 * script twice in a row (e.g. to pick up late edits made in the Sheet
 * before the real cutover) just re-does the whole migration cleanly — it
 * never doubles up rows. The three singleton settings tables
 * (report_settings / spec_standards / director_settings) are always
 * UPDATEd in place, which is naturally re-run-safe too.
 *
 * This script ONLY reads from Google Sheets and ONLY writes to Supabase.
 * It never touches the Sheet itself, so the Sheet remains a safe fallback
 * for as long as needed — see the project's migration plan.
 *
 * Tables are migrated in FK-dependency order:
 *   equipment -> edit_log -> users -> report_settings -> spec_standards ->
 *   director_settings -> maintenance_log -> maintenance_tasks ->
 *   booking_resources -> drivers -> trip_orders -> bookings
 *
 * UUID preservation: bookings/trip_orders/booking_resources/drivers/
 * maintenance_tasks already had an app-generated uuid in the Sheets era
 * (bookingId/tripOrderId/resourceId/driverId/taskId) — those exact values
 * are carried over as the new Postgres `id`, so nothing that already
 * references one of these ids (a past LINE notification, a URL) breaks.
 * equipment/edit_log/maintenance_log never had an app-level id in Sheets
 * (only a sheet row number), so they get a fresh id at migration time;
 * the old row number is kept only as an audit-only legacy_row_number
 * column, and edit_log.equipment_id / maintenance_log.equipment_id /
 * maintenance_tasks.equipment_id are filled in on a BEST-EFFORT basis
 * (see matchByLegacyRowNumber / matchByAssetNumber below) — a row that
 * can't be matched just gets equipment_id = NULL, same meaning
 * ON DELETE SET NULL already gives that column.
 *
 * Logging convention: only row counts and ids are ever printed, never a
 * full field value (name, phone, note, password hash, etc.) — the
 * terminal running this script, and any log that captures its output,
 * should never end up holding real resident/personnel data.
 */

import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { google } from "googleapis";
import { getSupabaseClient } from "@/lib/supabaseClient";
import { deriveNamedColumns } from "@/lib/db/equipmentDb";
import { updateReportSettings } from "@/lib/db/reportSettingsDb";
import { updateSpecStandards } from "@/lib/db/specStandardsDb";
import { setDirectorPasswordHash } from "@/lib/db/directorSettingsDb";
import {
  getEquipmentDataUnredacted,
  getUsers,
  getReportSettings,
  getMaintenanceLog,
  getMaintenanceTasks,
  getSpecStandards,
  getBookingResources,
  getDrivers,
  getBookings,
  getTripOrders,
  getDirectorPasswordHash,
  type SheetSnapshot,
} from "@/lib/sheets";

function log(message: string) {
  console.log(`[migrate] ${new Date().toISOString()} ${message}`);
}

function getEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env var ${name} (check .env.local)`);
  return value;
}

/** "" -> null, everything else passed through unchanged. Mirrors the
 * Postgres-NULL <-> Sheets-blank-string convention already established by
 * src/lib/db/bookingsDb.ts's rowToBooking() comment, just in the opposite
 * (write) direction. */
function N(value: string | null | undefined): string | null {
  const v = (value ?? "").trim();
  return v === "" ? null : (value as string);
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

type SupabaseClientType = ReturnType<typeof getSupabaseClient>;

/** Deletes every row of a uuid-keyed table (every table here has a
 * non-null `id` column, so this filter matches "all rows") before a fresh
 * re-insert — see the file header comment for why this is safe to re-run. */
async function deleteAllRows(supabase: SupabaseClientType, table: string): Promise<void> {
  const { error } = await supabase.from(table).delete().not("id", "is", null);
  if (error) throw new Error(`delete from ${table} failed: ${error.message}`);
}

async function insertChunked(
  supabase: SupabaseClientType,
  table: string,
  rows: Record<string, unknown>[],
  chunkSize = 500
): Promise<number> {
  let inserted = 0;
  for (const part of chunk(rows, chunkSize)) {
    if (part.length === 0) continue;
    const { error } = await supabase.from(table).insert(part);
    if (error) {
      throw new Error(
        `insert into ${table} failed at rows ${inserted}-${inserted + part.length - 1}: ${error.message}`
      );
    }
    inserted += part.length;
  }
  return inserted;
}

// ---------------------------------------------------------------------------
// EditLog has no existing getter in lib/sheets.ts (only appendEditLog, a
// write-only helper) — see the migration plan's research notes. Read the
// tab's raw rows directly here instead, using a read-only scope (this
// script never writes back to the Sheet). Column layout A-H matches
// appendEditLog's own write order exactly:
//   timestamp | action | actor | department | rowNumber | column | oldValue | newValue
// ---------------------------------------------------------------------------
interface RawEditLogEntry {
  timestamp: string;
  action: string;
  actor: string;
  department: string;
  rowNumber: number | null;
  column: string | null;
  oldValue: string;
  newValue: string;
}

let cachedReadOnlyAuth: ReturnType<typeof buildReadOnlyAuth> | null = null;
function buildReadOnlyAuth() {
  return new google.auth.GoogleAuth({
    credentials: {
      client_email: getEnv("GOOGLE_SERVICE_ACCOUNT_EMAIL"),
      private_key: getEnv("GOOGLE_PRIVATE_KEY").replace(/\\n/g, "\n"),
    },
    // Read-only: this script never writes back to Google Sheets.
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
}
function readOnlySheetsAuth() {
  if (!cachedReadOnlyAuth) cachedReadOnlyAuth = buildReadOnlyAuth();
  return cachedReadOnlyAuth;
}

async function readEditLogRaw(): Promise<RawEditLogEntry[]> {
  const spreadsheetId = getEnv("GOOGLE_SHEET_ID");
  const tab = process.env.GOOGLE_SHEET_EDIT_LOG_TAB?.trim() || "EditLog";
  const sheetsApi = google.sheets({ version: "v4", auth: readOnlySheetsAuth() });

  const res = await sheetsApi.spreadsheets.values.get({
    spreadsheetId,
    range: `${tab}!A2:H`, // A1:H1 is the header row, skip it
  });
  const values = (res.data.values as string[][] | undefined) ?? [];

  return values
    .filter((r) => r.some((cell) => (cell ?? "").toString().trim() !== ""))
    .map((r) => {
      const rowNumberRaw = (r[4] ?? "").toString().trim();
      const columnRaw = (r[5] ?? "").toString().trim();
      return {
        timestamp: (r[0] ?? "").toString(),
        action: (r[1] ?? "").toString(),
        actor: (r[2] ?? "").toString(),
        department: (r[3] ?? "").toString(),
        rowNumber: rowNumberRaw === "" ? null : Number(rowNumberRaw),
        column: columnRaw === "" ? null : columnRaw,
        oldValue: (r[6] ?? "").toString(),
        newValue: (r[7] ?? "").toString(),
      };
    });
}

// ---------------------------------------------------------------------------
// Per-table migration steps. Each one is called from main() inside its own
// try/catch (isolated error handling) so one table's failure doesn't stop
// the rest of the migration from running.
// ---------------------------------------------------------------------------

interface EquipmentMatchMaps {
  byLegacyRowNumber: Map<number, string>;
  byAssetNumber: Map<string, string>;
}

async function migrateEquipment(
  supabase: SupabaseClientType,
  snapshot: SheetSnapshot
): Promise<{ inserted: number; maps: EquipmentMatchMaps }> {
  await deleteAllRows(supabase, "equipment");

  const headers = snapshot.headers;
  const rows = snapshot.rows.map((r) => ({
    legacy_row_number: r.rowNumber,
    raw_responses: r.data,
    ...deriveNamedColumns(headers, r.data),
  }));
  const inserted = await insertChunked(supabase, "equipment", rows);

  const { data, error } = await supabase
    .from("equipment")
    .select("id, legacy_row_number, asset_number");
  if (error) throw new Error(`re-read equipment after insert failed: ${error.message}`);

  const byLegacyRowNumber = new Map<number, string>();
  const byAssetNumber = new Map<string, string>();
  let duplicateAssetNumbers = 0;
  for (const row of data ?? []) {
    if (row.legacy_row_number != null) byLegacyRowNumber.set(row.legacy_row_number, row.id);
    const assetNumber = (row.asset_number ?? "").trim();
    if (assetNumber) {
      if (byAssetNumber.has(assetNumber)) duplicateAssetNumbers++;
      else byAssetNumber.set(assetNumber, row.id);
    }
  }

  log(
    `equipment: inserted ${inserted} rows` +
      (duplicateAssetNumbers > 0
        ? ` (note: ${duplicateAssetNumbers} duplicate เลขครุภัณฑ์ values exist — only the first row per value is used for best-effort maintenance_log matching)`
        : "")
  );

  return { inserted, maps: { byLegacyRowNumber, byAssetNumber } };
}

async function migrateEditLog(
  supabase: SupabaseClientType,
  maps: EquipmentMatchMaps
): Promise<number> {
  const entries = await readEditLogRaw();
  await deleteAllRows(supabase, "edit_log");

  let matched = 0;
  const rows = entries.map((e) => {
    const equipmentId = e.rowNumber != null ? maps.byLegacyRowNumber.get(e.rowNumber) ?? null : null;
    if (equipmentId) matched++;
    return {
      timestamp: e.timestamp || new Date().toISOString(),
      action: e.action,
      actor: e.actor,
      department: N(e.department),
      legacy_row_number: e.rowNumber,
      equipment_id: equipmentId,
      column_name: e.column,
      old_value: e.oldValue,
      new_value: e.newValue,
    };
  });

  const inserted = await insertChunked(supabase, "edit_log", rows);
  log(`edit_log: inserted ${inserted} rows (${matched} matched to an equipment row by legacy row number)`);
  return inserted;
}

async function migrateUsers(supabase: SupabaseClientType): Promise<number> {
  const users = await getUsers();
  await deleteAllRows(supabase, "users");

  const rows = users.map((u) => ({
    username: u.username,
    password_hash: u.passwordHash,
    role: u.role,
    department: u.department ?? "",
    display_name: u.displayName ?? "",
    active: u.active,
    extra_permissions: u.extraPermissions ?? [],
    revoked_permissions: u.revokedPermissions ?? [],
  }));

  const inserted = await insertChunked(supabase, "users", rows);
  log(`users: inserted ${inserted} rows`);
  return inserted;
}

async function migrateReportSettings(): Promise<void> {
  const settings = await getReportSettings();
  await updateReportSettings(settings);
  log(`report_settings: singleton row updated`);
}

async function migrateSpecStandards(): Promise<void> {
  const standards = await getSpecStandards();
  await updateSpecStandards(standards);
  log(`spec_standards: singleton row updated`);
}

async function migrateDirectorSettings(): Promise<void> {
  const hash = await getDirectorPasswordHash();
  await setDirectorPasswordHash(hash);
  log(`director_settings: singleton row updated (ผอ. password hash ${hash ? "present" : "blank — falls back to DIRECTOR_BOOTSTRAP_PASSWORD_HASH"})`);
}

async function migrateMaintenanceLog(
  supabase: SupabaseClientType,
  maps: EquipmentMatchMaps
): Promise<number> {
  const entries = await getMaintenanceLog();
  await deleteAllRows(supabase, "maintenance_log");

  let matched = 0;
  const rows = entries.map((e) => {
    const equipmentId = maps.byAssetNumber.get(e.assetNumber.trim()) ?? null;
    if (equipmentId) matched++;
    return {
      timestamp: e.timestamp || new Date().toISOString(),
      asset_number: e.assetNumber,
      equipment_id: equipmentId,
      recorded_by: e.recordedBy,
      software: e.software ?? "",
      maintenance_date: N(e.maintenanceDate),
      manual_spec_status: e.manualSpecStatus ?? "",
      notes: e.notes ?? "",
    };
  });

  const inserted = await insertChunked(supabase, "maintenance_log", rows);
  log(`maintenance_log: inserted ${inserted} rows (${matched} matched to an equipment row by เลขครุภัณฑ์)`);
  return inserted;
}

async function migrateMaintenanceTasks(
  supabase: SupabaseClientType,
  maps: EquipmentMatchMaps
): Promise<number> {
  const tasks = await getMaintenanceTasks();
  await deleteAllRows(supabase, "maintenance_tasks");

  let matched = 0;
  const rows = tasks.map((t) => {
    const equipmentId = maps.byLegacyRowNumber.get(t.equipmentRowNumber) ?? null;
    if (equipmentId) matched++;
    return {
      id: t.taskId,
      created_at: t.createdAt || new Date().toISOString(),
      legacy_equipment_row_number: t.equipmentRowNumber,
      equipment_id: equipmentId,
      asset_number: t.assetNumber ?? "",
      equipment_type: t.equipmentType ?? "",
      brand_model: t.brandModel ?? "",
      department: t.department ?? "",
      location: t.location ?? "",
      assigned_to_username: t.assignedToUsername ?? "",
      assigned_to_display_name: t.assignedToDisplayName ?? "",
      status: t.status,
      actions_taken: t.actionsTaken ?? [],
      inspection_checks: t.inspectionChecks ?? [],
      parts_changed: t.partsChanged ?? "",
      other_detail: t.otherDetail ?? "",
      notes: t.notes ?? "",
      completed_at: N(t.completedAt),
      completed_by_username: N(t.completedByUsername),
      planned_actions: t.plannedActions ?? [],
      action_details: t.actionDetails ?? {},
    };
  });

  const inserted = await insertChunked(supabase, "maintenance_tasks", rows);
  log(`maintenance_tasks: inserted ${inserted} rows (${matched} matched to an equipment row by legacy row number)`);
  return inserted;
}

async function migrateBookingResources(supabase: SupabaseClientType): Promise<number> {
  const resources = await getBookingResources();
  // bookings.resource_id and trip_orders.resource_id both reference this
  // table with ON DELETE RESTRICT (see supabase/schema.sql) — so on a
  // second run, last run's bookings/trip_orders rows would block this
  // table's delete otherwise. Both get fully re-migrated later in main()
  // anyway (migrateTripOrders/migrateBookings each re-run-safely delete
  // their own table before inserting), so clearing them here first is
  // safe, and keeps this function correct to call even on its own.
  await deleteAllRows(supabase, "bookings");
  await deleteAllRows(supabase, "trip_orders");
  await deleteAllRows(supabase, "booking_resources");

  const rows = resources.map((r) => ({
    id: r.resourceId,
    type: r.type,
    name: r.name,
    detail: r.detail ?? "",
    active: r.active,
    image_data_url: r.imageDataUrl ?? "",
    seat_count: r.seatCount ?? 0,
    created_at: r.createdAt || new Date().toISOString(),
    created_by_username: r.createdByUsername ?? "",
  }));

  const inserted = await insertChunked(supabase, "booking_resources", rows);
  log(`booking_resources: inserted ${inserted} rows`);
  return inserted;
}

async function migrateDrivers(supabase: SupabaseClientType): Promise<number> {
  const drivers = await getDrivers();
  await deleteAllRows(supabase, "drivers");

  const rows = drivers.map((d) => ({
    id: d.driverId,
    name: d.name,
    phone: d.phone ?? "",
    active: d.active,
    created_at: d.createdAt || new Date().toISOString(),
    created_by_username: d.createdByUsername ?? "",
  }));

  const inserted = await insertChunked(supabase, "drivers", rows);
  log(`drivers: inserted ${inserted} rows`);
  return inserted;
}

async function migrateTripOrders(supabase: SupabaseClientType): Promise<number> {
  const tripOrders = await getTripOrders();
  await deleteAllRows(supabase, "trip_orders");

  const rows = tripOrders.map((t) => ({
    id: t.tripOrderId,
    resource_id: N(t.resourceId),
    resource_name: t.resourceName,
    driver_name: t.driverName ?? "",
    start_time: t.startTime,
    end_time: t.endTime,
    notes: t.notes ?? "",
    created_by_username: t.createdByUsername,
    created_at: t.createdAt || new Date().toISOString(),
  }));

  const inserted = await insertChunked(supabase, "trip_orders", rows);
  log(`trip_orders: inserted ${inserted} rows`);
  return inserted;
}

async function migrateBookings(supabase: SupabaseClientType): Promise<number> {
  const bookings = await getBookings();
  await deleteAllRows(supabase, "bookings");

  const rows = bookings.map((b) => ({
    id: b.bookingId,
    resource_id: N(b.resourceId),
    resource_type: b.resourceType,
    resource_name: b.resourceName,
    start_time: b.startTime,
    end_time: b.endTime,
    purpose: b.purpose ?? "",
    destination: b.destination ?? "",
    participants: b.participants ?? 0,
    contact_phone: b.contactPhone ?? "",
    booked_by_username: b.bookedByUsername,
    booked_by_display_name: b.bookedByDisplayName ?? "",
    department: b.department ?? "",
    created_at: b.createdAt || new Date().toISOString(),
    cancelled_at: N(b.cancelledAt),
    cancelled_by_username: N(b.cancelledByUsername),
    approval_status: b.approvalStatus || "approved",
    approved_at: N(b.approvedAt),
    approved_by_username: N(b.approvedByUsername),
    companions: b.companions ?? "",
    trip_order_id: N(b.tripOrderId),
    edited_by_username: N(b.editedByUsername),
    edited_at: N(b.editedAt),
    director_approval_status: b.directorApprovalStatus ?? "",
    director_approved_at: N(b.directorApprovedAt),
    director_note: b.directorNote ?? "",
    director_returned_at: N(b.directorReturnedAt),
  }));

  const inserted = await insertChunked(supabase, "bookings", rows);
  log(`bookings: inserted ${inserted} rows`);
  return inserted;
}

// ---------------------------------------------------------------------------
// main(): runs every table migration in FK order, isolating each one's
// errors so a failure in one table doesn't block the rest, then prints a
// final pass/fail summary. Exits with a non-zero code if anything failed,
// so a CI-style "did this succeed" check is possible later if needed.
// ---------------------------------------------------------------------------

interface StepResult {
  table: string;
  ok: boolean;
  detail: string;
}

async function runStep(table: string, fn: () => Promise<void>): Promise<StepResult> {
  try {
    await fn();
    return { table, ok: true, detail: "OK" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`!! ${table} FAILED: ${message}`);
    return { table, ok: false, detail: message };
  }
}

async function main() {
  log("Starting Google Sheets -> Supabase migration...");
  const supabase = getSupabaseClient();
  const results: StepResult[] = [];

  // equipment must run first and must succeed (everything else's
  // best-effort equipment_id matching depends on its result) — if it
  // fails, there's no point attempting the dependent tables at all.
  let maps: EquipmentMatchMaps = { byLegacyRowNumber: new Map(), byAssetNumber: new Map() };
  const equipmentStep = await runStep("equipment", async () => {
    const snapshot = await getEquipmentDataUnredacted();
    const { maps: m } = await migrateEquipment(supabase, snapshot);
    maps = m;
  });
  results.push(equipmentStep);

  results.push(await runStep("edit_log", () => migrateEditLog(supabase, maps).then(() => undefined)));
  results.push(await runStep("users", () => migrateUsers(supabase).then(() => undefined)));
  results.push(await runStep("report_settings", migrateReportSettings));
  results.push(await runStep("spec_standards", migrateSpecStandards));
  results.push(await runStep("director_settings", migrateDirectorSettings));
  results.push(
    await runStep("maintenance_log", () => migrateMaintenanceLog(supabase, maps).then(() => undefined))
  );
  results.push(
    await runStep("maintenance_tasks", () => migrateMaintenanceTasks(supabase, maps).then(() => undefined))
  );
  results.push(await runStep("booking_resources", () => migrateBookingResources(supabase).then(() => undefined)));
  results.push(await runStep("drivers", () => migrateDrivers(supabase).then(() => undefined)));
  // trip_orders before bookings: bookings.trip_order_id references
  // trip_orders.id, and trip_orders has no dependency on bookings (the
  // reverse "which bookings does this trip cover" relationship is derived
  // by querying bookings.trip_order_id, never stored on trip_orders — see
  // the schema.sql comment on trip_orders).
  results.push(await runStep("trip_orders", () => migrateTripOrders(supabase).then(() => undefined)));
  results.push(await runStep("bookings", () => migrateBookings(supabase).then(() => undefined)));

  log("---------------------------------------------");
  log("Migration summary:");
  for (const r of results) {
    log(`  ${r.ok ? "OK  " : "FAIL"}  ${r.table}${r.ok ? "" : `  (${r.detail})`}`);
  }
  const failures = results.filter((r) => !r.ok);
  if (failures.length > 0) {
    log(`${failures.length} table(s) failed. Fix the issue above and re-run the whole script.`);
    process.exitCode = 1;
  } else {
    log("All tables migrated successfully.");
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[migrate] FATAL: ${message}`);
  process.exitCode = 1;
});
