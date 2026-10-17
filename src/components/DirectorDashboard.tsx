"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Building2,
  Car,
  Check,
  ChevronDown,
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
    tripOrderIds: string[];
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

  async function submitDecision(tripOrderIds: string[], decision: "approved" | "rejected", comment: string = "") {
    if (tripOrderIds.length === 0) return;
    const groups = trips.filter((t) => tripOrderIds.includes(t.tripOrderId));
    const bookingIds = groups.flatMap((g) => g.requests.map((r) => r.bookingId));
    if (bookingIds.length === 0) return;
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

  async function submitReturn(tripOrderIds: string[], comment: string) {
    if (tripOrderIds.length === 0) return;
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

  function openCommentPrompt(kind: "reject" | "return", tripOrderIds: string[]) {
    setError("");
    setCommentPrompt({ kind, tripOrderIds, text: "" });
  }

  async function confirmCommentPrompt() {
    if (!commentPrompt) return;
    const { kind, tripOrderIds, text } = commentPrompt;
    if (kind === "return" && !text.trim()) {
      setError("กรุณาระบุข้อความถึงฝ่ายบริหารผู้จัดรถก่อนตีกลับ");
      return;
    }
    setCommentPrompt(null);
    if (kind === "reject") {
      await submitDecision(tripOrderIds, "rejected", text.trim());
    } else {
      await submitReturn(tripOrderIds, text.trim());
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
            onClick={() => loadTrips()}
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

      {trips.length === 0 ? (
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
                      onApprove={() => submitDecision([trip.tripOrderId], "approved")}
                      onReject={() => openCommentPrompt("reject", [trip.tripOrderId])}
                      onReturn={() => openCommentPrompt("return", [trip.tripOrderId])}
                      busy={busy}
                    />
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </>
      )}

      {selected.size > 0 && (
        <div className="fixed inset-x-0 bottom-0 border-t border-slate-200 bg-white/95 px-4 py-3 shadow-[0_-4px_16px_rgba(0,0,0,0.08)] backdrop-blur">
          <div className="mx-auto flex max-w-2xl items-center gap-2">
            <span className="flex-1 text-sm font-medium text-slate-700">เลือกไว้ {selected.size} รายการ</span>
            <button
              onClick={() => openCommentPrompt("reject", Array.from(selected))}
              disabled={busy}
              className="flex items-center gap-1 rounded-lg border border-rose-300 px-3 py-2 text-sm font-medium text-rose-700 transition hover:bg-rose-50 disabled:opacity-50"
            >
              <X className="h-4 w-4" />
              ไม่อนุมัติ
            </button>
            <button
              onClick={() => openCommentPrompt("return", Array.from(selected))}
              disabled={busy}
              className="flex items-center gap-1 rounded-lg border border-amber-300 px-3 py-2 text-sm font-medium text-amber-700 transition hover:bg-amber-50 disabled:opacity-50"
            >
              <Undo2 className="h-4 w-4" />
              ตีกลับ
            </button>
            <button
              onClick={() => submitDecision(Array.from(selected), "approved")}
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
          count={commentPrompt.tripOrderIds.length}
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
