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

function shown(value: string | number | null): string {
  if (typeof value === "number") return String(value);
  const text = value?.trim();
  return text ? text : "—";
}

function statusLabel(status: CaseSummary["status"]): string {
  return status === "finished" ? "Završen" : "Aktivan";
}

function Field({
  label,
  value,
  wide,
}: {
  label: string;
  value: string;
  wide?: boolean;
}) {
  return (
    <div className={wide ? "col-span-2 sm:col-span-3" : "min-w-0"}>
      <dt className="text-[10px] font-semibold tracking-wide text-[var(--muted)]">
        {label}
      </dt>
      <dd className="mt-0.5 text-sm text-[var(--muted-strong)]">{value}</dd>
    </div>
  );
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
    <section className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
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
        <ul className="mt-4 flex flex-col gap-3">
          {cases.map((item) => (
            <li key={item.id} className="surface-2 rounded-2xl px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <span
                  className={`rounded-lg px-2 py-1 text-[10px] font-semibold tracking-wide ${
                    item.status === "finished"
                      ? "bg-white/5 text-[var(--muted)]"
                      : "bg-[var(--accent-soft)] text-[var(--accent)]"
                  }`}
                >
                  {statusLabel(item.status)}
                </span>
                <span className="text-xs text-[var(--muted)]">{when(item.updatedAt)}</span>
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
                <Field label="Marka" value={shown(item.vehicleMake)} />
                <Field label="Model" value={shown(item.vehicleModel)} />
                <Field label="Godina" value={shown(item.vehicleYear)} />
                <Field label="Motor" value={shown(item.vehicleEngine)} />
                <Field label="Opis problema" value={shown(item.problemText)} wide />
                <Field label="Utvrđeni kvar" value={shown(item.confirmedFault)} wide />
              </dl>
              <button
                type="button"
                onClick={() => onOpen(item.id)}
                disabled={openingId != null}
                className="mt-3 min-h-11 rounded-xl border border-[var(--border)] px-3 text-sm text-[var(--accent)] disabled:opacity-35"
              >
                {openingId === item.id ? "Otvaram…" : "Otvori"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
