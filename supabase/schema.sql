-- =============================================================================
-- TTK Hospital booking/equipment system — Supabase (PostgreSQL) schema
-- Migrated from Google Sheets. Generated for branch feature/supabase-migration.
--
-- IMPORTANT — Row Level Security: deliberately left OFF for every table
-- below. The application connects to Postgres only from trusted Next.js
-- server code, using the Supabase *service role* key, which bypasses RLS
-- entirely anyway. Enabling RLS here would add complexity (writing policies
-- for every table/role) with zero actual benefit, since the service role
-- key ignores it. This is an intentional choice, not an oversight.
--
-- Primary keys: every entity that already had an ID in the app code
-- (bookingId, tripOrderId, resourceId, driverId, taskId) was already a
-- standard v4 UUID (crypto.randomUUID()) — these keep the `uuid` type and
-- their *existing* values carry over unchanged during data migration, so
-- nothing that already references one of these IDs (e.g. a past LINE
-- notification, or a URL) breaks. Tables that never had an app-level ID in
-- Google Sheets (equipment rows, edit log entries, maintenance log entries)
-- get a freshly generated uuid primary key at migration time.
-- =============================================================================

-- เปิดใช้ extension ที่จำเป็น (ปลอดภัยแม้เปิดอยู่แล้ว เพราะใช้ IF NOT EXISTS)
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- -----------------------------------------------------------------------------
-- ครุภัณฑ์ (Equipment) — เดิมคือการตอบแบบฟอร์ม Google Form ที่ไม่มีคอลัมน์ ID
-- ของตัวเอง (ใช้แค่เลขแถวในชีตอ้างอิง) และหัวคอลัมน์คือ "คำถาม" ของฟอร์มเอง
-- ซึ่งอาจมีคำถามเพิ่มเติมในอนาคตได้ จึงเก็บเป็น 2 ส่วน: (1) คอลัมน์หลักที่ระบบ
-- ใช้ค้นหา/กรองข้อมูลบ่อย (ชื่อ-นามสกุลผู้รับผิดชอบ, เลขครุภัณฑ์, สถานะ ฯลฯ)
-- และ (2) raw_responses แบบ jsonb เก็บคำตอบฟอร์มดิบทั้งหมดไว้ครบทุกคำถาม
-- (รวมคำถามที่อาจเพิ่มเข้ามาทีหลัง) เพื่อไม่ให้ข้อมูลตกหล่นแม้ฟอร์มจะเปลี่ยน
-- -----------------------------------------------------------------------------
CREATE TABLE equipment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- original sheet row number, kept only for audit/traceability during and
  -- right after migration — not used by the app going forward
  legacy_row_number integer,
  submitted_at timestamptz,              -- FieldMap.timestamp (ประทับเวลา ของ Google Form)
  department text,                        -- FieldMap.department (กลุ่มงาน)
  equipment_type text,                    -- FieldMap.equipmentType (ประเภทครุภัณฑ์)
  asset_number text,                      -- FieldMap.assetNumber (เลขครุภัณฑ์/เลขพัสดุ)
  purchase_date text,                     -- FieldMap.purchaseDate (วันที่จัดซื้อ) — kept as text: source already treats this as free-form/tolerant-parsed, not a strict date
  install_location text,                  -- FieldMap.installLocation (สถานที่/จุดติดตั้ง)
  position text,                          -- FieldMap.position (ตำแหน่งของผู้รับผิดชอบ)
  full_name text,                         -- resolved from fullNameHeader, or titlePrefixHeader+nameHeader merged (see fields.ts getFullName) — UNREDACTED value; redaction happens in app code at display time, same as today
  brand text,                             -- resolved value from whichever ยี่ห้อ(...) column was filled in for this row's equipment type
  model text,                             -- resolved value from whichever รุ่น(...) column was filled in
  status text,                            -- soft-delete status column (blank/NULL = active, "จำหน่าย" = disposed) — header name itself varies per sheet, so only the resolved value is kept here
  raw_responses jsonb NOT NULL DEFAULT '{}'::jsonb,  -- every original header -> value for this row, verbatim, including any column not covered by the named columns above
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_equipment_asset_number ON equipment (asset_number);
CREATE INDEX idx_equipment_department ON equipment (department);
CREATE INDEX idx_equipment_status ON equipment (status);
CREATE INDEX idx_equipment_raw_responses ON equipment USING gin (raw_responses);


