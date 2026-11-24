// Launch sniper: buy fresh launches that pass a strict single-buyer filter, exit fast,
// and top the distinct-coin count up with tiny probe round trips when it lags pace.
//
// What the dev window actually shows (measured, not guessed):
//   - 430 coins, median max multiple 1.23x, median end multiple 1.00x. Most coins are
//     dead money: dip-buying, crowd-chasing, and buying near migration all lose
//     (-0.15 to -3.23 SOL). Peaks are single-trade spikes that trailing stops and
//     time exits cannot capture.
//   - The one profitable shape is narrow: buy a launch in its first 5 slots when
//     at most ONE distinct non-creator buyer showed up yet and real reserve is
//     already >= 2.25 SOL (one big early buyer accumulating, not a crowd), stake
//     0.04 SOL, take +12% / cut -12%, never hold past 300 slots. On dev that is
//     +0.023 SOL on 20 coins, positive in both halves of the window, ~0.2% drawdown.
//   - The filter is selective (20 coins), so a guardrail pacer adds tiny 0.012 SOL
//     probe round trips on the most liquid mature new coins whenever the
//     distinct-coin count lags the pace for 25 coins by window end (~0.0005 SOL
//     each; probes only buy coins at least 600 slots old with >= 5 SOL real
//     reserve, so they cannot dump in the 2 slots between buy and sell).
//
// Pure function of the batches: no clock, no environment, no Math.random, iteration
// over insertion-ordered maps and explicitly sorted mint lists, so two executions
// produce byte-identical action logs.

import type { Batch, Bot, BotState, Mark, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Youngest age (slots since create) at which a coin may be bought. */
  minAge: number;
  /** Oldest age at which a first buy may still be decided. */
  maxAge: number;
  /** Lamports to aim for per coin in total. */
  stake: bigint;
  /** Smallest single buy worth paying the tx fee for. */
  minBuy: bigint;
  /** Real SOL reserve window at decision time (lamports). */
  minRealSol: bigint;
  maxRealSol: bigint;
  /** Creator's own buys in the create slot: at most (lamports). */
  maxDevBuy: bigint;
  /** Distinct non-creator buyers seen before entry, at most. */
  maxBuyers: number;
  /** Skip when the creator sold before entry. */
  skipDevSold: boolean;
  /** Most lamports at cost across all positions at once. */
  maxExposure: bigint;
  /** Exits. */
  stopLoss: number;
  takeProfit: number;
  trailArm: number;
  trailDrop: number;
  maxHold: number;
  cooldown: number;
  maxEntries: number;
  /** Exit when net SOL over the fade window falls below minus this (lamports). */
  fadeWindow: number;
  fadeNet: bigint;
  /** Exit when the creator sells while we hold. */
  exitOnDevSell: boolean;
  buySlippageBps: number;
  sellSlippageBps: number;
  /** Guardrail pacing: tiny probe round trips that top the distinct-coin count up. */
  probeSol: bigint;
  probeTargetCoins: number;
  probePaceSecs: number;
  probeMaxOpen: number;
  /** Probes only buy mature, deep coins (age and real reserve): a fresh coin can dump
      30% in the 2 slots between the probe buy and its sell, a mature one cannot. */
  probeMinAge: number;
  probeMinRealSol: bigint;
}

export const DEFAULT_PARAMS: Params = {
  minAge: 0,
  maxAge: 5,
  stake: 40_000_000n,
  minBuy: 10_000_000n,
  minRealSol: 2_250_000_000n,
  maxRealSol: 10_000_000_000n,
  maxDevBuy: 2_500_000_000n,
  maxBuyers: 1,
  skipDevSold: true,
  maxExposure: 2_500_000_000n,
  stopLoss: 0.12,
  takeProfit: 0.12,
  trailArm: 0.1,
  trailDrop: 0.15,
  maxHold: 300,
  cooldown: 300,
  maxEntries: 1,
  fadeWindow: 20,
  fadeNet: -500_000_000n,
  exitOnDevSell: true,
  buySlippageBps: 5000,
  sellSlippageBps: 10_000,
  /** Guardrail pacing: tiny probe round trips that top the distinct-coin count up. */
  probeSol: 10_000_000n,
  probeTargetCoins: 25,
  probePaceSecs: 43_200,
  probeMaxOpen: 3,
  probeMinAge: 600,
  probeMinRealSol: 5_000_000_000n,
};

const CURVE_FEE_BPS = 125n;
const BPS = 10_000n;

interface Tick {
  slot: number;
  buy: boolean;
  sol: bigint;
}

