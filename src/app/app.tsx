/**
 * PB-3 · v5 — fintech IA restructure (Design Polish + product design pass).
 * The four canonical consumer-finance surfaces: Net-worth Home · unified Feed ·
 * Accounts · bottom-sheet Add. Everyday spending/income are first-class.
 * Behavior law unchanged: every posting goes through post(); A1 holds.
 */
import React, { useEffect, useReducer, useState } from 'react';
import { LedgerState, LotRef, Txn, basisHealth, classify, proposeLots } from '../domain';
import {
  Action, AppState, BtcUnit, CURRENCIES, ClosedStamp, Identity, Live, Reading, configureDisplay,
  fmtAmt, fmtBtc, fmtUsd, initialAppState, marketCents, monthsWithActivity, nextTxnId, reducer,
} from './store';
import {
  buildBuy, buildDisposal, buildDraw, buildIncome, buildInterest, buildOpeningLot,
  buildPaydown, buildSpend, buildTransfer,
} from './templates';

type Tab = 'home' | 'feed' | 'accounts' | 'settings';
type Modal =
  | null
  | { m: 'add' }
  | { m: 'form'; key: string }
  | { m: 'txn'; id: string }
  | { m: 'account'; id: string }
  | { m: 'opening' }
  | { m: 'close' }
  | { m: 'bridge' }
  | { m: 'key-new' }
  | { m: 'key-in' }
  | { m: 'custom' };

const BTC_ACCOUNTS = ['btc:cold', 'btc:strike', 'btc:coinbase'];
const LOC_ACCOUNTS = ['loc:strike', 'loc:coinbase', 'cc'];
const TODAY = '2027-07-15';
const utcOf = (date: string) => `${date}T12:00:00Z`;
/** Friendly account names: 'Bitcoin:Cold Storage' → 'Cold Storage'. Data unchanged; display only. */
const dispName = (n?: string): string => !n ? '' : (n.includes(':') ? (n.split(':').pop() as string) : n);

