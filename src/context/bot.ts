import { SignedOrder } from "@polymarket/order-utils";

// <marketSlug, {up: positionSizeUp, down: positionSizeDown}>
export const PositionSizeContext = new Map<string, {
  up: number,
  down: number
}>();

export const TotalDepositContext = new Map<string, number>();

export const St1ConfigContext = new Map<string, {
  baseSize: number,
  priceThreshold: number,
  limitPrice: number,
  firstLimitSum: number,
  maxCount: number
}>();

export const OrderIdContext = new Map<string, {
  id: string,
  outcome: boolean,
  price: number,
  size: number
}>();

export const RoundContext = new Map<string, {
  lastOutcome: boolean,
  lastPrice: number,
  count: number,
  done: boolean,
}>();

export type St2Round = {
  id: number,
  outcome: boolean, // true for up market buy, false for down market buy
  price: number,
  threshold: number, // price threshold for next round
  done: boolean // true for limit bought, false for limit not bought
}

export type St2Order = {
  id: string,
  round: number,
  outcome: boolean,
  price: number,
  size: number,
  matchedSize: number
}

export const St2RoundContext = new Map<string, St2Round[]>([]);

export const St2OrderIdContext = new Map<string, St2Order[]>([]);

export const StartContext = new Map<string, boolean>();

export const ActiveMarketContext = new Map<string, boolean>();

export const FibonacciArray = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233];

export type St3Order = {
  id: string,
  outcome: boolean,
  price: number,
  size?: number,
  matchedSize?: number
}

export const S3PreOrderContext = new Map<string, SignedOrder>();
export const S3AllPostOrderContext = new Map<string, St3Order[]>([]);
export const S3PositionSizeContext = new Map<string, {
  up: number,
  down: number
}>();
export const S3PositionValueContext = new Map<string, {
  up: number,
  down: number
}>();
export const S3GroupContext = new Map<string, St3Order>();