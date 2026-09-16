"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  DiagnoseRequest,
  DiagnoseResponse,
  DiagnosticCase,
  DiagnosticStep,
} from "@/lib/diagnosis";
import { DIAGNOSTIC_UNAVAILABLE_MESSAGE } from "@/lib/diagnosis";
import {
  diagnosticStatusLabel,
  latestHypotheses,
} from "@/lib/diagnosis/ui-helpers";
import AppShell from "@/components/workspace/AppShell";
import AIAnalysisState from "@/components/workspace/AIAnalysisState";
import CannotPerformModal from "@/components/workspace/CannotPerformModal";
import CaseIntelligencePanel from "@/components/workspace/CaseIntelligencePanel";
import CommandPalette from "@/components/workspace/CommandPalette";
import DiagnosisCompletion from "@/components/workspace/DiagnosisCompletion";
import EvidenceTimeline from "@/components/workspace/EvidenceTimeline";
import HowToTestDrawer from "@/components/workspace/HowToTestDrawer";
import HypothesisPanel from "@/components/workspace/HypothesisPanel";
import NewCaseExperience from "@/components/workspace/NewCaseExperience";
import NextActionCard from "@/components/workspace/NextActionCard";
import QuickAddMenu from "@/components/workspace/QuickAddMenu";
import ResultModal from "@/components/workspace/ResultModal";
import VehicleHeader from "@/components/workspace/VehicleHeader";

type Phase = "intake" | "active" | "completed";
type NavKey = "new" | "active" | "history" | "settings";

function elapsedLabel(iso: string): string {
  const mins = Math.max(
    0,
    Math.round((Date.now() - new Date(iso).getTime()) / 60000),
  );
  if (mins < 1) return "<1 min";
  return `${mins} min`;
}

function lastFinishStep(
  diagnosticCase: DiagnosticCase,
  nextStep: DiagnosticStep | null,
): DiagnosticStep | null {
  if (nextStep?.actionType === "FINISH") return nextStep;
  for (let i = diagnosticCase.steps.length - 1; i >= 0; i -= 1) {
    const step = diagnosticCase.steps[i];
    if (step?.actionType === "FINISH") return step;
  }
  return null;
}

function AnalysisInterrupted({
  error,
  savedHint,
  canRetry,
  loading,
  onRetry,
  onDismiss,
}: {
  error: string;
  savedHint: string;
  canRetry: boolean;
  loading: boolean;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      role="alert"
      className="rounded-2xl border border-[var(--danger)]/40 bg-[var(--danger-soft)] px-4 py-3"
    >
      <p className="text-xs font-semibold tracking-wide text-[var(--danger)]">
        ANALIZA PREKINUTA
      </p>
      <p className="mt-1 text-sm text-[var(--muted-strong)]">{error}</p>
      <p className="mt-1 text-xs text-[var(--muted)]">{savedHint}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {canRetry ? (
          <button
            type="button"
            onClick={onRetry}
            disabled={loading}
            className="min-h-11 rounded-xl border border-[var(--border)] px-3 text-sm disabled:opacity-35"
          >
            PONOVNO POKUŠAJ
          </button>
        ) : null}
        <button
          type="button"
          onClick={onDismiss}
          disabled={loading}
          className="min-h-11 rounded-xl border border-[var(--border)] px-3 text-sm disabled:opacity-35"
        >
          ZATVORI
        </button>
      </div>
    </div>
  );
}

