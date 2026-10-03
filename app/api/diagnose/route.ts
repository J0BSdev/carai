import {
  DIAGNOSTIC_UNAVAILABLE_MESSAGE,
  InvalidObservationError,
  OBSERVATION_CONFLICT_MESSAGE,
  ObservationConflictError,
  type DiagnoseRequest,
  type DiagnosticCase,
} from "@/lib/diagnosis";
import { LlmDiagnosticEngine } from "@/lib/diagnosis/llm-engine";
import {
  parseObservationInput,
  parseStoredObservation,
} from "@/lib/diagnosis/observation";

function isDiagnosticCase(value: unknown): value is DiagnosticCase {
  if (!value || typeof value !== "object") return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.id === "string" &&
    typeof c.createdAt === "string" &&
    typeof c.problemText === "string" &&
    Array.isArray(c.observations) &&
    Array.isArray(c.steps)
  );
}

function parseCase(value: unknown): DiagnosticCase {
  if (!isDiagnosticCase(value)) {
    throw new Error("case nije valjan");
  }
  return {
    ...value,
    observations: value.observations.map(parseStoredObservation),
  };
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

  return {
    action,
    problemText: typeof raw.problemText === "string" ? raw.problemText : undefined,
    case: raw.case === undefined ? undefined : parseCase(raw.case),
    observation:
      raw.observation === undefined
        ? undefined
        : parseObservationInput(raw.observation),
  };
}

/** Internal pipeline detail never reaches the client — only the server log. */
async function runPipeline(run: () => Promise<unknown>): Promise<Response> {
  try {
    return Response.json(await run());
  } catch (error) {
    if (error instanceof InvalidObservationError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
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

  const observation = body.observation;
  if (!observation) {
    return Response.json(
      { error: "observation je obavezan kad je action continue" },
      { status: 400 },
    );
  }

  return runPipeline(() => engine.continueCase(diagnosticCase, observation));
}
