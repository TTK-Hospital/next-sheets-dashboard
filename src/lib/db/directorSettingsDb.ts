import { getSupabaseClient } from "@/lib/supabaseClient";

// Supabase-backed parallel of the "DirectorSettings" cluster in
// lib/sheets.ts (getDirectorPasswordHash/setDirectorPasswordHash). Same
// exported names/signatures.
//
// director_settings is a singleton table (id boolean PRIMARY KEY DEFAULT
// true CHECK (id)) seeded with exactly one row (password_hash: '') by
// supabase/schema.sql — unlike the old Sheets version, there is no
// "tab/row doesn't exist yet" fallback branch needed here: the row always
// exists from the moment the schema was applied, so a plain UPDATE always
// finds it. getDirectorPasswordHash returning "" (blank hash) still means
// exactly what it meant before: "ผอ. ยังไม่ตั้งรหัสเอง" — login falls back
// to DIRECTOR_BOOTSTRAP_PASSWORD_HASH, unchanged.

export async function getDirectorPasswordHash(): Promise<string> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("director_settings")
    .select("password_hash")
    .eq("id", true)
    .maybeSingle();

  if (error) {
    throw new Error(`อ่านการตั้งค่า ผอ. ไม่สำเร็จ: ${error.message}`);
  }
  return (data?.password_hash ?? "").trim();
}

export async function setDirectorPasswordHash(hash: string): Promise<void> {
  const supabase = getSupabaseClient();
  const { error } = await supabase
    .from("director_settings")
    .update({ password_hash: hash })
    .eq("id", true);

  if (error) {
    throw new Error(`บันทึกรหัสผ่าน ผอ. ไม่สำเร็จ: ${error.message}`);
  }
}
