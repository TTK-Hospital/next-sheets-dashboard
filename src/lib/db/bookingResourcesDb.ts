import type { BookingResource, BookingResourceType } from "@/lib/booking";
import { getSupabaseClient } from "@/lib/supabaseClient";

// Supabase-backed parallel of the "BookingResources" cluster in
// lib/sheets.ts (getBookingResources/createBookingResource/
// updateBookingResource). Same exported names/signatures/return shapes.

interface BookingResourceRow {
  id: string;
  type: string;
  name: string;
  detail: string;
  active: boolean;
  image_data_url: string;
  seat_count: number;
  created_at: string;
  created_by_username: string;
}

function rowToResource(row: BookingResourceRow): BookingResource {
  return {
    resourceId: row.id,
    type: row.type as BookingResourceType,
    name: row.name,
    detail: row.detail ?? "",
    active: row.active,
    createdAt: row.created_at,
    createdByUsername: row.created_by_username ?? "",
    imageDataUrl: row.image_data_url ?? "",
    seatCount: row.seat_count ?? 0,
  };
}

/** Every resource (active + deactivated) — callers filter by `active`
 * themselves, same rationale as the original getBookingResources. */
export async function getBookingResources(): Promise<BookingResource[]> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("booking_resources")
    .select("*")
    .order("created_at", { ascending: true });

  if (error) {
    throw new Error(`อ่านรายการรถ/ห้องประชุมไม่สำเร็จ: ${error.message}`);
  }
  return (data ?? []).map((row) => rowToResource(row as BookingResourceRow));
}

/** Adds one new vehicle or meeting room. seatCount is only meaningful for
 * type "car" — always stored as 0 for a room regardless of what's passed
 * in, same rule as the original createBookingResource. */
export async function createBookingResource(input: {
  type: BookingResourceType;
  name: string;
  detail: string;
  createdByUsername: string;
  imageDataUrl: string;
  seatCount: number;
}): Promise<BookingResource> {
  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .from("booking_resources")
    .insert({
      type: input.type,
      name: input.name,
      detail: input.detail,
      active: true,
      image_data_url: input.imageDataUrl,
      seat_count: input.type === "car" ? input.seatCount : 0,
      created_by_username: input.createdByUsername,
    })
    .select("*")
    .single();

  if (error || !data) {
    throw new Error(`เพิ่มรถ/ห้องประชุมไม่สำเร็จ: ${error?.message ?? "unknown error"}`);
  }
  return rowToResource(data as BookingResourceRow);
}

/** Merges `updates` into the resource identified by `resourceId`.
 * Renaming/editing detail never touches past bookings' snapshotted
 * resourceName (those live as plain text columns on the bookings/
 * trip_orders rows, never a live join) — same as the original. */
export async function updateBookingResource(
  resourceId: string,
  updates: Partial<Pick<BookingResource, "name" | "detail" | "active" | "imageDataUrl" | "seatCount">>
): Promise<BookingResource> {
  const supabase = getSupabaseClient();

  const patch: Record<string, unknown> = {};
  if (updates.name !== undefined) patch.name = updates.name;
  if (updates.detail !== undefined) patch.detail = updates.detail;
  if (updates.active !== undefined) patch.active = updates.active;
  if (updates.imageDataUrl !== undefined) patch.image_data_url = updates.imageDataUrl;
  if (updates.seatCount !== undefined) patch.seat_count = updates.seatCount;

  const { data, error } = await supabase
    .from("booking_resources")
    .update(patch)
    .eq("id", resourceId)
    .select("*")
    .maybeSingle();

  if (error) {
    throw new Error(`บันทึกรถ/ห้องประชุมไม่สำเร็จ: ${error.message}`);
  }
  if (!data) {
    throw new Error("ไม่พบรายการนี้ — อาจถูกลบไปแล้ว");
  }
  return rowToResource(data as BookingResourceRow);
}
