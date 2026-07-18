import { describe, expect, it } from 'vitest';
import {
  LedgerError, Txn, basisHealth, closeThrough, foldLots, post, prepareDisposal,
  proposeLots, reverse, trialBalance,
} from '../src/domain';
import {
  BANK, FEES, GAIN, acquire, btcIn, btcOut, dispose, feeTransfer, freshState,
  nextId, realizedGain, transfer, usd,
} from './helpers';

const expectCode = (fn: () => unknown, code: string) => {
  try { fn(); } catch (e) {
    expect(e).toBeInstanceOf(LedgerError);
    expect((e as LedgerError).code).toBe(code);
    return;
  }
  throw new Error(`expected LedgerError ${code}, got success`);
};

describe('I1/I9/I10 — shape law', () => {
  it('rejects unbalanced txns', () => {
    const s = freshState();
    expectCode(() => post(s, {
      id: nextId(), date: '2027-01-01', description: 'bad',
      splits: [usd(BANK, 100), usd('exp:rent', -99)],
    }), 'UNBALANCED');
  });
  it('rejects <2 splits, unknown accounts, placeholder postings', () => {
    const s = freshState();
    expectCode(() => post(s, { id: nextId(), date: '2027-01-01', description: 'x', splits: [usd(BANK, 0)] }), 'MIN_SPLITS');
    expectCode(() => post(s, { id: nextId(), date: '2027-01-01', description: 'x', splits: [usd('nope', 1), usd(BANK, -1)] }), 'UNKNOWN_ACCOUNT');
    expectCode(() => post(s, { id: nextId(), date: '2027-01-01', description: 'x', splits: [usd('assets', 1), usd(BANK, -1)] }), 'PLACEHOLDER_POSTING');
  });
  it('rejects float money and sats on non-BTC accounts', () => {
    const s = freshState();
    expectCode(() => post(s, { id: nextId(), date: '2027-01-01', description: 'x', splits: [usd(BANK, 0.5), usd('exp:rent', -0.5)] }), 'NOT_INTEGER');
    expectCode(() => post(s, {
      id: nextId(), date: '2027-01-01', description: 'x',
      splits: [{ accountId: BANK, valueCents: 1, amountSats: 5, reconcile: 'n' }, usd('exp:rent', -1)],
    }), 'SATS_ON_NON_BTC');
  });
  it('requires nonzero sats on BTC splits and utc on lot-touching txns', () => {
    const s = freshState();
    expectCode(() => post(s, {
      id: nextId(), date: '2027-01-01', description: 'x',
      splits: [{ accountId: 'btc:cold', valueCents: 100, reconcile: 'n' }, usd(BANK, -100)],
    }), 'MISSING_SATS');
    expectCode(() => post(s, {
      id: nextId(), date: '2027-01-01', description: 'x',
      splits: [btcIn('btc:cold', 1000, 100), usd(BANK, -100)],
    }), 'MISSING_UTC');
  });
  it('rejects duplicate txn ids', () => {
    let s = freshState();
    const r = acquire(s, 'btc:cold', 1000, 100, { id: 'dup1' }); s = r.state;
    expectCode(() => acquire(s, 'btc:cold', 1000, 100, { id: 'dup1' }), 'DUPLICATE_TXN_ID');
  });
});

describe('classifier — total and strict (§6.3)', () => {
  it('rejects mixed acquire+dispose', () => {
    let s = freshState();
    s = acquire(s, 'btc:cold', 100_000, 5_000).state;
    const refs = proposeLots(s.lots, 'btc:cold', 40_000);
    expectCode(() => post(s, {
      id: nextId(), date: '2027-02-01', utc: '2027-02-01T00:00:00Z', description: 'mixed',
      splits: [
        btcIn('btc:strike', 10_000, 700),
        btcOut('btc:cold', 40_000, 2_000, refs),
        usd(BANK, 1_300),
      ],
    }), 'MIXED_ACQUIRE_DISPOSE');
  });
  it('rejects fan-out transfers (1→2)', () => {
    let s = freshState();
    s = acquire(s, 'btc:cold', 100_000, 5_000).state;
    const refs = proposeLots(s.lots, 'btc:cold', 100_000);
    expectCode(() => post(s, {
      id: nextId(), date: '2027-02-01', utc: '2027-02-01T00:00:00Z', description: 'fanout',
      splits: [
        btcOut('btc:cold', 100_000, 5_000, refs),
        btcIn('btc:strike', 60_000, 3_000),
        btcIn('btc:coinbase', 40_000, 2_000),
      ],
    }), 'TRANSFER_SHAPE');
  });
});

