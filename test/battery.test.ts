/**
 * The PB-1 gate: property tests + the 10k-txn battery (spec §6, master spec §17.3).
 * Seeded, deterministic, no wall-clock dependence.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  LedgerState, foldLots, post, proposeLots, trialBalance, basisHealth,
} from '../src/domain';
import {
  BANK, acquire, dispose, feeTransfer, freshState, nextId, realizedGain, rng, transfer, usd,
} from './helpers';

const BTC_ACCTS = ['btc:cold', 'btc:strike', 'btc:coinbase'] as const;

describe('property — allocation exactness (spec call 3)', () => {
  it('Σ lifetime consumption shares ≡ basisCents for any chunking', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5_000_000 }),          // origin sats
        fc.integer({ min: 0, max: 10_000_000 }),         // basis cents
        fc.array(fc.integer({ min: 1, max: 1_000_000 }), { minLength: 1, maxLength: 12 }),
        (originSats, basisCents, chunkSeed) => {
          let s = freshState();
          s = acquire(s, 'btc:cold', originSats, basisCents).state;
          // normalize chunks to fully consume originSats
          const chunks: number[] = [];
          let left = originSats;
          for (const c of chunkSeed) {
            if (left === 0) break;
            const take = Math.min(1 + (c % left), left);
            chunks.push(take); left -= take;
          }
          if (left > 0) chunks.push(left);
          let consumedBasis = 0;
          for (const chunk of chunks) {
            const r = dispose(s, 'btc:cold', chunk, 0);
            s = r.state; consumedBasis += -r.gainCents;  // proceeds 0 ⇒ gain = −carried basis
          }
          expect(consumedBasis).toBe(basisCents);
          expect(s.balances['btc:cold'].valueCents).toBe(0);
          expect(s.balances['btc:cold'].sats).toBe(0);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('property — I3 transfer shuffle cannot change total realized gain', () => {
  it('interleaving arbitrary transfers between acquisition and full disposal preserves gain to the cent', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 4_000_000 }),          // sats
        fc.integer({ min: 0, max: 8_000_000 }),          // basis
        fc.integer({ min: 0, max: 9_000_000 }),          // proceeds
        fc.array(fc.tuple(fc.nat(2), fc.nat(2), fc.integer({ min: 1, max: 100 })), { maxLength: 8 }),
        (sats, basis, proceeds, hops) => {
          // Baseline: acquire → dispose all, no transfers.
          let base = freshState();
          base = acquire(base, 'btc:cold', sats, basis).state;
          const baseGain = dispose(base, 'btc:cold', sats, proceeds).gainCents;

          // Shuffled: same acquisition, then random transfer hops, then dispose everything
          // from wherever the sats ended up (possibly several accounts).
          let s = freshState();
          s = acquire(s, 'btc:cold', sats, basis).state;
          for (const [fi, ti, pct] of hops) {
            const from = BTC_ACCTS[fi % 3];
            const to = BTC_ACCTS[ti % 3];
            if (from === to) continue;
            const avail = s.balances[from]?.sats ?? 0;
            if (avail === 0) continue;
            const move = Math.max(1, Math.floor((avail * pct) / 100));
            s = transfer(s, from, to, move).state;
          }
          let totalGain = 0;
          let remaining = sats;
          for (const acct of BTC_ACCTS) {
            const bal = s.balances[acct]?.sats ?? 0;
            if (bal === 0) continue;
            // pro-rate proceeds by sats so Σ proceeds is identical to baseline
            const p = acct === BTC_ACCTS.find(a => (s.balances[a]?.sats ?? 0) > 0)
              ? 0 : 0; // placeholder, replaced below
            void p;
            remaining -= bal;
            void remaining;
            const r = dispose(s, acct, bal, 0);
            s = r.state; totalGain += r.gainCents;
          }
          // All disposals at proceeds 0 → totalGain = −Σ carried basis. Baseline at proceeds `proceeds`
          // differs by exactly `proceeds`. Compare on the basis side to keep proceeds allocation exact:
          expect(totalGain).toBe(baseGain - proceeds);
          expect(realizedGain(s)).toBe(totalGain);
          const tb = trialBalance(s);
          expect(tb.totalDebitCents).toBe(tb.totalCreditCents);
        },
      ),
      { numRuns: 150 },
    );
  });
});

describe('the 10k battery — invariants hold at every checkpoint', () => {
  it('10,000 mixed txns across 3 BTC accounts / 3 years', () => {
    const rand = rng(0xB17B00C5);
    let s: LedgerState = freshState();
    let posted = 0;
    let day = 0;
    const dateOf = () => {
      const d = new Date(Date.UTC(2027, 0, 1) + day * 86_400_000);
      return d.toISOString().slice(0, 10);
    };

    const checkpoint = () => {
      const tb = trialBalance(s);
      expect(tb.totalDebitCents).toBe(tb.totalCreditCents);
      const canonical = foldLots(s.txns, s.accounts, s.policy.networkFeeTreatment);
      for (const acct of BTC_ACCTS) {
        const bal = s.balances[acct]?.sats ?? 0;
        expect(canonical.bySats[acct] ?? 0).toBe(bal);          // I4 canonical
        expect(s.lots.bySats[acct] ?? 0).toBe(bal);             // I4 incremental
      }
      const health = basisHealth(s);
      for (const row of health) {
        const bal = s.balances[row.accountId]?.sats ?? 0;
        expect(row.documentedSats + row.unknownSats).toBe(bal); // D13 accounting is total
        expect(row.documentedBasisCents).toBeGreaterThanOrEqual(0);
      }
    };

    while (posted < 10_000) {
      day += rand() < 0.4 ? 1 : 0;
      const roll = rand();
      try {
        if (roll < 0.32) {
          const acct = BTC_ACCTS[Math.floor(rand() * 3)];
          const sats = 1_000 + Math.floor(rand() * 5_000_000);
          const cents = Math.floor(rand() * 2_000_000);
          const unknown = rand() < 0.06;
          s = acquire(s, acct, sats, unknown ? 0 : cents, {
            id: nextId('bat-a'), date: dateOf(), utc: `${dateOf()}T0${Math.floor(rand() * 9)}:00:00Z`,
            unknown, funding: rand() < 0.15 ? 'equity:opening' : BANK,
          }).state;
          posted++;
        } else if (roll < 0.55) {
          const from = BTC_ACCTS[Math.floor(rand() * 3)];
          let to = BTC_ACCTS[Math.floor(rand() * 3)];
          if (to === from) to = BTC_ACCTS[(BTC_ACCTS.indexOf(from) + 1) % 3];
          const avail = s.balances[from]?.sats ?? 0;
          if (avail < 2) continue;
          const move = 1 + Math.floor(rand() * (avail - 1));
          s = transfer(s, from, to, move, { id: nextId('bat-t'), date: dateOf(), utc: `${dateOf()}T10:00:00Z` }).state;
          posted++;
        } else if (roll < 0.60) {
          const from = BTC_ACCTS[Math.floor(rand() * 3)];
          let to = BTC_ACCTS[Math.floor(rand() * 3)];
          if (to === from) to = BTC_ACCTS[(BTC_ACCTS.indexOf(from) + 2) % 3];
          const avail = s.balances[from]?.sats ?? 0;
          if (avail < 100) continue;
          const fee = 1 + Math.floor(rand() * Math.min(500, avail - 2));
          const move = 1 + Math.floor(rand() * (avail - fee - 1));
          s = feeTransfer(s, from, to, move, fee, { id: nextId('bat-f'), date: dateOf(), utc: `${dateOf()}T11:00:00Z` }).state;
          posted++;
        } else if (roll < 0.85) {
          const acct = BTC_ACCTS[Math.floor(rand() * 3)];
          const avail = s.balances[acct]?.sats ?? 0;
          if (avail < 1) continue;
          const sats = 1 + Math.floor(rand() * avail);
          const proceeds = Math.floor(rand() * 2_500_000);
          s = dispose(s, acct, sats, proceeds, { id: nextId('bat-d'), date: dateOf(), utc: `${dateOf()}T12:00:00Z` }).state;
          posted++;
        } else {
          const cents = 1 + Math.floor(rand() * 300_000);
          s = post(s, {
            id: nextId('bat-p'), date: dateOf(), description: 'plain expense',
            splits: [usd('exp:misc', cents), usd(BANK, -cents)],
          });
          posted++;
        }
      } catch (e) {
        throw new Error(`battery failed at txn ${posted}: ${(e as Error).message}`);
      }
      if (posted % 1_000 === 0) checkpoint();
    }
    checkpoint();
    expect(s.txns).toHaveLength(10_000);
  }, 120_000);
});
