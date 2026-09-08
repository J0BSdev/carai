"use client";

import { useEffect, useState } from "react";
import { THINKING_MESSAGES } from "@/lib/diagnosis/ui-helpers";

type AIAnalysisStateProps = {
  active: boolean;
  mode?: "init" | "reanalyze";
};

const INIT_MESSAGES = [
  "Identificiram vozilo…",
  "Strukturiram prijavu…",
  "Pripremam prvi dijagnostički korak…",
] as const;

export default function AIAnalysisState({
  active,
  mode = "reanalyze",
}: AIAnalysisStateProps) {
  const messages = mode === "init" ? INIT_MESSAGES : THINKING_MESSAGES;
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => {
      setIndex((i) => (i + 1) % messages.length);
    }, 1600);
    return () => window.clearInterval(id);
  }, [active, messages.length]);

  if (!active) return null;

  return (
    <section
      className="hero-card anim-in relative p-5"
      role="status"
      aria-live="polite"
    >
      <div className="relative z-10">
        <p className="text-xs font-semibold tracking-[0.16em] text-[var(--accent)]">
          {mode === "init"
            ? "KREIRAM DIJAGNOSTIČKI SLUČAJ"
            : "ANALIZIRAM NOVE DOKAZE"}
        </p>
        <div className="mt-4 flex items-center gap-3">
          <span className="anim-pulse h-2.5 w-2.5 rounded-full bg-[var(--accent)] shadow-[0_0_16px_var(--accent-glow)]" />
          <p className="text-base font-medium">
            {messages[index % messages.length]}
          </p>
        </div>
        <p className="mt-2 text-sm text-[var(--muted)]">
          Podaci slučaja su sačuvani.
        </p>
      </div>
    </section>
  );
}
