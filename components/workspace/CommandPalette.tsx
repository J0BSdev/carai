"use client";

import { useMemo, useState } from "react";
import ResponsiveOverlay from "@/components/ui/ResponsiveOverlay";

type Command = {
  id: string;
  label: string;
  hint?: string;
  enabled: boolean;
  run: () => void;
};

type CommandPaletteProps = {
  open: boolean;
  onClose: () => void;
  commands: Command[];
};

export default function CommandPalette({
  open,
  onClose,
  commands,
}: CommandPaletteProps) {
  const [q, setQ] = useState("");
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return commands;
    return commands.filter((c) => c.label.toLowerCase().includes(needle));
  }, [commands, q]);

  function close() {
    setQ("");
    onClose();
  }

  return (
    <ResponsiveOverlay open={open} onClose={close} title="Naredbe" wide>
      {open && (
        <>
          <input
            key={open ? "open" : "closed"}
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Traži naredbu…"
            className="min-h-12 w-full rounded-2xl border border-[var(--border)] bg-black/25 px-3 text-base outline-none focus:border-[var(--accent)]"
          />
          <ul className="mt-3 max-h-80 overflow-y-auto">
            {filtered.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  disabled={!c.enabled}
                  onClick={() => {
                    c.run();
                    close();
                  }}
                  className="flex min-h-12 w-full items-center justify-between rounded-xl px-3 text-left text-sm transition hover:bg-white/5 disabled:opacity-35"
                >
                  <span>{c.label}</span>
                  <span className="text-xs text-[var(--muted)]">
                    {c.enabled ? c.hint ?? "" : "uskoro"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </ResponsiveOverlay>
  );
}
