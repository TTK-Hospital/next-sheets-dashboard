import { NextRequest, NextResponse } from "next/server";
import { DIRECTOR_SESSION_COOKIE, setDirectorSessionCookie, verifyDirectorSessionToken } from "@/lib/directorAuth";
import { getDirectorPendingTrips } from "@/lib/sheets";

// ข้อมูลเปลี่ยนได้ตลอด (มีรายการใหม่ทุกครั้งที่ผู้ดูแลระบบจัดรถ) — ห้าม cache
// หน้านี้ เหมือน /api/public/driver-trips และ /api/booking/* ทั้งหมด
export const dynamic = "force-dynamic";

/** รายการจองรถที่รอ ผอ. อนุมัติ — ดู DirectorTripItem/getDirectorPendingTrips
 * ใน lib/sheets.ts สำหรับเนื้อหาเต็ม (คัดเฉพาะฟิลด์ที่ ผอ. ต้องเห็นจริงๆ ตามที่
 * ขอ "ไม่มีรายละเอียดเยอะเกินความจำเป็น"). ต้องผ่าน session หน้า /director
 * เอง — ดูคอมเมนต์หัวไฟล์ lib/directorAuth.ts ว่าทำไมแยกจาก manage_session/
 * proxy.ts โดยสิ้นเชิง. */
export async function GET(request: NextRequest) {
  const token = request.cookies.get(DIRECTOR_SESSION_COOKIE)?.value;
  if (!verifyDirectorSessionToken(token)) {
    return NextResponse.json({ error: "กรุณาเข้าสู่ระบบ" }, { status: 401 });
  }

  try {
    const trips = await getDirectorPendingTrips();
    const response = NextResponse.json({ trips });
    setDirectorSessionCookie(response); // sliding idle timeout
    return response;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
