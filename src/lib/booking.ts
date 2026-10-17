import { hasPermission, type PermissionSession } from "@/lib/permissions";

// Pure type definitions + derivation logic for the vehicle / meeting-room
// booking feature ("ระบบจองรถ จองห้องประชุม") — dependency-free so client
// components can import these directly without pulling in googleapis (see
// lib/maintenanceLog.ts / lib/specEvaluation.ts for the same split this
// file follows). The actual Google Sheets read/write for both tabs lives in
// lib/sheets.ts, which imports and re-exports these types.
//
// Per the hospital's explicit request, *making a booking* stays open to
// every logged-in account (any role) — there is no role restriction there,
// only "must be logged in." Managing the resources themselves (adding a
// car/room, editing one, toggling it active/inactive) is narrower: only the
// "it" role or the single env-configured bootstrap superadmin account may
// do that — see canManageBookingResources in lib/auth.ts — a superadmin
// created later through /manage/users cannot. Bookings are confirmed
// immediately on creation; the only gate is the time-conflict check below
// against the same resource.
//
// The one exception is car bookings: per a later explicit request, a car
// booking additionally needs approval before it counts as confirmed — see
// BookingApprovalStatus/canApproveCarBooking below. Room bookings never go
// through this — they stay auto-confirmed exactly as before.

export type BookingResourceType = "car" | "room";

/** One bookable resource — a vehicle or a meeting room. Soft-deactivated
 * (Active=N) rather than ever hard-deleted, so past bookings against it
 * keep their meaning (a booking snapshots the resource's name at the time
 * it was made — see Booking.resourceName below — but still points back at
 * this ResourceId for the conflict check and for "which resource is this
 * booking against" in the UI). A deactivated resource simply stops
 * appearing as choosable for *new* bookings. */
export interface BookingResource {
  resourceId: string;
  type: BookingResourceType;
  name: string;
  /** Free text — e.g. a car's license plate/seats, a room's floor/capacity. */
  detail: string;
  active: boolean;
  createdAt: string;
  createdByUsername: string;
  /** "" (no photo) or a full `data:image/...;base64,...` data URL, resized
   * and compressed client-side (see BookingResourceFormModal) before it's
   * ever sent to the server, so a booker can see what they're booking
   * before confirming. Stored directly in the sheet cell — see
   * MAX_RESOURCE_IMAGE_DATA_URL_LENGTH below for why it has to stay small. */
  imageDataUrl: string;
  /** Number of seats — only meaningful (and only collected in the UI) for
   * type "car"; always 0 for a room. 0 also means "not specified" for an
   * older car resource added before this field existed, in which case
   * isOverSeatCapacity below never flags it (there is nothing to compare
   * against). */
  seatCount: number;
}

/** One registered driver (คนขับรถ) — a reusable entity the dispatch step
 * (TripOrderModal) picks from instead of retyping a name/phone from
 * scratch every time, per the hospital's explicit request ("ช่วยสร้างปุ่ม
 * สำหรับกดแล้วเพิ่มผู้ขับรถ และจะได้สามารถดึงมาเป็นตัวเลือกในกระบวนการจัดรถ").
 * Same soft-deactivate convention as BookingResource — never hard-deleted,
 * so a past TripOrder's driverName (still just a free-text string snapshot,
 * see TripOrder below) keeps its meaning even after the driver it came from
 * is later deactivated. Management of this list is gated by its own
 * dedicated permission key, "manageDrivers" (see canManageDrivers in
 * lib/auth.ts) — deliberately separate from "manageBookingResources" even
 * though the two are structurally similar, per the hospital's explicit
 * request for a driver-specific grant. */
export interface Driver {
  driverId: string;
  name: string;
  /** เบอร์ติดต่อ — free text (not strictly validated as a phone number, same
   * looseness as Booking.contactPhone elsewhere in this app). */
  phone: string;
  active: boolean;
  createdAt: string;
  createdByUsername: string;
}

/** Google Sheets caps a single cell at 50,000 characters — this keeps a
 * healthy safety margin under that ceiling (the row's other columns, plus
 * quoting/encoding overhead, all share the same request) while still
 * allowing a small, recognizable photo. BookingResourceFormModal resizes
 * and re-compresses every photo client-side to fit under this before it's
 * ever submitted; isValidResourceImageDataUrl below is the one shared check
 * both that upload UI and the API routes (defense in depth) run against it. */
export const MAX_RESOURCE_IMAGE_DATA_URL_LENGTH = 42000;