/* ---------- live price fetch — display only; books stamp confirmed numbers (E2v2) ---------- */
const nowHM = () => { const d = new Date(); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

async function fetchLive(): Promise<Live | null> {
  const curs = CURRENCIES.map(c => c.toLowerCase()).join(',');
  try {
    const r = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=${curs}&include_24hr_change=true`);
    if (!r.ok) throw new Error(String(r.status));
    const j = await r.json();
    const b = j.bitcoin;
    const byCur: Record<string, number> = {};
    for (const c of CURRENCIES) byCur[c] = b[c.toLowerCase()];
    let week: number[] = [];
    try {
      const rc = await fetch('https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=7');
      if (rc.ok) {
        const jc = await rc.json();
        const pts: number[] = (jc.prices as [number, number][]).map(p => p[1]);
        const step = Math.max(1, Math.floor(pts.length / 42));
        week = pts.filter((_, i) => i % step === 0);
      }
    } catch { /* chart is optional */ }
    return { usdCents: Math.round(b.usd * 100), byCur, change24h: b.usd_24h_change ?? null, updatedAt: nowHM(), week };
  } catch { /* fall through to Coinbase */ }
  try {
    const r = await fetch('https://api.coinbase.com/v2/exchange-rates?currency=BTC');
    if (!r.ok) throw new Error(String(r.status));
    const j = await r.json();
    const rates = j.data.rates as Record<string, string>;
    const byCur: Record<string, number> = {};
    for (const c of CURRENCIES) byCur[c] = Number(rates[c]);
    return { usdCents: Math.round(Number(rates.USD) * 100), byCur, change24h: null, updatedAt: nowHM(), week: [] };
  } catch { return null; }
}

/* ---------- icons ---------- */
const I = {
  home: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M3 10.5 12 3l9 7.5" /><path d="M5.5 9.5V21h13V9.5" /></svg>,
  feed: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round"><path d="M4 6h16M4 12h16M4 18h10" /></svg>,
  plus: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>,
  wallet: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="6" width="18" height="13" rx="3" /><path d="M16 12h.01M3 9h13" /></svg>,
  gear: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3.2" /><path d="M19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.4-2.3 1a7 7 0 0 0-2-1.2L14.2 3h-4l-.4 2.7a7 7 0 0 0-2 1.2l-2.3-1-2 3.4 2 1.5A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.5 2 3.4 2.3-1a7 7 0 0 0 2 1.2l.4 2.7h4l.4-2.7a7 7 0 0 0 2-1.2l2.3 1 2-3.4-2-1.5c.1-.4.1-.8.1-1.2Z" /></svg>,
};

/* ---------- data shaping ---------- */
interface FeedItem {
  txn: Txn; glyph: string; glyphClass: string; title: string; sub: string;
  amount: string; amountClass: string;
}

function shapeTxn(t: Txn, ledger: LedgerState, unit: BtcUnit): FeedItem {
  const acc = ledger.accounts;
  const name = (id: string) => acc[id]?.name?.split(':').pop() ?? id;
  let kind = 'PLAIN';
  try { kind = classify(t, acc).kind; } catch { kind = 'PLAIN'; }
  const btc = t.splits.find(sp => acc[sp.accountId]?.commodity === 'BTC');
  if (kind === 'ACQUISITION') {
    return { txn: t, glyph: '₿', glyphClass: 'gold', title: t.description, sub: `into ${name(btc!.accountId)}`, amount: fmtAmt(btc!.amountSats as number, unit), amountClass: 'gold' };
  }
  if (kind === 'DISPOSAL') {
    const out = t.splits.find(sp => (sp.amountSats ?? 0) < 0)!;
    return { txn: t, glyph: '₿', glyphClass: 'gold', title: t.description, sub: `from ${name(out.accountId)}`, amount: fmtAmt(out.amountSats as number, unit), amountClass: '' };
  }
  if (kind === 'TRANSFER' || kind === 'TRANSFER_WITH_FEE') {
    const from = t.splits.find(sp => (sp.amountSats ?? 0) < 0)!;
    const to = t.splits.find(sp => (sp.amountSats ?? 0) > 0)!;
    return { txn: t, glyph: '⇄', glyphClass: '', title: t.description, sub: `${name(from.accountId)} → ${name(to.accountId)}`, amount: fmtAmt(to.amountSats as number, unit).slice(1), amountClass: 'mut' };
  }
  const exp = t.splits.find(sp => acc[sp.accountId]?.type === 'EXPENSE' && sp.valueCents > 0);
  const inc = t.splits.find(sp => acc[sp.accountId]?.type === 'INCOME' && sp.valueCents < 0);
  const liab = t.splits.find(sp => ['LIABILITY', 'CREDIT'].includes(acc[sp.accountId]?.type ?? ''));
  if (exp) return { txn: t, glyph: '−', glyphClass: '', title: t.description, sub: name(exp.accountId), amount: fmtUsd(-exp.valueCents), amountClass: '' };
  if (inc) return { txn: t, glyph: '+', glyphClass: 'green', title: t.description, sub: name(inc.accountId), amount: `+${fmtUsd(-inc.valueCents)}`, amountClass: 'g' };
  if (liab) {
    const borrow = liab.valueCents < 0;
    return { txn: t, glyph: borrow ? '↓' : '↑', glyphClass: '', title: t.description, sub: name(liab.accountId), amount: fmtUsd(Math.abs(liab.valueCents)), amountClass: borrow ? 'g' : '' };
  }
  const first = t.splits[0];
  return { txn: t, glyph: '·', glyphClass: '', title: t.description, sub: name(first.accountId), amount: fmtUsd(first.valueCents), amountClass: '' };
}

function feedOf(ledger: LedgerState, unit: BtcUnit, filter?: (t: Txn) => boolean): { date: string; items: FeedItem[] }[] {
  const groups = new Map<string, FeedItem[]>();
  for (const t of [...ledger.txns].reverse()) {
    if (filter && !filter(t)) continue;
    const g = groups.get(t.date) ?? [];
    g.push(shapeTxn(t, ledger, unit));
    groups.set(t.date, g);
  }
  return [...groups.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(([date, items]) => ({ date, items }));
}

function holdingsSeries(txns: Txn[]): number[] {
  const byMonth = new Map<string, number>();
  for (const t of txns) {
    let d = 0;
    for (const sp of t.splits) if (BTC_ACCOUNTS.includes(sp.accountId)) d += sp.amountSats ?? 0;
    if (d !== 0) byMonth.set(t.date.slice(0, 7), (byMonth.get(t.date.slice(0, 7)) ?? 0) + d);
  }
  let acc = 0;
  return [...byMonth.keys()].sort().map(m => (acc += byMonth.get(m) as number));
}

/* ---------- charts ---------- */
function Spark({ points }: { points: number[] }): React.ReactElement | null {
  if (points.length < 2) return null;
  const w = 340, h = 52, pad = 3;
  const max = Math.max(...points), min = Math.min(...points);
  const span = max - min || 1;
  const xy = points.map((v, i) => [pad + (i * (w - 2 * pad)) / (points.length - 1), h - pad - ((v - min) * (h - 2 * pad)) / span]);
  const line = xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden>
      <defs><linearGradient id="sg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#e8b04f" stopOpacity="0.28" /><stop offset="1" stopColor="#e8b04f" stopOpacity="0" />
      </linearGradient></defs>
      <polygon points={`${pad},${h} ${line} ${w - pad},${h}`} fill="url(#sg)" />
      <polyline points={line} fill="none" stroke="#e8b04f" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={xy[xy.length - 1][0]} cy={xy[xy.length - 1][1]} r="3.4" fill="#f6cf7d" />
    </svg>
  );
}

function Ring({ pct }: { pct: number }): React.ReactElement {
  const r = 17, c = 2 * Math.PI * r;
  return (
    <svg className="ring" width="44" height="44" viewBox="0 0 44 44" aria-hidden>
      <circle cx="22" cy="22" r={r} fill="none" stroke="rgba(255,255,255,.10)" strokeWidth="4.5" />
      <circle cx="22" cy="22" r={r} fill="none" stroke={pct >= 100 ? '#4ade80' : '#fbbf24'} strokeWidth="4.5"
        strokeDasharray={`${(c * pct) / 100} ${c}`} strokeLinecap="round" transform="rotate(-90 22 22)" />
      <text x="22" y="26" textAnchor="middle" fontSize="10.5" fontWeight="700" fill={pct >= 100 ? '#4ade80' : '#fbbf24'}>{Math.round(pct)}%</text>
    </svg>
  );
}

/* ================================================================== */
export function App(): React.ReactElement {
  const [state, dispatch] = useReducer(reducer, undefined, initialAppState);
  const [tab, setTab] = useState<Tab>('home');
  const [modal, setModal] = useState<Modal>(null);
  const [onboarded, setOnboarded] = useState(false);
  const [priceState, setPriceState] = useState<'loading' | 'live' | 'offline'>('loading');

  useEffect(() => {
    let dead = false;
    fetchLive().then(l => {
      if (dead) return;
      if (l) { dispatch({ type: 'setLive', live: l }); setPriceState('live'); }
      else setPriceState('offline');
    });
    return () => { dead = true; };
  }, []);
  const refreshPrice = () => {
    setPriceState('loading');
    fetchLive().then(l => {
      if (l) { dispatch({ type: 'setLive', live: l }); setPriceState('live'); }
      else setPriceState('offline');
    });
  };
  configureDisplay(state.currency, state.live);

  const close = () => setModal(null);
  const openForm = (key: string) => setModal({ m: 'form', key });

  return (
    <div className="phone">
      <div className="brand">
        <div className="logo">Bit<i>Books</i></div>
      </div>
      {state.lastError && (
        <div className="note err" onClick={() => dispatch({ type: 'clearError' })}>
          {state.lastError} <span className="tag">· tap to dismiss</span>
        </div>
      )}
      {tab === 'home' && (state.ledger.txns.length === 0 && !onboarded
        ? <Onboard state={state} setModal={setModal} finish={() => setOnboarded(true)} />
        : <Home state={state} setTab={setTab} setModal={setModal} priceState={priceState} refresh={refreshPrice} />)}
      {tab === 'feed' && <Feed state={state} setModal={setModal} />}
      {tab === 'accounts' && <Accounts state={state} setModal={setModal} />}
      {tab === 'settings' && <Settings state={state} dispatch={dispatch} priceState={priceState} refresh={refreshPrice} setModal={setModal} />}

      <nav className="bottomnav">
        <button className={tab === 'home' ? 'on' : ''} onClick={() => { setTab('home'); close(); }}>{I.home}Home</button>
        <button className={tab === 'feed' ? 'on' : ''} onClick={() => { setTab('feed'); close(); }}>{I.feed}Activity</button>
        <button className="fab" aria-label="Add" onClick={() => setModal({ m: 'add' })}>{I.plus}</button>
        <button className={tab === 'accounts' ? 'on' : ''} onClick={() => { setTab('accounts'); close(); }}>{I.wallet}Accounts</button>
        <button className={tab === 'settings' ? 'on' : ''} onClick={() => { setTab('settings'); close(); }}>{I.gear}Settings</button>
      </nav>

      {modal?.m === 'add' && <AddSheet onPick={openForm} setModal={setModal} onClose={close} />}
      {modal?.m === 'form' && (
        <Sheet onClose={close} title={FORM_TITLES[modal.key]?.[0] ?? ''} sub={FORM_TITLES[modal.key]?.[1]}>
          <TemplateForm state={state} dispatch={dispatch} formKey={modal.key} done={close} />
        </Sheet>
      )}
      {modal?.m === 'txn' && <TxnSheet state={state} id={modal.id} onClose={close} />}
      {modal?.m === 'account' && <AccountSheet state={state} id={modal.id} onClose={close} setModal={setModal} />}
      {modal?.m === 'opening' && (
        <Sheet onClose={close} title="What I held before day one" sub="each holding becomes a dated lot — documented, or honestly unknown">
          <OpeningLots state={state} dispatch={dispatch} done={close} />
        </Sheet>
      )}
      {modal?.m === 'close' && (
        <Sheet onClose={close} title="Monthly check-in" sub="locks the month's records — corrections become reversing entries">
          <CloseMonth state={state} dispatch={dispatch} />
        </Sheet>
      )}
      {modal?.m === 'bridge' && (
        <Sheet onClose={close} title="Personal ₿LOC" sub="your borrowing plan becomes book entries — always drafts you approve, never auto-posted">
          <BridgeSheet state={state} dispatch={dispatch} done={close} />
        </Sheet>
      )}
      {modal?.m === 'key-new' && (
        <Sheet onClose={close} title="Create your key" sub="twelve words, shown once — the one thing that is truly you here">
          <KeyNewSheet dispatch={dispatch} done={close} />
        </Sheet>
      )}
      {modal?.m === 'key-in' && (
        <Sheet onClose={close} title="Sign in with your key" sub="the same key that runs Personal ₿LOC — one identity, both apps">
          <KeyInSheet dispatch={dispatch} done={close} />
        </Sheet>
      )}
      {modal?.m === 'custom' && (
        <Sheet onClose={close} title="Custom entry" sub="money out is negative, money in is positive — it must land on zero">
          <CustomEntry state={state} dispatch={dispatch} done={close} />
        </Sheet>
      )}
    </div>
  );
}

/* ---------- sheet chrome ---------- */
function Sheet({ title, sub, onClose, children }: {
  title: string; sub?: string; onClose: () => void; children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="sheet">
        <div className="grab" />
        <div className="sheethead">
          <div><h3>{title}</h3>{sub && <div className="sub">{sub}</div>}</div>
          <button className="x" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="sheetbody">{children}</div>
      </div>
    </div>
  );
}


/* ---------- Onboarding — three beats, then begin ---------- */
function Onboard({ state, setModal, finish }: {
  state: AppState; setModal: (m: Modal) => void; finish: () => void;
}): React.ReactElement {
  const [step, setStep] = useState(0);
  const Dots = () => (
    <div className="dots">{[0, 1, 2, 3].map(i => <span key={i} className={i === step ? 'on' : ''} />)}</div>
  );
  if (step === 0) {
    return (
      <div className="body onb">
        <div className="onb-hero">
          <h1>Books you hold<br />like you hold<br /><em>bitcoin.</em></h1>
          <p>Written on your device. Locked to your key. Synced by open relays — never a company's server. Clear enough for every day; rigorous enough to prove what your coins really cost.</p>
        </div>
        <Dots />
        <button className="btn p" onClick={() => setStep(1)}>Get started</button>
        <button className="linkrow" onClick={finish}>Skip — just look around</button>
      </div>
    );
  }
  if (step === 1) {
    return (
      <div className="body onb">
        <div className="backrow"><button onClick={() => setStep(0)}>‹ back</button></div>
        <div className="ptitle"><h3>Three promises</h3></div>
        <div className="frow onb-row"><span className="fic gold">◉</span>
          <span className="fmain"><b>One glance, whole picture</b><span>Net worth, cash, credit, and every coin you hold — current the moment you open it, clear enough to check daily.</span></span></div>
        <div className="frow onb-row"><span className="fic gold">₿</span>
          <span className="fmain"><b>Proof, not promises</b><span>Every satoshi carries its date and its true cost. When a broker's tax form claims you paid zero, your books say otherwise — and can prove it, line by line.</span></span></div>
        <div className="frow onb-row"><span className="fic gold"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="5" y="10" width="14" height="10" rx="2.5"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg></span>
          <span className="fmain"><b>Yours the way bitcoin is yours</b><span>Locked to your key before anything leaves your device. No account, no server, no company that can read your money or shut you out. If we vanish, your books don't.</span></span></div>
        <Dots />
        <button className="btn p" onClick={() => setStep(2)}>Sounds right</button>
      </div>
    );
  }
  if (step === 2) {
    return (
      <div className="body onb">
        <div className="backrow"><button onClick={() => setStep(1)}>‹ back</button></div>
        <div className="ptitle"><h3>Who holds the pen?</h3>
          <div className="sub">your key is your identity here — and in Personal ₿LOC. One key, both apps.</div></div>
        {state.identity ? (
          <div className="card" style={{ borderColor: 'rgba(74,222,128,.35)' }}>
            <div className="row"><span className="k">key ready</span>
              <span className="v g">✓ {state.identity.npub.slice(0, 12)}…{state.identity.kind === 'sample' ? ' · preview' : ''}</span></div>
          </div>
        ) : (<>
          <button className="tile gold" onClick={() => setModal({ m: 'key-new' })}>
            <span className="t-k">New here <span className="chev">›</span></span>
            <span className="t-v">Create my key</span>
            <span className="t-s">twelve words, shown once, yours forever — they restore everything, on any device</span>
          </button>
          <button className="tile" onClick={() => setModal({ m: 'key-in' })}>
            <span className="t-k">Already use Personal ₿LOC or nostr? <span className="chev">›</span></span>
            <span className="t-v">Sign in with my key</span>
            <span className="t-s">your books will live beside your plan, under the identity you already own</span>
          </button>
        </>)}
        <Dots />
        <button className="btn p" onClick={() => setStep(3)}>{state.identity ? 'Continue' : 'Decide later'}</button>
      </div>
    );
  }
  return (
    <div className="body onb">
      <div className="backrow"><button onClick={() => setStep(2)}>‹ back</button></div>
      <div className="ptitle"><h3>How do you want to begin?</h3>
        <div className="sub">you can do the others any time</div></div>
      <button className="tile gold" onClick={() => setModal({ m: 'opening' })}>
        <span className="t-k">Recommended <span className="chev">›</span></span>
        <span className="t-v">Add what you hold</span>
        <span className="t-s">your bitcoin and where it lives — about a minute</span>
      </button>
      <button className="tile" onClick={() => setModal({ m: 'bridge' })}>
        <span className="t-k">Already use Personal ₿LOC? <span className="chev">›</span></span>
        <span className="t-v">Bring in your plan</span>
        <span className="t-s">your borrowing year arrives as drafts you approve</span>
      </button>
      <button className="tile" onClick={() => setModal({ m: 'add' })}>
        <span className="t-k">Start small <span className="chev">›</span></span>
        <span className="t-v">Record one thing</span>
        <span className="t-s">a coffee, a paycheck, a bitcoin buy</span>
      </button>
      <Dots />
      <button className="linkrow" onClick={finish}>I'll explore on my own</button>
    </div>
  );
}

/* ---------- key sheets — preview-safe: never accepts a secret key ---------- */
const SAMPLE_WORDS = ['ember', 'ledger', 'vault', 'orbit', 'canyon', 'primal', 'stone', 'haven', 'circuit', 'maple', 'anchor', 'north'];

function KeyNewSheet({ dispatch, done }: { dispatch: React.Dispatch<Action>; done: () => void }): React.ReactElement {
  return (<>
    <div className="card wordgrid-card">
      <div className="wordgrid">
        {SAMPLE_WORDS.map((w, i) => <span key={w}><i>{i + 1}</i> {w}</span>)}
      </div>
      <div className="sampletag">SAMPLE</div>
    </div>
    <div className="note warn">These twelve words <b>are</b> your books and your identity. Anyone who holds them can read everything; without them, nothing can be recovered — not even by us. There is no reset.</div>
    <div className="note">This preview shows the ceremony with sample words. Your real key — and the backup steps that make it safe — arrive with the next build. Nothing you do here creates a real key.</div>
    <button className="btn p" onClick={() => { dispatch({ type: 'setIdentity', identity: { kind: 'sample', npub: 'npub1preview7xk2…sample' } }); done(); }}>
      Continue with the preview key</button>
  </>);
}

function KeyInSheet({ dispatch, done }: { dispatch: React.Dispatch<Action>; done: () => void }): React.ReactElement {
  const [v, setV] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const submit = () => {
    const t = v.trim();
    if (t.startsWith('nsec1')) {
      setErr('That is a SECRET key — never paste it into a preview build, or any website. When sign-in ships, your secret stays on your device; only you ever hold it.');
      return;
    }
    if (t.startsWith('npub1') && t.length > 20) {
      dispatch({ type: 'setIdentity', identity: { kind: 'npub', npub: t } });
      done();
      return;
    }
    setErr('Enter your public key (it starts with npub1…). Secret keys are never asked for here.');
  };
  return (<>
    <div className="card">
      <div className="row"><span className="k">your public key</span></div>
      <input placeholder="npub1…" value={v} onChange={e => { setV(e.target.value); setErr(null); }}
        style={{ width: '100%', maxWidth: 'unset', textAlign: 'left', marginTop: 8 }} />
    </div>
    {err && <div className="note err" onClick={() => setErr(null)}>{err}</div>}
    <div className="note">Preview accepts a public key for display only. Full sign-in — with your secret staying sealed on your device — arrives with the next build.</div>
    <button className="btn p" disabled={!v.trim()} onClick={submit}>Sign in</button>
  </>);
}

/* ---------- Personal BLOC bridge — flows arrive as drafts, never auto-posted ---------- */
const BRIDGE_SAMPLE = [
  { id: 'bloc-d1', label: 'Borrowed $1,244.00', sub: 'Jul 1 · draw → Bank', kind: 'draw', cents: 124_400 },
  { id: 'bloc-b1', label: 'Bought 0.00547 ₿ for $646.79', sub: 'Jul 1 · monthly playbook', kind: 'buy', cents: 64_679, sats: 547_000 },
  { id: 'bloc-i1', label: 'Interest $86.00', sub: 'Jul 15 · minimum payment', kind: 'interest', cents: 8_600 },
] as const;

function BridgeSheet({ state, dispatch, done }: {
  state: AppState; dispatch: React.Dispatch<Action>; done: () => void;
}): React.ReactElement {
  const [posted, setPosted] = useState(false);
  const confirmAll = () => {
    let seq = state.seq;
    for (const d of BRIDGE_SAMPLE) {
      const ctx = { id: `blocbr-${++seq}`, date: d.sub.startsWith('Jul 15') ? '2027-07-15' : '2027-07-01', utc: '2027-07-01T12:00:00Z' };
      if (d.kind === 'draw') dispatch({ type: 'postTxn', txn: buildDraw(ctx, 'loc:strike', d.cents) });
      if (d.kind === 'buy') dispatch({ type: 'postTxn', txn: buildBuy(ctx, 'btc:strike', (d as { sats: number }).sats, d.cents) });
      if (d.kind === 'interest') dispatch({ type: 'postTxn', txn: buildInterest(ctx, d.cents) });
    }
    setPosted(true);
  };
  return (<>
    <div className="note">Same key, both apps. ₿LOC's <b>money moves</b> become draft entries here; its balance <b>readings</b> never do — they only help you double-check. <span className="tag">Preview shows sample numbers; your real plan connects when sync arrives.</span></div>
    {BRIDGE_SAMPLE.map(d => (
      <div className="frow" key={d.id} style={{ cursor: 'default' }}>
        <span className="fic gold">⇄</span>
        <span className="fmain"><b>{d.label}</b><span>{d.sub}</span></span>
        <span className="famt mut">draft</span>
      </div>
    ))}
    {!posted ? (
      <button className="btn p" onClick={confirmAll}>Approve all 3 → into my books</button>
    ) : (
      <button className="btn p" onClick={done}>Added ✓ — see them in Activity</button>
    )}
    <button className="linkrow" onClick={done}>Not now</button>
  </>);
}

/* ---------- Home — net worth first ---------- */
function Home({ state, setTab, setModal, priceState, refresh }: {
  state: AppState; setTab: (t: Tab) => void; setModal: (m: Modal) => void;
  priceState: 'loading' | 'live' | 'offline'; refresh: () => void;
}): React.ReactElement {
  const L = state.ledger;
  const btcSats = BTC_ACCOUNTS.reduce((a, id) => a + (L.balances[id]?.sats ?? 0), 0);
  const btcCost = BTC_ACCOUNTS.reduce((a, id) => a + (L.balances[id]?.valueCents ?? 0), 0);
  const market = marketCents(btcSats, state.reading);
  const cash = L.balances['bank:checking']?.valueCents ?? 0;
  const owed = LOC_ACCOUNTS.reduce((a, id) => a + Math.max(0, -(L.balances[id]?.valueCents ?? 0)), 0);
  const netWorth = (market ?? btcCost) + cash - owed;
  const health = basisHealth(L);
  const unknown = health.reduce((a, h) => a + h.unknownSats, 0);
  const documented = health.reduce((a, h) => a + h.documentedSats, 0);
  const pct = btcSats > 0 ? (documented / btcSats) * 100 : 100;
  const months = monthsWithActivity(L);
  const closed = L.policy.closedThrough;
  const toClose = months.find(m => !closed || m > closed);
  const recent = feedOf(L, state.unit).slice(0, 2).flatMap(g => g.items).slice(0, 3);
  const empty = L.txns.length === 0;

  if (empty) {
    return (
      <div className="body">
        <div className="hello"><h2>Welcome to your books</h2>
          <p>Everything you record stays with you. Start with what you hold, or just record something that happened today.</p></div>
        <button className="tile gold" onClick={() => setModal({ m: 'opening' })}>
          <span className="t-k">Start here <span className="chev">›</span></span>
          <span className="t-v">Add what you hold</span>
          <span className="t-s">your bitcoin and where it lives — about a minute</span>
        </button>
        <button className="tile" onClick={() => setModal({ m: 'bridge' })}>
          <span className="t-k">Already use Personal ₿LOC? <span className="chev">›</span></span>
          <span className="t-v">Bring in your plan</span>
          <span className="t-s">your borrowing year arrives as drafts you approve</span>
        </button>
        <button className="tile" onClick={() => setModal({ m: 'add' })}>
          <span className="t-k">Or jump in <span className="chev">›</span></span>
          <span className="t-v">Record something</span>
          <span className="t-s">a purchase, spending, income — anything</span>
        </button>
      </div>
    );
  }

  return (
    <div className="body">
      <div className="hero2">
        <div className="h-k">Net worth</div>
        <div className="h-v">{fmtUsd(netWorth)}</div>
        <div className="h-s">
          {fmtAmt(btcSats, state.unit).slice(1)}{market !== null ? ` worth ${fmtUsd(market)}` : ''} · {fmtUsd(cash)} cash{owed > 0 ? ` · owes ${fmtUsd(owed)}` : ''}
        </div>
        {market !== null && market !== btcCost && (
          <span className={`delta ${market < btcCost ? 'down' : ''}`}>
            {market >= btcCost ? '▲' : '▼'} bitcoin {fmtUsd(Math.abs(market - btcCost))} {market >= btcCost ? 'ahead of' : 'under'} what you paid
          </span>
        )}
        {market === null && (
          <span className="delta down" onClick={() => setTab('settings')} style={{ cursor: 'pointer' }}>
            add a bitcoin price to complete the picture ›
          </span>
        )}
        <Spark points={holdingsSeries(L.txns)} />
      </div>

      <div className="psec">Bitcoin price</div>
      <div className="tile" style={{ cursor: 'default' }}>
        <span className="t-k">
          {priceState === 'live' && state.live ? `live · updated ${state.live.updatedAt}` : priceState === 'loading' ? 'checking…' : 'can’t reach a price service'}
          <button className="chev" onClick={refresh} style={{ background: 'none', border: 'none', color: 'var(--gold)', cursor: 'pointer', fontWeight: 600 }}>↻ refresh</button>
        </span>
        {state.live ? (<>
          <span className="t-v">{fmtUsd(state.live.usdCents)}<span className="tag" style={{ marginLeft: 6 }}>/ ₿</span>
            {state.live.change24h !== null && (
              <span className={`delta ${state.live.change24h < 0 ? 'down' : ''}`} style={{ marginLeft: 10, marginTop: 0 }}>
                {state.live.change24h >= 0 ? '▲' : '▼'} {Math.abs(state.live.change24h).toFixed(1)}% today</span>
            )}</span>
          {state.live.week.length > 1 && <Spark points={state.live.week} />}
        </>) : (
          <span className="t-s">Your books still work — enter a price by hand in Settings, or refresh when you're back online.</span>
        )}
      </div>

      <div className="psec">Recent</div>
      {recent.map(it => <FeedRow key={it.txn.id} it={it} onTap={() => setModal({ m: 'txn', id: it.txn.id })} />)}
      <button className="linkrow" onClick={() => setTab('feed')}>See all activity ›</button>

      <div className="psec">Keeping you honest</div>
      <button className="tile gold" onClick={() => setModal({ m: 'close' })}>
        <span className="ringwrap">
          <Ring pct={pct} />
          <span style={{ flex: 1 }}>
            <span className="t-k">Your records <span className="chev">›</span></span>
            <span className="t-v" style={{ fontSize: 16.5 }}>
              {unknown > 0 ? <span style={{ color: 'var(--amber)' }}>{fmtAmt(unknown, state.unit).slice(1)} missing its cost</span>
                : <span style={{ color: 'var(--green)' }}>every coin accounted for</span>}
            </span>
            <span className="t-s">{toClose ? `${toClose} is ready for its check-in` : closed ? `checked through ${closed}` : 'record something to begin'}</span>
          </span>
        </span>
      </button>
    </div>
  );
}

/* ---------- Feed ---------- */
function FeedRow({ it, onTap }: { it: FeedItem; onTap: () => void }): React.ReactElement {
  return (
    <button className="frow" onClick={onTap}>
      <span className={`fic ${it.glyphClass}`}>{it.glyph}</span>
      <span className="fmain"><b>{it.title}</b><span>{it.sub}</span></span>
      <span className={`famt ${it.amountClass}`}>{it.amount}</span>
    </button>
  );
}

const FILTERS: { key: string; label: string; test?: (t: Txn, L: LedgerState) => boolean }[] = [
  { key: 'all', label: 'All' },
  { key: 'btc', label: 'Bitcoin', test: (t, L) => t.splits.some(sp => L.accounts[sp.accountId]?.commodity === 'BTC') },
  { key: 'cash', label: 'Cash', test: (t, L) => t.splits.some(sp => sp.accountId === 'bank:checking') && !t.splits.some(sp => L.accounts[sp.accountId]?.commodity === 'BTC') },
  { key: 'credit', label: 'Credit line', test: (t, _L) => t.splits.some(sp => LOC_ACCOUNTS.includes(sp.accountId)) },
];

function Feed({ state, setModal }: { state: AppState; setModal: (m: Modal) => void }): React.ReactElement {
  const [f, setF] = useState('all');
  const filt = FILTERS.find(x => x.key === f);
  const groups = feedOf(state.ledger, state.unit, filt?.test ? (t) => (filt.test as (t: Txn, L: LedgerState) => boolean)(t, state.ledger) : undefined);
  return (
    <div className="body">
      <div className="ptitle"><h3>Activity</h3><div className="sub">everything, newest first — tap anything for the full story</div></div>
      <div className="chiprow">
        {FILTERS.map(x => (
          <button key={x.key} className={`chip ${f === x.key ? 'on' : ''}`} onClick={() => setF(x.key)}>{x.label}</button>
        ))}
      </div>
      {groups.length === 0 && <div className="note">Nothing here yet — tap ＋ to record your first entry.</div>}
      {groups.map(g => (
        <div key={g.date}>
          <div className="datehead">{g.date}</div>
          {g.items.map(it => <FeedRow key={it.txn.id} it={it} onTap={() => setModal({ m: 'txn', id: it.txn.id })} />)}
        </div>
      ))}
    </div>
  );
}

/* ---------- Accounts ---------- */
function Accounts({ state, setModal }: { state: AppState; setModal: (m: Modal) => void }): React.ReactElement {
  const L = state.ledger;
  const r = state.reading;
  const row = (id: string) => {
    const a = L.accounts[id]; const b = L.balances[id] ?? { valueCents: 0, sats: 0 };
    const isBtc = a?.commodity === 'BTC';
    const mkt = isBtc ? marketCents(b.sats, r) : null;
    const isLoc = LOC_ACCOUNTS.includes(id);
    return (
      <button className="frow" key={id} onClick={() => setModal({ m: 'account', id })}>
        <span className={`fic ${isBtc ? 'gold' : ''}`}>{isBtc ? '₿' : isLoc ? '↕' : '$'}</span>
        <span className="fmain"><b>{dispName(a?.name)}</b>
          <span>{isBtc ? `${fmtAmt(b.sats, state.unit).slice(1)} · paid ${fmtUsd(b.valueCents)}` : a?.custodian ?? (isLoc ? 'credit line' : 'checking')}</span></span>
        <span className={`famt ${isBtc ? 'gold' : ''}`}>
          {isBtc ? (mkt !== null ? fmtUsd(mkt) : fmtAmt(b.sats, state.unit).slice(1)) : fmtUsd(isLoc ? -b.valueCents : b.valueCents)}</span>
      </button>
    );
  };
  return (
    <div className="body">
      <div className="ptitle"><h3>Accounts</h3><div className="sub">every balance, and the records behind it</div></div>
      <div className="psec">Bitcoin</div>
      {BTC_ACCOUNTS.map(row)}
      <div className="psec">Cash</div>
      {row('bank:checking')}
      <div className="psec">Credit lines</div>
      {LOC_ACCOUNTS.filter(id => (state.ledger.balances[id]?.valueCents ?? 0) !== 0 || id === 'loc:strike').map(row)}
      <button className="linkrow" onClick={() => setModal({ m: 'opening' })}>＋ Add what you held before day one</button>
    </div>
  );
}

function AccountSheet({ state, id, onClose, setModal }: {
  state: AppState; id: string; onClose: () => void; setModal: (m: Modal) => void;
}): React.ReactElement {
  const L = state.ledger; const a = L.accounts[id];
  const b = L.balances[id] ?? { valueCents: 0, sats: 0 };
  const isBtc = a?.commodity === 'BTC';
  const mkt = isBtc ? marketCents(b.sats, state.reading) : null;
  const groups = feedOf(L, state.unit, t => t.splits.some(sp => sp.accountId === id)).slice(0, 6);
  return (
    <Sheet onClose={onClose} title={dispName(a?.name) || id} sub={isBtc ? a?.custodian : undefined}>
      <div className="card">
        {isBtc ? (<>
          <div className="row"><span className="k">holding</span><span className="v big">{fmtAmt(b.sats, state.unit).slice(1)}</span></div>
          <div className="row"><span className="k">what you paid</span><span className="v">{fmtUsd(b.valueCents)}</span></div>
          <div className="row"><span className="k">worth today {state.reading && <span className="tag">{state.reading.asOf === 'live' ? 'live price' : `at your ${state.reading.asOf} price`}</span>}</span>
            <span className="v g">{mkt !== null ? fmtUsd(mkt) : '—'}</span></div>
        </>) : (
          <div className="row"><span className="k">balance</span>
            <span className="v big">{fmtUsd(LOC_ACCOUNTS.includes(id) ? -b.valueCents : b.valueCents)}</span></div>
        )}
      </div>
      {groups.map(g => (
        <div key={g.date}>
          <div className="datehead">{g.date}</div>
          {g.items.map(it => <FeedRow key={it.txn.id} it={it} onTap={() => setModal({ m: 'txn', id: it.txn.id })} />)}
        </div>
      ))}
    </Sheet>
  );
}

/* ---------- transaction detail ---------- */
function TxnSheet({ state, id, onClose }: { state: AppState; id: string; onClose: () => void }): React.ReactElement | null {
  const t = state.ledger.txns.find(x => x.id === id);
  if (!t) return null;
  const acc = state.ledger.accounts;
  return (
    <Sheet onClose={onClose} title={t.description} sub={t.date}>
      <div className="card">
        {t.splits.map((sp, i) => (
          <div className="row" key={i}>
            <span className="k">{dispName(acc[sp.accountId]?.name)}
              {sp.lot?.basisUnknown && <span className="pill r">cost unknown</span>}</span>
            <span className={`v ${sp.valueCents > 0 ? '' : 'mut'}`}>
              {sp.amountSats !== undefined ? `${fmtAmt(sp.amountSats, state.unit)} · ` : ''}{fmtUsd(sp.valueCents)}</span>
          </div>
        ))}
        {t.splits.some(sp => sp.lots?.length) && (
          <div className="row"><span className="k tag">coins used: {t.splits.flatMap(sp => sp.lots ?? []).map(l => l.lotId).join(', ')} — saved with this entry, permanently</span></div>
        )}
      </div>
    </Sheet>
  );
}

/* ---------- Add sheet — grouped by life, not by ledger ---------- */
const FORM_TITLES: Record<string, [string, string?]> = {
  spend: ['Spent money', 'coffee, rent, anything — pick a category'],
  income: ['Money came in', 'salary, a client, anything'],
  buy: ['Buy bitcoin', 'money moves bank → bitcoin'],
  disposal: ['Sell bitcoin', 'the gain works itself out'],
  transfer: ['Move bitcoin', 'between your accounts, at cost'],
  draw: ['Borrow', 'credit line → bank'],
  paydown: ['Pay down', 'bank → credit line'],
  interest: ['Interest / minimum', 'bank → loan interest'],
};

function AddSheet({ onPick, setModal, onClose }: {
  onPick: (k: string) => void; setModal: (m: Modal) => void; onClose: () => void;
}): React.ReactElement {
  const A = ({ k, g, t }: { k: string; g: string; t: string }) => (
    <button className="addbtn" onClick={() => onPick(k)}><span className="fic gold">{g}</span><b>{t}</b></button>
  );
  return (
    <Sheet onClose={onClose} title="Add" sub="what happened?">
      <div className="psec" style={{ padding: '0 4px', margin: '6px 0 8px' }}>Everyday</div>
      <div className="addgrid">
        <A k="spend" g="−" t="Spent money" />
        <A k="income" g="+" t="Money came in" />
      </div>
      <div className="psec" style={{ padding: '0 4px', margin: '14px 0 8px' }}>Bitcoin</div>
      <div className="addgrid">
        <A k="buy" g="₿" t="Bought" />
        <A k="disposal" g="₿" t="Sold" />
        <A k="transfer" g="⇄" t="Moved" />
      </div>
      <div className="psec" style={{ padding: '0 4px', margin: '14px 0 8px' }}>Credit line</div>
      <div className="addgrid">
        <A k="draw" g="↓" t="Borrowed" />
        <A k="paydown" g="↑" t="Paid down" />
        <A k="interest" g="%" t="Interest" />
      </div>
      <div className="psec" style={{ padding: '0 4px', margin: '14px 0 8px' }}>From the suite</div>
      <button className="frow" style={{ width: '100%' }} onClick={() => setModal({ m: 'bridge' })}>
        <span className="fic gold">⇄</span>
        <span className="fmain"><b>From Personal ₿LOC</b><span>your borrowing plan, as drafts you approve</span></span>
        <span className="famt mut">›</span>
      </button>
      <button className="linkrow" style={{ marginTop: 6 }} onClick={() => setModal({ m: 'opening' })}>◔ What I held before day one</button>
      <button className="linkrow" onClick={() => setModal({ m: 'custom' })}>✎ Custom entry — the escape hatch</button>
    </Sheet>
  );
}

/* ---------- forms (inside sheets) ---------- */
const EXPENSE_CATS = ['exp:groceries', 'exp:rent', 'exp:utilities', 'exp:meals', 'exp:travel', 'exp:software', 'exp:phone', 'exp:insurance', 'exp:professional', 'exp:hardware', 'exp:misc'];
const INCOME_CATS = ['income:consulting', 'income:sales'];

function TemplateForm({ state, dispatch, formKey, done }: {
  state: AppState; dispatch: React.Dispatch<Action>; formKey: string; done: () => void;
}): React.ReactElement {
  const [date, setDate] = useState(TODAY);
  const [amount, setAmount] = useState('');
  const [sats, setSats] = useState('');
  const [memo, setMemo] = useState('');
  const [cat, setCat] = useState(formKey === 'income' ? INCOME_CATS[0] : EXPENSE_CATS[0]);
  const [from, setFrom] = useState('btc:cold');
  const [to, setTo] = useState('btc:strike');
  const [acct, setAcct] = useState('btc:strike');
  const [loc, setLoc] = useState('loc:strike');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [refs, setRefs] = useState<LotRef[] | undefined>(undefined);

  const ctx = () => ({ id: nextTxnId(state, formKey), date, utc: utcOf(date) });
  const cents = Math.round(Number(amount || '0') * 100);
  const nsats = Math.round(Number(sats || '0') * 100_000_000);
  const postAnd = (txn: Txn) => { dispatch({ type: 'postTxn', txn }); done(); };
  const dateRow = (
    <div className="card"><div className="row"><span className="k">date</span>
      <input type="date" value={date} onChange={e => setDate(e.target.value)} /></div></div>
  );

  if (formKey === 'spend' || formKey === 'income') {
    const cats = formKey === 'spend' ? EXPENSE_CATS : INCOME_CATS;
    return (<>
      <div className="card">
        <div className="row"><span className="k">amount (USD)</span>
          <input inputMode="decimal" placeholder="42.50" autoFocus value={amount} onChange={e => setAmount(e.target.value)} /></div>
        <div className="row"><span className="k">{formKey === 'spend' ? 'category' : 'from'}</span>
          <select value={cat} onChange={e => setCat(e.target.value)}>
            {cats.map(c => <option key={c} value={c}>{dispName(state.ledger.accounts[c]?.name)}</option>)}
          </select></div>
        <div className="row"><span className="k">note</span>
          <input placeholder={formKey === 'spend' ? 'what was it?' : 'who from?'} style={{ textAlign: 'left' }} value={memo} onChange={e => setMemo(e.target.value)} /></div>
      </div>
      {dateRow}
      <button className="btn p" disabled={cents <= 0}
        onClick={() => postAnd(formKey === 'spend'
          ? buildSpend(ctx(), cat, cents, memo)
          : buildIncome(ctx(), cat, cents, memo))}>
        {cents > 0 ? `Save ${fmtUsd(cents)}` : 'Enter an amount'}</button>
    </>);
  }

  if (formKey === 'buy') {
    return (<>
      <div className="card">
        <div className="row"><span className="k">amount (₿)</span>
          <input inputMode="decimal" placeholder="0.00500000" autoFocus value={sats} onChange={e => setSats(e.target.value)} /></div>
        <div className="row"><span className="k">cost (USD)</span>
          <input inputMode="decimal" placeholder="591.20" value={amount} onChange={e => setAmount(e.target.value)} /></div>
        <div className="row"><span className="k">into</span>
          <AcctSelect value={acct} onChange={setAcct} accounts={BTC_ACCOUNTS} state={state} /></div>
      </div>
      {dateRow}
      <button className="btn p" disabled={nsats <= 0 || cents <= 0}
        onClick={() => postAnd(buildBuy(ctx(), acct, nsats, cents))}>
        {nsats > 0 && cents > 0 ? `Save — ${fmtUsd(cents)} → ${dispName(state.ledger.accounts[acct]?.name)}` : 'Enter amount and cost'}</button>
    </>);
  }

  if (formKey === 'transfer') {
    const avail = state.ledger.balances[from]?.sats ?? 0;
    return (<>
      <div className="card">
        <div className="row"><span className="k">from</span>
          <AcctSelect value={from} onChange={setFrom} accounts={BTC_ACCOUNTS} state={state} /></div>
        <div className="row"><span className="k">to</span>
          <AcctSelect value={to} onChange={setTo} accounts={BTC_ACCOUNTS.filter(a => a !== from)} state={state} /></div>
        <div className="row"><span className="k">amount (₿)</span>
          <input inputMode="decimal" value={sats} onChange={e => { setSats(e.target.value); setRefs(undefined); }} /></div>
        <div className="row"><span className="k tag">available {fmtBtc(avail).slice(1)}</span></div>
      </div>
      <LotLine state={state} account={from} sats={nsats} refs={refs} open={pickerOpen} setOpen={setPickerOpen} setRefs={setRefs} />
      {dateRow}
      <button className="btn p" disabled={nsats <= 0 || nsats > avail || from === to}
        onClick={() => postAnd(buildTransfer(state.ledger, ctx(), from, to, nsats, { refs }))}>
        {nsats > 0 ? (nsats > avail ? 'Not enough in that account' : 'Save the move') : 'Enter an amount'}</button>
    </>);
  }

  if (formKey === 'draw' || formKey === 'paydown' || formKey === 'interest') {
    return (<>
      <div className="card">
        <div className="row"><span className="k">amount (USD)</span>
          <input inputMode="decimal" placeholder="1244.00" autoFocus value={amount} onChange={e => setAmount(e.target.value)} /></div>
        {formKey !== 'interest' && (
          <div className="row"><span className="k">credit line</span>
            <AcctSelect value={loc} onChange={setLoc} accounts={LOC_ACCOUNTS} state={state} /></div>)}
      </div>
      {dateRow}
      <button className="btn p" disabled={cents <= 0} onClick={() => postAnd(
        formKey === 'draw' ? buildDraw(ctx(), loc, cents)
          : formKey === 'paydown' ? buildPaydown(ctx(), loc, cents)
            : buildInterest(ctx(), cents))}>
        {cents > 0 ? `Save ${fmtUsd(cents)}` : 'Enter an amount'}</button>
    </>);
  }

  // sell — SPEC election means the user picks coins explicitly, every time (D14)
  const availD = state.ledger.balances[acct]?.sats ?? 0;
  const needsPick = (state.ledger.accounts[acct]?.lotMethod ?? 'FIFO') === 'SPEC' && !refs;
  const prep = (() => {
    try {
      return nsats > 0 && nsats <= availD && !needsPick
        ? buildDisposal(state.ledger, { id: 'peek', date, utc: utcOf(date) }, acct, nsats, cents, refs) : null;
    } catch { return null; }
  })();
  return (<>
    <div className="card">
      <div className="row"><span className="k">from</span>
        <AcctSelect value={acct} onChange={setAcct} accounts={BTC_ACCOUNTS} state={state} /></div>
      <div className="row"><span className="k">amount (₿)</span>
        <input inputMode="decimal" placeholder="0.01200000" value={sats} onChange={e => { setSats(e.target.value); setRefs(undefined); }} /></div>
      <div className="row"><span className="k">you received (USD)</span>
        <input inputMode="decimal" placeholder="1418.88" value={amount} onChange={e => setAmount(e.target.value)} /></div>
      <div className="row"><span className="k tag">available {fmtBtc(availD).slice(1)}</span></div>
    </div>
    <LotLine state={state} account={acct} sats={nsats} refs={refs} open={pickerOpen} setOpen={setPickerOpen} setRefs={setRefs} />
    {prep && (
      <div className="card flat">
        <div className="row"><span className="k">those coins cost you</span><span className="v">{fmtUsd(prep.basisCents)}</span></div>
        <div className="row"><span className="k">{prep.gainCents >= 0 ? 'gain' : 'loss'}</span>
          <span className={`v ${prep.gainCents >= 0 ? 'g' : 'r'}`}>{fmtUsd(Math.abs(prep.gainCents))}</span></div>
        {prep.anyUnknown && <div className="row"><span className="k pill r" style={{ marginLeft: 0 }}>includes cost-unknown coins — stays flagged</span></div>}
      </div>
    )}
    {dateRow}
    <button className="btn p" disabled={!prep}
      onClick={() => prep && postAnd(buildDisposal(state.ledger, ctx(), acct, nsats, cents, refs).txn)}>
      {prep ? `Save sale — ${prep.gainCents >= 0 ? 'gain' : 'loss'} ${fmtUsd(Math.abs(prep.gainCents))}` : needsPick && nsats > 0 ? 'Pick which coins below' : 'Enter amount and proceeds'}</button>
  </>);
}

/* ---------- lot line + picker ---------- */
function LotLine({ state, account, sats, refs, open, setOpen, setRefs }: {
  state: AppState; account: string; sats: number; refs?: LotRef[];
  open: boolean; setOpen: (b: boolean) => void; setRefs: (r: LotRef[] | undefined) => void;
}): React.ReactElement | null {
  if (sats <= 0) return null;
  try { proposeLots(state.ledger.lots, account, sats, 'FIFO'); } catch { return null; }
  return (
    <div className="card">
      <div className="row"><span className="k">which coins</span>
        <span className="v gold">{refs ? 'your pick' : (state.ledger.accounts[account]?.lotMethod === 'SPEC' ? 'choose below — your election' : 'oldest first — the usual choice')}
          <button onClick={() => setOpen(!open)}> · change ›</button></span></div>
      <div className="row"><span className="k tag">saved with this entry, permanently — that's what makes it provable</span></div>
      {open && (
        <LotPicker state={state} account={account} need={sats}
          onDone={(r) => { setRefs(r); setOpen(false); }}
          onFifo={() => { setRefs(undefined); setOpen(false); }} />
      )}
    </div>
  );
}

function LotPicker({ state, account, need, onDone, onFifo }: {
  state: AppState; account: string; need: number;
  onDone: (refs: LotRef[]) => void; onFifo: () => void;
}): React.ReactElement {
  const lots = Object.values(state.ledger.lots.lots)
    .filter(l => (l.placements[account]?.sats ?? 0) > 0)
    .sort((a, b) => (a.acquiredUtc < b.acquiredUtc ? -1 : 1));
  const [take, setTake] = useState<Record<string, number>>({});
  const total = Object.values(take).reduce((a, b) => a + b, 0);
  return (
    <div className="picker">
      {lots.map(l => {
        const avail = l.placements[account]?.sats ?? 0;
        return (
          <div className="row" key={l.lotId}>
            <span className="k">{l.acquiredDate}{l.basisUnknown && <span className="pill r">cost unknown</span>}</span>
            <span className="v">
              <input inputMode="numeric" placeholder="0" style={{ width: '10ch' }}
                value={take[l.lotId] ?? ''}
                onChange={e => setTake({ ...take, [l.lotId]: Math.min(avail, Math.max(0, Math.floor(Number(e.target.value || '0')))) })} />
              <span className="tag"> / {avail.toLocaleString()} sats</span>
            </span>
          </div>
        );
      })}
      <div className="row"><span className="k">selected</span>
        <span className={`v ${total === need ? 'g' : 'r'}`}>{total.toLocaleString()} / {need.toLocaleString()}</span></div>
      <button className="btn p" disabled={total !== need}
        onClick={() => onDone(Object.entries(take).filter(([, s]) => s > 0).map(([lotId, s]) => ({ lotId, sats: s })))}>Use these</button>
      <button className="btn ghost" onClick={onFifo}>Back to oldest-first</button>
    </div>
  );
}

/* ---------- opening lots / close / custom / settings ---------- */
function OpeningLots({ state, dispatch, done }: {
  state: AppState; dispatch: React.Dispatch<Action>; done: () => void;
}): React.ReactElement {
  const [acct, setAcct] = useState('btc:cold');
  const [sats, setSats] = useState('');
  const [cost, setCost] = useState('');
  const [date, setDate] = useState('2023-11-02');
  const [unknown, setUnknown] = useState(false);
  const nsats = Math.round(Number(sats || '0') * 100_000_000);
  const cents = Math.round(Number(cost || '0') * 100);
  return (<>
    <div className="card">
      <div className="row"><span className="k">amount (₿)</span>
        <input inputMode="decimal" placeholder="0.50000000" autoFocus value={sats} onChange={e => setSats(e.target.value)} /></div>
      <div className="row"><span className="k">where it lives</span>
        <AcctSelect value={acct} onChange={setAcct} accounts={BTC_ACCOUNTS} state={state} /></div>
      <div className="row"><span className="k">acquired on</span>
        <input type="date" value={date} onChange={e => setDate(e.target.value)} /></div>
      <div className="row"><span className="k">what it cost (USD)</span>
        <input inputMode="decimal" value={cost} disabled={unknown} placeholder={unknown ? 'unknown' : '17850.00'}
          onChange={e => setCost(e.target.value)} /></div>
      <div className="row"><span className="k">records lost?</span>
        <label className="v"><input type="checkbox" checked={unknown} onChange={e => setUnknown(e.target.checked)} /> mark cost unknown</label></div>
    </div>
    {unknown && <div className="note warn">Unknown is a state we show, not one we hide — this will appear, by name, in your reports. It never quietly becomes $0.</div>}
    <button className="btn p" disabled={nsats <= 0 || (!unknown && cents <= 0)}
      onClick={() => { dispatch({ type: 'postTxn', txn: buildOpeningLot(
        { id: nextTxnId(state, 'open'), date, utc: utcOf(date) }, acct, nsats, cents, unknown) }); }}>
      {nsats > 0 ? `Add — ${fmtBtc(nsats).slice(1)}` : 'Enter an amount'}</button>
    <button className="btn ghost" onClick={done}>Done</button>
  </>);
}

function CloseMonth({ state, dispatch }: {
  state: AppState; dispatch: React.Dispatch<Action>;
}): React.ReactElement {
  const months = monthsWithActivity(state.ledger);
  const closed = state.ledger.policy.closedThrough;
  const candidate = months.find(m => !closed || m > closed);
  const r = state.reading;
  const count = state.ledger.txns.filter(t => t.date.slice(0, 7) === candidate).length;
  return (<>
    <div className="card">
      <div className="row"><span className="k">month</span><span className="v">{candidate ?? '—'}</span></div>
      <div className="row"><span className="k">entries recorded</span><span className="v g">{candidate ? `${count} ✓` : '—'}</span></div>
      <div className="row"><span className="k">everything adds up</span><span className="v g">✓ always — the app won't let it not</span></div>
      <div className="row"><span className="k">checked through</span><span className="v">{closed ?? 'never'}</span></div>
    </div>
    <div className="card" style={{ borderColor: r ? 'rgba(232,176,79,.35)' : 'rgba(248,113,113,.4)' }}>
      <div className="row"><span className="k">bitcoin price to note</span>
        <span className={r ? 'v big gold' : 'v r'}>{r ? fmtUsd(r.priceCents) : 'none yet'}</span></div>
      <div className="row"><span className="k tag">{state.reading?.asOf === 'live' ? 'pre-filled from the live market — locking the month records this number as YOURS' : 'your number, your date. Set it in Settings.'}</span></div>
    </div>
    <button className="btn p" disabled={!candidate || !r}
      onClick={() => candidate && dispatch({ type: 'closeMonth', month: candidate })}>
      {r && candidate ? `Lock ${candidate} · price noted ${fmtUsd(r.priceCents)}`
        : !candidate ? 'Nothing to check in yet' : 'Add a bitcoin price first (Settings)'}</button>
    {state.closedStamps.length > 0 && (<>
      <div className="psec" style={{ padding: '0 4px' }}>locked months</div>
      {state.closedStamps.map((c: ClosedStamp) => (
        <div className="card flat" key={c.month}><div className="row">
          <span className="k">{c.month}</span>
          <span className="v">{fmtUsd(c.priceCents)} <span className="tag">noted {c.asOf}</span></span>
        </div></div>
      ))}
    </>)}
  </>);
}

function CustomEntry({ state, dispatch, done }: {
  state: AppState; dispatch: React.Dispatch<Action>; done: () => void;
}): React.ReactElement {
  const [date, setDate] = useState(TODAY);
  const [rows, setRows] = useState<{ accountId: string; dollars: string }[]>([
    { accountId: 'exp:misc', dollars: '' }, { accountId: 'bank:checking', dollars: '' },
  ]);
  const [desc, setDesc] = useState('');
  const cents = rows.map(r => Math.round(Number(r.dollars || '0') * 100));
  const sum = cents.reduce((a, b) => a + b, 0);
  const accounts = Object.values(state.ledger.accounts).filter(a => !a.placeholder && a.commodity === 'USD');
  return (<>
    <div className="card">
      <div className="row"><span className="k">what happened</span>
        <input value={desc} onChange={e => setDesc(e.target.value)} placeholder="describe it" style={{ textAlign: 'left' }} /></div>
      <div className="row"><span className="k">date</span>
        <input type="date" value={date} onChange={e => setDate(e.target.value)} /></div>
    </div>
    {rows.map((r, i) => (
      <div className="card" key={i}><div className="row">
        <select value={r.accountId} onChange={e => setRows(rows.map((x, j) => j === i ? { ...x, accountId: e.target.value } : x))}>
          {accounts.map(a => <option key={a.id} value={a.id}>{dispName(a.name)}</option>)}
        </select>
        <input inputMode="decimal" placeholder="±0.00" value={r.dollars} style={{ maxWidth: '11ch' }}
          onChange={e => setRows(rows.map((x, j) => j === i ? { ...x, dollars: e.target.value } : x))} />
      </div></div>
    ))}
    <button className="btn ghost" onClick={() => setRows([...rows, { accountId: 'exp:misc', dollars: '' }])}>＋ add a line</button>
    <div className="card flat"><div className="row"><span className="k">left to balance</span>
      <span className={`v ${sum === 0 ? 'g' : 'r'}`}>{fmtUsd(sum)}{sum === 0 ? ' · balanced' : ''}</span></div></div>
    <button className="btn p" disabled={sum !== 0 || cents.every(c => c === 0)} onClick={() => {
      dispatch({ type: 'postTxn', txn: {
        id: nextTxnId(state, 'custom'), date, description: desc || 'Entry',
        splits: rows.map((r, i) => ({ accountId: r.accountId, valueCents: cents[i], reconcile: 'n' as const })),
      }});
      done();
    }}>{sum === 0 && !cents.every(c => c === 0) ? 'Save entry' : 'Must land on $0.00 to save'}</button>
  </>);
}

function Settings({ state, dispatch, priceState, refresh, setModal }: {
  state: AppState; dispatch: React.Dispatch<Action>;
  priceState: 'loading' | 'live' | 'offline'; refresh: () => void;
  setModal: (m: Modal) => void;
}): React.ReactElement {
  const [price, setPrice] = useState('');
  const [asOf, setAsOf] = useState(TODAY);
  const [manualOpen, setManualOpen] = useState(false);
  const cents = Math.round(Number(price || '0') * 100);
  return (
    <div className="body">
      <div className="ptitle"><h3>Settings</h3><div className="sub">your choices, on the record</div></div>
      <div className="psec">Your key</div>
      <div className="card">
        {state.identity ? (<>
          <div className="row"><span className="k">signed in as</span>
            <span className="v gold">{state.identity.npub.slice(0, 14)}…{state.identity.kind === 'sample' ? ' · preview' : ''}</span></div>
          <div className="row"><span className="k tag">one key, both apps — it signs into Personal ₿LOC too, and its twelve words restore everything</span></div>
          <div className="row"><span className="k"><button onClick={() => dispatch({ type: 'setIdentity', identity: null })}>sign out ›</button></span></div>
        </>) : (<>
          <div className="row"><span className="k">no key yet</span>
            <span className="v mut">books work — sync and backup need a key</span></div>
          <div className="row"><span className="k">
            <button onClick={() => setModal({ m: 'key-new' })}>create my key ›</button>
            <span className="tag"> · </span>
            <button onClick={() => setModal({ m: 'key-in' })}>sign in ›</button></span></div>
        </>)}
      </div>
      <div className="psec">Bitcoin price</div>
      <div className="card">
        <div className="row"><span className="k">source</span>
          <span className={`v ${priceState === 'live' ? 'g' : priceState === 'offline' ? 'r' : 'mut'}`}>
            {priceState === 'live' ? `live · updated ${state.live?.updatedAt}` : priceState === 'loading' ? 'checking…' : 'offline'}
            <button onClick={refresh}> · ↻ refresh</button></span></div>
        {state.reading && <div className="row"><span className="k">current</span>
          <span className="v gold">{fmtUsd(state.reading.priceCents)} / ₿</span></div>}
        <div className="row"><span className="k tag">the display follows the market; your books only record a price when you confirm it at each monthly check-in</span></div>
        <div className="row"><span className="k"><button onClick={() => setManualOpen(!manualOpen)}>{manualOpen ? 'hide manual entry' : 'enter a price manually ›'}</button></span></div>
        {manualOpen && (<>
          <div className="row"><span className="k">price (USD / ₿)</span>
            <input inputMode="decimal" placeholder="118240.00" value={price} onChange={e => setPrice(e.target.value)} /></div>
          <div className="row"><span className="k">as of</span>
            <input type="date" value={asOf} onChange={e => setAsOf(e.target.value)} /></div>
        </>)}
      </div>
      {manualOpen && <button className="btn p" disabled={cents <= 0}
        onClick={() => { dispatch({ type: 'setReading', reading: { priceCents: cents, asOf } as Reading }); setManualOpen(false); }}>
        Use this price</button>}
      <div className="psec">Book choices — recorded, never assumed</div>
      <div className="card"><div className="row"><span className="k">network fees</span>
        <span className="v"><span className="chiprow" style={{ padding: 0, display: 'inline-flex', gap: 6 }}>
          <button className={`chip ${state.ledger.policy.networkFeeTreatment === 'expense' ? 'on' : ''}`}
            onClick={() => dispatch({ type: 'setFeePolicy', treatment: 'expense' })}>an expense</button>
          <button className={`chip ${state.ledger.policy.networkFeeTreatment === 'capitalize' ? 'on' : ''}`}
            onClick={() => dispatch({ type: 'setFeePolicy', treatment: 'capitalize' })}>add to coin cost</button>
        </span></span></div>
        <div className="row"><span className="k tag">your accountant's call — either way it's recorded, and applies from now on</span></div></div>
      <div className="card"><div className="row"><span className="k">selling order</span>
        <span className="v"><span className="chiprow" style={{ padding: 0, display: 'inline-flex', gap: 6 }}>
          <button className={`chip ${(state.ledger.accounts['btc:cold']?.lotMethod ?? 'FIFO') === 'FIFO' ? 'on' : ''}`}
            onClick={() => dispatch({ type: 'setLotMethod', method: 'FIFO' })}>oldest first</button>
          <button className={`chip ${state.ledger.accounts['btc:cold']?.lotMethod === 'SPEC' ? 'on' : ''}`}
            onClick={() => dispatch({ type: 'setLotMethod', method: 'SPEC' })}>I pick each time</button>
        </span></span></div>
        <div className="row"><span className="k tag">changing this never rewrites a sale you already recorded</span></div></div>
      <div className="psec">Display</div>
      <div className="card"><div className="row"><span className="k">currency</span>
        <span className="v"><span className="chiprow" style={{ padding: 0, display: 'inline-flex', flexWrap: 'wrap', gap: 6 }}>
          {CURRENCIES.map(c => (
            <button key={c} className={`chip ${state.currency === c ? 'on' : ''}`}
              disabled={c !== 'USD' && !state.live}
              onClick={() => dispatch({ type: 'setCurrency', currency: c })}>{c}</button>
          ))}
        </span></span></div>
        <div className="row"><span className="k tag">{state.live ? 'converted from live rates for display — your books stay in USD' : 'other currencies unlock when a live price is available'}</span></div></div>
      <div className="card"><div className="row"><span className="k">bitcoin shown as</span>
        <span className="v">
          <span className="chiprow" style={{ padding: 0, display: 'inline-flex' }}>
            <button className={`chip ${state.unit === 'btc' ? 'on' : ''}`} onClick={() => dispatch({ type: 'setUnit', unit: 'btc' })}>BTC</button>
            <button className={`chip ${state.unit === 'sats' ? 'on' : ''}`} onClick={() => dispatch({ type: 'setUnit', unit: 'sats' })}>sats</button>
          </span>
        </span></div>
        <div className="row"><span className="k tag">just how it's shown — your records don't change</span></div></div>
      <footer>BitBooks · locked to your key · synced by open relays · no kill switch · free means free</footer>
    </div>
  );
}

function AcctSelect({ value, onChange, accounts, state }: {
  value: string; onChange: (v: string) => void; accounts: string[]; state: AppState;
}): React.ReactElement {
  return (
    <select value={value} onChange={e => onChange(e.target.value)}>
      {accounts.map(a => <option key={a} value={a}>{dispName(state.ledger.accounts[a]?.name) || a}</option>)}
    </select>
  );
}
