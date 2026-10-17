import { randomUUID } from "crypto";
import { google } from "googleapis";
import { redactSurname, resolveFields, type EquipmentRow, type FieldMap } from "@/lib/fields";
import type { Role } from "@/lib/auth";
import { DEFAULT_SPEC_STANDARDS, type SpecOptionLists, type SpecStandards } from "@/lib/specEvaluation";
import { getLatestMaintenanceLogByAsset, type MaintenanceLogEntry } from "@/lib/maintenanceLog";
import { resolveColorOrder } from "@/lib/actionColors";
import { isPermissionKey, type PermissionKey } from "@/lib/permissions";
import {
  formatBookingDateTime,
  hasBookingConflict,
  isBookingCancelled,
  PENDING_CAR_RESOURCE_NAME,
  splitBookingDateTime,
  type Booking,
  type BookingApprovalStatus,
  type BookingResource,
  type BookingResourceType,
  type DirectorApprovalStatus,
  type Driver,
  type TripOrder,
} from "@/lib/booking";

export type { EquipmentRow, FieldMap };
// Re-exported so existing callers can keep importing these types (and the
// spec-standards defaults) from lib/sheets, where the Google Sheets
// read/write for them lives — the definitions themselves live in the pure
// lib/specEvaluation.ts / lib/maintenanceLog.ts / lib/booking.ts modules so
// those stay safely importable from client components (see each file's top
// comment). Server code should generally still prefer importing the
// read/write functions (getSpecStandards, getMaintenanceLog, etc.) from here.
export { DEFAULT_SPEC_STANDARDS, getLatestMaintenanceLogByAsset };
export type {
  SpecStandards,
  SpecOptionLists,
  MaintenanceLogEntry,
  Booking,
  BookingApprovalStatus,
  BookingResource,
  BookingResourceType,
  DirectorApprovalStatus,
  Driver,
  TripOrder,
};

// Each record pairs a row's data with its 1-based row number in the sheet
// (data row index + 2, accounting for the header row at row 1). This is the
// only stable identifier available — the sheet has no ID column of its own,
// since it's raw Google Form responses appended in submission order. The
// row-number identifies which physical sheet row an edit-back write targets.
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

function getEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`ไม่พบตัวแปรสภาพแวดล้อม ${name} (ตรวจสอบไฟล์ .env.local)`);
  }
  return value;
}

// Reused across every getXxx()/appendXxx()/updateXxx() call in this module
// (25+ call sites) instead of constructing a fresh GoogleAuth every time —
// GoogleAuth caches its OAuth2 access token internally and only re-fetches
// once it's near expiry, so sharing one instance turns "N sheet reads on
// one page load" from N separate token-exchange-then-API-call round trips
// into one token fetch (or zero, once warm) plus N plain API calls. This is
// the biggest lever on this app's page-load latency — a page like
// /manage/it makes 5 of these calls on a single load. Safe to share: this
// module holds no per-request state, and every call still goes through its
// own getEnv() checks either way. Module-level, so it lives for the life of
// the server process (or, on Vercel, however long that serverless instance
// stays warm) — never per-request.
let cachedAuth: ReturnType<typeof createSheetsAuth> | null = null;

// The googleapis client library has NO request timeout by default (gaxios,
// the HTTP layer underneath it, leaves `timeout` unset unless told
// otherwise) — every google.sheets(...) call in this file could therefore
// hang indefinitely if a request got stuck (a network hiccup, or Google
// throttling the service account after a burst of reads/writes, e.g. from
// manually editing the sheet a lot in a short span). That's exactly what
// stalled login for a long time on 2026-09-16: the login route's own
// unbounded `await appendEditLog(...)` before responding (see that route's
// comment — now fixed by deferring it via after()) masked this as a
// login-specific bug, but the same missing timeout affects every read/write
// here, including the getUsers() read that a non-bootstrap login still has
// to await before it can even check the password. Setting it once, globally,
// covers every call site in this module: a stuck request now fails after 15s
// with a clear, catchable error instead of hanging the caller forever.
google.options({ timeout: 15_000 });

function createSheetsAuth() {
  const clientEmail = getEnv("GOOGLE_SERVICE_ACCOUNT_EMAIL");
  const privateKey = getEnv("GOOGLE_PRIVATE_KEY").replace(/\\n/g, "\n");

  return new google.auth.GoogleAuth({
    credentials: {
      client_email: clientEmail,
      private_key: privateKey,
    },
    // Read+write — the /manage area (add/edit/dispose equipment, manage
    // users) writes cells back, appends new rows, and appends to the
    // EditLog tab. The service account must be re-shared on the sheet as
    // Editor (not just Viewer) for this to work — a Viewer-shared sheet
    // will fail write calls with 403.
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}

function sheetsAuth() {
  if (!cachedAuth) {
    cachedAuth = createSheetsAuth();
  }
  return cachedAuth;
}

/**
 * Reads equipment data from the configured Google Sheet using a service
 * account. Set GOOGLE_SHEET_TAB in .env.local if your tab isn't "Sheet1".
 */
export async function getEquipmentData(): Promise<SheetSnapshot> {
  const spreadsheetId = getEnv("GOOGLE_SHEET_ID");
  const tab = process.env.GOOGLE_SHEET_TAB?.trim() || "Sheet1";
  const clientEmail = getEnv("GOOGLE_SERVICE_ACCOUNT_EMAIL");

  const sheets = google.sheets({ version: "v4", auth: sheetsAuth() });

  let values: string[][] | undefined;
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${tab}!A1:Z2000`,
    });
    values = res.data.values as string[][] | undefined;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("Unable to parse range")) {
      throw new Error(
        `ไม่พบแท็บชื่อ "${tab}" ในสเปรดชีต — ตั้งค่า GOOGLE_SHEET_TAB ใน .env.local ให้ตรงกับชื่อแท็บจริง`
      );
    }
    if (message.includes("The caller does not have permission") || message.includes("403")) {
      throw new Error(
        `ไม่มีสิทธิ์เข้าถึงสเปรดชีต — เปิดสเปรดชีตแล้วแชร์ให้กับ ${clientEmail} (สิทธิ์ Editor เพื่อรองรับการแก้ไข)`
      );
    }
    throw new Error(`เชื่อมต่อ Google Sheets ไม่สำเร็จ: ${message}`);
  }

  if (!values || values.length === 0) {
    return {
      tab,
      headers: [],
      rows: [],
      fields: resolveFields([]),
      fetchedAt: new Date().toISOString(),
    };
  }

  const [headerRow, ...dataRows] = values;
  const headers = headerRow.map((h) => (h ?? "").toString().trim());

  const rows: EquipmentRecord[] = dataRows
    .map((r, i) => ({ r, rowNumber: i + 2 })) // +2: row 1 is the header, data starts at row 2
    .filter(({ r }) => r.some((cell) => (cell ?? "").toString().trim() !== ""))
    .map(({ r, rowNumber }) => {
      const row: EquipmentRow = {};
      headers.forEach((h, i) => {
        row[h || `column_${i + 1}`] = (r[i] ?? "").toString();
      });
      return { rowNumber, data: row };
    });

  const fields = resolveFields(headers);

  // Redact the responsible-person surname here, server-side, before this
  // data ever leaves the server. getCellValue() in fields.ts also masks it
  // again for display, but that alone still lets the true surname reach the
  // browser inside the page's RSC payload (visible via view-source or
  // devtools even though the rendered UI shows "xxxx"). Doing it on the raw
  // row means the real surname is never sent over the wire at all.
  //
  // The one exception is the /manage area: its routes call
  // getEquipmentDataUnredacted() below instead, after verifying a logged-in
  // session (src/lib/auth.ts) — never through this function or the public
  // /api/sheets route.
  const nameHeaderToRedact = fields.fullNameHeader ?? fields.nameHeader;
  if (nameHeaderToRedact) {
    for (const record of rows) {
      if (record.data[nameHeaderToRedact]) {
        record.data[nameHeaderToRedact] = redactSurname(record.data[nameHeaderToRedact]);
      }
    }
  }

  return {
    tab,
    headers,
    rows,
    fields,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Like getEquipmentData(), but skips the surname redaction — the raw values
 * exactly as they appear in the sheet. Only call this from a /manage route
 * that has already verified a logged-in session (src/lib/auth.ts); never
 * expose it through an unauthenticated endpoint.
 */
export async function getEquipmentDataUnredacted(): Promise<SheetSnapshot> {
  const spreadsheetId = getEnv("GOOGLE_SHEET_ID");
  const tab = process.env.GOOGLE_SHEET_TAB?.trim() || "Sheet1";
  const clientEmail = getEnv("GOOGLE_SERVICE_ACCOUNT_EMAIL");

  const sheets = google.sheets({ version: "v4", auth: sheetsAuth() });

  let values: string[][] | undefined;
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${tab}!A1:Z2000`,
    });
    values = res.data.values as string[][] | undefined;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("The caller does not have permission") || message.includes("403")) {
      throw new Error(
        `ไม่มีสิทธิ์เข้าถึงสเปรดชีต — เปิดสเปรดชีตแล้วแชร์ให้กับ ${clientEmail} (สิทธิ์ Editor)`
      );
    }
    throw new Error(`เชื่อมต่อ Google Sheets ไม่สำเร็จ: ${message}`);
  }

  if (!values || values.length === 0) {
    return { tab, headers: [], rows: [], fields: resolveFields([]), fetchedAt: new Date().toISOString() };
  }

  const [headerRow, ...dataRows] = values;
  const headers = headerRow.map((h) => (h ?? "").toString().trim());

  const rows: EquipmentRecord[] = dataRows
    .map((r, i) => ({ r, rowNumber: i + 2 }))
    .filter(({ r }) => r.some((cell) => (cell ?? "").toString().trim() !== ""))
    .map(({ r, rowNumber }) => {
      const row: EquipmentRow = {};
      headers.forEach((h, i) => {
        row[h || `column_${i + 1}`] = (r[i] ?? "").toString();
      });
      return { rowNumber, data: row };
    });

  return { tab, headers, rows, fields: resolveFields(headers), fetchedAt: new Date().toISOString() };
}

/**
 * Writes a full row of values back to the sheet at the given row number, in
 * header order. Used by the /manage routes only, after the caller has
 * verified a logged-in session and (for an admin session) that the row's
 * department matches the session's own department.
 */
export async function updateEquipmentRow(
  rowNumber: number,
  headers: string[],
  values: Record<string, string>
): Promise<void> {
  const spreadsheetId = getEnv("GOOGLE_SHEET_ID");
  const tab = process.env.GOOGLE_SHEET_TAB?.trim() || "Sheet1";
  const sheets = google.sheets({ version: "v4", auth: sheetsAuth() });

  const orderedValues = headers.map((h) => values[h] ?? "");
  const lastColLetter = columnLetter(headers.length);

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${tab}!A${rowNumber}:${lastColLetter}${rowNumber}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [orderedValues] },
  });
}

export type EditLogAction =
  | "แก้ไข"
  // Distinguishes the narrow "it"-role correction (installLocation /
  // responsible-person only, from /manage/it/report) from a regular
  // admin/superadmin edit in the audit trail — see
  // /api/manage/it/records/[rowNumber] for the only place this is used.
  | "แก้ไข (IT)"
  | "เพิ่มใหม่"
  | "จำหน่าย"
  | "ยกเลิกการจำหน่าย"
  | "ลบรายการ"
  | "จัดการผู้ใช้"
  | "เข้าสู่ระบบสำเร็จ"
  | "เข้าสู่ระบบล้มเหลว"
  | "ออกจากระบบ"
  // Self-service password reset (POST /api/auth/reset-password) — a user
  // proving a default password to set their own new one, distinct from
  // "จัดการผู้ใช้" which covers a superadmin resetting it *for* them.
  | "รีเซ็ตรหัสผ่านสำเร็จ"
  | "รีเซ็ตรหัสผ่านล้มเหลว"
  // Vehicle/meeting-room booking feature — see the BookingResources/
  // Bookings tab section near the end of this file.
  | "เพิ่มทรัพยากรจอง"
  | "แก้ไขทรัพยากรจอง"
  // คนขับรถ (Drivers tab) — see the Drivers tab section near the end of
  // this file and /api/booking/drivers*. Same "เพิ่ม/แก้ไข" split as
  // เพิ่มทรัพยากรจอง/แก้ไขทรัพยากรจอง above, kept as its own distinct pair
  // (not reusing those two) so the audit log can tell a driver change apart
  // from a car/room change at a glance.
  | "เพิ่มคนขับรถ"
  | "แก้ไขคนขับรถ"
  | "จองทรัพยากร"
  | "ยกเลิกการจอง"
  // "อนุมัติการจองรถ"/"ไม่อนุมัติการจองรถ" retired from the write path —
  // approval now always goes through "ออกใบสั่งงานเดินทาง" below, and the
  // reject path now logs "ปฏิเสธการจองรถ" instead (per the hospital's later
  // explicit request to drop the word "อนุมัติ" from everything at the
  // superadmin/admin level — only the director's own /director sign-off is
  // ever called "อนุมัติ" conceptually, and even that page itself uses
  // "รับทราบ" wording, never this string) — both old strings are kept in
  // the union only because old EditLog rows already logged with them still
  // need to type-check against anything that reads EditLog rows back typed
  // as EditLogAction.
  | "อนุมัติการจองรถ"
  | "ไม่อนุมัติการจองรถ"
  | "ปฏิเสธการจองรถ"
  // Dispatching one or more pending car bookings at once (POST
  // /api/booking/trip-orders) — the new "approve" for a car booking; see
  // TripOrder's doc comment in lib/booking.ts.
  | "ออกใบสั่งงานเดินทาง"
  // Editing an already-issued TripOrder's own car/driver/time/notes (PATCH
  // /api/booking/trip-orders/[tripOrderId]) — see updateTripOrder above.
  | "แก้ไขใบสั่งงานเดินทาง"
  // Splitting one already-covered booking back out of an issued TripOrder
  // (PATCH /api/booking/trip-orders/[tripOrderId] with `removeBookingId`) —
  // see splitBookingFromTripOrder above.
  | "แยกรายการออกจากใบสั่งงานเดินทาง"
  // Management/superadmin correcting a booking's own narrow field set
  // (PATCH /api/booking/bookings/[bookingId] with an `edit` payload) — see
  // editBookingByManagement above and canApproveCarBooking's doc comment in
  // lib/booking.ts for why this is the one deliberate exception to "the
  // original request is never edited".
  | "แก้ไขข้อมูลการจองโดยฝ่ายบริหาร"
  // หน้า /director (ดู src/app/director/page.tsx) — ผอ. ล็อกอิน/รีเซ็ตรหัสผ่าน
  // /อนุมัติการเดินทางด้วยตัวเอง ใช้ actor "ผอ." เสมอ (มีผู้ใช้คนเดียว ไม่มี
  // username ให้บอกต่างจากนี้ — ดูคอมเมนต์หัวไฟล์ lib/directorAuth.ts).
  | "ผอ. เข้าสู่ระบบสำเร็จ"
  | "ผอ. เข้าสู่ระบบล้มเหลว"
  | "ผอ. รีเซ็ตรหัสผ่านสำเร็จ"
  | "ผอ. รีเซ็ตรหัสผ่านล้มเหลว"
  // "ผอ. รับทราบการเดินทาง"/"ผอ. ไม่รับทราบการเดินทาง" retired จาก write
  // path — เปลี่ยนถ้อยคำปุ่ม/สถานะหน้า /director จาก "รับทราบ"/"ไม่รับทราบ"
  // เป็น "อนุมัติ"/"ไม่อนุมัติ" ตามที่ ผอ. ขอให้ตรงกับบทบาทจริง (ดู
  // DirectorApprovalStatus's doc comment ใน lib/booking.ts) — คงไว้ในยูเนียน
  // เฉพาะให้แถว EditLog เก่าที่เคยเขียนด้วยคำนี้ยัง type-check ผ่าน ไม่มีการ
  // เขียนด้วยคำเดิมอีกแล้วตั้งแต่นี้ไป
  | "ผอ. รับทราบการเดินทาง"
  | "ผอ. ไม่รับทราบการเดินทาง"
  | "ผอ. อนุมัติการเดินทาง"
  | "ผอ. ไม่อนุมัติการเดินทาง"
  | "ผอ. ตีกลับใบสั่งงานเดินทาง";

/** Appends one row to the EditLog tab — header row (created ahead of time
 * by the sheet owner, not by this app; see the project setup notes) must be:
 * เวลา | การกระทำ | ผู้ทำรายการ | กลุ่มงาน | แถวที่ | คอลัมน์ | ค่าเดิม | ค่าใหม่
 * rowNumber/column are blank for row-level actions (เพิ่มใหม่/จำหน่าย) or
 * user-management actions that don't target one equipment column. */
