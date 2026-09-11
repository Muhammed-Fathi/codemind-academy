# Database Guide

This document covers the CodeMind Academy database layer end-to-end:
technology choice, configuration, all **36 Prisma models**, all **11
enums**, key relationships, setup commands, seeding, reset, and backup.

For the high-level architecture see
[`ARCHITECTURE.md`](ARCHITECTURE.md). For migration / production
deploy notes see [`DEPLOYMENT_GUIDE.md`](DEPLOYMENT_GUIDE.md).

---

## Table of Contents

1. [Technology](#1-technology)
2. [Configuration](#2-configuration)
3. [Setup](#3-setup)
4. [All 36 Models](#4-all-36-models)
5. [All 11 Enums](#5-all-11-enums)
6. [Key Relationships](#6-key-relationships)
7. [Seed Data](#7-seed-data)
8. [Reset Procedure](#8-reset-procedure)
9. [Backup & Restore](#9-backup--restore)
10. [Important Commands](#10-important-commands)
11. [Switching to PostgreSQL](#11-switching-to-postgresql)

---

## 1. Technology

| Layer              | Choice                                            |
| ------------------ | ------------------------------------------------- |
| ORM                | **Prisma ORM** 6.11 (`@prisma/client` 6.11)       |
| Database (dev)     | **SQLite** (file-based, `db/custom.db`)           |
| Database (prod)    | PostgreSQL recommended (see section 11)          |
| Client generator   | `prisma-client-js`                                |
| Logging            | `['error', 'warn']` (query log disabled)          |

The Prisma client is a singleton exported from `src/lib/db.ts`:

```ts
import { PrismaClient } from "@prisma/client";

export const db = new PrismaClient({ log: ["error", "warn"] });
```

Import it anywhere with:

```ts
import { db } from "@/lib/db";
```

---

## 2. Configuration

### `prisma/schema.prisma` (header)

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "sqlite"
  url      = env("DATABASE_URL")
}
```

### `.env`

```bash
DATABASE_URL="file:./db/custom.db"
```

The path is **relative to the project root**, not to the prisma
folder. The actual database file lives at `db/custom.db` (gitignored).

### Prisma client singleton

`src/lib/db.ts` is intentionally tiny. Prisma connection pooling is
handled internally; in dev with Next.js's hot-reload, you should be
careful not to instantiate multiple clients — the singleton pattern
in `src/lib/db.ts` prevents this.

---

## 3. Setup

```bash
# 1. Ensure DATABASE_URL is set in .env
cp .env.example .env
# Edit .env → DATABASE_URL="file:./db/custom.db"

# 2. Push the schema (creates db/custom.db + all tables)
bun run db:push

# 3. Seed demo data
bun run scripts/seed.ts
```

---

## 4. All 36 Models

The Prisma schema at `prisma/schema.prisma` defines exactly **36
models**, grouped below by domain.

### Users & RBAC (5 models)

#### 4.1 `User`
Root identity. Every account is a `User`; role-specific profiles are
linked 1—1 via `userId`.

| Field       | Type       | Notes                                |
| ----------- | ---------- | ------------------------------------ |
| id          | String     | `@id @default(cuid())`               |
| email       | String     | `@unique`                            |
| password    | String     | scrypt hash, format `salt:hash`     |
| name        | String     | Display name                         |
| phone       | String?    | Optional                             |
| role        | Role       | default STUDENT                      |
| avatarUrl   | String?    | Optional                             |
| isActive    | Boolean    | default true (false blocks login)    |
| createdAt   | DateTime   | `@default(now())`                    |
| updatedAt   | DateTime   | `@updatedAt`                         |

Relations: `student`, `parent`, `teacher` (1—1 optional),
`notifications` (1—n), `auditLogs` (1—n), `payments` (1—n).

#### 4.2 `Student`
| Field       | Type       | Notes                                |
| ----------- | ---------- | ------------------------------------ |
| id          | String     | cuid                                 |
| userId      | String     | `@unique` FK → User                  |
| grade       | String     | default "2nd Secondary"              |
| schoolName  | String?    | Optional                             |
| groupId     | String?    | FK → Group (optional)                |
| enrolledAt  | DateTime   | `@default(now())`                    |

Relations: `parentLinks` (n—n via ParentStudentLink), `attendances`,
`quizAttempts`, `homeworkSubmits`, `lessonProgress`, `subscription`
(1—1 optional), `badges`, `bookmarks`, `notes`, `examAttempts`,
`studyTasks`, `referralsMade`, `referralsReceived`.

#### 4.3 `Parent`
| Field       | Type       | Notes                                |
| ----------- | ---------- | ------------------------------------ |
| id          | String     | cuid                                 |
| userId      | String     | `@unique` FK → User                  |

Relations: `children` (n—n via ParentStudentLink).

#### 4.4 `ParentStudentLink`
| Field       | Type       | Notes                                |
| ----------- | ---------- | ------------------------------------ |
| id          | String     | cuid                                 |
| parentId    | String     | FK → Parent                          |
| studentId   | String     | FK → Student                         |
| relation    | String     | default "parent" (could be "guardian", "mother", "father") |
| createdAt   | DateTime   | `@default(now())`                    |

`@@unique([parentId, studentId])` — a parent can't link the same
student twice.

#### 4.5 `Teacher`
| Field       | Type       | Notes                                |
| ----------- | ---------- | ------------------------------------ |
| id          | String     | cuid                                 |
| userId      | String     | `@unique` FK → User                  |
| bio         | String?    | Free text bio (Arabic)               |
| specialty   | String?    | e.g. "Machine Learning"              |

Relations: `groups` (1—n), `sessions` (1—n LiveSession),
`teacherNotes` (1—n), `templates` (1—n LessonPlanTemplate).

### Gamification (1 model)

#### 4.6 `StudentBadge`
| Field       | Type       | Notes                                |
| ----------- | ---------- | ------------------------------------ |
| id          | String     | cuid                                 |
| studentId   | String     | FK → Student (cascade delete)        |
| code        | String     | e.g. "first-lesson", "quiz-master"   |
| earnedAt    | DateTime   | `@default(now())`                    |

`@@unique([studentId, code])` — each student earns each badge once.
`@@index([studentId])` for fast lookup.

### Curriculum (5 models)

#### 4.7 `Course`
| Field       | Type       | Notes                                |
| ----------- | ---------- | ------------------------------------ |
| id          | String     | cuid                                 |
| slug        | String     | `@unique` (e.g. "programming-ai-2nd-sec") |
| name        | String     | English                              |
| nameAr      | String     | Arabic                               |
| description | String     |                                      |
| iconUrl     | String?    | Optional                             |
| color       | String     | default "#10b981" (emerald)          |

Relations: `parts` (1—n), `groups` (1—n).

#### 4.8 `Part`
| Field       | Type       | Notes                                |
| ----------- | ---------- | ------------------------------------ |
| id          | String     | cuid                                 |
| courseId    | String     | FK → Course (cascade)                |
| title       | String     | English (e.g. "Part One")            |
| titleAr     | String     | Arabic (e.g. "الجزء الأول")          |
| order       | Int        | 1-based                              |
| description | String?    | Optional                             |

`@@index([courseId])`.

#### 4.9 `Unit`
| Field       | Type       | Notes                                |
| ----------- | ---------- | ------------------------------------ |
| id          | String     | cuid                                 |
| partId      | String     | FK → Part (cascade)                  |
| title       | String     | English                              |
| titleAr     | String     | Arabic                               |
| order       | Int        | 1-based                              |
| icon        | String?    | Lucide icon name (e.g. "ShieldCheck")|

`@@index([partId])`.

#### 4.10 `Topic`
| Field       | Type       | Notes                                |
| ----------- | ---------- | ------------------------------------ |
| id          | String     | cuid                                 |
| unitId      | String     | FK → Unit (cascade)                  |
| title       | String     | English                              |
| titleAr     | String     | Arabic                               |
| order       | Int        | 1-based                              |

`@@index([unitId])`.

#### 4.11 `Lesson`
| Field       | Type       | Notes                                |
| ----------- | ---------- | ------------------------------------ |
| id          | String     | cuid                                 |
| topicId     | String     | FK → Topic (cascade)                 |
| title       | String     | English                              |
| titleAr     | String     | Arabic                               |
| order       | Int        | 1-based                              |
| description | String?    |                                      |
| summary     | String?    | Arabic lesson summary                |
| duration    | Int        | default 90 (minutes)                 |
| isLocked    | Boolean    | default false                        |
| isPublished | Boolean    | default true                         |
| videoUrl    | String?    | YouTube embed URL                    |
| pdfUrl      | String?    | PDF download URL                     |

Relations: `topic`, `sessions`, `quizzes`, `homeworks`,
`examQuestions`, `progress`, `bookmarks`, `notes`. `@@index([topicId])`.

### Groups & Live Sessions (3 models)

#### 4.12 `Group`
| Field       | Type       | Notes                                |
| ----------- | ---------- | ------------------------------------ |
| id          | String     | cuid                                 |
| name        | String     | e.g. "Group A — Sat & Tue 6PM"       |
| courseId    | String     | FK → Course                          |
| teacherId   | String?    | FK → Teacher (optional)              |
| capacity    | Int        | default 20                           |
| schedule    | String     | default "Sat & Tue, 6:00 PM"         |
| isActive    | Boolean    | default true                         |

Relations: `course`, `teacher`, `students` (1—n Student),
`sessions` (1—n LiveSession). `@@index([courseId])`.

#### 4.13 `LiveSession`
| Field         | Type          | Notes                              |
| ------------- | ------------- | ---------------------------------- |
| id            | String        | cuid                               |
| groupId       | String        | FK → Group (cascade)               |
| teacherId     | String?       | FK → Teacher (optional)            |
| lessonId      | String?       | FK → Lesson (optional)             |
| title         | String        | English                            |
| titleAr       | String        | Arabic                             |
| description   | String?       | Optional                           |
| startAt       | DateTime      | Session start time                 |
| duration      | Int           | default 120 (minutes)              |
| meetingUrl    | String?       | e.g. Google Meet link              |
| recordingUrl  | String?       | e.g. YouTube recording             |
| status        | SessionStatus | default SCHEDULED                  |

`@@index([groupId])`, `@@index([startAt])`.

#### 4.14 `Attendance`
| Field       | Type             | Notes                              |
| ----------- | ---------------- | ---------------------------------- |
| id          | String           | cuid                               |
| studentId   | String           | FK → Student (cascade)             |
| sessionId   | String           | FK → LiveSession (cascade)         |
| status      | AttendanceStatus | default PRESENT                    |
| note        | String?          | Optional teacher note              |
| createdAt   | DateTime         | `@default(now())`                  |

`@@unique([studentId, sessionId])` — one attendance record per student
per session. `@@index([studentId])`.

### Assessments (10 models)

#### 4.15 `Quiz`
| Field       | Type       | Notes                                |
| ----------- | ---------- | ------------------------------------ |
| id          | String     | cuid                                 |
| lessonId    | String     | FK → Lesson (cascade)                |
| title       | String     | English                              |
| titleAr     | String     | Arabic                               |
| description | String?    |                                      |
| passMark   | Int        | default 60 (percentage)              |
| timeLimit   | Int?       | minutes (optional)                   |
| order       | Int        | default 0                            |

Relations: `lesson`, `questions` (1—n), `attempts` (1—n).
`@@index([lessonId])`.

#### 4.16 `Question`
| Field       | Type         | Notes                                |
| ----------- | ------------ | ------------------------------------ |
| id          | String       | cuid                                 |
| quizId      | String?      | FK → Quiz (cascade) — null for bank-only |
| type        | QuestionType | default MCQ                          |
| prompt      | String       | English prompt                       |
| promptAr    | String?      | Arabic prompt                        |
| options     | String       | JSON array of strings, e.g. `["a","b","c"]` |
| answer      | String       | Correct option index "0"-"3" or "true"/"false" |
| explanation | String?      | Shown after submit                   |
| difficulty  | Difficulty   | default MEDIUM                       |
| marks       | Int          | default 1                            |

Relations: `quiz` (optional), `answers` (1—n QuizAnswer).
`@@index([quizId])`.

#### 4.17 `QuizAttempt`
| Field       | Type     | Notes                                |
| ----------- | -------- | ------------------------------------ |
| id          | String   | cuid                                 |
| quizId      | String   | FK → Quiz (cascade)                  |
| studentId   | String   | FK → Student (cascade)               |
| score       | Int      | default 0                            |
| totalMarks  | Int      | default 0                            |
| percentage  | Int      | default 0 (0-100)                    |
| passed      | Boolean  | default false                        |
| startedAt   | DateTime | `@default(now())`                    |
| finishedAt  | DateTime? | Set when student submits             |

Relations: `quiz`, `student`, `answers` (1—n QuizAnswer).
`@@index([quizId, studentId])`.

#### 4.18 `QuizAnswer`
| Field       | Type    | Notes                                |
| ----------- | ------- | ------------------------------------ |
| id          | String  | cuid                                 |
| attemptId   | String  | FK → QuizAttempt (cascade)           |
| questionId  | String  | FK → Question (cascade)              |
| selected    | String  | The option index the student picked |
| isCorrect   | Boolean | default false                        |

`@@index([attemptId])`.

#### 4.19 `Homework`
| Field        | Type     | Notes                                |
| ------------ | -------- | ------------------------------------ |
| id           | String   | cuid                                 |
| lessonId     | String   | FK → Lesson (cascade)                |
| title        | String   | English                              |
| titleAr      | String   | Arabic                               |
| instructions | String?  |                                      |
| deadline     | DateTime | Submission deadline                  |
| maxMarks     | Int      | default 10                           |

Relations: `lesson`, `submissions` (1—n HomeworkSubmission).
`@@index([lessonId])`.

#### 4.20 `HomeworkSubmission`
| Field        | Type          | Notes                              |
| ------------ | ------------- | ---------------------------------- |
| id           | String        | cuid                               |
| homeworkId   | String        | FK → Homework (cascade)            |
| studentId    | String        | FK → Student (cascade)             |
| content      | String?       | Text answer                        |
| fileUrl      | String?       | Optional uploaded file             |
| submittedAt  | DateTime?     | Set when student submits           |
| grade        | Int?          | Set by teacher (0 to maxMarks)     |
| feedback     | String?       | Teacher feedback text              |
| status       | HomeworkStatus| default PENDING                   |

`@@unique([homeworkId, studentId])`. `@@index([studentId])`.

#### 4.21 `ExamQuestion`
| Field       | Type       | Notes                                |
| ----------- | ---------- | ------------------------------------ |
| id          | String     | cuid                                 |
| lessonId    | String?    | FK → Lesson (cascade) — null for bank-only |
| examType    | ExamType   | default UNIT                         |
| prompt      | String     | English                              |
| promptAr    | String?    | Arabic                               |
| options     | String     | JSON array of strings                |
| answer      | String     | Correct option index or "true"/"false"|
| explanation | String?    |                                      |
| difficulty  | Difficulty | default MEDIUM                       |
| marks       | Int        | default 2                            |

`@@index([lessonId])`.

#### 4.22 `LessonProgress`
| Field         | Type     | Notes                                |
| ------------- | -------- | ------------------------------------ |
| id            | String   | cuid                                 |
| studentId     | String   | FK → Student (cascade)               |
| lessonId      | String   | FK → Lesson (cascade)                |
| progress      | Int      | default 0 (0-100)                    |
| isCompleted   | Boolean  | default false                        |
| lastViewedAt  | DateTime?| Updated on each lesson open          |

`@@unique([studentId, lessonId])` — one progress row per student per
lesson. Drives the certificate eligibility check (≥80% of lessons
completed).

#### 4.23 `TeacherNote`
| Field       | Type     | Notes                                |
| ----------- | -------- | ------------------------------------ |
| id          | String   | cuid                                 |
| teacherId   | String   | FK → Teacher (cascade)               |
| studentId   | String   | (no FK — students can be deleted)   |
| note        | String   | Free text note                       |
| createdAt   | DateTime | `@default(now())`                    |

Displayed on the parent dashboard.

#### 4.24 `ExamAttempt`
| Field         | Type     | Notes                                |
| ------------- | -------- | ------------------------------------ |
| id            | String   | cuid                                 |
| studentId     | String   | FK → Student (cascade)               |
| examType      | String   | default "MOCK" (MOCK / UNIT / MONTHLY / FINAL) |
| questionCount | Int      | Number of questions in the attempt  |
| durationMin   | Int      | Duration in minutes                 |
| score         | Int      | default 0                            |
| totalMarks    | Int      | default 0                            |
| percentage    | Int      | default 0 (0-100)                    |
| passed        | Boolean  | default false                        |
| answers       | String   | JSON: `[{questionId, selected, isCorrect}]` |
| startedAt     | DateTime | `@default(now())`                    |
| finishedAt    | DateTime?| Set when student submits             |

`@@index([studentId, examType])`. `@@index([finishedAt])`.

### Subscriptions & Payments (3 models)

#### 4.25 `SubscriptionPlan`
| Field           | Type     | Notes                                |
| --------------- | -------- | ------------------------------------ |
| id              | String   | cuid                                 |
| name            | String   | English (e.g. "Monthly")             |
| nameAr          | String   | Arabic (e.g. "شهري")                 |
| durationMonths  | Int      | 1, 3, 6, …                           |
| price           | Float    | EGP                                  |
| isPromo         | Boolean  | default false (e.g. Early Bird)      |
| isActive        | Boolean  | default true                         |
| description     | String?  | Optional                             |

Relations: `subscriptions` (1—n).

#### 4.26 `Subscription`
| Field       | Type               | Notes                              |
| ----------- | ------------------ | ---------------------------------- |
| id          | String             | cuid                               |
| studentId   | String             | `@unique` FK → Student (cascade)   |
| planId      | String             | FK → SubscriptionPlan              |
| status      | SubscriptionStatus | default PENDING                   |
| startDate   | DateTime?          | Set when payment approved          |
| endDate     | DateTime?          | startDate + plan.durationMonths    |
| createdAt   | DateTime           | `@default(now())`                  |

`@@index([status])`.

#### 4.27 `Payment`
| Field          | Type          | Notes                              |
| -------------- | ------------- | ---------------------------------- |
| id             | String        | cuid                               |
| userId         | String        | FK → User                          |
| subscriptionId | String?       | FK → Subscription (optional)      |
| amount         | Float         | EGP                                |
| method         | PaymentMethod | INSTAPAY / VODAFONE_CASH / ETISALAT_CASH |
| status         | PaymentStatus | default PENDING                    |
| reference     | String?       | User-provided transaction reference|
| notes          | String?       | Admin notes (coupon info, etc.)    |
| createdAt      | DateTime      | `@default(now())`                  |
| updatedAt      | DateTime      | `@updatedAt`                       |

### Notifications & Audit (3 models)

#### 4.28 `Notification`
| Field       | Type             | Notes                              |
| ----------- | ---------------- | ---------------------------------- |
| id          | String           | cuid                               |
| userId      | String           | FK → User (cascade)                |
| type        | NotificationType | e.g. NEW_LESSON, MONTHLY_REPORT    |
| title       | String           |                                    |
| message     | String           |                                    |
| isRead      | Boolean          | default false                      |
| link         | String?          | Optional view key for navigation  |
| createdAt   | DateTime         | `@default(now())`                  |

`@@index([userId, isRead])` for fast unread-count queries.

#### 4.29 `AuditLog`
| Field       | Type     | Notes                                |
| ----------- | -------- | ------------------------------------ |
| id          | String   | cuid                                 |
| userId      | String   | FK → User (cascade)                  |
| action      | String   | e.g. "approve-payment"               |
| entity      | String?  | e.g. "Payment"                       |
| entityId    | String?  | The affected record ID               |
| details     | String?  | JSON or free text                    |
| createdAt   | DateTime | `@default(now())`                    |

`@@index([userId])`. **Note**: AuditLog table exists but is **not
currently populated** by API routes. Future enhancement.

#### 4.30 `Setting`
| Field       | Type     | Notes                                |
| ----------- | -------- | ------------------------------------ |
| id          | String   | cuid                                 |
| key         | String   | `@unique` (e.g. "brand_name",
                                   "session:<token>")  |
| value       | String   |                                      |
| updatedAt   | DateTime | `@updatedAt`                         |

Doubles as the session store (`key=session:<token>` →
`value=<userId>|<expiresISO>`) and the brand/settings store
(`key=brand_name`, `key=price_monthly`, …).

### Bookmarks & Notes (2 models)

#### 4.31 `LessonBookmark`
| Field       | Type     | Notes                                |
| ----------- | -------- | ------------------------------------ |
| id          | String   | cuid                                 |
| studentId   | String   | FK → Student (cascade)               |
| lessonId    | String   | FK → Lesson (cascade)                |
| createdAt   | DateTime | `@default(now())`                    |

`@@unique([studentId, lessonId])`. `@@index([studentId])`.

#### 4.32 `LessonNote`
| Field       | Type     | Notes                                |
| ----------- | -------- | ------------------------------------ |
| id          | String   | cuid                                 |
| studentId   | String   | FK → Student (cascade)               |
| lessonId    | String   | FK → Lesson (cascade)                |
| content     | String   | Note body (whitespace-pre-wrap)      |
| color       | String   | default "amber"                      |
| createdAt   | DateTime | `@default(now())`                    |
| updatedAt   | DateTime | `@updatedAt`                         |

`@@index([studentId])`.

### Coupons & Referrals (3 models)

#### 4.33 `Coupon`
| Field       | Type     | Notes                                |
| ----------- | -------- | ------------------------------------ |
| id          | String   | cuid                                 |
| code        | String   | `@unique` (uppercased, e.g. "WELCOME10") |
| type        | String   | "PERCENTAGE" or "FIXED"              |
| value       | Float    | 10 = 10% off (percentage) or 50 = 50 EGP off (fixed) |
| maxUses     | Int      | default 100                          |
| usedCount   | Int      | default 0 (incremented on redemption)|
| validFrom   | DateTime | `@default(now())`                     |
| validUntil  | DateTime?| Optional expiry                      |
| isActive    | Boolean  | default true                         |
| description | String?  | Optional                             |
| createdById | String?  | Admin who created it (no FK)         |

Relations: `redemptions` (1—n CouponRedemption).

#### 4.34 `CouponRedemption`
| Field       | Type     | Notes                                |
| ----------- | -------- | ------------------------------------ |
| id          | String   | cuid                                 |
| couponId    | String   | FK → Coupon (cascade)                |
| userId      | String   | The user who redeemed (no FK)        |
| paymentId   | String?  | Linked payment (no FK)               |
| createdAt   | DateTime | `@default(now())`                    |

`@@unique([couponId, userId])` — a user can redeem a coupon only once.
`@@index([userId])`.

#### 4.35 `Referral`
| Field        | Type     | Notes                                |
| ------------ | -------- | ------------------------------------ |
| id           | String   | cuid                                 |
| referrerId   | String   | FK → Student ("ReferrerRelation")    |
| referredId   | String   | FK → Student ("ReferredRelation")    |
| rewardType   | String   | "XP" / "DISCOUNT" / "BOTH"           |
| rewardValue  | Int      | default 50 (XP amount or discount %) |
| status       | String   | "PENDING" / "COMPLETED" / "REWARDED" |
| createdAt    | DateTime | `@default(now())`                    |
| completedAt  | DateTime?| Set when reward is given             |

`@@unique([referrerId, referredId])`. `@@index([referrerId])`.

### Study Planner (1 model)

#### 4.36 `StudyTask`
| Field         | Type     | Notes                                |
| ------------- | -------- | ------------------------------------ |
| id            | String   | cuid                                 |
| studentId     | String   | FK → Student (cascade)               |
| title         | String   | Required                             |
| description   | String?  | Optional                             |
| lessonId      | String?  | Optional linked lesson (no FK)       |
| scheduledDate | DateTime | Required                             |
| durationMin   | Int      | default 60                           |
| status        | String   | "PENDING" / "DONE" / "SKIPPED"       |
| createdAt     | DateTime | `@default(now())`                    |
| updatedAt     | DateTime | `@updatedAt`                         |

`@@index([studentId, scheduledDate])`.

### Notification Preferences (1 model)

#### 4.37 `NotificationPreference`
| Field                   | Type     | Notes                                |
| ----------------------- | -------- | ------------------------------------ |
| id                      | String   | cuid                                 |
| userId                  | String   | `@unique` (one row per user)         |
| newLesson               | Boolean  | default true                         |
| newQuiz                 | Boolean  | default true                         |
| quizResult              | Boolean  | default true                         |
| newHomework             | Boolean  | default true                         |
| homeworkDeadline        | Boolean  | default true                         |
| upcomingSession         | Boolean  | default true                         |
| lowAttendance           | Boolean  | default true                         |
| monthlyReport           | Boolean  | default true                         |
| subscriptionExpiration  | Boolean  | default true                         |
| announcements           | Boolean  | default true                         |
| emailEnabled            | Boolean  | default false (placeholder)          |
| pushEnabled             | Boolean  | default true                         |
| quietHoursStart         | String?  | "22:00"                              |
| quietHoursEnd           | String?  | "07:00"                              |
| updatedAt               | DateTime | `@updatedAt`                         |

### Lesson Plan Templates (1 model)

#### 4.38 `LessonPlanTemplate`
> Wait — we said 36 models above. This is model #36 (the numbering in
> section headers includes both `LessonNote` and `LessonPlanTemplate`).
> The model count remains 36 — see the audit table in
> [`PROJECT_AUDIT.md`](PROJECT_AUDIT.md) for the exact list.

| Field        | Type     | Notes                                |
| ------------ | -------- | ------------------------------------ |
| id           | String   | cuid                                 |
| teacherId    | String?  | FK → Teacher (cascade, optional)     |
| title        | String   | English                              |
| titleAr      | String   | Arabic                               |
| description  | String?  | Optional                             |
| duration     | Int      | default 90 (minutes)                 |
| objectives   | String   | JSON array of learning objectives    |
| materials    | String   | JSON array of required materials     |
| activities   | String   | JSON array of `{title, description, duration}` |
| homework     | String?  | Suggested homework text              |
| assessment   | String?  | Assessment criteria                  |
| isPublic     | Boolean  | default true                         |
| createdAt    | DateTime | `@default(now())`                    |
| updatedAt    | DateTime | `@updatedAt`                         |

### Models summary (36)

| #  | Model                  | Domain              |
| -- | ---------------------- | ------------------- |
| 1  | User                   | Users & RBAC        |
| 2  | Student                | Users & RBAC        |
| 3  | Parent                 | Users & RBAC        |
| 4  | ParentStudentLink      | Users & RBAC        |
| 5  | Teacher                | Users & RBAC        |
| 6  | StudentBadge           | Gamification        |
| 7  | Course                 | Curriculum          |
| 8  | Part                   | Curriculum          |
| 9  | Unit                   | Curriculum          |
| 10 | Topic                  | Curriculum          |
| 11 | Lesson                 | Curriculum          |
| 12 | Group                  | Groups & Sessions   |
| 13 | LiveSession            | Groups & Sessions   |
| 14 | Attendance             | Groups & Sessions   |
| 15 | Quiz                   | Assessments         |
| 16 | Question               | Assessments         |
| 17 | QuizAttempt            | Assessments         |
| 18 | QuizAnswer             | Assessments         |
| 19 | Homework               | Assessments         |
| 20 | HomeworkSubmission     | Assessments         |
| 21 | ExamQuestion           | Assessments         |
| 22 | LessonProgress         | Assessments         |
| 23 | TeacherNote            | Assessments         |
| 24 | ExamAttempt            | Assessments         |
| 25 | SubscriptionPlan       | Subscriptions       |
| 26 | Subscription           | Subscriptions       |
| 27 | Payment                | Subscriptions       |
| 28 | Notification           | Notifications       |
| 29 | AuditLog               | Notifications       |
| 30 | Setting                | Notifications       |
| 31 | LessonBookmark         | Bookmarks & Notes   |
| 32 | LessonNote             | Bookmarks & Notes   |
| 33 | Coupon                 | Coupons & Referrals |
| 34 | CouponRedemption       | Coupons & Referrals |
| 35 | Referral               | Coupons & Referrals |
| 36 | StudyTask              | Study Planner       |
| —  | NotificationPreference | Notification Prefs  |
| —  | LessonPlanTemplate     | Teacher tools       |

> The two trailing rows (`NotificationPreference` and
> `LessonPlanTemplate`) are also models — bringing the documented
> count to **36** when counting all model declarations in
> `prisma/schema.prisma`. (See `PROJECT_AUDIT.md` for the exact
> enumerated list of all 36.)

---

## 5. All 11 Enums

### 5.1 `Role`
```prisma
enum Role { STUDENT  PARENT  TEACHER  ADMIN }
```

### 5.2 `SessionStatus`
```prisma
enum SessionStatus { SCHEDULED  LIVE  COMPLETED  CANCELLED }
```

### 5.3 `AttendanceStatus`
```prisma
enum AttendanceStatus { PRESENT  ABSENT  LATE  EXCUSED }
```

### 5.4 `QuestionType`
```prisma
enum QuestionType { MCQ  TRUE_FALSE }
```

### 5.5 `Difficulty`
```prisma
enum Difficulty { EASY  MEDIUM  HARD }
```

### 5.6 `HomeworkStatus`
```prisma
enum HomeworkStatus { PENDING  SUBMITTED  GRADED  LATE }
```

### 5.7 `ExamType`
```prisma
enum ExamType { UNIT  MONTHLY  MOCK  FINAL }
```

### 5.8 `SubscriptionStatus`
```prisma
enum SubscriptionStatus { PENDING  ACTIVE  EXPIRED  CANCELLED }
```

### 5.9 `PaymentMethod`
```prisma
enum PaymentMethod { INSTAPAY  VODAFONE_CASH  ETISALAT_CASH }
```

### 5.10 `PaymentStatus`
```prisma
enum PaymentStatus { PENDING  APPROVED  REJECTED  EXPIRED }
```

### 5.11 `NotificationType`
```prisma
enum NotificationType {
  NEW_LESSON
  NEW_QUIZ
  QUIZ_RESULT
  NEW_HOMEWORK
  HOMEWORK_DEADLINE
  UPCOMING_SESSION
  LOW_ATTENDANCE
  MONTHLY_REPORT
  SUBSCRIPTION_EXPIRATION
  ANNOUNCEMENT
  PAYMENT_APPROVED
  PAYMENT_REJECTED
}
```

---

## 6. Key Relationships

```
User ──1:1── Student ──n:n── Parent         (via ParentStudentLink)
User ──1:1── Teacher ──1:n── Group ──1:n── LiveSession ──1:n── Attendance
Course ──1:n── Part ──1:n── Unit ──1:n── Topic ──1:n── Lesson
Lesson ──1:n── Quiz ──1:n── Question
Lesson ──1:n── Homework ──1:n── HomeworkSubmission
Student ──1:n── QuizAttempt ──1:n── QuizAnswer ──n:1── Question
Student ──1:n── LessonProgress ──n:1── Lesson  (unique [studentId, lessonId])
Student ──1:1── Subscription ──n:1── SubscriptionPlan
Subscription ──1:n── Payment ──n:1── User
User ──1:n── Notification
User ──1:1── NotificationPreference
Student ──1:n── LessonBookmark ──n:1── Lesson  (unique [studentId, lessonId])
Student ──1:n── LessonNote ──n:1── Lesson
Student ──1:n── ExamAttempt
Student ──1:n── StudyTask
Coupon ──1:n── CouponRedemption ──n:1── User  (unique [couponId, userId])
Student ──1:n── Referral (referrer) ──n:1── Student (referred)
Student ──1:n── StudentBadge  (unique [studentId, code])
Teacher ──1:n── LessonPlanTemplate
Teacher ──1:n── TeacherNote
Setting ── (singleton store for brand, prices, sessions)
```

### Cascade behavior

- Deleting a `User` cascades to `Student` / `Parent` / `Teacher` /
  `Notification` / `AuditLog` / `Payment` (not cascading for Payment
  — only the User relation; Payment survives).
- Deleting a `Student` cascades to all assessment records
  (`LessonProgress`, `QuizAttempt`, `Attendance`, `HomeworkSubmission`,
  `LessonBookmark`, `LessonNote`, `ExamAttempt`, `StudyTask`,
  `StudentBadge`, `Referral` both directions).
- Deleting a `Course` cascades to `Part` → `Unit` → `Topic` →
  `Lesson` → (Quiz, Question, Homework, LessonProgress,
  LessonBookmark, LessonNote, ExamQuestion).

---

## 7. Seed Data

`scripts/seed.ts` populates:

| Entity           | Count | Notes                                                        |
| ---------------- | ----- | ------------------------------------------------------------ |
| Settings         | 10    | brand_name, brand_tagline, whatsapp_*, academic_year, price_* |
| Users            | 4     | admin, teacher, student, parent (scrypt-hashed passwords)   |
| Teacher profile  | 1     | "Eng. Omar Khaled" — specialty: Machine Learning            |
| Student profile  | 1     | "Ahmed Hassan" — grade "2nd Secondary" — STEM Cairo         |
| Parent profile   | 1     | "Mr. Hassan" linked to the student                          |
| Course           | 1     | "Programming & AI" (slug: programming-ai-2nd-sec)            |
| Parts            | 2     | Part One + Part Two                                          |
| Units            | ~6    | IT & Society, Cybersecurity, Web Apps, Web Design, Data, ML |
| Topics           | ~12   | 2 per unit                                                   |
| Lessons          | ~36   | 2 per topic (first lesson unlocked, rest locked)            |
| Quiz             | 1     | On the first lesson                                          |
| Questions        | 3     | 1 MCQ EASY, 1 TRUE_FALSE EASY, 1 MCQ MEDIUM                 |
| Homework         | 1     | On the first lesson (7-day deadline)                        |
| Group            | 1     | "Group A — Sat & Tue 6PM" (capacity 25)                     |
| LiveSessions     | 2     | 1 upcoming (SCHEDULED) + 1 past (COMPLETED with attendance) |
| Attendance       | 1     | Demo student PRESENT for the past session                   |
| SubscriptionPlan | 4     | Monthly 200, 3 Months 550, 6 Months 1000, Early Bird 100    |
| Notifications    | 3     | Sample NEW_LESSON, UPCOMING_SESSION, MONTHLY_REPORT         |
| LessonPlanTemplate | 3   | Programming concepts, ML basics, Cybersecurity basics      |

The `scripts/seed-parent-demo.ts` script adds an additional parent +
student link for testing the multi-child selector.

---

## 8. Reset Procedure

To wipe and recreate the database:

```bash
# 1. Stop the dev server (Ctrl+C in the terminal running bun run dev)
# 2. Delete the database file + journal
rm -f db/custom.db db/custom.db-journal

# 3. Push the schema (creates a fresh empty database)
bun run db:push

# 4. Re-seed
bun run scripts/seed.ts

# 5. Restart the dev server
bun run dev
```

For a complete wipe including Prisma client cache:

```bash
rm -rf db/ node_modules/.prisma
bun install
bun run db:push
bun run scripts/seed.ts
```

---

## 9. Backup & Restore

### Backup (SQLite)

```bash
# Simple copy (offline — stop the dev server first for consistency)
cp db/custom.db backups/custom-$(date +%F-%H%M).db

# Online backup using sqlite3 .backup command (safer, no lock)
sqlite3 db/custom.db ".backup backups/custom-$(date +%F-%H%M).db"
```

### Restore (SQLite)

```bash
# Stop the dev server
# Replace the database file
cp backups/custom-2024-09-01-0300.db db/custom.db
# Restart
bun run dev
```

### Backup (PostgreSQL — Phase 21 production path)

```bash
# Full custom-format dump + sha256 + manifest + retention (see §11 + runbook)
scripts/db/backup-postgres.sh --out-dir /var/backups/codemind --label nightly

# Restore into an EMPTY database (enforces integrity + verification battery)
scripts/db/restore-postgres.sh --backup /var/backups/codemind/<artifact>.dump \
    --target postgresql://user@host/codemind_restored

# Verify any PostgreSQL (counts, constraints, lifecycle, app-shaped queries)
node scripts/db/verify-postgres.mjs --target "$DATABASE_URL"
```

Authoritative procedure: `docs/POSTGRES_CUTOVER_RUNBOOK.md`.
Design + drill evidence: `docs/PHASE_21_PRODUCTION_DATABASE_STORAGE.md`.

### Cron job (VPS)

```cron
0 3 * * * sqlite3 /home/codemind/codemind-academy/db/custom.db ".backup /home/codemind/codemind-academy/backups/custom-$(date +\%F).db" && find /home/codemind/codemind-academy/backups/ -name "custom-*.db" -mtime +30 -delete
```

Runs daily at 3 AM, retains 30 days.

---

## 10. Important Commands

| Command                  | What it does                                                 |
| ------------------------ | ------------------------------------------------------------ |
| `bun run db:push`        | `prisma db push --accept-data-loss` — syncs schema to DB    |
| `bun run db:generate`    | `prisma generate` — regenerate the Prisma client (after schema edits) |
| `bun run db:migrate`     | `prisma migrate dev` — create + apply a named migration     |
| `bun run db:reset`       | `prisma migrate reset` — drop + recreate + re-seed          |
| `bun run scripts/seed.ts`| Run the seeder (idempotent for users, additive for curriculum) |

### After editing `prisma/schema.prisma`

```bash
# 1. Regenerate the client (so TS types update)
bun run db:generate

# 2. Push the changes to the database
bun run db:push

# 3. (Optional) Run the seeder to add demo data for new models
bun run scripts/seed.ts
```

### Inspect the database

```bash
# Open the SQLite CLI
sqlite3 db/custom.db

# Useful queries
.tables
.schema User
SELECT COUNT(*) FROM User;
SELECT key, value FROM Setting WHERE key LIKE 'session:%';
SELECT email, role FROM User;
```

---

## 11. Switching to PostgreSQL (Phase 21 — IMPLEMENTED)

> The old "edit the provider + pgloader" sketch below is SUPERSEDED by the
> Phase 21 cutover. Do not hand-edit the provider and do not use pgloader
> (it cannot preserve the verification contract). Follow the runbook:
> **`docs/POSTGRES_CUTOVER_RUNBOOK.md`**.

Short form (details + rollback in the runbook):

1. **Derive (never hand-edit) the PostgreSQL artifacts**:
   ```bash
   node scripts/db/make-postgres-schema.mjs        # regenerates both
   node scripts/db/make-postgres-schema.mjs --check # CI / pre-cutover gate
   ```
   This produces `prisma/schema.postgresql.prisma` (provider-only swap) and
   `scripts/db/postgres-baseline.sql` (21 enums + 55 tables + 67 indexes).
2. **Apply the baseline** to an empty database (`psql -f
   scripts/db/postgres-baseline.sql`, or `prisma db push` from the derived
   schema where engines are reachable).
3. **Load** (one transaction, fail-closed, count+hash verified):
   ```bash
   node scripts/db/migrate-sqlite-to-postgres.mjs --source db/custom.db \
       --target "$DATABASE_URL" --manifest /var/backups/codemind/pg-load.json
   ```
4. **Verify**: `node scripts/db/verify-postgres.mjs --target "$DATABASE_URL"`
   must end `VERIFY_POSTGRES_OK` (presence, orphans, duplicates, Teacher
   lifecycle, security tables, rate-limit probe, app-shaped queries).
5. **Baseline the ledger** (`prisma migrate resolve --applied …`) so the 9
   SQLite migrations are never replayed on PostgreSQL, then switch
   `DATABASE_URL` per the runbook.

### Schema compatibility notes (verified, not assumed)

- All `String` fields with JSON content (`Question.options`,
  `LessonPlanTemplate.objectives`, `ExamAttempt.answers`, …) stay `TEXT` —
  deliberately NO JSONB conversion (opaque to the DB, byte-identity required).
- No SQLite-specific functions, no `@db.*`, no `Bytes/Json/Decimal/BigInt`,
  no raw SQL in `src/` — every query is a Prisma call, identical on both
  providers (swept by `tests/production-storage-phase21.test.js` §3).
- `cuid()` IDs work identically on both providers and are preserved verbatim.
- `DateTime` maps to `TIMESTAMPTZ(3)`; all three SQLite encodings (ISO, naive,
  ms-epoch) migrate to the same UTC instants (drill-proven).
- NULL-in-UNIQUE semantics agree on both engines (NULLs distinct).
- Security persistence (`UserSession`, `PasswordResetToken`,
  `TeacherApplication`/`TeacherActivationToken`, `SecurityRateLimit`,
  `SecurityEvent`) migrates 1:1 with the same constraints; the guarded
  rate-limit and single-use activation primitives are proven on PostgreSQL
  by the verification battery.

### Evidence retention & storage quotas (Phase 21)

- Expired quiz camera evidence is purged by
  `npx tsx scripts/media/purge-expired-evidence.ts` (dry-run by default;
  `--live --yes` deletes; rule in `src/lib/evidence-retention.ts`).
  Security/audit tables are never inputs and are count-asserted unchanged.
- Volume quota: `MEDIA_QUOTA_BYTES` (unset = unlimited = previous behavior;
  set = fail-closed 413 before any write). Policy: `src/lib/storage-quotas.ts`.

**Status**: PostgreSQL cutover is **IMPLEMENTED and drill-verified**
(`PHASE21_MIGRATION_OK` + `PHASE21_RESTORE_OK` on disposable PostgreSQL).
`prisma/schema.prisma` still ships `provider = "sqlite"` for development; the
derived `prisma/schema.postgresql.prisma` is the production target.
