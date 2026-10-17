"use client";

import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Ban, Building2, ChevronLeft, ChevronRight, Clock, Loader2, MapPin, Pencil, Phone, Truck, Users, X } from "lucide-react";
import type { Role } from "@/lib/auth";
import { ACTION_OTHER_COLOR, actionColorVars, type ActionColor } from "@/lib/actionColors";
import type { PermissionKey } from "@/lib/permissions";
import {
  bookingColorMapKey,
  bookingStatusLabel,
  canCancelBooking,
  carBookingDisplayName,
  formatBookingDateTime,
  isBookingCancelled,
  splitBookingDateTime,
  type Booking,
  type TripOrder,
} from "@/lib/booking";

// Tone -> badge classes for bookingStatusLabel's four tones — same mapping
// as BookingDashboard's own copy (small enough to duplicate, matching this
// codebase's existing per-file constant convention).
const STATUS_BADGE_CLASSES: Record<ReturnType<typeof bookingStatusLabel>["tone"], string> = {
  cancelled: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400",
  pending: "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300",
  approved: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300",
  rejected: "bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300",
};
// ไม่ใช้สีระบุตัวตนรถ/เที่ยว (resourceColorMap) กับการจองรถอีกต่อไป ตามที่ขอ
// ("ไม่ต้องมีสีกำกับรถแล้วครับ") — สีของชิพ/จุดสำหรับรถตอนนี้บอก "สถานะการ
// จอง" แทน: เหลือง = กลุ่มงานจอง (รออนุมัติ — ใช้สไตล์ pending เดิมที่มีอยู่
// แล้วด้านล่าง), เขียว = บริหารอนุมัติแล้ว, แดง = ไม่อนุมัติ (ตามโทนเดียวกับ
// STATUS_BADGE_CLASSES ด้านบน) ส่วนที่ยกเลิกแล้วยังคงใช้สไตล์เทา/ขีดฆ่าเดิม
// ห้องประชุมไม่ได้รับผลกระทบ — ยังใช้ resourceColorMap (สีระบุตัวตนทรัพยากร)
// เหมือนเดิมทุกประการ เพราะห้องประชุมยืนยันทันที ไม่มีสถานะรออนุมัติที่ต้อง
// แยกสีให้เห็น
const CAR_STATUS_DOT_CLASSES: Partial<Record<ReturnType<typeof bookingStatusLabel>["tone"], string>> = {
  pending: "bg-amber-500 dark:bg-amber-400",
  approved: "bg-emerald-600 dark:bg-emerald-500",
  rejected: "bg-red-600 dark:bg-red-500",
};
// ลำดับการแสดงผลตามสถานะ — "รออนุมัติ" ต้องเห็นก่อนเสมอ (ยังต้องตัดสินใจ)
// ตามด้วย "อนุญาต" (เสร็จแล้ว ไม่ต้องทำอะไรต่อ) ส่วนไม่อนุมัติ/ยกเลิกแล้ว
// ไม่ใช่รายการที่ต้องรีบดู เลยไว้ท้ายสุด — ใช้กับทั้งช่องวันในปฏิทิน (3
// รายการแรกที่โชว์) และรายการในหน้าต่างรายละเอียดวัน (DayDetailModal) ตามที่ขอ
const STATUS_SORT_PRIORITY: Record<ReturnType<typeof bookingStatusLabel>["tone"], number> = {
  pending: 0,
  approved: 1,
  rejected: 2,
  cancelled: 3,
};

// สีแถบของ "เส้นเวลาการเดินทาง" ใน DayDetailModal (ดู buildTripTimeline
// ด้านล่าง) — คงที่เป็นเขียวเสมอ ไม่ใช่สีตามสถานะแบบเดิมอีกต่อไป เพราะเส้นเวลา
// นี้ผูกอยู่กับคำขอที่ "อนุมัติแล้ว" (มีใบสั่งงานคุมอยู่) เท่านั้นแล้ว ตามที่ขอ
// ภายหลัง ("สีที่แสดงให้เห็นต้องเป็นอนุญาตเท่านั่น") — รออนุมัติ/ไม่อนุมัติ/
// ยกเลิก ไม่มีทางมาถึงเส้นเวลานี้เลย จึงไม่จำเป็นต้องมี legend อธิบายสีอีกด้วย
const TIMELINE_BAR_CLASS = "bg-emerald-600 dark:bg-emerald-500";

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** ระยะห่างระหว่างขีดบอกเวลาบนเส้นเวลา (นาที) — สำเนาเดียวกับที่ใช้ใน
 * TripOrderModal.tsx (ก๊อปมาแทนที่จะ export ใช้ร่วมกัน ตามธรรมเนียมของ
 * โปรเจกต์นี้ที่ยอมให้ซ้ำกันได้เมื่อโค้ดเล็กพอ ดูคอมเมนต์ที่ STATUS_BADGE_CLASSES
 * ด้านบน) เลือก "ก้าว" ที่ดูเป็นธรรมชาติตัวแรกที่ทำให้ได้ขีดไม่เกิน ~8 ขีด */
function pickTickStepMinutes(domainSpanMin: number): number {
  const steps = [15, 30, 60, 120, 180, 240, 360, 480, 720];
  for (const step of steps) {
    if (domainSpanMin / step <= 8) return step;
  }
  return 720;
}

interface TripTimelineRow {
  bookingId: string;
  label: string;
  resourceLabel: string;
  timeLabel: string;
  leftPct: number;
  widthPct: number;
  sortKey: number;
}

interface TripTimelineTick {
  min: number;
  label: string;
  leftPct: number;
}

/** สร้างข้อมูล "เส้นเวลาการเดินทาง" ของ "เที่ยวรถ/ห้องหนึ่งรายการ" (ไม่ใช่ทั้ง
 * วันเหมือนเดิม) — ตามที่ขอภายหลัง ("ขอให้กล่องเส้นเวลาการเดินทาง อยู่ภายใน
 * กล่องสั่งงานเดินทางแต่ละรายการหรือรถนั้นๆ เช่น หากวันเดียวมีการจ่ายรถเดินทาง
 * 3 การเดินทางก็ต้องมี 3 กล่องเส้นเวลาการเดินทาง") เรียกครั้งเดียวต่อกลุ่มตอน
 * render (ไม่ใช่ hook — ไม่เรียก useMemo ในลูปได้อยู่แล้ว แต่จำนวนคำขอต่อกลุ่ม
 * น้อยมากจึงไม่คุ้มจะ memo แยก) กรองเอาเฉพาะคำขอที่ยังไม่ถูกยกเลิกออกมาก่อน
 * เสมอ — "รอบริหารจัดสรร"/"ไม่อนุมัติ"/"ยกเลิก" ไม่มีทางเข้าเส้นเวลานี้เลย ตามที่
 * ขอ ("ส่วนที่อยู่ระหว่างรอบริหารจัดสรร แยกออกมาจากเส้นเวลา... รออนุมัติ ไม่
 * อนุมัติ ยกเลิกไม่ต้องมีเส้นเวลา") เพราะฟังก์ชันนี้ถูกเรียกเฉพาะตอนกลุ่มมีใบ
 * สั่งงาน (trip) แล้วเท่านั้น (ดู caller ใน DayDetailModal) คืน null เมื่อไม่มี
 * คำขอที่ยังไม่ถูกยกเลิกเหลือเลย (เช่น เที่ยวที่ถูกยกเลิกไปทั้งกลุ่ม) ให้ caller
 * ไม่ render กล่องนี้ */
