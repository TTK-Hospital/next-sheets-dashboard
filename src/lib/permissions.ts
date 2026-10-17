import type { Role } from "@/lib/auth";

// Per-account permission overrides layered on top of the role system —
// added per the hospital's explicit request for finer per-account control
// ("อยากให้ระบบสิทธิมีรายการย่อยให้ติ๊ก... ยังไม่มีสถานการณ์เจาะจง อยากได้ไว้
// ก่อนเผื่อใช้อนาคต"). This is deliberately a HYBRID, not a replacement: every
// account still has one of the roles below, which sets a sensible default
// for each key below (see defaultPermissionsForRole); a bootstrap account
// creating or editing an account through /manage/users can then tick a key
// on ("extraPermissions") to grant something that role wouldn't normally
// have, or tick one off ("revokedPermissions") to take away something it
// would.
//
// ROLES (see lib/auth.ts's Role type and its own top-of-file comment for
// the full story): superadmin (every department; bootstrap gets everything
// unconditionally, a regular superadmin gets a smaller default set below,
// same as before) / admin (one department, equipment-registry access by
// default) / user (booking only, the newest and most-restrictive role,
// added later per the hospital's explicit request — no equipment-registry
// access by default). There used to be a fourth role, "it" (every
// department, read-only equipment-registry access + the technical
// /manage/it dashboard + booking-resource management) — folded into
// "superadmin" per a later explicit request ("นำสิทธิ it ออกไป และนำ
// ความสามารถในสิทธิ it ไปรวมกับ superadmin"): its two defining keys,
// accessItDashboard and manageBookingResources, moved out of
// NON_GRANTABLE_KEYS below so any superadmin account can now be granted
// them per-account, but neither became an automatic default for every
// superadmin — an explicit later choice not to silently change what every
// existing superadmin account can do.
//
// Dependency-free "pure module", same convention as lib/booking.ts and
// lib/roleLabel.ts (only a type-only import from lib/auth.ts, never the
// crypto-importing runtime code) — so this can be imported directly by
// client components (UserFormModal's checkboxes) as well as every server
// route and lib/auth.ts/lib/booking.ts, without pulling `crypto`/
// `googleapis` into client bundles.
//
// HIERARCHY CAP (added right after this feature first shipped, in response
// to the hospital noticing an admin account could otherwise be ticked all
// the way up to look exactly like a superadmin, making the role dropdown
// itself meaningless) — two layers, both enforced server-side (the real
// boundary, in /api/manage/users) and client-side (so UserFormModal's
// checkbox list never even offers something the server would reject):
//   1. A handful of keys — deleteEquipment, manageUsers,
//      manageReportActionList, viewAllMaintenanceTasks — stay reserved to
//      the literal bootstrap account and can never be granted to anyone
//      else via extraPermissions, full stop, even to a superadmin. See
//      NON_GRANTABLE_KEYS below.
//   2. On top of that, a role can have its own narrower allow-list for
//      everything NOT in that reserved set — currently "admin" (narrowed to
//      addEquipment + approveCarBooking, since the full "superadmin ทั่วไป"
//      tier — approveCarBooking, editBookingData, cancelAnyBooking,
//      manageEquipmentAllDept, addEquipment, disposeRestoreEquipment — was
//      still enough to make an admin account indistinguishable from a
//      superadmin) and "user" (narrowed to accessEquipmentRegistry alone,
//      the one capability the hospital explicitly asked to make optional
//      for this role). See GRANTABLE_EXTRA_KEYS_BY_ROLE below.
// isGrantablePermission(key, role) is the one function that combines both
// layers — always use that, never NON_GRANTABLE_KEYS or
// GRANTABLE_EXTRA_KEYS_BY_ROLE directly.
//
// NOT every existing role check in the app was migrated to read through
// here — only the ones listed below, chosen because they're reasonable,
// low-risk things a hospital admin might plausibly want to grant/revoke per
// account. One narrower rule was deliberately left as a plain role check
// because turning it into a togglable key would risk changing behavior in a
// way nobody asked for: a superadmin's own reach (every department,
// unconditionally) never depends on a permission key at all — see
// canAccessEquipmentRegistry in lib/auth.ts and the "manageEquipmentAllDept"
// checks in /api/manage/records*, both of which special-case
// role === "superadmin" before ever consulting hasPermission().