describe('I3 — D12 transfer neutrality', () => {
  it('transfers carry basis, not market; P&L untouched; placements move', () => {
    let s = freshState();
    s = acquire(s, 'btc:cold', 30_000_000, 2_412_000, { date: '2027-01-05' }).state; // 0.3 BTC @ $24,120
    s = transfer(s, 'btc:cold', 'btc:strike', 30_000_000).state;
    expect(s.balances['btc:cold'].valueCents).toBe(0);
    expect(s.balances['btc:strike'].valueCents).toBe(2_412_000);
    expect(s.balances['btc:strike'].sats).toBe(30_000_000);
    expect(realizedGain(s)).toBe(0);
    const lot = Object.values(s.lots.lots)[0];
    expect(lot.placements['btc:strike']).toEqual({ sats: 30_000_000, basisCents: 2_412_000 });
    expect(lot.acquiredDate).toBe('2027-01-05'); // identity unchanged
  });
  it('rejects transfers that touch P&L/Equity or misprice the legs', () => {
    let s = freshState();
    s = acquire(s, 'btc:cold', 1_000_000, 60_000).state;
    const refs = proposeLots(s.lots, 'btc:cold', 1_000_000);
    expectCode(() => post(s, {
      id: nextId(), date: '2027-02-01', utc: '2027-02-01T00:00:00Z', description: 'market-value transfer',
      splits: [btcOut('btc:cold', 1_000_000, 90_000, refs), btcIn('btc:strike', 1_000_000, 90_000)],
    }), 'TRANSFER_VALUE');
    expectCode(() => post(s, {
      id: nextId(), date: '2027-02-01', utc: '2027-02-01T00:00:00Z', description: 'pl touch',
      splits: [
        btcOut('btc:cold', 1_000_000, 60_000, refs),
        btcIn('btc:strike', 1_000_000, 59_000),
        usd(GAIN, 1_000),
      ],
    }), 'TRANSFER_TOUCHES_PL');
  });
  it('missing LotRefs on a transfer outflow is rejected (D14)', () => {
    let s = freshState();
    s = acquire(s, 'btc:cold', 1_000_000, 60_000).state;
    expectCode(() => post(s, {
      id: nextId(), date: '2027-02-01', utc: '2027-02-01T00:00:00Z', description: 'no refs',
      splits: [
        { accountId: 'btc:cold', valueCents: -60_000, amountSats: -1_000_000, reconcile: 'n' },
        btcIn('btc:strike', 1_000_000, 60_000),
      ],
    }), 'LOTS_REQUIRED');
  });
});