-- -----------------------------------------------------------------------------
-- EditLog — ประวัติการแก้ไข/การกระทำทุกชนิดในระบบ (เพิ่ม/แก้ไข/จำหน่ายครุภัณฑ์,
-- ล็อกอิน/ล็อกเอาท์, จัดการผู้ใช้, จองรถ/ห้องประชุม, อนุมัติของ ผอ. ฯลฯ)
-- action เป็น text ธรรมดา (ไม่ใช่ enum) เพราะรายการคำที่ใช้ได้ยังเพิ่มขึ้นเรื่อยๆ
-- ตามการใช้งานจริง — ดูคอมเมนต์ยาวของ EditLogAction ในโค้ดเดิมสำหรับคำที่ถูก
-- เลิกใช้ไปแล้วแต่ยังต้องอ่านแถวเก่าได้
-- -----------------------------------------------------------------------------
CREATE TABLE edit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "timestamp" timestamptz NOT NULL DEFAULT now(),
  action text NOT NULL,
  actor text NOT NULL,                    -- ผู้ทำรายการ (username, or "ผอ." for the director — see directorAuth.ts)
  department text,                        -- กลุ่มงาน
  legacy_row_number integer,              -- แถวที่ (เลขแถวเดิมในชีตครุภัณฑ์ ตอนที่บันทึก — คงไว้เพื่ออ้างอิงประวัติเก่าเท่านั้น)
  equipment_id uuid REFERENCES equipment (id) ON DELETE SET NULL,  -- new-style pointer, filled going forward (and best-effort backfilled at migration where the legacy row number could be matched)
  column_name text,                       -- คอลัมน์ (ชื่อคอลัมน์ที่ถูกแก้ — free text, matches the original sheet header at the time)
  old_value text,
  new_value text
);

CREATE INDEX idx_edit_log_timestamp ON edit_log ("timestamp" DESC);
CREATE INDEX idx_edit_log_actor ON edit_log (actor);
CREATE INDEX idx_edit_log_equipment_id ON edit_log (equipment_id);


-- -----------------------------------------------------------------------------
-- Users — บัญชีผู้ใช้งานระบบ (ไม่รวม ผอ. ซึ่งมีบัญชีเดียวแยกต่างหาก ดู
-- director_settings ด้านล่าง, และไม่รวม bootstrap superadmin ซึ่งตั้งค่าผ่าน
-- environment variable เท่านั้น ไม่มีแถวในตารางนี้)
-- -----------------------------------------------------------------------------
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text NOT NULL UNIQUE,
  password_hash text NOT NULL,            -- "salt:hash" scrypt format — same as today, app-level hashing unchanged
  role text NOT NULL DEFAULT 'user' CHECK (role IN ('superadmin', 'admin', 'user')),
  department text NOT NULL DEFAULT '',
  display_name text NOT NULL DEFAULT '',
  active boolean NOT NULL DEFAULT true,
  extra_permissions text[] NOT NULL DEFAULT '{}',
  revoked_permissions text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_users_username ON users (username);


