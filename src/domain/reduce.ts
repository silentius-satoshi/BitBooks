/**
 * PB-1 · posting reducers — the single write path. Every D-series invariant is enforced HERE,
 * never in a UI handler (master spec §6.9 discipline, carried from BLOC).
 * Pure: (state, txn) → new state. No IO, no clocks, no randomness.
 */
import { classify, isLotTouching, splitIsBtc } from './classify';
import {
  applyTxnToFold, cowFold, emptyFold, foldLots, lotIdOf, peekCarriedBasis, peekTransferLegs, proposeLots,
} from './lots';
import {
  Account, LedgerError, LedgerState, LotRef, PL_OR_EQUITY, Policy, Txn,
  assertInt, monthOf,
} from './types';

export const DEFAULT_POLICY: Policy = {
  networkFeeTreatment: 'expense',
  closedThrough: null,
  functionalCurrency: 'USD',
};

export function initialState(accounts: Account[], policy: Partial<Policy> = {}): LedgerState {
  const map: Record<string, Account> = {};
  for (const a of accounts) {
    if (map[a.id]) throw new LedgerError('DUPLICATE_TXN_ID', `duplicate account id ${a.id}`);
    map[a.id] = a;
  }
  return {
    accounts: map,
    policy: { ...DEFAULT_POLICY, ...policy },
    txns: [],
    balances: {},
    lots: emptyFold(),
  };
}

/** Structural + monetary validation common to every txn. Throws LedgerError. */
function validateShape(state: LedgerState, txn: Txn): void {
  if (state.txns.some(t => t.id === txn.id)) {
    throw new LedgerError('DUPLICATE_TXN_ID', `txn id ${txn.id} already posted`);
  }
  if (!txn.splits || txn.splits.length < 2) {
    throw new LedgerError('MIN_SPLITS', 'a transaction needs at least two splits');
  }
  let sum = 0;
  txn.splits.forEach((s, i) => {
    const a = state.accounts[s.accountId];
    if (!a) throw new LedgerError('UNKNOWN_ACCOUNT', `split ${i}: unknown account ${s.accountId}`);
    if (a.placeholder) throw new LedgerError('PLACEHOLDER_POSTING', `split ${i}: ${a.id} is a placeholder node`);
    assertInt(s.valueCents, `split ${i} valueCents`);
    sum += s.valueCents;
    if (a.commodity === 'BTC') {
      if (s.amountSats === undefined || s.amountSats === 0) {
        throw new LedgerError('MISSING_SATS', `split ${i}: BTC account requires nonzero amountSats`);
      }
      assertInt(s.amountSats, `split ${i} amountSats`);
      s.lots?.forEach((r, j) => {
        assertInt(r.sats, `split ${i} lot ref ${j} sats`);
        if (r.sats <= 0) throw new LedgerError('LOTS_SUM_MISMATCH', `split ${i} ref ${j}: sats must be positive`);
      });
    } else {
      if (s.amountSats !== undefined || s.lots || s.lot) {
        throw new LedgerError('SATS_ON_NON_BTC', `split ${i}: sats/lot fields on non-BTC account ${a.id}`);
      }
    }
  });
  if (sum !== 0) throw new LedgerError('UNBALANCED', `Σ valueCents = ${sum}, must be 0`);
  const closed = state.policy.closedThrough;
  if (closed && monthOf(txn.date) <= closed) {
    throw new LedgerError('PERIOD_CLOSED', `period ${monthOf(txn.date)} is closed through ${closed} — post a reversing entry in an open month`);
  }
  if (isLotTouching(txn, state.accounts) && !txn.utc) {
    throw new LedgerError('MISSING_UTC', 'lot-touching transactions require a utc instant (D15)');
  }
}