describe('§6.4 fee-on-transfer bend (D17 policy)', () => {
  it('expense policy: fee basis debits Network Fees; legs exact', () => {
    let s = freshState({ networkFeeTreatment: 'expense' });
    s = acquire(s, 'btc:cold', 1_000_000, 100_000).state;      // 10¢/1000 sats
    s = feeTransfer(s, 'btc:cold', 'btc:strike', 990_000, 10_000).state;
    expect(s.balances[FEES].valueCents).toBe(1_000);           // floor(100000*10000/1000000)
    expect(s.balances['btc:strike'].valueCents).toBe(99_000);
    expect(s.balances['btc:cold'].valueCents).toBe(0);
    expect(s.balances['btc:strike'].sats).toBe(990_000);
    expect(realizedGain(s)).toBe(0);
  });
  it('capitalize policy: fee basis rides to the destination; two splits only', () => {
    let s = freshState({ networkFeeTreatment: 'capitalize' });
    s = acquire(s, 'btc:cold', 1_000_000, 100_000).state;
    s = feeTransfer(s, 'btc:cold', 'btc:strike', 990_000, 10_000).state;
    expect(s.balances['btc:strike'].valueCents).toBe(100_000); // full basis arrived
    expect(s.balances['btc:strike'].sats).toBe(990_000);
    expect(s.balances[FEES]?.valueCents ?? 0).toBe(0);
    const lot = Object.values(s.lots.lots)[0];
    expect(lot.placements['btc:strike']).toEqual({ sats: 990_000, basisCents: 100_000 });
    // canonical fold parity under capitalize (closeThrough's oracle agrees with incremental state)
    const canonical = foldLots(s.txns, s.accounts, 'capitalize');
    expect(canonical.bySats['btc:strike']).toBe(990_000);
    expect(canonical.lots[lot.lotId].placements['btc:strike']).toEqual({ sats: 990_000, basisCents: 100_000 });
  });
  it('expense policy rejects a mis-sized fee split; a second non-BTC split makes it mixed', () => {
    let s = freshState();
    s = acquire(s, 'btc:cold', 1_000_000, 100_000).state;
    const refs = proposeLots(s.lots, 'btc:cold', 1_000_000);
    expectCode(() => post(s, {
      id: nextId(), date: '2027-02-01', utc: '2027-02-01T00:00:00Z', description: 'wrong fee size',
      splits: [
        btcOut('btc:cold', 1_000_000, 100_000, refs),
        btcIn('btc:strike', 990_000, 99_001),
        usd(FEES, 999),
      ],
    }), 'FEE_SPLIT_INVALID');
    expectCode(() => post(s, {
      id: nextId(), date: '2027-02-01', utc: '2027-02-01T00:00:00Z', description: 'not fee-shaped',
      splits: [
        btcOut('btc:cold', 1_000_000, 100_000, refs),
        btcIn('btc:strike', 990_000, 99_000),
        usd(FEES, 999), usd('exp:misc', 1),
      ],
    }), 'MIXED_ACQUIRE_DISPOSE');
  });
});

describe('I6 — disposal math is exact; realized gain is the plug', () => {
  it('gain = proceeds − carried basis, to the cent', () => {
    let s = freshState();
    s = acquire(s, 'btc:strike', 30_000_000, 120_480, { date: '2027-01-03' }).state;
    const r = dispose(s, 'btc:strike', 30_000_000, 236_480);
    s = r.state;
    expect(r.gainCents).toBe(116_000);
    expect(realizedGain(s)).toBe(116_000);
    expect(trialBalance(s).totalDebitCents).toBe(trialBalance(s).totalCreditCents);
  });
  it('remainder-to-last: chunked full consumption sums exactly to basis', () => {
    let s = freshState();
    s = acquire(s, 'btc:cold', 100, 99).state;                 // pathological: 99¢ over 100 sats
    let consumed = 0;
    for (const chunk of [33, 33, 34]) {
      const r = dispose(s, 'btc:cold', chunk, 0);
      s = r.state; consumed += -r.gainCents;                   // proceeds 0 ⇒ gain = −basis
    }
    expect(consumed).toBe(99);                                 // no drift, no lost cent
    expect(s.balances['btc:cold'].valueCents).toBe(0);
    expect(s.balances['btc:cold'].sats).toBe(0);
  });
  it('outflow not at basis is rejected', () => {
    let s = freshState();
    s = acquire(s, 'btc:cold', 1_000, 500).state;
    const refs = proposeLots(s.lots, 'btc:cold', 1_000);
    expectCode(() => post(s, {
      id: nextId(), date: '2027-03-01', utc: '2027-03-01T00:00:00Z', description: 'market out',
      splits: [btcOut('btc:cold', 1_000, 999, refs), usd(BANK, 1_200), usd(GAIN, -201)],
    }), 'OUTFLOW_NOT_AT_BASIS');
  });
  it('over/under-consumption and unknown lots are structural errors', () => {
    let s = freshState();
    s = acquire(s, 'btc:cold', 1_000, 500).state;
    const lotId = Object.keys(s.lots.lots)[0];
    expectCode(() => post(s, {
      id: nextId(), date: '2027-03-01', utc: '2027-03-01T00:00:00Z', description: 'oversupply',
      splits: [btcOut('btc:cold', 900, 450, [{ lotId, sats: 1_000 }]), usd(BANK, 450)],
    }), 'LOTS_SUM_MISMATCH');
    expectCode(() => post(s, {
      id: nextId(), date: '2027-03-01', utc: '2027-03-01T00:00:00Z', description: 'ghost lot',
      splits: [btcOut('btc:cold', 900, 450, [{ lotId: 'ghost:0', sats: 900 }]), usd(BANK, 450)],
    }), 'LOT_NOT_FOUND');
  });
});

