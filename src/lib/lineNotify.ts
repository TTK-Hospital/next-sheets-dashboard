/**
 * ส่งข้อความ push เข้า LINE ผ่าน LINE Messaging API (ไม่ใช่ LINE Notify ซึ่งถูก
 * ปิดให้บริการไปแล้วตั้งแต่ 31 มี.ค. 2568 — ดูรายละเอียดสถาปัตยกรรมเต็มๆ ใน
 * docs/line-driver-notify-plan.md) — ใช้ channel เดียวกัน (LINE_CHANNEL_ACCESS_TOKEN)
 * ยิงไปสองปลายทางที่แยกจากกัน: กลุ่มคนขับ (notifyDriverGroup) และ ผอ. โดยตรง
 * (notifyDirector — เพิ่มทีหลัง ตามที่ขอ "อยากให้มีการแจ้งเตือนทาง line ให้กับ
 * ผอ.ได้รับทราบว่ามีการขอรถเข้ามาด้วยครับ" เมื่อฝ่ายบริหารจัดรถเสร็จและส่ง
 * รายการรอ ผอ. อนุมัติ).
 *
 * ต้องตั้งค่า environment variables ก่อนใช้งานได้จริง (ดูขั้นตอนเต็มใน
 * เอกสารข้างต้น — ต้องสร้าง LINE Official Account + เปิด Messaging API ก่อน
 * ไม่ใช่งานที่ทำในโค้ดนี้ได้):
 *   - LINE_CHANNEL_ACCESS_TOKEN — token ของ Messaging API channel (ใช้ร่วมกันทั้งสองปลายทาง)
 *   - LINE_DRIVER_GROUP_ID — Group ID ของกลุ่ม LINE คนขับที่เชิญบอทเข้าไปแล้ว
 *   - LINE_DIRECTOR_USER_ID — LINE user ID ของ ผอ. (แชท 1-1 กับ OA โดยตรง — เพิ่ม
 *     เพื่อนกับ OA นี้แล้วดึง userId ออกมาด้วยวิธีเดียวกับที่เอกสารข้างต้นแนะนำ
 *     สำหรับ groupId ก็ใช้ได้ — LINE push API รับ "to" เป็นได้ทั้ง userId/groupId
 *     เหมือนกัน จะตั้งเป็น group ที่ ผอ. อยู่ด้วยก็ได้ ไม่จำเป็นต้องเป็น userId
 *     ส่วนตัวเท่านั้น)
 *
 * ตั้งใจให้ "best-effort" เสมอ — ยังไม่ได้ตั้งค่า env var ที่จำเป็นก็ไม่ใช่
 * ข้อผิดพลาด (ข้ามเงียบๆ ระบบจองยังทำงานปกติทุกอย่าง แค่ไม่มีข้อความเด้งไป
 * LINE เท่านั้น) และถ้าเรียก LINE API แล้วล้มเหลว (token หมดอายุ, โควตาเต็ม,
 * เครือข่ายมีปัญหา) ก็จะไม่ throw ออกไปให้ผู้เรียกเห็นเช่นกัน — แค่ log ไว้ กัน
 * ไม่ให้ปัญหาฝั่ง LINE ทำให้การอนุมัติ/แก้ไข/ยกเลิกจองรถในระบบหลักล้มเหลวตามไป
 * ด้วย ผู้เรียกทุกจุด (ดู route handlers ที่เรียกใช้) จึงเรียกแบบ "fire and
 * forget" ได้เลยโดยไม่ต้องกัน error เพิ่มเอง
 */

const LINE_PUSH_ENDPOINT = "https://api.line.me/v2/bot/message/push";

// LINE จำกัดความยาวข้อความประเภท text ไว้ที่ 5,000 ตัวอักษรต่อข้อความ — ตัด
// ปลายทิ้งเป็นเกราะป้องกันสุดท้าย ไม่ควรมีข้อความไหนในระบบนี้ยาวขนาดนั้นจริงๆ
// อยู่แล้ว แต่กันไว้ไม่ให้ทั้งคำขอ push ถูก LINE ปฏิเสธเพราะยาวเกิน
const LINE_TEXT_MAX_LENGTH = 5000;

/** ยิง LINE push message หนึ่งข้อความไปที่ targetId (userId หรือ groupId ก็ได้
 * — LINE API ไม่แยกฟอร์แมต) — ใช้ภายในไฟล์นี้เท่านั้น ทั้ง notifyDriverGroup และ
 * notifyDirector ด้านล่างเรียกตัวนี้ตัวเดียว กัน fetch/error-handling ซ้ำกันสอง
 * ที่ ดูคอมเมนต์หัวไฟล์สำหรับ contract เต็มๆ (ไม่ throw) */
