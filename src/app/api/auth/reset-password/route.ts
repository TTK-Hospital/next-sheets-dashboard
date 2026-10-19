import { NextRequest, NextResponse, after } from "next/server";
import {
  clearActiveSession,
  clearAttempts,
  clientIp,
  hashPassword,
  isLockedOut,
  recordFailedAttempt,
  requestAuditTag,
  verifyPassword,
} from "@/lib/auth";
import { appendEditLog, getUsers, updateUser } from "@/lib/sheets";

// Never cache/prerender — checks live rate-limit + account state, then writes.
export const dynamic = "force-dynamic";

interface ResetPayload {
  username: string;
  currentPassword: string;
  newPassword: string;
}

function readResetPayload(body: unknown): ResetPayload | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (typeof b.username !== "string" || !b.username.trim()) return null;
  if (typeof b.currentPassword !== "string" || !b.currentPassword) return null;
  if (typeof b.newPassword !== "string" || b.newPassword.length < 4) return null;
  return { username: b.username.trim(), currentPassword: b.currentPassword, newPassword: b.newPassword };
}

/** Every attempt — success or failure — is logged to EditLog, same pattern
 * as the login route's logLoginAttempt (src/app/api/auth/login/route.ts) —
 * including taking a pre-computed `auditTag` rather than the NextRequest,
 * since every call site below schedules this via after() instead of
 * awaiting it before responding (see that route's comment for why: an
 * unbounded await on this write used to be able to hang the whole request
 * whenever Google Sheets was slow). */
async function logResetAttempt(
  auditTag: string,
  outcome: "สำเร็จ" | "ล้มเหลว",
  username: string,
  reason?: string
): Promise<void> {
  try {
    const parts = [outcome === "ล้มเหลว" ? `เหตุผล: ${reason ?? "ไม่ทราบ"}` : null, auditTag].filter(
      (p): p is string => p !== null
    );
    await appendEditLog({
      timestamp: new Date().toISOString(),
      action: outcome === "สำเร็จ" ? "รีเซ็ตรหัสผ่านสำเร็จ" : "รีเซ็ตรหัสผ่านล้มเหลว",
      actor: username,
      department: "",
      oldValue: "",
      newValue: parts.join(" "),
    });
  } catch (err: unknown) {
    console.error("appendEditLog failed (reset-password):", err);
  }
}

/**
 * Self-service password reset — deliberately reachable with NO session,
 * unlike everything under /api/manage/*: this exists precisely for an
 * account that can't log in yet because it's still holding whatever default
 * password a superadmin/bootstrap account set for it through /manage/users.
 * Identity is proven by supplying that current/default password itself,
 * not by a cookie — there isn't one yet.
 *
 * Rate-limited under its own key namespace ("reset:...", vs. the login
 * route's bare "ip:username") so guessing wrong on one flow doesn't burn
 * through the other's attempt budget — same isLockedOut/recordFailedAttempt
 * in-memory map (src/lib/auth.ts), just partitioned by key.
 *
 * The bootstrap account (env-configured, no Users-tab row) simply never
 * matches in getUsers() below, so a reset attempt against it falls through
 * to the same generic "invalid" response as any wrong username — nothing
 * bootstrap-specific needed here, and its password stays something only
 * changed by editing BOOTSTRAP_SUPERADMIN_PASSWORD_HASH in the environment.
 */
export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "คำขอไม่ถูกต้อง" }, { status: 400 });
  }
  const submitted = readResetPayload(body);
  if (!submitted) {
    return NextResponse.json(
      { error: "ข้อมูลไม่ครบ — ต้องมีชื่อผู้ใช้ รหัสผ่านเริ่มต้น และรหัสผ่านใหม่ (อย่างน้อย 4 ตัวอักษร)" },
      { status: 400 }
    );
  }
  const { username, currentPassword, newPassword } = submitted;
  // Captured once up front — every EditLog write below is deferred via
  // after(), so nothing downstream touches `request` directly anymore.
  const auditTag = requestAuditTag(request);

  const rateLimitKey = `reset:${clientIp(request)}:${username}`;
  if (isLockedOut(rateLimitKey)) {
    after(() => logResetAttempt(auditTag, "ล้มเหลว", username, "ถูกล็อกชั่วคราว (พยายามผิดหลายครั้ง)"));
    return NextResponse.json(
      { error: "ลองรหัสผ่านเริ่มต้นผิดหลายครั้งเกินไป กรุณารอ 5 นาทีแล้วลองใหม่" },
      { status: 429 }
    );
  }

  try {
    const users = await getUsers();
    const user = users.find((u) => u.username === username && u.active);
    if (!user || !verifyPassword(currentPassword, user.passwordHash)) {
      recordFailedAttempt(rateLimitKey);
      after(() => logResetAttempt(auditTag, "ล้มเหลว", username, "ชื่อผู้ใช้หรือรหัสผ่านเริ่มต้นไม่ถูกต้อง"));
      return NextResponse.json({ error: "ชื่อผู้ใช้หรือรหัสผ่านเริ่มต้นไม่ถูกต้อง" }, { status: 401 });
    }
    // Identity confirmed — clear the attempt counter the same way the login
    // route does right after a credential match, so an earlier mistyped
    // guess doesn't count against this account once it's actually verified.
    clearAttempts(rateLimitKey);

    if (newPassword === currentPassword) {
      return NextResponse.json({ error: "รหัสผ่านใหม่ต้องไม่เหมือนกับรหัสผ่านเริ่มต้น" }, { status: 400 });
    }

    await updateUser(username, { passwordHash: hashPassword(newPassword) });
    // Any session already active for this account (lib/auth.ts's
    // registerNewSession/clearActiveSession, backed by lib/sessionStore.ts)
    // was established under the old password — release it so it can't keep
    // riding on a since-changed credential. The account's own next login
    // (with the new password) registers a fresh one as normal, same as any
    // other login.
    await clearActiveSession(username);

    after(() => logResetAttempt(auditTag, "สำเร็จ", username));
    return NextResponse.json({ ok: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
