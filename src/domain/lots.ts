/**
 * PB-1 · the lot fold (§6.7) — pure. Lots are DERIVED from the journal; zero extra storage.
 * A lot IS an acquisition split: id `${txnId}:${splitIndex}`, basis = that split's valueCents.
 *
 * Allocation exactness (spec call 3, per-placement form): basis lives ON each placement.
 * Consuming or moving S sats from a placement holding (B cents, O sats):
 *   share = floor(B * S / O), EXCEPT when S empties the placement — then share = B (absorb).
 * ⇒ every account's BTC book value ≡ Σ placement basis at ALL times (no pooled residue),
 *   and Σ lifetime consumption shares ≡ basisCents exactly (expense policy).
 * Under `capitalize`, fee sats leave a placement WITHOUT taking basis — per-sat basis rises there.
 */
import { classify } from './classify';
import {
  Account, LedgerError, LotFold, LotRef, LotState, NetworkFeeTreatment, Txn, assertInt,
} from './types';

export function lotIdOf(txnId: string, splitIndex: number): string {
  return `${txnId}:${splitIndex}`;
}

export function emptyFold(): LotFold {
  return { lots: {}, bySats: {}, unknownConsumed: [] };
}

function addSats(fold: LotFold, accountId: string, d: number): void {
  fold.bySats[accountId] = (fold.bySats[accountId] ?? 0) + d;
  if (fold.bySats[accountId] === 0) delete fold.bySats[accountId];
}

/** Exact share for taking `sats` out of a placement (B cents over O sats). */
function shareOf(placementSats: number, placementBasis: number, sats: number): number {
  if (placementSats === sats) return placementBasis;   // emptying absorbs every remaining cent
  return Math.floor((placementBasis * sats) / placementSats);
}

interface TakeResult { basisCents: number }

/** Take sats (and their exact basis share) out of a lot's placement in `accountId`. Mutates the lot. */
function takeFromPlacement(lot: LotState, accountId: string, sats: number, withBasis: boolean): TakeResult {
  const pl = lot.placements[accountId];
  if (!pl || pl.sats < sats) {
    throw new LedgerError('LOT_INSUFFICIENT',
      `lot ${lot.lotId} has ${pl?.sats ?? 0} sats in ${accountId}, cannot supply ${sats}`);
  }
  const share = withBasis ? shareOf(pl.sats, pl.basisCents, sats) : 0;
  pl.sats -= sats;
  pl.basisCents -= share;
  if (pl.sats === 0 && pl.basisCents === 0) delete lot.placements[accountId];
  return { basisCents: share };
}

/**
 * Apply one txn to the fold, mutating it. The single lot-semantics implementation —
 * foldLots() loops it; the reducer applies it incrementally on a copy-on-write clone.
 */