async function pushLineMessage(targetId: string, text: string): Promise<void> {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  try {
    const res = await fetch(LINE_PUSH_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        to: targetId,
        messages: [{ type: "text", text: text.slice(0, LINE_TEXT_MAX_LENGTH) }],
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[lineNotify] LINE push ล้มเหลว (${res.status}): ${body}`);
    }
  } catch (err: unknown) {
    console.error("[lineNotify] เรียก LINE API ไม่สำเร็จ:", err);
  }
}

/** ส่งข้อความ text หนึ่งข้อความเข้ากลุ่มคนขับที่ตั้งค่าไว้ (LINE_DRIVER_GROUP_ID)
 * — ดูคอมเมนต์หัวไฟล์สำหรับ contract เต็มๆ (ไม่ throw, ข้ามเงียบๆ ถ้ายังไม่ได้
 * ตั้งค่า) เรียกจาก route handler หลังบันทึกข้อมูลลง Sheets สำเร็จแล้วเท่านั้น
 * — ไม่เคย await ผลลัพธ์เพื่อตัดสินใจอย่างอื่นต่อ เพราะการแจ้งเตือนไม่ควรเป็น
 * เงื่อนไขว่าการดำเนินการหลักสำเร็จหรือไม่ */
export async function notifyDriverGroup(text: string): Promise<void> {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const groupId = process.env.LINE_DRIVER_GROUP_ID;
  if (!token || !groupId) {
    // ยังไม่ได้ตั้งค่า LINE Messaging API — ข้ามเงียบๆ ตามที่ออกแบบไว้ (ดู
    // คอมเมนต์หัวไฟล์) ไม่ log เป็น error เพราะนี่เป็นสถานะที่คาดไว้ได้ตามปกติ
    // ก่อนที่โรงพยาบาลจะตั้งค่า LINE OA เสร็จ (เฟส 0 ใน
    // docs/line-driver-notify-plan.md)
    return;
  }
  await pushLineMessage(groupId, text);
}

/** ส่งข้อความ text หนึ่งข้อความให้ ผอ. โดยเฉพาะ (LINE_DIRECTOR_USER_ID) — แยก
 * ปลายทางจาก notifyDriverGroup ข้างบน (คนละผู้รับ คนละ env var) แต่ใช้ channel
 * access token ตัวเดียวกัน เพิ่มเข้ามาตามที่ขอ "อยากให้มีการแจ้งเตือนทาง line
 * ให้กับผอ.ได้รับทราบว่ามีการขอรถเข้ามาด้วยครับ" — เรียกจาก route ที่ฝ่าย
 * บริหารออกใบสั่งงาน/เพิ่มคำขอเข้าใบสั่งงานเดิม (ดู
 * src/app/api/booking/trip-orders/route.ts และ .../[tripOrderId]/route.ts)
 * ทุกครั้งที่มีคำขอเข้าคิว "รอ ผอ. อนุมัติ" ใหม่ (directorApprovalStatus เปลี่ยน
 * เป็น "pending") เช่นเดียวกับ notifyDriverGroup — ไม่ throw, ข้ามเงียบๆ ถ้า
 * ยังไม่ได้ตั้งค่า */
export async function notifyDirector(text: string): Promise<void> {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const targetId = process.env.LINE_DIRECTOR_USER_ID;
  if (!token || !targetId) {
    return;
  }
  await pushLineMessage(targetId, text);
}

/** URL เต็มของหน้าปฏิทินงานคนขับ (/driver) — คำนวณจาก origin ของคำขอที่กำลัง
 * ประมวลผลอยู่ (request.nextUrl.origin) แทนการพึ่ง env var ตัวใหม่ เพราะ
 * origin ที่ถูกต้องมีอยู่แล้วในทุก request ที่เข้ามาที่ route handler เหล่านี้
 * (ใช้ได้ทั้ง production/preview deployment ของ Vercel โดยไม่ต้องตามอัปเดต
 * env var ทุกครั้งที่โดเมนเปลี่ยน) รองรับ path ทางเลือกผ่าน
 * DRIVER_CALENDAR_PATH เผื่ออยากเปลี่ยนจาก "/driver" ตรงๆ เป็น path ที่เดา
 * ยากกว่าภายหลัง (ดูข้อ 6 ใน docs/line-driver-notify-plan.md) — ไม่ตั้งค่า
 * ก็ใช้ "/driver" เป็นค่าเริ่มต้น */
export function driverCalendarUrl(origin: string): string {
  const path = process.env.DRIVER_CALENDAR_PATH || "/driver";
  return `${origin}${path}`;
}

/** URL เต็มของหน้าอนุมัติของ ผอ. (/director) — หลักการเดียวกับ driverCalendarUrl
 * ข้างบนทุกประการ (คำนวณจาก origin ของ request ไม่ใช่ env var ใหม่) แนบไปกับ
 * ข้อความแจ้งเตือนของ notifyDirector ให้กดเข้าไปอนุมัติได้ทันที — หน้านี้ยังต้อง
 * ล็อกอินด้วยรหัสผ่านอยู่เสมอ (ดู lib/directorAuth.ts) ลิงก์นี้แค่พาไปหน้า
 * login เท่านั้น ไม่ได้ bypass การล็อกอิน */
export function directorApprovalUrl(origin: string): string {
  return `${origin}/director`;
}