export async function appendEditLog(entry: {
  timestamp: string;
  action: EditLogAction;
  actor: string;
  department: string;
  rowNumber?: number;
  column?: string;
  oldValue: string;
  newValue: string;
}): Promise<void> {
  const spreadsheetId = getEnv("GOOGLE_SHEET_ID");
  const logTab = process.env.GOOGLE_SHEET_EDIT_LOG_TAB?.trim() || "EditLog";
  const sheets = google.sheets({ version: "v4", auth: sheetsAuth() });

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${logTab}!A1`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values: [[
        entry.timestamp,
        entry.action,
        entry.actor,
        entry.department,
        entry.rowNumber != null ? String(entry.rowNumber) : "",
        entry.column ?? "",
        entry.oldValue,
        entry.newValue,
      ]],
    },
  });
}

// ---------------------------------------------------------------------------
// Users tab — accounts for the /manage area. Only a password hash is ever
// stored here (see src/lib/auth.ts hashPassword/verifyPassword); superadmins
// manage rows through the /manage/users UI, not by hand-editing the sheet.
// Header row (created ahead of time by the sheet owner): Username |
// PasswordHash | Role | Department | DisplayName | Active | ExtraPermissions
// | RevokedPermissions
//
// The last two columns back the per-account permission-override feature
// (see src/lib/permissions.ts) — added after the original six; a sheet that
// predates this feature simply has blank/missing G and H cells, which reads
// back as "no overrides" (parsePermissionKeyList("") below), so nothing
// existing breaks until the sheet owner adds the two columns by hand (same
// one-time manual-column-add pattern as SeatCount/ApprovalStatus earlier).
// Each cell holds a comma-separated list of PermissionKey strings, e.g.
// "accessItDashboard,manageUsers".
// ---------------------------------------------------------------------------

export interface UserRecord {
  rowNumber: number;
  username: string;
  passwordHash: string;
  role: Role;
  department: string;
  displayName: string;
  active: boolean;
  extraPermissions: PermissionKey[];
  revokedPermissions: PermissionKey[];
}

/** "a,b,c" -> ["a","b"] — silently drops any entry that isn't a real
 * PermissionKey (a stray typo hand-edited into the sheet, or a key retired
 * in a later version of this app) rather than letting it through as an
 * opaque string nothing downstream understands. */
function parsePermissionKeyList(raw: string): PermissionKey[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(isPermissionKey);
}

/** Parses the Role column's raw text, defaulting to the most restrictive
 * role ("user") for anything unrecognized — e.g. a blank cell, or a typo
 * hand-edited into the sheet — rather than silently granting broader
 * access than intended. "it" was a real role once, but has since been
 * folded into "superadmin" (per the hospital's explicit request — see
 * lib/auth.ts's Role comment) — any row still holding the literal text
 * "it" from before that change is treated as "superadmin" rather than
 * falling through to the generic unrecognized-value default, since that's
 * where its capabilities actually went. Note this does NOT automatically
 * restore what that account could do as "it": accessItDashboard/
 * manageBookingResources are no longer an automatic default for any
 * superadmin (regular or migrated) — re-grant them for this specific
 * account through /manage/users if the hospital wants that account to keep
 * reaching /manage/it and managing booking resources. */
function parseRole(raw: string): Role {
  const trimmed = raw.trim();
  if (trimmed === "superadmin") return "superadmin";
  if (trimmed === "admin") return "admin";
  if (trimmed === "it") return "superadmin";
  return "user";
}

function parseActive(raw: string): boolean {
  const v = raw.trim().toUpperCase();
  // Blank counts as active — a Users tab where nobody bothered filling in
  // the Active column shouldn't silently lock everyone out.
  return v !== "N" && v !== "NO" && v !== "FALSE" && v !== "0";
}

function getUsersTab(): string {
  return process.env.GOOGLE_SHEET_USERS_TAB?.trim() || "Users";
}

export async function getUsers(): Promise<UserRecord[]> {
  const spreadsheetId = getEnv("GOOGLE_SHEET_ID");
  const usersTab = getUsersTab();
  const sheets = google.sheets({ version: "v4", auth: sheetsAuth() });

  let values: string[][] | undefined;
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${usersTab}!A2:H1000`, // skip header row (row 1)
    });
    values = res.data.values as string[][] | undefined;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("Unable to parse range")) {
      throw new Error(
        `ไม่พบแท็บชื่อ "${usersTab}" ในสเปรดชีต — สร้างแท็บนี้ก่อน (ดูรายละเอียดใน README) หรือตั้งค่า GOOGLE_SHEET_USERS_TAB ให้ตรงกับชื่อแท็บจริง`
      );
    }
    throw new Error(`อ่านรายชื่อผู้ใช้ไม่สำเร็จ: ${message}`);
  }

  return (values ?? [])
    .map((r, i) => ({ r, rowNumber: i + 2 }))
    .filter(({ r }) => (r[0] ?? "").toString().trim() !== "")
    .map(({ r, rowNumber }) => ({
      rowNumber,
      username: (r[0] ?? "").toString().trim(),
      passwordHash: (r[1] ?? "").toString().trim(),
      role: parseRole((r[2] ?? "").toString()),
      department: (r[3] ?? "").toString().trim(),
      displayName: (r[4] ?? "").toString().trim(),
      active: parseActive((r[5] ?? "").toString()),
      extraPermissions: parsePermissionKeyList((r[6] ?? "").toString()),
      revokedPermissions: parsePermissionKeyList((r[7] ?? "").toString()),
    }));
}

export async function addUser(user: {
  username: string;
  passwordHash: string;
  role: Role;
  department: string;
  displayName: string;
  extraPermissions?: PermissionKey[];
  revokedPermissions?: PermissionKey[];
}): Promise<void> {
  const spreadsheetId = getEnv("GOOGLE_SHEET_ID");
  const usersTab = getUsersTab();
  const sheets = google.sheets({ version: "v4", auth: sheetsAuth() });

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${usersTab}!A1`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values: [[
        user.username,
        user.passwordHash,
        user.role,
        user.department,
        user.displayName,
        "Y",
        (user.extraPermissions ?? []).join(","),
        (user.revokedPermissions ?? []).join(","),
      ]],
    },
  });
}

/** Updates the row for `username` (only the fields present in `updates`).
 * Looks the row up by scanning getUsers() rather than trusting a cached row
 * number, since the Users tab is small and can be hand-edited (e.g. an
 * emergency Active=N) between calls. */
export async function updateUser(
  username: string,
  updates: Partial<
    Pick<
      UserRecord,
      "passwordHash" | "role" | "department" | "displayName" | "active" | "extraPermissions" | "revokedPermissions"
    >
  >
): Promise<UserRecord> {
  const users = await getUsers();
  const existing = users.find((u) => u.username === username);
  if (!existing) {
    throw new Error(`ไม่พบผู้ใช้ "${username}" ในแท็บ ${getUsersTab()}`);
  }
  const merged: UserRecord = { ...existing, ...updates };

  const spreadsheetId = getEnv("GOOGLE_SHEET_ID");
  const usersTab = getUsersTab();
  const sheets = google.sheets({ version: "v4", auth: sheetsAuth() });

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${usersTab}!A${merged.rowNumber}:H${merged.rowNumber}`,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [[
        merged.username,
        merged.passwordHash,
        merged.role,
        merged.department,
        merged.displayName,
        merged.active ? "Y" : "N",
        merged.extraPermissions.join(","),
        merged.revokedPermissions.join(","),
      ]],
    },
  });

  return merged;
}

// ---------------------------------------------------------------------------
// ReportSettings tab — the handful of fixed text pieces that appear on a
// printed report (see /manage/it) but change independently of the app's
// code: the org name, a report's title, and who signs as "ผู้รับทราบ" on
// the maintenance form. Stored as plain key/value rows (Key | Value,
// starting row 2) rather than one column per setting, so adding a new
// setting later never means widening the sheet.
//
// This tab is NOT created by this app — like Users/EditLog, the sheet
// owner creates it by hand (see project setup notes) before anyone edits
// settings through /manage/it. Reading gracefully falls back to
// DEFAULT_REPORT_SETTINGS when the tab doesn't exist yet (or a key isn't
// in it) so the report generator still works with sensible text out of
// the box; only *writing* an edited value requires the tab to actually
// exist, and fails with a clear "create it first" message if it doesn't.
// ---------------------------------------------------------------------------

export interface ReportSettings {
  orgName: string;
  maintenanceFormTitle: string;
  fiscalYearLabel: string;
  acknowledgerName: string;
  acknowledgerPosition: string;
  acknowledgerDepartment: string;
  /** Font size (in pt — the unit print layouts are conventionally sized
   * in, unlike on-screen px/rem) for the printed form's general body text:
   * the "ข้อมูลครุภัณฑ์ที่ดำเนินการบำรุงรักษา" section heading, and the
   * วันที่ดำเนินการ/ช่วงเวลา/ผู้ดำเนินการ + signature block below the
   * table — i.e. everything on the page that ISN'T the header (see
   * printHeaderFontSizePt below, its own separate control) or the
   * equipment table itself (see printTableFontSizePx, likewise separate).
   * Shown in the settings UI as just "ขนาดตัวอักษรภาพรวม" now that all
   * three areas have their own control. Stored as a string, same
   * plain-text handling as every other field here — parsed with a
   * fallback at render time (see MaintenanceReportBuilder's
   * printBodyFontSizePt) so a blank or hand-edited non-numeric cell never
   * breaks the page. */
  printFontSizePt: string;
  /** Font size (in pt) for the printed form's header block: หน่วยงาน,
   * ชื่อแบบฟอร์ม, ปีงบประมาณ, and (when set) กลุ่มงาน — all four lines
   * share this one size rather than each having its own control; หน่วยงาน
   * /ชื่อแบบฟอร์ม stay bold and ปีงบประมาณ/กลุ่มงาน stay regular weight,
   * same as before, only the size became adjustable. Kept separate from
   * printFontSizePt (the rest of the page's body text) since a hospital
   * wanting a more prominent — or more compact — header shouldn't have to
   * resize the whole form to do it. Stored as a string, same plain-text
   * handling as every other field here — parsed with a fallback at
   * render time (see MaintenanceReportBuilder's printHeaderFontSizePt) so
   * a blank or hand-edited non-numeric cell never breaks the page. */
  printHeaderFontSizePt: string;
  /** Base font size (in px, not pt — the equipment table's columns are
   * laid out in px so its three internal sizes can stay in fixed
   * proportion to each other, see below) for the printed equipment table:
   * the ลำดับ/รายการครุภัณฑ์/ผู้รับผิดชอบครุภัณฑ์ columns sit at exactly
   * this size, while the smaller sub-details (หมายเลขครุภัณฑ์, the
   * ยี่ห้อ/รุ่น and กลุ่มงาน sub-lines, การดำเนินการ checkboxes, and
   * ผลการตรวจสอบโดย IT checkboxes) are derived from it at render time
   * (see MaintenanceReportBuilder's printTableFontSizePx) so raising or
   * lowering this one number scales the whole table together instead of
   * needing five separate settings. Kept separate from printFontSizePt
   * above (and from the table entirely on purpose) since this table was
   * originally, and still needs to stay, small enough to keep the whole
   * printed list on one page — too large a value here risks the table
   * spilling onto a second page for a report with many selected items.
   * Stored as a string, same plain-text handling as every other field
   * here. */
  printTableFontSizePx: string;
  /** Line-height (a bare unitless CSS multiplier of font-size, e.g. "0.9"
   * — NOT px/pt, so it scales correctly no matter what font size each
   * block underneath ends up at) applied to the whole printed form at
   * once via the print-area container's own inline style (see
   * MaintenanceReportBuilder's print-area div) and inherited down by
   * everything under it EXCEPT the equipment table, which keeps its own
   * separately-tuned leading-snug instead (it was already deliberately
   * kept small and dense to fit the whole list on one printed page, a
   * different goal than "how tight the rest of the form reads"). That
   * means this one setting now governs the header block, the "ข้อมูล
   * ครุภัณฑ์..." heading/date-time line, AND the ผู้ตรวจสอบ/ผู้รับทราบ
   * signature blocks together — all three needed hand-tuned tightening
   * before this became adjustable (TH SarabunPSK, see PRINT_FONT_FAMILY,
   * bakes an unusually tall line box into its own font metrics, so this
   * typically needs to sit well below 1 to read as normal spacing rather
   * than airy), so one shared control now covers all three instead of
   * each needing its own code change. Defaults to "0.9", matching what
   * this form already used before the value became adjustable. Stored as
   * a string, same plain-text handling as every other field here —
   * parsed with a fallback at render time (see MaintenanceReportBuilder's
   * printLineHeight) so a blank or hand-edited non-numeric cell never
   * breaks the page. */
  printLineHeight: string;
  /** Vertical gap (in px) around and inside the printed signature-block
   * area: the space above the ลงชื่อ.../ผู้ตรวจสอบ/ผู้รับทราบ grid (between
   * it and the วันที่ดำเนินการ line above) and the row gap between a row of
   * ผู้ตรวจสอบ blocks and the ผู้รับทราบ block below it — the two blank
   * areas a hospital reported as wasteful once an IT department with many
   * ผู้ตรวจสอบ departments pushed ผู้รับทราบ onto its own grid row, which
   * then occasionally needed a second printed page the signature area
   * never flowed onto cleanly. Deliberately separate from printLineHeight
   * above (which governs line spacing WITHIN each block's own text, not
   * the blank space BETWEEN blocks/rows) so tightening one doesn't fight
   * the reserved pen-signature space each block keeps above its own
   * heading. Defaults to "16", tighter than this form's original
   * hard-coded 24px/32px gaps, so a hospital that never touches the
   * settings screen still gets the more compact layout requested. Stored
   * as a string, same plain-text handling as every other field here —
   * parsed with a fallback at render time (see
   * MaintenanceReportBuilder's printSignatureGapPx) so a blank or
   * hand-edited non-numeric cell never breaks the page. */
  printSignatureGapPx: string;
  /** Checklist items shown under the "การดำเนินการ" column of a printed
   * maintenance report — editable by the hospital instead of hard-coded,
   * since this list is expected to grow (today just "บำรุงรักษา", later
   * maybe "อัพเดทโปรแกรม Hosxp 3 เป็นเวอร์ชัน ...."). Stored as a JSON
   * array in the Value cell — see the special-cased handling in
   * getReportSettings/updateReportSettings below, since every other
   * setting here is a plain string. */
  actionOptions: string[];
  /** Exact text of any actionOptions entries that are currently "ซ่อน"
   * (hidden) — hidden entries disappear from every place IT actually
   * *picks* an action (the report page's "เลือกรายการที่จะดำเนินการ"
   * chips, the printed form, and the "อัปเดตสถานะงาน" checklist on
   * /manage/it/tasks) but stay in actionOptions itself, at their original
   * array index, so they can be unhidden and reused later without
   * shifting any other entry's position — see buildActionColorMap
   * (lib/actionColors), which assigns colors by array index and would
   * otherwise silently reassign every later entry's color, desyncing
   * already-printed reports and saved task records from their original
   * color. Stored as a JSON array, same as actionOptions. */
  hiddenActionOptions: string[];
  /** Exact text of any actionOptions entries that need IT to write in a
   * free-text detail when they mark that action taken — e.g. "อัปเกรด/
   * เปลี่ยนอะไหล่ฮาร์ดแวร์" needs to say *which* part. Every place the
   * action's label appears as a fill-in checklist item (the printed form's
   * "การดำเนินการ" column) gets a dotted blank appended after the label —
   * see MaintenanceReportBuilder's ACTION_DETAIL_SUFFIX/actionLabelForPrint
   * — and MaintenanceTasksBoard's TaskUpdateModal offers a matching
   * free-text box once that action is ticked, saved onto the task as
   * MaintenanceTask.actionDetails[name]. Membership list by name, not
   * index — same convention as hiddenActionOptions above, for the same
   * reason: this is a property of the entry itself, not its position, so
   * it stays attached to the right entry through a reorder. Stored as a
   * JSON array, same as actionOptions/hiddenActionOptions. */
  detailRequiredActionOptions: string[];
  /** Exact text of any actionOptions entries currently "ล็อก" (locked) —
   * forced into every printing round's selection on
   * MaintenanceReportBuilder's "เลือกรายการที่จะดำเนินการ" card and
   * impossible to exclude from there (toggleActiveAction there is a no-op
   * for a locked name) — for a checklist item IT must always carry out
   * every round (e.g. a mandatory safety check), not just when someone
   * remembers to tick it. Same membership-by-name convention as
   * hiddenActionOptions/detailRequiredActionOptions above (stays attached to
   * the right entry through a reorder, never disturbs buildActionColorMap's
   * index-based colors). Unlike those two — bootstrap-only via
   * manageReportActionList — toggling this one is open to any superadmin
   * account, bootstrap or not (see lockReportActionOptions in
   * lib/permissions.ts and canLockActionOptions in
   * MaintenanceReportBuilder.tsx), per the hospital's explicit request.
   * Stored as a JSON array, same as actionOptions/hiddenActionOptions/
   * detailRequiredActionOptions. */
  lockedActionOptions: string[];
  /** The order buildActionColorMap (lib/actionColors) actually assigns
   * colors in — deliberately NOT the same as actionOptions' own order, so
   * that reordering the settings list with the up/down-arrow buttons
   * (moveActionOption) never reshuffles anyone's color. Self-heals on every
   * read (see getReportSettings) and is reconciled on every write (see
   * updateReportSettings) via resolveColorOrder — a genuinely new name gets
   * appended and picks up the next open color slot, a removed name drops
   * out (so later names shift up and reclaim that slot, same as this
   * always behaved before this field existed), and a plain reorder of
   * actionOptions leaves this list completely untouched. Deliberately not
   * exposed to direct client editing — see readSettingsPayload
   * (/api/manage/it/settings), which doesn't accept this key at all;
   * updateReportSettings always recomputes it server-side from the
   * incoming actionOptions and whatever was already persisted, so a
   * tampered/stale value in a PATCH body can never override it. Stored as
   * a JSON array, same as actionOptions/hiddenActionOptions/
   * detailRequiredActionOptions. */
  actionColorOrder: string[];
}

// Matches the attached example form exactly, so a hospital that never
// touches the settings screen still gets a correct-looking report.
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

// Fixed key order — also what updateReportSettings writes back, so the
// tab's row order stays stable across edits instead of depending on
// whatever order a partial update happened to touch keys in.
const REPORT_SETTINGS_KEYS = Object.keys(DEFAULT_REPORT_SETTINGS) as (keyof ReportSettings)[];

function getReportSettingsTab(): string {
  return process.env.GOOGLE_SHEET_REPORT_SETTINGS_TAB?.trim() || "ReportSettings";
}

