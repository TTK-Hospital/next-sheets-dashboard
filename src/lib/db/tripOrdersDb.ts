import {
  PENDING_CAR_RESOURCE_NAME,
  hasBookingStarted,
  isBookingCancelled,
  splitBookingDateTime,
  formatBookingDateTime,
  type Booking,
  type DirectorApprovalStatus,
  type TripOrder,
} from "@/lib/booking";
import { getBookingResources } from "@/lib/db/bookingResourcesDb";
import { getBookings } from "@/lib/db/bookingsDb";
import { getSupabaseClient } from "@/lib/supabaseClient";

// Supabase-backed parallel of the "TripOrders"/director-decision cluster
// in lib/sheets.ts: getTripOrders, getDriverTrips, createTripOrder,
// updateTripOrder, splitBookingFromTripOrder, getDirectorPendingTrips,
// getDirectorAllTrips, setDirectorDecision, returnTripToDispatch. Same
// exported names/signatures/return shapes as the originals.
//
// KEY DESIGN DIFFERENCE — bookingIds is DERIVED, never stored: the old
// Sheets TripOrder row stored a BookingIds comma-separated column AND
// every covered Booking stored its own TripOrderId pointer back — two
// places holding the same relationship, which supabase/schema.sql's
// trip_orders table deliberately does not repeat (see its header
// comment). Every function below computes a TripOrder's bookingIds by
// querying `bookings` for rows whose trip_order_id matches, via
// loadTripOrdersWithBookingIds()/getBookings(), and still exposes the
// result under the same `bookingIds: string[]` field name so every
// existing call site (DriverCalendar, DirectorDashboard, the
// /api/booking/trip-orders routes, etc.) keeps working unchanged.
//
// A consequence worth flagging explicitly: every place the original
// sheets.ts carefully wrote the TripOrders row FIRST and the covered
// Bookings rows SECOND ("so a failure never leaves a dangling TripOrder
// reference") was reasoning about the *stored* bookingIds array
// specifically. With bookingIds now derived purely from bookings.
// trip_order_id, there is nothing on the trip_orders row itself that can
// ever point at a booking that doesn't reciprocate — so for
// splitBookingFromTripOrder and returnTripToDispatch (which only ever
// *remove* a booking from a trip order's coverage) there is no longer a
// separate "first write" needed at all: clearing a booking's own
// trip_order_id *is* the entire change. createTripOrder/updateTripOrder
// (which also write the trip_orders row's own car/driver/time/notes
// fields) still write that row before touching any bookings row, for the
// same reasoning as before, just narrowed to the fields that still live
// on that row.

interface TripOrderRow {
  id: string;
  resource_id: string | null;
  resource_name: string;
  driver_name: string;
  start_time: string;
  end_time: string;
  notes: string;
  created_by_username: string;
  created_at: string;
}

/** วันที่ (YYYY-MM-DD) ตามเขตเวลา Asia/Bangkok — ย้ายมาจาก bangkokDateKey
 * ของ lib/sheets.ts เดิมทุกประการ (ดูคอมเมนต์เต็มที่ไฟล์นั้น) คัดลอกมาที่นี่
 * เพราะเป็น private helper ของไฟล์เดิม ไม่ได้ export ออกมาให้ import ใช้ซ้ำ
 * ได้ — ตรรกะไม่เปลี่ยนแม้แต่ตัวอักษรเดียว. */
function bangkokDateKey(date: Date): string {
  return date.toLocaleDateString("en-CA", { timeZone: "Asia/Bangkok" });
}

function rowToTripOrder(row: TripOrderRow, bookingIds: string[]): TripOrder {
  return {
    tripOrderId: row.id,
    resourceId: row.resource_id ?? "",
    resourceName: row.resource_name,
    driverName: row.driver_name ?? "",
    startTime: row.start_time,
    endTime: row.end_time,
    notes: row.notes ?? "",
    bookingIds,
    createdByUsername: row.created_by_username,
    createdAt: row.created_at,
  };
}

