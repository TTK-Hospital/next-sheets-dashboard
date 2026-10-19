import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, canAccessEquipmentRegistry, requestAuditTag, verifySessionToken } from "@/lib/auth";
import { appendEditLog, appendEquipmentRow, getEquipmentDataUnredacted } from "@/lib/sheets";
import { STATUS_ACTIVE, findDuplicateAssetNumberRow, isDeleted } from "@/lib/fields";
import { hasPermission } from "@/lib/permissions";
import { rowSnapshotHash } from "@/lib/recordHash";

// Always live — reveals unredacted data behind an auth check and accepts
// writes, never something to cache/prerender.
export const dynamic = "force-dynamic";

function fieldValue(row: Record<string, string>, header: string | null): string {
  if (!header) return "";
  return (row[header] ?? "").trim();
}

/**
 * Renders a new row's "ประทับเวลา" in the exact same raw shape Google
 * Forms itself writes into the sheet — D/M/YYYY, H:MM:SS, Gregorian year,
 * 24-hour clock, no leading zeros on the date (e.g. "27/7/2026, 11:20:58")
 * — so a row added here parses identically to one that came in through
 * the real form. Using `toLocaleString("th-TH", {dateStyle, timeStyle})`
 * here previously wrote an already-Thai-formatted string instead (e.g.
 * "31 ส.ค. 2569 13:32"), which the public dashboard's date-only formatter
 * doesn't recognize as a timestamp to reformat, so it fell back to
 * showing the raw value untouched — time included. Built from
 * Intl.DateTimeFormat parts (not a manually offset Date) so it's immune
 * to DST/offset arithmetic bugs and always reflects Asia/Bangkok wall-clock
 * time regardless of the server's own timezone.
 */
function formatSheetTimestamp(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok",
    day: "numeric",
    month: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("day")}/${get("month")}/${get("year")}, ${get("hour")}:${get("minute")}:${get("second")}`;
}

/**
 * Lists equipment rows scoped by role: superadmin and any account granted
 * "manageEquipmentAllDept" see every row, everyone else sees only rows whose
 * department column matches their own department. proxy.ts already blocks
 * unauthenticated requests to /api/manage/*, but this route re-checks the
 * session itself too — never trust that alone. Also hard-gated on
 * canAccessEquipmentRegistry() (lib/auth.ts): the page-level redirect in
 * /manage/page.tsx is only a UX nicety, this is the actual boundary — an
 * account without base registry access must be refused here even if it
 * reaches this URL directly.
 */
export async function GET(request: NextRequest) {
  const session = verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value);
  if (!session) {
    return NextResponse.json({ error: "กรุณาเข้าสู่ระบบ" }, { status: 401 });
  }
  if (!canAccessEquipmentRegistry(session)) {
    return NextResponse.json({ error: "คุณไม่มีสิทธิ์เข้าถึงทะเบียนครุภัณฑ์คอมพิวเตอร์" }, { status: 403 });
  }

  try {
    const snapshot = await getEquipmentDataUnredacted();
    // Deleted rows (bootstrap-only "ลบรายการ") never reach /manage — hidden
    // from every role, not just filtered out of the UI.
    const notDeleted = snapshot.rows.filter((r) => !isDeleted(r.data, snapshot.fields));
    const scopedRows =
      session.role === "superadmin" || hasPermission(session, "manageEquipmentAllDept")
        ? notDeleted
        : notDeleted.filter((r) => fieldValue(r.data, snapshot.fields.department) === session.department);

    return NextResponse.json({
      tab: snapshot.tab,
      headers: snapshot.headers,
      fields: snapshot.fields,
      role: session.role,
      department: session.department,
      rows: scopedRows.map((r) => ({
        rowNumber: r.rowNumber,
        values: r.data,
        snapshotHash: rowSnapshotHash(snapshot.headers, r.data),
      })),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

function readNewRecordPayload(body: unknown): Record<string, string> | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (!b.values || typeof b.values !== "object") return null;
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(b.values as Record<string, unknown>)) {
    if (typeof value !== "string") return null;
    values[key] = value;
  }
  return values;
}

/** Adds a new equipment row — superadmin by default (see hasPermission's
 * "addEquipment" key in lib/permissions.ts — same unchanged default, now
 * also grantable per account through /manage/users). */
export async function POST(request: NextRequest) {
  const session = verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value);
  if (!session) {
    return NextResponse.json({ error: "กรุณาเข้าสู่ระบบ" }, { status: 401 });
  }
  if (!hasPermission(session, "addEquipment")) {
    return NextResponse.json({ error: "เฉพาะ superadmin เท่านั้นที่เพิ่มรายการใหม่ได้" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "คำขอไม่ถูกต้อง" }, { status: 400 });
  }
  const submitted = readNewRecordPayload(body);
  if (!submitted) {
    return NextResponse.json({ error: "ข้อมูลที่ส่งมาไม่ถูกต้อง" }, { status: 400 });
  }

  try {
    const snapshot = await getEquipmentDataUnredacted();
    const values: Record<string, string> = {};
    for (const header of snapshot.headers) {
      values[header] = submitted[header] ?? "";
    }
    if (snapshot.fields.timestamp && !values[snapshot.fields.timestamp]) {
      values[snapshot.fields.timestamp] = formatSheetTimestamp(new Date());
    }
    if (snapshot.fields.status) {
      values[snapshot.fields.status] = STATUS_ACTIVE;
    }

    if (snapshot.fields.assetNumber) {
      const candidate = values[snapshot.fields.assetNumber] ?? "";
      const duplicateRow = findDuplicateAssetNumberRow(snapshot.rows, snapshot.fields, candidate);
      if (duplicateRow !== null) {
        return NextResponse.json(
          {
            error: `เลขครุภัณฑ์ "${candidate.trim()}" นี้มีอยู่ในระบบแล้ว (แถวที่ ${duplicateRow}) กรุณาตรวจสอบและระบุเลขครุภัณฑ์ใหม่`,
          },
          { status: 409 }
        );
      }
    }

    const { rowNumber } = await appendEquipmentRow(values);

    const summaryParts = [
      snapshot.fields.department && values[snapshot.fields.department],
      snapshot.fields.equipmentType && values[snapshot.fields.equipmentType],
    ].filter(Boolean);
    try {
      await appendEditLog({
        timestamp: new Date().toISOString(),
        action: "เพิ่มใหม่",
        actor: session.username,
        department: (snapshot.fields.department && values[snapshot.fields.department]) || "",
        rowNumber,
        oldValue: "",
        newValue: `${summaryParts.length > 0 ? summaryParts.join(" / ") : `แถวที่ ${rowNumber}`} ${requestAuditTag(request)}`,
      });
    } catch (logErr: unknown) {
      console.error("appendEditLog failed:", logErr);
    }

    return NextResponse.json({
      rowNumber,
      values,
      snapshotHash: rowSnapshotHash(snapshot.headers, values),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
