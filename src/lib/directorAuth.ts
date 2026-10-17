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
// ตัวเลือก "จำรหัสผ่าน" บนหน้า login (ตามที่ขอ "ให้มีการเลือกจำรหัสผ่านเพิ่ม
// ด้วยครับ") — ไม่ได้เก็บรหัสผ่านจริงไว้ที่ไหนเลย (ยังต้องกรอกรหัสผ่านถูกต้อง
// ตอน login เสมอ) แค่ขยาย sliding idle timeout ด้านบนจาก 20 นาทีเป็น 30 วัน
// ให้คุกกี้เซสชันไม่หมดอายุเร็วจนต้องพิมพ์รหัสผ่านใหม่ทุกครั้งที่ไม่ได้เปิดหน้า
// นี้ทิ้งไว้ติดกัน — ยังเป็น sliding (ต่ออายุทุก API call ที่ผ่าน
// verifyDirectorSessionToken เหมือนเดิมทุกประการ) แค่หน้าต่างกว้างขึ้นมาก
const DIRECTOR_REMEMBER_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 วัน (ติ๊ก "จำรหัสผ่าน")
export const DIRECTOR_SESSION_COOKIE = "director_session";
export const DIRECTOR_SESSION_MAX_AGE_SECONDS = DIRECTOR_SESSION_TTL_MS / 1000;
export const DIRECTOR_REMEMBER_MAX_AGE_SECONDS = DIRECTOR_REMEMBER_TTL_MS / 1000;

interface DirectorSessionPayload {
  purpose: "director";
  exp: number;
  /** true ถ้าตอน login ติ๊ก "จำรหัสผ่าน" ไว้ — คุม TTL/maxAge ของคุกกี้เท่านั้น
   * (ดูคอมเมนต์ที่ DIRECTOR_REMEMBER_TTL_MS ด้านบน) ไม่มีผลต่อสิ่งอื่นใด เก็บไว้
   * ในตัว payload เอง (ไม่ใช่แค่ตอน login) เพื่อให้ทุกจุดที่ต่ออายุคุกกี้แบบ
   * sliding (setDirectorSessionCookie ด้านล่าง ผ่าน route อื่นๆ ภายใต้
   * /api/director/*) รู้ว่าต้องต่ออายุด้วย TTL ไหนต่อไป โดยไม่ต้องส่งค่านี้
   *แยกมาจากที่อื่นอีก — ดู getDirectorSessionRemember ด้านล่าง. */
  remember: boolean;
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

export function createDirectorSessionToken(remember: boolean = false): string {
  const ttl = remember ? DIRECTOR_REMEMBER_TTL_MS : DIRECTOR_SESSION_TTL_MS;
  const payload: DirectorSessionPayload = { purpose: "director", exp: Date.now() + ttl, remember };
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${payloadB64}.${sign(payloadB64)}`;
}

/** Signature + expiry check เต็มรูป คืนค่า payload ที่ถอดแล้วถ้าผ่านทุกขั้น
 * (null ถ้าไม่ผ่านขั้นไหนก็ตาม) — verifyDirectorSessionToken/
 * getDirectorSessionRemember ด้านล่างทั้งสองฟังก์ชันเรียกตัวนี้ตัวเดียว กัน
 * ตรรกะตรวจ signature/expiry ซ้ำกันสองที่ (เคยเป็นแบบนั้นมาก่อน ตอนยังไม่มี
 * ฟีเจอร์ "จำรหัสผ่าน" ที่ต้องอ่านค่า remember จาก token เดิมด้วย). */
function decodeDirectorSessionPayload(token: string | undefined | null): DirectorSessionPayload | null {
  if (!token) return null;
  const dotIndex = token.indexOf(".");
  if (dotIndex === -1) return null;
  const payloadB64 = token.slice(0, dotIndex);
  const sig = token.slice(dotIndex + 1);
  if (!payloadB64 || !sig) return null;

  let sigBuf: Buffer;
  let expectedBuf: Buffer;
  try {
    sigBuf = Buffer.from(sig, "hex");
    expectedBuf = Buffer.from(sign(payloadB64), "hex");
  } catch {
    return null;
  }
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) return null;

  let payload: DirectorSessionPayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (payload.purpose !== "director" || typeof payload.exp !== "number") return null;
  if (Date.now() > payload.exp) return null;
  return payload;
}

/** Signature + expiry only — เหมือน verifySessionTokenWithReason ของ
 * lib/auth.ts แต่ไม่มีอะไรให้ return นอกจาก true/false (ไม่มี username/role/
 * department ให้เก็บ — ผอ. มีบัญชีเดียว ไม่ต้องรู้ว่า "ใคร" อีกแล้วเมื่อผ่าน
 * ขั้นรหัสผ่านมาได้). */
export function verifyDirectorSessionToken(token: string | undefined | null): boolean {
  return decodeDirectorSessionPayload(token) !== null;
}

/** อ่านค่าตัวเลือก "จำรหัสผ่าน" จาก token เดิมที่แนบมากับ request — ใช้ตอน
 * ต่ออายุคุกกี้แบบ sliding ใน route อื่นๆ ภายใต้ /api/director/* (ดู
 * setDirectorSessionCookie ด้านล่าง) เพื่อให้ TTL ที่ต่ออายุให้ตรงกับตัวเลือก
 * เดิมที่ ผอ. กดไว้ตอน login เสมอ ไม่ใช่กลับไปเป็นค่าเริ่มต้น (20 นาที) กลาง
 * ครันทุกครั้งที่มีการเรียก API อื่นที่ไม่ใช่ login เอง — token ที่ตรวจไม่ผ่าน
 * (ไม่ควรเกิด เพราะ route เรียก verifyDirectorSessionToken ก่อนเสมอแล้ว) ถือว่า
 * false ไว้ก่อน ปลอดภัยกว่า (TTL สั้นกว่าที่ควรจะเป็น ไม่ใช่ยาวกว่า). */
export function getDirectorSessionRemember(token: string | undefined | null): boolean {
  return decodeDirectorSessionPayload(token)?.remember ?? false;
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
 * /director ไม่ผ่าน proxy.ts เลย จึงต้องทำเองตรงนี้แทน (ดูคอมเมนต์หัวไฟล์).
 *
 * `remember` — ตัวเลือก "จำรหัสผ่าน" ตอน login (ดูคอมเมนต์ที่
 * DIRECTOR_REMEMBER_TTL_MS ด้านบน) ทุก route ที่ไม่ใช่ login เอง *ต้อง* ส่งค่า
 * นี้มาจาก getDirectorSessionRemember(token เดิม) ไม่ใช่ปล่อย default — ไม่งั้น
 * การต่ออายุแบบ sliding ทุกครั้งที่เรียก API อื่นจะดึง TTL กลับไปเป็น 20 นาที
 * ทันที ทำให้ตัวเลือก "จำรหัสผ่าน" ไม่มีผลจริงหลัง API call แรกที่ไม่ใช่ login. */
export function setDirectorSessionCookie(response: NextResponse, remember: boolean = false): void {
  response.cookies.set(DIRECTOR_SESSION_COOKIE, createDirectorSessionToken(remember), {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: remember ? DIRECTOR_REMEMBER_MAX_AGE_SECONDS : DIRECTOR_SESSION_MAX_AGE_SECONDS,
  });
}

export function clearDirectorSessionCookie(response: NextResponse): void {
  response.cookies.set(DIRECTOR_SESSION_COOKIE, "", { path: "/", maxAge: 0 });
}
