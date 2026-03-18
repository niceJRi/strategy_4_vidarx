# Strategy 4 notes

## What I found from `@vidarx` data

I used the uploaded trade files (`02-12.csv` to `03-15.csv`) and position result files (`user_positions...csv`) as a behavioral reference.

### High-level observations

- The bot is **not balanced 50/50** most of the time.
- It usually spends **more on one side** and keeps a **smaller hedge** on the other side.
- Across the position-result data, the side that eventually won had a **higher average entry price** than the losing side in about **76%** of markets.
- Median spend split was roughly **65/35** between heavier side and lighter side.
- The historical result set was net-positive in about **56.6%** of markets, with positive average market PnL overall.

### Important caveat

Your formula for position-side traded amount is:

- win side: `totalTrade - pnl`
- lose side: `abs(pnl)`

I used that formula in the analysis. I **could not fully reproduce an exact one-to-one match** between every `user_positions` row and the raw daily trade CSV sums. Some markets matched closely, but many did not. That usually means at least one of these is happening:

- the trade exports are partial,
- the position export is aggregated differently,
- merged/redeemed behavior changed totals,
- or not every fill from the wallet is present in the raw trade files you exported.

So Strategy 4 is a **data-informed imitation** of the behavior pattern, not a claim that I perfectly reverse-engineered the original bot.

## Strategy 4 idea

Strategy 4 is a **leader + cheap hedge** strategy.

It waits until:

- the market is already inside a late trading window,
- one side is clearly leading by ask price,
- the two asks are not too expensive together,
- and the bot still has budget left for that market.

Then it:

1. Buys the **leader side** more aggressively.
2. Buys the **other side** only when it is still cheap enough.
3. Stops before the last few seconds.
4. Caps total USDC used per market.
5. Caps per-trade size and max number of trades per market.

This is meant to avoid one of the main bad patterns in the historical behavior: **over-hedging the wrong side late in the market**.

## Default constants used

These are the defaults wired into the new Strategy 4 config:

- `tradeWindowStartSec = 120`
- `hardStopSec = 12`
- `cooldownMs = 3000`
- `maxTradesPerMarket = 4`
- `maxMarketExposureUsdc = 60`
- `maxTradeUsdc = 20`
- `minTradeUsdc = 3`
- `maxBudgetFractionPerTrade = 0.35`
- `minPriceGap = 0.12`
- `strongPriceGap = 0.22`
- `maxCombinedAsk = 0.985`
- `hedgeOnlyBelowPrice = 0.34`
- `hedgeCombinedCap = 0.965`
- `minLeaderShare = 0.68`
- `maxLeaderShare = 0.86`
- `maxOneSideExposurePct = 0.78`
- `slippageBuffer = 0.02`

## How position sizing works

For each decision:

- the bot finds the side with the higher ask price,
- computes the gap between up and down ask,
- maps that gap into a target leader share,
- then allocates market budget roughly like:

`leader_usdc = trade_budget * leader_share`

`hedge_usdc = trade_budget - leader_usdc`

When the hedge side is too expensive, the bot moves closer to **one-sided leader buying**.

## How to tune it

### More aggressive

- raise `maxMarketExposureUsdc`
- raise `maxTradeUsdc`
- lower `minPriceGap`
- lower `hardStopSec`
- raise `maxLeaderShare`

### More conservative

- lower `maxMarketExposureUsdc`
- lower `maxTradeUsdc`
- raise `minPriceGap`
- lower `maxCombinedAsk`
- lower `hedgeCombinedCap`
- raise `hardStopSec`

### If you want more hedge

- lower `minLeaderShare`
- lower `maxLeaderShare`
- raise `hedgeOnlyBelowPrice`

### If you want less hedge

- raise `minLeaderShare`
- raise `maxLeaderShare`
- lower `hedgeOnlyBelowPrice`

## API config fields added

POST `/bot/config`

You can now send fields like:

```json
{
  "strategy": 4,
  "st4Enabled": true,
  "st4MaxMarketExposureUsdc": 80,
  "st4MaxTradeUsdc": 25,
  "st4MinTradeUsdc": 5,
  "st4MinPriceGap": 0.14,
  "st4MaxCombinedAsk": 0.97,
  "st4MinLeaderShare": 0.72,
  "st4MaxLeaderShare": 0.9
}
```

## Files added/changed

- `src/bot/st-4.ts`
- `src/bot/bot.service.ts`
- `src/bot/bot.gateway.ts`
- `STRATEGY4_NOTES.md`

## Practical note

This version is designed for your current **paper / fake order mode using real orderbook data**. That is the right place to test first. I would not treat these constants as production-safe for real funds until you validate them with several days of paper logs and compare them against your market-result CSVs.
