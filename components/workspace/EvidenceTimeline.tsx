"use client";

import { useState } from "react";
import type { DiagnosticCase, DiagnosticStep, Observation } from "@/lib/diagnosis";
import ResponsiveOverlay from "@/components/ui/ResponsiveOverlay";

type TimelineKind =
  | "PRIJAVA"
  | "PITANJE"
  | "TEST"
  | "REZULTAT"
  | "MJERENJE"
  | "DIJAGNOZA"
  | "AI ANALIZA";

type Item = {
  key: string;
  kind: TimelineKind;
  title: string;
  detail?: string;
  result?: string;
  observation?: Observation;
  step?: DiagnosticStep;
};

function buildItems(c: DiagnosticCase): Item[] {
  const items: Item[] = [
    {
      key: "complaint",
      kind: "PRIJAVA",
      title: c.problemText,
    },
  ];

  for (const step of c.steps) {
    if (step.actionType === "FINISH") {
      items.push({
        key: `${step.id}-dx`,
        kind: "DIJAGNOZA",
        title: step.confirmedFault ?? step.content,
        detail: step.rationale,
        step,
      });
      continue;
    }

    items.push({
      key: `${step.id}-act`,
      kind: step.actionType === "ASK" ? "PITANJE" : "TEST",
      title: step.recommendedTest?.name || step.content,
      detail: step.rationale,
      step,
    });

    const obs = c.observations.find((o) => o.stepId === step.id);
    if (obs) {
      items.push({
        key: `${step.id}-res`,
        kind: step.actionType === "TEST" ? "MJERENJE" : "REZULTAT",
        title: obs.resultText,
        result: obs.resultText,
        observation: obs,
        step,
      });
      items.push({
        key: `${step.id}-ai`,
        kind: "AI ANALIZA",
        title: "Novi dokaz obrađen",
      });
    }
  }
  return items;
}

type EvidenceTimelineProps = {
  diagnosticCase: DiagnosticCase;
};

export default function EvidenceTimeline({
  diagnosticCase,
}: EvidenceTimelineProps) {
  const items = buildItems(diagnosticCase);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [inspect, setInspect] = useState<Item | null>(null);

  return (
    <section className="anim-in">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-medium text-[var(--muted)]">
          Dijagnostički trag
        </h2>
        <span className="text-xs text-[var(--muted)]">
          {diagnosticCase.observations.length} unosa
        </span>
      </div>

      <ol className="surface-2 px-4 py-4">
        {items.map((item, index) => {
          const open = expanded[item.key];
          const isLast = index === items.length - 1;
          return (
            <li key={item.key} className="relative flex gap-3 pb-4 last:pb-0">
              {!isLast && (
                <span className="absolute left-[5px] top-3 h-[calc(100%-6px)] w-px bg-white/10" />
              )}
              <span
                className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${
                  item.result || item.kind === "DIJAGNOZA"
                    ? "bg-[var(--accent)]"
                    : "bg-white/25"
                }`}
              />
              <button
                type="button"
                onClick={() => {
                  setExpanded((s) => ({ ...s, [item.key]: !s[item.key] }));
                  if (item.observation) setInspect(item);
                }}
                className="min-w-0 flex-1 rounded-xl p-1 text-left transition hover:bg-white/5"
              >
                <span className="inline-flex rounded-md border border-[var(--border)] px-2 py-0.5 text-[10px] font-semibold tracking-wide text-[var(--muted-strong)]">
                  {item.kind}
                </span>
                <p
                  className={`mt-1.5 leading-snug ${
                    item.result
                      ? "mono-data text-base font-medium text-[var(--accent)]"
                      : "text-sm text-[var(--muted-strong)]"
                  }`}
                >
                  {item.title}
                </p>
                {open && item.detail && (
                  <p className="mt-1 text-xs text-[var(--muted)]">{item.detail}</p>
                )}
              </button>
            </li>
          );
        })}
      </ol>

      <ResponsiveOverlay
        open={Boolean(inspect)}
        onClose={() => setInspect(null)}
        title="Detalji dokaza"
      >
        {inspect && (
          <dl className="space-y-3 text-sm">
            <Row label="Tip" value={inspect.kind} />
            <Row label="Vrijednost" value={inspect.result || inspect.title} mono />
            <Row label="Izvor" value="Unos tehničara" />
            <Row
              label="Zabilježeno"
              value={
                inspect.observation
                  ? new Date(inspect.observation.recordedAt).toLocaleString("hr-HR")
                  : "—"
              }
            />
            <Row label="Koristi AI" value="Da" />
            <div className="flex gap-2 pt-2">
              <button
                type="button"
                disabled
                className="min-h-11 flex-1 rounded-xl border border-dashed border-[var(--border)] text-sm text-[var(--muted)]"
              >
                Uredi (uskoro)
              </button>
              <button
                type="button"
                disabled
                className="min-h-11 flex-1 rounded-xl border border-dashed border-[var(--border)] text-sm text-[var(--muted)]"
              >
                Označi nepouzdano
              </button>
            </div>
          </dl>
        )}
      </ResponsiveOverlay>
    </section>
  );
}

function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div>
      <dt className="text-xs text-[var(--muted)]">{label}</dt>
      <dd className={`mt-1 ${mono ? "mono-data" : ""}`}>{value}</dd>
    </div>
  );
}
