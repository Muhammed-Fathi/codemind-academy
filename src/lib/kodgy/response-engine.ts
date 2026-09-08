// CodeMind Academy — Kodgy Scripted Response Engine (Phase 10)
//
// Deterministic, dependency-free, bilingual (AR/EN) knowledge matcher.
// There is intentionally NO network, NO external LLM and NO database here:
//
//   Kodgy UI
//      ↓
//   Kodgy Assistant Controller  (use-kodgy-chat.ts)
//      ↓
//   Scripted Response Engine    (this file)
//      ↓
//   Matched Response            ({ intent, answer })
//
// The engine is deliberately simple and maintainable: normalized
// phrase/keyword scoring over a curated knowledge set. A future real AI
// engine can replace `match()` behind the same `KodgyResponse` contract
// without rebuilding the UI.
//
// IMPORTANT SECURITY: user input is NEVER rendered as HTML anywhere in
// Kodgy. This module only *normalizes* input for matching; it never
// echoes raw input back into responses.

export type KodgyLocale = "ar" | "en";

export interface LocalizedText {
  ar: string;
  en: string;
}

export interface KodgyResponse {
  /** Stable intent id, e.g. "platform.lessons" or "fallback". */
  intent: string;
  /** Whether a curated answer matched (false = graceful fallback). */
  matched: boolean;
  /** Deterministic match score (higher wins; 0 = fallback). */
  score: number;
  /** Bilingual answer text — the UI picks the active locale. */
  answer: LocalizedText;
}

interface KnowledgeEntry {
  id: string;
  intent: string;
  /** Normalized phrases — a phrase hit is a strong signal. */
  phrases: readonly string[];
  /** Normalized keywords — single-word/token hits are weaker signals. */
  keywords: readonly string[];
  answer: LocalizedText;
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/** Normalize Arabic orthography variants so matching is forgiving. */
function normalizeArabic(s: string): string {
  return s
    .replace(/[\u064B-\u0652\u0670\u0640]/g, "") // tashkeel + tatweel
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/ئ/g, "ي")
    .replace(/ؤ/g, "و")
    .replace(/ـ/g, ""); // kashida variation of tatweel
}

/**
 * Deterministic query normalization:
 *   - lowercase (Latin), NFKC
 *   - Arabic diacritics/hamza variants collapsed
 *   - punctuation (incl. Arabic ؟،) removed
 *   - definite article "ال" stripped when it leaves ≥3 chars
 *   - whitespace collapsed
 * The same normalization is applied to knowledge phrases at match time so
 * authoring stays readable.
 */
