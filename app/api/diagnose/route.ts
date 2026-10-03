import {
  DIAGNOSTIC_UNAVAILABLE_MESSAGE,
  OBSERVATION_CONFLICT_MESSAGE,
  ObservationConflictError,
  USER_CONTINUE_INTENTS,
  type DiagnoseRequest,
  type DiagnosticCase,
  type UserContinueIntent,
} from "@/lib/diagnosis";
import { LlmDiagnosticEngine } from "@/lib/diagnosis/llm-engine";

function isDiagnosticCase(value: unknown): value is DiagnosticCase {
  if (!value || typeof value !== "object") return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.id === "string" &&
    typeof c.createdAt === "string" &&
    typeof c.problemText === "string" &&
    Array.isArray(c.observations) &&
    Array.isArray(c.steps) &&
    (c.status === "active" || c.status === "completed")
  );
}

function parseIntent(value: unknown): UserContinueIntent | undefined {
  if (typeof value !== "string") return undefined;
  return USER_CONTINUE_INTENTS.includes(value as UserContinueIntent)
    ? (value as UserContinueIntent)
    : undefined;
}

function parseBody(body: unknown): DiagnoseRequest {
  if (!body || typeof body !== "object") {
    throw new Error("Tijelo zahtjeva mora biti JSON objekt");
  }

  const raw = body as Record<string, unknown>;
  const action = raw.action;

  if (action !== "start" && action !== "continue") {
    throw new Error('action mora biti "start" ili "continue"');
  }

  const observation =
    raw.observation && typeof raw.observation === "object"
      ? (raw.observation as Record<string, unknown>)
      : undefined;
  const intentRaw = observation?.intent;
  if (
    intentRaw != null &&
    typeof intentRaw === "string" &&
    !parseIntent(intentRaw)
  ) {
    throw new Error("observation.intent nije valjan");
  }
  const intent = parseIntent(intentRaw);
  const resultText =
    observation && typeof observation.resultText === "string"
      ? observation.resultText
      : undefined;
  const cannotPerformReason =
    observation && typeof observation.cannotPerformReason === "string"
      ? observation.cannotPerformReason
      : undefined;

  return {
    action,
    problemText: typeof raw.problemText === "string" ? raw.problemText : undefined,
    case: isDiagnosticCase(raw.case) ? raw.case : undefined,
    observation:
      intent || resultText || cannotPerformReason
        ? { intent, resultText, cannotPerformReason }
        : undefined,
  };
}

/** Internal pipeline detail never reaches the client — only the server log. */
async function runPipeline(run: () => Promise<unknown>): Promise<Response> {
  try {
    return Response.json(await run());
  } catch (error) {
    if (error instanceof ObservationConflictError) {
      console.warn("[diagnose] observation conflict", error);
      return Response.json(
        { error: OBSERVATION_CONFLICT_MESSAGE },
        { status: 409 },
      );
    }
    console.error("[diagnose] diagnostic pipeline failed", error);
    return Response.json(
      { error: DIAGNOSTIC_UNAVAILABLE_MESSAGE },
      { status: 503 },
    );
  }
}

export async function POST(request: Request) {
  let body: DiagnoseRequest;
  try {
    body = parseBody(await request.json());
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Zahtjev nije valjan JSON";
    return Response.json({ error: message }, { status: 400 });
  }

  const engine = new LlmDiagnosticEngine();

  if (body.action === "start") {
    const problemText = body.problemText?.trim();
    if (!problemText) {
      return Response.json(
        { error: "problemText je obavezan kad je action start" },
        { status: 400 },
      );
    }
    return runPipeline(() => engine.startCase(problemText));
  }

  const diagnosticCase = body.case;
  if (!diagnosticCase) {
    return Response.json(
      { error: "case je obavezan kad je action continue" },
      { status: 400 },
    );
  }

  const resultText = body.observation?.resultText?.trim();
  const intent = body.observation?.intent;
  if (!intent && !resultText) {
    return Response.json(
      { error: "observation.resultText je obavezan kad je action continue" },
      { status: 400 },
    );
  }
  if (intent === "SUBMIT_RESULT" && !resultText) {
    return Response.json(
      { error: "observation.resultText je obavezan za SUBMIT_RESULT" },
      { status: 400 },
    );
  }

  return runPipeline(() =>
    engine.continueCase(diagnosticCase, {
      intent,
      resultText,
      cannotPerformReason: body.observation?.cannotPerformReason,
    }),
  );
}
