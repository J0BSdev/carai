"use client";

import type { CaseSummary } from "@/app/actions/cases";

type CaseHistoryProps = {
  configured: boolean;
  signedIn: boolean;
  loading: boolean;
  error: string | null;
  cases: CaseSummary[];
  openingId: string | null;
  onOpen: (id: string) => void;
  onSignIn: () => void;
};

function titleOf(problemText: string): string {
  const text = problemText.trim();
  return text || "Fotografija";
}

function when(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("hr-HR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function CaseHistory({
  configured,
  signedIn,
  loading,
  error,
  cases,
  openingId,
  onOpen,
  onSignIn,
}: CaseHistoryProps) {
  return (
    <section className="mx-auto w-full max-w-2xl px-4 py-8 sm:px-6">
      <p className="text-xs font-semibold tracking-[0.16em] text-[var(--accent)]">
        POVIJEST
      </p>
      <h1 className="mt-2 text-2xl font-semibold">Spremljeni slučajevi</h1>

      {!configured && (
        <p className="mt-4 text-sm text-[var(--muted-strong)]">
          Baza nije konfigurirana. Dijagnoza i dalje radi u ovom pregledniku.
        </p>
      )}

      {configured && !signedIn && (
        <div className="mt-4">
          <p className="text-sm text-[var(--muted-strong)]">
            Prijavi se da vidiš slučajeve spremljene na račun.
          </p>
          <button
            type="button"
            onClick={onSignIn}
            className="mt-3 min-h-11 rounded-xl border border-[var(--border-strong)] px-4 text-sm"
          >
            Prijava
          </button>
        </div>
      )}

      {error && (
        <p role="alert" className="mt-4 text-sm text-[var(--danger)]">
          {error}
        </p>
      )}

      {signedIn && loading && (
        <p className="mt-4 text-sm text-[var(--muted)]">Učitavam slučajeve…</p>
      )}

      {signedIn && !loading && cases.length === 0 && !error && (
        <p className="mt-4 text-sm text-[var(--muted-strong)]">
          Još nema spremljenih slučajeva.
        </p>
      )}

      {signedIn && cases.length > 0 && (
        <ul className="mt-4 flex flex-col gap-2">
          {cases.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => onOpen(item.id)}
                disabled={openingId != null}
                className="surface-2 flex min-h-16 w-full items-center justify-between gap-3 rounded-2xl px-4 py-3 text-left disabled:opacity-35"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">
                    {titleOf(item.problemText)}
                  </span>
                  <span className="mt-1 block text-xs text-[var(--muted)]">
                    {when(item.updatedAt)}
                  </span>
                </span>
                <span className="shrink-0 text-xs text-[var(--accent)]">
                  {openingId === item.id ? "Otvaram…" : "Otvori"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
