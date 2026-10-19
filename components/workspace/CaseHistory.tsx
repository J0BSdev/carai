"use client";

import { useState, type FormEvent } from "react";
import {
  saveManualResolvedFault,
  type CaseSummary,
} from "@/app/actions/cases";

type CaseHistoryProps = {
  configured: boolean;
  signedIn: boolean;
  loading: boolean;
  error: string | null;
  cases: CaseSummary[];
  openingId: string | null;
  onOpen: (id: string) => void;
  onSignIn: () => void;
  onRefresh: () => void;
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

function sourceLabel(source: CaseSummary["source"]): string {
  return source === "manual" ? "Ručno uneseno" : "CarAI dijagnostika";
}

function isHighConfidenceFault(item: CaseSummary): boolean {
  if (item.source === "manual") return true;
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
  accent,
}: {
  label: string;
  value: string;
  wide?: boolean;
  accent?: boolean;
}) {
  return (
    <div className={wide ? "col-span-2 sm:col-span-3" : "min-w-0"}>
      <dt className="text-[10px] font-semibold tracking-wide text-[var(--muted)]">
        {label}
      </dt>
      <dd
        className={`mt-0.5 text-sm ${
          accent ? "text-[var(--accent)]/70" : "text-[var(--muted-strong)]"
        }`}
      >
        {value}
      </dd>
    </div>
  );
}