-- -----------------------------------------------------------------------------
-- ReportSettings — ค่าตั้งค่าคงที่ของฟอร์มรายงานที่พิมพ์ได้ (ชื่อหน่วยงาน,
-- ชื่อฟอร์ม, ผู้รับทราบ, ขนาดตัวอักษร ฯลฯ) มีแถวเดียวเสมอ (singleton)
-- -----------------------------------------------------------------------------
CREATE TABLE report_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),  -- singleton-table pattern: guarantees exactly one row can ever exist
  org_name text NOT NULL DEFAULT 'โรงพยาบาลท่าตะเกียบ',
  maintenance_form_title text NOT NULL DEFAULT '',
  fiscal_year_label text NOT NULL DEFAULT '',
  acknowledger_name text NOT NULL DEFAULT '',
  acknowledger_position text NOT NULL DEFAULT '',
  acknowledger_department text NOT NULL DEFAULT '',
  print_font_size_pt text NOT NULL DEFAULT '14',
  print_header_font_size_pt text NOT NULL DEFAULT '16',
  print_table_font_size_px text NOT NULL DEFAULT '11',
  print_line_height text NOT NULL DEFAULT '0.9',
  print_signature_gap_px text NOT NULL DEFAULT '16',
  action_options jsonb NOT NULL DEFAULT '[]'::jsonb,
  hidden_action_options jsonb NOT NULL DEFAULT '[]'::jsonb,
  detail_required_action_options jsonb NOT NULL DEFAULT '[]'::jsonb,
  locked_action_options jsonb NOT NULL DEFAULT '[]'::jsonb,
  action_color_order jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);


-- -----------------------------------------------------------------------------
-- SpecStandards — มาตรฐานสเปกคอมพิวเตอร์ขั้นต่ำที่ IT ใช้ประเมิน + รายการ
-- ตัวเลือกใน dropdown ต่างๆ ที่ขยายได้เรื่อยๆ ตามการใช้งานจริง (singleton)
-- -----------------------------------------------------------------------------
CREATE TABLE spec_standards (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  min_ram_capacity_gb text NOT NULL DEFAULT '8',
  min_ram_type text NOT NULL DEFAULT 'DDR4',
  require_ssd text NOT NULL DEFAULT 'false',
  ram_capacity_options jsonb NOT NULL DEFAULT '[]'::jsonb,
  ram_speed_options jsonb NOT NULL DEFAULT '[]'::jsonb,
  storage_type_options jsonb NOT NULL DEFAULT '[]'::jsonb,
  storage_capacity_options jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);


-- -----------------------------------------------------------------------------
-- DirectorSettings — รหัสผ่านของ ผอ. (ผู้ใช้คนเดียว ไม่มี username) ถ้าแถวนี้
-- ไม่มีค่า ระบบจะ fallback ไปใช้ DIRECTOR_BOOTSTRAP_PASSWORD_HASH (env var)
-- -----------------------------------------------------------------------------
CREATE TABLE director_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  password_hash text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);


-- -----------------------------------------------------------------------------
-- MaintenanceLog — ประวัติการบำรุงรักษาเชิงป้องกัน (คนละตารางกับ
-- MaintenanceTasks ด้านล่าง — อันนี้คือ "บันทึกที่เกิดขึ้นแล้ว" อันนั้นคือ
-- "งานที่มอบหมาย/กำลังทำ")
-- -----------------------------------------------------------------------------
CREATE TABLE maintenance_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "timestamp" timestamptz NOT NULL DEFAULT now(),
  asset_number text NOT NULL,
  equipment_id uuid REFERENCES equipment (id) ON DELETE SET NULL,  -- best-effort link, filled at migration where asset_number matched an equipment row
  recorded_by text NOT NULL,
  software text NOT NULL DEFAULT '',      -- "name: version; name: version" free text (see fields.ts splitSoftwareEntries)
  maintenance_date text,                  -- kept as text, same tolerant-parse convention as source
  manual_spec_status text NOT NULL DEFAULT '' CHECK (manual_spec_status IN ('', 'ปกติ', 'ต่ำกว่ามาตรฐาน')),
  notes text NOT NULL DEFAULT ''
);

CREATE INDEX idx_maintenance_log_asset_number ON maintenance_log (asset_number);
CREATE INDEX idx_maintenance_log_timestamp ON maintenance_log ("timestamp" DESC);


