import { authorizeUsage, usageDeniedResponse } from "@/lib/access";
import { DIAGNOSTIC_UNAVAILABLE_MESSAGE } from "@/lib/diagnosis/errors";
import {
  ChatAiError,
  ChatConflictError,
  ChatError,
  chatSend,
} from "@/lib/chat/server-chat";

function parseBody(body: unknown): {
  conversationId?: string;
  message: string;
} {
  if (!body || typeof body !== "object") {
    throw new ChatError("Tijelo zahtjeva mora biti JSON objekt");
  }
  const raw = body as Record<string, unknown>;
  const message = typeof raw.message === "string" ? raw.message : "";
  const conversationId =
    typeof raw.conversationId === "string" && raw.conversationId.trim()
      ? raw.conversationId.trim()
      : undefined;
  return { conversationId, message };
}

export async function POST(request: Request) {
  const access = await authorizeUsage(request.headers.get("host"));
  if (!access.ok) return usageDeniedResponse(access.reason);

  let parsed: { conversationId?: string; message: string };
  try {
    parsed = parseBody(await request.json());
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Zahtjev nije valjan JSON";
    return Response.json({ error: message }, { status: 400 });
  }

  try {
    const conversation = await chatSend({
      conversationId: parsed.conversationId,
      message: parsed.message,
      access,
    });
    return Response.json({ conversation });
  } catch (error) {
    if (error instanceof ChatError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof ChatConflictError) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof ChatAiError) {
      console.error("[chat] ai failed", error.message);
      return Response.json(
        {
          error: DIAGNOSTIC_UNAVAILABLE_MESSAGE,
          conversation: error.conversation,
        },
        { status: 503 },
      );
    }
    console.error("[chat] failed", error);
    return Response.json(
      { error: DIAGNOSTIC_UNAVAILABLE_MESSAGE },
      { status: 503 },
    );
  }
}
