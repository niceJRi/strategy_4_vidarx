import { config } from 'dotenv';
import { ClobClient } from '@polymarket/clob-client';
import { Wallet } from 'ethers';

config();

const CLOB_API_BASE = 'https://clob.polymarket.com';
const PROXY_WALLET  = '0xaf8d54ff6e3dfd108b66c5851a1c78597e85c396';

const signer = new Wallet(process.env.PRIVATE_KEY);
const creds  = {
  key:        process.env.RELAYER_API_KEY,
  secret:     process.env.RELAYER_SECRET,
  passphrase: process.env.RELAYER_PASSPHRASE,
};

console.log('Testing credentials:');
console.log('  key:       ', creds.key);
console.log('  passphrase:', creds.passphrase);
console.log('  signer:    ', signer.address);
console.log('  proxy:     ', PROXY_WALLET);
console.log('');

const client = new ClobClient(CLOB_API_BASE, 137, signer, creds, 1, PROXY_WALLET);

try {
  const orders = await client.getOpenOrders({ market: '' });
  console.log('✅ Auth OK — open orders count:', Array.isArray(orders) ? orders.length : JSON.stringify(orders));
} catch (err) {
  const status = err?.response?.status ?? err?.status ?? '';
  const msg    = err?.response?.data?.error ?? err?.message ?? err;
  console.error(`❌ Auth FAILED [${status}]: ${msg}`);
  process.exit(1);
}
