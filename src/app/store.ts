/**
 * PB-3 · app store — a thin reducer over the pure core. U1: every posting goes through post().
 * Prototype uses useReducer; the PB-2 repo version swaps in a Zustand slice with the SAME action names.
 * No browser storage APIs; persistence = JSON export/import (C-preview shape).
 */
import {
  COA_BITCOINER_SOLE_OPERATOR, LedgerError, LedgerState, LotRef, Txn,
  closeThrough, initialState, post,
} from '../domain';

export interface Reading { priceCents: number; asOf: string }           // E2: manual, never fetched
export interface ClosedStamp { month: string; priceCents: number; asOf: string }

export type BtcUnit = 'btc' | 'sats';

/** Identity — preview shape. Real keys arrive with the Recovery Key ceremony at sync. */
export interface Identity { kind: 'sample' | 'npub'; npub: string }

/** Live market data — DISPLAY ONLY. The books stamp confirmed numbers (E2v2). */
export interface Live {
  usdCents: number;                    // 1 BTC in USD cents
  byCur: Record<string, number>;       // 1 BTC in each currency (major units)
  change24h: number | null;            // percent
  updatedAt: string;                   // HH:MM local, display only
  week: number[];                      // 7d price series (USD), possibly empty
}

export const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'CHF'] as const;
const SYM: Record<string, string> = { USD: '$', EUR: '€', GBP: '£', JPY: '¥', CAD: 'CA$', AUD: 'A$', CHF: 'CHF ' };
const DEC: Record<string, number> = { JPY: 0 };

/** Module display config — set once per render by the App from state; call sites stay unchanged. */
let DISP = { cur: 'USD', rate: 1, sym: '$', dec: 2 };
export function configureDisplay(currency: string, live: Live | null): void {
  if (!live || currency === 'USD' || !live.byCur[currency] || !live.byCur.USD) {
    DISP = { cur: 'USD', rate: 1, sym: '$', dec: 2 };
    return;
  }
  DISP = {
    cur: currency,
    rate: live.byCur[currency] / live.byCur.USD,   // implied USD→currency via BTC cross
    sym: SYM[currency] ?? currency + ' ',
    dec: DEC[currency] ?? 2,
  };
}

export interface AppState {
  ledger: LedgerState;
  reading: Reading | null;
  closedStamps: ClosedStamp[];
  lastError: string | null;      // plain-worded core reason (U2)
  seq: number;                   // txn id counter — ids are data, not clock output
  unit: BtcUnit;                 // display preference — never changes stored data
  currency: string;              // display currency — books stay USD (functional currency)
  identity: Identity | null;     // who holds the pen — preview only until the key ceremony ships
  live: Live | null;             // fetched market data; null = offline/manual mode
}

export type Action =
  | { type: 'postTxn'; txn: Txn }
  | { type: 'setReading'; reading: Reading }
  | { type: 'closeMonth'; month: string }
  | { type: 'setUnit'; unit: BtcUnit }
  | { type: 'setCurrency'; currency: string }
  | { type: 'setFeePolicy'; treatment: 'expense' | 'capitalize' }
  | { type: 'setLotMethod'; method: 'FIFO' | 'SPEC' }
  | { type: 'setLive'; live: Live }
  | { type: 'setIdentity'; identity: Identity | null }
  | { type: 'clearError' }
  | { type: 'importState'; state: AppState };

export function initialAppState(): AppState {
  return {
    ledger: initialState(COA_BITCOINER_SOLE_OPERATOR),
    reading: null,
    closedStamps: [],
    lastError: null,
    seq: 0,
    unit: 'btc',
    currency: 'USD',
    live: null,
    identity: null,
  };
}

/** Plain-words rendering of a LedgerError (U2: the core's reason, not a paraphrase). */
export function plainError(e: unknown): string {
  if (e instanceof LedgerError) return e.message.replace(/^\[[A-Z_]+\]\s*/, '');
  return e instanceof Error ? e.message : String(e);
}

