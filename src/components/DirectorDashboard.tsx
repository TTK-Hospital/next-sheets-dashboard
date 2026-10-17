"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Car, Check, Clock, Loader2, LogOut, RefreshCw, User, Users, X } from "lucide-react";
import { formatBookingDateRange } from "@/lib/booking";
import type { DirectorTripItem } from "@/lib/sheets";

// ผอ. ต้องเห็นคำขอใหม่เร็ว (รถถูกจัดเสร็จแล้วรออยู่) แต่ไม่ต้องถี่เท่า
// NotificationBell.tsx (15 วินาที, ของฝ่ายบริหารตอนจัดรถ) — 20 วินาทีพอเหมาะ
// สำหรับหน้าที่เปิดทิ้งไว้รอบเดียวแล้วรับทราบทีละชุด
const POLL_INTERVAL_MS = 20_000;

type Screen = "checking" | "login" | "resetPassword" | "ready";

/**
 * หน้า /director ทั้งหมด (ล็อกอิน + รีเซ็ตรหัสผ่าน + รายการรอรับทราบ) อยู่ใน
 * คอมโพเนนต์เดียวนี้โดยตั้งใจ — ตามที่ขอ "เมนูตัวเลือกน้อยๆ เข้าใจง่าย" ไม่มี
 * เหตุผลต้องแยกเป็นหลายหน้า/หลาย route ของจริง ทุกอย่างคือ state เดียวกันของ
 * ผอ. คนเดียว.
 *
 * ไม่ส่ง username ไปกับ login/reset-password request เลย (ดูคอมเมนต์หัวไฟล์
 * lib/directorAuth.ts) — เช็ค session ด้วยการลอง GET /api/director/trips
 * ตรงๆ ตอนโหลดหน้า: 200 แปลว่าเข้าสู่ระบบอยู่แล้ว (คุกกี้ยังไม่หมดอายุ), 401
 * แปลว่าต้องกรอกรหัสผ่านก่อน.
 */
