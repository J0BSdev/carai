"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  listDiagnosticCases,
  loadDiagnosticCase,
  saveDiagnosticCase,
  type CaseSummary,
} from "@/app/actions/cases";
import type { SessionUser } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/client";
import type {
  DiagnoseRequest,
  DiagnoseResponse,
  DiagnosticCase,
  DiagnosticStep,
  ObservationInput,
  TurnImage,
} from "@/lib/diagnosis";
import { DIAGNOSTIC_UNAVAILABLE_MESSAGE } from "@/lib/diagnosis/errors";
import { fileToTurnImage } from "@/lib/diagnosis/turn-image";
import {
  diagnosticStatusLabel,
  latestHypotheses,
} from "@/lib/diagnosis/ui-helpers";
import AccountPanel from "@/components/workspace/AccountPanel";
import AppShell from "@/components/workspace/AppShell";
import CaseHistory from "@/components/workspace/CaseHistory";
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

export default function DiagnosticScreen({
  user,
  persistenceConfigured,
  role,
}: {
  user: SessionUser | null;
  persistenceConfigured: boolean;
  role: "admin" | "member" | "local";
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("intake");
  const [problemText, setProblemText] = useState("");
  const intakePhotoRef = useRef<File | null>(null);
  const intakePhotoGen = useRef(0);
  const preparingRef = useRef(false);
  const [hasPhoto, setHasPhoto] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const onIntakePhoto = useCallback((file: File | null) => {
    intakePhotoGen.current += 1;
    intakePhotoRef.current = file;
    setHasPhoto(file != null);
  }, []);
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
  const [saveNote, setSaveNote] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [history, setHistory] = useState<CaseSummary[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const saveGeneration = useRef(0);
  const saveQueue = useRef(Promise.resolve());

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
    nextStep.actionType !== "FINISH";

  const applyResponse = useCallback((data: DiagnoseResponse) => {
    const finished = data.nextStep?.actionType === "FINISH";
    const finish = lastFinishStep(data.case, data.nextStep);

    setResultOpen(false);
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
    saveGeneration.current += 1;
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
    setSaveNote(null);
    setNav("new");
  }

  function openStoredCase(stored: DiagnosticCase) {
    requestGeneration.current += 1;
    requestInFlight.current = false;
    setFailedRequest(null);
    setError(null);
    setLoading(false);
    setInitLoading(false);
    setResultOpen(false);
    setCantOpen(false);
    setHowToOpen(false);
    setHypOpen(false);
    setProblemText(stored.problemText);
    setDiagnosticCase(stored);
    const last = stored.steps[stored.steps.length - 1] ?? null;
    setNextStep(last);
    setPhase(last?.actionType === "FINISH" ? "completed" : "active");
    setNav("active");
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

  async function handleStart() {
    if (preparingRef.current) return;
    const text = problemText.trim();
    const file = intakePhotoRef.current;
    if (!text && !file) return;
    const gen = intakePhotoGen.current;
    preparingRef.current = true;
    setPreparing(true);
    try {
      const image = file ? await fileToTurnImage(file) : undefined;
      if (intakePhotoGen.current !== gen || intakePhotoRef.current !== file) return;
      void runDiagnose({
        action: "start",
        problemText: text,
        ...(image ? { image } : {}),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Slika nije valjana.");
    } finally {
      preparingRef.current = false;
      setPreparing(false);
    }
  }

  function handleContinue(
    observation: ObservationInput,
    caseOverride?: DiagnosticCase,
    image?: TurnImage,
  ) {
    const base = caseOverride ?? diagnosticCase;
    if (!base) return;
    if (observation.kind === "RESULT" && !observation.text?.trim() && !image) {
      setError("Unesi rezultat ili fotografiju prije nastavka.");
      return;
    }
    void runDiagnose({
      action: "continue",
      case: base,
      observation,
      ...(image ? { image } : {}),
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

  function reopenAndContinue(
    kind: "REJECT_DIAGNOSIS" | "CONTINUE_AFTER_FINISH",
  ) {
    if (!diagnosticCase || !finishStep) return;
    handleContinue({ kind });
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

  const userId = user?.id ?? null;
  useEffect(() => {
    if (!userId || !diagnosticCase) return;
    const snapshot = diagnosticCase;
    const generation = saveGeneration.current + 1;
    saveGeneration.current = generation;
    saveQueue.current = saveQueue.current.then(async () => {
      try {
        const result = await saveDiagnosticCase(snapshot);
        if (generation !== saveGeneration.current) return;
        if (
          result.ok ||
          result.code === "UNAUTHENTICATED" ||
          result.code === "UNCONFIGURED"
        ) {
          setSaveNote(null);
          return;
        }
        setSaveNote(result.message);
      } catch {
        if (generation !== saveGeneration.current) return;
        setSaveNote("Spremanje slučaja nije uspjelo.");
      }
    });
  }, [userId, diagnosticCase]);

  async function refreshHistory() {
    if (!user) {
      setHistory([]);
      setHistoryError(null);
      setHistoryLoading(false);
      return;
    }
    setHistoryLoading(true);
    setHistoryError(null);
    const result = await listDiagnosticCases();
    setHistoryLoading(false);
    if (!result.ok) {
      setHistoryError(result.message);
      return;
    }
    setHistory(result.data);
  }

  async function openHistoryCase(id: string) {
    if (openingId) return;
    setOpeningId(id);
    setHistoryError(null);
    const result = await loadDiagnosticCase(id);
    setOpeningId(null);
    if (!result.ok) {
      setHistoryError(result.message);
      return;
    }
    openStoredCase(result.data);
  }

  async function signOut() {
    if (signingOut) return;
    setSigningOut(true);
    try {
      const supabase = createClient();
      if (supabase) await supabase.auth.signOut();
      resetCase();
      router.refresh();
    } finally {
      setSigningOut(false);
    }
  }

  function onNavigate(key: NavKey) {
    if (key === "history") {
      setNav("history");
      void refreshHistory();
      return;
    }
    if (key === "settings") {
      setNav("settings");
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
      enabled: showActiveStep && !loading,
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
      label: "Spremljeni slučajevi",
      enabled: true,
      run: () => onNavigate("history"),
    },
  ];

  const showWorkspace = nav === "new" || nav === "active";

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
          {role === "admin" ? (
            <span className="rounded-lg bg-[var(--accent-soft)] px-2 py-1 text-[10px] font-semibold tracking-wide text-[var(--accent)]">
              ADMIN
            </span>
          ) : null}
          {user ? (
            <span className="hidden max-w-40 truncate text-xs text-[var(--muted)] sm:inline">
              {user.email}
            </span>
          ) : null}
          {user ? (
            <button
              type="button"
              onClick={() => void signOut()}
              disabled={signingOut}
              className="min-h-10 rounded-xl border border-[var(--border)] px-3 text-sm disabled:opacity-35"
            >
              Odjava
            </button>
          ) : (
            <button
              type="button"
              onClick={() => onNavigate("settings")}
              className="min-h-10 rounded-xl border border-[var(--border)] px-3 text-sm"
            >
              Prijava
            </button>
          )}
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
      {role === "local" && (
        <p className="mx-auto w-full max-w-6xl px-4 pt-3 text-xs text-[var(--muted)] sm:px-6">
          Lokalni razvoj. Prijava nije obavezna.
        </p>
      )}

      {nav === "history" && (
        <CaseHistory
          configured={persistenceConfigured}
          signedIn={user != null}
          loading={historyLoading}
          error={historyError}
          cases={history}
          openingId={openingId}
          onOpen={(id) => void openHistoryCase(id)}
          onSignIn={() => onNavigate("settings")}
          onRefresh={() => void refreshHistory()}
        />
      )}

      {nav === "settings" && (
        <AccountPanel
          email={user?.email ?? null}
          configured={persistenceConfigured}
          onSignOut={() => void signOut()}
          signingOut={signingOut}
        />
      )}

      {showWorkspace && saveNote && (
        <div className="mx-auto w-full max-w-6xl px-4 pt-3 sm:px-6">
          <p role="status" className="text-sm text-[var(--warning)]">
            {saveNote}
          </p>
        </div>
      )}

      {showWorkspace && futureNotice && (
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

      {showWorkspace && phase === "intake" && (
        <div hidden={initLoading || loading}>
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
            onPhotoChange={onIntakePhoto}
            hasPhoto={hasPhoto}
            preparing={preparing}
            onStart={() => void handleStart()}
            loading={loading}
            error={null}
          />
        </div>
      )}

      {showWorkspace && (initLoading || (loading && phase === "intake")) && (
        <div className="mx-auto w-full max-w-2xl px-4 py-10 sm:px-6">
          <AIAnalysisState active mode="init" />
        </div>
      )}

      {showWorkspace && phase !== "intake" && diagnosticCase && (
        <div className="mx-auto grid w-full max-w-6xl gap-4 px-4 py-4 sm:px-6 sm:py-6 lg:grid-cols-[minmax(0,1fr)_280px]">
          <div className="flex min-w-0 flex-col gap-4">
            {error && !missingFinish && !resultOpen && (
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
                onSubmitResult={(text, image) =>
                  handleContinue(
                    text.trim()
                      ? { kind: "RESULT", text: text.trim() }
                      : { kind: "RESULT" },
                    undefined,
                    image,
                  )
                }
                onCantPerform={() => setCantOpen(true)}
                onSkip={() => handleContinue({ kind: "SKIP" })}
                onHowTo={() => setHowToOpen(true)}
                pending={loading}
                error={resultOpen ? null : error}
              />
            )}

            {phase === "completed" && finishStep && (
              <DiagnosisCompletion
                step={finishStep}
                onComplete={resetCase}
                onKeepDiagnosing={() =>
                  reopenAndContinue("CONTINUE_AFTER_FINISH")
                }
                onReject={() => reopenAndContinue("REJECT_DIAGNOSIS")}
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

      {showWorkspace && phase === "active" && showActiveStep && !loading && nextStep && (
        <QuickAddMenu onEnterResult={() => setResultOpen(true)} />
      )}

      {showWorkspace && nextStep && nextStep.actionType !== "FINISH" && (
        <ResultModal
          open={resultOpen}
          onClose={() => setResultOpen(false)}
          step={nextStep}
          pending={loading}
          error={resultOpen ? error : null}
          onSubmit={(result, image) =>
            handleContinue(
              result.trim()
                ? { kind: "RESULT", text: result.trim() }
                : { kind: "RESULT" },
              undefined,
              image,
            )
          }
        />
      )}

      {showWorkspace && (
      <>
      <CannotPerformModal
        open={cantOpen}
        onClose={() => setCantOpen(false)}
        onSubmit={(reason) =>
          handleContinue(
            reason.trim()
              ? { kind: "CANNOT_PERFORM", reason: reason.trim() }
              : { kind: "CANNOT_PERFORM" },
          )
        }
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
      </>
      )}

      <CommandPalette
        open={cmdOpen}
        onClose={() => setCmdOpen(false)}
        commands={commands}
      />
    </AppShell>
  );
}
