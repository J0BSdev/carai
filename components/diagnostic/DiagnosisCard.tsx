import type { DiagnosticStep } from "@/lib/diagnosis";

type DiagnosisCardProps = {
  step: DiagnosticStep;
  confirmedFault?: string;
  onComplete: () => void;
};

export default function DiagnosisCard({
  step,
  confirmedFault,
  onComplete,
}: DiagnosisCardProps) {
  const confirmed = !step.insufficientEvidence;
  const title = confirmedFault ?? step.confirmedFault ?? step.content;

  const evidenceLines = [...(step.evidence ?? []), ...(step.facts ?? [])];

  return (
    <section
      className={`anim-enter rounded-[var(--radius)] border p-4 sm:p-5 ${
        confirmed
          ? "border-[rgba(46,230,168,0.35)] bg-[linear-gradient(180deg,rgba(46,230,168,0.12),rgba(20,26,34,0.95))]"
          : "border-[rgba(240,180,41,0.35)] bg-[linear-gradient(180deg,rgba(240,180,41,0.1),rgba(20,26,34,0.95))]"
      }`}
    >
      <p
        className={`text-xs font-semibold tracking-[0.16em] ${
          confirmed ? "text-[var(--accent)]" : "text-[var(--amber)]"
        }`}
      >
        {confirmed ? "DIJAGNOZA POTVRĐENA" : "VJEROJATAN UZROK"}
      </p>

      <h2 className="mt-3 text-xl font-semibold leading-snug tracking-tight sm:text-2xl">
        {title}
      </h2>

      {!confirmed && (
        <p className="mt-2 text-sm text-[var(--amber)]">
          Potrebna je dodatna potvrda
        </p>
      )}

      {evidenceLines.length > 0 && (
        <div className="mt-5">
          <p className="text-xs font-medium tracking-wide text-[var(--muted)]">
            Dokazi
          </p>
          <ul className="mt-2 flex flex-col gap-2">
            {evidenceLines.map((line) => (
              <li key={line} className="flex gap-2 text-sm text-[var(--muted-strong)]">
                <span className="text-[var(--accent)]" aria-hidden>
                  ✓
                </span>
                <span>{line}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {step.rationale && (
        <div className="mt-5">
          <p className="text-xs font-medium tracking-wide text-[var(--muted)]">
            Preporučena radnja
          </p>
          <p className="mt-2 text-sm leading-relaxed text-[var(--foreground)]">
            {step.rationale}
          </p>
        </div>
      )}

      <button
        type="button"
        onClick={onComplete}
        className="mt-6 min-h-12 w-full rounded-xl bg-[var(--accent)] px-4 text-base font-semibold text-[#071018] transition active:scale-[0.99] sm:w-auto sm:px-6"
      >
        Završi slučaj
      </button>
    </section>
  );
}