function buildTripTimeline(
  items: Booking[],
  tripOrderByBookingId: Map<string, TripOrder>
): { domain: { startMin: number; endMin: number }; rows: TripTimelineRow[]; ticks: TripTimelineTick[] } | null {
  const activeItems = items.filter((b) => !isBookingCancelled(b));
  if (activeItems.length === 0) return null;

  let minStart = Infinity;
  let maxEnd = -Infinity;
  for (const b of activeItems) {
    const s = splitBookingDateTime(b.startTime);
    const e = splitBookingDateTime(b.endTime);
    if (s) minStart = Math.min(minStart, Number(s.time.slice(0, 2)) * 60 + Number(s.time.slice(3, 5)));
    if (e) maxEnd = Math.max(maxEnd, Number(e.time.slice(0, 2)) * 60 + Number(e.time.slice(3, 5)));
  }
  if (!Number.isFinite(minStart) || !Number.isFinite(maxEnd) || maxEnd <= minStart) return null;
  const domain = { startMin: minStart, endMin: maxEnd };
  const domainSpan = Math.max(domain.endMin - domain.startMin, 1);

  const rows = activeItems
    .map((b) => {
      const s = splitBookingDateTime(b.startTime);
      const e = splitBookingDateTime(b.endTime);
      const bStart = s ? Number(s.time.slice(0, 2)) * 60 + Number(s.time.slice(3, 5)) : domain.startMin;
      const bEnd = e ? Number(e.time.slice(0, 2)) * 60 + Number(e.time.slice(3, 5)) : domain.endMin;
      const leftPct = Math.min(100, Math.max(0, ((bStart - domain.startMin) / domainSpan) * 100));
      const rawWidthPct = ((bEnd - bStart) / domainSpan) * 100;
      const widthPct = Math.min(100 - leftPct, Math.max(rawWidthPct, 3));
      const resourceLabel =
        b.resourceType === "car" ? carBookingDisplayName(b, tripOrderByBookingId.get(b.bookingId)) : b.resourceName;
      const label = b.department || resourceLabel;
      return {
        bookingId: b.bookingId,
        label,
        resourceLabel,
        timeLabel: `${s?.time ?? "--:--"}–${e?.time ?? "--:--"}`,
        leftPct,
        widthPct,
        sortKey: bStart,
      };
    })
    .sort((a, b) => a.sortKey - b.sortKey);

  const step = pickTickStepMinutes(domainSpan);
  const firstTick = Math.ceil(domain.startMin / step) * step;
  const ticks: TripTimelineTick[] = [];
  for (let m = firstTick; m <= domain.endMin; m += step) {
    ticks.push({
      min: m,
      label: `${pad2(Math.floor(m / 60) % 24)}:${pad2(m % 60)}`,
      leftPct: ((m - domain.startMin) / domainSpan) * 100,
    });
  }

  return { domain, rows, ticks };
}

const THAI_MONTHS = [
  "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน",
  "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม",
];
const THAI_WEEKDAYS = ["อา", "จ", "อ", "พ", "พฤ", "ศ", "ส"];

/** Local-calendar-date key ("YYYY-MM-DD") for a plain JS Date, built from
 * its local getFullYear/getMonth/getDate — never toISOString(), which is
 * UTC-based and would shift the date near midnight depending on the
 * viewer's timezone. Every date this component works with is a "local
 * wall-clock date" the same way Booking.startTime/endTime are (see
 * lib/booking.ts), so this keeps the same convention. */