/** Applies several independent per-booking column patches. PostgREST has
 * no bulk-update endpoint (unlike Sheets' batchUpdate, one API call for N
 * rows) — this is N concurrent single-row UPDATEs instead. Not atomic
 * (same as the Sheets version's batchUpdate wasn't truly transactional
 * either — see every "...สำเร็จ แต่...ไม่สำเร็จ กรุณาตรวจสอบ...ลองใหม่"
 * error message below, carried over verbatim because the same partial-
 * failure possibility still exists here). */
async function writeBookingPatches(patches: { id: string; patch: Record<string, unknown> }[]): Promise<void> {
  if (patches.length === 0) return;
  const supabase = getSupabaseClient();
  const results = await Promise.all(
    patches.map(({ id, patch }) => supabase.from("bookings").update(patch).eq("id", id))
  );
  const failed = results.find((r) => r.error);
  if (failed?.error) {
    throw new Error(failed.error.message);
  }
}

/** Loads every trip_orders row plus the full bookings table in two
 * parallel queries, then derives each TripOrder's bookingIds in memory by
 * grouping bookings on their tripOrderId — see file header comment. */
async function loadTripOrdersWithBookingIds(): Promise<{ tripOrders: TripOrder[]; bookings: Booking[] }> {
  const supabase = getSupabaseClient();
  const [tripOrdersResult, bookings] = await Promise.all([
    supabase.from("trip_orders").select("*").order("created_at", { ascending: true }),
    getBookings(),
  ]);
  if (tripOrdersResult.error) {
    throw new Error(`อ่านรายการใบสั่งงานไม่สำเร็จ: ${tripOrdersResult.error.message}`);
  }

  const bookingIdsByTripOrder = new Map<string, string[]>();
  for (const b of bookings) {
    if (!b.tripOrderId) continue;
    const list = bookingIdsByTripOrder.get(b.tripOrderId);
    if (list) list.push(b.bookingId);
    else bookingIdsByTripOrder.set(b.tripOrderId, [b.bookingId]);
  }

  const rows = (tripOrdersResult.data ?? []) as TripOrderRow[];
  const tripOrders = rows.map((row) => rowToTripOrder(row, bookingIdsByTripOrder.get(row.id) ?? []));
  return { tripOrders, bookings };
}

/** Every dispatch record ever issued — callers join against
 * Booking.tripOrderId themselves, same "read everything, filter/join
 * client-side" shape as the original. */
export async function getTripOrders(): Promise<TripOrder[]> {
  const { tripOrders } = await loadTripOrdersWithBookingIds();
  return tripOrders;
}

export interface DriverTripRequestSummary {
  department: string;
  purpose: string;
  destination: string;
  participants: number;
  startTime: string;
  endTime: string;
  cancelled: boolean;
}

export interface DriverTripSummary {
  tripOrderId: string;
  resourceName: string;
  driverName: string;
  startTime: string;
  endTime: string;
  totalParticipants: number;
  requests: DriverTripRequestSummary[];
}

/** Data for the public /driver calendar page — identical filtering rules
 * to the original getDriverTrips in lib/sheets.ts: only requests the
 * director has actually approved (directorApprovalStatus === "approved")
 * are visible, restricted to [today, today + lookaheadDays] in
 * Asia/Bangkok time, sorted by start time. */