export async function getReportSettings(): Promise<ReportSettings> {
  const spreadsheetId = getEnv("GOOGLE_SHEET_ID");
  const tab = getReportSettingsTab();
  const sheets = google.sheets({ version: "v4", auth: sheetsAuth() });

  let values: string[][] | undefined;
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${tab}!A2:B200`,
    });
    values = res.data.values as string[][] | undefined;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("Unable to parse range")) {
      // Tab doesn't exist yet — every setting falls back to its default.
      return { ...DEFAULT_REPORT_SETTINGS };
    }
    throw new Error(`อ่านการตั้งค่ารายงานไม่สำเร็จ: ${message}`);
  }

  const stored = new Map<string, string>();
  for (const row of values ?? []) {
    const key = (row[0] ?? "").toString().trim();
    if (key) stored.set(key, (row[1] ?? "").toString());
  }

  const result: ReportSettings = {
    ...DEFAULT_REPORT_SETTINGS,
    actionOptions: [...DEFAULT_REPORT_SETTINGS.actionOptions],
    hiddenActionOptions: [...DEFAULT_REPORT_SETTINGS.hiddenActionOptions],
    detailRequiredActionOptions: [...DEFAULT_REPORT_SETTINGS.detailRequiredActionOptions],
    lockedActionOptions: [...DEFAULT_REPORT_SETTINGS.lockedActionOptions],
    actionColorOrder: [...DEFAULT_REPORT_SETTINGS.actionColorOrder],
  };
  for (const key of REPORT_SETTINGS_KEYS) {
    const v = stored.get(key);
    if (v === undefined || v.trim() === "") continue;
    if (
      key === "actionOptions" ||
      key === "hiddenActionOptions" ||
      key === "detailRequiredActionOptions" ||
      key === "lockedActionOptions" ||
      key === "actionColorOrder"
    ) {
      // JSON array, not plain text — see the interface comment above.
      try {
        const parsed: unknown = JSON.parse(v);
        if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) {
          // actionOptions must never end up empty (nothing to print/pick
          // from) — hiddenActionOptions/detailRequiredActionOptions/
          // lockedActionOptions/actionColorOrder have no such floor, an
          // empty array just means "nothing hidden/flagged/locked/
          // color-assigned yet" (actionColorOrder self-heals right below
          // anyway).
          if (key === "actionOptions") {
            if (parsed.length > 0) result.actionOptions = parsed as string[];
          } else if (key === "hiddenActionOptions") {
            result.hiddenActionOptions = parsed as string[];
          } else if (key === "detailRequiredActionOptions") {
            result.detailRequiredActionOptions = parsed as string[];
          } else if (key === "lockedActionOptions") {
            result.lockedActionOptions = parsed as string[];
          } else {
            result.actionColorOrder = parsed as string[];
          }
        }
      } catch {
        // Malformed cell (hand-edited?) — keep the default rather than crash.
      }
      continue;
    }
    result[key] = v;
  }
  // Self-heals actionColorOrder on every read: a ReportSettings tab saved
  // before this field existed (or hand-edited into an inconsistent state)
  // just falls back to actionOptions' own current order, which is exactly
  // this app's original index-based color behavior — see resolveColorOrder
  // (lib/actionColors) for why this is safe to always run, not just when
  // the parsed value came back empty.
  result.actionColorOrder = resolveColorOrder(result.actionOptions, result.actionColorOrder);
  return result;
}

/** Merges `updates` into the current settings and rewrites the whole
 * tab in the fixed REPORT_SETTINGS_KEYS order. Throws (with a
 * create-the-tab-first message) if the tab doesn't exist — unlike
 * getReportSettings, there's nothing sensible to fall back to for a
 * *write*. */
export async function updateReportSettings(updates: Partial<ReportSettings>): Promise<ReportSettings> {
  const current = await getReportSettings();
  const merged: ReportSettings = { ...current, ...updates };
  // actionColorOrder is never taken from `updates` as-is — always
  // recomputed here from the current (already self-healed) persisted order
  // plus whatever actionOptions ends up in `merged`, so a client can never
  // influence color assignment except indirectly through an actionOptions
  // change it's already permitted to make (see readSettingsPayload,
  // /api/manage/it/settings, which doesn't even accept this key). This is
  // also what makes a plain reorder (moveActionOption client-side) a no-op
  // for color: it only ever touches actionOptions, so this line just
  // reproduces the exact same actionColorOrder that was already there.
  merged.actionColorOrder = resolveColorOrder(merged.actionOptions, current.actionColorOrder);

  const spreadsheetId = getEnv("GOOGLE_SHEET_ID");
  const tab = getReportSettingsTab();
  const sheets = google.sheets({ version: "v4", auth: sheetsAuth() });

  try {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${tab}!A2:B${1 + REPORT_SETTINGS_KEYS.length}`,
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: REPORT_SETTINGS_KEYS.map((key) => {
          if (key === "actionOptions") return [key, JSON.stringify(merged.actionOptions)];
          if (key === "hiddenActionOptions") return [key, JSON.stringify(merged.hiddenActionOptions)];
          if (key === "detailRequiredActionOptions") return [key, JSON.stringify(merged.detailRequiredActionOptions)];
          if (key === "actionColorOrder") return [key, JSON.stringify(merged.actionColorOrder)];
          return [key, merged[key]];
        }),
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("Unable to parse range")) {
      throw new Error(
        `ยังไม่พบแท็บชื่อ "${tab}" ในสเปรดชีต — สร้างแท็บนี้ก่อน (หัวตาราง: Key | Value) หรือตั้งค่า GOOGLE_SHEET_REPORT_SETTINGS_TAB ให้ตรงกับชื่อแท็บจริง`
      );
    }
    throw new Error(`บันทึกการตั้งค่ารายงานไม่สำเร็จ: ${message}`);
  }

  return merged;
}

// ---------------------------------------------------------------------------
// MaintenanceLog tab — the IT dashboard's per-machine service history
// (/manage/it): every time IT services a computer they append one row here
// instead of overwriting a single "current status" cell, so the full
// history (every software/version update, every "เป่าฝุ่น" cleaning visit)
// stays visible, not just the latest one. A machine's *current* status —
// shown in the IT dashboard's spec tables — is simply whichever row has the
// newest timestamp for that เลขครุภัณฑ์; see getLatestMaintenanceLogByAsset.
//
// "ซอฟต์แวร์ที่ติดตั้ง/อัปเดต" is deliberately free-form ("HOSxP 3: 3.2.6;
// HOSxP 4: 4.1.0") rather than fixed HOSxP-3/HOSxP-4 columns — the hospital
// asked for room to track other software later without a schema change.
// joinSoftwareEntries/splitSoftwareEntries (fields.ts) are the only code
// that needs to understand this string's shape.
//
// Same manually-created-tab convention as ReportSettings/Users/EditLog: the
// sheet owner creates this tab by hand (see project setup notes) before
// anyone logs a maintenance visit. Reading tolerates a missing tab (just
// means "no history yet"); appending requires the tab to already exist.
// ---------------------------------------------------------------------------

// MaintenanceLogEntry / getLatestMaintenanceLogByAsset themselves are
// defined in lib/maintenanceLog.ts and re-exported above.

function getMaintenanceLogTab(): string {
  return process.env.GOOGLE_SHEET_MAINTENANCE_LOG_TAB?.trim() || "MaintenanceLog";
}

const MAINTENANCE_LOG_COLUMNS = 7; // timestamp, assetNumber, recordedBy, software, maintenanceDate, manualSpecStatus, notes

function parseManualSpecStatus(raw: string): MaintenanceLogEntry["manualSpecStatus"] {
  const trimmed = raw.trim();
  return trimmed === "ปกติ" || trimmed === "ต่ำกว่ามาตรฐาน" ? trimmed : "";
}

/** Every logged maintenance visit, oldest first (append order) — callers
 * that want "current status per asset" should use
 * getLatestMaintenanceLogByAsset instead of re-deriving it themselves. */
export async function getMaintenanceLog(): Promise<MaintenanceLogEntry[]> {
  const spreadsheetId = getEnv("GOOGLE_SHEET_ID");
  const tab = getMaintenanceLogTab();
  const sheets = google.sheets({ version: "v4", auth: sheetsAuth() });

  let values: string[][] | undefined;
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${tab}!A2:G100000`,
    });
    values = res.data.values as string[][] | undefined;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("Unable to parse range")) {
      // Tab doesn't exist yet — no maintenance history recorded anywhere.
      return [];
    }
    throw new Error(`อ่านประวัติการบำรุงรักษาไม่สำเร็จ: ${message}`);
  }

  return (values ?? [])
    .filter((row) => (row[1] ?? "").toString().trim()) // must have an asset number
    .map((row) => ({
      timestamp: (row[0] ?? "").toString(),
      assetNumber: (row[1] ?? "").toString().trim(),
      recordedBy: (row[2] ?? "").toString(),
      software: (row[3] ?? "").toString(),
      maintenanceDate: (row[4] ?? "").toString(),
      manualSpecStatus: parseManualSpecStatus((row[5] ?? "").toString()),
      notes: (row[6] ?? "").toString(),
    }));
}

/** Appends one maintenance-visit row. Throws a clear "create the tab
 * first" error if GOOGLE_SHEET_MAINTENANCE_LOG_TAB / "MaintenanceLog"
 * doesn't exist — same convention as appendEditLog. */
export async function appendMaintenanceLogEntry(
  entry: Omit<MaintenanceLogEntry, "timestamp"> & { timestamp?: string }
): Promise<void> {
  const spreadsheetId = getEnv("GOOGLE_SHEET_ID");
  const tab = getMaintenanceLogTab();
  const sheets = google.sheets({ version: "v4", auth: sheetsAuth() });
  const timestamp = entry.timestamp ?? new Date().toISOString();

  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${tab}!A1`,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: {
        values: [[
          timestamp,
          entry.assetNumber,
          entry.recordedBy,
          entry.software,
          entry.maintenanceDate,
          entry.manualSpecStatus,
          entry.notes,
        ]],
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("Unable to parse range")) {
      throw new Error(
        `ยังไม่พบแท็บชื่อ "${tab}" ในสเปรดชีต — สร้างแท็บนี้ก่อน (หัวตาราง: เวลา | เลขครุภัณฑ์ | ผู้บันทึก | ซอฟต์แวร์ที่ติดตั้ง/อัปเดต | วันที่บำรุงรักษา | ประเมินสเปกด้วยตนเอง | หมายเหตุ) หรือตั้งค่า GOOGLE_SHEET_MAINTENANCE_LOG_TAB ให้ตรงกับชื่อแท็บจริง`
      );
    }
    throw new Error(`บันทึกประวัติการบำรุงรักษาไม่สำเร็จ: ${message}`);
  }
  void MAINTENANCE_LOG_COLUMNS; // referenced for documentation/consistency only
}

// ---------------------------------------------------------------------------
// MaintenanceTasks tab — one mutable row per "IT is working on this piece
// of equipment right now" task, created automatically when an IT account
// prints a maintenance report from /manage/it/report (see
// createMaintenanceTasks, called from the report page's print button) and
// later filled in / closed from /manage/it/tasks (see updateMaintenanceTask).
// Unlike MaintenanceLog/EditLog above, this tab is NOT append-only — a task
// row gets read back and overwritten in place as its status changes from
// "in_progress" to "done", the same read-all/find-row/write-one-row pattern
// as updateUser() uses for the Users tab. TaskId (a random UUID, not the row
// number) is the stable identifier a client holds onto across that update,
// since the physical sheet row can shift if someone else's task is
// inserted/removed in between.
//
// ActionsTaken and InspectionChecks are small string arrays (checked items
// from the printed form's checklists) stored as a JSON string in one cell —
// same convention as ReportSettings.actionOptions above.
//
// Same manually-created-tab convention as every other tab here: the sheet
// owner creates it by hand before anyone prints a report. Reading tolerates
// a missing tab (just means "no tasks yet"); writing requires it to exist.
// ---------------------------------------------------------------------------

export type MaintenanceTaskStatus = "in_progress" | "done";
export type InspectionCheck = "ปกติ" | "ส่งซ่อม" | "เปลี่ยนอะไหล่" | "อื่นๆ";

export interface MaintenanceTask {
  taskId: string;
  createdAt: string;
  /** The equipment row's own sheet row number at the time the task was
   * created — kept for reference/audit only. Everything the task list and
   * dashboard actually display is snapshotted onto this row below, so
   * neither view needs to re-join against the live equipment sheet. */
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
  /** Free text for the "เปลี่ยนอะไหล่ ...." blank on the printed form. */
  partsChanged: string;
  /** Free text for the "อื่นๆ ระบุ ...." blank on the printed form. */
  otherDetail: string;
  notes: string;
  completedAt: string;
  completedByUsername: string;
  /** Snapshot of exactly which รายการ "การดำเนินการ" were selected and
   * printed on THIS task's form — set once at creation (see
   * createMaintenanceTasks, called from MaintenanceReportBuilder's
   * handlePrint with that print round's printActionOptions) and never
   * changed afterward. This is what MaintenanceTasksBoard's TaskUpdateModal
   * checklist is scoped to, instead of the full master ReportSettings.
   * actionOptions list — a task for "เป่าฝุ่น + อัปเดตโปรแกรม" should only
   * ever offer those two, not every action the hospital has ever defined.
   * A task created before this field existed reads back as an empty array
   * (parseJsonStringArray on a blank cell) — callers fall back to the full
   * master list in that case, see MaintenanceTasksBoard's own comment. */
  plannedActions: string[];
  /** Free-text detail per action, keyed by the exact action name — only
   * meaningful for names in ReportSettings.detailRequiredActionOptions
   * (e.g. "อัปเกรด/เปลี่ยนอะไหล่ฮาร์ดแวร์" -> "RAM 8GB"), filled in from
   * TaskUpdateModal once that action is ticked. Stored as a JSON object in
   * one cell, same one-cell-per-structured-value convention as
   * actionsTaken/inspectionChecks above. */
  actionDetails: Record<string, string>;
}

const MAINTENANCE_TASKS_HEADER_ROW = [
  "TaskId", "CreatedAt", "EquipmentRowNumber", "AssetNumber", "EquipmentType", "BrandModel",
  "Department", "Location", "AssignedToUsername", "AssignedToDisplayName", "Status",
  "ActionsTaken", "InspectionChecks", "PartsChanged", "OtherDetail", "Notes",
  "CompletedAt", "CompletedByUsername", "PlannedActions", "ActionDetails",
];

function getMaintenanceTasksTab(): string {
  return process.env.GOOGLE_SHEET_MAINTENANCE_TASKS_TAB?.trim() || "MaintenanceTasks";
}

