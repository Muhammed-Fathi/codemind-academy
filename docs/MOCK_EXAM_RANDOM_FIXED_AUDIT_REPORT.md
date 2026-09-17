# Mock Exam Random/Fixed Audit Report

نتيجة أوديت كاملة لمشكلة اختيار أسئلة الـMock Exam، مع الإصلاح، والاختبارات، والأدلة.
كل اللي تحت مبني على كود الفروع الفعلي + اختبارات تشغيلية على الهاندلرز الحقيقية
(in-memory Prisma؛ مفيش أي لمس لبيانات إنتاجية).

---

## 1. Root Cause

المشكلة مكانت في الـAI Generator ولا في الأسئلة نفسها — المشكلة إن **الـPool كان معرّف
مرتين بشكلين مختلفين**، والاتنين كانوا بيقيسوا حاجة مختلفة:

| المسار | كان بيقيس إيه | النتيجة |
|---|---|---|
| حراسة الإنشاء (Admin POST) | كل صفوف البنك المطابق (`questionBankFilter(schoolType)` ± الصعوبة)، **بدون أي ربط بكورس/درس** | امتحان يتقبل بسهولة |
| حراسة النشر (Admin PATCH) | كل صفوف البنك، **بدون صعوبة ولا ربط بكورس/درس** | امتحان يتنشر |
| مسار الطالب RANDOM | `quiz.lessonId ∈ lessonIds` أو `ExamQuestion.lessonId ∈ lessonIds` — أي **لازم السؤال يبقى تابع لدرس** | أسئلة يدوية = **صفر** |

السؤال اليدوي اللي بيتضاف من Question Bank بيتحفظ بـ `quizId = null`
(`src/app/api/admin/question-bank/route.ts:128` — "Add Question" ما بيبعتش `quizId`
أصلًا في `admin-dashboard.tsx`)، فبالتالي:

- **RANDOM**: السؤال مش داخل الـPool خالص → الامتحان بيتنشأ/بيتنشر وهو مش قابل للتقديم،
  والطالب إما يشوف «مفيش أسئلة» أو ورقة أقل من المطلوب من غير تفسير.
- **FIXED**: شغّال، لأن الأسئلة بتتحل بالـ`id` (`MockExamQuestion.questionId`) والاستعلام
  عليها مفلتر بالبنك بس — مفيش شرط درس. وده بالظبط سبب إن المشكلة طلعت في RANDOM بس.

**السبب الفرعي (اتصلّح كمان):** الإنشاء التلقائي لامتحان FIXED كان بيسحب من جدول
`Question` بس، بينما عدّاد الحراسة كان بيجمع `Question + ExamQuestion` — يعني الحراسة
تقول "كافي" وفي الآخر pins أقل من العدد.

**إثبات تنفيذي (بدون أي بيانات حقيقية):** الاختبار الجديد
`tests/mock-exam-random-manual-bank.test.js` بيبني بنك من **12 سؤال يدوي** (بدون درس،
بدون أي metadata، بدون AI) + أسئلة مربوطة بدروس، ويجيب آخر الحالة:
Pool عربي للكورس = 17 سؤال، والـRANDOM بياخد 5 منهم، والـFIXED بيخدم الـids المختارة
بالظبط، والـLANGUAGE مستحيل يشوف العربي.

---

## 2. Manual Question Eligibility (العقد الواحد)

العقد اتجمع في ملف واحد **`src/lib/mock-exam-pool.ts`** — مصدر الحقيقة الوحيد لكل من:
الطالب، حراسة الإنشاء، حراسة النشر، والإحصائيات في لوحة الأدمن:

سؤال مؤهل ⟺