export function isValidResourceImageDataUrl(value: string): boolean {
  if (value === "") return true;
  if (value.length > MAX_RESOURCE_IMAGE_DATA_URL_LENGTH) return false;
  return /^data:image\/(png|jpe?g|webp);base64,/.test(value);
}

/** True only when this is a car resource with a known seat count and the
 * requested traveler count exceeds it — used both by BookingFormModal
 * (client-side, non-blocking warning) and could be reused server-side if
 * this ever needs to be enforced. A room booking, or a car with seatCount
 * still 0 ("not specified"), never triggers this. Per the hospital's
 * explicit choice, exceeding this only warns — it never blocks the
 * booking. */
export function isOverSeatCapacity(
  resource: Pick<BookingResource, "type" | "seatCount">,
  participants: number
): boolean {
  return resource.type === "car" && resource.seatCount > 0 && participants > resource.seatCount;
}

/** Car bookings need a superadmin's approval before they count as
 * confirmed — a later, narrower request than the original "every booking
 * confirms immediately" rule. Room bookings never go through this: they're
 * created already "approved" (see createBooking's approvalStatus
 * derivation in lib/sheets.ts) and this field is otherwise ignored for
 * them. A car booking made before this feature existed also reads back as
 * "approved" (see parseApprovalStatus in lib/sheets.ts) rather than
 * retroactively becoming "pending" — it was already confirmed under the
 * rule in force when it was made. */
export type BookingApprovalStatus = "pending" | "approved" | "rejected";

/** การรับทราบ/อนุมัติการเดินทางโดยผู้อำนวยการ (ผอ.) — เพิ่มเข้ามาทีหลัง
 * approvalStatus/TripOrder เดิมทั้งหมด (ดูคอมเมนต์ยาวที่ Booking.
 * directorApprovalStatus ด้านล่าง) เป็นเลเยอร์ "รับทราบ" แยกต่างหาก ไม่ใช่
 * ขั้นอนุมัติที่บังคับก่อนจัดรถ — ตามที่โรงพยาบาลเลือกไว้ชัดเจน (ผอ. จะเห็น
 * รายการเดินทางหลังจากที่ผู้ดูแลระบบจัดรถ/คนขับเรียบร้อยแล้วเท่านั้น)
 *
 * "" — ยังไม่ถึงขั้นที่ ผอ. ต้องรับทราบ (ยัง "รออนุมัติ"/ยังไม่ถูกจัดรถ, เป็นการ
 * จองห้องประชุม, หรือเป็นการจองรถที่ถูกปฏิเสธไปแล้ว) — ไม่ขึ้นในหน้า ผอ. เลย.
 * "pending" — จัดรถ/คนขับแล้ว กำลังรอ ผอ. รับทราบ — ตั้งค่านี้ตอนออก/ขยาย
 * TripOrder (createTripOrder/updateTripOrder ใน lib/sheets.ts).
 * "approved" / "rejected" — ผอ. กดรับทราบ/ไม่รับทราบแล้ว ผ่านหน้า /director
 * (ดู setDirectorDecision ใน lib/sheets.ts) — ไม่ย้อนกลับไปกระทบ
 * approvalStatus/TripOrder เดิมเลย เป็นแค่ชั้นมองเห็นเพิ่มเติมสำหรับ ผอ. */
export type DirectorApprovalStatus = "" | "pending" | "approved" | "rejected";

/** One booking against one resource, for one time range. Live vs cancelled
 * is tracked separately from approval (cancelledAt is blank while live, set
 * once cancelled — see isBookingCancelled) — a booking can be cancelled
 * regardless of its approvalStatus. Cancelled bookings are kept (never
 * deleted) as an audit trail and so the same time slot's history is
 * visible.
 *
 * hasBookingConflict below is still what a *room* booking is checked
 * against (a room can only host one meeting at a time), but createBooking
 * in lib/sheets.ts deliberately skips this check for a *car* booking, per
 * the hospital's explicit request — several people may need the same car
 * around the same time before management has decided how to route them,
 * and blocking the second request would defeat the whole point of the
 * TripOrder/carpool review step below: management sees every overlapping
 * request and decides which car, which driver, and whether to combine them
 * into one trip. */
/** Placeholder resourceName (paired with resourceId "") recorded on every
 * *car* booking now that the requester no longer picks a specific vehicle
 * up front — per a later, explicit hospital request: which car (and
 * driver) is used is entirely management's call, decided only when they
 * dispatch it via a TripOrder (see TripOrder below), so there's nothing
 * resource-specific left to record on the original request. Room bookings
 * are unaffected by this — a room booking still records the real
 * resourceId/resourceName of the room the requester picked, exactly as
 * before, since there's no equivalent "management assigns it later" step
 * for rooms (see BookingFormModal/POST /api/booking/bookings, which is
 * what actually branches on resourceType to decide whether a real
 * resourceId is required from the client at all). */