function parseJsonStringArray(raw: string): string[] {
  if (!raw.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Same one-cell-JSON convention as parseJsonStringArray, for the one
 * object-shaped field (MaintenanceTask.actionDetails) instead of an array —
 * a malformed or blank cell reads back as an empty object rather than
 * throwing. */
function parseJsonStringRecord(raw: string): Record<string, string> {
  if (!raw.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function rowToMaintenanceTask(row: string[]): MaintenanceTask {
  const col = (i: number) => (row[i] ?? "").toString();
  return {
    taskId: col(0).trim(),
    createdAt: col(1),
    equipmentRowNumber: Number(col(2)) || 0,
    assetNumber: col(3),
    equipmentType: col(4),
    brandModel: col(5),
    department: col(6),
    location: col(7),
    assignedToUsername: col(8),
    assignedToDisplayName: col(9),
    status: col(10).trim() === "done" ? "done" : "in_progress",
    actionsTaken: parseJsonStringArray(col(11)),
    inspectionChecks: parseJsonStringArray(col(12)) as InspectionCheck[],
    partsChanged: col(13),
    otherDetail: col(14),
    notes: col(15),
    completedAt: col(16),
    completedByUsername: col(17),
    plannedActions: parseJsonStringArray(col(18)),
    actionDetails: parseJsonStringRecord(col(19)),
  };
}

function maintenanceTaskToRow(t: MaintenanceTask): (string | number)[] {
  return [
    t.taskId, t.createdAt, t.equipmentRowNumber, t.assetNumber, t.equipmentType, t.brandModel,
    t.department, t.location, t.assignedToUsername, t.assignedToDisplayName, t.status,
    JSON.stringify(t.actionsTaken), JSON.stringify(t.inspectionChecks), t.partsChanged,
    t.otherDetail, t.notes, t.completedAt, t.completedByUsername,
    JSON.stringify(t.plannedActions), JSON.stringify(t.actionDetails),
  ];
}

/** Every task, oldest first (append order) — the task-list page and
 * dashboard both filter/aggregate this client-side rather than the API
 * doing it, same rationale as getMaintenanceLog. */
export async function getMaintenanceTasks(): Promise<MaintenanceTask[]> {
  const spreadsheetId = getEnv("GOOGLE_SHEET_ID");
  const tab = getMaintenanceTasksTab();
  const sheets = google.sheets({ version: "v4", auth: sheetsAuth() });

  let values: string[][] | undefined;
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${tab}!A2:T100000`,
    });
    values = res.data.values as string[][] | undefined;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("Unable to parse range")) {
      // Tab doesn't exist yet — no tasks have ever been logged.
      return [];
    }
    throw new Error(`อ่านรายการงานบำรุงรักษาไม่สำเร็จ: ${message}`);
  }

  return (values ?? [])
    .filter((row) => (row[0] ?? "").toString().trim() !== "")
    .map(rowToMaintenanceTask);
}

/** Creates one "in progress" task per entry — called when an IT account
 * prints a maintenance report, one row per piece of equipment on that
 * report. Throws a clear "create the tab first" error if the
 * MaintenanceTasks tab doesn't exist yet. */
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
  /** The exact รายการ "การดำเนินการ" selected and printed on this round's
   * report — snapshotted identically onto every task created from it, since
   * one print always covers the same action selection across all its
   * equipment rows. See MaintenanceTask.plannedActions for why this needs
   * to be captured at creation time rather than re-derived later. */
  plannedActions: string[] = []
): Promise<MaintenanceTask[]> {
  if (entries.length === 0) return [];

  const spreadsheetId = getEnv("GOOGLE_SHEET_ID");
  const tab = getMaintenanceTasksTab();
  const sheets = google.sheets({ version: "v4", auth: sheetsAuth() });
  const now = new Date().toISOString();

  const tasks: MaintenanceTask[] = entries.map((e) => ({
    taskId: randomUUID(),
    createdAt: now,
    equipmentRowNumber: e.equipmentRowNumber,
    assetNumber: e.assetNumber,
    equipmentType: e.equipmentType,
    brandModel: e.brandModel,
    department: e.department,
    location: e.location,
    assignedToUsername: e.assignedToUsername,
    assignedToDisplayName: e.assignedToDisplayName,
    status: "in_progress",
    actionsTaken: [],
    inspectionChecks: [],
    partsChanged: "",
    otherDetail: "",
    notes: "",
    completedAt: "",
    completedByUsername: "",
    plannedActions: [...plannedActions],
    actionDetails: {},
  }));

  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${tab}!A1`,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: tasks.map(maintenanceTaskToRow) },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("Unable to parse range")) {
      throw new Error(
        `ยังไม่พบแท็บชื่อ "${tab}" ในสเปรดชีต — สร้างแท็บนี้ก่อน (หัวตาราง: ${MAINTENANCE_TASKS_HEADER_ROW.join(" | ")}) หรือตั้งค่า GOOGLE_SHEET_MAINTENANCE_TASKS_TAB ให้ตรงกับชื่อแท็บจริง`
      );
    }
    throw new Error(`บันทึกงานบำรุงรักษาไม่สำเร็จ: ${message}`);
  }

  return tasks;
}

/** Merges `updates` into the task identified by `taskId` and rewrites just
 * that one sheet row — looks the row up by scanning getMaintenanceTasks()
 * rather than trusting a cached row number, same reasoning as updateUser()
 * (another IT account's task could have been inserted/closed in between). */
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
  const spreadsheetId = getEnv("GOOGLE_SHEET_ID");
  const tab = getMaintenanceTasksTab();
  const sheets = google.sheets({ version: "v4", auth: sheetsAuth() });

  let values: string[][] | undefined;
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${tab}!A2:T100000`,
    });
    values = res.data.values as string[][] | undefined;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`อ่านรายการงานบำรุงรักษาไม่สำเร็จ: ${message}`);
  }

  const rows = values ?? [];
  const idx = rows.findIndex((row) => (row[0] ?? "").toString().trim() === taskId);
  if (idx === -1) {
    throw new Error("ไม่พบงานนี้ในระบบ — อาจถูกลบหรือแก้ไขไปแล้ว");
  }
  const merged: MaintenanceTask = { ...rowToMaintenanceTask(rows[idx]), ...updates };
  const sheetRow = idx + 2;

  try {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${tab}!A${sheetRow}:T${sheetRow}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [maintenanceTaskToRow(merged)] },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`บันทึกงานบำรุงรักษาไม่สำเร็จ: ${message}`);
  }

  return merged;
}

/** Physically removes one task row from the MaintenanceTasks tab — for when
 * IT selected the wrong equipment (or a duplicate) and wants the mistaken
 * task gone entirely, not just closed. Unlike updateMaintenanceTask this
 * doesn't rewrite a row in place; it deletes the sheet row outright via a
 * deleteDimension batchUpdate, so it disappears from every list immediately
 * and never leaves a blank row behind. Same find-by-taskId scan as
 * updateMaintenanceTask, for the same reason (another account's task could
 * have shifted the physical row in between).
 *
 * A "done" task can never be deleted this way — it's the completed record
 * of work IT actually did, kept for the หัวหน้า tracking view/history, so
 * only a fresh "in_progress" mistake is eligible. The API route also
 * enforces this server-side (never trust the client alone), but the check
 * lives here too so any other caller gets the same guarantee. */
export async function deleteMaintenanceTask(taskId: string): Promise<void> {
  const spreadsheetId = getEnv("GOOGLE_SHEET_ID");
  const tab = getMaintenanceTasksTab();
  const sheets = google.sheets({ version: "v4", auth: sheetsAuth() });

  let values: string[][] | undefined;
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${tab}!A2:T100000`,
    });
    values = res.data.values as string[][] | undefined;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`อ่านรายการงานบำรุงรักษาไม่สำเร็จ: ${message}`);
  }

  const rows = values ?? [];
  const idx = rows.findIndex((row) => (row[0] ?? "").toString().trim() === taskId);
  if (idx === -1) {
    throw new Error("ไม่พบงานนี้ในระบบ — อาจถูกลบไปแล้ว");
  }
  if (rowToMaintenanceTask(rows[idx]).status === "done") {
    throw new Error("งานนี้เสร็จสิ้นแล้ว ไม่สามารถลบได้");
  }
  const sheetRow = idx + 2; // 1-based sheet row — matches updateMaintenanceTask's own math

  let sheetId: number | null | undefined;
  try {
    const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: "sheets.properties" });
    sheetId = meta.data.sheets?.find((s) => s.properties?.title === tab)?.properties?.sheetId;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`ลบงานบำรุงรักษาไม่สำเร็จ: ${message}`);
  }
  if (sheetId == null) {
    throw new Error(`ไม่พบแท็บชื่อ "${tab}" ในสเปรดชีต`);
  }

  try {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            deleteDimension: {
              range: {
                sheetId,
                dimension: "ROWS",
                startIndex: sheetRow - 1,
                endIndex: sheetRow,
              },
            },
          },
        ],
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`ลบงานบำรุงรักษาไม่สำเร็จ: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// SpecStandards tab — the minimum PC spec the hospital currently considers
// acceptable, used by lib/specEvaluation.ts to auto-flag a machine as
// "ต่ำกว่ามาตรฐาน" from its already-recorded RAM/storage spec columns. Same
// Key | Value shape and manual-tab-creation convention as ReportSettings —
// see that section's comment for the read/write fallback rules, which this
// mirrors exactly.
// ---------------------------------------------------------------------------

// SpecStandards / DEFAULT_SPEC_STANDARDS themselves are defined in
// lib/specEvaluation.ts and re-exported above.

const SPEC_STANDARDS_KEYS = Object.keys(DEFAULT_SPEC_STANDARDS) as (keyof SpecStandards)[];

function getSpecStandardsTab(): string {
  return process.env.GOOGLE_SHEET_SPEC_STANDARDS_TAB?.trim() || "SpecStandards";
}

export async function getSpecStandards(): Promise<SpecStandards> {
  const spreadsheetId = getEnv("GOOGLE_SHEET_ID");
  const tab = getSpecStandardsTab();
  const sheets = google.sheets({ version: "v4", auth: sheetsAuth() });

  let values: string[][] | undefined;
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${tab}!A2:B200`,
    });
    values = res.data.values as string[][] | undefined;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("Unable to parse range")) {
      return { ...DEFAULT_SPEC_STANDARDS };
    }
    throw new Error(`อ่านมาตรฐานสเปกไม่สำเร็จ: ${message}`);
  }

  const stored = new Map<string, string>();
  for (const row of values ?? []) {
    const key = (row[0] ?? "").toString().trim();
    if (key) stored.set(key, (row[1] ?? "").toString());
  }

  const result: SpecStandards = {
    ...DEFAULT_SPEC_STANDARDS,
    ramCapacityOptions: [...DEFAULT_SPEC_STANDARDS.ramCapacityOptions],
    ramSpeedOptions: [...DEFAULT_SPEC_STANDARDS.ramSpeedOptions],
    storageTypeOptions: [...DEFAULT_SPEC_STANDARDS.storageTypeOptions],
    storageCapacityOptions: [...DEFAULT_SPEC_STANDARDS.storageCapacityOptions],
  };
  for (const key of SPEC_STANDARDS_KEYS) {
    const v = stored.get(key);
    if (v === undefined || v.trim() === "") continue;
    if (
      key === "ramCapacityOptions" ||
      key === "ramSpeedOptions" ||
      key === "storageTypeOptions" ||
      key === "storageCapacityOptions"
    ) {
      // JSON array, not plain text — same convention as
      // ReportSettings.actionOptions (see getReportSettings above).
      try {
        const parsed: unknown = JSON.parse(v);
        if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) {
          result[key] = parsed as string[];
        }
      } catch {
        // Malformed cell (hand-edited?) — keep the default rather than crash.
      }
      continue;
    }
    result[key] = v;
  }
  return result;
}

export async function updateSpecStandards(updates: Partial<SpecStandards>): Promise<SpecStandards> {
  const current = await getSpecStandards();
  const merged: SpecStandards = { ...current, ...updates };

  const spreadsheetId = getEnv("GOOGLE_SHEET_ID");
  const tab = getSpecStandardsTab();
  const sheets = google.sheets({ version: "v4", auth: sheetsAuth() });

  try {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${tab}!A2:B${1 + SPEC_STANDARDS_KEYS.length}`,
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: SPEC_STANDARDS_KEYS.map((key) => {
          if (
            key === "ramCapacityOptions" ||
            key === "ramSpeedOptions" ||
            key === "storageTypeOptions" ||
            key === "storageCapacityOptions"
          ) {
            return [key, JSON.stringify(merged[key])];
          }
          return [key, merged[key]];
        }),
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("Unable to parse range")) {
      throw new Error(
        `ยังไม่พบแท็บชื่อ "${tab}" ในสเปรดชีต — สร้างแท็บนี้ก่อน (หัวตาราง: Key | Value) หรือตั้งค่า GOOGLE_SHEET_SPEC_STANDARDS_TAB ให้ตรงกับชื่อแท็บจริง`
      );
    }
    throw new Error(`บันทึกมาตรฐานสเปกไม่สำเร็จ: ${message}`);
  }

  return merged;
}

// ---------------------------------------------------------------------------
// Equipment: add new row (superadmin only) / soft-delete via status column
// ---------------------------------------------------------------------------

/** Appends a new equipment row to the end of the main sheet, in whatever
 * header order the sheet currently has. Returns the row number Sheets
 * actually wrote to — parsed from the API's updatedRange rather than
 * assumed from the current row count, since an append always lands after
 * the last non-empty row (trailing blank rows, or a concurrent append,
 * would make an assumed row number wrong). */
export async function appendEquipmentRow(values: Record<string, string>): Promise<{ rowNumber: number }> {
  const spreadsheetId = getEnv("GOOGLE_SHEET_ID");
  const tab = process.env.GOOGLE_SHEET_TAB?.trim() || "Sheet1";
  const sheets = google.sheets({ version: "v4", auth: sheetsAuth() });

  const headerRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${tab}!A1:Z1` });
  const headers = ((headerRes.data.values?.[0] ?? []) as string[]).map((h) => (h ?? "").toString().trim());
  const orderedValues = headers.map((h) => values[h] ?? "");

  const appendRes = await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${tab}!A1`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [orderedValues] },
  });

  const updatedRange = appendRes.data.updates?.updatedRange ?? "";
  const match = updatedRange.match(/![A-Z]+(\d+):/);
  const rowNumber = match ? Number(match[1]) : NaN;
  if (!Number.isInteger(rowNumber)) {
    throw new Error("เพิ่มรายการสำเร็จแต่ไม่สามารถระบุแถวที่เพิ่มได้ กรุณารีเฟรชหน้าเพื่อตรวจสอบ");
  }
  return { rowNumber };
}

/** Soft-deletes ("จำหน่าย") one equipment row by overwriting just its status
 * column, via the same updateEquipmentRow() used for regular edits — reads
 * only the one row it needs (not the whole sheet) since this can be called
 * for any row number without a prior full fetch. */
export async function setEquipmentStatus(
  rowNumber: number,
  statusHeader: string,
  status: string
): Promise<Record<string, string>> {
  const spreadsheetId = getEnv("GOOGLE_SHEET_ID");
  const tab = process.env.GOOGLE_SHEET_TAB?.trim() || "Sheet1";
  const sheets = google.sheets({ version: "v4", auth: sheetsAuth() });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${tab}!A1:Z${rowNumber}`,
  });
  const values = (res.data.values ?? []) as string[][];
  const headers = (values[0] ?? []).map((h) => (h ?? "").toString().trim());
  const rowValues = values[rowNumber - 1] ?? [];
  if (rowValues.length === 0) {
    throw new Error("ไม่พบรายการนี้ — อาจถูกย้ายหรือลบไปแล้ว");
  }

  const current: Record<string, string> = {};
  headers.forEach((h, i) => {
    current[h || `column_${i + 1}`] = (rowValues[i] ?? "").toString();
  });
  current[statusHeader] = status;

  await updateEquipmentRow(rowNumber, headers, current);
  return current;
}

/** 1-based column index -> spreadsheet column letter(s), e.g. 1 -> "A", 27 -> "AA". */
function columnLetter(index: number): string {
  let n = index;
  let letters = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

// ---------------------------------------------------------------------------
// BookingResources / Bookings tabs — vehicle + meeting-room booking feature
// ("ระบบจองรถ จองห้องประชุม"). Same manually-created-tab convention as every
// other tab here: the sheet owner creates both by hand before anyone can
// add a resource or make a booking. Reading tolerates either tab being
// missing (just means "no resources/bookings yet"); writing requires the
// relevant tab to exist. Any logged-in account, any role, can read both and
// can make a booking — only *managing* BookingResources itself (add/edit/
// toggle-active) is restricted, see lib/booking.ts's top comment and
// canManageBookingResources in lib/auth.ts.
// ---------------------------------------------------------------------------

const BOOKING_RESOURCES_HEADER_ROW = [
  "ResourceId", "Type", "Name", "Detail", "Active", "CreatedAt", "CreatedByUsername", "ImageDataUrl", "SeatCount",
];

const BOOKINGS_HEADER_ROW = [
  "BookingId", "ResourceId", "ResourceType", "ResourceName", "StartTime", "EndTime",
  "Purpose", "Destination", "Participants", "ContactPhone", "BookedByUsername",
  "BookedByDisplayName", "Department", "CreatedAt", "CancelledAt", "CancelledByUsername",
  "ApprovalStatus", "ApprovedAt", "ApprovedByUsername",
  // Added after the original 19 columns (same one-time manual-column-add
  // pattern as ExtraPermissions/RevokedPermissions on the Users tab) — a
  // sheet that predates this feature just has blank T/U cells, which reads
  // back as "no companions" / "not yet dispatched" (see rowToBooking),
  // nothing existing breaks until the sheet owner adds these two by hand.
  "Companions", "TripOrderId",
  // Added later still, same manual-add convention — blank V/W cells read
  // back as "never edited by management" (see rowToBooking/
  // editBookingByManagement below).
  "EditedByUsername", "EditedAt",
  // Added for the director (ผอ.) sign-off layer — same manual-add
  // convention as above; blank X/Y cells read back as "" (not yet
  // dispatched / not applicable), see parseDirectorApprovalStatus and the
  // DirectorApprovalStatus doc comment in lib/booking.ts.
  "DirectorApprovalStatus", "DirectorApprovedAt",
  // Added for the director's note (ไม่อนุมัติ's reason to the requester, or
  // ตีกลับ's note to dispatch) and the ตีกลับ timestamp — same manual-add
  // convention; blank Z/AA cells read back as "" (see rowToBooking and
  // Booking.directorNote/directorReturnedAt's doc comments in
  // lib/booking.ts).
  "DirectorNote", "DirectorReturnedAt",
];

function getBookingResourcesTab(): string {
  return process.env.GOOGLE_SHEET_BOOKING_RESOURCES_TAB?.trim() || "BookingResources";
}

function getBookingsTab(): string {
  return process.env.GOOGLE_SHEET_BOOKINGS_TAB?.trim() || "Bookings";
}

function parseBookingResourceType(raw: string): BookingResourceType {
  return raw.trim() === "room" ? "room" : "car";
}

function rowToBookingResource(row: string[]): BookingResource {
  const col = (i: number) => (row[i] ?? "").toString();
  return {
    resourceId: col(0).trim(),
    type: parseBookingResourceType(col(1)),
    name: col(2),
    detail: col(3),
    active: parseActive(col(4)),
    createdAt: col(5),
    createdByUsername: col(6),
    imageDataUrl: col(7),
    seatCount: Number(col(8)) || 0,
  };
}

function bookingResourceToRow(r: BookingResource): (string | number)[] {
  return [
    r.resourceId, r.type, r.name, r.detail, r.active ? "Y" : "N", r.createdAt, r.createdByUsername,
    r.imageDataUrl, r.seatCount,
  ];
}

/** Defaults anything not exactly "pending"/"rejected" to "approved" — this
 * is what makes a blank ApprovalStatus cell (every room booking, and every
 * car booking written before this column existed) read back as already
 * confirmed instead of retroactively becoming "pending". */
function parseApprovalStatus(raw: string): BookingApprovalStatus {
  const v = raw.trim();
  return v === "pending" || v === "rejected" ? v : "approved";
}

/** Unlike parseApprovalStatus above, a blank cell here genuinely means ""
 * (not applicable yet) rather than defaulting to some other state — every
 * row written before this column existed, and every room booking, is
 * correctly "" either way (see the DirectorApprovalStatus doc comment in
 * lib/booking.ts). */
function parseDirectorApprovalStatus(raw: string): DirectorApprovalStatus {
  const v = raw.trim();
  return v === "pending" || v === "approved" || v === "rejected" ? v : "";
}

function rowToBooking(row: string[]): Booking {
  const col = (i: number) => (row[i] ?? "").toString();
  return {
    bookingId: col(0).trim(),
    resourceId: col(1),
    resourceType: parseBookingResourceType(col(2)),
    resourceName: col(3),
    startTime: col(4),
    endTime: col(5),
    purpose: col(6),
    destination: col(7),
    participants: Number(col(8)) || 0,
    contactPhone: col(9),
    bookedByUsername: col(10),
    bookedByDisplayName: col(11),
    department: col(12),
    createdAt: col(13),
    cancelledAt: col(14),
    cancelledByUsername: col(15),
    approvalStatus: parseApprovalStatus(col(16)),
    approvedAt: col(17),
    approvedByUsername: col(18),
    companions: col(19),
    tripOrderId: col(20).trim(),
    editedByUsername: col(21),
    editedAt: col(22),
    directorApprovalStatus: parseDirectorApprovalStatus(col(23)),
    directorApprovedAt: col(24),
    // คอลัมน์ Z/AA เพิ่มทีหลัง (ดูคอมเมนต์ Booking.directorNote/
    // directorReturnedAt ใน lib/booking.ts) — แถวเก่าก่อนมีคอลัมน์นี้อ่านเป็น
    // "" ตามปกติเหมือนทุกคอลัมน์ blank-means-not-applicable อื่นในไฟล์นี้.
    directorNote: col(25),
    directorReturnedAt: col(26),
  };
}

function bookingToRow(b: Booking): (string | number)[] {
  return [
    b.bookingId, b.resourceId, b.resourceType, b.resourceName, b.startTime, b.endTime,
    b.purpose, b.destination, b.participants, b.contactPhone, b.bookedByUsername,
    b.bookedByDisplayName, b.department, b.createdAt, b.cancelledAt, b.cancelledByUsername,
    b.approvalStatus, b.approvedAt, b.approvedByUsername, b.companions, b.tripOrderId,
    b.editedByUsername, b.editedAt, b.directorApprovalStatus, b.directorApprovedAt,
    b.directorNote, b.directorReturnedAt,
  ];
}

/** Every resource (car + room, active + deactivated) — callers filter by
 * type/active themselves, same rationale as getMaintenanceTasks. */
export async function getBookingResources(): Promise<BookingResource[]> {
  const spreadsheetId = getEnv("GOOGLE_SHEET_ID");
  const tab = getBookingResourcesTab();
  const sheets = google.sheets({ version: "v4", auth: sheetsAuth() });

  let values: string[][] | undefined;
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${tab}!A2:I100000`,
    });
    values = res.data.values as string[][] | undefined;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("Unable to parse range")) {
      // Tab doesn't exist yet — no resources have ever been added.
      return [];
    }
    throw new Error(`อ่านรายการรถ/ห้องประชุมไม่สำเร็จ: ${message}`);
  }

  return (values ?? [])
    .filter((row) => (row[0] ?? "").toString().trim() !== "")
    .map(rowToBookingResource);
}

/** Adds one new vehicle or meeting room. Throws a clear "create the tab
 * first" Thai error if the BookingResources tab doesn't exist yet.
 * seatCount is only meaningful for type "car" — always stored as 0 for a
 * room regardless of what's passed in, so a room resource never
 * accidentally carries a stray seat count. */
export async function createBookingResource(input: {
  type: BookingResourceType;
  name: string;
  detail: string;
  createdByUsername: string;
  imageDataUrl: string;
  seatCount: number;
}): Promise<BookingResource> {
  const spreadsheetId = getEnv("GOOGLE_SHEET_ID");
  const tab = getBookingResourcesTab();
  const sheets = google.sheets({ version: "v4", auth: sheetsAuth() });

  const resource: BookingResource = {
    resourceId: randomUUID(),
    type: input.type,
    name: input.name,
    detail: input.detail,
    active: true,
    createdAt: new Date().toISOString(),
    createdByUsername: input.createdByUsername,
    imageDataUrl: input.imageDataUrl,
    seatCount: input.type === "car" ? input.seatCount : 0,
  };

  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${tab}!A1`,
      // RAW, not USER_ENTERED — CreatedAt is a plain ISO datetime string
      // (2026-09-15T08:33:00.000Z); USER_ENTERED lets Sheets "helpfully"
      // recognize and reformat date-looking text, which silently changes
      // what a later values.get() reads back (see the same note on
      // createBooking below, where this actually broke the app).
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [bookingResourceToRow(resource)] },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("Unable to parse range")) {
      throw new Error(
        `ยังไม่พบแท็บชื่อ "${tab}" ในสเปรดชีต — สร้างแท็บนี้ก่อน (หัวตาราง: ${BOOKING_RESOURCES_HEADER_ROW.join(" | ")}) หรือตั้งค่า GOOGLE_SHEET_BOOKING_RESOURCES_TAB ให้ตรงกับชื่อแท็บจริง`
      );
    }
    throw new Error(`เพิ่มรถ/ห้องประชุมไม่สำเร็จ: ${message}`);
  }

  return resource;
}

