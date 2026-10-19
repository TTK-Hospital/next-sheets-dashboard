import { getSupabaseClient } from "@/lib/supabaseClient";

// ---------------------------------------------------------------------------
// Supabase-backed replacement for the EditLog section of lib/sheets.ts
// (EditLogAction / appendEditLog). Parallel implementation — does NOT
// touch lib/sheets.ts.
//
// The old Sheets version stored everything in a Key-ordered flat row:
// เวลา | การกระทำ | ผู้ทำรายการ | กลุ่มงาน | แถวที่ | คอลัมน์ | ค่าเดิม | ค่าใหม่
// The new edit_log table (see supabase/schema.sql) has the same fields as
// real columns, plus an equipment_id uuid FK (nullable) that the Sheets
// version had no equivalent for — left unset here since this layer only
// ever receives a legacy rowNumber from callers, same as the old function's
// signature. A future caller that has the real equipment id handy can set
// it directly; that's additive and doesn't change this function's contract.
// ---------------------------------------------------------------------------

// Identical union to lib/sheets.ts's EditLogAction — kept as its own
// type here (not imported from lib/sheets.ts) so this module has zero
// dependency on the Sheets implementation, per the migration's
// keep-the-old-system-untouched-and-independent requirement. Any future
// single source of truth for this union should move to a shared,
// dependency-free module (e.g. lib/editLog.ts) rather than either file
// importing from the other.
export type EditLogAction =
  | "แก้ไข"
  | "แก้ไข (IT)"
  | "เพิ่มใหม่"
  | "จำหน่าย"
  | "ยกเลิกการจำหน่าย"
  | "ลบรายการ"
  | "จัดการผู้ใช้"
  | "เข้าสู่ระบบสำเร็จ"
  | "เข้าสู่ระบบล้มเหลว"
  | "ออกจากระบบ"
  | "รีเซ็ตรหัสผ่านสำเร็จ"
  | "รีเซ็ตรหัสผ่านล้มเหลว"
  | "เพิ่มทรัพยากรจอง"
  | "แก้ไขทรัพยากรจอง"
  | "เพิ่มคนขับรถ"
  | "แก้ไขคนขับรถ"
  | "จองทรัพยากร"
  | "ยกเลิกการจอง"
  | "อนุมัติการจองรถ"
  | "ไม่อนุมัติการจองรถ"
  | "ปฏิเสธการจองรถ"
  | "ออกใบสั่งงานเดินทาง"
  | "แก้ไขใบสั่งงานเดินทาง"
  | "แยกรายการออกจากใบสั่งงานเดินทาง"
  | "แก้ไขข้อมูลการจองโดยฝ่ายบริหาร"
  | "ผอ. เข้าสู่ระบบสำเร็จ"
  | "ผอ. เข้าสู่ระบบล้มเหลว"
  | "ผอ. รีเซ็ตรหัสผ่านสำเร็จ"
  | "ผอ. รีเซ็ตรหัสผ่านล้มเหลว"
  | "ผอ. รับทราบการเดินทาง"
  | "ผอ. ไม่รับทราบการเดินทาง"
  | "ผอ. อนุมัติการเดินทาง"
  | "ผอ. ไม่อนุมัติการเดินทาง"
  | "ผอ. ตีกลับใบสั่งงานเดินทาง";

/** Supabase equivalent of appendEditLog() — inserts one edit_log row.
 * Signature matches the Sheets version exactly (rowNumber/column optional,
 * same field names) so call sites don't need any changes beyond the
 * import. rowNumber maps onto legacy_row_number on the table; there is no
 * attempt here to resolve it to an equipment_id FK (see file header). */
export async function appendEditLog(entry: {
  timestamp: string;
  action: EditLogAction;
  actor: string;
  department: string;
  rowNumber?: number;
  column?: string;
  oldValue: string;
  newValue: string;
}): Promise<void> {
  const supabase = getSupabaseClient();
  const { error } = await supabase.from("edit_log").insert({
    timestamp: entry.timestamp,
    action: entry.action,
    actor: entry.actor,
    department: entry.department || null,
    legacy_row_number: entry.rowNumber ?? null,
    column_name: entry.column ?? null,
    old_value: entry.oldValue,
    new_value: entry.newValue,
  });
  if (error) throw new Error(`บันทึกประวัติการแก้ไขไม่สำเร็จ: ${error.message}`);
}
