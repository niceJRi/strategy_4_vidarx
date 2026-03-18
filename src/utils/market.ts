/**
 * Calculate the current 15-minute market slug based on current timestamp
 * Markets update every 15 minutes, so we round down to the nearest 15-minute interval
 * Example: 10:00 AM, 10:15 AM, 10:30 AM, etc.
 */
export function get5MinuteMarketSlug(token: string): {slug: string, timestamp: number} {
  const now = Math.floor(Date.now() / 1000);
  const MARKET_INTERVAL = 5 * 60;

  const marketTimestamp = Math.floor(now / MARKET_INTERVAL) * MARKET_INTERVAL;
  return {slug: `${token}-updown-5m-${marketTimestamp}`, timestamp: marketTimestamp};
}

/**
 * Calculate the current 1-hour market slug based on current timestamp
 * Markets update every 60 minutes, so we round down to the nearest 60-minute interval
 * Example: 10:00 AM, 11:00 AM, 12:00 PM, etc.
 */
export function getOneHourMarketSlug(token: string): {slug: string, timestamp: number} {
  const now = Math.floor(Date.now() / 1000); // Current Unix timestamp
  const MARKET_INTERVAL = 60 * 60; // 60 minutes in seconds (3600)

  // Round down to nearest 60-minute interval
  // Example: if now = 1766414750 (10:05 AM), round down to 1766414700 (10:00 AM)
  const marketTimestamp = Math.floor(now / MARKET_INTERVAL) * MARKET_INTERVAL;
  
  const date = new Date(marketTimestamp * 1000);

  const month = date.toLocaleString('en-US', { timeZone: 'America/New_York', month: 'long' }).toLowerCase();
  const day = date.toLocaleString('en-US', { timeZone: 'America/New_York', day: 'numeric' });
  const hour = date.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: true }).split(' ')[0];
  const meridiem = date.toLocaleString('en-US', { timeZone: 'America/New_York' }).split(' ')[2].toLowerCase();

  return {slug: `${token}-up-or-down-${month}-${day}-${hour}${meridiem}-et`, timestamp: marketTimestamp};
}

/**
 * Calculate the market timestamp based on the slug
 * Example: 'bitcoin-up-or-down-january-12-1am-et' -> 1715616000
 */
export function getMarketTimestamp(slug: string): number {
  const date = new Date(slug.split('-')[3]);
  return Math.floor(date.getTime() / 1000);
}

export function getTimeRemaining(endTime: number): number {
  const now = Math.floor(Date.now() / 1000);
  return endTime - now;
}