/**
 * PB-1 · txn classifier — total, unambiguous, reducer-enforced (master spec §6.3–6.4).
 * Classification is by net sats over BTC-commodity splits, with structural rules:
 *   net > 0  ACQUISITION  (no negative BTC splits allowed — mixed is rejected)
 *   net = 0  TRANSFER     (exactly 1→1, carries basis, cannot touch P&L/Equity — D12)
 *   net < 0  DISPOSAL     (no positive BTC splits — mixed is rejected)
 *   EXCEPT: exactly two BTC splits of opposite sign with |out| = in + fee → TRANSFER_WITH_FEE (§6.4 bend)
 */
import { Account, LedgerError, Split, Txn, TxnClass } from './types';

export function btcSplitIndices(txn: Txn, accounts: Record<string, Account>): number[] {
  const idx: number[] = [];
  txn.splits.forEach((s, i) => {
    const a = accounts[s.accountId];
    if (a && a.commodity === 'BTC') idx.push(i);
  });
  return idx;
}

export function classify(txn: Txn, accounts: Record<string, Account>): TxnClass {
  const btcIdx = btcSplitIndices(txn, accounts);
  if (btcIdx.length === 0) return { kind: 'PLAIN' };

  for (const i of btcIdx) {
    const s = txn.splits[i];
    if (s.amountSats === undefined || s.amountSats === 0) {
      throw new LedgerError('ZERO_SATS', `BTC split ${i} must carry nonzero amountSats`);
    }
  }
  const sats = (i: number) => txn.splits[i].amountSats as number;
  const net = btcIdx.reduce((acc, i) => acc + sats(i), 0);
  const positives = btcIdx.filter(i => sats(i) > 0);
  const negatives = btcIdx.filter(i => sats(i) < 0);

  // The §6.4 bend: exactly one BTC out + one BTC in, net negative by the fee, and the txn's
  // non-BTC surface is fee-shaped: either NO non-BTC splits (capitalize) or exactly ONE
  // EXPENSE split (expense). Anything else (bank proceeds, income, …) is a mixed txn — split it.
  // The discriminator is STRUCTURAL, not arithmetic: |out| = in + fee is an identity and proves nothing.
  if (positives.length === 1 && negatives.length === 1 && net < 0) {
    const nonBtc = txn.splits.filter((s) => {
      const a = accounts[s.accountId];
      return !a || a.commodity !== 'BTC';
    });
    const feeShaped =
      nonBtc.length === 0 ||
      (nonBtc.length === 1 && accounts[nonBtc[0].accountId]?.type === 'EXPENSE');
    if (feeShaped) {
      return { kind: 'TRANSFER_WITH_FEE', fromIdx: negatives[0], toIdx: positives[0], feeSats: -net };
    }
    throw new LedgerError('MIXED_ACQUIRE_DISPOSE',
      'txn both acquires and disposes BTC — split it into two transactions (only a network-fee transfer may net negative across two BTC legs)');
  }

  if (net > 0) {
    if (negatives.length > 0) {
      throw new LedgerError('MIXED_ACQUIRE_DISPOSE', 'txn both acquires and disposes BTC — split it into two transactions');
    }
    return { kind: 'ACQUISITION' };
  }
  if (net < 0) {
    if (positives.length > 0) {
      throw new LedgerError('MIXED_ACQUIRE_DISPOSE', 'txn both acquires and disposes BTC — split it into two transactions');
    }
    return { kind: 'DISPOSAL' };
  }
  // net === 0 → TRANSFER; v1 requires exactly 1 → 1 (fan-out rejected, §6.3)
  if (positives.length !== 1 || negatives.length !== 1) {
    throw new LedgerError('TRANSFER_SHAPE', 'v1 transfers are 1-account → 1-account — split fan-outs');
  }
  const fromIdx = negatives[0], toIdx = positives[0];
  if (Math.abs(sats(fromIdx)) !== sats(toIdx)) {
    // net===0 with 1↔1 implies equality; defensive.
    throw new LedgerError('TRANSFER_SHAPE', 'transfer legs must move equal sats');
  }
  if (txn.splits[fromIdx].accountId === txn.splits[toIdx].accountId) {
    throw new LedgerError('TRANSFER_SHAPE', 'transfer must move between two distinct accounts');
  }
  return { kind: 'TRANSFER', fromIdx, toIdx };
}

export function isLotTouching(txn: Txn, accounts: Record<string, Account>): boolean {
  return btcSplitIndices(txn, accounts).length > 0;
}

export function splitIsBtc(s: Split, accounts: Record<string, Account>): boolean {
  const a = accounts[s.accountId];
  return !!a && a.commodity === 'BTC';
}