export const PENDING_CAR_RESOURCE_NAME = "รถ (รอบริหารจัดสรร)";

/** ชื่อ window CustomEvent ที่ยิงออกไปทุกครั้งที่มีการออก/แก้ไขใบสั่งงาน
 * เดินทาง (TripOrder) สำเร็จ — ไม่ว่าจะทำผ่านหน้าจองรถเอง (BookingDashboard)
 * หรือผ่านป็อปอัปกระดิ่งแจ้งเตือนที่ลอยอยู่ทุกหน้า (NotificationBell) ก็ตาม
 * ทั้งสองที่นี้ต่างคนต่างมี state ของตัวเอง ไม่ได้แชร์กันโดยตรง (ไม่มี
 * SWR/React Query หรือ context กลางในระบบนี้) เดิมทำให้ปฏิทิน/รายการในหน้า
 * จองรถไม่อัปเดตทันทีถ้าเพิ่งอนุมัติผ่านป็อปอัปกระดิ่งไป (ต้องรีเฟรชหน้าเอง
 * ถึงจะเห็น) — ใช้ window event ธรรมดานี้แทนเพื่อบอกให้ทุกฝั่งที่กำลังแสดงผล
 * อยู่รีเฟรชข้อมูลสดใหม่ทันที ตามที่ขอเพิ่มภายหลัง (ดู
 * BookingDashboard.tsx's refreshData / NotificationBell.tsx's
 * handleTripOrderCreated) */
export const TRIP_ORDER_CHANGED_EVENT = "ttk:trip-order-changed";

/** ชื่อ window CustomEvent (detail: { text: string }) ที่ยิงออกไปทุกครั้งที่
 * มีข้อความแจ้งผลสำเร็จของการดำเนินการจองรถ (เช่น "อนุมัติสำเร็จ...",
 * "บันทึกการแก้ไขสำเร็จ...") — เดิมข้อความนี้แสดงแค่เป็นแถบข้อความบนหน้าจองรถ
 * (BookingDashboard) เท่านั้น ตามที่ขอเพิ่มภายหลังให้ข้อความเดียวกันนี้ไป
 * ปรากฏที่กระดิ่งแจ้งเตือน (NotificationBell) ด้วย ("เอาการแจ้งเตือนในกล่อง 1
 * ไปใส่ในแจ้งเตือนกล่อง 2 ด้วย") — คงแถบเดิมไว้ทั้งคู่ ไม่ได้ย้ายออก แค่ยิง
 * event นี้เพิ่มขนานกันไปให้ NotificationBell (ซึ่งลอยอยู่ทุกหน้า mount แยก
 * ก้อน state ต่างหาก ไม่ได้แชร์กับ BookingDashboard โดยตรง) เก็บเข้ารายการ
 * "กิจกรรมล่าสุด" ของตัวเองด้วย ให้เปิดกระดิ่งดูย้อนได้แม้พลาดแถบข้อความบนหน้า
 * ไป — เก็บในหน่วยความจำของแท็บนี้เท่านั้น (ไม่ persist ข้ามเซสชัน เหมือนกับ
 * ส่วนอื่นของ NotificationBell ที่ตั้งใจไม่เก็บประวัติถาวรอยู่แล้ว) */
export const BOOKING_NOTICE_EVENT = "ttk:booking-notice";