export async function getDriverTrips(lookaheadDays: number = 14): Promise<DriverTripSummary[]> {
  const { tripOrders, bookings } = await loadTripOrdersWithBookingIds();
  const todayKey = bangkokDateKey(new Date());
  const endKey = bangkokDateKey(new Date(Date.now() + lookaheadDays * 24 * 60 * 60 * 1000));
  const bookingById = new Map(bookings.map((b) => [b.bookingId, b]));

  const trips: DriverTripSummary[] = [];
  for (const trip of tripOrders) {
    const dateKey = splitBookingDateTime(trip.startTime)?.dateKey;
    if (!dateKey || dateKey < todayKey || dateKey > endKey) continue;

    const covered = trip.bookingIds
      .map((id) => bookingById.get(id))
      .filter((b): b is Booking => !!b && b.resourceType === "car" && b.directorApprovalStatus === "approved");
    if (covered.length === 0) continue;
    if (covered.every((b) => isBookingCancelled(b))) continue;

    const totalParticipants = covered
      .filter((b) => !isBookingCancelled(b))
      .reduce((sum, b) => sum + b.participants, 0);

    trips.push({
      tripOrderId: trip.tripOrderId,
      resourceName: trip.resourceName,
      driverName: trip.driverName,
      startTime: trip.startTime,
      endTime: trip.endTime,
      totalParticipants,
      requests: covered.map((b) => ({
        department: b.department || b.bookedByDisplayName || b.bookedByUsername,
        purpose: b.purpose,
        destination: b.destination,
        participants: b.participants,
        startTime: b.startTime,
        endTime: b.endTime,
        cancelled: isBookingCancelled(b),
      })),
    });
  }

  trips.sort((a, b) => a.startTime.localeCompare(b.startTime));
  return trips;
}

/** Dispatches one or more *pending* car bookings at once — same semantics
 * as the original createTripOrder: every covered booking is re-validated
 * against the *current* bookings table (never trust a caller's stale
 * list) before anything is written, and the trip_orders row is written
 * before the covered bookings rows are updated. */
export async function createTripOrder(input: {
  resourceId: string;
  resourceName: string;
  driverName: string;
  startTime: string;
  endTime: string;
  notes: string;
  bookingIds: string[];
  createdByUsername: string;
}): Promise<{ tripOrder: TripOrder; bookings: Booking[] }> {
  if (input.bookingIds.length === 0) {
    throw new Error("กรุณาเลือกรายการจองที่จะออกใบสั่งงานอย่างน้อย 1 รายการ");
  }

  const supabase = getSupabaseClient();
  const allBookings = await getBookings();
  const bookingById = new Map(allBookings.map((b) => [b.bookingId, b]));

  const targets: Booking[] = [];
  for (const bookingId of input.bookingIds) {
    const booking = bookingById.get(bookingId);
    if (!booking) {
      throw new Error(`ไม่พบรายการจอง (${bookingId}) — อาจถูกยกเลิกไปแล้ว`);
    }
    if (booking.resourceType !== "car") {
      throw new Error(`${booking.resourceName}: ไม่ใช่การจองรถ ออกใบสั่งงานไม่ได้`);
    }
    if (isBookingCancelled(booking)) {
      throw new Error(`${booking.resourceName} (${formatBookingDateTime(booking.startTime)}): ถูกยกเลิกไปแล้ว`);
    }
    if (booking.approvalStatus !== "pending") {
      throw new Error(`${booking.resourceName} (${formatBookingDateTime(booking.startTime)}): ถูกพิจารณาไปแล้ว`);
    }
    targets.push(booking);
  }

  const { data: tripRow, error: tripError } = await supabase
    .from("trip_orders")
    .insert({
      resource_id: input.resourceId || null,
      resource_name: input.resourceName,
      driver_name: input.driverName,
      start_time: input.startTime,
      end_time: input.endTime,
      notes: input.notes,
      created_by_username: input.createdByUsername,
    })
    .select("*")
    .single();
  if (tripError || !tripRow) {
    throw new Error(`บันทึกใบสั่งงานไม่สำเร็จ: ${tripError?.message ?? "unknown error"}`);
  }

  const createdAt = new Date().toISOString();
  const tripOrder = rowToTripOrder(tripRow as TripOrderRow, input.bookingIds);

  const updatedBookings: Booking[] = targets.map((booking) => ({
    ...booking,
    approvalStatus: "approved",
    approvedAt: createdAt,
    approvedByUsername: input.createdByUsername,
    tripOrderId: tripOrder.tripOrderId,
    directorApprovalStatus: "pending",
    directorApprovedAt: "",
    directorNote: "",
    directorReturnedAt: "",
  }));

  try {
    await writeBookingPatches(
      updatedBookings.map((b) => ({
        id: b.bookingId,
        patch: {
          approval_status: b.approvalStatus,
          approved_at: b.approvedAt || null,
          approved_by_username: b.approvedByUsername || null,
          trip_order_id: b.tripOrderId || null,
          director_approval_status: b.directorApprovalStatus,
          director_approved_at: b.directorApprovedAt || null,
          director_note: b.directorNote,
          director_returned_at: b.directorReturnedAt || null,
        },
      }))
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `บันทึกใบสั่งงานสำเร็จ แต่ปรับสถานะการจองที่เกี่ยวข้องไม่สำเร็จ (${message}) — กรุณาตรวจสอบรายการจองและลองออกใบสั่งงานอีกครั้งหากยังค้างอยู่`
    );
  }

  return { tripOrder, bookings: updatedBookings };
}

