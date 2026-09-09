import type { DiagnosisCertainty, DiagnosticStep } from "@/lib/diagnosis";

type DiagnosisCompletionProps = {
  step: DiagnosticStep;
  confirmedFault?: string;
  onComplete: () => void;
  onKeepDiagnosing: () => void;
  onReject: () => void;
};

function certaintyLabel(certainty: DiagnosisCertainty | undefined, insufficient?: boolean): {
  text: string;
  tone: "confirmed" | "high" | "likely" | "suspected";
} {
  const c =
    certainty ??
    (insufficient === false ? "HIGH_CONFIDENCE" : "LIKELY");
  switch (c) {
    case "CONFIRMED":
      return { text: "POTVRĐENO", tone: "confirmed" };
    case "HIGH_CONFIDENCE":
      return { text: "VISOKA POUZDANOST", tone: "high" };
    case "SUSPECTED":
      return { text: "SUMNJA", tone: "suspected" };
    case "LIKELY":
    default:
      return { text: "VJEROJATNO", tone: "likely" };
  }
}

export default function DiagnosisCompletion({
  step,
  confirmedFault,
  onComplete,
  onKeepDiagnosing,
  onReject,
}: DiagnosisCompletionProps) {
  const meta = certaintyLabel(step.diagnosisCertainty, step.insufficientEvidence);
  const confirmed = meta.tone === "confirmed";
  const title = confirmedFault ?? step.confirmedFault ?? step.content;
  const evidence = [...(step.evidence ?? []), ...(step.facts ?? [])];
  const pct =
    typeof step.diagnosisConfidence === "number"
      ? step.diagnosisConfidence
      : step.hypotheses
          ?.map((h) => h.confidence)
          .filter((c): c is number => typeof c === "number")
          .sort((a, b) => b - a)[0];

  const shell =
    meta.tone === "confirmed"
      ? "border-[rgba(47,224,181,0.35)] bg-[linear-gradient(180deg,rgba(47,224,181,0.12),rgba(12,17,24,0.96))]"
      : meta.tone === "high"
        ? "border-[rgba(47,224,181,0.25)] bg-[linear-gradient(180deg,rgba(47,224,181,0.08),rgba(12,17,24,0.96))]"
        : "border-[rgba(240,180,41,0.4)] bg-[linear-gradient(180deg,rgba(240,180,41,0.1),rgba(12,17,24,0.96))]";

  const toneColor =
    meta.tone === "confirmed" || meta.tone === "high"
      ? "text-[var(--accent)]"
      : "text-[var(--warning)]";

  return (
    <section
      className={`anim-in rounded-[var(--radius-lg)] border p-4 sm:p-6 ${shell}`}
    >
      <p className="text-xs font-semibold tracking-[0.16em] text-[var(--muted)]">
        DIJAGNOZA
      </p>
      <p className={`mt-2 text-sm font-semibold tracking-wide ${toneColor}`}>
        {meta.text}
        {typeof pct === "number" ? ` — ${pct}%` : ""}
      </p>

      <h2 className="mt-3 text-2xl font-semibold leading-snug tracking-tight">
        {title}
      </h2>

      {!confirmed && (
        <p className="mt-2 text-sm text-[var(--warning)]">
          {meta.tone === "high"
            ? "Visoka pouzdanost prema trenutnim dokazima, ali još nije potvrđeno — alternative nisu potpuno eliminirane ili nedostaje neovisni potvrđujući dokaz."
            : "Potrebna je dodatna potvrda prije zamjene skupih dijelova."}
        </p>
      )}

      {evidence.length > 0 && (
        <div className="mt-5">
          <p className="text-xs tracking-wide text-[var(--muted)]">DOKAZI</p>
          <ul className="mt-2 space-y-2">
            {evidence.map((e) => (
              <li key={e} className="flex gap-2 text-sm text-[var(--muted-strong)]">
                <span className="text-[var(--accent)]">✓</span>
                <span>{e}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {step.hypotheses && step.hypotheses.length > 0 && (
        <div className="mt-5">
          <p className="text-xs tracking-wide text-[var(--muted)]">HIPOTEZE</p>
          <ul className="mt-2 space-y-1.5">
            {step.hypotheses.slice(0, 4).map((h) => (
              <li key={h.label} className="text-sm text-[var(--muted-strong)]">
                {typeof h.confidence === "number" ? `${h.confidence}%` : "—"} ·{" "}
                {h.label}
              </li>
            ))}
          </ul>
        </div>
      )}

      {step.rationale && (
        <div className="mt-5">
          <p className="text-xs tracking-wide text-[var(--muted)]">
            {confirmed ? "RADNJA POPRAVKA" : "ŠTO JOŠ NEDOSTAJE / PREPORUKA"}
          </p>
          <p className="mt-2 text-sm leading-relaxed">{step.rationale}</p>
        </div>
      )}

      <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        {confirmed ? (
          <button
            type="button"
            onClick={onComplete}
            className="min-h-12 rounded-2xl bg-[var(--accent)] px-5 text-sm font-semibold text-[#061018]"
          >
            ZAVRŠI SLUČAJ
          </button>
        ) : (
          <button
            type="button"
            onClick={onComplete}
            className="min-h-12 rounded-2xl border border-[var(--border-strong)] px-5 text-sm"
          >
            ZAVRŠI KAO {meta.text}
          </button>
        )}
        <button
          type="button"
          onClick={onKeepDiagnosing}
          className="min-h-12 rounded-2xl bg-[var(--accent)] px-5 text-sm font-semibold text-[#061018]"
        >
          NASTAVI DIJAGNOSTIKU
        </button>
        <button
          type="button"
          onClick={onReject}
          className="min-h-12 rounded-2xl px-3 text-sm text-[var(--muted)]"
        >
          Dijagnoza ne izgleda točno
        </button>
      </div>
    </section>
  );
}
