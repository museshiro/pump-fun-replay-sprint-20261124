// Entrypoint: Launch Sniper + Post-Crowd Retrace bot (redo v2).
// Runs under the grader as `node /bot/main.ts` (Node 22, no build step).
// The strategy is a pure function of the replayed batches: no clock,
// no environment, no randomness — the two runs the grader performs
// produce byte-identical action logs.
import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy } from './strategy.ts';

await runBot(createStrategy());
