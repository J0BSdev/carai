import { getDiagnosticEngine } from "@/lib/diagnosis";
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

export async function POST(request: Request) {
  try {
    const json = await request.json();
    const body = parseBody(json);
    const engine = getDiagnosticEngine();

    if (body.action === "start") {
      if (!body.problemText?.trim()) {
        return Response.json(
          { error: "problemText je obavezan kad je action start" },
          { status: 400 },
        );
      }

      const result = await engine.startCase(body.problemText);
      return Response.json(result);
    }

    if (!body.case) {
      return Response.json(
        { error: "case je obavezan kad je action continue" },
        { status: 400 },
      );
    }

    if (!body.observation?.resultText?.trim()) {
      return Response.json(
        {
          error: "observation.resultText je obavezan kad je action continue",
        },
        { status: 400 },
      );
    }

    const result = await engine.continueCase(
      body.case,
      body.observation.resultText,
    );
    return Response.json(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Obrada dijagnoze nije uspjela";
    return Response.json({ error: message }, { status: 400 });
  }
}
