import {
  DIAGNOSTIC_UNAVAILABLE_MESSAGE,
  InvalidObservationError,
  OBSERVATION_CONFLICT_MESSAGE,
  ObservationConflictError,
  type DiagnoseRequest,
} from "@/lib/diagnosis";
import { parseObservationInput } from "@/lib/diagnosis/observation";
import {
  CaseConflictError,
  CaseNotFoundError,
  CasePersistError,
  diagnoseContinue,
  diagnoseStart,
} from "@/lib/diagnosis/server-diagnose";
import { parseTurnImage } from "@/lib/diagnosis/turn-image";
import { authorizeUsage, usageDeniedResponse } from "@/lib/access";

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
    caseId: typeof raw.caseId === "string" ? raw.caseId : undefined,
    stepId: typeof raw.stepId === "string" ? raw.stepId : undefined,
    observation:
      raw.observation === undefined
        ? undefined
        : parseObservationInput(raw.observation),
    image: parseTurnImage(raw.image),
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
    if (error instanceof CaseNotFoundError) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof CaseConflictError) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof CasePersistError) {
      console.error("[diagnose] persist failed", error);
      return Response.json({ error: error.message }, { status: 503 });
    }
    console.error("[diagnose] diagnostic pipeline failed", error);
    return Response.json(
      { error: DIAGNOSTIC_UNAVAILABLE_MESSAGE },
      { status: 503 },
    );
  }
}

export async function POST(request: Request) {
  const access = await authorizeUsage(request.headers.get("host"));
  if (!access.ok) return usageDeniedResponse(access.reason);

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

  if (body.action === "start") {
    const problemText =
      typeof body.problemText === "string" ? body.problemText.trim() : "";
    if (!problemText && !body.image) {
      return Response.json(
        { error: "Potreban je opis ili fotografija" },
        { status: 400 },
      );
    }
    return runPipeline(() => diagnoseStart(problemText, body.image, access));
  }

  const caseId = body.caseId?.trim();
  const stepId = body.stepId?.trim();
  if (!caseId) {
    return Response.json(
      { error: "caseId je obavezan kad je action continue" },
      { status: 400 },
    );
  }
  if (!stepId) {
    return Response.json(
      { error: "stepId je obavezan kad je action continue" },
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

  return runPipeline(() =>
    diagnoseContinue({
      caseId,
      stepId,
      observation,
      image: body.image,
      access,
    }),
  );
}
