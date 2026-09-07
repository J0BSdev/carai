"use client";

import { useState } from "react";
import type {
  DiagnoseResponse,
  DiagnosticCase,
  DiagnosticStep,
} from "@/lib/diagnosis";

type Phase = "intake" | "active" | "completed";

export default function DiagnosticScreen() {
  const [phase, setPhase] = useState<Phase>("intake");
  const [problemText, setProblemText] = useState("");
  const [resultText, setResultText] = useState("");
  const [diagnosticCase, setDiagnosticCase] = useState<DiagnosticCase | null>(
    null,
  );
  const [nextStep, setNextStep] = useState<DiagnosticStep | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function resetCase() {
    setPhase("intake");
    setProblemText("");
    setResultText("");
    setDiagnosticCase(null);
    setNextStep(null);
    setMessage(null);
    setError(null);
    setLoading(false);
  }

  async function callDiagnose(body: unknown): Promise<DiagnoseResponse> {
    const response = await fetch("/api/diagnose", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(
        typeof data.error === "string" ? data.error : "Zahtjev nije uspio",
      );
    }
    return data as DiagnoseResponse;
  }

  async function handleStart() {
    setError(null);
    setLoading(true);
    try {
      const data = await callDiagnose({
        action: "start",
        problemText,
      });
      setDiagnosticCase(data.case);
      setNextStep(data.nextStep);
      setMessage(data.message ?? null);
      setResultText("");
      setPhase(data.case.status === "completed" ? "completed" : "active");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Nije moguće pokrenuti dijagnozu",
      );
    } finally {
      setLoading(false);
    }
  }

  async function handleContinue() {
    if (!diagnosticCase) return;
    setError(null);
    setLoading(true);
    try {
      const data = await callDiagnose({
        action: "continue",
        case: diagnosticCase,
        observation: { resultText },
      });
      setDiagnosticCase(data.case);
      setNextStep(data.nextStep);
      setMessage(data.message ?? null);
      setResultText("");
      setPhase(data.case.status === "completed" ? "completed" : "active");
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Nije moguće nastaviti dijagnozu",
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-lg flex-1 flex-col gap-6 px-4 py-6 sm:px-6 sm:py-10">
      <header className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium tracking-wide text-[var(--accent)]">
            CarAI
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-[var(--foreground)]">
            Dijagnoza vozila
          </h1>
          <p className="mt-1 text-sm text-[var(--muted)]">
            Opišite vozilo i kvar, zatim prođite kroz svaki dijagnostički korak.
          </p>
        </div>
        {phase !== "intake" && (
          <button
            type="button"
            onClick={resetCase}
            className="shrink-0 rounded-md border border-[var(--border)] px-3 py-2 text-sm font-medium text-[var(--foreground)]"
          >
            Novi slučaj
          </button>
        )}
      </header>

      {error && (
        <p
          role="alert"
          className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800"
        >
          {error}
        </p>
      )}

      {phase === "intake" && (
        <section className="flex flex-col gap-4">
          <label className="flex flex-col gap-2">
            <span className="text-sm font-medium text-[var(--foreground)]">
              Vozilo i kvar
            </span>
            <textarea
              value={problemText}
              onChange={(e) => setProblemText(e.target.value)}
              rows={8}
              placeholder="npr. VW Golf 1.6 TDI 2016 — nestabilan rad u praznom hodu kad je topao, bez lampice kvara, nedavno mijenjane grijače…"
              className="min-h-40 w-full resize-y rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-3 text-base leading-relaxed text-[var(--foreground)] outline-none focus:border-[var(--accent)]"
              disabled={loading}
            />
          </label>
          <button
            type="button"
            onClick={handleStart}
            disabled={loading || !problemText.trim()}
            className="w-full rounded-md bg-[var(--accent)] px-4 py-3 text-base font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? "Pokrećem…" : "Pokreni dijagnozu"}
          </button>
        </section>
      )}

      {phase !== "intake" && diagnosticCase && (
        <section className="flex flex-col gap-5">
          <div className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-3">
            <p className="text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
              Slučaj
            </p>
            <p className="mt-1 text-sm leading-relaxed text-[var(--foreground)]">
              {diagnosticCase.problemText}
            </p>
          </div>

          {diagnosticCase.observations.length > 0 && (
            <div className="flex flex-col gap-3">
              <h2 className="text-sm font-semibold text-[var(--foreground)]">
                Povijest
              </h2>
              <ol className="flex flex-col gap-3">
                {diagnosticCase.observations.map((obs) => {
                  const step = diagnosticCase.steps.find(
                    (s) => s.id === obs.stepId,
                  );
                  return (
                    <li
                      key={`${obs.stepId}-${obs.recordedAt}`}
                      className="border-l-2 border-[var(--border)] pl-3"
                    >
                      <p className="text-sm font-medium text-[var(--foreground)]">
                        {step?.instruction ?? obs.stepId}
                      </p>
                      <p className="mt-1 text-sm text-[var(--muted)]">
                        Rezultat: {obs.resultText}
                      </p>
                    </li>
                  );
                })}
              </ol>
            </div>
          )}

          {phase === "active" && nextStep && (
            <div className="flex flex-col gap-4">
              <div className="rounded-md border border-[var(--accent)] bg-[var(--accent-soft)] px-4 py-4">
                <p className="text-xs font-medium uppercase tracking-wide text-[var(--accent)]">
                  Sljedeći dijagnostički korak
                </p>
                <p className="mt-2 text-base font-medium leading-snug text-[var(--foreground)]">
                  {nextStep.instruction}
                </p>
                {nextStep.rationale && (
                  <p className="mt-2 text-sm text-[var(--muted)]">
                    {nextStep.rationale}
                  </p>
                )}
                {nextStep.expectedResultHint && (
                  <p className="mt-2 text-sm text-[var(--muted)]">
                    Napomena: {nextStep.expectedResultHint}
                  </p>
                )}
              </div>

              <label className="flex flex-col gap-2">
                <span className="text-sm font-medium text-[var(--foreground)]">
                  Rezultat testa
                </span>
                <textarea
                  value={resultText}
                  onChange={(e) => setResultText(e.target.value)}
                  rows={5}
                  placeholder="Unesite što ste primijetili ili izmjerili…"
                  className="min-h-28 w-full resize-y rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-3 text-base leading-relaxed text-[var(--foreground)] outline-none focus:border-[var(--accent)]"
                  disabled={loading}
                />
              </label>

              <button
                type="button"
                onClick={handleContinue}
                disabled={loading || !resultText.trim()}
                className="w-full rounded-md bg-[var(--accent)] px-4 py-3 text-base font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
              >
                {loading ? "Šaljem…" : "Pošalji rezultat"}
              </button>
            </div>
          )}

          {phase === "completed" && (
            <div className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-4 py-4">
              <p className="text-base font-semibold text-[var(--foreground)]">
                Dijagnoza završena
              </p>
              <p className="mt-2 text-sm text-[var(--muted)]">
                {message ??
                  "Nema više mock koraka. Pregledajte povijest i odlučite o popravku."}
              </p>
              <button
                type="button"
                onClick={resetCase}
                className="mt-4 w-full rounded-md bg-[var(--accent)] px-4 py-3 text-base font-semibold text-white"
              >
                Novi slučaj
              </button>
            </div>
          )}
        </section>
      )}
    </main>
  );
}