export function applyTxnToFold(
  fold: LotFold, txn: Txn, accounts: Record<string, Account>, feeTreatment: NetworkFeeTreatment,
): void {
  const cls = classify(txn, accounts);
  if (cls.kind === 'PLAIN') return;

  if (cls.kind === 'ACQUISITION') {
    txn.splits.forEach((s, i) => {
      const a = accounts[s.accountId];
      if (!a || a.commodity !== 'BTC') return;
      const sats = s.amountSats as number;
      const id = lotIdOf(txn.id, i);
      if (fold.lots[id]) throw new LedgerError('DUPLICATE_TXN_ID', `lot ${id} already exists`);
      fold.lots[id] = {
        lotId: id,
        accountOfOrigin: s.accountId,
        acquiredDate: txn.date,
        acquiredUtc: txn.utc as string,
        originSats: sats,
        basisCents: s.valueCents,
        basisUnknown: !!s.lot?.basisUnknown,
        placements: { [s.accountId]: { sats, basisCents: s.valueCents } },
        disposedSats: 0,
      };
      addSats(fold, s.accountId, sats);
    });
    return;
  }

  if (cls.kind === 'TRANSFER' || cls.kind === 'TRANSFER_WITH_FEE') {
    const from = txn.splits[cls.fromIdx];
    const to = txn.splits[cls.toIdx];
    const refs = from.lots ?? [];
    const outSats = Math.abs(from.amountSats as number);
    const inSats = to.amountSats as number;
    const supplied = refs.reduce((acc, r) => acc + r.sats, 0);
    if (supplied !== outSats) {
      throw new LedgerError('LOTS_SUM_MISMATCH', `transfer refs supply ${supplied} sats, outflow is ${outSats}`);
    }
    // Place `inSats` at the destination in ref order; the remainder of each ref is network fee.
    let toPlace = inSats;
    for (const ref of refs) {
      const lot = fold.lots[ref.lotId];
      if (!lot) throw new LedgerError('LOT_NOT_FOUND', `lot ${ref.lotId} does not exist`);
      const place = Math.min(ref.sats, toPlace);
      const feePart = ref.sats - place;
      if (place > 0) {
        const moved = takeFromPlacement(lot, from.accountId, place, true);
        const dst = lot.placements[to.accountId] ?? (lot.placements[to.accountId] = { sats: 0, basisCents: 0 });
        dst.sats += place;
        dst.basisCents += moved.basisCents;           // basis RELOCATES; acquisition identity unchanged (D12)
        toPlace -= place;
      }
      if (feePart > 0) {
        const feeTaken = takeFromPlacement(lot, from.accountId, feePart, true);
        if (feeTreatment === 'capitalize') {
          // §6.4: the fee sats' basis is ADDED to the receiving side's carried basis.
          const dst = lot.placements[to.accountId] ?? (lot.placements[to.accountId] = { sats: 0, basisCents: 0 });
          dst.basisCents += feeTaken.basisCents;
        }
        // expense: the basis left with takeFromPlacement — the reducer's expense split carries it.
        lot.disposedSats += feePart;
        if (lot.basisUnknown) fold.unknownConsumed.push({ txnId: txn.id, lotId: lot.lotId, sats: feePart });
      }
    }
    addSats(fold, from.accountId, from.amountSats as number);
    addSats(fold, to.accountId, inSats);
    return;
  }

  // DISPOSAL — every negative BTC split consumes refs from ITS account's placements.
  txn.splits.forEach((s) => {
    const a = accounts[s.accountId];
    if (!a || a.commodity !== 'BTC') return;
    const sats = s.amountSats as number;              // negative
    const refs = s.lots ?? [];
    const need = -sats;
    const supplied = refs.reduce((acc, r) => acc + r.sats, 0);
    if (supplied !== need) {
      throw new LedgerError('LOTS_SUM_MISMATCH', `disposal refs supply ${supplied} sats, need ${need}`);
    }
    for (const ref of refs) {
      const lot = fold.lots[ref.lotId];
      if (!lot) throw new LedgerError('LOT_NOT_FOUND', `lot ${ref.lotId} does not exist`);
      takeFromPlacement(lot, s.accountId, ref.sats, true);
      lot.disposedSats += ref.sats;
      if (lot.basisUnknown) fold.unknownConsumed.push({ txnId: txn.id, lotId: lot.lotId, sats: ref.sats });
    }
    addSats(fold, s.accountId, sats);
  });
}

/** The canonical pure derivation: fold every txn in order. */
export function foldLots(
  txns: Txn[], accounts: Record<string, Account>, feeTreatment: NetworkFeeTreatment = 'expense',
): LotFold {
  const fold = emptyFold();
  for (const txn of txns) applyTxnToFold(fold, txn, accounts, feeTreatment);
  for (const k of Object.keys(fold.bySats)) assertInt(fold.bySats[k], `bySats[${k}]`);
  return fold;
}

/** Carried basis of refs against CURRENT fold state, without mutating (validates disposal value legs). */
export function peekCarriedBasis(
  fold: LotFold, accountId: string, refs: LotRef[],
): { basisCents: number; anyUnknown: boolean } {
  let basis = 0; let anyUnknown = false;
  const shadow: Record<string, { sats: number; basisCents: number }> = {};
  for (const ref of refs) {
    const lot = fold.lots[ref.lotId];
    if (!lot) throw new LedgerError('LOT_NOT_FOUND', `lot ${ref.lotId} does not exist`);
    const pl = lot.placements[accountId];
    const sh = shadow[ref.lotId] ?? (shadow[ref.lotId] = { sats: pl?.sats ?? 0, basisCents: pl?.basisCents ?? 0 });
    if (sh.sats < ref.sats) {
      throw new LedgerError('LOT_INSUFFICIENT',
        `lot ${ref.lotId} has ${sh.sats} sats in ${accountId}, cannot supply ${ref.sats}`);
    }
    const share = shareOf(sh.sats, sh.basisCents, ref.sats);
    sh.sats -= ref.sats; sh.basisCents -= share;
    basis += share;
    if (lot.basisUnknown) anyUnknown = true;
  }
  return { basisCents: basis, anyUnknown };
}