/** Edits an already-issued TripOrder's own car/driver/time/notes, and
 * optionally adds more pending car bookings into its coverage
 * (addBookingIds — only ever *adds*, same as the original updateTripOrder;
 * there is still no way to remove a booking this way, see
 * splitBookingFromTripOrder below for that). Locked once the dispatch
 * time has arrived (hasBookingStarted) or once any covered booking has
 * already been director-approved — same two gates as the original. */
export async function updateTripOrder(
  tripOrderId: string,
  updates: {
    resourceId?: string;
    resourceName?: string;
    driverName?: string;
    startTime?: string;
    endTime?: string;
    notes?: string;
    addBookingIds?: string[];
  },
  actorUsername: string
): Promise<{ tripOrder: TripOrder; addedBookings: Booking[] }> {
  const supabase = getSupabaseClient();
  const { tripOrders, bookings } = await loadTripOrdersWithBookingIds();
  const current = tripOrders.find((t) => t.tripOrderId === tripOrderId);
  if (!current) {
    throw new Error("ไม่พบใบสั่งงานนี้");
  }
  if (hasBookingStarted(current)) {
    throw new Error("ใบสั่งงานนี้ถึงเวลาเดินทางแล้ว แก้ไขไม่ได้อีก");
  }

  const addBookingIds = Array.from(new Set(updates.addBookingIds ?? [])).filter(
    (id) => !current.bookingIds.includes(id)
  );

  const bookingById = new Map(bookings.map((b) => [b.bookingId, b]));

  for (const bookingId of current.bookingIds) {
    const booking = bookingById.get(bookingId);
    if (!booking) continue;
    if (booking.directorApprovalStatus === "approved") {
      throw new Error("ใบสั่งงานนี้มีคำขอที่ ผอ. อนุมัติไปแล้ว แก้ไขไม่ได้อีก");
    }
  }

  const bookingTargets: Booking[] = [];
  for (const bookingId of addBookingIds) {
    const booking = bookingById.get(bookingId);
    if (!booking) {
      throw new Error(`ไม่พบรายการจอง (${bookingId}) — อาจถูกยกเลิกไปแล้ว`);
    }
    if (booking.resourceType !== "car") {
      throw new Error(`${booking.resourceName}: ไม่ใช่การจองรถ เพิ่มเข้าใบสั่งงานนี้ไม่ได้`);
    }
    if (isBookingCancelled(booking)) {
      throw new Error(`${booking.resourceName} (${formatBookingDateTime(booking.startTime)}): ถูกยกเลิกไปแล้ว`);
    }
    if (booking.approvalStatus !== "pending") {
      throw new Error(`${booking.resourceName} (${formatBookingDateTime(booking.startTime)}): ถูกพิจารณาไปแล้ว`);
    }
    bookingTargets.push(booking);
  }

  const merged: TripOrder = {
    ...current,
    resourceId: updates.resourceId ?? current.resourceId,
    resourceName: updates.resourceName ?? current.resourceName,
    driverName: updates.driverName ?? current.driverName,
    startTime: updates.startTime ?? current.startTime,
    endTime: updates.endTime ?? current.endTime,
    notes: updates.notes ?? current.notes,
    bookingIds: bookingTargets.length > 0 ? [...current.bookingIds, ...addBookingIds] : current.bookingIds,
  };

  const { error: tripUpdateError } = await supabase
    .from("trip_orders")
    .update({
      resource_id: merged.resourceId || null,
      resource_name: merged.resourceName,
      driver_name: merged.driverName,
      start_time: merged.startTime,
      end_time: merged.endTime,
      notes: merged.notes,
    })
    .eq("id", tripOrderId);
  if (tripUpdateError) {
    throw new Error(`บันทึกการแก้ไขใบสั่งงานไม่สำเร็จ: ${tripUpdateError.message}`);
  }

  let addedBookings: Booking[] = [];
  if (bookingTargets.length > 0) {
    const approvedAt = new Date().toISOString();
    addedBookings = bookingTargets.map((booking) => ({
      ...booking,
      approvalStatus: "approved",
      approvedAt,
      approvedByUsername: actorUsername,
      tripOrderId: merged.tripOrderId,
      directorApprovalStatus: "pending",
      directorApprovedAt: "",
      directorNote: "",
      directorReturnedAt: "",
    }));

    try {
      await writeBookingPatches(
        addedBookings.map((b) => ({
          id: b.bookingId,
          patch: {
            approval_status: b.approvalStatus,
            approved_at: b.approvedAt || null,
            approved_by_username: b.approvedByUsername || null,
            trip_order_id: b.tripOrderId || null,
            director_approval_status: b.directorApprovalStatus,
            director_approved_at: b.directorApprovedAt || null,
            director_note: b.directorNote,
            director_returned_at: b.directorReturnedAt || null,
          },
        }))
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `บันทึกการแก้ไขใบสั่งงานสำเร็จ แต่ปรับสถานะคำขอที่เพิ่มเข้ามาไม่สำเร็จ (${message}) — กรุณาตรวจสอบรายการจองและลองใหม่หากยังค้างอยู่`
      );
    }
  }

  return { tripOrder: merged, addedBookings };
}