export interface Booking {
  bookingId: string;
  /** "" for every car booking (see PENDING_CAR_RESOURCE_NAME above) — still
   * the real BookingResource id for a room booking, which keeps choosing a
   * specific resource up front. */
  resourceId: string;
  resourceType: BookingResourceType;
  /** Snapshot of the resource's name at booking time, so this booking's
   * label in the UI/printouts never changes even if the resource is later
   * renamed — same rationale as MaintenanceTask's equipment snapshot
   * fields in lib/sheets.ts. Always PENDING_CAR_RESOURCE_NAME for a car
   * booking (see above) — the actual assigned car only ever appears on the
   * TripOrder that dispatches it. */
  resourceName: string;
  /** ISO 8601 datetime strings (local wall-clock, no timezone conversion —
   * same convention as every other timestamp this app stores). */
  startTime: string;
  endTime: string;
  /** วัตถุประสงค์ / เหตุผลการใช้งาน — required for every booking. */
  purpose: string;
  /** ปลายทาง — only meaningful (and only collected in the UI) for
   * resourceType "car"; always "" for a room booking. */
  destination: string;
  /** จำนวนผู้โดยสาร/ผู้เข้าร่วม. */
  participants: number;
  /** เบอร์ติดต่อผู้จอง. */
  contactPhone: string;
  bookedByUsername: string;
  bookedByDisplayName: string;
  department: string;
  createdAt: string;
  /** "pending" only ever applies to a car booking awaiting a superadmin's
   * review; room bookings and pre-existing car bookings are "approved".
   * See BookingApprovalStatus above. */
  approvalStatus: BookingApprovalStatus;
  /** Blank until reviewed; set once a superadmin approves/rejects — see
   * canApproveCarBooking below. */
  approvedAt: string;
  approvedByUsername: string;
  /** Blank while the booking is live; set to an ISO timestamp once
   * cancelled — see isBookingCancelled. */
  cancelledAt: string;
  cancelledByUsername: string;
  /** ผู้ร่วมเดินทาง — free text, optional, car only (same "only meaningful
   * for a car" shape as destination above; always "" for a room booking).
   * Filled in by the requester at booking time — editable by management
   * afterwards, same as purpose/destination/participants/contactPhone, see
   * editedByUsername below. */
  companions: string;
  /** Blank until a superadmin/management account dispatches this car
   * booking by creating a TripOrder covering it (see createTripOrder in
   * lib/sheets.ts) — that's what moves it out of "pending" now, replacing
   * the old plain approve toggle. Sharing the same TripOrderId across
   * several bookings is exactly what "combine these trips" means — see
   * TripOrder.bookingIds below. Always "" for a room booking (rooms never
   * go through review) and for a rejected car booking. */
  tripOrderId: string;
  /** Blank until a superadmin/management account edits this booking's own
   * details (see editBookingByManagement in lib/sheets.ts and PATCH
   * /api/booking/bookings/[bookingId]'s `edit` payload) — set to that
   * account's username so the UI can show "แก้ไขโดยฝ่ายบริหาร" on the
   * booking, per the hospital's explicit request. Only a fixed, narrow set
   * of fields is ever editable this way (purpose/destination/participants/
   * contactPhone/companions) — never bookedByUsername/department/resourceId/
   * startTime/endTime/approvalStatus, which stay exactly as the requester
   * submitted them (or are handled separately, e.g. via TripOrder for the
   * actual car/driver/time — see the doc comment on TripOrder below). */
  editedByUsername: string;
  /** Blank alongside editedByUsername; set to the same edit's timestamp. */
  editedAt: string;
  /** See DirectorApprovalStatus above — "" until a TripOrder dispatches
   * this car booking, then "pending" until the director acts on it via
   * /director. Always "" for a room booking. */
  directorApprovalStatus: DirectorApprovalStatus;
  /** Blank until the director approves/rejects; set to that decision's
   * ISO timestamp — same shape as approvedAt above. */
  directorApprovedAt: string;
}

/**
 * ใบสั่งงาน/ใบเดินทาง — management's own record of which car, which driver,
 * and what actual time window will serve one or more car booking *requests*
 * (Booking above). Creating one is now the only way a pending car booking
 * becomes "approved" — see setBookingApprovalStatus / createTripOrder in
 * lib/sheets.ts and POST /api/booking/trip-orders.
 *
 * Deliberately a separate record rather than an edit to the original
 * Booking rows it covers: the hospital was explicit that the original
 * request (who asked, for what, when, to where) must stay exactly as
 * submitted — management's decision lives here instead, and every covered
 * Booking just carries a `tripOrderId` pointer to it (see above). Covering
 * more than one bookingId here *is* the "combine several requests into one
 * trip" (carpool) feature — there's no separate merge mechanism, issuing a
 * TripOrder for multiple bookingIds at once *is* the merge.
 */
