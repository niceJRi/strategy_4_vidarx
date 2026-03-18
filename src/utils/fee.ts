const FEE_RATE = 0.25; // 25%
const EXPONENT = 2;

export function calculateFee(amount: number, price: number) {
  return amount * FEE_RATE * Math.pow((price * (1 - price)), EXPONENT) * 100;
}