-- -----------------------------------------------------------------------------
-- MaintenanceTasks — งานบำรุงรักษาที่มอบหมายให้เจ้าหน้าที่ IT แต่ละคน
-- (snapshot ข้อมูลครุภัณฑ์ไว้ตอนสร้างงาน ไม่ต้อง join กับตาราง equipment
-- สดทุกครั้งที่แสดงผล — ตามของเดิม)
-- -----------------------------------------------------------------------------
CREATE TABLE maintenance_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),  -- was taskId (already a uuid) — value preserved at migration
  created_at timestamptz NOT NULL DEFAULT now(),
  legacy_equipment_row_number integer,    -- kept for audit only, see equipment.legacy_row_number
  equipment_id uuid REFERENCES equipment (id) ON DELETE SET NULL,
  asset_number text,
  equipment_type text,
  brand_model text,
  department text,
  location text,
  assigned_to_username text,
  assigned_to_display_name text,
  status text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'done')),
  actions_taken jsonb NOT NULL DEFAULT '[]'::jsonb,
  inspection_checks jsonb NOT NULL DEFAULT '[]'::jsonb,
  parts_changed text NOT NULL DEFAULT '',
  other_detail text NOT NULL DEFAULT '',
  notes text NOT NULL DEFAULT '',
  completed_at timestamptz,
  completed_by_username text,
  planned_actions jsonb NOT NULL DEFAULT '[]'::jsonb,
  action_details jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX idx_maintenance_tasks_status ON maintenance_tasks (status);
CREATE INDEX idx_maintenance_tasks_assigned_to ON maintenance_tasks (assigned_to_username);
CREATE INDEX idx_maintenance_tasks_equipment_id ON maintenance_tasks (equipment_id);


-- -----------------------------------------------------------------------------
-- BookingResources — ทรัพยากรที่จองได้ (รถ/ห้องประชุม) — ไม่เคยลบจริง
-- (soft-deactivate ด้วย active=false) เพื่อให้การจองเก่ายังอ้างอิงชื่อ/
-- รายละเอียดเดิมได้ถูกต้อง
-- -----------------------------------------------------------------------------
CREATE TABLE booking_resources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),  -- was resourceId
  type text NOT NULL CHECK (type IN ('car', 'room')),
  name text NOT NULL,
  detail text NOT NULL DEFAULT '',
  active boolean NOT NULL DEFAULT true,
  image_data_url text NOT NULL DEFAULT '',  -- data:image/...;base64,... — kept as-is; consider moving to Supabase Storage in a later pass, out of scope for this migration
  seat_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by_username text NOT NULL DEFAULT ''
);

CREATE INDEX idx_booking_resources_type_active ON booking_resources (type, active);


-- -----------------------------------------------------------------------------
-- Drivers — คนขับรถที่ลงทะเบียนไว้ให้เลือกตอนจัดรถ (soft-deactivate เหมือน
-- BookingResources — TripOrder เก็บชื่อคนขับเป็น snapshot ข้อความ ไม่ใช่ FK
-- ตรงๆ ตามของเดิม เพื่อให้ประวัติเก่ายังอ่านได้แม้คนขับคนนั้นถูกปิดใช้งานแล้ว)
-- -----------------------------------------------------------------------------
CREATE TABLE drivers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),  -- was driverId
  name text NOT NULL,
  phone text NOT NULL DEFAULT '',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by_username text NOT NULL DEFAULT ''
);

CREATE INDEX idx_drivers_active ON drivers (active);


