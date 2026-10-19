import type { Role } from "@/lib/auth";
import type { PermissionKey } from "@/lib/permissions";
import type { UserRecord } from "@/lib/sheets";
import { getSupabaseClient } from "@/lib/supabaseClient";

// Supabase-backed parallel of the "Users" cluster in lib/sheets.ts
// (getUsers/addUser/updateUser). Same exported function names/signatures
// and the same UserRecord/Role/PermissionKey types, unchanged — only WHERE
// the data lives changes (a Postgres table instead of a sheet tab).
//
// UserRecord.rowNumber is a pure Sheets-era artifact (confirmed by reading
// every .rowNumber call site in the app: it's only ever used for React
// list keys / display, never to look a user up — updateUser is keyed by
// username both here and in the original). There is no equivalent concept
// in Postgres, so this file synthesizes a placeholder value wherever one
// is needed (position in the getUsers() result for a fresh read; 0 after
// updateUser, since nothing downstream reads rowNumber off that return
// value in a way that would notice).

interface UsersRow {
  id: string;
  username: string;
  password_hash: string;
  role: string;
  department: string;
  display_name: string;
  active: boolean;
  extra_permissions: string[] | null;
  revoked_permissions: string[] | null;
  created_at: string;
  updated_at: string;
}

// Same defaulting behaviour as parseRole in lib/sheets.ts: anything that
// isn't one of the three known roles falls back to "user" (the most
// restrictive), never silently granting broader access. The CHECK
// constraint on users.role already prevents anything else from being
// written in the first place, but this stays defensive for a row written
// by hand (e.g. directly in the Supabase Table Editor) before validation.
function parseRole(raw: string): Role {
  if (raw === "superadmin" || raw === "admin") return raw;
  return "user";
}

function rowToUser(row: UsersRow, rowNumber: number): UserRecord {
  return {
    rowNumber,
    username: row.username,
    passwordHash: row.password_hash,
    role: parseRole(row.role),
    department: row.department ?? "",
    displayName: row.display_name ?? "",
    active: row.active,
    extraPermissions: (row.extra_permissions ?? []) as PermissionKey[],
    revokedPermissions: (row.revoked_permissions ?? []) as PermissionKey[],
  };
}

export async function getUsers(): Promise<UserRecord[]> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("users")
    .select("*")
    .order("created_at", { ascending: true });

  if (error) {
    throw new Error(`อ่านรายชื่อผู้ใช้ไม่สำเร็จ: ${error.message}`);
  }

  // rowNumber here mirrors the old "row 2 is the first data row" Sheets
  // convention purely for familiarity in any debug output — nothing reads
  // it for lookup purposes (see file header comment).
  return (data ?? []).map((row, i) => rowToUser(row as UsersRow, i + 2));
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
  const supabase = getSupabaseClient();

  const { error } = await supabase.from("users").insert({
    username: user.username,
    password_hash: user.passwordHash,
    role: user.role,
    department: user.department,
    display_name: user.displayName,
    active: true,
    extra_permissions: user.extraPermissions ?? [],
    revoked_permissions: user.revokedPermissions ?? [],
  });

  if (error) {
    // 23505 = unique_violation — users.username has a UNIQUE index, same
    // uniqueness guarantee the Sheets version only ever enforced loosely
    // (nothing in sheets.ts actually checked for a duplicate username
    // before appending a row) — surfaced here as a clear Thai error
    // instead of a raw Postgres error, which is a (deliberate, minor)
    // behavior improvement over the original.
    if (error.code === "23505") {
      throw new Error(`มีชื่อผู้ใช้ "${user.username}" อยู่แล้ว`);
    }
    throw new Error(`เพิ่มผู้ใช้ไม่สำเร็จ: ${error.message}`);
  }
}

export async function updateUser(
  username: string,
  updates: Partial<
    Pick<
      UserRecord,
      "passwordHash" | "role" | "department" | "displayName" | "active" | "extraPermissions" | "revokedPermissions"
    >
  >
): Promise<UserRecord> {
  const supabase = getSupabaseClient();

  const patch: Record<string, unknown> = {};
  if (updates.passwordHash !== undefined) patch.password_hash = updates.passwordHash;
  if (updates.role !== undefined) patch.role = updates.role;
  if (updates.department !== undefined) patch.department = updates.department;
  if (updates.displayName !== undefined) patch.display_name = updates.displayName;
  if (updates.active !== undefined) patch.active = updates.active;
  if (updates.extraPermissions !== undefined) patch.extra_permissions = updates.extraPermissions;
  if (updates.revokedPermissions !== undefined) patch.revoked_permissions = updates.revokedPermissions;

  const { data, error } = await supabase
    .from("users")
    .update(patch)
    .eq("username", username)
    .select("*")
    .maybeSingle();

  if (error) {
    throw new Error(`บันทึกข้อมูลผู้ใช้ไม่สำเร็จ: ${error.message}`);
  }
  if (!data) {
    throw new Error(`ไม่พบผู้ใช้ "${username}" ในระบบ`);
  }

  return rowToUser(data as UsersRow, 0);
}
