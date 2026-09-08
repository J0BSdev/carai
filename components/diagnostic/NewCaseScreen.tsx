type NewCaseScreenProps = {
  value: string;
  onChange: (value: string) => void;
  onStart: () => void;
  loading: boolean;
  error: string | null;
};

export default function NewCaseScreen({
  value,
  onChange,
  onStart,
  loading,
  error,
}: NewCaseScreenProps) {
  return (
    <section className="mx-auto flex w-full max-w-[720px] flex-1 flex-col justify-center px-4 py-10 sm:px-6">
      <div className="anim-enter">
        <h1 className="text-3xl font-semibold tracking-tight text-[var(--foreground)] sm:text-4xl">
          Što nije u redu s vozilom?
        </h1>
        <p className="mt-3 text-base text-[var(--muted)]">
          Piši prirodno. DTC kodovi nisu obavezni.
        </p>

        {error && (
          <p
            role="alert"
            className="mt-5 rounded-xl border border-[var(--danger-border)] bg-[var(--danger-bg)] px-3 py-2 text-sm text-[var(--danger)]"
          >
            {error}
          </p>
        )}

        <div className="surface-card mt-8 p-2 sm:p-3">
          <textarea
            value={value}
            onChange={(e) => onChange(e.target.value)}
            rows={6}
            disabled={loading}
            placeholder="npr. Golf 7 GTD gubi snagu iznad 3000 o/min, P0299…"
            className="min-h-40 w-full resize-y rounded-xl bg-transparent px-3 py-3 text-base leading-relaxed text-[var(--foreground)] outline-none placeholder:text-[var(--muted)]"
          />
          <div className="mt-2 flex justify-end">
            <button
              type="button"
              onClick={onStart}
              disabled={loading || !value.trim()}
              className="min-h-12 rounded-xl bg-[var(--accent)] px-5 text-base font-semibold text-[#071018] transition active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-35"
            >
              {loading ? "Pokrećem…" : "Pokreni dijagnozu"}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