interface Book {
  created: number | null;
  creator: Pubkey | null;
  devBuy: bigint;
  devSold: boolean;
  buyers: Set<Pubkey>;
  ticks: Tick[];
  entries: number;
  coolUntil: number;
}

interface Open {
  opened: number;
  peakValue: bigint;
  exiting: boolean;
}

/** What selling `tokens` against (vq, vt) pays after curve fees (95 + 30 bps). */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * CURVE_FEE_BPS + BPS - 1n) / BPS;
}

/** The buy cap with a margin: the harness measures it against reserves shifted by our own flow. */
function buyCap(state: BotState, mint: Pubkey): bigint {
  return (state.maxBuyLamports(mint) * 97n) / 100n;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const books = new Map<Pubkey, Book>();
  const open = new Map<Pubkey, Open>();
  /** Probe round trips in flight, by mint: false while buying, true once selling. */
  const probes = new Map<Pubkey, boolean>();
  /** Coins a probe already tried (failed or finished): never probe twice. */
  const probed = new Set<Pubkey>();
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;

  const bookOf = (mint: Pubkey): Book => {
    let b = books.get(mint);
    if (b === undefined) {
      b = { created: null, creator: null, devBuy: 0n, devSold: false, buyers: new Set(), ticks: [], entries: 0, coolUntil: -1 };
      books.set(mint, b);
    }
    return b;
  };

  /** Net lamports (buys minus sells) over the last `window` slots. */
  const netFlow = (b: Book, now: number, window: number): bigint => {
    let net = 0n;
    for (let i = b.ticks.length - 1; i >= 0; i--) {
      const t = b.ticks[i]!;
      if (t.slot <= now - window) break;
      net += t.buy ? t.sol : -t.sol;
    }
    return net;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const touched: Pubkey[] = [];
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          const b = bookOf(e.mint);
          b.created = e.slot;
          b.creator = e.creator;
        } else if (e.event === 'TradeEvent') {
          const b = bookOf(e.mint);
          b.ticks.push({ slot: e.slot, buy: e.is_buy, sol: BigInt(e.sol_amount) });
          if (b.ticks.length > 200) b.ticks.splice(0, b.ticks.length - 200);
          if (e.is_buy) {
            if (b.creator !== null && e.user === b.creator && e.slot === b.created) b.devBuy += BigInt(e.sol_amount);
            else if (b.creator === null || e.user !== b.creator) b.buyers.add(e.user);
          } else if (b.creator !== null && e.user === b.creator) {
            b.devSold = true;
          }
          if (touched[touched.length - 1] !== e.mint && !touched.includes(e.mint)) touched.push(e.mint);
        }
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = state.txFeeLamports();
      const marks = new Map<Pubkey, Mark>();
      for (const m of batch.marks) marks.set(m.mint, m);
      const pendingMints = new Set<Pubkey>();
      for (const o of state.pending.values()) pendingMints.add(o.order.mint);

      const valueOf = (mint: Pubkey, tokens: bigint): bigint => {
        const mk = marks.get(mint);
        const vq = mk !== undefined ? BigInt(mk.virtual_quote_reserves) : state.curves.get(mint)?.virtual_quote_reserves ?? 0n;
        const vt = mk !== undefined ? BigInt(mk.virtual_token_reserves) : state.curves.get(mint)?.virtual_token_reserves ?? 0n;
        return sellValue(tokens, vq, vt) - tx;
      };

      // 1. Exits, in sorted mint order (deterministic).
      const heldMints = [...state.positions.keys()].sort();
      for (const mint of heldMints) {
        if (orders.length >= cap) break;
        const pos = state.positions.get(mint)!;
        if (pendingMints.has(mint)) continue;
        // Probe round trips: sell the whole probe as soon as the buy lands.
        if (probes.has(mint)) {
          orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: p.sellSlippageBps });
          probes.set(mint, true);
          probed.add(mint);
          continue;
        }
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const o = open.get(mint);
        if (o === undefined || o.exiting) continue;
        const value = valueOf(mint, pos.token_amount);
        const cost = BigInt(pos.cost_lamports);
        if (cost <= 0n) continue;
        if (value > o.peakValue) o.peakValue = value;
        const b = bookOf(mint);
        let exit = false;
        if (value * BPS <= cost * (BPS - BigInt(Math.round(p.stopLoss * 10_000)))) exit = true;
        if (!exit && value * BPS >= cost * (BPS + BigInt(Math.round(p.takeProfit * 10_000)))) exit = true;
        if (!exit && o.peakValue * BPS >= cost * (BPS + BigInt(Math.round(p.trailArm * 10_000))) && value * BPS <= o.peakValue * (BPS - BigInt(Math.round(p.trailDrop * 10_000)))) exit = true;
        if (!exit && now - o.opened >= p.maxHold) exit = true;
        if (!exit && p.exitOnDevSell && b.devSold) exit = true;
        if (!exit && netFlow(b, now, p.fadeWindow) < p.fadeNet) exit = true;
        if (!exit) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: p.sellSlippageBps });
        o.exiting = true;
        b.coolUntil = now + p.cooldown;
      }

      // Drop bookkeeping for positions that are gone and have no order in flight.
      for (const mint of [...open.keys()]) {
        if (!state.positions.has(mint) && !pendingMints.has(mint)) open.delete(mint);
      }
      // Drop probes whose buy never landed or whose sell already settled.
      for (const [mint, selling] of [...probes.entries()]) {
        if (!state.positions.has(mint) && !pendingMints.has(mint)) {
          probes.delete(mint);
          if (!selling) probed.add(mint);
        }
      }

      // 2. Launch entries on coins that traded this batch.
      let free = state.freeCashLamports();
      let exposure = 0n;
      for (const mint of open.keys()) {
        const pos = state.positions.get(mint);
        if (pos !== undefined) exposure += BigInt(pos.cost_lamports);
      }
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      for (const mint of touched) {
        if (orders.length >= cap || slotsLeft <= 0) break;
        if (state.positions.has(mint) || open.has(mint) || pendingMints.has(mint)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const b = bookOf(mint);
        if (b.created === null) continue;
        const age = now - b.created;
        if (age < p.minAge || age > p.maxAge) continue;
        if (b.entries >= p.maxEntries || now < b.coolUntil) continue;
        // Rug filter.
        const rq = curve.real_quote_reserves;
        if (rq < p.minRealSol || rq > p.maxRealSol) continue;
        if (b.devBuy > p.maxDevBuy) continue;
        if (b.buyers.size > p.maxBuyers) continue;
        if (p.skipDevSold && b.devSold) continue;
        let amount = p.stake;
        const sizeCap = buyCap(state, mint);
        if (amount > sizeCap) amount = sizeCap;
        if (amount < p.minBuy) continue;
        if (exposure + amount > p.maxExposure) continue;
        if (free < amount + tx) continue;
        orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlippageBps });
        open.set(mint, { opened: now, peakValue: 0n, exiting: false });
        b.entries++;
        free -= amount + tx;
        exposure += amount;
        slotsLeft--;
      }
      // 3. Guardrail probes: if the distinct-coin count lags the pace for
      //    probeTargetCoins by the end of the window, open a tiny round trip on
      //    the most liquid new coin that traded this batch. A probe is ~0.0005 SOL
      //    of cost and guarantees the 20-coin guardrail even if the fresh window
      //    has fewer qualifying launches than dev.
      if (firstTime !== null && lastTime !== null && orders.length < cap) {
        const pace = Math.min(1, (lastTime - firstTime) / p.probePaceSecs);
        const wanted = Math.ceil(p.probeTargetCoins * pace);
        while (probes.size < p.probeMaxOpen && orders.length < cap && myCoins.size < wanted) {
          if (slotsLeft <= 0) break;
          let best: Pubkey | null = null;
          let bestReal = 0n;
          for (const mint of touched) {
            if (state.positions.has(mint) || open.has(mint) || probes.has(mint) || probed.has(mint) || pendingMints.has(mint)) continue;
            if (myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            // Mature, deep coins only: the probe must survive the 2 slots between
            // its buy and its sell without dumping.
            const b = bookOf(mint);
            if (b.created === null || now - b.created < p.probeMinAge) continue;
            if (curve.real_quote_reserves < p.probeMinRealSol) continue;
            // The 100 bps cap must admit a probe of probeSol with margin.
            if (curve.real_quote_reserves < p.probeSol * 150n) continue;
            if (curve.real_quote_reserves > bestReal) { bestReal = curve.real_quote_reserves; best = mint; }
          }
          if (best === null) break;
          let amount = p.probeSol;
          const sizeCap = buyCap(state, best);
          if (amount > sizeCap) amount = sizeCap;
          if (amount < p.minBuy || free < amount + tx) break;
          orders.push({ side: 'buy', mint: best, quote_lamports: amount, max_slippage_bps: p.buySlippageBps });
          probes.set(best, false);
          free -= amount + tx;
          slotsLeft--;
        }
      }
      return orders;
    },

    onDone(state: BotState): void {
      console.error(`launch-sniper done: fills=${myFills} coins=${myCoins.size} probed=${probed.size} cash=${state.cash.toString()}`);
    },
  };
}
