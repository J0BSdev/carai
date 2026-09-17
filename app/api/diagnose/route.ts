import { DIAGNOSTIC_UNAVAILABLE_MESSAGE } from "@/lib/diagnosis";
import { LlmDiagnosticEngine } from "@/lib/diagnosis/llm-engine";
import type { DiagnoseRequest, DiagnosticCase } from "@/lib/diagnosis";

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
    case: isDiagnosticCase(raw.case) ? raw.case : undefined,
    observation:
      raw.observation &&
      typeof raw.observation === "object" &&
      typeof (raw.observation as Record<string, unknown>).resultText === "string"
        ? { resultText: (raw.observation as { resultText: string }).resultText }
        : undefined,
  };
}

/** Internal pipeline detail never reaches the client — only the server log. */
async function runPipeline(run: () => Promise<unknown>): Promise<Response> {
  try {
    return Response.json(await run());
  } catch (error) {
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
  if (!resultText) {
    return Response.json(
      { error: "observation.resultText je obavezan kad je action continue" },
      { status: 400 },
    );
  }

  return runPipeline(() => engine.continueCase(diagnosticCase, resultText));
}