export function reducer(s: AppState, a: Action): AppState {
  switch (a.type) {
    case 'postTxn': {
      try {
        return { ...s, ledger: post(s.ledger, a.txn), lastError: null, seq: s.seq + 1 };
      } catch (e) {
        return { ...s, lastError: plainError(e) };
      }
    }
    case 'setReading':
      return { ...s, reading: a.reading, lastError: null };
    case 'closeMonth': {
      if (!s.reading) return { ...s, lastError: 'Add a price reading before closing — the close stamps the price it used.' };
      try {
        const ledger = closeThrough(s.ledger, a.month);
        return {
          ...s, ledger, lastError: null,
          closedStamps: [...s.closedStamps, { month: a.month, priceCents: s.reading.priceCents, asOf: s.reading.asOf }],
        };
      } catch (e) {
        return { ...s, lastError: plainError(e) };
      }
    }
    case 'setUnit':
      return { ...s, unit: a.unit };
    case 'setCurrency':
      return { ...s, currency: a.currency };
    case 'setFeePolicy':
      // an election (D17): applies to FUTURE entries; nothing already posted changes.
      return { ...s, ledger: { ...s.ledger, policy: { ...s.ledger.policy, networkFeeTreatment: a.treatment } } };
    case 'setLotMethod': {
      // default selection policy for BTC accounts — never rewrites recorded selections (D14).
      const accounts = { ...s.ledger.accounts };
      for (const id of Object.keys(accounts)) {
        if (accounts[id].commodity === 'BTC') accounts[id] = { ...accounts[id], lotMethod: a.method };
      }
      return { ...s, ledger: { ...s.ledger, accounts } };
    }
    case 'setIdentity':
      return { ...s, identity: a.identity };
    case 'setLive':
      // live price also becomes the working reading (E2v2): display follows the market,
      // but nothing is RECORDED until the user confirms a number (check-in stamp).
      return { ...s, live: a.live, reading: { priceCents: a.live.usdCents, asOf: 'live' } };
    case 'clearError':
      return { ...s, lastError: null };
    case 'importState':
      return a.state;
  }
}

/** Market value at the reading, integer cents: sats × price / 1e8, floored. Safe to 21M BTC. */
export function marketCents(sats: number, reading: Reading | null): number | null {
  if (!reading) return null;
  // 2.1e15 sats × 1e7+ cents overflows 2^53 — split to keep integer math exact.
  const whole = Math.floor(sats / 100_000_000);
  const rem = sats % 100_000_000;
  return whole * reading.priceCents + Math.floor((rem * reading.priceCents) / 100_000_000);
}

export const fmtUsd = (cents: number): string => {
  const sign = cents < 0 ? '−' : '';
  const v = (Math.abs(cents) / 100) * DISP.rate;
  const num = v.toLocaleString('en-US', { minimumFractionDigits: DISP.dec, maximumFractionDigits: DISP.dec });
  return `${sign}${DISP.sym}${num}`;
};

/** Display helper honoring the user's unit preference. Signed. */
export const fmtAmt = (sats: number, unit: BtcUnit): string => {
  if (unit === 'sats') {
    const sign = sats < 0 ? '−' : '+';
    return `${sign}${Math.abs(sats).toLocaleString('en-US')} sats`;
  }
  return fmtBtc(sats);
};

export const fmtBtc = (sats: number): string => {
  const sign = sats < 0 ? '−' : '+';
  const abs = Math.abs(sats);
  const whole = Math.floor(abs / 100_000_000);
  const frac = String(abs % 100_000_000).padStart(8, '0');
  return `${sign}${whole}.${frac} ₿`;
};

/** Register rows for a BTC (or any) account in a month, with running sats balance. */
export function registerRows(ledger: LedgerState, accountId: string, month: string) {
  const rows: { txn: Txn; deltaCents: number; deltaSats: number; runningSats: number; unknown: boolean }[] = [];
  let running = 0;
  for (const txn of ledger.txns) {
    const split = txn.splits.find(sp => sp.accountId === accountId);
    if (!split) continue;
    running += split.amountSats ?? 0;
    if (txn.date.slice(0, 7) !== month) continue;
    rows.push({
      txn,
      deltaCents: split.valueCents,
      deltaSats: split.amountSats ?? 0,
      runningSats: running,
      unknown: !!split.lot?.basisUnknown,
    });
  }
  return rows.reverse();          // newest first, like the preview
}

export function monthsWithActivity(ledger: LedgerState): string[] {
  const set = new Set<string>();
  for (const t of ledger.txns) set.add(t.date.slice(0, 7));
  return [...set].sort();
}

export function nextTxnId(s: AppState, prefix: string): string {
  return `${prefix}-${s.seq + 1}`;
}

export type { LotRef };
