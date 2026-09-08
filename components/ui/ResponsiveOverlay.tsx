"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";

type OverlayMode = "modal" | "sheet" | "drawer";

type ResponsiveOverlayProps = {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  preferDrawer?: boolean;
  wide?: boolean;
};

function useIsMobile(breakpoint = 768) {
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
    const apply = () => setMobile(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [breakpoint]);
  return mobile;
}

export default function ResponsiveOverlay({
  open,
  onClose,
  title,
  children,
  preferDrawer,
  wide,
}: ResponsiveOverlayProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const mobile = useIsMobile();

  const mode: OverlayMode = mobile
    ? "sheet"
    : preferDrawer
      ? "drawer"
      : "modal";

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panelRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="overlay-enter fixed inset-0 z-50 flex"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="absolute inset-0 bg-black/55 backdrop-blur-[2px]" />

      {mode === "modal" && (
        <div className="relative z-10 flex w-full items-end justify-center p-4 sm:items-center">
          <div
            ref={panelRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            className={`panel-enter surface-3 w-full rounded-[var(--radius-lg)] p-4 sm:p-5 ${
              wide ? "max-w-2xl" : "max-w-lg"
            }`}
          >
            <OverlayHeader titleId={titleId} title={title} onClose={onClose} />
            <div className="mt-4">{children}</div>
          </div>
        </div>
      )}

      {mode === "sheet" && (
        <div className="relative z-10 mt-auto flex w-full justify-center">
          <div
            ref={panelRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            className="sheet-enter surface-3 max-h-[88vh] w-full overflow-y-auto rounded-t-[var(--radius-lg)] p-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:max-w-lg sm:rounded-[var(--radius-lg)]"
          >
            <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-white/15 sm:hidden" />
            <OverlayHeader titleId={titleId} title={title} onClose={onClose} />
            <div className="mt-4">{children}</div>
          </div>
        </div>
      )}

      {mode === "drawer" && (
        <div className="relative z-10 ml-auto flex h-full w-full max-w-md">
          <div
            ref={panelRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            className="drawer-enter surface-3 flex h-full w-full flex-col overflow-y-auto rounded-l-[var(--radius-lg)] p-5"
          >
            <OverlayHeader titleId={titleId} title={title} onClose={onClose} />
            <div className="mt-4 flex-1">{children}</div>
          </div>
        </div>
      )}
    </div>
  );
}

function OverlayHeader({
  titleId,
  title,
  onClose,
}: {
  titleId: string;
  title: string;
  onClose: () => void;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <h2 id={titleId} className="text-lg font-semibold tracking-tight">
        {title}
      </h2>
      <button
        type="button"
        onClick={onClose}
        aria-label="Zatvori"
        className="flex h-11 w-11 items-center justify-center rounded-xl text-[var(--muted)] transition hover:bg-white/5 hover:text-[var(--foreground)]"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path
            d="M6 6l12 12M18 6L6 18"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
        </svg>
      </button>
    </div>
  );
}