/** Splits one booking out of a TripOrder's coverage — the request goes
 * back to a plain "pending, unassigned" car booking (same placeholder
 * resourceId/resourceName reset as a brand-new request), and every
 * director-decision field is cleared. See file header comment for why
 * this is now a single write (the booking's own row) rather than two. */
export async function splitBookingFromTripOrder(
  tripOrderId: string,
  bookingId: string,
  actorUsername: string
): Promise<{ tripOrder: TripOrder; booking: Booking; hasApprovedSibling: boolean }> {
  const supabase = getSupabaseClient();
  const { tripOrders, bookings } = await loadTripOrdersWithBookingIds();
  const current = tripOrders.find((t) => t.tripOrderId === tripOrderId);
  if (!current) {
    throw new Error("ไม่พบใบสั่งงานนี้");
  }
  if (!current.bookingIds.includes(bookingId)) {
    throw new Error("ใบสั่งงานนี้ไม่ได้ครอบคลุมคำขอจองนี้ — อาจถูกแยกออกไปแล้วก่อนหน้านี้");
  }
  if (current.bookingIds.length <= 1) {
    throw new Error("ใบสั่งงานนี้มีคำขอจองเพียงรายการเดียว ไม่สามารถแยกออกได้");
  }
  if (hasBookingStarted(current)) {
    throw new Error("ใบสั่งงานนี้ถึงเวลาเดินทางแล้ว แก้ไขไม่ได้อีก");
  }

  const bookingById = new Map(bookings.map((b) => [b.bookingId, b]));
  const booking = bookingById.get(bookingId);
  if (!booking) {
    throw new Error("ไม่พบรายการจองนี้ — อาจถูกยกเลิกไปแล้ว");
  }
  if (isBookingCancelled(booking)) {
    throw new Error(`${booking.resourceName}: ถูกยกเลิกไปแล้ว ไม่ต้องแยกออกอีก`);
  }
  if (booking.directorApprovalStatus === "approved") {
    throw new Error("คำขอนี้ ผอ. อนุมัติไปแล้ว แก้ไขไม่ได้อีก");
  }

  const editedAt = new Date().toISOString();
  const updatedBooking: Booking = {
    ...booking,
    resourceId: "",
    resourceName: PENDING_CAR_RESOURCE_NAME,
    approvalStatus: "pending",
    approvedAt: "",
    approvedByUsername: "",
    tripOrderId: "",
    editedByUsername: actorUsername,
    editedAt,
    directorApprovalStatus: "",
    directorApprovedAt: "",
    directorNote: "",
    directorReturnedAt: "",
  };

  const { error: bookingUpdateError } = await supabase
    .from("bookings")
    .update({
      resource_id: null,
      resource_name: updatedBooking.resourceName,
      approval_status: updatedBooking.approvalStatus,
      approved_at: null,
      approved_by_username: null,
      trip_order_id: null,
      edited_by_username: updatedBooking.editedByUsername,
      edited_at: updatedBooking.editedAt,
      director_approval_status: "",
      director_approved_at: null,
      director_note: "",
      director_returned_at: null,
    })
    .eq("id", bookingId);
  if (bookingUpdateError) {
    throw new Error(
      `แยกรายการออกจากใบสั่งงานไม่สำเร็จ (${bookingUpdateError.message}) — กรุณาตรวจสอบรายการจองและลองใหม่หากยังค้างอยู่`
    );
  }

  const updatedTripOrder: TripOrder = {
    ...current,
    bookingIds: current.bookingIds.filter((id) => id !== bookingId),
  };
  const hasApprovedSibling = updatedTripOrder.bookingIds.some(
    (id) => bookingById.get(id)?.directorApprovalStatus === "approved"
  );

  return { tripOrder: updatedTripOrder, booking: updatedBooking, hasApprovedSibling };
}

