"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Building2,
  Calendar as CalendarIcon,
  Car,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  List as ListIcon,
  Loader2,
  LogOut,
  RefreshCw,
  Undo2,
  User,
  Users,
  X,
} from "lucide-react";
import { formatBookingDateTime, splitBookingDateTime } from "@/lib/booking";
import type { DirectorTripItem } from "@/lib/sheets";

// ผอ. ต้องเห็นคำขอใหม่เร็ว (รถถูกจัดเสร็จแล้วรออยู่) แต่ไม่ต้องถี่เท่า
// NotificationBell.tsx (15 วินาที, ของฝ่ายบริหารตอนจัดรถ) — 20 วินาทีพอเหมาะ
// สำหรับหน้าที่เปิดทิ้งไว้รอบเดียวแล้วอนุมัติทีละชุด
const POLL_INTERVAL_MS = 20_000;

// เวลาที่การ์ดที่ตัดสินใจแล้ว (เปลี่ยนสีให้เห็นชัดว่าทำรายการแล้ว) ยังค้าง
// แสดงอยู่ก่อนจะหายไปจากรายการจริง — ตามที่ขอ "เมื่ออัพเดทสถานะแล้วก็ให้
// เปลี่ยนสีรายการให้รู้ได้ชัดเจนว่ารายการนั่นได้ทำการอนุมัติแล้ว"
const DECIDED_CARD_LINGER_MS = 1600;

type Screen = "checking" | "login" | "resetPassword" | "ready";

/** ผลการตัดสินใจที่เพิ่งทำไปกับการ์ดหนึ่งใบ (keyed by tripOrderId) — ใช้แค่
 * ย้อมสี/ไอคอนการ์ดก่อนมันจะหายไปจากรายการจริงหลัง DECIDED_CARD_LINGER_MS ไม่
 * เกี่ยวกับสถานะจริงบนเซิร์ฟเวอร์ (ซึ่งอัปเดตไปแล้วตั้งแต่ request สำเร็จ). */
type DecidedTone = "approved" | "rejected" | "returned";

const THAI_WEEKDAYS = ["วันอาทิตย์", "วันจันทร์", "วันอังคาร", "วันพุธ", "วันพฤหัสบดี", "วันศุกร์", "วันเสาร์"];
const THAI_MONTHS = [
  "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน",
  "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม",
];

/** "2026-08-25" -> "วันจันทร์ที่ 25 สิงหาคม 2569" — หัวข้อกลุ่มรายวัน (ตามที่
 * ขอ "แยกการแสดงผลเป็นรายวันอย่างชัดเจน") คำนวณจากตัวเลขวันที่ตรงๆ แบบเดียวกับ
 * bookingDateTimeToMillis ใน lib/booking.ts (new Date(y, mo-1, d) ไม่ผ่าน
 * timezone conversion ใดๆ) ไม่ใช่การ parse ด้วย Date ตรงๆ — dateKey นี้เป็นแค่
 * วันที่ไม่มีเวลา จึงไม่มีปัญหาเรื่อง timezone shift ให้ต้องกังวลอยู่แล้ว. */
function formatThaiDateHeader(dateKey: string): string {
  const [y, mo, d] = dateKey.split("-").map(Number);
  if (!y || !mo || !d) return dateKey;
  const date = new Date(y, mo - 1, d);
  return `${THAI_WEEKDAYS[date.getDay()]}ที่ ${d} ${THAI_MONTHS[mo - 1]} ${y + 543}`;
}

function todayDateKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

