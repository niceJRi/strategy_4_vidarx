import * as dotenv from 'dotenv';
import { Wallet } from "ethers";
import { ClobClient } from "@polymarket/clob-client";

dotenv.config();

// Backend configuration
export const BINDING_PORT = 5000;

export const CLOB_API_BASE = 'https://clob.polymarket.com';
export const DATA_API_BASE = 'https://data-api.polymarket.com';
export const GAMMA_API_BASE = 'https://gamma-api.polymarket.com';
export const WS_BASE = 'wss://ws-subscriptions-clob.polymarket.com';

export const SAFE_ADDRESS = "0xaf8d54ff6e3dfd108b66c5851a1c78597e85c396";
export const USDC_ADDRESS = "0x2791bca1f2de4661ed88a30c99a7a9449aa84174";
export const CONDITIONAL_TOKENS_FRAMEWORK_ADDRESS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";

export const USDCE_DIGITS = 6;

export const RPC_URL = process.env.RPC_URL || "https://polygon-mainnet.core.chainstack.com/750d5ee0efca11519fdc972b60003982";

export const PRICE_CHECK_INTERVAL = 200; // 200ms

export const PRIVATE_KEY = process.env.PRIVATE_KEY || "";
export const signer = new Wallet(PRIVATE_KEY);
export const clobClient = new ClobClient(CLOB_API_BASE, 137, signer);

export const POLY_BUILDER_API_KEY = process.env.RELAYER_API_KEY || "";
export const POLY_BUILDER_SECRET = process.env.RELAYER_SECRET || "";
export const POLY_BUILDER_PASSPHRASE = process.env.RELAYER_PASSPHRASE || "";

export const AVAILABLE_5M_MARKETS = ['btc'] // ['btc', 'eth', 'xrp', 'sol'];
export const AVAILABLE_1H_MARKETS = [] // ['bitcoin', 'ethereum', 'solana', 'xrp'];