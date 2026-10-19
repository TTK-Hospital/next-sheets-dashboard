import { NextResponse } from "next/server";
import { getDriverTrips } from "@/lib/sheets";

// เที่ยวรถ/สถานะยกเลิกเปลี่ยนได้ตลอดเวลา — ห้าม cache เหมือน route อื่นๆ ที่
// อ่าน Bookings/TripOrders ในระบบนี้ (ดู /api/booking/bookings,
// /api/booking/trip-orders)
export const dynamic = "force-dynamic";

/**
 * สาธารณะ — ไม่เช็ก session cookie เลย (ต่างจากทุก route อื่นใต้
 * /api/booking/... โดยตั้งใจ) เพื่อให้หน้า /driver (ปฏิทินงานคนขับ) เปิดดูได้
 * จากลิงก์ในข้อความ LINE ทันทีโดยไม่ต้องล็อกอิน ตามที่ออกแบบไว้ใน
 * docs/line-driver-notify-plan.md
 *
 * ตัว page.tsx ของ /driver เองเรียก getDriverTrips() ตรงๆ ฝั่งเซิร์ฟเวอร์อยู่
 * แล้วสำหรับการเรนเดอร์ครั้งแรก — endpoint นี้มีไว้ให้ DriverCalendar.tsx
 * (client component) เรียกซ้ำเป็นระยะเพื่อรีเฟรชข้อมูลโดยไม่ต้องโหลดหน้าใหม่
 * ทั้งหน้า ใช้ getDriverTrips() ตัวเดียวกันทั้งสองทาง กันสองจุดคำนวณเพี้ยนไป
 * จากกัน — ดูคอมเมนต์เต็มที่ getDriverTrips ใน lib/sheets.ts สำหรับรายละเอียด
 * ว่ากรอง/ตัดข้อมูลอะไรออกบ้าง (โดยเฉพาะเบอร์โทรผู้จอง)
 */
export async function GET() {
  try {
    const trips = await getDriverTrips();
    return NextResponse.json({ trips });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