export function normalize(input: string): string {
  let s = String(input ?? "")
    .normalize("NFKC")
    .toLowerCase();
  // "الـ<latin>" ligature article — remove entirely BEFORE tatweel removal.
  s = s.replace(/الـ/g, "");
  s = normalizeArabic(s);
  s = s
    // strip Arabic definite article for (ال) + ≥3 letters
    .replace(/^ال(?=[\u0621-\u064A]{3,})/g, "")
    .replace(/\sال(?=[\u0621-\u064A]{3,})/g, " ");
  // Keep letters/digits (Arabic letter ranges only — the \u0600-\u06FF block
  // also contains Arabic PUNCTUATION like ؟ ، ؛, which must be removed).
  s = s.replace(
    /[^a-z0-9\u0621-\u064A\u0660-\u0669\u0671-\u06D3\u06D5\u0750-\u077F\s]/g,
    " "
  );
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

/** Normalized word tokens (empty for a blank query). */
export function tokens(normalized: string): string[] {
  return normalized.split(" ").filter(Boolean);
}

// ---------------------------------------------------------------------------
// Knowledge set (curated, initial Phase 10 coverage)
// ---------------------------------------------------------------------------

const T = (ar: string, en: string): LocalizedText => ({ ar, en });

const ENTRIES: readonly KnowledgeEntry[] = [
  // ----------------------------- platform --------------------------------
  {
    id: "greeting",
    intent: "greeting",
    phrases: [
      "أهلا",
      "أهلين",
      "مرحبا",
      "السلام عليكم",
      "صباح الخير",
      "مساء الخير",
      "هاي",
      "ازيك",
      "hello",
      "hi",
      "hey",
      "good morning",
      "good evening",
    ],
    keywords: ["تحية"],
    answer: T(
      "أهلاً بيك! أنا كودجي 🤖 مساعد CodeMind الذكي. اسألني عن أي حاجة في المنصة — زي إزاي تبدأ درس، أو فين الكويزات، أو امتحانات الموك — أو عن مفاهيم البرمجة والذكاء الاصطناعي.",
      "Hi there! I'm Kodgy 🤖, CodeMind's smart assistant. Ask me anything about the platform — how to start a lesson, where to find quizzes or mock exams — or about programming and AI concepts."
    ),
  },
  {
    id: "help",
    intent: "help",
    phrases: [
      "ماذا تستطيع",
      "بتقدر تساعد",
      "عايز مساعدة",
      "محتاج مساعدة",
      "what can you do",
      "how can you help",
      "what do you do",
      "help me",
    ],
    keywords: ["مساعدة", "help"],
    answer: T(
      "أقدر أساعدك في حاجتين:\n1️⃣ المنصة — بداية التعلم، الكورسات، الدروس، الكويزات، تقدم الجلسات، امتحانات الموك، جدول المذاكرة، التقدم والشهادات.\n2️⃣ التعليم — متغير، دالة، حلقة، شرط، مصفوفة، خوارزمية، برمجة، ذكاء اصطناعي، تعلم الآلة، شبكات عصبية.\nلو سؤالك خارج النطاق ده، هقولك بأمانة إن معرفتي الحالية محدودة.",
      "I can help with two things:\n1️⃣ The platform — getting started, courses, lessons, quizzes, session progression, mock exams, study scheduler, progress and certificates.\n2️⃣ Education — variables, functions, loops, conditions, arrays, algorithms, programming, AI, machine learning and neural networks.\nIf your question is outside that scope, I'll honestly tell you my current knowledge is limited."
    ),
  },
  {
    id: "getting-started",
    intent: "platform.getting-started",
    phrases: [
      "كيف أبدأ",
      "ازاي ابدأ",
      "ابدا منين",
      "منين ابدأ",
      "getting started",
      "get started",
      "how do i start",
      "where do i start",
      "start learning",
      "first step",
    ],
    keywords: ["ابدأ", "بداية", "مبتدئ", "start", "beginner", "أول خطوة"],
    answer: T(
      "ابدأ من صفحة «الرئيسية»: هتلاقي «الكورس» بمنهج Programming & AI مقسم لأجزاء ووحدات ودروس بالترتيب. افتح أول درس، شوف الفيديو (95% على الأقل)، وخلّص الواجب والكويز بتاعه — كده هيفتحلك الدرس اللي بعده تلقائياً. لو لسه مسجلتش، دور أول على خطوات التسجيل من صفحة «الاشتراك».",
      "Start on the Home page: you'll find the Programming & AI course split into parts, units and lessons in order. Open the first lesson, watch the video (at least 95%), and finish its homework and quiz — the next lesson unlocks automatically. If you haven't enrolled yet, complete the subscription steps first."
    ),
  },
  {
    id: "courses",
    intent: "platform.courses",
    phrases: ["الدورات", "الكورسات", "courses", "course catalog"],
    keywords: ["كورس", "كورسات", "دوره", "دورات", "course", "courses"],
    answer: T(
      "الكورسات موجودة من القائمة الجانبية تحت «الكورس». المنصة بتشتغل على منهج واحد أساسي: Programming & Artificial Intelligence لطلاب الثانوية العامة — مقسم لأجزاء ووحدات ودروس، وكل جزء ليه كويزات وواجبات مرتبطة بيه.",
      "Courses live in the sidebar under Course. The platform runs one core curriculum: Programming & Artificial Intelligence for secondary school students — split into parts, units and lessons, each with its own quizzes and homework."
    ),
  },
  {
    id: "lessons",
    intent: "platform.lessons",
    phrases: ["الدروس", "الجلسات", "الدرس", "lessons", "the lessons"],
    keywords: ["درس", "دروس", "جلسه", "جلسات", "محاضره", "محاضرات", "lesson", "lessons", "session", "sessions"],
    answer: T(
      "دروس الكورس بتظهر جوه «الكورس» من القائمة الجانبية — كل درس بيفتح في ترتيب معين. عشان تخلص درس لازم: تشوف الفيديو بنسبة 95% على الأقل، تسلّم الواجب، وتجاوب على الكويز. بعد كده الدرس اللي بعده هيفتح.",
      "Course lessons appear inside Course in the sidebar — each lesson opens in order. To complete one you must: watch the video to at least 95%, submit the homework, and answer the quiz. The next lesson then unlocks."
    ),
  },
  {
    id: "quizzes",
    intent: "platform.quizzes",
    phrases: [
      "فين الكويزات",
      "الاختبارات القصيره",
      "الاختبار القصير",
      "quizzes",
      "quiz questions",
      "where are the quizzes",
    ],
    keywords: ["كويز", "كويزات", "اختبار قصير", "امتحان قصير", "quiz", "quizzes"],
    answer: T(
      "الكويزات بتظهر مع كل درس جوه صفحة «الكورس» — بتفتح بعد ما تشوف الفيديو بتاع الدرس. الدرجة بتتحسب تلقائياً، ونتيجتك موجودة في صفحة «تقدمي» وفي تحليلات المدرس. أي كويز بتعيده بيتسجل كمحاولة جديدة، وأفضل درجة بتفضل.",
      "Quizzes appear with each lesson on the Course page and unlock after you watch the lesson video. Your score is graded automatically and appears on your Progress page and in the teacher's analytics. Retakes count as new attempts and your best score is kept."
    ),
  },
  {
    id: "session-progression",
    intent: "platform.session-progression",
    phrases: [
      "ترتيب الجلسات",
      "فك القفل",
      "الجلسات المقفوله",
      "الجلسه الجايه",
      "session progression",
      "unlock the next",
      "unlocking sessions",
      "how do sessions unlock",
      "unlock sessions",
    ],
    keywords: ["قفل", "مقفول", "تفتح", "متطلب", "متطلبات", "بالتسلسل", "unlock", "requirement", "progression", "sequential"],
    answer: T(
      "الجلسات بتتقدم بالترتيب: عشان يفتح لك الدرس التالي لازم تخلص المتطلبات بتاعة الدرس الحالي — فيديو 95% على الأقل + الواجب + الكويز. متطلب واحد مش موجود؟ متقلقش: القاعدة بتشترط اللي موجود بس، مش كل حاجة. المدرس ممكن كمان يعيد ترتيب الدروس من لوحة التحكم.",
      "Sessions progress in order: to unlock the next lesson you must complete the current lesson's requirements — video 95%+, homework and quiz. Missing one requirement? Don't worry: the rule only requires what exists, not everything. Teachers can also reorder lessons from their dashboard."
    ),
  },
  {
    id: "mock-exam",
    intent: "platform.mock-exam",
    phrases: [
      "الامتحان التجريبي",
      "الامتحانات التجريبيه",
      "امتحان تجريبي",
      "mock exam",
      "mock exams",
      "the mock exam",
    ],
    keywords: ["تجريبي", "تجريبيه", "mock"],
    answer: T(
      "امتحانات الموك موجودة من القائمة الجانبية تحت «الامتحان». بتختار الامتحان اللي مخصص لكل مدرستك، وبتدخل عليه، وبتجاوب، وفي الآخر بتشوف نتيجتك والإجابات الصحيحة والشرح. المدرسين بيحددوا الأسئلة والمدة ودرجة النجاح لكل امتحان.",
      "Mock exams are in the sidebar under Exams. Pick the exam assigned to your school type, take it, then review your result with correct answers and explanations. Teachers set the questions, duration and pass mark for each exam."
    ),
  },
  {
    id: "study-scheduler",
    intent: "platform.study-scheduler",
    phrases: [
      "جدول المذاكره",
      "خطة المذاكره",
      "منظم المذاكره",
      "study plan",
      "study scheduler",
      "study schedule",
    ],
    keywords: ["جدول", "مذاكره", "خطه", "scheduler", "study", "دراسه"],
    answer: T(
      "صفحة «الجدول» فيها تقويم شهرى لتخطيط مذاكرتك: اختار اليوم، اضيف مهمة، وحدد حالتها (تم / اتأجلت / معلقة). ده مش بيفتح دروس — الترتيب الحقيقي للدروس بيفضل هو نفسه — لكنه بيساعدك تلتزم بخطة أسبوعية.",
      "The Scheduler page has a monthly calendar for planning: pick a day, add a task, and mark its status (Done / Skipped / Pending). It doesn't unlock lessons — real lesson order stays the same — but it helps you stay consistent with a weekly plan."
    ),
  },
  {
    id: "progress",
    intent: "platform.progress",
    phrases: ["تقدمي", "نسبه التقدم", "my progress", "progress report"],
    keywords: ["تقدم", "انجاز", "تقدمي", "نسبه", "progress", "completion", "مستواي"],
    answer: T(
      "صفحة «تقدمي» بتعرض: نسبة إنجازك في الكورس، الجلسات المكتملة والحالية والمقفولة، درجات الكويزات، الحضور، ومستوى الـXP والشارات. فيه كمان زر «تصدير» لتنزيل تقرير تقدمك كملف، وفي يوتيوب؟ لأ — الملف CSV يفتح في Excel.",
      "Your Progress page shows: course completion, completed/current/locked sessions, quiz scores, attendance, and your XP/level with badges. There's also an Export button that downloads your progress as a file you can open in Excel."
    ),
  },
  {
    id: "certificate",
    intent: "platform.certificate",
    phrases: ["الشهاده", "شهادات الانجاز", "certificate", "get the certificate"],
    keywords: ["شهاده", "شهادات", "certificate", "certificates"],
    answer: T(
      "صفحة «الشهادة» بتظهر لما تصل نسبة إكمال 80% على الأقل من دروس الكورس. الشهادة بتحمل اسمك وبياناتك، وفيها زر طباعة / حفظ PDF. لو النسبة أقل من 80%، هتشوف نسبة إنجازك وعارف قد إيه فاضل.",
      "The Certificate page unlocks once you complete at least 80% of the course lessons. It carries your name and details, with a print / save-as-PDF button. Below 80% you'll see your completion percentage and what's left."
    ),
  },
  {
    id: "navigation",
    intent: "platform.navigation",
    phrases: [
      "فين القايمه",
      "التنقل في المنصه",
      "navigation",
      "how do i navigate",
    ],
    keywords: ["تنقل", "فين", "أين", "القايمه الجانبيه", "navigation", "menu", "الوصول"],
    answer: T(
      "كل حاجة بتوصلك من القائمة الجانبية (على الموبايل تفتحها من زر القائمة فوق): الرئيسية، الكورس، الامتحان، الجدول، الإحالات، تقدمي، وغيرها. جوه كل صفحة في أزرار كافية للتنقل، ولو مش لاقي حاجة اسألني عنها بالتحديد.",
      "Everything is reachable from the sidebar (on mobile, open it from the menu button at the top): Home, Course, Exams, Scheduler, Referral, Progress and more. Each page has its own navigation controls — if you can't find something, ask me specifically."
    ),
  },
  {
    id: "notifications",
    intent: "platform.notifications",
    phrases: ["الاشعارات", "التنبيهات", "notifications", "notification settings"],
    keywords: ["اشعار", "اشعارات", "تنبيه", "تنبيهات", "notification", "notifications"],
    answer: T(
      "صفحة «الإشعارات» بتجمع كل التنبيهات الخاصة بك — واجبات جديدة، نتائج كويزات، حصص، ومستجدات. تقدر كمان تتحكم في نوع الإشعارات اللي توصلك (زي الإشعارات الفورية بس) من إعدادات التفضيلات في نفس الصفحة.",
      "The Notifications page collects all your alerts — new homework, quiz results, sessions and updates. You can also control which notification types you receive from the preferences settings on that page."
    ),
  },

  // --------------------------- educational -------------------------------
  {
    id: "variable",
    intent: "edu.variable",
    phrases: ["ما هو المتغير", "ما هي المتغيرات", "المتغير", "variable"],
    keywords: ["متغير", "متغيرات", "variable", "variables"],
    answer: T(
      "المتغير (Variable) هو «علبة» في ذاكرة الكمبيوتر ليها اسم، بتخزن قيمة ممكن تتغير أثناء تشغيل البرنامج.\nمثال: السن = 16 — بعدين نقدر نغيرها: السن = 17.\nفي بايثون بنكتب: age = 16 من غير ما نحدد النوع، لكن في لغات تانية بنحدده زي int age = 16.",
      "A variable is a named box in the computer's memory that stores a value which can change while the program runs.\nExample: age = 16 — then we can change it: age = 17.\nIn Python: age = 16 (no type needed); in other languages you declare it, like int age = 16."
    ),
  },
  {
    id: "function",
    intent: "edu.function",
    phrases: ["ما هي الداله", "الدوال", "function"],
    keywords: ["داله", "دوال", "function", "functions"],
    answer: T(
      "الدالة (Function) هي كتلة كود ليها اسم، بتاخد مدخلات (inputs)، بتنفذ خطوات محددة، وبتَرجع نتيجة. بتستخدمها عشان تكرر نفس العملية من غير ما تعيد كتابة الكود.\nمثال: دالة تجمع رقمين → add(a, b) = a + b.\nتقسيم الكود لدوال صغيرة بيسهل القراءة والتعديل والاختبار.",
      "A function is a named block of code that takes inputs, runs specific steps, and returns a result. You use it to repeat the same logic without rewriting code.\nExample: a function that adds two numbers → add(a, b) = a + b.\nSplitting code into small functions makes it easier to read, change and test."
    ),
  },
  {
    id: "loop",
    intent: "edu.loop",
    phrases: ["ما هي الحلقه", "حلقات التكرار", "loop"],
    keywords: ["حلقه", "حلقات", "تكرار", "loop", "loops", "for loop", "while loop"],
    answer: T(
      "الحلقة (Loop) بتكرر مجموعة أوامر عدد معين من المرات أو لحد ما شرط معين يتحقق.\nمثال: عشان تطبع الأرقام من 1 لـ 5: for i in range(1, 6): print(i).\nفي بايثون في while (تكرر ما دام الشرط صحيح) و for (تكرر على مجموعة). الحلقة بتوفر عليك كتابة نفس السطر مئات المرات.",
      "A loop repeats a set of instructions a fixed number of times, or until a condition becomes true.\nExample: to print 1 to 5: for i in range(1, 6): print(i).\nPython has while (repeat while a condition holds) and for (iterate over a collection). Loops save you from writing the same line hundreds of times."
    ),
  },
  {
    id: "condition",
    intent: "edu.condition",
    phrases: ["ما هو الشرط", "الشروط", "if else", "condition"],
    keywords: ["شرط", "شروط", "condition", "conditions", "if statement"],
    answer: T(
      "الشرط (Condition) بيخلي البرنامج ياخد قرار بناءً على مقارنة: لو صح ننفذ حاجة، ولو غلط ننفذ حاجة تانية.\nمثال: if score >= 50 → «ناجح» else → «راسب».\nالمقارنات الشائعة: أكبر من >، أصغر من <، يساوي ==، وممكن ندمج أكتر من شرط بـ and / or.",
      "A condition lets the program make a decision based on a comparison: if it's true do one thing, otherwise do another.\nExample: if score >= 50 → 'Passed' else → 'Failed'.\nCommon comparisons: greater than >, less than <, equal ==, and you can combine conditions with and / or."
    ),
  },
  {
    id: "array",
    intent: "edu.array",
    phrases: ["ما هي المصفوفه", "المصفوفات", "array", "arrays"],
    keywords: ["مصفوفه", "مصفوفات", "array", "arrays", "قايمه مرتبه"],
    answer: T(
      "المصفوفة (Array) بتخزن مجموعة قيم من نفس النوع في مكان واحد، وكل قيمة ليها رقم (index) بيبدأ من صفر.\nمثال: grades = [90, 85, 95] — أول عنصر grades[0] هو 90.\nالحلقات بتشتغل رائع مع المصفوفات عشان تمر على كل العناصر، والقوائم (Lists) في بايثون نسخة أسهل وأقوى.",
      "An array stores a collection of values of the same type in one place, each with an index starting at 0.\nExample: grades = [90, 85, 95] — grades[0] is 90.\nLoops work great with arrays to visit every element; Python lists are an easier, more powerful version."
    ),
  },
  {
    id: "algorithm",
    intent: "edu.algorithm",
    phrases: ["ما هي الخوارزميه", "الخوارزميات", "algorithm"],
    keywords: ["خوارزميه", "خوارزميات", "algorithm", "algorithms"],
    answer: T(
      "الخوارزمية (Algorithm) هي خطوات مرتبة ومحددة بوضوح لحل مشكلة معينة — زي وصفة طبخ لكن للكمبيوتر. لازم تكون: محددة، منتهية (بتخلص)، وفعالة.\nمثال: خوارزمية إيجاد أكبر رقم في قايمة — قارن كل عنصر بالعنصر الأكبر لحد دلوقتي.\nالبرمجة هي ترجمة الخوارزمية لكود بلغة يفهمها الكمبيوتر.",
      "An algorithm is a clear, ordered set of steps to solve a specific problem — like a recipe, but for a computer. It must be: precise, finite (it ends), and effective.\nExample: finding the largest number in a list — compare each element with the largest so far.\nProgramming is translating an algorithm into code a computer can run."
    ),
  },
  {
    id: "programming",
    intent: "edu.programming",
    phrases: [
      "تعلم البرمجه",
      "البرمجه",
      "programming basics",
      "how to code",
      "learn programming",
      "start learning programming",
      "how do i start learning programming",
    ],
    keywords: ["برمجه", "كود", "coding", "programming", "مبتدئ برمجه"],
    answer: T(
      "البرمجة هي كتابة تعليمات للكمبيوتر عشان ينفذ مهمة. أول خطواتك: فكر في المشكلة، اكتب الخوارزمية (الخطوات)، وبعدين ترجمها لكود بلغة زي Python.\nفي CodeMind بتتعلم بالترتيب: المتغيرات ← الشروط ← الحلقات ← الدوال ← المصفوفات، وبعدين تنتقل لمواضيع الذكاء الاصطناعي. أهم حاجة هو التدريب العملي — اكتب كود بنفسك وقرب من أخطائك.",
      "Programming is writing instructions for a computer to perform a task. First steps: think about the problem, write the algorithm (steps), then translate it into code in a language like Python.\nAt CodeMind you learn in order: variables → conditions → loops → functions → arrays, then AI topics. Hands-on practice is everything — write code yourself and learn from your mistakes."
    ),
  },
  {
    id: "data-types",
    intent: "edu.data-types",
    phrases: ["انواع البيانات", "data types", "types of data"],
    keywords: ["نوع البيانات", "انواع البيانات", "data type", "data types", "integer", "string", "boolean", "float"],
    answer: T(
      "أنواع البيانات بتحدد شكل القيمة اللي بتخزنها: نص (string) زي «أحمد»، رقم صحيح (int) زي 16، رقم عشري (float) زي 3.14، وصحيح/خطأ (boolean) زي True/False.\nاختيار النوع الصح مهم: النص بيتخزن ويُقارن بشكل مختلف عن الأرقام، والعمليات الحسابية بتشتغل على الأرقام بس.",
      "Data types define the shape of a stored value: text (string) like 'Ahmed', whole number (int) like 16, decimal (float) like 3.14, and true/false (boolean).\nChoosing the right type matters: text is stored and compared differently from numbers, and arithmetic only works on numbers."
    ),
  },
  {
    id: "input-output",
    intent: "edu.input-output",
    phrases: ["الادخال والاخراج", "input and output", "طباعه"],
    keywords: ["ادخال", "اخراج", "طباعه", "input", "output", "print"],
    answer: T(
      "الإدخال (Input) هو البيانات اللي البرنامج بياخدها من المستخدم، والإخراج (Output) هو النتيجة اللي بيظهرها.\nفي بايثون: input() بتاخد من المستخدم، و print() بتبعت نص على الشاشة. أي برنامج عملي هو حلقة: ادخال ← معالجة ← اخراج.",
      "Input is the data a program receives from the user; output is the result it shows.\nIn Python: input() reads from the user and print() writes text to the screen. Every practical program is a loop of: input → processing → output."
    ),
  },
  {
    id: "ai-basics",
    intent: "edu.ai-basics",
    phrases: [
      "الذكاء الاصطناعي",
      "ذكاء اصطناعي",
      "artificial intelligence",
      "what is ai",
    ],
    keywords: ["ذكاء اصطناعي", "الذكاء", "artificial intelligence", "ai"],
    answer: T(
      "الذكاء الاصطناعي (AI) هو فرع من علوم الكمبيوتر بيبني أنظمة تقدر تتعلم من البيانات وتاخد قرارات أو تتنبأ — بدل ما تتبع تعليمات مكتوبة حرفياً لكل حالة.\nمن تطبيقاته: التعرف على الصور والصوت، الترجمة، التوصيات، والمحادثة. في CodeMind بتدرس أساسياته: تعلم الآلة، الشبكات العصبية، ونماذج اللغة الكبيرة.",
      "Artificial Intelligence (AI) is a branch of computer science that builds systems able to learn from data and make decisions or predictions — instead of following hand-written instructions for every case.\nApplications include image and speech recognition, translation, recommendations and conversation. At CodeMind you study its foundations: machine learning, neural networks and large language models."
    ),
  },
  {
    id: "ml-basics",
    intent: "edu.ml-basics",
    phrases: [
      "تعلم الاله",
      "تعلم الآلة",
      "machine learning",
      "what is machine learning",
    ],
    keywords: ["تعلم الاله", "machine learning", "machine", "ml"],
    answer: T(
      "تعلم الآلة (Machine Learning) هو طريقة بيشتغل بيها الذكاء الاصطناعي: بدل ما نكتب القواعد يدوي، بندي النظام بيانات وأمثلة، وهو بيستنتج النمط بنفسه.\nأنواعه الأساسية: تعلم بإشراف (Supervised) ببيانات ليها إجابات، وتعلم بدون إشراف (Unsupervised) ببيانات من غير إجابات، وتعلم بالتعزيز (Reinforcement) بالمكافآت.",
      "Machine Learning (ML) is how AI often works: instead of writing rules by hand, we give the system data and examples, and it learns the pattern itself.\nMain types: supervised learning (data with answers), unsupervised learning (data without answers), and reinforcement learning (learning by rewards)."
    ),
  },
  {
    id: "neural-network",
    intent: "edu.neural-network",
    phrases: ["الشبكه العصبيه", "شبكه عصبيه", "neural network", "neural networks"],
    keywords: ["شبكه عصبيه", "شبكات عصبيه", "neural network", "neural networks", "neuron"],
    answer: T(
      "الشبكة العصبية (Neural Network) نموذج مستوحى من خلايا المخ: طبقات من «عُقد» (neurons) كل واحدة بتاخد أرقام، وتضربها في أوزان، وتمرر النتيجة لدالة تفعيل.\nأثناء التدريب الأوزان بتتعدل بحيث تقل الأخطاء تدريجياً. أول طبقة بتاخد المدخلات، وآخر طبقة بتطلع النتيجة، واللي بينهم بتتعلم تمثيلات أعمق للمشكلة.",
      "A neural network is a model inspired by brain cells: layers of nodes (neurons) that take numbers, multiply them by weights, and pass the result through an activation function.\nDuring training the weights adjust so errors shrink gradually. The first layer takes inputs, the last produces the output, and the layers in between learn deeper representations."
    ),
  },
  {
    // Deliberately keyword-only and placed LAST among education entries:
    // when the question also names a concrete concept ("explain variables"),
    // the concept entry wins on score/order and explains it directly.
    id: "explain",
    intent: "edu.explain",
    phrases: [],
    keywords: [
      "explain this concept",
      "explain simply",
      "help me understand",
      "simple explanation",
      "simple example",
      "give me an example",
      "اشرح لي المفهوم",
      "اشرح المفهوم",
      "شرح مبسط",
      "ببساطه",
      "مثال بسيط",
      "فهمني",
    ],
    answer: T(
      "ماشي، هبسطهالك! بس محتاج أعرف المفهوم اللي بتسأل عنه بالظبط. 😊\nجرّب تسألني: «ما هو المتغير؟» أو «ما هي الحلقة؟» أو «ما هو الذكاء الاصطناعي؟» — وهشرحه بأمثلة بسيطة.",
      "Sure, let's keep it simple! I just need to know exactly which concept you mean. 😊\nTry: 'What is a variable?' or 'What is a loop?' or 'What is artificial intelligence?' — I'll explain with simple examples."
    ),
  },
  {
    id: "llm",
    intent: "edu.llm",
    phrases: ["نماذج اللغه", "نموذج لغوي", "large language model", "llm", "language model"],
    keywords: ["لغوي", "language model", "llm", "large language"],
    answer: T(
      "نموذج اللغة الكبير (LLM) هو شبكة عصبية ضخمة اتدربت على كميات هائلة من النصوص، فاتعلمت أنماط اللغة. لما تديله سؤال، بيتنبأ بالكلمة التالية الأكثر احتمالاً ويبني رد كامل.\nمن أشهر الأمثلة ChatGPT و Gemini. مهم تعرف إنه ممكن يغلط — دايماً تحقق من المعلومات المهمة. (وهنا في CodeMind، مساعد كودجي نفسها بيجاوب دلوقتي من قاعدة معرفة جاهزة! 😉)",
      "A Large Language Model (LLM) is a huge neural network trained on massive amounts of text, so it learned language patterns. Give it a prompt and it predicts the most likely next word, building a full reply.\nFamous examples are ChatGPT and Gemini. Remember it can be wrong — always verify important information. (And right here at CodeMind, Kodgy herself answers from a prepared scripted knowledge base! 😉)"
    ),
  },
];

// ---------------------------------------------------------------------------
// Curated "difference between X and Y" answers
// ---------------------------------------------------------------------------

interface DifferencePair {
  id: string;
  left: readonly string[];
  right: readonly string[];
  answer: LocalizedText;
}

const DIFF_PAIRS: readonly DifferencePair[] = [
  {
    id: "variable-vs-constant",
    left: ["متغير", "variable"],
    right: ["ثابت", "constant", "const"],
    answer: T(
      "الفرق: المتغير قيمة بتتغير شغال البرنامج، أما الثابت (constant) بيُحدد مرة واحدة ومينفعش يتغير بعدها.\nمثال: الثابت سرعة_الضوء = 3e8 — هتفضل ثابتة دايمًا، لكن العدادات زي (النقاط) بتبقى متغيرات.\nالقاعدة: لو القيمة مش هتتغير خلّيها constant، لو هتتغير استخدم variable.",
      "The difference: a variable's value can change while the program runs, while a constant is set once and cannot change afterward.\nExample: const SPEED_OF_LIGHT = 3e8 stays fixed forever, but counters like score are variables.\nRule of thumb: if the value never changes, make it a constant; otherwise use a variable."
    ),
  },
  {
    id: "loop-vs-condition",
    left: ["حلقه", "loop", "تكرار"],
    right: ["شرط", "condition", "if"],
    answer: T(
      "الشرط بياخد قرار مره واحدة: لو صح نفذ، غير كده لا. الحلقة بتكرر أوامر — وغالباً بتعتمد على شرط داخلي عشان تعرف توقف.\nمثال: if (age >= 18) بياخد قرار واحد. بينما for i in range(5) بيشغل الكود 5 مرات.\nالخلاصة: شرط = اختيار، حلقة = تكرار.",
      "A condition makes one decision: if true run it, otherwise skip. A loop repeats instructions — usually relying on an inner condition to know when to stop.\nExample: if (age >= 18) makes a single decision, while for i in range(5) runs the code five times.\nSummary: condition = choose, loop = repeat."
    ),
  },
  {
    id: "supervised-vs-unsupervised",
    left: ["تعلم بإشراف", "supervised", "بإشراف"],
    right: ["تعلم بدون إشراف", "unsupervised", "بدون إشراف", "غير خاضع"],
    answer: T(
      "في التعلم بإشراف (Supervised)، البيانات جاية بعلامات/إجابات معروفة — زي صور «قط/كلب» لكل صورة، والنظام بيتعلم يطابقها. في التعلم بدون إشراف (Unsupervised) الإجابات مش معروفة، والنظام بيلاقي أنماط وتجميعات بنفسه.\nمثال: التصنيف بإشراف، أما تجميع العملاء حسب سلوكهم فهو بدون إشراف.",
      "In supervised learning the data comes with known labels/answers — like cat/dog labels for each image — and the system learns to match them. In unsupervised learning the answers are unknown and the system finds patterns and clusters by itself.\nExample: classification is supervised; grouping customers by behaviour is unsupervised."
    ),
  },
];

const GENERIC_DIFF = T(
  "مقدرش أتأكد من الفرق بين الحاجتين دول من قاعدة معرفتي الحالية. بس أقدر أشرح كل مفهوم لوحده! جرّب «ما هو المتغير؟» أو «ما هي الحلقة؟» — أو اسألني عن مفاهيم البرمجة والذكاء الاصطناعي اللي بدرسها.",
  "I can't confidently explain the difference between those two from my current knowledge base. But I can explain each concept on its own! Try 'What is a variable?' or 'What is a loop?' — or ask me about the programming and AI concepts you study."
);

const DIFFERENCE_PHRASES = [
  "الفرق بين",
  "الفرق",
  "مقارنه بين",
  "مقابل",
  "difference between",
  "difference",
  "compare",
  "between",
  " vs ", // spaced so "vscode" etc. can never trigger it
];

// ---------------------------------------------------------------------------
// Fallback
// ---------------------------------------------------------------------------

const FALLBACK = T(
  "معرفتي الحالية محدودة في النقطة دي — لسه بشتغل بقاعدة معرفة جاهزة ومش متصل بأي ذكاء اصطناعي خارجي. 😊\nاسألني عن المنصة (الكورسات، الدروس، الكويزات، امتحانات الموك، التقدم، الشهادات، الجدول) أو عن مفاهيم: المتغير، الدالة، الحلقة، الشرط، المصفوفة، الخوارزمية، البرمجة، الذكاء الاصطناعي، تعلم الآلة، والشبكات العصبية.",
  "My knowledge is limited on that one — I currently work from a prepared scripted knowledge base and I'm not connected to any external AI. 😊\nAsk me about the platform (courses, lessons, quizzes, mock exams, progress, certificates, scheduler) or about concepts like: variables, functions, loops, conditions, arrays, algorithms, programming, AI, machine learning and neural networks."
);

const MAX_SAFE_INPUT = 500;

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/**
 * Phrase hit: sub-string containment, EXCEPT short single-word phrases
 * (<4 chars, e.g. "hi", "hey") which must match a whole token — otherwise
 * "hi" would match inside "this" and "hey" inside "they".
 */
function containsPhrase(norm: string, phraseNorm: string): boolean {
  if (!phraseNorm) return false;
  const phraseTokens = tokens(phraseNorm);
  if (phraseTokens.length === 1 && phraseTokens[0].length < 4) {
    return tokens(norm).includes(phraseTokens[0]);
  }
  return norm.includes(phraseNorm);
}

/**
 * Keyword hit rules (containment must never create false positives):
 *   - short single token (<4 chars, e.g. "ai", "ml"): exact token match only
 *   - longer single token: containment (allows "كورس" → "كورسات")
 *   - multi-word keyword: full phrase containment
 */
function keywordHits(norm: string, keywordNorm: string): boolean {
  if (!keywordNorm) return false;
  const kwTokens = tokens(keywordNorm);
  if (kwTokens.length === 1) {
    const token = kwTokens[0];
    if (token.length < 4) return tokens(norm).includes(token);
    return norm.includes(token);
  }
  return norm.includes(keywordNorm);
}

function entryScore(norm: string, entry: KnowledgeEntry): number {
  let score = 0;
  for (const phrase of entry.phrases) {
    const p = normalize(phrase);
    if (containsPhrase(norm, p)) score += 8 + Math.min(6, p.length / 4);
  }
  for (const kw of entry.keywords) {
    const k = normalize(kw);
    if (keywordHits(norm, k)) score += 2 + Math.min(3, k.length / 6);
  }
  return score;
}

/**
 * Match a user question to a curated intent.
 *
 * Deterministic rules:
 *   1. normalize(query) once,
 *   2. score every entry (phrase hits strongly, keyword hits weakly),
 *   3. best score wins; ties resolve to the earliest curated entry,
 *   4. score 0 → graceful fallback.
 */
export function match(query: string): KodgyResponse {
  const input = String(query ?? "").slice(0, MAX_SAFE_INPUT);
  const norm = normalize(input);

  if (!norm) {
    return { intent: "fallback", matched: false, score: 0, answer: FALLBACK };
  }

  // Curated difference pairs take precedence when the question asks to compare.
  const wantsDifference = DIFFERENCE_PHRASES.some((p) => norm.includes(normalize(p)));
  if (wantsDifference) {
    for (const pair of DIFF_PAIRS) {
      const hasLeft = pair.left.some((w) => norm.includes(normalize(w)));
      const hasRight = pair.right.some((w) => norm.includes(normalize(w)));
      if (hasLeft && hasRight) {
        return { intent: `edu.difference.${pair.id}`, matched: true, score: 100, answer: pair.answer };
      }
    }
    // Unknown pair: answer with compare-guidance (still graceful, more
    // helpful than the generic fallback for a detected comparison).
    return {
      intent: "edu.difference.generic",
      matched: false,
      score: 1,
      answer: GENERIC_DIFF,
    };
  }

  let best: { entry: KnowledgeEntry; score: number } | null = null;
  for (const entry of ENTRIES) {
    const score = entryScore(norm, entry);
    if (score > 0 && (!best || score > best.score)) {
      best = { entry, score };
    }
  }

  if (best) {
    return {
      intent: best.entry.intent,
      matched: true,
      score: best.score,
      answer: best.entry.answer,
    };
  }

  return { intent: "fallback", matched: false, score: 0, answer: FALLBACK };
}

/** Locale-picked answer for a response (convenience for the controller). */
export function pickAnswer(response: KodgyResponse, locale: KodgyLocale): string {
  return locale === "ar" ? response.answer.ar : response.answer.en;
}

/** Curated starter questions shown in the empty state (bilingual). */
export function suggestedPrompts(locale: KodgyLocale): string[] {
  const prompts: LocalizedText[] = [
    T("إزاي أبدأ أول درس؟", "How do I start my first lesson?"),
    T("فين الكويزات بتاعتي؟", "Where can I find my quizzes?"),
    T("ما هو المتغير؟", "What is a variable?"),
    T("فين الامتحانات التجريبية؟", "Where are the mock exams?"),
  ];
  return prompts.map((p) => (locale === "ar" ? p.ar : p.en));
}

/** Supported intents list — used for docs/tests/diagnostics. */
export function supportedIntents(): string[] {
  return [...new Set(ENTRIES.map((e) => e.intent))];
}