describe('I5 — D14 recorded selection', () => {
  it('changing lotMethod changes future proposals, never posted splits', () => {
    let s = freshState();
    s = acquire(s, 'btc:cold', 1_000, 100, { utc: '2027-01-01T00:00:00Z', date: '2027-01-01' }).state;
    s = acquire(s, 'btc:cold', 1_000, 400, { utc: '2027-01-02T00:00:00Z', date: '2027-01-02' }).state;
    const r = dispose(s, 'btc:cold', 500, 300);                // FIFO: consumes the older lot
    s = r.state;
    const postedRefs = JSON.stringify(r.txn.splits[0].lots);
    s.accounts['btc:cold'] = { ...s.accounts['btc:cold'], lotMethod: 'SPEC' };
    expect(proposeLots(s.lots, 'btc:cold', 100, 'SPEC')).toEqual([]);   // SPEC proposes nothing
    expect(JSON.stringify(s.txns.find(t => t.id === r.txn.id)?.splits[0].lots)).toBe(postedRefs);
  });
  it('FIFO orders by acquiredUtc, ties broken by lotId', () => {
    let s = freshState();
    s = acquire(s, 'btc:cold', 100, 10, { id: 'b', utc: '2027-01-01T00:00:00Z' }).state;
    s = acquire(s, 'btc:cold', 100, 20, { id: 'a', utc: '2027-01-01T00:00:00Z' }).state;
    s = acquire(s, 'btc:cold', 100, 30, { id: 'c', utc: '2026-12-31T00:00:00Z' }).state;
    const refs = proposeLots(s.lots, 'btc:cold', 250);
    expect(refs.map(x => x.lotId)).toEqual(['c:0', 'a:0', 'b:0']);
    expect(refs.map(x => x.sats)).toEqual([100, 100, 50]);
  });
});

describe('I7 — D13 basis honesty', () => {
  it('unknown lots contribute nothing to documented basis and are named separately', () => {
    let s = freshState();
    s = acquire(s, 'btc:cold', 50_000_000, 1_785_000, { funding: 'equity:opening', date: '2023-11-02', utc: '2023-11-02T00:00:00Z' }).state;
    s = acquire(s, 'btc:cold', 9_960_000, 0, { funding: 'equity:opening', unknown: true, date: '2021-06-01', utc: '2021-06-01T00:00:00Z' }).state;
    const health = basisHealth(s).find(h => h.accountId === 'btc:cold');
    expect(health).toEqual({
      accountId: 'btc:cold',
      documentedSats: 50_000_000,
      unknownSats: 9_960_000,
      documentedBasisCents: 1_785_000,
    });
  });
  it('consuming an unknown lot is recorded loudly in unknownConsumed', () => {
    let s = freshState();
    s = acquire(s, 'btc:cold', 1_000, 0, { unknown: true }).state;
    const r = dispose(s, 'btc:cold', 400, 100);
    expect(r.state.lots.unknownConsumed).toHaveLength(1);
    expect(r.state.lots.unknownConsumed[0].sats).toBe(400);
  });
});