export default function DirectorDashboard() {
  // screen และ trips รวมเป็น state ก้อนเดียวตั้งใจ (ไม่ใช่ useState สองตัว
  // แยกกัน) — loadTrips ด้านล่างต้องอัปเดตทั้งคู่พร้อมกันตอนโหลดสำเร็จ ถ้าแยก
  // state จะกลายเป็นเรียก setState 2 ครั้งซ้อนกันภายใน effect เดียว (ตอนเปิด
  // หน้าครั้งแรก) ซึ่ง react-hooks/set-state-in-effect เตือนว่าทำให้เกิด
  // re-render ซ้อนกันหลายรอบโดยไม่จำเป็น — เหตุผลเดียวกับ approvalPanel ใน
  // NotificationBell.tsx
  const [view, setView] = useState<{ screen: Screen; trips: DirectorTripItem[] }>({ screen: "checking", trips: [] });
  const screen = view.screen;
  const trips = view.trips;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const [password, setPassword] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

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
  // แทน ตั้งเวลา 0 มิลลิวินาทีเพื่อให้ทำงานทันทีในทางปฏิบัติ แค่ไม่ใช่
  // synchronous call ในมุมของ effect) — react-hooks/set-state-in-effect
  // เตือนตรงๆ ว่าการเรียกฟังก์ชันที่ setState อยู่โดยตรงใน effect (ไม่ผ่าน
  // callback ของ timer/subscription) เสี่ยง cascading re-render เหมือนที่
  // DriverCalendar.tsx เลี่ยงด้วยการรับ initialTrips จาก server component
  // แทนไม่ต้อง fetch ตอน mount เลย — แต่หน้านี้ต้องเช็ค session ก่อนเสมอ (ไม่มี
  // อะไรให้ fetch ล่วงหน้าจากฝั่งเซิร์ฟเวอร์ได้ ดูคอมเมนต์ที่ page.tsx) จึงใช้
  // setTimeout(..., 0) เป็นทางออกที่ยังคงเช็คตั้งแต่เปิดหน้าทันทีได้เหมือนเดิม
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

  async function submitDecision(bookingIds: string[], decision: "approved" | "rejected") {
    if (bookingIds.length === 0) return;
    setError("");
    setBusy(true);
    try {
      const res = await fetch("/api/director/trips/decision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bookingIds, decision }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "บันทึกไม่สำเร็จ");
      setView((v) => ({ ...v, trips: v.trips.filter((t) => !bookingIds.includes(t.bookingId)) }));
      setSelected((prev) => {
        const next = new Set(prev);
        bookingIds.forEach((id) => next.delete(id));
        return next;
      });
      setNotice(
        decision === "approved"
          ? `รับทราบแล้ว ${bookingIds.length} รายการ`
          : `ไม่รับทราบแล้ว ${bookingIds.length} รายการ`
      );
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "บันทึกไม่สำเร็จ");
    } finally {
      setBusy(false);
    }
  }

  function toggleSelected(bookingId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(bookingId)) next.delete(bookingId);
      else next.add(bookingId);
      return next;
    });
  }

  const allSelected = trips.length > 0 && selected.size === trips.length;
  function toggleSelectAll() {
    setSelected(allSelected ? new Set() : new Set(trips.map((t) => t.bookingId)));
  }

  // เคลียร์ notice เองหลัง 4 วินาที ไม่ต้องให้ ผอ. กดปิดเอง
  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(""), 4000);
    return () => clearTimeout(id);
  }, [notice]);

  if (screen === "checking") {
    return (
      <main className="flex min-h-screen items-center justify-center bg-gray-50">
        <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
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
    <main className="mx-auto min-h-screen max-w-2xl bg-gray-50 px-4 pb-28 pt-6">
      <header className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-bold text-gray-900">อนุมัติการเดินทาง</h1>
        <div className="flex items-center gap-2">
          <button
            onClick={() => loadTrips()}
            disabled={refreshing}
            className="rounded-full p-2 text-gray-500 hover:bg-gray-200 disabled:opacity-50"
            aria-label="รีเฟรช"
          >
            <RefreshCw className={`h-5 w-5 ${refreshing ? "animate-spin" : ""}`} />
          </button>
          <button
            onClick={handleLogout}
            className="flex items-center gap-1 rounded-full px-3 py-2 text-sm text-gray-500 hover:bg-gray-200"
          >
            <LogOut className="h-4 w-4" />
            ออกจากระบบ
          </button>
        </div>
      </header>

      {notice && (
        <div className="mb-3 rounded-lg bg-emerald-100 px-4 py-2 text-sm font-medium text-emerald-800">{notice}</div>
      )}
      {error && <div className="mb-3 rounded-lg bg-red-100 px-4 py-2 text-sm font-medium text-red-700">{error}</div>}

      {trips.length === 0 ? (
        <p className="mt-16 text-center text-gray-500">ไม่มีรายการรอรับทราบในขณะนี้</p>
      ) : (
        <>
          <label className="mb-3 flex items-center gap-2 text-sm text-gray-600">
            <input
              type="checkbox"
              className="h-5 w-5 accent-emerald-700"
              checked={allSelected}
              onChange={toggleSelectAll}
            />
            เลือกทั้งหมด ({trips.length} รายการ)
          </label>

          <ul className="space-y-3">
            {trips.map((trip) => (
              <TripCard
                key={trip.bookingId}
                trip={trip}
                selected={selected.has(trip.bookingId)}
                onToggle={() => toggleSelected(trip.bookingId)}
                onApprove={() => submitDecision([trip.bookingId], "approved")}
                onReject={() => submitDecision([trip.bookingId], "rejected")}
                busy={busy}
              />
            ))}
          </ul>
        </>
      )}

      {selected.size > 0 && (
        <div className="fixed inset-x-0 bottom-0 border-t border-gray-200 bg-white px-4 py-3 shadow-[0_-2px_8px_rgba(0,0,0,0.06)]">
          <div className="mx-auto flex max-w-2xl items-center gap-3">
            <span className="flex-1 text-sm font-medium text-gray-700">เลือกไว้ {selected.size} รายการ</span>
            <button
              onClick={() => submitDecision(Array.from(selected), "rejected")}
              disabled={busy}
              className="flex items-center gap-1 rounded-lg border border-red-300 px-4 py-2 font-medium text-red-700 disabled:opacity-50"
            >
              <X className="h-4 w-4" />
              ไม่รับทราบ
            </button>
            <button
              onClick={() => submitDecision(Array.from(selected), "approved")}
              disabled={busy}
              className="flex items-center gap-1 rounded-lg bg-emerald-700 px-5 py-2 font-medium text-white disabled:opacity-50"
            >
              <Check className="h-4 w-4" />
              รับทราบที่เลือก
            </button>
          </div>
        </div>
      )}
    </main>
  );
}

