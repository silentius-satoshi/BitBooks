# BitBooks Architecture

> **For product identity and direction, see [NORTH_STAR.md](NORTH_STAR.md).** Doc pattern adapted from RUNSTR's ARCHITECTURE.md, with one deliberate inversion stated up front:
> **RUNSTR's source of truth is Supabase (their server); BitBooks has NO server.** The client is everything; relays hold ciphertext the user's key encrypted. Nothing in this document may introduce a backend, and any future doc that does is violating the thesis, not extending it.
> **Status:** the pure domain core (PB-1) and entry-UX preview (PB-3) in this repo are built and tested; storage/sync (PB-2) is designed here but not yet built.

## System Overview

```
+--------------------------------------------------------------+
|                       BitBooks App                            |
|      React + TypeScript · static bundle · no backend          |
|                                                               |
|   +----------+  +----------+  +---------+  +----------+      |
|   |  Home    |  | Activity |  | Accounts|  | Settings |      |
|   | net worth|  |   feed   |  | grouped |  |  policy  |      |
|   | integrity|  |  sheets  |  |registers|  |  key     |      |
|   +----+-----+  +----+-----+  +----+----+  +----+-----+      |
|        |             |             |            |             |
|   +----v-------------v-------------v------------v-----+      |
|   |                   UI layer                         |      |
|   +----------------------+-----------------------------+     |
|                          |                                    |
|   +----------------------v-----------------------------+     |
|   |        PURE DOMAIN CORE  (src/domain/ · PB-1)       |     |
|   |  accounts tree · Txn/Splits (Σ value = 0, integers) |     |
|   |  txn classifier: ACQUISITION | TRANSFER | DISPOSAL  |     |
|   |  foldLots → lot ledger (derived, never stored)      |     |
|   |  reports = pure fns over reduced state              |     |
|   |  NO UI imports · NO sync imports · NO Date.now()    |     |
|   +----------------------+-----------------------------+     |
|                          | single write path (one store action)
|   +----------------------v-----------------------------+     |
|   |            BOOK STORAGE + SYNC (PB-2, next)         |     |
|   |  bookKey (32 B, per epoch) → owner + viewer wraps   |     |
|   |  monthly pages (48 KB soft split) · manifest oracle |     |
|   |  PULL-before-PUBLISH · monotonic created_at ·       |     |
|   |  manifest-as-commit · dirty timer retry             |     |
|   +---------+--------------------------+---------------+     |
+-------------|--------------------------|----------------------+
              v                          v
      +---------------+          +----------------+
      | nostr relays  |          | Local persist  |
      | (ciphertext   |          | (arrives with  |
      |  only, NIP-65)|          |  PB-2)         |
      +---------------+          +----------------+
```

External systems: **none required.** The one outbound call in the preview is the live bitcoin price (display only — E2v2; confirmed numbers go on the record). Optional later: the concierge relay (ours, paid, never a dependence), Lightning zaps (outbound tip only).

## Core Data Model

```
Account (GnuCash-typed: ASSET/BANK/CASH · LIABILITY/CREDIT ·
         EQUITY/INCOME · EXPENSE; commodity USD|BTC; tree via parentId;
         BTC accounts: lotMethod FIFO|SPEC + custodian)
Txn  { date (LOCAL — the accounting period) · utc (REQUIRED on
       lot-touching txns — lot ordering, holding period, broker match:
       dual timestamps) · splits[] with Σ valueCents === 0 }
Split{ valueCents (signed int, USD cents) · amountSats? (signed int,
       BTC accounts — the GnuCash value/amount duality) ·
       reconcile n|c|y · lots?: LotRef[] (outflows — RECORDED at post) ·
       lot?: { basisUnknown? } (acquisitions — the split IS the lot) }
LotRef { lotId = `${txnId}:${splitIndex}` · sats }
Policy { lotMethod per account · networkFeeTreatment expense|capitalize ·
         closedThrough · functionalCurrency USD }
Reading { priceCents, asOf } — confirmed by the user; live price is
         display-only until confirmed (E2v2)
```

**Classifier (total, reducer-enforced):** net sats over BTC splits > 0 ⇒ ACQUISITION (each positive BTC split creates a lot; fees fold into basis) · = 0 ⇒ TRANSFER (carries basis, nets to zero in sats AND value, may not touch Income/Expense/Equity) · < 0 ⇒ DISPOSAL (BTC leaves at basis; realized gain is the balancing figure). A fee-shaped transfer (one BTC out, one BTC in, net negative, at most one expense split) is TRANSFER_WITH_FEE. Mixed acquire+dispose and fan-out transfers are rejected in v1.

