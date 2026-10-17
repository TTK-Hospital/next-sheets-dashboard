This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## ระบบ login + จัดการข้อมูลครุภัณฑ์ (สิทธิ์ superadmin / admin)

แดชบอร์ดหลัก (`/`) เป็น **public ดูได้โดยไม่ต้อง login เหมือนเดิม** — เฉพาะหน้า "จัดการข้อมูล"
(`/manage`) และ "จัดการผู้ใช้" (`/manage/users`) เท่านั้นที่ต้อง login ผ่าน `/login`

มี 2 สิทธิ์:

- **superadmin** — เห็น/แก้ไขครุภัณฑ์ได้ทุกกลุ่มงาน, เพิ่มครุภัณฑ์ใหม่ได้, "จำหน่ายครุภัณฑ์"
  ได้ (soft delete — เปลี่ยนคอลัมน์สถานะเป็น "จำหน่ายแล้ว" ไม่ลบแถวจริง), และจัดการบัญชีผู้ใช้
  ได้ที่ `/manage/users`
- **admin** — แก้ไขข้อมูลครุภัณฑ์ได้เฉพาะกลุ่มงานของตัวเอง (เพิ่ม/จำหน่ายไม่ได้)

บัญชีผู้ใช้ทั้งหมดเก็บอยู่ในแท็บ **Users** ของสเปรดชีตเดียวกัน (เก็บเฉพาะ hash ของรหัสผ่าน
ไม่เคยเก็บรหัสผ่านจริง) และจัดการได้เองผ่านหน้าเว็บ ไม่ต้องแก้โค้ด

### เตรียม Google Sheet

1. แชร์สเปรดชีตให้ service account (`GOOGLE_SERVICE_ACCOUNT_EMAIL`) เป็นสิทธิ์ **Editor**
   (ไม่ใช่แค่ Viewer — ฟีเจอร์แก้ไข/เพิ่ม/จำหน่าย ต้องเขียนกลับเข้าไปในชีต)
2. เพิ่มแท็บใหม่ชื่อ **`Users`** (หรือชื่อที่ตั้งใน `GOOGLE_SHEET_USERS_TAB`) พร้อม header
   แถวแรก:
   ```
   Username | PasswordHash | Role | Department | DisplayName | Active
   ```
   ไม่ต้องกรอกข้อมูลในแท็บนี้เอง — สร้างบัญชีจริงผ่านหน้า "จัดการผู้ใช้" หลัง login ครั้งแรก
   ด้วยบัญชี bootstrap (ดูด้านล่าง) ยกเว้นกรณีฉุกเฉินอยากปิดบัญชีใดบัญชีหนึ่งทันที ก็แก้คอลัมน์
   `Active` เป็น `N` ในชีตตรงๆ ได้เลย (`Y`/ว่าง = เปิดใช้งาน)
3. เพิ่มคอลัมน์ **สถานะ** ในชีตข้อมูลครุภัณฑ์หลัก (ชีตที่มาจาก Google Form) ใช้บันทึกว่าแถวนั้น
   "ใช้งาน" หรือ "จำหน่ายแล้ว" — ถ้ายังไม่มีคอลัมน์นี้ แดชบอร์ด/หน้าจัดการยังทำงานได้ปกติ (ถือว่า
   ทุกแถว "ใช้งาน") แต่ปุ่ม "จำหน่าย" จะใช้ไม่ได้จนกว่าจะเพิ่มคอลัมน์นี้
4. เพิ่มแท็บใหม่ชื่อ `EditLog` (หรือชื่อที่ตั้งใน `GOOGLE_SHEET_EDIT_LOG_TAB`) พร้อม header
   แถวแรก: `เวลา | การกระทำ | ผู้ทำรายการ | กลุ่มงาน | แถวที่ | คอลัมน์ | ค่าเดิม | ค่าใหม่` —
   ทุกการแก้ไข/เพิ่ม/จำหน่าย/จัดการผู้ใช้ จะถูกบันทึกที่นี่