export type PermissionKey =
  | "approveCarBooking"
  | "editBookingData"
  | "manageBookingResources"
  | "manageDrivers"
  | "cancelAnyBooking"
  | "manageEquipmentAllDept"
  | "addEquipment"
  | "disposeRestoreEquipment"
  | "deleteEquipment"
  | "accessItDashboard"
  | "accessEquipmentRegistry"
  | "manageUsers"
  | "manageReportActionList"
  | "viewAllMaintenanceTasks"
  | "lockReportActionOptions";

export const PERMISSION_KEYS: PermissionKey[] = [
  "approveCarBooking",
  "editBookingData",
  "manageBookingResources",
  "manageDrivers",
  "cancelAnyBooking",
  "manageEquipmentAllDept",
  "addEquipment",
  "disposeRestoreEquipment",
  "deleteEquipment",
  "accessItDashboard",
  "accessEquipmentRegistry",
  "manageUsers",
  "manageReportActionList",
  "viewAllMaintenanceTasks",
  "lockReportActionOptions",
];

/** Thai labels for the checkbox list in UserFormModal — kept here, next to
 * the keys themselves, so the two can never drift out of sync. */
export const PERMISSION_LABELS: Record<PermissionKey, string> = {
  // เดิมชื่อ "อนุมัติ/ไม่อนุมัติ/ออกใบสั่งงานการจองรถ" — ตัด "อนุมัติ/ไม่อนุมัติ"
  // ออกแล้ว เหลือแค่ "จัดรถ" เพราะมีผู้อนุมัติ/ไม่อนุมัติการจองรถได้เพียง ผอ.
  // คนเดียวเท่านั้นตามที่ขอ (ดู PATCH /api/booking/bookings/[bookingId]'s doc
  // comment และ canApproveCarBooking's doc comment ใน lib/booking.ts) — คีย์
  // ชื่อ "approveCarBooking" เองยังคงไว้เหมือนเดิมเพื่อไม่ต้องย้ายข้อมูลสิทธิ
  // เก่าของทุกบัญชี มีผลกับ label ที่แสดงผลให้ bootstrap เห็นตอนติ๊กสิทธิ์
  // เท่านั้น
  approveCarBooking: "จัดรถ (ออกใบสั่งงานการจองรถ)",
  editBookingData: "แก้ไขข้อมูลรายละเอียดการจอง (วัตถุประสงค์/ปลายทาง/ผู้ร่วมเดินทาง ฯลฯ)",
  manageBookingResources: "จัดการรถ/ห้องประชุม (เพิ่ม/แก้ไข/ปิดใช้งาน)",
  manageDrivers: "จัดการข้อมูลคนขับรถ (เพิ่ม/แก้ไข/ปิดใช้งาน)",
  cancelAnyBooking: "ยกเลิกการจองของผู้อื่นได้ (ทุกแผนก)",
  manageEquipmentAllDept: "แก้ไขรายการครุภัณฑ์ได้ทุกแผนก (ไม่จำกัดเฉพาะแผนกตัวเอง)",
  addEquipment: "เพิ่มรายการครุภัณฑ์ใหม่",
  disposeRestoreEquipment: "จำหน่าย/กู้คืนรายการครุภัณฑ์",
  deleteEquipment: "ลบรายการครุภัณฑ์ถาวร",
  accessItDashboard: "เข้าหน้าระบบงาน IT (สเปก/รายงาน/งานบำรุงรักษา)",
  accessEquipmentRegistry: "เข้าหน้าทะเบียนครุภัณฑ์คอมพิวเตอร์ (แก้ไขได้เฉพาะกลุ่มงานตัวเอง)",
  manageUsers: "จัดการผู้ใช้งาน (เพิ่ม/แก้ไข/ปิดใช้งานบัญชี)",
  manageReportActionList: 'จัดการรายการ "การดำเนินการ" มาตรฐานในรายงาน',
  viewAllMaintenanceTasks: "ดูงานบำรุงรักษาของทุกคนในทีม (ไม่ใช่แค่ของตัวเอง)",
  lockReportActionOptions: 'ล็อกรายการ "การดำเนินการ" ให้บังคับเลือกเสมอทุกครั้งที่พิมพ์รายงาน',
};

