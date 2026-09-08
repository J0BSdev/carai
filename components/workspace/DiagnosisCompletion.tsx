import type { DiagnosticStep } from "@/lib/diagnosis";

type DiagnosisCompletionProps = {
  step: DiagnosticStep;
  confirmedFault?: string;
  onComplete: () => void;
  onKeepDiagnosing: () => void;
  onReject: () => void;
};

export default function DiagnosisCompletion({
  step,
  confirmedFault,
  onComplete,
  onKeepDiagnosing,
  onReject,
}: DiagnosisCompletionProps) {
  const confirmed = !step.insufficientEvidence;
  const title = confirmedFault ?? step.confirmedFault ?? step.content;
  const evidence = [...(step.evidence ?? []), ...(step.facts ?? [])];

  return (
    <section
      className={`anim-in rounded-[var(--radius-lg)] border p-4 sm:p-6 ${
        confirmed
          ? "border-[rgba(47,224,181,0.35)] bg-[linear-gradient(180deg,rgba(47,224,181,0.12),rgba(12,17,24,0.96))]"
          : "border-[rgba(240,180,41,0.4)] bg-[linear-gradient(180deg,rgba(240,180,41,0.1),rgba(12,17,24,0.96))]"
      }`}
    >
      <p className="text-xs font-semibold tracking-[0.16em] text-[var(--muted)]">
        DIJAGNOZA
      </p>
      <p
        className={`mt-2 text-sm font-semibold tracking-wide ${
          confirmed ? "text-[var(--accent)]" : "text-[var(--warning)]"
        }`}
      >
        {confirmed ? "POTVRĐENO" : "VJEROJATAN UZROK · JOŠ NIJE POTVRĐENO"}
      </p>

      <h2 className="mt-3 text-2xl font-semibold leading-snug tracking-tight">
        {title}
      </h2>

      {!confirmed && (
        <p className="mt-2 text-sm text-[var(--warning)]">
          Potrebna je dodatna potvrda prije zamjene skupih dijelova.
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
            onClick={onKeepDiagnosing}
            className="min-h-12 rounded-2xl bg-[var(--accent)] px-5 text-sm font-semibold text-[#061018]"
          >
            NASTAVI TESTIRANJE
          </button>
        )}
        <button
          type="button"
          onClick={onKeepDiagnosing}
          className="min-h-12 rounded-2xl border border-[var(--border-strong)] px-5 text-sm"
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