function TripCard({
  trip,
  selected,
  onToggle,
  onApprove,
  onReject,
  busy,
}: {
  trip: DirectorTripItem;
  selected: boolean;
  onToggle: () => void;
  onApprove: () => void;
  onReject: () => void;
  busy: boolean;
}) {
  const timeRange = useMemo(() => formatBookingDateRange(trip.startTime, trip.endTime), [trip.startTime, trip.endTime]);
  return (
    <li className={`rounded-xl border bg-white p-4 shadow-sm ${selected ? "border-emerald-600 ring-1 ring-emerald-600" : "border-gray-200"}`}>
      <div className="flex gap-3">
        <input
          type="checkbox"
          className="mt-1 h-5 w-5 flex-shrink-0 accent-emerald-700"
          checked={selected}
          onChange={onToggle}
        />
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-gray-900">{trip.purpose || "(ไม่ระบุวัตถุประสงค์)"}</p>
          <p className="mt-0.5 text-sm text-gray-600">
            {trip.bookedByDisplayName}
            {trip.department ? ` · ${trip.department}` : ""}
          </p>

          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-gray-700">
            <span className="flex items-center gap-1">
              <Clock className="h-4 w-4 text-gray-400" />
              {timeRange}
            </span>
            {trip.destination && (
              <span className="flex items-center gap-1">
                <Car className="h-4 w-4 text-gray-400" />
                ไป {trip.destination}
              </span>
            )}
            {trip.participants > 0 && (
              <span className="flex items-center gap-1">
                <Users className="h-4 w-4 text-gray-400" />
                {trip.participants} คน
              </span>
            )}
          </div>

          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-gray-500">
            {trip.resourceName && <span>รถ: {trip.resourceName}</span>}
            {trip.driverName && (
              <span className="flex items-center gap-1">
                <User className="h-3.5 w-3.5" />
                คนขับ: {trip.driverName}
              </span>
            )}
          </div>

          <div className="mt-3 flex gap-2">
            <button
              onClick={onReject}
              disabled={busy}
              className="flex items-center gap-1 rounded-lg border border-red-300 px-3 py-1.5 text-sm font-medium text-red-700 disabled:opacity-50"
            >
              <X className="h-4 w-4" />
              ไม่รับทราบ
            </button>
            <button
              onClick={onApprove}
              disabled={busy}
              className="flex items-center gap-1 rounded-lg bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              <Check className="h-4 w-4" />
              รับทราบ
            </button>
          </div>
        </div>
      </div>
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
    <main className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
      <form onSubmit={onSubmit} className="w-full max-w-sm rounded-2xl border border-gray-200 bg-white p-8 shadow-sm">
        <h1 className="text-center text-lg font-bold text-gray-900">อนุมัติการเดินทาง</h1>
        <p className="mt-1 text-center text-sm text-gray-500">สำหรับผู้อำนวยการ</p>

        {notice && (
          <div className="mt-4 rounded-lg bg-emerald-100 px-3 py-2 text-sm text-emerald-800">{notice}</div>
        )}
        {error && <div className="mt-4 rounded-lg bg-red-100 px-3 py-2 text-sm text-red-700">{error}</div>}

        <label className="mt-5 block text-sm font-medium text-gray-700">
          รหัสผ่าน
          <input
            type="password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2.5 text-base focus:border-emerald-700 focus:outline-none"
          />
        </label>

        <button
          type="submit"
          disabled={busy || !password}
          className="mt-5 flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-700 py-2.5 font-medium text-white disabled:opacity-50"
        >
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          เข้าสู่ระบบ
        </button>

        <button
          type="button"
          onClick={onForgotPassword}
          className="mt-4 w-full text-center text-sm text-gray-500 underline"
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
    <main className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
      <form onSubmit={onSubmit} className="w-full max-w-sm rounded-2xl border border-gray-200 bg-white p-8 shadow-sm">
        <h1 className="text-center text-lg font-bold text-gray-900">เปลี่ยนรหัสผ่าน</h1>

        {error && <div className="mt-4 rounded-lg bg-red-100 px-3 py-2 text-sm text-red-700">{error}</div>}

        <label className="mt-5 block text-sm font-medium text-gray-700">
          รหัสผ่านปัจจุบัน
          <input
            type="password"
            autoFocus
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2.5 text-base focus:border-emerald-700 focus:outline-none"
          />
        </label>
        <label className="mt-3 block text-sm font-medium text-gray-700">
          รหัสผ่านใหม่
          <input
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2.5 text-base focus:border-emerald-700 focus:outline-none"
          />
        </label>
        <label className="mt-3 block text-sm font-medium text-gray-700">
          ยืนยันรหัสผ่านใหม่
          <input
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2.5 text-base focus:border-emerald-700 focus:outline-none"
          />
        </label>

        <button
          type="submit"
          disabled={busy || !currentPassword || !newPassword || !confirmPassword}
          className="mt-5 flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-700 py-2.5 font-medium text-white disabled:opacity-50"
        >
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          บันทึกรหัสผ่านใหม่
        </button>

        <button type="button" onClick={onBack} className="mt-4 w-full text-center text-sm text-gray-500 underline">
          กลับไปหน้าเข้าสู่ระบบ
        </button>
      </form>
    </main>
  );
}