/** Class-specific validation (D12/D13/D14 enforcement). Returns lot ids this txn touches. */
function validateByClass(state: LedgerState, txn: Txn): string[] {
  const cls = classify(txn, state.accounts);
  const touched: string[] = [];

  if (cls.kind === 'PLAIN') return touched;

  if (cls.kind === 'ACQUISITION') {
    txn.splits.forEach((s, i) => {
      if (!splitIsBtc(s, state.accounts)) return;
      if ((s.amountSats as number) < 0) throw new LedgerError('MIXED_ACQUIRE_DISPOSE', 'unreachable');
      if (s.valueCents < 0) {
        throw new LedgerError('ACQ_SIGN', `split ${i}: acquisition basis (valueCents) cannot be negative`);
      }
      if (s.lots) throw new LedgerError('LOTS_SUM_MISMATCH', `split ${i}: acquisition splits do not carry LotRefs`);
      touched.push(lotIdOf(txn.id, i));
    });
    return touched;
  }

  if (cls.kind === 'TRANSFER' || cls.kind === 'TRANSFER_WITH_FEE') {
    // D12: may not touch INCOME / EXPENSE / EQUITY — with the single §6.4 exception:
    // TRANSFER_WITH_FEE under policy 'expense' carries EXACTLY ONE expense split equal to the fee basis.
    const from = txn.splits[cls.fromIdx];
    const to = txn.splits[cls.toIdx];
    const refs = from.lots;
    if (!refs || refs.length === 0) {
      throw new LedgerError('LOTS_REQUIRED', 'transfer outflow must record its LotRefs (D14)');
    }
    refs.forEach(r => touched.push(r.lotId));

    const others = txn.splits.filter((_, i) => i !== cls.fromIdx && i !== cls.toIdx);
    const plTouches = txn.splits.filter(s => PL_OR_EQUITY.has(state.accounts[s.accountId].type));

    if (cls.kind === 'TRANSFER') {
      if (plTouches.length > 0) {
        throw new LedgerError('TRANSFER_TOUCHES_PL', 'transfers cannot touch Income/Expense/Equity (D12)');
      }
      if (txn.splits.length !== 2 || others.length !== 0) {
        throw new LedgerError('TRANSFER_SHAPE', 'a v1 transfer is exactly two splits (1 → 1)');
      }
      const { basisCents } = peekCarriedBasis(state.lots, from.accountId, refs);
      if (from.valueCents !== -basisCents || to.valueCents !== basisCents) {
        throw new LedgerError('TRANSFER_VALUE',
          `transfer legs must carry basis exactly: expected ∓${basisCents}, got ${from.valueCents}/${to.valueCents}`);
      }
      return touched;
    }

    // TRANSFER_WITH_FEE
    const { movedBasisCents, feeBasisCents } =
      peekTransferLegs(state.lots, from.accountId, refs, to.amountSats as number);
    if (state.policy.networkFeeTreatment === 'expense') {
      if (others.length !== 1) {
        throw new LedgerError('FEE_SPLIT_INVALID', 'fee-transfer (expense policy) is exactly three splits: out, in, fee expense');
      }
      const feeSplit = others[0];
      const feeAcct = state.accounts[feeSplit.accountId];
      if (feeAcct.type !== 'EXPENSE') {
        throw new LedgerError('FEE_SPLIT_INVALID', 'the fee split must debit an EXPENSE account');
      }
      if (feeSplit.valueCents !== feeBasisCents) {
        throw new LedgerError('FEE_SPLIT_INVALID', `fee split must carry the fee sats' basis exactly (${feeBasisCents})`);
      }
      if (from.valueCents !== -(movedBasisCents + feeBasisCents) || to.valueCents !== movedBasisCents) {
        throw new LedgerError('TRANSFER_VALUE',
          `fee-transfer legs: out must be −${movedBasisCents + feeBasisCents}, in must be ${movedBasisCents}`);
      }
      const nonFeePl = plTouches.filter(s => s !== feeSplit);
      if (nonFeePl.length > 0) {
        throw new LedgerError('TRANSFER_TOUCHES_PL', 'only the fee expense split may touch P&L (§6.4)');
      }
    } else { // capitalize
      if (txn.splits.length !== 2 || others.length !== 0) {
        throw new LedgerError('FEE_SPLIT_INVALID', 'fee-transfer (capitalize policy) is exactly two splits — fee basis rides to the destination');
      }
      if (plTouches.length > 0) {
        throw new LedgerError('TRANSFER_TOUCHES_PL', 'transfers cannot touch Income/Expense/Equity (D12)');
      }
      const total = movedBasisCents + feeBasisCents;
      if (from.valueCents !== -total || to.valueCents !== total) {
        throw new LedgerError('TRANSFER_VALUE',
          `capitalized fee-transfer legs must carry ∓${total} (moved ${movedBasisCents} + fee ${feeBasisCents})`);
      }
    }
    return touched;
  }

  // DISPOSAL — outflow leaves AT BASIS (§6.4); realized gain is the caller's plug split.
  txn.splits.forEach((s, i) => {
    if (!splitIsBtc(s, state.accounts)) return;
    const refs = s.lots;
    if (!refs || refs.length === 0) {
      throw new LedgerError('LOTS_REQUIRED', `split ${i}: disposal outflow must record its LotRefs (D14)`);
    }
    const supplied = refs.reduce((acc, r) => acc + r.sats, 0);
    if (supplied !== -(s.amountSats as number)) {
      throw new LedgerError('LOTS_SUM_MISMATCH',
        `split ${i}: refs supply ${supplied} sats, outflow needs ${-(s.amountSats as number)}`);
    }
    refs.forEach(r => touched.push(r.lotId));
    const { basisCents } = peekCarriedBasis(state.lots, s.accountId, refs);
    if (s.valueCents !== -basisCents) {
      throw new LedgerError('OUTFLOW_NOT_AT_BASIS',
        `split ${i}: BTC leaves at basis — expected valueCents ${-basisCents}, got ${s.valueCents}`);
    }
  });
  return touched;
}

