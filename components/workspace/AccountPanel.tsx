"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

type AccountPanelProps = {
  email: string | null;
  configured: boolean;
  onSignOut?: () => void;
  signingOut?: boolean;
};

function authMessage(code: string | undefined, mode: "sign-in" | "sign-up"): string {
  if (code === "email_not_confirmed") return "Potvrdi email prije prijave.";
  if (code === "email_exists" || code === "user_already_exists") {
    return "Račun s tim emailom već postoji.";
  }
  if (code === "weak_password") return "Lozinka ne zadovoljava pravila projekta.";
  if (code === "over_request_rate_limit" || code === "over_email_send_rate_limit") {
    return "Previše pokušaja. Pričekaj pa pokušaj ponovo.";
  }
  return mode === "sign-in"
    ? "Prijava nije uspjela. Provjeri email i lozinku."
    : "Registracija nije uspjela.";
}

export default function AccountPanel({
  email,
  configured,
  onSignOut,
  signingOut = false,
}: AccountPanelProps) {
  const router = useRouter();
  const [mode, setMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setNotice(null);
    const form = new FormData(event.currentTarget);
    const nextEmail = String(form.get("email") ?? "").trim();
    const password = String(form.get("password") ?? "");
    if (!nextEmail.includes("@") || password.length < 8) {
      setError("Unesi ispravan email i lozinku od najmanje 8 znakova.");
      return;
    }
    const supabase = createClient();
    if (!supabase) {
      setError("Supabase nije konfiguriran.");
      return;
    }

    setPending(true);
    try {
      if (mode === "sign-in") {
        const { error: authError } = await supabase.auth.signInWithPassword({
          email: nextEmail,
          password,
        });
        if (authError) {
          setError(authMessage(authError.code, mode));
          return;
        }
        router.refresh();
        return;
      }

      const { data, error: authError } = await supabase.auth.signUp({
        email: nextEmail,
        password,
      });
      if (authError) {
        setError(authMessage(authError.code, mode));
        return;
      }
      if (!data.session) {
        setNotice("Račun je kreiran. Potvrdi email, zatim se prijavi.");
        setMode("sign-in");
        return;
      }
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="mx-auto w-full max-w-lg px-4 py-8 sm:px-6">
      <p className="text-xs font-semibold tracking-[0.16em] text-[var(--accent)]">
        RAČUN
      </p>
      <h1 className="mt-2 text-2xl font-semibold">Prijava</h1>
      <p className="mt-2 text-sm text-[var(--muted-strong)]">
        Slučajevi se spremaju na tvoj račun. Prijava je obavezna, osim dok
        aplikacija radi lokalno u razvojnom načinu.
      </p>

      {!configured && (
        <p className="mt-5 rounded-2xl border border-[var(--border)] bg-[var(--bg-2)] px-3 py-2 text-sm text-[var(--muted-strong)]">
          Postavi NEXT_PUBLIC_SUPABASE_URL i NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
          pa pokreni SQL migraciju.
        </p>
      )}

      {email ? (
        <div className="surface-2 mt-6 rounded-[var(--radius-lg)] p-4">
          <p className="text-sm text-[var(--muted)]">Prijavljen</p>
          <p className="mt-1 break-all text-base">{email}</p>
          <button
            type="button"
            onClick={() => onSignOut?.()}
            disabled={signingOut}
            className="mt-4 min-h-11 rounded-xl border border-[var(--border-strong)] px-4 text-sm disabled:opacity-35"
          >
            Odjava
          </button>
        </div>
      ) : (
        <form onSubmit={(event) => void onSubmit(event)} className="surface-2 mt-6 rounded-[var(--radius-lg)] p-4">
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                setMode("sign-in");
                setError(null);
                setNotice(null);
              }}
              className={`min-h-10 rounded-xl px-3 text-sm ${
                mode === "sign-in"
                  ? "bg-[var(--accent-soft)] text-[var(--accent)]"
                  : "text-[var(--muted)]"
              }`}
            >
              Prijava
            </button>
            <button
              type="button"
              onClick={() => {
                setMode("sign-up");
                setError(null);
                setNotice(null);
              }}
              className={`min-h-10 rounded-xl px-3 text-sm ${
                mode === "sign-up"
                  ? "bg-[var(--accent-soft)] text-[var(--accent)]"
                  : "text-[var(--muted)]"
              }`}
            >
              Registracija
            </button>
          </div>

          {error && (
            <p role="alert" className="mt-4 text-sm text-[var(--danger)]">
              {error}
            </p>
          )}
          {notice && (
            <p className="mt-4 text-sm text-[var(--muted-strong)]">{notice}</p>
          )}

          <label className="mt-4 block text-xs text-[var(--muted)]" htmlFor="account-email">
            Email
          </label>
          <input
            id="account-email"
            name="email"
            type="email"
            autoComplete="username"
            required
            disabled={!configured || pending}
            className="mt-1 min-h-11 w-full rounded-xl border border-[var(--border)] bg-transparent px-3 text-sm outline-none"
          />
          <label className="mt-3 block text-xs text-[var(--muted)]" htmlFor="account-password">
            Lozinka
          </label>
          <input
            id="account-password"
            name="password"
            type="password"
            autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
            required
            minLength={8}
            disabled={!configured || pending}
            className="mt-1 min-h-11 w-full rounded-xl border border-[var(--border)] bg-transparent px-3 text-sm outline-none"
          />
          <button
            type="submit"
            disabled={!configured || pending}
            className="mt-4 min-h-11 rounded-xl bg-[var(--accent)] px-4 text-sm font-medium text-black disabled:opacity-35"
          >
            {mode === "sign-in" ? "Prijavi se" : "Otvori račun"}
          </button>
        </form>
      )}
    </section>
  );
}