export interface TripOrder {
  tripOrderId: string;
  /** The car actually assigned — may differ from what any individual
   * covered booking originally requested (management's call, per the
   * hospital's explicit "management decides which car" request). */
  resourceId: string;
  /** Snapshot of the assigned car's name at dispatch time, same rationale
   * as Booking.resourceName. */
  resourceName: string;
  /** ชื่อพนักงานขับรถ — free text, required. The one new field this whole
   * feature was originally requested for. */
  driverName: string;
  /** Actual dispatch time window — management's call, may differ from any
   * individual covered booking's originally requested time (e.g. when
   * combining several requests, the unified pickup/return window). Same
   * "local wall-clock, no timezone conversion" string convention as every
   * other timestamp here. */
  startTime: string;
  endTime: string;
  /** หมายเหตุ — free text, optional (route/stops/anything management wants
   * noted alongside the dispatch). */
  notes: string;
  /** The car booking request(s) this dispatch covers — one for an ordinary
   * single approval, more than one when combining trips. Every bookingId
   * here must reference a car booking that was "pending" at the moment this
   * TripOrder was created. */
  bookingIds: string[];
  createdByUsername: string;
  createdAt: string;
}

export function isBookingCancelled(booking: Pick<Booking, "cancelledAt">): boolean {
  return booking.cancelledAt.trim() !== "";
}

/** The key a booking is color-coded by in resourceColorMap (see
 * BookingDashboard's resourceColorMap useMemo and every
 * resourceColorMap.get(...) call site in BookingCalendar.tsx/
 * BookingDashboard.tsx) — NOT simply booking.resourceName for a car
 * booking, because every car booking shares the exact same placeholder
 * name until dispatched (see PENDING_CAR_RESOURCE_NAME above), which would
 * either color every car booking identically (meaningless) or key on a
 * name no TripOrder-based map actually contains.
 *
 * Room bookings are unaffected — same resourceName key as always, matching
 * a real BookingResource.name.
 *
 * A car booking is keyed by its tripOrderId once dispatched — every
 * booking a single TripOrder covers shares that one key, so bookings
 * combined into the same dispatch/trip render with the exact same color,
 * which is exactly what "these travel together" should look like visually
 * (per the hospital's later, explicit request — see resourceColorMap's own
 * comment in BookingDashboard.tsx for how the map itself is built from
 * tripOrders for car). A car booking with no tripOrderId yet (still
 * pending, or rejected outright) has no meaningful key — returns "" so
 * resourceColorMap.get(...) always misses for it; every call site that
 * reads the result already either never uses color for that case (a
 * pending booking always renders via a fixed status style instead — see
 * BookingCalendar's day-cell chip) or falls back to a neutral color
 * (ACTION_OTHER_COLOR from lib/actionColors.ts) rather than ever rendering
 * an unstyled/invisible chip. */
export function bookingColorMapKey(booking: Pick<Booking, "resourceType" | "resourceName" | "tripOrderId">): string {
  if (booking.resourceType !== "car") return booking.resourceName;
  return booking.tripOrderId;
}

/** What to show as a car booking's primary resource label once it's been
 * dispatched — the real assigned car (from the TripOrder that covers it)
 * once one exists, falling back to the request's own
 * PENDING_CAR_RESOURCE_NAME placeholder while still pending or rejected.
 * Degrades to booking.resourceName whenever there's no covering TripOrder
 * (including for a room booking, which never has one), so it's always safe
 * to call regardless of resourceType. */
export function carBookingDisplayName(
  booking: Pick<Booking, "resourceName">,
  tripOrder: Pick<TripOrder, "resourceName"> | undefined
): string {
  return tripOrder?.resourceName || booking.resourceName;
}

/** Display label + tone for a booking's overall status, shared by every
 * booking list/calendar view (BookingDashboard, BookingCalendar) so the
 * wording and color never drift between them. Cancelled always wins — a
 * cancelled booking is cancelled regardless of whether it was ever
 * approved — otherwise this just mirrors approvalStatus, which is always
 * "approved" for a room booking (see createBooking in lib/sheets.ts), so a
 * room booking always reads exactly as it always has.
 *
 * Text deliberately avoids the word "อนุมัติ" (approve) — per the
 * hospital's later explicit request, that word is reserved for the
 * director's own sign-off on /director (see directorStatusLabel below);
 * what a superadmin/admin does to a car booking at this level is "จัดรถ"
 * (arrange the car), never "approve" it, so "pending"/"rejected" read
 * "รอจัดรถ"/"ปฏิเสธแล้ว" instead of the old "รออนุมัติ"/"ไม่อนุมัติ". */
export function bookingStatusLabel(
  booking: Pick<Booking, "cancelledAt" | "approvalStatus">
): { text: string; tone: "cancelled" | "pending" | "approved" | "rejected" } {
  if (isBookingCancelled(booking)) return { text: "ยกเลิกแล้ว", tone: "cancelled" };
  if (booking.approvalStatus === "pending") return { text: "รอจัดรถ", tone: "pending" };
  if (booking.approvalStatus === "rejected") return { text: "ปฏิเสธแล้ว", tone: "rejected" };
  return { text: "อนุญาต", tone: "approved" };
}