/** Merges `updates` into the resource identified by `resourceId` and
 * rewrites just that one sheet row — find-by-id scan, same reasoning as
 * updateMaintenanceTask (another account could have added/removed a
 * resource in between). Renaming/editing detail never touches past
 * bookings' snapshotted resourceName; toggling `active` to false just
 * removes it from the choosable list for *new* bookings (see
 * getBookingResources callers in the API routes). */
export async function updateBookingResource(
  resourceId: string,
  updates: Partial<Pick<BookingResource, "name" | "detail" | "active" | "imageDataUrl" | "seatCount">>
): Promise<BookingResource> {
  const spreadsheetId = getEnv("GOOGLE_SHEET_ID");
  const tab = getBookingResourcesTab();
  const sheets = google.sheets({ version: "v4", auth: sheetsAuth() });

  let values: string[][] | undefined;
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${tab}!A2:I100000`,
    });
    values = res.data.values as string[][] | undefined;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`อ่านรายการรถ/ห้องประชุมไม่สำเร็จ: ${message}`);
  }

  const rows = values ?? [];
  const idx = rows.findIndex((row) => (row[0] ?? "").toString().trim() === resourceId);
  if (idx === -1) {
    throw new Error("ไม่พบรายการนี้ — อาจถูกลบไปแล้ว");
  }
  const merged: BookingResource = { ...rowToBookingResource(rows[idx]), ...updates };
  const sheetRow = idx + 2;

  try {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${tab}!A${sheetRow}:I${sheetRow}`,
      // RAW — see the note on the append() above.
      valueInputOption: "RAW",
      requestBody: { values: [bookingResourceToRow(merged)] },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`บันทึกรถ/ห้องประชุมไม่สำเร็จ: ${message}`);
  }

  return merged;
}

// ---------------------------------------------------------------------------
// Drivers tab — คนขับรถ (vehicle-booking feature, see the BookingResources
// section above). Same manually-created-tab convention as every other tab
// here; same soft-deactivate convention as BookingResources (never
// hard-deleted, so a past TripOrder's driverName snapshot keeps its meaning
// even once the driver it came from is deactivated). Reading/listing is open
// to any logged-in account (TripOrderModal needs the active list to offer as
// dropdown options to anyone dispatching a trip); only *managing* this list
// (add/edit/toggle-active) is restricted — see canManageDrivers in
// lib/auth.ts and the "manageDrivers" permission key in lib/permissions.ts,
// deliberately its own dedicated key rather than reusing
// "manageBookingResources", per the hospital's explicit request.
// ---------------------------------------------------------------------------

const DRIVERS_HEADER_ROW = ["DriverId", "Name", "Phone", "Active", "CreatedAt", "CreatedByUsername"];

function getDriversTab(): string {
  return process.env.GOOGLE_SHEET_DRIVERS_TAB?.trim() || "Drivers";
}

function rowToDriver(row: string[]): Driver {
  const col = (i: number) => (row[i] ?? "").toString();
  return {
    driverId: col(0).trim(),
    name: col(1),
    phone: col(2),
    active: parseActive(col(3)),
    createdAt: col(4),
    createdByUsername: col(5),
  };
}

function driverToRow(d: Driver): string[] {
  return [d.driverId, d.name, d.phone, d.active ? "Y" : "N", d.createdAt, d.createdByUsername];
}

/** Every driver (active + deactivated) — callers filter by `active`
 * themselves, same rationale as getBookingResources. */
export async function getDrivers(): Promise<Driver[]> {
  const spreadsheetId = getEnv("GOOGLE_SHEET_ID");
  const tab = getDriversTab();
  const sheets = google.sheets({ version: "v4", auth: sheetsAuth() });

  let values: string[][] | undefined;
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${tab}!A2:F100000`,
    });
    values = res.data.values as string[][] | undefined;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("Unable to parse range")) {
      // Tab doesn't exist yet — no drivers have ever been added.
      return [];
    }
    throw new Error(`อ่านรายชื่อคนขับรถไม่สำเร็จ: ${message}`);
  }

  return (values ?? []).filter((row) => (row[0] ?? "").toString().trim() !== "").map(rowToDriver);
}

/** Adds one new driver. Throws a clear "create the tab first" Thai error if
 * the Drivers tab doesn't exist yet — same pattern as createBookingResource. */
export async function createDriver(input: {
  name: string;
  phone: string;
  createdByUsername: string;
}): Promise<Driver> {
  const spreadsheetId = getEnv("GOOGLE_SHEET_ID");
  const tab = getDriversTab();
  const sheets = google.sheets({ version: "v4", auth: sheetsAuth() });

  const driver: Driver = {
    driverId: randomUUID(),
    name: input.name,
    phone: input.phone,
    active: true,
    createdAt: new Date().toISOString(),
    createdByUsername: input.createdByUsername,
  };

  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${tab}!A1`,
      // RAW, not USER_ENTERED — see the identical note on
      // createBookingResource above (CreatedAt is a plain ISO datetime
      // string; USER_ENTERED lets Sheets "helpfully" reformat date-looking
      // text, silently changing what a later values.get() reads back).
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [driverToRow(driver)] },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("Unable to parse range")) {
      throw new Error(
        `ยังไม่พบแท็บชื่อ "${tab}" ในสเปรดชีต — สร้างแท็บนี้ก่อน (หัวตาราง: ${DRIVERS_HEADER_ROW.join(" | ")}) หรือตั้งค่า GOOGLE_SHEET_DRIVERS_TAB ให้ตรงกับชื่อแท็บจริง`
      );
    }
    throw new Error(`เพิ่มคนขับรถไม่สำเร็จ: ${message}`);
  }

  return driver;
}

/** Merges `updates` into the driver identified by `driverId` and rewrites
 * just that one sheet row — find-by-id scan, same reasoning as
 * updateBookingResource. Toggling `active` to false just removes the driver
 * from the choosable list for *new* trip orders (see getDrivers callers);
 * it never touches a past TripOrder's already-snapshotted driverName
 * string. */
export async function updateDriver(
  driverId: string,
  updates: Partial<Pick<Driver, "name" | "phone" | "active">>
): Promise<Driver> {
  const spreadsheetId = getEnv("GOOGLE_SHEET_ID");
  const tab = getDriversTab();
  const sheets = google.sheets({ version: "v4", auth: sheetsAuth() });

  let values: string[][] | undefined;
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${tab}!A2:F100000`,
    });
    values = res.data.values as string[][] | undefined;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`อ่านรายชื่อคนขับรถไม่สำเร็จ: ${message}`);
  }

  const rows = values ?? [];
  const idx = rows.findIndex((row) => (row[0] ?? "").toString().trim() === driverId);
  if (idx === -1) {
    throw new Error("ไม่พบคนขับรายนี้ — อาจถูกลบไปแล้ว");
  }
  const merged: Driver = { ...rowToDriver(rows[idx]), ...updates };
  const sheetRow = idx + 2;

  try {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${tab}!A${sheetRow}:F${sheetRow}`,
      valueInputOption: "RAW",
      requestBody: { values: [driverToRow(merged)] },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`บันทึกข้อมูลคนขับรถไม่สำเร็จ: ${message}`);
  }

  return merged;
}

/** Every booking (live + cancelled) across every resource — callers filter
 * by resource/type/date range themselves, same rationale as
 * getMaintenanceTasks. */
export async function getBookings(): Promise<Booking[]> {
  const spreadsheetId = getEnv("GOOGLE_SHEET_ID");
  const tab = getBookingsTab();
  const sheets = google.sheets({ version: "v4", auth: sheetsAuth() });

  let values: string[][] | undefined;
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${tab}!A2:AA100000`,
    });
    values = res.data.values as string[][] | undefined;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("Unable to parse range")) {
      // Tab doesn't exist yet — no bookings have ever been made.
      return [];
    }
    throw new Error(`อ่านรายการจองไม่สำเร็จ: ${message}`);
  }

  return (values ?? [])
    .filter((row) => (row[0] ?? "").toString().trim() !== "")
    .map(rowToBooking);
}

/** Creates one booking. Room bookings confirm immediately (approvalStatus
 * "approved") — a room can only host one meeting at a time, so this
 * re-checks for a time conflict against the *current* Bookings tab (never
 * trust a conflict check the caller may have done earlier against a stale
 * list — two accounts could race to book the same slot) and throws a clear
 * Thai error on conflict.
 *
 * Car bookings start "pending" and skip that conflict check entirely — per
 * the hospital's explicit request, more than one pending request against
 * the same car/time is allowed (even expected: overlapping requests are
 * exactly what management reviews to decide which car, which driver, and
 * whether to combine them into one TripOrder — see createTripOrder below
 * and canApproveCarBooking's doc comment in lib/booking.ts). A car booking
 * needs a superadmin's review before it's "approved" either way.
 *
 * Throws a "create the tab first" error if the Bookings tab doesn't exist
 * yet. The caller (POST /api/booking/bookings) derives approvalStatus from
 * resourceType, same as it already derives destination. */
export async function createBooking(input: {
  resourceId: string;
  resourceType: BookingResourceType;
  resourceName: string;
  startTime: string;
  endTime: string;
  purpose: string;
  destination: string;
  participants: number;
  contactPhone: string;
  bookedByUsername: string;
  bookedByDisplayName: string;
  department: string;
  approvalStatus: BookingApprovalStatus;
  /** ผู้ร่วมเดินทาง — optional, car only; "" for a room booking, same
   * derivation the caller already does for destination. */
  companions: string;
}): Promise<Booking> {
  const spreadsheetId = getEnv("GOOGLE_SHEET_ID");
  const tab = getBookingsTab();
  const sheets = google.sheets({ version: "v4", auth: sheetsAuth() });

  // ห้องประชุมเท่านั้นที่ยังเช็คช่วงเวลาซ้ำ — รถอนุญาตให้จองเวลาซ้ำกันได้
  // โดยตั้งใจ ดูคอมเมนต์ด้านบนฟังก์ชันนี้
  if (input.resourceType === "room") {
    const existing = await getBookings();
    if (hasBookingConflict(existing, input.resourceId, input.startTime, input.endTime)) {
      throw new Error("ช่วงเวลาที่เลือกถูกจองไปแล้ว กรุณาเลือกช่วงเวลาอื่น");
    }
  }

  const booking: Booking = {
    bookingId: randomUUID(),
    resourceId: input.resourceId,
    resourceType: input.resourceType,
    resourceName: input.resourceName,
    startTime: input.startTime,
    endTime: input.endTime,
    purpose: input.purpose,
    destination: input.destination,
    participants: input.participants,
    contactPhone: input.contactPhone,
    bookedByUsername: input.bookedByUsername,
    bookedByDisplayName: input.bookedByDisplayName,
    department: input.department,
    createdAt: new Date().toISOString(),
    cancelledAt: "",
    cancelledByUsername: "",
    approvalStatus: input.approvalStatus,
    approvedAt: "",
    approvedByUsername: "",
    companions: input.companions,
    tripOrderId: "",
    editedByUsername: "",
    editedAt: "",
    directorApprovalStatus: "",
    directorApprovedAt: "",
    directorNote: "",
    directorReturnedAt: "",
  };

  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${tab}!A1`,
      // RAW, not USER_ENTERED — StartTime/EndTime are plain
      // "2026-09-15T08:33" strings the app parses itself (see
      // splitBookingDateTime in lib/booking.ts). USER_ENTERED lets Sheets
      // recognize that text as a date and silently reformat it (commonly to
      // something like "2026-09-15 8:33:00"), which a later values.get()
      // reads back instead of what was written — the app's date parsing
      // then fails to match, and the booking quietly vanishes from the
      // calendar (which needs a parseable date) while still showing in the
      // list view (which just falls back to printing the raw string
      // unchanged). RAW writes the string byte-for-byte, so this can't
      // happen for anything created from here on.
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [bookingToRow(booking)] },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("Unable to parse range")) {
      throw new Error(
        `ยังไม่พบแท็บชื่อ "${tab}" ในสเปรดชีต — สร้างแท็บนี้ก่อน (หัวตาราง: ${BOOKINGS_HEADER_ROW.join(" | ")}) หรือตั้งค่า GOOGLE_SHEET_BOOKINGS_TAB ให้ตรงกับชื่อแท็บจริง`
      );
    }
    throw new Error(`บันทึกการจองไม่สำเร็จ: ${message}`);
  }

  return booking;
}

/** Soft-cancels one booking (sets CancelledAt/CancelledByUsername) rather
 * than deleting the row — keeps the slot's history visible and matches the
 * "จำหน่าย/ยกเลิกการจำหน่าย" pattern used for equipment elsewhere in this
 * app. Find-by-id scan, same reasoning as updateMaintenanceTask. The
 * permission check (creator or superadmin — see lib/booking.ts
 * canCancelBooking) is the API route's job, not this function's; this just
 * performs the write once the caller has already decided it's allowed. */
export async function cancelBooking(bookingId: string, cancelledByUsername: string): Promise<Booking> {
  const spreadsheetId = getEnv("GOOGLE_SHEET_ID");
  const tab = getBookingsTab();
  const sheets = google.sheets({ version: "v4", auth: sheetsAuth() });

  let values: string[][] | undefined;
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${tab}!A2:AA100000`,
    });
    values = res.data.values as string[][] | undefined;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`อ่านรายการจองไม่สำเร็จ: ${message}`);
  }

  const rows = values ?? [];
  const idx = rows.findIndex((row) => (row[0] ?? "").toString().trim() === bookingId);
  if (idx === -1) {
    throw new Error("ไม่พบรายการจองนี้ — อาจถูกยกเลิกไปแล้ว");
  }
  const current = rowToBooking(rows[idx]);
  if (isBookingCancelled(current)) {
    throw new Error("รายการจองนี้ถูกยกเลิกไปแล้ว");
  }
  const merged: Booking = { ...current, cancelledAt: new Date().toISOString(), cancelledByUsername };
  const sheetRow = idx + 2;

  try {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${tab}!A${sheetRow}:AA${sheetRow}`,
      // RAW — see the note on createBooking's append() above.
      valueInputOption: "RAW",
      requestBody: { values: [bookingToRow(merged)] },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`ยกเลิกการจองไม่สำเร็จ: ${message}`);
  }

  return merged;
}

/** Rejects a *pending* car booking outright — the superadmin review step a
 * car booking needs before it's settled either way (see
 * BookingApprovalStatus in lib/booking.ts). Find-by-id scan, same reasoning
 * as cancelBooking. Only ever moves a booking out of "pending" — rejecting
 * one that's already been reviewed (or was cancelled by its owner first, or
 * isn't a car booking) throws instead of silently overwriting a prior
 * decision; the permission check itself (canApproveCarBooking) is the API
 * route's job, not this function's, same split as
 * cancelBooking/canCancelBooking.
 *
 * "approved" is deliberately not an accepted value here anymore — approving
 * a pending car booking now means dispatching it via createTripOrder below
 * (which does its own approvalStatus/approvedAt/approvedByUsername write,
 * alongside setting tripOrderId), never this plain toggle. Keeping this
 * function reject-only means there's no code path left that can mark a
 * booking "approved" without a TripOrder backing it. */
