// Launch Sniper + Post-Crowd Retrace — pump.fun replay bot (redo v2).
//
// Design (DeepSeek v4.1 flash, 26 Nov 2026) from fresh offline analysis of
// the dev window (430 coins) plus parameter sweeps against the pilot sim:
//
// Two shapes, both with tight banked exits and no holding through the fade:
//  1. LAUNCH: buy in a coin's first 5 slots when at most one distinct
//     non-creator buyer has appeared, real reserve >= 2 SOL, creator bought
//     <= 2.5 SOL and has not sold. Stake 0.035 SOL (capped at 97% of the
//     1%-of-reserve order cap). Exits: TP +8%, SL -12%, trailing -4% from
//     peak once +5% is reached, max hold 300 slots, exit on creator sell
//     or real reserve > 55 SOL.
//  2. PCR: after a crowd signal (>= 20 distinct buyers, >= 15 SOL of
//     non-creator buys), buy the first 12-25% retracement from the
//     post-signal running max when the last-5-slot flow turns positive
//     again, within 500 slots of the signal. Stake 0.06 SOL (same cap).
//     Exits: TP +10%, SL -15%, trailing -3% from peak once +4% is reached,
//     max hold 30 slots, same creator-sell / big-reserve exits.
// A third shape (buy the crowd signal itself) and a flow-fade exit were
// tested on dev and REMOVED: the crowd-signal entry buys the top of the
// spike (net -0.010 SOL, 0/10 wins) and the fade exit fires on slot noise
// (6 of the first 10 exits). They stay in the code only as inert
// parameters (csbDistinctCap 0, fadeNetLamports far below any real flow).
//
// Dev results (pilot sim): net +0.0704 SOL, 40 distinct mints, 41 trips,
// 18 wins, max drawdown 0.003, positive in both window halves
// (+0.0328 / +0.0376), +0.0174 SOL at 2x fees. Active submission v1:
// +0.0202 SOL, 25 mints, 7 wins.
//
// Determinism: pure function of the event stream. No clock, no environment,
// no Math.random. All ordering is by first-seen order or explicit sort by
// mint pubkey. Prices are compared as scaled integers (bigint), never floats.

import type { Batch, BotState, OrderInput } from './vendor/makefun-bot.ts';

export interface Params {
  // Stakes (lamports).
  stakeCsb: bigint;
  stakePcr: bigint;
  stakeFallback: bigint;
  // Crowd-signal filter.
  minBuyers: number;
  minCumBuyLamports: bigint;
  maxCreatorBuyLamports: bigint;
  minRealLamports: bigint;
  maxRealLamports: bigint;
  exitRealLamports: bigint;
  maxAgeSlots: number;
  // Fill-price guards, in bps of the reference price (10000 = 100%).
  maxFillVsSignalBps: number;
  maxFillVsFirstBps: number;
  // CSB exits (bps of entry price, 10000 = 100%).
  tpBps: number;
  slBps: number;
  trailArmBps: number;
  trailDropBps: number;
  maxHoldSlots: number;
  // PCR shape.
  pcrLowBps: number;
  pcrHighBps: number;
  pcrMaxAgeSlots: number;
  pcrTpBps: number;
  pcrSlBps: number;
  pcrTrailArmBps: number;
  pcrTrailDropBps: number;
  pcrMaxHoldSlots: number;
  // Fade exit: net non-creator flow over the last 20 slots at or below this.
  fadeNetLamports: bigint;
  // Launch shape: buy the launch itself, before any crowd forms.
  launchMaxAgeSlots: number;
  launchMaxBuyers: number;
  launchMinRealLamports: bigint;
  launchMaxCreatorBuyLamports: bigint;
  launchStake: bigint;
  // Pacer.
  fallbackCreated1: number;
  fallbackBuyers1: number;
  fallbackCumBuyLamports1: bigint;
  fallbackCreated2: number;
  fallbackBuyers2: number;
  fallbackCumBuyLamports2: bigint;
  maxDistinct: number;
  csbDistinctCap: number;
  slippageBps: number;
}

