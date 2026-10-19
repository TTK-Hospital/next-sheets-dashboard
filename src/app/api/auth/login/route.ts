import { NextRequest, NextResponse, after } from "next/server";
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  clearAttempts,
  clientIp,
  createSessionToken,
  isLockedOut,
  recordFailedAttempt,
  registerNewSession,
  requestAuditTag,
  verifyPassword,
  type Role,
} from "@/lib/auth";
import type { PermissionKey } from "@/lib/permissions";
import { appendEditLog, getUsers } from "@/lib/sheets";

// Never cache/prerender — checks live rate-limit + credential state.
export const dynamic = "force-dynamic";

/** Every login attempt — success or failure — is written to EditLog, per
 * the hospital's request to log everything from login onward. A logging
 * failure never blocks the actual login outcome.
 *
 * Takes a pre-computed `auditTag` (see requestAuditTag) rather than the
 * NextRequest itself — every call site now schedules this via `after()`
 * (see the POST handler below) instead of awaiting it before responding, so
 * the request object shouldn't be relied on inside this deferred callback;
 * capturing the one string it actually needs out of it beforehand sidesteps
 * that entirely. See the POST handler's comment for why this got deferred:
 * a slow/stuck Google Sheets write here used to be able to hang the whole
 * login response, even for the bootstrap account, which otherwise never
 * touches Sheets at all to authenticate. */
async function logLoginAttempt(
  auditTag: string,
  outcome: "สำเร็จ" | "ล้มเหลว",
  detail: { username: string; role?: Role; department?: string; isBootstrap?: boolean; reason?: string }
): Promise<void> {
  try {
    const parts = [
      outcome === "สำเร็จ"
        ? `สิทธิ์: ${detail.role}${detail.isBootstrap ? " (bootstrap)" : ""}`
        : `เหตุผล: ${detail.reason ?? "ไม่ทราบ"}`,
      auditTag,
    ];
    await appendEditLog({
      timestamp: new Date().toISOString(),
      action: outcome === "สำเร็จ" ? "เข้าสู่ระบบสำเร็จ" : "เข้าสู่ระบบล้มเหลว",
      actor: detail.username,
      department: detail.department ?? "",
      oldValue: "",
      newValue: parts.join(" "),
    });
  } catch (err: unknown) {
    console.error("appendEditLog failed (login):", err);
  }
}

function readCredentials(body: unknown): { username: string; password: string } | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (typeof b.username !== "string" || typeof b.password !== "string") return null;
  if (!b.username.trim() || !b.password) return null;
  return { username: b.username.trim(), password: b.password };
}

interface Matched {
  username: string;
  role: Role;
  department: string;
  isBootstrap: boolean;
  /** See the displayName comment on SessionPayload (lib/auth.ts) — looked
   * up once, right here, from the very same Users-tab row this function
   * already fetched to check the password, so it costs nothing extra. */
  displayName: string;
  /** Per-account permission overrides (see lib/permissions.ts), carried
   * into the session the same way displayName is — omitted (not just
   * empty-array) for the bootstrap account, which has no Users-tab row and
   * is immune to revocation/needs no grants anyway. */
  extraPermissions?: PermissionKey[];
  revokedPermissions?: PermissionKey[];
}

/** The bootstrap account (env-configured) always works, independent of the
 * Users sheet tab — guarantees there's always a way in even if that tab is
 * empty, missing, or every real superadmin gets accidentally deactivated.
 * Once logged in, use it to create real accounts via /manage/users. */
