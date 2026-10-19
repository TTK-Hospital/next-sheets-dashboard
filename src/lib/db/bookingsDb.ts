import {
  hasBookingConflict,
  isBookingCancelled,
  isBookingLockedFromEditing,
  type Booking,
  type BookingApprovalStatus,
  type BookingResourceType,
} from "@/lib/booking";
import { getSupabaseClient } from "@/lib/supabaseClient";

// Supabase-backed parallel of the "Bookings" cluster in lib/sheets.ts
// (getBookings/createBooking/cancelBooking/editBookingByManagement). Same
// exported names/signatures/return shapes. Every pure business-rule
// function this relies on (hasBookingConflict, isBookingCancelled,
// isBookingLockedFromEditing) is reused UNCHANGED from lib/booking.ts —
// none of that logic is Sheets-specific, it only ever operates on
// already-shaped Booking objects.
//
// rejectCarBooking: deliberately NOT reimplemented here. It was already
// removed from lib/sheets.ts per the hospital's explicit request ("ด้วย
// ความที่ผู้อนุมัติรถมีเพียงผอ. เท่านั้น... ต้องเอา[สิทธินี้]ออก") — only the
// director may reject a car booking now (see tripOrdersDb.ts's
// setDirectorDecision). That removal is dead-code history, not a gap to
// fill back in.

interface BookingRow {
  id: string;
  resource_id: string | null;
  resource_type: string;
  resource_name: string;
  start_time: string;
  end_time: string;
  purpose: string;
  destination: string;
  participants: number;
  contact_phone: string;
  booked_by_username: string;
  booked_by_display_name: string;
  department: string;
  created_at: string;
  cancelled_at: string | null;
  cancelled_by_username: string | null;
  approval_status: string;
  approved_at: string | null;
  approved_by_username: string | null;
  companions: string;
  trip_order_id: string | null;
  edited_by_username: string | null;
  edited_at: string | null;
  director_approval_status: string;
  director_approved_at: string | null;
  director_note: string;
  director_returned_at: string | null;
}

/** Postgres NULL <-> the app's "" (blank-string) convention for every
 * optional/not-yet-set field on a Booking — the Sheets version used a
 * blank cell for the exact same meaning everywhere (see the long field
 * comments on the Booking interface in lib/booking.ts: "Blank until...").
 * This is the one systematic shape difference the new schema introduces;
 * every other field/value is carried over as-is. */
export function rowToBooking(row: BookingRow): Booking {
  return {
    bookingId: row.id,
    resourceId: row.resource_id ?? "",
    resourceType: row.resource_type as BookingResourceType,
    resourceName: row.resource_name,
    startTime: row.start_time,
    endTime: row.end_time,
    purpose: row.purpose ?? "",
    destination: row.destination ?? "",
    participants: row.participants ?? 0,
    contactPhone: row.contact_phone ?? "",
    bookedByUsername: row.booked_by_username,
    bookedByDisplayName: row.booked_by_display_name ?? "",
    department: row.department ?? "",
    createdAt: row.created_at,
    approvalStatus: row.approval_status as BookingApprovalStatus,
    approvedAt: row.approved_at ?? "",
    approvedByUsername: row.approved_by_username ?? "",
    cancelledAt: row.cancelled_at ?? "",
    cancelledByUsername: row.cancelled_by_username ?? "",
    companions: row.companions ?? "",
    tripOrderId: row.trip_order_id ?? "",
    editedByUsername: row.edited_by_username ?? "",
    editedAt: row.edited_at ?? "",
    directorApprovalStatus: (row.director_approval_status ?? "") as Booking["directorApprovalStatus"],
    directorApprovedAt: row.director_approved_at ?? "",
    directorNote: row.director_note ?? "",
    directorReturnedAt: row.director_returned_at ?? "",
  };
}

/** Every booking (live + cancelled) across every resource — callers filter
 * by resource/type/date range themselves, same "read everything, filter
 * client-side" shape as the original getBookings. */
export async function getBookings(): Promise<Booking[]> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("bookings")
    .select("*")
    .order("created_at", { ascending: true });

  if (error) {
    throw new Error(`อ่านรายการจองไม่สำเร็จ: ${error.message}`);
  }
  return (data ?? []).map((row) => rowToBooking(row as BookingRow));
}

/** Creates one booking. Room bookings confirm immediately and are
 * re-checked for a time conflict against the *current* bookings table
 * right before insert (never trust a conflict check the caller may have
 * done earlier against a stale list — two accounts could race to book the
 * same slot). Car bookings start "pending" and deliberately skip that
 * conflict check — same rule, same reasoning, as the original
 * createBooking in lib/sheets.ts. */