1. **البنك**: `schoolType` = بنك الامتحان أو `null` (مشترك) — نفس `questionBankFilter`.
2. **النطاق**: واحد من:
   - **بنك حر بدون درس** (`Question.quizId = null` — و`Quiz.lessonId` عمود غير قابل
     للـnull، فالسؤال إما بدون كويز تمامًا أو داخل درس؛ و`ExamQuestion.lessonId = null`)
     → مؤهل لأي كورس من نفس البنك. ✅ ده اللي كان مكسور.
   - **مربوط بدرس** من دروس الكورس اللي **مرئية للطالب** (`status = PUBLISHED`،
     والدرس تابع لكورس الامتحان أو كورس الطالب لو الامتحان مش مربوط بكورس) — على السلسلتين
     (canonical: unit→part، وlegacy: topic→unit→part).
3. **غير محذوف** — مفيش علم أرشفة للسؤال، والحذف مرفوض أصلًا لو الامتحان FIXED مثبّت السؤال
   أو في محاولة بتشاور عليه.

**اللي مش داخل في الأهلية خالص:** مصدر السؤال (AI/يدوي)، الـtags، التصنيفات، الـmarks،
والصعوبة (الصعوبة **فلتر اختيار** مش شرط أهلية). يعني سؤال الأدمن اليدوي = سؤال الـAI
المحفوظ، بنفس الشكل بالظبط.

---

## 3. FIXED Flow (محفوظ زي ما هو + اتظبط)

- الأدمن بيختار الأسئلة بالـid من قائمة الأسئلة المؤهلة (نفس الـpool) → السيرفر يتحقق من:
  كل id موجود، **وشكل مش مكرر**، **تابع لبنك الامتحان**، **ومؤهل لنطاق الامتحان**
  (بنك حر أو درس مرئي في كورس الامتحان) — وإلا 400 برسالة عربية واضحة
  (`api.306`…`api.309`).
- عدد الأسئلة بيتحدد من الاختيار نفسه؛ أي `questionCount` متعارض بيترفض (`api.308`).
- وقت التقديم: الأسئلة المثبتة بتتقدّم **بنفس الترتيب** — مفيش فلتر صعوبة، مفيش خلط، مفيش
  حذف صامت لأي سؤال (`/api/exams/mock` GET). لو اتشيَل سؤال من البنك بعد كده، الطالب
  يتقال له صريح إن الورقة أقل من المطلوب.
- النشر بقى يتحقق من **عدد الـpins** مقابل العدد المطلوب (`api.312`) بدل ما يقيس البنك كله.
- الاختبارات بتأكد: 3 قراءات متتالية بنفس الترتيب، والـpins هي نفس الـids المختارة بالحرف.

---

## 4. RANDOM Flow

- الـPool: العقد الواحد (بند 2) على الجدولين (`Question` + `ExamQuestion`).
- الاختيار: **مجمّد لكل محاولة**:
  `seed = HMAC-SHA256(server secret, student | course | exam | attemptIndex | count | difficulty)`
  وترتيب المرشحين بـ`HMAC(secret, seed|id)` ثم أخذ أعلى N. النتيجة:
  - نفس الطالب + نفس المحاولة ⟹ **نفس الأسئلة بنفس الترتيب** (refresh/رجوع/تاب تاني
    مايغيّرش حاجة)؛
  - مفيش تكرار داخل المحاولة (dedupe بالـid)؛
  - الترتيب بيتحسب على السيرفر بمفتاح سري، فالطالب مايقدرش يتوقّعه ولا يختاره؛
  - **مفيش حالة in-progress متخزنة** على السيرفر (GET يفضل read-only، ومفيش جدول/عمود جديد).
- الطلب أكبر من المتاح: الإنشاء/النشر بيترفضوا مقدمًا (`api.213` بأرقام: مطلوب/متاح/بنك حر)،
  ولو البنك قلّ بعد النشر، الطالب بياخد المتاح **ومعاه رسالة واضحة** (`api.311`).
- الصعوبة: لو مفيش أسئلة بالصعوبة المطلوبة → fallback للـpool كله (سلوك قديم محفوظ)،
  والعدّاد `servable` في لوحة الأدمن بيحسب نفس القاعدة.

