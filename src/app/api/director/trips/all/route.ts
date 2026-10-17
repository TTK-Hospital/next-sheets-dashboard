import { NextRequest, NextResponse } from "next/server";
import { DIRECTOR_SESSION_COOKIE, setDirectorSessionCookie, verifyDirectorSessionToken } from "@/lib/directorAuth";
import { getDirectorAllTrips } from "@/lib/sheets";

// ข้อมูลเปลี่ยนได้ตลอด เหมือน ../route.ts (รายการรออนุมัติ) — ห้าม cache
export const dynamic = "force-dynamic";

/** รายการจองรถที่ "ผ่านมือ ผอ. มาแล้ว" ทั้งหมด (รออยู่ + อนุมัติ/ไม่อนุมัติไป
 * แล้ว) — ไม่ใช่แค่ที่ยัง "pending" เหมือน GET ../route.ts ใช้สำหรับมุมมอง
 * "ปฏิทิน" ของหน้า /director โดยเฉพาะ (ดู getDirectorAllTrips ใน lib/sheets.ts
 * สำหรับเหตุผลเต็ม) — ยังต้องผ่าน session หน้า /director เหมือนกันทุกประการ
 * แยก endpoint ต่างหากจาก ../route.ts เพื่อไม่ให้มุมมอง "รายการ" (ที่ใช้เป็น
 * คิวงานต้องทำ) ต้องรับข้อมูลที่ไม่เกี่ยวข้อง (ประวัติ) มาด้วยทุกครั้งที่ poll
 * โดยไม่จำเป็น — ฝั่ง UI เลือกเรียก endpoint นี้เฉพาะตอนเปิดมุมมองปฏิทินเท่านั้น
 * (ดู DirectorDashboard.tsx). */
export async function GET(request: NextRequest) {
  const token = request.cookies.get(DIRECTOR_SESSION_COOKIE)?.value;
  if (!verifyDirectorSessionToken(token)) {
    return NextResponse.json({ error: "กรุณาเข้าสู่ระบบ" }, { status: 401 });
  }

  try {
    const trips = await getDirectorAllTrips();
    const response = NextResponse.json({ trips });
    setDirectorSessionCookie(response);
    return response;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
