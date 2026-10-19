import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, hashPassword, requestAuditTag, verifySessionToken, type Role } from "@/lib/auth";
import { addUser, appendEditLog, getUsers, updateUser, type UserRecord } from "@/lib/sheets";
import {
  PERMISSION_LABELS,
  hasPermission,
  isGrantablePermission,
  isPermissionKey,
  type PermissionKey,
} from "@/lib/permissions";

// Always live — reveals account data behind an auth check and accepts
// writes, never something to cache/prerender.
export const dynamic = "force-dynamic";

type PublicUser = Omit<UserRecord, "passwordHash">;

function toPublic(user: UserRecord): PublicUser {
  // Password hashes never leave the server, even to an authenticated
  // superadmin's browser — there's no legitimate reason the UI needs them.
  return {
    rowNumber: user.rowNumber,
    username: user.username,
    role: user.role,
    department: user.department,
    displayName: user.displayName,
    active: user.active,
    extraPermissions: user.extraPermissions,
    revokedPermissions: user.revokedPermissions,
  };
}

/** Managing users is restricted to the single env-configured bootstrap
 * account (SessionPayload.isBootstrap) — not just any superadmin. Backed by
 * hasPermission()'s "manageUsers" key (see lib/permissions.ts) rather than a
 * hardcoded isBootstrap check for consistency with every other migrated
 * check, but in practice this stays bootstrap-only: manageUsers is one of
 * the six keys in NON_GRANTABLE_KEYS (lib/permissions.ts) that a per-account
 * override can never grant to anyone else, precisely so that reaching this
 * route always means being the literal bootstrap account. */
function requireManageUsersPermission(request: NextRequest) {
  const session = verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value);
  if (!session) {
    return { session: null, response: NextResponse.json({ error: "กรุณาเข้าสู่ระบบ" }, { status: 401 }) };
  }
  if (!hasPermission(session, "manageUsers")) {
    return {
      session: null,
      response: NextResponse.json(
        { error: "เฉพาะบัญชีผู้ดูแลระบบหลัก (หรือบัญชีที่ได้รับสิทธิ์นี้เพิ่มเติม) เท่านั้นที่จัดการผู้ใช้ได้" },
        { status: 403 }
      ),
    };
  }
  return { session, response: null };
}

/** Lists every account in the Users tab — bootstrap account only. */
export async function GET(request: NextRequest) {
  const { session, response } = requireManageUsersPermission(request);
  if (!session) return response;

  try {
    const users = await getUsers();
    return NextResponse.json({ users: users.map(toPublic) });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

interface NewUserPayload {
  username: string;
  password: string;
  role: Role;
  department: string;
  displayName: string;
  extraPermissions: PermissionKey[];
  revokedPermissions: PermissionKey[];
}

/** Reads a permission-key array from the request body, dropping any entry
 * that isn't a real PermissionKey (see isPermissionKey) instead of
 * rejecting the whole request over one bad value — same defensive posture
 * as parsePermissionKeyList in lib/sheets.ts, just on the way in instead of
 * the way back out of the sheet. Missing/wrong-type entirely -> []. */
function readPermissionKeyArray(value: unknown): PermissionKey[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isPermissionKey);
}

/** The real enforcement of the hierarchy cap (see NON_GRANTABLE_KEYS in
 * lib/permissions.ts): rejects the request outright if any submitted
 * extraPermissions entry would grant a bootstrap-reserved key to an account
 * that doesn't already get it by role default. UserFormModal disables those
 * checkboxes so this should rarely trigger from the real UI — this is the
 * actual security boundary, not just a UI nicety, since a request can always
 * be hand-crafted. Returns null (no error) when everything's within the
 * cap. */
function validatePermissionCap(extraPermissions: PermissionKey[], role: Role): string | null {
  const notGrantable = extraPermissions.filter((k) => !isGrantablePermission(k, role));
  if (notGrantable.length === 0) return null;
  return `สิทธิ์ต่อไปนี้ให้เพิ่มเติมผ่านการติ๊กไม่ได้ (สงวนไว้เฉพาะบัญชีผู้ดูแลระบบหลัก): ${notGrantable
    .map((k) => PERMISSION_LABELS[k])
    .join(", ")}`;
}

function readNewUserPayload(body: unknown): NewUserPayload | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (typeof b.username !== "string" || b.username.trim() === "") return null;
  if (typeof b.password !== "string" || b.password.length < 4) return null;
  if (b.role !== "superadmin" && b.role !== "admin" && b.role !== "user") return null;
  if (typeof b.displayName !== "string") return null;
  if (typeof b.department !== "string") return null;
  return {
    username: b.username.trim(),
    password: b.password,
    role: b.role,
    // ทุกสิทธิ์ต้องระบุกลุ่มงานแล้วตอนนี้ (ไม่ใช่แค่ admin เหมือนก่อนหน้านี้)
    // ตามที่ขอ เพื่อให้ superadmin ที่สร้างในระบบมีกลุ่มงานติดไปกับบัญชี
    // ด้วย (เช่น ตอนจองห้องประชุม/จองรถจะได้ขึ้นหน่วยงาน) — ไม่กระทบสิทธิ์การ
    // มองเห็น/จัดการข้อมูลของ superadmin เลย เพราะจุดที่ scope ตาม
    // department (เช่น GET /api/manage/records) เช็คแค่ role !== "superadmin"
    // และไม่มีสิทธิ์ manageEquipmentAllDept เท่านั้น ดูคอมเมนต์ที่
    // SessionPayload.department ใน lib/auth.ts
    department: b.department.trim(),
    displayName: b.displayName.trim(),
    extraPermissions: readPermissionKeyArray(b.extraPermissions),
    revokedPermissions: readPermissionKeyArray(b.revokedPermissions),
  };
}

