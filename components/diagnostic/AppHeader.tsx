type AppHeaderProps = {
  showNewCase?: boolean;
  onNewCase?: () => void;
};

export default function AppHeader({ showNewCase, onNewCase }: AppHeaderProps) {
  return (
    <header className="sticky top-0 z-30 border-b border-[var(--border)] bg-[rgba(11,15,20,0.82)] backdrop-blur-md">
      <div className="mx-auto flex w-full max-w-[1100px] items-center justify-between gap-3 px-4 py-3 sm:px-6">
        <div className="min-w-0">
          <p className="text-base font-semibold tracking-tight text-[var(--foreground)]">
            CarAI
          </p>
          <p className="truncate text-xs text-[var(--muted)] sm:text-sm">
            AI dijagnostički copilot
          </p>
        </div>
        {showNewCase && onNewCase && (
          <button
            type="button"
            onClick={onNewCase}
            className="min-h-11 shrink-0 rounded-xl border border-[var(--border-strong)] bg-[var(--surface)] px-4 text-sm font-medium text-[var(--foreground)] transition active:scale-[0.98]"
          >
            Novi slučaj
          </button>
        )}
      </div>
    </header>
  );
}
