"use client";

type AIAnalysisStateProps = {
  active: boolean;
  mode?: "init" | "reanalyze";
};

export default function AIAnalysisState({
  active,
  mode = "reanalyze",
}: AIAnalysisStateProps) {
  if (!active) return null;

  const isInit = mode === "init";

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
          <p className="text-base font-medium">
            {isInit
              ? "Šaljem prijavu AI dijagnostičaru i čekam prvi korak…"
              : "Šaljem nove dokaze AI dijagnostičaru i čekam sljedeći korak…"}
          </p>
        </div>
        <p className="mt-2 text-sm text-[var(--muted)]">
          Podaci slučaja su sačuvani.
        </p>
      </div>
    </section>
  );
}
