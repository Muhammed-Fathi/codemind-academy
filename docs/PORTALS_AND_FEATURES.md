# Portals & Features

This document is the canonical reference for **every feature implemented
in each of the 4 portals** (Student, Parent, Teacher, Admin). It is
sourced from `worklog.md` (16 development rounds) and verified
against the actual code in `src/components/` and `src/app/api/`.

For step-by-step admin usage, see [`ADMIN_GUIDE.md`](ADMIN_GUIDE.md).

---

## Table of Contents

1. [Student Portal](#1-student-portal)
2. [Parent Portal](#2-parent-portal)
3. [Teacher Portal](#3-teacher-portal)
4. [Admin Portal](#4-admin-portal)
5. [Cross-Portal Features](#5-cross-portal-features)

---

## 1. Student Portal

**Home view**: `student-dashboard`
**Sidebar items**: Dashboard · الكورس · Mock Exams · Bookmarks · Study
Plan · Referral · تقدمي · Leaderboard · Achievements · الشهادة ·
الواجبات · الإشعارات

### 1.1 Dashboard
`src/components/student/student-dashboard.tsx` · `GET /api/students/me/dashboard`
- Welcome header with student name + group info
- **Continue Learning** card (last viewed lesson, progress %)
- **Next Live Session** card (date/time, teacher, "انضم للـSession" button)
- **Attendance summary** (present/absent counts, percentage)
- **Recent Quizzes** list (title, score %, pass/fail badge)
- **Pending Homework** list (deadline countdown, status)
- Subscription status banner (active / pending / expired)
- Empty / loading / error states with Egyptian Arabic copy
- Framer Motion staggered entrances

### 1.2 Course View
`src/components/course/student-course.tsx` · `GET /api/courses/[slug]`
- Curriculum tree: Part → Unit → Topic → Lesson
- Lesson cards with title (Ar + En), duration, lock state
- Completion checkmarks on lessons with `LessonProgress.isCompleted`
- Locked lessons (first lesson is unlocked by default in the seeder)
- Click a lesson → `student-lesson` view

### 1.3 Lesson View
`src/components/course/student-lesson.tsx` · `GET /api/lessons/[id]`
- **Video player** (YouTube embed via `videoUrl`)
- **PDF download** link (via `pdfUrl`)
- **Summary** card (Arabic lesson summary text)
- **Bookmark toggle** in header (amber-filled state with toast feedback)
- **Progress tracker** (auto-updates `LessonProgress.progress` 0-100
  and `lastViewedAt`)
- **Sticky Notes** section (`LessonNotesSection`):
  - "أضف" (Add) button reveals a textarea
  - Notes list (max-h-64 scroll area), each note shows content,
    timestamp, hover-revealed edit + delete buttons
  - Edit mode: inline textarea with save/cancel
  - Empty state with StickyNote icon
- **Quizzes** for this lesson (link to Quiz Runner)
- **Homework** for this lesson (link to Homework view)
- API: `GET /api/lessons/[id]`, `POST /api/lessons/[id]/progress`,
  `GET/POST/DELETE /api/students/me/notes`

### 1.4 Quiz Runner
`src/components/course/quiz-runner.tsx` · `GET /api/quizzes/[id]`, `POST /api/quizzes/[id]/submit`
- Fetches quiz + questions + options
- One question per screen with AnimatePresence transitions
- MCQ (radio cards) + True/False (binary cards)
- Difficulty badge per question
- Progress bar + question counter
- Submit → instant grading with `QuizAttempt` persisted
- Result screen: score hero (pass/fail), per-question review with
  correct (emerald) / incorrect (rose) highlighting
- Explanations displayed after submit

### 1.5 Mock Exams
`src/components/student/mock-exam.tsx` · `GET/POST /api/exams/mock`
- **Setup**: choose question count (5/10/15) + difficulty
  (سهل/متوسط/صعب/متقدم)
- **Exam**: countdown timer (pulses red < 60 s), question dots with
  ring on current, option A/B/C/D selection, prev/next navigation,
  submit button
- Randomized question order + shuffled MCQ options
- **Result**: score hero (gradient trophy), answer review cards with
  correct/incorrect highlighting + explanations
- Persists an `ExamAttempt` row (with answers JSON)
- API query params: `?count=10&difficulty=mixed|EASY|MEDIUM|HARD&examType=MOCK`

### 1.6 Homework
`src/components/student/student-dashboard.tsx` (HomeworkView tab) · `GET /api/students/me/homework`
- Homework list with deadline + status badge
- GRADED status with grade (e.g. "8/10") + feedback text
- SUBMITTED status ("اتبعثت — مستنية التصحيح")
- LATE status ("اتبعثت متأخر")
- PENDING status ("لسه متبعثش")
- Deadline badge turns red when pending + close to deadline
- Submit content / file URL via POST to the homework endpoint

### 1.7 Notifications
`src/components/student/student-dashboard.tsx` (NotificationsView tab) · `GET /api/notifications`
- Full notification list with type badges
- Read / unread indicators
- "تحديد كمقروء" (mark as read) action
- Click notification → navigate to linked view (e.g. `link: "course"`)
- Polled by the dashboard bell every 30 s via `/api/notifications/unread-count`

### 1.8 Progress
`src/components/student/student-dashboard.tsx` (ProgressView tab)
- Course completion % (lessons completed / total)
- Attendance % over time
- Quiz performance trend (last 6 attempts)
- Homework submitted / graded counts
- Activity timeline (recent lessons, quizzes, homework, attendance)
- **Export CSV** button (BackBar) → `GET /api/students/me/export-progress`
  returns CSV with 6 columns (Type, Title, Topic, Date, Score/Status,
  Details)

### 1.9 Gamification (XP, Levels, Badges)
`src/components/student/gamification-panel.tsx` · `GET /api/students/me/gamification`
- **Engine**: `src/lib/gamification.ts`
  - XP_RULES: lesson=50, quiz passed=30, perfect bonus=50, homework=20,
    graded-high=25, attendance=10, daily login=5
  - LEVELS: 6 levels — مبتدئ (0 XP) → طالب (100) → متمكن (300) →
    محترف (600) → خبير (1000) → أسطورة (1500)
  - BADGES: 9 badges — first-lesson, lesson-explorer, quiz-rookie,
    quiz-master, perfect-score, homework-hero, attendance-streak,
    week-streak, month-streak
  - `buildStats()` computes lessonsCompleted, quizzesTaken/Passed,
    avgQuizPct, homeworkSubmitted/Graded, attendancePct, currentStreak
    (consecutive active days, 60-day window), longestStreak
- **UI**:
  - Level card with gradient header, XP number, progress bar to next
    level (e.g. "23% to Level 4")
  - 4 mini-stats (streak, quizzes, lessons, avg)
  - Badges grid (3-4 cols) with earned (color) vs locked (grayscale)
    states, emoji icons, hover scale
  - Toast notifications when new badges are earned
- Wired into StudentDashboard in a 2-column grid alongside a
  motivational streak banner

### 1.10 Leaderboard
`src/components/student/leaderboard-view.tsx` · `GET /api/students/me/leaderboard`
- Top students ranked by XP
- Rank badges (gold/silver/bronze for top 3)
- Student's own rank highlighted
- XP + level shown per row
- Cilckable to view other students' public profiles (read-only)

### 1.11 Achievements Gallery
`src/components/student/achievements-view.tsx`
- Header card with gradient strip, Trophy icon, earned count + %
- Progress bar showing badge completion %
- 3 summary stat cards (Total XP, Level, Day Streak)
- **Earned Badges** section: grid of cards with badge emoji (float
  animation), title, description, "مفتوحة" badge with Trophy icon
- **Locked Badges** section: grayscale cards with Lock icon, "مقفولة"
  badge
- **Level Progress** card: current level → next level with progress bar
- Framer Motion spring entrance for each badge
- Uses existing gamification API (no new backend)

### 1.12 Certificate
`src/components/student/certificate-view.tsx` · `GET /api/students/me/certificate`
- Eligibility check: ≥80% of course lessons completed
- **Eligible view**: premium gradient border frame (double border,
  emerald), header with academy name + logo + tagline, "Certificate of
  Completion" title in Arabic + English, student name (large, emerald),
  course name (teal), 3 stat cards (avg quiz score, attendance rate,
  completion date), Certificate ID (monospace), signature line with
  academic year, "حفظ كـ PDF" button triggers `window.print()`
- **Not-eligible view**: progress bar showing how far to 80%
- Print CSS (@media print, landscape @page, visibility toggle)

### 1.13 Study Scheduler
`src/components/student/study-scheduler.tsx` · `GET/POST/PATCH/DELETE /api/students/me/study-plan`
- Calendar grid (7 columns, day names in Arabic) with month navigation
- Each day cell shows: date number, task count badge, colored dots
  (green=done, amber=pending), today highlighted in amber, selected in
  emerald
- Legend explaining dot colors
- Selected date panel: lists tasks with toggle (Circle→CheckCircle2),
  duration badge, delete button
- "أضف مهمة" button reveals inline form (title, description, duration)
- Framer Motion animations for entrance + AnimatePresence for add form

### 1.14 Referral Program
`src/components/student/referral-view.tsx` · `GET/POST /api/students/me/referral`
- Hero card with gradient header, Gift icon, referral code (CM-XXXXXX
  format from student ID)
- Copy button with checkmark feedback
- Share button (uses `navigator.share` if available, otherwise copies
  URL to clipboard)
- 4 stat cards (total referrals, completed, pending, XP earned) with
  gradient icons
- Referral list with avatar initials, name, email, status badge, XP
  earned
- "How it works" section with 4 numbered steps
- Empty state: "مفيش إحالات لسه" with explanation
- **Reward**: 50 XP + auto-creates a 10% discount coupon with code
  `REF-XXXXXX` (1 max use) when a referral is completed
- API POST handler validates code format, finds referrer, creates
  `Referral` record, awards XP, sends notification to referrer

### 1.15 AI Assistant (Student)
`src/components/ai/ai-assistant.tsx` · `POST/GET/DELETE /api/ai/chat`
- Floating gradient button (bottom-left, emerald→teal→amber) with pulse
  indicator — visible on all authenticated views
- Glass-strong chat panel with:
  - Header (Bot avatar + "CodeMind Assistant" + clear/close buttons)
  - Message area with user/assistant bubbles (gradient avatars)
  - Suggestion chips for quick start (Machine Learning, Programming,
    Cybersecurity, …)
  - Typing indicator (animated dots)
  - Code block rendering (` ``` ` blocks with LTR direction,
    syntax-highlighted via react-syntax-highlighter)
  - Auto-scroll to bottom
  - Session persistence (loads history on mount, keyed by sessionId,
    max 12 messages)
  - Enter to send, Shift+Enter for newline
- Backend uses z-ai-web-dev-sdk with an Egyptian Arabic system prompt
  framing the assistant as a CodeMind tutor
- LLM calls take ~30 s; typing indicator makes this acceptable

### 1.16 Bookmarks
`src/components/student/bookmarks-view.tsx` · `GET/POST/DELETE /api/students/me/bookmarks`
- List of bookmarked lessons with title (Ar + En), part name, topic
- "Open" button navigates to the lesson view
- Remove button per bookmark
- Empty state with "تصفح الكورس" CTA
- Toggle from inside lesson view header (amber-filled bookmark icon)

### 1.17 Notes
`src/components/course/student-lesson.tsx` (LessonNotesSection) · `GET/POST/PUT/DELETE /api/students/me/notes`
- Sticky note card with amber theme (StickyNote icon)
- Per-lesson notes (note belongs to a `studentId` + `lessonId`)
- Color field (defaults to `amber`)
- Inline edit + delete with hover-revealed buttons
- Empty state: "مفيش ملاحظات لسه"

### 1.18 Notification Preferences
`src/components/shared/notification-preferences.tsx` · `GET/PUT /api/students/me/notification-prefs`
- 10 notification type toggles (newLesson, newQuiz, quizResult,
  newHomework, homeworkDeadline, upcomingSession, lowAttendance,
  monthlyReport, subscriptionExpiration, announcements) — each with
  icon, label, description, Switch
- Channel preferences: Push Notifications toggle, Email toggle (marked
  "قريبًا")
- Quiet hours: time inputs for start/end, badge showing active quiet
  period
- Save button with gradient + loading spinner
- Enforced server-side via `src/lib/notify.ts` — notifications are
  only created if the type is enabled AND not within quiet hours

### 1.19 CSV Export (Student)
`GET /api/students/me/export-progress`
- Returns CSV with UTF-8 BOM (for Arabic support)
- Columns: Type, Title, Topic, Date, Score/Status, Details
- Covers: Lessons viewed, Quizzes taken, Homework submitted, Attendance
- Triggered from ProgressView "Export CSV" button in BackBar

### 1.20 Enrollment Flow
`src/components/auth/enroll-view.tsx` · `POST /api/enroll`
- 5-step wizard: Course → Group → Plan → Payment → Confirm
- CoursePicker fetches `/api/courses`
- GroupPicker fetches `/api/groups?courseId=` (shows capacity bar,
  blocks when full)
- PlanPicker fetches `/api/subscription-plans` (shows promo badge)
- PaymentPicker: InstaPay / Vodafone Cash / e& Cash + Reference Number
  input
- Coupon section: Ticket icon + "عندك كود خصم?" label, input with
  auto-uppercase + "اتحقق" (Validate) button, validates via
  `/api/coupons/validate`
- ConfirmCard: reviews details, shows coupon line + discounted total +
  original price with strikethrough
- Submits to `/api/enroll` → creates PENDING subscription + PENDING
  payment, assigns student to group, notifies all admins
- Framer Motion AnimatePresence transitions between steps

---

## 2. Parent Portal

**Home view**: `parent-dashboard`
**Sidebar items**: Dashboard · التقارير

### 2.1 Dashboard
`src/components/parent/parent-dashboard.tsx` · `GET /api/parents/me/dashboard`
- Welcome header with parent name + linked children count
- Summary banner (active child + course)
- **6 analytics cards**:
  1. Course Progress %
  2. Attendance %
  3. Avg Quiz Score
  4. Homework Submitted count
  5. Next Live Session
  6. Days until subscription expires
- **Strong Topics** (avg quiz % ≥ 60%) — emerald themed
- **Weak Topics** (avg quiz % < 60%) — amber themed
- **Performance Trend chart** — Recharts LineChart, last 6 quizzes,
  wrapped in `dir="ltr"` for axis correctness, brand gradient stroke
- **Next Live Session** card (date/time, teacher, "انضم للـSession"
  button)
- **Teacher Notes** card (latest 3, scrollable max-h-96)
- **Recent Activity** timeline (mix of quiz/homework/attendance,
  color-coded)
- **Monthly Report** button → opens the MonthlyReport component
- **Weekly Report** button → opens the WeeklyReport component
- **Analytics** button → opens the AnalyticsView
- **Link another student** dialog → POST `/api/parents/me/link-student`,
  invalidates query cache on success
- **Notification Preferences** button → opens the shared
  NotificationPreferences component
- Empty state for parents with no children linked (link form + demo
  hint)
- Loading state with Skeleton placeholders
- Error state "حصلت مشكلة. حاول تاني." with retry button
- Empty mini-state per card ("مفيش بيانات كفاية دلوقتي")
- Framer Motion staggered card entrances + hover lift (card-hover)
- Charts use brand tokens (--chart-1 emerald, --chart-2 amber, --chart-3 teal)

### 2.2 Monthly Report (PDF)
`src/components/parent/monthly-report.tsx`
- Print-optimized HTML report with:
  - Gradient header (emerald→teal→amber) with CodeMind logo + month name
  - Student info grid (name, grade, course, group)
  - 4 metric cards (Course Progress, Attendance, Quiz Average, Homework)
  - Subscription status with days left
  - Strong/Weak topics comparison
  - Recent quizzes table (title, %, pass/fail, date)
  - Teacher notes section
  - Auto-generated recommendations based on performance
  - Print-specific CSS (@media print, visibility toggle, @page margins)
  - "حفظ كـ PDF" button triggers `window.print()` → browser's native
    PDF export
- This approach avoids server-side PDF generation (which would need
  Playwright/ReportLab and cause memory issues in the 4 GB sandbox)

### 2.3 Weekly Report
`src/components/parent/weekly-report.tsx` · `GET /api/parents/me/weekly-report`
- Header card with gradient strip, CalendarDays icon, week range
- 4 summary stat cards (Lessons Viewed, Quizzes Taken, Homework,
  Active Days)
- **Daily Activity heatmap**: 7-day grid with intensity-based coloring
  (emerald), attendance indicators (checkmark for present, dot for
  absent)
- Recent Quizzes section with pass/fail badges + percentages
- Recent Homework section with status badges
- Framer Motion staggered entrance
- Print-friendly styles (@media print)

### 2.4 Analytics
`src/components/parent/analytics-view.tsx` · `GET /api/parents/me/analytics`
- Child selector (if multiple children)
- 4 overview stat cards (Course Progress, Attendance, Avg Quiz,
  Homework)
- **Quiz Performance Trend**: Recharts LineChart with gradient stroke
  (last 10 attempts with title, percentage, passed)
- **Attendance by Month**: Recharts BarChart with gradient fill (last 6
  months with pct, present, total)
- **Strong/Weak Topics** comparison (by quiz topic, sorted by avg %) —
  emerald vs amber themed
- **Course Completion**: Recharts RadialBarChart (circular progress)

### 2.5 Link Student
`POST /api/parents/me/link-student`
- Dialog form: enter student email → POST creates a
  `ParentStudentLink` row
- Validates: student exists, student.role === STUDENT, not already
  linked to this parent
- Returns 404 with friendly Arabic error if email is unknown or not a
  student
- On success: query cache invalidated, dashboard refreshes

### 2.6 Notification Preferences
`src/components/shared/notification-preferences.tsx` · `GET/PUT /api/parents/me/notification-prefs`
- Same UI as the student version (10 type toggles + channel prefs +
  quiet hours)
- Re-exported at `/api/parents/me/notification-prefs`

---

## 3. Teacher Portal

**Home view**: `teacher-dashboard`
**Sidebar items**: Dashboard · Attendance · Quizzes · Homework

### 3.1 Overview (Dashboard)
`src/components/teacher/teacher-dashboard.tsx` · `GET /api/teacher/dashboard`
- Welcome header with teacher name + specialty
- **Groups** section: cards per group with course name, student count,
  capacity bar, next session
- **Sessions** section: upcoming + past live sessions with date/time,
  status, link to meeting URL or recording URL
- **Recent Activity** timeline (recent attendance, homework grading,
  quiz submissions)
- **Quick Stats**: total students, total groups, avg attendance %,
  pending homework to grade
- Tabs to switch between Dashboard / Attendance / Quizzes / Homework /
  Templates

### 3.2 Attendance
`src/components/teacher/teacher-dashboard.tsx` (Attendance tab) · `GET/POST /api/teacher/attendance`
- Session picker (dropdown of teacher's sessions)
- Student roster for the selected session
- Per-student status buttons: PRESENT (emerald ✓) / ABSENT (red ✕) /
  LATE (amber clock) / EXCUSED (gray)
- Optional note per student
- "حفظ" (Save) button → POST batches the attendance updates
- Stats summary at top: present count, absent count, late count
- Validates: session belongs to one of teacher's groups

### 3.3 Quizzes (CRUD)
`src/components/teacher/teacher-dashboard.tsx` (Quizzes tab) · `GET/POST /api/teacher/quizzes`
- List of quizzes created by this teacher (with lesson + question count)
- **Create Quiz** form: title (Ar + En), description, pass mark,
  time limit, lesson selector
- **Add Question** form: type (MCQ / True/False), prompt (Ar + En),
  options (dynamic add/remove), correct answer picker, explanation,
  difficulty (EASY/MEDIUM/HARD), marks
- **Edit / Delete** quiz
- Questions are stored in the `Question` model with `options` as JSON
  string and `answer` as index or "true"/"false"

### 3.4 Homework Grading
`src/components/teacher/teacher-dashboard.tsx` (Homework tab) · `GET /api/teacher/homework`, `POST /api/teacher/homework/[id]/grade`
- List of homework submissions for the teacher's lessons
- Filter by status (PENDING / SUBMITTED / GRADED / LATE)
- Click a submission to view content + file URL
- Grade input (0 to maxMarks) + feedback textarea
- Submit → POST updates `HomeworkSubmission.grade` + `feedback` +
  `status=GRADED`
- Validates: homework belongs to one of teacher's lessons

### 3.5 Lesson Plan Templates
`src/components/teacher/teacher-dashboard.tsx` (Templates tab) · `GET/POST /api/teacher/templates`, `DELETE /api/teacher/templates/[id]`
- Templates list with expandable cards (click to expand)
- Expanded view shows: objectives (with checkmarks), activities
  (numbered with duration badges), suggested homework
- "تمبلت جديد" button opens create form (title, description, duration,
  objectives textarea, homework)
- Delete button per template (teachers can only delete their own)
- 3 default templates seeded:
  1. "مقدمة في مفاهيم البرمجة" — 90 min, 4 objectives, 5 activities,
     homework
  2. "أساسيات تعلم الآلة" — 90 min, 4 objectives, 5 activities, homework
  3. "أساسيات الأمن السيبراني" — 90 min, 4 objectives, 5 activities,
     homework
- Templates can be public (visible to all teachers) or owned by a
  specific teacher

### 3.6 Analytics
`GET /api/teacher/analytics`
- Student performance metrics: avg quiz score, attendance rate,
  homework submission rate, pass rates per quiz
- Course-wide aggregates
- Useful for identifying struggling students

---

## 4. Admin Portal

**Home view**: `admin-overview`
**Sidebar items**: Overview · الطلاب · المعلمون · المجموعات ·
الكورسات · Question Bank · المدفوعات · الاشتراكات · أكواد الخصم ·
الإشعارات · الإعدادات

The admin portal is implemented as a single large component:
`src/components/admin/admin-dashboard.tsx` (3576 lines) which switches
on the current `view` to render OverviewView / StudentsView /
TeachersView / etc.

### 4.1 Overview
`src/components/admin/admin-dashboard.tsx` (OverviewView) · `GET /api/admin/overview`
- **KPI cards**: total students, total teachers, total groups, total
  revenue, active subscriptions, pending payments
- **Charts** (Recharts): student growth (LineChart), revenue by month
  (BarChart), payment method distribution (PieChart), group fill
  (horizontal bars)
- **Recent Activity** list (latest 10 events: enrollments, payments,
  new users)
- **Quick Actions**: links to Add Student / Add Teacher / Create Coupon
  / Send Notification
- Empty states with skeleton loaders

#### 4.1.1 Revenue Analytics
`src/components/admin/admin-dashboard.tsx` (RevenueAnalyticsSection) · `GET /api/admin/revenue-analytics`
- 4 revenue stat cards (Total Revenue, Avg Payment, Paying Users,
  Pending Revenue) with gradient icons
- Growth indicator card (green for positive, red for negative) with
  percentage badge
- **Bar chart**: Revenue by Month with gradient fill bars
- **Payment Methods breakdown**: animated progress bars per method
  (INSTAPAY / VODAFONE_CASH / ETISALAT_CASH counts + revenue)
- Overview stats: totalRevenue, totalPayments, avgPaymentValue,
  uniquePayingUsers, pendingPayments, pendingRevenue,
  activeSubscriptions
- Configurable months (default 6, max 24)

#### 4.1.2 Revenue Forecast
`src/components/admin/admin-dashboard.tsx` (RevenueForecastSection) · `GET /api/admin/revenue-forecast`
- Trend indicator card (green/gray/red based on direction) with
  percentage
- **Revenue Projection chart**: Recharts BarChart with historical
  (emerald gradient) + forecast (amber gradient) bars
- **Projected Q+1 Revenue** card (special revenue-card styling)
- Monthly forecast cards with confidence badges (ثقة عالية/متوسطة/منخفضة)
- **Subscription Insights** card (active, expiring this month,
  expected renewal rate)
- Algorithm: builds monthly revenue (last 6 months), runs linear
  regression (y = mx + b), forecasts next 3 months with confidence
  based on data quality (more months = higher confidence)
- Metrics: avgMonthlyRevenue, trendDirection (growing/stable/declining),
  trendPercentage, monthOverMonthGrowth, projectedQuarterRevenue

### 4.2 Students
`src/components/admin/admin-dashboard.tsx` (StudentsView) · `GET/POST /api/admin/students`, `PATCH/DELETE /api/admin/students/[id]`
- Searchable list with pagination (page + pageSize, default 20, max
  100; returns `pagination` metadata)
- **Add Student** dialog: name, email, phone, password, grade, school,
  group assignment
- **Edit Student** dialog: all fields + group reassignment
- **Delete Student** (with confirmation)
- **Export CSV** button → `GET /api/admin/export-progress` returns
  CSV with 18 columns (Name, Email, Phone, Group, Course, Enrolled,
  Lessons Completed/Total/%, Attendance %, Quizzes Taken/Passed, Avg
  Quiz Score, Homework Submitted/Graded, Subscription Status/Plan/End
  Date)
- Status filter (active / inactive)
- CSV includes UTF-8 BOM for Arabic support

### 4.3 Teachers
`src/components/admin/admin-dashboard.tsx` (TeachersView) · `GET/POST /api/admin/teachers`
- List of teachers with name, email, specialty, group count, student
  count
- **Add Teacher** dialog: name, email, phone, password, bio, specialty
- **Edit Teacher**: all fields
- **Assign Teacher to Group** (done via Groups view)

### 4.4 Groups
`src/components/admin/admin-dashboard.tsx` (GroupsView) · `GET/POST /api/admin/groups`, `PATCH/DELETE /api/admin/groups/[id]`
- List of groups with name, course, teacher, capacity, student count,
  schedule, active toggle
- **Create Group** form: name, course selector, teacher selector,
  capacity (default 20), schedule (default "Sat & Tue, 6:00 PM")
- **Edit Group**: all fields including teacher reassignment and
  capacity changes
- **Delete Group** (with confirmation)
- Capacity bar visualization (students / capacity)
- Active / inactive toggle

### 4.5 Courses
`src/components/admin/admin-dashboard.tsx` (CoursesView) · `GET /api/admin/courses`
- Curriculum tree viewer: Course → Parts → Units → Topics → Lessons
- Read-only display (course content is seeded via `scripts/seed.ts`)
- Shows lesson metadata: title (Ar + En), duration, isLocked,
  isPublished, has video, has PDF, has summary

### 4.6 Question Bank
`src/components/admin/admin-dashboard.tsx` (QuestionBankView) · `GET/POST /api/admin/question-bank`, `POST /api/admin/ai-generate-quiz`
- Searchable list of questions with difficulty + type filters
- **Add Question** dialog: type (MCQ / True/False), prompt (Ar + En),
  options (dynamic add/remove), correct answer picker, explanation,
  difficulty (EASY/MEDIUM/HARD), marks
- **AI Generate** button + expandable panel:
  - Sparkles icon + "AI Generate" button next to "Add Question"
  - Lesson selector (dropdown of all lessons)
  - Question count (3/5/7/10)
  - Difficulty selector (MIXED / EASY / MEDIUM / HARD)
  - "ولّد الأسئلة" button with gradient background
  - Loading state with spinner + "جارٍ التوليد... (30 ثانية)" text
  - Info banner explaining the AI process
  - Toast on success: "اتولّدت N أسئلة بالـAI 🤖"
- Backend builds context from lesson hierarchy, asks LLM for
  JSON-formatted questions in Egyptian Arabic, parses + validates,
  creates Quiz (if doesn't exist) + Questions

### 4.7 Payments
`src/components/admin/admin-dashboard.tsx` (PaymentsView) · `GET /api/admin/payments`, `POST /api/admin/payments/[id]/approve`, `POST /api/admin/payments/[id]/reject`, `POST /api/admin/payments/import`
- Table with pending rows highlighted amber
- **Approve** (emerald ✓) / **Reject** (red ✕) icon buttons per row
- Status filter (PENDING / APPROVED / REJECTED / EXPIRED)
- Payment method column (INSTAPAY / VODAFONE_CASH / ETISALAT_CASH)
- Reference number display + notes
- Pagination (page + pageSize, default 20, max 100)
- Approve action: sets status=APPROVED, activates the linked
  Subscription (sets startDate, endDate based on plan duration),
  sends PAYMENT_APPROVED notification (respecting preferences)
- Reject action: sets status=REJECTED, sends PAYMENT_REJECTED
  notification (respecting preferences)

#### 4.7.1 Bulk Payment Import (xlsx)
`POST /api/admin/payments/import` (FormData with xlsx file)
- **"استيراد xlsx"** button + expandable panel
- File input (hidden, triggered by button)
- **"تحميل Template"** button → `GET /api/admin/payments/import`
  downloads a template xlsx with 2 example rows
- Import results display: created / failed / total counts + error
  details per row
- Loading state with spinner
- Toast feedback on success
- Backend uses `xlsx` package (XLSX.read + XLSX.utils.sheet_to_json),
  supports English + Arabic column names:
  - userEmail / email / الإيميل
  - amount / المبلغ
  - method / الطريقة (INSTAPAY / VODAFONE_CASH / ETISALAT_CASH)
  - reference / المرجع
  - status / الحالة
  - notes / ملاحظات
- Validates each row (finds user by email, validates method/status)
- Creates Payment records in bulk
- Returns `{ created, failed, total, results: [...] }`

### 4.8 Subscriptions
`src/components/admin/admin-dashboard.tsx` (SubscriptionsView) · `GET /api/admin/subscriptions`
- Table with plan, price, dates, status, student name
- Status filter (PENDING / ACTIVE / EXPIRED / CANCELLED)
- Pagination (page + pageSize, default 20, max 100)
- Shows subscription plan name (Ar + En), durationMonths, price
- Shows start date, end date, days remaining

### 4.9 Coupons
`src/components/admin/admin-dashboard.tsx` (CouponsView) · `GET/POST /api/admin/coupons`, `PATCH/DELETE /api/admin/coupons/[id]`
- List of coupon cards with code, type (PERCENTAGE / FIXED), value,
  usage stats (usedCount / maxUses), active toggle, validity dates
- **"كود جديد"** button opens create form (code, type, value, maxUses,
  description, validFrom, validUntil)
- Code validation: unique, uppercase enforced, min 3 chars
- **Toggle active/inactive** per coupon
- **Delete** coupon (with confirmation)
- Redemption tracking: shows how many times each coupon has been used
- Empty state with Ticket icon

### 4.10 Notifications (Center + Broadcast)
`src/components/admin/admin-dashboard.tsx` (NotificationsView) · `GET/POST /api/admin/notifications`, `GET /api/admin/notifications-center`

#### Broadcast
- **Send Notification** form: title, message, target (all students /
  all parents / all teachers / specific user by email), type
- Sends to all matching users (respecting each user's
  NotificationPreference + quiet hours)

#### Notification Center
`GET /api/admin/notifications-center` (with type filter + pagination)
- **4 stat cards**: Total, Read, Unread, Types — with gradient icons
- **Type breakdown** as clickable filter chips (click to filter by
  type)
- **Full notification list** with:
  - Read/unread indicators (colored dot)
  - User name + role + email
  - Timestamp (relative + absolute)
  - Type badge
- Scrollable list area (max-h-80)
- Pagination metadata (page, pageSize, total, totalPages, hasMore)
- Stats: total, read, unread, byType (groupBy type with counts)

### 4.11 Settings
`src/components/admin/admin-dashboard.tsx` (SettingsView) · `GET/PUT /api/admin/settings`
- **Brand form**: brand_name, brand_tagline, whatsapp_teacher,
  whatsapp_technical, whatsapp_subscription, academic_year
- **Subscription Prices form**: price_monthly, price_3months,
  price_6months, price_early_bird (12 keys total)
- Save button persists all settings to the `Setting` table
- Public endpoint `/api/settings/public` exposes these to the landing
  page (no auth required)

---

## 5. Cross-Portal Features

### 5.1 Authentication
- Login + Register with 4-role picker
- Cookie-based sessions (7-day TTL, scrypt hashing)
- Session restoration on page reload via `/api/auth/me`
- Logout via `/api/auth/logout`

### 5.2 Theme Toggle
- Light/dark via next-themes (class strategy)
- Toggle button in dashboard header
- Theme persisted across reloads via Zustand `persist` middleware

### 5.3 Notifications Bell
- Polls `/api/notifications/unread-count` every 30 s
- Shows count badge (pulse animation if > 0)
- Click → navigates to notification center (admin) or notifications
  tab (other roles)

### 5.4 Error Boundary
- Wraps the entire AppShell
- Catches render errors and shows friendly Egyptian Arabic fallback
  ("حصلت مشكلة. حاول تاني.") with retry + home buttons

### 5.5 Page Transitions
- Framer Motion `AnimatePresence mode="wait"` wraps each view
- Subtle fade + slide transition (0.22 s) between views
- Loading spinner animated with motion

### 5.6 Mobile Responsive
- Mobile-first design with Tailwind responsive prefixes
- Desktop sidebar (lg:w-64) + mobile Sheet sidebar (hamburger toggle)
- All cards reflow to single column on mobile
- Touch targets ≥ 44 px

### 5.7 WhatsApp Support
- Help card in sidebar footer: "محتاج مساعدة؟" + WhatsApp link
- Uses `whatsappLink(brand.whatsapp.technical, "السلام عليكم، محتاج مساعدة")`
- Three WhatsApp numbers (teacher / technical / subscription) set via
  Settings → brand

### 5.8 AI Assistant
- Available on all authenticated views (hidden on landing/login)
- Same UI for all roles (student/parent/teacher/admin)
- Egyptian Arabic system prompt adapting to user role context

### 5.9 CSV / Excel Export
- Student progress CSV (per-student, 6 columns)
- Admin progress CSV (all students, 18 columns)
- Payment template xlsx download (with 2 example rows)
- Payment bulk import xlsx upload
- All CSVs include UTF-8 BOM for Arabic support

### 5.10 Gamification Enforcement
- XP computed dynamically from lesson progress + quiz attempts +
  homework submissions + attendance
- Badges auto-awarded on stats change (upsert)
- Streaks computed from day-over-day active days (60-day window)
- Same engine used by: Student Dashboard (gamification panel),
  Leaderboard, Achievements Gallery, Certificate eligibility

### 5.11 Notification Preference Enforcement
- `src/lib/notify.ts` — `createNotificationIfAllowed()` checks:
  1. User's per-type toggle (e.g. `newLesson`, `monthlyReport`)
  2. Quiet hours (handles overnight wrap, e.g. 22:00-07:00)
- Skips creation entirely if either gate fails
- Used by: payment approval/rejection, referral reward, and any
  notification-creating API route

### 5.12 PWA Manifest
- `public/manifest.json` — name, icons, theme color, display: standalone
- Service worker: **Not Currently Implemented** (listed as a future
  enhancement)

---

## Not Currently Implemented

The following items are explicitly **out of scope** for the current
release and noted in the worklog as future enhancements:

- **Email / SMS notification delivery** — notifications are in-app
  only; `emailEnabled` is a placeholder toggle.
- **Service worker / offline PWA** — manifest exists but no SW for
  caching.
- **PostgreSQL migration** — schema is SQLite; the `datasource` block
  in `prisma/schema.prisma` would need to switch provider.
- **Real payment gateway** — payments are verified manually by admin
  (InstaPay / Vodafone Cash / e& Cash are informational only).
- **Student leaderboard caching** — XP is computed on-demand for all
  students; for large datasets this could be slow.
- **Parent daily report** — daily summary notifications (currently
  weekly + monthly only).
- **Course content bulk editing** — admin Courses view is read-only.
- **Referral discount tracking dashboard** — referrals create discount
  coupons but there's no admin view for tracking redemption.