-- -----------------------------------------------------------------------------
-- Bookings — คำขอจองรถ/ห้องประชุมต้นฉบับจากผู้จอง (ไม่เคยถูกแก้ไขฟิลด์หลัก
-- โดยฝ่ายบริหารเลยตามเจตนาเดิม ยกเว้นชุดฟิลด์แคบๆ ที่อนุญาตผ่าน
-- edited_by_username/edited_at — ดูคอมเมนต์ยาวในโค้ดเดิมที่ Booking.tripOrderId)
--
-- start_time/end_time เป็น `timestamp` (ไม่มี time zone) โดยตั้งใจ — ค่าเดิม
-- ในชีตคือ "wall-clock เวลาท้องถิ่น ไม่แปลง timezone" เสมอ (ดูคอมเมนต์
-- splitBookingDateTime ในโค้ดเดิม) การใช้ `timestamp` แบบไม่มี time zone ใน
-- Postgres คือการเก็บค่าแบบเดียวกันนี้เป๊ะๆ โดยไม่มีการแปลงใดๆ แอบเกิดขึ้น
-- -----------------------------------------------------------------------------
CREATE TABLE bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),  -- was bookingId
  resource_id uuid REFERENCES booking_resources (id) ON DELETE RESTRICT,  -- NULL for every car booking (see PENDING_CAR_RESOURCE_NAME) — still set for a room booking
  resource_type text NOT NULL CHECK (resource_type IN ('car', 'room')),
  resource_name text NOT NULL,            -- snapshot at booking time, kept even if the resource is later renamed
  start_time timestamp NOT NULL,
  end_time timestamp NOT NULL,
  purpose text NOT NULL DEFAULT '',
  destination text NOT NULL DEFAULT '',   -- car only, '' for a room booking
  participants integer NOT NULL DEFAULT 0,
  contact_phone text NOT NULL DEFAULT '',
  booked_by_username text NOT NULL,
  booked_by_display_name text NOT NULL DEFAULT '',
  department text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz,
  cancelled_by_username text,
  approval_status text NOT NULL DEFAULT 'approved' CHECK (approval_status IN ('pending', 'approved', 'rejected')),
  approved_at timestamptz,
  approved_by_username text,
  companions text NOT NULL DEFAULT '',    -- car only
  trip_order_id uuid,                     -- FK added below, after trip_orders exists (the two tables reference each other)
  edited_by_username text,
  edited_at timestamptz,
  director_approval_status text NOT NULL DEFAULT '' CHECK (director_approval_status IN ('', 'pending', 'approved', 'rejected')),
  director_approved_at timestamptz,
  director_note text NOT NULL DEFAULT '',
  director_returned_at timestamptz
);

CREATE INDEX idx_bookings_resource_id ON bookings (resource_id);
CREATE INDEX idx_bookings_booked_by ON bookings (booked_by_username);
CREATE INDEX idx_bookings_director_approval_status ON bookings (director_approval_status);
CREATE INDEX idx_bookings_approval_status ON bookings (approval_status);
CREATE INDEX idx_bookings_time_range ON bookings (resource_id, start_time, end_time) WHERE cancelled_at IS NULL;
CREATE INDEX idx_bookings_trip_order_id ON bookings (trip_order_id);


-- -----------------------------------------------------------------------------
-- TripOrders — ใบสั่งงาน/ใบเดินทาง ที่ฝ่ายบริหารออกให้ครอบคลุมคำขอจองรถ
-- หนึ่งรายการขึ้นไป (รวมหลายคำขอเป็นเที่ยวเดียวกันได้ = "carpool")
--
-- หมายเหตุการออกแบบที่สำคัญ: ของเดิมเก็บ bookingIds เป็น array ซ้อนอยู่ใน
-- TripOrder เองด้วย (นอกเหนือจาก Booking.tripOrderId ที่ชี้กลับมา) ทำให้มี
-- 2 จุดที่เก็บความสัมพันธ์เดียวกัน เสี่ยงข้อมูลไม่ตรงกันได้ถ้าจุดใดจุดหนึ่งเพี้ยน
-- ในฐานข้อมูลนี้เก็บความสัมพันธ์นี้ไว้จุดเดียว (bookings.trip_order_id ชี้มาที่
-- ตารางนี้) แล้วหาเที่ยวที่ TripOrder หนึ่งครอบคลุมด้วยการ query
-- (SELECT * FROM bookings WHERE trip_order_id = ...) แทน ไม่เก็บซ้ำสองที่
-- -----------------------------------------------------------------------------
CREATE TABLE trip_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),  -- was tripOrderId
  resource_id uuid REFERENCES booking_resources (id) ON DELETE RESTRICT,  -- the actual car assigned — may differ from any covered booking's original request
  resource_name text NOT NULL,            -- snapshot at dispatch time
  driver_name text NOT NULL DEFAULT '',
  start_time timestamp NOT NULL,
  end_time timestamp NOT NULL,
  notes text NOT NULL DEFAULT '',
  created_by_username text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_trip_orders_resource_id ON trip_orders (resource_id);
