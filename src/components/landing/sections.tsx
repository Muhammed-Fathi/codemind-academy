"use client";

import * as React from "react";
import { motion } from "framer-motion";
import {
  Sparkles,
  Video,
  Brain,
  ShieldCheck,
  LineChart,
  Users,
  Bell,
  CreditCard,
  HelpCircle,
  ChevronDown,
  Rocket,
  CheckCircle2,
  Globe,
  Database,
  BarChart3,
  Cpu,
  Palette,
  Shield,
  BookOpen,
  GraduationCap,
  HeartHandshake,
  Star,
  Quote,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { useApp } from "@/lib/store";
import { brand, whatsappLink } from "@/lib/brand";
import { CodeMindLogo } from "@/components/logo";

/* ----------------------------------- WHY ---------------------------------- */
export function WhySection() {
  const items = [
    {
      icon: Video,
      title: "Live Classes حقيقية",
      desc: "حصتين في الأسبوع، تفاعل مباشر مع الـTeacher، وتسجيلات متاحة بعد كل حصة.",
    },
    {
      icon: Brain,
      title: "Programming & AI من الصفر",
      desc: "منهج رسمي للثانوية العامة يبنيك خطوة بخطوة لحد ما توصل للـMachine Learning.",
    },
    {
      icon: ShieldCheck,
      title: "متابعة الأهل",
      desc: "Dashboard مخصص لكل أب/أم يعرف مستوى ابنه، حضوره، وواجباته بشكل دوري.",
    },
    {
      icon: LineChart,
      title: "تتبع التقدم",
      desc: "شوف إنت فين في كل وحدة، تحل Quiz وتشوف نتيجتك فورًا، وتعرف نقاط قوتك وضعفك.",
    },
    {
      icon: Users,
      title: "Groups صغيرة",
      desc: "مجموعات منظمة بـTeacher مختص عشان كل طالب ياخد حقه في المتابعة.",
    },
    {
      icon: Bell,
      title: "Notifications ذكية",
      desc: "تنبيهات قبل الحصص، عند إضافة واجب، أو لما تقرب مدة الاشتراك على الانتهاء.",
    },
  ];
  return (
    <section id="why" className="py-24 sm:py-32 relative">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <SectionHeading
          eyebrow="ليه CodeMind؟"
          title="اللي يخلّي CodeMind مختلفة"
          subtitle="مش مجرد فيديوهات. دي تجربة تعليمية متكاملة معمولة بقلب وعقل."
        />
        <div className="mt-14 grid sm:grid-cols-2 lg:grid-cols-3 gap-5 stagger-in">
          {items.map((it) => (
            <Card
              key={it.title}
              className="card-hover card-lift glass card-lift border-0 shadow-sm overflow-hidden"
            >
              <CardContent className="p-6">
                <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-primary/15 to-amber-400/15 flex items-center justify-center mb-4">
                  <it.icon className="w-6 h-6 text-primary" />
                </div>
                <h3 className="text-lg font-bold mb-2">{it.title}</h3>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  {it.desc}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </section>
  );
}

/* --------------------------------- JOURNEY -------------------------------- */
export function JourneySection() {
  const steps = [
    { num: "01", title: "Register", desc: "اعمل حساب في أقل من دقيقة.", icon: Rocket },
    { num: "02", title: "اختر Group", desc: "اختار المجموعة اللي تناسب جدولك.", icon: Users },
    { num: "03", title: "اشترك", desc: "اختار باقة شهرية أو مخفضة.", icon: CreditCard },
    { num: "04", title: "Admin Approval", desc: "نتأكد من الدفع ونفعل الاشتراك.", icon: ShieldCheck },
    { num: "05", title: "ابدأ تتعلم", desc: "تابع Live Classes، Recordings، Quizzes.", icon: BookOpen },
    { num: "06", title: "اتابع مستواك", desc: "شوف Progress وخطط الباقي.", icon: LineChart },
  ];
  return (
    <section id="journey" className="py-24 sm:py-32 bg-gradient-to-b from-background via-primary/5 to-background">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <SectionHeading
          eyebrow="رحلتك"
          title="إزاي تبدأ — خطوة بخطوة"
          subtitle="من أول ما تعمل حساب لحد ما تخلص الكورس.كل خطوة واضحة."
        />
        <div className="mt-14 grid sm:grid-cols-2 lg:grid-cols-3 gap-5 stagger-in">
          {steps.map((s) => (
            <div
              key={s.num}
              className="relative bg-card rounded-2xl p-6 border border-border/60 shadow-sm card-hover"
            >
              <div className="absolute top-4 left-4 text-5xl font-black text-primary/10 leading-none select-none">
                {s.num}
              </div>
              <div className="relative">
                <div className="w-11 h-11 rounded-xl bg-primary/10 flex items-center justify-center mb-4">
                  <s.icon className="w-5 h-5 text-primary" />
                </div>
                <h3 className="text-base font-bold">{s.title}</h3>
                <p className="text-sm text-muted-foreground mt-1.5 leading-relaxed">
                  {s.desc}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ------------------------------- CURRICULUM ------------------------------- */
export function CurriculumSection() {
  const [activePart, setActivePart] = React.useState(0);

  const parts = [
    {
      titleAr: "الجزء الأول",
      title: "Part One",
      color: "from-emerald-500 to-teal-500",
      units: [
        { name: "Information Technology and Society", icon: Globe, lessons: 4 },
        { name: "Cybersecurity", icon: Shield, lessons: 4 },
        { name: "Web Applications", icon: Globe, lessons: 4 },
        { name: "Web and Media Design", icon: Palette, lessons: 4 },
      ],
    },
    {
      titleAr: "الجزء الثاني",
      title: "Part Two",
      color: "from-amber-500 to-orange-500",
      units: [
        { name: "Data Collection and Cleaning", icon: Database, lessons: 6 },
        { name: "Analysis and Communication", icon: BarChart3, lessons: 6 },
        { name: "Machine Learning and AI", icon: Cpu, lessons: 7 },
      ],
    },
  ];

  return (
    <section id="curriculum" className="py-24 sm:py-32">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <SectionHeading
          eyebrow="المنهج"
          title="كل اللي هتتعلمه"
          subtitle="منهج Programming & AI كامل للثانوية العامة، مقسم على جزئين وكل جزء فيه وحدات واضحة."
        />

        {/* Part toggle */}
        <div className="mt-10 flex justify-center">
          <div className="inline-flex p-1 bg-muted/60 rounded-full">
            {parts.map((p, i) => (
              <button
                key={i}
                onClick={() => setActivePart(i)}
                className={`relative px-6 py-2 text-sm font-bold rounded-full transition-all ${
                  activePart === i
                    ? "bg-background text-foreground shadow"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {p.titleAr} <span className="text-xs opacity-70">({p.title})</span>
              </button>
            ))}
          </div>
        </div>

        {/* Active part units */}
        <motion.div
          key={activePart}
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          className="mt-10 grid sm:grid-cols-2 lg:grid-cols-3 gap-5"
        >
          {parts[activePart].units.map((u, idx) => (
            <Card
              key={u.name}
              className="card-hover card-lift overflow-hidden border-0 shadow-sm glass"
            >
              <div className={`h-1.5 bg-gradient-to-r ${parts[activePart].color}`} />
              <CardContent className="p-6">
                <div className="flex items-start gap-3">
                  <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-primary/15 to-amber-400/15 flex items-center justify-center shrink-0">
                    <u.icon className="w-5 h-5 text-primary" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[10px] text-muted-foreground font-mono">
                      UNIT {String(idx + 1).padStart(2, "0")}
                    </div>
                    <h3 className="font-bold text-base mt-0.5 leading-snug">
                      {u.name}
                    </h3>
                    <div className="mt-2 text-xs text-muted-foreground flex items-center gap-1.5">
                      <BookOpen className="w-3.5 h-3.5" />
                      {u.lessons} Lessons
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </motion.div>
      </div>
    </section>
  );
}

/* -------------------------------- FEATURES -------------------------------- */
export function FeaturesSection() {
  const features = [
    {
      icon: Video,
      title: "Live Sessions أسبوعية",
      desc: "حصتين لايف أسبوعيًا، تسجيلات متاحة بعد كل حصة، حضور وإدارة منظمة.",
    },
    {
      icon: Brain,
      title: "Quizzes أوتوماتيك",
      desc: "اختبارات بعد كل Lesson، تصحيص فوري، شرح للإجابات، ومتابعة متقدمة.",
    },
    {
      icon: BookOpen,
      title: "PDFs & Summaries",
      desc: "ملخصات لكل Lesson، PDFs قابلة للتحميل، ومواد إضافية منظمة.",
    },
    {
      icon: Users,
      title: "Parent Dashboard",
      desc: "الأهل يشوفوا مستوى الطالب، حضوره، واجباته، وتقارير شهرية مفصلة.",
    },
    {
      icon: CreditCard,
      title: "Subscription ذكي",
      desc: "اشتراك شهري، 3 شهور، أو 6 شهور. الـAdmin يفعّل بعد تأكيد الدفع.",
    },
    {
      icon: Bell,
      title: "Notifications مخصصة",
      desc: "تنبيهات قبل الحصص، عند إضافة محتوى جديد، وعند انتهاء الاشتراك.",
    },
  ];

  return (
    <section id="features" className="py-24 sm:py-32 bg-gradient-to-b from-background to-muted/40">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <SectionHeading
          eyebrow="المميزات"
          title="حاجة في كل ركن من المنصة"
          subtitle="الكل شغّال فعلاً — من أول الحصة اللايف لحد ما يوصلك الـReport الشهري."
        />
        <div className="mt-14 grid sm:grid-cols-2 lg:grid-cols-3 gap-5 stagger-in">
          {features.map((f) => (
            <Card
              key={f.title}
              className="card-hover card-lift glass card-lift border-0 shadow-sm overflow-hidden"
            >
              <CardContent className="p-6">
                <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-primary/15 to-amber-400/15 flex items-center justify-center mb-4">
                  <f.icon className="w-6 h-6 text-primary" />
                </div>
                <h3 className="text-lg font-bold mb-2">{f.title}</h3>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  {f.desc}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </section>
  );
}

/* --------------------------------- PARENT --------------------------------- */
export function ParentSection() {
  return (
    <section className="py-24 sm:py-32 relative overflow-hidden">
      <div className="absolute -left-32 top-20 w-96 h-96 rounded-full bg-amber-400/10 blur-3xl" />
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="grid lg:grid-cols-2 gap-12 items-center">
          {/* Copy */}
          <div>
            <Badge variant="secondary" className="mb-4 bg-amber-400/15 text-amber-700 hover:bg-amber-400/20">
              <HeartHandshake className="w-3.5 h-3.5 ml-1.5" />
              للأهل
            </Badge>
            <h2 className="text-3xl sm:text-4xl font-extrabold leading-tight">
              متبقاش قلقان على مستوى ابنك.
              <br />
              <span className="text-gradient">تابع كل حاجة من مكان واحد.</span>
            </h2>
            <p className="mt-5 text-muted-foreground leading-relaxed">
              Parent Dashboard مخصوص بيخلّي الأهل على اطلاع دائم: مستوى التقدم، Attendance،
              نتائج الـQuizzes والـHomework، وملاحظات الـTeacher — كله بشكل مبسط وواضح.
            </p>
            <ul className="mt-6 space-y-3">
              {[
                "تقارير شهرية مفصلة",
                "Attendance ونقاط القوة والضعف",
                "تنبيهات قبل الحصص والامتحانات",
                "تتبع التحصيل الشهري",
              ].map((it) => (
                <li key={it} className="flex items-center gap-2 text-sm">
                  <CheckCircle2 className="w-4 h-4 text-primary shrink-0" />
                  {it}
                </li>
              ))}
            </ul>
          </div>

          {/* Visual */}
          <div className="relative">
            <div className="absolute inset-0 -z-10 bg-gradient-to-br from-primary/20 via-amber-400/15 to-teal-400/20 blur-3xl rounded-[3rem]" />
            <Card className="glass-strong border-0 shadow-2xl rounded-3xl overflow-hidden">
              <CardContent className="p-6">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-2">
                    <div className="w-9 h-9 rounded-full bg-gradient-to-br from-primary to-amber-400 flex items-center justify-center text-white text-xs font-bold">
                      AH
                    </div>
                    <div>
                      <div className="text-sm font-bold">Ahmed Hassan</div>
                      <div className="text-[10px] text-muted-foreground">2nd Secondary · Group A</div>
                    </div>
                  </div>
                  <Badge className="bg-primary/10 text-primary hover:bg-primary/15">
                    Active
                  </Badge>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <MiniStat label="Course Progress" value="68%" tone="primary" />
                  <MiniStat label="Attendance" value="92%" tone="amber" />
                  <MiniStat label="آخر Quiz" value="88%" tone="primary" />
                  <MiniStat label="Homework" value="3/4" tone="amber" />
                </div>

                <div className="mt-4 rounded-2xl bg-muted/50 p-4">
                  <div className="text-xs font-semibold mb-2">Performance Trend</div>
                  <div className="flex items-end gap-1.5 h-16">
                    {[40, 55, 50, 68, 75, 88].map((v, i) => (
                      <motion.div
                        key={i}
                        initial={{ height: 0 }}
                        whileInView={{ height: `${v}%` }}
                        viewport={{ once: true }}
                        transition={{ delay: i * 0.1, duration: 0.5 }}
                        className="flex-1 bg-gradient-to-t from-primary to-amber-400 rounded-t-md"
                      />
                    ))}
                  </div>
                </div>

                <div className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
                  <Sparkles className="w-3.5 h-3.5 text-amber-500" />
                  Monthly Report جاهز للتحميل
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </section>
  );
}

function MiniStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "primary" | "amber";
}) {
  return (
    <div className="rounded-xl bg-background/70 border border-border/40 p-3">
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div
        className={`text-xl font-extrabold mt-0.5 ${
          tone === "primary" ? "text-primary" : "text-amber-600"
        }`}
      >
        {value}
      </div>
    </div>
  );
}

/* --------------------------------- PRICING -------------------------------- */
export function PricingSection() {
  const setView = useApp((s) => s.setView);

  const plans = [
    {
      name: "Early Bird",
      nameAr: "Early Bird",
      price: 100,
      duration: "شهر",
      desc: "لفترة محدودة — استفيد من العرض.",
      features: ["Live Classes", "Recordings", "Quizzes", "PDFs"],
      highlight: false,
      promo: true,
    },
    {
      name: "Monthly",
      nameAr: "شهري",
      price: 200,
      duration: "/شهر",
      desc: "الأنسب للتجربة.",
      features: [
        "كل مميزات Early Bird",
        "Homework + Grading",
        "Parent Dashboard",
        "Monthly Report",
      ],
      highlight: true,
    },
    {
      name: "6 Months",
      nameAr: "6 شهور",
      price: 1000,
      duration: "/6 شهور",
      desc: "وفّر 16% مع الباقة الفصلية.",
      features: [
        "كل مميزات الشهري",
        "تقارير شهرية مفصلة",
        "أولوية في Support",
        "Mock Exams",
      ],
      highlight: false,
    },
  ];

  return (
    <section id="pricing" className="py-24 sm:py-32 bg-gradient-to-b from-muted/40 to-background">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <SectionHeading
          eyebrow="الأسعار"
          title="باقة تناسب كل واحد"
          subtitle="ابدأ بـ Early Bird، أو اطلع باقة شهرية/فصلية.كلها قابلة للإلغاء في أي وقت."
        />
        <div className="mt-14 grid md:grid-cols-3 gap-6 items-stretch">
          {plans.map((p) => (
            <Card
              key={p.name}
              className={`relative flex flex-col overflow-hidden transition-all ${
                p.highlight
                  ? "border-primary/30 shadow-xl shadow-primary/10 md:-translate-y-2"
                  : "border-0 glass shadow-sm"
              }`}
            >
              {p.highlight && (
                <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-primary via-teal-500 to-amber-400" />
              )}
              {p.promo && (
                <Badge className="absolute top-3 left-4 bg-amber-500 hover:bg-amber-500 text-white shadow-md">
                  <Star className="w-3 h-3 ml-1 fill-white" />
                  Limited Offer
                </Badge>
              )}
              <CardContent className="p-6 flex flex-col flex-1">
                <div className="mb-4">
                  <h3 className="text-lg font-bold">{p.nameAr}</h3>
                  <p className="text-xs text-muted-foreground mt-1">{p.desc}</p>
                </div>
                <div className="flex items-end gap-1.5 mb-5">
                  <span className="text-4xl font-extrabold">{p.price}</span>
                  <span className="text-sm text-muted-foreground mb-1.5">EGP</span>
                  <span className="text-xs text-muted-foreground mb-1.5">{p.duration}</span>
                </div>
                <ul className="space-y-2.5 flex-1">
                  {p.features.map((f) => (
                    <li key={f} className="flex items-start gap-2 text-sm">
                      <CheckCircle2 className="w-4 h-4 text-primary shrink-0 mt-0.5" />
                      <span>{f}</span>
                    </li>
                  ))}
                </ul>
                <Button
                  className="mt-6 w-full font-bold"
                  variant={p.highlight ? "default" : "outline"}
                  onClick={() => setView("register")}
                >
                  ابدأ دلوقتي
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
        <p className="text-center text-xs text-muted-foreground mt-6">
          الأسعار شاملة للـVAT. طرق الدفع: InstaPay ({brand.payments.instapay}) · e&
          Cash ({brand.payments.eCash}) · Vodafone Cash (قريبًا)
        </p>
      </div>
    </section>
  );
}

/* ---------------------------------- FAQ ----------------------------------- */
export function FaqSection() {
  const faqs = [
    {
      q: "المنصة دي لمين؟",
      a: "لطلاب الصف الثاني الثانوي اللي عايزين يتعلموا Programming & AI بطريقة منظمة. الأهل كمان معاهم Dashboard خاص لمتابعة الأبناء.",
    },
    {
      q: "إزاي بدأ؟",
      a: "تعمل حساب، تختار Group، تشترك، تدفع عن طريق InstaPay أو e& Cash على +20 1147422177، وبعد ما الـAdmin يؤكد الدفع يتفعل اشتراكك خلال 24 ساعة.",
    },
    {
      q: "في Recordings بعد كل Live Session؟",
      a: "أيوا. كل حصة بتتسجل تلقائيًا، و Recording بيكون متاح لكل المشتركين النشطين.",
    },
    {
      q: "أقدر أشوف المستوى بتاعي إزاي؟",
      a: "في Dashboard هتلاقي Course Progress، Attendance، نتائج Quizzes، Homework، وتقارير شهرية. والأهل يقدروا يشوفوا اللي بيعملوه.",
    },
    {
      q: "إيه طرق الدفع؟",
      a: "InstaPay و e& Cash على +20 1147422177 (تحويل يدوي وتبعت الـReference، والـAdmin يفعّل اشتراكك). Vodafone Cash قريبًا.",
    },
    {
      q: "لو اشتراكي خلص إيه اللي بيحصل؟",
      a: "حسابك بيفضل موجود، لكن المحتوى التعليمي بيتقفل لحد ما تجدد الاشتراك. تقدر تجدد في أي وقت من الـDashboard.",
    },
  ];
  return (
    <section id="faq" className="py-24 sm:py-32">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
        <SectionHeading
          eyebrow="الأسئلة الشائعة"
          title="كل اللي محتاج تعرفه"
          subtitle="لو سؤالك مش هنا، تواصل معانا على WhatsApp."
        />
        <Accordion type="single" collapsible className="mt-12 space-y-3">
          {faqs.map((f, i) => (
            <AccordionItem
              key={i}
              value={`item-${i}`}
              className="border-0 bg-card rounded-2xl px-5 shadow-sm border border-border/40"
            >
              <AccordionTrigger className="text-right font-bold hover:no-underline">
                <div className="flex items-center gap-3 flex-1">
                  <HelpCircle className="w-4 h-4 text-primary shrink-0" />
                  {f.q}
                </div>
              </AccordionTrigger>
              <AccordionContent className="text-muted-foreground leading-relaxed pt-2 pb-4">
                {f.a}
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </div>
    </section>
  );
}

/* ------------------------------- TESTIMONIAL ------------------------------ */
export function TestimonialSection() {
  const items = [
    {
      name: "Mariam A.",
      role: "طالبة 2nd Secondary",
      content:
        "أخيراً منصة عربية محترمة تشرح الـMachine Learning بشكل بسيط. الـLive Sessions مريحة والـQuizzes بتثبت المعلومة.",
      rating: 5,
    },
    {
      name: "Mr. Adel",
      role: "أب طالب",
      content:
        "بقدر أشوف مستوى ابني كل أسبوع من غير ما أسأل. الـDashboard واضح والتقارير الشهرية ممتازة.",
      rating: 5,
    },
    {
      name: "Youssef M.",
      role: "طالبة 2nd Secondary",
      content:
        "الـRecordings بتنقذني كتير لما بفوت حصة. الـPDFs والـSummaries بترجعلي المعلومة بسرعة.",
      rating: 5,
    },
  ];
  return (
    <section className="py-24 sm:py-32 bg-gradient-to-b from-background via-muted/30 to-background">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <SectionHeading
          eyebrow="آراء"
          title="طلابنا وأهلهم بيقولوا إيه"
          subtitle="ثقة الناس هي أكبر نجاح لينا."
        />
        <div className="mt-14 grid md:grid-cols-3 gap-6 stagger-in">
          {items.map((t) => (
            <Card key={t.name} className="card-hover card-lift border-0 glass shadow-sm">
              <CardContent className="p-6">
                <Quote className="w-7 h-7 text-primary/30 mb-3" />
                <p className="text-sm leading-relaxed">{t.content}</p>
                <div className="mt-5 flex items-center gap-3">
                  <div className="w-9 h-9 rounded-full bg-gradient-to-br from-primary to-amber-400 text-white text-xs font-bold flex items-center justify-center">
                    {t.name.slice(0, 2).toUpperCase()}
                  </div>
                  <div>
                    <div className="text-sm font-bold">{t.name}</div>
                    <div className="text-[11px] text-muted-foreground">{t.role}</div>
                  </div>
                  <div className="ml-auto flex">
                    {Array.from({ length: t.rating }).map((_, i) => (
                      <Star key={i} className="w-3.5 h-3.5 text-amber-500 fill-amber-500" />
                    ))}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </section>
  );
}

/* --------------------------------- FINAL CTA ------------------------------ */
export function FinalCtaSection() {
  const setView = useApp((s) => s.setView);
  return (
    <section className="py-24 sm:py-32 relative overflow-hidden">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="relative rounded-[2.5rem] overflow-hidden p-10 sm:p-16 bg-gradient-to-br from-primary via-teal-500 to-amber-500 text-white shadow-2xl">
          <div className="absolute inset-0 bg-grid opacity-20" />
          <div className="absolute -top-20 -right-20 w-80 h-80 rounded-full bg-white/10 blur-3xl" />
          <div className="absolute -bottom-20 -left-20 w-80 h-80 rounded-full bg-white/10 blur-3xl" />
          <div className="relative text-center">
            <GraduationCap className="w-12 h-12 mx-auto mb-4" />
            <h2 className="text-3xl sm:text-4xl font-extrabold leading-tight">
              جاهز تبدأ رحلتك في Programming & AI؟
            </h2>
            <p className="mt-4 text-white/90 max-w-xl mx-auto">
              انضم لأكثر من 500 طالب بيدرسوا بطريقة منظمة وممتعة. أول Lesson مجانية!
            </p>
            <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
              <Button
                size="lg"
                onClick={() => setView("register")}
                className="bg-white text-primary hover:bg-white/90 h-12 px-7 text-base font-bold"
              >
                <Rocket className="w-4 h-4 ml-2" />
                ابدأ مجاناً
              </Button>
              <a
                href={whatsappLink(brand.whatsapp.subscription, "السلام عليكم، عايز أعرف أكتر عن CodeMind")}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center h-12 px-6 rounded-full bg-white/10 hover:bg-white/15 backdrop-blur-sm text-white text-sm font-bold transition-colors"
              >
                اسأل على WhatsApp
              </a>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ---------------------------------- FOOTER -------------------------------- */
export function Footer() {
  const setView = useApp((s) => s.setView);
  return (
    <footer className="border-t bg-card mt-auto">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="grid md:grid-cols-4 gap-8">
          <div className="md:col-span-2">
            <CodeMindLogo withWordmark size={32} />
            <p className="mt-4 text-sm text-muted-foreground leading-relaxed max-w-md">
              {brand.description}
            </p>
            <div className="mt-4 text-xs text-muted-foreground">
              {brand.academicYear}
            </div>
          </div>

          <div>
            <h4 className="font-bold mb-3 text-sm">المنصة</h4>
            <ul className="space-y-2 text-sm text-muted-foreground">
              <li><button className="hover:text-foreground" onClick={() => setView("login")}>تسجيل الدخول</button></li>
              <li><button className="hover:text-foreground" onClick={() => setView("register")}>إنشاء حساب</button></li>
              <li><button className="hover:text-foreground" onClick={() => useApp.getState().scrollTo("pricing")}>الأسعار</button></li>
              <li><button className="hover:text-foreground" onClick={() => useApp.getState().scrollTo("curriculum")}>المنهج</button></li>
            </ul>
          </div>

          <div>
            <h4 className="font-bold mb-3 text-sm">تواصل معانا</h4>
            <ul className="space-y-2 text-sm text-muted-foreground">
              <li>
                <a
                  href={whatsappLink(brand.whatsapp.technical)}
                  target="_blank"
                  rel="noreferrer"
                  className="hover:text-foreground inline-flex items-center gap-1.5"
                >
                  <Bell className="w-3.5 h-3.5" />
                  Technical Support
                </a>
              </li>
              <li>
                <a
                  href={whatsappLink(brand.whatsapp.teacher)}
                  target="_blank"
                  rel="noreferrer"
                  className="hover:text-foreground inline-flex items-center gap-1.5"
                >
                  <GraduationCap className="w-3.5 h-3.5" />
                  اسأل الـTeacher
                </a>
              </li>
              <li>
                <a
                  href={whatsappLink(brand.whatsapp.subscription)}
                  target="_blank"
                  rel="noreferrer"
                  className="hover:text-foreground inline-flex items-center gap-1.5"
                >
                  <CreditCard className="w-3.5 h-3.5" />
                  Subscription Support
                </a>
              </li>
              <li dir="ltr" className="text-left">
                <a
                  href={`tel:${brand.contact.phone.replace(/[^+0-9]/g, "")}`}
                  className="hover:text-foreground font-bold"
                >
                  {brand.contact.phone}
                </a>
              </li>
            </ul>
          </div>
        </div>

        <div className="mt-10 pt-6 border-t flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-muted-foreground">
          <div>© {new Date().getFullYear()} {brand.name}. كل الحقوق محفوظة.</div>
          <div className="flex items-center gap-3">
            <span className="px-2 py-1 rounded-md bg-muted/50">Make it Beautiful.</span>
            <span className="px-2 py-1 rounded-md bg-muted/50">Make it Fast.</span>
            <span className="px-2 py-1 rounded-md bg-muted/50">Make it Work.</span>
          </div>
        </div>
      </div>
    </footer>
  );
}

/* ------------------------------- SHARED PARTS ------------------------------ */
export function SectionHeading({
  eyebrow,
  title,
  subtitle,
}: {
  eyebrow?: string;
  title: string;
  subtitle?: string;
}) {
  return (
    <div className="text-center max-w-2xl mx-auto">
      {eyebrow && (
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary/10 text-primary text-xs font-semibold mb-3">
          <Sparkles className="w-3 h-3" />
          {eyebrow}
        </div>
      )}
      <h2 className="text-3xl sm:text-4xl font-extrabold tracking-tight leading-tight">
        {title}
      </h2>
      {subtitle && (
        <p className="mt-4 text-muted-foreground leading-relaxed">{subtitle}</p>
      )}
    </div>
  );
}