**Invariants (each one is a property test in `test/`):**
1. Σ valueCents = 0 per txn; trial balance nets to zero after any prefix.
2. TRANSFER-NEUTRALITY: no sequence of transfers changes realized gain by one cent. *The bug this design exists to prevent — its regression test was written first.*
3. Lot cross-check: per BTC account, Σ lot placements ≡ Σ amountSats — always.
4. Lot selections recorded at post, never recomputed; method changes never rewrite history.
5. BASIS-HONESTY: basisUnknown contributes *nothing* to basis totals and is counted separately, loudly — never silently $0.
6. Integer money only; allocation remainder handling is exact (per-placement basis: no penny residue, ever).
7. Period lock rejects postings ≤ closedThrough; closed pages byte-stable.
8. DEGRADED ⇒ read-only, no close, no Basis Package (refusals are code paths).

## The Most Important Data Flow: Entry → Close → Prove

```
RECORD   template (front door) or custom editor (escape hatch)
         → classify → disposal? lot picker (policy pre-selects; choice
           WRITTEN to the split) → Σ=0 gate → post via the single store
           action

CLOSE    requires reconciled splits · lot cross-check exact · TB Σ=0
         → stamps the confirmed price reading → page freezes

PROVE    broker reconcile (five-defect taxonomy) → Basis Package
         (frozen, elections on face, undocumented sats named) →
         self-filer renders (8949/Sched D, TurboTax/H&R Block CSV) —
         same fold, file formats never APIs
```

## Event Kind Map (the sync layer to come)

All app data rides **kind 30078** (NIP-78 replaceable) — custom kinds rejected (relay policy risk, no interop win). Envelope on every encrypted event: `{ v, epoch, cipher }`.

| Event | `d` tag | Encrypted with |
|---|---|---|
| Settings + CoA + policy | `bitbooks:settings:{bookId}:v1` | signer NIP-44 (self) |
| Book-key wrap (owner) | `bitbooks:bookkey:{bookId}:self:e{n}` | signer NIP-44 (self) |
| Book-key wrap (viewer) | `bitbooks:bookkey:{bookId}:{viewerPub}:e{n}` | signer NIP-44 → viewer |
| Journal page (monthly, 48 KB split) | `bitbooks:journal:{bookId}:{YYYY-MM}:p{n}` | symmetric NIP-44 (bookKey) |
| Manifest — **the completeness oracle** | `bitbooks:manifest:{bookId}:v1` | symmetric (bookKey) |
| Import dedup index | `bitbooks:dedup:{bookId}:{YYYY}` | symmetric (bookKey) |
| Relay list | kind 10002 (NIP-65) | — |

No lot events exist — lots are a fold over pages. `bookId='main'` in v1 but present in every d-tag so multi-book is additive.

## Sync Law (inherited from Personal ₿LOC, battle-tested)

1. PULL before PUBLISH — seed state never clobbers remote.
2. Per-d-tag monotonic `created_at`.
3. An ack is a real relay OK frame.
4. Single writer of actuals — one store action mutates postings.
5. Manifest after pages — manifest is the commit marker for dirty-retry.
6. iOS PWA never fires `online` — retry is timer-based (5s→60s).

Hydration: settings → owner wrap (latest epoch) → manifest → pages (parallel, hash-verified) → reduce → foldLots. Reconcile by manifest hash, never timestamps. COMPLETE or DEGRADED — nothing between.

## Identity & Grants

- One Recovery Key = the ₿LOC key: NIP-06 mnemonic → keyVault (WebAuthn PRF/PIN) → word quiz → backup gate. Sign-in: local key (iOS PWA) · NIP-07 (desktop) · NIP-46. No books until the backup ladder is climbed; there is no reset.
- Accountant grant: wrap the bookKey to the accountant's npub. Revoke = epoch rotation; retains-what-they-saw stated honestly.

## Architectural Principles

1. **No server, ever.** Static bundle + relays + encrypted local persist. A backend PR is a thesis violation. (Paid *services* — hosted relay, managed backups — are servers doing real work beside the app, never under it.)
2. **The pure core stays pure.** `src/domain/` has no UI/sync/clock imports; timestamps are inputs; property-tested.
3. **The fold is the single derived truth.** Registers, reports, Package, exports — all pure functions over the same fold; no second computation path; no stored derived basis.
4. **Local-first, manifest-verified.** Save locally immediately; relays repair in background; completeness is *proven* (COMPLETE/DEGRADED), never assumed.
5. **Integer money only.**
6. **Live for display, confirmed for records (E2v2).** The price fetch is the one outbound call and carries no user data.
7. **Refusals are code paths** — close gates, Package gates, DEGRADED read-only live in reducers, not copy.
8. **500-line file limit** (RUNSTR rule, adopted).
9. **One nostr library, pinned:** `nostr-tools` **2.23.5 exact**. **Never NDK.** NIP-44 layer discipline: signer-nip44 (pubkey-first) in auth; low-level nip44 (key-first) in storage; a lint boundary enforces — swapping them corrupts silently.
10. **The six simplicity rules govern every screen.** Terminology: "Recovery Key," "relays" (Settings only); never nsec/NIP-x in primary UI.
11. **Encrypt before upload, always** — any future blob is NIP-44'd client-side, addressed by sha256(ciphertext).