function checkBootstrapAccount(username: string, password: string): Matched | null {
  const bootstrapUsername = process.env.BOOTSTRAP_SUPERADMIN_USERNAME;
  const bootstrapHash = process.env.BOOTSTRAP_SUPERADMIN_PASSWORD_HASH;
  if (!bootstrapUsername || !bootstrapHash) return null;
  if (username !== bootstrapUsername) return null;
  if (!verifyPassword(password, bootstrapHash)) return null;
  // No Users-tab row backs the bootstrap account, so there's no display
  // name to look up — the bare username is the best available label.
  return { username, role: "superadmin", department: "", isBootstrap: true, displayName: username };
}

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "คำขอไม่ถูกต้อง" }, { status: 400 });
  }
  const credentials = readCredentials(body);
  if (!credentials) {
    return NextResponse.json({ error: "กรุณาระบุชื่อผู้ใช้และรหัสผ่าน" }, { status: 400 });
  }
  const { username, password } = credentials;
  // Captured once up front — every EditLog write below is deferred via
  // after() (see the comment on logLoginAttempt), so nothing downstream
  // touches `request` directly anymore.
  const auditTag = requestAuditTag(request);

  const rateLimitKey = `${clientIp(request)}:${username}`;
  if (isLockedOut(rateLimitKey)) {
    after(() =>
      logLoginAttempt(auditTag, "ล้มเหลว", {
        username,
        reason: "ถูกล็อกชั่วคราว (พยายามผิดหลายครั้ง)",
      })
    );
    return NextResponse.json(
      { error: "ลองรหัสผ่านผิดหลายครั้งเกินไป กรุณารอ 5 นาทีแล้วลองใหม่" },
      { status: 429 }
    );
  }

  let matched = checkBootstrapAccount(username, password);

  if (!matched) {
    try {
      const users = await getUsers();
      const user = users.find((u) => u.username === username && u.active);
      if (user && verifyPassword(password, user.passwordHash)) {
        // Always false here — even a "superadmin" role user from the
        // Users tab is not the bootstrap account, so it can't manage
        // other users. See the isBootstrap comment on SessionPayload.
        matched = {
          username: user.username,
          role: user.role,
          department: user.department,
          isBootstrap: false,
          displayName: user.displayName || user.username,
          extraPermissions: user.extraPermissions,
          revokedPermissions: user.revokedPermissions,
        };
      }
    } catch (err: unknown) {
      // Users tab missing/misconfigured — fall through to the generic
      // failure below instead of leaking sheet-structure details to an
      // unauthenticated caller. The bootstrap account above still works
      // regardless of this tab's state.
      console.error("getUsers failed during login:", err);
    }
  }

  if (!matched) {
    recordFailedAttempt(rateLimitKey);
    after(() =>
      logLoginAttempt(auditTag, "ล้มเหลว", {
        username,
        reason: "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง",
      })
    );
    return NextResponse.json({ error: "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง" }, { status: 401 });
  }

  clearAttempts(rateLimitKey);
  // One active session per account (lib/auth.ts's activeSessions map) — this
  // mints a fresh sessionId and registers it as the sole active one for
  // `matched.username`, silently superseding whatever session (on another
  // device/browser) was active before it. Per the hospital's explicit
  // choice: logging in elsewhere kicks the old session out immediately,
  // rather than blocking this new login while an old one is still active.
  const sessionId = await registerNewSession(matched.username);
  const token = createSessionToken({ ...matched, sessionId });
  // Deferred via after() — this is the fix for logins (bootstrap account
  // especially) hanging for a long time when the Sheets API write is slow:
  // this EditLog write used to be awaited *before* the response was built
  // and sent, so any slowness or hiccup on Google's end stalled the entire
  // login for however long that write took, with no timeout on it at all.
  // after() runs it once the response has already gone out to the browser
  // (and, on Vercel, keeps the function alive long enough for it to finish
  // via waitUntil under the hood) — a slow write no longer blocks anyone
  // from getting in.
  after(() =>
    logLoginAttempt(auditTag, "สำเร็จ", {
      username: matched.username,
      role: matched.role,
      department: matched.department,
      isBootstrap: matched.isBootstrap,
    })
  );

  const response = NextResponse.json({ ok: true, role: matched.role, department: matched.department });
  response.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
  return response;
}