---

## 5. Retry / Attempt Behavior

- **مفيش أي نموذج محاولات جديد**: المحاولات زي ما هي — الطالب بيسلّم محاولة، بتتسجّل
  (الدرجة/النسبة/النجاح) وبتظهر في سجله (`attempts`, `bestPercentage`).
- `attemptIndex` = عدد المحاولات **المنتهية** لهذا الطالب على هذا الامتحان. يعني:
  - محاولة تحت التنفيذ ⟹ مجمّدة تمامًا (index ثابت).
  - بعد التسليم ⟹ أول طلب جديد بيبقى **ورقة جديدة** من نفس الأسئلة المؤهلة.
- التصحيح كله على السيرفر: `isCorrect`/`marks` القادمة من العميل لا تُصدَّق أبدًا،
  ومفتاح الإجابة بيظهر **بعد التسليم بس** (`correctText` + `explanation`).
- الإجابات المتكررة في نفس الطلب بتتدمج لصف واحد لكل سؤال (المحاولة مجموعة أسئلة، ليست
  multiset)، والـIDs المجهولة أو من بنك تاني بتتصحح صفر وما بترتبطش بالامتحان.

---

## 6. Security

- **مفيش مفتاح إجابة قبل التسليم**: GET مابيرسّلش `correctIndex` ولا `explanation`؛
  الخيارات بتتخلط للعرض والإجابة بتتصحح بالنص على السيرفر.
- **الطالب مايختارش أسئلته**: الـPool والاختيار سيرفر-سايد بالكامل، والمفتاح بيتحسب من
  `Student.schoolType` (من الداتابيز) — مفيش `schoolType` من العميل في مسار الطالب.
- **عزل البنوك**: عربي ⟹ عربي + مشترك بس، ولغات ⟹ لغات + مشترك بس — على الاختيار
  **والتصحيح** (`gradingBankFilter`).
- **نطاق الكورس**: امتحان مربوط بكورس → الطالب لازم يكون في الكورس (وإلا 404)، والأسئلة
  المربوطة بدروس لازم تكون في نفس النطاق (بنك حر = للأي كورس).
- **حراسة الأدوار**: كل مسارات إدارة الامتحانات (والإحصاءات الجديدة) ADMIN فقط — الفحوصات
  بتأكد 403 للمدرّس/الطالب/ولي الأمر، ومفيش أي مسار للطالب بيسمح بتعديل امتحان.
- **مراجعة المرسل**: أي `mockExamId` غير منشور/بنك مختلف/كورس مختلف بيتعامل كتدريب حر
  صامت (بدون ربط محاولة).

---

## 7. Files Changed

| الملف | التغيير |
|---|---|
| `src/lib/mock-exam-pool.ts` | **جديد** — العقد الواحد للأهلية + عدّاد الـpool + اختيار RANDOM المجمّد (HMAC) + helpers للـwhere |
| `src/app/api/exams/mock/route.ts` | pool الطالب بقى يشمل البنك الحر؛ اختيار عشوائي مجمّد لكل محاولة؛ `selectionMode`/`requestedCount`/`eligiblePool`/`shortfall`/`passMark` في الرد؛ رسالة واضحة لبنك فاضي؛ dedupe للإجابات |
| `src/app/api/admin/mock-exams/route.ts` | حراسة الإنشاء بقت على نفس الـpool؛ التحقق من `questionIds` لـFIXED؛ عدّاد الأهلية لكل امتحان في GET |
| `src/app/api/admin/mock-exams/[id]/route.ts` | حراسة النشر: RANDOM بالـpool المؤهل، FIXED بعدد الـpins (`api.312`) |
| `src/app/api/admin/mock-exams/eligible/route.ts` | **جديد** — ADMIN-only: عدد الأسئلة المؤهلة + قائمة الأسئلة للاختيار (بدون مفاتيح إجابة) |
| `src/components/admin/mock-exams-view.tsx` | شاشة الإنشاء: شرح FIXED/RANDOM، عدّاد المتاح + تفصيل (بنك حر/صعوبة)، اختيار أسئلة FIXED، رفض فوري بالأرقام، ملاحظة «الـAI مش مطلوب»، تنبيه للأمتحانات الناقصة |
| `src/components/student/mock-exam.tsx` | إظهار الـshortfall بوضوح للطالب، والنجاح/الرسوب بيتبع `passed` من السيرفر (مش 60 ثابتة) |
| `src/lib/i18n-dict-2026.ts` | مفاتيح عربية/إنجليزية جديدة لكل الرسائل (`api.213` بالأرقام، `api.306-312`, `admin.539-555`, `student.250`) |
| `tests/mock-exam-random-manual-bank.test.js` | **جديد** — 12 سؤال يدوي، FIXED/RANDOM، freeze/retry، أمان، عزل بنوك، بنك فاضي |
| `docs/MOCK_EXAM_WORKFLOW_GUIDE_AR.md` | **جديد** — دليل عربي كامل |
| `docs/MOCK_EXAM_RANDOM_FIXED_AUDIT_REPORT.md` | **جديد** — التقرير ده |

