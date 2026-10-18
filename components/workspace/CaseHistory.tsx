"use client";

import { useState } from "react";
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

function isHighConfidenceFault(item: CaseSummary): boolean {
  return (
    item.diagnosisCertainty === "CONFIRMED" ||
    item.diagnosisCertainty === "HIGH_CONFIDENCE"
  );
}

function vehicleTitle(item: CaseSummary): string {
  const parts = [
    item.vehicleMake?.trim(),
    item.vehicleModel?.trim(),
    item.vehicleEngine?.trim(),
    item.vehicleYear != null ? String(item.vehicleYear) : "",
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : "Nepoznato vozilo";
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

function CaseCard({
  item,
  expanded,
  openingId,
  onToggle,
  onOpen,
  showFaultOnCard,
}: {
  item: CaseSummary;
  expanded: boolean;
  openingId: string | null;
  onToggle: () => void;
  onOpen: (id: string) => void;
  showFaultOnCard: boolean;
}) {
  return (
    <li className="surface-2 rounded-2xl">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full items-start justify-between gap-3 px-4 py-3 text-left"
      >
        <span className="min-w-0">
          <span className="block text-sm font-medium text-[var(--foreground)]">
            {vehicleTitle(item)}
          </span>
          {showFaultOnCard && item.confirmedFault ? (
            <span className="mt-1 block text-xs text-[var(--muted-strong)]">
              {item.confirmedFault}
            </span>
          ) : null}
        </span>
        <span className="shrink-0 text-xs text-[var(--muted)]">
          {when(item.updatedAt)}
        </span>
      </button>

      {expanded && (
        <div className="border-t border-[var(--border)] px-4 py-3">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
            {item.vehicleMake ? (
              <Field label="Marka" value={item.vehicleMake} />
            ) : null}
            {item.vehicleModel ? (
              <Field label="Model" value={item.vehicleModel} />
            ) : null}
            {item.vehicleYear != null ? (
              <Field label="Godina" value={String(item.vehicleYear)} />
            ) : null}
            {item.vehicleEngine ? (
              <Field label="Motor" value={item.vehicleEngine} />
            ) : null}
            <Field label="Opis problema" value={shown(item.problemText)} wide />
            <Field
              label="Utvrđeni kvar"
              value={shown(item.confirmedFault)}
              wide
            />
            <Field
              label="Pouzdanost (diagnosisCertainty)"
              value={shown(item.diagnosisCertainty)}
            />
            <Field label="Status" value={statusLabel(item.status)} />
          </dl>
          <button
            type="button"
            onClick={() => onOpen(item.id)}
            disabled={openingId != null}
            className="mt-3 min-h-11 rounded-xl border border-[var(--border)] px-3 text-sm text-[var(--accent)] disabled:opacity-35"
          >
            {openingId === item.id ? "Otvaram…" : "Otvori dijagnostiku"}
          </button>
        </div>
      )}
    </li>
  );
}

function CaseSection({
  title,
  cases,
  empty,
  expandedId,
  openingId,
  onToggle,
  onOpen,
  showFaultOnCard,
}: {
  title: string;
  cases: CaseSummary[];
  empty: string;
  expandedId: string | null;
  openingId: string | null;
  onToggle: (id: string) => void;
  onOpen: (id: string) => void;
  showFaultOnCard: boolean;
}) {
  return (
    <section className="mt-8">
      <h2 className="text-xs font-semibold tracking-[0.16em] text-[var(--muted)]">
        {title}
      </h2>
      {cases.length === 0 ? (
        <p className="mt-3 text-sm text-[var(--muted-strong)]">{empty}</p>
      ) : (
        <ul className="mt-3 flex flex-col gap-3">
          {cases.map((item) => (
            <CaseCard
              key={item.id}
              item={item}
              expanded={expandedId === item.id}
              openingId={openingId}
              onToggle={() => onToggle(item.id)}
              onOpen={onOpen}
              showFaultOnCard={showFaultOnCard}
            />
          ))}
        </ul>
      )}
    </section>
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
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const highConfidence = cases.filter(isHighConfidenceFault);
  const other = cases.filter((item) => !isHighConfidenceFault(item));

  function toggle(id: string) {
    setExpandedId((current) => (current === id ? null : id));
  }

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
        <>
          <CaseSection
            title="POTVRĐENI I VISOKOPOUZDANI KVAROVI"
            cases={highConfidence}
            empty="Nema potvrđenih ni visokopouzdanih kvarova."
            expandedId={expandedId}
            openingId={openingId}
            onToggle={toggle}
            onOpen={onOpen}
            showFaultOnCard
          />
          <CaseSection
            title="NEPOTVRĐENI I NEDOVRŠENI SLUČAJEVI"
            cases={other}
            empty="Nema nepotvrđenih ni nedovršenih slučajeva."
            expandedId={expandedId}
            openingId={openingId}
            onToggle={toggle}
            onOpen={onOpen}
            showFaultOnCard={false}
          />
        </>
      )}
    </section>
  );
}
