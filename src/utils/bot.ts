export const getGroupKey = (conditionId: string, outcome: boolean, _price: number) => {
  const priceZone = Math.round(_price / 0.03);
  return `${conditionId}-${outcome ? 'up' : 'down'}-${priceZone}`;
}