describe('I8 — period lock & reversals (§6.10, §8.6)', () => {
  it('closed periods reject postings; reversal in an open month is the path', () => {
    let s = freshState();
    const a = acquire(s, 'btc:cold', 1_000, 500, { date: '2027-01-10' }); s = a.state;
    s = closeThrough(s, '2027-01');
    expectCode(() => acquire(s, 'btc:cold', 1_000, 500, { date: '2027-01-31' }), 'PERIOD_CLOSED');
    s = reverse(s, a.txn.id, { id: nextId('rev'), date: '2027-02-01', utc: '2027-02-01T00:00:00Z' });
    expect(s.balances['btc:cold'].sats).toBe(0);
    expect(s.balances['btc:cold'].valueCents).toBe(0);
    expect(trialBalance(s).totalDebitCents).toBe(trialBalance(s).totalCreditCents);
  });
  it('closeThrough is monotonic and cross-checked', () => {
    let s = freshState();
    s = closeThrough(s, '2027-02');
    expectCode(() => closeThrough(s, '2027-01'), 'PERIOD_CLOSED');
  });
  it('reversing a disposal re-acquires at the disposed basis', () => {
    let s = freshState();
    s = acquire(s, 'btc:cold', 10_000, 700).state;
    const d = dispose(s, 'btc:cold', 10_000, 900); s = d.state;
    s = reverse(s, d.txn.id, { id: nextId('rev'), date: '2027-03-11', utc: '2027-03-11T00:00:00Z' });
    expect(s.balances['btc:cold'].sats).toBe(10_000);
    expect(s.balances['btc:cold'].valueCents).toBe(700);
    expect(realizedGain(s)).toBe(0);
  });
  it('reversing a transfer moves the same lots back', () => {
    let s = freshState();
    s = acquire(s, 'btc:cold', 10_000, 700).state;
    const t = transfer(s, 'btc:cold', 'btc:strike', 10_000); s = t.state;
    s = reverse(s, t.txn.id, { id: nextId('rev'), date: '2027-02-11', utc: '2027-02-11T00:00:00Z' });
    expect(s.balances['btc:cold'].sats).toBe(10_000);
    expect(s.balances['btc:strike'].sats).toBe(0);
    const lot = Object.values(s.lots.lots)[0];
    expect(lot.placements['btc:cold']).toEqual({ sats: 10_000, basisCents: 700 });
  });
});

describe('I2/I4 — trial balance & cross-check as running law', () => {
  it('TB nets to zero after any prefix of a mixed script; fold matches journal at every step', () => {
    let s = freshState();
    const steps: ((st: typeof s) => typeof s)[] = [
      st => acquire(st, 'btc:cold', 2_000_000, 120_000, { date: '2027-01-05' }).state,
      st => acquire(st, 'btc:strike', 500_000, 31_000, { date: '2027-01-08' }).state,
      st => post(st, { id: nextId(), date: '2027-01-15', description: 'rent', splits: [usd('exp:rent', 85_000), usd(BANK, -85_000)] }),
      st => transfer(st, 'btc:cold', 'btc:strike', 800_000, { date: '2027-02-02' }).state,
      st => dispose(st, 'btc:strike', 600_000, 45_000, { date: '2027-02-20' }).state,
      st => transfer(st, 'btc:strike', 'btc:coinbase', 300_000, { date: '2027-03-01' }).state,
      st => dispose(st, 'btc:coinbase', 300_000, 9_000, { date: '2027-03-15' }).state,
    ];
    for (const step of steps) {
      s = step(s);
      const tb = trialBalance(s);
      expect(tb.totalDebitCents).toBe(tb.totalCreditCents);
      const canonical = foldLots(s.txns, s.accounts, s.policy.networkFeeTreatment);
      for (const acct of ['btc:cold', 'btc:strike', 'btc:coinbase']) {
        expect(canonical.bySats[acct] ?? 0).toBe(s.balances[acct]?.sats ?? 0);
        expect(s.lots.bySats[acct] ?? 0).toBe(s.balances[acct]?.sats ?? 0);
      }
    }
  });
});
