"use client";

import { useEffect, useState } from "react";

type AIAnalysisStateProps = {
  active: boolean;
  mode?: "init" | "reanalyze";
};

export default function AIAnalysisState({
  active,
  mode = "reanalyze",
}: AIAnalysisStateProps) {
  const [phase, setPhase] = useState<"analyze" | "next">("analyze");

  useEffect(() => {
    if (!active) {
      setPhase("analyze");
      return;
    }
    setPhase("analyze");
    const id = window.setTimeout(() => setPhase("next"), 1800);
    return () => window.clearTimeout(id);
  }, [active, mode]);

  if (!active) return null;

  const isInit = mode === "init";
  const statusText =
    phase === "next"
      ? "Određujem sljedeći dijagnostički korak…"
      : isInit
        ? "Analiziram prijavljeni kvar…"
        : "Analiziram nove dokaze…";

  return (
    <section
      className="hero-card anim-in relative p-5"
      role="status"
      aria-live="polite"
    >
      <div className="relative z-10">
        <p className="text-xs font-semibold tracking-[0.16em] text-[var(--accent)]">
          {isInit
            ? "KREIRAM DIJAGNOSTIČKI SLUČAJ"
            : "ANALIZIRAM NOVE DOKAZE"}
        </p>
        <div className="mt-4 flex items-center gap-3">
          <span className="anim-pulse h-2.5 w-2.5 rounded-full bg-[var(--accent)] shadow-[0_0_16px_var(--accent-glow)]" />
          <p className="text-base font-medium">{statusText}</p>
        </div>
        <p className="mt-2 text-sm text-[var(--muted)]">
          Podaci slučaja su sačuvani.
        </p>
      </div>
    </section>
  );
}
