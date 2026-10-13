"use client";

import { useState, type ReactNode } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Car,
  ClipboardList,
  DoorOpen,
  Globe,
  LayoutGrid,
  LogOut,
  Menu,
  Package,
  Users,
  Wrench,
  X,
} from "lucide-react";
import NotificationBell from "@/components/NotificationBell";
import SessionWatcher from "@/components/SessionWatcher";

/**
 * Persistent left-sidebar app shell for every authenticated screen (/menu,
 * /manage, /manage/it, /manage/it/tasks, /manage/it/report, /manage/users,
 * /booking/car, /booking/room). Introduced to replace the old pattern of each page repeating
 * its own row of "เมนูหลัก / จองรถ/ห้องประชุม / ระบบงาน IT / ออกจากระบบ"
 * links inside its own <header> — same destinations, same role gating,
 * just declared once here instead of copy-pasted seven times (see the
 * removed per-page `logout()` + header nav <Link> clusters this replaces).
 * Each page keeps its own content (tables, modals, page-specific action
 * buttons) completely untouched; only the outer chrome moved.
 *
 * Deliberately NOT used by the public, unauthenticated dashboard at "/"
 * (see src/components/Dashboard.tsx) — that page has no session/role to
 * build a nav from, and showing internal-staff links to an anonymous
 * visitor would be wrong. It links here manually via a plain "เข้าสู่ระบบ"
 * link, same as before.
 *
 * Colors intentionally stay inside the existing green brand family
 * (--brand/--brand-2/--brand-strong, plus Tailwind's built-in emerald and
 * zinc scales) rather than adopting a new palette. The sidebar itself is a
 * light surface with a soft white→emerald-50 gradient wash (previously a
 * fixed dark emerald-950 "anchor" regardless of theme) — per an explicit
 * request for a brighter, airier feel across the whole system, sidebar
 * included, with subtle gradients rather than flat fills for a more modern
 * look. It still follows the app's existing prefers-color-scheme dark mode
 * (dark: variants) exactly like every card elsewhere, it just no longer
 * *always* renders dark the way it used to.
 */

export interface AppShellProps {
  /** Exactly what each page's own header subtitle already showed (e.g.
   * "superadmin (ทุกกลุ่มงาน)", "admin · กลุ่มงานเภสัชกรรม", "IT") — moved
   * here unchanged rather than re-derived, so wording never drifts from
   * what a returning user already recognizes. */
  roleLabel: string;
  username: string;
  displayName?: string;
  /** Show "ครุภัณฑ์คอมพิวเตอร์" (/manage) in the sidebar. */
  canAccessManage: boolean;
  /** Show "จัดการผู้ใช้" (/manage/users) in the sidebar — bootstrap only.
   * Rendered in its own "ผู้ดูแลระบบ" section, separate from "ทะเบียนครุภัณฑ์"
   * — user management isn't an equipment-registry function. */
  canManageUsers: boolean;
  /** Show "ระบบงาน IT" (/manage/it), with "งานบำรุงรักษา" (/manage/it/tasks)
   * nested underneath it as a sub-item — งานบำรุงรักษา (and its report at
   * /manage/it/report, reached from inside these two pages rather than its
   * own sidebar entry) is part of the IT system, not a separate one, so the
   * nav shows that hierarchy instead of listing them as equal siblings. */
  canAccessIt: boolean;
  /** Show the pending-car-booking-approval bell — only superadmin accounts
   * (see canApproveCarBooking in lib/booking.ts). Each caller computes this
   * from its own session/currentUser rather than AppShell re-deriving it,
   * same pattern as the other can* flags above. NotificationBell itself is
   * still mounted regardless of this flag — every account also gets a toast
   * when their own car booking is approved, which isn't gated by this prop
   * at all (see NotificationBell's own doc comment). */
  canApproveBookings: boolean;
  children: ReactNode;
}

function initialsOf(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 2).toUpperCase() : "??";
}

