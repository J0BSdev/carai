"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { imageMediaType, MAX_IMAGE_BYTES } from "@/lib/diagnosis/turn-image";

type PhotoAttachProps = {
  disabled?: boolean;
  onChange: (file: File | null) => void;
};

export default function PhotoAttach({ disabled, onChange }: PhotoAttachProps) {
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const cameraRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);
  const onChangeRef = useRef(onChange);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    return () => onChangeRef.current(null);
  }, []);

  function choose(next: File | null) {
    setFile(next);
    setMenu(false);
    onChange(next);
  }

  async function pick(list: FileList | null) {
    const picked = list?.[0];
    if (cameraRef.current) cameraRef.current.value = "";
    if (galleryRef.current) galleryRef.current.value = "";
    if (!picked) return;
    try {
      const bytes = new Uint8Array(await picked.arrayBuffer());
      if (bytes.byteLength === 0) {
        setError("Slika je prazna.");
        return;
      }
      if (bytes.byteLength > MAX_IMAGE_BYTES) {
        setError("Slika je prevelika.");
        return;
      }
      if (!imageMediaType(bytes)) {
        setError("Podržane su samo JPEG, PNG i WebP slike.");
        return;
      }
      setError(null);
      choose(picked);
    } catch {
      setError("Slika nije valjana.");
    }
  }

  return (
    <div className="min-w-0">
      {file ? (
        <div className="flex items-center gap-2">
          <Preview file={file} />
          <button
            type="button"
            onClick={() => {
              setError(null);
              choose(null);
            }}
            className="min-h-11 rounded-xl px-3 text-sm text-[var(--muted-strong)] transition hover:bg-white/5 hover:text-[var(--foreground)]"
          >
            Obriši
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-1">
          <button
            type="button"
            aria-label="Dodaj fotografiju"
            disabled={disabled}
            onClick={() => setMenu((open) => !open)}
            className="flex h-10 w-10 items-center justify-center rounded-xl text-[var(--muted)] transition hover:bg-white/5 hover:text-[var(--foreground)] disabled:opacity-35"
          >
            <CameraIcon />
          </button>
          {menu ? (
            <>
              <button
                type="button"
                onClick={() => cameraRef.current?.click()}
                className="min-h-11 rounded-xl px-3 text-sm text-[var(--foreground)] transition hover:bg-white/5"
              >
                Fotografiraj
              </button>
              <button
                type="button"
                onClick={() => galleryRef.current?.click()}
                className="min-h-11 rounded-xl px-3 text-sm text-[var(--foreground)] transition hover:bg-white/5"
              >
                Galerija
              </button>
            </>
          ) : null}
        </div>
      )}
      <input
        ref={cameraRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        capture="environment"
        className="pointer-events-none absolute h-0 w-0 opacity-0"
        tabIndex={-1}
        onChange={(event) => void pick(event.target.files)}
      />
      <input
        ref={galleryRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="pointer-events-none absolute h-0 w-0 opacity-0"
        tabIndex={-1}
        onChange={(event) => void pick(event.target.files)}
      />
      {error ? (
        <p role="alert" className="mt-2 text-sm text-[var(--danger)]">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function Preview({ file }: { file: File }) {
  const url = useMemo(() => URL.createObjectURL(file), [file]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return (
    // blob: preview. next/image does not accept object URLs.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt="Odabrana fotografija"
      className="h-16 w-16 rounded-xl object-cover"
    />
  );
}

function CameraIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M4 8h3l2-2h6l2 2h3v11H4V8Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="13" r="3.5" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}
