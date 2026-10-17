"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Bell, CheckCircle2, DoorOpen, Loader2, Scissors, Truck, X as XIcon } from "lucide-react";
import {
  BOOKING_NOTICE_EVENT,
  formatBookingDateTime,
  isBookingCancelled,
  TRIP_ORDER_CHANGED_EVENT,
  type Booking,
  type BookingResource,
  type Driver,
  type TripOrder,
} from "@/lib/booking";
import TripOrderModal from "@/components/TripOrderModal";

// No websocket/push available — the backend is Google Sheets, read on
// every request — so "live" here means polling. True real-time would need
// an external pub/sub service (Pusher/Ably/Supabase Realtime etc.), which
// needs its own account + API keys; per explicit choice, faster polling is
// the tradeoff instead — every 15 seconds, still per authenticated screen
// (this mounts once per session via AppShell) rather than a true push.
const POLL_INTERVAL_MS = 15_000;
const TOAST_DURATION_MS = 6000;

interface Toast {
  id: string;
  text: string;
  // "pending" (ค่าเริ่มต้น เมื่อไม่ระบุ) = มีคำขอรถรออนุมัติใหม่ (เฉพาะบัญชีที่
  // เห็นกระดิ่งนี้) คลิกแล้วเปิดแผงกระดิ่ง — "approved" = การจองรถของ "ตัวเอง"
  // เพิ่งได้รับการอนุมัติ (ทุกคนเห็น) คลิกแล้วพาไปหน้าจองรถแทน — "room" = มีการ
  // จอง/ยกเลิกห้องประชุมใหม่ (ทุกแผนก เฉพาะบัญชีที่เห็นกระดิ่งนี้เหมือน
  // "pending") คลิกแล้วพาไปหน้าจองห้องประชุมแทน — เพิ่มภายหลังตามที่ขอ ("อยากให้
  // เป็นช่องแจ้งเตือนหลายอย่างเท่าที่ทำได้และเหมาะสม ไม่ใช่แค่การจองรถ") — "split"
  // = การจองรถของ "ตัวเอง" ถูกแยกออกจากใบสั่งงานเดินทางเดิม กลับไปเป็น
  // "รออนุมัติ" แล้ว (ทุกคนเห็น เหมือน "approved") เพิ่มภายหลังตามที่ขอ ("ต้องมี
  // การแจ้งเตือนไปยังผู้จองได้รับทราบ") คลิกแล้วพาไปหน้าจองรถเหมือน "approved"
  // ไอคอน/ปลายทางคลิกต่างกันตามชนิดนี้ — ดู render ของ toast ด้านล่าง
  kind?: "approved" | "room" | "split";
}