export default function AppShell({
  roleLabel,
  username,
  displayName,
  canAccessManage,
  canManageUsers,
  canAccessIt,
  canApproveBookings,
  children,
}: AppShellProps) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

  async function logout() {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      // Hard navigation, not router.push()/router.refresh() — same fix and
      // same reasoning as LoginForm's handleLoginSubmit: a full page
      // unload can never get stuck in a half-finished client-router
      // transition the way push+refresh occasionally could. Deliberately
      // ignoring the lint rule's router.push() suggestion — that's the
      // exact pattern being fixed here.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- intentional hard navigation, see comment above
      window.location.href = "/login";
    }
  }

  // จองรถ / จองห้องประชุม are genuinely separate menu items and pages now
  // (/booking/car, /booking/room), not one combined "ระบบจองรถ / ห้องประชุม"
  // entry with an internal switcher — per the hospital's explicit request.
  const generalItems = [
    { href: "/menu", label: "เมนูหลัก", icon: LayoutGrid, active: pathname === "/menu" },
    { href: "/booking/car", label: "จองรถ", icon: Car, active: pathname.startsWith("/booking/car") },
    { href: "/booking/room", label: "จองห้องประชุม", icon: DoorOpen, active: pathname.startsWith("/booking/room") },
  ];

  const registryItems = canAccessManage
    ? [{ href: "/manage", label: "ครุภัณฑ์คอมพิวเตอร์", icon: Package, active: pathname === "/manage" }]
    : [];

  // "จัดการผู้ใช้" is an administration function (superadmin/bootstrap
  // account management), not part of the equipment registry — kept as its
  // own section instead of living under "ทะเบียนครุภัณฑ์", per explicit
  // feedback that the two don't belong together.
  const adminItems = canManageUsers
    ? [{ href: "/manage/users", label: "จัดการผู้ใช้", icon: Users, active: pathname.startsWith("/manage/users") }]
    : [];

  // "งานบำรุงรักษา" (and the report it prints, /manage/it/report) is a
  // sub-feature of "ระบบงาน IT", not a system of its own — nested as a
  // child of the IT item below rather than listed as a same-level sibling.
  const itItems: NavItem[] = canAccessIt
    ? [
        {
          href: "/manage/it",
          label: "ระบบงาน IT",
          icon: Wrench,
          active: pathname === "/manage/it" || pathname.startsWith("/manage/it/report"),
          children: [
            {
              href: "/manage/it/tasks",
              label: "งานบำรุงรักษา",
              icon: ClipboardList,
              active: pathname.startsWith("/manage/it/tasks"),
            },
          ],
        },
      ]
    : [];

  const displayText = displayName || username;

  const sidebarBody = (
    <>
      <div className="flex h-16 shrink-0 items-center gap-3 border-b border-emerald-900/10 bg-white px-6 dark:border-emerald-400/10 dark:bg-zinc-900">
        {/* ตราสัญลักษณ์จริงของโรงพยาบาล (ไฟล์เดียวกับที่ใช้บนแดชบอร์ดสาธารณะ
            และหน้า login) แทนไอคอน Hospital ทั่วไปที่ใช้อยู่เดิม */}
        <Image
          src="/logo.png"
          alt="ตราสัญลักษณ์โรงพยาบาลท่าตะเกียบ"
          width={36}
          height={36}
          className="h-9 w-9 shrink-0 rounded-lg object-cover ring-1 ring-emerald-900/10 dark:ring-emerald-400/10"
        />
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold leading-tight text-zinc-900 dark:text-zinc-50">รพ.ท่าตะเกียบ</p>
          <p className="text-[11px] leading-tight text-emerald-700 dark:text-emerald-400">ระบบบริหารจัดการภายใน</p>
        </div>
      </div>

      <nav className="flex-1 space-y-6 overflow-y-auto px-3 py-4">
        <NavSection label="บริการทั่วไป" items={generalItems} />
        {registryItems.length > 0 && <NavSection label="ทะเบียนครุภัณฑ์" items={registryItems} />}
        {itItems.length > 0 && <NavSection label="งานศูนย์คอมพิวเตอร์ (IT)" items={itItems} />}
        {adminItems.length > 0 && <NavSection label="ผู้ดูแลระบบ" items={adminItems} />}
      </nav>

      <div className="shrink-0 border-t border-emerald-900/10 px-3 py-3 dark:border-emerald-400/10">
        <Link
          href="/"
          className="flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium text-zinc-500 transition-colors hover:bg-emerald-50 hover:text-emerald-700 dark:text-zinc-400 dark:hover:bg-emerald-950/40 dark:hover:text-emerald-300"
        >
          <Globe size={14} strokeWidth={2} aria-hidden="true" />
          แดชบอร์ดสาธารณะ
        </Link>
      </div>

      <div className="flex shrink-0 items-center justify-between gap-2 border-t border-emerald-900/10 bg-gradient-to-r from-emerald-50/70 to-white p-3 dark:border-emerald-400/10 dark:from-zinc-900 dark:to-zinc-900">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-[var(--brand)] to-[var(--brand-2)] text-xs font-bold text-white shadow-sm">
            {initialsOf(displayText)}
          </div>
          <div className="min-w-0 text-xs">
            <p className="truncate font-medium text-zinc-800 dark:text-zinc-100">{displayText}</p>
            <span className="mt-0.5 inline-block truncate rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
              {roleLabel}
            </span>
          </div>
        </div>
        <button
          type="button"
          onClick={logout}
          title="ออกจากระบบ"
          className="shrink-0 rounded-lg p-2 text-zinc-400 transition-colors hover:bg-rose-50 hover:text-rose-600 dark:text-zinc-500 dark:hover:bg-rose-950/30 dark:hover:text-rose-400"
        >
          <LogOut size={16} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>
    </>
  );

  return (
    <div className="app-shell-page-bg flex h-screen overflow-hidden">
      {/* Fixed-position, so it renders once here rather than being
          duplicated inside both the desktop sidebar and the mobile topbar
          markup below — see NotificationBell's own doc comment. */}
      <NotificationBell enabled={canApproveBookings} username={username} />
      {/* Renders nothing — polls in the background and force-navigates to
          /login the moment this session is no longer valid (see its own
          doc comment). Mounted once here for the same reason as
          NotificationBell above. */}
      <SessionWatcher />

      {/* Desktop sidebar — persistent, always visible at lg+. A light
          surface with a soft top-to-bottom white→emerald-50 wash rather
          than a flat fill, so it reads as bright and airy but still has a
          little depth/dimension to it. */}
      <aside className="app-shell-sidebar hidden w-64 shrink-0 flex-col border-r border-emerald-900/10 bg-gradient-to-b from-white via-white to-emerald-50/70 text-zinc-700 lg:flex dark:border-emerald-400/10 dark:from-zinc-900 dark:via-zinc-900 dark:to-zinc-900 dark:text-zinc-300">
        {sidebarBody}
      </aside>

      {/* Mobile sidebar — off-canvas drawer, toggled by the topbar's menu
          button below; a backdrop click or the drawer's own X closes it. */}
      {mobileOpen && (
        <div className="app-shell-sidebar fixed inset-0 z-40 flex lg:hidden">
          <div
            className="absolute inset-0 bg-black/50"
            onClick={() => setMobileOpen(false)}
            aria-hidden="true"
          />
          <aside className="relative flex w-64 max-w-[80vw] flex-col border-r border-emerald-900/10 bg-gradient-to-b from-white via-white to-emerald-50/70 text-zinc-700 shadow-xl dark:border-emerald-400/10 dark:from-zinc-900 dark:via-zinc-900 dark:to-zinc-900 dark:text-zinc-300">
            <button
              type="button"
              onClick={() => setMobileOpen(false)}
              aria-label="ปิดเมนู"
              className="absolute right-2 top-2 rounded-lg p-2 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:text-zinc-500 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
            >
              <X size={18} strokeWidth={2} aria-hidden="true" />
            </button>
            {sidebarBody}
          </aside>
        </div>
      )}

      <div className="app-shell-content flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* Slim mobile-only topbar — the desktop sidebar already carries
            the brand mark + nav, so this only needs to exist below the lg
            breakpoint to expose the drawer toggle. */}
        <div className="app-shell-topbar flex h-14 shrink-0 items-center gap-3 border-b border-zinc-200 bg-white px-4 dark:border-zinc-800 dark:bg-zinc-900 lg:hidden">
          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            aria-label="เปิดเมนู"
            className="rounded-lg p-2 text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            <Menu size={20} strokeWidth={2} aria-hidden="true" />
          </button>
          <span className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">รพ.ท่าตะเกียบ</span>
        </div>

        <div className="app-shell-scroll flex-1 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}