/** Display label + tone for a car booking's director sign-off — separate
 * from bookingStatusLabel above since this is a sign-off layer on top of
 * (never a replacement for) the existing approvalStatus/TripOrder flow. "" →
 * no label at all (not dispatched yet, a room booking, or an already-
 * rejected car booking) — every call site should skip rendering anything
 * for that case rather than show a blank chip. */
export function directorStatusLabel(
  booking: Pick<Booking, "directorApprovalStatus">
): { text: string; tone: "pending" | "approved" | "rejected" } | null {
  if (booking.directorApprovalStatus === "pending") return { text: "ผอ. รอรับทราบ", tone: "pending" };
  if (booking.directorApprovalStatus === "approved") return { text: "ผอ. รับทราบแล้ว", tone: "approved" };
  if (booking.directorApprovalStatus === "rejected") return { text: "ผอ. ไม่รับทราบ", tone: "rejected" };
  return null;
}

/** Splits a startTime/endTime string ("2026-08-25T14:30", the raw
 * <input type="datetime-local"> value) into its date and time parts by
 * string matching — never `new Date(...)`, so this never shifts by the
 * viewer's or server's timezone, matching the "local wall-clock, no
 * conversion" convention documented on Booking above. Returns null for
 * anything that doesn't match (a blank or malformed cell).
 *
 * Also accepts "2026-08-25 14:30[:00]" — a space instead of "T", an
 * optional seconds part, and an hour that isn't zero-padded. That's the
 * shape Google Sheets can silently rewrite a date-looking string into when
 * it's written with valueInputOption "USER_ENTERED" (it recognizes the
 * text as a date and reformats it on save; a later read-back then sees the
 * reformatted text, not what was written). Every booking write now uses
 * "RAW" instead precisely to stop that from happening going forward — see
 * the note on createBooking in lib/sheets.ts — but tolerating the
 * space-separated shape here means a booking written before that fix still
 * parses correctly instead of silently disappearing from the calendar
 * (which needs this to succeed) while still showing, garbled, in the flat
 * list (which just prints the raw string when this returns null). */
export function splitBookingDateTime(raw: string): { dateKey: string; time: string } | null {
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  return { dateKey: `${y}-${mo}-${d}`, time: `${h.padStart(2, "0")}:${mi}` };
}

/** startTime/endTime -> epoch milliseconds, via splitBookingDateTime so it
 * tolerates the same two shapes that function does — never `new
 * Date(raw).getTime()` directly, which isn't guaranteed to parse a
 * non-standard "YYYY-MM-DD HH:MM" string the same way across JS engines.
 * Returns NaN for anything unparseable, same contract as Date#getTime(),
 * so existing NaN checks at every call site keep working unchanged. */
function bookingDateTimeToMillis(raw: string): number {
  const parts = splitBookingDateTime(raw);
  if (!parts) return NaN;
  const [y, mo, d] = parts.dateKey.split("-").map(Number);
  const [h, mi] = parts.time.split(":").map(Number);
  return new Date(y, mo - 1, d, h, mi).getTime();
}

/** "Now", expressed in the exact same naive-local-numbers convention as
 * bookingDateTimeToMillis above (wall-clock digits run through `new
 * Date(y, mo-1, d, h, mi)`, which stamps them using whatever timezone the
 * JS engine itself runs in). startTime/endTime are stored as *Bangkok*
 * wall-clock digits with no timezone conversion (see the Booking.startTime
 * doc comment), so comparing bookingDateTimeToMillis(booking.startTime)
 * against a plain Date.now() would be silently wrong by the server's UTC
 * offset whenever the server isn't itself running in Asia/Bangkok (Vercel
 * runs in UTC). Converting "now" to Bangkok wall-clock digits first (via
 * toLocaleString with timeZone: "Asia/Bangkok", same technique as
 * bangkokDateKey in lib/sheets.ts) and then feeding those digits through
 * the identical new Date(y, mo-1, d, h, mi) conversion cancels that offset
 * out on both sides, so the subtraction below is correct regardless of
 * which timezone the server process happens to run in. */