/** Post a transaction. Returns a NEW state; the input state is not mutated. */
export function post(state: LedgerState, txn: Txn): LedgerState {
  validateShape(state, txn);
  const touched = validateByClass(state, txn);

  // Apply — copy-on-write on the fold; balances shallow-copied per touched account.
  const lots = cowFold(state.lots, touched);
  applyTxnToFold(lots, txn, state.accounts, state.policy.networkFeeTreatment);

  const balances = { ...state.balances };
  const z = (x: number) => (x === 0 ? 0 : x);   // normalize −0 → 0 (Object.is hygiene)
  for (const s of txn.splits) {
    const prev = balances[s.accountId] ?? { valueCents: 0, sats: 0 };
    balances[s.accountId] = {
      valueCents: z(prev.valueCents + s.valueCents),
      sats: z(prev.sats + (s.amountSats ?? 0)),
    };
  }

  // I4 incremental cross-check on touched BTC accounts — an internal-corruption tripwire, loud by design.
  for (const s of txn.splits) {
    const a = state.accounts[s.accountId];
    if (a.commodity !== 'BTC') continue;
    const foldSats = lots.bySats[s.accountId] ?? 0;
    const balSats = balances[s.accountId]?.sats ?? 0;
    if (foldSats !== balSats) {
      throw new LedgerError('CROSS_CHECK_FAILED',
        `${s.accountId}: fold says ${foldSats} sats, journal says ${balSats} — the ledger is broken; failing loudly`);
    }
  }

  return { ...state, txns: [...state.txns, txn], balances, lots };
}