// --- Helpers เฉพาะมุมมอง "ปฏิทิน" (DirectorCalendarView ด้านล่าง) ---
// คัดลอกแนวทางเดียวกับ monthGrid/dateKeyFromDate/startOfMonth ใน
// BookingCalendar.tsx (ก๊อปมาแทนที่จะ export ใช้ร่วมกัน — ไฟล์นี้แยกอิสระจาก
// /booking โดยตั้งใจอยู่แล้ว ดูคอมเมนต์หัวไฟล์ และเป็นธรรมเนียมเดิมของโปรเจกต์
// นี้ที่ยอมให้โค้ดเล็กๆ ซ้ำกันได้) ไม่จำเป็นต้องรองรับเที่ยวที่ข้ามเที่ยงคืน
// (ไปวันหนึ่งกลับอีกวัน) ซ้อนหลายวันในช่องปฏิทินแบบที่ BookingCalendar ทำกับการ
// จองทั่วไป — ใช้แค่วันที่ของ startTime (เวลาออกเดินทาง) จุดเดียวต่อเที่ยว ตรง
// กับที่ dayGroups ของมุมมอง "รายการ" ด้านบนทำอยู่แล้วทุกประการ
function dateKeyFromDate(d: Date): string {
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${mo}-${day}`;
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

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

/** สถานะโดยรวมของหนึ่งใบสั่งงาน (กลุ่มคำขอ) สำหรับมุมมองปฏิทิน — ทุกคำขอใน
 * กลุ่มเดียวกันถูกอนุมัติ/ไม่อนุมัติพร้อมกันเสมอผ่าน UI นี้ (submitDecision ส่ง
 * bookingIds ของทั้งกลุ่มไปด้วยกันเป็นก้อนเดียว) จึงใช้สถานะของคำขอแรกเป็น
 * ตัวแทนทั้งกลุ่มได้อย่างปลอดภัย. */
function tripGroupStatus(trip: DirectorTripItem): "pending" | "approved" | "rejected" {
  const s = trip.requests[0]?.directorApprovalStatus;
  return s === "approved" || s === "rejected" ? s : "pending";
}

/**
 * หน้า /director ทั้งหมด (ล็อกอิน + รีเซ็ตรหัสผ่าน + รายการรออนุมัติ) อยู่ใน
 * คอมโพเนนต์เดียวนี้โดยตั้งใจ — ตามที่ขอ "เมนูตัวเลือกน้อยๆ เข้าใจง่าย" ไม่มี
 * เหตุผลต้องแยกเป็นหลายหน้า/หลาย route ของจริง ทุกอย่างคือ state เดียวกันของ
 * ผอ. คนเดียว.
 *
 * ไม่ส่ง username ไปกับ login/reset-password request เลย (ดูคอมเมนต์หัวไฟล์
 * lib/directorAuth.ts) — เช็ค session ด้วยการลอง GET /api/director/trips
 * ตรงๆ ตอนโหลดหน้า: 200 แปลว่าเข้าสู่ระบบอยู่แล้ว (คุกกี้ยังไม่หมดอายุ), 401
 * แปลว่าต้องกรอกรหัสผ่านก่อน.
 *
 * รายการจาก getDirectorPendingTrips ถูกจัดกลุ่มมาแล้วทีละหนึ่งใบสั่งงาน (หลาย
 * คำขอที่ไปรถคันเดียวกันรวมเป็นรายการเดียว — ดู DirectorTripItem.requests ใน
 * lib/sheets.ts) คอมโพเนนต์นี้จึงเลือก/อนุมัติ/ไม่อนุมัติ/ตีกลับเป็นระดับ
 * "ใบสั่งงาน" (tripOrderId) เสมอ ไม่ใช่ระดับคำขอย่อย.
 */
export default function DirectorDashboard() {
  // screen และ trips รวมเป็น state ก้อนเดียวตั้งใจ — ดูคอมเมนต์ยาวในเวอร์ชัน
  // ก่อนไฟล์นี้ (react-hooks/set-state-in-effect) เหตุผลเดียวกับ
  // approvalPanel ใน NotificationBell.tsx
  const [view, setView] = useState<{ screen: Screen; trips: DirectorTripItem[] }>({ screen: "checking", trips: [] });
  const screen = view.screen;
  const trips = view.trips;
  // มุมมอง "รายการ" (เดิม, ค่าเริ่มต้น) vs "ปฏิทิน" (ใหม่ — ตามที่ขอ "อยากให้
  // แสดงเป็นรูปแบบปฎิทิน ... ทำเป็นรูปแบบให้ผอ.ท่านเลือกใช้ก็ได้ครับแบบเดิมก็
  // เก็บไว้") — จำค่าที่เลือกไว้ใน localStorage (เฉพาะเบราว์เซอร์/อุปกรณ์นี้) ให้
  // ไม่ต้องสลับใหม่ทุกครั้งที่เข้าหน้านี้ ครอบ try/catch เพราะ localStorage อาจ
  // ใช้ไม่ได้บางสภาพแวดล้อม (private mode ฯลฯ) — ไม่ใช่ข้อมูลสำคัญ พลาดได้ไม่
  // กระทบการทำงานหลัก แค่จำค่าที่เลือกไม่ได้เฉยๆ
  const [viewMode, setViewModeState] = useState<"list" | "calendar">(() => {
    try {
      return localStorage.getItem("director_view_mode") === "calendar" ? "calendar" : "list";
    } catch {
      return "list";
    }
  });
  function setViewMode(mode: "list" | "calendar") {
    setViewModeState(mode);
    try {
      localStorage.setItem("director_view_mode", mode);
    } catch {
      // best-effort — ดูคอมเมนต์ที่ useState ด้านบน
    }
  }
  // ทุกรายการที่ "ผ่านมือ ผอ. มาแล้ว" (รออยู่ + อนุมัติ/ไม่อนุมัติไปแล้ว) — ใช้
  // เฉพาะมุมมองปฏิทินเท่านั้น (ดู getDirectorAllTrips ใน lib/sheets.ts) โหลด/
  // poll เฉพาะตอนเปิดมุมมองนี้อยู่ ไม่ให้เสียทรัพยากรโหลดข้อมูลที่ไม่ได้ใช้ตอน
  // อยู่มุมมอง "รายการ" — แยก state ออกจาก `trips` (คิวงานที่ต้องทำ, ใช้โดย
  // มุมมองรายการ + แถบเลือกหลายรายการด้านล่าง) โดยเจตนา เพราะคนละความหมายกัน
  // (คิวงานที่ต้องทำ vs ภาพรวมทั้งหมดรวมประวัติ)
  const [allTrips, setAllTrips] = useState<DirectorTripItem[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [decided, setDecided] = useState<Map<string, DecidedTone>>(new Map());
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const [password, setPassword] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  // ป็อปอัปขอข้อความ (เหตุผลไม่อนุมัติ / ข้อความตีกลับ) — ใช้ร่วมกันทั้ง
  // ปุ่มรายการเดียวและปุ่มรายการที่เลือกไว้หลายรายการ ตามที่ขอ "ช่องคอมเม้น"
  // สำหรับทั้งสองกรณี
  const [commentPrompt, setCommentPrompt] = useState<{
    kind: "reject" | "return";
    groups: DirectorTripItem[];
    text: string;
  } | null>(null);

  const loadTrips = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setRefreshing(true);
    try {
      const res = await fetch("/api/director/trips", { cache: "no-store" });
      if (res.status === 401) {
        // อ่านจาก updater function (v) เสมอ ไม่ใช่ตัวแปร screen ที่ปิดไว้ตอน
        // สร้างฟังก์ชันนี้ (loadTrips นี้ deps เป็น [] คงที่ ไม่ผูกกับ screen) —
        // กันไม่ให้ poll เงียบๆ ที่ยิงมาตอน ผอ. กำลังกรอกฟอร์มรีเซ็ตรหัสผ่านอยู่
        // (ซึ่งยังไม่ได้ล็อกอินเหมือนกัน จึงได้ 401 เช่นกัน) เด้งกลับไปหน้า
        // ล็อกอินกลางคันโดยไม่ตั้งใจ
        setView((v) => (v.screen === "resetPassword" ? v : { ...v, screen: "login" }));
        return;
      }
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "โหลดรายการไม่สำเร็จ");
      setView({ screen: "ready", trips: data.trips as DirectorTripItem[] });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "โหลดรายการไม่สำเร็จ");
    } finally {
      setRefreshing(false);
    }
  }, []);

  // เหมือน loadTrips ด้านบนทุกประการ ต่างกันแค่ endpoint (ดึง "ทุกรายการที่
  // ผ่านมือ ผอ." ไม่ใช่แค่ที่ยังรออยู่) และไม่แตะ `screen`/401-redirect เลย —
  // ใช้แค่ตอนมุมมองปฏิทินเปิดอยู่ (ดู effect ด้านล่าง) ซึ่งแปลว่า session ยัง
  // ใช้ได้แน่ๆ อยู่แล้ว (ไม่งั้นคงเด้งไปหน้า login จาก loadTrips ไปก่อนแล้ว) จึง
  // ไม่ต้องเช็ค 401 ซ้ำอีกชั้น — ปล่อยให้ error เงียบๆ ถ้าพลาด (best-effort
  // เหมือน poll อื่นๆ ในแอปนี้)
  const loadAllTrips = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setRefreshing(true);
    try {
      const res = await fetch("/api/director/trips/all", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      if (!Array.isArray(data?.trips)) return;
      setAllTrips(data.trips as DirectorTripItem[]);
    } catch {
      // best-effort
    } finally {
      setRefreshing(false);
    }
  }, []);

  // เช็ค session ตอนเปิดหน้าครั้งแรก แล้วตั้ง interval รีเฟรชเป็นระยะต่อเนื่อง
  // ไปในตัว (เงียบๆ ไม่โชว์ spinner ทับรายการเดิมระหว่างอ่าน) — ตั้งใจไม่เรียก
  // loadTrips() ตรงๆ ในตัว effect เอง (เรียกผ่าน setTimeout(loadTrips, 0)
  // แทน) — react-hooks/set-state-in-effect เตือนตรงๆ ว่าการเรียกฟังก์ชันที่
  // setState อยู่โดยตรงใน effect (ไม่ผ่าน callback ของ timer/subscription)
  // เสี่ยง cascading re-render — ดูคอมเมนต์ยาวในเวอร์ชันก่อนไฟล์นี้.
  useEffect(() => {
    const initial = setTimeout(loadTrips, 0);
    const id = setInterval(() => loadTrips({ silent: true }), POLL_INTERVAL_MS);
    return () => {
      clearTimeout(initial);
      clearInterval(id);
    };
  }, [loadTrips]);

  // โหลด/poll "ทุกรายการ" เฉพาะตอนมุมมองปฏิทินเปิดอยู่จริงๆ เท่านั้น (ตามที่ขอ
  // เรื่องไม่สิ้นเปลืองทรัพยากรของมุมมองปฏิทินฝั่งผู้จอง — ใช้หลักการเดียวกัน
  // ที่นี่: ไม่ดึงข้อมูลที่หน้าจอไม่ได้แสดงอยู่) สลับกลับไปมุมมองรายการ หรือยัง
  // ไม่ล็อกอิน ก็หยุด poll ไปเอง
  useEffect(() => {
    if (screen !== "ready" || viewMode !== "calendar") return;
    const initial = setTimeout(loadAllTrips, 0);
    const id = setInterval(() => loadAllTrips({ silent: true }), POLL_INTERVAL_MS);
    return () => {
      clearTimeout(initial);
      clearInterval(id);
    };
  }, [screen, viewMode, loadAllTrips]);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const res = await fetch("/api/director/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "เข้าสู่ระบบไม่สำเร็จ");
      setPassword("");
      await loadTrips();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "เข้าสู่ระบบไม่สำเร็จ");
    } finally {
      setBusy(false);
    }
  }

  async function handleResetPassword(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (newPassword.length < 4) {
      setError("รหัสผ่านใหม่ต้องมีอย่างน้อย 4 ตัวอักษร");
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("รหัสผ่านใหม่ทั้งสองช่องไม่ตรงกัน");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/director/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "เปลี่ยนรหัสผ่านไม่สำเร็จ");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setNotice("เปลี่ยนรหัสผ่านสำเร็จ — กรุณาเข้าสู่ระบบด้วยรหัสผ่านใหม่");
      setView((v) => ({ ...v, screen: "login" }));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "เปลี่ยนรหัสผ่านไม่สำเร็จ");
    } finally {
      setBusy(false);
    }
  }

  async function handleLogout() {
    await fetch("/api/director/logout", { method: "POST" });
    setView({ screen: "login", trips: [] });
    setSelected(new Set());
  }

  // ย้อมสีการ์ด(กลุ่ม)ที่เพิ่งตัดสินใจไปทันที แล้วค่อยลบออกจากรายการจริงหลัง
  // DECIDED_CARD_LINGER_MS — ตามที่ขอ "เปลี่ยนสีรายการให้รู้ได้ชัดเจน".
  function markDecided(tripOrderIds: string[], tone: DecidedTone) {
    setDecided((prev) => {
      const next = new Map(prev);
      tripOrderIds.forEach((id) => next.set(id, tone));
      return next;
    });
    setTimeout(() => {
      setView((v) => ({ ...v, trips: v.trips.filter((t) => !tripOrderIds.includes(t.tripOrderId)) }));
      setDecided((prev) => {
        const next = new Map(prev);
        tripOrderIds.forEach((id) => next.delete(id));
        return next;
      });
    }, DECIDED_CARD_LINGER_MS);
  }

  // อัปเดตสถานะของกลุ่มที่ตัดสินใจแล้วใน allTrips (มุมมองปฏิทิน) ทันที โดยไม่
  // ต้องรอรอบ poll ถัดไป — เฉพาะ "อนุมัติ/ไม่อนุมัติ" (ใบสั่งงานยังอยู่เหมือนเดิม
  // แค่เปลี่ยนสถานะ) ส่วน "ตีกลับ" ดูฟังก์ชันถัดไปด้านล่าง (ยุบใบสั่งงานทิ้งไป
  // เลย ไม่ใช่แค่เปลี่ยนสถานะ)
  function applyDecisionToAllTrips(tripOrderIds: string[], decision: "approved" | "rejected", comment: string) {
    setAllTrips((prev) =>
      prev.map((t) =>
        tripOrderIds.includes(t.tripOrderId)
          ? { ...t, requests: t.requests.map((r) => ({ ...r, directorApprovalStatus: decision, directorNote: comment })) }
          : t
      )
    );
  }

  // รับ "กลุ่ม" (DirectorTripItem) ตรงๆ แทน tripOrderId เฉยๆ — ใช้ร่วมกันได้
  // ทั้งมุมมองรายการ (กลุ่มมาจาก `trips`) และมุมมองปฏิทิน (กลุ่มมาจาก
  // `allTrips`, ซึ่งไม่ได้อยู่ใน `trips` เสมอไปถ้าเคยถูกตัดสินใจไปแล้วก่อนหน้า
  // — แก้บั๊กเดิมที่ lookup จาก `trips` ตรงๆ ข้างในฟังก์ชันนี้ ซึ่งใช้ไม่ได้กับ
  // กลุ่มที่มาจากมุมมองปฏิทิน)
  async function submitDecision(groups: DirectorTripItem[], decision: "approved" | "rejected", comment: string = "") {
    const bookingIds = groups.flatMap((g) => g.requests.map((r) => r.bookingId));
    if (bookingIds.length === 0) return;
    const tripOrderIds = groups.map((g) => g.tripOrderId);
    setError("");
    setBusy(true);
    try {
      const res = await fetch("/api/director/trips/decision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bookingIds, decision, comment }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "บันทึกไม่สำเร็จ");
      markDecided(tripOrderIds, decision === "approved" ? "approved" : "rejected");
      applyDecisionToAllTrips(tripOrderIds, decision, comment);
      setSelected((prev) => {
        const next = new Set(prev);
        tripOrderIds.forEach((id) => next.delete(id));
        return next;
      });
      setNotice(
        decision === "approved"
          ? `อนุมัติแล้ว ${tripOrderIds.length} รายการ`
          : `ไม่อนุมัติแล้ว ${tripOrderIds.length} รายการ`
      );
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "บันทึกไม่สำเร็จ");
    } finally {
      setBusy(false);
    }
  }

  async function submitReturn(groups: DirectorTripItem[], comment: string) {
    if (groups.length === 0) return;
    const tripOrderIds = groups.map((g) => g.tripOrderId);
    setError("");
    setBusy(true);
    try {
      let okCount = 0;
      for (const tripOrderId of tripOrderIds) {
        const res = await fetch("/api/director/trips/return", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tripOrderId, comment }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || "ตีกลับไม่สำเร็จ");
        okCount += 1;
      }
      markDecided(tripOrderIds, "returned");
      // ตีกลับยุบใบสั่งงานทิ้งไปเลย (กลับไปเป็นคำขอ "รอจัดรถ" ธรรมดา ไม่ใช่
      // เรื่องของ ผอ. อีกต่อไป — ดู returnTripToDispatch ใน lib/sheets.ts) จึงต้อง
      // ลบออกจาก allTrips ด้วย (ไม่ใช่แค่เปลี่ยนสถานะเหมือน applyDecisionToAllTrips)
      // — หน่วงเวลาลบเท่ากับ DECIDED_CARD_LINGER_MS เหมือน markDecided ด้านบน
      // ให้มุมมองปฏิทินได้เห็นป้าย "ตีกลับแล้ว" วาบขึ้นก่อนช่องวัน/การ์ดจะหายไป
      // เฉยๆ ทันที ไม่ใช่แค่หายวับไปโดยไม่มีคำอธิบาย
      setTimeout(() => {
        setAllTrips((prev) => prev.filter((t) => !tripOrderIds.includes(t.tripOrderId)));
      }, DECIDED_CARD_LINGER_MS);
      setSelected((prev) => {
        const next = new Set(prev);
        tripOrderIds.forEach((id) => next.delete(id));
        return next;
      });
      setNotice(`ตีกลับให้ฝ่ายบริหารจัดรถใหม่แล้ว ${okCount} รายการ`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "ตีกลับไม่สำเร็จ");
    } finally {
      setBusy(false);
    }
  }

  function openCommentPrompt(kind: "reject" | "return", groups: DirectorTripItem[]) {
    setError("");
    setCommentPrompt({ kind, groups, text: "" });
  }

  async function confirmCommentPrompt() {
    if (!commentPrompt) return;
    const { kind, groups, text } = commentPrompt;
    if (kind === "return" && !text.trim()) {
      setError("กรุณาระบุข้อความถึงฝ่ายบริหารผู้จัดรถก่อนตีกลับ");
      return;
    }
    setCommentPrompt(null);
    if (kind === "reject") {
      await submitDecision(groups, "rejected", text.trim());
    } else {
      await submitReturn(groups, text.trim());
    }
  }

  function toggleSelected(tripOrderId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(tripOrderId)) next.delete(tripOrderId);
      else next.add(tripOrderId);
      return next;
    });
  }

  const allSelected = trips.length > 0 && selected.size === trips.length;
  function toggleSelectAll() {
    setSelected(allSelected ? new Set() : new Set(trips.map((t) => t.tripOrderId)));
  }

  // เคลียร์ notice เองหลัง 4 วินาที ไม่ต้องให้ ผอ. กดปิดเอง
  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(""), 4000);
    return () => clearTimeout(id);
  }, [notice]);

  // จัดกลุ่มตามวัน (ตามที่ขอ "แยกการแสดงผลเป็นรายวันอย่างชัดเจน") — trips มา
  // เรียงตาม startTime จาก getDirectorPendingTrips แล้ว จึงแค่ไล่หยอดเข้ากลุ่ม
  // ตามลำดับเดิม ไม่ต้อง sort ซ้ำ
  const dayGroups = useMemo(() => {
    const map = new Map<string, DirectorTripItem[]>();
    for (const trip of trips) {
      const dateKey = splitBookingDateTime(trip.startTime)?.dateKey ?? "ไม่ระบุวันที่";
      const list = map.get(dateKey);
      if (list) list.push(trip);
      else map.set(dateKey, [trip]);
    }
    return Array.from(map.entries());
  }, [trips]);
  const today = todayDateKey();

  if (screen === "checking") {
    return (
      <main className="flex min-h-screen items-center justify-center bg-gradient-to-b from-slate-50 to-slate-100">
        <Loader2 className="h-8 w-8 animate-spin text-indigo-500" />
      </main>
    );
  }

  if (screen === "login") {
    return (
      <LoginScreen
        password={password}
        setPassword={setPassword}
        onSubmit={handleLogin}
        busy={busy}
        error={error}
        notice={notice}
        onForgotPassword={() => {
          setError("");
          setView((v) => ({ ...v, screen: "resetPassword" }));
        }}
      />
    );
  }

  if (screen === "resetPassword") {
    return (
      <ResetPasswordScreen
        currentPassword={currentPassword}
        setCurrentPassword={setCurrentPassword}
        newPassword={newPassword}
        setNewPassword={setNewPassword}
        confirmPassword={confirmPassword}
        setConfirmPassword={setConfirmPassword}
        onSubmit={handleResetPassword}
        busy={busy}
        error={error}
        onBack={() => {
          setError("");
          setView((v) => ({ ...v, screen: "login" }));
        }}
      />
    );
  }

  return (
    <main className="mx-auto min-h-screen max-w-2xl bg-gradient-to-b from-slate-50 to-slate-100 px-4 pb-32 pt-6">
      <header className="mb-5 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-600 to-indigo-800 text-white shadow-md shadow-indigo-900/20">
            <Car className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-lg font-bold leading-tight text-slate-900">อนุมัติการเดินทาง</h1>
            <p className="text-xs text-slate-400">สำหรับผู้อำนวยการ</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => (viewMode === "calendar" ? loadAllTrips() : loadTrips())}
            disabled={refreshing}
            className="rounded-full p-2.5 text-slate-500 transition hover:bg-white hover:shadow-sm disabled:opacity-50"
            aria-label="รีเฟรช"
          >
            <RefreshCw className={`h-5 w-5 ${refreshing ? "animate-spin" : ""}`} />
          </button>
          <button
            onClick={handleLogout}
            className="flex items-center gap-1 rounded-full px-3 py-2.5 text-sm font-medium text-slate-500 transition hover:bg-white hover:shadow-sm"
          >
            <LogOut className="h-4 w-4" />
            ออกจากระบบ
          </button>
        </div>
      </header>

      {/* สลับมุมมอง "รายการ" (เดิม, คิวงานที่ต้องทำ) / "ปฏิทิน" (ใหม่ — ภาพรวม
          ทั้งเดือน รวมรายการที่ตัดสินใจไปแล้ว) — ตามที่ขอ "ทำเป็นรูปแบบให้ผอ.
          ท่านเลือกใช้ก็ได้ครับแบบเดิมก็เก็บไว้" ค่าที่เลือกจำไว้ใน localStorage
          (ดู setViewMode ด้านบน) */}
      <div className="mb-4 flex gap-1 rounded-xl bg-white/70 p-1 shadow-sm">
        <button
          type="button"
          onClick={() => setViewMode("list")}
          className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg py-2 text-sm font-medium transition ${
            viewMode === "list" ? "bg-indigo-600 text-white shadow-sm" : "text-slate-500 hover:bg-white"
          }`}
        >
          <ListIcon className="h-4 w-4" />
          รายการ
        </button>
        <button
          type="button"
          onClick={() => setViewMode("calendar")}
          className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg py-2 text-sm font-medium transition ${
            viewMode === "calendar" ? "bg-indigo-600 text-white shadow-sm" : "text-slate-500 hover:bg-white"
          }`}
        >
          <CalendarIcon className="h-4 w-4" />
          ปฏิทิน
        </button>
      </div>

      {notice && (
        <div className="mb-3 rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white shadow-sm shadow-emerald-900/10">
          {notice}
        </div>
      )}
      {error && (
        <div className="mb-3 rounded-xl bg-rose-600 px-4 py-2.5 text-sm font-medium text-white shadow-sm shadow-rose-900/10">
          {error}
        </div>
      )}

      {viewMode === "list" ? (
        trips.length === 0 ? (
          <div className="mt-20 flex flex-col items-center gap-2 text-center text-slate-400">
            <Check className="h-10 w-10 text-slate-300" />
            <p>ไม่มีรายการรออนุมัติในขณะนี้</p>
          </div>
        ) : (
          <>
            <label className="mb-4 flex items-center gap-2 rounded-xl bg-white/70 px-3 py-2 text-sm font-medium text-slate-600 shadow-sm">
              <input
                type="checkbox"
                className="h-5 w-5 accent-indigo-600"
                checked={allSelected}
                onChange={toggleSelectAll}
              />
              เลือกทั้งหมด ({trips.length} รายการ)
            </label>

            <div className="space-y-6">
              {dayGroups.map(([dateKey, dayTrips]) => (
                <section key={dateKey}>
                  <div className="mb-2 flex items-center gap-2 px-1">
                    <h2 className="text-sm font-bold text-slate-700">{formatThaiDateHeader(dateKey)}</h2>
                    {dateKey === today && (
                      <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-[11px] font-semibold text-indigo-700">
                        วันนี้
                      </span>
                    )}
                    <span className="text-xs text-slate-400">({dayTrips.length} เที่ยว)</span>
                  </div>
                  <ul className="space-y-3">
                    {dayTrips.map((trip) => (
                      <TripCard
                        key={trip.tripOrderId}
                        trip={trip}
                        selected={selected.has(trip.tripOrderId)}
                        decided={decided.get(trip.tripOrderId)}
                        onToggle={() => toggleSelected(trip.tripOrderId)}
                        onApprove={() => submitDecision([trip], "approved")}
                        onReject={() => openCommentPrompt("reject", [trip])}
                        onReturn={() => openCommentPrompt("return", [trip])}
                        busy={busy}
                      />
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          </>
        )
      ) : (
        <DirectorCalendarView
          trips={allTrips}
          decided={decided}
          busy={busy}
          onApprove={(groups) => submitDecision(groups, "approved")}
          onReject={(groups) => openCommentPrompt("reject", groups)}
          onReturn={(groups) => openCommentPrompt("return", groups)}
        />
      )}

      {selected.size > 0 && (
        <div className="fixed inset-x-0 bottom-0 border-t border-slate-200 bg-white/95 px-4 py-3 shadow-[0_-4px_16px_rgba(0,0,0,0.08)] backdrop-blur">
          <div className="mx-auto flex max-w-2xl items-center gap-2">
            <span className="flex-1 text-sm font-medium text-slate-700">เลือกไว้ {selected.size} รายการ</span>
            <button
              onClick={() => openCommentPrompt("reject", trips.filter((t) => selected.has(t.tripOrderId)))}
              disabled={busy}
              className="flex items-center gap-1 rounded-lg border border-rose-300 px-3 py-2 text-sm font-medium text-rose-700 transition hover:bg-rose-50 disabled:opacity-50"
            >
              <X className="h-4 w-4" />
              ไม่อนุมัติ
            </button>
            <button
              onClick={() => openCommentPrompt("return", trips.filter((t) => selected.has(t.tripOrderId)))}
              disabled={busy}
              className="flex items-center gap-1 rounded-lg border border-amber-300 px-3 py-2 text-sm font-medium text-amber-700 transition hover:bg-amber-50 disabled:opacity-50"
            >
              <Undo2 className="h-4 w-4" />
              ตีกลับ
            </button>
            <button
              onClick={() => submitDecision(trips.filter((t) => selected.has(t.tripOrderId)), "approved")}
              disabled={busy}
              className="flex items-center gap-1 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-emerald-700 disabled:opacity-50"
            >
              <Check className="h-4 w-4" />
              อนุมัติที่เลือก
            </button>
          </div>
        </div>
      )}

      {commentPrompt && (
        <CommentModal
          kind={commentPrompt.kind}
          count={commentPrompt.groups.length}
          text={commentPrompt.text}
          onChangeText={(text) => setCommentPrompt((p) => (p ? { ...p, text } : p))}
          busy={busy}
          error={error}
          onCancel={() => {
            setError("");
            setCommentPrompt(null);
          }}
          onConfirm={confirmCommentPrompt}
        />
      )}
    </main>
  );
}

/**
 * มุมมอง "ปฏิทิน" ของหน้า /director — ทางเลือกแสดงผลเพิ่มจากมุมมอง "รายการ"
 * เดิม (ตามที่ขอ "อยากให้แสดงเป็นรูปแบบปฎิทิน เช่นเดียวกับของผู้ใช้งาน ...
 * จะได้เห็นรายการที่เคยทำการอนุมัติไปแล้วได้ด้วย ทำเป็นรูปแบบให้ผอ.ท่านเลือกใช้
 * ก็ได้ครับแบบเดิมก็เก็บไว้") ใช้ `trips` ที่ส่งมาเป็น allTrips จาก
 * getDirectorAllTrips (ทุกรายการที่ผ่านมือ ผอ. มาแล้ว ไม่ใช่แค่ "pending"),
 * ตรงนี้จึงเห็นทั้งที่รออยู่ (เหลือง) และที่ตัดสินใจไปแล้ว (เขียว/แดง) ต่างจาก
 * มุมมองรายการที่เป็นคิวงานต้องทำล้วนๆ. ตัวตาราง/การนำทางเดือนก๊อปแนวทางเดียวกับ
 * BookingCalendar.tsx (ดูคอมเมนต์ที่ monthGrid/dateKeyFromDate ด้านบนไฟล์) แต่
 * ใช้สไตล์ indigo/slate การ์ดมือถือเดียวกับส่วนอื่นของหน้านี้ ไม่ใช่สไตล์
 * zinc/dark-mode ของ /booking (หน้านี้ไม่มี dark mode เลยอยู่แล้ว).
 */
function DirectorCalendarView({
  trips,
  decided,
  busy,
  onApprove,
  onReject,
  onReturn,
}: {
  trips: DirectorTripItem[];
  decided: Map<string, DecidedTone>;
  busy: boolean;
  onApprove: (groups: DirectorTripItem[]) => void;
  onReject: (groups: DirectorTripItem[]) => void;
  onReturn: (groups: DirectorTripItem[]) => void;
}) {
  const [monthCursor, setMonthCursor] = useState(() => startOfMonth(new Date()));
  const [selectedDateKey, setSelectedDateKey] = useState<string | null>(null);
  const todayKey = todayDateKey();

  const days = useMemo(() => monthGrid(monthCursor), [monthCursor]);

  const tripsByDate = useMemo(() => {
    const map = new Map<string, DirectorTripItem[]>();
    for (const t of trips) {
      const dateKey = splitBookingDateTime(t.startTime)?.dateKey;
      if (!dateKey) continue;
      const list = map.get(dateKey);
      if (list) list.push(t);
      else map.set(dateKey, [t]);
    }
    for (const list of map.values()) {
      list.sort((a, b) => (a.startTime < b.startTime ? -1 : 1));
    }
    return map;
  }, [trips]);

  const dayTrips = selectedDateKey ? tripsByDate.get(selectedDateKey) ?? [] : [];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2 rounded-xl bg-white/70 px-2 py-1.5 shadow-sm">
        <button
          type="button"
          onClick={() => setMonthCursor((m) => new Date(m.getFullYear(), m.getMonth() - 1, 1))}
          aria-label="เดือนก่อนหน้า"
          className="rounded-full p-2 text-slate-500 transition hover:bg-white"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-slate-700">
            {THAI_MONTHS[monthCursor.getMonth()]} {monthCursor.getFullYear() + 543}
          </span>
          <button
            type="button"
            onClick={() => setMonthCursor(startOfMonth(new Date()))}
            className="rounded-full border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-500 transition hover:bg-white"
          >
            วันนี้
          </button>
        </div>
        <button
          type="button"
          onClick={() => setMonthCursor((m) => new Date(m.getFullYear(), m.getMonth() + 1, 1))}
          aria-label="เดือนถัดไป"
          className="rounded-full p-2 text-slate-500 transition hover:bg-white"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>

      {/* legend สีเล็กๆ บอกความหมายจุดในช่องวัน */}
      <div className="flex flex-wrap items-center gap-3 px-1 text-[11px] text-slate-500">
        <span className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-full bg-amber-500" aria-hidden="true" />
          รออนุมัติ
        </span>
        <span className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-full bg-emerald-500" aria-hidden="true" />
          อนุมัติแล้ว
        </span>
        <span className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-full bg-rose-500" aria-hidden="true" />
          ไม่อนุมัติ
        </span>
      </div>

      <div className="grid grid-cols-7 overflow-hidden rounded-xl border border-slate-200 bg-white">
        {THAI_WEEKDAYS.map((wd) => (
          <div
            key={wd}
            className="border-b border-r border-slate-100 bg-slate-50 py-1.5 text-center text-[10px] font-medium text-slate-400 last:border-r-0"
          >
            {wd.replace("วัน", "")}
          </div>
        ))}
        {days.map((day) => {
          const key = dateKeyFromDate(day);
          const inMonth = day.getMonth() === monthCursor.getMonth();
          const list = tripsByDate.get(key) ?? [];
          const isToday = key === todayKey;
          return (
            <button
              type="button"
              key={key}
              onClick={() => list.length > 0 && setSelectedDateKey(key)}
              disabled={list.length === 0}
              className={`flex min-h-[3.75rem] flex-col items-center gap-1 border-b border-r border-slate-100 p-1 last:border-r-0 ${
                inMonth ? "bg-white" : "bg-slate-50/60"
              } ${list.length > 0 ? "cursor-pointer hover:bg-slate-50" : "cursor-default"}`}
            >
              <span
                className={`inline-flex h-5 w-5 items-center justify-center rounded-full text-[11px] ${
                  isToday ? "bg-indigo-600 font-semibold text-white" : inMonth ? "text-slate-600" : "text-slate-300"
                }`}
              >
                {day.getDate()}
              </span>
              {list.length > 0 && (
                <div className="flex flex-wrap items-center justify-center gap-0.5">
                  {list.slice(0, 4).map((t) => {
                    const liveTone = decided.get(t.tripOrderId);
                    const status = liveTone === "approved" || liveTone === "rejected" ? liveTone : tripGroupStatus(t);
                    const dotClass =
                      status === "approved" ? "bg-emerald-500" : status === "rejected" ? "bg-rose-500" : "bg-amber-500";
                    return <span key={t.tripOrderId} className={`h-1.5 w-1.5 rounded-full ${dotClass}`} aria-hidden="true" />;
                  })}
                  {list.length > 4 && <span className="text-[9px] text-slate-400">+{list.length - 4}</span>}
                </div>
              )}
            </button>
          );
        })}
      </div>

      {trips.length === 0 && <p className="mt-4 text-center text-sm text-slate-400">ยังไม่มีรายการในเดือนนี้</p>}

      {selectedDateKey && (
        <CalendarDayModal
          dateKey={selectedDateKey}
          trips={dayTrips}
          decided={decided}
          busy={busy}
          onApprove={onApprove}
          onReject={onReject}
          onReturn={onReturn}
          onClose={() => setSelectedDateKey(null)}
        />
      )}
    </div>
  );
}

/** หน้าต่างรายละเอียดวันของมุมมองปฏิทิน — คลิกวันที่มีเที่ยวรถใน
 * DirectorCalendarView แล้วเปิดตัวนี้ แสดงทุกเที่ยวของวันนั้น (ทั้งที่รออยู่
 * และที่ตัดสินใจไปแล้ว) ให้ยังอนุมัติ/ไม่อนุมัติ/ตีกลับได้ตรงนี้เลยถ้ายังรออยู่
 * (ดู CalendarTripEntry ด้านล่าง) — ตั้งใจไม่ทำ overlay เต็มจอเหมือน CommentModal
 * ให้ปิดด้วยการคลิกฉากหลังได้เหมือน DayDetailModal ของ BookingCalendar.tsx. */
function CalendarDayModal({
  dateKey,
  trips,
  decided,
  busy,
  onApprove,
  onReject,
  onReturn,
  onClose,
}: {
  dateKey: string;
  trips: DirectorTripItem[];
  decided: Map<string, DecidedTone>;
  busy: boolean;
  onApprove: (groups: DirectorTripItem[]) => void;
  onReject: (groups: DirectorTripItem[]) => void;
  onReturn: (groups: DirectorTripItem[]) => void;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-40 flex items-end justify-center bg-slate-900/40 px-4 pb-4 pt-20 sm:items-center"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[80vh] w-full max-w-sm flex-col overflow-hidden rounded-2xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
          <h2 className="text-sm font-bold text-slate-800">{formatThaiDateHeader(dateKey)}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="ปิดหน้าต่าง"
            className="rounded-full p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <ul className="flex flex-col gap-3 overflow-y-auto px-4 py-4">
          {trips.length === 0 ? (
            <p className="py-4 text-center text-sm text-slate-400">ไม่มีรายการในวันนี้</p>
          ) : (
            trips.map((trip) => (
              <CalendarTripEntry
                key={trip.tripOrderId}
                trip={trip}
                decided={decided.get(trip.tripOrderId)}
                busy={busy}
                onApprove={() => onApprove([trip])}
                onReject={() => onReject([trip])}
                onReturn={() => onReturn([trip])}
              />
            ))
          )}
        </ul>
      </div>
    </div>
  );
}

/** หนึ่งเที่ยวรถในหน้าต่างรายละเอียดวันของมุมมองปฏิทิน — ต่างจาก TripCard ของ
 * มุมมองรายการตรงที่ต้องรองรับทั้งสถานะ "รออยู่" (มีปุ่มจัดการให้) และ "ตัดสินใจ
 * ไปแล้ว" (แค่ป้ายสถานะ, ไม่มีปุ่ม — ข้อมูลนี้มาจาก directorApprovalStatus ที่
 * เก็บไว้จริงในชีต ไม่ใช่แค่ local state เหมือน `decided` ของมุมมองรายการที่
 * เป็นแค่ลูกเล่นสีก่อนรายการจะหลุดจากคิว) — ไม่มีช่องเลือกหลายรายการ (checkbox)
 * เหมือน TripCard เพราะมุมมองปฏิทินเน้นดูภาพรวม/จัดการทีละวันละรายการพอ. */
function CalendarTripEntry({
  trip,
  decided,
  busy,
  onApprove,
  onReject,
  onReturn,
}: {
  trip: DirectorTripItem;
  decided?: DecidedTone;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
  onReturn: () => void;
}) {
  // `decided` (ลูกเล่นสีชั่วคราวหลังกดเมื่อกี้) มาก่อนสถานะที่เก็บจริงเสมอ ถ้ามี
  // — ให้เห็นผลทันทีโดยไม่ต้องรอ allTrips อัปเดต (แม้จะอัปเดตเกือบพร้อมกันอยู่
  // แล้วก็ตาม ดู applyDecisionToAllTrips)
  const status = decided ?? tripGroupStatus(trip);
  const isPending = status === "pending";
  const note = trip.requests.find((r) => r.directorNote)?.directorNote;
  const start = splitBookingDateTime(trip.startTime);
  const end = splitBookingDateTime(trip.endTime);

  const toneClass =
    status === "approved"
      ? "border-emerald-200 bg-emerald-50"
      : status === "rejected"
        ? "border-rose-200 bg-rose-50"
        : status === "returned"
          ? "border-amber-200 bg-amber-50"
          : "border-slate-200 bg-white";
  const badgeClass =
    status === "approved"
      ? "bg-emerald-100 text-emerald-700"
      : status === "rejected"
        ? "bg-rose-100 text-rose-700"
        : "bg-amber-100 text-amber-700";
  const badgeText =
    status === "approved"
      ? "อนุมัติแล้ว"
      : status === "rejected"
        ? "ไม่อนุมัติแล้ว"
        : status === "returned"
          ? "ตีกลับแล้ว"
          : "รออนุมัติ";

  return (
    <li className={`rounded-xl border p-3 ${toneClass}`}>
      <div className="flex items-start gap-3">
        {trip.resourceImageDataUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- data: URL ขนาดเล็ก เหมือน TripCard ด้านบน
          <img
            src={trip.resourceImageDataUrl}
            alt={trip.resourceName}
            className="h-12 w-12 flex-shrink-0 rounded-lg object-cover"
          />
        ) : (
          <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-indigo-400">
            <Car className="h-5 w-5" />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-slate-900">{trip.resourceName || "(ยังไม่ระบุรถ)"}</p>
          {trip.driverName && <p className="text-xs text-slate-500">คนขับ: {trip.driverName}</p>}
          <p className="mt-0.5 text-xs text-slate-400">
            {start?.time ?? "—"} – {end?.time ?? "—"}
          </p>
        </div>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${badgeClass}`}>{badgeText}</span>
      </div>

      <div className="mt-2 space-y-1.5">
        {trip.requests.map((r) => (
          <div key={r.bookingId} className="rounded-lg bg-white/70 px-2.5 py-1.5 text-xs text-slate-600">
            <p className="font-medium text-slate-800">{r.purpose || "(ไม่ระบุวัตถุประสงค์)"}</p>
            <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-slate-500">
              <span>
                {r.bookedByDisplayName}
                {r.department ? ` · ${r.department}` : ""}
              </span>
              {r.destination && <span>ไป {r.destination}</span>}
              {r.participants > 0 && <span>{r.participants} คน</span>}
            </p>
          </div>
        ))}
      </div>

      {note && (
        <p className="mt-2 text-xs text-slate-500">
          {status === "rejected" ? "เหตุผล: " : "หมายเหตุ: "}
          {note}
        </p>
      )}

      {isPending && (
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={onReject}
            disabled={busy}
            className="flex items-center gap-1 rounded-lg border border-rose-300 px-2.5 py-1.5 text-xs font-medium text-rose-700 transition hover:bg-rose-50 disabled:opacity-50"
          >
            <X className="h-3.5 w-3.5" />
            ไม่อนุมัติ
          </button>
          <button
            type="button"
            onClick={onReturn}
            disabled={busy}
            className="flex items-center gap-1 rounded-lg border border-amber-300 px-2.5 py-1.5 text-xs font-medium text-amber-700 transition hover:bg-amber-50 disabled:opacity-50"
          >
            <Undo2 className="h-3.5 w-3.5" />
            ตีกลับ
          </button>
          <button
            type="button"
            onClick={onApprove}
            disabled={busy}
            className="ml-auto flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm transition hover:bg-emerald-700 disabled:opacity-50"
          >
            <Check className="h-3.5 w-3.5" />
            อนุมัติ
          </button>
        </div>
      )}
    </li>
  );
}

