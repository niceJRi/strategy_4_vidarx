import { ClobClient, Side, OrderType } from '@polymarket/clob-client';
import pkg from 'ethers';
const { Wallet } = pkg;
import { readFileSync } from 'fs';

const envContent = readFileSync('.env', 'utf8');
const env = {};
for (const line of envContent.split('\n')) {
  const m = line.match(/^([^=]+)=(.*)$/);
  if (m) env[m[1].trim()] = m[2].trim();
}

const PRIVATE_KEY = env.PRIVATE_KEY;
const PROXY_WALLET = '0xaf8d54ff6e3dfd108b66c5851a1c78597e85c396';
const CLOB_API = 'https://clob.polymarket.com';
const wallet = new Wallet(PRIVATE_KEY);

// Get current BTC market
const now = Math.floor(Date.now() / 1000);
const floor = Math.floor(now / 300) * 300;
const slug = `btc-updown-5m-${floor}`;
const resp = await fetch(`https://gamma-api.polymarket.com/markets?slug=${slug}`);
const markets = await resp.json();
const market = Array.isArray(markets) ? markets[0] : markets;
const tokenIds = JSON.parse(market.clobTokenIds);
const tokenId = tokenIds[0];  // "Up" token
console.log('Token ID:', tokenId);

const eoaClient = new ClobClient(CLOB_API, 137, wallet);
const creds = await eoaClient.deriveApiKey();
const proxyClient = new ClobClient(CLOB_API, 137, wallet, creds, 1, PROXY_WALLET);

// Try to create and post a small POLY_PROXY order
console.log('\n--- Testing POLY_PROXY order ---');
try {
  const order = await proxyClient.createOrder({
    tokenID: tokenId,
    price: 0.1,  // very low, won't fill
    side: Side.BUY,
    size: 3,
  });
  console.log('Order created:');
  console.log('  maker:', order.maker);
  console.log('  signer:', order.signer);
  console.log('  signatureType:', order.signatureType);
  console.log('  signature:', order.signature.substring(0, 20) + '...');

  const result = await proxyClient.postOrder(order, OrderType.GTC);
  console.log('SUCCESS! Result:', JSON.stringify(result));
} catch(e) {
  console.log('Error creating/posting:', e.message);
  // Try to get the raw axios error
  const cause = e.cause || e;
  if (cause?.response) {
    console.log('HTTP status:', cause.response.status);
    console.log('HTTP data:', JSON.stringify(cause.response.data));
  }
}

// Also test EOA order for comparison
console.log('\n--- Testing EOA (sig_type=0) order ---');
const eoaClientL2 = new ClobClient(CLOB_API, 137, wallet, creds);
try {
  const order = await eoaClientL2.createOrder({
    tokenID: tokenId,
    price: 0.1,
    side: Side.BUY,
    size: 3,
  });
  console.log('EOA order created:');
  console.log('  maker:', order.maker);
  console.log('  signer:', order.signer);
  console.log('  signatureType:', order.signatureType);

  const result = await eoaClientL2.postOrder(order, OrderType.GTC);
  console.log('EOA Result:', JSON.stringify(result));
} catch(e) {
  console.log('EOA Error:', e.message);
  const cause = e.cause || e;
  if (cause?.response) {
    console.log('HTTP status:', cause.response.status);
    console.log('HTTP data:', JSON.stringify(cause.response.data));
  }
}

