"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { deleteChat, listChats, loadChat } from "@/app/actions/chats";
import { diagnosisHandoffText } from "@/lib/chat/handoff";
import type { ChatConversation, ChatMessage, ChatSummary } from "@/lib/chat/types";
import VoiceNote from "@/components/workspace/VoiceNote";

type ChatScreenProps = {
  signedIn: boolean;
  persistenceConfigured: boolean;
  onStartDiagnosis: (problemText: string) => void;
};

export default function ChatScreen({
  signedIn,
  persistenceConfigured,
  onStartDiagnosis,
}: ChatScreenProps) {
  const [conversation, setConversation] = useState<ChatConversation | null>(
    null,
  );
  const [summaries, setSummaries] = useState<ChatSummary[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [listLoading, setListLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef(input);
  const conversationIdRef = useRef<string | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    inputRef.current = input;
  }, [input]);

  useEffect(() => {
    conversationIdRef.current =
      conversation?.id && conversation.id !== "pending"
        ? conversation.id
        : null;
  }, [conversation?.id]);

  const refreshList = useCallback(async () => {
    setListLoading(true);
    const result = await listChats();
    setListLoading(false);
    if (result.ok) setSummaries(result.data);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void listChats().then((result) => {
      if (cancelled || !result.ok) return;
      setSummaries(result.data);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [conversation?.messages.length, loading]);

  async function openConversation(id: string) {
    setError(null);
    const result = await loadChat(id);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setConversation(result.data);
    setSidebarOpen(false);
  }

  function startNew() {
    setConversation(null);
    conversationIdRef.current = null;
    setInput("");
    setError(null);
    setSidebarOpen(false);
  }

  async function removeConversation(id: string) {
    const result = await deleteChat(id);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    if (conversation?.id === id) startNew();
    void refreshList();
  }

  async function sendMessage(raw?: string) {
    const text = (raw ?? input).trim();
    if (!text || inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    setError(null);
    setInput("");

    const optimisticUser: ChatMessage = {
      id: `local-${crypto.randomUUID()}`,
      role: "user",
      content: text,
      createdAt: new Date().toISOString(),
    };
    const existingId = conversationIdRef.current;

    setConversation((prev) => {
      if (!prev) {
        return {
          id: "pending",
          title: "Novi razgovor",
          messages: [optimisticUser],
          createdAt: optimisticUser.createdAt,
          updatedAt: optimisticUser.createdAt,
          revision: 0,
        };
      }
      const last = prev.messages[prev.messages.length - 1];
      // Mirror server: replace a lone user turn (retry after AI failure).
      if (last?.role === "user") {
        return {
          ...prev,
          messages: [...prev.messages.slice(0, -1), optimisticUser],
        };
      }
      return { ...prev, messages: [...prev.messages, optimisticUser] };
    });

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          ...(existingId ? { conversationId: existingId } : {}),
        }),
      });
      const data = (await response.json()) as {
        conversation?: ChatConversation;
        error?: string;
      };

      if (data.conversation) {
        setConversation(data.conversation);
        conversationIdRef.current = data.conversation.id;
        void refreshList();
      }

      if (!response.ok) {
        throw new Error(
          typeof data.error === "string" ? data.error : "Zahtjev nije uspio",
        );
      }
      if (!data.conversation) {
        throw new Error("Zahtjev nije uspio");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Slanje nije uspjelo");
      setInput(text);
      // Drop optimistic-only pending if the server never persisted a conversation.
      if (!conversationIdRef.current) {
        setConversation(null);
      }
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }

  function handleStartDiagnosis() {
    const handoff = conversation
      ? diagnosisHandoffText(conversation.messages)
      : "";
    onStartDiagnosis(handoff);
  }

  const messages = conversation?.messages ?? [];
  const empty = messages.length === 0 && !loading;

  return (
    <div className="mx-auto flex h-[calc(100dvh-7.5rem)] w-full max-w-6xl flex-col lg:h-[calc(100dvh-4.5rem)] lg:flex-row">
      <aside
        className={`surface-1 border-[var(--border)] lg:flex lg:w-64 lg:shrink-0 lg:flex-col lg:border-r ${
          sidebarOpen ? "flex flex-col border-b" : "hidden"
        }`}
      >
        <div className="flex items-center justify-between gap-2 px-3 py-3">
          <p className="text-xs font-semibold tracking-wide text-[var(--muted)]">
            RAZGOVORI
          </p>
          <button
            type="button"
            onClick={startNew}
            className="min-h-9 rounded-lg border border-[var(--border)] px-2 text-xs text-[var(--accent)]"
          >
            Novi
          </button>
        </div>
        {!signedIn && persistenceConfigured ? (
          <p className="px-3 pb-2 text-[11px] text-[var(--muted)]">
            Prijavi se za trajno spremanje razgovora.
          </p>
        ) : null}
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {listLoading && summaries.length === 0 ? (
            <p className="px-2 text-xs text-[var(--muted)]">Učitavam…</p>
          ) : null}
          {summaries.map((item) => (
            <div
              key={item.id}
              className={`group mb-1 flex items-stretch rounded-xl ${
                conversation?.id === item.id
                  ? "bg-[var(--accent-soft)]"
                  : "hover:bg-white/5"
              }`}
            >
              <button
                type="button"
                onClick={() => void openConversation(item.id)}
                className="min-w-0 flex-1 px-3 py-2 text-left"
              >
                <p className="truncate text-sm">{item.title}</p>
                {item.preview ? (
                  <p className="truncate text-[11px] text-[var(--muted)]">
                    {item.preview}
                  </p>
                ) : null}
              </button>
              <button
                type="button"
                title="Obriši"
                onClick={() => void removeConversation(item.id)}
                className="px-2 text-xs text-[var(--muted)] opacity-70 transition hover:opacity-100 lg:opacity-0 lg:group-hover:opacity-100"
              >
                ×
              </button>
            </div>
          ))}
          {!listLoading && summaries.length === 0 ? (
            <p className="px-2 text-xs text-[var(--muted)]">
              Nema spremljenih razgovora.
            </p>
          ) : null}
        </div>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between gap-2 border-b border-[var(--border)] px-4 py-3 sm:px-6">
          <div className="min-w-0">
            <button
              type="button"
              className="text-xs text-[var(--muted)] lg:hidden"
              onClick={() => setSidebarOpen((v) => !v)}
            >
              {sidebarOpen ? "Sakrij popis" : "Razgovori"}
            </button>
            <p className="truncate text-sm font-medium">
              {conversation?.title ?? "Novi razgovor"}
            </p>
          </div>
          <button
            type="button"
            onClick={handleStartDiagnosis}
            className="min-h-10 shrink-0 rounded-xl bg-[var(--accent-soft)] px-3 text-sm font-medium text-[var(--accent)] transition hover:brightness-110"
          >
            Pokreni dijagnostiku
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6">
          {empty ? (
            <div className="anim-in mx-auto flex max-w-xl flex-col justify-center py-12 text-center">
              <p className="text-sm font-semibold tracking-[0.18em] text-[var(--accent)]">
                CARAI
              </p>
              <h1 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
                Pitaj bilo što o vozilu
              </h1>
              <p className="mt-3 text-base text-[var(--muted-strong)]">
                Slobodan razgovor o simptomima, uzrocima i popravcima. Kad želiš
                strukturirane korake, pokreni dijagnostiku.
              </p>
              <div className="mt-8 flex flex-wrap justify-center gap-2">
                {[
                  "Motor treperi u praznom hodu",
                  "Što znači kod P0300?",
                  "Kako provjeriti naboj akumulatora?",
                ].map((hint) => (
                  <button
                    key={hint}
                    type="button"
                    disabled={loading}
                    onClick={() => void sendMessage(hint)}
                    className="rounded-full border border-[var(--border)] px-3 py-2 text-left text-sm text-[var(--muted-strong)] transition hover:border-[var(--border-strong)] hover:text-[var(--foreground)]"
                  >
                    {hint}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <ul className="mx-auto flex max-w-2xl flex-col gap-4">
              {messages.map((m) => (
                <li
                  key={m.id}
                  className={`anim-in flex ${
                    m.role === "user" ? "justify-end" : "justify-start"
                  }`}
                >
                  <div
                    className={`max-w-[92%] rounded-2xl px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap sm:max-w-[85%] ${
                      m.role === "user"
                        ? "bg-[var(--accent-soft)] text-[var(--foreground)]"
                        : "surface-2 border border-[var(--border)]"
                    }`}
                  >
                    {m.content}
                  </div>
                </li>
              ))}
              {loading ? (
                <li className="flex justify-start">
                  <div className="surface-2 rounded-2xl border border-[var(--border)] px-4 py-3 text-sm text-[var(--muted)]">
                    <span className="anim-pulse inline-block h-2 w-2 rounded-full bg-[var(--accent)]" />{" "}
                    Pišem odgovor…
                  </div>
                </li>
              ) : null}
              <div ref={bottomRef} />
            </ul>
          )}
        </div>

        {error ? (
          <p
            role="alert"
            className="mx-4 mb-2 rounded-xl border border-[var(--danger)]/40 bg-[var(--danger-soft)] px-3 py-2 text-sm text-[var(--danger)] sm:mx-6"
          >
            {error}
          </p>
        ) : null}

        <div className="border-t border-[var(--border)] px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6">
          <div className="surface-3 mx-auto flex max-w-2xl items-end gap-2 rounded-[var(--radius-lg)] p-2">
            <VoiceNote
              disabled={loading}
              onBusyChange={setVoiceBusy}
              onTranscript={(text) => {
                const prev = inputRef.current.trim();
                const next = prev ? `${prev}\n${text}` : text;
                inputRef.current = next;
                setInput(next);
              }}
            />
            <textarea
              value={input}
              rows={1}
              disabled={loading}
              placeholder="Pitaj o kvaru, dijelu ili postupku…"
              onChange={(e) => {
                inputRef.current = e.target.value;
                setInput(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void sendMessage();
                }
              }}
              className="max-h-36 min-h-11 flex-1 resize-none bg-transparent px-2 py-2.5 text-sm leading-relaxed outline-none placeholder:text-[var(--muted)]"
            />
            <button
              type="button"
              disabled={loading || voiceBusy || !input.trim()}
              onClick={() => void sendMessage()}
              className="min-h-11 shrink-0 rounded-xl bg-[var(--accent-soft)] px-4 text-sm font-medium text-[var(--accent)] disabled:opacity-35"
            >
              Pošalji
            </button>
          </div>
          <p className="mx-auto mt-2 max-w-2xl text-center text-[11px] text-[var(--muted)]">
            Chat nije potvrda kvara. Za strukturirane ASK/TEST korake koristi
            dijagnostiku.
          </p>
        </div>
      </div>
    </div>
  );
}
