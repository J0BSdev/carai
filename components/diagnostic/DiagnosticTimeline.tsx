import type { DiagnosticCase, DiagnosticStep } from "@/lib/diagnosis";

type TimelineKind =
  | "PITANJE"
  | "TEST"
  | "REZULTAT"
  | "MJERENJE"
  | "DIJAGNOZA"
  | "AI ANALIZA";

type TimelineItem = {
  key: string;
  kind: TimelineKind;
  title: string;
  body?: string;
  emphasis?: boolean;
};

function buildItems(diagnosticCase: DiagnosticCase): TimelineItem[] {
  const items: TimelineItem[] = [];

  for (const step of diagnosticCase.steps) {
    if (step.actionType === "FINISH") {
      items.push({
        key: `${step.id}-diagnosis`,
        kind: "DIJAGNOZA",
        title: step.confirmedFault ?? step.content,
        body: step.rationale,
        emphasis: true,
      });
      continue;
    }

    items.push({
      key: `${step.id}-action`,
      kind: step.actionType === "ASK" ? "PITANJE" : "TEST",
      title: step.recommendedTest?.name || step.content,
    });

    const obs = diagnosticCase.observations.find((o) => o.stepId === step.id);
    if (obs) {
      const numeric = /^[\d.,\s]+(mA|A|V|%|Ω|bar|°C)?$/i.test(
        obs.resultText.split("·")[0]?.trim() ?? "",
      );
      items.push({
        key: `${step.id}-result`,
        kind: numeric || step.actionType === "TEST" ? "MJERENJE" : "REZULTAT",
        title: obs.resultText,
        emphasis: true,
      });
    }
  }

  return items;
}

function kindColor(kind: TimelineKind): string {
  switch (kind) {
    case "REZULTAT":
    case "MJERENJE":
      return "text-[var(--accent)] border-[var(--accent)]/30 bg-[var(--accent-soft)]";
    case "DIJAGNOZA":
      return "text-[var(--accent-2)] border-[var(--accent-2)]/30 bg-[rgba(61,214,245,0.08)]";
    case "TEST":
      return "text-[var(--amber)] border-[var(--amber)]/30 bg-[var(--amber-soft)]";
    default:
      return "text-[var(--muted-strong)] border-[var(--border-strong)] bg-[rgba(255,255,255,0.03)]";
  }
}

function DiagnosticEvent({
  item,
  isLast,
}: {
  item: TimelineItem;
  isLast: boolean;
}) {
  return (
    <li className="relative flex gap-3 pb-4 last:pb-0">
      {!isLast && (
        <span
          className="absolute left-[5px] top-3 h-[calc(100%-4px)] w-px bg-[rgba(255,255,255,0.1)]"
          aria-hidden
        />
      )}
      <span
        className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${
          item.emphasis ? "bg-[var(--accent)]" : "bg-[rgba(255,255,255,0.28)]"
        }`}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <span
          className={`inline-flex rounded-md border px-2 py-0.5 text-[10px] font-semibold tracking-wide ${kindColor(item.kind)}`}
        >
          {item.kind}
        </span>
        <p
          className={`mt-1.5 leading-snug ${
            item.emphasis
              ? "mono-data text-base font-medium text-[var(--foreground)]"
              : "text-sm text-[var(--muted-strong)]"
          }`}
        >
          {item.title}
        </p>
        {item.body && (
          <p className="mt-1 text-xs leading-relaxed text-[var(--muted)]">
            {item.body}
          </p>
        )}
      </div>
    </li>
  );
}

type DiagnosticTimelineProps = {
  diagnosticCase: DiagnosticCase;
  currentStep?: DiagnosticStep | null;
};

export default function DiagnosticTimeline({
  diagnosticCase,
}: DiagnosticTimelineProps) {
  const items = buildItems(diagnosticCase);
  if (items.length === 0) return null;

  const resultCount = diagnosticCase.observations.length;

  return (
    <section className="anim-enter">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-medium text-[var(--muted)]">
          Dijagnostički trag
        </h2>
        <span className="text-xs text-[var(--muted)]">
          {resultCount}{" "}
          {resultCount === 1
            ? "rezultat"
            : resultCount >= 2 && resultCount <= 4
              ? "rezultata"
              : "rezultata"}
        </span>
      </div>
      <ol className="surface-card px-4 py-4">
        {items.map((item, index) => (
          <DiagnosticEvent
            key={item.key}
            item={item}
            isLast={index === items.length - 1}
          />
        ))}
      </ol>
    </section>
  );
}
