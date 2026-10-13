"use client";

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Eye,
  EyeOff,
  FileText,
  Loader2,
  Lock,
  MapPin,
  PenLine,
  Plus,
  Printer as PrinterIcon,
  RectangleHorizontal,
  RectangleVertical,
  Save,
  Settings,
  Sparkles,
  Trash2,
  Unlock,
  Wrench,
  X,
} from "lucide-react";
import type { InspectionCheck, MaintenanceTaskStatus, ReportSettings } from "@/lib/sheets";
import { TITLE_PREFIX_OPTIONS } from "@/lib/fields";
import {
  ACTION_OTHER_COLOR,
  actionColorVars,
  buildActionColorMap,
  colorForAction as colorForActionShared,
  resolveColorOrder,
  type ActionColor,
} from "@/lib/actionColors";
import MultiSelect from "@/components/MultiSelect";
import AppShell from "@/components/AppShell";
import { hasPermission, type PermissionKey } from "@/lib/permissions";
import type { Role } from "@/lib/auth";

/** One selectable equipment item — already flattened/redaction-free by
 * manage/it/report/page.tsx from the raw sheet row, so this component never
 * needs FieldMap/EquipmentRow at all. */
export interface ReportEquipmentItem {
  rowNumber: number;
  assetNumber: string;
  equipmentType: string;
  brandModel: string;
  department: string;
  installLocation: string;
  /** Combined "คำนำหน้า ชื่อ-นามสกุล" for display/search/print — always
   * derived from titlePrefix + nameOnly below, whichever sheet shape this
   * came from (see manage/it/report/page.tsx). */
  responsiblePerson: string;
  /** One of TITLE_PREFIX_OPTIONS (@/lib/fields), or "" if none was set or
   * none could be detected — drives the คำนำหน้า dropdown in the
   * "แก้ไข ... ก่อนพิมพ์" modal below. */
  titlePrefix: string;
  /** ชื่อ-นามสกุล without the คำนำหน้า. */
  nameOnly: string;
  /** For the optimistic-concurrency check on save-back — see
   * /api/manage/it/records/[rowNumber]. */
  snapshotHash: string;
  /** Whether editing titlePrefix/nameOnly here can save back to the sheet
   * (true whenever the sheet has either a combined name column or both
   * split columns) — false only for a sheet missing both shapes entirely,
   * in which case editing here only affects this one printout. */
  canSaveResponsiblePerson: boolean;
}

/** One maintenance task, trimmed to just what the equipment-picker badges
 * (and the ปี filter driving them) need — see manage/it/report/page.tsx's
 * taskHistory mapping from the full MaintenanceTask. actionsTaken/
 * inspectionChecks/partsChanged/otherDetail are only ever filled in once
 * someone opens "อัปเดตสถานะงาน" on /manage/it/tasks and saves — an
 * in-progress task nobody has touched yet just carries empty values here,
 * which the month-strip popup below renders as "ยังไม่ได้บันทึกรายละเอียด". */
export interface ReportTaskEntry {
  equipmentRowNumber: number;
  status: MaintenanceTaskStatus;
  createdAt: string;
  completedAt: string;
  displayName: string;
  actionsTaken: string[];
  inspectionChecks: InspectionCheck[];
  partsChanged: string;
  otherDetail: string;
}

/** Minimal data manage/it/tasks/page.tsx (via ?reprintTaskIds=id1,id2,...)
 * hands down per task to pre-fill this page for "พิมพ์ซ้ำ" — reprinting the
 * same paper form for maintenance round(s) that already happened, because
 * the original copy got lost, WITHOUT logging what would look like brand
 * new visits. One or more can come through at once — see
 * MaintenanceTasksBoard's central "พิมพ์ซ้ำ (N)" button, which bundles
 * every currently-filtered "กำลังดำเนินการ" task into one reprint instead
 * of reprinting one at a time. See the isReprint/reprintTasks derivations
 * below and handlePrint's early return. */
export interface ReprintTaskInfo {
  taskId: string;
  equipmentRowNumber: number;
  department: string;
  /** ISO timestamp the original task (and therefore, in practice, the
   * original printout) was created at — used to default "วันที่ดำเนินการ"
   * back to that same date rather than today's, since a reprint documents
   * a visit that already happened on that day, not a new one happening
   * now. Only used as the default when every task in this reprint batch
   * shares the same date — see the visitDate initializer below. */
  createdAt: string;
}

/** "ปกติ, เปลี่ยนอะไหล่ (จอ LCD), ส่งซ่อม" — folds the ผลการตรวจสอบโดย IT
 * checkboxes back into one readable line for the month-strip popup, same
 * checks as the printed form's "ผลการตรวจสอบโดย IT" box. Appends the
 * matching free-text blank in parens where one was filled in. */
function formatInspectionResult(t: ReportTaskEntry): string {
  return t.inspectionChecks
    .map((check) => {
      if (check === "เปลี่ยนอะไหล่" && t.partsChanged.trim()) return `${check} (${t.partsChanged.trim()})`;
      if (check === "อื่นๆ" && t.otherDetail.trim()) return `${check} (${t.otherDetail.trim()})`;
      return check;
    })
    .join(", ");
}

interface SelectedRow {
  rowNumber: number;
  assetNumber: string;
  description: string;
  /** ประเภทครุภัณฑ์ and ยี่ห้อ/รุ่น kept separate (description above stays
   * the single-line "type — brand/model" form for compact UI like the
   * adjust-modal row label) so the printed table can put them on two lines
   * at different sizes — see the "รายการครุภัณฑ์" column below. */
  equipmentType: string;
  brandModel: string;
  /** Shown above location in the printed "สถานที่ตั้ง" column so it reads
   * as "กลุ่มงาน — ที่ตั้ง" without needing its own table column. */
  department: string;
  location: string;
  responsiblePerson: string;
  titlePrefix: string;
  nameOnly: string;
  canSaveResponsiblePerson: boolean;
  snapshotHash: string;
  locationChanged: boolean;
  responsiblePersonChanged: boolean;
}

type SaveStatus = "idle" | "saving" | "saved" | "error";

const CARD =
  "rounded-2xl border border-emerald-900/10 bg-gradient-to-b from-white to-emerald-50 shadow-[0_1px_2px_rgba(4,120,87,0.04),0_4px_16px_-4px_rgba(4,120,87,0.14)] dark:border-emerald-400/10 dark:from-zinc-900 dark:to-zinc-900 dark:shadow-[0_1px_2px_rgba(0,0,0,0.3),0_4px_16px_-4px_rgba(0,0,0,0.45)]";
const INPUT_CLASS =
  "h-10 rounded-lg border border-zinc-200 bg-white px-3 text-sm text-zinc-900 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand)] dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100";

const THAI_MONTHS_SHORT = [
  "ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.",
  "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค.",
];

/** CSS custom properties for one action-color segment — applied via
 * className="bg-[var(--seg-c)] dark:bg-[var(--seg-c-dark)]" so the two
 * static Tailwind arbitrary-value classes stay the same for every segment
 * while the actual color comes from the inline variables per element. Thin
 * wrapper around the shared actionColorVars (lib/actionColors) that just
 * adds the CSSProperties cast for JSX's style prop. */
function actionColorStyle(color: ActionColor): CSSProperties {
  return actionColorVars(color) as CSSProperties;
}

/** Parses ReportSettings.printFontSizePt into a safe pt number for the
 * print-area's inline font-size style — falls back to the same "14" the
 * field defaults to (DEFAULT_REPORT_SETTINGS) whenever the stored value is
 * blank or a hand-edited, non-numeric sheet cell, so a bad value never
 * breaks the page. The API route validates this range on save too, but
 * this is the last line of defense for whatever's actually in the sheet. */
function printBodyFontSizePt(raw: string): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 8 && n <= 36 ? n : 14;
}

/** Parses ReportSettings.printTableFontSizePx into a safe px number for the
 * printed equipment table's base font size — same "reject a bad stored
 * value, don't break the page" role as printBodyFontSizePt above, and the
 * same 7–20 range the API route validates on save. Falls back to "11", the
 * field's own default. */
function printTableFontSizePx(raw: string): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 7 && n <= 20 ? n : 11;
}

/** Parses ReportSettings.printHeaderFontSizePt into a safe pt number for
 * the printed form's header block (หน่วยงาน/ชื่อแบบฟอร์ม/ปีงบประมาณ/
 * กลุ่มงาน) — same "reject a bad stored value, don't break the page" role
 * as printBodyFontSizePt above, and the same 8–36 range the API route
 * validates on save. Falls back to "16", the field's own default. */
function printHeaderFontSizePt(raw: string): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 8 && n <= 36 ? n : 16;
}

/** Parses ReportSettings.printLineHeight into a safe, unitless line-height
 * multiplier for the print-area's own inline line-height style — same
 * "reject a bad stored value, don't break the page" role as the size
 * helpers above, and the same 0.7–2.5 range the API route validates on
 * save. Falls back to "0.9", the field's own default. */
function printLineHeight(raw: string): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0.7 && n <= 2.5 ? n : 0.9;
}

/** Parses ReportSettings.printSignatureGapPx into a safe px number for the
 * blank space above the printed signature-block grid and the row gap
 * between a row of ผู้ตรวจสอบ blocks and the ผู้รับทราบ block below it —
 * same "reject a bad stored value, don't break the page" role as the
 * helpers above, and the same 0–48 range the API route validates on save.
 * Falls back to "16", the field's own default. */
function printSignatureGapPx(raw: string): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 48 ? n : 16;
}

/** Fixed print font stack — used to be user-configurable
 * (ReportSettings.printFontFamily), but the hospital never needed
 * anything besides this, so it's now just a constant instead of a
 * settings field + UI input to maintain. */
const PRINT_FONT_FAMILY = '"TH SarabunPSK", "TH Sarabun New", sans-serif';

/** Appended (with a leading space) after a การดำเนินการ label, on the
 * printed form only, when that entry is in
 * ReportSettings.detailRequiredActionOptions — a blank for the maintenance
 * technician to hand-write a detail into (e.g. which hardware part was
 * replaced), matching the existing hand-written blanks already used for the
 * separate ผลการตรวจสอบโดย IT checklist ("เปลี่ยนอะไหล่ ................",
 * see computeAutoTableColumnWidths's itCheckLabels). Same dot count/style as
 * those for visual consistency. */
const ACTION_DETAIL_SUFFIX = " ..........";

/** The exact text printed for one การดำเนินการ checklist item — the plain
 * name, or the name plus ACTION_DETAIL_SUFFIX when it's flagged in
 * detailRequiredActionOptions. Shared by the print table's own rendering and
 * computeAutoTableColumnWidths's width measurement, so what gets measured is
 * always exactly what gets printed. */
function actionLabelForPrint(name: string, detailRequiredActionOptions: string[]): string {
  return detailRequiredActionOptions.includes(name) ? `${name}${ACTION_DETAIL_SUFFIX}` : name;
}

/** The printed equipment table's column widths (% of table width, in
 * ลำดับ / หมายเลขครุภัณฑ์ / รายการครุภัณฑ์ / สถานที่ตั้ง /
 * ผู้รับผิดชอบครุภัณฑ์ / การดำเนินการ / ผลการตรวจสอบโดย IT order) before
 * "ปรับความกว้างคอลัมน์ให้พอดีอัตโนมัติ" (see computeAutoTableColumnWidths
 * and autoFitTableColumns below) is ever clicked, and what "คืนค่าเริ่มต้น"
 * resets back to. A fixed best-guess, same as this table always used
 * before the auto-fit button existed — it works reasonably for typical
 * data but, unlike auto-fit, doesn't adapt to what's actually selected.
 * Must sum to 100. */
const DEFAULT_TABLE_COLUMN_WIDTHS = [4, 13, 20, 14, 14, 14, 21];

/** One row's worth of the fields computeAutoTableColumnWidths actually
 * needs to measure — a narrow slice of SelectedRow so the function isn't
 * coupled to that whole type. */
interface AutoFitTableRow {
  assetNumber: string;
  equipmentType: string;
  brandModel: string;
  department: string;
  location: string;
  responsiblePerson: string;
}

/** Measures every printed table column's actual current content — column
 * headers, every selected row's cell text, and this round's
 * printActionOptions/the (static) ผลการตรวจสอบโดย IT checkbox labels —
 * through a scratch, never-attached &lt;canvas&gt; 2D context, so the
 * measurement goes through the exact same font resolution (including TH
 * SarabunPSK's own fallback behavior on a computer that doesn't have it
 * installed, see PRINT_FONT_FAMILY) that the browser will use to actually
 * render/print the table. Converts those pixel widths into proportional
 * percentages that sum to 100, so a column with short content this round
 * (e.g. หมายเลขครุภัณฑ์) shrinks and a column with long content (e.g.
 * สถานที่ตั้ง, which otherwise wraps to two lines and looks cramped)
 * grows — instead of every printout using the same fixed guess
 * (DEFAULT_TABLE_COLUMN_WIDTHS) no matter what's actually in it. Returns
 * null if canvas 2D isn't available (a locked-down browser) — the caller
 * keeps whatever widths were already in effect rather than fail loudly
 * over what's just a layout convenience. */
function computeAutoTableColumnWidths(
  rows: AutoFitTableRow[],
  actionLabels: string[],
  fontFamily: string,
  baseSizePx: number,
  secondarySizePx: number,
  tertiarySizePx: number
): number[] | null {
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return null;

  function widthOf(text: string, sizePx: number, weight: "400" | "500"): number {
    ctx!.font = `${weight} ${sizePx}px ${fontFamily}`;
    return ctx!.measureText(text).width;
  }

  // Cell padding (px-1 py-1) plus a little breathing room so measured
  // text never sits flush against its own cell border.
  const PAD = 14;

  const headers = [
    "ลำดับ",
    "หมายเลขครุภัณฑ์",
    "รายการครุภัณฑ์",
    "สถานที่ตั้ง",
    "ผู้รับผิดชอบครุภัณฑ์",
    "การดำเนินการ",
    "ผลการตรวจสอบโดย IT",
  ];
  const required = headers.map((h) => widthOf(h, baseSizePx, "500") + PAD);

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    required[0] = Math.max(required[0], widthOf(String(i + 1), baseSizePx, "400") + PAD);
    required[1] = Math.max(required[1], widthOf(r.assetNumber || "—", secondarySizePx, "400") + PAD);
    required[2] = Math.max(
      required[2],
      widthOf(r.equipmentType || "—", baseSizePx, "500") + PAD,
      widthOf(r.brandModel, tertiarySizePx, "400") + PAD
    );
    required[3] = Math.max(
      required[3],
      widthOf(r.department, tertiarySizePx, "400") + PAD,
      widthOf(r.location || "—", baseSizePx, "400") + PAD
    );
    required[4] = Math.max(required[4], widthOf(r.responsiblePerson || "—", baseSizePx, "400") + PAD);
  }

  const actionWidth = actionLabels.reduce(
    (max, label) => Math.max(max, widthOf(`☐ ${label}`, secondarySizePx, "400")),
    0
  );
  required[5] = Math.max(required[5], actionWidth + PAD);

  // Static labels (never affected by the sheet's own data) — still
  // measured rather than hard-coded so a locale/font change is reflected
  // too. Laid out as a 2-column grid (grid-cols-2 gap-x-1), so the column
  // needs roughly two of the widest single item side by side plus the
  // gap between them.
  const itCheckLabels = ["☐ ปกติ", "☐ เปลี่ยนอะไหล่ ................", "☐ ส่งซ่อม", "☐ อื่นๆ ระบุ ....................."];
  const itCheckMax = itCheckLabels.reduce(
    (max, label) => Math.max(max, widthOf(label, secondarySizePx, "400")),
    0
  );
  required[6] = Math.max(required[6], itCheckMax * 2 + 4 + PAD);

  const total = required.reduce((sum, w) => sum + w, 0);
  if (total <= 0) return null;

  const MIN_PCT = 4;
  const raw = required.map((w) => (w / total) * 100);
  // Every column gets its proportional share, except a floor of MIN_PCT%
  // for whichever ends up thinnest (realistically only ลำดับ, a 1–3 digit
  // index) — the shortfall to reach that floor is taken back out of every
  // other column in proportion to how much room it has above the floor,
  // so the whole row still sums to exactly 100.
  const deficit = raw.reduce((sum, p) => sum + Math.max(MIN_PCT - p, 0), 0);
  if (deficit === 0) return raw;
  const donors = raw.reduce((sum, p) => sum + Math.max(p - MIN_PCT, 0), 0);
  if (donors <= 0) return raw;
  return raw.map((p) => (p < MIN_PCT ? MIN_PCT : p - ((p - MIN_PCT) / donors) * deficit));
}

