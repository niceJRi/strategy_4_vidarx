/**
 * PriceContext is a map of token id to prices
 * Example: { '0x1234567890123456789012345678901234567890': 54 }
 */
export const PriceContext = new Map<string, { bestAsk: number, bestBid: number }>();

export const PrevPriceContext = new Map<string, { bestAsk: number, bestBid: number }>();
export const PriceTimeContext = new Map<string, number>();
export const MatchedPriceTimeContext = new Map<string, number>();

/**
 * TokenIdContext is a map of market slug to token id pair
 * Example: {
 *            'bitcoin-up-or-down-january-1-12pm-et': { 
 *              up: '0x1234567890123456789012345678901234567890', 
 *              down: '0x1234567890123456789012345678901234567890' 
 *            }
 *          }
 */
export const TokenIdContext = new Map<string, { up: string, down: string }>();

/**
 * ConditionIdContext is a map of market slug to condition id
 * Example: {
 *            'bitcoin-up-or-down-january-1-12pm-et': '0x1234567890123456789012345678901234567890'
 *          }
 */
export const ConditionIdContext = new Map<string, string>();

/**
 * EndDateContext is a map of market slug to end date
 * Example: {
 *            'bitcoin-up-or-down-january-1-12pm-et': 1715616000
 *          }
 */
export const EndDateContext = new Map<string, number>();

export const SplittedContext = new Map<string, number>();

/**
 * Get list of Market Slug from TokenIdContext
 */
export function getMarketSlugList(): string[] {
  return Array.from(TokenIdContext.keys());
}

/**
 * Get list of All 15 Minute Token Id from TokenIdContext
 */
export function getAll5MinuteTokenIdList(): string[] {
  const slugList = getMarketSlugList().filter(slug => slug.includes('updown-5m'));
  return [...slugList.map(slug => TokenIdContext.get(slug)?.up), ...slugList.map(slug => TokenIdContext.get(slug)?.down)];
}

/**
 * Get list of All 1 Hour Token Id from TokenIdContext
 */
export function getAll1HourTokenIdList(): string[] {
  const slugList = getMarketSlugList().filter(slug => slug.includes('up-or-down'));
  return [...slugList.map(slug => TokenIdContext.get(slug)?.up), ...slugList.map(slug => TokenIdContext.get(slug)?.down)];
}

/**
 * Get slug by token id
 */
export function getSlugByTokenId(tokenId: string): string {
  return getMarketSlugList().find(slug => TokenIdContext.get(slug)?.up === tokenId || TokenIdContext.get(slug)?.down === tokenId);
}

export function getSplittedConditionIdList(): string[] {
  return Array.from(SplittedContext.keys());
}