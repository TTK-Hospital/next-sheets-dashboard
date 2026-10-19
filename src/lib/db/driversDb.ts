import type { Driver } from "@/lib/booking";
import { getSupabaseClient } from "@/lib/supabaseClient";

// Supabase-backed parallel of the "Drivers" cluster in lib/sheets.ts
// (getDrivers/createDriver/updateDriver). Same exported names/signatures/
// return shapes. Same soft-deactivate convention (active=false, never a
// hard delete) as the original — a past TripOrder's driverName stays a
// plain text snapshot on the trip_orders row, never a live join back to
// this table, so deactivating a driver here never changes how an old
// trip order reads.

interface DriverRow {
  id: string;
  name: string;
  phone: string;
  active: boolean;
  created_at: string;
  created_by_username: string;
}

function rowToDriver(row: DriverRow): Driver {
  return {
    driverId: row.id,
    name: row.name,
    phone: row.phone ?? "",
    active: row.active,
    createdAt: row.created_at,
    createdByUsername: row.created_by_username ?? "",
  };
}

export async function getDrivers(): Promise<Driver[]> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("drivers")
    .select("*")
    .order("created_at", { ascending: true });

  if (error) {
    throw new Error(`อ่านรายชื่อคนขับรถไม่สำเร็จ: ${error.message}`);
  }
  return (data ?? []).map((row) => rowToDriver(row as DriverRow));
}

export async function createDriver(input: {
  name: string;
  phone: string;
  createdByUsername: string;
}): Promise<Driver> {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from("drivers")
    .insert({
      name: input.name,
      phone: input.phone,
      active: true,
      created_by_username: input.createdByUsername,
    })
    .select("*")
    .single();

  if (error || !data) {
    throw new Error(`เพิ่มคนขับรถไม่สำเร็จ: ${error?.message ?? "unknown error"}`);
  }
  return rowToDriver(data as DriverRow);
}

export async function updateDriver(
  driverId: string,
  updates: Partial<Pick<Driver, "name" | "phone" | "active">>
): Promise<Driver> {
  const supabase = getSupabaseClient();

  const patch: Record<string, unknown> = {};
  if (updates.name !== undefined) patch.name = updates.name;
  if (updates.phone !== undefined) patch.phone = updates.phone;
  if (updates.active !== undefined) patch.active = updates.active;

  const { data, error } = await supabase
    .from("drivers")
    .update(patch)
    .eq("id", driverId)
    .select("*")
    .maybeSingle();

  if (error) {
    throw new Error(`บันทึกข้อมูลคนขับรถไม่สำเร็จ: ${error.message}`);
  }
  if (!data) {
    throw new Error("ไม่พบคนขับรายนี้ — อาจถูกลบไปแล้ว");
  }
  return rowToDriver(data as DriverRow);
}