/** Build + post the reversing entry for a posted txn (the only correction path once a month closes). */
export function reverse(
  state: LedgerState, txnId: string, opts: { id: string; date: string; utc?: string },
): LedgerState {
  const orig = state.txns.find(t => t.id === txnId);
  if (!orig) throw new LedgerError('TXN_NOT_FOUND', `txn ${txnId} not found`);

  const cls = classify(orig, state.accounts);
  const splits = orig.splits.map((s) => {
    const flipped: typeof s = {
      accountId: s.accountId,
      valueCents: -s.valueCents,
      reconcile: 'n' as const,
      ...(s.amountSats !== undefined ? { amountSats: -s.amountSats } : {}),
    };
    return flipped;
  });

  // Lot wiring for the reversal:
  //  - reversing an ACQUISITION disposes the created lots (refs to them);
  //  - reversing a DISPOSAL re-acquires (new lots at the disposed basis) — no refs;
  //  - reversing a TRANSFER moves the same lots back (refs against the destination).
  if (cls.kind === 'ACQUISITION') {
    orig.splits.forEach((s, i) => {
      if (!splitIsBtc(s, state.accounts)) return;
      const rev = splits[i];
      rev.lots = [{ lotId: lotIdOf(orig.id, i), sats: s.amountSats as number }];
    });
  } else if (cls.kind === 'TRANSFER' || cls.kind === 'TRANSFER_WITH_FEE') {
    if (cls.kind === 'TRANSFER_WITH_FEE') {
      throw new LedgerError('TRANSFER_SHAPE',
        'reversing a fee-transfer is not mechanical (fee sats are gone) — post a manual correcting entry');
    }
    const rev = splits[cls.toIdx];               // reversal flows destination → source
    rev.lots = (orig.splits[cls.fromIdx].lots ?? []).map(r => ({ ...r }));
  } else if (cls.kind === 'DISPOSAL') {
    // flipped outflow is now an inflow at the same value — it becomes a fresh lot (re-acquisition).
    splits.forEach((rev) => { if (rev.lots) delete rev.lots; });
  }

  const reversal: Txn = {
    id: opts.id,
    date: opts.date,
    utc: opts.utc ?? orig.utc,
    description: `REVERSAL of ${orig.id}: ${orig.description}`,
    splits,
    meta: { source: 'reversal', reverses: orig.id },
  };
  return post(state, reversal);
}

/** Close through a month (§8.6): requires the canonical fold to cross-check exactly. */
export function closeThrough(state: LedgerState, ym: string): LedgerState {
  const prev = state.policy.closedThrough;
  if (prev && ym <= prev) {
    throw new LedgerError('PERIOD_CLOSED', `already closed through ${prev}`);
  }
  const canonical = foldLots(state.txns, state.accounts, state.policy.networkFeeTreatment);
  for (const [acct, a] of Object.entries(state.accounts)) {
    if (a.commodity !== 'BTC') continue;
    const foldSats = canonical.bySats[acct] ?? 0;
    const balSats = state.balances[acct]?.sats ?? 0;
    if (foldSats !== balSats) {
      throw new LedgerError('CROSS_CHECK_FAILED',
        `close refused: ${acct} fold=${foldSats} journal=${balSats}`);
    }
  }
  return { ...state, policy: { ...state.policy, closedThrough: ym } };
}

/** UI aid: propose lots per account policy + peek the carried basis and the suggested plug. */
export function prepareDisposal(
  state: LedgerState, accountId: string, sats: number, refs?: LotRef[],
): { refs: LotRef[]; basisCents: number; anyUnknown: boolean } {
  const acct = state.accounts[accountId];
  if (!acct || acct.commodity !== 'BTC') {
    throw new LedgerError('UNKNOWN_ACCOUNT', `${accountId} is not a BTC account`);
  }
  const chosen = refs && refs.length > 0
    ? refs
    : proposeLots(state.lots, accountId, sats, acct.lotMethod ?? 'FIFO');
  const peek = peekCarriedBasis(state.lots, accountId, chosen);
  return { refs: chosen, basisCents: peek.basisCents, anyUnknown: peek.anyUnknown };
}