export async function rejectCarBooking(bookingId: string, rejectedByUsername: string): Promise<Booking> {
  const spreadsheetId = getEnv("GOOGLE_SHEET_ID");
  const tab = getBookingsTab();
  const sheets = google.sheets({ version: "v4", auth: sheetsAuth() });

  let values: string[][] | undefined;
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${tab}!A2:AA100000`,
    });
    values = res.data.values as string[][] | undefined;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`อ่านรายการจองไม่สำเร็จ: ${message}`);
  }

  const rows = values ?? [];
  const idx = rows.findIndex((row) => (row[0] ?? "").toString().trim() === bookingId);
  if (idx === -1) {
    throw new Error("ไม่พบรายการจองนี้ — อาจถูกยกเลิกไปแล้ว");
  }
  const current = rowToBooking(rows[idx]);
  if (current.resourceType !== "car") {
    throw new Error("การจองนี้ไม่ต้องรอจัดรถ");
  }
  if (current.approvalStatus !== "pending") {
    throw new Error("รายการจองนี้ถูกพิจารณาไปแล้ว");
  }
  const merged: Booking = {
    ...current,
    approvalStatus: "rejected",
    approvedAt: new Date().toISOString(),
    approvedByUsername: rejectedByUsername,
  };
  const sheetRow = idx + 2;

  try {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${tab}!A${sheetRow}:AA${sheetRow}`,
      // RAW — see the note on createBooking's append() above.
      valueInputOption: "RAW",
      requestBody: { values: [bookingToRow(merged)] },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`บันทึกผลการปฏิเสธคำขอไม่สำเร็จ: ${message}`);
  }

  return merged;
}

/** Lets management/superadmin correct a narrow, fixed set of fields on an
 * *existing* booking — purpose/destination/participants/contactPhone/
 * companions only. This is the one deliberate exception to "the original
 * request is never edited" (see canApproveCarBooking's doc comment in
 * lib/booking.ts): the hospital explicitly asked for it, so every edit here
 * always stamps editedByUsername/editedAt, which the UI shows as "แก้ไขโดย
 * ฝ่ายบริหาร" on the booking — it's a correction, never a silent rewrite.
 *
 * Deliberately does NOT accept bookedByUsername/department/resourceId/
 * resourceType/resourceName/startTime/endTime/approvalStatus — who asked,
 * for which resource, and when, stay exactly as submitted; reassigning the
 * actual car/driver/time is TripOrder's job (createTripOrder/
 * updateTripOrder below), not this function's. Allowed on a booking in any
 * approvalStatus (a typo might need fixing after approval too) except a
 * cancelled one — find-by-id scan, same reasoning as cancelBooking. The
 * permission check itself (canApproveCarBooking) is the API route's job,
 * not this function's, same split as cancelBooking/canCancelBooking. */
export async function editBookingByManagement(
  bookingId: string,
  edits: {
    purpose?: string;
    destination?: string;
    participants?: number;
    contactPhone?: string;
    companions?: string;
  },
  editedByUsername: string
): Promise<Booking> {
  const spreadsheetId = getEnv("GOOGLE_SHEET_ID");
  const tab = getBookingsTab();
  const sheets = google.sheets({ version: "v4", auth: sheetsAuth() });

  let values: string[][] | undefined;
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${tab}!A2:AA100000`,
    });
    values = res.data.values as string[][] | undefined;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`อ่านรายการจองไม่สำเร็จ: ${message}`);
  }

  const rows = values ?? [];
  const idx = rows.findIndex((row) => (row[0] ?? "").toString().trim() === bookingId);
  if (idx === -1) {
    throw new Error("ไม่พบรายการจองนี้ — อาจถูกยกเลิกไปแล้ว");
  }
  const current = rowToBooking(rows[idx]);
  // Scoped to car bookings only — this whole capability exists for the car
  // review/dispatch workflow (gated by canApproveCarBooking, same as
  // rejectCarBooking/createTripOrder); a room booking has no review step
  // and was never part of this request.
  if (current.resourceType !== "car") {
    throw new Error("แก้ไขข้อมูลตรงนี้ได้เฉพาะการจองรถเท่านั้น");
  }
  if (isBookingCancelled(current)) {
    throw new Error("รายการจองนี้ถูกยกเลิกไปแล้ว แก้ไขไม่ได้");
  }

  const merged: Booking = {
    ...current,
    purpose: edits.purpose ?? current.purpose,
    destination: edits.destination ?? current.destination,
    participants: edits.participants ?? current.participants,
    contactPhone: edits.contactPhone ?? current.contactPhone,
    companions: edits.companions ?? current.companions,
    editedByUsername,
    editedAt: new Date().toISOString(),
  };
  const sheetRow = idx + 2;

  try {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${tab}!A${sheetRow}:AA${sheetRow}`,
      // RAW — see the note on createBooking's append() above.
      valueInputOption: "RAW",
      requestBody: { values: [bookingToRow(merged)] },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`บันทึกการแก้ไขไม่สำเร็จ: ${message}`);
  }

  return merged;
}

// ---------------------------------------------------------------------------
// TripOrders tab — the dispatch/merge record for car bookings (see
// TripOrder's doc comment in lib/booking.ts for why this exists as its own
// tab rather than editing Bookings rows directly). Same manually-created-tab
// convention as every other tab here — the sheet owner creates it by hand
// before the first dispatch can be issued. Header row:
// TripOrderId | ResourceId | ResourceName | DriverName | StartTime | EndTime
// | Notes | BookingIds | CreatedByUsername | CreatedAt
// BookingIds is a comma-separated list of Bookings-tab BookingId values,
// same encoding as Users' ExtraPermissions/RevokedPermissions columns.
// ---------------------------------------------------------------------------

const TRIP_ORDERS_HEADER_ROW = [
  "TripOrderId", "ResourceId", "ResourceName", "DriverName", "StartTime", "EndTime",
  "Notes", "BookingIds", "CreatedByUsername", "CreatedAt",
];

function getTripOrdersTab(): string {
  return process.env.GOOGLE_SHEET_TRIP_ORDERS_TAB?.trim() || "TripOrders";
}

function rowToTripOrder(row: string[]): TripOrder {
  const col = (i: number) => (row[i] ?? "").toString();
  return {
    tripOrderId: col(0).trim(),
    resourceId: col(1),
    resourceName: col(2),
    driverName: col(3),
    startTime: col(4),
    endTime: col(5),
    notes: col(6),
    bookingIds: col(7)
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== ""),
    createdByUsername: col(8),
    createdAt: col(9),
  };
}

function tripOrderToRow(t: TripOrder): (string | number)[] {
  return [
    t.tripOrderId, t.resourceId, t.resourceName, t.driverName, t.startTime, t.endTime,
    t.notes, t.bookingIds.join(","), t.createdByUsername, t.createdAt,
  ];
}

/** Every dispatch record ever issued — callers join against
 * Booking.tripOrderId themselves (see BookingDashboard), same "read
 * everything, filter/join client-side" shape as getBookings and
 * getBookingResources. Empty array (not an error) if the tab doesn't exist
 * yet — no car booking has ever been dispatched. */
export async function getTripOrders(): Promise<TripOrder[]> {
  const spreadsheetId = getEnv("GOOGLE_SHEET_ID");
  const tab = getTripOrdersTab();
  const sheets = google.sheets({ version: "v4", auth: sheetsAuth() });

  let values: string[][] | undefined;
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${tab}!A2:J100000`,
    });
    values = res.data.values as string[][] | undefined;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("Unable to parse range")) {
      return [];
    }
    throw new Error(`อ่านรายการใบสั่งงานไม่สำเร็จ: ${message}`);
  }

  return (values ?? [])
    .filter((row) => (row[0] ?? "").toString().trim() !== "")
    .map(rowToTripOrder);
}

/** วันที่ (YYYY-MM-DD) ตามเขตเวลา Asia/Bangkok ของ Date ที่ให้มา — เซิร์ฟเวอร์
 * (Vercel) รันเป็น UTC แต่ startTime/endTime ของคำขอจองเก็บเป็นเวลาท้องถิ่น
 * กรุงเทพฯ ตรงๆ (ดู splitBookingDateTime/bookingDateTimeToMillis ใน
 * lib/booking.ts) ใช้เทียบ "วันนี้"/ช่วงวันข้างหน้าให้ตรงเขตเวลาเดียวกัน
 * ไม่งั้นช่วงหัวค่ำ/ดึกจะเลื่อนวันผิดไป 1 วันเมื่อรันบนเซิร์ฟเวอร์ UTC — ใช้
 * locale "en-CA" เพราะให้ผลลัพธ์เป็น YYYY-MM-DD ตรงตัว เทียบ string ต่อได้เลย
 * เหมือน dateKey อื่นๆ ในระบบนี้ */
function bangkokDateKey(date: Date): string {
  return date.toLocaleDateString("en-CA", { timeZone: "Asia/Bangkok" });
}

/** คำขอย่อยหนึ่งรายการที่ครอบคลุมอยู่ในเที่ยวรถเดียวกัน — เฉพาะฟิลด์ที่จำเป็น
 * ต่องานขับรถจริงๆ ดูคอมเมนต์เต็มที่ getDriverTrips ด้านล่างว่าทำไมตัดฟิลด์
 * อื่นออก (โดยเฉพาะเบอร์โทรผู้จอง) */
export interface DriverTripRequestSummary {
  department: string;
  purpose: string;
  destination: string;
  participants: number;
  startTime: string;
  endTime: string;
  cancelled: boolean;
}

/** เที่ยวรถหนึ่งเที่ยว (ใบสั่งงานเดินทางหนึ่งใบ) รูปแบบย่อสำหรับหน้าปฏิทินงาน
 * คนขับสาธารณะ — ดู getDriverTrips ด้านล่าง */
export interface DriverTripSummary {
  tripOrderId: string;
  resourceName: string;
  driverName: string;
  startTime: string;
  endTime: string;
  totalParticipants: number;
  requests: DriverTripRequestSummary[];
}

/**
 * ข้อมูลสำหรับหน้า /driver (ปฏิทินงานคนขับ) — สาธารณะ ไม่ต้องล็อกอิน ตามที่
 * ออกแบบไว้ใน docs/line-driver-notify-plan.md เรียกทั้งจาก page.tsx ของ
 * /driver เอง (server component, render ครั้งแรก) และจาก
 * GET /api/public/driver-trips (client-side refresh เป็นระยะ) — รวม logic
 * กรอง/แปลงข้อมูลไว้ที่นี่ที่เดียว กันโค้ดสองจุดเพี้ยนไปจากกัน
 *
 * เห็นเฉพาะเที่ยวรถที่ "จ่ายรถแล้ว" เท่านั้น (มีใบสั่งงานคุมอยู่จริง) — คำขอที่
 * ยังรออนุมัติยังไม่ใช่งานจริงของคนขับ จึงไม่แสดง ตัดฟิลด์ที่ไม่จำเป็นต่องาน
 * ขับรถออกทั้งหมด โดยเฉพาะเบอร์โทร/ชื่อผู้จอง (ข้อมูลส่วนบุคคล ไม่จำเป็นต้อง
 * เผยแพร่แบบไม่ล็อกอิน — ถ้าคนขับต้องติดต่อผู้จองให้ประสานผ่านฝ่ายบริหารแทน)
 * เหลือแค่กลุ่มงาน/วัตถุประสงค์/ปลายทาง/จำนวนคน
 *
 * จำกัดช่วงเวลาวันนี้ถึง +lookaheadDays วัน (ตามเขตเวลา Asia/Bangkok — ดู
 * bangkokDateKey ด้านบน) กันข้อมูลย้อนหลังทั้งหมดถูกดึงออกไปโดยไม่จำเป็น —
 * เรียงจากเวลาออกเดินทางเร็วสุดไปช้าสุด
 */
export async function getDriverTrips(lookaheadDays: number = 14): Promise<DriverTripSummary[]> {
  const [bookings, tripOrders] = await Promise.all([getBookings(), getTripOrders()]);
  const todayKey = bangkokDateKey(new Date());
  const endKey = bangkokDateKey(new Date(Date.now() + lookaheadDays * 24 * 60 * 60 * 1000));
  const bookingById = new Map(bookings.map((b) => [b.bookingId, b]));

  const trips: DriverTripSummary[] = [];
  for (const trip of tripOrders) {
    const dateKey = splitBookingDateTime(trip.startTime)?.dateKey;
    if (!dateKey || dateKey < todayKey || dateKey > endKey) continue;

    const covered = trip.bookingIds
      .map((id) => bookingById.get(id))
      .filter((b): b is Booking => !!b && b.resourceType === "car");
    if (covered.length === 0) continue;
    // ทุกคำขอที่ครอบคลุมถูกยกเลิกหมดแล้ว — ไม่มีเที่ยวจริงเหลือให้คนขับไปแล้ว
    if (covered.every((b) => isBookingCancelled(b))) continue;

    const totalParticipants = covered
      .filter((b) => !isBookingCancelled(b))
      .reduce((sum, b) => sum + b.participants, 0);

    trips.push({
      tripOrderId: trip.tripOrderId,
      resourceName: trip.resourceName,
      driverName: trip.driverName,
      startTime: trip.startTime,
      endTime: trip.endTime,
      totalParticipants,
      requests: covered.map((b) => ({
        department: b.department || b.bookedByDisplayName || b.bookedByUsername,
        purpose: b.purpose,
        destination: b.destination,
        participants: b.participants,
        startTime: b.startTime,
        endTime: b.endTime,
        cancelled: isBookingCancelled(b),
      })),
    });
  }

  trips.sort((a, b) => a.startTime.localeCompare(b.startTime));
  return trips;
}

/** Dispatches one or more *pending* car bookings at once — appends the
 * TripOrder row, then flips every covered booking to "approved" and points
 * its tripOrderId at the new record, in a single batchUpdate (one API call
 * for N rows, not N separate calls — this app has been burned before by
 * unbatched per-row Sheets writes piling up quota usage, see proxy.ts/
 * sheets.ts's global timeout comment). This *is* the "combine several
 * requests into one trip" feature: pass every bookingId that should share
 * this car/driver/time and they're merged by construction — there is no
 * separate merge step.
 *
 * Every covered booking is re-validated against the *current* Bookings tab
 * (never trust a caller's stale list) before anything is written: it must
 * exist, be a car booking, not be cancelled, and still be "pending" — if
 * any one of them fails that, the whole call throws before writing
 * anything, rather than partially dispatching some and silently skipping
 * others. The TripOrders row is written before the booking rows are
 * updated: if the batchUpdate that follows fails partway (Sheets isn't
 * transactional), every booking that *did* get updated already points at a
 * TripOrder that genuinely exists — never a dangling reference. */
export async function createTripOrder(input: {
  resourceId: string;
  resourceName: string;
  driverName: string;
  startTime: string;
  endTime: string;
  notes: string;
  bookingIds: string[];
  createdByUsername: string;
}): Promise<{ tripOrder: TripOrder; bookings: Booking[] }> {
  if (input.bookingIds.length === 0) {
    throw new Error("กรุณาเลือกรายการจองที่จะออกใบสั่งงานอย่างน้อย 1 รายการ");
  }

  const spreadsheetId = getEnv("GOOGLE_SHEET_ID");
  const bookingsTab = getBookingsTab();
  const tripOrdersTab = getTripOrdersTab();
  const sheets = google.sheets({ version: "v4", auth: sheetsAuth() });

  let values: string[][] | undefined;
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${bookingsTab}!A2:AA100000`,
    });
    values = res.data.values as string[][] | undefined;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`อ่านรายการจองไม่สำเร็จ: ${message}`);
  }
  const rows = values ?? [];

  // Locate + validate every covered booking up front — see the doc comment
  // above for why nothing gets written until every one of them checks out.
  const targets: { rowIndex: number; booking: Booking }[] = [];
  for (const bookingId of input.bookingIds) {
    const idx = rows.findIndex((row) => (row[0] ?? "").toString().trim() === bookingId);
    if (idx === -1) {
      throw new Error(`ไม่พบรายการจอง (${bookingId}) — อาจถูกยกเลิกไปแล้ว`);
    }
    const booking = rowToBooking(rows[idx]);
    if (booking.resourceType !== "car") {
      throw new Error(`${booking.resourceName}: ไม่ใช่การจองรถ ออกใบสั่งงานไม่ได้`);
    }
    if (isBookingCancelled(booking)) {
      throw new Error(`${booking.resourceName} (${formatBookingDateTime(booking.startTime)}): ถูกยกเลิกไปแล้ว`);
    }
    if (booking.approvalStatus !== "pending") {
      throw new Error(`${booking.resourceName} (${formatBookingDateTime(booking.startTime)}): ถูกพิจารณาไปแล้ว`);
    }
    targets.push({ rowIndex: idx, booking });
  }

  const tripOrder: TripOrder = {
    tripOrderId: randomUUID(),
    resourceId: input.resourceId,
    resourceName: input.resourceName,
    driverName: input.driverName,
    startTime: input.startTime,
    endTime: input.endTime,
    notes: input.notes,
    bookingIds: input.bookingIds,
    createdByUsername: input.createdByUsername,
    createdAt: new Date().toISOString(),
  };

  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${tripOrdersTab}!A1`,
      // RAW — see the note on createBooking's append() above.
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [tripOrderToRow(tripOrder)] },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("Unable to parse range")) {
      throw new Error(
        `ยังไม่พบแท็บชื่อ "${tripOrdersTab}" ในสเปรดชีต — สร้างแท็บนี้ก่อน (หัวตาราง: ${TRIP_ORDERS_HEADER_ROW.join(" | ")}) หรือตั้งค่า GOOGLE_SHEET_TRIP_ORDERS_TAB ให้ตรงกับชื่อแท็บจริง`
      );
    }
    throw new Error(`บันทึกใบสั่งงานไม่สำเร็จ: ${message}`);
  }

  const updatedBookings: Booking[] = targets.map(({ booking }) => ({
    ...booking,
    approvalStatus: "approved",
    approvedAt: tripOrder.createdAt,
    approvedByUsername: input.createdByUsername,
    tripOrderId: tripOrder.tripOrderId,
    // รถ/คนขับถูกจัดแล้ว — เข้าคิวรอ ผอ. รับทราบ (ดู DirectorApprovalStatus ใน
    // lib/booking.ts) เฉพาะการจองรถเท่านั้น (ฟังก์ชันนี้คัดแต่ resourceType
    // "car" ไว้แล้วที่ด้านบน) — ไม่กระทบ approvalStatus/TripOrder เดิมเลย.
    directorApprovalStatus: "pending",
    directorApprovedAt: "",
    // ถ้าคำขอนี้เคยถูก ผอ. "ตีกลับ" มาก่อน (ดู returnTripToDispatch
    // ด้านล่าง) ตอนนี้ถูกจัดรถใหม่แล้ว — ล้างข้อความ/เวลาตีกลับเดิมทิ้ง ไม่ให้
    // แบนเนอร์ "ผอ. ตีกลับ" ค้างอยู่ในหน้าจองรถเกินกว่าใบสั่งงานที่มันพูดถึง.
    directorNote: "",
    directorReturnedAt: "",
  }));

  try {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: {
        valueInputOption: "RAW",
        data: targets.map(({ rowIndex }, i) => ({
          range: `${bookingsTab}!A${rowIndex + 2}:AA${rowIndex + 2}`,
          values: [bookingToRow(updatedBookings[i])],
        })),
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    // The TripOrder row above already exists at this point — see the doc
    // comment's note on write order — so this is never a dangling
    // reference, just an incomplete one that needs a retry.
    throw new Error(
      `บันทึกใบสั่งงานสำเร็จ แต่ปรับสถานะการจองที่เกี่ยวข้องไม่สำเร็จ (${message}) — กรุณาตรวจสอบรายการจองและลองออกใบสั่งงานอีกครั้งหากยังค้างอยู่`
    );
  }

  return { tripOrder, bookings: updatedBookings };
}

/** Edits an already-issued TripOrder's own car/driver/time/notes — "แก้ไข
 * ข้อมูลเท่าที่จำเป็น" for management, per the hospital's explicit later
 * request (e.g. the assigned driver calls in sick and someone else takes
 * the trip, or the pickup time slips by half an hour). Never touches the
 * Bookings rows this TripOrder already covers: they already point at this
 * tripOrderId and stay "approved" throughout, exactly as before the edit.
 * Find-by-id scan, same reasoning as every other single-row lookup in this
 * file.
 *
 * `addBookingIds` — a later, explicit addition per the hospital's request:
 * "เผื่อในกรณีอนุมัติไปแล้ว แต่มีกลุ่มที่ต้องการเดินทางไปด้วยจะได้สามารถ
 * แก้ไขและเพิ่มรายการใหม่เข้าไปได้" (a car's already been dispatched, but
 * another group wants to ride along too — let management add them in
 * rather than issuing a whole separate TripOrder for the same trip). Only
 * ever *adds* — there is still no way to remove a booking this TripOrder
 * already covers, or to move it to a different TripOrder, from here; that
 * stays a "re-triage" outside this function's scope, same as before. Every
 * added booking is re-validated against the *current* Bookings tab (never
 * trust a caller's stale list) exactly like createTripOrder does: it must
 * exist, be a car booking, not be cancelled, and still be "pending" — if
 * any one of them fails that, nothing is written at all (not even the
 * TripOrder's own field edits), so a bad add never silently drops just the
 * one bad row while the rest go through half-applied. IDs already covered
 * (or repeated in the same call) are silently ignored rather than erroring
 * — see addBookingIds' own filtering below. The TripOrder row (already
 * carrying the expanded bookingIds list) is written before the newly-added
 * bookings' own rows are flipped to "approved" — same "never a dangling
 * TripOrder reference, only ever a booking that hasn't caught up yet"
 * tradeoff as createTripOrder's own write order, for the same reason. */
export async function updateTripOrder(
  tripOrderId: string,
  updates: {
    resourceId?: string;
    resourceName?: string;
    driverName?: string;
    startTime?: string;
    endTime?: string;
    notes?: string;
    addBookingIds?: string[];
  },
  actorUsername: string
): Promise<{ tripOrder: TripOrder; addedBookings: Booking[] }> {
  const spreadsheetId = getEnv("GOOGLE_SHEET_ID");
  const tripOrdersTab = getTripOrdersTab();
  const bookingsTab = getBookingsTab();
  const sheets = google.sheets({ version: "v4", auth: sheetsAuth() });

  let tripValues: string[][] | undefined;
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${tripOrdersTab}!A2:J100000`,
    });
    tripValues = res.data.values as string[][] | undefined;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`อ่านรายการใบสั่งงานไม่สำเร็จ: ${message}`);
  }

  const tripRows = tripValues ?? [];
  const tripIdx = tripRows.findIndex((row) => (row[0] ?? "").toString().trim() === tripOrderId);
  if (tripIdx === -1) {
    throw new Error("ไม่พบใบสั่งงานนี้");
  }
  const current = rowToTripOrder(tripRows[tripIdx]);

  // ตัดรายการที่ครอบคลุมอยู่แล้ว (หรือซ้ำกันเองในคำขอเดียวกัน) ออกก่อนเสมอ —
  // ไม่ถือเป็นข้อผิดพลาด แค่ไม่มีอะไรต้องทำเพิ่มสำหรับรายการนั้น
  const addBookingIds = Array.from(new Set(updates.addBookingIds ?? [])).filter(
    (id) => !current.bookingIds.includes(id)
  );

  const bookingTargets: { rowIndex: number; booking: Booking }[] = [];
  if (addBookingIds.length > 0) {
    let bookingValues: string[][] | undefined;
    try {
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${bookingsTab}!A2:AA100000`,
      });
      bookingValues = res.data.values as string[][] | undefined;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`อ่านรายการจองไม่สำเร็จ: ${message}`);
    }
    const bookingRows = bookingValues ?? [];

    for (const bookingId of addBookingIds) {
      const idx = bookingRows.findIndex((row) => (row[0] ?? "").toString().trim() === bookingId);
      if (idx === -1) {
        throw new Error(`ไม่พบรายการจอง (${bookingId}) — อาจถูกยกเลิกไปแล้ว`);
      }
      const booking = rowToBooking(bookingRows[idx]);
      if (booking.resourceType !== "car") {
        throw new Error(`${booking.resourceName}: ไม่ใช่การจองรถ เพิ่มเข้าใบสั่งงานนี้ไม่ได้`);
      }
      if (isBookingCancelled(booking)) {
        throw new Error(`${booking.resourceName} (${formatBookingDateTime(booking.startTime)}): ถูกยกเลิกไปแล้ว`);
      }
      if (booking.approvalStatus !== "pending") {
        throw new Error(`${booking.resourceName} (${formatBookingDateTime(booking.startTime)}): ถูกพิจารณาไปแล้ว`);
      }
      bookingTargets.push({ rowIndex: idx, booking });
    }
  }

  const merged: TripOrder = {
    ...current,
    resourceId: updates.resourceId ?? current.resourceId,
    resourceName: updates.resourceName ?? current.resourceName,
    driverName: updates.driverName ?? current.driverName,
    startTime: updates.startTime ?? current.startTime,
    endTime: updates.endTime ?? current.endTime,
    notes: updates.notes ?? current.notes,
    bookingIds: bookingTargets.length > 0 ? [...current.bookingIds, ...addBookingIds] : current.bookingIds,
  };
  const sheetRow = tripIdx + 2;

  try {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${tripOrdersTab}!A${sheetRow}:J${sheetRow}`,
      // RAW — see the note on createBooking's append() above.
      valueInputOption: "RAW",
      requestBody: { values: [tripOrderToRow(merged)] },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`บันทึกการแก้ไขใบสั่งงานไม่สำเร็จ: ${message}`);
  }

  let addedBookings: Booking[] = [];
  if (bookingTargets.length > 0) {
    const approvedAt = new Date().toISOString();
    addedBookings = bookingTargets.map(({ booking }) => ({
      ...booking,
      approvalStatus: "approved",
      approvedAt,
      approvedByUsername: actorUsername,
      tripOrderId: merged.tripOrderId,
      // เพิ่มเข้าใบสั่งงานที่จัดรถ/คนขับแล้ว — เข้าคิวรอ ผอ. อนุมัติเหมือนกับ
      // createTripOrder ด้านบน. ล้างข้อความ/เวลาตีกลับเดิม (ถ้ามี) ด้วยเหตุผล
      // เดียวกับที่ createTripOrder ทำ.
      directorApprovalStatus: "pending",
      directorApprovedAt: "",
      directorNote: "",
      directorReturnedAt: "",
    }));
    try {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: {
          valueInputOption: "RAW",
          data: bookingTargets.map(({ rowIndex }, i) => ({
            range: `${bookingsTab}!A${rowIndex + 2}:AA${rowIndex + 2}`,
            values: [bookingToRow(addedBookings[i])],
          })),
        },
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      // TripOrder row above already carries the expanded bookingIds — see
      // this function's doc comment for why that's never a dangling
      // reference, just an incomplete one that needs a retry.
      throw new Error(
        `บันทึกการแก้ไขใบสั่งงานสำเร็จ แต่ปรับสถานะคำขอที่เพิ่มเข้ามาไม่สำเร็จ (${message}) — กรุณาตรวจสอบรายการจองและลองใหม่หากยังค้างอยู่`
      );
    }
  }

  return { tripOrder: merged, addedBookings };
}