/** Keys reserved to the bootstrap account by default — never grantable to
 * any other account through extraPermissions, no matter its role. Without
 * this cap, an admin account could be ticked up through every checkbox and
 * end up functionally indistinguishable from a superadmin (or even from
 * bootstrap itself), which would make the role dropdown meaningless — a
 * concern the hospital raised directly after this feature first shipped.
 * The chosen fix: a per-account override can raise an account's ceiling up
 * to (but never past) what a plain, non-bootstrap superadmin already gets
 * by default — the keys below stay behind the literal bootstrap account,
 * full stop. Revoking one of these from an account that already has it by
 * role default (i.e. bootstrap itself, which gets every key) is still
 * always allowed — this only blocks *granting* one of these keys to an
 * account that wouldn't otherwise have it.
 *
 * accessItDashboard and manageBookingResources used to live here too (back
 * when they were the old "it" role's exclusive default) — moved out per the
 * hospital's later explicit request to fold "it" into "superadmin" and let
 * any superadmin account optionally be granted those two instead of only
 * the bootstrap account (see lib/auth.ts's Role comment). Enforced both
 * server-side (readNewUserPayload/readUpdateUserPayload in
 * /api/manage/users, the real boundary) and client-side (UserFormModal
 * disables the checkbox), so this list is the single source of truth for
 * both. */
export const NON_GRANTABLE_KEYS: PermissionKey[] = [
  "deleteEquipment",
  "manageUsers",
  "manageReportActionList",
  "viewAllMaintenanceTasks",
];

/** A second, per-role ceiling on top of NON_GRANTABLE_KEYS — added when the
 * hospital pointed out that even the "superadmin ทั่วไป" tier (the keys NOT
 * in NON_GRANTABLE_KEYS: approveCarBooking, editBookingData,
 * cancelAnyBooking, manageEquipmentAllDept, addEquipment,
 * disposeRestoreEquipment, accessItDashboard, manageBookingResources,
 * manageDrivers, lockReportActionOptions) was too much to let an "admin"
 * account reach in full — ticking every one of
 * those still made an admin account functionally identical to a plain
 * superadmin, the exact problem this whole cap exists to prevent, just one
 * tier down. Only a role listed here has its grantable additions narrowed
 * further; a role with no entry keeps the plain NON_GRANTABLE_KEYS ceiling.
 * This never restricts a role's own defaults (see isGrantablePermission
 * below) — only what can be added beyond them.
 *
 * - admin: addEquipment (per the hospital's original explicit choice —
 *   "admin ให้เพิ่มได้เฉพาะเพิ่มรายการครุภัณฑ์ใหม่เท่านั้น นอกนั้นซ่อนไป") +
 *   approveCarBooking, added later per an explicit follow-up request to let
 *   a specific admin account optionally also dispatch car bookings ("ปรับให้
 *   สิทธิ admin สามารถเลือกความสามารถในการอนุมัติ" — ถ้อยคำเดิมตอนขอ, ตอนนี้คือ
 *   "จัดรถ" ไม่ใช่ "อนุมัติ" แล้ว ดู PERMISSION_LABELS ด้านบน).
 * - user: accessEquipmentRegistry alone — the one capability the hospital
 *   explicitly asked to make optional for this role (per-department
 *   equipment-registry access, the same thing admin gets by default). */
export const GRANTABLE_EXTRA_KEYS_BY_ROLE: Partial<Record<Role, PermissionKey[]>> = {
  admin: ["addEquipment", "approveCarBooking"],
  user: ["accessEquipmentRegistry"],
};

/** True if `key` can be added to some account's extraPermissions for the
 * given `role` — checked in this order: (1) the role already gets it by
 * default anyway, so "granting" it is really just re-enabling the role's
 * own default, never blocked; (2) it's one of the six bootstrap-reserved
 * keys (NON_GRANTABLE_KEYS) — never grantable as an addition to anyone;
 * (3) the role has its own narrower allow-list (GRANTABLE_EXTRA_KEYS_BY_ROLE)
 * — only listed keys are grantable; (4) no allow-list for this role — every
 * remaining (non-reserved) key is grantable. Use this — never a bare
 * NON_GRANTABLE_KEYS/GRANTABLE_EXTRA_KEYS_BY_ROLE check — everywhere a grant
 * is being validated. */
export function isGrantablePermission(key: PermissionKey, role: Role): boolean {
  if (defaultPermissionsForRole(role, false).has(key)) return true;
  if (NON_GRANTABLE_KEYS.includes(key)) return false;
  const allowedExtras = GRANTABLE_EXTRA_KEYS_BY_ROLE[role];
  if (allowedExtras) return allowedExtras.includes(key);
  return true;
}

/** The minimal shape hasPermission()/defaultPermissionsForRole() need —
 * matches (a subset of) SessionPayload without importing it as a value. */
