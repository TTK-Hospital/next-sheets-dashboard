import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, canAccessItDashboard, requestAuditTag, verifySessionToken } from "@/lib/auth";
import { appendEditLog, getEquipmentDataUnredacted, updateEquipmentRow } from "@/lib/sheets";
import { isDeleted, isDisposed, PC_ONLY_FIELD_HEADERS } from "@/lib/fields";

export const dynamic = "force-dynamic";

// Maps each bulk-editable field key onto its index in PC_ONLY_FIELD_HEADERS
// (fields.ts) — every one of these is a คอมพิวเตอร์/โน้ตบุ๊ก-only column
// (the "- C" ยี่ห้อ/รุ่น headers included), matching how /manage/it scopes
// the bulk-select checkbox to the คอมพิวเตอร์/โน้ตบุ๊ก/All-in-One table only.
// A fixed key -> header mapping here — rather than accepting arbitrary
// header strings from the client, the way the general admin edit route
// (/api/manage/records/[rowNumber], which "it" is blocked from entirely)
// does — is a deliberate security boundary: this route is a real expansion
// of what the "it" role can write (see the file-level comment on the
// narrow single-row PATCH route next door, /api/manage/it/records/
// [rowNumber]), so it must only ever be able to reach exactly these
// columns, never one a crafted request happens to name.
const BULK_FIELD_HEADER_INDEX = {
  brand: 0, // ยี่ห้อ (System Manufacturer) - C
  model: 1, // รุ่น (System Model) - C
  processor: 2, // หน่วยประมวลผล (Processor)
  storageType: 3, // ประเภทของหน่วยจัดเก็บข้อมูล (Storage Type)
  storageCapacity: 4, // ขนาดความจุรวมของพื้นที่จัดเก็บข้อมูล (Capacity)
  ramType: 5, // ประเภทของ RAM (RAM Type)
  ramCapacity: 6, // ความจุของ RAM (RAM Capacity)
  ramSpeed: 7, // ความเร็วของ RAM (RAM Speed)
} as const;

type BulkFieldKey = keyof typeof BULK_FIELD_HEADER_INDEX;

interface BulkPatchPayload {
  rowNumbers: number[];
  fields: Partial<Record<BulkFieldKey, string>>;
}

function readPayload(body: unknown): BulkPatchPayload | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;

  if (!Array.isArray(b.rowNumbers) || b.rowNumbers.length === 0) return null;
  const rowNumbers: number[] = [];
  for (const v of b.rowNumbers) {
    if (typeof v !== "number" || !Number.isInteger(v) || v < 2) return null;
    rowNumbers.push(v);
  }
  // Sane upper bound — this hospital's whole inventory is a couple hundred
  // rows; anything past that is almost certainly a client bug, not a real
  // bulk edit.
  if (rowNumbers.length > 300) return null;

  if (!b.fields || typeof b.fields !== "object") return null;
  const rawFields = b.fields as Record<string, unknown>;
  const fields: Partial<Record<BulkFieldKey, string>> = {};
  for (const key of Object.keys(rawFields)) {
    if (!(key in BULK_FIELD_HEADER_INDEX)) return null;
    const v = rawFields[key];
    if (typeof v !== "string") return null;
    fields[key as BulkFieldKey] = v;
  }
  // Reject an empty field set outright rather than silently no-op-ing —
  // almost certainly a client bug if it ever happens (the modal itself
  // requires at least one checked field before it will submit).
  if (Object.keys(fields).length === 0) return null;

  return { rowNumbers, fields };
}

/**
 * Bulk sibling of /api/manage/it/records/[rowNumber] — applies the same
 * set of field changes to many equipment rows at once, so IT can fix e.g.
 * ยี่ห้อ/รุ่น or a RAM/storage spec across a batch of machines in one go
 * instead of one row at a time. Reachable by the same accounts as the rest
 * of /manage/it (canAccessItDashboard): the "it" role and the bootstrap
 * superadmin only.
 *
 * No expectedSnapshotHash check here (unlike the single-row PATCH route) —
 * this reads one fresh snapshot right before applying every row in the
 * batch, so it's always working from current data; a genuine concurrent
 * edit to one of the same rows in the few seconds this takes is an
 * accepted, low-probability edge case for this internal tool rather than
 * something worth a per-row conflict UI.
 *
 * A row that's disposed (or deleted) is always skipped, never edited —
 * mirrors the same lock the single-row edit path enforces (see isDisposed
 * in /api/manage/records/[rowNumber] and the disabled "แก้ไข" button in
 * ManageDashboard) — bulk edit is not a backdoor around that rule.
 */
export async function PATCH(request: NextRequest) {
  const session = verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value);
  if (!session) {
    return NextResponse.json({ error: "กรุณาเข้าสู่ระบบ" }, { status: 401 });
  }
  if (!canAccessItDashboard(session)) {
    return NextResponse.json({ error: "ไม่มีสิทธิ์เข้าถึงหน้านี้" }, { status: 403 });
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

    const updated: { rowNumber: number; values: Record<string, string> }[] = [];
    const skipped: { rowNumber: number; reason: string }[] = [];
    const timestamp = new Date().toISOString();
    const auditTag = requestAuditTag(request);
    const fieldKeys = Object.keys(payload.fields) as BulkFieldKey[];

    for (const rowNumber of payload.rowNumbers) {
      const record = snapshot.rows.find((r) => r.rowNumber === rowNumber);
      if (!record || isDeleted(record.data, snapshot.fields)) {
        skipped.push({ rowNumber, reason: "ไม่พบรายการนี้ — อาจถูกย้ายหรือลบไปแล้ว" });
        continue;
      }
      if (isDisposed(record.data, snapshot.fields)) {
        skipped.push({ rowNumber, reason: "รายการนี้จำหน่ายแล้ว ไม่สามารถแก้ไขได้" });
        continue;
      }

      const nextValues: Record<string, string> = { ...record.data };
      const changes: { header: string; oldValue: string; newValue: string }[] = [];

      for (const key of fieldKeys) {
        const candidate = PC_ONLY_FIELD_HEADERS[BULK_FIELD_HEADER_INDEX[key]];
        const header = snapshot.headers.find((h) => h.trim() === candidate.trim());
        if (!header) continue; // this sheet doesn't have that column — skip just this one field
        const newValue = (payload.fields[key] ?? "").trim();
        const oldValue = record.data[header] ?? "";
        nextValues[header] = newValue;
        if (oldValue !== newValue) changes.push({ header, oldValue, newValue });
      }

      if (changes.length === 0) {
        updated.push({ rowNumber, values: nextValues });
        continue;
      }

      await updateEquipmentRow(rowNumber, snapshot.headers, nextValues);

      const department = snapshot.fields.department ? (record.data[snapshot.fields.department] ?? "") : "";
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

      updated.push({ rowNumber, values: nextValues });
    }

    return NextResponse.json({ updated, skipped });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
