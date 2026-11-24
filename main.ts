// Launch sniper: buy fresh launches that pass a rug filter, exit fast, never chase.
// Entry point: the grader runs `node /bot/main.ts` on Node 22 (types stripped, no build).

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