export async function createBooking(input: {
  resourceId: string;
  resourceType: BookingResourceType;
  resourceName: string;
  startTime: string;
  endTime: string;
  purpose: string;
  destination: string;
  participants: number;
  contactPhone: string;
  bookedByUsername: string;
  bookedByDisplayName: string;
  department: string;
  approvalStatus: BookingApprovalStatus;
  companions: string;
}): Promise<Booking> {
  const supabase = getSupabaseClient();

  if (input.resourceType === "room") {
    const existing = await getBookings();
    if (hasBookingConflict(existing, input.resourceId, input.startTime, input.endTime)) {
      throw new Error("ช่วงเวลาที่เลือกถูกจองไปแล้ว กรุณาเลือกช่วงเวลาอื่น");
    }
  }

  const { data, error } = await supabase
    .from("bookings")
    .insert({
      resource_id: input.resourceId || null,
      resource_type: input.resourceType,
      resource_name: input.resourceName,
      start_time: input.startTime,
      end_time: input.endTime,
      purpose: input.purpose,
      destination: input.destination,
      participants: input.participants,
      contact_phone: input.contactPhone,
      booked_by_username: input.bookedByUsername,
      booked_by_display_name: input.bookedByDisplayName,
      department: input.department,
      approval_status: input.approvalStatus,
      companions: input.companions,
    })
    .select("*")
    .single();

  if (error || !data) {
    throw new Error(`บันทึกการจองไม่สำเร็จ: ${error?.message ?? "unknown error"}`);
  }
  return rowToBooking(data as BookingRow);
}

/** Soft-cancels one booking (sets cancelled_at/cancelled_by_username)
 * rather than deleting the row — keeps the slot's history visible, same
 * as the original cancelBooking. The permission check (creator or
 * superadmin — see lib/booking.ts canCancelBooking) is the API route's
 * job, not this function's. */
export async function cancelBooking(bookingId: string, cancelledByUsername: string): Promise<Booking> {
  const supabase = getSupabaseClient();

  const { data: currentRow, error: readError } = await supabase
    .from("bookings")
    .select("*")
    .eq("id", bookingId)
    .maybeSingle();
  if (readError) throw new Error(`อ่านรายการจองไม่สำเร็จ: ${readError.message}`);
  if (!currentRow) throw new Error("ไม่พบรายการจองนี้ — อาจถูกยกเลิกไปแล้ว");

  const current = rowToBooking(currentRow as BookingRow);
  if (isBookingCancelled(current)) {
    throw new Error("รายการจองนี้ถูกยกเลิกไปแล้ว");
  }

  const { data, error } = await supabase
    .from("bookings")
    .update({ cancelled_at: new Date().toISOString(), cancelled_by_username: cancelledByUsername })
    .eq("id", bookingId)
    .select("*")
    .single();

  if (error || !data) {
    throw new Error(`ยกเลิกการจองไม่สำเร็จ: ${error?.message ?? "unknown error"}`);
  }
  return rowToBooking(data as BookingRow);
}

/** Lets management correct a narrow, fixed set of fields on an *existing*
 * car booking — purpose/destination/participants/contactPhone/companions
 * only. Same restriction set, same lock rules (isBookingLockedFromEditing,
 * reused unchanged from lib/booking.ts), same stamped
 * editedByUsername/editedAt, as the original editBookingByManagement. The
 * permission check itself (canEditBookingByManagement) is the API route's
 * job, not this function's. */
export async function editBookingByManagement(
  bookingId: string,
  edits: {
    purpose?: string;
    destination?: string;
    participants?: number;
    contactPhone?: string;
    companions?: string;
  },
  editedByUsername: string
): Promise<Booking> {
  const supabase = getSupabaseClient();

  const { data: currentRow, error: readError } = await supabase
    .from("bookings")
    .select("*")
    .eq("id", bookingId)
    .maybeSingle();
  if (readError) throw new Error(`อ่านรายการจองไม่สำเร็จ: ${readError.message}`);
  if (!currentRow) throw new Error("ไม่พบรายการจองนี้ — อาจถูกยกเลิกไปแล้ว");

  const current = rowToBooking(currentRow as BookingRow);
  if (current.resourceType !== "car") {
    throw new Error("แก้ไขข้อมูลตรงนี้ได้เฉพาะการจองรถเท่านั้น");
  }
  if (isBookingCancelled(current)) {
    throw new Error("รายการจองนี้ถูกยกเลิกไปแล้ว แก้ไขไม่ได้");
  }
  if (isBookingLockedFromEditing(current)) {
    throw new Error(
      current.directorApprovalStatus === "approved"
        ? "รายการนี้ ผอ. อนุมัติแล้ว แก้ไขไม่ได้อีก"
        : "รายการนี้ถึงเวลาเดินทางแล้ว แก้ไขไม่ได้อีก"
    );
  }

  const patch: Record<string, unknown> = {
    edited_by_username: editedByUsername,
    edited_at: new Date().toISOString(),
  };
  if (edits.purpose !== undefined) patch.purpose = edits.purpose;
  if (edits.destination !== undefined) patch.destination = edits.destination;
  if (edits.participants !== undefined) patch.participants = edits.participants;
  if (edits.contactPhone !== undefined) patch.contact_phone = edits.contactPhone;
  if (edits.companions !== undefined) patch.companions = edits.companions;

  const { data, error } = await supabase
    .from("bookings")
    .update(patch)
    .eq("id", bookingId)
    .select("*")
    .single();

  if (error || !data) {
    throw new Error(`บันทึกการแก้ไขไม่สำเร็จ: ${error?.message ?? "unknown error"}`);
  }
  return rowToBooking(data as BookingRow);
}
