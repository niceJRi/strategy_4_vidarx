import { createWalletClient, http, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { RelayClient, RelayerTxType } from "@polymarket/builder-relayer-client";
import { BuilderConfig } from "@polymarket/builder-signing-sdk";
import { POLY_BUILDER_API_KEY, POLY_BUILDER_SECRET, POLY_BUILDER_PASSPHRASE, PRIVATE_KEY, RPC_URL } from "../constant.js";
import { Wallet } from "ethers";

const account = privateKeyToAccount(`0x${PRIVATE_KEY}`);
const wallet = createWalletClient({
  account,
  chain: polygon,
  transport: http(RPC_URL),
});

const builderConfig = new BuilderConfig({
  localBuilderCreds: {
    key: POLY_BUILDER_API_KEY!,
    secret: POLY_BUILDER_SECRET!,
    passphrase: POLY_BUILDER_PASSPHRASE!,
  },
});

export const relayClient = new RelayClient(
  "https://relayer-v2.polymarket.com/",
  137,
  wallet as unknown as Wallet,
  builderConfig,
  RelayerTxType.SAFE
);