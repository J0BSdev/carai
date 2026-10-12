"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import type { DiagnosticStep, TurnImage } from "@/lib/diagnosis";
import { fileToTurnImage } from "@/lib/diagnosis/turn-image";
import ResponsiveOverlay from "@/components/ui/ResponsiveOverlay";
import PhotoAttach from "@/components/workspace/PhotoAttach";

type ResultModalProps = {
  open: boolean;
  onClose: () => void;
  step: DiagnosticStep;
  onSubmit: (result: string, image?: TurnImage) => void;
};

export default function ResultModal({
  open,
  onClose,
  step,
  onSubmit,
}: ResultModalProps) {
  const [text, setText] = useState("");
  const [stepId, setStepId] = useState(step.id);
  const [photoKey, setPhotoKey] = useState(0);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const photoRef = useRef<File | null>(null);
  const onPhoto = useCallback((file: File | null) => {
    photoRef.current = file;
    if (file) setPhotoError(null);
  }, []);
  if (step.id !== stepId) {
    setStepId(step.id);
    setText("");
    setPhotoError(null);
  }

  const title = step.content.split(/[.\n]/)[0]?.trim() || "Rezultat testa";

  const quick = useMemo(() => {
    if (step.actionType === "ASK") return ["Da", "Ne", "Nisam siguran"];
    return ["Ispravno", "Neispravno", "Nisam mogao utvrditi"];
  }, [step.actionType]);

  function reset() {
    setText("");
    setPhotoKey((key) => key + 1);
  }

  function handleClose() {
    reset();
    onClose();
  }

  async function submit(extra?: string) {
    const payload = extra ?? (text.trim() || null);
    if (!payload) return;
    const file = photoRef.current;
    try {
      const image = file ? await fileToTurnImage(file) : undefined;
      if (photoRef.current !== file) return;
      setPhotoError(null);
      onSubmit(payload, image);
      reset();
    } catch (err) {
      setPhotoError(err instanceof Error ? err.message : "Slika nije valjana.");
    }
  }

  return (
    <ResponsiveOverlay open={open} onClose={handleClose} title="Rezultat testa">
      <p className="text-sm text-[var(--muted-strong)]">{title}</p>
      <p className="mt-1 text-xs text-[var(--muted)]">Što si pronašao?</p>

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={4}
        className="mt-4 w-full resize-y rounded-2xl border border-[var(--border)] bg-black/25 px-3 py-3 text-base outline-none focus:border-[var(--accent)]"
        placeholder="Opiši rezultat ili što si primijetio…"
      />

      <div className="mt-4">
        <p className="text-xs font-medium tracking-wide text-[var(--muted)]">
          BRZI REZULTATI
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          {quick.map((q) => (
            <button
              key={q}
              type="button"
              onClick={() => void submit(q)}
              className="min-h-11 rounded-xl border border-[var(--border)] px-3 text-sm text-[var(--muted-strong)] transition hover:border-[var(--accent)]/40 hover:text-[var(--foreground)]"
            >
              {q}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4 flex flex-col gap-2">
        <button
          type="button"
          disabled
          className="min-h-11 rounded-xl border border-dashed border-[var(--border)] px-3 text-left text-sm text-[var(--muted)]"
        >
          + Dodaj mjerenje (uskoro)
        </button>
        <PhotoAttach key={`${step.id}-${photoKey}`} onChange={onPhoto} />
        {photoError ? (
          <p role="alert" className="text-sm text-[var(--danger)]">
            {photoError}
          </p>
        ) : null}
      </div>

      <button
        type="button"
        onClick={() => void submit()}
        disabled={!text.trim()}
        className="mt-5 flex min-h-12 w-full items-center justify-center rounded-2xl bg-[var(--accent)] text-base font-semibold text-[#061018] disabled:opacity-35"
      >
        POŠALJI REZULTAT →
      </button>
    </ResponsiveOverlay>
  );
}
