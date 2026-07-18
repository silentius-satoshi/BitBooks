# BitBooks: Sovereign Books for Bitcoiners

> This document is the identity and direction reference for BitBooks (and its suite relationship to Personal ₿LOC). It describes what the app is, how it works, and where it's headed. All other documentation — ARCHITECTURE.md, the BitBooks Book, specs, marketing — must align with this document. Doc pattern adapted from RUNSTR's North Star (github.com/RUNSTR-LLC/RUNSTR).
> **Status note:** BitBooks is pre-launch (target: the 2028 tax season). This document speaks in the present tense about the *design*; nothing here may be claimed as shipped in public copy until it ships.

---

## The Pitch

BitBooks is double-entry bookkeeping for bitcoiners — books you own, basis you can prove. Your books are encrypted to your key before they leave your device, synced over relays, and never uploaded to anyone. There is no account, no server, no subscription, and no kill switch: if we vanish, your books don't. When a broker's 1099-DA reports zero basis on coins you moved in, your books are the record that proves the real number — frozen, hash-anchored, and ready to hand to your CPA or attach to your own filing.

Every bitcoin account in your books carries its own lots: what you hold, what it cost, when you acquired it. Sats, basis, and market value are three separate truths, never blended. Close a month and its page freezes with a verifiable hash; incomplete books say so loudly and refuse to pretend otherwise. At year's end, BitBooks emits the Basis Package — every lot and disposal reconciled line-by-line against the broker's form, elections stated on its face — and, for self-filers, renders Form 8949 and CSV files TurboTax and H&R Block accept directly. Free means free: unlimited transactions, full reports, the Package — no meter, no trial, no tier. If it ever saves you a tax fight, there's a zap button. That's the business model.

## The Core Loop

```
Record → Close → Prove
```

Enter what happened (or import it). Close the month — the ritual that freezes a verified page. Prove your basis when it matters: to the IRS's matching computer, to your CPA, to yourself. Everything in the product serves this loop; anything that doesn't is trimmed.

## The Three Pillars

| Pillar | What it is |
|---|---|
| **Record** | A real double-entry ledger with native BTC lots. Register, templates, CSV import, reconcile. Sats · basis · market — three truths, never conflated. |
| **Prove** | Integrity as UI: the manifest strip (COMPLETE or DEGRADED, every screen), the close ritual, the broker reconcile, the Basis Package, the self-filer exports (8949, TurboTax/H&R Block CSV). |
| **Suite** | One Recovery Key runs Personal ₿LOC (the borrowing side) and BitBooks (the record side). Your ₿LOC year imports as draft entries. More apps under the same key, never holding data hostage. |

## Key Principles

- **Positioning** — The free, bitcoin-native double-entry record ledger you actually own. GnuCash's sovereignty, CoinTracker's lot intelligence, a register a normal person can use. Not an SMB ERP; not a tax filer; not a portfolio ticker.
- **Messaging priority (fixed order)** — ① provable basis vs 1099-DA ② ownership / no kill switch ③ free forever ④ native lots in a real ledger ⑤ the suite. **Nostr is plumbing, never the pitch** — marketing leads with outcomes (can't read your books, can't take them away), and the protocol name lives in Settings and docs.
- **One voice, plain words** — In-app and in marketing alike: "Recovery Key," not nsec; "relays" only in Settings; never "NIP-44," "npub," or "decentralized" in primary UI or headline copy.
- **The user never pays** — No meter, no tier, ever. Revenue lives around the books: zaps on artifacts, CPA seats (accountant portal), concierge backup/relay. Any proposal that charges the user is void on arrival.
- **Simplicity over all else (the six rules, law)** — No debit/credit in primary UI (money moves from → to; Σ=0 carries the invariant) · templates are the front door · presets before mapping · one decision per screen · the integrity strip is the only integrity UI · simple is the baseline, complexity is added later behind advanced surfaces, never shipped as default.
- **Scope fence** — No invoicing, payroll, AR/AP, or inventory. Personal/household books and small operations. Permanently.
- **Three truths** — Sats held, cost basis, market at the last reading. Separate columns, never a blended number.
- **Live for display, confirmed for records (E2v2)** — The live ₿ price may inform the screen, but nothing goes on the record until the user confirms a number with a date. No Plaid, no exchange account links. Every number on an artifact can cite its source.
- **Lots are written, never recomputed** — Disposal lot selections are recorded on the entry at post time, forever. Changing the account's method never rewrites history.
- **Unknown basis is loud** — A first-class rendered state, named in Home, reports, and the Package. A placeholder never silently becomes $0.
- **Loud failure** — COMPLETE or DEGRADED, nothing between. Degraded books go read-only and refuse to close or emit a Package. Incomplete books never pretend to be whole.
- **Records, not advice** — The product states facts and records the user's elections; it never recommends tax actions. The CPA (or the self-filer) makes the calls. Exports are file formats, not APIs — the CSV *is* the TurboTax integration.
- **Sovereignty is real, not rhetorical** — NIP-44 encryption to the user's key; relays hold ciphertext only; the app is a static bundle with no backend. Restore everything from the Recovery Key on any device.

## The Wedge (why this product, why now)

Brokers report proceeds to the IRS on 1099-DA; for coins acquired elsewhere or transferred in, basis is blank — and the matching is automated. The only party who can prove what those sats cost is the holder. BitBooks exists to make that proof ordinary: per-account lots (the account-by-account rule falls out of the data model), a hash manifest that makes books provably whole, and the Basis Package as the artifact the whole product exists to emit.

## Who it's for

Bitcoiners keeping their own books: self-filers first (the majority — the free product is complete without a CPA), CPA-attached users second (the accountant grant and portal serve them), Personal ₿LOC borrowers as the seed audience (their year imports as drafts). Built for people who already chose self-custody and expect their records to work the same way.

## Direction

- **Roadmap arc** — ledger core → register/entry UI → import/reconcile/close → relay rehearsal → reports/broker reconcile → Basis Package → public launch into the 2028 tax season → self-filer exports → accountant portal.
- **The accountant grant** — read everything, change nothing; revoke = epoch rotation. The professional layer grows around free books, never inside them.
- **The suite deepens** — the ₿LOC bridge at launch; future apps under the same Recovery Key, each raising switching costs without custody.
- **What we will not become** — a portfolio tracker with live tickers, a tax-advice engine, an e-file integrator, a QuickBooks. The restraint is the product.
