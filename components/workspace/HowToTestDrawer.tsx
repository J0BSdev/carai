import type { DiagnosticStep } from "@/lib/diagnosis";
import ResponsiveOverlay from "@/components/ui/ResponsiveOverlay";

type HowToTestDrawerProps = {
  open: boolean;
  onClose: () => void;
  step: DiagnosticStep | null;
};

export default function HowToTestDrawer({
  open,
  onClose,
  step,
}: HowToTestDrawerProps) {
  const howTo = step?.recommendedTest?.howTo;
  const what = step?.recommendedTest?.whatToRecord;
  const name = step?.recommendedTest?.name || step?.content;

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
          POTREBNI ALATI
        </h3>
        <p className="mt-2 text-sm text-[var(--muted-strong)]">
          Podaci o alatima bit će dostupni kad AI vrati strukturirani guide.
        </p>
      </section>

      <section className="mt-5">
        <h3 className="text-xs font-medium tracking-wide text-[var(--muted)]">
          POSTUPAK
        </h3>
        {howTo ? (
          <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-[var(--muted-strong)]">
            {howTo}
          </p>
        ) : (
          <p className="mt-2 text-sm leading-relaxed text-[var(--muted-strong)]">
            {step?.content ||
              "Uputa još nije dostupna iz backend responsea. Slijedi opis u sljedećem koraku."}
          </p>
        )}
      </section>

      <section className="mt-5">
        <h3 className="text-xs font-medium tracking-wide text-[var(--muted)]">
          OČEKIVANO OPAŽANJE
        </h3>
        <p className="mt-2 text-sm text-[var(--muted-strong)]">
          {what || step?.expectedResultHint || "Zabilježi što si izmjerio ili vidio."}
        </p>
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
