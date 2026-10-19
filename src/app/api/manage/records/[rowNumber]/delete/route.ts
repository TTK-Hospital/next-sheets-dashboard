import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, requestAuditTag, verifySessionToken } from "@/lib/auth";
import { appendEditLog, getEquipmentDataUnredacted, setEquipmentStatus } from "@/lib/sheets";
import { STATUS_DELETED, isDeleted } from "@/lib/fields";
import { hasPermission } from "@/lib/permissions";

export const dynamic = "force-dynamic";

function fieldValue(row: Record<string, string>, header: string | null): string {
  if (!header) return "";
  return (row[header] ?? "").trim();
}

/** Hides ("ลบ") one equipment row — restricted to the single env-configured
 * bootstrap account, not merely any superadmin, per the hospital's request.
 * Backed by hasPermission()'s "deleteEquipment" key (see lib/permissions.ts)
 * rather than a hardcoded isBootstrap check for consistency with every other
 * migrated check, but this stays bootstrap-only in practice: deleteEquipment
 * is one of the six keys in NON_GRANTABLE_KEYS that a per-account override
 * can never grant to anyone else. This is still a soft delete: only the
 * status column changes
 * (setEquipmentStatus never removes a row), so the row is never physically
 * destroyed and stays recoverable by editing the sheet directly — but the
 * app hides it from every table (public dashboard and /manage) and excludes
 * it from every report from this point on. Can be applied to an active or
 * already-disposed row; a row already deleted is treated as not found (it's
 * already hidden). */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ rowNumber: string }> }
) {
  const session = verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value);
  if (!session) {
    return NextResponse.json({ error: "กรุณาเข้าสู่ระบบ" }, { status: 401 });
  }
  if (!hasPermission(session, "deleteEquipment")) {
    return NextResponse.json(
      { error: "เฉพาะบัญชีผู้ดูแลระบบหลักเท่านั้นที่ลบรายการครุภัณฑ์ได้" },
      { status: 403 }
    );
  }

  const { rowNumber: rowNumberParam } = await params;
  const rowNumber = Number(rowNumberParam);
  if (!Number.isInteger(rowNumber) || rowNumber < 2) {
    return NextResponse.json({ error: "หมายเลขแถวไม่ถูกต้อง" }, { status: 400 });
  }

  try {
    const snapshot = await getEquipmentDataUnredacted();
    if (!snapshot.fields.status) {
      return NextResponse.json(
        { error: 'ยังไม่มีคอลัมน์ "สถานะ" ในชีต' },
        { status: 400 }
      );
    }
    const record = snapshot.rows.find((r) => r.rowNumber === rowNumber);
    if (!record || isDeleted(record.data, snapshot.fields)) {
      return NextResponse.json({ error: "ไม่พบรายการนี้ — อาจถูกลบไปแล้ว" }, { status: 404 });
    }

    const previousStatus = fieldValue(record.data, snapshot.fields.status);
    await setEquipmentStatus(rowNumber, snapshot.fields.status, STATUS_DELETED);

    try {
      await appendEditLog({
        timestamp: new Date().toISOString(),
        action: "ลบรายการ",
        actor: session.username,
        department: fieldValue(record.data, snapshot.fields.department),
        rowNumber,
        column: snapshot.fields.status,
        oldValue: previousStatus,
        newValue: `${STATUS_DELETED} ${requestAuditTag(request)}`,
      });
    } catch (logErr: unknown) {
      console.error("appendEditLog failed:", logErr);
    }

    return NextResponse.json({ rowNumber });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
