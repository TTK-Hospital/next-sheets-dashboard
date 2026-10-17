"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, ImageOff, Loader2, Save, Scissors, Truck, Users, X } from "lucide-react";
import {
  formatBookingDateRange,
  splitBookingDateTime,
  type Booking,
  type BookingResource,
  type Driver,
  type TripOrder,
} from "@/lib/booking";
import { buildActionColorMap, actionColorVars } from "@/lib/actionColors";

const INPUT_CLASS =
  "h-11 rounded-lg border border-zinc-200 bg-white px-3 text-base text-zinc-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand)] disabled:cursor-not-allowed disabled:bg-zinc-50 disabled:text-zinc-500 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100 dark:disabled:bg-zinc-800/60 dark:disabled:text-zinc-500";

// ค่าพิเศษของตัวเลือก "ชื่อพนักงานขับรถ" (select) ที่หมายถึง "สลับไปพิมพ์ชื่อ
// เอง" — ไม่ใช่ driverId/ชื่อคนขับจริง ดูคอมเมนต์ที่ driverName/
// manualDriverEntry state ด้านล่างสำหรับรายละเอียดทั้งหมด
const DRIVER_MANUAL_OPTION = "__manual__";

// เวลาเริ่ม/สิ้นสุดแยกวันที่+ชั่วโมง+นาที เหมือน BookingFormModal ทุกประการ —
// คัดลอกชุดตัวช่วยเล็กๆ นี้มาเป็นชุดของตัวเองแทนการ import ข้ามไฟล์ ตาม
// รูปแบบที่โค้ดฐานนี้ใช้อยู่แล้ว (เช่น STATUS_BADGE_CLASSES ที่ซ้ำกันระหว่าง
// BookingCalendar/BookingDashboard)
function pad2(n: number): string {
  return String(n).padStart(2, "0");
}
// ไม่มี HOUR_OPTIONS/MINUTE_OPTIONS/select ให้เลือกเวลาเองแล้ว — เวลาถูก
// ล็อกให้คำนวณอัตโนมัติล้วนๆ เท่านั้น (ดูคอมเมนต์ที่ startHour/startMinute/
// endHour/endMinute ด้านล่าง) เหลือไว้แค่ชนิดข้อมูล MinuteOption เพราะ
// autoTimeParts ยังใช้เป็นชนิดข้อมูลของค่าที่คำนวณออกมาอยู่
type MinuteOption = "00" | "30";

function combineDateTime(date: string, hour: string, minute: string): string {
  return date ? `${date}T${hour}:${minute}` : "";
}

/** ระยะห่างระหว่างขีดบอกเวลาบนเส้นเวลาการเดินทาง (นาที) — เลือกจาก "ก้าว"
 * ที่ดูเป็นธรรมชาติ (15/30 นาที, 1/2/3/4/6/8/12 ชั่วโมง) ตัวแรกที่ทำให้ได้
 * ขีดไม่เกิน ~8 ขีดตลอดทั้งเส้น ไม่ว่าเที่ยวนั้นจะสั้นแค่ครึ่งชั่วโมงหรือยาว
 * ข้ามวัน ตามที่ขอเพิ่มภายหลัง ("บอกเวลาเป็นช่วงๆ...เห็นความห่างของเวลาได้
 * ชัดเจนขึ้น") */
function pickTickStepMinutes(domainSpanMin: number): number {
  const steps = [15, 30, 60, 120, 180, 240, 360, 480, 720];
  for (const step of steps) {
    if (domainSpanMin / step <= 8) return step;
  }
  return 720;
}

/** "กลุ่มงาน/ผู้จอง" — เดิมมีต่อท้ายด้วย "— วัตถุประสงค์" แต่ตัดส่วนนั้นออก
 * ตามที่ขอภายหลัง ("ลบ - ในวง และชื่อสถานที่ที่ไปในวงออก เพราะซ้ำซ้อนการ
 * แสดงผลกัน") เนื่องจากวัตถุประสงค์ที่กรอกไว้มักซ้ำกับ "(ปลายทาง: ...)" ที่
 * แสดงแยกอยู่แล้วในบรรทัดถัดไปของทั้งสองกล่อง คงชื่อฟังก์ชันเดิมไว้ (เรียก
 * ใช้ร่วมกันทั้งกล่องยืนยันรายการที่จะรวมในใบสั่งงาน และกล่องคำขอรถอื่นใน
 * วันเดียวกันด้านล่าง) แต่เหลือแค่กลุ่มงาน/ผู้จอง ไม่แสดงวัตถุประสงค์อีกต่อไป */
function BookingWhoAndPurpose({
  booking,
}: {
  booking: Pick<Booking, "department" | "bookedByDisplayName" | "bookedByUsername">;
}) {
  return <>{booking.department || booking.bookedByDisplayName || booking.bookedByUsername}</>;
}

/** เวลารวมของใบสั่งงาน — ครอบคลุมทุกคำขอที่เลือกไว้พอดี: เริ่มต้นปัดลงถึง
 * ครึ่งชั่วโมงก่อนหน้า (ไม่ตัดเวลาที่เร็วที่สุดออก) และสิ้นสุดปัดขึ้นถึงครึ่ง
 * ชั่วโมงถัดไป (ไม่ตัดเวลาที่ช้าที่สุดออก) — เช่น คำขอ A 09:00-10:00 รวมกับ
 * คำขอ B 08:00-09:00 ได้เวลารวม 08:00-10:00 อัตโนมัติ ไม่มีวันที่ในนี้แล้ว
 * (ดูคอมเมนต์ที่ tripDateKey ด้านล่างว่าทำไม) เรียกใหม่ทุกครั้งที่รายการที่
 * เลือกไว้เปลี่ยน (ติ๊กเพิ่ม/ถอนคำขออื่น) ไม่ใช่แค่ตอนเปิดหน้าต่างครั้งแรก —
 * ตามที่โรงพยาบาลขอ ฝ่ายบริหารจึงปรับเวลาเองไม่ได้แล้วเช่นกัน (ปรับอัตโนมัติ
 * ล้วนๆ ตามคำขอที่เลือกไว้). */
function autoTimeParts(bookings: { startTime: string; endTime: string }[]): {
  startHour: string;
  startMinute: MinuteOption;
  endHour: string;
  endMinute: MinuteOption;
} {
  const starts = bookings.map((b) => new Date(b.startTime).getTime()).filter((t) => !Number.isNaN(t));
  const ends = bookings.map((b) => new Date(b.endTime).getTime()).filter((t) => !Number.isNaN(t));
  const now = new Date();
  const start = starts.length > 0 ? new Date(Math.min(...starts)) : now;
  const end = ends.length > 0 ? new Date(Math.max(...ends)) : new Date(now.getTime() + 60 * 60 * 1000);

  start.setSeconds(0, 0);
  const startMinutes = start.getMinutes();
  if (startMinutes !== 0 && startMinutes !== 30) {
    start.setMinutes(startMinutes < 30 ? 0 : 30);
  }
  end.setSeconds(0, 0);
  const endMinutes = end.getMinutes();
  if (endMinutes !== 0 && endMinutes !== 30) {
    end.setMinutes(endMinutes < 30 ? 30 : 0);
    if (endMinutes > 30) end.setHours(end.getHours() + 1);
  }

  return {
    startHour: pad2(start.getHours()),
    startMinute: start.getMinutes() === 30 ? "30" : "00",
    endHour: pad2(end.getHours()),
    endMinute: end.getMinutes() === 30 ? "30" : "00",
  };
}

