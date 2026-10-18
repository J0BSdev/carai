"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import AccountPanel from "@/components/workspace/AccountPanel";

export default function AuthGate({
  configured,
  reason,
}: {
  configured: boolean;
  reason: "auth" | "subscription";
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function signOut() {
    if (pending) return;
    setPending(true);
    try {
      const supabase = createClient();
      if (supabase) await supabase.auth.signOut();
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  if (reason === "subscription") {
    return (
      <main className="mx-auto w-full max-w-lg px-4 py-16 sm:px-6">
        <h1 className="text-2xl font-semibold">Pretplata</h1>
        <p className="mt-3 text-sm text-[var(--muted-strong)]">
          Ovaj račun trenutno nema pristup dijagnozi.
        </p>
        <button
          type="button"
          onClick={() => void signOut()}
          disabled={pending}
          className="mt-5 min-h-11 rounded-xl border border-[var(--border-strong)] px-4 text-sm disabled:opacity-35"
        >
          Odjava
        </button>
      </main>
    );
  }

  return <AccountPanel configured={configured} email={null} />;
}
