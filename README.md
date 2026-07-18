# BitBooks

**Double-entry bookkeeping for bitcoiners — books you own, basis you can prove.**

BitBooks keeps proper books for your money — spending, income, credit, and
every coin's date and true cost — clear enough for every day, rigorous
enough to prove what your coins really cost when a broker's 1099-DA says
otherwise. Your books are written on your device and locked to a key you
hold. Free means free: no meter, no trial, no tier.

A [Twelve Words](https://twelvewords.xyz) app, sibling to **Personal ₿LOC**
(the borrowing side of the house). One key, two ledgers.

> **Status: working preview.** The ledger core underneath is real and
> property-tested; key backup and relay sync arrive with launch
> (target: the 2028 tax season). Nothing here is financial, tax, or
> accounting advice — BitBooks records facts and elections; it never
> recommends.

## What's in this repo

- `src/domain/` — the pure ledger core (PB-1): accounts, Σ=0 postings, a
  total transaction classifier, per-placement lot basis tracking, and
  reports as pure functions over a fold. No clocks, no network, no UI —
  just data in, data out, with the invariants enforced by property tests.
- `src/app/` — the entry-UX preview (PB-3): a Monarch-class PWA surface
  over the core. Templates as the front door, no debit/credit in sight,
  matte-black fintech design.
- `demo/` + `scripts/` — builds the site: the landing page embeds the real
  app as a live sandbox inside an iPhone frame (blob URL, nothing leaves
  the page), plus a standalone single-file preview.
- `docs/` — [NORTH_STAR.md](docs/NORTH_STAR.md) (what this is and why),
  [ARCHITECTURE.md](docs/ARCHITECTURE.md) (how it works, including the
  nostr event map for the sync layer to come).
- `book/` — the BitBooks Book, written milestone by milestone as the
  product ships.

## Run it

```bash
npm install
npm test          # 37 tests: invariants, property battery, entry UX
npm run typecheck
npm run build     # → dist/ (index.html landing + app.html standalone)
```

Open `dist/app.html` in a browser — the whole preview is one file.

## The invariants (the short version)

Money is integers (sats + cents). Every posting sums to zero. Transfers
carry basis and never touch P&L. Lot selections are written at post time
and never recomputed. Unknown basis stays loud — it never becomes $0.
Realized gain is the balancing figure. Each of these is a test, not a hope.

## License

[FSL-1.1-MIT](LICENSE.md) — Functional Source License: free for everything
except building a competing product, converting to MIT two years per
release. The user-facing promise is simpler: BitBooks is free, and your
books are yours.
