import { createHmac, timingSafeEqual } from "crypto";
import type { NextResponse } from "next/server";

/**
 * Session handling for /director (หน้าอนุมัติ/รับทราบการเดินทางของ ผอ. — ดู
 * src/app/director/page.tsx) — เขียนแยกจาก lib/auth.ts ทั้งหมด ไม่ใช้
 * SessionPayload/Role-based session เดิมเลย ด้วยเหตุผล 2 อย่าง:
 *
 * 1. ผอ. ไม่มี username เลย (ตามที่ขอ "ไม่ต้องกรอก user เนื่องจากมีผู้ใช้งาน
 *    หน้านี้เพียงท่านเดียว") — SessionPayload เดิมบังคับมี username/role เป็น
 *    หนึ่งใน "superadmin"|"admin"|"user" เท่านั้น (ดู verifySessionTokenWithReason
 *    ใน lib/auth.ts) การยัด ผอ. เข้าไปเป็น role ที่ 4 จะกระทบ type guard นั้น
 *    และทุกจุดที่ switch บน Role ทั่วทั้งแอป ทั้งที่ ผอ. ไม่ได้ต้องการสิทธิ์
 *    อะไรจากระบบสิทธิ์เดิมเลยสักอย่าง (ไม่ใช้ hasPermission, ไม่ผ่าน proxy.ts)
 * 2. /director ตั้งใจแยกออกจากระบบหลักโดยสิ้นเชิง เหมือน /driver (ดูคอมเมนต์
 *    ที่ src/app/driver/page.tsx) — ไม่ผ่าน proxy.ts เลย (ดู config.matcher ใน
 *    proxy.ts ว่าคุมแค่ /manage, /booking, /menu และ API ของสองหน้านั้น) จึง
 *    ต้องเช็ค session ของตัวเองในทุก API route ภายใต้ /api/director/* เอง
 *    (ดู requireDirectorSession ด้านล่าง) แทนที่จะพึ่ง proxy.ts ให้ครอบคลุม.
 *
 * Token เป็น scheme เดียวกับ manage_session (base64url(JSON) + "." +
 * HMAC-SHA256 hex) แต่เซ็นด้วย "director:" prefix กันเอาไปใช้สวมรอยเป็น
 * manage_session หรือกลับกัน แม้จะใช้ secret ตัวเดียวกัน (EDIT_SESSION_SECRET
 * — ไม่อยากเพิ่ม env var ใหม่อีกตัวสำหรับ session ของหน้านี้โดยเฉพาะ).
 */

// ผอ. อาจรับทราบหลายรายการต่อเนื่องในครั้งเดียว ("คลิ๊กไม่กี่คลิ๊ก...ในครั้ง
// เดียว") ให้เวลานานกว่า manage_session (5 นาที) เล็กน้อย แต่ยังเป็น sliding
// idle timeout เหมือนกัน — ทุก API call ที่ผ่าน requireDirectorSession จะได้
// คุกกี้ใหม่อายุเต็มกลับไปเสมอ (เหมือนที่ proxy.ts ทำให้ manage_session ทุก
// request) ไม่ใช่แค่ตอน login.
const DIRECTOR_SESSION_TTL_MS = 20 * 60 * 1000; // 20 นาที ไม่มีการใช้งาน
export const DIRECTOR_SESSION_COOKIE = "director_session";
export const DIRECTOR_SESSION_MAX_AGE_SECONDS = DIRECTOR_SESSION_TTL_MS / 1000;

interface DirectorSessionPayload {
  purpose: "director";
  exp: number;
}

function getSessionSecret(): string {
  const secret = process.env.EDIT_SESSION_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error(
      "ไม่พบ EDIT_SESSION_SECRET ที่ยาวพอใน .env.local (ต้องเป็นสตริงสุ่มอย่างน้อย 16 ตัวอักษร) — จำเป็นสำหรับเซ็นชื่อ session หน้า ผอ. ด้วยเช่นกัน"
    );
  }
  return secret;
}

function sign(payloadB64: string): string {
  // "director:" prefix — ดูคอมเมนต์หัวไฟล์ว่าทำไมต้องมี แม้ secret จะเป็น
  // ตัวเดียวกับ manage_session.
  return createHmac("sha256", getSessionSecret()).update(`director:${payloadB64}`).digest("hex");
}