export interface PermissionSession {
  role: Role;
  isBootstrap: boolean;
  extraPermissions?: PermissionKey[];
  revokedPermissions?: PermissionKey[];
}

/** What each role gets out of the box, before any per-account override is
 * applied — this is exactly the pre-override behavior every one of these
 * keys' underlying checks already had, so an account with no overrides at
 * all behaves identically to before this feature existed. The single
 * env-configured bootstrap account gets every key (moot in practice, since
 * hasPermission short-circuits to true for it before ever consulting this —
 * kept here anyway so this function alone is always a correct, complete
 * description of "what can this role do"). */
export function defaultPermissionsForRole(role: Role, isBootstrap: boolean): Set<PermissionKey> {
  if (role === "superadmin" && isBootstrap) {
    return new Set(PERMISSION_KEYS);
  }
  if (role === "superadmin") {
    // Any superadmin — bootstrap or one created through /manage/users —
    // reaches equipment/booking oversight the same way today (see
    // canApproveCarBooking/canEditBookingByManagement/canCancelBooking in
    // lib/booking.ts and the records API routes); only the old "it" role's
    // two surfaces (accessItDashboard, manageBookingResources) stay off by
    // default for a regular superadmin — grantable per account instead, per
    // the hospital's explicit choice not to silently change every existing
    // superadmin account's reach when "it" was folded into this role (see
    // lib/auth.ts's Role comment for the full story).
    return new Set<PermissionKey>([
      "approveCarBooking",
      "editBookingData",
      "cancelAnyBooking",
      "manageEquipmentAllDept",
      "addEquipment",
      "disposeRestoreEquipment",
      // Locking a รายการ "การดำเนินการ" entry (forcing it into every print
      // round's selection — see lockedActionOptions in lib/sheets.ts and
      // MaintenanceReportBuilder's canLockActionOptions) is on by default
      // for any superadmin, bootstrap or not — deliberately NOT reserved to
      // bootstrap the way manageReportActionList (adding/renaming/reordering/
      // deleting an entry) is, per the hospital's explicit request that a
      // superadmin created through /manage/users should be able to set this
      // lock too. "admin"/"user" never get this: GRANTABLE_EXTRA_KEYS_BY_ROLE
      // below has its own narrow allow-list for each and doesn't include
      // this key, so isGrantablePermission keeps it off the checkbox list
      // for those two roles entirely (see that function's own comment) —
      // exactly "superadmin only", without a one-off plain role check.
      "lockReportActionOptions",
    ]);
  }
  if (role === "admin") {
    // Matches canAccessEquipmentRegistry in lib/auth.ts — the same
    // per-department equipment-registry access admin has always had, now
    // named as an explicit (and therefore individually revocable) key
    // instead of an implicit "not it, not superadmin" role check.
    return new Set<PermissionKey>(["accessEquipmentRegistry"]);
  }
  // user — the newest, most-restrictive role (added per the hospital's
  // explicit request for one that "ทำได้เพียงใช้ระบบ" — booking only).
  // Booking/viewing/cancelling-your-own-booking stays open to every role
  // regardless (not a togglable key); nothing in this list is on by default
  // for user.
  return new Set<PermissionKey>();
}

/** The single source of truth every migrated check now calls instead of
 * comparing session.role/isBootstrap directly. The one carve-out: the
 * bootstrap account is immune to revocation for every key — deliberately,
 * so a mistaken or malicious revokedPermissions entry can never lock the one
 * account that can grant/revoke everyone else's permissions out of its own
 * capabilities. For every other account: an explicit revoke always wins,
 * then the role's default, then an explicit grant. */
export function hasPermission(session: PermissionSession, key: PermissionKey): boolean {
  if (session.role === "superadmin" && session.isBootstrap) return true;

  const revoked = session.revokedPermissions;
  if (revoked && revoked.includes(key)) return false;

  if (defaultPermissionsForRole(session.role, session.isBootstrap).has(key)) return true;

  const extra = session.extraPermissions;
  return extra ? extra.includes(key) : false;
}

/** Validates that every entry in `value` is a real PermissionKey — used by
 * the /api/manage/users route to reject a malformed or hand-crafted
 * extraPermissions/revokedPermissions array instead of silently storing
 * garbage in the sheet. */
export function isPermissionKey(value: unknown): value is PermissionKey {
  return typeof value === "string" && (PERMISSION_KEYS as string[]).includes(value);
}