function nowAsBookingMillis(): number {
  // en-CA + these options -> "YYYY-MM-DD, HH:MM" (24h clock, comma
  // separator) — locale chosen only for that predictable digit order, not
  // for anything Canada-specific.
  const formatted = new Date().toLocaleString("en-CA", {
    timeZone: "Asia/Bangkok",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const m = formatted.match(/^(\d{4})-(\d{2})-(\d{2}),?\s*(\d{2}):(\d{2})/);
  if (!m) return Date.now(); // should never happen; falls back to a safe default
  const [, y, mo, d, h, mi] = m.map(Number) as unknown as number[];
  return new Date(y, mo - 1, d, h, mi).getTime();
}

/** Whether a booking's own start date/time has already arrived (or
 * passed), as of "now" in Bangkok time. Once this is true the booking
 * describes a trip/meeting that has already begun (or is already over),
 * so it can no longer meaningfully be cancelled — see canCancelBooking
 * below, which folds this in unconditionally (not even a superadmin may
 * cancel a booking whose time has already arrived). Returns false — i.e.
 * "hasn't started, cancellation still allowed on this basis" — if
 * startTime can't be parsed, so a malformed value never silently blocks a
 * cancellation that should otherwise be allowed. */
export function hasBookingStarted(booking: Pick<Booking, "startTime">): boolean {
  const startMillis = bookingDateTimeToMillis(booking.startTime);
  if (Number.isNaN(startMillis)) return false;
  return nowAsBookingMillis() >= startMillis;
}

/** "2026-08-25T14:30" -> "25/08/2026 14:30" — display formatting shared by
 * the flat list (BookingDashboard) and the calendar view
 * (BookingCalendar), both of which show the exact same underlying data in
 * a different shape. Falls back to the raw string unchanged if it doesn't
 * match the expected format. */
export function formatBookingDateTime(raw: string): string {
  const parts = splitBookingDateTime(raw);
  if (!parts) return raw;
  const [y, mo, d] = parts.dateKey.split("-");
  return `${d}/${mo}/${Number(y) + 543} ${parts.time}`;
}

/** ช่วงเวลาแบบกระชับสำหรับคำขอเดียวที่วันเริ่ม/สิ้นสุดเป็นวันเดียวกัน (กรณี
 * ทั่วไปของการจองรถ/ห้อง) — "DD/MM/YYYY HH:MM-HH:MM" แทนที่จะเขียนวันที่ซ้ำ
 * สองรอบแบบ formatBookingDateTime คู่กัน (เช่น
 * "24/09/2569 09:00 – 24/09/2569 12:00" ซึ่งอ่านซ้ำซ้อนเกินจำเป็นเมื่อเป็น
 * วันเดียวกัน) — ตามที่ขอปรับ popup สั่งงานเดินทางให้ "จัดลำดับเพื่อความ
 * สวยงาม" ถ้าเริ่ม/สิ้นสุดคนละวัน (เช่น เดินทางข้ามคืน) จะ fallback ไปแสดง
 * แบบเต็มทั้งสองฝั่งเหมือนเดิม (คั่นด้วย " – ") กันไม่ให้ข้อมูลวันที่หาย. */
export function formatBookingDateRange(startRaw: string, endRaw: string): string {
  const start = splitBookingDateTime(startRaw);
  const end = splitBookingDateTime(endRaw);
  if (!start || !end || start.dateKey !== end.dateKey) {
    return `${formatBookingDateTime(startRaw)} – ${formatBookingDateTime(endRaw)}`;
  }
  const [y, mo, d] = start.dateKey.split("-");
  return `${d}/${mo}/${Number(y) + 543} ${start.time}-${end.time}`;
}

/** True if [startTime, endTime) would overlap any existing, still-relevant
 * booking on the same resource — the gate a new booking has to clear.
 * Cancelled bookings never block (the slot was given back), and neither do
 * rejected car bookings (the trip was turned down, so the slot is free
 * again) — a *pending* car booking still blocks, though, so two accounts
 * can't both have a request in flight for the same overlapping slot while
 * a superadmin hasn't reviewed either yet. Half-open interval overlap
 * test: two ranges overlap iff existing.start < new.end && existing.end >
 * new.start. `excludeBookingId` lets a future "edit booking time" feature
 * check a booking against every *other* booking without conflicting with
 * itself; unused by plain creation. */
export function hasBookingConflict(
  existingBookings: Booking[],
  resourceId: string,
  startTime: string,
  endTime: string,
  excludeBookingId?: string
): boolean {
  const start = bookingDateTimeToMillis(startTime);
  const end = bookingDateTimeToMillis(endTime);
  if (Number.isNaN(start) || Number.isNaN(end) || start >= end) return false;

  return existingBookings.some((b) => {
    if (b.resourceId !== resourceId) return false;
    if (excludeBookingId && b.bookingId === excludeBookingId) return false;
    if (isBookingCancelled(b)) return false;
    if (b.approvalStatus === "rejected") return false;
    const bStart = bookingDateTimeToMillis(b.startTime);
    const bEnd = bookingDateTimeToMillis(b.endTime);
    if (Number.isNaN(bStart) || Number.isNaN(bEnd)) return false;
    return bStart < end && bEnd > start;
  });
}

/** Who may cancel a booking: the account that made it, or any superadmin
 * (every department, same "oversight" reach a superadmin already has
 * everywhere else in this app) — not gated to the bootstrap account, since
 * resource/booking management itself was explicitly opened up to every
 * role equally. Not exposed as a setting the user was asked about; this is
 * a reasonable default to stop one account from cancelling another
 * department's booking outright. Backed by hasPermission()'s
 * "cancelAnyBooking" key for the "someone else's booking" half — same
 * unchanged default (any superadmin), now also grantable per account; a
 * booking's own owner can always cancel it regardless, exactly as before.
 *
 * On top of that ownership check, a booking whose own start date/time has
 * already arrived can never be cancelled by anyone — per explicit request,
 * this is absolute and does not defer to "cancelAnyBooking"/superadmin the
 * way the ownership half does: a trip or meeting that has already started
 * (or already happened) is done, not something to retroactively "not have
 * booked". Checked here (hasBookingStarted) rather than left to each call
 * site so the three places that gate the cancel action — the flat list in
 * BookingDashboard, the calendar day view in BookingCalendar, and the
 * DELETE route in api/booking/bookings/[bookingId] — can never drift out
 * of sync with each other. */
export function canCancelBooking(
  booking: Pick<Booking, "bookedByUsername" | "startTime">,
  session: { username: string } & PermissionSession
): boolean {
  if (hasBookingStarted(booking)) return false;
  return booking.bookedByUsername === session.username || hasPermission(session, "cancelAnyBooking");
}

/** Who may review a pending car booking: any account with the superadmin
 * role — per the hospital's explicit choice, this is *not* narrowed to the
 * single bootstrap account the way canManageBookingResources is; every
 * superadmin (bootstrap or one created later through /manage/users) can
 * review car bookings, matching canCancelBooking's "any superadmin" reach
 * above. Room bookings never reach this check — they have no pending state
 * to review. Backed by hasPermission()'s "approveCarBooking" key — same
 * unchanged default (any superadmin), now also grantable per account.
 *
 * Gates three distinct actions now, all still "management handling a car
 * booking": rejecting a pending one outright (PATCH
 * /api/booking/bookings/[bookingId] with approvalStatus), *approving* one
 * by dispatching it — creating a TripOrder that assigns a real
 * car/driver/time to it, alone or combined with other pending requests
 * (POST /api/booking/trip-orders) — and editing an already-issued
 * TripOrder's own car/driver/time/notes afterwards (PATCH
 * /api/booking/trip-orders/[tripOrderId]). See TripOrder's doc comment
 * above for why *approving* is a dispatch record rather than a plain status
 * toggle.
 *
 * Editing a *booking's* own narrow set of fields (purpose/destination/
 * participants/contactPhone/companions) used to be bundled into this same
 * key too — split out into its own canEditBookingByManagement below (per
 * the hospital's later, explicit request to be able to grant/revoke that
 * specifically for one superadmin account without touching its approve/
 * reject/dispatch rights) — see that function for the rest of this story. */
export function canApproveCarBooking(session: PermissionSession): boolean {
  return hasPermission(session, "approveCarBooking");
}

/** Who may edit a *booking's* own narrow set of fields — purpose/
 * destination/participants/contactPhone/companions only (PATCH
 * /api/booking/bookings/[bookingId] with an `edit` payload instead of
 * approvalStatus — see editBookingByManagement in lib/sheets.ts). This is
 * the one deliberate exception to "the original request is never edited":
 * the hospital explicitly asked for it, and every edit is always visibly
 * marked via Booking.editedByUsername/editedAt so it's never silent.
 *
 * Split out from canApproveCarBooking above into its own
 * "editBookingData" permission key — same unchanged default as before (any
 * superadmin gets both by default, see defaultPermissionsForRole in
 * lib/permissions.ts), but now independently grantable/revocable per
 * account: a hospital admin can tick approveCarBooking off for one
 * superadmin account while leaving editBookingData on, or vice versa,
 * without the two ever being forced to move together the way they used to
 * be when this was all one key. */
export function canEditBookingByManagement(session: PermissionSession): boolean {
  return hasPermission(session, "editBookingData");
}
