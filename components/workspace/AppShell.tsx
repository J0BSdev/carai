"use client";

import type { ReactNode } from "react";

type NavKey = "chat" | "active" | "history" | "settings";

type AppShellProps = {
  children: ReactNode;
  collapsed: boolean;
  onToggleCollapse: () => void;
  activeNav: NavKey;
  onNavigate: (key: NavKey) => void;
  hasActiveCase: boolean;
  caseElapsed?: string;
  topRight?: ReactNode;
};

export default function AppShell({
  children,
  collapsed,
  onToggleCollapse,
  activeNav,
  onNavigate,
  hasActiveCase,
  caseElapsed,
  topRight,
}: AppShellProps) {
  return (
    <div className="app-bg flex min-h-full flex-1">
      {/* Desktop sidebar */}
      <aside
        className={`surface-1 sticky top-0 hidden h-screen shrink-0 flex-col border-r border-[var(--border)] transition-[width] duration-200 lg:flex ${
          collapsed ? "w-[72px]" : "w-[220px]"
        }`}
      >
        <div className={`flex items-center gap-2 px-4 py-4 ${collapsed ? "justify-center" : ""}`}>
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-[var(--accent-soft)] text-sm font-bold text-[var(--accent)]">
            C
          </span>
          {!collapsed && (
            <div>
              <p className="text-sm font-semibold">CarAI</p>
              <p className="text-[11px] text-[var(--muted)]">Workspace</p>
            </div>
          )}
        </div>

        <nav className="flex flex-1 flex-col gap-1 px-2">
          <NavBtn
            active={activeNav === "chat"}
            collapsed={collapsed}
            label="Chat"
            onClick={() => onNavigate("chat")}
            icon={<ChatIcon />}
          />
          <NavBtn
            active={activeNav === "active"}
            collapsed={collapsed}
            label="Dijagnostika"
            onClick={() => onNavigate("active")}
            icon={<PulseIcon />}
            disabled={!hasActiveCase}
          />
          <NavBtn
            active={activeNav === "history"}
            collapsed={collapsed}
            label="Povijest"
            onClick={() => onNavigate("history")}
            icon={<ClockIcon />}
          />
          <NavBtn
            active={activeNav === "settings"}
            collapsed={collapsed}
            label="Postavke"
            onClick={() => onNavigate("settings")}
            icon={<GearIcon />}
          />
        </nav>

        <button
          type="button"
          onClick={onToggleCollapse}
          className="m-3 flex min-h-11 items-center justify-center rounded-xl border border-[var(--border)] text-xs text-[var(--muted)] transition hover:bg-white/5"
        >
          {collapsed ? "»" : "« Sažmi"}
        </button>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex items-center justify-between gap-3 border-b border-[var(--border)] bg-[rgba(7,10,14,0.82)] px-4 py-3 backdrop-blur-md sm:px-6">
          <div className="min-w-0 lg:hidden">
            <p className="text-sm font-semibold">CarAI</p>
            <p className="truncate text-xs text-[var(--muted)]">
              {hasActiveCase
                ? `Dijagnostika${caseElapsed ? ` · ${caseElapsed}` : ""}`
                : "Chat · dijagnostika"}
            </p>
          </div>
          <div className="hidden min-w-0 lg:block">
            <p className="text-sm text-[var(--muted)]">
              {hasActiveCase
                ? `Aktivna dijagnostika${caseElapsed ? ` · ${caseElapsed}` : ""}`
                : "Slobodni chat"}
            </p>
          </div>
          <div className="flex items-center gap-2">{topRight}</div>
        </header>

        <div className="flex-1">{children}</div>

        {/* Mobile bottom nav */}
        <nav className="surface-3 sticky bottom-0 z-30 flex border-t border-[var(--border)] px-2 py-2 lg:hidden pb-[max(0.5rem,env(safe-area-inset-bottom))]">
          <MobileNav
            active={activeNav === "chat"}
            label="Chat"
            onClick={() => onNavigate("chat")}
            icon={<ChatIcon />}
          />
          <MobileNav
            active={activeNav === "active"}
            label="Dijagnoza"
            onClick={() => onNavigate("active")}
            icon={<PulseIcon />}
            disabled={!hasActiveCase}
          />
          <MobileNav
            active={activeNav === "history"}
            label="Povijest"
            onClick={() => onNavigate("history")}
            icon={<ClockIcon />}
          />
          <MobileNav
            active={activeNav === "settings"}
            label="Više"
            onClick={() => onNavigate("settings")}
            icon={<GearIcon />}
          />
        </nav>
      </div>
    </div>
  );
}

function NavBtn({
  active,
  collapsed,
  label,
  onClick,
  icon,
  disabled,
  future,
}: {
  active: boolean;
  collapsed: boolean;
  label: string;
  onClick: () => void;
  icon: ReactNode;
  disabled?: boolean;
  future?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={future ? `${label} (uskoro)` : label}
      className={`flex min-h-11 items-center gap-3 rounded-xl px-3 text-sm transition ${
        collapsed ? "justify-center" : ""
      } ${
        active
          ? "bg-[var(--accent-soft)] text-[var(--accent)]"
          : "text-[var(--muted-strong)] hover:bg-white/5"
      } disabled:cursor-not-allowed disabled:opacity-35`}
    >
      {icon}
      {!collapsed && (
        <span className="flex items-center gap-2">
          {label}
          {future && (
            <span className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-[var(--muted)]">
              uskoro
            </span>
          )}
        </span>
      )}
    </button>
  );
}

function MobileNav({
  active,
  label,
  onClick,
  icon,
  disabled,
  future,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  icon: ReactNode;
  disabled?: boolean;
  future?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex min-h-12 flex-1 flex-col items-center justify-center gap-0.5 rounded-xl text-[10px] ${
        active ? "text-[var(--accent)]" : "text-[var(--muted)]"
      } disabled:opacity-35`}
    >
      {icon}
      <span>
        {label}
        {future ? "*" : ""}
      </span>
    </button>
  );
}

function ChatIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M5 6.5A2.5 2.5 0 0 1 7.5 4h9A2.5 2.5 0 0 1 19 6.5v6A2.5 2.5 0 0 1 16.5 15H12l-4 3.5V15H7.5A2.5 2.5 0 0 1 5 12.5v-6Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}
function PulseIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M3 12h4l2-5 4 10 2-5h6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function ClockIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="1.8" />
      <path d="M12 8v5l3 2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}
function GearIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.8" />
      <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6L17 7M7 17l-1.4 1.4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}