export const DEFAULT_PARAMS: Params = {
  stakeCsb: 20_000_000n,
  stakePcr: 60_000_000n,
  stakeFallback: 12_000_000n,
  minBuyers: 20,
  minCumBuyLamports: 15_000_000_000n,
  maxCreatorBuyLamports: 2_500_000_000n,
  minRealLamports: 2_500_000_000n,
  maxRealLamports: 50_000_000_000n,
  exitRealLamports: 55_000_000_000n,
  maxAgeSlots: 50,
  maxFillVsSignalBps: 10_600,
  maxFillVsFirstBps: 13_500,
  tpBps: 10_800,
  slBps: 8_800,
  trailArmBps: 10_500,
  trailDropBps: 9_600,
  maxHoldSlots: 300,
  pcrLowBps: 7_500,
  pcrHighBps: 8_800,
  pcrMaxAgeSlots: 500,
  pcrTpBps: 11_000,
  pcrSlBps: 8_500,
  pcrTrailArmBps: 10_400,
  pcrTrailDropBps: 9_700,
  pcrMaxHoldSlots: 30,
  fadeNetLamports: -100_000_000_000n,
  launchMaxAgeSlots: 5,
  launchMaxBuyers: 1,
  launchMinRealLamports: 2_000_000_000n,
  launchMaxCreatorBuyLamports: 2_500_000_000n,
  launchStake: 35_000_000n,
  fallbackCreated1: 120,
  fallbackBuyers1: 15,
  fallbackCumBuyLamports1: 10_000_000_000n,
  fallbackCreated2: 250,
  fallbackBuyers2: 10,
  fallbackCumBuyLamports2: 6_000_000_000n,
  maxDistinct: 40,
  csbDistinctCap: 0,
  slippageBps: 500,
};

const LAMPORT_KEYS: (keyof Params)[] = [
  'stakeCsb',
  'stakePcr',
  'stakeFallback',
  'minCumBuyLamports',
  'maxCreatorBuyLamports',
  'minRealLamports',
  'maxRealLamports',
  'exitRealLamports',
  'fadeNetLamports',
  'fallbackCumBuyLamports1',
  'fallbackCumBuyLamports2',
  'launchMinRealLamports',
  'launchMaxCreatorBuyLamports',
  'launchStake',
];

const SCALE = 1_000_000n;

interface Coin {
  mint: string;
  creator: string;
  firstSlot: number;
  firstPrice: bigint;
  buyers: Set<string>;
  cumBuy: bigint;
  creatorBuy: bigint;
  creatorSold: boolean;
  signalSlot: number;
  signalPrice: bigint;
  peakAfterSignal: bigint;
  // Recent non-creator net flow: [slot, deltaLamports], pruned to last 20 slots.
  flow: { slot: number; delta: bigint }[];
  csbTried: boolean;
  pcrTried: boolean;
  launchTried: boolean;
  complete: boolean;
}

interface Held {
  entryPrice: bigint;
  entrySlot: number;
  peak: bigint;
  kind: 'csb' | 'pcr';
}

interface PendingBuy {
  mint: string;
  price: bigint;
  kind: 'csb' | 'pcr';
}

function priceOf(vq: bigint, vt: bigint): bigint {
  if (vt <= 0n) return 0n;
  return (vq * SCALE) / vt;
}

