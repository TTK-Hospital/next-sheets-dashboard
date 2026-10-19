import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, canAccessItDashboard, requestAuditTag, verifySessionToken } from "@/lib/auth";
import { appendEditLog, getEquipmentDataUnredacted, updateEquipmentRow } from "@/lib/sheets";
import { isDeleted, TITLE_PREFIX_OPTIONS } from "@/lib/fields";
import { rowSnapshotHash } from "@/lib/recordHash";

export const dynamic = "force-dynamic";

interface ItRecordPatchPayload {
  installLocation?: string;
  // Sent together as one pair (never independently) — see the
  // responsibleTitlePrefix handling below for why: whichever sheet shape
  // this row uses, writing the name back needs both parts at once.
  responsibleTitlePrefix?: string;
  responsibleName?: string;
  expectedSnapshotHash?: string;
}

function readPayload(body: unknown): ItRecordPatchPayload | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const out: ItRecordPatchPayload = {};
  if (b.installLocation !== undefined) {
    if (typeof b.installLocation !== "string") return null;
    out.installLocation = b.installLocation;
  }
  // The client always sends both halves together when the name changed (see
  // MaintenanceReportBuilder's saveRow) — require both here too rather than
  // guessing what an isolated half would mean.
  if (b.responsibleTitlePrefix !== undefined || b.responsibleName !== undefined) {
    if (typeof b.responsibleTitlePrefix !== "string" || typeof b.responsibleName !== "string") return null;
    if (b.responsibleTitlePrefix && !TITLE_PREFIX_OPTIONS.includes(b.responsibleTitlePrefix)) return null;
    out.responsibleTitlePrefix = b.responsibleTitlePrefix;
    out.responsibleName = b.responsibleName;
  }
  if (b.expectedSnapshotHash !== undefined) {
    if (typeof b.expectedSnapshotHash !== "string") return null;
    out.expectedSnapshotHash = b.expectedSnapshotHash;
  }
  // Reject an empty patch outright rather than silently no-op-ing — almost
  // certainly a client bug if it ever happens.
  if (out.installLocation === undefined && out.responsibleName === undefined) return null;
  return out;
}

