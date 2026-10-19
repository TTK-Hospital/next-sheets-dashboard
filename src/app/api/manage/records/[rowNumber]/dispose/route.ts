import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, requestAuditTag, verifySessionToken } from "@/lib/auth";
import { appendEditLog, getEquipmentDataUnredacted, setEquipmentStatus } from "@/lib/sheets";
import { STATUS_DISPOSED, isDeleted } from "@/lib/fields";
import { hasPermission } from "@/lib/permissions";

export const dynamic = "force-dynamic";

function fieldValue(row: Record<string, string>, header: string | null): string {
  if (!header) return "";
  return (row[header] ?? "").trim();
}

/** Soft-deletes ("จำหน่าย") one equipment row — superadmin by default (see
 * hasPermission's "disposeRestoreEquipment" key in lib/permissions.ts —
 * same unchanged default, now also grantable per account). Sets the status
 * column rather than removing the row, so the sheet keeps a full history
 * (see fields.ts isDisposed / STATUS_DISPOSED). */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ rowNumber: string }> }
) {
  const session = verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value);
  if (!session) {
    return NextResponse.json({ error: "กรุณาเข้าสู่ระบบ" }, { status: 401 });
  }
  if (!hasPermission(session, "disposeRestoreEquipment")) {
    return NextResponse.json({ error: "เฉพาะ superadmin เท่านั้นที่จำหน่ายครุภัณฑ์ได้" }, { status: 403 });
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
        { error: 'ยังไม่มีคอลัมน์ "สถานะ" ในชีต — เพิ่มคอลัมน์นี้ในชีตก่อนถึงจะใช้การจำหน่ายได้ (ดู README)' },
        { status: 400 }
      );
    }
    const record = snapshot.rows.find((r) => r.rowNumber === rowNumber);
    if (!record || isDeleted(record.data, snapshot.fields)) {
      return NextResponse.json({ error: "ไม่พบรายการนี้ — อาจถูกย้ายหรือลบไปแล้ว" }, { status: 404 });
    }

    const previousStatus = fieldValue(record.data, snapshot.fields.status);
    if (previousStatus === STATUS_DISPOSED) {
      return NextResponse.json({ error: "รายการนี้ถูกจำหน่ายไปแล้ว" }, { status: 409 });
    }

    const updated = await setEquipmentStatus(rowNumber, snapshot.fields.status, STATUS_DISPOSED);

    try {
      await appendEditLog({
        timestamp: new Date().toISOString(),
        action: "จำหน่าย",
        actor: session.username,
        department: fieldValue(record.data, snapshot.fields.department),
        rowNumber,
        column: snapshot.fields.status,
        oldValue: previousStatus,
        newValue: `${STATUS_DISPOSED} ${requestAuditTag(request)}`,
      });
    } catch (logErr: unknown) {
      console.error("appendEditLog failed:", logErr);
    }

    return NextResponse.json({ rowNumber, values: updated });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