function CaseCard({
  item,
  expanded,
  editing,
  openingId,
  onToggle,
  onOpen,
  onEdit,
  onCancelEdit,
  onSaved,
  showFaultOnCard,
}: {
  item: CaseSummary;
  expanded: boolean;
  editing: boolean;
  openingId: string | null;
  onToggle: () => void;
  onOpen: (id: string) => void;
  onEdit: () => void;
  onCancelEdit: () => void;
  onSaved: () => void;
  showFaultOnCard: boolean;
}) {
  const manual = item.source === "manual";

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
          <span
            className={`mt-1 block text-[10px] font-semibold tracking-wide ${
              manual ? "text-[var(--muted)]" : "text-[var(--accent)]/70"
            }`}
          >
            {sourceLabel(item.source)}
          </span>
        </span>
        <span className="shrink-0 text-xs text-[var(--muted)]">
          {when(item.updatedAt)}
        </span>
      </button>

      {expanded && editing && manual ? (
        <div className="border-t border-[var(--border)] px-4 py-3">
          <ManualFaultForm
            caseId={item.id}
            embedded
            initial={{
              vehicleMake: item.vehicleMake ?? "",
              vehicleModel: item.vehicleModel ?? "",
              vehicleEngine: item.vehicleEngine ?? "",
              vehicleYear: item.vehicleYear,
              problemText: item.problemText ?? "",
              confirmedFault: item.confirmedFault ?? "",
            }}
            onCancel={onCancelEdit}
            onSaved={onSaved}
          />
        </div>
      ) : null}

      {expanded && !editing && (
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
            {!manual ? (
              <Field
                label="Opis problema"
                value={shown(item.problemText)}
                wide
              />
            ) : item.problemText.trim() ? (
              <Field
                label="Simptomi / razlog dolaska"
                value={item.problemText}
                wide
              />
            ) : null}
            <Field
              label="Utvrđeni kvar"
              value={shown(item.confirmedFault)}
              wide
            />
            <Field
              label="Izvor"
              value={sourceLabel(item.source)}
              accent={!manual}
            />
            {!manual ? (
              <Field
                label="Pouzdanost (diagnosisCertainty)"
                value={shown(item.diagnosisCertainty)}
              />
            ) : null}
            <Field label="Status" value={statusLabel(item.status)} />
          </dl>
          {manual ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={onEdit}
                className="min-h-11 rounded-xl border border-[var(--border)] px-3 text-sm text-[var(--accent)]"
              >
                Uredi
              </button>
              <p className="text-xs text-[var(--muted)]">
                Ručno unesen kvar nema CarAI dijagnostiku za nastavak.
              </p>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => onOpen(item.id)}
              disabled={openingId != null}
              className="mt-3 min-h-11 rounded-xl border border-[var(--border)] px-3 text-sm text-[var(--accent)] disabled:opacity-35"
            >
              {openingId === item.id ? "Otvaram…" : "Otvori dijagnostiku"}
            </button>
          )}
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
  editingId,
  openingId,
  onToggle,
  onOpen,
  onEdit,
  onCancelEdit,
  onSaved,
  showFaultOnCard,
}: {
  title: string;
  cases: CaseSummary[];
  empty: string;
  expandedId: string | null;
  editingId: string | null;
  openingId: string | null;
  onToggle: (id: string) => void;
  onOpen: (id: string) => void;
  onEdit: (id: string) => void;
  onCancelEdit: () => void;
  onSaved: () => void;
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
              editing={editingId === item.id}
              openingId={openingId}
              onToggle={() => onToggle(item.id)}
              onOpen={onOpen}
              onEdit={() => onEdit(item.id)}
              onCancelEdit={onCancelEdit}
              onSaved={onSaved}
              showFaultOnCard={showFaultOnCard}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

type ManualFaultFormValues = {
  vehicleMake: string;
  vehicleModel: string;
  vehicleEngine: string;
  vehicleYear: number | null;
  problemText: string;
  confirmedFault: string;
};

function ManualFaultForm({
  caseId,
  initial,
  embedded,
  onCancel,
  onSaved,
}: {
  caseId?: string;
  initial?: ManualFaultFormValues;
  embedded?: boolean;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const editing = caseId != null;
  const [make, setMake] = useState(initial?.vehicleMake ?? "");
  const [model, setModel] = useState(initial?.vehicleModel ?? "");
  const [engine, setEngine] = useState(initial?.vehicleEngine ?? "");
  const [year, setYear] = useState(
    initial?.vehicleYear != null ? String(initial.vehicleYear) : "",
  );
  const [symptoms, setSymptoms] = useState(initial?.problemText ?? "");
  const [fault, setFault] = useState(initial?.confirmedFault ?? "");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setFormError(null);
    try {
      const yearText = year.trim();
      let vehicleYear: number | null = null;
      if (yearText) {
        if (!/^\d{4}$/.test(yearText)) {
          setFormError("Godina mora biti četiri znamenke.");
          return;
        }
        vehicleYear = Number(yearText);
      }

      const result = await saveManualResolvedFault({
        ...(caseId ? { id: caseId } : {}),
        vehicleMake: make,
        vehicleModel: model,
        vehicleEngine: engine,
        vehicleYear,
        problemText: symptoms,
        confirmedFault: fault,
      });
      if (!result.ok) {
        setFormError(result.message);
        return;
      }
      onSaved();
    } catch {
      setFormError("Spremanje nije uspjelo. Provjeri vezu i pokušaj ponovo.");
    } finally {
      setSaving(false);
    }
  }

  const fieldClass =
    "mt-1 min-h-11 w-full rounded-xl border border-[var(--border)] bg-transparent px-3 text-sm outline-none";
  const formClass = embedded
    ? ""
    : "surface-2 mt-4 rounded-2xl px-4 py-4";

  return (
    <form
      onSubmit={(event) => void onSubmit(event)}
      className={formClass}
    >
      <p className="text-xs font-semibold tracking-[0.16em] text-[var(--muted)]">
        {editing ? "UREDI RIJEŠENI KVAR" : "NOVI RIJEŠENI KVAR"}
      </p>
      <label className="mt-3 block text-xs text-[var(--muted)]" htmlFor="manual-make">
        Marka vozila
      </label>
      <input
        id="manual-make"
        value={make}
        onChange={(e) => setMake(e.target.value)}
        required
        maxLength={200}
        className={fieldClass}
      />
      <label className="mt-3 block text-xs text-[var(--muted)]" htmlFor="manual-model">
        Model vozila
      </label>
      <input
        id="manual-model"
        value={model}
        onChange={(e) => setModel(e.target.value)}
        required
        maxLength={200}
        className={fieldClass}
      />
      <label className="mt-3 block text-xs text-[var(--muted)]" htmlFor="manual-engine">
        Motor (neobavezno)
      </label>
      <input
        id="manual-engine"
        value={engine}
        onChange={(e) => setEngine(e.target.value)}
        maxLength={200}
        className={fieldClass}
      />
      <label className="mt-3 block text-xs text-[var(--muted)]" htmlFor="manual-year">
        Godina (neobavezno)
      </label>
      <input
        id="manual-year"
        value={year}
        onChange={(e) => setYear(e.target.value)}
        inputMode="numeric"
        maxLength={4}
        placeholder="npr. 2016"
        className={fieldClass}
      />
      <label className="mt-3 block text-xs text-[var(--muted)]" htmlFor="manual-symptoms">
        Simptomi / razlog dolaska (neobavezno)
      </label>
      <textarea
        id="manual-symptoms"
        value={symptoms}
        onChange={(e) => setSymptoms(e.target.value)}
        rows={3}
        maxLength={20000}
        className="mt-1 w-full rounded-xl border border-[var(--border)] bg-transparent px-3 py-2 text-sm outline-none"
      />
      <label className="mt-3 block text-xs text-[var(--muted)]" htmlFor="manual-fault">
        Utvrđeni kvar
      </label>
      <textarea
        id="manual-fault"
        value={fault}
        onChange={(e) => setFault(e.target.value)}
        required
        rows={3}
        maxLength={4000}
        className="mt-1 w-full rounded-xl border border-[var(--border)] bg-transparent px-3 py-2 text-sm outline-none"
      />
      {formError && (
        <p role="alert" className="mt-3 text-sm text-[var(--danger)]">
          {formError}
        </p>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="submit"
          disabled={saving}
          className="min-h-11 rounded-xl border border-[var(--border-strong)] px-4 text-sm disabled:opacity-35"
        >
          {saving ? "Spremam…" : "Spremi"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="min-h-11 rounded-xl border border-[var(--border)] px-4 text-sm disabled:opacity-35"
        >
          Odustani
        </button>
      </div>
    </form>
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
  onRefresh,
}: CaseHistoryProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const highConfidence = cases.filter(isHighConfidenceFault);
  const other = cases.filter((item) => !isHighConfidenceFault(item));

  function toggle(id: string) {
    setExpandedId((current) => {
      if (current === id) {
        setEditingId(null);
        return null;
      }
      setEditingId(null);
      return id;
    });
  }

  function startEdit(id: string) {
    setShowForm(false);
    setExpandedId(id);
    setEditingId(id);
  }

  function cancelEdit() {
    setEditingId(null);
  }

  function afterManualSaved() {
    setShowForm(false);
    setEditingId(null);
    onRefresh();
  }

  return (
    <section className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
      <p className="text-xs font-semibold tracking-[0.16em] text-[var(--accent)]">
        POVIJEST
      </p>
      <div className="mt-2 flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-2xl font-semibold">Spremljeni slučajevi</h1>
        {signedIn && configured && (
          <button
            type="button"
            onClick={() => {
              setEditingId(null);
              setShowForm(true);
            }}
            className="min-h-11 rounded-xl border border-[var(--border-strong)] px-4 text-sm text-[var(--accent)]"
          >
            + Dodaj riješeni kvar
          </button>
        )}
      </div>

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

      {signedIn && showForm && (
        <ManualFaultForm
          onCancel={() => setShowForm(false)}
          onSaved={afterManualSaved}
        />
      )}

      {signedIn && loading && (
        <p className="mt-4 text-sm text-[var(--muted)]">Učitavam slučajeve…</p>
      )}

      {signedIn && !loading && cases.length === 0 && !error && !showForm && (
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
            editingId={editingId}
            openingId={openingId}
            onToggle={toggle}
            onOpen={onOpen}
            onEdit={startEdit}
            onCancelEdit={cancelEdit}
            onSaved={afterManualSaved}
            showFaultOnCard
          />
          <CaseSection
            title="NEPOTVRĐENI I NEDOVRŠENI SLUČAJEVI"
            cases={other}
            empty="Nema nepotvrđenih ni nedovršenih slučajeva."
            expandedId={expandedId}
            editingId={editingId}
            openingId={openingId}
            onToggle={toggle}
            onOpen={onOpen}
            onEdit={startEdit}
            onCancelEdit={cancelEdit}
            onSaved={afterManualSaved}
            showFaultOnCard={false}
          />
        </>
      )}
    </section>
  );
}
