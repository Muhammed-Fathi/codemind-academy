# Admin Guide

Step-by-step manual for CodeMind Academy administrators. The admin
portal is implemented as a single large component:
`src/components/admin/admin-dashboard.tsx`. Log in with the admin
demo account, then use the left sidebar to navigate.

> All admin endpoints are protected by `requireRole("ADMIN")` and live
> under `src/app/api/admin/`. Every action that changes data writes
> to the database and (where relevant) creates a notification
> respecting each recipient's preferences.

---

## Table of Contents

1. [Logging In](#1-logging-in)
2. [User Management](#2-user-management)
3. [Student Management](#3-student-management)
4. [Teacher Management](#4-teacher-management)
5. [Parent Management](#5-parent-management)
6. [Group Management](#6-group-management)
7. [Course Management](#7-course-management)
8. [Question Bank & AI Generation](#8-question-bank--ai-generation)
9. [Payment Management](#9-payment-management)
10. [Coupon Management](#10-coupon-management)
11. [Notification Management](#11-notification-management)
12. [Settings](#12-settings)
13. [Reports & Exports](#13-reports--exports)

---

## 1. Logging In

1. Navigate to the app root (`/`).
2. Click **"تسجيل الدخول"** (Sign In).
3. Use the quick-login button or enter credentials:
   - **Email**: `admin@codemind.academy`
   - **Password**: `admin123`
4. On success you land on the **Overview** dashboard
   (`view: "admin-overview"`).

> The demo admin account is created by `scripts/seed.ts`. To change
> the password, edit the seed or update the `User.password` field
> directly (use `hashPassword()` from `src/lib/auth.ts`).

---

## 2. User Management

CodeMind uses the `User` model as the root for all roles. Every user
has one of: `STUDENT`, `PARENT`, `TEACHER`, `ADMIN`. Role-specific
profiles (`Student`, `Parent`, `Teacher`) are linked 1—1 via
`userId`.

To create a new user, use the appropriate management view (Students,
Teachers, or have a Parent self-register via the landing page and link
their child).

To deactivate a user without deleting them, set `isActive = false`
on the `User` row (this prevents session restoration). Currently the
admin UI doesn't expose a dedicated deactivate toggle — contact a
developer to run:

```ts
await db.user.update({ where: { id }, data: { isActive: false } });
```

---

## 3. Student Management

**Sidebar item**: الطلاب (`admin-students`)
**API**: `GET/POST /api/admin/students`, `PATCH/DELETE /api/admin/students/[id]`

### 3.1 List students
- Searchable table with pagination (default 20 per page, max 100).
- Columns: name, email, phone, group, course, subscription status.
- Status filter (active / inactive).

### 3.2 Add a student
1. Click **"إضافة طالب"** (Add Student).
2. Fill the dialog:
   - Name (required)
   - Email (required, must be unique)
   - Phone (optional)
   - Password (required, will be scrypt-hashed on save)
   - Grade (default "2nd Secondary")
   - School name (optional)
   - Group (dropdown of existing groups; optional)
3. Click **"حفظ"**. The API:
   - Creates the `User` with role=STUDENT + hashed password.
   - Creates the linked `Student` profile.
   - If a group is selected, assigns `student.groupId`.

### 3.3 Edit a student
1. Click the edit (pencil) icon in a student row.
2. Update any field (name, phone, grade, school, group, password).
3. Click **"حفظ"**. Password is re-hashed if changed.

### 3.4 Assign / reassign to a group
1. Edit the student (see 3.3).
2. In the Group dropdown, pick the new group.
3. Save. The previous group's roster is updated automatically (the
   `Student.groupId` FK is updated; nothing else needs to move).

### 3.5 Delete a student
1. Click the delete (trash) icon in a student row.
2. Confirm the deletion dialog.
3. The `User` + `Student` + cascading records
   (`LessonProgress`, `QuizAttempt`, `Attendance`, `HomeworkSubmission`,
   `LessonBookmark`, `LessonNote`, `ExamAttempt`, `StudyTask`,
   `StudentBadge`, `Referral`) are deleted.

### 3.6 Export students as CSV
1. Click **"Export CSV"** (next to "Add Student").
2. The browser downloads `students-progress-<timestamp>.csv` with
   UTF-8 BOM (for Arabic support) and 18 columns:
   - Name, Email, Phone, Group, Course, Enrolled
   - Lessons Completed / Total / %
   - Attendance %
   - Quizzes Taken / Passed
   - Avg Quiz Score
   - Homework Submitted / Graded
   - Subscription Status / Plan / End Date

---

## 4. Teacher Management

**Sidebar item**: المعلمون (`admin-teachers`)
**API**: `GET/POST /api/admin/teachers`

### 4.1 List teachers
- Cards or table with name, email, specialty, bio, group count,
  total students.

### 4.2 Add a teacher
1. Click **"إضافة معلم"** (Add Teacher).
2. Fill the dialog:
   - Name (required)
   - Email (required, unique)
   - Phone (optional)
   - Password (required, scrypt-hashed)
   - Bio (optional, Arabic free text)
   - Specialty (optional, e.g. "Machine Learning")
3. Click **"حفظ"**. The API:
   - Creates the `User` with role=TEACHER.
   - Creates the linked `Teacher` profile.

### 4.3 Edit a teacher
- Edit name, email, phone, password, bio, specialty.

### 4.4 Assign to groups
- Teachers are assigned to groups via the **Groups** view
  (section 6.4 below). A teacher can be assigned to multiple groups.

---

## 5. Parent Management

Parents are not directly created by the admin — they self-register via
the landing page and link their children themselves.

### 5.1 How a parent joins
1. Parent visits the landing page.
2. Clicks **"إنشاء حساب"** (Sign Up).
3. Selects the **Parent** role.
4. Fills name, email, password.
5. On first login, the parent dashboard shows an empty state with a
   "ربط طالب" (Link Student) button.
6. Parent enters the student's email → API validates → creates a
   `ParentStudentLink`.

### 5.2 Linking multiple students to one parent
- From the parent dashboard, click **"ربط طالب أخر"**.
- The API: `POST /api/parents/me/link-student` accepts `{ email }`,
  validates that the email belongs to a STUDENT, and creates a
  `ParentStudentLink` row.
- A parent can link an unlimited number of students.

### 5.3 Unlinking a student
- Currently no admin UI for unlinking. Developer can run:
  ```ts
  await db.parentStudentLink.delete({
    where: { parentId_studentId: { parentId, studentId } }
  });
  ```

---

## 6. Group Management

**Sidebar item**: المجموعات (`admin-groups`)
**API**: `GET/POST /api/admin/groups`, `PATCH/DELETE /api/admin/groups/[id]`

### 6.1 List groups
- Cards showing: name, course, teacher, student count / capacity
  bar, schedule, active toggle.

### 6.2 Create a group
1. Click **"إضافة مجموعة"** (Add Group).
2. Fill the form:
   - Name (e.g. "Group A — Sat & Tue 6PM")
   - Course (dropdown — e.g. "Programming & AI")
   - Teacher (dropdown of all teachers; optional)
   - Capacity (default 20)
   - Schedule (free text, default "Sat & Tue, 6:00 PM")
   - Active (default true)
3. Click **"حفظ"**.

### 6.3 Edit a group
- Update name, course, teacher, capacity, schedule, active.
- Changing the capacity does not auto-unenroll students if the new
  capacity is below the current student count — handle with care.

### 6.4 Assign a teacher to a group
1. Edit the group.
2. In the Teacher dropdown, pick the teacher.
3. Save. The `Group.teacherId` FK is updated.

### 6.5 Delete a group
1. Click delete on a group card.
2. Confirm. Students previously in the group have their `groupId`
   set to null (the `Student.groupId` relation is optional, not
   cascading).

---

## 7. Course Management

**Sidebar item**: الكورسات (`admin-courses`)
**API**: `GET /api/admin/courses`

### 7.1 View curriculum
- Read-only tree viewer: Course → Parts → Units → Topics → Lessons.
- Shows lesson metadata: title (Ar + En), duration, isLocked,
  isPublished, has video, has PDF, has summary.

### 7.2 Modifying curriculum content
- Course content is seeded via `scripts/seed.ts` which reads
  `src/lib/curriculum.ts`. To add/edit lessons:
  1. Edit `src/lib/curriculum.ts` to add/modify the curriculum data.
  2. Reset the database (`rm db/custom.db && bun run db:push`) and
     re-run `bun run scripts/seed.ts`.
- Per-lesson metadata (video URL, PDF URL, summary, isLocked,
  isPublished) can be edited by a developer directly via Prisma:
  ```ts
  await db.lesson.update({
    where: { id },
    data: { videoUrl, pdfUrl, summary, isLocked, isPublished }
  });
  ```
- **Bulk lesson editing UI is Not Currently Implemented.**

---

## 8. Question Bank & AI Generation

**Sidebar item**: Question Bank (`admin-question-bank`)
**API**: `GET/POST /api/admin/question-bank`, `POST /api/admin/ai-generate-quiz`

### 8.1 List questions
- Searchable list with difficulty (EASY/MEDIUM/HARD) and type
  (MCQ / TRUE_FALSE) filters.
- Shows: prompt (Ar + En), type, difficulty, marks, linked lesson.

### 8.2 Add a question manually
1. Click **"إضافة سؤال"** (Add Question).
2. Fill the dialog:
   - Type: MCQ or TRUE_FALSE
   - Prompt (English, required)
   - Prompt (Arabic, optional but recommended)
   - Options (dynamic add/remove; for TRUE_FALSE the options are
     auto-set to ["True", "False"])
   - Correct answer (radio picker — for MCQ this is the option index,
     for TRUE_FALSE it's "0" or "1")
   - Explanation (shown after a student submits)
   - Difficulty (EASY / MEDIUM / HARD)
   - Marks (default 1)
3. Click **"حفظ"**.

### 8.3 Generate questions with AI
1. Click **"AI Generate"** (Sparkles icon, next to Add Question).
2. Expand the panel.
3. Pick a **Lesson** from the dropdown (all lessons in the
   curriculum are listed).
4. Pick **Question count** (3 / 5 / 7 / 10).
5. Pick **Difficulty** (MIXED / EASY / MEDIUM / HARD).
6. Click **"ولّد الأسئلة"** (Generate Questions).
7. Wait ~30 s — the loading spinner shows "جارٍ التوليد... (30
   ثانية)".
8. On success: toast "اتولّدت N أسئلة بالـAI 🤖" and the new
   questions appear in the list.

**Backend behavior** (`POST /api/admin/ai-generate-quiz`):
- Builds context from the lesson's full hierarchy (course → part →
  unit → topic → lesson title, description, summary).
- Sends an Egyptian Arabic system prompt requesting JSON-formatted
  questions to the z-ai-web-dev-sdk LLM.
- Parses the LLM response, extracts JSON, validates structure.
- Creates a `Quiz` for the lesson (if one doesn't exist) + creates
  `Question` rows.
- Returns `{ generated: count, questions: [...], quizId }`.

### 8.4 Edit / delete a question
- Currently no admin UI for editing individual questions. Developer
  can use Prisma directly:
  ```ts
  await db.question.update({ where: { id }, data: { prompt, options, answer } });
  await db.question.delete({ where: { id } });
  ```

---

## 9. Payment Management

**Sidebar item**: المدفوعات (`admin-payments`)
**API**: `GET /api/admin/payments`, `POST /api/admin/payments/[id]/approve`, `POST /api/admin/payments/[id]/reject`, `POST /api/admin/payments/import` (FormData), `GET /api/admin/payments/import` (template download)

### 9.1 List payments
- Table with: student name, amount, method, reference, status, date.
- Pending rows highlighted amber.
- Status filter (PENDING / APPROVED / REJECTED / EXPIRED).
- Pagination (default 20, max 100).

### 9.2 Approve a payment
1. Find the pending payment row (amber highlight).
2. Click the **green ✓ (Approve)** icon.
3. Confirm. The API:
   - Sets `Payment.status = APPROVED`.
   - Looks up the linked `Subscription` and activates it:
     `status = ACTIVE`, `startDate = now`, `endDate = now + plan.durationMonths`.
   - Sends a `PAYMENT_APPROVED` notification to the student
     (respecting their `NotificationPreference` + quiet hours).

### 9.3 Reject a payment
1. Find the pending payment row.
2. Click the **red ✕ (Reject)** icon.
3. Confirm. The API:
   - Sets `Payment.status = REJECTED`.
   - Sends a `PAYMENT_REJECTED` notification (respecting prefs).
   - The student's subscription remains PENDING; the student must
     re-submit a payment.

### 9.4 Bulk import payments from xlsx
1. Click **"تحميل Template"** (Download Template).
2. The browser downloads an xlsx template with 2 example rows.
3. Fill the template with payment rows. Supported columns (English or
   Arabic headers):
   - `userEmail` / `email` / `الإيميل`
   - `amount` / `المبلغ`
   - `method` / `الطريقة` — values: `INSTAPAY`, `VODAFONE_CASH`, `ETISALAT_CASH`
   - `reference` / `المرجع`
   - `status` / `الحالة` — values: `PENDING`, `APPROVED`, `REJECTED`, `EXPIRED`
   - `notes` / `ملاحظات` (optional)
4. Click **"استيراد xlsx"** (Import xlsx).
5. Select the filled xlsx file.
6. The import results panel shows:
   - **Created** count (rows that became Payment rows)
   - **Failed** count (rows with errors)
   - Per-row error details (e.g. "user not found", "invalid method")
7. Click **"حفظ"** to dismiss. Created payments are immediately
   visible in the table.

**Backend behavior**:
- `POST /api/admin/payments/import` accepts FormData with the xlsx
  file.
- Uses `xlsx` package (`XLSX.read` + `XLSX.utils.sheet_to_json`).
- Validates each row (finds user by email, validates method/status).
- Creates Payment records in bulk.
- Returns `{ created, failed, total, results: [...] }`.

### 9.5 Recording a manual payment (alternative)
- Instead of importing, students initiate payments via the enrollment
  wizard (Course → Group → Plan → Payment → Confirm). Each enrollment
  creates a PENDING Payment + PENDING Subscription. The admin then
  approves via section 9.2.

---

## 10. Coupon Management

**Sidebar item**: أكواد الخصم (`admin-coupons`)
**API**: `GET/POST /api/admin/coupons`, `PATCH/DELETE /api/admin/coupons/[id]`, `POST /api/coupons/validate` (public)

### 10.1 List coupons
- Cards showing: code (monospace), type (PERCENTAGE / FIXED), value,
  used / max (e.g. "0 / 100"), valid from → until, active toggle,
  description.
- Empty state with Ticket icon if no coupons exist.

### 10.2 Create a coupon
1. Click **"كود جديد"** (New Coupon).
2. Fill the form:
   - Code (3+ chars, will be uppercased, must be unique)
   - Type: PERCENTAGE (value 10 = 10% off) or FIXED (value 50 = 50 EGP off)
   - Value (number)
   - Max uses (default 100)
   - Valid from (default now)
   - Valid until (optional)
   - Description (optional)
3. Click **"حفظ"**. The coupon is immediately usable by students
   during enrollment.

### 10.3 Validate a coupon (student side)
- Students enter the coupon code in the enrollment wizard
  (Payment step → "عندك كود خصم?") and click **"اتحقق"**.
- The API: `POST /api/coupons/validate` checks:
  - Coupon exists.
  - Coupon is active.
  - Coupon is not expired (`validUntil` is null or in the future).
  - Coupon is not fully used (`usedCount < maxUses`).
  - User has not already redeemed this coupon (unique
    `CouponRedemption` per `[couponId, userId]`).
- Returns `{ valid, discount, finalPrice }`.

### 10.4 Activate / deactivate a coupon
- Click the **active toggle** on a coupon card.
- Inactive coupons fail validation immediately.

### 10.5 Delete a coupon
1. Click delete on a coupon card.
2. Confirm. Past `CouponRedemption` records are also deleted
   (cascade).

### 10.6 Referral discount coupons
- When a student completes a referral (their invitee signs up), the
  system auto-creates a 10% discount coupon with code `REF-XXXXXX`
  (derived from the referrer's student ID), 1 max use, active.
- These appear in the coupon list like any other coupon and can be
  deactivated / deleted by the admin.

---

## 11. Notification Management

**Sidebar item**: الإشعارات (`admin-notifications`)
**API**: `GET/POST /api/admin/notifications` (broadcast), `GET /api/admin/notifications-center` (center)

### 11.1 Broadcast a notification
1. In the **Send Notification** form:
   - Title (required)
   - Message (required, Arabic)
   - Target audience:
     - All students
     - All parents
     - All teachers
     - Specific user (by email)
   - Type (e.g. ANNOUNCEMENT, NEW_LESSON, MONTHLY_REPORT)
2. Click **"إرسال"** (Send).
3. The API creates a `Notification` row for every matching user,
   respecting each user's `NotificationPreference` and quiet hours
   (notifications are skipped silently for users who have disabled
   that type or are in quiet hours).

### 11.2 View the Notification Center
1. The Notification Center is rendered alongside the broadcast form.
2. **4 stat cards** show: Total / Read / Unread / Types count.
3. **Type breakdown** as clickable filter chips — click a chip to
   filter the list by that type.
4. **Full notification list** with:
   - Read/unread colored dot
   - User name + role + email
   - Timestamp (relative + absolute)
   - Type badge
   - Message preview (truncated)
5. Pagination (page + pageSize, default 20, max 100).

### 11.3 Important behavior notes
- Notifications are **in-app only**. There is no email or SMS
  delivery — the `emailEnabled` toggle in user preferences is a
  placeholder for future integration.
- The notification bell in the dashboard header polls
  `/api/notifications/unread-count` every 30 s.
- Notifications are created via `createNotificationIfAllowed()` in
  `src/lib/notify.ts`, which checks the user's preference and quiet
  hours before inserting the row.

---

## 12. Settings

**Sidebar item**: الإعدادات (`admin-settings`)
**API**: `GET/PUT /api/admin/settings`, `GET /api/settings/public` (public)

### 12.1 Brand settings
- `brand_name` — platform name (default "CodeMind Academy")
- `brand_tagline` — tagline (default "Learn. Build. Think.")
- `whatsapp_teacher` — teacher WhatsApp number
- `whatsapp_technical` — technical support WhatsApp number
- `whatsapp_subscription` — subscriptions WhatsApp number
- `academic_year` — e.g. "2024 / 2025"

### 12.2 Subscription prices
- `price_monthly` — monthly plan price in EGP (default 200)
- `price_3months` — 3-month plan price (default 550)
- `price_6months` — 6-month plan price (default 1000)
- `price_early_bird` — early bird promo price (default 100)

### 12.3 Save
- Click **"حفظ"** (Save) to persist all 10 settings to the `Setting`
  table (key/value pairs).
- The landing page reads these via `GET /api/settings/public` (no
  auth) and renders them in the hero, footer, pricing section, and
  WhatsApp help card.

### 12.4 Defaults vs overrides
- If a setting is missing from the DB, the UI falls back to the
  defaults in `src/lib/brand.ts`.
- Setting a value in the DB always overrides the brand.ts default.

---

## 13. Reports & Exports

### 13.1 Student progress CSV (admin)
- **Trigger**: Students view → "Export CSV" button.
- **Endpoint**: `GET /api/admin/export-progress`.
- **Columns** (18): Name, Email, Phone, Group, Course, Enrolled,
  Lessons Completed / Total / %, Attendance %, Quizzes Taken / Passed,
  Avg Quiz Score, Homework Submitted / Graded, Subscription Status /
  Plan / End Date.
- **Format**: CSV with UTF-8 BOM (for Arabic support).
- **Filename**: `students-progress-<timestamp>.csv`.

### 13.2 Revenue Analytics
- **Sidebar**: Overview → Revenue Analytics section.
- **Endpoint**: `GET /api/admin/revenue-analytics?months=6`.
- **Displays**:
  - 4 revenue stat cards (Total Revenue, Avg Payment, Paying Users,
    Pending Revenue)
  - Growth indicator card (green/red)
  - Bar chart: Revenue by Month (emerald gradient)
  - Payment method breakdown (INSTAPAY / VODAFONE_CASH /
    ETISALAT_CASH counts + revenue) with animated progress bars
- **Configurable**: `?months=` query param (default 6, max 24).

### 13.3 Revenue Forecast
- **Sidebar**: Overview → Revenue Forecast section.
- **Endpoint**: `GET /api/admin/revenue-forecast`.
- **Displays**:
  - Trend indicator card (green/gray/red) with percentage
  - Revenue Projection BarChart (historical = emerald, forecast =
    amber diagonal stripes)
  - Projected Q+1 Revenue card
  - Monthly forecast cards with confidence badges (ثقة عالية /
    متوسطة / منخفضة)
  - Subscription Insights (active count, expiring this month,
    expected renewal rate)
- **Algorithm**: linear regression (y = mx + b) on last 6 months of
  revenue, projects next 3 months. Confidence is high if ≥6 months of
  data exist, medium if 3-5, low if <3.

### 13.4 Notification Center stats
- **Sidebar**: Notifications view.
- **Endpoint**: `GET /api/admin/notifications-center?type=<TYPE>&page=1&pageSize=20`.
- **Returns**: `{ stats: { total, read, unread, byType },
  notifications: [...], pagination: {...} }`.

### 13.5 Audit logs
- The `AuditLog` model exists in the schema but is **not currently
  populated by API routes**. To enable audit logging for admin
  actions, wrap your API handlers with:
  ```ts
  await db.auditLog.create({
    data: { userId: user.id, action: "approve-payment", entity: "Payment", entityId, details: "..." }
  });
  ```

---

## Quick Reference

| Task                              | Sidebar → View          | API endpoint                                                |
| --------------------------------- | ----------------------- | ----------------------------------------------------------- |
| Add student                       | الطلاب                  | `POST /api/admin/students`                                  |
| Add teacher                       | المعلمون                | `POST /api/admin/teachers`                                  |
| Create group                      | المجموعات               | `POST /api/admin/groups`                                    |
| Add question (manual)             | Question Bank           | `POST /api/admin/question-bank`                             |
| Generate questions with AI        | Question Bank           | `POST /api/admin/ai-generate-quiz`                          |
| Approve payment                   | المدفوعات               | `POST /api/admin/payments/[id]/approve`                     |
| Reject payment                    | المدفوعات               | `POST /api/admin/payments/[id]/reject`                      |
| Download payment template         | المدفوعات               | `GET /api/admin/payments/import`                            |
| Bulk import payments              | المدفوعات               | `POST /api/admin/payments/import`                           |
| Create coupon                     | أكواد الخصم             | `POST /api/admin/coupons`                                   |
| Toggle coupon active              | أكواد الخصم             | `PATCH /api/admin/coupons/[id]`                             |
| Broadcast notification            | الإشعارات               | `POST /api/admin/notifications`                             |
| View notification center          | الإشعارات               | `GET /api/admin/notifications-center`                       |
| Edit brand settings               | الإعدادات               | `PUT /api/admin/settings`                                   |
| Export all students as CSV        | الطلاب                  | `GET /api/admin/export-progress`                            |
| View revenue analytics            | Overview                | `GET /api/admin/revenue-analytics`                         |
| View revenue forecast             | Overview                | `GET /api/admin/revenue-forecast`                           |