export interface DirectorTripRequestItem {
  bookingId: string;
  purpose: string;
  destination: string;
  participants: number;
  bookedByDisplayName: string;
  department: string;
  companions: string;
  directorApprovalStatus: DirectorApprovalStatus;
  directorNote: string;
}

export interface DirectorTripItem {
  tripOrderId: string;
  startTime: string;
  endTime: string;
  resourceName: string;
  resourceImageDataUrl: string;
  driverName: string;
  requests: DirectorTripRequestItem[];
}

/** Shared grouping logic behind getDirectorPendingTrips/getDirectorAllTrips
 * below — the two functions are identical except for which bookings they
 * keep (see each one's own doc comment for its predicate), so this is one
 * behavior-preserving consolidation of what was two near-duplicate loops
 * in the original lib/sheets.ts. */
function groupDirectorTrips(
  bookings: Booking[],
  tripOrders: TripOrder[],
  resources: { name: string; imageDataUrl: string }[],
  predicate: (b: Booking) => boolean
): DirectorTripItem[] {
  const tripOrderById = new Map(tripOrders.map((t) => [t.tripOrderId, t]));
  const resourceByName = new Map(resources.map((r) => [r.name, r]));

  const groups = new Map<string, DirectorTripItem>();
  for (const b of bookings) {
    if (!predicate(b) || isBookingCancelled(b)) continue;
    const trip = tripOrderById.get(b.tripOrderId);
    let group = groups.get(b.tripOrderId);
    if (!group) {
      const resourceName = trip?.resourceName || b.resourceName;
      group = {
        tripOrderId: b.tripOrderId,
        startTime: trip?.startTime || b.startTime,
        endTime: trip?.endTime || b.endTime,
        resourceName,
        resourceImageDataUrl: resourceByName.get(resourceName)?.imageDataUrl || "",
        driverName: trip?.driverName || "",
        requests: [],
      };
      groups.set(b.tripOrderId, group);
    }
    group.requests.push({
      bookingId: b.bookingId,
      purpose: b.purpose,
      destination: b.destination,
      participants: b.participants,
      bookedByDisplayName: b.bookedByDisplayName,
      department: b.department,
      companions: b.companions,
      directorApprovalStatus: b.directorApprovalStatus,
      directorNote: b.directorNote,
    });
  }

  return Array.from(groups.values()).sort((a, b) => a.startTime.localeCompare(b.startTime));
}

