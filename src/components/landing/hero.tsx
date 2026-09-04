"use client";

import * as React from "react";
import { motion } from "framer-motion";
import { CodeMindLogo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { GlobalControls } from "@/components/global-controls";
import { getStrings , useT, pickAuto } from "@/lib/i18n";
import { useApp } from "@/lib/store";
import {
  Rocket,
  BookOpen,
  Trophy,
  Users,
  Sparkles,
  ChevronLeft,
  LogIn,
} from "lucide-react";

export function LandingHero() {
  const tr = useT();
  const setView = useApp((s) => s.setView);
  const scrollTo = useApp((s) => s.scrollTo);
  const locale = useApp((s) => s.locale);
  const t = getStrings(locale);

  return (
    <section className="relative overflow-hidden bg-mesh">
      {/* Decorative grid overlay */}
      <div className="absolute inset-0 bg-grid opacity-50 pointer-events-none" />

      {/* Floating decorative blobs */}
      <div className="absolute top-24 -start-16 w-72 h-72 rounded-full bg-primary/20 blur-3xl animate-float" />
      <div className="absolute top-40 end-10 w-80 h-80 rounded-full bg-amber-300/30 blur-3xl animate-float-slow" />
      <div className="absolute bottom-0 start-1/2 -translate-x-1/2 w-[600px] h-72 rounded-full bg-teal-300/20 blur-3xl" />

      {/* Top nav */}
      <LandingNav />

      <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-16 sm:pt-24 pb-24 sm:pb-32">
        <div className="grid lg:grid-cols-12 gap-12 items-center">
          {/* Left: copy */}
          <div className="lg:col-span-7 text-center lg:text-end">
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6 }}
              className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-primary/10 text-primary text-xs font-semibold mb-6"
            >
              <Sparkles className="w-3.5 h-3.5" />
              {tr("landing.001")}</motion.div>

            <motion.h1
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.7, delay: 0.05 }}
              className="text-4xl sm:text-5xl lg:text-6xl font-extrabold tracking-tight leading-[1.1]"
            >
              {tr("landing.002")}<span className="text-gradient">Programming & AI</span>
              <br />
              {tr("landing.003")}</motion.h1>

            <motion.p
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.7, delay: 0.15 }}
              className="mt-6 text-base sm:text-lg text-muted-foreground leading-relaxed max-w-2xl mx-auto lg:mx-0 lg:me-0"
            >
              {tr("landing.004")}</motion.p>

            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.7, delay: 0.25 }}
              className="mt-8 flex flex-wrap items-center justify-center lg:justify-start gap-3"
            >
              <Button
                size="lg"
                onClick={() => setView("register")}
                className="group h-12 px-6 text-base font-bold shadow-lg shadow-primary/25 hover:shadow-xl hover:shadow-primary/40 transition-all glow-pulse shine-on-hover"
              >
                <Rocket className="w-4 h-4 ms-2 group-hover:rotate-12 transition-transform" />
                {t.nav.startJourney}
              </Button>
              <Button
                size="lg"
                variant="outline"
                onClick={() => scrollTo("curriculum")}
                className="h-12 px-6 text-base font-semibold bg-background/60 backdrop-blur-sm shine-on-hover"
              >
                {t.nav.seeCurriculum}
                <ChevronLeft className="w-4 h-4 me-2" />
              </Button>
            </motion.div>

            {/* Stats strip */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.7, delay: 0.35 }}
              className="mt-12 grid grid-cols-3 max-w-md mx-auto lg:mx-0 gap-4"
            >
              <Stat value="+500" label={tr("landing.005")} />
              <Stat value="92%" label="Attendance" />
              <Stat value="4.9★" label={tr("landing.006")} />
            </motion.div>
          </div>

          {/* Right: hero visual */}
          <motion.div
            initial={{ opacity: 0, scale: 0.9, rotate: -2 }}
            animate={{ opacity: 1, scale: 1, rotate: 0 }}
            transition={{ duration: 0.8, delay: 0.2 }}
            className="lg:col-span-5 relative"
          >
            <HeroVisual />
          </motion.div>
        </div>
      </div>

      {/* Soft gradient transition */}
      <div className="absolute bottom-0 start-0 end-0 h-24 bg-gradient-to-t from-background to-transparent" />
    </section>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="text-center lg:text-end">
      <div className="text-2xl sm:text-3xl font-extrabold text-gradient">
        {value}
      </div>
      <div className="text-xs text-muted-foreground mt-1">{label}</div>
    </div>
  );
}

