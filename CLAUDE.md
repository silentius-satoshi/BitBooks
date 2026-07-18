# CLAUDE.md — BitBooks

BitBooks is double-entry bookkeeping for bitcoiners: books you own, basis you
can prove. Free forever for the user; encrypted to their key; nostr relays as
sync plumbing (never the pitch). This repo is the public BitBooks codebase —
currently the PB-1 pure ledger core + PB-3 entry-UX preview and the landing
site. Personal ₿LOC (the borrowing-side sibling app) lives in its own repo;
both apps share one Recovery Key. Parent brand: **Twelve Words**
(twelvewords.xyz).

## Commands

- `npm test` — vitest suite (37 tests: invariants, property battery, PB-3)
- `npm run typecheck` — tsc strict, no emit
- `npm run build` — bundles the app, then assembles `dist/`
  (index.html = landing with live sandbox, app.html = standalone preview)
- Deploy: Vercel builds with `npm run build`, serves `dist/` (vercel.json)

## Layout

- `src/domain/` — the PURE core (PB-1). Plain data + pure functions.
  **No UI imports, no sync imports, no Date.now()/Math.random()/network.**
  Timestamps and ids are inputs. This purity is load-bearing: it's what
  makes the core node-testable and the property battery meaningful.
- `src/app/` — PB-3 preview UI (React 18, useReducer store). Every posting
  goes through the single `post()` action (U1). No localStorage /
  sessionStorage / indexedDB anywhere — persistence arrives with PB-2 sync.
- `test/` — invariants + fast-check property tests + a seeded 10k battery.
- `demo/` — shell.html (app chrome/CSS), landing.html (marketing page
  template), fonts.css (Inter, base64 — no webfont fetches).
- `docs/` — NORTH_STAR.md (identity; read first), ARCHITECTURE.md (system
  design). `book/` — the BitBooks Book TOC (written milestone-by-milestone).

## Domain law (locked — do not renegotiate in code)

- Integer money only: sats + USD cents. Never float arithmetic on money.
  Allocation remainder goes to the last element, never dropped.
- Σ valueCents = 0 gates every posting; trial balance nets to zero always.
- Classifier is total: ACQUISITION / TRANSFER / TRANSFER_WITH_FEE / DISPOSAL.
- D12 transfer-neutrality: transfers carry basis and NEVER touch P&L —
  no sequence of transfers may change realized gain by one cent.
- D13 basis-honesty: unknown basis is a loud rendered state, never $0.
- D14: lot selections are written on the split at post time, never
  recomputed; changing an account's method never rewrites history.
- D15 dual timestamps: local date = accounting period; utc required on
  lot-touching txns.
- Lots are a fold over the journal (`foldLots`) — derived, never stored.
- Realized gain is the balancing figure, not an input.

## UI law (Amendment A1 — six rules)

No debit/credit in primary UI (money moves from → to) · templates are the
front door · presets before mapping · one decision per screen · the
integrity strip is the only integrity UI · simple is the only launch mode.
Scope fence: no invoicing, payroll, AR/AP, inventory. The user never pays.

Voice: plain words. "Recovery Key" (never nsec), "relays" only in Settings,
no NIP-x in primary UI. Matte-black theme, gold #e8b04f as the single
accent, green/red reserved for money meaning.

Live price (E2v2): fetched for DISPLAY, confirmed numbers go on the record.
The price fetch is the app's only outbound call and carries no user data.

## Security invariants (preview builds)

- Never generate real keys in a preview: the key ceremony renders
  SAMPLE-watermarked words only.
- Never accept an nsec anywhere: the sign-in sheet refuses secret keys with
  a lesson. npub (display identity) only until real auth ships (PB-2).
- No browser storage APIs; no analytics; no webfont/CDN fetches.

## When PB-2 (sync) opens

nostr-tools pinned 2.23.5 exact — never NDK. Kind 30078, d-tags
`bitbooks:*` (see docs/ARCHITECTURE.md event map). Sync law: PULL before
PUBLISH · per-d-tag monotonic created_at · manifest-as-commit ·
COMPLETE or DEGRADED, nothing between (DEGRADED ⇒ read-only).

## Working agreements

- Tests are the deliverable: the suite green + typecheck clean before any
  commit is called done. New core behavior gets a property test, not just
  an example test.
- 500-line file limit.
- UI changes ship at production fidelity (screenshot-verified); skeleton
  quality never ships.
- Deviations from spec are written down in the commit/PR body, never silent.
