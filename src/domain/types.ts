/**
 * PB-1 — Double-Entry + Lot Core · types
 * Master spec v1.3 §6.1–6.2 (D8, D12–D15, D17). Money is integers (cents, sats).
 * This module tree is pure: no IO, no clocks, no randomness, no imports outside src/domain.
 */

export type AccountType =
  | 'ASSET' | 'BANK' | 'CASH' | 'AR'      // debit-normal
  | 'LIABILITY' | 'CREDIT' | 'AP'         // credit-normal
  | 'EQUITY' | 'INCOME'                   // credit-normal
  | 'EXPENSE';                            // debit-normal

export type Commodity = 'USD' | 'BTC';
export type LotMethod = 'FIFO' | 'SPEC';
export type ReconcileState = 'n' | 'c' | 'y';

export interface Account {
  id: string;
  name: string;
  type: AccountType;
  commodity: Commodity;          // BTC only on asset-side types
  parentId: string | null;
  code?: string;
  placeholder?: boolean;         // structural node — postings rejected
  archived?: boolean;            // hide, never delete
  // BTC accounts only:
  lotMethod?: LotMethod;         // default FIFO (D14 default policy)
  custodian?: string;            // 'self-custody' | 'Strike' | 'Coinbase' | …
}

export interface LotRef {
  lotId: string;                 // `${txnId}:${splitIndex}` of the acquisition split
  sats: number;                  // positive integer
}

export interface Split {
  accountId: string;
  memo?: string;
  /** Signed integer cents in the transaction commodity (v1: USD). + debit, − credit. Σ per txn === 0. */
  valueCents: number;
  /** Signed integer sats. ONLY on BTC-commodity accounts; same sign as valueCents unless basis placeholder differs. */
  amountSats?: number;
  reconcile: ReconcileState;
  /** BTC outflow: which lots supply these sats. RECORDED AT POSTING (D14). Σ sats === |amountSats|. */
  lots?: LotRef[];
  /** BTC acquisition: this split IS the lot (§6.7). */
  lot?: { basisUnknown?: boolean };
}

export type TxnSource = 'manual' | 'import' | 'invoice' | 'reversal' | 'opening';

export interface Txn {
  id: string;                    // caller-supplied (uuid); core generates nothing
  date: string;                  // 'YYYY-MM-DD' LOCAL — accounting period + page (D15)
  utc?: string;                  // ISO-8601 instant — REQUIRED on any lot-touching txn (D15)
  description: string;
  num?: string;
  splits: Split[];               // ≥ 2; Σ valueCents === 0 enforced
  meta?: {
    source?: TxnSource;
    dedupHash?: string;
    reverses?: string;
    docId?: string;
  };
}

export type NetworkFeeTreatment = 'expense' | 'capitalize';

export interface Policy {
  networkFeeTreatment: NetworkFeeTreatment;  // D17 election, default 'expense'
  closedThrough: string | null;              // 'YYYY-MM' | null (§8.6)
  functionalCurrency: 'USD';
}

export type TxnClass =
  | { kind: 'PLAIN' }                                        // no BTC splits
  | { kind: 'ACQUISITION' }                                  // net sats > 0, no negative BTC splits
  | { kind: 'TRANSFER'; fromIdx: number; toIdx: number }     // net 0, 1→1
  | { kind: 'TRANSFER_WITH_FEE'; fromIdx: number; toIdx: number; feeSats: number } // §6.4 bend
  | { kind: 'DISPOSAL' };                                    // net sats < 0, no positive BTC splits

export interface LedgerState {
  accounts: Record<string, Account>;
  policy: Policy;
  /** Posted transactions in posting order. Append-only; closed periods immutable (§6.10). */
  txns: Txn[];
  /** Derived caches, recomputed by post(): balances + lot fold. Never serialized as truth. */
  balances: Record<string, { valueCents: number; sats: number }>;
  lots: LotFold;
}

export interface LotState {
  lotId: string;
  accountOfOrigin: string;
  acquiredDate: string;
  acquiredUtc: string;
  originSats: number;
  basisCents: number;            // placeholder when basisUnknown (D13)
  basisUnknown: boolean;
  /** Where the remaining sats sit NOW — with the exact basis that travelled there.
   *  Account book value ≡ Σ placement basis at all times; no pooled residue can exist. */
  placements: Record<string, { sats: number; basisCents: number }>;
  disposedSats: number;
}

export interface LotFold {
  lots: Record<string, LotState>;
  /** Sats per BTC account per the fold — must always equal journal balance (I4). */
  bySats: Record<string, number>;
  /** Disposals that consumed basisUnknown lots (I7 loudness hook). */
  unknownConsumed: { txnId: string; lotId: string; sats: number }[];
}

export interface TrialBalanceRow { accountId: string; debitCents: number; creditCents: number }
export interface TrialBalance { rows: TrialBalanceRow[]; totalDebitCents: number; totalCreditCents: number }

export interface BasisHealthRow {
  accountId: string;
  documentedSats: number;
  unknownSats: number;           // named, never rounded away (D13)
  documentedBasisCents: number;  // unknown lots contribute NOTHING here (I7)
}

export const DEBIT_NORMAL: ReadonlySet<AccountType> = new Set(['ASSET', 'BANK', 'CASH', 'AR', 'EXPENSE']);
export const PL_OR_EQUITY: ReadonlySet<AccountType> = new Set(['INCOME', 'EXPENSE', 'EQUITY']);

export function monthOf(date: string): string { return date.slice(0, 7); }

/** Runtime integer guard — floats never touch money (I10). */
export function assertInt(n: number, label: string): void {
  if (!Number.isSafeInteger(n)) throw new LedgerError('NOT_INTEGER', `${label} must be a safe integer, got ${n}`);
}

export type LedgerErrorCode =
  | 'NOT_INTEGER' | 'UNBALANCED' | 'MIN_SPLITS' | 'UNKNOWN_ACCOUNT' | 'PLACEHOLDER_POSTING'
  | 'SATS_ON_NON_BTC' | 'MISSING_SATS' | 'MISSING_UTC' | 'MIXED_ACQUIRE_DISPOSE'
  | 'TRANSFER_SHAPE' | 'TRANSFER_TOUCHES_PL' | 'TRANSFER_VALUE' | 'FEE_SPLIT_INVALID'
  | 'LOTS_REQUIRED' | 'LOTS_SUM_MISMATCH' | 'LOT_NOT_FOUND' | 'LOT_INSUFFICIENT'
  | 'OUTFLOW_NOT_AT_BASIS' | 'PERIOD_CLOSED' | 'CROSS_CHECK_FAILED' | 'TXN_NOT_FOUND'
  | 'DUPLICATE_TXN_ID' | 'ACQ_SIGN' | 'ZERO_SATS';

export class LedgerError extends Error {
  constructor(public code: LedgerErrorCode, message: string) {
    super(`[${code}] ${message}`);
    this.name = 'LedgerError';
  }
}