interface NavItem {
  href: string;
  label: string;
  icon: typeof LayoutGrid;
  active: boolean;
  /** Sub-pages nested under this item (e.g. งานบำรุงรักษา under ระบบงาน
   * IT) — rendered indented, under a connecting rule, instead of as a
   * same-level item, so the sidebar reflects that they're part of the
   * parent feature rather than a separate one. */
  children?: NavItem[];
}

function NavSection({ label, items }: { label: string; items: NavItem[] }) {
  return (
    <div>
      <p className="px-3 pb-2 text-[11px] font-medium uppercase tracking-wider text-zinc-400 dark:text-zinc-500">{label}</p>
      <ul className="space-y-1">
        {items.map((item) => (
          <li key={item.href}>
            <NavLink item={item} />
            {item.children && item.children.length > 0 && (
              <ul className="ml-[1.15rem] mt-1 space-y-1 border-l border-emerald-900/15 pl-3.5 dark:border-emerald-400/15">
                {item.children.map((child) => (
                  <li key={child.href}>
                    <NavLink item={child} sub />
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function NavLink({ item, sub = false }: { item: NavItem; sub?: boolean }) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      aria-current={item.active ? "page" : undefined}
      className={`flex items-center gap-3 rounded-lg font-medium transition-colors ${
        sub ? "px-3 py-1.5 text-[13px]" : "px-3 py-2 text-sm"
      } ${
        item.active
          ? "bg-gradient-to-r from-[var(--brand)] to-[var(--brand-2)] text-white shadow-sm"
          : "text-zinc-600 hover:bg-emerald-50 hover:text-emerald-800 dark:text-zinc-300 dark:hover:bg-emerald-950/40 dark:hover:text-emerald-200"
      }`}
    >
      <Icon size={sub ? 14 : 16} strokeWidth={2} aria-hidden="true" />
      <span className="truncate">{item.label}</span>
    </Link>
  );
}