/**
 * Fee-transfer leg math against current state (validation aid): places `inSats` in ref order,
 * remainder is fee. One sequential simulation so moved + fee ≡ total consumed, exactly.
 */
export function peekTransferLegs(
  fold: LotFold, fromAccountId: string, refs: LotRef[], inSats: number,
): { movedBasisCents: number; feeBasisCents: number; anyUnknown: boolean } {
  let moved = 0; let fee = 0; let anyUnknown = false;
  let toPlace = inSats;
  const shadow: Record<string, { sats: number; basisCents: number }> = {};
  for (const ref of refs) {
    const lot = fold.lots[ref.lotId];
    if (!lot) throw new LedgerError('LOT_NOT_FOUND', `lot ${ref.lotId} does not exist`);
    const pl = lot.placements[fromAccountId];
    const sh = shadow[ref.lotId] ?? (shadow[ref.lotId] = { sats: pl?.sats ?? 0, basisCents: pl?.basisCents ?? 0 });
    if (sh.sats < ref.sats) {
      throw new LedgerError('LOT_INSUFFICIENT',
        `lot ${ref.lotId} has ${sh.sats} sats in ${fromAccountId}, cannot supply ${ref.sats}`);
    }
    const place = Math.min(ref.sats, toPlace);
    if (place > 0) {
      const s1 = shareOf(sh.sats, sh.basisCents, place);
      sh.sats -= place; sh.basisCents -= s1; moved += s1; toPlace -= place;
    }
    const feePart = ref.sats - place;
    if (feePart > 0) {
      const s2 = shareOf(sh.sats, sh.basisCents, feePart);
      sh.sats -= feePart; sh.basisCents -= s2; fee += s2;
    }
    if (lot.basisUnknown) anyUnknown = true;
  }
  return { movedBasisCents: moved, feeBasisCents: fee, anyUnknown };
}

/** FIFO proposal (D14 default): acquiredUtc asc, ties by lotId. SPEC returns [] — the caller chooses. */
export function proposeLots(
  fold: LotFold, accountId: string, sats: number, method: 'FIFO' | 'SPEC' = 'FIFO',
): LotRef[] {
  if (method === 'SPEC') return [];
  const candidates = Object.values(fold.lots)
    .filter(l => (l.placements[accountId]?.sats ?? 0) > 0)
    .sort((a, b) => a.acquiredUtc === b.acquiredUtc
      ? (a.lotId < b.lotId ? -1 : 1)
      : (a.acquiredUtc < b.acquiredUtc ? -1 : 1));
  const refs: LotRef[] = [];
  let need = sats;
  for (const l of candidates) {
    if (need === 0) break;
    const avail = l.placements[accountId]?.sats as number;
    const take = Math.min(avail, need);
    refs.push({ lotId: l.lotId, sats: take });
    need -= take;
  }
  if (need > 0) throw new LedgerError('LOT_INSUFFICIENT', `account ${accountId} holds insufficient sats for ${sats}`);
  return refs;
}

/** Copy-on-write clone for incremental application: deep-copies only the named lots. */
export function cowFold(fold: LotFold, touchLotIds: Iterable<string>): LotFold {
  const lots = { ...fold.lots };
  for (const id of touchLotIds) {
    const l = lots[id];
    if (l) {
      const placements: LotState['placements'] = {};
      for (const [k, v] of Object.entries(l.placements)) placements[k] = { ...v };
      lots[id] = { ...l, placements };
    }
  }
  return { lots, bySats: { ...fold.bySats }, unknownConsumed: [...fold.unknownConsumed] };
}