/** /director's "ต้องตัดสินใจ" list — only requests still "pending" at the
 * director layer. Same shape/grouping-by-tripOrderId as the original
 * getDirectorPendingTrips. */
export async function getDirectorPendingTrips(): Promise<DirectorTripItem[]> {
  const [{ tripOrders, bookings }, resources] = await Promise.all([
    loadTripOrdersWithBookingIds(),
    getBookingResources(),
  ]);
  return groupDirectorTrips(bookings, tripOrders, resources, (b) => b.directorApprovalStatus === "pending");
}

/** /director's calendar view — every request that has passed through the
 * director layer at least once (pending, approved, or rejected — not
 * "" and not cancelled). Same as the original getDirectorAllTrips. */
export async function getDirectorAllTrips(): Promise<DirectorTripItem[]> {
  const [{ tripOrders, bookings }, resources] = await Promise.all([
    loadTripOrdersWithBookingIds(),
    getBookingResources(),
  ]);
  return groupDirectorTrips(bookings, tripOrders, resources, (b) => b.directorApprovalStatus !== "");
}

/** ผอ. กดอนุมัติ/ไม่อนุมัติ — ทีละรายการหรือหลายรายการพร้อมกัน. รายการที่หา
 * ไม่เจอ หรือไม่ได้อยู่ในสถานะ "pending" แล้ว ถูกข้ามอย่างเงียบๆ (ไม่ throw
 * ทั้งชุด) เหมือนของเดิมทุกประการ. */
export async function setDirectorDecision(
  bookingIds: string[],
  decision: "approved" | "rejected",
  comment: string = ""
): Promise<{ updatedBookingIds: string[]; bookings: Booking[] }> {
  if (bookingIds.length === 0) return { updatedBookingIds: [], bookings: [] };

  const allBookings = await getBookings();
  const bookingById = new Map(allBookings.map((b) => [b.bookingId, b]));
  const decidedAt = new Date().toISOString();

  const targets: Booking[] = [];
  for (const bookingId of bookingIds) {
    const booking = bookingById.get(bookingId);
    if (!booking) continue;
    if (booking.directorApprovalStatus !== "pending") continue;
    targets.push(booking);
  }
  if (targets.length === 0) return { updatedBookingIds: [], bookings: [] };

  const updatedBookings: Booking[] = targets.map((booking) => ({
    ...booking,
    directorApprovalStatus: decision,
    directorApprovedAt: decidedAt,
    directorNote: comment,
  }));

  try {
    await writeBookingPatches(
      updatedBookings.map((b) => ({
        id: b.bookingId,
        patch: {
          director_approval_status: b.directorApprovalStatus,
          director_approved_at: b.directorApprovedAt || null,
          director_note: b.directorNote,
        },
      }))
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`บันทึกการอนุมัติของ ผอ. ไม่สำเร็จ: ${message}`);
  }

  return { updatedBookingIds: updatedBookings.map((b) => b.bookingId), bookings: updatedBookings };
}

