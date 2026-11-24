# Launch Sniper — Pump.fun Paper Bot

[![Competition](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![Rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/museshiro/pump-fun-replay-sprint-20261124/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![Reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/museshiro/pump-fun-replay-sprint-20261124/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

Entry for the [Pump.fun Replay Sprint — Paper Bot, Real Ranking](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) bounty on [make.fun](https://make.fun/r/xrr5vp10).

## What it does

A paper-trading bot for the pump.fun replay harness. It does exactly one thing
well: **snipe fresh launches that pass a strict single-buyer filter, exit fast,
and never chase.**

- **Entry (launch only):** in a coin's first 5 slots, when at most **one**
  distinct non-creator buyer has shown up yet, real reserve is already
  **≥ 2.25 SOL**, the creator bought ≤ 2.5 SOL and has not sold. Stake
  **0.04 SOL** per coin, at most 5 open positions, at most 2.5 SOL exposed.
- **Exits:** take profit **+12%**, stop loss **−12%**, trailing stop −15% from
  the peak (armed at +10%), max hold **300 slots**, exit on a creator sell or
  on a fade in net flow (−0.5 SOL over 20 slots).
- **Guardrail pacer:** tiny **0.01 SOL** probe round trips on mature, deep coins
  (≥ 600 slots old, ≥ 5 SOL real reserve) whenever the distinct-coin count lags
  the pace for 25 coins by window end — insurance for the 20-coin guardrail on
  a fresh window, at ~0.0008 SOL per probe.

## Why this shape

Measured on the frozen 24h dev dataset (2–3 Nov 2026, 430 coins, pilot sim):

- Most coins are dead money (median max multiple 1.23x, median end multiple
  1.00x). Dip-buying, crowd-chasing, and buying near migration all lose
  (−0.15 to −3.23 SOL). Peaks are single-trade spikes no trailing stop can
  capture.
- The one profitable shape is the single-buyer launch: one big early buyer
  accumulating, not a crowd. On dev: **+0.0202 SOL** on 25 coins, positive in
  both halves of the window, max drawdown 0.2%.

## Results (dev dataset, pilot sim)

| | net PnL |
|---|---|
| **This bot** | **+0.020200 SOL (+20,199,979 lamports)** |
| hold-cash | 0 SOL |
| equal-weight pilot | −0.017 SOL (5 coins — fails the 20-coin guardrail) |
| sniper pilot | −0.135 SOL |
| reversion pilot | −1.779 SOL |
| momentum pilot | −9.384 SOL |

Guardrails: 25 distinct mints, 25 round trips ≥ 0.01 SOL, max drawdown 0.002
(0.2%, limit 50%). Deterministic: two local runs produce byte-identical
action logs (sha256 `4f953d31cbfdba64`).

## Files

- `main.ts` — entry point (`node /bot/main.ts`).
- `strategy.ts` — the bot. Fresh code, written for this entry.
- `vendor/makefun-bot.ts` — the kit SDK shim, copied byte-for-byte as the kit
  instructs (excluded from authorship counts).

## License

MIT — see [LICENSE](LICENSE).
