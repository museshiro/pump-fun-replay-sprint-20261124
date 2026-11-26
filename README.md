# Launch Sniper + Post-Crowd Retrace — Pump.fun Paper Bot

[![Competition](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![Rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/museshiro/pump-fun-replay-sprint-20261124/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![Reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/museshiro/pump-fun-replay-sprint-20261124/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

Entry for the [Pump.fun Replay Sprint — Paper Bot, Real Ranking](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) bounty on [make.fun](https://make.fun/r/xrr5vp10).

## What it does

A paper-trading bot for the pump.fun replay harness. It does exactly two
things: **snipe fresh launches that pass a strict single-buyer filter, and
buy the first retracement of proven crowd runners — exit fast, never chase.**

- **Entry 1 — launch:** in a coin's first 5 slots, when at most **one**
  distinct non-creator buyer has shown up yet, real reserve is already
  **≥ 2 SOL**, the creator bought ≤ 2.5 SOL and has not sold. Stake
  **0.035 SOL** per coin (capped at 97% of the 1%-of-reserve order cap),
  at most 5 open positions.
- **Entry 2 — post-crowd retrace:** after a crowd signal (≥ 20 distinct
  buyers, ≥ 15 SOL of non-creator buys), buy the first **12–25%**
  retracement from the post-signal running max when the last-5-slot flow
  turns positive again, within 500 slots of the signal. Stake **0.06 SOL**
  per coin (same cap). One retrace buy per mint.
- **Exits (launch):** take profit **+8%**, stop loss **−12%**, trailing stop
  −4% from the peak (armed at +5%), max hold **300 slots**, exit on a
  creator sell or real reserve > 55 SOL.
- **Exits (retrace):** take profit **+10%**, stop loss **−15%**, trailing
  stop −3% from the peak (armed at +4%), max hold **30 slots**, same
  creator-sell / big-reserve exits.

## Why this shape

Measured on the frozen 24h dev dataset (2–3 Nov 2026, 430 coins, pilot sim):

- Most coins are dead money (median max multiple 1.23x, median end multiple
  1.00x). Dip-buying, crowd-chasing, and buying near migration all lose
  (−0.15 to −3.23 SOL). Peaks are single-trade spikes no trailing stop can
  capture.
- Buying the crowd signal itself buys the top of the spike (net −0.010 SOL,
  0/10 wins on dev) and a flow-fade exit fires on slot noise — both were
  tested and removed.
- The two shapes that work are the single-buyer launch and the retracement
  of a proven crowd runner: on dev, **+0.0574 SOL** on 40 coins, positive in
  both halves of the window, max drawdown 0.3%. The launch alone is worth
  +0.019 SOL; the retrace alone +0.003 SOL; together they are worth more
  than the sum — the retrace only fires on coins that already ran once.

## Results (dev dataset, grade-local, process driver)

| | net PnL |
|---|---|
| **This bot (v2)** | **+0.057387 SOL** |
| v1 (launch only) | +0.020200 SOL |
| hold-cash | 0 SOL |
| equal-weight pilot | −0.017 SOL (5 coins — fails the 20-coin guardrail) |
| sniper pilot | −0.135 SOL |
| reversion pilot | −1.779 SOL |
| momentum pilot | −9.384 SOL |

Guardrails: 40 distinct mints, 40 round trips ≥ 0.01 SOL, max drawdown 0.0032
(0.3%, limit 50%). Deterministic: the grader's two executions reproduce the
action log byte for byte. Honest caveat: the score is concentrated — 3 coins
make 53% of the gains, and rebuilt block copies of the dev window have median
−0.07 SOL (8 of 10 lose money). The final window is fresh data; this entry
wins only if its runners show up there too.

## Files

- `main.ts` — entry point (`node /bot/main.ts`).
- `strategy.ts` — the bot. Fresh code, written for this entry.
- `vendor/makefun-bot.ts` — the kit SDK shim, copied byte-for-byte as the kit
  instructs (excluded from authorship counts).

## License

MIT — see [LICENSE](LICENSE).
