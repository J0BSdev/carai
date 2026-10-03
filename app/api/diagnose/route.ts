import {
  DIAGNOSTIC_UNAVAILABLE_MESSAGE,
  InvalidObservationError,
  OBSERVATION_CONFLICT_MESSAGE,
  ObservationConflictError,
  type DiagnoseRequest,
} from "@/lib/diagnosis";
import { parseDiagnosticCase } from "@/lib/diagnosis/case-parse";
import { LlmDiagnosticEngine } from "@/lib/diagnosis/llm-engine";
import { parseObservationInput } from "@/lib/diagnosis/observation";

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
    case: raw.case === undefined ? undefined : parseDiagnosticCase(raw.case),
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
    if (error instanceof ObservationConflictError) {
      return Response.json(
        { error: OBSERVATION_CONFLICT_MESSAGE },
        { status: 409 },
      );
    }
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