export function createDirectorSessionToken(): string {
  const payload: DirectorSessionPayload = { purpose: "director", exp: Date.now() + DIRECTOR_SESSION_TTL_MS };
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${payloadB64}.${sign(payloadB64)}`;
}

/** Signature + expiry only — เหมือน verifySessionTokenWithReason ของ
 * lib/auth.ts แต่ไม่มีอะไรให้ return นอกจาก true/false (ไม่มี username/role/
 * department ให้เก็บ — ผอ. มีบัญชีเดียว ไม่ต้องรู้ว่า "ใคร" อีกแล้วเมื่อผ่าน
 * ขั้นรหัสผ่านมาได้). */
export function verifyDirectorSessionToken(token: string | undefined | null): boolean {
  if (!token) return false;
  const dotIndex = token.indexOf(".");
  if (dotIndex === -1) return false;
  const payloadB64 = token.slice(0, dotIndex);
  const sig = token.slice(dotIndex + 1);
  if (!payloadB64 || !sig) return false;

  let sigBuf: Buffer;
  let expectedBuf: Buffer;
  try {
    sigBuf = Buffer.from(sig, "hex");
    expectedBuf = Buffer.from(sign(payloadB64), "hex");
  } catch {
    return false;
  }
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) return false;

  let payload: DirectorSessionPayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return false;
  }
  if (payload.purpose !== "director" || typeof payload.exp !== "number") return false;
  if (Date.now() > payload.exp) return false;
  return true;
}

// --- Rate limiting (in-memory, per process) ---
// Key แยกต่างหากจาก lib/auth.ts's attempts map (ใช้ prefix "director:" ตอน
// เรียกจาก route — ดู login/route.ts) เพื่อไม่ให้คนพยายามเดารหัสผ่านหน้านี้
// กระทบ lockout ของบัญชี manage_session อื่นที่ IP เดียวกันบังเอิญใช้อยู่ (หรือ
// กลับกัน). Map เดียวกันนี้ยังถูกใช้ร่วมกับ reset-password ด้วย (คนละ key
// prefix) กันทั้งสองทางถูกบรูทฟอร์ซพร้อมกันไม่จำกัด.
interface AttemptState {
  count: number;
  lockedUntil: number;
}
const directorAttempts = new Map<string, AttemptState>();
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 5 * 60 * 1000; // 5 นาที

export function isDirectorLockedOut(key: string): boolean {
  const state = directorAttempts.get(key);
  if (!state) return false;
  if (state.lockedUntil && Date.now() < state.lockedUntil) return true;
  if (state.lockedUntil && Date.now() >= state.lockedUntil) directorAttempts.delete(key);
  return false;
}

export function recordDirectorFailedAttempt(key: string): void {
  const state = directorAttempts.get(key) ?? { count: 0, lockedUntil: 0 };
  state.count += 1;
  if (state.count >= MAX_ATTEMPTS) {
    state.lockedUntil = Date.now() + LOCKOUT_MS;
    state.count = 0;
  }
  directorAttempts.set(key, state);
}

export function clearDirectorAttempts(key: string): void {
  directorAttempts.delete(key);
}

/** คุกกี้อายุเต็มใหม่เสมอ — เรียกจากทุก API route ภายใต้ /api/director/* ที่
 * ผ่าน verifyDirectorSessionToken สำเร็จ (ไม่ใช่แค่ตอน login) ให้ได้ sliding
 * idle timeout เหมือน manage_session ที่ proxy.ts ทำให้ทุก request — แต่
 * /director ไม่ผ่าน proxy.ts เลย จึงต้องทำเองตรงนี้แทน (ดูคอมเมนต์หัวไฟล์). */
export function setDirectorSessionCookie(response: NextResponse): void {
  response.cookies.set(DIRECTOR_SESSION_COOKIE, createDirectorSessionToken(), {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: DIRECTOR_SESSION_MAX_AGE_SECONDS,
  });
}

export function clearDirectorSessionCookie(response: NextResponse): void {
  response.cookies.set(DIRECTOR_SESSION_COOKIE, "", { path: "/", maxAge: 0 });
}
