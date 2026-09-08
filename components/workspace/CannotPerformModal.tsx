"use client";

import { useState } from "react";
import ResponsiveOverlay from "@/components/ui/ResponsiveOverlay";

const REASONS = [
  "Nemam opremu",
  "Otežan pristup vozilu",
  "Test bi predugo trajao",
  "Ne znam kako",
  "Ostalo",
] as const;

type CannotPerformModalProps = {
  open: boolean;
  onClose: () => void;
  onSubmit: (reason: string) => void;
};

export default function CannotPerformModal({
  open,
  onClose,
  onSubmit,
}: CannotPerformModalProps) {
  const [reason, setReason] = useState<string>(REASONS[0]);

  return (
    <ResponsiveOverlay
      open={open}
      onClose={onClose}
      title="Ne mogu izvesti ovaj test"
    >
      <p className="text-sm text-[var(--muted)]">Zašto?</p>
      <ul className="mt-3 flex flex-col gap-2">
        {REASONS.map((r) => (
          <li key={r}>
            <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border border-[var(--border)] px-3 transition hover:bg-white/5">
              <input
                type="radio"
                name="cant-reason"
                checked={reason === r}
                onChange={() => setReason(r)}
                className="accent-[var(--accent)]"
              />
              <span className="text-sm">{r}</span>
            </label>
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={() => {
          onSubmit(`Ne mogu izvesti test: ${reason}`);
          onClose();
        }}
        className="mt-5 flex min-h-12 w-full items-center justify-center rounded-2xl bg-[var(--accent)] text-sm font-semibold text-[#061018]"
      >
        NAĐI DRUGI TEST
      </button>
    </ResponsiveOverlay>
  );
}