CREATE INDEX idx_trip_orders_created_at ON trip_orders (created_at DESC);

-- Now that trip_orders exists, wire up the forward reference from bookings:
ALTER TABLE bookings
  ADD CONSTRAINT fk_bookings_trip_order_id
  FOREIGN KEY (trip_order_id) REFERENCES trip_orders (id) ON DELETE SET NULL;


-- -----------------------------------------------------------------------------
-- updated_at auto-maintenance — one trigger function, reused by every table
-- that has an updated_at column, so no app code has to remember to set it
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_equipment_updated_at
  BEFORE UPDATE ON equipment
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_report_settings_updated_at
  BEFORE UPDATE ON report_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_spec_standards_updated_at
  BEFORE UPDATE ON spec_standards
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_director_settings_updated_at
  BEFORE UPDATE ON director_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- -----------------------------------------------------------------------------
-- Seed the two singleton settings tables with one row each, using the same
-- defaults DEFAULT_REPORT_SETTINGS / DEFAULT_SPEC_STANDARDS already had in
-- code — so the app has sane settings to read even before the data
-- migration script runs (which will overwrite these with the hospital's
-- actual saved settings, if any exist in the current Google Sheet).
-- -----------------------------------------------------------------------------
INSERT INTO report_settings (
  id, org_name, maintenance_form_title, fiscal_year_label,
  acknowledger_name, acknowledger_position, acknowledger_department,
  print_font_size_pt, print_header_font_size_pt, print_table_font_size_px,
  print_line_height, print_signature_gap_px
) VALUES (
  true, 'โรงพยาบาลท่าตะเกียบ',
  'แบบฟอร์มการบำรุงรักษาเชิงป้องกันเครื่องคอมพิวเตอร์และครุภัณฑ์คอมพิวเตอร์',
  'ประจำปีงบประมาณ 2569',
  'นางขนัญธร เสียงล้ำ', 'เจ้าพนักงานเวชสถิติชำนาญงาน', 'กลุ่มงานประกันสุขภาพและกลุ่มงานสุขภาพดิจิทัล',
  '14', '16', '11', '0.9', '16'
) ON CONFLICT (id) DO NOTHING;

INSERT INTO spec_standards (
  id, min_ram_capacity_gb, min_ram_type, require_ssd,
  ram_capacity_options, ram_speed_options, storage_type_options, storage_capacity_options
) VALUES (
  true, '8', 'DDR4', 'false',
  '["2 GB", "4 GB", "8 GB", "16 GB", "32 GB", "64 GB"]'::jsonb,
  '["1333 MHz", "1600 MHz", "2133 MHz", "2400 MHz", "2666 MHz", "3200 MHz", "3600 MHz", "4800 MHz", "5600 MHz"]'::jsonb,
  '["HDD", "SSD (SATA)", "SSD (M.2 NVMe)", "eMMC"]'::jsonb,
  '["120 GB", "128 GB", "240 GB", "250 GB", "256 GB", "500 GB", "512 GB", "1 TB", "2 TB", "4 TB"]'::jsonb
) ON CONFLICT (id) DO NOTHING;

INSERT INTO director_settings (id, password_hash) VALUES (true, '')
ON CONFLICT (id) DO NOTHING;


-- -----------------------------------------------------------------------------
-- เปิดสิทธิ์ให้ service_role (ที่แอป server ใช้เชื่อมต่อ) เข้าถึงทุกตารางได้ครบ
-- จำเป็นเพราะตอนสร้างโปรเจกต์ เราปิด "Automatically expose new tables" ไว้
-- โดยตั้งใจ (เพื่อความปลอดภัย ไม่ให้ตารางใหม่เปิดสิทธิ์อัตโนมัติ) — ไม่เปิดให้
-- role สาธารณะ (anon/authenticated) เข้าถึง เพราะแอปนี้ไม่เคยเรียก Supabase
-- จากฝั่ง browser เลย เชื่อมต่อผ่านเซิร์ฟเวอร์ Next.js เท่านั้น
-- -----------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO service_role;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL PRIVILEGES ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL PRIVILEGES ON SEQUENCES TO service_role;
