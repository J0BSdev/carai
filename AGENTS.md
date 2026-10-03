<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Diagnostic authority

- AI owns semantics. The backend does not interpret free-form mechanic text, except a legacy fail-safe when a stored observation has no typed intent.
- Backend owns structure and invariants: state, enums, evidence provenance, retry limits, safety and spec guards.
- Internal control flow uses typed codes and state. Never route on your own issue or error strings (`startsWith`, `includes`, regex).
- A UI button sends a structured intent enum. Do not turn a click into fake free-text for the backend to parse.