/** ผอ. กด "ตีกลับ" ใบสั่งงานทั้งใบ — ทุกคำขอที่ TripOrder นี้ครอบคลุมกลับไป
 * เป็น "รอจัดรถ" ตั้งแต่ต้น เหมือน splitBookingFromTripOrder ด้านบนแต่ทำกับ
 * ทุกคำขอพร้อมกัน พร้อมข้อความของ ผอ. (`comment`). ใบสั่งงานเดิมไม่ถูกลบแถว
 * ทิ้ง — "ตีกลับ" แค่ทำให้ bookingIds ของมัน (ซึ่งตอนนี้ derived แล้ว) เหลือ
 * [] โดยอัตโนมัติทันทีที่ bookings ด้านล่างเขียน trip_order_id เป็น null ครบ
 * ทุกแถว ไม่ต้องมีขั้น "เขียนใบสั่งงานก่อน" แยกต่างหากเหมือนของเดิมอีกแล้ว —
 * เหตุผลเดียวกับที่อธิบายไว้ที่ splitBookingFromTripOrder ด้านบน. */
export async function returnTripToDispatch(
  tripOrderId: string,
  comment: string,
  actorUsername: string
): Promise<{ tripOrder: TripOrder; bookings: Booking[] }> {
  const { tripOrders, bookings } = await loadTripOrdersWithBookingIds();
  const current = tripOrders.find((t) => t.tripOrderId === tripOrderId);
  if (!current) {
    throw new Error("ไม่พบใบสั่งงานนี้ — อาจถูกตีกลับไปแล้วก่อนหน้านี้");
  }
  if (current.bookingIds.length === 0) {
    throw new Error("ใบสั่งงานนี้ไม่มีคำขอจองเหลืออยู่แล้ว");
  }
  if (hasBookingStarted(current)) {
    throw new Error("ใบสั่งงานนี้ถึงเวลาเดินทางแล้ว แก้ไขไม่ได้อีก");
  }

  const bookingById = new Map(bookings.map((b) => [b.bookingId, b]));

  const targets: Booking[] = [];
  for (const bookingId of current.bookingIds) {
    const booking = bookingById.get(bookingId);
    if (!booking) continue;
    if (isBookingCancelled(booking)) continue;
    if (booking.directorApprovalStatus === "approved") {
      throw new Error("ใบสั่งงานนี้มีคำขอที่ ผอ. อนุมัติไปแล้ว ตีกลับไม่ได้อีก");
    }
    targets.push(booking);
  }
  if (targets.length === 0) {
    throw new Error("ไม่พบคำขอจองที่ยังใช้งานอยู่ในใบสั่งงานนี้");
  }

  const returnedAt = new Date().toISOString();
  const updatedBookings: Booking[] = targets.map((booking) => ({
    ...booking,
    resourceId: "",
    resourceName: PENDING_CAR_RESOURCE_NAME,
    approvalStatus: "pending",
    approvedAt: "",
    approvedByUsername: "",
    tripOrderId: "",
    editedByUsername: actorUsername,
    editedAt: returnedAt,
    directorApprovalStatus: "",
    directorApprovedAt: "",
    directorNote: comment,
    directorReturnedAt: returnedAt,
  }));
  const dissolvedTripOrder: TripOrder = { ...current, bookingIds: [] };

  try {
    await writeBookingPatches(
      updatedBookings.map((b) => ({
        id: b.bookingId,
        patch: {
          resource_id: null,
          resource_name: b.resourceName,
          approval_status: b.approvalStatus,
          approved_at: null,
          approved_by_username: null,
          trip_order_id: null,
          edited_by_username: b.editedByUsername,
          edited_at: b.editedAt,
          director_approval_status: "",
          director_approved_at: null,
          director_note: b.directorNote,
          director_returned_at: b.directorReturnedAt,
        },
      }))
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `ตีกลับใบสั่งงานสำเร็จ แต่ปรับสถานะคำขอที่เกี่ยวข้องกลับเป็น "รอจัดรถ" ไม่สำเร็จ (${message}) — กรุณาตรวจสอบรายการจองและลองใหม่หากยังค้างอยู่`
    );
  }

  return { tripOrder: dissolvedTripOrder, bookings: updatedBookings };
}