/**
 * ใบสั่งงาน/ใบเดินทาง — วิธีเดียวที่ฝ่ายบริหาร/superadmin จะ "อนุมัติ" การจอง
 * รถได้ในระบบใหม่นี้ ระบุรถ + คนขับ + เวลารวม แล้วออกใบสั่งงานอ้างอิงคำขอจอง
 * เดิมหลายรายการพร้อมกัน (การเลือกมากกว่า 1 รายการ = ฟีเจอร์ "รวมเที่ยว/
 * คาร์พูล" ในตัว ไม่มีขั้นตอนรวมแยกต่างหาก) — ข้อมูลคำขอจองเดิมของผู้ขอ
 * (วัตถุประสงค์ ปลายทาง ผู้ร่วมเดินทาง ฯลฯ) จะไม่ถูกแก้ไขเลย ตามที่โรงพยาบาล
 * ขอไว้อย่างชัดเจน — ดู createTripOrder ใน lib/sheets.ts
 *
 * ใช้ได้สองโหมดจากคอมโพเนนต์เดียวกัน: สร้างใหม่ (ไม่ส่ง `editing`, เรียก
 * `onCreated` — POST /api/booking/trip-orders) หรือแก้ไขใบสั่งงานที่ออกไป
 * แล้ว (ส่ง `editing`, เรียก `onUpdated` แทน — PATCH
 * /api/booking/trip-orders/[tripOrderId]) — แก้ได้เฉพาะรถ/คนขับ/เวลา/
 * หมายเหตุ ("เท่าที่จำเป็น" ตามที่โรงพยาบาลขอ) รายการคำขอจองที่ครอบคลุมอยู่
 * เดิมจะไม่ถูกแก้ไข/เอาออกในโหมดแก้ไข (แสดงไว้ให้ดูอย่างเดียว เหมือนโหมดสร้าง
 * ใหม่) — *เพิ่ม* รายการใหม่เข้าไปได้เท่านั้น ดูย่อหน้าถัดไป.
 *
 * ถ้าผู้เรียกส่ง `candidateBookings` มาด้วย (คำขอจองรถ "รออนุมัติ" อื่นๆ ที่
 * ยังไม่ถูกเลือกไว้แต่แรก) คอมโพเนนต์นี้จะกรองให้เหลือเฉพาะวันเดียวกับคำขอที่
 * เลือก/ครอบคลุมอยู่แล้ว แล้วแสดงเป็นรายการให้ติ๊กเพิ่มเข้าใบสั่งงานเดียวกัน
 * ได้เอง — สำหรับกรณีเดินทางไปทางเดียวกัน/วันเดียวกัน ใช้ได้ทั้งสองโหมด:
 * โหมดสร้างใหม่ (ตามที่โรงพยาบาลขอเพิ่มภายหลัง) และโหมดแก้ไข (ตามที่ขอเพิ่ม
 * อีกครั้งภายหลัง — "เผื่อในกรณีอนุมัติไปแล้ว แต่มีกลุ่มที่ต้องการเดินทางไปด้วย
 * จะได้สามารถแก้ไขและเพิ่มรายการใหม่เข้าไปได้" — ใบสั่งงานเดิมยังคงเป็นใบ
 * เดียวกัน ไม่มีการออกใบใหม่หรือย้ายรายการข้ามใบ) ยังคงเป็นแค่ "เลือกได้เอง"
 * ไม่มีการจัดกลุ่มอัตโนมัติทั้งสองโหมด — เวลารวมของใบสั่งงาน (ดู autoTimeParts
 * ด้านล่าง) จะขยายให้ครอบคลุมรายการที่เพิ่งติ๊กเพิ่มโดยอัตโนมัติถ้าจำเป็น ไม่ว่า
 * จะอยู่โหมดไหนก็ตาม.
 *
 * โหมดแก้ไขเท่านั้น — ตรงข้ามกับการติ๊กเพิ่มด้านบน: แต่ละรายการที่ใบสั่งงาน
 * ครอบคลุม*อยู่เดิม*แล้ว (ไม่ใช่รายการที่เพิ่งติ๊กเพิ่มในหน้าต่างนี้ ซึ่งยังไม่ถูก
 * บันทึกจริง) มีปุ่ม "แยกออก" ของตัวเอง ให้แยกกลับไปเป็น "รออนุมัติ" ตั้งแต่ต้น
 * ได้ทีละรายการ (ตามที่ขอเพิ่มภายหลัง — "อยากให้สามารถแยกรายการการเดินทางที่
 * อนุมัติไปแล้วได้") แสดงเฉพาะเมื่อใบสั่งงานนี้ยังครอบคลุมมากกว่า 1 รายการ (แยก
 * จนว่างเปล่าไม่ได้) เรียก PATCH /api/booking/trip-orders/[tripOrderId] ด้วย
 * `removeBookingId` — ดู splitBookingFromTripOrder ใน lib/sheets.ts สำหรับ
 * รายละเอียดว่าคำขอที่ถูกแยกออกกลับไปอยู่ในสถานะอะไร
 */
