"use client";

import { useState } from "react";
import ResponsiveOverlay from "@/components/ui/ResponsiveOverlay";

const ITEMS = [
  { id: "obs", label: "Opažanje", ready: false },
  { id: "meas", label: "Mjerenje", ready: false },
  { id: "dtc", label: "DTC", ready: false },
  { id: "test", label: "Rezultat testa", ready: true },
  { id: "photo", label: "Fotografija", ready: false },
  { id: "note", label: "Bilješka", ready: false },
] as const;

type QuickAddMenuProps = {
  onEnterResult: () => void;
};

export default function QuickAddMenu({ onEnterResult }: QuickAddMenuProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Dodaj u slučaj"
        className="fixed bottom-24 right-4 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-[var(--accent)] text-xl font-semibold text-[#061018] shadow-[0_12px_40px_rgba(47,224,181,0.35)] transition active:scale-95 lg:bottom-8"
      >
        +
      </button>

      <ResponsiveOverlay
        open={open}
        onClose={() => setOpen(false)}
        title="Dodaj u slučaj"
      >
        <ul className="flex flex-col gap-2">
          {ITEMS.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                disabled={!item.ready}
                onClick={() => {
                  if (item.id === "test") {
                    setOpen(false);
                    onEnterResult();
                  }
                }}
                className="flex min-h-12 w-full items-center justify-between rounded-xl border border-[var(--border)] px-3 text-sm transition hover:bg-white/5 disabled:opacity-40"
              >
                <span>{item.label}</span>
                {!item.ready && (
                  <span className="text-xs text-[var(--muted)]">uskoro</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      </ResponsiveOverlay>
    </>
  );
}