/**
 * ลอยอยู่เหนือทุกหน้า (mounted once ผ่าน AppShell) หกส่วนที่แยกกันชัดเจน — เดิม
 * ผูกอยู่กับ "การจองรถรออนุมัติ" อย่างเดียว แต่ตามที่ขอภายหลัง ("ไม่อยากให้มีไว้
 * เพื่อแจ้งเฉพาะการจองรถ อยากให้เป็นช่องแจ้งเตือนหลายอย่างเท่าที่ทำได้และ
 * เหมาะสม") จึงเพิ่มส่วนที่ 4 (ห้องประชุม) เข้ามาด้วย — หัวข้อ/aria-label ต่างๆ
 * ในกระดิ่งจึงเปลี่ยนจาก "การจองรถรออนุมัติ" เป็นคำกลางๆ ("การแจ้งเตือน") แทน
 * ให้รองรับหลายประเภทได้ในกระดิ่งเดียว ต่อมา (ตามที่ขอเพิ่มอีกครั้ง — "ต้องมีการ
 * แจ้งเตือนไปยังผู้จองได้รับทราบผ่านหน้าต่างแจ้งเตือน") ตัวกระดิ่งเองก็เปิดให้
 * "ทุกบัญชี" เห็นแล้ว (เดิมเห็นเฉพาะบัญชีที่ `enabled` เท่านั้น) พร้อมเพิ่มส่วนที่
 * 5-6 (แยกรายการ + กิจกรรมส่วนตัวของทุกบัญชี):
 *
 * 1. กระดิ่งแจ้งเตือนคำขอจองรถรออนุมัติ ("รถรออนุมัติ") — เฉพาะบัญชีที่มีสิทธิ์
 *    อนุมัติการจองรถ (ดู canApproveCarBooking ใน lib/booking.ts; `enabled`
 *    คำนวณจาก session/currentUser ของแต่ละ AppShell caller เอง) เท่านั้นที่เห็น
 *    หัวข้อย่อยนี้ในแผง — ส่วนอื่นของแผง (ตัวกระดิ่งเอง, ส่วนที่ 6) เห็นได้ทุก
 *    บัญชีแล้ว (ดูคอมเมนต์ย่อหน้าบน) "ไม่อนุมัติ" ยังเรียก PATCH
 *    /api/booking/bookings/[bookingId] ตรงๆ (การตัดสินใจแบบกดครั้งเดียวเหมือน
 *    เดิม) "จัดรถ" ไม่ได้เปลี่ยนสถานะตรงนี้อีกต่อไป — เปิด TripOrderModal ตัว
 *    เดียวกับที่หน้าจองรถใช้แทน เพื่อให้การจัดรถจากป็อปอัปนี้ยังผ่านเส้นทาง
 *    เดียวที่ถูกต้องเสมอ (รถ+คนขับ+เวลา -> POST /api/booking/trip-orders) แทน
 *    การเรียก approve ตรงๆ แบบเก่าที่เซิร์ฟเวอร์ปฏิเสธไปแล้ว
 *
 * 2. Toast แจ้งผลการจองรถของ "ตัวเอง" — ทุกบัญชีเห็น (ไม่ผูกกับ `enabled`
 *    เลย) สองเหตุการณ์: (ก) คำขอจองรถของบัญชีนี้เปลี่ยนจาก "รออนุมัติ" เป็น
 *    "อนุญาต" (มีคนออกใบสั่งงานเดินทางให้แล้ว) — เด้ง toast บอกรายละเอียดรถ/
 *    คนขับที่จัดให้ ตามที่โรงพยาบาลขอ, (ข) คำขอจองรถของบัญชีนี้เปลี่ยนกลับจาก
 *    "อนุญาต" เป็น "รออนุมัติ" (ถูกแยกออกจากใบสั่งงานเดิม — เพิ่มภายหลังตามที่
 *    ขอ) — เด้ง toast บอกว่าคำขอนี้ต้องรอออกใบสั่งงานใหม่ ทั้งสองเหตุการณ์
 *    persist เข้าส่วนที่ 6 (กิจกรรมของฉัน) ด้วยเสมอ ไม่ใช่แค่ toast 6 วินาที
 *    ที่หายไปเฉยๆ (เพิ่มภายหลังตามที่ขอเช่นกัน) — ใช้ ref แยกต่างหาก
 *    (seenBookingStatuses) ติดตามสถานะล่าสุดที่เคยเห็นของแต่ละคำขอ (pending/
 *    approved) แยกทางกันตามทิศทางการเปลี่ยน ไม่เกี่ยวกับ seenIds ของส่วนที่ 1
 *    เลย ใช้ toast stack เดียวกัน (ด้านล่างสุดขวา) กับส่วนอื่นๆ เพื่อไม่ให้มี
 *    กล่อง toast ลอยซ้อนกันหลายกล่องตำแหน่งเดียวกัน
 *
 * 3. "กิจกรรมล่าสุด" ในแผงกระดิ่ง — เฉพาะบัญชีที่เห็นหัวข้อย่อย "รถรออนุมัติ"
 *    (ผูกกับ `enabled` เหมือนส่วนที่ 1 — คนละรายการกับส่วนที่ 6 ซึ่งเห็นได้ทุก
 *    บัญชี) รายการข้อความแจ้งเหตุการณ์บริหารจัดการต่างๆ ในระบบ ทั้งผลสำเร็จของ
 *    การดำเนินการที่ทำเอง (อนุมัติ/แก้ไข/แยกใบสั่งงาน — ทั้งที่ทำผ่านป็อปอัปนี้
 *    เองและที่ทำผ่านหน้าจองรถ BookingDashboard.tsx ผ่าน BOOKING_NOTICE_EVENT,
 *    ดูคอมเมนต์เต็มที่ประกาศ event นี้ใน lib/booking.ts) และเหตุการณ์ที่คนอื่น
 *    ทำด้วย (การจอง/ยกเลิกห้องประชุมใหม่ จากส่วนที่ 4 ด้านล่าง) — ต่างจากแถบ
 *    ข้อความบนหน้าซึ่งหายไปเองเมื่อกดปิด/ทำอย่างอื่นต่อ ส่วนนี้ "ค้างอยู่ใน
 *    รายการ" จนกว่าจะกดล้างเอง (เก็บในหน่วยความจำของแท็บนี้เท่านั้น ไม่
 *    persist ข้ามเซสชัน เหมือนส่วนอื่นๆ ของกระดิ่งนี้ — จำกัดไว้ไม่เกิน 20
 *    รายการล่าสุดกันไม่ให้โตไม่มีที่สิ้นสุด)
 *
 * 4. แจ้งเตือนห้องประชุม (จอง/ยกเลิกใหม่) — เพิ่มภายหลังตามที่ขอ (ดูคอมเมนต์
 *    หัวฟังก์ชันด้านบน) เฉพาะบัญชีที่เห็นหัวข้อย่อย "รถรออนุมัติ" (ผูกกับ
 *    `enabled` เหมือนส่วนที่ 1/3) ห้องประชุมยืนยันทันทีอยู่แล้ว ไม่มีสถานะ
 *    "รออนุมัติ" ให้กด จึงแค่แจ้งให้ทราบเฉยๆ (toast + เก็บเข้า "กิจกรรมล่าสุด"
 *    ของส่วนที่ 3 ด้วย) ต่างจากส่วนที่ 2 ตรงที่ดูทุกแผนก ไม่ใช่แค่คำขอ "ของ
 *    บัญชีนี้เอง" — ใช้ ref แยกต่างหาก (seenRoomBookings) ติดตามว่าห้องประชุม
 *    คำขอไหนเคยเห็นแล้ว/ยกเลิกไปหรือยัง
 *
 * 5. (ปุ่ม "แยกออก" เอง) อยู่ใน TripOrderModal.tsx ไม่ใช่ที่นี่ — กระดิ่งนี้เป็น
 *    แค่ผู้รับผลจากการแยก (ส่วนที่ 2/6) ไม่ได้เป็นจุดที่สั่งแยกเอง
 *
 * 6. "กิจกรรมของฉัน" ในแผงกระดิ่ง — ทุกบัญชีเห็น (ไม่ผูกกับ `enabled` เลย ต่าง
 *    จากส่วนที่ 3) เก็บข้อความเดียวกับ toast ของส่วนที่ 2 ไว้ถาวรกว่า (จนกว่าจะ
 *    กดล้างเอง เหมือนส่วนที่ 3 แต่คนละรายการ คนละ state) เพิ่มภายหลังตามที่ขอ
 *    ("ต้องมีการแจ้งเตือนไปยังผู้จองได้รับทราบผ่านหน้าต่างแจ้งเตือนด้วย") ให้
 *    ผู้จองที่พลาด toast 6 วินาทีไป (เช่นแท็บไม่ได้โฟกัสอยู่ตอนนั้น) ยังเปิดแผง
 *    กระดิ่งมาดูย้อนหลังได้ ตราบใดที่ยังเปิดแท็บ/ล็อกอินอยู่ (ไม่ persist ข้าม
 *    เซสชัน — เป็นข้อจำกัดที่ยอมรับได้ตามที่ตกลงไว้ เพราะระบบนี้ไม่มี store
 *    กลางฝั่งเซิร์ฟเวอร์สำหรับการแจ้งเตือนเลย มีแต่ client-side polling diff)
 *
 * ส่วนที่ 1-2-4 แชร์ poll() เดียวกัน (ดึง GET /api/booking/bookings — และ
 * GET /api/booking/trip-orders เพิ่มด้วยสำหรับส่วนที่ 2 — ทุก 15 วินาที) และ
 * useEffect เดียวกัน (ทำงานเสมอ ไม่ผูกกับ `enabled` อีกต่อไป เพราะส่วนที่ 2
 * ต้องทำงานสำหรับทุกบัญชี) ตัวกระดิ่ง+แผงเองแสดงให้ทุกบัญชีเห็นแล้ว (ดูย่อหน้า
 * เปิด) มีแค่หัวข้อย่อย "รถรออนุมัติ" (ส่วนที่ 1), "กิจกรรมล่าสุด" (ส่วนที่ 3)
 * และห้องประชุม (ส่วนที่ 4) เท่านั้นที่ยังคงถูกซ่อนภายในแผงเมื่อ `enabled` เป็น
 * false
 */
