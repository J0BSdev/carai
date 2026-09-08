"use client";

import { useMemo, useRef, useState } from "react";
import type {
  DiagnoseResponse,
  DiagnosticCase,
  DiagnosticStep,
} from "@/lib/diagnosis";
import {
  diagnosticStatusLabel,
  latestHypotheses,
  statusProgress,
} from "@/lib/diagnosis/ui-helpers";
import AIProcessingState from "@/components/diagnostic/AIProcessingState";
import AppHeader from "@/components/diagnostic/AppHeader";
import DiagnosisCard from "@/components/diagnostic/DiagnosisCard";
import DiagnosticInput from "@/components/diagnostic/DiagnosticInput";
import DiagnosticTimeline from "@/components/diagnostic/DiagnosticTimeline";
import HypothesesPanel from "@/components/diagnostic/HypothesesPanel";
import NewCaseScreen from "@/components/diagnostic/NewCaseScreen";
import NextStepCard from "@/components/diagnostic/NextStepCard";
import VehicleCaseCard from "@/components/diagnostic/VehicleCaseCard";

type Phase = "intake" | "active" | "completed";

export default function DiagnosticScreen() {
  const [phase, setPhase] = useState<Phase>("intake");
  const [problemText, setProblemText] = useState("");
  const [resultText, setResultText] = useState("");
  const [inputOpen, setInputOpen] = useState(false);
  const [diagnosticCase, setDiagnosticCase] = useState<DiagnosticCase | null>(
    null,
  );
  const [nextStep, setNextStep] = useState<DiagnosticStep | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const inputAnchorRef = useRef<HTMLDivElement | null>(null);

  const statusLabel = useMemo(
    () => diagnosticStatusLabel(phase, diagnosticCase, nextStep),
    [phase, diagnosticCase, nextStep],
  );
  const progress = statusProgress(statusLabel);
  const hypotheses = diagnosticCase ? latestHypotheses(diagnosticCase) : [];

  const finishStep =
    phase === "completed"
      ? (nextStep?.actionType === "FINISH"
          ? nextStep
          : diagnosticCase?.steps.find((s) => s.actionType === "FINISH") ??
            diagnosticCase?.steps.at(-1) ??
            null)
      : null;

  const showActiveStep =
    phase === "active" &&
    nextStep != null &&
    nextStep.actionType !== "FINISH" &&
    !loading;

  function applyResponse(data: DiagnoseResponse) {
    setDiagnosticCase(data.case);
    setNextStep(data.nextStep);
    setResultText("");
    setInputOpen(false);
    const finished =
      data.case.status === "completed" ||
      data.nextStep?.actionType === "FINISH";
    setPhase(finished ? "completed" : "active");
  }

  function resetCase() {
    setPhase("intake");
    setProblemText("");
    setResultText("");
    setInputOpen(false);
    setDiagnosticCase(null);
    setNextStep(null);
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
      applyResponse(await callDiagnose({ action: "start", problemText }));
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Nije moguće pokrenuti dijagnozu",
      );
    } finally {
      setLoading(false);
    }
  }

  async function handleContinue(forcedResult?: string) {
    if (!diagnosticCase) return;
    const text = (forcedResult ?? resultText).trim();
    if (!text) {
      setError("Unesi rezultat prije nastavka.");
      return;
    }
    setError(null);
    setLoading(true);
    try {
      applyResponse(
        await callDiagnose({
          action: "continue",
          case: diagnosticCase,
          observation: { resultText: text },
        }),
      );
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Nije moguće nastaviti dijagnozu",
      );
    } finally {
      setLoading(false);
    }
  }

  function openInput() {
    setInputOpen(true);
    setError(null);
    requestAnimationFrame(() => {
      inputAnchorRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    });
  }

  return (
    <div className="app-shell flex min-h-full flex-1 flex-col">
      <AppHeader showNewCase={phase !== "intake"} onNewCase={resetCase} />

      {phase === "intake" && (
        <NewCaseScreen
          value={problemText}
          onChange={setProblemText}
          onStart={handleStart}
          loading={loading}
          error={error}
        />
      )}

      {phase === "intake" && loading && (
        <div className="mx-auto w-full max-w-[720px] px-4 pb-10 sm:px-6">
          <AIProcessingState active />
        </div>
      )}

      {phase !== "intake" && diagnosticCase && (
        <div
          className={`mx-auto flex w-full max-w-[1100px] flex-1 flex-col gap-5 px-4 py-5 sm:px-6 sm:py-6 ${
            inputOpen || loading ? "pb-36" : "pb-8"
          }`}
        >
          {error && (
            <p
              role="alert"
              className="rounded-xl border border-[var(--danger-border)] bg-[var(--danger-bg)] px-3 py-2 text-sm text-[var(--danger)]"
            >
              {error}
            </p>
          )}

          <VehicleCaseCard
            diagnosticCase={diagnosticCase}
            statusLabel={statusLabel}
            progressIndex={progress.index}
            progressTotal={progress.total}
          />

          {/* NEXT STEP first — primary UX question */}
          {showActiveStep && nextStep && (
            <NextStepCard
              step={nextStep}
              stepNumber={diagnosticCase.steps.length}
              onEnterResult={openInput}
              onCantPerform={() =>
                handleContinue("Ne mogu izvesti ovaj test s dostupnim alatima.")
              }
              onSkip={() => handleContinue("Preskočeno za sada.")}
            />
          )}

          <AIProcessingState active={loading} />

          {phase === "completed" && finishStep && (
            <DiagnosisCard
              step={finishStep}
              confirmedFault={diagnosticCase.confirmedFault}
              onComplete={resetCase}
            />
          )}

          <HypothesesPanel hypotheses={hypotheses} />

          <DiagnosticTimeline
            diagnosticCase={diagnosticCase}
            currentStep={nextStep}
          />

          <div ref={inputAnchorRef} />
        </div>
      )}

      {phase === "active" && inputOpen && !loading && (
        <DiagnosticInput
          value={resultText}
          onChange={setResultText}
          onSubmit={() => handleContinue()}
          disabled={loading}
          autoFocus
        />
      )}
    </div>
  );
}
