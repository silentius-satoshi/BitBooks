/** PB-3 gate — template builders + store logic, headless (spec §5). */
import { describe, expect, it } from 'vitest';
import { foldLots, post, proposeLots } from '../src/domain';
import {
  initialAppState, marketCents, monthsWithActivity, reducer, registerRows,
} from '../src/app/store';
import {
  buildBuy, buildDisposal, buildDraw, buildInterest, buildOpeningLot, buildPaydown, buildTransfer,
} from '../src/app/templates';

const ctx = (id: string, date = '2027-07-01') => ({ id, date, utc: `${date}T12:00:00Z` });

describe('U1/U2 — store posts through the core and surfaces its reasons', () => {
  it('valid template txns post; invalid ones surface plain-worded core errors', () => {
    let s = initialAppState();
    s = reducer(s, { type: 'postTxn', txn: buildBuy(ctx('b1'), 'btc:strike', 500_000, 59_120) });
    expect(s.lastError).toBeNull();
    expect(s.ledger.balances['btc:strike'].sats).toBe(500_000);
    // an unbalanced hand-rolled txn is refused with the core's reason, state unchanged
    const before = s.ledger.txns.length;
    s = reducer(s, { type: 'postTxn', txn: {
      id: 'bad1', date: '2027-07-02', description: 'bad',
      splits: [{ accountId: 'bank:checking', valueCents: 100, reconcile: 'n' }, { accountId: 'exp:misc', valueCents: -99, reconcile: 'n' }],
    }});
    expect(s.lastError).toMatch(/must be 0/);
    expect(s.ledger.txns.length).toBe(before);
  });
});

describe('the six templates produce core-valid postings', () => {
  it('buy · draw · paydown · interest · transfer · disposal', () => {
    let s = initialAppState();
    s = reducer(s, { type: 'postTxn', txn: buildBuy(ctx('t-buy'), 'btc:cold', 1_000_000, 100_000) });
    s = reducer(s, { type: 'postTxn', txn: buildDraw(ctx('t-draw'), 'loc:strike', 124_400) });
    s = reducer(s, { type: 'postTxn', txn: buildPaydown(ctx('t-pay'), 'loc:strike', 20_000) });
    s = reducer(s, { type: 'postTxn', txn: buildInterest(ctx('t-int'), 8_600) });
    s = reducer(s, { type: 'postTxn', txn: buildTransfer(s.ledger, ctx('t-tr'), 'btc:cold', 'btc:strike', 400_000) });
    const d = buildDisposal(s.ledger, ctx('t-disp'), 'btc:strike', 400_000, 47_000);
    s = reducer(s, { type: 'postTxn', txn: d.txn });
    expect(s.lastError).toBeNull();
    expect(s.ledger.txns).toHaveLength(6);
    expect(d.basisCents).toBe(40_000);
    expect(d.gainCents).toBe(7_000);
    expect(s.ledger.balances['loc:strike'].valueCents).toBe(-104_400 + 0); // draw −124,400 +20,000 paydown
    // canonical fold agrees after the whole script
    const canonical = foldLots(s.ledger.txns, s.ledger.accounts, 'expense');
    expect(canonical.bySats['btc:cold']).toBe(600_000);
    expect(canonical.bySats['btc:strike'] ?? 0).toBe(0);
  });

  it('fee-transfer template honors both policies', () => {
    for (const policy of ['expense', 'capitalize'] as const) {
      let s = initialAppState();
      s.ledger = { ...s.ledger, policy: { ...s.ledger.policy, networkFeeTreatment: policy } };
      s = reducer(s, { type: 'postTxn', txn: buildBuy(ctx('fb'), 'btc:cold', 1_000_000, 100_000) });
      s = reducer(s, { type: 'postTxn', txn: buildTransfer(s.ledger, ctx('ft'), 'btc:cold', 'btc:strike', 990_000, { feeSats: 10_000 }) });
      expect(s.lastError).toBeNull();
      expect(s.ledger.balances['btc:strike'].sats).toBe(990_000);
      expect(s.ledger.balances['btc:strike'].valueCents).toBe(policy === 'expense' ? 99_000 : 100_000);
    }
  });

  it('opening lots: documented and unknown, unknown never becomes $0 silently — it is flagged', () => {
    let s = initialAppState();
    s = reducer(s, { type: 'postTxn', txn: buildOpeningLot(ctx('op1', '2023-11-02'), 'btc:cold', 50_000_000, 1_785_000, false) });
    s = reducer(s, { type: 'postTxn', txn: buildOpeningLot(ctx('op2', '2021-06-01'), 'btc:cold', 9_960_000, 0, true) });
    expect(s.lastError).toBeNull();
    const lots = Object.values(s.ledger.lots.lots);
    expect(lots.find(l => l.basisUnknown)?.placements['btc:cold']?.sats).toBe(9_960_000);
    const rows = registerRows(s.ledger, 'btc:cold', '2021-06');
    expect(rows[0].unknown).toBe(true);
  });
});