function HeroVisual() {
  const tr = useT();
  return (
    <div className="relative aspect-square max-w-md mx-auto">
      {/* Card stack */}
      <div className="absolute inset-0">
        {/* Background card */}
        <motion.div
          animate={{ y: [0, -8, 0] }}
          transition={{ duration: 6, repeat: Infinity, ease: "easeInOut" }}
          className="absolute top-6 end-6 w-72 glass-strong rounded-3xl p-5 shadow-xl"
        >
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-amber-400/20 flex items-center justify-center">
              <Trophy className="w-5 h-5 text-amber-500" />
            </div>
            <div>
              <div className="text-xs text-muted-foreground">{tr("landing.007")}</div>
              <div className="text-lg font-bold">88%</div>
            </div>
          </div>
          <div className="mt-3 h-2 bg-amber-400/20 rounded-full overflow-hidden">
            <motion.div
              initial={{ width: 0 }}
              animate={{ width: "88%" }}
              transition={{ duration: 1.5, delay: 0.8 }}
              className="h-full bg-gradient-to-r from-amber-400 to-amber-500 rounded-full"
            />
          </div>
        </motion.div>

        {/* Main card */}
        <motion.div
          animate={{ y: [0, 8, 0] }}
          transition={{ duration: 7, repeat: Infinity, ease: "easeInOut" }}
          className="absolute top-24 start-4 w-64 glass-strong rounded-3xl p-5 shadow-2xl"
        >
          <div className="flex items-center justify-between">
            <div className="text-xs text-muted-foreground">Course Progress</div>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-primary/10 text-primary font-bold">
              Part 1
            </span>
          </div>
          <div className="mt-3 flex items-end gap-1">
            <span className="text-4xl font-extrabold text-gradient">68</span>
            <span className="text-sm text-muted-foreground mb-1">%</span>
          </div>
          <div className="mt-3 space-y-1.5">
            {[
              { name: "IT & Society", done: true },
              { name: "Cybersecurity", done: true },
              { name: "Web Apps", done: false },
            ].map((it) => (
              <div key={it.name} className="flex items-center gap-2 text-xs">
                <div
                  className={`w-4 h-4 rounded-full flex items-center justify-center text-[9px] ${
                    it.done
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-muted-foreground"
                  }`}
                >
                  {it.done ? "✓" : "→"}
                </div>
                <span className={it.done ? "" : "text-muted-foreground"}>
                  {it.name}
                </span>
              </div>
            ))}
          </div>
        </motion.div>

        {/* Live session pill */}
        <motion.div
          animate={{ y: [0, -6, 0] }}
          transition={{ duration: 5, repeat: Infinity, ease: "easeInOut" }}
          className="absolute bottom-12 end-8 glass-strong rounded-2xl px-4 py-3 shadow-xl"
        >
          <div className="flex items-center gap-2.5">
            <div className="relative">
              <div className="w-9 h-9 rounded-full bg-red-500/20 flex items-center justify-center">
                <Users className="w-4 h-4 text-red-500" />
              </div>
              <span className="absolute -top-0.5 -end-0.5 w-3 h-3 rounded-full bg-red-500 animate-pulse" />
            </div>
            <div>
              <div className="text-[10px] text-muted-foreground">Live Session</div>
              <div className="text-xs font-bold">{tr("landing.008")}</div>
            </div>
          </div>
        </motion.div>

        {/* Floating lesson pill */}
        <motion.div
          animate={{ y: [0, 10, 0] }}
          transition={{ duration: 8, repeat: Infinity, ease: "easeInOut" }}
          className="absolute bottom-6 start-10 glass-strong rounded-2xl px-3.5 py-2.5 shadow-xl flex items-center gap-2"
        >
          <BookOpen className="w-4 h-4 text-primary" />
          <div className="text-xs">
            <div className="font-bold">{tr("landing.009")}</div>
            <div className="text-[10px] text-muted-foreground">Neural Networks</div>
          </div>
        </motion.div>
      </div>

      {/* Decorative gradient ring */}
      <div className="absolute inset-0 -z-10">
        <div className="w-full h-full rounded-full bg-gradient-to-br from-primary/30 via-amber-400/20 to-teal-400/30 blur-3xl opacity-70" />
      </div>
    </div>
  );
}

function LandingNav() {
  const setView = useApp((s) => s.setView);
  const scrollTo = useApp((s) => s.scrollTo);
  const locale = useApp((s) => s.locale);
  const t = getStrings(locale);

  return (
    <header className="absolute top-0 start-0 end-0 z-30">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-20 gap-2">
          <CodeMindLogo withWordmark size={36} />

          <nav className="hidden md:flex items-center gap-1 text-sm">
            <NavBtn onClick={() => scrollTo("why")}>{t.nav.why}</NavBtn>
            <NavBtn onClick={() => scrollTo("curriculum")}>{t.nav.curriculum}</NavBtn>
            <NavBtn onClick={() => scrollTo("features")}>{t.nav.features}</NavBtn>
            <NavBtn onClick={() => scrollTo("pricing")}>{t.nav.pricing}</NavBtn>
            <NavBtn onClick={() => scrollTo("faq")}>{t.nav.faq}</NavBtn>
          </nav>

          <div className="flex items-center gap-1.5">
            {/* Global theme + language toggles — functional pre-login */}
            <GlobalControls />
            <Button
              variant="ghost"
              size="sm"
              className="px-2 sm:px-3"
              onClick={() => setView("login")}
              aria-label={t.nav.login}
            >
              <span className="hidden sm:inline">{t.nav.login}</span>
              <LogIn className="w-4 h-4 sm:hidden" />
            </Button>
            <Button size="sm" className="font-bold" onClick={() => setView("register")}>
              {t.nav.startFree}
            </Button>
          </div>
        </div>
      </div>
    </header>
  );
}

function NavBtn({
  children,
  onClick,
}: {
  children: React.ReactNode;
  onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="px-3 py-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors font-medium"
    >
      {children}
    </button>
  );
}