/**
 * แยกคำขอจองรถหนึ่งรายการออกจากใบสั่งงานเดินทางที่ครอบคลุมอยู่ (ตามที่ขอเพิ่ม
 * ภายหลัง — "อยากให้สามารถแยกรายการการเดินทางที่อนุมัติไปแล้วได้") — ตรงข้ามกับ
 * addBookingIds ของ updateTripOrder ด้านบนซึ่งมีแต่ทางเพิ่มเข้าอย่างเดียว
 * ฟังก์ชันนี้คือทางเดียวที่เอาออกได้ ก่อนหน้านี้ไม่มีอยู่เลย (ดูคอมเมนต์ที่
 * updateTripOrder เดิมว่า "re-triage ไม่รองรับ")
 *
 * คำขอที่ถูกแยกออกจะกลับไปเป็น "รออนุมัติ" ตั้งแต่ต้น — resourceId/
 * resourceName กลับไปเป็นค่า placeholder เดียวกับตอนสร้างใหม่ (ดู
 * PENDING_CAR_RESOURCE_NAME) และ tripOrderId/approvedAt/approvedByUsername
 * ถูกล้างทั้งหมด เพื่อให้ฝ่ายบริหารต้องออกใบสั่งงานแยกให้ใหม่อีกครั้ง แทนที่จะ
 * ค้างอยู่ในสถานะ "อนุญาต" ทั้งที่ไม่มีใบสั่งงานรองรับแล้ว — ฟิลด์อื่นๆ ของคำขอ
 * เดิม (วัตถุประสงค์ ปลายทาง ผู้ร่วมเดินทาง ผู้จอง แผนก ฯลฯ) ไม่ถูกแตะเลย ตาม
 * หลักการเดียวกับ createTripOrder/updateTripOrder ที่ไม่แก้ข้อมูลคำขอเดิม
 *
 * ใบสั่งงานต้องครอบคลุมคำขอนี้อยู่จริง และต้องมีคำขออื่นเหลืออยู่อย่างน้อย 1
 * รายการหลังแยกออก (แยกจนว่างเปล่าไม่ได้ — ยกเลิกใบสั่งงานทั้งใบแทนถ้าต้องการ
 * เอาออกทั้งหมด ซึ่งยังไม่มีฟังก์ชันรองรับในระบบนี้เช่นกัน)
 *
 * เขียนใบสั่งงาน (bookingIds ที่ตัดออกแล้ว) ก่อนเสมอ แล้วค่อยเขียนแถวคำขอที่
 * ถูกแยก — เหตุผลเดียวกับลำดับการเขียนใน createTripOrder ด้านบน (ถ้าขั้นที่สอง
 * ล้มเหลว คำขอยังค้างอยู่ในใบสั่งงานเดิมแบบไม่ต้อง rollback อะไร แค่ retry
 * ฟังก์ชันนี้ใหม่อีกครั้ง)
 */
export async function splitBookingFromTripOrder(
  tripOrderId: string,
  bookingId: string,
  actorUsername: string
): Promise<{ tripOrder: TripOrder; booking: Booking }> {
  const spreadsheetId = getEnv("GOOGLE_SHEET_ID");
  const tripOrdersTab = getTripOrdersTab();
  const bookingsTab = getBookingsTab();
  const sheets = google.sheets({ version: "v4", auth: sheetsAuth() });

  let tripValues: string[][] | undefined;
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${tripOrdersTab}!A2:J100000`,
    });
    tripValues = res.data.values as string[][] | undefined;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`อ่านรายการใบสั่งงานไม่สำเร็จ: ${message}`);
  }
  const tripRows = tripValues ?? [];
  const tripIdx = tripRows.findIndex((row) => (row[0] ?? "").toString().trim() === tripOrderId);
  if (tripIdx === -1) {
    throw new Error("ไม่พบใบสั่งงานนี้");
  }
  const current = rowToTripOrder(tripRows[tripIdx]);
  if (!current.bookingIds.includes(bookingId)) {
    throw new Error("ใบสั่งงานนี้ไม่ได้ครอบคลุมคำขอจองนี้ — อาจถูกแยกออกไปแล้วก่อนหน้านี้");
  }
  if (current.bookingIds.length <= 1) {
    throw new Error("ใบสั่งงานนี้มีคำขอจองเพียงรายการเดียว ไม่สามารถแยกออกได้");
  }

  let bookingValues: string[][] | undefined;
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${bookingsTab}!A2:AA100000`,
    });
    bookingValues = res.data.values as string[][] | undefined;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`อ่านรายการจองไม่สำเร็จ: ${message}`);
  }
  const bookingRows = bookingValues ?? [];
  const bookingIdx = bookingRows.findIndex((row) => (row[0] ?? "").toString().trim() === bookingId);
  if (bookingIdx === -1) {
    throw new Error("ไม่พบรายการจองนี้ — อาจถูกยกเลิกไปแล้ว");
  }
  const booking = rowToBooking(bookingRows[bookingIdx]);
  if (isBookingCancelled(booking)) {
    throw new Error(`${booking.resourceName}: ถูกยกเลิกไปแล้ว ไม่ต้องแยกออกอีก`);
  }

  const updatedTripOrder: TripOrder = {
    ...current,
    bookingIds: current.bookingIds.filter((id) => id !== bookingId),
  };
  const editedAt = new Date().toISOString();
  const updatedBooking: Booking = {
    ...booking,
    resourceId: "",
    resourceName: PENDING_CAR_RESOURCE_NAME,
    approvalStatus: "pending",
    approvedAt: "",
    approvedByUsername: "",
    tripOrderId: "",
    editedByUsername: actorUsername,
    editedAt,
    // แยกออกจากใบสั่งงานแล้ว — ไม่มีการจัดรถ/คนขับรองรับอีกต่อไป จึงไม่มีอะไร
    // ให้ ผอ. อนุมัติแล้ว กลับไปเป็น "" เหมือนคำขอที่สร้างใหม่ (เช่นเดียวกับ
    // directorNote/directorReturnedAt — กันไว้เผื่อค้างจากครั้งก่อน).
    directorApprovalStatus: "",
    directorApprovedAt: "",
    directorNote: "",
    directorReturnedAt: "",
  };

  const tripSheetRow = tripIdx + 2;
  try {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${tripOrdersTab}!A${tripSheetRow}:J${tripSheetRow}`,
      // RAW — see the note on createBooking's append() above.
      valueInputOption: "RAW",
      requestBody: { values: [tripOrderToRow(updatedTripOrder)] },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`บันทึกการแยกรายการออกจากใบสั่งงานไม่สำเร็จ: ${message}`);
  }

  const bookingSheetRow = bookingIdx + 2;
  try {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${bookingsTab}!A${bookingSheetRow}:AA${bookingSheetRow}`,
      valueInputOption: "RAW",
      requestBody: { values: [bookingToRow(updatedBooking)] },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    // ใบสั่งงานด้านบนถูกตัดรายการนี้ออกไปเรียบร้อยแล้ว — คำขอนี้จึงไม่มีใบ
    // สั่งงานรองรับอีกต่อไปไม่ว่าขั้นนี้จะสำเร็จหรือไม่ แค่สถานะยังค้างเป็น
    // "อนุญาต" ผิดพลาดอยู่ ต้องลองใหม่ให้ครบ (ไม่ใช่ dangling reference แบบที่
    // อาจเข้าใจผิดได้ — เป็นคำขอที่ "หลุด" ออกจากใบสั่งงานแล้วแต่สถานะยังไม่
    // อัปเดตตามแค่นั้น)
    throw new Error(
      `แยกรายการออกจากใบสั่งงานสำเร็จ แต่ปรับสถานะคำขอที่แยกออกกลับเป็น "รอจัดรถ" ไม่สำเร็จ (${message}) — กรุณาตรวจสอบรายการจองและลองใหม่หากยังค้างอยู่`
    );
  }

  return { tripOrder: updatedTripOrder, booking: updatedBooking };
}

