"use client";
import { useT, useLocale, pickAuto } from "@/lib/i18n";

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
  const tr = useT();
  const items = [
    {
      icon: Video,
      title: tr("landing.010"),
      desc: tr("landing.011"),
    },
    {
      icon: Brain,
      title: tr("landing.012"),
      desc: tr("landing.013"),
    },
    {
      icon: ShieldCheck,
      title: tr("landing.014"),
      desc: tr("landing.015"),
    },
    {
      icon: LineChart,
      title: tr("landing.016"),
      desc: tr("landing.017"),
    },
    {
      icon: Users,
      title: tr("landing.018"),
      desc: tr("landing.019"),
    },
    {
      icon: Bell,
      title: tr("landing.020"),
      desc: tr("landing.021"),
    },
  ];
  return (
    <section id="why" className="py-24 sm:py-32 relative">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <SectionHeading
          eyebrow={tr("landing.022")}
          title={tr("landing.023")}
          subtitle={tr("landing.024")}
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
  const tr = useT();
  const steps = [
    { num: "01", title: tr("landing.200"), desc: tr("landing.025"), icon: Rocket },
    { num: "02", title: tr("landing.026"), desc: tr("landing.027"), icon: Users },
    { num: "03", title: tr("landing.028"), desc: tr("landing.029"), icon: CreditCard },
    { num: "04", title: tr("landing.201"), desc: tr("landing.030"), icon: ShieldCheck },
    { num: "05", title: tr("landing.031"), desc: tr("landing.032"), icon: BookOpen },
    { num: "06", title: tr("landing.033"), desc: tr("landing.034"), icon: LineChart },
  ];
  return (
    <section id="journey" className="py-24 sm:py-32 bg-gradient-to-b from-background via-primary/5 to-background">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <SectionHeading
          eyebrow={tr("landing.035")}
          title={tr("landing.036")}
          subtitle={tr("landing.037")}
        />
        <div className="mt-14 grid sm:grid-cols-2 lg:grid-cols-3 gap-5 stagger-in">
          {steps.map((s) => (
            // The step number used to be absolutely positioned on top of the
            // icon, which overlapped it in both AR and EN. It is now a sibling
            // in a flex row: the icon and the number can never collide at any
            // breakpoint, and `start/end` logical properties keep the order
            // correct in RTL and LTR.
            <div
              key={s.num}
              className="bg-card rounded-2xl p-6 border border-border/60 shadow-sm card-hover flex flex-col"
            >
              <div className="flex items-start justify-between gap-3 mb-4">
                <div className="w-11 h-11 shrink-0 rounded-xl bg-primary/10 flex items-center justify-center">
                  <s.icon className="w-5 h-5 text-primary" />
                </div>
                <span
                  aria-hidden="true"
                  className="shrink-0 text-3xl sm:text-4xl font-black text-primary/15 leading-none select-none tabular-nums"
                >
                  {s.num}
                </span>
              </div>
              <div>
                <h3 className="text-base font-bold">
                  <span className="sr-only">{`${tr("landing.035")} ${s.num}: `}</span>
                  {s.title}
                </h3>
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
  const tr = useT();
  const locale = useLocale();
  const [activePart, setActivePart] = React.useState(0);

  const parts = [
    {
      titleAr: tr("landing.038"),
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
      titleAr: tr("landing.039"),
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
          eyebrow={tr("landing.040")}
          title={tr("landing.041")}
          subtitle={tr("landing.042")}
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
                {pickAuto(p.titleAr, p.title)}{locale === "ar" && <span className="text-xs opacity-70"> ({p.title})</span>}
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
  const tr = useT();
  const features = [
    {
      icon: Video,
      title: tr("landing.043"),
      desc: tr("landing.044"),
    },
    {
      icon: Brain,
      title: tr("landing.045"),
      desc: tr("landing.046"),
    },
    {
      icon: BookOpen,
      title: "PDFs & Summaries",
      desc: tr("landing.047"),
    },
    {
      icon: Users,
      title: "Parent Dashboard",
      desc: tr("landing.048"),
    },
    {
      icon: CreditCard,
      title: tr("landing.049"),
      desc: tr("landing.050"),
    },
    {
      icon: Bell,
      title: tr("landing.051"),
      desc: tr("landing.052"),
    },
  ];

  return (
    <section id="features" className="py-24 sm:py-32 bg-gradient-to-b from-background to-muted/40">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <SectionHeading
          eyebrow={tr("landing.053")}
          title={tr("landing.054")}
          subtitle={tr("landing.055")}
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
  const tr = useT();
  return (
    <section className="py-24 sm:py-32 relative overflow-hidden">
      <div className="absolute -start-32 top-20 w-96 h-96 rounded-full bg-amber-400/10 blur-3xl" />
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="grid lg:grid-cols-2 gap-12 items-center">
          {/* Copy */}
          <div>
            <Badge variant="secondary" className="mb-4 bg-amber-400/15 text-amber-700 hover:bg-amber-400/20">
              <HeartHandshake className="w-3.5 h-3.5 ms-1.5" />
              {tr("landing.056")}</Badge>
            <h2 className="text-3xl sm:text-4xl font-extrabold leading-tight">
              {tr("landing.057")}<br />
              <span className="text-gradient">{tr("landing.058")}</span>
            </h2>
            <p className="mt-5 text-muted-foreground leading-relaxed">
              {tr("landing.059")}</p>
            <ul className="mt-6 space-y-3">
              {[
                tr("landing.060"),
                tr("landing.061"),
                tr("landing.062"),
                tr("landing.063"),
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
                  <MiniStat label={tr("landing.064")} value="88%" tone="primary" />
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
                  {tr("landing.065")}</div>
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
  const tr = useT();
  const setView = useApp((s) => s.setView);

  const plans = [
    {
      name: "Early Bird",
      nameAr: "Early Bird",
      price: 100,
      duration: tr("landing.066"),
      desc: tr("landing.067"),
      features: ["Live Classes", "Recordings", "Quizzes", "PDFs"],
      highlight: false,
      promo: true,
    },
    {
      name: "Monthly",
      nameAr: tr("landing.068"),
      price: 200,
      duration: tr("landing.069"),
      desc: tr("landing.070"),
      features: [
        tr("landing.071"),
        "Homework + Grading",
        "Parent Dashboard",
        "Monthly Report",
      ],
      highlight: true,
    },
    {
      name: "6 Months",
      nameAr: tr("landing.072"),
      price: 1000,
      duration: tr("landing.073"),
      desc: tr("landing.074"),
      features: [
        tr("landing.075"),
        tr("landing.060"),
        tr("landing.077"),
        "Mock Exams",
      ],
      highlight: false,
    },
  ];

  return (
    <section id="pricing" className="py-24 sm:py-32 bg-gradient-to-b from-muted/40 to-background">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <SectionHeading
          eyebrow={tr("landing.078")}
          title={tr("landing.079")}
          subtitle={tr("landing.080")}
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
                <div className="absolute top-0 start-0 end-0 h-1 bg-gradient-to-r from-primary via-teal-500 to-amber-400" />
              )}
              {p.promo && (
                <Badge className="absolute top-3 start-4 bg-amber-500 hover:bg-amber-500 text-white shadow-md">
                  <Star className="w-3 h-3 ms-1 fill-white" />
                  Limited Offer
                </Badge>
              )}
              <CardContent className="p-6 flex flex-col flex-1">
                <div className="mb-4">
                  <h3 className="text-lg font-bold">{pickAuto(p.nameAr, p.name)}</h3>
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
                  {tr("landing.081")}</Button>
              </CardContent>
            </Card>
          ))}
        </div>
        <p className="text-center text-xs text-muted-foreground mt-6">
          {tr("landing.082")}{brand.payments.instapay}) · e&
          Cash ({brand.payments.eCash}{tr("landing.083")}</p>
      </div>
    </section>
  );
}

/* ---------------------------------- FAQ ----------------------------------- */
export function FaqSection() {
  const tr = useT();
  const faqs = [
    {
      q: tr("landing.084"),
      a: tr("landing.085"),
    },
    {
      q: tr("landing.086"),
      a: tr("landing.087"),
    },
    {
      q: tr("landing.088"),
      a: tr("landing.089"),
    },
    {
      q: tr("landing.090"),
      a: tr("landing.091"),
    },
    {
      q: tr("landing.092"),
      a: tr("landing.093"),
    },
    {
      q: tr("landing.094"),
      a: tr("landing.095"),
    },
  ];
  return (
    <section id="faq" className="py-24 sm:py-32">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
        <SectionHeading
          eyebrow={tr("landing.096")}
          title={tr("landing.097")}
          subtitle={tr("landing.098")}
        />
        <Accordion type="single" collapsible className="mt-12 space-y-3">
          {faqs.map((f, i) => (
            <AccordionItem
              key={i}
              value={`item-${i}`}
              className="border-0 bg-card rounded-2xl px-5 shadow-sm border border-border/40"
            >
              <AccordionTrigger className="text-end font-bold hover:no-underline">
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
  const tr = useT();
  const items = [
    {
      name: "Mariam A.",
      role: tr("landing.099"),
      content:
        tr("landing.100"),
      rating: 5,
    },
    {
      name: "Mr. Adel",
      role: tr("landing.101"),
      content:
        tr("landing.102"),
      rating: 5,
    },
    {
      name: "Youssef M.",
      role: tr("landing.099"),
      content:
        tr("landing.104"),
      rating: 5,
    },
  ];
  return (
    <section className="py-24 sm:py-32 bg-gradient-to-b from-background via-muted/30 to-background">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <SectionHeading
          eyebrow={tr("landing.105")}
          title={tr("landing.106")}
          subtitle={tr("landing.107")}
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
                  <div className="ms-auto flex">
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
  const tr = useT();
  const setView = useApp((s) => s.setView);
  return (
    <section className="py-24 sm:py-32 relative overflow-hidden">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="relative rounded-[2.5rem] overflow-hidden p-10 sm:p-16 bg-gradient-to-br from-primary via-teal-500 to-amber-500 text-white shadow-2xl">
          <div className="absolute inset-0 bg-grid opacity-20" />
          <div className="absolute -top-20 -end-20 w-80 h-80 rounded-full bg-white/10 blur-3xl" />
          <div className="absolute -bottom-20 -start-20 w-80 h-80 rounded-full bg-white/10 blur-3xl" />
          <div className="relative text-center">
            <GraduationCap className="w-12 h-12 mx-auto mb-4" />
            <h2 className="text-3xl sm:text-4xl font-extrabold leading-tight">
              {tr("landing.108")}</h2>
            <p className="mt-4 text-white/90 max-w-xl mx-auto">
              {tr("landing.109")}</p>
            <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
              <Button
                size="lg"
                onClick={() => setView("register")}
                className="bg-white text-primary hover:bg-white/90 h-12 px-7 text-base font-bold"
              >
                <Rocket className="w-4 h-4 ms-2" />
                {tr("landing.110")}</Button>
              <a
                href={whatsappLink(brand.whatsapp.subscription, tr("landing.111"))}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center h-12 px-6 rounded-full bg-white/10 hover:bg-white/15 backdrop-blur-sm text-white text-sm font-bold transition-colors"
              >
                {tr("landing.112")}</a>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ---------------------------------- FOOTER -------------------------------- */
export function Footer() {
  const tr = useT();
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
            <h4 className="font-bold mb-3 text-sm">{tr("landing.113")}</h4>
            <ul className="space-y-2 text-sm text-muted-foreground">
              <li><button className="hover:text-foreground" onClick={() => setView("login")}>{tr("landing.114")}</button></li>
              <li><button className="hover:text-foreground" onClick={() => setView("register")}>{tr("landing.115")}</button></li>
              <li><button className="hover:text-foreground" onClick={() => useApp.getState().scrollTo("pricing")}>{tr("landing.078")}</button></li>
              <li><button className="hover:text-foreground" onClick={() => useApp.getState().scrollTo("curriculum")}>{tr("landing.040")}</button></li>
            </ul>
          </div>

          <div>
            <h4 className="font-bold mb-3 text-sm">{tr("landing.118")}</h4>
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
                  {tr("landing.119")}</a>
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
              <li dir="ltr" className="text-start">
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
          <div>© {new Date().getFullYear()} {brand.name}{tr("landing.120")}</div>
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
