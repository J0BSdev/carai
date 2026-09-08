"use client";

type DiagnosticInputProps = {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  disabled?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
};

export default function DiagnosticInput({
  value,
  onChange,
  onSubmit,
  disabled,
  placeholder = "Unesi rezultat ili opiši što si pronašao…",
  autoFocus,
}: DiagnosticInputProps) {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-40 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-8 sm:px-6">
      <div className="pointer-events-auto mx-auto w-full max-w-[720px]">
        <div className="rounded-2xl border border-[var(--border-strong)] bg-[rgba(17,22,29,0.92)] p-2 shadow-[0_-8px_40px_rgba(0,0,0,0.45)] backdrop-blur-xl">
          <div className="flex items-end gap-2">
            <div className="flex gap-1 pb-1 pl-1">
              <span
                className="flex h-10 w-10 items-center justify-center rounded-xl text-[var(--muted)]"
                title="Tipkovnica"
                aria-hidden
              >
                <KeyboardIcon />
              </span>
              <span
                className="flex h-10 w-10 items-center justify-center rounded-xl text-[var(--muted)] opacity-50"
                title="Mikrofon (uskoro)"
                aria-hidden
              >
                <MicIcon />
              </span>
              <span
                className="flex h-10 w-10 items-center justify-center rounded-xl text-[var(--muted)] opacity-50"
                title="Kamera (uskoro)"
                aria-hidden
              >
                <CameraIcon />
              </span>
            </div>

            <textarea
              value={value}
              onChange={(e) => onChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  if (!disabled && value.trim()) onSubmit();
                }
              }}
              rows={2}
              autoFocus={autoFocus}
              disabled={disabled}
              placeholder={placeholder}
              className="max-h-32 min-h-[52px] flex-1 resize-none bg-transparent px-2 py-3 text-base leading-relaxed text-[var(--foreground)] outline-none placeholder:text-[var(--muted)]"
            />

            <button
              type="button"
              onClick={onSubmit}
              disabled={disabled || !value.trim()}
              aria-label="Nastavi"
              className="mb-1 flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-[var(--accent)] text-[#071018] transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-35"
            >
              <ArrowIcon />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function KeyboardIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="2" y="6" width="20" height="12" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function MicIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="9" y="3" width="6" height="11" rx="3" stroke="currentColor" strokeWidth="1.6" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function CameraIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M4 8h3l2-2h6l2 2h3v11H4V8Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <circle cx="12" cy="13" r="3.5" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
