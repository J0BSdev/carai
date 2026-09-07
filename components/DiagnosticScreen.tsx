"use client";

import { useState } from "react";
import type {
  AiActionType,
  DiagnoseResponse,
  DiagnosticCase,
  DiagnosticStep,
} from "@/lib/diagnosis";

type Phase = "intake" | "active" | "completed";

function actionLabel(actionType: AiActionType): string {
  switch (actionType) {
    case "ASK":
      return "Pitanje";
    case "TEST":
      return "Test";
    case "SEARCH_WEB":
      return "Pretraga";
    case "FINISH":
      return "Zaključak";
  }
}

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

  function applyResponse(data: DiagnoseResponse) {
    setDiagnosticCase(data.case);
    setNextStep(data.nextStep);
    setMessage(data.message ?? null);
    setResultText("");

    const finished =
      data.case.status === "completed" ||
      data.nextStep?.actionType === "FINISH";
    setPhase(finished ? "completed" : "active");
  }

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
      applyResponse(data);
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
      applyResponse(data);
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

  const extracted = diagnosticCase?.extracted;
  const vehicleBits = [
    extracted?.vehicle?.make,
    extracted?.vehicle?.model,
    extracted?.vehicle?.year,
    extracted?.vehicle?.engine,
  ].filter(Boolean);

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
            Opišite vozilo i kvar — sustav vodi jedan korak odjednom.
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
              placeholder='npr. Golf 7 GTD 2015, P0299, gubi snagu iznad 3000 o/min. Smoke test napravljen, nema curenja. Turbo aktuator se miče normalno.'
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
              Vozilo / trenutni slučaj
            </p>
            {vehicleBits.length > 0 && (
              <p className="mt-1 text-sm font-medium text-[var(--foreground)]">
                {vehicleBits.join(" · ")}
              </p>
            )}
            <p className="mt-1 text-sm leading-relaxed text-[var(--foreground)]">
              {diagnosticCase.problemText}
            </p>
            {extracted?.dtcs && extracted.dtcs.length > 0 && (
              <p className="mt-2 text-sm text-[var(--muted)]">
                DTC: {extracted.dtcs.join(", ")}
              </p>
            )}
          </div>

          {diagnosticCase.observations.length > 0 && (
            <div className="flex flex-col gap-3">
              <h2 className="text-sm font-semibold text-[var(--foreground)]">
                Trenutna evidencija
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
                      <p className="text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
                        {step ? actionLabel(step.actionType) : obs.stepId}
                      </p>
                      <p className="mt-1 text-sm font-medium text-[var(--foreground)]">
                        {step?.content ?? obs.stepId}
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

          {phase === "active" && nextStep && nextStep.actionType !== "FINISH" && (
            <div className="flex flex-col gap-4">
              <div className="rounded-md border border-[var(--accent)] bg-[var(--accent-soft)] px-4 py-4">
                <p className="text-xs font-medium uppercase tracking-wide text-[var(--accent)]">
                  {actionLabel(nextStep.actionType)} · Sljedeći korak
                </p>
                <p className="mt-2 text-base font-medium leading-snug text-[var(--foreground)]">
                  {nextStep.content}
                </p>
                <p className="mt-3 text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
                  Zašto
                </p>
                <p className="mt-1 text-sm text-[var(--muted)]">
                  {nextStep.rationale}
                </p>
                {nextStep.expectedResultHint && (
                  <p className="mt-2 text-sm text-[var(--muted)]">
                    Zabilježite: {nextStep.expectedResultHint}
                  </p>
                )}
              </div>

              <label className="flex flex-col gap-2">
                <span className="text-sm font-medium text-[var(--foreground)]">
                  {nextStep.actionType === "ASK"
                    ? "Vaš odgovor"
                    : "Rezultat testa"}
                </span>
                <textarea
                  value={resultText}
                  onChange={(e) => setResultText(e.target.value)}
                  rows={5}
                  placeholder="Unesite odgovor ili što ste izmjerili…"
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
                {loading ? "Šaljem…" : "Nastavi"}
              </button>
            </div>
          )}

          {phase === "completed" && (
            <div className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-4 py-4">
              <p className="text-xs font-medium uppercase tracking-wide text-[var(--accent)]">
                Finish · Dijagnoza
              </p>
              <p className="mt-2 text-base font-semibold text-[var(--foreground)]">
                {diagnosticCase.confirmedFault ??
                  nextStep?.confirmedFault ??
                  "Slučaj završen"}
              </p>
              {(nextStep?.content || message) && (
                <p className="mt-2 text-sm text-[var(--muted)]">
                  {nextStep?.content ?? message}
                </p>
              )}
              {nextStep?.rationale && (
                <>
                  <p className="mt-3 text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
                    Zašto
                  </p>
                  <p className="mt-1 text-sm text-[var(--muted)]">
                    {nextStep.rationale}
                  </p>
                </>
              )}
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