---

## 8. Tests (بالأرقام الفعلية)

تشغيل كامل لـ`tests/*.test.js` بعد الإصلاح:

| السويت | النتيجة |
|---|---|
| `mock-exam-phase8` | **135 passed, 0 failed** |
| `mock-exam-random-manual-bank` (**جديد**) | **75 passed, 0 failed** |
| `mock-exam-grading-isolation` | **22 passed, 0 failed** |
| `authorization-invariants` | **93 passed, 0 failed** |
| `session-quiz` (Phase 26D lesson-quiz) | **70 passed, 0 failed** |
| `phase26d-teacher-full-flow` | **PASS** (`PHASE26D_TEST_OK`) |
| `phase26b-student-flow` | **40 passed, 0 failed** |
| `auth-cross-role-phase26f` | **20 passed, 0 failed** |
| `security-hardening` | **375 passed, 0 failed** |
| `security-hardening-phase20` | **192 passed, 0 failed** |
| `security-audit-gate` | **116 passed, 0 failed** |
| `admin-publishing-phase15` | **386 passed, 0 failed** |
| `post-launch-admin-lifecycle` | **57/57 checks passed** |
| `teacher-workflow-phase18` | **371 passed, 0 failed** |
| `calendar-i18n-phase9` | **460 passed, 0 failed** |
| `track-architecture-phase12` | **310 passed, 0 failed** |
| باقي سويتات `tests/` (59 ملف إجمالًا) | **57 سويت passed بـ0 failed** — و2 استثناءات بيئية تحت |

استثناءات بيئية (مش ليها علاقة بالامتحانات، وبتفشل/تتخطى قبل الإصلاح كمان):

- `final-integration-phase22`: بيحتاج `db/custom.db` + فولدر `backups/` على الجهاز —
  بيخرج `ENOENT` لعدم وجودهم هنا.
- `phase26d-concurrency-postgres`: `SKIPPED` — محتاج PostgreSQL حقيقي (CI بيبنيها).

**TypeScript (المصدر الرسمي = CI):** بوابة CI بتعمل `npx prisma generate && npx tsc --noEmit`
على الـclient الحقيقي المتولّد — و**3/3 بوابات CI كلها success** على آخر commit:

