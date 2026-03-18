import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ethers } from "ethers"; 
import { safeAbi } from "../abi/safeAbi.js";
import { PRIVATE_KEY, RPC_URL, SAFE_ADDRESS, USDC_ADDRESS, CONDITIONAL_TOKENS_FRAMEWORK_ADDRESS, USDCE_DIGITS, DATA_API_BASE } from '../constant.js';
import { encodeRedeem, encodeMerge, signAndExecuteSafeTransaction, encodeSplit } from '../utils/wallet.js';
import { OperationType, SafeTransaction } from '../types/wallet.js';
import { relayClient } from './relayer.js';
import { encodeFunctionData } from 'viem';

interface Transaction {
  to: string; // Target contract address
  data: string; // Encoded function call
  value: string; // POL to send (usually "0")
}

@Injectable()
export class WalletService implements OnModuleInit {
  private readonly logger = new Logger(WalletService.name);
  private provider: ethers.providers.JsonRpcProvider;
  private wallet: ethers.Wallet;
  private safe: ethers.Contract;
  private closedPositionIds: any;

  constructor() {
    this.provider = new ethers.providers.JsonRpcProvider(RPC_URL);
    this.wallet = new ethers.Wallet(PRIVATE_KEY, this.provider);
    this.safe = new ethers.Contract(SAFE_ADDRESS, safeAbi, this.wallet);
  }

  async onModuleInit() {
    this.logger.log('Wallet service initialized');
  }

  getHello(): string {
    return this.wallet.address;
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async redeemPositions() {
    if (!this.closedPositionIds) return;
    try {
      for (const conditionId of this.closedPositionIds) {
        await this.redeem(conditionId as string);
      }
    } catch (error) {
      this.logger.error(`Error checking positions: ${error}`);
    }
  }

  setClosedPositionIds(closedPositionIds: any) {
    this.closedPositionIds = closedPositionIds;
  }

  async redeem(conditionId: string) {
    try {
      this.logger.log(`Redeeming condition ${conditionId}`);
      const data = encodeRedeem(USDC_ADDRESS, conditionId);

      const safeTxn: SafeTransaction = {
        to: CONDITIONAL_TOKENS_FRAMEWORK_ADDRESS,
        operation: OperationType.Call,
        data: data,
        value: "0",
      }

      const txn = await signAndExecuteSafeTransaction(this.wallet, this.safe, safeTxn, { gasPrice: 500000000000n, gasLimit: 500000n});
      this.logger.log(`Redeem transaction sent: ${txn.hash}`);
      await txn.wait();
      return txn.hash;
    } catch (e) {
      this.logger.error(`Error redeeming condition ${conditionId}: ${e}`);
      return null;
    }
  }

  async merge(conditionId: string, amount: string) {
    try {
      this.logger.log(`Merging condition ${conditionId}`);
      const data = encodeMerge(USDC_ADDRESS, conditionId, ethers.utils.parseUnits(amount, 6));

      const safeTxn: SafeTransaction = {
      to: CONDITIONAL_TOKENS_FRAMEWORK_ADDRESS,
      operation: OperationType.Call,
      data: data,
      value: "0",
      }

      const txn = await signAndExecuteSafeTransaction(this.wallet, this.safe, safeTxn, { gasPrice: 400000000000n, gasLimit: 500000n});

      this.logger.log(`Merge transaction sent: ${txn.hash}`);

      await txn.wait();

      return txn.hash;
    } catch (e) {
      this.logger.error(`Error merging condition ${conditionId}: ${e}`);
      return null;
    }
  }

  async mergeByRelayer(conditionId: string, amount: string) {
    try {
      const mergeTx = {
        to: CONDITIONAL_TOKENS_FRAMEWORK_ADDRESS,
        data: encodeFunctionData({
          abi: [
            {
              name: "mergePositions",
              type: "function",
              inputs: [
                { name: "collateralToken", type: "address" },
                { name: "parentCollectionId", type: "bytes32" },
                { name: "conditionId", type: "bytes32" },
                { name: "indexSets", type: "uint256[]" },
                { name: "amount", type: "uint256" },
              ],
              outputs: [],
            },
          ],
          functionName: "mergePositions",
          args: [USDC_ADDRESS, ethers.constants.HashZero, conditionId, [1, 2], ethers.utils.parseUnits(amount, 6)],
        }),
        value: "0",
      };
      const response = await relayClient.execute([mergeTx], "Merge positions");
      this.logger.log(`Merge transaction sent: ${response.transactionHash}`);
      await response.wait();
      this.logger.log(`Merge transaction confirmed: ${response.transactionHash}`);
      return response.transactionHash;
    } catch (e) {
      this.logger.error(`Error merging condition ${conditionId} by relayer: ${e}`);
      return null;
    }
  }

  async split(conditionId: string, amount: string) {
    try {
      this.logger.log(`Splitting condition ${conditionId}`);
      const data = encodeSplit(USDC_ADDRESS, conditionId, ethers.utils.parseUnits(amount, USDCE_DIGITS));

      const safeTxn: SafeTransaction = {
        to: CONDITIONAL_TOKENS_FRAMEWORK_ADDRESS,
        operation: OperationType.Call,
        data: data,
        value: "0",
      }

      const txn = await signAndExecuteSafeTransaction(this.wallet, this.safe, safeTxn, { gasPrice: 2000000000000n, gasLimit: 500000n});

      await txn.wait();

      this.logger.log(`Split transaction sent: ${txn.hash}`);

      return txn.hash;
    } catch (e) {
      this.logger.error(`Error splitting condition ${conditionId}: ${e}`);
      return null;
    }
  }
}