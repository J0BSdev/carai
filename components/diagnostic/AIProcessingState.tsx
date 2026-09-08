"use client";

import { useEffect, useState } from "react";
import { THINKING_MESSAGES } from "@/lib/diagnosis/ui-helpers";

type AIProcessingStateProps = {
  active: boolean;
};

export default function AIProcessingState({ active }: AIProcessingStateProps) {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => {
      setIndex((i) => (i + 1) % THINKING_MESSAGES.length);
    }, 1800);
    return () => window.clearInterval(id);
  }, [active]);

  if (!active) return null;

  const message = THINKING_MESSAGES[index % THINKING_MESSAGES.length];

  return (
    <div
      className="surface-card anim-enter flex items-center gap-3 px-4 py-4"
      role="status"
      aria-live="polite"
    >
      <span
        className="anim-pulse-soft h-2.5 w-2.5 rounded-full bg-[var(--accent)] shadow-[0_0_12px_var(--accent-glow)]"
        aria-hidden
      />
      <div>
        <p className="text-sm font-medium text-[var(--foreground)]">{message}</p>
        <p className="mt-0.5 text-xs text-[var(--muted)]">
          Čekam sljedeću dijagnostičku akciju
        </p>
      </div>
    </div>
  );
}