/** Full names, in the same index order as THAI_MONTHS_SHORT — used only for
 * the month-strip popup heading below (e.g. "สิงหาคม 2569"), where the
 * abbreviation would read a bit too terse for a heading. */
const THAI_MONTHS_FULL = [
  "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน",
  "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม",
];

/** "2026-08-14" -> "14 ส.ค. 2569" (Buddhist calendar, matching every other
 * Thai date on this site — see Dashboard.tsx's own date formatting). */
function formatThaiDate(iso: string): string {
  const parts = iso.split("-").map(Number);
  const [y, m, d] = parts;
  if (!y || !m || !d) return iso;
  return `${d} ${THAI_MONTHS_SHORT[m - 1] ?? ""} ${y + 543}`;
}

/** Drops blank entries (left behind mid-edit, e.g. a newly-added row the
 * person hasn't typed into yet) and guarantees at least one item survives,
 * so the printed table's "การดำเนินการ" column is never empty. Used both
 * before saving to the sheet and when rendering the print preview. */
function cleanActionOptions(list: string[]): string[] {
  const filtered = list.map((s) => s.trim()).filter(Boolean);
  return filtered.length > 0 ? filtered : ["บำรุงรักษา"];
}

const SETTINGS_FIELDS: { key: keyof ReportSettings; label: string }[] = [
  { key: "orgName", label: "ชื่อหน่วยงาน" },
  { key: "maintenanceFormTitle", label: "ชื่อแบบฟอร์ม" },
  { key: "fiscalYearLabel", label: "ปีงบประมาณ" },
  { key: "acknowledgerName", label: "ชื่อผู้รับทราบ" },
  { key: "acknowledgerPosition", label: "ตำแหน่งผู้รับทราบ" },
  { key: "acknowledgerDepartment", label: "สังกัดผู้รับทราบ" },
];