describe('U3 — lot choices land exactly as picked and are never recomputed', () => {
  it('SPEC override rides the posted txn verbatim', () => {
    let s = initialAppState();
    s = reducer(s, { type: 'postTxn', txn: buildBuy(ctx('l1', '2027-01-01'), 'btc:cold', 100, 10) });
    s = reducer(s, { type: 'postTxn', txn: buildBuy(ctx('l2', '2027-01-02'), 'btc:cold', 100, 40) });
    const overridden = [{ lotId: 'l2:0', sats: 60 }];              // NOT fifo
    const d = buildDisposal(s.ledger, ctx('ld'), 'btc:cold', 60, 100, overridden);
    s = reducer(s, { type: 'postTxn', txn: d.txn });
    expect(s.lastError).toBeNull();
    const posted = s.ledger.txns.find(t => t.id === 'ld');
    expect(posted?.splits[0].lots).toEqual(overridden);
    expect(proposeLots(s.ledger.lots, 'btc:cold', 10, 'FIFO')[0].lotId).toBe('l1:0'); // FIFO unchanged
  });
});

describe('U4/E2 — close is gated on the reading and stamps it', () => {
  it('refuses without a reading; stamps with one; lock then rejects backdated postings', () => {
    let s = initialAppState();
    s = reducer(s, { type: 'postTxn', txn: buildBuy(ctx('c1', '2027-01-10'), 'btc:cold', 1_000, 100) });
    s = reducer(s, { type: 'closeMonth', month: '2027-01' });
    expect(s.lastError).toMatch(/price reading/);
    expect(s.closedStamps).toHaveLength(0);
    s = reducer(s, { type: 'setReading', reading: { priceCents: 11_824_000, asOf: '2027-01-31' } });
    s = reducer(s, { type: 'closeMonth', month: '2027-01' });
    expect(s.lastError).toBeNull();
    expect(s.closedStamps).toEqual([{ month: '2027-01', priceCents: 11_824_000, asOf: '2027-01-31' }]);
    s = reducer(s, { type: 'postTxn', txn: buildBuy(ctx('c2', '2027-01-20'), 'btc:cold', 1_000, 100) });
    expect(s.lastError).toMatch(/closed through/);
  });
});

describe('U6 — three truths math', () => {
  it('market = sats × reading in exact integer cents, safe at 21M BTC', () => {
    const r = { priceCents: 11_824_000, asOf: '2027-07-15' };
    expect(marketCents(30_000_000, r)).toBe(3_547_200);            // 0.3 × $118,240
    expect(marketCents(2_100_000_000_000_000, r)).toBe(2_100_000_000_000_000 / 100_000_000 * 11_824_000);
    expect(marketCents(1, { priceCents: 99, asOf: 'x' })).toBe(0); // floors, never rounds up
    expect(marketCents(5, null)).toBeNull();                       // no reading → no number, never a guess
  });
  it('register rows: month filter + running balance', () => {
    let s = initialAppState();
    s = reducer(s, { type: 'postTxn', txn: buildBuy(ctx('r1', '2027-01-05'), 'btc:strike', 500, 50) });
    s = reducer(s, { type: 'postTxn', txn: buildBuy(ctx('r2', '2027-02-05'), 'btc:strike', 300, 30) });
    const jan = registerRows(s.ledger, 'btc:strike', '2027-01');
    const feb = registerRows(s.ledger, 'btc:strike', '2027-02');
    expect(jan).toHaveLength(1);
    expect(jan[0].runningSats).toBe(500);
    expect(feb[0].runningSats).toBe(800);
    expect(monthsWithActivity(s.ledger)).toEqual(['2027-01', '2027-02']);
  });
});