/** Creates a new account — bootstrap account only. The plaintext password is
 * hashed here and never written to the sheet or logged. */
export async function POST(request: NextRequest) {
  const { session, response } = requireManageUsersPermission(request);
  if (!session) return response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "คำขอไม่ถูกต้อง" }, { status: 400 });
  }
  const submitted = readNewUserPayload(body);
  if (!submitted) {
    return NextResponse.json(
      { error: "ข้อมูลไม่ครบ — ต้องมีชื่อผู้ใช้, รหัสผ่าน (อย่างน้อย 4 ตัวอักษร), สิทธิ์ และชื่อที่แสดง" },
      { status: 400 }
    );
  }
  // ทุกสิทธิ์ต้องระบุกลุ่มงาน ไม่ใช่แค่ admin แล้ว — ดูคอมเมนต์ที่
  // readNewUserPayload ด้านบน
  if (submitted.department === "") {
    return NextResponse.json({ error: "ต้องระบุกลุ่มงานที่รับผิดชอบ" }, { status: 400 });
  }
  const capError = validatePermissionCap(submitted.extraPermissions, submitted.role);
  if (capError) {
    return NextResponse.json({ error: capError }, { status: 400 });
  }

  try {
    const existing = await getUsers();
    if (existing.some((u) => u.username === submitted.username)) {
      return NextResponse.json({ error: `มีชื่อผู้ใช้ "${submitted.username}" อยู่แล้ว` }, { status: 409 });
    }

    await addUser({
      username: submitted.username,
      passwordHash: hashPassword(submitted.password),
      role: submitted.role,
      department: submitted.department,
      displayName: submitted.displayName,
      extraPermissions: submitted.extraPermissions,
      revokedPermissions: submitted.revokedPermissions,
    });

    try {
      await appendEditLog({
        timestamp: new Date().toISOString(),
        action: "จัดการผู้ใช้",
        actor: session.username,
        department: submitted.department,
        oldValue: "",
        newValue: `สร้างผู้ใช้ "${submitted.username}" (${submitted.role}) ${requestAuditTag(request)}`,
      });
    } catch (logErr: unknown) {
      console.error("appendEditLog failed:", logErr);
    }

    const users = await getUsers();
    const created = users.find((u) => u.username === submitted.username);
    return NextResponse.json({ user: created ? toPublic(created) : null }, { status: 201 });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

interface UpdateUserPayload {
  username: string;
  password?: string;
  role?: Role;
  department?: string;
  displayName?: string;
  active?: boolean;
  extraPermissions?: PermissionKey[];
  revokedPermissions?: PermissionKey[];
}

function readUpdateUserPayload(body: unknown): UpdateUserPayload | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (typeof b.username !== "string" || b.username.trim() === "") return null;
  const out: UpdateUserPayload = { username: b.username.trim() };
  if (b.password !== undefined) {
    if (typeof b.password !== "string" || b.password.length < 4) return null;
    out.password = b.password;
  }
  if (b.role !== undefined) {
    if (b.role !== "superadmin" && b.role !== "admin" && b.role !== "user") return null;
    out.role = b.role;
  }
  if (b.department !== undefined) {
    if (typeof b.department !== "string") return null;
    out.department = b.department.trim();
  }
  if (b.displayName !== undefined) {
    if (typeof b.displayName !== "string") return null;
    out.displayName = b.displayName.trim();
  }
  if (b.active !== undefined) {
    if (typeof b.active !== "boolean") return null;
    out.active = b.active;
  }
  if (b.extraPermissions !== undefined) out.extraPermissions = readPermissionKeyArray(b.extraPermissions);
  if (b.revokedPermissions !== undefined) out.revokedPermissions = readPermissionKeyArray(b.revokedPermissions);
  return out;
}