export default function TripOrderModal({
  bookings,
  candidateBookings,
  resources,
  drivers,
  existingTripOrders,
  editing,
  onClose,
  onCreated,
  onUpdated,
  onBookingSplit,
}: {
  /** โหมดสร้างใหม่: คำขอจองรถที่ยังรออนุมัติที่ถูกเลือกไว้ (อย่างน้อย 1
   * รายการ) — ทุกรายการต้องเป็นรถและสถานะ pending อยู่แล้ว. โหมดแก้ไข:
   * รายการคำขอที่ใบสั่งงานนี้ครอบคลุมอยู่แล้ว (แสดงผลอย่างเดียว ไม่เปลี่ยน
   * ได้ตรงนี้) — คัดกรองมาจากผู้เรียกใช้ทั้งสองกรณี. */
  bookings: Booking[];
  /** ใช้ได้ทั้งสองโหมด — คำขอจองรถ "รออนุมัติ" อื่นๆ ที่ยังไม่ได้เลือก/ยังไม่
   * ถูกครอบคลุมไว้ ให้ผู้ใช้เลือกเพิ่มเข้าใบสั่งงานเดียวกันได้เอง ถ้าจะเดินทาง
   * ไปด้วยกัน (โหมดแก้ไข: เพิ่มเข้าใบสั่งงานที่อนุมัติไปแล้ว ตามที่โรงพยาบาล
   * ขอเพิ่มภายหลัง) คอมโพเนนต์นี้กรองเหลือเฉพาะวันเดียวกับ `bookings` ที่
   * เลือก/ครอบคลุมอยู่แล้วให้เอง (ไม่ต้องกรองมาก่อน) และตัด bookingId ที่ซ้ำ
   * กับ `bookings` ออกให้เองด้วย. */
  candidateBookings?: Booking[];
  /** รถที่เปิดใช้งานอยู่ (ประเภท car) — ในโหมดแก้ไข ถ้ารถที่ถูกมอบหมายไว้เดิม
   * ไม่อยู่ในรายการนี้แล้ว (เช่น ถูกปิดใช้งานไปหลังออกใบสั่งงาน) คอมโพเนนต์นี้
   * จะเติมให้เองเพื่อให้ตัวเลือกเดิมยังแสดงถูกต้อง. */
  resources: BookingResource[];
  /** คนขับที่เปิดใช้งานอยู่ — ใช้เป็นตัวเลือกใน select "ชื่อพนักงานขับรถ"
   * ด้านล่าง แทนที่จะต้องพิมพ์ชื่อใหม่ทุกครั้ง (ดึงมาเป็นตัวเลือกในกระบวนการ
   * จัดรถ ตามที่ขอ) ว่างได้ (ยังไม่มีคนขับลงทะเบียนไว้เลย) — คอมโพเนนต์นี้จะ
   * สลับไปโหมดพิมพ์ชื่อเองอัตโนมัติเมื่อว่าง ดูคอมเมนต์ที่ manualDriverEntry
   * ด้านล่าง. */
  drivers: Driver[];
  /** ใบสั่งงานเดินทางทั้งหมดที่ออกไปแล้ว (ทุกคัน/ทุกวัน) — ใช้เช็คว่ารถคันไหน
   * "ไม่ว่าง" ในช่วงเวลาของใบสั่งงานนี้บ้าง (ถูกจัดไปทับกับใบสั่งงานอื่นแล้ว)
   * เพื่อล็อกไม่ให้เลือกซ้ำ ตามที่ขอเพิ่มภายหลัง — ดู conflictingResourceIds
   * ด้านล่าง คอมโพเนนต์นี้กรองเทียบช่วงเวลาเองทั้งหมด ผู้เรียกส่งมาทั้งก้อนได้
   * เลยไม่ต้องกรองมาก่อน. */
  existingTripOrders: TripOrder[];
  /** ใส่ค่านี้เพื่อเปิดในโหมดแก้ไขใบสั่งงานที่มีอยู่แล้ว — ไม่ใส่ = โหมดสร้างใหม่. */
  editing?: TripOrder;
  onClose: () => void;
  /** โหมดสร้างใหม่เท่านั้น */
  onCreated?: (result: { tripOrder: TripOrder; bookings: Booking[] }) => void;
  /** โหมดแก้ไขเท่านั้น — `addedBookings` ว่างเปล่าถ้าไม่ได้ติ๊กเพิ่มคำขอใหม่
   * เข้ามาเลย (แก้แค่รถ/คนขับ/หมายเหตุตามปกติ) ไม่ว่างเมื่อมีการเพิ่ม (ตามที่
   * ขอเพิ่มภายหลัง — ดูคอมเมนต์ที่ eligibleCandidates ด้านบน) ผู้เรียกต้อง
   * merge รายการเหล่านี้เข้า state การจองเองด้วย ไม่ใช่แค่ TripOrder. */
  onUpdated?: (result: { tripOrder: TripOrder; addedBookings: Booking[] }) => void;
  /** โหมดแก้ไขเท่านั้น — เรียกเมื่อกด "แยกออก" สำเร็จ (ดูคอมเมนต์ที่หัว
   * คอมโพเนนต์ด้านบน) ผู้เรียกต้องปรับ state ทั้ง TripOrder (bookingIds ที่
   * ตัดออกแล้ว) และ Booking (กลับไปเป็นรออนุมัติ) เอง — คอมโพเนนต์นี้ไม่ปิด
   * หน้าต่างให้อัตโนมัติหลังแยกสำเร็จ ปล่อยให้ผู้เรียกตัดสินใจเอง (เหมือนกับที่
   * onUpdated ไม่ปิดหน้าต่างเองเช่นกัน). */
  onBookingSplit?: (result: { tripOrder: TripOrder; booking: Booking }) => void;
}) {
  // วันที่ (YYYY-MM-DD) ของคำขอที่เลือกไว้แต่แรกทั้งหมด — ใช้กรอง
  // candidateBookings ให้เหลือเฉพาะวันเดียวกัน (ดูคอมเมนต์ที่ prop ด้านบน)
  const initialDates = useMemo(() => new Set(bookings.map((b) => b.startTime.slice(0, 10))), [bookings]);
  // ตัวเลือก "เพิ่มคำขออื่น" ที่แสดงจริง — ใช้ได้ทั้งสองโหมดแล้ว (เดิมเฉพาะ
  // โหมดสร้างใหม่ — เปิดให้ใช้ในโหมดแก้ไขด้วยตามที่ขอเพิ่มภายหลัง) กรองเหลือ
  // เฉพาะวันเดียวกับที่เลือก/ครอบคลุมไว้แล้ว และไม่ซ้ำกับที่เลือก/ครอบคลุมอยู่
  // แล้ว — ผู้เรียกเป็นคนกำหนดว่าจะส่ง candidateBookings มาด้วยหรือไม่
  // (ไม่ส่งมา = ไม่มีให้เลือกเพิ่ม ไม่ว่าโหมดไหน)
  const eligibleCandidates = useMemo(
    () =>
      (candidateBookings ?? []).filter(
        (b) => initialDates.has(b.startTime.slice(0, 10)) && !bookings.some((ib) => ib.bookingId === b.bookingId)
      ),
    [candidateBookings, initialDates, bookings]
  );
  // คำขอที่ผู้ใช้ติ๊กเพิ่มจาก eligibleCandidates (bookingId) — เริ่มว่างเสมอ
  // ผู้ใช้ต้องเลือกเองทีละรายการ ไม่มีการเลือกอัตโนมัติ
  const [extraBookingIds, setExtraBookingIds] = useState<Set<string>>(new Set());
  function toggleExtra(bookingId: string) {
    setExtraBookingIds((prev) => {
      const next = new Set(prev);
      if (next.has(bookingId)) next.delete(bookingId);
      else next.add(bookingId);
      return next;
    });
  }
  // รายการที่จะรวมในใบสั่งงานจริง (ที่เลือกไว้แต่แรก + ที่เพิ่งติ๊กเพิ่ม) —
  // ใช้แทน `bookings` เดิมทุกจุดที่ต้องนับ/แสดง/ส่งไป API ยกเว้นกล่องแสดงผล
  // อย่างเดียวของโหมดแก้ไขซึ่งไม่มี extraBookingIds ให้เพิ่มอยู่แล้ว
  const includedBookings = useMemo(
    () => [...bookings, ...eligibleCandidates.filter((b) => extraBookingIds.has(b.bookingId))],
    [bookings, eligibleCandidates, extraBookingIds]
  );
  const effectiveResources = useMemo(() => {
    if (editing && !resources.some((r) => r.resourceId === editing.resourceId)) {
      const placeholder: BookingResource = {
        resourceId: editing.resourceId,
        type: "car",
        name: `${editing.resourceName} (ปิดใช้งานแล้ว)`,
        detail: "",
        active: false,
        createdAt: "",
        createdByUsername: "",
        imageDataUrl: "",
        seatCount: 0,
      };
      return [placeholder, ...resources];
    }
    return resources;
  }, [resources, editing]);

  const [resourceId, setResourceId] = useState(editing?.resourceId ?? resources[0]?.resourceId ?? "");
  // วันเดินทางเดียว ไม่ให้เลือกเอง — คำขอที่รวมกันได้ต้องเป็นวันเดียวกัน
  // ทุกรายการเสมออยู่แล้ว (บังคับผ่าน eligibleCandidates ข้างบน) จึงไม่มี
  // ความจำเป็นต้องมีช่องเลือกวันที่ให้ฝ่ายบริหารกรอก ตามที่ขอ — ในโหมดแก้ไข
  // ใช้วันที่ของใบสั่งงานเดิม ในโหมดสร้างใหม่ใช้วันที่ของคำขอที่เลือกไว้แรก
  // สุด (ทุกรายการอยู่วันเดียวกันอยู่แล้วไม่ว่าจะอ้างอิงรายการไหน)
  const tripDateKey = useMemo(
    () => (editing ? editing.startTime : (bookings[0]?.startTime ?? "")).slice(0, 10),
    [editing, bookings]
  );
  // เวลารวมของใบสั่งงาน — คำนวณอัตโนมัติล้วนๆ ตามที่ขอเพิ่มภายหลัง (ล็อกไม่
  // ให้ฝ่ายบริหารแก้ไขเวลาเองได้อีกเลย ไม่ใช่แค่ "auto-suggest แต่ยังแก้ได้"
  // แบบก่อนหน้านี้) จึงไม่มี state/select ให้กรอกอีกต่อไป เหลือแค่ค่าที่คำนวณ
  // มาแสดงผลอย่างเดียว (เหมือนวันเดินทางด้านล่างที่ล็อกไว้อยู่แล้วเช่นกัน) —
  // โหมดสร้างใหม่: จากเวลาเริ่มเร็วที่สุด/สิ้นสุดช้าที่สุดของคำขอที่เลือกไว้
  // ทั้งหมด (autoTimeParts ด้านบน) คำนวณใหม่ทุกครั้งที่ includedBookings
  // เปลี่ยน (ติ๊กเพิ่ม/ถอนคำขออื่น) โหมดแก้ไข: ใช้เวลาที่บันทึกไว้ในใบสั่งงาน
  // เดิมเป็นฐานเสมอ (ไม่หดแคบกว่าที่บันทึกไว้แต่แรกเด็ดขาด แม้จะเคยถูกฝ่าย
  // บริหารปรับกว้างกว่าคำขอเดิมไว้ก่อนหน้านี้ก็ตาม) — แต่ถ้ามีการติ๊กเพิ่มคำขอ
  // ใหม่เข้ามา (ตามที่ขอเพิ่มภายหลัง — ดูคอมเมนต์ที่ eligibleCandidates
  // ด้านบน) จะขยายช่วงเวลาให้ครอบคลุมคำขอที่เพิ่งเพิ่มเข้ามาโดยอัตโนมัติด้วย
  // เช่นกัน (ไม่ขยายเกินความจำเป็น — ยังปัดลง/ปัดขึ้นครึ่งชั่วโมงแบบเดียวกับ
  // โหมดสร้างใหม่)
  const { startHour, startMinute, endHour, endMinute } = useMemo(() => {
    if (!editing) return autoTimeParts(includedBookings);
    const addedBookings = includedBookings.filter((b) => !bookings.some((ib) => ib.bookingId === b.bookingId));
    if (addedBookings.length === 0) {
      return autoTimeParts([{ startTime: editing.startTime, endTime: editing.endTime }]);
    }
    return autoTimeParts([{ startTime: editing.startTime, endTime: editing.endTime }, ...addedBookings]);
  }, [editing, includedBookings, bookings]);
  const startTime = combineDateTime(tripDateKey, startHour, startMinute);
  const endTime = combineDateTime(tripDateKey, endHour, endMinute);

  /** รถที่ "ไม่ว่าง" สำหรับช่วงเวลารวมของใบสั่งงานนี้ — คือรถที่ถูกใบสั่งงาน
   * อื่น (ที่ยังไม่ถูกยกเลิก/ไม่ใช่ใบนี้เอง) จัดคาบเกี่ยวกับช่วงเวลานี้ไปแล้ว
   * ตามที่ขอเพิ่มภายหลัง ("เอาออกไม่ให้เป็นตัวเลือก หรืออยู่สถานะล็อกไม่ให้
   * เลือก") — เลือกทำแบบล็อกไว้ (แสดงในรายการแต่กดเลือกไม่ได้ + บอกเหตุผล)
   * แทนการเอาออกทั้งหมด ให้ฝ่ายบริหารยังเห็นว่ารถคันนั้นมีอยู่แต่ไม่ว่าง
   * ไม่ใช่หายไปเฉยๆ โดยไม่มีคำอธิบาย
   *
   * ตรวจแบบ "ช่วงเวลาคาบเกี่ยวกัน" มาตรฐาน (start1 < end2 && start2 < end1)
   * — ตัวแปร startTime/endTime ที่นี่เป็นสตริง "YYYY-MM-DDTHH:MM" แบบเดียวกับ
   * TripOrder.startTime/endTime เทียบกันตรงๆ ด้วย string comparison ได้เลย
   * (ตามรูปแบบเดียวกับ nowDateTimeStr ใน BookingFormModal.tsx) โหมดแก้ไข
   * ไม่เทียบกับใบสั่งงานเดิมของตัวเอง (editing.tripOrderId) — ไม่งั้นจะชนกับ
   * ตัวเองเสมอ */
  const conflictingResourceIds = useMemo(() => {
    const ids = new Set<string>();
    if (!startTime || !endTime) return ids;
    for (const t of existingTripOrders) {
      if (editing && t.tripOrderId === editing.tripOrderId) continue;
      if (t.startTime < endTime && startTime < t.endTime) ids.add(t.resourceId);
    }
    return ids;
  }, [existingTripOrders, editing, startTime, endTime]);

  /** ค่าที่ "ใช้จริง" สำหรับแสดง/เลือก/ส่งบันทึก — ต่างจาก resourceId (state
   * ดิบที่ผู้ใช้กดเลือกเอง หรือค่าเริ่มต้น) ตรงที่คำนวณสดทุกครั้งที่เรนเดอร์
   * แทนการ setState ในนี้ ถ้ารถที่เลือกอยู่กลายเป็น "ไม่ว่าง" (เช่น ค่า
   * default ตอนเปิดหน้าต่าง หรือช่วงเวลารวมขยับไปชนหลังติ๊กเพิ่ม/ถอนคำขอ) จะ
   * สลับไปคันแรกที่ยังว่างให้อัตโนมัติ โดยไม่แตะ resourceId เดิมเลย — ถ้า
   * ภายหลังช่วงเวลาขยับกลับมาไม่ชนแล้ว ค่าที่ผู้ใช้เลือกไว้แต่แรกจะกลับมาใช้
   * เองโดยอัตโนมัติเช่นกัน (ไม่มีอะไรถูกลืมค่าไว้ถาวร) */
  const selectedResourceId = conflictingResourceIds.has(resourceId)
    ? (effectiveResources.find((r) => !conflictingResourceIds.has(r.resourceId))?.resourceId ?? resourceId)
    : resourceId;
  // พรีวิวรูป+รายละเอียดของรถที่เลือกอยู่จริง (selectedResourceId ไม่ใช่
  // resourceId ดิบ — ดูคอมเมนต์ด้านบน) — เหมือนกับตอนจองรถใหม่ใน
  // BookingFormModal.tsx ทุกประการ (ดูคอมเมนต์ที่นั่นสำหรับรายละเอียด) ให้
  // ฝ่ายบริหารเห็นรถจริงก่อนออกใบสั่งงาน ไม่ใช่แค่ชื่อเฉยๆ ตามที่ขอ
  const selectedResource = effectiveResources.find((r) => r.resourceId === selectedResourceId);

  // เส้นเวลาเดินทาง — โซนเวลาที่แสดงคือเวลารวมของใบสั่งงาน (startHour:
  // startMinute – endHour:endMinute ด้านบน) เพราะการันตีครอบคลุมทุกคำขอที่
  // เลือกไว้อยู่แล้ว (มาจาก autoTimeParts ตัวเดียวกัน) แต่ละแถบด้านล่างคือ
  // ช่วงเวลาที่คำขอแต่ละรายการระบุไว้เอง วางเทียบกันให้เห็นว่าใครไปช่วงไหน
  // กับรถคันเดียวกันนี้บ้าง ตามที่ขอ ("สวยๆ")
  const timelineDomain = useMemo(() => {
    const startMin = Number(startHour) * 60 + Number(startMinute);
    const rawEndMin = Number(endHour) * 60 + Number(endMinute);
    return { startMin, endMin: rawEndMin > startMin ? rawEndMin : startMin + 30 };
  }, [startHour, startMinute, endHour, endMinute]);
  const timelineRows = useMemo(() => {
    const domainSpan = Math.max(timelineDomain.endMin - timelineDomain.startMin, 1);
    return includedBookings.map((b) => {
      const startParts = splitBookingDateTime(b.startTime);
      const endParts = splitBookingDateTime(b.endTime);
      const bStartMin = startParts
        ? Number(startParts.time.slice(0, 2)) * 60 + Number(startParts.time.slice(3, 5))
        : timelineDomain.startMin;
      const bEndMin = endParts
        ? Number(endParts.time.slice(0, 2)) * 60 + Number(endParts.time.slice(3, 5))
        : timelineDomain.endMin;
      const leftPct = Math.min(100, Math.max(0, ((bStartMin - timelineDomain.startMin) / domainSpan) * 100));
      const rawWidthPct = ((bEndMin - bStartMin) / domainSpan) * 100;
      // ความกว้างขั้นต่ำ 3% กันแถบหายไปเลยตอนช่วงเวลาสั้นมากเทียบกับช่วงรวม
      const widthPct = Math.min(100 - leftPct, Math.max(rawWidthPct, 3));
      return {
        bookingId: b.bookingId,
        label: b.department || b.bookedByDisplayName || b.bookedByUsername,
        timeLabel: `${startParts?.time ?? "--:--"}–${endParts?.time ?? "--:--"}`,
        leftPct,
        widthPct,
      };
    });
  }, [includedBookings, timelineDomain]);
  // สีประจำแต่ละแถว — ใช้ชุดสีเดียวกับที่ใช้ทั่วทั้งแอป (buildActionColorMap,
  // ผ่านการตรวจสอบ colorblind-safe แล้ว ดู lib/actionColors.ts) คีย์ด้วย
  // bookingId เพื่อให้สีคงที่ตราบใดที่ยังไม่มีการติ๊กเพิ่ม/ถอนคำขอ
  const timelineColorMap = useMemo(
    () => buildActionColorMap(includedBookings.map((b) => b.bookingId)),
    [includedBookings]
  );
  // ขีดบอกเวลา — ตำแหน่ง (leftPct) คำนวณจาก timelineDomain เดียวกับแถบสีของ
  // แต่ละคำขอด้านบน จึงอยู่แนวเดียวกันเป๊ะ ใช้ทั้งเป็นป้ายเวลาใต้เส้น และเป็น
  // เส้นไกด์บางๆ พาดผ่านแต่ละแถบด้วย (ดูจุดที่ใช้ด้านล่าง) ตามที่ขอเพิ่มภายหลัง
  const timelineTicks = useMemo(() => {
    const domainSpan = Math.max(timelineDomain.endMin - timelineDomain.startMin, 1);
    const step = pickTickStepMinutes(domainSpan);
    const firstTick = Math.ceil(timelineDomain.startMin / step) * step;
    const ticks: { min: number; label: string; leftPct: number }[] = [];
    for (let m = firstTick; m <= timelineDomain.endMin; m += step) {
      ticks.push({
        min: m,
        label: `${pad2(Math.floor(m / 60) % 24)}:${pad2(m % 60)}`,
        leftPct: ((m - timelineDomain.startMin) / domainSpan) * 100,
      });
    }
    return ticks;
  }, [timelineDomain]);

  const [driverName, setDriverName] = useState(editing?.driverName ?? "");
  // true = ช่อง "ชื่อพนักงานขับรถ" แสดงเป็นกล่องพิมพ์ชื่อเอง (input ธรรมดา),
  // false = แสดงเป็น select เลือกจากรายชื่อคนขับที่ลงทะเบียนไว้ (drivers
  // prop) — ค่าเริ่มต้นคำนวณครั้งเดียวตอนเปิดหน้าต่าง (lazy initializer):
  // ยังไม่มีคนขับในระบบเลย (drivers ว่าง) เริ่มเป็นโหมดพิมพ์เองเสมอ (ไม่มี
  // อะไรให้เลือก); โหมดแก้ไขที่ชื่อคนขับเดิมไม่ตรงกับใครในรายชื่อพอดี (เช่น
  // พิมพ์เองไว้ตั้งแต่ก่อนมีฟีเจอร์นี้ หรือคนขับคนนั้นถูกปิดใช้งานไปแล้ว) ก็
  // เริ่มเป็นโหมดพิมพ์เองเช่นกัน เพื่อไม่ให้ชื่อเดิมหายไปจากจอ — นอกนั้นเริ่ม
  // เป็นโหมด select เสมอ (รวมถึงตอนสร้างใหม่ที่มีคนขับให้เลือกแล้ว)
  const [manualDriverEntry, setManualDriverEntry] = useState(() => {
    if (drivers.length === 0) return true;
    if (editing && editing.driverName && !drivers.some((d) => d.name === editing.driverName)) return true;
    return false;
  });
  const [notes, setNotes] = useState(editing?.notes ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // true เฉพาะตอนบันทึกไม่สำเร็จเพราะเซสชันหลุด (401) — ดูคอมเมนต์อธิบาย
  // เต็มๆ ที่ BookingFormModal.tsx ซึ่งเจอปัญหาเดียวกันนี้ก่อน
  const [sessionExpired, setSessionExpired] = useState(false);
  // bookingId ที่กำลังแยกออกอยู่ (โหมดแก้ไขเท่านั้น) — ใช้ปิดปุ่ม "แยกออก" ของ
  // แถวนั้นระหว่างรอผลจาก API ไม่ปิดทั้งฟอร์ม (ต่างจาก `saving` ที่ใช้กับการ
  // บันทึกฟอร์มหลักทั้งก้อน) กันกดซ้ำ/กดหลายแถวพร้อมกัน
  const [splittingId, setSplittingId] = useState<string | null>(null);
  const firstInputRef = useRef<HTMLSelectElement | null>(null);

  useEffect(() => {
    firstInputRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const totalParticipants = includedBookings.reduce((sum, b) => sum + b.participants, 0);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!selectedResourceId) {
      setError("กรุณาเลือกรถที่จะใช้");
      return;
    }
    if (conflictingResourceIds.has(selectedResourceId)) {
      setError("รถคันนี้ถูกจัดไปในใบสั่งงานอื่นทับช่วงเวลานี้แล้ว กรุณาเลือกคันอื่น");
      return;
    }
    if (!driverName.trim()) {
      setError("กรุณาระบุชื่อพนักงานขับรถ");
      return;
    }
    if (!startTime || !endTime) {
      setError("กรุณาระบุวันเวลาเริ่มต้นและสิ้นสุด");
      return;
    }
    if (startTime >= endTime) {
      setError("เวลาสิ้นสุดต้องอยู่หลังเวลาเริ่มต้น");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      if (editing) {
        const res = await fetch(`/api/booking/trip-orders/${editing.tripOrderId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            resourceId: selectedResourceId,
            driverName: driverName.trim(),
            startTime,
            endTime,
            notes: notes.trim(),
            // คำขอที่เพิ่งติ๊กเพิ่มจาก eligibleCandidates เท่านั้น (ไม่ใช่
            // includedBookings ทั้งก้อน) — รายการเดิมที่ใบสั่งงานนี้ครอบคลุม
            // อยู่แล้วไม่ต้องส่งซ้ำ ดูคอมเมนต์ที่ updateTripOrder ใน
            // lib/sheets.ts ว่ารายการซ้ำ/ที่ครอบคลุมอยู่แล้วจะถูกข้ามอยู่แล้ว
            // เช่นกัน แต่ส่งเฉพาะของใหม่ตั้งแต่ต้นให้ชัดเจนกว่า
            addBookingIds: [...extraBookingIds],
          }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          if (res.status === 401) {
            setSessionExpired(true);
            setError("เซสชันหมดอายุ หรือมีการเข้าสู่ระบบบัญชีนี้จากที่อื่น กรุณาเข้าสู่ระบบใหม่อีกครั้ง (ข้อมูลที่แก้ไขไว้จะหายไป)");
          } else {
            setError(json.error || "บันทึกการแก้ไขไม่สำเร็จ");
          }
          setSaving(false);
          return;
        }
        onUpdated?.({
          tripOrder: json.tripOrder as TripOrder,
          addedBookings: (Array.isArray(json.addedBookings) ? json.addedBookings : []) as Booking[],
        });
        return;
      }

      const res = await fetch("/api/booking/trip-orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resourceId: selectedResourceId,
          driverName: driverName.trim(),
          startTime,
          endTime,
          notes: notes.trim(),
          bookingIds: includedBookings.map((b) => b.bookingId),
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 401) {
          setSessionExpired(true);
          setError("เซสชันหมดอายุ หรือมีการเข้าสู่ระบบบัญชีนี้จากที่อื่น กรุณาเข้าสู่ระบบใหม่อีกครั้ง (ข้อมูลที่กรอกไว้จะหายไป)");
        } else {
          setError(json.error || "ออกใบสั่งงานไม่สำเร็จ");
        }
        setSaving(false);
        return;
      }
      onCreated?.(json as { tripOrder: TripOrder; bookings: Booking[] });
    } catch {
      setError(editing ? "บันทึกการแก้ไขไม่สำเร็จ กรุณาลองใหม่" : "ออกใบสั่งงานไม่สำเร็จ กรุณาลองใหม่");
      setSaving(false);
    }
  }

  /** แยกคำขอจองหนึ่งรายการออกจากใบสั่งงานนี้ — โหมดแก้ไขเท่านั้น (ปุ่มนี้ไม่
   * แสดงเลยนอกโหมดแก้ไข ดู render ด้านล่าง) เป็นการเปลี่ยนสถานะที่ย้อนกลับได้
   * ยากกว่าการติ๊กเพิ่ม/ยกเลิกทั่วไป (คำขอกลับไปรออนุมัติ ต้องออกใบสั่งงานแยก
   * ให้ใหม่) จึงยืนยันก่อนเสมอ เหมือนรูปแบบ window.confirm ที่ใช้อยู่แล้วกับ
   * handleCancelBooking ใน BookingDashboard.tsx */
  async function handleSplit(booking: Booking) {
    if (!editing) return;
    const confirmed = window.confirm(
      `ยืนยันแยก "${booking.department || booking.bookedByDisplayName || booking.bookedByUsername}" (${formatBookingDateRange(
        booking.startTime,
        booking.endTime
      )}) ออกจากใบสั่งงานนี้ใช่หรือไม่?\n\nคำขอนี้จะกลับไปเป็น "รอจัดรถ" และต้องออกใบสั่งงานแยกให้ใหม่`
    );
    if (!confirmed) return;

    setSplittingId(booking.bookingId);
    setError(null);
    try {
      const res = await fetch(`/api/booking/trip-orders/${editing.tripOrderId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ removeBookingId: booking.bookingId }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 401) {
          setSessionExpired(true);
          setError("เซสชันหมดอายุ หรือมีการเข้าสู่ระบบบัญชีนี้จากที่อื่น กรุณาเข้าสู่ระบบใหม่อีกครั้ง");
        } else {
          setError(json.error || "แยกรายการออกไม่สำเร็จ");
        }
        return;
      }
      onBookingSplit?.({ tripOrder: json.tripOrder as TripOrder, booking: json.booking as Booking });
    } catch {
      setError("แยกรายการออกไม่สำเร็จ กรุณาลองใหม่");
    } finally {
      setSplittingId(null);
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="trip-order-modal-title"
        className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl bg-white shadow-xl dark:bg-zinc-900"
      >
        <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-4 dark:border-zinc-800">
          <h2
            id="trip-order-modal-title"
            className="flex items-center gap-2 text-base font-semibold text-zinc-800 dark:text-zinc-100"
          >
            <Truck size={18} strokeWidth={2} className="shrink-0 text-[var(--brand-strong)]" aria-hidden="true" />
            {editing ? "แก้ไขใบสั่งงานเดินทาง" : "คำขอการเดินทาง"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="ปิดหน้าต่าง"
            className="rounded-full p-1.5 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800"
          >
            <X size={18} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
        <div className="overflow-y-auto px-5 py-4">
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            {/* รายการคำขอจองที่ถูกเลือกไว้ — ย้ายมาไว้บนสุดตามที่ขอ (เดิมอยู่
                ถัดจาก error) แสดงเป็นการยืนยันเท่านั้น ข้อมูลของแต่ละคำขอจะ
                ไม่ถูกแก้ไข ใบสั่งงานนี้เป็นระเบียนแยกต่างหากที่อ้างอิงคำขอ
                เหล่านี้เท่านั้น ตามที่โรงพยาบาลขอ */}
            <div className="flex flex-col gap-1.5 rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-700 dark:bg-zinc-800/60">
              <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
                {editing
                  ? `คำขอจองที่ใบสั่งงานนี้ครอบคลุม (${includedBookings.length.toLocaleString("th-TH")} รายการ) — แก้ไขตรงนี้ไม่ได้`
                  : `คำขอการเดินทาง (${includedBookings.length.toLocaleString("th-TH")} รายการ)`}
              </p>
              <ul className="flex flex-col gap-2">
                {includedBookings.map((b) => {
                  // "แยกออก" แสดงเฉพาะโหมดแก้ไข + รายการที่ใบสั่งงานครอบคลุม
                  // อยู่เดิมจริงๆ (มาจาก `bookings` prop ที่ผู้เรียกกรองมาให้ —
                  // ไม่ใช่รายการที่เพิ่งติ๊กเพิ่มใน eligibleCandidates ซึ่งยังไม่
                  // ถูกบันทึกเข้าใบสั่งงานจริง ยังไม่มีอะไรให้แยก) และต้องเหลือ
                  // มากกว่า 1 รายการหลังแยก (ดูคอมเมนต์ที่หัวคอมโพเนนต์ด้านบน)
                  const canSplit = !!editing && bookings.length > 1 && bookings.some((ob) => ob.bookingId === b.bookingId);
                  return (
                    // ลำดับใหม่ตามที่ขอ ("จัดลำดับเพื่อความสวยงาม") — วันที่+
                    // ช่วงเวลาขึ้นก่อนบรรทัดเดียว (ไม่เขียนวันที่ซ้ำสองรอบเมื่อ
                    // เป็นวันเดียวกัน ดู formatBookingDateRange) ตามด้วยกลุ่มงาน/
                    // วัตถุประสงค์ แล้วค่อยจำนวนผู้โดยสารของคำขอนั้นๆ (ตามที่ขอ
                    // เพิ่มภายหลัง — ให้เห็นที่มาที่ไปของยอดรวมด้านล่าง) แล้วค่อย
                    // ปลายทางท้ายสุด
                    <li
                      key={b.bookingId}
                      className="flex items-start justify-between gap-2 text-xs leading-5 text-zinc-600 dark:text-zinc-300"
                    >
                      <span className="flex flex-col gap-0.5">
                        <span className="font-medium text-zinc-800 dark:text-zinc-100">
                          {formatBookingDateRange(b.startTime, b.endTime)}
                        </span>
                        <span>
                          <BookingWhoAndPurpose booking={b} />
                          {extraBookingIds.has(b.bookingId) && (
                            <span className="ml-1 text-emerald-700 dark:text-emerald-400">(เพิ่มเข้ามา)</span>
                          )}
                        </span>
                        <span className="inline-flex items-center gap-1">
                          <Users size={11} strokeWidth={2} aria-hidden="true" className="shrink-0" />
                          {b.participants.toLocaleString("th-TH")} คน
                        </span>
                        {b.destination && <span>(ปลายทาง: {b.destination})</span>}
                      </span>
                      {canSplit && (
                        <button
                          type="button"
                          onClick={() => handleSplit(b)}
                          disabled={splittingId === b.bookingId}
                          className="inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-200 px-2 py-1 text-xs font-medium text-amber-700 transition-colors hover:bg-amber-50 disabled:opacity-60 dark:border-amber-900/50 dark:text-amber-300 dark:hover:bg-amber-950/30"
                        >
                          {splittingId === b.bookingId ? (
                            <Loader2 size={11} strokeWidth={2} className="animate-spin" aria-hidden="true" />
                          ) : (
                            <Scissors size={11} strokeWidth={2} aria-hidden="true" />
                          )}
                          แยกออก
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
              <p className="mt-0.5 inline-flex items-center gap-1 text-xs font-medium text-zinc-600 dark:text-zinc-300">
                <Users size={12} strokeWidth={2} aria-hidden="true" className="shrink-0" />
                รวมผู้โดยสารตามคำขอ {totalParticipants.toLocaleString("th-TH")} คน
              </p>
            </div>

            {/* เส้นเวลาการเดินทาง — ถัดจากรายการคำขอด้านบนตามที่ขอ (เดิมอยู่
                ถัดจากช่องเวลา ตอนนี้เวลาก็ล็อกไว้ไม่ให้แก้ไขแล้วด้วย จึงให้
                เห็นภาพรวมเวลาเดินทางก่อนเป็นอย่างแรกๆ) — แสดงให้เห็นว่า
                แต่ละคำขอที่รวมอยู่ในใบสั่งงานนี้เดินทางช่วงไหนบ้างเทียบกับ
                เวลารวมทั้งหมดของรถคันนี้ (แถบสีคือแต่ละคำขอ ตำแหน่ง/ความกว้าง
                คำนวณจาก timelineRows ด้านบน) ใช้ชุดสีเดียวกับที่ใช้ทั่วทั้งแอป
                (buildActionColorMap จาก lib/actionColors.ts ซึ่งผ่านการ
                ตรวจสอบ colorblind-safe แล้ว) ไม่สร้างชุดสีใหม่ ตามที่ขอ
                ("สวยๆ") */}
            {timelineRows.length > 0 && (
              <div className="flex flex-col gap-2.5 rounded-lg border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-700 dark:bg-zinc-800/60">
                <div className="flex items-center justify-between text-xs font-medium text-zinc-500 dark:text-zinc-400">
                  <span>เส้นเวลาการเดินทาง</span>
                  <span className="tabular-nums">
                    {startHour}:{startMinute} – {endHour}:{endMinute}
                  </span>
                </div>
                <div className="flex flex-col gap-1.5">
                  {timelineRows.map((row) => {
                    const color = timelineColorMap.get(row.bookingId);
                    return (
                      <div key={row.bookingId} className="flex items-center gap-2">
                        <span
                          className="w-20 shrink-0 truncate text-xs text-zinc-600 dark:text-zinc-300"
                          title={row.label}
                        >
                          {row.label}
                        </span>
                        <div className="relative h-5 flex-1 rounded-full bg-zinc-200 dark:bg-zinc-700">
                          {/* เส้นไกด์บางๆ ตามขีดเวลา — วางไว้ใต้แถบสี (ก่อนใน
                              DOM) ให้ดูเป็นพื้นหลังเบาๆ ไม่แย่งความสนใจจากแถบสี
                              เอง (recessive grid) ตามที่ขอเพิ่มภายหลัง */}
                          {timelineTicks.map((tick) => (
                            <span
                              key={tick.min}
                              className="absolute inset-y-0 w-px bg-zinc-300/70 dark:bg-zinc-600/70"
                              style={{ left: `${tick.leftPct}%` }}
                              aria-hidden="true"
                            />
                          ))}
                          {color && (
                            <div
                              className="absolute inset-y-0 rounded-full bg-[var(--seg-c)] dark:bg-[var(--seg-c-dark)]"
                              style={{ left: `${row.leftPct}%`, width: `${row.widthPct}%`, ...actionColorVars(color) }}
                              title={`${row.label}: ${row.timeLabel}`}
                            />
                          )}
                        </div>
                        <span className="w-24 shrink-0 text-right text-xs tabular-nums text-zinc-500 dark:text-zinc-400">
                          {row.timeLabel}
                        </span>
                      </div>
                    );
                  })}
                  {/* แถวขีดบอกเวลา — จัดวางด้วย layout เดียวกับแถวแถบสีด้านบน
                      ทุกประการ (spacer ซ้าย/ขวากว้างเท่ากัน) ตำแหน่งขีดจึง
                      ตรงกับเส้นไกด์ในแถบสีเป๊ะ ตามที่ขอ ("บอกเวลาเป็นช่วงๆ...
                      เห็นความห่างของเวลาได้ชัดเจนขึ้น") */}
                  {timelineTicks.length > 0 && (
                    <div className="flex items-center gap-2">
                      <span className="w-20 shrink-0" aria-hidden="true" />
                      <div className="relative h-3.5 flex-1">
                        {timelineTicks.map((tick) => (
                          <span
                            key={tick.min}
                            className="absolute top-0 -translate-x-1/2 text-[10px] tabular-nums text-zinc-400 first:translate-x-0 last:translate-x-[-100%] dark:text-zinc-500"
                            style={{ left: `${tick.leftPct}%` }}
                          >
                            {tick.label}
                          </span>
                        ))}
                      </div>
                      <span className="w-24 shrink-0" aria-hidden="true" />
                    </div>
                  )}
                </div>
              </div>
            )}

            {error && (
              <div role="alert" className="flex flex-col gap-1.5">
                <p className="flex items-start gap-2 text-sm text-red-700 dark:text-red-300">
                  <AlertTriangle size={16} strokeWidth={2} className="mt-0.5 shrink-0" aria-hidden="true" />
                  {error}
                </p>
                {sessionExpired && (
                  <button
                    type="button"
                    onClick={() => {
                      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- intentional hard navigation, same reasoning as BookingFormModal
                      window.location.href = "/login";
                    }}
                    className="ml-6 self-start text-sm font-medium text-red-700 underline underline-offset-2 hover:text-red-800 dark:text-red-300 dark:hover:text-red-200"
                  >
                    เข้าสู่ระบบใหม่
                  </button>
                )}
              </div>
            )}

            {/* คำขอจองรถ "รออนุมัติ" อื่นในวันเดียวกันที่ยังไม่ถูกเลือก/ยังไม่
                ถูกครอบคลุมไว้แต่แรก — ให้ติ๊กเพิ่มเข้าใบสั่งงานเดียวกันได้เอง
                ถ้าจะเดินทางไปทางเดียวกัน ใช้ได้ทั้งโหมดสร้างใหม่ (ตามที่
                โรงพยาบาลขอเพิ่มภายหลัง) และโหมดแก้ไข (ตามที่ขอเพิ่มอีกครั้ง
                ภายหลัง — เผื่อกรณีอนุมัติไปแล้วแต่มีกลุ่มอื่นอยากไปด้วย) */}
            {eligibleCandidates.length > 0 && (
              <div className="flex flex-col gap-1.5 rounded-xl border border-dashed border-sky-200 bg-sky-50/60 p-3 dark:border-sky-900/50 dark:bg-sky-950/20">
                <p className="text-xs font-medium text-sky-800 dark:text-sky-200">
                  {editing
                    ? "คำขอจองรถอื่นในวันเดียวกัน — เลือกเพิ่มเข้าใบสั่งงานนี้ได้ถ้าจะเดินทางไปด้วยกัน"
                    : "คำขอจองรถอื่นในวันเดียวกัน — เลือกเพิ่มได้ถ้าจะเดินทางไปด้วยกัน"}
                </p>
                <ul className="flex flex-col gap-2">
                  {eligibleCandidates.map((b) => (
                    // ลำดับ/แยกบรรทัดแบบเดียวกับกล่อง "คำขอการเดินทาง" ด้านบน
                    // ตามที่ขอ — วันที่+ช่วงเวลาก่อน ตามด้วยกลุ่มงาน/วัตถุประสงค์
                    // แล้วค่อยปลายทางท้ายสุด (ดู formatBookingDateRange/
                    // BookingWhoAndPurpose)
                    <li key={b.bookingId}>
                      <label className="flex cursor-pointer items-start gap-2 text-xs leading-5 text-zinc-600 dark:text-zinc-300">
                        <input
                          type="checkbox"
                          checked={extraBookingIds.has(b.bookingId)}
                          onChange={() => toggleExtra(b.bookingId)}
                          disabled={saving}
                          className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-[var(--brand)]"
                        />
                        <span className="flex flex-col gap-0.5">
                          <span className="font-medium text-zinc-800 dark:text-zinc-100">
                            {formatBookingDateRange(b.startTime, b.endTime)}
                          </span>
                          <span>
                            <BookingWhoAndPurpose booking={b} />
                          </span>
                          <span className="inline-flex items-center gap-1">
                            <Users size={11} strokeWidth={2} aria-hidden="true" className="shrink-0" />
                            {b.participants.toLocaleString("th-TH")} คน
                          </span>
                          {b.destination && <span>(ปลายทาง: {b.destination})</span>}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <label className="flex flex-col gap-1 text-sm text-zinc-600 dark:text-zinc-300">
              รถที่ใช้
              <select
                ref={firstInputRef}
                value={selectedResourceId}
                onChange={(e) => setResourceId(e.target.value)}
                disabled={saving || effectiveResources.length === 0}
                className={INPUT_CLASS}
              >
                {effectiveResources.length === 0 && <option value="">ไม่มีรถที่เปิดใช้งาน</option>}
                {effectiveResources.map((r) => {
                  const conflicted = conflictingResourceIds.has(r.resourceId);
                  return (
                    <option key={r.resourceId} value={r.resourceId} disabled={conflicted}>
                      {r.name}
                      {conflicted ? " — ไม่ว่าง (ถูกจัดในช่วงเวลานี้แล้ว)" : ""}
                    </option>
                  );
                })}
              </select>
              {/* ตัดข้อความสรุปแยกบรรทัดออกตามที่ขอ — คำอธิบาย "ไม่ว่าง" ต่อ
                  ท้ายชื่อรถแต่ละคันในตัวเลือก (ด้านบน) ให้ข้อมูลเพียงพออยู่
                  แล้วโดยไม่ต้องมีข้อความซ้ำเพิ่มอีกบรรทัด */}
            </label>

            {/* พรีวิวรูป+รายละเอียดของรถที่เลือกอยู่ — เหมือนกับตอนจองรถใหม่ใน
                BookingFormModal.tsx ทุกประการ (ดูคอมเมนต์ที่นั่นสำหรับ
                รายละเอียด) ให้ฝ่ายบริหารเห็นรถจริงก่อนออกใบสั่งงาน ไม่ใช่แค่
                ชื่อเฉยๆ ตามที่ขอ */}
            {effectiveResources.length > 0 && (
              <div className="flex items-center gap-3 rounded-lg border border-zinc-200 bg-zinc-50 p-2.5 dark:border-zinc-700 dark:bg-zinc-800/60">
                <div className="flex h-16 w-24 shrink-0 items-center justify-center overflow-hidden rounded-md bg-zinc-100 dark:bg-zinc-800">
                  {selectedResource?.imageDataUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element -- data: URL from the sheet, not a static/remote asset next/image can optimize
                    <img
                      src={selectedResource.imageDataUrl}
                      alt={selectedResource.name}
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <ImageOff size={16} strokeWidth={1.5} className="text-zinc-300 dark:text-zinc-600" aria-hidden="true" />
                  )}
                </div>
                <div className="min-w-0 text-xs text-zinc-500 dark:text-zinc-400">
                  {selectedResource?.detail ? (
                    // whitespace-pre-line: คงการขึ้นบรรทัดใหม่ตามที่พิมพ์ไว้ใน
                    // ช่อง "รายละเอียดเพิ่มเติม" เหมือน BookingFormModal.tsx
                    <p className="whitespace-pre-line leading-5">{selectedResource.detail}</p>
                  ) : (
                    <p className="italic">ไม่มีรายละเอียดเพิ่มเติม</p>
                  )}
                  {!!selectedResource?.seatCount && (
                    <p className="mt-0.5 leading-5">{selectedResource.seatCount.toLocaleString("th-TH")} ที่นั่ง</p>
                  )}
                </div>
              </div>
            )}

            <label className="flex flex-col gap-1 text-sm text-zinc-600 dark:text-zinc-300">
              ชื่อพนักงานขับรถ
              {manualDriverEntry ? (
                <>
                  <input
                    type="text"
                    value={driverName}
                    onChange={(e) => setDriverName(e.target.value)}
                    disabled={saving}
                    className={INPUT_CLASS}
                  />
                  {/* สลับกลับไปเลือกจากรายชื่อได้ก็ต่อเมื่อมีคนขับให้เลือกจริง
                      — ถ้า drivers ว่างเปล่า ไม่มีประโยชน์ที่จะมีปุ่มนี้เลย */}
                  {drivers.length > 0 && (
                    <button
                      type="button"
                      onClick={() => {
                        setManualDriverEntry(false);
                        // คงชื่อเดิมไว้ถ้าตรงกับคนขับในรายชื่อพอดี ไม่งั้นเริ่ม
                        // ว่างใหม่ให้เลือกเอง (กันกรณีพิมพ์ชื่อที่ไม่มีในระบบ
                        // ค้างอยู่ใน select ซึ่งไม่มีตัวเลือกนั้นให้เลือก)
                        if (!drivers.some((d) => d.name === driverName)) setDriverName("");
                      }}
                      disabled={saving}
                      className="self-start text-xs font-medium text-sky-600 hover:underline disabled:opacity-60 dark:text-sky-400"
                    >
                      เลือกจากรายชื่อคนขับที่มี
                    </button>
                  )}
                </>
              ) : (
                <select
                  value={driverName}
                  onChange={(e) => {
                    if (e.target.value === DRIVER_MANUAL_OPTION) {
                      setManualDriverEntry(true);
                      setDriverName("");
                    } else {
                      setDriverName(e.target.value);
                    }
                  }}
                  disabled={saving}
                  className={INPUT_CLASS}
                >
                  <option value="">-- เลือกคนขับ --</option>
                  {drivers.map((d) => (
                    <option key={d.driverId} value={d.name}>
                      {d.name}
                      {d.phone ? ` (${d.phone})` : ""}
                    </option>
                  ))}
                  <option value={DRIVER_MANUAL_OPTION}>อื่นๆ (ระบุชื่อเอง)</option>
                </select>
              )}
            </label>

            {/* ซ่อนบล็อก "วันเดินทาง"/"เวลาเริ่มต้น-สิ้นสุด (รวม)" ที่เคยอยู่
                ตรงนี้ออกทั้งหมดตามที่ขอ — ข้อมูลชุดเดียวกันนี้ (วันที่+ช่วง
                เวลารวม) แสดงซ้ำอยู่แล้วทั้งในกล่อง "คำขอการเดินทาง" ด้านบนสุด
                และแถบ "เส้นเวลาการเดินทาง" (มุมขวาบน) เป็นข้อมูลอ่านอย่างเดียว
                ล็อกไว้เหมือนกันทุกจุดอยู่แล้ว (ดู tripDateKey/startHour/
                startMinute/endHour/endMinute ด้านบน) ไม่จำเป็นต้องแสดงซ้ำเป็น
                ช่องอีกรอบด้านล่างนี้ — ตัวแปรเหล่านั้นยังใช้งานอยู่ที่อื่น
                (startTime/endTime ที่ส่งไป API, เส้นเวลาการเดินทางด้านบน) จึง
                ไม่ได้ลบออกจากโค้ด แค่ไม่เรนเดอร์เป็นช่องซ้ำตรงนี้อีกแล้ว */}

            <label className="flex flex-col gap-1 text-sm text-zinc-600 dark:text-zinc-300">
              หมายเหตุ (ไม่บังคับ)
              <input
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                disabled={saving}
                className={INPUT_CLASS}
              />
            </label>

            <div className="mt-1 flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                disabled={saving}
                className="rounded-full border border-zinc-200 px-4 py-2 text-sm font-medium text-zinc-600 transition-colors hover:bg-zinc-50 disabled:opacity-60 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                ยกเลิก
              </button>
              <button
                type="submit"
                disabled={saving || effectiveResources.length === 0}
                className="inline-flex items-center gap-1.5 rounded-full bg-gradient-to-br from-[var(--brand)] to-[var(--brand-2)] px-4 py-2 text-sm font-medium text-[var(--brand-contrast)] shadow-sm transition-opacity hover:opacity-90 disabled:opacity-60"
              >
                {saving ? (
                  <Loader2 size={16} strokeWidth={2} className="animate-spin" aria-hidden="true" />
                ) : (
                  <Save size={16} strokeWidth={2} aria-hidden="true" />
                )}
                {editing ? "บันทึกการแก้ไข" : "จัดรถ"}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>,
    document.body
  );
}