export default function NotificationBell({ enabled, username }: { enabled: boolean; username: string }) {
  const router = useRouter();
  // `pending` และ `tripOrders` (ใบสั่งงานที่ยังมีผลอยู่ — ใช้เช็ครถไม่ว่างใน
  // TripOrderModal ที่เปิดจากปุ่ม "จัดรถ" ในแผงนี้) รวมเป็น state ก้อนเดียว
  // ตั้งใจ ไม่ใช้ useState แยกสองตัว — poll() ด้านล่างต้องอัปเดตทั้งคู่พร้อม
  // กันทุกรอบ ถ้าแยก state จะกลายเป็นเรียก setState 2 ครั้งซ้อนกันภายใน
  // effect เดียว (ผ่าน poll()) ซึ่ง react-hooks/set-state-in-effect เตือนว่า
  // ทำให้เกิด re-render ซ้อนกันหลายรอบโดยไม่จำเป็น รวมเป็นก้อนเดียวแล้วอัปเดต
  // ด้วย setState ครั้งเดียวจบ
  const [approvalPanel, setApprovalPanel] = useState<{ pending: Booking[]; tripOrders: TripOrder[] }>({
    pending: [],
    tripOrders: [],
  });
  const pending = approvalPanel.pending;
  const [open, setOpen] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [actingId, setActingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // รถที่เปิดใช้งานอยู่ — ดึงมาให้ TripOrderModal เลือกใช้ตอนกด "จัดรถ" จาก
  // ป็อปอัปนี้ (ปกติแล้วหน้าจองรถเองมีรายการนี้อยู่แล้ว แต่ป็อปอัปนี้ลอยอยู่
  // เหนือทุกหน้า จึงต้องดึงเองแยกต่างหาก)
  const [carResources, setCarResources] = useState<BookingResource[]>([]);
  // คนขับที่เปิดใช้งานอยู่ — ดึงแบบ best-effort เดียวกับ carResources ด้านบน
  // เมื่อเปิด TripOrderModal จากป็อปอัปนี้ (ดู openDispatch ด้านล่าง)
  const [carDrivers, setCarDrivers] = useState<Driver[]>([]);
  const [dispatchBooking, setDispatchBooking] = useState<Booking | null>(null);
  // null = no poll has completed yet, so the very first result is treated
  // as "what's already waiting" (one summary toast) rather than diffed
  // against an empty set (which would also work, but this reads clearer).
  // เฉพาะส่วนที่ 1 (แผงรออนุมัติ, superadmin เท่านั้น).
  const seenIds = useRef<Set<string> | null>(null);
  // สถานะล่าสุดที่เคยเห็นของคำขอจองรถ "ของบัญชีนี้เอง" แต่ละรายการ (bookingId
  // -> approvalStatus) — เฉพาะส่วนที่ 2 (toast+กิจกรรมของฉัน แจ้งผลของตัวเอง,
  // ทุกบัญชี) null = ยังไม่เคย poll เลย เหมือน seenIds ด้านบน (ตั้ง baseline
  // เงียบๆ ครั้งแรก ไม่ toast ย้อนหลังสำหรับคำขอที่อนุมัติ/แยกไปนานแล้วก่อนเปิด
  // หน้านี้) ใช้ค่าเดิมทั้ง "pending -> approved" (อนุมัติแล้ว) และ
  // "approved -> pending" (ถูกแยกออกจากใบสั่งงานเดิม เพิ่มภายหลังตามที่ขอ) แยก
  // ทิศทางกันด้วยค่าปัจจุบัน/ค่าก่อนหน้าตรงๆ ไม่ต้องเก็บ tripOrderId เพิ่มเลย —
  // คำขอจองรถใหม่เอี่ยมเริ่มที่ "pending" อยู่แล้วตั้งแต่สร้าง (ไม่เคยเป็น
  // "approved" มาก่อน) จึงไม่มีทางถูกเข้าใจผิดเป็น "ถูกแยกออก" ได้เลย
  const seenBookingStatuses = useRef<Map<string, Booking["approvalStatus"]> | null>(null);
  // ส่วนที่ 3 — "กิจกรรมล่าสุด" ในแผงกระดิ่ง เก็บล่าสุดไว้บนสุด (unshift) จำกัด
  // ไม่เกิน 20 รายการ ดูคอมเมนต์เต็มที่หัวไฟล์
  const [recentNotices, setRecentNotices] = useState<{ id: string; text: string }[]>([]);
  // สถานะล่าสุดที่เคยเห็นของ "การจองห้องประชุมทุกแผนก" แต่ละรายการ (bookingId
  // -> ถูกยกเลิกไปแล้วหรือยัง) — เฉพาะส่วนที่ 4 (แจ้งเตือนห้องประชุม, เฉพาะบัญชี
  // ที่เห็นกระดิ่ง) null = ยังไม่เคย poll เลย เหมือน ref อื่นๆ ด้านบน (ตั้ง
  // baseline เงียบๆ ครั้งแรก ไม่แจ้งย้อนหลังสำหรับรายการที่จองไปนานแล้วก่อนเปิด
  // หน้านี้)
  const seenRoomBookings = useRef<Map<string, boolean> | null>(null);
  // ส่วนที่ 6 — "กิจกรรมของฉัน" ในแผงกระดิ่ง ทุกบัญชีเห็น เก็บล่าสุดไว้บนสุด
  // (unshift) จำกัดไม่เกิน 20 รายการเหมือน recentNotices ของส่วนที่ 3 (ดู
  // คอมเมนต์เต็มที่หัวไฟล์)
  const [myNotices, setMyNotices] = useState<{ id: string; text: string }[]>([]);
  // จำนวนรายการใน myNotices ที่ยังไม่เคยเปิดแผงดูตั้งแต่เพิ่มเข้ามา — ใช้เป็น
  // badge ตัวเลขบนกระดิ่งสำหรับบัญชีที่ไม่เห็นหัวข้อย่อย "รถรออนุมัติ" (enabled
  // เป็น false อยู่) เพราะ badge เดิม (pending.length) มีความหมายเฉพาะบัญชีที่
  // อนุมัติได้เท่านั้น รีเซ็ตเป็น 0 ทุกครั้งที่เปิดแผง (ดู useEffect ด้านล่าง)
  const [unseenMyNotices, setUnseenMyNotices] = useState(0);

  const pushToast = useCallback((text: string, kind?: Toast["kind"]) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setToasts((prev) => [...prev, { id, text, kind }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, TOAST_DURATION_MS);
  }, []);

  const pushRecent = useCallback((text: string) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setRecentNotices((prev) => [{ id, text }, ...prev].slice(0, 20));
  }, []);

  const pushMyNotice = useCallback((text: string) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setMyNotices((prev) => [{ id, text }, ...prev].slice(0, 20));
    setUnseenMyNotices((prev) => prev + 1);
  }, []);

  // รับข้อความแจ้งผลสำเร็จจากหน้าจองรถ (BookingDashboard.tsx) ผ่าน
  // BOOKING_NOTICE_EVENT — เฉพาะ superadmin (ผูกกับ `enabled` เหมือนส่วนที่ 1
  // เพราะข้อความเหล่านี้ล้วนมาจากการกระทำที่ต้องมีสิทธิ์ superadmin อยู่แล้ว)
  useEffect(() => {
    if (!enabled) return;
    function onNotice(e: Event) {
      const text = (e as CustomEvent<{ text: string }>).detail?.text;
      if (text) pushRecent(text);
    }
    window.addEventListener(BOOKING_NOTICE_EVENT, onNotice);
    return () => window.removeEventListener(BOOKING_NOTICE_EVENT, onNotice);
  }, [enabled, pushRecent]);

  const poll = useCallback(async () => {
    try {
      // ทั้งสองส่วน (แผงรออนุมัติของ superadmin + toast ผลของตัวเอง) ต้องใช้
      // GET /api/booking/bookings เหมือนกัน ส่วนที่ 2 ยังต้องรู้ว่าใครจัดรถ/
      // คนขับคนไหนให้ด้วย เลยดึง GET /api/booking/trip-orders คู่กันไปเลย
      // (เปิดให้ทุกบัญชีที่ล็อกอินอยู่แล้วอ่านได้ ไม่ใช่แค่ superadmin)
      const [bookingsRes, tripOrdersRes] = await Promise.all([
        fetch("/api/booking/bookings", { cache: "no-store" }),
        fetch("/api/booking/trip-orders", { cache: "no-store" }),
      ]);
      if (!bookingsRes.ok) return;
      const data = await bookingsRes.json();
      const bookings: Booking[] = Array.isArray(data.bookings) ? data.bookings : [];
      // Best-effort — ถ้าดึงใบสั่งงานไม่สำเร็จ toast ของส่วนที่ 2 ยังขึ้นได้
      // แค่ไม่มีรายละเอียดรถ/คนขับแนบมา (ดูจุดที่ใช้ tripOrders ด้านล่าง)
      const tripOrdersData = tripOrdersRes.ok ? await tripOrdersRes.json().catch(() => ({})) : {};
      const tripOrders: TripOrder[] = Array.isArray(tripOrdersData.tripOrders) ? tripOrdersData.tripOrders : [];

      // --- ส่วนที่ 1: แผงรออนุมัติ (superadmin เท่านั้น) ---
      if (enabled) {
        // ตัดใบสั่งงานที่ทุกคำขอที่ครอบคลุมถูกยกเลิกไปหมดแล้วออก ก่อนเก็บไว้ให้
        // TripOrderModal (เปิดจากปุ่ม "จัดรถ" ในแผงนี้ — เฉพาะ superadmin เห็น
        // อยู่แล้ว ตามเงื่อนไข `enabled` เดียวกัน) ใช้เช็ครถไม่ว่าง — เหตุผล
        // เดียวกับ activeTripOrders ใน BookingDashboard.tsx (ไม่งั้นรถจะค้าง
        // สถานะ "ไม่ว่าง" ทั้งที่ไม่มีใครใช้จริงแล้ว) — คำนวณไว้ก่อน แล้วรวม
        // กับ stillPending ด้านล่าง อัปเดตพร้อมกันด้วย setApprovalPanel ครั้ง
        // เดียว (ดูคอมเมนต์ที่ประกาศ approvalPanel ด้านบนว่าทำไมต้องรวม)
        const activeTripOrders = tripOrders.filter((t) =>
          t.bookingIds.some((id) => {
            const b = bookings.find((bk) => bk.bookingId === id);
            return b ? !isBookingCancelled(b) : true;
          })
        );

        const stillPending = bookings
          .filter((b) => b.resourceType === "car" && b.approvalStatus === "pending" && !isBookingCancelled(b))
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

        const currentIds = new Set(stillPending.map((b) => b.bookingId));
        if (seenIds.current) {
          const newOnes = stillPending.filter((b) => !seenIds.current!.has(b.bookingId));
          if (newOnes.length === 1) {
            const requester = newOnes[0].bookedByDisplayName || newOnes[0].bookedByUsername;
            pushToast(`มีรายการจองรถรอจัดรถใหม่: ${newOnes[0].resourceName} (${requester})`);
          } else if (newOnes.length > 1) {
            pushToast(`มีรายการจองรถรอจัดรถใหม่ ${newOnes.length} รายการ`);
          }
        } else if (stillPending.length > 0) {
          pushToast(
            stillPending.length === 1
              ? "มีรายการจองรถรอจัดรถ 1 รายการ"
              : `มีรายการจองรถรอจัดรถ ${stillPending.length} รายการ`
          );
        }
        seenIds.current = currentIds;
        setApprovalPanel({ pending: stillPending, tripOrders: activeTripOrders });

        // --- ส่วนที่ 4: แจ้งเตือนห้องประชุม (จอง/ยกเลิกใหม่ ทุกแผนก) ---
        // ห้องประชุมยืนยันทันที ไม่มีสถานะ "รออนุมัติ" ให้ตาม จึงแค่ diff รายชื่อ
        // คำขอห้องประชุมทั้งหมดกับรอบก่อนหน้า (seenRoomBookings) หา "ใหม่ที่ยัง
        // ไม่เคยเห็น" กับ "เคยเห็นแล้วแต่ตอนนี้ถูกยกเลิก" แยกกัน — เหมือนแนวทาง
        // ของ stillPending/seenIds ด้านบน แต่ไม่มีปุ่มกดอนุมัติ/ไม่อนุมัติ แค่
        // แจ้งให้ทราบ (toast + เก็บเข้า "กิจกรรมล่าสุด" ของส่วนที่ 3)
        const roomBookings = bookings.filter((b) => b.resourceType === "room");
        if (seenRoomBookings.current) {
          const prevSeen = seenRoomBookings.current;
          const newOnes = roomBookings.filter((b) => !prevSeen.has(b.bookingId) && !isBookingCancelled(b));
          const newlyCancelled = roomBookings.filter(
            (b) => prevSeen.has(b.bookingId) && !prevSeen.get(b.bookingId) && isBookingCancelled(b)
          );
          if (newOnes.length === 1) {
            const b = newOnes[0];
            const requester = b.bookedByDisplayName || b.bookedByUsername;
            const text = `มีการจองห้องประชุมใหม่: ${b.resourceName} (${requester}) ${formatBookingDateTime(
              b.startTime
            )} – ${formatBookingDateTime(b.endTime)}`;
            pushToast(text, "room");
            pushRecent(text);
          } else if (newOnes.length > 1) {
            const text = `มีการจองห้องประชุมใหม่ ${newOnes.length.toLocaleString("th-TH")} รายการ`;
            pushToast(text, "room");
            pushRecent(text);
          }
          if (newlyCancelled.length === 1) {
            const b = newlyCancelled[0];
            const requester = b.bookedByDisplayName || b.bookedByUsername;
            const text = `การจองห้องประชุม "${b.resourceName}" (${requester}) ${formatBookingDateTime(
              b.startTime
            )} – ${formatBookingDateTime(b.endTime)} ถูกยกเลิกแล้ว`;
            pushToast(text, "room");
            pushRecent(text);
          } else if (newlyCancelled.length > 1) {
            const text = `มีการยกเลิกการจองห้องประชุม ${newlyCancelled.length.toLocaleString("th-TH")} รายการ`;
            pushToast(text, "room");
            pushRecent(text);
          }
        }
        seenRoomBookings.current = new Map(roomBookings.map((b) => [b.bookingId, isBookingCancelled(b)]));
      }

      // --- ส่วนที่ 2: toast แจ้งผลการจองรถของ "ตัวเอง" (ทุกบัญชี) ---
      // เฉพาะการจองรถ (ห้องประชุมยืนยันทันทีอยู่แล้ว ไม่มีสถานะรออนุมัติให้
      // เปลี่ยนแปลง) ของบัญชีนี้เอง ที่ยังไม่ถูกยกเลิก
      const myCarBookings = bookings.filter(
        (b) => b.resourceType === "car" && b.bookedByUsername === username && !isBookingCancelled(b)
      );
      if (seenBookingStatuses.current) {
        const newlyApproved = myCarBookings.filter(
          (b) => b.approvalStatus === "approved" && seenBookingStatuses.current!.get(b.bookingId) === "pending"
        );
        if (newlyApproved.length === 1) {
          const b = newlyApproved[0];
          const trip = tripOrders.find((t) => t.tripOrderId === b.tripOrderId);
          const text =
            `การจองรถ "${b.resourceName}" (${formatBookingDateTime(b.startTime)} – ${formatBookingDateTime(
              b.endTime
            )}) ได้รับการจัดรถแล้ว` +
            (trip ? ` — รถที่จัดให้: ${trip.resourceName} คนขับ: ${trip.driverName || "-"}` : "");
          pushToast(text, "approved");
          // เก็บเข้า "กิจกรรมของฉัน" ด้วยเสมอ (เพิ่มภายหลังตามที่ขอ) — ไม่งั้น
          // ข้อความนี้จะหายไปพร้อม toast ใน 6 วินาทีถ้าพลาดดูตอนนั้น
          pushMyNotice(text);
        } else if (newlyApproved.length > 1) {
          const text = `การจองรถของคุณได้รับการจัดรถแล้ว ${newlyApproved.length} รายการ — ดูรายละเอียดที่หน้าจองรถ`;
          pushToast(text, "approved");
          pushMyNotice(text);
        }

        // ถูกแยกออกจากใบสั่งงานเดิม (ทิศทางย้อนกลับของด้านบน) — เพิ่มภายหลัง
        // ตามที่ขอ ("ต้องมีการแจ้งเตือนไปยังผู้จองได้รับทราบผ่านหน้าต่างแจ้ง
        // เตือนด้วย") ดูคอมเมนต์ที่ประกาศ seenBookingStatuses ด้านบนว่าทำไม
        // เช็คทิศทางนี้ปลอดภัย ไม่ชนกับคำขอใหม่ที่เพิ่งสร้าง
        const newlySplit = myCarBookings.filter(
          (b) => b.approvalStatus === "pending" && seenBookingStatuses.current!.get(b.bookingId) === "approved"
        );
        if (newlySplit.length === 1) {
          const b = newlySplit[0];
          const text = `การจองรถ "${b.purpose || b.destination || formatBookingDateTime(b.startTime)}" (${formatBookingDateTime(
            b.startTime
          )} – ${formatBookingDateTime(b.endTime)}) ถูกแยกออกจากใบสั่งงานเดินทางเดิม กลับเป็น "รอจัดรถ" แล้ว รอออกใบสั่งงานใหม่`;
          pushToast(text, "split");
          pushMyNotice(text);
        } else if (newlySplit.length > 1) {
          const text = `การจองรถของคุณถูกแยกออกจากใบสั่งงานเดินทางเดิม ${newlySplit.length} รายการ — กลับเป็น "รอจัดรถ" แล้ว รอออกใบสั่งงานใหม่`;
          pushToast(text, "split");
          pushMyNotice(text);
        }
      }
      const nextStatuses = new Map<string, Booking["approvalStatus"]>();
      for (const b of myCarBookings) nextStatuses.set(b.bookingId, b.approvalStatus);
      seenBookingStatuses.current = nextStatuses;
    } catch {
      // Best-effort — a transient poll failure just tries again next
      // interval, same philosophy as other background refreshes here.
    }
  }, [pushToast, pushRecent, pushMyNotice, enabled, username]);

  useEffect(() => {
    // ทำงานเสมอ ไม่ผูกกับ `enabled` อีกต่อไป — ส่วนที่ 2 (toast แจ้งผลการจอง
    // รถของตัวเอง) ต้องทำงานสำหรับทุกบัญชี ไม่ใช่แค่ superadmin
    poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [poll]);

  /** เปิดแผงแล้วถือว่าเห็น "กิจกรรมของฉัน" (ส่วนที่ 6) ที่ค้างอยู่ทั้งหมดแล้ว —
   * เคลียร์ badge ตัวเลขสำหรับบัญชีที่ไม่เห็นหัวข้อย่อย "รถรออนุมัติ" (ดู
   * คอมเมนต์ที่ประกาศ unseenMyNotices ด้านบน) เรียกตรงจากจุดที่เปิดแผงเอง
   * (event handler) แทนการ setState ใน useEffect — กัน cascading render ที่
   * ไม่จำเป็น */
  function openPanel() {
    setOpen(true);
    setUnseenMyNotices(0);
  }

  /** Rejects a pending car booking outright — the only decision left that's
   * a direct status flip. See the top doc comment for why "approve" is
   * handled by openDispatch/TripOrderModal instead. */
  async function reject(bookingId: string) {
    setActingId(bookingId);
    setActionError(null);
    try {
      const res = await fetch(`/api/booking/bookings/${bookingId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approvalStatus: "rejected" }),
      });
      const data = await res.json();
      if (!res.ok) {
        setActionError(data.error || "เกิดข้อผิดพลาด");
        return;
      }
      setApprovalPanel((prev) => ({ ...prev, pending: prev.pending.filter((b) => b.bookingId !== bookingId) }));
      seenIds.current?.delete(bookingId);
    } catch {
      setActionError("เกิดข้อผิดพลาดในการเชื่อมต่อ");
    } finally {
      setActingId(null);
    }
  }

  /** Opens TripOrderModal for exactly this one booking — fetches the
   * active car resource list and active driver list on demand (best-effort;
   * the modal itself still shows a clear "ไม่มีรถที่เปิดใช้งาน"/falls back to
   * free-text driver entry if either comes back empty, same as
   * BookingFormModal/BookingDashboard). */
  async function openDispatch(booking: Booking) {
    setActionError(null);
    if (carResources.length === 0) {
      try {
        const res = await fetch("/api/booking/resources", { cache: "no-store" });
        const data = await res.json().catch(() => ({}));
        if (res.ok && Array.isArray(data.resources)) {
          setCarResources((data.resources as BookingResource[]).filter((r) => r.type === "car" && r.active));
        }
      } catch {
        // best-effort — TripOrderModal still opens and shows "ไม่มีรถที่เปิดใช้งาน"
      }
    }
    if (carDrivers.length === 0) {
      try {
        const res = await fetch("/api/booking/drivers", { cache: "no-store" });
        const data = await res.json().catch(() => ({}));
        if (res.ok && Array.isArray(data.drivers)) {
          setCarDrivers((data.drivers as Driver[]).filter((d) => d.active));
        }
      } catch {
        // best-effort — TripOrderModal ยังเปิดได้ปกติ แค่ตกไปโหมดพิมพ์ชื่อคนขับเอง
      }
    }
    setDispatchBooking(booking);
    setOpen(false);
  }

  function handleTripOrderCreated({ tripOrder, bookings: updatedBookings }: { tripOrder: TripOrder; bookings: Booking[] }) {
    setApprovalPanel((prev) => ({
      ...prev,
      pending: prev.pending.filter((b) => !tripOrder.bookingIds.includes(b.bookingId)),
    }));
    for (const bookingId of tripOrder.bookingIds) seenIds.current?.delete(bookingId);
    setDispatchBooking(null);
    // เก็บเข้า "กิจกรรมล่าสุด" ของกระดิ่งเองด้วย — ข้อความเดียวกับที่
    // BookingDashboard.tsx ใช้ตอนอนุมัติผ่านหน้าจองรถโดยตรง (ดูคอมเมนต์ที่
    // ประกาศ BOOKING_NOTICE_EVENT ใน lib/booking.ts) เพื่อให้การอนุมัติผ่าน
    // ป็อปอัปนี้เองก็ขึ้นในรายการเดียวกันเช่นกัน ไม่ต้องรอ event จากที่อื่น
    pushRecent(
      `จัดรถสำเร็จ (${tripOrder.resourceName} · คนขับ: ${tripOrder.driverName || "—"}) — รายการจองที่เกี่ยวข้อง ${updatedBookings.length.toLocaleString("th-TH")} รายการปรับสถานะเป็น "อนุญาต" ในปฏิทินแล้ว`
    );
    // แจ้งหน้าจองรถ (BookingDashboard.tsx) ที่อาจเปิดอยู่พร้อมกัน (เช่น
    // อนุมัติจากป็อปอัปนี้ขณะดูปฏิทินอยู่) ให้รีเฟรชข้อมูลสดใหม่ทันที — ไม่งั้น
    // ปฏิทินจะยังค้างสถานะ "รออนุมัติ" เดิมจนกว่าจะรีเฟรชหน้าเอง เพราะสอง
    // คอมโพเนนต์นี้มี state แยกกันคนละก้อน ไม่ได้แชร์กัน (ดูคอมเมนต์ที่ประกาศ
    // TRIP_ORDER_CHANGED_EVENT ใน lib/booking.ts)
    window.dispatchEvent(new Event(TRIP_ORDER_CHANGED_EVENT));
  }

  // badge ตัวเลขบนกระดิ่ง — บัญชีที่เห็นหัวข้อย่อย "รถรออนุมัติ" (enabled) ใช้
  // จำนวนรออนุมัติเหมือนเดิมทุกประการ บัญชีอื่น (ตอนนี้เห็นกระดิ่งด้วยแล้ว ตามที่
  // ขอเพิ่มภายหลัง — ดูคอมเมนต์เต็มที่หัวไฟล์) ใช้จำนวน "กิจกรรมของฉัน" ที่ยังไม่
  // เคยเปิดแผงดูแทน (ดูคอมเมนต์ที่ประกาศ unseenMyNotices ด้านบน)
  const badgeCount = enabled ? pending.length : unseenMyNotices;

  return (
    <>
      {/* เดิมทั้งกล่องนี้ถูกซ่อนเมื่อ enabled เป็น false — เปิดให้ทุกบัญชีเห็น
          กระดิ่ง+แผงแล้ว ตามที่ขอเพิ่มภายหลัง ("ต้องมีการแจ้งเตือนไปยังผู้จอง
          ได้รับทราบผ่านหน้าต่างแจ้งเตือน") มีแค่หัวข้อย่อยภายในแผง (รถรออนุมัติ/
          กิจกรรมล่าสุด/ห้องประชุม) เท่านั้นที่ยังผูกกับ enabled อยู่ ดูคอมเมนต์
          เต็มที่หัวไฟล์ */}
      {/* Fixed, not embedded in the sidebar/topbar markup, so the same
          trigger appears in a stable spot across both the desktop sidebar
          layout and the mobile topbar without duplicating it in each. On
          mobile it sits just below the 56px topbar; on desktop (no topbar)
          it sits near the very top of the viewport instead. */}
      {/* print:hidden (+ no-print as a belt-and-suspenders backstop, same
          convention as MaintenanceReportBuilder's own print-only controls)
          — this button is `position: fixed`, so without an explicit print
          override it stays pinned on top of the page at print time too,
          landing right over the printed form's content (reported as the
          bell icon overlapping the equipment table on a printed
          maintenance report). Fixed-position elements aren't naturally
          excluded from print the way scrolled-past content is. */}
      <div className="no-print fixed right-3 top-[68px] z-50 print:hidden lg:right-4 lg:top-4">
        <button
          type="button"
          onClick={() => (open ? setOpen(false) : openPanel())}
          aria-label="การแจ้งเตือน"
          className="relative flex h-10 w-10 items-center justify-center rounded-full border border-emerald-900/10 bg-white text-zinc-600 shadow-sm transition-colors hover:bg-emerald-50 hover:text-emerald-700 dark:border-emerald-400/10 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-emerald-950/40"
        >
          <Bell size={18} strokeWidth={2} aria-hidden="true" />
          {badgeCount > 0 && (
            <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-bold text-white">
              {badgeCount > 99 ? "99+" : badgeCount}
            </span>
          )}
        </button>

        {open && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} aria-hidden="true" />
            <div className="absolute right-0 z-50 mt-2 w-[22rem] max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-2xl border border-emerald-900/10 bg-white shadow-xl dark:border-emerald-400/10 dark:bg-zinc-900">
              {/* หัวแผงรวม — ตั้งใจใช้คำกลางๆ ("การแจ้งเตือน") ไม่เจาะจงแค่การ
                  จองรถอีกต่อไป ตามที่ขอภายหลัง เพราะตอนนี้แผงนี้ครอบคลุมหลาย
                  หมวด (รถรออนุมัติ/กิจกรรมล่าสุด/ห้องประชุม/กิจกรรมของฉัน — ดู
                  คอมเมนต์เต็มที่หัวไฟล์) ไม่ใช่แค่รถอย่างเดียว หัวข้อย่อย
                  "รถรออนุมัติ" ด้านล่างยังคงบอกจำนวนรายการที่ต้องกดจัดการอยู่
                  เหมือนเดิม (เฉพาะบัญชีที่ enabled) */}
              <div className="flex items-center justify-between border-b border-zinc-100 px-4 py-2.5 dark:border-zinc-800">
                <span className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">การแจ้งเตือน</span>
              </div>

              {/* ส่วนที่ 6 — "กิจกรรมของฉัน" ทุกบัญชีเห็น ไม่ผูกกับ enabled เลย
                  ดูคอมเมนต์เต็มที่หัวไฟล์ */}
              {myNotices.length > 0 && (
                <div className="border-b border-zinc-100 dark:border-zinc-800">
                  <div className="flex items-center justify-between px-4 py-2">
                    <span className="text-xs font-semibold text-zinc-500 dark:text-zinc-400">กิจกรรมของฉัน</span>
                    <button
                      type="button"
                      onClick={() => setMyNotices([])}
                      className="text-xs text-zinc-400 underline underline-offset-2 hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300"
                    >
                      ล้างทั้งหมด
                    </button>
                  </div>
                  <ul className="max-h-52 space-y-1.5 overflow-y-auto px-2 pb-2">
                    {myNotices.map((n) => (
                      <li
                        key={n.id}
                        className="flex items-start gap-1.5 rounded-lg bg-sky-50/60 px-2.5 py-2 text-xs leading-5 text-zinc-700 dark:bg-sky-950/20 dark:text-zinc-300"
                      >
                        <Bell
                          size={13}
                          strokeWidth={2}
                          className="mt-0.5 shrink-0 text-sky-600 dark:text-sky-400"
                          aria-hidden="true"
                        />
                        <span className="flex-1">{n.text}</span>
                        <button
                          type="button"
                          onClick={() => setMyNotices((prev) => prev.filter((x) => x.id !== n.id))}
                          aria-label="ลบการแจ้งเตือนนี้"
                          className="shrink-0 rounded-full p-0.5 text-zinc-400 transition-colors hover:bg-zinc-200/60 hover:text-zinc-600 dark:text-zinc-500 dark:hover:bg-zinc-700/60 dark:hover:text-zinc-300"
                        >
                          <XIcon size={12} strokeWidth={2} aria-hidden="true" />
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {/* บัญชีที่ไม่เห็นหัวข้อย่อย "รถรออนุมัติ" (!enabled) และไม่มี
                  "กิจกรรมของฉัน" เลย — ไม่มีอะไรเหลือให้แสดงในแผงนี้อีก ต้องมี
                  ข้อความว่างบอกไว้ ไม่งั้นแผงจะโล่งไม่มีคำอธิบาย */}
              {myNotices.length === 0 && !enabled && (
                <p className="px-3 py-6 text-center text-sm text-zinc-400 dark:text-zinc-500">ไม่มีการแจ้งเตือน</p>
              )}

              {enabled && (
                <>
                  <div className="flex items-center justify-between px-4 pb-1.5 pt-2.5">
                    <span className="text-xs font-semibold text-zinc-500 dark:text-zinc-400">รถรอจัดรถ</span>
                    <span className="text-xs text-zinc-400 dark:text-zinc-500">{pending.length} รายการ</span>
                  </div>
                  {actionError && <p className="px-4 py-2 text-xs text-red-600 dark:text-red-400">{actionError}</p>}
                  <div className="max-h-[22rem] overflow-y-auto p-2">
                    {pending.length === 0 ? (
                      <p className="px-3 py-6 text-center text-sm text-zinc-400 dark:text-zinc-500">
                        ไม่มีรายการรอจัดรถ
                      </p>
                    ) : (
                      <ul className="space-y-2">
                        {pending.map((b) => (
                          <li key={b.bookingId} className="rounded-xl border border-zinc-100 p-3 dark:border-zinc-800">
                            <p className="text-sm font-medium text-zinc-800 dark:text-zinc-100">{b.resourceName}</p>
                            <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                              {formatBookingDateTime(b.startTime)} – {formatBookingDateTime(b.endTime)}
                            </p>
                            <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                              {b.bookedByDisplayName || b.bookedByUsername}
                              {b.department ? ` · ${b.department}` : ""}
                            </p>
                            {b.purpose && <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-300">{b.purpose}</p>}
                            <div className="mt-2 flex gap-1.5">
                              <button
                                type="button"
                                onClick={() => openDispatch(b)}
                                disabled={actingId === b.bookingId}
                                className="inline-flex items-center gap-1 rounded-full border border-sky-200 px-2 py-1 text-xs font-medium text-sky-700 transition-colors hover:bg-sky-50 disabled:opacity-60 dark:border-sky-900/50 dark:text-sky-300 dark:hover:bg-sky-950/30"
                              >
                                <Truck size={12} strokeWidth={2} aria-hidden="true" />
                                จัดรถ
                              </button>
                              <button
                                type="button"
                                onClick={() => reject(b.bookingId)}
                                disabled={actingId === b.bookingId}
                                className="inline-flex items-center gap-1 rounded-full border border-red-200 px-2 py-1 text-xs font-medium text-red-700 transition-colors hover:bg-red-50 disabled:opacity-60 dark:border-red-900/50 dark:text-red-300 dark:hover:bg-red-950/30"
                              >
                                {actingId === b.bookingId ? (
                                  <Loader2 size={12} strokeWidth={2} className="animate-spin" aria-hidden="true" />
                                ) : (
                                  <XIcon size={12} strokeWidth={2} aria-hidden="true" />
                                )}
                                ปฏิเสธคำขอ
                              </button>
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  {/* ส่วนที่ 3 — "กิจกรรมล่าสุด" ครอบคลุมทั้งผลสำเร็จของการกระทำ
                      ที่ทำเอง (อนุมัติ/แก้ไข/แยกใบสั่งงาน — เดิมมาจากแถบข้อความ
                      บนหน้าจองรถ ผ่าน BOOKING_NOTICE_EVENT) และเหตุการณ์ที่คนอื่น
                      ทำ (การจอง/ยกเลิกห้องประชุมใหม่ จากส่วนที่ 4) ตามที่ขอเพิ่ม
                      ภายหลัง ("อยากให้เป็นช่องแจ้งเตือนหลายอย่างเท่าที่ทำได้และ
                      เหมาะสม ไม่ใช่แค่การจองรถ") — ต่างจากแถบข้อความบนหน้าซึ่ง
                      หายไปเองเมื่อกดปิด ส่วนนี้ค้างอยู่ในรายการจนกว่าจะกดลบเอง
                      (รายการเดียว/ล้างทั้งหมด) ตามที่ขอเจาะจง ดูคอมเมนต์เต็มที่
                      หัวไฟล์ */}
                  {recentNotices.length > 0 && (
                    <div className="border-t border-zinc-100 dark:border-zinc-800">
                      <div className="flex items-center justify-between px-4 py-2">
                        <span className="text-xs font-semibold text-zinc-500 dark:text-zinc-400">กิจกรรมล่าสุด</span>
                        <button
                          type="button"
                          onClick={() => setRecentNotices([])}
                          className="text-xs text-zinc-400 underline underline-offset-2 hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300"
                        >
                          ล้างทั้งหมด
                        </button>
                      </div>
                      <ul className="max-h-52 space-y-1.5 overflow-y-auto px-2 pb-2">
                        {recentNotices.map((n) => (
                          <li
                            key={n.id}
                            className="flex items-start gap-1.5 rounded-lg bg-emerald-50/60 px-2.5 py-2 text-xs leading-5 text-zinc-700 dark:bg-emerald-950/20 dark:text-zinc-300"
                          >
                            <CheckCircle2
                              size={13}
                              strokeWidth={2}
                              className="mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-400"
                              aria-hidden="true"
                            />
                            <span className="flex-1">{n.text}</span>
                            <button
                              type="button"
                              onClick={() => setRecentNotices((prev) => prev.filter((x) => x.id !== n.id))}
                              aria-label="ลบการแจ้งเตือนนี้"
                              className="shrink-0 rounded-full p-0.5 text-zinc-400 transition-colors hover:bg-zinc-200/60 hover:text-zinc-600 dark:text-zinc-500 dark:hover:bg-zinc-700/60 dark:hover:text-zinc-300"
                            >
                              <XIcon size={12} strokeWidth={2} aria-hidden="true" />
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </>
              )}
            </div>
          </>
        )}
      </div>

      {/* Toast stack — ใช้ร่วมกันทุกส่วน (แสดงเสมอไม่ว่า enabled จะเป็นอะไร)
          เพื่อไม่ให้มีกล่อง toast ลอยซ้อนกันหลายกล่องตำแหน่งเดียวกัน */}
      <div className="fixed bottom-4 right-4 z-50 flex w-[calc(100vw-2rem)] max-w-sm flex-col gap-2">
        {toasts.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => {
              if (t.kind === "approved" || t.kind === "split") {
                router.push("/booking/car");
              } else if (t.kind === "room") {
                router.push("/booking/room");
              } else {
                openPanel();
              }
              setToasts((prev) => prev.filter((x) => x.id !== t.id));
            }}
            className="flex items-start gap-2 rounded-xl border border-emerald-900/10 bg-white px-4 py-3 text-left text-sm text-zinc-700 shadow-lg dark:border-emerald-400/10 dark:bg-zinc-900 dark:text-zinc-200"
          >
            {t.kind === "approved" ? (
              <CheckCircle2
                size={16}
                strokeWidth={2}
                className="mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-400"
                aria-hidden="true"
              />
            ) : t.kind === "room" ? (
              <DoorOpen
                size={16}
                strokeWidth={2}
                className="mt-0.5 shrink-0 text-sky-600 dark:text-sky-400"
                aria-hidden="true"
              />
            ) : t.kind === "split" ? (
              <Scissors
                size={16}
                strokeWidth={2}
                className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400"
                aria-hidden="true"
              />
            ) : (
              <Bell
                size={16}
                strokeWidth={2}
                className="mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-400"
                aria-hidden="true"
              />
            )}
            <span>{t.text}</span>
          </button>
        ))}
      </div>

      {dispatchBooking && (
        <TripOrderModal
          bookings={[dispatchBooking]}
          // รายการรออนุมัติอื่นในป็อปอัปนี้เอง (รออยู่แล้ว) ส่งต่อให้
          // TripOrderModal กรองเหลือเฉพาะวันเดียวกันเอง — ตัดรายการที่กำลัง
          // จัดรถอยู่ตอนนี้ออกก่อน
          candidateBookings={pending.filter((b) => b.bookingId !== dispatchBooking.bookingId)}
          resources={carResources}
          drivers={carDrivers}
          existingTripOrders={approvalPanel.tripOrders}
          onClose={() => setDispatchBooking(null)}
          onCreated={handleTripOrderCreated}
        />
      )}
    </>
  );
}
