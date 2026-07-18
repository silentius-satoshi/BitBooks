/** Test builders — all ids/dates/utc are explicit inputs; the core generates nothing. */
import {
  COA_BITCOINER_SOLE_OPERATOR, LedgerState, LotRef, Split, Txn,
  initialState, peekCarriedBasis, peekTransferLegs, post, prepareDisposal, proposeLots,
} from '../src/domain';

export const GAIN = 'income:realized-gain';
export const LOSS = 'exp:realized-loss';
export const FEES = 'exp:network-fees';
export const BANK = 'bank:checking';

export function freshState(policy: Parameters<typeof initialState>[1] = {}): LedgerState {
  return initialState(COA_BITCOINER_SOLE_OPERATOR, policy);
}

export const usd = (accountId: string, valueCents: number): Split =>
  ({ accountId, valueCents, reconcile: 'n' });

export const btcIn = (accountId: string, sats: number, basisCents: number, unknown = false): Split =>
  ({ accountId, valueCents: basisCents, amountSats: sats, reconcile: 'n', ...(unknown ? { lot: { basisUnknown: true } } : {}) });

export const btcOut = (accountId: string, sats: number, basisCents: number, lots: LotRef[]): Split =>
  ({ accountId, valueCents: -basisCents, amountSats: -sats, reconcile: 'n', lots });

let n = 0;
export const nextId = (p = 't') => `${p}${++n}`;

export function acquire(
  state: LedgerState, acct: string, sats: number, cents: number,
  o: { id?: string; date?: string; utc?: string; unknown?: boolean; funding?: string } = {},
): { state: LedgerState; txn: Txn } {
  const id = o.id ?? nextId('acq');
  const txn: Txn = {
    id,
    date: o.date ?? '2027-01-10',
    utc: o.utc ?? `${o.date ?? '2027-01-10'}T12:00:00Z`,
    description: `acquire ${sats}`,
    splits: [btcIn(acct, sats, cents, o.unknown), usd(o.funding ?? BANK, -cents)],
  };
  return { state: post(state, txn), txn };
}

export function transfer(
  state: LedgerState, from: string, to: string, sats: number,
  o: { id?: string; date?: string; utc?: string; refs?: LotRef[] } = {},
): { state: LedgerState; txn: Txn } {
  const refs = o.refs ?? proposeLots(state.lots, from, sats, 'FIFO');
  const { basisCents } = peekCarriedBasis(state.lots, from, refs);
  const txn: Txn = {
    id: o.id ?? nextId('tr'),
    date: o.date ?? '2027-02-10',
    utc: o.utc ?? `${o.date ?? '2027-02-10'}T12:00:00Z`,
    description: `transfer ${sats}`,
    splits: [btcOut(from, sats, basisCents, refs), btcIn(to, sats, basisCents)],
  };
  // btcIn adds a lot marker? No: transfer inflow must NOT create a lot — classification handles it;
  // the inflow split has no `lot` field, and classify() sees net 0 → TRANSFER. ✓
  return { state: post(state, txn), txn };
}

export function feeTransfer(
  state: LedgerState, from: string, to: string, moveSats: number, feeSats: number,
  o: { id?: string; date?: string; utc?: string; refs?: LotRef[] } = {},
): { state: LedgerState; txn: Txn } {
  const outSats = moveSats + feeSats;
  const refs = o.refs ?? proposeLots(state.lots, from, outSats, 'FIFO');
  const { movedBasisCents, feeBasisCents } = peekTransferLegs(state.lots, from, refs, moveSats);
  const policy = state.policy.networkFeeTreatment;
  const splits: Split[] = policy === 'expense'
    ? [
        btcOut(from, outSats, movedBasisCents + feeBasisCents, refs),
        btcIn(to, moveSats, movedBasisCents),
        usd(FEES, feeBasisCents),
      ]
    : [
        btcOut(from, outSats, movedBasisCents + feeBasisCents, refs),
        btcIn(to, moveSats, movedBasisCents + feeBasisCents),
      ];
  const txn: Txn = {
    id: o.id ?? nextId('ftr'),
    date: o.date ?? '2027-02-15',
    utc: o.utc ?? `${o.date ?? '2027-02-15'}T12:00:00Z`,
    description: `fee-transfer ${moveSats}+${feeSats}`,
    splits,
  };
  return { state: post(state, txn), txn };
}

/** Disposal at market: builds outflow at basis, proceeds to bank, plug to gain/loss. */
export function dispose(
  state: LedgerState, acct: string, sats: number, proceedsCents: number,
  o: { id?: string; date?: string; utc?: string; refs?: LotRef[] } = {},
): { state: LedgerState; txn: Txn; gainCents: number } {
  const prep = prepareDisposal(state, acct, sats, o.refs);
  const gain = proceedsCents - prep.basisCents;
  const plug: Split = gain >= 0 ? usd(GAIN, -gain) : usd(LOSS, -gain);
  const txn: Txn = {
    id: o.id ?? nextId('disp'),
    date: o.date ?? '2027-03-10',
    utc: o.utc ?? `${o.date ?? '2027-03-10'}T12:00:00Z`,
    description: `dispose ${sats}`,
    splits: [
      btcOut(acct, sats, prep.basisCents, prep.refs),
      usd(BANK, proceedsCents),
      plug,
    ],
  };
  return { state: post(state, txn), txn, gainCents: gain };
}

/** Total realized gain currently on the books: income gain credit − loss debits. */
export function realizedGain(state: LedgerState): number {
  const g = state.balances[GAIN]?.valueCents ?? 0;   // credit-normal: negative value = gain
  const l = state.balances[LOSS]?.valueCents ?? 0;   // debit-normal: positive value = loss
  const out = -g - l;
  return out === 0 ? 0 : out;                        // −0 hygiene
}

/** Deterministic RNG (mulberry32) — the core has no randomness; tests seed their own. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