function dateKeyFromDate(d: Date): string {
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${mo}-${day}`;
}

function addDaysToKey(dateKey: string, days: number): string {
  const [y, mo, d] = dateKey.split("-").map(Number);
  const dt = new Date(y, mo - 1, d);
  dt.setDate(dt.getDate() + days);
  return dateKeyFromDate(dt);
}

/** Every calendar date a booking's [startTime, endTime) touches — almost
 * always just one date, but a booking that crosses midnight (e.g. an
 * overnight car trip 20:00 -> 08:00 the next day) shows up on both dates
 * it actually spans. Drops a trailing end-date whose time is exactly
 * "00:00" — a booking ending right at midnight doesn't really occupy that
 * next date. Capped at 60 days as a safety guard against a malformed row. */
function bookingDateKeys(booking: Booking): string[] {
  const start = splitBookingDateTime(booking.startTime);
  const end = splitBookingDateTime(booking.endTime);
  if (!start) return [];
  if (!end || end.dateKey === start.dateKey) return [start.dateKey];

  const keys: string[] = [];
  let cur = start.dateKey;
  for (let i = 0; i < 60; i++) {
    keys.push(cur);
    if (cur === end.dateKey) break;
    cur = addDaysToKey(cur, 1);
  }
  if (keys.length > 1 && keys[keys.length - 1] === end.dateKey && end.time === "00:00") {
    keys.pop();
  }
  return keys;
}

/** All 42 dates (6 full Sun-Sat weeks) covering the given month, including
 * the leading/trailing days borrowed from the adjacent months — a fixed
 * cell count keeps every month's grid the same height. */
function monthGrid(monthCursor: Date): Date[] {
  const year = monthCursor.getFullYear();
  const month = monthCursor.getMonth();
  const firstOfMonth = new Date(year, month, 1);
  const gridStart = new Date(year, month, 1 - firstOfMonth.getDay());
  const days: Date[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart);
    d.setDate(gridStart.getDate() + i);
    days.push(d);
  }
  return days;
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

/**
 * Month-view calendar for one resource type's bookings — each day cell
 * shows a colored chip per booking that touches that date (color keyed by
 * resource, via resourceColorMap, so which vehicle/room is booked reads at
 * a glance), clicking a day with bookings opens a detail panel with the
 * full information and a cancel action, same as the flat list view this
 * sits alongside in BookingDashboard.
 */
export default function BookingCalendar({
  typeLabel,
  bookings,
  resourceColorMap,
  showResourceLegend,
  session,
  onCancel,
  cancellingBookingId,
  showDestination,
  canApprove,
  canEditBooking,
  onReject,
  rejectingBookingId,
  selectedBookingIds,
  onToggleSelect,
  tripOrderByBookingId,
  onEditBooking,
  onEditTripOrder,
  onOpenTripOrder,
  onClearSelection,
}: {
  typeLabel: string;
  bookings: Booking[];
  resourceColorMap: Map<string, ActionColor>;
  /** Legend รายชื่อทรัพยากรมีความหมายเฉพาะห้องประชุม — ดูคอมเมนต์ที่จุดเรียก
   * ใน BookingDashboard.tsx (resourceColorMap ของรถตอนนี้คีย์ด้วย
   * tripOrderId ซึ่งไม่มีความหมายให้คนอ่านเป็น legend ได้) */
  showResourceLegend: boolean;
  session: { username: string; role: Role; isBootstrap: boolean; extraPermissions?: PermissionKey[]; revokedPermissions?: PermissionKey[] };
  onCancel: (booking: Booking) => void;
  cancellingBookingId: string | null;
  showDestination: boolean;
  /** True only on the car calendar, for a superadmin — see canApproveCarBooking
   * in lib/booking.ts. Room calendars never pass true, since room bookings
   * have no pending state to review. */
  canApprove: boolean;
  /** สิทธิ์ "แก้ไขข้อมูลการจอง" แยกจาก canApprove แล้ว (permission key
   * "editBookingData") — ใช้เฉพาะปุ่ม "แก้ไขข้อมูล" ใน DayDetailModal ปุ่ม
   * อื่นทั้งหมดยังใช้ canApprove เหมือนเดิม ดูคอมเมนต์ที่ BookingDashboard.tsx */
  canEditBooking: boolean;
  /** Rejects a pending car booking outright — the only single-click decision
   * left here. "Approving" is no longer a status flip: it only happens by
   * dispatching a TripOrder (see selectedBookingIds/onToggleSelect below and
   * TripOrderModal), which combining >1 selection into is exactly the
   * carpool feature. */
  onReject: (booking: Booking) => void;
  rejectingBookingId: string | null;
  /** Pending car bookings picked to go into the same TripOrder — owned by
   * BookingDashboard so it survives switching between calendar/list view. */
  selectedBookingIds: Set<string>;
  onToggleSelect: (booking: Booking) => void;
  /** Booking.bookingId -> the TripOrder that dispatched it (once approved
   * this way) — lets a booking card show which car/driver it ended up with,
   * without ever having edited the booking row itself. */
  tripOrderByBookingId: Map<string, TripOrder>;
  /** Opens ManagementEditBookingModal for this booking — "แก้ไขข้อมูลเท่าที่
   * จำเป็น" per the hospital's later request, only ever the narrow field set
   * editBookingByManagement allows (see its doc comment in lib/sheets.ts).
   * Same canApprove gate as everything else here. */
  onEditBooking: (booking: Booking) => void;
  /** Opens TripOrderModal in edit mode for the TripOrder covering this
   * booking — lets management correct the assigned car/driver/time after
   * the fact, without touching which bookings it covers. */
  onEditTripOrder: (tripOrder: TripOrder) => void;
  /** เปิด TripOrderModal โหมดสร้างใหม่ (ออกใบสั่งงาน) สำหรับรายการที่เลือกไว้
   * ใน selectedBookingIds ทั้งหมด — ปุ่มนี้ย้ายมาอยู่ใน DayDetailModal เอง
   * ตามที่ขอ (เดิมมีอยู่แต่ที่หัวข้อด้านบนปฏิทิน ซึ่งถูกโมดัลนี้บังไว้พอดี
   * ตอนดูรายละเอียดวัน) — BookingDashboard เป็นเจ้าของ state ที่แท้จริง. */
  onOpenTripOrder: () => void;
  /** ล้าง selectedBookingIds ทั้งหมด (ทุกวัน ไม่ใช่แค่วันที่กำลังปิด) —
   * เรียกตอนปิดหน้าต่างรายละเอียดวัน (ปุ่ม X, คลิกฉากหลัง) เพื่อไม่ให้รายการ
   * ที่เคยติ๊กไว้จากวันอื่นก่อนหน้านี้ค้างรวมอยู่ในตัวเลขที่ปุ่ม "ออกใบสั่งงาน
   * เดินทาง" ของวันถัดไปโดยไม่รู้ตัว ("ต้องรีเซ็ตเป็นแต่ละวัน" ตามที่ขอ) —
   * เปิดวันใหม่ต้องเริ่มเลือกใหม่เสมอ. */
  onClearSelection: () => void;
}) {
  const [monthCursor, setMonthCursor] = useState(() => startOfMonth(new Date()));
  const [selectedDateKey, setSelectedDateKey] = useState<string | null>(null);

  const days = useMemo(() => monthGrid(monthCursor), [monthCursor]);
  const todayKey = useMemo(() => dateKeyFromDate(new Date()), []);

  const bookingsByDate = useMemo(() => {
    const map = new Map<string, Booking[]>();
    for (const b of bookings) {
      for (const key of bookingDateKeys(b)) {
        const list = map.get(key) ?? [];
        list.push(b);
        map.set(key, list);
      }
    }
    for (const list of map.values()) {
      list.sort((a, b) => {
        const priorityDiff =
          STATUS_SORT_PRIORITY[bookingStatusLabel(a).tone] - STATUS_SORT_PRIORITY[bookingStatusLabel(b).tone];
        if (priorityDiff !== 0) return priorityDiff;
        return a.startTime < b.startTime ? -1 : 1;
      });
    }
    return map;
  }, [bookings]);

  const legendNames = useMemo(() => Array.from(resourceColorMap.keys()), [resourceColorMap]);
  const selectedBookings = selectedDateKey ? (bookingsByDate.get(selectedDateKey) ?? []) : [];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setMonthCursor((m) => new Date(m.getFullYear(), m.getMonth() - 1, 1))}
            aria-label="เดือนก่อนหน้า"
            className="rounded-full p-1.5 text-zinc-500 transition-colors hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
          >
            <ChevronLeft size={18} strokeWidth={2} aria-hidden="true" />
          </button>
          <span className="min-w-[9rem] text-center text-sm font-semibold text-zinc-800 dark:text-zinc-100">
            {THAI_MONTHS[monthCursor.getMonth()]} {monthCursor.getFullYear() + 543}
          </span>
          <button
            type="button"
            onClick={() => setMonthCursor((m) => new Date(m.getFullYear(), m.getMonth() + 1, 1))}
            aria-label="เดือนถัดไป"
            className="rounded-full p-1.5 text-zinc-500 transition-colors hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
          >
            <ChevronRight size={18} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
        <button
          type="button"
          onClick={() => setMonthCursor(startOfMonth(new Date()))}
          className="rounded-full border border-zinc-200 px-3 py-1 text-xs font-medium text-zinc-600 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          วันนี้
        </button>
      </div>

      {showResourceLegend && legendNames.length > 0 && (
        <div className="flex flex-wrap gap-x-3 gap-y-1.5">
          {legendNames.map((name) => {
            const color = resourceColorMap.get(name);
            if (!color) return null;
            return (
              <span key={name} className="inline-flex items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-full bg-[var(--seg-c)] dark:bg-[var(--seg-c-dark)]"
                  style={actionColorVars(color)}
                  aria-hidden="true"
                />
                {name}
              </span>
            );
          })}
        </div>
      )}

      <div className="grid grid-cols-7 overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-700">
        {THAI_WEEKDAYS.map((wd) => (
          <div
            key={wd}
            className="border-b border-r border-zinc-100 bg-zinc-50 px-1.5 py-1.5 text-center text-xs font-medium text-zinc-400 last:border-r-0 dark:border-zinc-800 dark:bg-zinc-950/40 dark:text-zinc-500"
          >
            {wd}
          </div>
        ))}
        {days.map((day) => {
          const key = dateKeyFromDate(day);
          const inMonth = day.getMonth() === monthCursor.getMonth();
          const dayBookings = bookingsByDate.get(key) ?? [];
          const isToday = key === todayKey;
          const visible = dayBookings.slice(0, 3);
          const extra = dayBookings.length - visible.length;
          return (
            <button
              type="button"
              key={key}
              onClick={() => dayBookings.length > 0 && setSelectedDateKey(key)}
              disabled={dayBookings.length === 0}
              className={`flex min-h-[5.5rem] flex-col items-stretch gap-1 border-b border-r border-zinc-100 p-1.5 text-left last:border-r-0 dark:border-zinc-800 ${
                inMonth ? "bg-white dark:bg-zinc-900" : "bg-zinc-50/60 dark:bg-zinc-950/30"
              } ${
                dayBookings.length > 0
                  ? "cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-800/60"
                  : "cursor-default"
              }`}
            >
              <span
                className={`inline-flex h-5 w-5 items-center justify-center rounded-full text-xs ${
                  isToday
                    ? "bg-gradient-to-br from-[var(--brand)] to-[var(--brand-2)] font-semibold text-[var(--brand-contrast)]"
                    : inMonth
                      ? "text-zinc-600 dark:text-zinc-300"
                      : "text-zinc-300 dark:text-zinc-600"
                }`}
              >
                {day.getDate()}
              </span>
              <div className="flex flex-col gap-0.5">
                {visible.map((b) => {
                  const cancelled = isBookingCancelled(b);
                  const pending = !cancelled && b.approvalStatus === "pending";
                  const isCar = b.resourceType === "car";
                  // รถ: ไม่ใช้สีระบุตัวตนรถ/เที่ยวแล้ว — ดูคอมเมนต์ที่
                  // CAR_STATUS_DOT_CLASSES ด้านบน ห้องประชุมยังคง Fallback ไป
                  // สีกลางๆ (ACTION_OTHER_COLOR) เมื่อไม่พบสีจริง กันไม่ให้ชิพ
                  // กลายเป็นสีขาวล่องหน (bg-[var(--seg-c)] ไม่มีค่าให้ใช้) ซึ่ง
                  // เป็นสาเหตุที่รายงานว่า "รายการหายไปจากปฏิทิน" ตอนก่อนหน้านี้
                  const color = isCar ? undefined : (resourceColorMap.get(bookingColorMapKey(b)) ?? ACTION_OTHER_COLOR);
                  const carStatusClass =
                    isCar && !cancelled && !pending ? CAR_STATUS_DOT_CLASSES[bookingStatusLabel(b).tone] : undefined;
                  const startTimeOfDay = splitBookingDateTime(b.startTime)?.time ?? "";
                  const endTimeOfDay = splitBookingDateTime(b.endTime)?.time ?? "";
                  const label =
                    b.department ||
                    (b.resourceType === "car"
                      ? carBookingDisplayName(b, tripOrderByBookingId.get(b.bookingId))
                      : b.resourceName);
                  return (
                    <span
                      key={b.bookingId}
                      style={!isCar && !cancelled && !pending ? actionColorVars(color!) : undefined}
                      // จองรถที่ "รออนุมัติ" ใช้เส้นขอบประสีเหลือง แทนสีทรัพยากร
                      // ปกติ — ให้ superadmin กวาดตาเห็นได้ทันทีว่ายังต้องรีวิว
                      className={`truncate rounded px-1 py-0.5 text-[10px] leading-tight ${
                        cancelled
                          ? "bg-zinc-200 text-zinc-500 line-through dark:bg-zinc-800 dark:text-zinc-500"
                          : pending
                            ? "border border-dashed border-amber-500 bg-amber-50 text-amber-800 dark:border-amber-400 dark:bg-amber-950/40 dark:text-amber-200"
                            : isCar
                              ? `${carStatusClass ?? "bg-zinc-500 dark:bg-zinc-600"} text-white`
                              : "bg-[var(--seg-c)] text-white dark:bg-[var(--seg-c-dark)]"
                      }`}
                    >
                      {startTimeOfDay}
                      {endTimeOfDay ? `-${endTimeOfDay}` : ""} {label}
                    </span>
                  );
                })}
                {extra > 0 && (
                  <span className="text-[10px] font-medium text-zinc-400 dark:text-zinc-500">
                    +{extra} เพิ่มเติม
                  </span>
                )}
              </div>
            </button>
          );
        })}
      </div>

      {selectedDateKey && (
        <DayDetailModal
          dateKey={selectedDateKey}
          typeLabel={typeLabel}
          bookings={selectedBookings}
          resourceColorMap={resourceColorMap}
          session={session}
          onCancel={onCancel}
          cancellingBookingId={cancellingBookingId}
          showDestination={showDestination}
          canApprove={canApprove}
          canEditBooking={canEditBooking}
          onReject={onReject}
          rejectingBookingId={rejectingBookingId}
          selectedBookingIds={selectedBookingIds}
          onToggleSelect={onToggleSelect}
          tripOrderByBookingId={tripOrderByBookingId}
          onEditBooking={onEditBooking}
          onEditTripOrder={onEditTripOrder}
          onOpenTripOrder={onOpenTripOrder}
          onClose={() => {
            // ปิดหน้าต่างวันนี้ + ล้างรายการที่เลือกไว้ทั้งหมด — ดูคอมเมนต์ที่
            // onClearSelection prop ด้านบนสำหรับเหตุผล
            onClearSelection();
            setSelectedDateKey(null);
          }}
        />
      )}
    </div>
  );
}

function DayDetailModal({
  dateKey,
  typeLabel,
  bookings,
  resourceColorMap,
  session,
  onCancel,
  cancellingBookingId,
  showDestination,
  canApprove,
  canEditBooking,
  onReject,
  rejectingBookingId,
  selectedBookingIds,
  onToggleSelect,
  tripOrderByBookingId,
  onEditBooking,
  onEditTripOrder,
  onOpenTripOrder,
  onClose,
}: {
  dateKey: string;
  typeLabel: string;
  bookings: Booking[];
  resourceColorMap: Map<string, ActionColor>;
  session: { username: string; role: Role; isBootstrap: boolean; extraPermissions?: PermissionKey[]; revokedPermissions?: PermissionKey[] };
  onCancel: (booking: Booking) => void;
  cancellingBookingId: string | null;
  showDestination: boolean;
  canApprove: boolean;
  canEditBooking: boolean;
  onReject: (booking: Booking) => void;
  rejectingBookingId: string | null;
  selectedBookingIds: Set<string>;
  onToggleSelect: (booking: Booking) => void;
  tripOrderByBookingId: Map<string, TripOrder>;
  onEditBooking: (booking: Booking) => void;
  onEditTripOrder: (tripOrder: TripOrder) => void;
  onOpenTripOrder: () => void;
  onClose: () => void;
}) {
  const [y, mo, d] = dateKey.split("-");
  const dateLabel = `${d}/${mo}/${Number(y) + 543}`;

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
        aria-labelledby="booking-day-detail-title"
        className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl bg-white shadow-xl dark:bg-zinc-900"
      >
        <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-4 dark:border-zinc-800">
          <h2 id="booking-day-detail-title" className="text-base font-semibold text-zinc-800 dark:text-zinc-100">
            การจอง{typeLabel} วันที่ {dateLabel}
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
        <div className="flex flex-col gap-3 overflow-y-auto px-5 py-4">
          {(() => {
            // จัดกลุ่มคำขอที่เดินทางร่วมกัน (TripOrder เดียวกันครอบคลุม >1
            // คำขอ) ให้อยู่ใน "การ์ดเดียวกัน" แทนที่จะแยกเป็นหลายกล่องซ้อนกัน
            // — ตามที่ขอ ("เชื่อมกรอบสองวงเป็นกรอบเดียว") ข้อมูลที่เป็นของ
            // เที่ยวรถโดยรวม (ชื่อรถ/คนขับ) แสดงครั้งเดียวต่อกลุ่ม ส่วนข้อมูล
            // เฉพาะคำขอ (วัตถุประสงค์/ผู้ติดต่อ/สถานะ/ปุ่มจัดการ) ยังคงแยกราย
            // คำขอเหมือนเดิม รายการที่ไม่ได้เดินทางร่วมกับใครยังคงเป็นกลุ่มละ
            // 1 คำขอเหมือนเดิมทุกประการ
            const seen = new Set<string>();
            const groups: { key: string; trip?: TripOrder; items: Booking[] }[] = [];
            for (const b of bookings) {
              if (seen.has(b.bookingId)) continue;
              const trip = tripOrderByBookingId.get(b.bookingId);
              if (trip && trip.bookingIds.length > 1) {
                const items = bookings.filter((x) => trip.bookingIds.includes(x.bookingId));
                items.forEach((it) => seen.add(it.bookingId));
                groups.push({ key: trip.tripOrderId, trip, items });
              } else {
                seen.add(b.bookingId);
                groups.push({ key: b.bookingId, trip, items: [b] });
              }
            }

            if (groups.length === 0) {
              return <p className="py-4 text-center text-sm text-zinc-500 dark:text-zinc-400">ไม่มีการจองในวันนี้</p>;
            }

            return groups.map(({ key, trip, items }) => {
              const first = items[0];
              const travelingTogether = items.length > 1;
              const allCancelled = items.every(isBookingCancelled);
              const isCar = first.resourceType === "car";
              // รถ: ไม่ใช้สีระบุตัวตนรถ/เที่ยวแล้ว — จุดสี/กรอบตอนนี้บอกสถานะ
              // แทน (ดูคอมเมนต์ที่ CAR_STATUS_DOT_CLASSES ด้านบน) กลุ่มที่
              // เดินทางร่วมกัน (>1 คำขอ) ล้วนมีใบสั่งงานคุมอยู่แล้วจึงถือว่า
              // "อนุมัติแล้ว" เสมอ (เขียว) ส่วนกลุ่มเดี่ยวใช้สถานะของคำขอนั้นเอง
              // — ห้องประชุมยังคงใช้สีระบุตัวตนทรัพยากร (resourceColorMap)
              // เหมือนเดิมทุกประการ
              const color = !isCar ? resourceColorMap.get(bookingColorMapKey(first)) : undefined;
              const carTone = travelingTogether ? "approved" : bookingStatusLabel(first).tone;
              const carDotClass = isCar && !allCancelled ? CAR_STATUS_DOT_CLASSES[carTone] : undefined;
              const displayResourceName =
                first.resourceType === "car" ? carBookingDisplayName(first, trip) : first.resourceName;
              // เส้นเวลาการเดินทางของกลุ่มนี้เอง — เฉพาะกลุ่มที่มีใบสั่งงาน
              // (trip, คำขอห้องประชุมไม่มี trip อยู่แล้วจึงไม่มีเส้นเวลานี้ตาม
              // ธรรมชาติ) และมีคำขอที่ยังไม่ถูกยกเลิกเหลืออยู่จริง — ดูคอมเมนต์
              // เต็มที่ buildTripTimeline ด้านบนว่าทำไมกรองแบบนี้
              const timeline = showDestination && trip ? buildTripTimeline(items, tripOrderByBookingId) : null;
              return (
                <div
                  key={key}
                  style={!isCar && !allCancelled && travelingTogether && color ? actionColorVars(color) : undefined}
                  className={`flex flex-col gap-1.5 rounded-xl border p-3 ${
                    allCancelled
                      ? "border-zinc-200 opacity-70 dark:border-zinc-800"
                      : isCar
                        ? travelingTogether
                          ? "border-2 border-emerald-500 dark:border-emerald-400"
                          : "border-zinc-200 dark:border-zinc-700"
                        : travelingTogether && color
                          ? "border-2 border-[var(--seg-c)] dark:border-[var(--seg-c-dark)]"
                          : "border-zinc-200 dark:border-zinc-700"
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-1.5">
                      {isCar
                        ? carDotClass && (
                            <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${carDotClass}`} aria-hidden="true" />
                          )
                        : color && (
                            <span
                              className="h-2.5 w-2.5 shrink-0 rounded-full bg-[var(--seg-c)] dark:bg-[var(--seg-c-dark)]"
                              style={actionColorVars(color)}
                              aria-hidden="true"
                            />
                          )}
                      <span className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">
                        {displayResourceName}
                      </span>
                    </div>
                    {/* มุมขวาบนของหัวการ์ด: ปุ่ม "แก้ไขใบสั่งงานเดินทาง" (ถ้ามี
                        ใบสั่งงานและมีสิทธิ์อนุมัติ) — ย้ายมาจากแถวกล่องคนขับ
                        ด้านล่างมาไว้ตรงนี้แทน ตามที่ขอภายหลัง ("ย้ายปุ่มไปไว้
                        ที่ว่างข้างชื่อรถ") ไม่ชนกับแบดจ์สถานะด้านล่าง เพราะ
                        แบดจ์แสดงเฉพาะกลุ่มที่มีคำขอเดียว (!travelingTogether)
                        ส่วนปุ่มนี้แสดงเมื่อมีใบสั่งงานคุมอยู่ (trip) ซึ่งทับ
                        ซ้อนกันได้เฉพาะกรณีคำขอเดี่ยวที่มีใบสั่งงานของตัวเองแล้ว
                        — เมื่อนั้นให้ปุ่มมาก่อน (แก้ไขได้สำคัญกว่าดูสถานะเฉยๆ) */}
                    {showDestination && trip && canApprove ? (
                      <button
                        type="button"
                        onClick={() => onEditTripOrder(trip)}
                        className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-sky-300 bg-white px-2 py-1 text-right text-xs font-medium text-sky-700 transition-colors hover:bg-sky-50 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-300 dark:hover:bg-sky-900/40"
                      >
                        <Pencil size={12} strokeWidth={2} className="shrink-0" aria-hidden="true" />
                        แก้ไขใบสั่งงานเดินทาง
                      </button>
                    ) : (
                      // แบดจ์สถานะรวมไว้ตรงหัวการ์ดเฉพาะกลุ่มที่มีคำขอเดียว —
                      // กลุ่มที่เดินทางร่วมกันแต่ละคำขออาจมีสถานะต่างกันได้
                      // (เช่น อนุมัติแล้ว 1 / ยกเลิกไป 1) จึงย้ายไปแสดงแยกราย
                      // คำขอด้านล่างแทน กันข้อความ "สถานะ" ที่ไม่ตรงความจริง
                      // ของบางคำขอในกลุ่ม
                      !travelingTogether && (
                        <span
                          className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE_CLASSES[bookingStatusLabel(first).tone]}`}
                        >
                          {bookingStatusLabel(first).text}
                        </span>
                      )
                    )}
                  </div>
                  {/* กล่องเวลาออกเดินทาง/คนขับ — ข้อมูลของ "เที่ยวรถ" โดยรวม
                      แสดงครั้งเดียวต่อกลุ่ม (ไม่ว่าจะมี 1 หรือหลายคำขอ) ย้ายมา
                      ไว้เหนือกล่องเส้นเวลาการเดินทาง ใต้ชื่อรถ/ป้ายทะเบียนใน
                      หัวการ์ดทันที ตามที่ขอภายหลัง ("ย้ายกล่องที่วงด้านล่างไป
                      ไว้ด้านบน... ใต้ชื่อรถ และป้ายทะเบียน") เดิมอยู่ใต้กล่อง
                      เส้นเวลา — สลับลำดับเพื่อให้เวลาออกเดินทาง (สำคัญที่สุด)
                      เห็นก่อนรายละเอียดอื่นเสมอ พร้อมเพิ่มตัวเลขเวลาออกเดินทาง
                      ขนาดใหญ่เด่นชัดไว้ในกล่องเดียวกัน (ตามที่ขอ — "เวลาเริ่ม
                      เดินทางมีความสำคัญมาก") ใช้ trip.startTime ตรงๆ (เวลารวม
                      ของทั้งเที่ยว ไม่ใช่ของคำขอใดคำขอหนึ่ง) ปุ่ม "แก้ไขใบสั่งงาน
                      เดินทาง" ย้ายขึ้นไปอยู่ที่หัวการ์ดแล้ว (ดูคอมเมนต์ด้านบน) */}
                  {showDestination && trip && (
                    <div className="flex flex-col gap-1.5 rounded-lg bg-sky-50 p-2.5 dark:bg-sky-950/30">
                      <div className="flex items-baseline gap-2">
                        <Clock
                          size={20}
                          strokeWidth={2.5}
                          className="mb-0.5 shrink-0 self-center text-sky-700 dark:text-sky-300"
                          aria-hidden="true"
                        />
                        <span className="text-2xl font-bold leading-none tabular-nums text-sky-900 dark:text-sky-100">
                          {splitBookingDateTime(trip.startTime)?.time ?? formatBookingDateTime(trip.startTime)}
                        </span>
                        <span className="text-xs font-medium text-sky-700 dark:text-sky-300">เวลาออกเดินทาง</span>
                      </div>
                      <span className="flex items-start gap-1.5 text-xs leading-5 text-sky-800 dark:text-sky-200">
                        <Truck size={13} strokeWidth={2} className="mt-0.5 shrink-0" aria-hidden="true" />
                        <span>
                          คนขับ: {trip.driverName || "—"}
                          {travelingTogether && <> · รวม {items.length.toLocaleString("th-TH")} คำขอเดินทางร่วมกัน</>}
                        </span>
                      </span>
                    </div>
                  )}
                  {/* เส้นเวลาการเดินทางของ "เที่ยวรถรายการนี้" เอง — ย้ายมาจาก
                      กล่องรวมทั้งวันที่หัวหน้าต่างเดิมมาไว้ในการ์ดของแต่ละเที่ยว
                      แทน ตามที่ขอภายหลัง ("ขอให้กล่องเส้นเวลาการเดินทาง อยู่
                      ภายในกล่องสั่งงานเดินทางแต่ละรายการหรือรถนั้นๆ... หากวัน
                      เดียวมีการจ่ายรถเดินทาง 3 การเดินทางก็ต้องมี 3 กล่องเส้น
                      เวลาการเดินทาง") มีเฉพาะกลุ่มที่มีใบสั่งงานคุมอยู่แล้ว (ดู
                      timeline ด้านบน) จึงไม่มีทางโผล่ในกลุ่ม "รอบริหารจัดสรร"/
                      ไม่อนุมัติ/ยกเลิกเลย (ดูคอมเมนต์เต็มที่ buildTripTimeline)
                      สีของแถบเลยคงที่เป็นเขียวเสมอ ไม่ต้องมี legend อธิบายสี */}
                  {timeline && (
                    <div className="flex flex-col gap-2 rounded-lg border border-zinc-200 bg-zinc-50 p-2.5 dark:border-zinc-700 dark:bg-zinc-800/60">
                      <div className="flex items-center justify-between text-[11px] font-medium text-zinc-500 dark:text-zinc-400">
                        <span>เส้นเวลาการเดินทาง</span>
                        <span className="tabular-nums">
                          {pad2(Math.floor(timeline.domain.startMin / 60) % 24)}:{pad2(timeline.domain.startMin % 60)} –{" "}
                          {pad2(Math.floor(timeline.domain.endMin / 60) % 24)}:{pad2(timeline.domain.endMin % 60)}
                        </span>
                      </div>
                      <div className="flex flex-col gap-1.5">
                        {timeline.rows.map((row) => (
                          <div key={row.bookingId} className="flex items-center gap-2">
                            <span
                              className="w-16 shrink-0 truncate text-[11px] text-zinc-600 dark:text-zinc-300"
                              title={`${row.label} (${row.resourceLabel})`}
                            >
                              {row.label}
                            </span>
                            <div className="relative h-4 flex-1 rounded-full bg-zinc-200 dark:bg-zinc-700">
                              {timeline.ticks.map((tick) => (
                                <span
                                  key={tick.min}
                                  className="absolute inset-y-0 w-px bg-zinc-300/70 dark:bg-zinc-600/70"
                                  style={{ left: `${tick.leftPct}%` }}
                                  aria-hidden="true"
                                />
                              ))}
                              <div
                                className={`absolute inset-y-0 rounded-full ${TIMELINE_BAR_CLASS}`}
                                style={{ left: `${row.leftPct}%`, width: `${row.widthPct}%` }}
                                title={`${row.label} (${row.resourceLabel}): ${row.timeLabel}`}
                              />
                            </div>
                            <span className="w-20 shrink-0 text-right text-[11px] tabular-nums text-zinc-500 dark:text-zinc-400">
                              {row.timeLabel}
                            </span>
                          </div>
                        ))}
                        {/* แถวขีดบอกเวลา — layout เดียวกับแถวแถบสีด้านบนทุก
                            ประการ (spacer ซ้าย/ขวากว้างเท่ากัน) ตำแหน่งขีดจึงตรง
                            กับเส้นไกด์ในแถบสีเป๊ะ */}
                        {timeline.ticks.length > 0 && (
                          <div className="flex items-center gap-2">
                            <span className="w-16 shrink-0" aria-hidden="true" />
                            <div className="relative h-3 flex-1">
                              {timeline.ticks.map((tick) => (
                                <span
                                  key={tick.min}
                                  className="absolute top-0 -translate-x-1/2 text-[9px] tabular-nums text-zinc-400 first:translate-x-0 last:translate-x-[-100%] dark:text-zinc-500"
                                  style={{ left: `${tick.leftPct}%` }}
                                >
                                  {tick.label}
                                </span>
                              ))}
                            </div>
                            <span className="w-20 shrink-0" aria-hidden="true" />
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                  {items.map((b, index) => {
                    const cancelled = isBookingCancelled(b);
                    const status = bookingStatusLabel(b);
                    // ตัดวันที่ออก เหลือแค่เวลา เมื่อเริ่ม/สิ้นสุดเป็นวันเดียวกัน
                    // — ตามที่ขอ ("นำวันที่ที่วงด้านล่างออก เพราะมันซ้ำซ้อนกับ
                    // ที่วงด้านบน") เพราะหัวหน้าต่าง (DayDetailModal) บอกวันที่
                    // ไว้ครั้งเดียวอยู่แล้ว ("การจองรถ วันที่ ...") กรณีคำขอข้าม
                    // คืน (เริ่ม/สิ้นสุดคนละวัน) ยังคงต้องเห็นวันที่ทั้งสองฝั่ง
                    // เหมือนเดิม กันข้อมูลวันที่ที่ต่างจากหัวหน้าต่างหายไป
                    const bStart = splitBookingDateTime(b.startTime);
                    const bEnd = splitBookingDateTime(b.endTime);
                    const timeRangeLabel =
                      bStart && bEnd && bStart.dateKey === bEnd.dateKey
                        ? `${bStart.time} – ${bEnd.time}`
                        : `${formatBookingDateTime(b.startTime)} – ${formatBookingDateTime(b.endTime)}`;
                    return (
                      <div
                        key={b.bookingId}
                        className={`flex flex-col gap-1.5 ${
                          index > 0 ? "border-t border-dashed border-zinc-200 pt-2 dark:border-zinc-700" : ""
                        } ${cancelled ? "opacity-70" : ""}`}
                      >
                        {/* เวลา + สถานะรายคำขอ (สำหรับกลุ่มที่เดินทางร่วมกัน
                            หลายคำขอเท่านั้น — คำขอเดียวสถานะอยู่ที่หัวการ์ด
                            ด้านบนแล้ว) */}
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs text-zinc-500 dark:text-zinc-400">{timeRangeLabel}</span>
                          {travelingTogether && (
                            <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE_CLASSES[status.tone]}`}>
                              {status.text}
                            </span>
                          )}
                        </div>
                        {/* ลำดับใหม่ตามที่ขอ — กลุ่มงาน, จำนวนผู้เดินทาง และ
                            เบอร์ติดต่อ ขึ้นก่อนวัตถุประสงค์เดินทาง */}
                        {b.department && (
                          <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-[var(--brand-strong)]">
                            <Building2 size={14} strokeWidth={2} aria-hidden="true" className="shrink-0" />
                            {b.department}
                          </span>
                        )}
                        <div className="flex flex-wrap items-center gap-3 text-xs text-zinc-500 dark:text-zinc-400">
                          <span className="inline-flex items-center gap-1">
                            <Users size={12} strokeWidth={2} aria-hidden="true" className="shrink-0" />
                            {b.participants.toLocaleString("th-TH")}
                          </span>
                          <span className="inline-flex items-center gap-1">
                            <Phone size={12} strokeWidth={2} aria-hidden="true" className="shrink-0" />
                            {b.contactPhone}
                          </span>
                          <span>{b.bookedByDisplayName || b.bookedByUsername}</span>
                        </div>
                        <p className="text-sm text-zinc-700 dark:text-zinc-200">{b.purpose}</p>
                        {showDestination && b.destination && (
                          <span className="inline-flex items-center gap-1 text-xs text-zinc-500 dark:text-zinc-400">
                            <MapPin size={12} strokeWidth={2} aria-hidden="true" className="shrink-0" />
                            {b.destination}
                          </span>
                        )}
                        {showDestination && b.companions && (
                          <span className="inline-flex items-center gap-1 text-xs text-zinc-500 dark:text-zinc-400">
                            <Users size={12} strokeWidth={2} aria-hidden="true" className="shrink-0" />
                            ผู้ร่วมเดินทาง: {b.companions}
                          </span>
                        )}
                        {showDestination && b.editedByUsername && (
                          <span className="inline-flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400">
                            <Pencil size={12} strokeWidth={2} aria-hidden="true" className="shrink-0" />
                            แก้ไขโดยฝ่ายบริหาร ({b.editedByUsername})
                          </span>
                        )}
                        {/* เหตุผลที่ ผอ. ไม่อนุมัติ ให้ผู้จอง/ผู้จัดรถเห็น (ตามที่ขอ
                            "ให้ผู้จองได้รับทราบเหตุผล") — ดู
                            Booking.directorNote ใน lib/booking.ts */}
                        {b.directorApprovalStatus === "rejected" && b.directorNote && (
                          <p className="text-xs text-red-600 dark:text-red-400">ผอ. ไม่อนุมัติ: {b.directorNote}</p>
                        )}
                        {/* ผอ. "ตีกลับ" ใบสั่งงานเดิม — ยัง "รอจัดรถ" อยู่ แค่มี
                            ข้อความฝากไว้ให้ผู้จัดรถเห็นก่อนจัดรถใหม่ */}
                        {b.directorReturnedAt && b.approvalStatus === "pending" && (
                          <p className="text-xs text-amber-700 dark:text-amber-400">
                            ผอ. ตีกลับ{b.directorNote ? `: ${b.directorNote}` : " — กรุณาจัดรถใหม่"}
                          </p>
                        )}
                        <div className="mt-1 flex flex-wrap items-center gap-1.5">
                          {!cancelled && canApprove && b.approvalStatus === "pending" && (
                            <>
                              <label className="inline-flex w-fit cursor-pointer items-center gap-1.5 rounded-full border border-zinc-200 px-2 py-1 text-xs font-medium text-zinc-600 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800">
                                <input
                                  type="checkbox"
                                  checked={selectedBookingIds.has(b.bookingId)}
                                  onChange={() => onToggleSelect(b)}
                                  className="h-3.5 w-3.5 accent-[var(--brand)]"
                                />
                                เลือกจัดรถ
                              </label>
                              <button
                                type="button"
                                onClick={() => onReject(b)}
                                disabled={rejectingBookingId === b.bookingId}
                                className="inline-flex w-fit items-center gap-1 rounded-full border border-red-200 px-2 py-1 text-xs font-medium text-red-700 transition-colors hover:bg-red-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-600 disabled:opacity-60 dark:border-red-900/50 dark:text-red-300 dark:hover:bg-red-950/30"
                              >
                                {rejectingBookingId === b.bookingId ? (
                                  <Loader2 size={12} strokeWidth={2} className="animate-spin" aria-hidden="true" />
                                ) : (
                                  <X size={12} strokeWidth={2} aria-hidden="true" />
                                )}
                                ปฏิเสธคำขอ
                              </button>
                            </>
                          )}
                          {!cancelled && canEditBooking && showDestination && (
                            <button
                              type="button"
                              onClick={() => onEditBooking(b)}
                              className="inline-flex w-fit items-center gap-1 rounded-full border border-zinc-200 px-2 py-1 text-xs font-medium text-zinc-600 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                            >
                              <Pencil size={12} strokeWidth={2} aria-hidden="true" />
                              แก้ไขข้อมูล
                            </button>
                          )}
                          {!cancelled && canCancelBooking(b, session) && (
                            <button
                              type="button"
                              onClick={() => onCancel(b)}
                              disabled={cancellingBookingId === b.bookingId}
                              className="inline-flex w-fit items-center gap-1 rounded-full border border-red-200 px-2 py-1 text-xs font-medium text-red-700 transition-colors hover:bg-red-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-600 disabled:opacity-60 dark:border-red-900/50 dark:text-red-300 dark:hover:bg-red-950/30"
                            >
                              {cancellingBookingId === b.bookingId ? (
                                <Loader2 size={12} strokeWidth={2} className="animate-spin" aria-hidden="true" />
                              ) : (
                                <Ban size={12} strokeWidth={2} aria-hidden="true" />
                              )}
                              ยกเลิก
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              );
            });
          })()}
        </div>
        {/* ปุ่ม "ออกใบสั่งงานเดินทาง" ย้ายมาไว้ตรงนี้ (แถบท้ายหน้าต่างรายละเอียด
            วัน) ตามที่ขอ — เดิมอยู่เหนือปฏิทินด้านหลัง ซึ่งหน้าต่างนี้บังไว้
            พอดีตอนกำลังเลือกจัดรถอยู่ ต้องปิดหน้าต่างนี้ก่อนถึงจะกดได้ ย้ายมา
            ไว้ในหน้าต่างเดียวกันนี้แทน กดได้ทันทีโดยไม่ต้องปิดก่อน (ยังใช้
            selectedBookingIds ชุดเดียวกับที่ BookingDashboard เป็นเจ้าของ จึง
            อาจรวมรายการที่เลือกไว้จากวันอื่นก่อนหน้านี้ด้วยได้เหมือนเดิม) */}
        {canApprove && selectedBookingIds.size > 0 && (
          <div className="flex justify-end border-t border-zinc-100 px-5 py-3 dark:border-zinc-800">
            <button
              type="button"
              onClick={onOpenTripOrder}
              className="inline-flex items-center gap-1.5 rounded-full bg-gradient-to-br from-sky-600 to-sky-500 px-3 py-1.5 text-xs font-medium text-white shadow-sm transition-opacity hover:opacity-90"
            >
              <Truck size={14} strokeWidth={2} aria-hidden="true" />
              จัดรถและคนขับ ({selectedBookingIds.size.toLocaleString("th-TH")})
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
