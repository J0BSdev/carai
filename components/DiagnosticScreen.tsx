"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
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

export default function DiagnosticScreen() {
  const [phase, setPhase] = useState<Phase>("intake");
  const [problemText, setProblemText] = useState("");
  const [diagnosticCase, setDiagnosticCase] = useState<DiagnosticCase | null>(
    null,
  );
  const [nextStep, setNextStep] = useState<DiagnosticStep | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [initLoading, setInitLoading] = useState(false);

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

  const applyResponse = useCallback((data: DiagnoseResponse) => {
    setDiagnosticCase(data.case);
    setNextStep(data.nextStep);
    const finished =
      data.case.status === "completed" ||
      data.nextStep?.actionType === "FINISH";
    setPhase(finished ? "completed" : "active");
    setNav("active");
  }, []);

  function resetCase() {
    setPhase("intake");
    setProblemText("");
    setDiagnosticCase(null);
    setNextStep(null);
    setError(null);
    setLoading(false);
    setInitLoading(false);
    setResultOpen(false);
    setCantOpen(false);
    setHowToOpen(false);
    setHypOpen(false);
    setNav("new");
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
    setInitLoading(true);
    try {
      applyResponse(await callDiagnose({ action: "start", problemText }));
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Nije moguće pokrenuti dijagnozu",
      );
      setPhase("intake");
      setNav("new");
    } finally {
      setLoading(false);
      setInitLoading(false);
    }
  }

  async function handleContinue(
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
    setError(null);
    setResultOpen(false);
    setCantOpen(false);
    setLoading(true);
    try {
      applyResponse(
        await callDiagnose({
          action: "continue",
          case: base,
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

  /** Client-side reopen after FINISH without changing engine code. */
  async function reopenAndContinue(reason: string) {
    if (!diagnosticCase) return;
    const steps = diagnosticCase.steps.filter((s) => s.actionType !== "FINISH");
    if (steps.length === 0) {
      resetCase();
      return;
    }
    const reopened: DiagnosticCase = {
      ...diagnosticCase,
      steps,
      status: "active",
      confirmedFault: undefined,
    };
    setPhase("active");
    setDiagnosticCase(reopened);
    setNextStep(steps[steps.length - 1] ?? null);
    await handleContinue(reason, reopened);
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
        <NewCaseExperience
          value={problemText}
          onChange={setProblemText}
          onStart={handleStart}
          loading={loading}
          error={error}
        />
      )}

      {(initLoading || (loading && phase === "intake")) && (
        <div className="mx-auto w-full max-w-2xl px-4 py-10 sm:px-6">
          <AIAnalysisState active mode="init" />
        </div>
      )}

      {phase !== "intake" && diagnosticCase && (
        <div className="mx-auto grid w-full max-w-6xl gap-4 px-4 py-4 sm:px-6 sm:py-6 lg:grid-cols-[minmax(0,1fr)_280px]">
          <div className="flex min-w-0 flex-col gap-4">
            {error && (
              <div
                role="alert"
                className="rounded-2xl border border-[var(--danger)]/40 bg-[var(--danger-soft)] px-4 py-3"
              >
                <p className="text-xs font-semibold tracking-wide text-[var(--danger)]">
                  ANALIZA PREKINUTA
                </p>
                <p className="mt-1 text-sm text-[var(--muted-strong)]">
                  {error}
                </p>
                <p className="mt-1 text-xs text-[var(--muted)]">
                  Podaci slučaja su sačuvani.
                </p>
                <button
                  type="button"
                  onClick={() => setError(null)}
                  className="mt-3 min-h-11 rounded-xl border border-[var(--border)] px-3 text-sm"
                >
                  PONOVNO POKUŠAJ / ZATVORI
                </button>
              </div>
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
                    "Mehaničar želi nastaviti dijagnostiku nakon prijedloga.",
                  )
                }
                onReject={() =>
                  reopenAndContinue(
                    "Mehaničar odbija predloženu dijagnozu — treba drugi smjer.",
                  )
                }
              />
            )}

            <EvidenceTimeline diagnosticCase={diagnosticCase} />

            <p className="text-center text-[11px] text-[var(--muted)]">
              Faza {progress.index}/{progress.total}
            </p>
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
