/** PB-1 · trial balance + basis health — pure functions over reduced state (§6.8). */
import {
  BasisHealthRow, LedgerState, TrialBalance, TrialBalanceRow,
} from '../types';

export function trialBalance(state: LedgerState): TrialBalance {
  const rows: TrialBalanceRow[] = [];
  let d = 0, c = 0;
  for (const accountId of Object.keys(state.balances).sort()) {
    const v = state.balances[accountId].valueCents;
    if (v === 0) { rows.push({ accountId, debitCents: 0, creditCents: 0 }); continue; }
    if (v > 0) { rows.push({ accountId, debitCents: v, creditCents: 0 }); d += v; }
    else { rows.push({ accountId, debitCents: 0, creditCents: -v }); c += -v; }
  }
  return { rows, totalDebitCents: d, totalCreditCents: c };
}

/**
 * Basis health per BTC account (D13): documented vs unknown sats, and the documented basis.
 * Unknown lots contribute NOTHING to documentedBasisCents and are counted separately, by name (I7).
 */
export function basisHealth(state: LedgerState): BasisHealthRow[] {
  const perAccount: Record<string, BasisHealthRow> = {};
  for (const [accountId, a] of Object.entries(state.accounts)) {
    if (a.commodity !== 'BTC') continue;
    perAccount[accountId] = { accountId, documentedSats: 0, unknownSats: 0, documentedBasisCents: 0 };
  }
  for (const lot of Object.values(state.lots.lots)) {
    for (const [accountId, pl] of Object.entries(lot.placements)) {
      const row = perAccount[accountId];
      if (!row || pl.sats === 0) continue;
      if (lot.basisUnknown) {
        row.unknownSats += pl.sats;                 // named, never rounded away
      } else {
        row.documentedSats += pl.sats;
        row.documentedBasisCents += pl.basisCents;  // exact — placement basis is integral by construction
      }
    }
  }
  return Object.values(perAccount).sort((x, y) => (x.accountId < y.accountId ? -1 : 1));
}