/**
 * หน้า /director (ดู src/app/director/page.tsx) — รายการจองรถที่ "รอ ผอ.
 * อนุมัติ" (directorApprovalStatus === "pending") พร้อมข้อมูลรถ/คนขับ/ช่วงเวลา
 * ที่จัดไว้แล้วจาก TripOrder ที่ครอบคลุม — คัดมาเฉพาะเท่าที่ ผอ. ต้องเห็นจริงๆ
 * (ตามที่ขอ "ไม่มีรายละเอียดเยอะเกินความจำเป็น") ไม่ใช่ Booking/TripOrder เต็ม
 * รูปแบบ. อ่าน getBookings + getTripOrders + getBookingResources ตรงๆ แทนการ
 * เพิ่ม range พิเศษ — ทั้งสามฟังก์ชันนี้ก็ต้องอ่านทั้งแท็บอยู่แล้วเหมือนกัน (ไม่มี
 * caching ในชั้นนี้ของแอป ดูคอมเมนต์ที่ cachedAuth ด้านบนว่าแคชแค่ตัว auth
 * client เท่านั้น) จึงไม่ได้แพงขึ้นกว่าการเรียก 3 ครั้งตรงๆ แบบนี้.
 *
 * จัดกลุ่มตาม tripOrderId เป็นรายการเดียวต่อหนึ่งใบสั่งงาน (ตามที่ขอ "ให้สอง
 * คำขอนี้เดินทางไปด้วยกันรถคันเดียวกันให้รวมรายการคำขอเป็นรายการเดียวให้อนุมัติ
 * ครั้งเดียวพร้อมกัน") — requests ด้านในคือคำขอ(หลาย)รายการที่ TripOrder นี้
 * ครอบคลุม ส่วนรถ/คนขับ/ช่วงเวลาเป็นของ TripOrder เดียวที่ใช้ร่วมกันทั้งกลุ่ม. */
export interface DirectorTripRequestItem {
  bookingId: string;
  purpose: string;
  destination: string;
  participants: number;
  bookedByDisplayName: string;
  department: string;
  companions: string;
}

export interface DirectorTripItem {
  tripOrderId: string;
  startTime: string;
  endTime: string;
  resourceName: string;
  /** "" เมื่อไม่พบรูปของรถคันนี้ (ยังไม่เคยอัปโหลด หรือจับคู่ชื่อไม่ได้ — ดู
   * คอมเมนต์ที่ match ด้านล่าง) — ฝั่ง UI แสดงไอคอนรถเปล่าแทนในกรณีนี้. */
  resourceImageDataUrl: string;
  driverName: string;
  requests: DirectorTripRequestItem[];
}

export async function getDirectorPendingTrips(): Promise<DirectorTripItem[]> {
  const [bookings, tripOrders, resources] = await Promise.all([
    getBookings(),
    getTripOrders(),
    getBookingResources(),
  ]);
  const tripOrderById = new Map(tripOrders.map((t) => [t.tripOrderId, t]));
  // จับคู่รูปรถด้วยชื่อ — TripOrder เก็บแค่ resourceName มาตั้งแต่แรก (snapshot
  // ตอนจ่ายรถ ดูคอมเมนต์ TripOrder.resourceName ใน lib/booking.ts) ไม่มี
  // resourceId เก็บไว้ให้ join ตรงๆ ชื่อซ้ำกัน (เช่นรถถูกลบแล้วสร้างใหม่ชื่อเดิม)
  // จะได้รูปของตัวที่ query เจอก่อน — ยอมรับได้เพราะเป็นแค่รูปประกอบการพิจารณา
  // ไม่ใช่ข้อมูลที่ผลต่อการอนุมัติ.
  const resourceByName = new Map(resources.map((r) => [r.name, r]));

  const groups = new Map<string, DirectorTripItem>();
  for (const b of bookings) {
    if (b.directorApprovalStatus !== "pending" || isBookingCancelled(b)) continue;
    const trip = tripOrderById.get(b.tripOrderId);
    let group = groups.get(b.tripOrderId);
    if (!group) {
      const resourceName = trip?.resourceName || b.resourceName;
      group = {
        tripOrderId: b.tripOrderId,
        startTime: trip?.startTime || b.startTime,
        endTime: trip?.endTime || b.endTime,
        resourceName,
        resourceImageDataUrl: resourceByName.get(resourceName)?.imageDataUrl || "",
        driverName: trip?.driverName || "",
        requests: [],
      };
      groups.set(b.tripOrderId, group);
    }
    group.requests.push({
      bookingId: b.bookingId,
      purpose: b.purpose,
      destination: b.destination,
      participants: b.participants,
      bookedByDisplayName: b.bookedByDisplayName,
      department: b.department,
      companions: b.companions,
    });
  }

  return Array.from(groups.values()).sort((a, b) => a.startTime.localeCompare(b.startTime));
}

/** ผอ. กดอนุมัติ/ไม่อนุมัติ — ทีละรายการหรือหลายรายการพร้อมกันก็ได้ (ตามที่
 * ขอ "คลิ๊กไม่กี่คลิ๊กสามารถอนุมัติรายการเดินทางหลายรายการได้ในครั้งเดียว", และ
 * ทุกคำขอที่รวมอยู่ในใบสั่งงานเดียวกันถูกส่งมาพร้อมกันเป็นก้อนเดียวจาก
 * DirectorDashboard เพื่อ "อนุมัติครั้งเดียวพร้อมกัน" — ดู getDirectorPendingTrips
 * ด้านบน) เขียนทีละแถวผ่าน batchUpdate เหมือน createTripOrder ด้านบน. รายการ
 * ที่หาไม่เจอ หรือไม่ได้อยู่ในสถานะ "pending" แล้ว (เช่นถูกแยกออกจากใบสั่งงาน
 * หรือ ผอ. อีกแท็บ/อีกครั้งกดไปแล้ว) ถูกข้ามอย่างเงียบๆ แทนการ throw ทั้งชุด —
 * เพราะนี่เป็นการกดยืนยันหลายรายการพร้อมกัน รายการเดียวที่ค้างไม่ควรทำให้รายการ
 * ที่เหลือกดไม่ติดไปด้วย. คืนรายการ bookingId ที่ตั้งค่าสำเร็จจริงกลับไป ให้ฝั่ง
 * UI รู้ว่ารายการไหนหลุดไปบ้าง.
 *
 * `comment` — ข้อความจาก ผอ. เก็บลง Booking.directorNote ของทุกแถวที่อัปเดต
 * สำเร็จ ("" ถ้าไม่ได้กรอก) ตามที่ขอเพิ่ม "ช่องที่ผอ.ท่านสามารถชี้แจงเหตุผลกับ
 * ผู้จองว่าทำไมถึงไม่ให้" สำหรับกรณีไม่อนุมัติ — ใช้ฟิลด์เดียวกันได้ทั้งอนุมัติ/
 * ไม่อนุมัติ เผื่ออนาคตอยากฝากข้อความตอนอนุมัติด้วย แม้ตอนนี้ฝั่ง UI จะเก็บช่อง
 * นี้ไว้เฉพาะตอนไม่อนุมัติก็ตาม. */
export async function setDirectorDecision(
  bookingIds: string[],
  decision: "approved" | "rejected",
  comment: string = ""
): Promise<{ updatedBookingIds: string[] }> {
  if (bookingIds.length === 0) return { updatedBookingIds: [] };

  const spreadsheetId = getEnv("GOOGLE_SHEET_ID");
  const bookingsTab = getBookingsTab();
  const sheets = google.sheets({ version: "v4", auth: sheetsAuth() });

  let values: string[][] | undefined;
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${bookingsTab}!A2:AA100000`,
    });
    values = res.data.values as string[][] | undefined;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`อ่านรายการจองไม่สำเร็จ: ${message}`);
  }
  const rows = values ?? [];
  const decidedAt = new Date().toISOString();

  const targets: { rowIndex: number; booking: Booking }[] = [];
  for (const bookingId of bookingIds) {
    const idx = rows.findIndex((row) => (row[0] ?? "").toString().trim() === bookingId);
    if (idx === -1) continue;
    const booking = rowToBooking(rows[idx]);
    if (booking.directorApprovalStatus !== "pending") continue;
    targets.push({ rowIndex: idx, booking });
  }
  if (targets.length === 0) return { updatedBookingIds: [] };

  try {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: {
        valueInputOption: "RAW",
        data: targets.map(({ rowIndex, booking }) => ({
          range: `${bookingsTab}!A${rowIndex + 2}:AA${rowIndex + 2}`,
          values: [
            bookingToRow({
              ...booking,
              directorApprovalStatus: decision,
              directorApprovedAt: decidedAt,
              directorNote: comment,
            }),
          ],
        })),
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`บันทึกการอนุมัติของ ผอ. ไม่สำเร็จ: ${message}`);
  }

  return { updatedBookingIds: targets.map((t) => t.booking.bookingId) };
}

/** ผอ. กด "ตีกลับ" ใบสั่งงานทั้งใบ (ไม่ใช่รายคำขอ) ให้ฝ่ายบริหารผู้จัดรถ
 * พิจารณาจัดรถใหม่ — ต่างจาก setDirectorDecision ด้านบนตรงที่นี่คือการยกเลิก
 * การจัดรถเดิมทั้งหมดและคืนทุกคำขอที่ TripOrder นี้ครอบคลุมกลับไปเป็น "รอจัดรถ"
 * ตั้งแต่ต้น (ยืนยันกับผู้ใช้แล้วว่าต้องการพฤติกรรมนี้ ไม่ใช่แค่ติดป้ายเตือนไว้
 * เฉยๆ) — เหมือนกับที่ splitBookingFromTripOrder ทำกับคำขอเดียว เพียงแต่ทำกับ
 * ทุกคำขอในใบสั่งงานพร้อมกัน และใส่ข้อความของ ผอ. (`comment`) ลงไปด้วย ("ช่อง
 * คอมเม้นด้วยว่าท่านมีอะไรจะบอกกับผู้จัดรถ" ตามที่ขอ) ให้ฝ่ายบริหารเห็นตอนจัด
 * รถใหม่ (ดู Booking.directorNote/directorReturnedAt และแบนเนอร์ใน
 * BookingDashboard.tsx)
 *
 * ใบสั่งงานเดิมไม่ถูกลบแถวทิ้ง (ตาม convention "ไม่ลบจริง" ทั้งไฟล์นี้) แค่ถูก
 * ล้าง bookingIds เหลือรายการเปล่า ("ตีกลับ" = ยกเลิกใบสั่งงานทั้งใบ ซึ่งเดิมยัง
 * ไม่มีฟังก์ชันรองรับเลยจนกว่าจะมีนี้ — ดูคอมเมนต์ของ
 * splitBookingFromTripOrder ด้านบนว่าเคยพูดถึงไว้ว่า "ยังไม่มีฟังก์ชันรองรับ")
 * เขียนใบสั่งงานก่อนเสมอ แล้วค่อยเขียนแถวคำขอ — เหตุผลเดียวกับฟังก์ชันอื่นๆ ใน
 * ไฟล์นี้ที่แก้ทั้งสองแท็บ. */
export async function returnTripToDispatch(
  tripOrderId: string,
  comment: string,
  actorUsername: string
): Promise<{ tripOrder: TripOrder; bookings: Booking[] }> {
  const spreadsheetId = getEnv("GOOGLE_SHEET_ID");
  const tripOrdersTab = getTripOrdersTab();
  const bookingsTab = getBookingsTab();
  const sheets = google.sheets({ version: "v4", auth: sheetsAuth() });

  let tripValues: string[][] | undefined;
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${tripOrdersTab}!A2:J100000`,
    });
    tripValues = res.data.values as string[][] | undefined;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`อ่านรายการใบสั่งงานไม่สำเร็จ: ${message}`);
  }
  const tripRows = tripValues ?? [];
  const tripIdx = tripRows.findIndex((row) => (row[0] ?? "").toString().trim() === tripOrderId);
  if (tripIdx === -1) {
    throw new Error("ไม่พบใบสั่งงานนี้ — อาจถูกตีกลับไปแล้วก่อนหน้านี้");
  }
  const current = rowToTripOrder(tripRows[tripIdx]);
  if (current.bookingIds.length === 0) {
    throw new Error("ใบสั่งงานนี้ไม่มีคำขอจองเหลืออยู่แล้ว");
  }

  let bookingValues: string[][] | undefined;
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${bookingsTab}!A2:AA100000`,
    });
    bookingValues = res.data.values as string[][] | undefined;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`อ่านรายการจองไม่สำเร็จ: ${message}`);
  }
  const bookingRows = bookingValues ?? [];

  const targets: { rowIndex: number; booking: Booking }[] = [];
  for (const bookingId of current.bookingIds) {
    const idx = bookingRows.findIndex((row) => (row[0] ?? "").toString().trim() === bookingId);
    if (idx === -1) continue; // กันพลาด — ไม่ควรเกิดขึ้น
    const booking = rowToBooking(bookingRows[idx]);
    if (isBookingCancelled(booking)) continue; // ยกเลิกไปแล้ว ไม่ต้องตีกลับอีก
    targets.push({ rowIndex: idx, booking });
  }
  if (targets.length === 0) {
    throw new Error("ไม่พบคำขอจองที่ยังใช้งานอยู่ในใบสั่งงานนี้");
  }

  const returnedAt = new Date().toISOString();
  const updatedBookings: Booking[] = targets.map(({ booking }) => ({
    ...booking,
    resourceId: "",
    resourceName: PENDING_CAR_RESOURCE_NAME,
    approvalStatus: "pending",
    approvedAt: "",
    approvedByUsername: "",
    tripOrderId: "",
    editedByUsername: actorUsername,
    editedAt: returnedAt,
    directorApprovalStatus: "",
    directorApprovedAt: "",
    directorNote: comment,
    directorReturnedAt: returnedAt,
  }));
  const dissolvedTripOrder: TripOrder = { ...current, bookingIds: [] };

  const tripSheetRow = tripIdx + 2;
  try {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${tripOrdersTab}!A${tripSheetRow}:J${tripSheetRow}`,
      // RAW — see the note on createBooking's append() above.
      valueInputOption: "RAW",
      requestBody: { values: [tripOrderToRow(dissolvedTripOrder)] },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`บันทึกการตีกลับใบสั่งงานไม่สำเร็จ: ${message}`);
  }

  try {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: {
        valueInputOption: "RAW",
        data: targets.map(({ rowIndex }, i) => ({
          range: `${bookingsTab}!A${rowIndex + 2}:AA${rowIndex + 2}`,
          values: [bookingToRow(updatedBookings[i])],
        })),
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    // ใบสั่งงานด้านบนถูกล้าง bookingIds ไปแล้ว — คำขอเหล่านี้จึงไม่มีใบสั่งงาน
    // รองรับอีกต่อไปไม่ว่าขั้นนี้จะสำเร็จหรือไม่ แค่สถานะยังค้างผิดอยู่ ต้อง
    // ลองใหม่ให้ครบ เหมือน splitBookingFromTripOrder ด้านบน.
    throw new Error(
      `ตีกลับใบสั่งงานสำเร็จ แต่ปรับสถานะคำขอที่เกี่ยวข้องกลับเป็น "รอจัดรถ" ไม่สำเร็จ (${message}) — กรุณาตรวจสอบรายการจองและลองใหม่หากยังค้างอยู่`
    );
  }

  return { tripOrder: dissolvedTripOrder, bookings: updatedBookings };
}

/** รหัสผ่านของหน้า ผอ. (/director) — เก็บแบบ key/value แท็บเดียวกับ
 * ReportSettings/SpecStandards ด้านบน (รูปแบบเดียวกันทั้งแอป) เพื่อให้ ผอ.
 * เปลี่ยนรหัสผ่านเองได้ผ่าน /api/director/reset-password โดยไม่ต้องพึ่ง env
 * var ซึ่งแก้ตอน runtime ไม่ได้ (บน Vercel). ถ้าแท็บนี้ยังไม่มี/ยังไม่มีแถว
 * passwordHash เลย ถือว่า "ยังไม่ตั้งรหัสเอง" — ฝั่ง login จะ fallback ไปใช้
 * DIRECTOR_BOOTSTRAP_PASSWORD_HASH (env var) แทน เหมือน bootstrap superadmin
 * (ดู checkBootstrapAccount ใน api/auth/login/route.ts) — มีรหัสผ่านให้เข้า
 * เสมอตั้งแต่วันแรกที่ deploy แม้ยังไม่เคยกด "เปลี่ยนรหัสผ่าน" เลยก็ตาม. */
function getDirectorSettingsTab(): string {
  return process.env.GOOGLE_SHEET_DIRECTOR_SETTINGS_TAB?.trim() || "DirectorSettings";
}

export async function getDirectorPasswordHash(): Promise<string> {
  const spreadsheetId = getEnv("GOOGLE_SHEET_ID");
  const tab = getDirectorSettingsTab();
  const sheets = google.sheets({ version: "v4", auth: sheetsAuth() });

  let values: string[][] | undefined;
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${tab}!A2:B10`,
    });
    values = res.data.values as string[][] | undefined;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("Unable to parse range")) return ""; // แท็บยังไม่มี
    throw new Error(`อ่านการตั้งค่า ผอ. ไม่สำเร็จ: ${message}`);
  }
  for (const row of values ?? []) {
    if ((row[0] ?? "").toString().trim() === "passwordHash") {
      return (row[1] ?? "").toString().trim();
    }
  }
  return "";
}

/** เขียนทับทั้งแท็บเสมอ (มีแค่แถวเดียวที่ใช้จริง) — ต้องมีแท็บ "DirectorSettings"
 * อยู่ก่อนแล้ว (เหมือนแท็บอื่นๆ ในแอปนี้ — values.update ไม่สร้างแท็บใหม่ให้
 * เอง ต่างจาก append ซึ่งสร้าง range ใหม่ในแท็บที่มีอยู่แล้วได้) — ให้ error
 * ชัดเจนบอกให้สร้างแท็บก่อนถ้ายังไม่มี เหมือน createTripOrder/createBooking
 * ด้านบน. */
export async function setDirectorPasswordHash(hash: string): Promise<void> {
  const spreadsheetId = getEnv("GOOGLE_SHEET_ID");
  const tab = getDirectorSettingsTab();
  const sheets = google.sheets({ version: "v4", auth: sheetsAuth() });

  try {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${tab}!A2:B2`,
      valueInputOption: "RAW",
      requestBody: { values: [["passwordHash", hash]] },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("Unable to parse range")) {
      throw new Error(
        `ยังไม่พบแท็บชื่อ "${tab}" ในสเปรดชีต — สร้างแท็บนี้ก่อน (หัวตาราง: key | value) หรือตั้งค่า GOOGLE_SHEET_DIRECTOR_SETTINGS_TAB ให้ตรงกับชื่อแท็บจริง`
      );
    }
    throw new Error(`บันทึกรหัสผ่าน ผอ. ไม่สำเร็จ: ${message}`);
  }
}