/**
 * Narrow, deliberate exception to "it is read-only everywhere" (the general
 * edit route, /api/manage/records/[rowNumber] PATCH, blocks role "it"
 * outright). The maintenance-report screen (/manage/it/report) lets IT
 * staff fix a stale "สถานที่ตั้ง" / "ผู้รับผิดชอบครุภัณฑ์" right before
 * printing, and the hospital asked for that correction to also save back to
 * the sheet instead of only affecting the one printout. This endpoint
 * accepts *only* those two fields — asset number, brand/model, department,
 * equipment type, disposal status, everything else about a row stays
 * completely out of reach through it, so it does not reopen the broader
 * edit surface /manage/it was deliberately scoped away from. Reachable by
 * the same accounts as the rest of /manage/it (see canAccessItDashboard):
 * the "it" role and the bootstrap superadmin only. Logged under the
 * distinct "แก้ไข (IT)" EditLog action so this narrow path is always
 * distinguishable from a regular admin/superadmin edit in the audit trail.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ rowNumber: string }> }
) {
  const session = verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value);
  if (!session) {
    return NextResponse.json({ error: "กรุณาเข้าสู่ระบบ" }, { status: 401 });
  }
  if (!canAccessItDashboard(session)) {
    return NextResponse.json({ error: "ไม่มีสิทธิ์เข้าถึงหน้านี้" }, { status: 403 });
  }

  const { rowNumber: rowNumberParam } = await params;
  const rowNumber = Number(rowNumberParam);
  if (!Number.isInteger(rowNumber) || rowNumber < 2) {
    return NextResponse.json({ error: "หมายเลขแถวไม่ถูกต้อง" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "คำขอไม่ถูกต้อง" }, { status: 400 });
  }
  const payload = readPayload(body);
  if (!payload) {
    return NextResponse.json({ error: "ข้อมูลที่ส่งมาไม่ถูกต้อง" }, { status: 400 });
  }

  try {
    const snapshot = await getEquipmentDataUnredacted();
    const record = snapshot.rows.find((r) => r.rowNumber === rowNumber);
    if (!record || isDeleted(record.data, snapshot.fields)) {
      return NextResponse.json(
        { error: "ไม่พบรายการนี้ — อาจถูกย้ายหรือลบไปแล้ว กรุณารีเฟรชหน้า" },
        { status: 404 }
      );
    }

    if (payload.expectedSnapshotHash) {
      const currentHash = rowSnapshotHash(snapshot.headers, record.data);
      if (currentHash !== payload.expectedSnapshotHash) {
        return NextResponse.json(
          { error: "ข้อมูลถูกแก้ไขโดยคนอื่นระหว่างนี้ กรุณาโหลดข้อมูลใหม่แล้วลองอีกครั้ง" },
          { status: 409 }
        );
      }
    }

    const nextValues: Record<string, string> = { ...record.data };
    const changes: { header: string; oldValue: string; newValue: string }[] = [];

    if (payload.installLocation !== undefined) {
      if (!snapshot.fields.installLocation) {
        return NextResponse.json(
          { error: "ชีตนี้ไม่มีคอลัมน์สถานที่ตั้ง — บันทึกไม่ได้" },
          { status: 400 }
        );
      }
      const header = snapshot.fields.installLocation;
      const oldValue = record.data[header] ?? "";
      const newValue = payload.installLocation.trim();
      nextValues[header] = newValue;
      if (oldValue !== newValue) changes.push({ header, oldValue, newValue });
    }

    if (payload.responsibleName !== undefined) {
      const titlePrefix = (payload.responsibleTitlePrefix ?? "").trim();
      const name = payload.responsibleName.trim();
      // Some sheets split ชื่อ-สกุล into separate คำนำหน้า / ชื่อ-นามสกุล
      // columns instead of one combined question (see fields.ts
      // resolveFields) — write to whichever shape this sheet actually has.
      // A sheet with neither shape at all (shouldn't normally happen; see
      // canSaveResponsiblePerson on the report page) has nowhere to save
      // this, so it's rejected rather than silently dropped.
      if (snapshot.fields.fullNameHeader) {
        const header = snapshot.fields.fullNameHeader;
        const oldValue = record.data[header] ?? "";
        const newValue = [titlePrefix, name].filter(Boolean).join("");
        nextValues[header] = newValue;
        if (oldValue !== newValue) changes.push({ header, oldValue, newValue });
      } else if (snapshot.fields.titlePrefixHeader && snapshot.fields.nameHeader) {
        const prefixHeader = snapshot.fields.titlePrefixHeader;
        const nameHeader = snapshot.fields.nameHeader;
        const oldPrefix = record.data[prefixHeader] ?? "";
        const oldName = record.data[nameHeader] ?? "";
        nextValues[prefixHeader] = titlePrefix;
        nextValues[nameHeader] = name;
        if (oldPrefix !== titlePrefix) changes.push({ header: prefixHeader, oldValue: oldPrefix, newValue: titlePrefix });
        if (oldName !== name) changes.push({ header: nameHeader, oldValue: oldName, newValue: name });
      } else {
        return NextResponse.json(
          { error: "ชีตนี้ไม่มีคอลัมน์ชื่อผู้รับผิดชอบครุภัณฑ์ — บันทึกไม่ได้" },
          { status: 400 }
        );
      }
    }

    if (changes.length === 0) {
      return NextResponse.json({
        rowNumber,
        values: nextValues,
        snapshotHash: rowSnapshotHash(snapshot.headers, nextValues),
      });
    }

    await updateEquipmentRow(rowNumber, snapshot.headers, nextValues);

    const timestamp = new Date().toISOString();
    const department = snapshot.fields.department ? (record.data[snapshot.fields.department] ?? "") : "";
    const auditTag = requestAuditTag(request);
    for (const change of changes) {
      try {
        await appendEditLog({
          timestamp,
          action: "แก้ไข (IT)",
          actor: session.username,
          department,
          rowNumber,
          column: change.header,
          oldValue: change.oldValue,
          newValue: `${change.newValue} ${auditTag}`,
        });
      } catch (logErr: unknown) {
        console.error("appendEditLog failed:", logErr);
      }
    }

    return NextResponse.json({
      rowNumber,
      values: nextValues,
      snapshotHash: rowSnapshotHash(snapshot.headers, nextValues),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