export function createStrategy(overrides: Partial<Params> = {}) {
  const p: Params = { ...DEFAULT_PARAMS };
  for (const [k, v] of Object.entries(overrides)) {
    const key = k as keyof Params;
    if (v === undefined) continue;
    if ((LAMPORT_KEYS as string[]).includes(k) && typeof v === 'number') {
      (p as Record<string, unknown>)[key] = BigInt(Math.round(v));
    } else {
      (p as Record<string, unknown>)[key] = v;
    }
  }

  const coins = new Map<string, Coin>();
  const held = new Map<string, Held>();
  const pendingBuys = new Map<string, PendingBuy>();
  const traded = new Set<string>();
  let createdCount = 0;
  let orderNo = 0;

  function coinFor(mint: string, slot: number): Coin {
    let c = coins.get(mint);
    if (c === undefined) {
      c = {
        mint,
        creator: '',
        firstSlot: slot,
        firstPrice: 0n,
        buyers: new Set<string>(),
        cumBuy: 0n,
        creatorBuy: 0n,
        creatorSold: false,
        signalSlot: -1,
        signalPrice: 0n,
        peakAfterSignal: 0n,
        flow: [],
        csbTried: false,
        pcrTried: false,
        launchTried: false,
        complete: false,
      };
      coins.set(mint, c);
    }
    return c;
  }

  function netFlow(c: Coin, slot: number, window: number): bigint {
    let sum = 0n;
    for (const f of c.flow) if (f.slot > slot - window) sum += f.delta;
    return sum;
  }

  function crowdMet(c: Coin, minBuyers: number, minCum: bigint): boolean {
    return (
      c.buyers.size >= minBuyers &&
      c.cumBuy >= minCum &&
      c.creatorBuy <= p.maxCreatorBuyLamports &&
      !c.creatorSold
    );
  }

  function onBatch(state: BotState, batch: Batch): OrderInput[] {
    const slot = batch.slot;
    // ---- 1. Fold this batch's events into per-coin state. ----
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        const c = coinFor(e.mint, slot);
        if (c.creator === '') c.creator = e.creator;
        if (c.firstSlot === slot) createdCount += 1;
      } else if (e.event === 'TradeEvent') {
        const c = coinFor(e.mint, slot);
        if (c.creator === '') c.creator = e.creator;
        const price = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
        if (c.firstPrice === 0n) c.firstPrice = price;
        const sol = BigInt(e.sol_amount);
        if (e.user === c.creator) {
          if (e.is_buy) c.creatorBuy += sol;
          else c.creatorSold = true;
        } else {
          if (e.is_buy) {
            c.buyers.add(e.user);
            c.cumBuy += sol;
            c.flow.push({ slot, delta: sol });
          } else {
            c.flow.push({ slot, delta: -sol });
          }
        }
        if (c.flow.length > 400) c.flow.splice(0, c.flow.length - 400);
        if (c.signalSlot >= 0 && price > c.peakAfterSignal) c.peakAfterSignal = price;
        if (c.signalSlot < 0 && crowdMet(c, p.minBuyers, p.minCumBuyLamports)) {
          c.signalSlot = slot;
          c.signalPrice = price;
          c.peakAfterSignal = price;
        }
      } else {
        const c = coins.get(e.mint);
        if (c !== undefined) c.complete = true;
      }
    }

    // ---- 2. Fold fills: record entries, clear exited/failed buys. ----
    for (const f of batch.fills) {
      if (f.status === 'filled' && f.side === 'buy') {
        const pb = pendingBuys.get(f.client_id);
        pendingBuys.delete(f.client_id);
        if (pb !== undefined) {
          held.set(f.mint, { entryPrice: pb.price, entrySlot: f.slot, peak: pb.price, kind: pb.kind });
          traded.add(f.mint);
        }
      } else if (f.side === 'buy') {
        pendingBuys.delete(f.client_id);
      } else if (f.status === 'filled' && f.side === 'sell') {
        held.delete(f.mint);
      }
    }
    for (const mint of [...held.keys()]) {
      if (!state.positions.has(mint)) held.delete(mint);
    }

    const orders: OrderInput[] = [];
    const txFee = state.txFeeLamports();
    // A sell already in flight still shows its tokens in positions until its
    // fill arrives — never send a second sell for the same mint.
    const pendingSell = new Set(
      [...state.pending.values()].filter((po) => po.order.side === 'sell').map((po) => po.order.mint),
    );

    // ---- 3. Exits first: bank spikes, cut losers, never hold the fade. ----
    for (const [mint, pos] of [...state.positions.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      if (pendingSell.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      const h = held.get(mint);
      const c = coins.get(mint);
      // Entry price fallback: cost basis from the position when the fill
      // record is missing (should not happen, but never exit blind).
      const entry = h !== undefined ? h.entryPrice : (BigInt(pos.cost_lamports) * SCALE) / BigInt(pos.token_amount);
      if (entry <= 0n || price <= 0n) continue;
      const kind = h !== undefined ? h.kind : 'csb';
      const tp = kind === 'pcr' ? p.pcrTpBps : p.tpBps;
      const sl = kind === 'pcr' ? p.pcrSlBps : p.slBps;
      const arm = kind === 'pcr' ? p.pcrTrailArmBps : p.trailArmBps;
      const drop = kind === 'pcr' ? p.pcrTrailDropBps : p.trailDropBps;
      const maxHold = kind === 'pcr' ? p.pcrMaxHoldSlots : p.maxHoldSlots;
      if (h !== undefined && price > h.peak) h.peak = price;
      const peak = h !== undefined ? h.peak : price;
      const entrySlot = h !== undefined ? h.entrySlot : slot;
      let exit = false;
      if (price * 10_000n >= entry * BigInt(tp)) exit = true; // take profit
      else if (price * 10_000n <= entry * BigInt(sl)) exit = true; // stop loss
      else if (peak * 10_000n >= entry * BigInt(arm) && price * 10_000n <= peak * BigInt(drop)) exit = true; // trailing
      else if (slot - entrySlot >= maxHold) exit = true; // max hold
      else if (c !== undefined && c.creatorSold) exit = true; // creator sold
      else if (curve.real_quote_reserves > p.exitRealLamports) exit = true; // near migration
      else if (c !== undefined && netFlow(c, slot, 20) <= p.fadeNetLamports) exit = true; // flow faded
      if (exit && BigInt(pos.token_amount) > 0n) {
        orders.push({ side: 'sell', mint, token_amount: BigInt(pos.token_amount), max_slippage_bps: p.slippageBps });
      }
    }

    // ---- 4. Entries: crowd spike bank, then post-crowd retrace. ----
    const openNow = state.committedPositionCount();
    const selling = new Set(orders.filter((o) => o.side === 'sell').map((o) => o.mint));
    const freeAfterSells = openNow - selling.size;
    const slotsFree = Math.max(0, 5 - freeAfterSells);
    if (slotsFree > 0 && traded.size < p.maxDistinct && orders.length < 16) {
      const cands: { mint: string; kind: 'csb' | 'pcr'; shape: 'launch' | 'csb' | 'pcr'; stake: bigint; buyers: number; cum: bigint; real: bigint }[] = [];
      const allowFallback1 = traded.size < 20 && createdCount >= p.fallbackCreated1;
      const allowFallback2 = traded.size < 20 && createdCount >= p.fallbackCreated2;
      for (const c of coins.values()) {
        if (c.complete) continue;
        if (held.has(c.mint) || state.positions.has(c.mint)) continue;
        if (pendingBuys.size > 0 && [...pendingBuys.values()].some((pb) => pb.mint === c.mint)) continue;
        const curve = state.curves.get(c.mint);
        if (curve === undefined || curve.complete) continue;
        const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
        if (price <= 0n || c.firstPrice <= 0n) continue;
        const real = curve.real_quote_reserves;
        if (real < p.launchMinRealLamports || real > p.maxRealLamports) continue;
        if (c.creatorSold || c.creatorBuy > p.maxCreatorBuyLamports) continue;
        const age = slot - c.firstSlot;
        // Launch: a single big early buyer accumulating, before any crowd
        // forms. Time-critical (first few slots only), so it outranks the
        // other shapes in the sort below.
        if (!c.launchTried && age <= p.launchMaxAgeSlots && c.buyers.size <= p.launchMaxBuyers) {
          if (real >= p.launchMinRealLamports && c.creatorBuy <= p.launchMaxCreatorBuyLamports) {
            cands.push({ mint: c.mint, kind: 'csb', shape: 'launch', stake: p.launchStake, buyers: c.buyers.size, cum: c.cumBuy, real });
          }
        }
        // CSB: fresh crowd signal, price not already blown out.
        if (c.signalSlot >= 0 && !c.csbTried && age <= p.maxAgeSlots && traded.size < p.csbDistinctCap && real >= p.minRealLamports) {
          const strict = crowdMet(c, p.minBuyers, p.minCumBuyLamports);
          const fb1 = allowFallback1 && crowdMet(c, p.fallbackBuyers1, p.fallbackCumBuyLamports1);
          const fb2 = allowFallback2 && crowdMet(c, p.fallbackBuyers2, p.fallbackCumBuyLamports2);
          if (strict || fb1 || fb2) {
            if (price * 10_000n <= c.signalPrice * BigInt(p.maxFillVsSignalBps) && price * 10_000n <= c.firstPrice * BigInt(p.maxFillVsFirstBps)) {
              cands.push({ mint: c.mint, kind: 'csb', shape: 'csb', stake: strict ? p.stakeCsb : p.stakeFallback, buyers: c.buyers.size, cum: c.cumBuy, real });
            }
          }
        }
        // PCR: 12-25% retracement from the post-signal running max, fresh
        // flow turning positive again. Age is measured from the SIGNAL slot:
        // a retracement takes hundreds of slots to form. One per mint.
        if (!c.pcrTried && c.signalSlot >= 0 && slot - c.signalSlot <= p.pcrMaxAgeSlots && c.peakAfterSignal > 0n) {
          if (
            price * 10_000n >= c.peakAfterSignal * BigInt(p.pcrLowBps) &&
            price * 10_000n <= c.peakAfterSignal * BigInt(p.pcrHighBps) &&
            netFlow(c, slot, 5) > 0n
          ) {
            cands.push({ mint: c.mint, kind: 'pcr', shape: 'pcr', stake: p.stakePcr, buyers: c.buyers.size, cum: c.cumBuy, real });
          }
        }
      }
      // Priority: launch first (it expires in slots), then most buyers,
      // then most crowd SOL, then deepest reserve, then mint pubkey —
      // fully deterministic.
      const shapeRank = (s: 'launch' | 'csb' | 'pcr'): number => (s === 'launch' ? 0 : s === 'csb' ? 1 : 2);
      cands.sort((a, b) => {
        if (shapeRank(a.shape) !== shapeRank(b.shape)) return shapeRank(a.shape) - shapeRank(b.shape);
        if (b.buyers !== a.buyers) return b.buyers - a.buyers;
        if (b.cum !== a.cum) return b.cum > a.cum ? 1 : -1;
        if (a.real !== b.real) return a.real < b.real ? -1 : 1;
        return a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : 0;
      });
      let freeCash = state.freeCashLamports();
      let sent = 0;
      for (const cand of cands) {
        if (sent >= slotsFree) break;
        if (orders.length >= 16) break;
        const cap = state.maxBuyLamports(cand.mint);
        let stake = cand.stake;
        const capped = (cap * 97n) / 100n;
        if (stake > capped) stake = capped;
        if (stake < 10_000_000n) continue; // round trips must clear 0.01 SOL
        if (freeCash < stake + txFee) continue;
        const c = coins.get(cand.mint);
        if (c === undefined) continue;
        if (cand.shape === 'csb') c.csbTried = true;
        else if (cand.shape === 'pcr') c.pcrTried = true;
        else c.launchTried = true;
        orderNo += 1;
        const id = `b${orderNo}`;
        pendingBuys.set(id, {
          mint: cand.mint,
          price: priceOf(state.curves.get(cand.mint)!.virtual_quote_reserves, state.curves.get(cand.mint)!.virtual_token_reserves),
          kind: cand.kind,
        });
        orders.push({ side: 'buy', client_id: id, mint: cand.mint, quote_lamports: stake, max_slippage_bps: p.slippageBps });
        freeCash -= stake + txFee;
        sent += 1;
      }
    }

    return orders;
  }

  return { onBatch };
}