export default function DiagnosticScreen() {
  const [phase, setPhase] = useState<Phase>("intake");
  const [problemText, setProblemText] = useState("");
  const [diagnosticCase, setDiagnosticCase] = useState<DiagnosticCase | null>(
    null,
  );
  const [nextStep, setNextStep] = useState<DiagnosticStep | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [failedRequest, setFailedRequest] = useState<DiagnoseRequest | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [initLoading, setInitLoading] = useState(false);
  const requestInFlight = useRef(false);
  const requestGeneration = useRef(0);

  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [nav, setNav] = useState<NavKey>("new");
  const [resultOpen, setResultOpen] = useState(false);
  const [cantOpen, setCantOpen] = useState(false);
  const [howToOpen, setHowToOpen] = useState(false);
  const [hypOpen, setHypOpen] = useState(false);
  const [cmdOpen, setCmdOpen] = useState(false);
  const [futureNotice, setFutureNotice] = useState<string | null>(null);

  const statusLabel = useMemo(
    () => diagnosticStatusLabel(phase, diagnosticCase, nextStep),
    [phase, diagnosticCase, nextStep],
  );
  const hypotheses = diagnosticCase ? latestHypotheses(diagnosticCase) : [];

  const finishStep =
    phase === "completed" && diagnosticCase
      ? lastFinishStep(diagnosticCase, nextStep)
      : null;
  const missingFinish = phase === "completed" && !finishStep;
  const interruptedSavedHint = diagnosticCase
    ? "Podaci slučaja su sačuvani."
    : "Uneseni opis ostao je sačuvan.";

  const showActiveStep =
    phase === "active" &&
    nextStep != null &&
    nextStep.actionType !== "FINISH" &&
    !loading;

  const applyResponse = useCallback((data: DiagnoseResponse) => {
    const finished =
      data.case.status === "completed" ||
      data.nextStep?.actionType === "FINISH";
    const finish = lastFinishStep(data.case, data.nextStep);

    setDiagnosticCase(data.case);
    setNav("active");

    if (!finished) {
      setNextStep(data.nextStep);
      setPhase("active");
      return;
    }

    setPhase("completed");
    if (finish) {
      setNextStep(finish);
      return;
    }

    setNextStep(data.nextStep);
  }, []);

  function resetCase() {
    requestGeneration.current += 1;
    requestInFlight.current = false;
    setPhase("intake");
    setProblemText("");
    setDiagnosticCase(null);
    setNextStep(null);
    setError(null);
    setFailedRequest(null);
    setLoading(false);
    setInitLoading(false);
    setResultOpen(false);
    setCantOpen(false);
    setHowToOpen(false);
    setHypOpen(false);
    setNav("new");
  }

  async function callDiagnose(
    body: DiagnoseRequest,
  ): Promise<DiagnoseResponse> {
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

  async function runDiagnose(payload: DiagnoseRequest) {
    if (requestInFlight.current) return;
    requestInFlight.current = true;
    const generation = requestGeneration.current;
    const isStart = payload.action === "start";
    setLoading(true);
    if (isStart) setInitLoading(true);
    setError(null);
    setResultOpen(false);
    setCantOpen(false);
    try {
      const data = await callDiagnose(payload);
      if (generation !== requestGeneration.current) return;
      setFailedRequest(null);
      setError(null);
      applyResponse(data);
    } catch (err) {
      if (generation !== requestGeneration.current) return;
      setFailedRequest(payload);
      setError(
        err instanceof Error
          ? err.message
          : isStart
            ? "Nije moguće pokrenuti dijagnozu"
            : "Nije moguće nastaviti dijagnozu",
      );
      if (isStart) {
        setPhase("intake");
        setNav("new");
      }
    } finally {
      if (generation === requestGeneration.current) {
        requestInFlight.current = false;
        setLoading(false);
        if (isStart) setInitLoading(false);
      }
    }
  }

  function handleStart() {
    const text = problemText.trim();
    if (!text) return;
    void runDiagnose({ action: "start", problemText: text });
  }

  function handleContinue(
    resultText: string,
    caseOverride?: DiagnosticCase,
  ) {
    const base = caseOverride ?? diagnosticCase;
    if (!base) return;
    const text = resultText.trim();
    if (!text) {
      setError("Unesi rezultat prije nastavka.");
      return;
    }
    void runDiagnose({
      action: "continue",
      case: base,
      observation: { resultText: text },
    });
  }

  function retryFailedRequest() {
    if (!failedRequest) return;
    void runDiagnose(failedRequest);
  }

  function dismissInterrupted() {
    setError(null);
    setFailedRequest(null);
  }

  /** Reopen FINISH via engine: rejection is stored in case.rejectedDiagnoses. */
  function reopenAndContinue(reason: string) {
    if (!diagnosticCase || !finishStep) return;
    handleContinue(reason, {
      ...diagnosticCase,
      status: "active",
    });
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCmdOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function onNavigate(key: NavKey) {
    if (key === "history" || key === "settings") {
      setFutureNotice(
        key === "history"
          ? "Povijest slučajeva dolazi u sljedećem milestonu."
          : "Postavke dolaze u sljedećem milestonu.",
      );
      return;
    }
    if (key === "new") {
      resetCase();
      return;
    }
    if (key === "active" && diagnosticCase) {
      setNav("active");
    }
  }

  const commands = [
    {
      id: "new",
      label: "Novi dijagnostički slučaj",
      enabled: true,
      run: () => resetCase(),
    },
    {
      id: "result",
      label: "Unesi rezultat",
      enabled: Boolean(showActiveStep),
      run: () => setResultOpen(true),
    },
    {
      id: "vehicle",
      label: "Otvori detalje vozila",
      enabled: Boolean(diagnosticCase),
      hint: "klikni header",
      run: () => setFutureNotice("Otvori kartica vozila u workspaceu."),
    },
    {
      id: "hyp",
      label: "Pregledaj hipoteze",
      enabled: Boolean(diagnosticCase),
      run: () => setHypOpen(true),
    },
    {
      id: "end",
      label: "Završi slučaj",
      enabled: phase === "completed",
      run: () => resetCase(),
    },
    {
      id: "search",
      label: "Pretraži slučajeve",
      enabled: false,
      run: () => undefined,
    },
  ];

  return (
    <AppShell
      collapsed={sidebarCollapsed}
      onToggleCollapse={() => setSidebarCollapsed((v) => !v)}
      activeNav={nav}
      onNavigate={onNavigate}
      hasActiveCase={Boolean(diagnosticCase)}
      caseElapsed={
        diagnosticCase ? elapsedLabel(diagnosticCase.createdAt) : undefined
      }
      topRight={
        <>
          <button
            type="button"
            onClick={() => setCmdOpen(true)}
            className="hidden min-h-10 rounded-xl border border-[var(--border)] px-3 text-xs text-[var(--muted)] transition hover:bg-white/5 md:inline-flex md:items-center"
          >
            ⌘K
          </button>
          {phase !== "intake" && (
            <button
              type="button"
              onClick={resetCase}
              className="min-h-10 rounded-xl border border-[var(--border-strong)] px-3 text-sm"
            >
              Novi slučaj
            </button>
          )}
        </>
      }
    >
      {futureNotice && (
        <div className="mx-auto w-full max-w-6xl px-4 pt-3 sm:px-6">
          <p className="rounded-2xl border border-[var(--border)] bg-[var(--bg-2)] px-3 py-2 text-sm text-[var(--muted-strong)]">
            {futureNotice}{" "}
            <button
              type="button"
              className="text-[var(--accent)]"
              onClick={() => setFutureNotice(null)}
            >
              U redu
            </button>
          </p>
        </div>
      )}

      {phase === "intake" && !initLoading && (
        <>
          {error ? (
            <div className="mx-auto w-full max-w-2xl px-4 pt-6 sm:px-6">
              <AnalysisInterrupted
                error={error}
                savedHint={interruptedSavedHint}
                canRetry={failedRequest != null}
                loading={loading}
                onRetry={retryFailedRequest}
                onDismiss={dismissInterrupted}
              />
            </div>
          ) : null}
          <NewCaseExperience
            value={problemText}
            onChange={setProblemText}
            onStart={handleStart}
            loading={loading}
            error={null}
          />
        </>
      )}

      {(initLoading || (loading && phase === "intake")) && (
        <div className="mx-auto w-full max-w-2xl px-4 py-10 sm:px-6">
          <AIAnalysisState active mode="init" />
        </div>
      )}

      {phase !== "intake" && diagnosticCase && (
        <div className="mx-auto grid w-full max-w-6xl gap-4 px-4 py-4 sm:px-6 sm:py-6 lg:grid-cols-[minmax(0,1fr)_280px]">
          <div className="flex min-w-0 flex-col gap-4">
            {error && !missingFinish && (
              <AnalysisInterrupted
                error={error}
                savedHint={interruptedSavedHint}
                canRetry={failedRequest != null}
                loading={loading}
                onRetry={retryFailedRequest}
                onDismiss={dismissInterrupted}
              />
            )}

            <VehicleHeader
              diagnosticCase={diagnosticCase}
              elapsedLabel={elapsedLabel(diagnosticCase.createdAt)}
              statusLabel={statusLabel}
            />

            {/* Mobile status strip */}
            <div className="surface-2 flex items-center justify-between p-3 lg:hidden">
              <div>
                <p className="text-xs text-[var(--muted)]">Status</p>
                <p className="text-sm text-[var(--accent)]">{statusLabel}</p>
              </div>
              <button
                type="button"
                onClick={() => setHypOpen(true)}
                className="min-h-11 rounded-xl border border-[var(--border)] px-3 text-sm"
              >
                Hipoteze
              </button>
            </div>

            {loading && <AIAnalysisState active mode="reanalyze" />}

            {showActiveStep && nextStep && (
              <NextActionCard
                step={nextStep}
                stepNumber={diagnosticCase.steps.length}
                onSubmitResult={(text) => handleContinue(text)}
                onCantPerform={() => setCantOpen(true)}
                onSkip={() => handleContinue("Preskočeno za sada.")}
                onHowTo={() => setHowToOpen(true)}
              />
            )}

            {phase === "completed" && finishStep && (
              <DiagnosisCompletion
                step={finishStep}
                confirmedFault={diagnosticCase.confirmedFault}
                onComplete={resetCase}
                onKeepDiagnosing={() =>
                  reopenAndContinue(
                    "Mehaničar želi nastaviti dijagnostiku nakon prijedloga. Predloži diskriminirajući sljedeći korak (ne CONFIRMED bez novog dokaza).",
                  )
                }
                onReject={() =>
                  reopenAndContinue(
                    "TECHNICIAN_REJECTED_DIAGNOSIS: Mehaničar odbija predloženu dijagnozu (dijagnoza ne izgleda točno). Reevaluate alternatives. Pitaj: Što u prethodnom zaključku možda nije objašnjeno?",
                  )
                }
              />
            )}

            {missingFinish && (
              <div
                role="alert"
                className="rounded-2xl border border-[var(--danger)]/40 bg-[var(--danger-soft)] px-4 py-3"
              >
                <p className="text-xs font-semibold tracking-wide text-[var(--danger)]">
                  DIJAGNOZA NIJE DOSTUPNA
                </p>
                <p className="mt-1 text-sm text-[var(--muted-strong)]">
                  {DIAGNOSTIC_UNAVAILABLE_MESSAGE}
                </p>
              </div>
            )}

            <EvidenceTimeline diagnosticCase={diagnosticCase} />
          </div>

          <CaseIntelligencePanel
            diagnosticCase={diagnosticCase}
            statusLabel={statusLabel}
            hypotheses={hypotheses}
            onViewHypotheses={() => setHypOpen(true)}
          />
        </div>
      )}

      {phase === "active" && showActiveStep && nextStep && (
        <QuickAddMenu onEnterResult={() => setResultOpen(true)} />
      )}

      {nextStep && nextStep.actionType !== "FINISH" && (
        <ResultModal
          open={resultOpen}
          onClose={() => setResultOpen(false)}
          step={nextStep}
          onSubmit={(result) => handleContinue(result)}
        />
      )}

      <CannotPerformModal
        open={cantOpen}
        onClose={() => setCantOpen(false)}
        onSubmit={(reason) => handleContinue(reason)}
      />

      <HowToTestDrawer
        open={howToOpen}
        onClose={() => setHowToOpen(false)}
        step={nextStep}
      />

      <HypothesisPanel
        open={hypOpen}
        onClose={() => setHypOpen(false)}
        hypotheses={hypotheses}
        evidenceNeeded={nextStep?.expectedResultHint}
      />

      <CommandPalette
        open={cmdOpen}
        onClose={() => setCmdOpen(false)}
        commands={commands}
      />
    </AppShell>
  );
}
