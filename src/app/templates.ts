/**
 * PB-3 · the six templates — named for what people do, not how the ledger thinks (A1 rule 2).
 * Each builds a core-valid Txn via the domain helpers. Money moves from → to; no debit/credit.
 */
import {
  LedgerState, LotRef, Split, Txn, peekCarriedBasis, peekTransferLegs, prepareDisposal, proposeLots,
} from '../domain';

const usd = (accountId: string, valueCents: number): Split => ({ accountId, valueCents, reconcile: 'n' });
const btcIn = (accountId: string, sats: number, cents: number, unknown = false): Split =>
  ({ accountId, valueCents: cents, amountSats: sats, reconcile: 'n', ...(unknown ? { lot: { basisUnknown: true } } : {}) });
const btcOut = (accountId: string, sats: number, cents: number, lots: LotRef[]): Split =>
  ({ accountId, valueCents: -cents, amountSats: -sats, reconcile: 'n', lots });

export interface TemplateDef {
  key: 'buy' | 'transfer' | 'draw' | 'paydown' | 'interest' | 'disposal';
  title: string;                  // plain words
  hint: string;                   // from → to
}

export const TEMPLATES: TemplateDef[] = [
  { key: 'buy',      title: '₿ Buy bitcoin',                 hint: 'bank → bitcoin account' },
  { key: 'transfer', title: '⇄ Move bitcoin between accounts', hint: 'at cost · never a gain' },
  { key: 'draw',     title: '↓ Borrow from the credit line',  hint: 'credit line → bank' },
  { key: 'paydown',  title: '↑ Pay down the credit line',     hint: 'bank → credit line' },
  { key: 'interest', title: '％ Interest / minimum payment',   hint: 'bank → loan interest' },
  { key: 'disposal', title: '− Sell bitcoin',                 hint: 'pick the coins — the gain works itself out' },
];

export interface BuildCtx { id: string; date: string; utc: string }

export function buildBuy(ctx: BuildCtx, btcAccount: string, sats: number, costCents: number, fundingAccount = 'bank:checking'): Txn {
  return {
    id: ctx.id, date: ctx.date, utc: ctx.utc, description: 'Buy bitcoin',
    splits: [btcIn(btcAccount, sats, costCents), usd(fundingAccount, -costCents)],
  };
}

/** Transfer at cost. Optional network fee handled per book policy (§6.4). */
export function buildTransfer(
  ledger: LedgerState, ctx: BuildCtx, from: string, to: string, sats: number,
  opts: { feeSats?: number; refs?: LotRef[] } = {},
): Txn {
  const fee = opts.feeSats ?? 0;
  const refs = opts.refs ?? proposeLots(ledger.lots, from, sats + fee, ledger.accounts[from]?.lotMethod ?? 'FIFO');
  if (fee === 0) {
    const { basisCents } = peekCarriedBasis(ledger.lots, from, refs);
    return {
      id: ctx.id, date: ctx.date, utc: ctx.utc, description: 'Move bitcoin between accounts',
      splits: [btcOut(from, sats, basisCents, refs), btcIn(to, sats, basisCents)],
    };
  }
  const legs = peekTransferLegs(ledger.lots, from, refs, sats);
  const total = legs.movedBasisCents + legs.feeBasisCents;
  const splits: Split[] = ledger.policy.networkFeeTreatment === 'expense'
    ? [btcOut(from, sats + fee, total, refs), btcIn(to, sats, legs.movedBasisCents), usd('exp:network-fees', legs.feeBasisCents)]
    : [btcOut(from, sats + fee, total, refs), btcIn(to, sats, total)];
  return { id: ctx.id, date: ctx.date, utc: ctx.utc, description: 'Move bitcoin (network fee)', splits };
}

export function buildDraw(ctx: BuildCtx, locAccount: string, cents: number, bankAccount = 'bank:checking'): Txn {
  return {
    id: ctx.id, date: ctx.date, utc: ctx.utc, description: 'Borrow from the credit line',
    splits: [usd(bankAccount, cents), usd(locAccount, -cents)],
  };
}

export function buildPaydown(ctx: BuildCtx, locAccount: string, cents: number, bankAccount = 'bank:checking'): Txn {
  return {
    id: ctx.id, date: ctx.date, utc: ctx.utc, description: 'Pay down the credit line',
    splits: [usd(locAccount, cents), usd(bankAccount, -cents)],
  };
}

export function buildInterest(ctx: BuildCtx, cents: number, bankAccount = 'bank:checking'): Txn {
  return {
    id: ctx.id, date: ctx.date, utc: ctx.utc, description: 'Interest / minimum payment',
    splits: [usd('exp:loan-interest', cents), usd(bankAccount, -cents)],
  };
}

/** Sell: outflow at basis, proceeds to bank, gain/loss is the balancing figure. */
export function buildDisposal(
  ledger: LedgerState, ctx: BuildCtx, btcAccount: string, sats: number, proceedsCents: number,
  refs?: LotRef[], bankAccount = 'bank:checking',
): { txn: Txn; basisCents: number; gainCents: number; anyUnknown: boolean; refs: LotRef[] } {
  const prep = prepareDisposal(ledger, btcAccount, sats, refs);
  const gain = proceedsCents - prep.basisCents;
  const plug: Split = gain >= 0 ? usd('income:realized-gain', -gain) : usd('exp:realized-loss', -gain);
  return {
    txn: {
      id: ctx.id, date: ctx.date, utc: ctx.utc, description: 'Sell bitcoin',
      splits: [btcOut(btcAccount, sats, prep.basisCents, prep.refs), usd(bankAccount, proceedsCents), plug],
    },
    basisCents: prep.basisCents, gainCents: gain, anyUnknown: prep.anyUnknown, refs: prep.refs,
  };
}

/** Everyday spending: money leaves checking for a category. */
export function buildSpend(ctx: BuildCtx, categoryAccount: string, cents: number, memo: string, fromAccount = 'bank:checking'): Txn {
  return {
    id: ctx.id, date: ctx.date, description: memo || 'Spending',
    splits: [usd(categoryAccount, cents), usd(fromAccount, -cents)],
  };
}

/** Money in: income lands in checking from a source. */
export function buildIncome(ctx: BuildCtx, sourceAccount: string, cents: number, memo: string, intoAccount = 'bank:checking'): Txn {
  return {
    id: ctx.id, date: ctx.date, description: memo || 'Income',
    splits: [usd(intoAccount, cents), usd(sourceAccount, -cents)],
  };
}

/** Opening lots: just a transaction — equity offset against a backdated acquisition (§6.7). */
export function buildOpeningLot(
  ctx: BuildCtx, btcAccount: string, sats: number, basisCents: number, basisUnknown: boolean,
): Txn {
  return {
    id: ctx.id, date: ctx.date, utc: ctx.utc, description: 'Opening balance',
    meta: { source: 'opening' },
    splits: [
      btcIn(btcAccount, sats, basisUnknown ? 0 : basisCents, basisUnknown),
      usd('equity:opening', -(basisUnknown ? 0 : basisCents)),
    ],
  };
}