- Migration provider architecture gate — success
  (https://github.com/Muhammed-Fathi/codemind-academy/actions/runs/35260699546)
- Phase 26D PostgreSQL concurrency gate — success
  (https://github.com/Muhammed-Fathi/codemind-academy/actions/runs/35260699446)
- PG17 trusted catalog references (pre-26D + POST-26D full chain) — success
  (https://github.com/Muhammed-Fathi/codemind-academy/actions/runs/35260699433)

في البيئة المحلية للـsandbox الـ`@prisma/client` **غير مولّد** (`prisma generate` محتاج
تنزيل engines ومش متاح offline)، فالمقارنة المحلية هي: 58 خطأ قبل التغيير (كلها في ملفات
قديمة بسبب العميل غير المولّد) و58 بعده + 11 خطأ إضافي في ملفات الإصلاح، كلها من نوع
واحد: `Namespace ... Prisma has no exported member 'QuestionWhereInput' /
'ExamQuestionWhereInput' / 'LessonWhereInput'` — أي إن السطر اللي بيقول "استخدم نوع
Prisma الحقيقي" هو نفسه اللي بيفشل محليًا لغياب العميل. البوابات الثلاثة (وعلى رأسها
`tsc` مع العميل الحقيقي + `next build` على Postgres) كلها خضراء، يعني الكود يمرّ
type-check كامل في البيئة الصحيحة.

**ESLint:** نفس عدد أخطاء ما قبل التغيير بالظبط (3 أخطاء قائمة في ملفين، نمط قديم)،
صفر أخطاء إضافية.

---

## 9. DB / Migration Impact

**صفر.** مفيش أي تغيير في `prisma/schema.prisma` ولا `prisma/postgres/schema.prisma`،
ولا migrations جديدة (SQLite ولا Postgres). الإصلاح واختيار الأسئلة كلهم على مستوى
الأستعلامات/الـAPI/الـUI، والمحاولات بتتخزن في نفس الجداول والحقول الموجودة
(`ExamAttempt.answers` snapshot زي ما هي). اختبارات الـmigrations
(`migration-providers`, `migration-sql`, `platform-upgrade-2026-migration`) كلها passed.

---

## 10. Arabic Guide (path)

**`docs/MOCK_EXAM_WORKFLOW_GUIDE_AR.md`**

بيغطي: يعني إيه Mock Exam، الفرق FIXED/RANDOM، إزاي تضيف سؤال يدوي، امتى السؤال يبقى مؤهل،
إزاي تعمل امتحان FIXED، إزاي تعمل امتحان RANDOM، الطالب بيشوف إيه، هل الأسئلة بتتغيّر
أثناء المحاولة، بيحصل إيه في الـretry، الأخطاء الشائعة وحلولها، وهل الـAI Generator مطلوب
(الإجابة: **لأ**)، وChecklist قبل النشر.

---

## 11. Verdict

**READY FOR GIT DELIVERY**

- السبب اتحدد من الكود الفعلي واتثبت باختبار تشغيلي، مش تخمين.
- الأسئلة اليدوية بقت مؤهلة في FIXED و RANDOM بنفس القواعد، والـAI مش مطلوب.
- محاولة RANDOM مجمّدة، والـretry ورقة جديدة، وقواعد المحاولات الحالية زي ما هي.
- كل السويتات passed، و0 أخطاء جديدة في TypeScript/ESLint، و0 تغييرات DB/Migration.
- الفروع: شغل على فرع مخصص (`arena/01a0b089-codemind-academy`) من آخر `main`
  (`ac191fa`) — **بدون دمج، بدون نشر، وبدون PR قبل المراجعة**، وبدون أي لمس لبيانات
  إنتاجية.

ملاحظات للمراجعة (مقصودة وموثّقة):

1. سياسة `ARCHIVED` للدروس في pool الامتحانات **ماتغيّرتش** (القرار القديم الموثّق في الراوت:
   الفلتر هو `status = PUBLISHED` فقط) — التغيير كان محصور في الأهلية اللي كانت مكسورة.
2. الأدمن بقى يقدر يثبّت أسئلة FIXED بالاسم (ودي إضافة مطلوبة)، والسلوك القديم
   (auto-pin بدون `questionIds`) لسه مدعوم للتوافق.
3. شاشة الطالب مابتحفظش إجابات مؤقتة على السيرفر — التجميد خاص بالأسئلة نفسها
   (وده المطلوب في الأوديت).