/** ป็อปอัปขอข้อความก่อนยืนยัน "ไม่อนุมัติ" (เหตุผลให้ผู้จองรับทราบ) หรือ
 * "ตีกลับ" (ข้อความถึงฝ่ายบริหารผู้จัดรถ) — ใช้ร่วมกันสองกรณีเพราะหน้าตา/ที่มา
 * ของข้อความเหมือนกันทุกอย่าง ต่างกันแค่ถ้อยคำกำกับและว่าบังคับกรอกหรือไม่
 * (ตีกลับบังคับ เพราะไม่มีข้อความก็ไม่มีประโยชน์อะไรกับฝ่ายบริหาร — ไม่อนุมัติ
 * ไม่บังคับ เผื่อ ผอ. อยากกดปฏิเสธเฉยๆ โดยไม่อธิบาย). */
function CommentModal({
  kind,
  count,
  text,
  onChangeText,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  kind: "reject" | "return";
  count: number;
  text: string;
  onChangeText: (v: string) => void;
  busy: boolean;
  error: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const isReturn = kind === "return";
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 px-4 pb-4 pt-20 sm:items-center">
      <div className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl">
        <div className="flex items-center gap-2">
          <div
            className={`flex h-9 w-9 items-center justify-center rounded-full ${
              isReturn ? "bg-amber-100 text-amber-700" : "bg-rose-100 text-rose-700"
            }`}
          >
            {isReturn ? <Undo2 className="h-4 w-4" /> : <X className="h-4 w-4" />}
          </div>
          <h2 className="text-base font-bold text-slate-900">
            {isReturn ? "ตีกลับให้จัดรถใหม่" : "ไม่อนุมัติการเดินทาง"}
          </h2>
        </div>
        <p className="mt-1.5 text-sm text-slate-500">
          {count} รายการ —{" "}
          {isReturn
            ? "ข้อความนี้จะส่งถึงฝ่ายบริหารผู้จัดรถ เพื่อให้จัดรถ/คนขับ/เวลาใหม่"
            : "ข้อความนี้ (ถ้ามี) จะให้ผู้จองเห็นว่าทำไมถึงไม่ได้รับอนุมัติ"}
        </p>

        {error && <div className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}

        <label className="mt-4 block text-sm font-medium text-slate-700">
          {isReturn ? "ข้อความถึงผู้จัดรถ" : "เหตุผล (ไม่บังคับ)"}
          <textarea
            autoFocus
            rows={3}
            value={text}
            onChange={(e) => onChangeText(e.target.value)}
            placeholder={isReturn ? "เช่น ขอเปลี่ยนรถให้ใหญ่ขึ้น หรือเปลี่ยนช่วงเวลา" : "เช่น ช่วงเวลาที่ขอชนกับภารกิจอื่น"}
            className="mt-1 w-full resize-none rounded-lg border border-slate-300 px-3 py-2.5 text-sm focus:border-indigo-600 focus:outline-none"
          />
        </label>

        <div className="mt-4 flex gap-2">
          <button
            onClick={onCancel}
            disabled={busy}
            className="flex-1 rounded-lg border border-slate-300 py-2.5 text-sm font-medium text-slate-600 disabled:opacity-50"
          >
            ยกเลิก
          </button>
          <button
            onClick={onConfirm}
            disabled={busy}
            className={`flex flex-1 items-center justify-center gap-2 rounded-lg py-2.5 text-sm font-medium text-white disabled:opacity-50 ${
              isReturn ? "bg-amber-600" : "bg-rose-600"
            }`}
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {isReturn ? "ยืนยันตีกลับ" : "ยืนยันไม่อนุมัติ"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** ช่วงเวลาไป-กลับแบบกราฟเส้นเวลาสั้นๆ — ตามที่ขอ "กราฟเส้นเวลาการเดินทาง
 * ไปกลับ และทำให้เวลาเริ่มเดินทางเด่นชัดกว่านี้" เวลาเริ่ม (ไป) ใหญ่/ชัดกว่า
 * เวลากลับเสมอ ตามที่ขอตรงๆ ("เวลาเริ่มเดินทาง"). แสดงวันที่แค่ครั้งเดียวถ้าไป
 * กลับวันเดียวกัน (กรณีทั่วไป) ถ้าข้ามวัน (ค้างคืน) แสดงวันที่กำกับทั้งสองฝั่ง
 * แยกกันแทน กันข้อมูลวันที่หายเหมือนที่ formatBookingDateRange ทำ. */
function TripTimeline({ startTime, endTime }: { startTime: string; endTime: string }) {
  const start = splitBookingDateTime(startTime);
  const end = splitBookingDateTime(endTime);
  const sameDay = !!start && !!end && start.dateKey === end.dateKey;

  return (
    <div className="mt-3 rounded-xl bg-slate-50 px-3 py-2.5">
      <div className="flex items-center">
        <div className="flex min-w-[3.4rem] flex-col">
          <span className="text-[11px] font-medium text-slate-400">ไป</span>
          <span className="text-xl font-extrabold leading-tight text-indigo-700">{start?.time ?? "—"}</span>
          {!sameDay && start && <span className="text-[11px] text-slate-400">{formatBookingDateTime(startTime).split(" ")[0]}</span>}
        </div>
        <div className="relative mx-2 h-px flex-1 bg-gradient-to-r from-indigo-400 via-slate-300 to-emerald-400">
          <Car className="absolute left-1/2 top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full bg-slate-50 text-slate-400" />
        </div>
        <div className="flex min-w-[3.4rem] flex-col items-end">
          <span className="text-[11px] font-medium text-slate-400">กลับ</span>
          <span className="text-base font-semibold leading-tight text-emerald-700">{end?.time ?? "—"}</span>
          {!sameDay && end && <span className="text-[11px] text-slate-400">{formatBookingDateTime(endTime).split(" ")[0]}</span>}
        </div>
      </div>
      {sameDay && start && (
        <p className="mt-1 text-center text-[11px] text-slate-400">{formatBookingDateTime(startTime).split(" ")[0]}</p>
      )}
    </div>
  );
}

function TripCard({
  trip,
  selected,
  decided,
  onToggle,
  onApprove,
  onReject,
  onReturn,
  busy,
}: {
  trip: DirectorTripItem;
  selected: boolean;
  decided?: DecidedTone;
  onToggle: () => void;
  onApprove: () => void;
  onReject: () => void;
  onReturn: () => void;
  busy: boolean;
}) {
  const [expanded, setExpanded] = useState(trip.requests.length <= 1);
  const totalParticipants = trip.requests.reduce((sum, r) => sum + r.participants, 0);
  const primary = trip.requests[0];

  const decidedStyle =
    decided === "approved"
      ? "border-emerald-500 bg-emerald-50"
      : decided === "rejected"
        ? "border-rose-400 bg-rose-50"
        : decided === "returned"
          ? "border-amber-400 bg-amber-50"
          : selected
            ? "border-indigo-500 ring-1 ring-indigo-500"
            : "border-slate-200";

  return (
    <li className={`rounded-2xl border bg-white p-4 shadow-sm transition-colors ${decidedStyle}`}>
      {decided ? (
        <div className="flex items-center gap-2 py-1">
          <span
            className={`flex h-7 w-7 items-center justify-center rounded-full ${
              decided === "approved"
                ? "bg-emerald-600 text-white"
                : decided === "rejected"
                  ? "bg-rose-500 text-white"
                  : "bg-amber-500 text-white"
            }`}
          >
            {decided === "returned" ? <Undo2 className="h-4 w-4" /> : decided === "approved" ? (
              <Check className="h-4 w-4" />
            ) : (
              <X className="h-4 w-4" />
            )}
          </span>
          <span className="text-sm font-semibold text-slate-700">
            {decided === "approved" && "อนุมัติแล้ว"}
            {decided === "rejected" && "ไม่อนุมัติแล้ว"}
            {decided === "returned" && "ตีกลับให้จัดรถใหม่แล้ว"}
          </span>
        </div>
      ) : (
        <div className="flex gap-3">
          <input
            type="checkbox"
            className="mt-1 h-5 w-5 flex-shrink-0 accent-indigo-600"
            checked={selected}
            onChange={onToggle}
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-start gap-3">
              {trip.resourceImageDataUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- data: URL ขนาดเล็ก ไม่ใช่ไฟล์จาก public/ ให้ next/image ปรับขนาด
                <img
                  src={trip.resourceImageDataUrl}
                  alt={trip.resourceName}
                  className="h-14 w-14 flex-shrink-0 rounded-xl object-cover shadow-sm"
                />
              ) : (
                <div className="flex h-14 w-14 flex-shrink-0 items-center justify-center rounded-xl bg-indigo-50 text-indigo-400">
                  <Car className="h-6 w-6" />
                </div>
              )}
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-slate-900">{trip.resourceName || "(ยังไม่ระบุรถ)"}</p>
                {trip.driverName && (
                  <p className="mt-0.5 flex items-center gap-1 text-sm text-slate-500">
                    <User className="h-3.5 w-3.5" />
                    คนขับ: {trip.driverName}
                  </p>
                )}
              </div>
            </div>

            <TripTimeline startTime={trip.startTime} endTime={trip.endTime} />

            <div className="mt-3 space-y-2">
              {(expanded ? trip.requests : trip.requests.slice(0, 1)).map((r) => (
                <div key={r.bookingId} className="rounded-lg border border-slate-100 bg-slate-50/60 px-3 py-2">
                  <p className="text-sm font-medium text-slate-800">{r.purpose || "(ไม่ระบุวัตถุประสงค์)"}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
                    <span className="flex items-center gap-1">
                      <Building2 className="h-3.5 w-3.5" />
                      {r.bookedByDisplayName}
                      {r.department ? ` · ${r.department}` : ""}
                    </span>
                    {r.destination && <span>ไป {r.destination}</span>}
                    {r.participants > 0 && (
                      <span className="flex items-center gap-1">
                        <Users className="h-3.5 w-3.5" />
                        {r.participants} คน
                      </span>
                    )}
                  </div>
                </div>
              ))}
              {trip.requests.length > 1 && !expanded && (
                <button
                  onClick={() => setExpanded(true)}
                  className="flex w-full items-center justify-center gap-1 rounded-lg border border-dashed border-slate-300 py-1.5 text-xs font-medium text-slate-500"
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                  อีก {trip.requests.length - 1} คำขอในเที่ยวเดียวกัน (รวม {totalParticipants} คน)
                </button>
              )}
              {trip.requests.length > 1 && expanded && (
                <p className="px-1 text-center text-[11px] text-slate-400">
                  {trip.requests.length} คำขอรวมกัน ({totalParticipants} คน) — เดินทางรถคันเดียวกัน
                </p>
              )}
              {trip.requests.length === 1 && primary?.companions && (
                <p className="px-1 text-xs text-slate-400">ผู้ร่วมเดินทาง: {primary.companions}</p>
              )}
            </div>

            <div className="mt-3 flex gap-2">
              <button
                onClick={onReject}
                disabled={busy}
                className="flex items-center gap-1 rounded-lg border border-rose-300 px-3 py-1.5 text-sm font-medium text-rose-700 transition hover:bg-rose-50 disabled:opacity-50"
              >
                <X className="h-4 w-4" />
                ไม่อนุมัติ
              </button>
              <button
                onClick={onReturn}
                disabled={busy}
                className="flex items-center gap-1 rounded-lg border border-amber-300 px-3 py-1.5 text-sm font-medium text-amber-700 transition hover:bg-amber-50 disabled:opacity-50"
              >
                <Undo2 className="h-4 w-4" />
                ตีกลับ
              </button>
              <button
                onClick={onApprove}
                disabled={busy}
                className="ml-auto flex items-center gap-1 rounded-lg bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white shadow-sm transition hover:bg-emerald-700 disabled:opacity-50"
              >
                <Check className="h-4 w-4" />
                อนุมัติ
              </button>
            </div>
          </div>
        </div>
      )}
    </li>
  );
}

function LoginScreen({
  password,
  setPassword,
  onSubmit,
  busy,
  error,
  notice,
  onForgotPassword,
}: {
  password: string;
  setPassword: (v: string) => void;
  onSubmit: (e: React.FormEvent) => void;
  busy: boolean;
  error: string;
  notice: string;
  onForgotPassword: () => void;
}) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-gradient-to-br from-indigo-950 via-indigo-900 to-slate-900 px-4">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm rounded-3xl bg-white p-8 shadow-2xl shadow-indigo-950/40"
      >
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-600 to-indigo-800 text-white shadow-md shadow-indigo-900/30">
          <Car className="h-6 w-6" />
        </div>
        <h1 className="mt-4 text-center text-lg font-bold text-slate-900">อนุมัติการเดินทาง</h1>
        <p className="mt-1 text-center text-sm text-slate-400">สำหรับผู้อำนวยการ</p>

        {notice && (
          <div className="mt-4 rounded-xl bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{notice}</div>
        )}
        {error && <div className="mt-4 rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}

        <label className="mt-6 block text-sm font-medium text-slate-700">
          รหัสผ่าน
          <input
            type="password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1.5 w-full rounded-xl border border-slate-300 px-3.5 py-3 text-base focus:border-indigo-600 focus:outline-none focus:ring-2 focus:ring-indigo-100"
          />
        </label>

        <button
          type="submit"
          disabled={busy || !password}
          className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-700 py-3 font-medium text-white shadow-sm transition hover:bg-indigo-800 disabled:opacity-50"
        >
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          เข้าสู่ระบบ
        </button>

        <button
          type="button"
          onClick={onForgotPassword}
          className="mt-4 w-full text-center text-sm text-slate-400 underline underline-offset-2"
        >
          ลืมรหัสผ่าน / เปลี่ยนรหัสผ่าน
        </button>
      </form>
    </main>
  );
}

function ResetPasswordScreen({
  currentPassword,
  setCurrentPassword,
  newPassword,
  setNewPassword,
  confirmPassword,
  setConfirmPassword,
  onSubmit,
  busy,
  error,
  onBack,
}: {
  currentPassword: string;
  setCurrentPassword: (v: string) => void;
  newPassword: string;
  setNewPassword: (v: string) => void;
  confirmPassword: string;
  setConfirmPassword: (v: string) => void;
  onSubmit: (e: React.FormEvent) => void;
  busy: boolean;
  error: string;
  onBack: () => void;
}) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-gradient-to-br from-indigo-950 via-indigo-900 to-slate-900 px-4">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm rounded-3xl bg-white p-8 shadow-2xl shadow-indigo-950/40"
      >
        <h1 className="text-center text-lg font-bold text-slate-900">เปลี่ยนรหัสผ่าน</h1>

        {error && <div className="mt-4 rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}

        <label className="mt-6 block text-sm font-medium text-slate-700">
          รหัสผ่านปัจจุบัน
          <input
            type="password"
            autoFocus
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            className="mt-1.5 w-full rounded-xl border border-slate-300 px-3.5 py-3 text-base focus:border-indigo-600 focus:outline-none focus:ring-2 focus:ring-indigo-100"
          />
        </label>
        <label className="mt-3 block text-sm font-medium text-slate-700">
          รหัสผ่านใหม่
          <input
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            className="mt-1.5 w-full rounded-xl border border-slate-300 px-3.5 py-3 text-base focus:border-indigo-600 focus:outline-none focus:ring-2 focus:ring-indigo-100"
          />
        </label>
        <label className="mt-3 block text-sm font-medium text-slate-700">
          ยืนยันรหัสผ่านใหม่
          <input
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            className="mt-1.5 w-full rounded-xl border border-slate-300 px-3.5 py-3 text-base focus:border-indigo-600 focus:outline-none focus:ring-2 focus:ring-indigo-100"
          />
        </label>

        <button
          type="submit"
          disabled={busy || !currentPassword || !newPassword || !confirmPassword}
          className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-700 py-3 font-medium text-white shadow-sm transition hover:bg-indigo-800 disabled:opacity-50"
        >
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          บันทึกรหัสผ่านใหม่
        </button>

        <button type="button" onClick={onBack} className="mt-4 w-full text-center text-sm text-slate-400 underline underline-offset-2">
          กลับไปหน้าเข้าสู่ระบบ
        </button>
      </form>
    </main>
  );
}