/** Edits an existing account (reset password, change role/department,
 * rename, enable/disable) — bootstrap account only. */
export async function PATCH(request: NextRequest) {
  const { session, response } = requireManageUsersPermission(request);
  if (!session) return response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "คำขอไม่ถูกต้อง" }, { status: 400 });
  }
  const submitted = readUpdateUserPayload(body);
  if (!submitted) {
    return NextResponse.json({ error: "ข้อมูลที่ส่งมาไม่ถูกต้อง" }, { status: 400 });
  }

  const nextRole = submitted.role;
  const nextDepartment = submitted.department;
  // ทุกสิทธิ์ต้องระบุกลุ่มงานแล้วตอนนี้ ไม่ใช่แค่ admin (ดูคอมเมนต์ที่
  // readNewUserPayload ด้านบน) — ตรวจเฉพาะตอนที่คำขอนี้ส่ง department มา
  // ด้วยจริงๆ เท่านั้น (เหมือนพฤติกรรมเดิมของเช็คนี้ ซึ่งเป็นการแก้ไขแบบ
  // partial update — คำขอที่ไม่ได้แตะ department เลยไม่ควรถูกบังคับ)
  if (nextDepartment !== undefined && nextDepartment === "") {
    return NextResponse.json({ error: "ต้องระบุกลุ่มงานที่รับผิดชอบ" }, { status: 400 });
  }

  try {
    // The cap (see validatePermissionCap above) is checked against whatever
    // role the account will actually have after this save — the submitted
    // role if this request is changing it, otherwise its current one (a
    // request that only touches extraPermissions, leaving role untouched,
    // still needs the right role to validate against).
    if (submitted.extraPermissions !== undefined && submitted.extraPermissions.length > 0) {
      const effectiveRole = nextRole ?? (await getUsers()).find((u) => u.username === submitted.username)?.role;
      const capError = effectiveRole ? validatePermissionCap(submitted.extraPermissions, effectiveRole) : null;
      if (capError) {
        return NextResponse.json({ error: capError }, { status: 400 });
      }
    }

    const updates: Partial<
      Pick<
        UserRecord,
        "passwordHash" | "role" | "department" | "displayName" | "active" | "extraPermissions" | "revokedPermissions"
      >
    > = {};
    if (submitted.password) updates.passwordHash = hashPassword(submitted.password);
    if (submitted.role) updates.role = submitted.role;
    if (submitted.department !== undefined) updates.department = submitted.department;
    if (submitted.displayName !== undefined) updates.displayName = submitted.displayName;
    if (submitted.active !== undefined) updates.active = submitted.active;
    if (submitted.extraPermissions !== undefined) updates.extraPermissions = submitted.extraPermissions;
    if (submitted.revokedPermissions !== undefined) updates.revokedPermissions = submitted.revokedPermissions;

    const updated = await updateUser(submitted.username, updates);

    const changeSummary = [
      submitted.password && "รีเซ็ตรหัสผ่าน",
      submitted.role && `สิทธิ์ → ${submitted.role}`,
      submitted.department !== undefined && `กลุ่มงาน → ${submitted.department || "-"}`,
      submitted.displayName !== undefined && `ชื่อที่แสดง → ${submitted.displayName}`,
      submitted.active !== undefined && (submitted.active ? "เปิดใช้งาน" : "ปิดใช้งาน"),
      (submitted.extraPermissions !== undefined || submitted.revokedPermissions !== undefined) &&
        "ปรับสิทธิ์เฉพาะบัญชี",
    ].filter(Boolean);
    try {
      await appendEditLog({
        timestamp: new Date().toISOString(),
        action: "จัดการผู้ใช้",
        actor: session.username,
        department: updated.department,
        oldValue: "",
        newValue: `แก้ไขผู้ใช้ "${submitted.username}": ${changeSummary.join(", ") || "-"} ${requestAuditTag(request)}`,
      });
    } catch (logErr: unknown) {
      console.error("appendEditLog failed:", logErr);
    }

    return NextResponse.json({ user: toPublic(updated) });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