### ตั้งค่า `.env.local`

คัดลอก `.env.local.example` เป็น `.env.local` (ถ้ายังไม่มี) แล้วเพิ่ม:

- `EDIT_SESSION_SECRET` — สตริงสุ่มยาวๆ เซ็นชื่อ session cookie หลัง login (ดูวิธีสร้างในไฟล์
  ตัวอย่าง)
- `BOOTSTRAP_SUPERADMIN_USERNAME`, `BOOTSTRAP_SUPERADMIN_PASSWORD_HASH` — บัญชี superadmin
  สำรอง ใช้ login ครั้งแรกตอนแท็บ Users ยังว่างเปล่า (ปัญหาไก่-ไข่: ต้อง login ก่อนถึงจะสร้าง
  บัญชีจริงในเว็บได้) ใช้ได้เสมอไม่ว่าแท็บ Users จะมีปัญหาหรือไม่ก็ตาม — หลัง login ด้วยบัญชีนี้
  แล้วให้รีบไปสร้างบัญชี superadmin จริงของฝ่ายบริหาร/IT ที่ `/manage/users`
- `GOOGLE_SHEET_USERS_TAB` — ทางเลือก ชื่อแท็บ Users (ค่าเริ่มต้น: `Users` ถ้าไม่ตั้ง)

**แนะนำให้ทดสอบระบบนี้กับสเปรดชีตสำเนา แยกจากชีตจริงที่ใช้งานอยู่** เพราะเป็นการเขียนข้อมูล
กลับ ความผิดพลาดระหว่างพัฒนาจะกระทบข้อมูลจริงทันทีถ้าใช้ชีตเดียวกัน

### หน้า /director (รับทราบการเดินทางโดยผู้อำนวยการ)

หน้าพิเศษแยกออกจากระบบหลักทั้งหมด สำหรับให้ ผอ. รับทราบ/ไม่รับทราบรายการเดินทาง
**หลังจาก**ผู้ดูแลระบบจัดรถ/คนขับให้แล้ว (ไม่ใช่ขั้นอนุมัติก่อนจัดรถ) — ล็อกอินด้วยรหัสผ่านอย่าง
เดียว ไม่ต้องใส่ username

1. เพิ่มคอลัมน์ `DirectorApprovalStatus`, `DirectorApprovedAt` ต่อจากคอลัมน์สุดท้ายเดิมของแท็บ
   `Bookings` (คอลัมน์ X, Y) — สเปรดชีตที่มีแท็บ Bookings อยู่แล้วก่อนอัปเดตนี้ต้องเพิ่มสองคอลัมน์
   นี้เอง ไม่งั้น Google Sheets API จะเขียนคอลัมน์ผิดตำแหน่งเมื่อมีคอลัมน์ไม่ครบ
2. เพิ่มแท็บใหม่ชื่อ **`DirectorSettings`** (หรือชื่อที่ตั้งใน
   `GOOGLE_SHEET_DIRECTOR_SETTINGS_TAB`) — เก็บรหัสผ่านที่ ผอ. ตั้งเองผ่านหน้า /director (คอลัมน์
   A/B พอ ไม่ต้องมี header ก็ได้ แอปจะเขียนแถวเดียวคือ `passwordHash | <hash>` ให้เอง)
3. ตั้งค่า `DIRECTOR_BOOTSTRAP_PASSWORD_HASH` ใน `.env.local` — รหัสผ่านตั้งต้นก่อน ผอ. จะเปลี่ยน
   เอง (ดูวิธีสร้างในไฟล์ `.env.local.example`)

ไม่กระทบขั้นตอนอนุมัติ/จัดรถเดิมของผู้ดูแลระบบเลย — เป็นแค่ชั้นรับทราบเพิ่มเติมสำหรับการจองรถ
เท่านั้น (ไม่รวมห้องประชุม)

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