export default function MaintenanceReportBuilder({
  items: initialItems,
  loadError,
  settings: initialSettings,
  currentUser,
  taskHistory,
  reprintTasks,
}: {
  items: ReportEquipmentItem[];
  loadError: string | null;
  settings: ReportSettings;
  /** The logged-in IT account — auto-fills "ผู้ดำเนินการ" on the printed
   * form (see the print-area date/time line below) and attributes any
   * maintenance tasks created when this report is printed (see
   * createTasksForSelection / the print button's onClick). isBootstrap
   * drives canManageActionOptions below — only the single env-configured
   * bootstrap account may reorder/edit/delete an existing รายการ
   * "การดำเนินการ" entry; every other account (it, or a superadmin created
   * later through /manage/users) may only append new ones. */
  currentUser: {
    username: string;
    displayName: string;
    role: Role;
    isBootstrap: boolean;
    extraPermissions?: PermissionKey[];
    revokedPermissions?: PermissionKey[];
  };
  /** Every maintenance task ever created (any equipment, any year) — the
   * source for the "กำลังบำรุงรักษาโดย ..." / "เสร็จสิ้นล่าสุดโดย ..."
   * badges in the picker table below. Kept as the raw list (not
   * pre-reduced to one entry per row) so the ปี filter can re-derive those
   * badges for whichever year is selected, client-side — a future year
   * with no tasks yet just shows no badges, no code change needed. */
  taskHistory: ReportTaskEntry[];
  /** Non-empty only when this page was reached via the central "พิมพ์ซ้ำ"
   * button on /manage/it/tasks (?reprintTaskIds=id1,id2,...) — see
   * manage/it/report/page.tsx. Empty/undefined on every normal visit. */
  reprintTasks?: ReprintTaskInfo[];
}) {
  const router = useRouter();

  const [items, setItems] = useState(initialItems);
  // Multi-select — an empty array means "no filter on that dimension", same
  // convention as the department/equipment-type filters on /manage and
  // /manage/it (see MultiSelect).
  const [departmentFilter, setDepartmentFilter] = useState<string[]>([]);
  const [equipmentTypeFilter, setEquipmentTypeFilter] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  // Defaults to the current พ.ศ. year (computed fresh on every load, not a
  // stored value) rather than "ทุกปี" — per the hospital's request that the
  // maintenance status "reset" year to year: on 1 ม.ค. of a new year this
  // default alone makes every item look untouched (no tasks yet that year),
  // with zero carry-over from the year before and no code change needed.
  // "" still means ทุกปี (every task ever, newest wins) internally, but per
  // the hospital's request that option is no longer offered in the dropdown
  // below (only real พ.ศ. years) — this state can just never be "" in
  // practice now. Left in place rather than ripped out since it's harmless
  // and easy to bring back if "ดูประวัติทั้งหมด" is ever wanted again.
  const [maintenanceYearFilter, setMaintenanceYearFilter] = useState(() =>
    String(new Date().getFullYear() + 543)
  );
  // Companion to ปีที่บำรุงรักษา — narrows the "กำลังบำรุงรักษาโดย .../
  // เสร็จสิ้นล่าสุดโดย ..." badge and the "X ครั้ง" count (see the useMemo
  // below) down to one เดือน within that ปี, defaulting to the current
  // month. Per the hospital's request, this is what makes that status
  // "reset" every month instead of only every year: on day 1 of a new
  // month this default alone makes every item look untouched again for
  // that badge, with no code change and no data actually deleted — the
  // month-strip below still shows the full year's history regardless of
  // this filter (it only restricts monthlyTasks by ปี, never by this), so
  // nothing about past months is ever hidden, only what counts as "current".
  const [maintenanceMonthFilter, setMaintenanceMonthFilter] = useState(() =>
    String(new Date().getMonth() + 1)
  );
  // Unlike ปีที่บำรุงรักษา (which only reshapes the badges/counts above),
  // this one actually hides non-matching rows from the picker table below —
  // per the hospital's explicit request for a real filter, same behavior as
  // กลุ่มงาน/ประเภทครุภัณฑ์. Classified per row from the same
  // inProgress/lastCompleted lookups (already scoped to maintenanceYearFilter),
  // so picking a status is always relative to whichever ปีที่บำรุงรักษา is
  // selected — e.g. "ยังไม่เคยบำรุงรักษา" means "no task logged in that ปี".
  const [maintenanceStatusFilter, setMaintenanceStatusFilter] = useState<"" | "in_progress" | "done" | "none">("");
  // Pre-selects every equipment item a "พิมพ์ซ้ำ" batch came in with (one
  // or more — see ReprintTaskInfo/MaintenanceTasksBoard's central "พิมพ์ซ้ำ
  // (N)" button), plus a best-effort กลุ่มงาน/วันที่ default: only filled
  // in when EVERY task in the batch agrees on it, left blank (same as a
  // normal fresh printout) otherwise, since these are just editable header
  // text either way — no point guessing between conflicting values. Lazy
  // initializers rather than an effect (reprintTasks is a stable prop for
  // this page's whole lifetime, set once server-side from the URL), so this
  // never fights the eslint "no setState in an effect" rule.
  const [selectedRowNumbers, setSelectedRowNumbers] = useState<number[]>(() =>
    (reprintTasks ?? []).map((t) => t.equipmentRowNumber)
  );
  // Deliberately NOT prefilled from reprintTasks (unlike selectedRowNumbers
  // and visitDate above/below) — per the hospital's request, กลุ่มงาน is
  // left for the IT account preparing the printout to type in themselves
  // every time, reprint or not, rather than carried over from whichever
  // department the original task happened to be filed under.
  const [formDepartment, setFormDepartment] = useState("");
  const [visitDate, setVisitDate] = useState(() => {
    const dates = new Set((reprintTasks ?? []).map((t) => t.createdAt.slice(0, 10)));
    return dates.size === 1 ? [...dates][0] : "";
  });
  const [timeFrom, setTimeFrom] = useState("");
  const [timeTo, setTimeTo] = useState("");
  const [overrides, setOverrides] = useState<
    Record<number, { location: string; titlePrefix: string; nameOnly: string }>
  >({});
  const [rowSaveStatus, setRowSaveStatus] = useState<Record<number, SaveStatus>>({});
  const [rowSaveError, setRowSaveError] = useState<Record<number, string>>({});
  const [savingAll, setSavingAll] = useState(false);
  // Collapsed by default — this used to be a separate settings toggle on
  // /manage/it, moved here (and hidden behind a button, same UX pattern) so
  // there's a single place to edit the report template text, right next to
  // where it's actually used.
  const [showSettings, setShowSettings] = useState(false);
  // Also collapsed behind a button, same reasoning — the location/
  // responsible-person override editor used to sit inline on the page at
  // all times once anything was selected, which pushed the actual printable
  // form preview further and further down the page.
  const [showAdjustModal, setShowAdjustModal] = useState(false);
  // Chrome (and most other browsers) hide their own print-dialog "Layout"
  // (portrait/landscape) control once a page declares @page { size: ... } —
  // which this page always does, to keep the printed A4 size/margins
  // consistent regardless of a printer's own defaults. So orientation has
  // to be a control of our own instead, feeding the same @page rule below.
  const [orientation, setOrientation] = useState<"portrait" | "landscape">("landscape");
  // Printing is the moment a maintenance task is considered "started" (see
  // handlePrint below) — creatingTasks disables the print button for the
  // one round-trip that takes, and taskCreateError surfaces a failure
  // without ever blocking the actual print (the paper form is what matters
  // most; task tracking is secondary).
  const [creatingTasks, setCreatingTasks] = useState(false);
  const [taskCreateError, setTaskCreateError] = useState<string | null>(null);

  // Once IT clicks "พิมพ์ / บันทึกเป็น PDF" (handlePrint calls window.print()
  // below), the browser's own print dialog/preview takes over the screen —
  // "afterprint" is the one event every major browser fires the moment that
  // dialog closes again, whether the person actually printed or just
  // cancelled it. Either way, per the hospital's request, leaving that
  // dialog means the maintenance round has started, so this sends them
  // straight to "งานบำรุงรักษา" (the tasks board) instead of leaving them
  // back on this report-builder page.
  useEffect(() => {
    function handleAfterPrint() {
      router.push("/manage/it/tasks");
    }
    window.addEventListener("afterprint", handleAfterPrint);
    return () => window.removeEventListener("afterprint", handleAfterPrint);
  }, [router]);

  // True for the whole lifetime of this page load whenever it was reached
  // via "พิมพ์ซ้ำ" — see handlePrint below (skips creating a fresh
  // maintenance task entirely, since the round(s) already happened and are
  // already on record) and the no-print banner / printed-page note further
  // down. Deliberately not "only while selectedRowNumbers still matches
  // reprintTasks" — if IT adds or swaps items during this same reprint
  // session, this is still fundamentally a reprint errand, not a new
  // maintenance round, so it keeps skipping task-creation for the whole
  // session rather than switching behavior mid-way.
  const isReprint = (reprintTasks?.length ?? 0) > 0;

  // Form header / signature text — editable right here (pre-filled from the
  // saved ReportSettings) so a one-off change (a substitute signee, say)
  // doesn't require a trip to the settings panel on /manage/it. "บันทึกเป็น
  // ค่าเริ่มต้น" below writes it back to ReportSettings for next time;
  // without pressing that, an edit here only affects this one printout.
  const [formSettings, setFormSettings] = useState<ReportSettings>(initialSettings);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsSaved, setSettingsSaved] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  // Only the single env-configured bootstrap account may touch รายการ
  // "การดำเนินการ" at all — add a new entry, or reorder/rename/delete an
  // already-saved one (or, by extension, the color that entry's list
  // position implies) — see canAccessItDashboard's isBootstrap comment in
  // lib/auth.ts for why this is a narrower check than "any superadmin".
  // Everyone else who can reach this page (it, or a superadmin created
  // later through /manage/users) sees the master list as plain read-only
  // text with no "+ เพิ่มรายการ" button at all — per the hospital's
  // request, this isn't a per-account catalog anyone can grow, only the
  // bootstrap account's to manage. Enforced again server-side in
  // /api/manage/it/settings — this is a UI convenience, not the actual
  // security boundary.
  const canManageActionOptions = hasPermission(currentUser, "manageReportActionList");
  // ล็อก/ปลดล็อก one รายการ "การดำเนินการ" entry (forcing it into every
  // printing round's selection — see toggleLockedActionOption below) is a
  // separate, broader permission than canManageActionOptions above: open to
  // any superadmin account, bootstrap or not, per the hospital's explicit
  // request — NOT restricted to bootstrap the way add/rename/reorder/delete
  // still is. Backed by hasPermission()'s "lockReportActionOptions" key
  // (lib/permissions.ts), on by default for every superadmin and never
  // grantable to admin/user (see that key's own comment there). Enforced
  // again server-side in /api/manage/it/settings — this is a UI convenience,
  // not the actual security boundary.
  const canLockActionOptions = hasPermission(currentUser, "lockReportActionOptions");
  // How many รายการ "การดำเนินการ" entries are already saved (and therefore
  // locked for non-bootstrap accounts) — starts at however many the page
  // loaded with, and grows whenever a save succeeds (see
  // saveSettingsAsDefault), so a non-bootstrap account's own just-appended
  // entries lock immediately after they save, same as anyone else's.
  const [lockedActionOptionsCount, setLockedActionOptionsCount] = useState(
    initialSettings.actionOptions.length
  );
  // Which รายการ "การดำเนินการ" entries are turned OFF for THIS printing
  // round only — separate from the master list above (formSettings.
  // actionOptions), per the hospital's request to grow the master catalog
  // over time without every past entry having to appear on every single
  // printout. Tracked as an exclude-list (not an include-list) purely so
  // toggling one entry off never touches the master list or its colors —
  // but the starting value now excludes every visible master entry, so
  // the "เลือกรายการที่จะดำเนินการ" card below loads with nothing selected
  // and IT has to deliberately pick what applies each round, rather than
  // risk an unwanted item slipping onto the print because it defaulted to
  // "on". Not persisted anywhere (resets to "everything off" on reload).
  // See the "เลือกรายการที่จะดำเนินการ" card below and printActionOptions
  // further down. A locked entry (formSettings.lockedActionOptions — see
  // that field's own comment in lib/sheets.ts) never starts here even
  // though everything else does: it's forced ON for every round, not just
  // this one, so it's excluded from "everything off" by design — see
  // toggleActiveAction right below, which also refuses to add one here.
  const [excludedActionOptions, setExcludedActionOptions] = useState<string[]>(() =>
    cleanActionOptions(formSettings.actionOptions).filter(
      (name) => !formSettings.hiddenActionOptions.includes(name) && !formSettings.lockedActionOptions.includes(name)
    )
  );

  function toggleActiveAction(name: string) {
    // A locked entry can't be turned off for this round — the whole point
    // of ล็อก is that IT can't skip it. See canLockActionOptions above for
    // who can lock/unlock an entry in the first place.
    if (formSettings.lockedActionOptions.includes(name)) return;
    setExcludedActionOptions((prev) =>
      prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]
    );
  }

  const departmentOptions = useMemo(() => {
    const set = new Set<string>();
    for (const it of items) if (it.department) set.add(it.department);
    return [...set].sort((a, b) => a.localeCompare(b, "th")).map((value) => ({ value }));
  }, [items]);

  const equipmentTypeOptions = useMemo(() => {
    const set = new Set<string>();
    for (const it of items) if (it.equipmentType) set.add(it.equipmentType);
    return [...set].sort((a, b) => a.localeCompare(b, "th")).map((value) => ({ value }));
  }, [items]);

  // Every พ.ศ. year any task was created in, newest first, plus the current
  // year always available even before anything's been logged for it yet —
  // same "offer only years with real (or current) data" approach as the
  // ปี filter on /manage/it/tasks.
  const maintenanceYearOptions = useMemo(() => {
    const set = new Set<string>([String(new Date().getFullYear() + 543)]);
    for (const t of taskHistory) {
      const y = new Date(t.createdAt).getFullYear();
      if (!Number.isNaN(y)) set.add(String(y + 543));
    }
    return [...set].sort((a, b) => Number(b) - Number(a));
  }, [taskHistory]);

  // Assigns each distinct "การดำเนินการ" text a fixed color — by its
  // position in ReportSettings.actionColorOrder (NOT actionOptions' own,
  // freely-reorderable display order), so the color a person sees in the
  // settings list matches the color used everywhere else (month-strip,
  // legend, popup) even before that action has ever been recorded on a real
  // task, AND stays put when someone uses the up/down-arrow buttons to
  // reorder the list — only adding, removing, or renaming an entry (via the
  // bootstrap-only canManageActionOptions controls below) actually changes
  // a color. formSettings.actionColorOrder itself never gets mutated by any
  // local edit here (see moveActionOption/addActionOption/
  // removeActionOption/updateActionOption below — none of them touch it),
  // so it stays a stable baseline for this whole editing session until the
  // next successful save echoes back whatever the server recomputed — see
  // resolveColorOrder (lib/actionColors) for the actual merge logic and
  // buildActionColorMap for the index -> color assignment and its 8-color
  // cap.
  const actionColorMap = useMemo(
    () => buildActionColorMap(resolveColorOrder(formSettings.actionOptions, formSettings.actionColorOrder)),
    [formSettings.actionOptions, formSettings.actionColorOrder]
  );

  const colorForAction = (name: string): ActionColor => colorForActionShared(actionColorMap, name);

  // Re-derives the "กำลังบำรุงรักษาโดย ..." / "เสร็จสิ้นล่าสุดโดย ..." badge
  // lookups, plus a plain per-equipment visit count (visitCounts — every
  // task counts once regardless of status, since printing the report is
  // itself the visit; see the badge below), restricted to the selected ปี
  // (created year) AND เดือน — per the hospital's request this is what
  // "resets" the badge every month, not just every year. Both are still
  // keyed off createdAt (เดือนที่เปิดเคส) — unrelated to the roll-forward
  // rule below, unchanged from before.
  //
  // monthlyTasks is the same data grouped one step further, by เดือน (0 =
  // ม.ค. ... 11 = ธ.ค.), and drives the 12-month strip in the picker table
  // below (and its click popup) — but per the hospital's request, an
  // เดือนที่เปิดเคส (createdAt) is no longer what buckets a task there. A
  // "done" task anchors permanently to the เดือน it was actually finished
  // in (completedAt) — that never changes again once set. A still-open
  // ("in_progress") task instead rolls forward to the current real-world
  // เดือน every time this renders: opened in ส.ค., still open when ก.ย.
  // arrives — the amber tick "moves" to ก.ย., because ส.ค. is now
  // considered a month it was NOT finished in, and it keeps moving forward
  // like that for as long as it stays open. This bucket is restricted by
  // effective ปี only (never by เดือน), same "never hide a past month's
  // detail" rule as before — only what counts as "current status" changes.
  const { inProgress, lastCompleted, visitCounts, monthlyTasks } = useMemo(() => {
    const inProgress: Record<number, { displayName: string; createdAt: string }> = {};
    const lastCompleted: Record<number, { displayName: string; completedAt: string }> = {};
    const visitCounts: Record<number, number> = {};
    const monthlyTasks: Record<number, ReportTaskEntry[][]> = {};
    const nowIso = new Date().toISOString();
    for (const t of taskHistory) {
      // Strip bucket — effective เดือน/ปี, per the roll-forward rule above.
      const effectiveIso = t.status === "done" ? t.completedAt || t.createdAt : nowIso;
      const effectiveDate = new Date(effectiveIso);
      const effectiveYear = effectiveDate.getFullYear() + 543;
      const effectiveMonthIdx = effectiveDate.getMonth();
      if (
        (!maintenanceYearFilter || String(effectiveYear) === maintenanceYearFilter) &&
        !Number.isNaN(effectiveMonthIdx)
      ) {
        if (!monthlyTasks[t.equipmentRowNumber]) {
          monthlyTasks[t.equipmentRowNumber] = Array.from({ length: 12 }, () => []);
        }
        monthlyTasks[t.equipmentRowNumber][effectiveMonthIdx].push(t);
      }

      // Badge + visit count — still keyed off เดือนที่เปิดเคส (createdAt).
      if (maintenanceYearFilter) {
        const y = new Date(t.createdAt).getFullYear() + 543;
        if (String(y) !== maintenanceYearFilter) continue;
      }
      const monthIdx = new Date(t.createdAt).getMonth();
      if (maintenanceMonthFilter && String(monthIdx + 1) !== maintenanceMonthFilter) continue;
      visitCounts[t.equipmentRowNumber] = (visitCounts[t.equipmentRowNumber] ?? 0) + 1;
      if (t.status === "in_progress") {
        const existing = inProgress[t.equipmentRowNumber];
        if (!existing || t.createdAt > existing.createdAt) {
          inProgress[t.equipmentRowNumber] = { displayName: t.displayName, createdAt: t.createdAt };
        }
      } else {
        const existing = lastCompleted[t.equipmentRowNumber];
        if (!existing || t.completedAt > existing.completedAt) {
          lastCompleted[t.equipmentRowNumber] = { displayName: t.displayName, completedAt: t.completedAt };
        }
      }
    }
    return { inProgress, lastCompleted, visitCounts, monthlyTasks };
  }, [taskHistory, maintenanceYearFilter, maintenanceMonthFilter]);

  // Locks the checkbox for any equipment someone else already has "กำลัง
  // บำรุงรักษาโดย ..." open — per the hospital's request, one IT starting a
  // maintenance round on a piece of equipment should block every other IT
  // from picking that same equipment again until the first one marks it
  // เสร็จสิ้น. Deliberately NOT the `inProgress` map above (that one is
  // scoped to whichever ปี/เดือนที่บำรุงรักษา filter happens to be selected,
  // so it can go blank for an open task created in an earlier เดือน/ปี —
  // see its own comment) — the lock has to hold regardless of what this
  // page's filters are currently set to, so it always scans the full,
  // unfiltered taskHistory instead. The server (POST /api/manage/it/tasks)
  // enforces the real "one open task per equipment" rule independently —
  // this is only what makes the picker table itself refuse the duplicate
  // selection up front, with a reason IT can see.
  const inProgressByEquipment = useMemo(() => {
    const map: Record<number, { displayName: string }> = {};
    for (const t of taskHistory) {
      if (t.status === "in_progress") map[t.equipmentRowNumber] = { displayName: t.displayName };
    }
    return map;
  }, [taskHistory]);

  // Which month-strip tick's task list is open, shown as a small centered
  // modal (see the JSX below) — click-only, no hover tracking. An earlier
  // version tried a hover-following tooltip positioned with
  // getBoundingClientRect()/position:fixed, but that's exactly what crashed
  // the page: the tooltip could render close enough to the cursor to steal
  // the mouseleave/mouseenter pair from the tick underneath it, causing an
  // open→close→open loop that pegged the tab. A plain click-to-open modal
  // (same pattern as showSettings/showAdjustModal above) has no hover state
  // to fight over, so that failure mode can't happen here.
  const [monthPopup, setMonthPopup] = useState<{ rowNumber: number; month: number } | null>(null);

  const filteredItems = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((it) => {
      if (departmentFilter.length > 0 && !departmentFilter.includes(it.department)) return false;
      if (equipmentTypeFilter.length > 0 && !equipmentTypeFilter.includes(it.equipmentType)) return false;
      if (maintenanceStatusFilter) {
        const status = inProgress[it.rowNumber] ? "in_progress" : lastCompleted[it.rowNumber] ? "done" : "none";
        if (status !== maintenanceStatusFilter) return false;
      }
      if (q) {
        const hay = `${it.assetNumber} ${it.brandModel} ${it.equipmentType} ${it.installLocation} ${it.responsiblePerson}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [items, departmentFilter, equipmentTypeFilter, maintenanceStatusFilter, inProgress, lastCompleted, search]);

  function toggleItem(rowNumber: number) {
    // A locked (already in_progress elsewhere) row can still appear here if
    // it was selected before the lock kicked in — always allow *un*checking,
    // just never re-checking a currently-locked row.
    if (inProgressByEquipment[rowNumber] && !selectedRowNumbers.includes(rowNumber)) return;
    setSelectedRowNumbers((prev) =>
      prev.includes(rowNumber) ? prev.filter((n) => n !== rowNumber) : [...prev, rowNumber]
    );
  }

  function selectAllFiltered() {
    setSelectedRowNumbers((prev) => {
      const next = new Set(prev);
      for (const it of filteredItems) {
        if (inProgressByEquipment[it.rowNumber]) continue; // locked — someone else already has this open
        next.add(it.rowNumber);
      }
      return [...next];
    });
  }

  function clearSelection() {
    setSelectedRowNumbers([]);
  }

  function updateOverride(rowNumber: number, field: "location" | "titlePrefix" | "nameOnly", value: string) {
    const source = items.find((it) => it.rowNumber === rowNumber);
    setOverrides((prev) => ({
      ...prev,
      [rowNumber]: {
        location: prev[rowNumber]?.location ?? source?.installLocation ?? "",
        titlePrefix: prev[rowNumber]?.titlePrefix ?? source?.titlePrefix ?? "",
        nameOnly: prev[rowNumber]?.nameOnly ?? source?.nameOnly ?? "",
        [field]: value,
      },
    }));
    // A fresh edit invalidates whatever save result was showing for this row.
    setRowSaveStatus((prev) => ({ ...prev, [rowNumber]: "idle" }));
  }

  // Preserve pick order (the order the person checked items in) rather than
  // the table's own order — that's usually the order they'll want on the
  // printed form too.
  const selectedRows: SelectedRow[] = useMemo(() => {
    return selectedRowNumbers
      .map((n) => items.find((it) => it.rowNumber === n))
      .filter((it): it is ReportEquipmentItem => Boolean(it))
      .map((it) => {
        const o = overrides[it.rowNumber];
        const location = o?.location ?? it.installLocation;
        const titlePrefix = o?.titlePrefix ?? it.titlePrefix;
        const nameOnly = o?.nameOnly ?? it.nameOnly;
        const responsiblePerson = [titlePrefix, nameOnly].filter(Boolean).join("");
        return {
          rowNumber: it.rowNumber,
          assetNumber: it.assetNumber,
          description: [it.equipmentType, it.brandModel].filter(Boolean).join(" — "),
          equipmentType: it.equipmentType,
          brandModel: it.brandModel,
          department: it.department,
          location,
          responsiblePerson,
          titlePrefix,
          nameOnly,
          canSaveResponsiblePerson: it.canSaveResponsiblePerson,
          snapshotHash: it.snapshotHash,
          locationChanged: location !== it.installLocation,
          responsiblePersonChanged: titlePrefix !== it.titlePrefix || nameOnly !== it.nameOnly,
        };
      });
  }, [selectedRowNumbers, items, overrides]);

  // Distinct กลุ่มงาน among the selected equipment, in first-picked order —
  // drives one "ผู้ตรวจสอบ" signature block per department below the table
  // (see the print area), so a single printout can cover several
  // departments' PM work in one day instead of one department per sheet.
  // Falls back to the old generic label when none of the selected rows
  // carry a department (e.g. that column is blank in the sheet).
  const selectedDepartments = useMemo(() => {
    const seen = new Set<string>();
    const list: string[] = [];
    for (const row of selectedRows) {
      const dep = row.department.trim();
      if (dep && !seen.has(dep)) {
        seen.add(dep);
        list.push(dep);
      }
    }
    return list.length > 0 ? list : ["กลุ่มงานผู้รับบริการ"];
  }, [selectedRows]);

  // A responsible-person edit only counts as "savable" when the sheet uses
  // one combined name column (see canSaveResponsiblePerson) — otherwise
  // there is nothing this row could send the API that it would accept, so
  // treating it as dirty would just produce a confusing 400 on save.
  function hasSavableChange(row: SelectedRow): boolean {
    return row.locationChanged || (row.responsiblePersonChanged && row.canSaveResponsiblePerson);
  }

  const dirtyRowCount = selectedRows.filter(hasSavableChange).length;

  async function saveRow(row: SelectedRow) {
    if (!hasSavableChange(row)) return true;
    setRowSaveStatus((prev) => ({ ...prev, [row.rowNumber]: "saving" }));
    setRowSaveError((prev) => ({ ...prev, [row.rowNumber]: "" }));
    try {
      const body: Record<string, string> = { expectedSnapshotHash: row.snapshotHash };
      if (row.locationChanged) body.installLocation = row.location;
      if (row.responsiblePersonChanged && row.canSaveResponsiblePerson) {
        // Sent as a pair — see /api/manage/it/records/[rowNumber], which
        // needs both halves together regardless of which sheet shape (one
        // combined column, or split คำนำหน้า/ชื่อ-นามสกุล) it ends up in.
        body.responsibleTitlePrefix = row.titlePrefix;
        body.responsibleName = row.nameOnly;
      }
      const res = await fetch(`/api/manage/it/records/${row.rowNumber}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) {
        setRowSaveStatus((prev) => ({ ...prev, [row.rowNumber]: "error" }));
        setRowSaveError((prev) => ({ ...prev, [row.rowNumber]: json.error ?? "บันทึกไม่สำเร็จ" }));
        return false;
      }
      // Fold the saved values back into the base item so the row reads as
      // "up to date" (no longer "changed") and the next save's optimistic-
      // concurrency check uses the fresh snapshotHash instead of a stale one.
      setItems((prev) =>
        prev.map((it) =>
          it.rowNumber === row.rowNumber
            ? {
                ...it,
                installLocation: row.locationChanged ? row.location : it.installLocation,
                responsiblePerson:
                  row.responsiblePersonChanged && row.canSaveResponsiblePerson
                    ? row.responsiblePerson
                    : it.responsiblePerson,
                titlePrefix:
                  row.responsiblePersonChanged && row.canSaveResponsiblePerson ? row.titlePrefix : it.titlePrefix,
                nameOnly: row.responsiblePersonChanged && row.canSaveResponsiblePerson ? row.nameOnly : it.nameOnly,
                snapshotHash: json.snapshotHash ?? it.snapshotHash,
              }
            : it
        )
      );
      setRowSaveStatus((prev) => ({ ...prev, [row.rowNumber]: "saved" }));
      return true;
    } catch {
      setRowSaveStatus((prev) => ({ ...prev, [row.rowNumber]: "error" }));
      setRowSaveError((prev) => ({ ...prev, [row.rowNumber]: "บันทึกไม่สำเร็จ กรุณาลองใหม่" }));
      return false;
    }
  }

  async function saveAllChanged() {
    setSavingAll(true);
    try {
      for (const row of selectedRows) {
        if (hasSavableChange(row)) {
          await saveRow(row);
        }
      }
    } finally {
      setSavingAll(false);
    }
  }

  // CRUD for the "การดำเนินการ" checklist — see the SETTINGS_FIELDS-adjacent
  // section in the settings modal below. Blank rows are allowed while
  // editing (so a freshly-added row isn't yanked away before anyone can
  // type into it); cleanActionOptions strips them out at save/print time.
  // An index below lockedActionOptionsCount is an already-saved entry — off
  // limits to update/remove for anyone but the bootstrap account (see
  // canManageActionOptions); the UI never renders an input/delete button for
  // one anyway, but these guards keep it true even if that ever drifts.
  function updateActionOption(index: number, value: string) {
    if (!canManageActionOptions && index < lockedActionOptionsCount) return;
    setFormSettings((prev) => ({
      ...prev,
      actionOptions: prev.actionOptions.map((v, i) => (i === index ? value : v)),
    }));
    setSettingsSaved(false);
  }

  function addActionOption() {
    if (!canManageActionOptions) return;
    setFormSettings((prev) => ({ ...prev, actionOptions: [...prev.actionOptions, ""] }));
    setSettingsSaved(false);
  }

  function removeActionOption(index: number) {
    if (!canManageActionOptions && index < lockedActionOptionsCount) return;
    setFormSettings((prev) => {
      if (prev.actionOptions.length <= 1) return prev;
      const removed = prev.actionOptions[index];
      return {
        ...prev,
        actionOptions: prev.actionOptions.filter((_, i) => i !== index),
        // A removed entry has nothing left to hide, or lock, — drop it from
        // hiddenActionOptions/lockedActionOptions too so neither list ever
        // accumulates names that no longer exist.
        hiddenActionOptions: prev.hiddenActionOptions.filter((n) => n !== removed),
        lockedActionOptions: prev.lockedActionOptions.filter((n) => n !== removed),
      };
    });
    setSettingsSaved(false);
  }

  /** Bootstrap-only reorder for one รายการ "การดำเนินการ" entry — swaps it
   * with its immediate neighbor (direction -1 = move up, +1 = move down),
   * changing only actionOptions' own display/print order. Deliberately
   * restricted the same way add/remove already are (see
   * canManageActionOptions above) — this is still the list that determines
   * dropdown/print order for everyone — but unlike add/remove/rename, a
   * plain reorder never touches actionColorOrder (see the actionColorMap
   * comment above), so moving an entry up or down never changes anyone's
   * color, here or anywhere else it's shown. */
  function moveActionOption(index: number, direction: -1 | 1) {
    if (!canManageActionOptions) return;
    setFormSettings((prev) => {
      const target = index + direction;
      if (target < 0 || target >= prev.actionOptions.length) return prev;
      const next = [...prev.actionOptions];
      [next[index], next[target]] = [next[target], next[index]];
      return { ...prev, actionOptions: next };
    });
    setSettingsSaved(false);
  }

  /** Bootstrap-only "ซ่อน/แสดง" (hide/show) toggle for one รายการ
   * "การดำเนินการ" entry. Unlike removeActionOption, this never touches
   * actionOptions itself — the entry stays at its exact array index (so
   * its color from buildActionColorMap never shifts) — it only adds/
   * removes the entry's exact text from hiddenActionOptions. A hidden
   * entry disappears from every place IT actually *picks* an action (the
   * "เลือกรายการที่จะดำเนินการ" chips below, the printed form's
   * printActionOptions, and /manage/it/tasks's "อัปเดตสถานะงาน" checklist)
   * but stays visible — dimmed — in this settings list so it can be
   * unhidden and used again later, per the hospital's request not to lose
   * it outright. */
  function toggleHiddenActionOption(name: string) {
    if (!canManageActionOptions) return;
    setFormSettings((prev) => ({
      ...prev,
      hiddenActionOptions: prev.hiddenActionOptions.includes(name)
        ? prev.hiddenActionOptions.filter((n) => n !== name)
        : [...prev.hiddenActionOptions, name],
    }));
    setSettingsSaved(false);
  }

  /** Superadmin-only (any superadmin, not just bootstrap — see
   * canLockActionOptions above) ล็อก/ปลดล็อก toggle for one รายการ
   * "การดำเนินการ" entry. Deliberately NOT gated behind canManageActionOptions
   * the way toggleHiddenActionOption/toggleDetailRequiredActionOption/
   * moveActionOption are — a non-bootstrap superadmin can lock or unlock an
   * entry even though it still can't rename/reorder/hide/delete one. Like
   * toggleHiddenActionOption, this never touches actionOptions itself — the
   * entry stays at its exact array index (so its color from
   * buildActionColorMap never shifts) — it only adds/removes the entry's
   * exact text from lockedActionOptions. A locked entry can no longer be
   * excluded from any single printing round (see toggleActiveAction/
   * excludedActionOptions above) — it's forced into every round's selection
   * until unlocked again. */
  function toggleLockedActionOption(name: string) {
    if (!canLockActionOptions) return;
    setFormSettings((prev) => ({
      ...prev,
      lockedActionOptions: prev.lockedActionOptions.includes(name)
        ? prev.lockedActionOptions.filter((n) => n !== name)
        : [...prev.lockedActionOptions, name],
    }));
    setSettingsSaved(false);
  }

  /** Bootstrap-only toggle for whether one รายการ "การดำเนินการ" entry needs
   * IT to write in a free-text detail when marking it taken — e.g. "อัปเกรด/
   * เปลี่ยนอะไหล่ฮาร์ดแวร์" needs to say *which* part. Same
   * membership-by-name convention as toggleHiddenActionOption above, for the
   * same reason (stays attached to the right entry through a reorder,
   * doesn't disturb buildActionColorMap's index-based colors). Flagging an
   * entry adds a dotted blank after its label on the printed form (see
   * ACTION_DETAIL_SUFFIX/actionLabelForPrint) and — once IT actually ticks
   * that action while it's selected on a task — a matching free-text box in
   * /manage/it/tasks's "อัปเดตสถานะงาน" (see MaintenanceTasksBoard). */
  function toggleDetailRequiredActionOption(name: string) {
    if (!canManageActionOptions) return;
    setFormSettings((prev) => ({
      ...prev,
      detailRequiredActionOptions: prev.detailRequiredActionOptions.includes(name)
        ? prev.detailRequiredActionOptions.filter((n) => n !== name)
        : [...prev.detailRequiredActionOptions, name],
    }));
    setSettingsSaved(false);
  }

  async function saveSettingsAsDefault() {
    setSettingsSaving(true);
    setSettingsError(null);
    setSettingsSaved(false);
    try {
      const cleanedActionOptions = cleanActionOptions(formSettings.actionOptions);
      const payload: ReportSettings = {
        ...formSettings,
        actionOptions: cleanedActionOptions,
        // Drop any hidden-name/detail-required-name/locked-name that no
        // longer matches a real entry (e.g. it got removed, or a blank row
        // it referenced was cleaned away) so none of these lists ever grow
        // stale.
        hiddenActionOptions: formSettings.hiddenActionOptions.filter((n) => cleanedActionOptions.includes(n)),
        detailRequiredActionOptions: formSettings.detailRequiredActionOptions.filter((n) =>
          cleanedActionOptions.includes(n)
        ),
        lockedActionOptions: formSettings.lockedActionOptions.filter((n) => cleanedActionOptions.includes(n)),
      };
      const res = await fetch("/api/manage/it/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok) {
        setSettingsError(json.error ?? "บันทึกไม่สำเร็จ");
        return;
      }
      setFormSettings(json.settings);
      // Whatever just got saved is now permanent for non-bootstrap accounts
      // (their own just-appended entries included) — see
      // lockedActionOptionsCount's declaration.
      setLockedActionOptionsCount((json.settings as ReportSettings).actionOptions.length);
      setSettingsSaved(true);
    } catch {
      setSettingsError("บันทึกไม่สำเร็จ กรุณาลองใหม่");
    } finally {
      setSettingsSaving(false);
    }
  }

  /** Logs one "in progress" maintenance task per selected item (see
   * /manage/it/tasks) and then opens the print dialog — printing this form
   * is the point a maintenance round is considered to have started. Task
   * logging never blocks the actual print: on failure it just leaves
   * taskCreateError up for the person to notice, since the paper form is
   * the part that has to happen regardless. */
  async function handlePrint() {
    if (selectedRows.length === 0) return;
    if (isReprint) {
      // The maintenance round(s) this reprint documents already happened
      // and are already on record (that's exactly what reprintTasks points
      // at) — this is standing in for a lost paper copy, not a new visit,
      // so skip POST /api/manage/it/tasks entirely rather than logging what
      // would look like brand-new rounds for the same equipment.
      window.print();
      return;
    }
    setCreatingTasks(true);
    setTaskCreateError(null);
    try {
      const res = await fetch("/api/manage/it/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: selectedRows.map((row) => ({
            equipmentRowNumber: row.rowNumber,
            assetNumber: row.assetNumber,
            equipmentType: row.equipmentType,
            brandModel: row.brandModel,
            department: row.department,
            location: row.location,
          })),
          // Snapshotted onto every task this print round creates (see
          // MaintenanceTask.plannedActions) so /manage/it/tasks's
          // "อัปเดตสถานะงาน" only ever offers the actions actually printed
          // on THIS task's form, not the full master list.
          plannedActions: printActionOptions,
        }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        setTaskCreateError(json.error ?? "บันทึกงานเข้าระบบติดตามไม่สำเร็จ — พิมพ์รายงานต่อได้ตามปกติ");
      }
      // Note: a successful response's skippedAlreadyInProgress count (the
      // server's own backstop against the same equipment somehow ending up
      // with two open tasks — see POST /api/manage/it/tasks) isn't surfaced
      // here on purpose: window.print() below is immediately followed by
      // the "afterprint" redirect to /manage/it/tasks (see the useEffect
      // above), so any message set on this page would be shown for only a
      // moment, hidden behind the print dialog the whole time — not a
      // reliable place for it. The checkbox lock in the picker table is
      // what actually prevents this up front, in a place IT can see before
      // printing at all.
    } catch {
      setTaskCreateError("บันทึกงานเข้าระบบติดตามไม่สำเร็จ — พิมพ์รายงานต่อได้ตามปกติ");
    } finally {
      setCreatingTasks(false);
    }
    window.print();
  }

  const displayDate = visitDate ? formatThaiDate(visitDate) : "";
  const timeRangeLabel = timeFrom && timeTo ? `${timeFrom} - ${timeTo}` : timeFrom || timeTo || "";
  // Drives the inline font-size on the "ข้อมูลครุภัณฑ์..." heading and the
  // วันที่ดำเนินการ/ลายเซ็น block below the table — see
  // ReportSettings.printFontSizePt's own comment for why only those two,
  // not the whole print-area.
  const bodyFontSizePt = printBodyFontSizePt(formSettings.printFontSizePt);
  // Drives all four lines of the print-area header (หน่วยงาน/ชื่อแบบฟอร์ม/
  // ปีงบประมาณ/กลุ่มงาน) — one shared size rather than each having its own
  // control; หน่วยงาน/ชื่อแบบฟอร์ม stay bold via a className, this only
  // ever changes size.
  const headerFontSizePt = printHeaderFontSizePt(formSettings.printHeaderFontSizePt);
  // Applied to the whole print-area container (see the print-area div
  // below) and inherited by everything under it except the equipment
  // table (its own leading-snug wins over the inherited value) — see
  // ReportSettings.printLineHeight's own comment for exactly what that
  // covers.
  const lineHeightRatio = printLineHeight(formSettings.printLineHeight);
  // Drives the blank space above the signature-block grid and the row gap
  // between a row of ผู้ตรวจสอบ blocks and the ผู้รับทราบ block below it —
  // see ReportSettings.printSignatureGapPx's own comment for exactly which
  // two gaps this covers (and which ones it deliberately doesn't, like the
  // reserved pen-signature space above each heading).
  const signatureGapPx = printSignatureGapPx(formSettings.printSignatureGapPx);
  // Drives the equipment table's base font size (see
  // ReportSettings.printTableFontSizePx) — the two smaller in-table sizes
  // below are derived from it, offset by fixed px amounts, so the table's
  // original visual hierarchy (ลำดับ/รายการ/ผู้รับผิดชอบ largest, then
  // หมายเลขครุภัณฑ์/checkboxes, then the ยี่ห้อ-รุ่น/กลุ่มงาน sub-lines
  // smallest) holds at any base size instead of flattening out. Math.max
  // floors each at 6px so an admin dialing the base all the way down to 7
  // still gets a readable, non-zero/negative table rather than broken CSS.
  const tableBaseFontSizePx = printTableFontSizePx(formSettings.printTableFontSizePx);
  const tableSecondaryFontSizePx = Math.max(tableBaseFontSizePx - 1, 6);
  const tableTertiaryFontSizePx = Math.max(tableBaseFontSizePx - 1.5, 6);
  // null = DEFAULT_TABLE_COLUMN_WIDTHS (this table's original fixed
  // guess). Set once "ปรับความกว้างคอลัมน์ให้พอดีอัตโนมัติ" is clicked
  // below (see autoFitTableColumns) — deliberately not recomputed
  // automatically on every selection/settings change, since re-measuring
  // is only meaningful as an explicit "fit it now" action, not something
  // that should silently reshuffle the table's layout while someone's
  // still picking items. Not persisted — resets to the default on reload,
  // same as excludedActionOptions above.
  const [tableColumnWidths, setTableColumnWidths] = useState<number[] | null>(null);
  // Blank rows mid-edit in the settings modal never leak into the printed
  // table (cleanActionOptions), anything ซ่อน/hidden from the master list
  // (hiddenActionOptions) never appears on a printed form at all, and
  // anything toggled off for just this round (excludedActionOptions, see
  // the "เลือกรายการที่จะดำเนินการ" card) is dropped too — the master list
  // stays untouched either way.
  const printActionOptions = cleanActionOptions(formSettings.actionOptions)
    .filter((name) => !formSettings.hiddenActionOptions.includes(name))
    .filter((name) => !excludedActionOptions.includes(name));

  /** "ปรับความกว้างคอลัมน์ให้พอดีอัตโนมัติ" button handler — measures the
   * table exactly as it's about to render right now (current selectedRows,
   * printActionOptions, font family/sizes) and applies the result. A no-op
   * (silently, since this is just a layout convenience) if nothing's
   * selected yet or canvas measurement isn't available. */
  function autoFitTableColumns() {
    if (selectedRows.length === 0) return;
    const widths = computeAutoTableColumnWidths(
      selectedRows,
      printActionOptions.map((name) => actionLabelForPrint(name, formSettings.detailRequiredActionOptions)),
      PRINT_FONT_FAMILY,
      tableBaseFontSizePx,
      tableSecondaryFontSizePx,
      tableTertiaryFontSizePx
    );
    if (widths) setTableColumnWidths(widths);
  }
  // One ผู้ตรวจสอบ block per department, then ผู้รับทราบ last — all rendered
  // from a single grid below so they pair up left/right instead of
  // ผู้รับทราบ always getting shoved onto its own row. See that grid's
  // comment for why.
  const signatureBlocks = [
    ...selectedDepartments.map((dep) => ({
      key: `inspector-${dep}`,
      heading: "ลงชื่อ ....................................................... ผู้ตรวจสอบ",
      nameLine: "(.......................................................)",
      positionLine: "ตำแหน่ง .......................................................",
      subLabel: dep,
    })),
    {
      key: "acknowledger",
      heading: "ลงชื่อ ....................................................... ผู้รับทราบ",
      nameLine: `(${formSettings.acknowledgerName})`,
      positionLine: `ตำแหน่ง ${formSettings.acknowledgerPosition}`,
      subLabel: formSettings.acknowledgerDepartment,
    },
  ];

  return (
    // translate="no" (+ the "notranslate" class, for older Chrome builds
    // that still key off it) tells Chrome's built-in page-translate feature
    // to leave this whole page alone. Without it, translating this page
    // lets Chrome rewrite text nodes behind React's back; the next time
    // React updates the DOM here (e.g. the month-strip popup below
    // appearing/disappearing on hover) it can crash trying to remove/update
    // a node Translate already altered — a well-known React ↔ Chrome
    // Translate conflict, not specific to this page's own logic. Since this
    // dashboard is Thai-only by design anyway, there's no reason to ever
    // offer translation on it.
    <AppShell
      roleLabel={currentUser.isBootstrap ? "Superadmin (Bootstrap)" : "IT"}
      username={currentUser.username}
      displayName={currentUser.displayName}
      canAccessManage={currentUser.isBootstrap}
      canManageUsers={hasPermission(currentUser, "manageUsers")}
      canAccessIt
      canApproveBookings={hasPermission(currentUser, "approveCarBooking")}
    >
    <main
      translate="no"
      className="notranslate flex w-full flex-1 justify-center px-4 py-8 print:block print:bg-white print:px-0 print:py-0 sm:px-6 lg:px-10"
    >
      <div className="flex w-full max-w-[75rem] flex-col gap-6 print:block print:max-w-none print:gap-0">
        {/* Selection controls — never printed (see the @media print rule
            below, which also hides anything with the .no-print class as a
            belt-and-suspenders backstop for browsers that ignore print:). */}
        <div className="no-print flex flex-col gap-6 print:hidden">
          {/* ออกรายงานเป็นขั้นตอนย่อยของงานบำรุงรักษา ซึ่งเป็นส่วนย่อยของ
              "ระบบงาน IT" อีกที — breadcrumb นี้ยืนยันบริบทนั้นให้ตรงกับ
              ลำดับชั้นใน sidebar และปุ่ม "พิมพ์แบบฟอร์ม" ที่พาเข้ามาหน้านี้. */}
          <nav aria-label="breadcrumb" className="-mb-2 flex items-center gap-1.5 text-xs font-medium text-zinc-400 dark:text-zinc-500">
            <Link href="/manage/it" className="inline-flex items-center gap-1 hover:text-[var(--brand)] hover:underline">
              <Wrench size={12} strokeWidth={2} aria-hidden="true" />
              ระบบงาน IT
            </Link>
            <ChevronRight size={12} strokeWidth={2} aria-hidden="true" />
            <Link href="/manage/it/tasks" className="hover:text-[var(--brand)] hover:underline">
              งานบำรุงรักษา
            </Link>
            <ChevronRight size={12} strokeWidth={2} aria-hidden="true" />
            <span className="text-zinc-500 dark:text-zinc-400">ออกรายงาน</span>
          </nav>
          <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3">
              <span
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-[var(--brand)] to-[var(--brand-2)] text-[var(--brand-contrast)] shadow-sm"
                aria-hidden="true"
              >
                <FileText size={20} strokeWidth={2} />
              </span>
              <h1 className="text-xl font-bold text-zinc-950 dark:text-zinc-50 sm:text-2xl">
                ออกรายงาน: แบบฟอร์มบำรุงรักษาเชิงป้องกัน
              </h1>
            </div>
            <button
              type="button"
              onClick={() => setShowSettings((v) => !v)}
              className="inline-flex items-center gap-1.5 self-start rounded-full border border-zinc-200 px-4 py-2 text-sm font-medium text-zinc-600 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800 sm:self-auto"
            >
              <Settings size={16} strokeWidth={2} aria-hidden="true" />
              ตั้งค่าแบบฟอร์มรายงาน
            </button>
          </header>

          {isReprint && (
            <div
              role="status"
              className="flex items-start gap-2 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300"
            >
              <PrinterIcon size={16} strokeWidth={2} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span>
                โหมดพิมพ์ซ้ำ — เตรียมพิมพ์สำเนาแบบฟอร์มของงานบำรุงรักษา{reprintTasks && reprintTasks.length > 1
                  ? ` ${reprintTasks.length.toLocaleString("th-TH")} รายการ`
                  : ""}{" "}
                ที่มีอยู่แล้วในระบบ (สำหรับกรณีเอกสารต้นฉบับสูญหาย) การพิมพ์ครั้งนี้จะ
                <strong>ไม่สร้างงานบำรุงรักษารายการใหม่</strong>
                ในระบบ — ปรับ วันที่/ช่วงเวลา/รายการครุภัณฑ์ ด้านล่างได้ตามจริงก่อนพิมพ์
              </span>
            </div>
          )}

          {loadError && (
            <div
              role="alert"
              className="rounded-2xl border border-red-200 bg-red-50 p-4 text-red-900 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-200"
            >
              {loadError}
            </div>
          )}

          <div className={`${CARD} flex flex-col gap-3 p-4`}>
            <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">ข้อมูลของแบบฟอร์ม (ใช้ร่วมกันทุกรายการในตาราง)</p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <label className="flex flex-col gap-1 text-sm text-zinc-500 dark:text-zinc-400">
                กลุ่มงาน (แสดงในหัวแบบฟอร์ม)
                <input
                  type="text"
                  value={formDepartment}
                  onChange={(e) => setFormDepartment(e.target.value)}
                  placeholder="เช่น กลุ่มงานรังสีวิทยา"
                  className={INPUT_CLASS}
                />
              </label>
              <label className="flex flex-col gap-1 text-sm text-zinc-500 dark:text-zinc-400">
                วันที่ดำเนินการ
                <input type="date" value={visitDate} onChange={(e) => setVisitDate(e.target.value)} className={INPUT_CLASS} />
              </label>
              <label className="flex flex-col gap-1 text-sm text-zinc-500 dark:text-zinc-400">
                เวลาเริ่ม
                <input type="time" value={timeFrom} onChange={(e) => setTimeFrom(e.target.value)} className={INPUT_CLASS} />
              </label>
              <label className="flex flex-col gap-1 text-sm text-zinc-500 dark:text-zinc-400">
                เวลาสิ้นสุด
                <input type="time" value={timeTo} onChange={(e) => setTimeTo(e.target.value)} className={INPUT_CLASS} />
              </label>
            </div>
          </div>

          {showSettings && (
            <div
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
              onClick={() => setShowSettings(false)}
              role="presentation"
            >
              <div
                className={`${CARD} flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden`}
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-center justify-between gap-3 border-b border-emerald-900/10 px-4 py-3 dark:border-emerald-400/10">
                  <div className="flex items-center gap-1.5 text-sm font-semibold text-zinc-800 dark:text-zinc-100">
                    <Settings size={15} strokeWidth={2} aria-hidden="true" />
                    ตั้งค่าแบบฟอร์มรายงาน
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowSettings(false)}
                    className="rounded-full p-1 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800"
                    aria-label="ปิด"
                  >
                    <X size={16} strokeWidth={2} aria-hidden="true" />
                  </button>
                </div>

                <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
                  {settingsError && (
                    <div
                      role="alert"
                      className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-200"
                    >
                      {settingsError}
                    </div>
                  )}

                  {/* Each setting group gets its own bordered card — kept
                      visually distinct instead of one long form, since
                      these three are edited on different occasions (rarely
                      for the header text, often for the checklist). */}
                  <div className="flex flex-col gap-2 rounded-xl border border-zinc-200 p-3 dark:border-zinc-700">
                    <p className="text-sm font-bold text-zinc-800 dark:text-zinc-100">ข้อความหัวแบบฟอร์ม</p>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      {SETTINGS_FIELDS.map(({ key, label }) => (
                        <label key={key} className="flex flex-col gap-1 text-sm text-zinc-500 dark:text-zinc-400">
                          {label}
                          <input
                            type="text"
                            value={formSettings[key]}
                            onChange={(e) => {
                              setFormSettings((prev) => ({ ...prev, [key]: e.target.value }));
                              setSettingsSaved(false);
                            }}
                            className={INPUT_CLASS}
                          />
                        </label>
                      ))}
                    </div>
                  </div>

                  <div className="flex flex-col gap-2 rounded-xl border border-zinc-200 p-3 dark:border-zinc-700">
                    <p className="text-sm font-bold text-zinc-800 dark:text-zinc-100">ขนาดตัวอักษรที่พิมพ์</p>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <label className="flex flex-col gap-1 text-sm text-zinc-500 dark:text-zinc-400">
                        ขนาดตัวอักษรหัวแบบฟอร์ม (pt)
                        <input
                          type="number"
                          min={8}
                          max={36}
                          value={formSettings.printHeaderFontSizePt}
                          onChange={(e) => {
                            setFormSettings((prev) => ({ ...prev, printHeaderFontSizePt: e.target.value }));
                            setSettingsSaved(false);
                          }}
                          className={INPUT_CLASS}
                        />
                      </label>
                      <label className="flex flex-col gap-1 text-sm text-zinc-500 dark:text-zinc-400">
                        ขนาดตัวอักษรภาพรวม (pt)
                        <input
                          type="number"
                          min={8}
                          max={36}
                          value={formSettings.printFontSizePt}
                          onChange={(e) => {
                            setFormSettings((prev) => ({ ...prev, printFontSizePt: e.target.value }));
                            setSettingsSaved(false);
                          }}
                          className={INPUT_CLASS}
                        />
                      </label>
                      <label className="flex flex-col gap-1 text-sm text-zinc-500 dark:text-zinc-400">
                        ขนาดตัวอักษรในตาราง (px)
                        <input
                          type="number"
                          min={7}
                          max={20}
                          value={formSettings.printTableFontSizePx}
                          onChange={(e) => {
                            setFormSettings((prev) => ({ ...prev, printTableFontSizePx: e.target.value }));
                            setSettingsSaved(false);
                          }}
                          className={INPUT_CLASS}
                        />
                      </label>
                      <label className="flex flex-col gap-1 text-sm text-zinc-500 dark:text-zinc-400">
                        ระยะห่างระหว่างบรรทัดภาพรวม
                        <input
                          type="number"
                          min={0.7}
                          max={2.5}
                          step={0.05}
                          value={formSettings.printLineHeight}
                          onChange={(e) => {
                            setFormSettings((prev) => ({ ...prev, printLineHeight: e.target.value }));
                            setSettingsSaved(false);
                          }}
                          className={INPUT_CLASS}
                        />
                      </label>
                      <label className="flex flex-col gap-1 text-sm text-zinc-500 dark:text-zinc-400">
                        ระยะห่างช่องว่างส่วนลงชื่อ (px)
                        <input
                          type="number"
                          min={0}
                          max={48}
                          value={formSettings.printSignatureGapPx}
                          onChange={(e) => {
                            setFormSettings((prev) => ({ ...prev, printSignatureGapPx: e.target.value }));
                            setSettingsSaved(false);
                          }}
                          className={INPUT_CLASS}
                        />
                      </label>
                    </div>
                  </div>

                  <div className="flex flex-col gap-2 rounded-xl border border-zinc-200 p-3 dark:border-zinc-700">
                    <p className="text-sm font-bold text-zinc-800 dark:text-zinc-100">รายการ &quot;การดำเนินการ&quot;</p>
                    <div className="flex flex-col gap-2">
                      {formSettings.actionOptions.map((opt, idx) => {
                        const locked = !canManageActionOptions && idx < lockedActionOptionsCount;
                        const hidden = opt.trim() ? formSettings.hiddenActionOptions.includes(opt) : false;
                        const detailRequired = opt.trim()
                          ? formSettings.detailRequiredActionOptions.includes(opt)
                          : false;
                        // "บังคับเลือกเสมอ" (mandatory) — see toggleLockedActionOption
                        // above. Named "mandatory" here, not "locked", so it never
                        // gets confused with this row's own `locked` (an unrelated
                        // concept: "already saved, this account can't edit/delete
                        // it at all" — see that variable's own definition above).
                        const mandatory = opt.trim() ? formSettings.lockedActionOptions.includes(opt) : false;
                        const color = opt.trim() ? colorForAction(opt) : null;
                        return (
                          <div key={idx} className={`flex items-center gap-2 ${hidden ? "opacity-50" : ""}`}>
                            <span
                              className="h-2.5 w-2.5 shrink-0 rounded-full bg-[var(--seg-c)] dark:bg-[var(--seg-c-dark)]"
                              style={color ? actionColorStyle(color) : actionColorStyle(ACTION_OTHER_COLOR)}
                              aria-hidden="true"
                            />
                            {canManageActionOptions && (
                              <div className="flex shrink-0 flex-col">
                                <button
                                  type="button"
                                  onClick={() => moveActionOption(idx, -1)}
                                  disabled={idx === 0}
                                  title="เลื่อนรายการนี้ขึ้น — สลับตำแหน่งกับรายการก่อนหน้า"
                                  aria-label="เลื่อนรายการนี้ขึ้น"
                                  className="flex h-[19px] w-6 items-center justify-center rounded-t-md border border-b-0 border-zinc-200 text-zinc-500 transition-colors hover:bg-zinc-50 hover:text-zinc-700 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
                                >
                                  <ChevronUp size={12} strokeWidth={2.5} aria-hidden="true" />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => moveActionOption(idx, 1)}
                                  disabled={idx === formSettings.actionOptions.length - 1}
                                  title="เลื่อนรายการนี้ลง — สลับตำแหน่งกับรายการถัดไป"
                                  aria-label="เลื่อนรายการนี้ลง"
                                  className="flex h-[19px] w-6 items-center justify-center rounded-b-md border border-zinc-200 text-zinc-500 transition-colors hover:bg-zinc-50 hover:text-zinc-700 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
                                >
                                  <ChevronDown size={12} strokeWidth={2.5} aria-hidden="true" />
                                </button>
                              </div>
                            )}
                            {locked ? (
                              <span className="flex h-10 flex-1 items-center gap-2 rounded-lg border border-transparent px-3 text-sm text-zinc-700 dark:text-zinc-300">
                                {opt}
                                {hidden && (
                                  <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-medium text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                                    ซ่อนอยู่
                                  </span>
                                )}
                                {detailRequired && (
                                  <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-medium text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                                    มีช่องกรอกรายละเอียด
                                  </span>
                                )}
                                {mandatory && (
                                  <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-600 dark:bg-amber-950/40 dark:text-amber-300">
                                    บังคับเลือกเสมอ
                                  </span>
                                )}
                              </span>
                            ) : (
                              <input
                                type="text"
                                value={opt}
                                onChange={(e) => updateActionOption(idx, e.target.value)}
                                placeholder="เช่น อัพเดทโปรแกรม Hosxp 3 เป็นเวอร์ชัน ...."
                                className={`${INPUT_CLASS} flex-1`}
                              />
                            )}
                            {canManageActionOptions && opt.trim() && (
                              <button
                                type="button"
                                onClick={() => toggleHiddenActionOption(opt)}
                                title={
                                  hidden
                                    ? "แสดงรายการนี้อีกครั้ง — จะกลับมาให้ IT เลือกและปรากฏในเอกสาร"
                                    : "ซ่อนรายการนี้ — จะหายไปจากรายการที่ IT เลือกได้และในเอกสาร แต่ไม่ถูกลบ"
                                }
                                aria-label={hidden ? "แสดงรายการนี้อีกครั้ง" : "ซ่อนรายการนี้"}
                                className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-zinc-200 text-zinc-500 transition-colors hover:border-zinc-300 hover:bg-zinc-50 hover:text-zinc-700 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                              >
                                {hidden ? (
                                  <EyeOff size={16} strokeWidth={2} aria-hidden="true" />
                                ) : (
                                  <Eye size={16} strokeWidth={2} aria-hidden="true" />
                                )}
                              </button>
                            )}
                            {canManageActionOptions && opt.trim() && (
                              <button
                                type="button"
                                onClick={() => toggleDetailRequiredActionOption(opt)}
                                title={
                                  detailRequired
                                    ? "ยกเลิกช่องกรอกรายละเอียด — จะไม่มีจุดประ .......... ต่อท้ายรายการนี้อีก"
                                    : "เพิ่มช่องกรอกรายละเอียด — จะมีจุดประ .......... ต่อท้ายรายการนี้บนแบบฟอร์ม เพื่อให้เจ้าหน้าที่เขียน/กรอกรายละเอียดเพิ่มเติม"
                                }
                                aria-label={detailRequired ? "ยกเลิกช่องกรอกรายละเอียด" : "เพิ่มช่องกรอกรายละเอียด"}
                                className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border transition-colors ${
                                  detailRequired
                                    ? "border-blue-200 bg-blue-50 text-blue-600 hover:bg-blue-100 dark:border-blue-900/50 dark:bg-blue-950/40 dark:text-blue-300"
                                    : "border-zinc-200 text-zinc-500 hover:border-zinc-300 hover:bg-zinc-50 hover:text-zinc-700 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                                }`}
                              >
                                <PenLine size={16} strokeWidth={2} aria-hidden="true" />
                              </button>
                            )}
                            {canLockActionOptions && opt.trim() && (
                              <button
                                type="button"
                                onClick={() => toggleLockedActionOption(opt)}
                                title={
                                  mandatory
                                    ? "ยกเลิกบังคับ — IT จะเลือกไม่ใช้รายการนี้ในบางรอบได้อีกครั้ง"
                                    : "บังคับเลือกเสมอ — รายการนี้จะถูกเลือกอัตโนมัติทุกครั้งที่พิมพ์ และ IT จะปิดใช้งานไม่ได้"
                                }
                                aria-label={mandatory ? "ยกเลิกบังคับเลือกเสมอ" : "บังคับเลือกเสมอ"}
                                className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border transition-colors ${
                                  mandatory
                                    ? "border-amber-200 bg-amber-50 text-amber-600 hover:bg-amber-100 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-300"
                                    : "border-zinc-200 text-zinc-500 hover:border-zinc-300 hover:bg-zinc-50 hover:text-zinc-700 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                                }`}
                              >
                                {mandatory ? (
                                  <Lock size={16} strokeWidth={2} aria-hidden="true" />
                                ) : (
                                  <Unlock size={16} strokeWidth={2} aria-hidden="true" />
                                )}
                              </button>
                            )}
                            {locked ? (
                              <Lock
                                size={16}
                                strokeWidth={2}
                                className="shrink-0 text-zinc-300 dark:text-zinc-600"
                                aria-label="รายการนี้บันทึกแล้ว แก้ไข/ลบไม่ได้"
                              />
                            ) : (
                              <button
                                type="button"
                                onClick={() => removeActionOption(idx)}
                                disabled={formSettings.actionOptions.length <= 1}
                                title={formSettings.actionOptions.length <= 1 ? "ต้องมีอย่างน้อย 1 รายการ" : "ลบรายการนี้"}
                                aria-label="ลบรายการนี้"
                                className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-zinc-200 text-zinc-500 transition-colors hover:border-red-200 hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-zinc-200 disabled:hover:bg-transparent disabled:hover:text-zinc-500 dark:border-zinc-700 dark:text-zinc-400 dark:hover:border-red-900/50 dark:hover:bg-red-950/40 dark:hover:text-red-300"
                              >
                                <Trash2 size={16} strokeWidth={2} aria-hidden="true" />
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                    {canManageActionOptions && (
                      <button
                        type="button"
                        onClick={addActionOption}
                        className="inline-flex w-fit items-center gap-1.5 rounded-full border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-600 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                      >
                        <Plus size={14} strokeWidth={2} aria-hidden="true" />
                        เพิ่มรายการ
                      </button>
                    )}
                  </div>

                  <div className="flex flex-col gap-2 rounded-xl border border-zinc-200 p-3 dark:border-zinc-700">
                    <p className="text-sm font-bold text-zinc-800 dark:text-zinc-100">แนวกระดาษที่พิมพ์</p>
                    {/* Chrome hides its own print-dialog "Layout" control
                        once the page's @page CSS sets a size, so this is
                        what actually switches orientation — see the
                        `orientation` state comment above. Defaults to
                        landscape since the table is wide enough that
                        that's the right choice almost every time. */}
                    <div
                      role="group"
                      aria-label="แนวกระดาษ"
                      className="inline-flex w-fit items-center rounded-full border border-zinc-200 p-0.5 dark:border-zinc-700"
                    >
                      <button
                        type="button"
                        onClick={() => setOrientation("portrait")}
                        aria-pressed={orientation === "portrait"}
                        className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${
                          orientation === "portrait"
                            ? "bg-gradient-to-r from-[var(--brand)] to-[var(--brand-2)] text-[var(--brand-contrast)]"
                            : "text-zinc-600 hover:bg-zinc-50 dark:text-zinc-300 dark:hover:bg-zinc-800"
                        }`}
                      >
                        <RectangleVertical size={16} strokeWidth={2} aria-hidden="true" />
                        แนวตั้ง
                      </button>
                      <button
                        type="button"
                        onClick={() => setOrientation("landscape")}
                        aria-pressed={orientation === "landscape"}
                        className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${
                          orientation === "landscape"
                            ? "bg-gradient-to-r from-[var(--brand)] to-[var(--brand-2)] text-[var(--brand-contrast)]"
                            : "text-zinc-600 hover:bg-zinc-50 dark:text-zinc-300 dark:hover:bg-zinc-800"
                        }`}
                      >
                        <RectangleHorizontal size={16} strokeWidth={2} aria-hidden="true" />
                        แนวนอน
                      </button>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-3 border-t border-emerald-900/10 px-4 py-3 dark:border-emerald-400/10">
                  <button
                    type="button"
                    onClick={saveSettingsAsDefault}
                    disabled={settingsSaving}
                    className="inline-flex items-center gap-2 rounded-full bg-gradient-to-r from-[var(--brand)] to-[var(--brand-2)] px-5 py-2.5 text-sm font-semibold text-[var(--brand-contrast)] shadow-sm transition-colors hover:from-[var(--brand-strong)] disabled:opacity-60"
                  >
                    {settingsSaving ? (
                      <Loader2 size={16} strokeWidth={2} className="animate-spin" aria-hidden="true" />
                    ) : (
                      <Save size={16} strokeWidth={2} aria-hidden="true" />
                    )}
                    บันทึกเป็นค่าเริ่มต้น
                  </button>
                  {settingsSaved && (
                    <span className="inline-flex items-center gap-1 text-sm font-medium text-emerald-600 dark:text-emerald-400">
                      <Check size={15} strokeWidth={2} aria-hidden="true" />
                      บันทึกแล้ว
                    </span>
                  )}
                </div>
              </div>
            </div>
          )}

          <div className={`${CARD} flex flex-col gap-3 p-4`}>
            <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
              <MultiSelect
                label="กรองตามกลุ่มงาน"
                options={departmentOptions}
                selected={departmentFilter}
                onChange={setDepartmentFilter}
                className="sm:max-w-xs sm:flex-1"
              />
              <MultiSelect
                label="กรองตามประเภทครุภัณฑ์"
                options={equipmentTypeOptions}
                selected={equipmentTypeFilter}
                onChange={setEquipmentTypeFilter}
                className="sm:max-w-xs sm:flex-1"
              />
              <label className="flex flex-col gap-1 text-sm text-zinc-500 dark:text-zinc-400">
                เดือนที่บำรุงรักษา
                <select
                  value={maintenanceMonthFilter}
                  onChange={(e) => setMaintenanceMonthFilter(e.target.value)}
                  aria-label="กรองสถานะบำรุงรักษาตามเดือน"
                  className={INPUT_CLASS}
                >
                  {THAI_MONTHS_FULL.map((label, idx) => (
                    <option key={label} value={idx + 1}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-sm text-zinc-500 dark:text-zinc-400">
                ปีที่บำรุงรักษา
                <select
                  value={maintenanceYearFilter}
                  onChange={(e) => setMaintenanceYearFilter(e.target.value)}
                  aria-label="กรองสถานะบำรุงรักษาตามปี"
                  className={INPUT_CLASS}
                >
                  {maintenanceYearOptions.map((y) => (
                    <option key={y} value={y}>
                      {y}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-sm text-zinc-500 dark:text-zinc-400">
                กรองสถานะ
                <select
                  value={maintenanceStatusFilter}
                  onChange={(e) => setMaintenanceStatusFilter(e.target.value as typeof maintenanceStatusFilter)}
                  aria-label="กรองรายการตามสถานะบำรุงรักษา"
                  className={INPUT_CLASS}
                >
                  <option value="">ทั้งหมด</option>
                  <option value="in_progress">กำลังดำเนินการ</option>
                  <option value="done">เสร็จสิ้นแล้ว</option>
                  <option value="none">ยังไม่เคยบำรุงรักษา</option>
                </select>
              </label>
              <label className="flex flex-col gap-1 text-sm text-zinc-500 dark:text-zinc-400 sm:max-w-xs sm:flex-1">
                ค้นหา
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="เลขครุภัณฑ์ / ยี่ห้อ / รุ่น / สถานที่"
                  className={INPUT_CLASS}
                />
              </label>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={selectAllFiltered}
                disabled={filteredItems.length === 0}
                className="inline-flex items-center gap-1.5 rounded-full border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-600 transition-colors hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                <Check size={13} strokeWidth={2} aria-hidden="true" />
                เลือกทั้งหมดที่กรองอยู่ ({filteredItems.length.toLocaleString("th-TH")})
              </button>
              {selectedRowNumbers.length > 0 && (
                <button
                  type="button"
                  onClick={clearSelection}
                  className="inline-flex items-center gap-1.5 rounded-full border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-600 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                >
                  <X size={13} strokeWidth={2} aria-hidden="true" />
                  ล้างที่เลือก
                </button>
              )}
              <span className="text-sm text-zinc-400 sm:ml-auto">
                เลือกแล้ว {selectedRowNumbers.length.toLocaleString("th-TH")} รายการ
              </span>
            </div>
            {/* max-w-full + overflow-x-auto here (on top of the existing
                vertical max-h-80 overflow-y-auto) so this table scrolls
                sideways on a narrow phone instead of squeezing every column
                down to unreadably thin — table-fixed's percentage widths
                below then apply against the table's own min-width, not the
                viewport. */}
            <div className="max-h-80 max-w-full overflow-x-auto overflow-y-auto rounded-lg border border-zinc-100 dark:border-zinc-800">
              <table className="w-full min-w-[38rem] table-fixed text-left text-xs sm:text-sm">
                {/* Explicit column widths — เดือนที่บำรุงรักษา gets the extra
                    room freed up from ผู้รับผิดชอบครุภัณฑ์, whose content
                    (a name) rarely needs as much width as an unconstrained
                    table would otherwise give it (see the user's screenshot
                    pointing at that dead space). */}
                <colgroup>
                  <col className="w-10" />
                  <col className="w-[21%]" />
                  <col className="w-[26%]" />
                  <col className="w-[27%]" />
                  <col className="w-[26%]" />
                </colgroup>
                <thead className="sticky top-0 bg-white dark:bg-zinc-900">
                  <tr className="border-b border-zinc-100 text-[10px] uppercase tracking-wide text-zinc-400 dark:border-zinc-800">
                    <th scope="col" className="px-2 py-2 font-medium">เลือก</th>
                    <th scope="col" className="px-2 py-2 font-medium">เดือนที่บำรุงรักษา</th>
                    <th scope="col" className="px-2 py-2 font-medium">รายการ</th>
                    <th scope="col" className="px-2 py-2 font-medium">กลุ่มงาน / สถานที่ตั้ง</th>
                    <th scope="col" className="px-2 py-2 font-medium">ผู้รับผิดชอบครุภัณฑ์</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredItems.map((it) => (
                    <tr key={it.rowNumber} className="border-b border-zinc-50 last:border-0 dark:border-zinc-800/60">
                      <td className="px-2 py-1.5 align-top">
                        <input
                          type="checkbox"
                          checked={selectedRowNumbers.includes(it.rowNumber)}
                          onChange={() => toggleItem(it.rowNumber)}
                          disabled={Boolean(inProgressByEquipment[it.rowNumber]) && !selectedRowNumbers.includes(it.rowNumber)}
                          title={
                            inProgressByEquipment[it.rowNumber]
                              ? `กำลังบำรุงรักษาโดย ${inProgressByEquipment[it.rowNumber].displayName} อยู่ — เลือกซ้ำไม่ได้จนกว่าจะกดเสร็จสิ้น`
                              : undefined
                          }
                          aria-label={`เลือก ${it.assetNumber || it.equipmentType}`}
                          className="disabled:cursor-not-allowed disabled:opacity-40"
                        />
                      </td>
                      <td className="px-2 py-1.5 align-top">
                        <div
                          className="flex flex-wrap items-start gap-[3px]"
                          role="group"
                          aria-label={`เดือนที่บำรุงรักษาในปี ${maintenanceYearFilter || "ทุกปี"}`}
                        >
                          {THAI_MONTHS_SHORT.map((label, monthIdx) => {
                            const monthTasks = monthlyTasks[it.rowNumber]?.[monthIdx] ?? [];
                            const hasInProgress = monthTasks.some((t) => t.status === "in_progress");
                            const isFilteredMonth = String(monthIdx + 1) === maintenanceMonthFilter;
                            const isEmpty = monthTasks.length === 0;
                            // Every "การดำเนินการ" item logged by any visit
                            // that month, combined — a month with 2+ visits
                            // (each with its own actionsTaken list) shows all
                            // of them together, flattened in order, per the
                            // hospital's request to see the whole month's
                            // work at a glance rather than only the latest
                            // visit.
                            const allActions = hasInProgress
                              ? []
                              : monthTasks.flatMap((t) =>
                                  t.actionsTaken.map((a) => a.trim()).filter(Boolean)
                                );
                            // De-dotted ("ม.ค." -> "มค") so the abbreviation
                            // reads cleanly as its own small label under the
                            // bar — the full-dotted form is still used
                            // everywhere else (title/aria-label, dates, the
                            // popup heading).
                            const shortLabel = label.replace(/\./g, "");
                            return (
                              <div key={monthIdx} className="flex shrink-0 flex-col items-center gap-0.5">
                                <button
                                  type="button"
                                  onClick={() => setMonthPopup({ rowNumber: it.rowNumber, month: monthIdx })}
                                  title={`${label}: บำรุงรักษา ${monthTasks.length.toLocaleString("th-TH")} ครั้ง${
                                    allActions.length > 0 ? ` — ${allActions.join(", ")}` : ""
                                  } — คลิกเพื่อดูรายละเอียด`}
                                  aria-label={`${label}: บำรุงรักษา ${monthTasks.length.toLocaleString("th-TH")} ครั้ง${
                                    allActions.length > 0 ? ` — ${allActions.join(", ")}` : ""
                                  } — คลิกเพื่อดูรายละเอียด`}
                                  className={`flex h-7 w-3.5 flex-col overflow-hidden rounded-[3px] transition-colors ${
                                    isFilteredMonth
                                      ? "ring-2 ring-[var(--brand)] ring-offset-1 ring-offset-white dark:ring-offset-zinc-900"
                                      : ""
                                  }`}
                                >
                                  {isEmpty ? (
                                    <span className="h-full w-full bg-zinc-200 dark:bg-zinc-700" />
                                  ) : hasInProgress ? (
                                    <span className="h-full w-full bg-amber-500 dark:bg-amber-400" />
                                  ) : allActions.length === 0 ? (
                                    <span className="h-full w-full bg-emerald-500 dark:bg-emerald-400" />
                                  ) : (
                                    <span className="flex h-full w-full flex-col gap-px bg-white dark:bg-zinc-900">
                                      {allActions.map((name, i) => (
                                        <span
                                          key={i}
                                          className="min-h-0 flex-1 bg-[var(--seg-c)] dark:bg-[var(--seg-c-dark)]"
                                          style={actionColorStyle(colorForAction(name))}
                                        />
                                      ))}
                                    </span>
                                  )}
                                </button>
                                <span className="text-[7px] leading-none font-medium text-zinc-400 select-none dark:text-zinc-500">
                                  {shortLabel}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                        {visitCounts[it.rowNumber] > 0 && (
                          <p className="mt-1 text-[9px] text-zinc-400 dark:text-zinc-500">
                            {visitCounts[it.rowNumber].toLocaleString("th-TH")} ครั้ง (
                            {THAI_MONTHS_SHORT[Number(maintenanceMonthFilter) - 1] ?? ""})
                          </p>
                        )}
                        {(() => {
                          // Chip list of the currently-filtered month's
                          // distinct actions, color-matched to the segments
                          // above — lets the hospital see what was done
                          // without clicking into the popup, for whichever
                          // month "เดือนที่บำรุงรักษา" is currently set to.
                          const filteredMonthIdx = Number(maintenanceMonthFilter) - 1;
                          const filteredMonthTasks = monthlyTasks[it.rowNumber]?.[filteredMonthIdx] ?? [];
                          const names = [
                            ...new Set(
                              filteredMonthTasks.flatMap((t) =>
                                t.actionsTaken.map((a) => a.trim()).filter(Boolean)
                              )
                            ),
                          ];
                          if (names.length === 0) return null;
                          return (
                            <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                              {names.map((name) => (
                                <span
                                  key={name}
                                  className="inline-flex items-center gap-1 text-[9px] text-zinc-500 dark:text-zinc-400"
                                >
                                  <span
                                    className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--seg-c)] dark:bg-[var(--seg-c-dark)]"
                                    style={actionColorStyle(colorForAction(name))}
                                    aria-hidden="true"
                                  />
                                  {name}
                                </span>
                              ))}
                            </div>
                          );
                        })()}
                      </td>
                      <td className="px-2 py-1.5 text-zinc-700 dark:text-zinc-300 align-top">
                        <div className="font-medium">{it.equipmentType || "—"}</div>
                        <div className="text-[10px] leading-snug text-zinc-400 dark:text-zinc-500">
                          {[it.assetNumber, it.brandModel].filter(Boolean).join(" · ") || "—"}
                        </div>
                        {inProgress[it.rowNumber] ? (
                          <span className="mt-1 inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
                            <Wrench size={10} strokeWidth={2} aria-hidden="true" />
                            กำลังบำรุงรักษาโดย {inProgress[it.rowNumber].displayName}
                          </span>
                        ) : (
                          lastCompleted[it.rowNumber] && (
                            <span className="mt-1 inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
                              <CheckCircle2 size={10} strokeWidth={2} aria-hidden="true" />
                              เสร็จสิ้นล่าสุดโดย {lastCompleted[it.rowNumber].displayName}
                              {lastCompleted[it.rowNumber].completedAt &&
                                ` เมื่อ ${formatThaiDate(lastCompleted[it.rowNumber].completedAt.slice(0, 10))}`}
                            </span>
                          )
                        )}
                      </td>
                      <td className="px-2 py-1.5 text-zinc-700 dark:text-zinc-300 align-top">
                        <div>{it.department || "—"}</div>
                        <div className="text-[10px] leading-snug text-zinc-400 dark:text-zinc-500">
                          {it.installLocation || "—"}
                        </div>
                      </td>
                      <td className="px-2 py-1.5 text-zinc-700 dark:text-zinc-300 align-top">
                        {it.responsiblePerson || "—"}
                      </td>
                    </tr>
                  ))}
                  {filteredItems.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-2 py-6 text-center text-zinc-400">
                        ไม่พบรายการ
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Step 3 in the intended top-to-bottom flow (กรอกหน่วยงาน →
              กรองประเภทครุภัณฑ์/เลือกรายการ → เลือกรายการที่จะดำเนินการ →
              preview → พิมพ์): which of the master รายการ "การดำเนินการ"
              entries actually show up as checkboxes on THIS printout. A
              plain toggle over the always-visible master list — not a
              second CRUD editor — so switching what's relevant this round
              never touches (and never requires deleting from) the master
              list in "ตั้งค่าแบบฟอร์มรายงาน". */}
          <div className={`${CARD} flex flex-col gap-3 p-4`}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                  เลือกรายการที่จะดำเนินการ (แสดงในแบบฟอร์มที่พิมพ์รอบนี้)
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={() => setExcludedActionOptions([])}
                  disabled={excludedActionOptions.length === 0}
                  className="inline-flex items-center gap-1 rounded-full border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-600 transition-colors hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                >
                  <Check size={13} strokeWidth={2} aria-hidden="true" />
                  เลือกทั้งหมด
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setExcludedActionOptions(
                      cleanActionOptions(formSettings.actionOptions).filter(
                        (name) =>
                          !formSettings.hiddenActionOptions.includes(name) &&
                          // A locked entry can't be cleared out by "ล้างที่เลือก"
                          // either — see toggleActiveAction's own guard above.
                          !formSettings.lockedActionOptions.includes(name)
                      )
                    )
                  }
                  disabled={printActionOptions.length === 0}
                  className="inline-flex items-center gap-1 rounded-full border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-600 transition-colors hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                >
                  <X size={13} strokeWidth={2} aria-hidden="true" />
                  ล้างที่เลือก
                </button>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {cleanActionOptions(formSettings.actionOptions)
                .filter((name) => !formSettings.hiddenActionOptions.includes(name))
                .map((name) => {
                  const active = !excludedActionOptions.includes(name);
                  const mandatory = formSettings.lockedActionOptions.includes(name);
                  return (
                  <button
                    key={name}
                    type="button"
                    onClick={() => toggleActiveAction(name)}
                    disabled={mandatory}
                    aria-pressed={active}
                    title={
                      mandatory
                        ? "รายการนี้ถูกล็อกให้บังคับเลือกเสมอทุกครั้งที่พิมพ์ — ปิดใช้งานไม่ได้"
                        : active
                        ? "คลิกเพื่อไม่ใช้รายการนี้ในรอบนี้"
                        : "คลิกเพื่อใช้รายการนี้ในรอบนี้"
                    }
                    className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                      mandatory
                        ? "cursor-default border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300"
                        : active
                        ? "border-zinc-200 bg-white text-zinc-700 shadow-sm dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
                        : "border-dashed border-zinc-200 bg-transparent text-zinc-400 line-through dark:border-zinc-700 dark:text-zinc-500"
                    }`}
                  >
                    <span
                      className={`h-2.5 w-2.5 shrink-0 rounded-full bg-[var(--seg-c)] dark:bg-[var(--seg-c-dark)] ${active ? "" : "opacity-30"}`}
                      style={actionColorStyle(colorForAction(name))}
                      aria-hidden="true"
                    />
                    {name}
                    {mandatory ? (
                      <Lock size={12} strokeWidth={2.5} aria-hidden="true" />
                    ) : active ? (
                      <Check size={12} strokeWidth={2.5} aria-hidden="true" />
                    ) : (
                      <X size={12} strokeWidth={2.5} aria-hidden="true" />
                    )}
                  </button>
                );
              })}
            </div>
            {printActionOptions.length === 0 && (
              <p role="alert" className="text-xs text-amber-600 dark:text-amber-400">
                ยังไม่ได้เลือกรายการดำเนินการสำหรับรอบนี้เลย — แบบฟอร์มที่พิมพ์จะไม่มีช่องติ๊กการดำเนินการ
              </p>
            )}
          </div>

          {/* Month-strip popup — a small centered modal listing the
              maintenance tasks for whichever tick was clicked (see
              monthPopup state above). Click-only, same
              backdrop-click-to-close pattern as showSettings/showAdjustModal
              below — deliberately NOT a hover-following tooltip (an earlier
              version was, and a tooltip rendered close enough to the cursor
              ended up stealing the mouseleave/mouseenter pair from the tick
              underneath it, looping open→close→open fast enough to crash
              the tab). A modal has no hover state to fight over. */}
          {monthPopup && (
            <div
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
              onClick={() => setMonthPopup(null)}
              role="presentation"
            >
              <div
                className={`${CARD} flex max-h-[70vh] w-full max-w-sm flex-col overflow-hidden`}
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-center justify-between gap-3 border-b border-emerald-900/10 px-4 py-3 dark:border-emerald-400/10">
                  <div>
                    <p className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">
                      {THAI_MONTHS_FULL[monthPopup.month]} {maintenanceYearFilter || String(new Date().getFullYear() + 543)}
                    </p>
                    {(() => {
                      const item = items.find((it) => it.rowNumber === monthPopup.rowNumber);
                      return item ? (
                        <p className="text-xs text-zinc-400 dark:text-zinc-500">
                          {[item.equipmentType, item.assetNumber].filter(Boolean).join(" · ") || "—"}
                        </p>
                      ) : null;
                    })()}
                  </div>
                  <button
                    type="button"
                    onClick={() => setMonthPopup(null)}
                    className="rounded-full p-1 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800"
                    aria-label="ปิด"
                  >
                    <X size={16} strokeWidth={2} aria-hidden="true" />
                  </button>
                </div>
                <div className="flex flex-1 flex-col gap-2 overflow-y-auto p-4 text-sm">
                  {(monthlyTasks[monthPopup.rowNumber]?.[monthPopup.month] ?? []).length === 0 ? (
                    <p className="text-zinc-400">ไม่มีการบำรุงรักษาในเดือนนี้</p>
                  ) : (
                    <ul className="flex flex-col gap-2">
                      {(monthlyTasks[monthPopup.rowNumber]?.[monthPopup.month] ?? []).map((t, i) => (
                        <li key={i} className="flex flex-col gap-1 rounded-lg border border-zinc-100 p-2 dark:border-zinc-800">
                          <div className="flex items-start gap-1.5">
                            {t.status === "in_progress" ? (
                              <Wrench size={13} strokeWidth={2} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
                            ) : (
                              <CheckCircle2 size={13} strokeWidth={2} className="mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
                            )}
                            <span className="text-zinc-700 dark:text-zinc-300">
                              {formatThaiDate((t.status === "in_progress" ? t.createdAt : t.completedAt || t.createdAt).slice(0, 10))} — {t.displayName}
                              {t.status === "in_progress" && " (กำลังดำเนินการ)"}
                            </span>
                          </div>
                          {t.actionsTaken.length === 0 && t.inspectionChecks.length === 0 ? (
                            <p className="pl-[19px] text-xs text-zinc-400 italic">ยังไม่ได้บันทึกรายละเอียดการดำเนินการ</p>
                          ) : (
                            <>
                              {t.actionsTaken.length > 0 && (
                                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pl-[19px] text-xs text-zinc-500 dark:text-zinc-400">
                                  <span className="font-medium text-zinc-600 dark:text-zinc-300">การดำเนินการ:</span>
                                  {t.actionsTaken.map((name, actionIdx) => (
                                    <span key={actionIdx} className="inline-flex items-center gap-1">
                                      <span
                                        className="inline-block h-2 w-2 shrink-0 rounded-full bg-[var(--seg-c)] dark:bg-[var(--seg-c-dark)]"
                                        style={actionColorStyle(colorForAction(name))}
                                        aria-hidden="true"
                                      />
                                      {name.trim()}
                                    </span>
                                  ))}
                                </div>
                              )}
                              {t.inspectionChecks.length > 0 && (
                                <p className="pl-[19px] text-xs text-zinc-500 dark:text-zinc-400">
                                  <span className="font-medium text-zinc-600 dark:text-zinc-300">ผลตรวจสอบโดย IT:</span>{" "}
                                  {formatInspectionResult(t)}
                                </p>
                              )}
                            </>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </div>
          )}

          {showAdjustModal && selectedRows.length > 0 && (
            <div
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
              onClick={() => setShowAdjustModal(false)}
              role="presentation"
            >
              <div
                className={`${CARD} flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden`}
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-center justify-between gap-3 border-b border-emerald-900/10 px-4 py-3 dark:border-emerald-400/10">
                  <div className="flex items-center gap-1.5 text-sm font-semibold text-zinc-800 dark:text-zinc-100">
                    <MapPin size={15} strokeWidth={2} aria-hidden="true" />
                    แก้ไข &quot;สถานที่ตั้ง&quot; / &quot;ผู้รับผิดชอบครุภัณฑ์&quot; ก่อนพิมพ์
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowAdjustModal(false)}
                    className="rounded-full p-1 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800"
                    aria-label="ปิด"
                  >
                    <X size={16} strokeWidth={2} aria-hidden="true" />
                  </button>
                </div>

                <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
                  <div className="flex flex-col gap-2">
                    {selectedRows.map((row) => {
                      const status = rowSaveStatus[row.rowNumber] ?? "idle";
                      return (
                        <div
                          key={row.rowNumber}
                          className="grid grid-cols-1 gap-2 border-b border-zinc-50 pb-2 last:border-0 sm:grid-cols-[1fr_1fr_0.7fr_1fr_auto] dark:border-zinc-800/60"
                        >
                          <span className="self-center text-xs text-zinc-500 dark:text-zinc-400">
                            {row.assetNumber || "—"} · {row.description || "—"}
                          </span>
                          <input
                            type="text"
                            value={row.location}
                            onChange={(e) => updateOverride(row.rowNumber, "location", e.target.value)}
                            placeholder="สถานที่ตั้ง"
                            className={INPUT_CLASS}
                          />
                          <select
                            value={row.titlePrefix}
                            onChange={(e) => updateOverride(row.rowNumber, "titlePrefix", e.target.value)}
                            aria-label="คำนำหน้า"
                            title={
                              row.canSaveResponsiblePerson
                                ? undefined
                                : "ชีตนี้ไม่มีคอลัมน์ชื่อผู้รับผิดชอบครุภัณฑ์ — แก้ไขได้เฉพาะรายงานนี้ บันทึกลงระบบไม่ได้"
                            }
                            className={INPUT_CLASS}
                          >
                            <option value="">คำนำหน้า</option>
                            {TITLE_PREFIX_OPTIONS.map((p) => (
                              <option key={p} value={p}>
                                {p}
                              </option>
                            ))}
                          </select>
                          <input
                            type="text"
                            value={row.nameOnly}
                            onChange={(e) => updateOverride(row.rowNumber, "nameOnly", e.target.value)}
                            placeholder="ชื่อ-นามสกุล"
                            title={
                              row.canSaveResponsiblePerson
                                ? undefined
                                : "ชีตนี้ไม่มีคอลัมน์ชื่อผู้รับผิดชอบครุภัณฑ์ — แก้ไขได้เฉพาะรายงานนี้ บันทึกลงระบบไม่ได้"
                            }
                            className={INPUT_CLASS}
                          />
                          <div className="flex items-center gap-1.5 self-center text-xs">
                            {status === "saving" && (
                              <Loader2 size={14} strokeWidth={2} className="animate-spin text-zinc-400" aria-hidden="true" />
                            )}
                            {status === "saved" && (
                              <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                                <Check size={14} strokeWidth={2} aria-hidden="true" />
                                บันทึกแล้ว
                              </span>
                            )}
                            {status === "error" && (
                              <span className="text-red-600 dark:text-red-400" title={rowSaveError[row.rowNumber]}>
                                บันทึกไม่สำเร็จ
                              </span>
                            )}
                            {hasSavableChange(row) && status !== "saving" && (
                              <button
                                type="button"
                                onClick={() => saveRow(row)}
                                className="inline-flex items-center gap-1 rounded-full border border-zinc-200 px-2 py-1 font-medium text-zinc-600 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                              >
                                <Save size={12} strokeWidth={2} aria-hidden="true" />
                                บันทึก
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div className="flex items-center gap-3 border-t border-emerald-900/10 px-4 py-3 dark:border-emerald-400/10">
                  <button
                    type="button"
                    onClick={saveAllChanged}
                    disabled={dirtyRowCount === 0 || savingAll}
                    className="inline-flex items-center gap-2 rounded-full bg-gradient-to-r from-[var(--brand)] to-[var(--brand-2)] px-5 py-2.5 text-sm font-semibold text-[var(--brand-contrast)] shadow-sm transition-colors hover:from-[var(--brand-strong)] disabled:opacity-60"
                  >
                    {savingAll ? (
                      <Loader2 size={16} strokeWidth={2} className="animate-spin" aria-hidden="true" />
                    ) : (
                      <Save size={16} strokeWidth={2} aria-hidden="true" />
                    )}
                    บันทึกข้อมูลที่แก้ไขลงระบบ{dirtyRowCount > 0 ? ` (${dirtyRowCount})` : ""}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* The printable form itself — kept visible on screen too (as a live
            preview) so what ends up on paper is never a surprise. The fixed
            print font (PRINT_FONT_FAMILY) applies to the whole page, and
            the configured line-height (ReportSettings.printLineHeight)
            applies here too and is inherited by everything under it EXCEPT
            the equipment table below (its own leading-snug class wins over
            the inherited value — see printTableFontSizePx) — so the live
            preview matches what actually prints, same reasoning as
            everything else on this page staying visible pre-print. */}
        <div
          className="print-area relative rounded-2xl border border-zinc-200 bg-white p-8 text-zinc-900 shadow-sm print:rounded-none print:border-0 print:p-0 print:shadow-none dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100"
          style={{ fontFamily: PRINT_FONT_FAMILY, lineHeight: lineHeightRatio }}
        >
          {/* Per the hospital's request, a reprinted copy stays visibly
              marked as such — including the date it was reprinted, not
              just the original วันที่ดำเนินการ below — so anyone reviewing
              it later can tell it's a reissued copy rather than a second
              original. Pinned to the page's own top-right corner (small,
              out of the way of the centered header text) rather than sitting
              inline under the header — note this is still inside OUR page
              content, not the browser's own print header/footer strip
              (the date/title line Chrome adds above the page when
              "Headers and footers" is on in the print dialog) — a page has
              no way to draw into that browser-owned area. */}
          {isReprint && (
            <p className="absolute right-3 top-3 text-[9px] text-red-600 print:right-0 print:top-0">
              (พิมพ์ซ้ำเมื่อ {formatThaiDate(new Date().toISOString().slice(0, 10))})
            </p>
          )}
          {/* No line-height override here anymore — this block just
              inherits ReportSettings.printLineHeight (lineHeightRatio)
              from the print-area container above it, same as the "ข้อมูล
              ครุภัณฑ์..." heading/date-time line below and the signature
              blocks further down, so all three are now tuned together by
              that one setting instead of each carrying its own
              hard-coded value. gap-0 removes the flex gap entirely so
              line-height alone controls the space between these lines.
              fontSize comes from ReportSettings.printHeaderFontSizePt
              (see headerFontSizePt above), its own separate control. */}
          <div className="flex flex-col items-center gap-0 text-center" style={{ fontSize: `${headerFontSizePt}pt` }}>
            <p className="font-bold">{formSettings.orgName}</p>
            <p className="font-bold">{formSettings.maintenanceFormTitle}</p>
            <p>{formSettings.fiscalYearLabel}</p>
            {formDepartment && <p className="mt-0.5">กลุ่มงาน: {formDepartment}</p>}
          </div>

          <div className="mt-4">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2 print:hidden">
              <p className="font-semibold" style={{ fontSize: `${bodyFontSizePt}pt` }}>
                ข้อมูลครุภัณฑ์ที่ดำเนินการบำรุงรักษา
              </p>
              {/* Screen-only controls (print:hidden) — a one-off "measure
                  and fit now" action, not a live setting, so it never
                  shows up on the printed page itself. See
                  computeAutoTableColumnWidths/autoFitTableColumns above
                  for what it actually does. */}
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={autoFitTableColumns}
                  disabled={selectedRows.length === 0}
                  title={
                    selectedRows.length === 0
                      ? "เลือกรายการครุภัณฑ์ก่อนจึงจะปรับความกว้างคอลัมน์ได้"
                      : "วัดความกว้างข้อความจริงของแต่ละคอลัมน์ในรายการที่เลือกอยู่ แล้วปรับสัดส่วนให้พอดี"
                  }
                  className="inline-flex items-center gap-1.5 rounded-full border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-600 transition-colors hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                >
                  <Sparkles size={13} strokeWidth={2} aria-hidden="true" />
                  ปรับความกว้างคอลัมน์ให้พอดีอัตโนมัติ
                </button>
                {tableColumnWidths && (
                  <button
                    type="button"
                    onClick={() => setTableColumnWidths(null)}
                    title="คืนความกว้างคอลัมน์กลับเป็นค่าเริ่มต้น"
                    className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-500 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
                  >
                    <X size={12} strokeWidth={2.5} aria-hidden="true" />
                    คืนค่าเริ่มต้น
                  </button>
                )}
              </div>
            </div>
            <table
              className="w-full border-collapse leading-snug"
              style={{ fontSize: `${tableBaseFontSizePx}px` }}
            >
              <colgroup>
                {(tableColumnWidths ?? DEFAULT_TABLE_COLUMN_WIDTHS).map((pct, i) => (
                  <col key={i} style={{ width: `${pct}%` }} />
                ))}
              </colgroup>
              <thead>
                <tr>
                  <th className="border border-zinc-400 px-1 py-1 font-medium">ลำดับ</th>
                  <th className="border border-zinc-400 px-1 py-1 font-medium">หมายเลขครุภัณฑ์</th>
                  <th className="border border-zinc-400 px-1 py-1 font-medium">รายการครุภัณฑ์</th>
                  <th className="border border-zinc-400 px-1 py-1 font-medium">สถานที่ตั้ง</th>
                  <th className="border border-zinc-400 px-1 py-1 font-medium">ผู้รับผิดชอบครุภัณฑ์</th>
                  <th className="border border-zinc-400 px-1 py-1 font-medium">การดำเนินการ</th>
                  <th className="border border-zinc-400 px-1 py-1 font-medium">ผลการตรวจสอบโดย IT</th>
                </tr>
              </thead>
              <tbody>
                {selectedRows.map((row, i) => (
                  <tr key={row.rowNumber}>
                    <td className="border border-zinc-400 px-1 py-1 text-center align-top">{i + 1}</td>
                    <td
                      className="border border-zinc-400 px-1 py-1 align-top whitespace-nowrap"
                      style={{ fontSize: `${tableSecondaryFontSizePx}px` }}
                    >
                      {row.assetNumber || "—"}
                    </td>
                    <td className="border border-zinc-400 px-1 py-1 align-top">
                      <div className="font-medium">{row.equipmentType || "—"}</div>
                      {row.brandModel && (
                        <div
                          className="leading-snug text-zinc-500"
                          style={{ fontSize: `${tableTertiaryFontSizePx}px` }}
                        >
                          {row.brandModel}
                        </div>
                      )}
                    </td>
                    <td className="border border-zinc-400 px-1 py-1 align-top">
                      {row.department && (
                        <div
                          className="leading-snug text-zinc-500"
                          style={{ fontSize: `${tableTertiaryFontSizePx}px` }}
                        >
                          {row.department}
                        </div>
                      )}
                      <div>{row.location || "—"}</div>
                    </td>
                    <td className="border border-zinc-400 px-1 py-1 align-top">{row.responsiblePerson || "—"}</td>
                    <td
                      className="border border-zinc-400 px-1 py-1 align-top leading-snug"
                      style={{ fontSize: `${tableSecondaryFontSizePx}px` }}
                    >
                      <div className="flex flex-col gap-0.5">
                        {printActionOptions.map((name) => (
                          <span key={name}>
                            ☐ {actionLabelForPrint(name, formSettings.detailRequiredActionOptions)}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="border border-zinc-400 px-1 py-1 align-top">
                      <div
                        className="grid grid-cols-2 gap-x-1 gap-y-0.5 whitespace-nowrap"
                        style={{ fontSize: `${tableSecondaryFontSizePx}px` }}
                      >
                        <span>☐ ปกติ</span>
                        <span>☐ เปลี่ยนอะไหล่ ................</span>
                        <span>☐ ส่งซ่อม</span>
                        <span>☐ อื่นๆ ระบุ .....................</span>
                      </div>
                    </td>
                  </tr>
                ))}
                {selectedRows.length === 0 && (
                  <tr>
                    <td colSpan={7} className="border border-zinc-400 px-1.5 py-6 text-center text-zinc-400">
                      ยังไม่ได้เลือกครุภัณฑ์ — เลือกจากรายการด้านบนก่อนพิมพ์
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="mt-4 print:break-inside-avoid" style={{ fontSize: `${bodyFontSizePt}pt` }}>
            <div className="flex flex-wrap gap-x-8 gap-y-2">
              <span>วันที่ดำเนินการ {displayDate || "............................................."}</span>
              <span>ช่วงเวลา {timeRangeLabel || "....................."}</span>
              <span>ผู้ดำเนินการ {currentUser.displayName || currentUser.username}</span>
            </div>
          </div>

          {/* One "ผู้ตรวจสอบ" block per department represented in the
              selection (see selectedDepartments above), plus ผู้รับทราบ as
              the final block in the very same grid — so with one
              department it pairs up naturally as ผู้ตรวจสอบ-left /
              ผู้รับทราบ-right instead of ผู้รับทราบ always being forced onto
              its own row below (wasting the row's other half). Lets one
              printout cover several departments' PM visits in a single day.
              print:break-inside-avoid on each block stops a page break from
              ever landing mid-signature; an odd one out (here, whichever
              block ends up alone) spans both columns instead of sitting
              lopsided in a half-filled row. */}
          <div
            className="grid grid-cols-1 gap-x-8 text-center sm:grid-cols-2"
            style={{
              fontSize: `${bodyFontSizePt}pt`,
              // marginTop + rowGap replace this grid's old fixed mt-6/
              // gap-y-8 (24px/32px) — both now driven by the one
              // ReportSettings.printSignatureGapPx control (see
              // signatureGapPx above) instead of being hard-coded, so a
              // hospital can tighten the two blank areas it reported as
              // wasteful (and reclaim margin a signature section
              // occasionally needed to spill onto a second printed page
              // for) without a code change. gap-x-8 (the column gap
              // between left/right blocks) deliberately stays fixed —
              // only the vertical blank space was reported as excessive.
              marginTop: `${signatureGapPx}px`,
              rowGap: `${signatureGapPx}px`,
            }}
          >
            {signatureBlocks.map((block, idx) => (
              <div
                key={block.key}
                className={`flex flex-col items-center gap-0.5 print:break-inside-avoid ${
                  signatureBlocks.length % 2 === 1 && idx === signatureBlocks.length - 1 ? "sm:col-span-2" : ""
                }`}
              >
                {/* pt-6 leaves blank room above the dotted line for an
                    actual pen signature — the dots alone (no space above
                    them) left no room to sign without touching the block
                    above. No line-height class here anymore — like the
                    page header, this now just inherits
                    ReportSettings.printLineHeight (lineHeightRatio) from
                    the print-area container, so the four lines below
                    (name/ตำแหน่ง/กลุ่มงาน) stay tight without a class of
                    their own to keep in sync. */}
                <p className="pt-6">{block.heading}</p>
                <p>{block.nameLine}</p>
                <p>{block.positionLine}</p>
                <p>{block.subLabel}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Actions for the preview above — moved below it (rather than the
            page header) so they read as "do this to the form you just
            reviewed" instead of being disconnected from it up top. */}
        <div className="no-print flex flex-col items-end gap-2 print:hidden">
          {taskCreateError && (
            <p role="alert" className="text-xs text-red-600 dark:text-red-400">
              {taskCreateError}
            </p>
          )}
          <div className="flex flex-wrap items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowAdjustModal(true)}
              disabled={selectedRows.length === 0}
              title={selectedRows.length === 0 ? "เลือกครุภัณฑ์อย่างน้อย 1 รายการก่อน" : undefined}
              className="inline-flex items-center gap-1.5 rounded-full border border-zinc-200 px-4 py-2 text-sm font-medium text-zinc-600 transition-colors hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              <MapPin size={16} strokeWidth={2} aria-hidden="true" />
              แก้ไขสถานที่ตั้ง / ผู้รับผิดชอบ
              {dirtyRowCount > 0 && (
                <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-500 px-1 text-xs font-semibold text-white">
                  {dirtyRowCount}
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={handlePrint}
              disabled={selectedRows.length === 0 || creatingTasks}
              className="inline-flex items-center gap-1.5 rounded-full bg-gradient-to-r from-[var(--brand)] to-[var(--brand-2)] px-4 py-2 text-sm font-medium text-[var(--brand-contrast)] transition-colors hover:from-[var(--brand-strong)] disabled:opacity-50"
            >
              {creatingTasks ? (
                <Loader2 size={16} strokeWidth={2} className="animate-spin" aria-hidden="true" />
              ) : (
                <PrinterIcon size={16} strokeWidth={2} aria-hidden="true" />
              )}
              {isReprint ? "พิมพ์ซ้ำ / บันทึกเป็น PDF (ไม่สร้างงานใหม่)" : "พิมพ์ / บันทึกเป็น PDF"}
            </button>
          </div>
        </div>
      </div>

      <style>{`
        @media print {
          @page { size: A4 ${orientation}; margin: 14mm; }
          html, body { background: #fff !important; }
          .no-print { display: none !important; }
          .print-area, .print-area * { color: #000 !important; border-color: #52525b !important; }
          .print-area tr { break-inside: avoid; }
        }
      `}</style>
    </main>
    </AppShell>
  );
}
