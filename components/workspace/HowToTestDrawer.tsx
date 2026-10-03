import type { DiagnosticStep } from "@/lib/diagnosis";
import ResponsiveOverlay from "@/components/ui/ResponsiveOverlay";

type HowToTestDrawerProps = {
  open: boolean;
  onClose: () => void;
  step: DiagnosticStep | null;
};

function howToTitle(step: DiagnosticStep): string {
  const fromContent =
    step.content.split(/[.\n!?]/)[0]?.trim() || step.content.trim();
  return fromContent || "Test";
}

export default function HowToTestDrawer({
  open,
  onClose,
  step,
}: HowToTestDrawerProps) {
  const name = step ? howToTitle(step) : "Test";
  const procedure =
    step?.testGuide?.trim() || step?.content || "Uputa još nije dostupna.";
  const expected =
    step?.expectedResultHint?.trim() || "Zabilježi što si izmjerio ili vidio.";

  return (
    <ResponsiveOverlay
      open={open}
      onClose={onClose}
      title="Kako izvesti test"
      preferDrawer
    >
      <p className="text-sm font-medium text-[var(--foreground)]">{name}</p>

      <section className="mt-5">
        <h3 className="text-xs font-medium tracking-wide text-[var(--muted)]">
          POSTUPAK
        </h3>
        <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-[var(--muted-strong)]">
          {procedure}
        </p>
      </section>

      <section className="mt-5">
        <h3 className="text-xs font-medium tracking-wide text-[var(--muted)]">
          OČEKIVANO OPAŽANJE
        </h3>
        <p className="mt-2 text-sm text-[var(--muted-strong)]">{expected}</p>
      </section>

      <section className="mt-5">
        <h3 className="text-xs font-medium tracking-wide text-[var(--muted)]">
          SIGURNOST
        </h3>
        <p className="mt-2 text-sm text-[var(--muted-strong)]">
          Radi prema uobičajenoj radioničkoj praksi. Ne izmišljaj OEM limite ako nisu verificirani.
        </p>
      </section>

      <button
        type="button"
        onClick={onClose}
        className="mt-6 flex min-h-12 w-full items-center justify-center rounded-2xl border border-[var(--border-strong)] text-sm font-medium"
      >
        RAZUMIJEM
      </button>
    </ResponsiveOverlay>
  );
}
