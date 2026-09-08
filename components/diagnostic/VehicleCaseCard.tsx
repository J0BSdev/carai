import type { DiagnosticCase } from "@/lib/diagnosis";
import {
  vehicleMake,
  vehicleSubtitle,
  type DiagnosticPhaseUi,
} from "@/lib/diagnosis/ui-helpers";
import DiagnosticStatus from "./DiagnosticStatus";

type VehicleCaseCardProps = {
  diagnosticCase: DiagnosticCase;
  statusLabel: DiagnosticPhaseUi;
  progressIndex: number;
  progressTotal: number;
};

export default function VehicleCaseCard({
  diagnosticCase,
  statusLabel,
  progressIndex,
  progressTotal,
}: VehicleCaseCardProps) {
  const dtcs = diagnosticCase.extracted?.dtcs;

  return (
    <section className="surface-card anim-enter p-4 sm:p-5">
      <div className="flex flex-col gap-4">
        <div>
          <p className="text-xs font-medium tracking-[0.14em] text-[var(--muted)]">
            VOZILO / SLUČAJ
          </p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight text-[var(--foreground)] sm:text-3xl">
            {vehicleMake(diagnosticCase)}
          </h1>
          <p className="mt-1 text-base text-[var(--muted-strong)]">
            {vehicleSubtitle(diagnosticCase)}
          </p>
          {dtcs && dtcs.length > 0 && (
            <p className="mono-data mt-2 text-sm text-[var(--accent-2)]">
              {dtcs.join(" · ")}
            </p>
          )}
        </div>

        <DiagnosticStatus
          label={statusLabel}
          progressIndex={progressIndex}
          progressTotal={progressTotal}
        />

        <div className="border-t border-[var(--border)] pt-3">
          <p className="text-xs text-[var(--muted)]">Prijavljeni kvar</p>
          <p className="mt-1 text-sm leading-relaxed text-[var(--muted-strong)]">
            {diagnosticCase.problemText}
          </p>
        </div>
      </div>
    </section>
  );
}
