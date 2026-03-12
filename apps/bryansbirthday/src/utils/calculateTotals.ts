export interface Guest {
  name: string;
  paid: boolean;
  total: number;
  shared: boolean;
  items: string[];
}

export interface Receipt {
  pretax: number;
  tax: number;
  tip: number;
  guests: number;
  foodShared: {
    total: number;
    items: string[];
  };
  participates: Guest[];
}

export interface GuestBreakdown {
  name: string;
  items: string[];
  subtotal: number;
  sharedTotal: number;
  taxShare: number;
  tipShare: number;
  totalOwed: number;
  amountPaid: boolean;
  remainingBalance: number;
  isBryanSplit: boolean;
}

export interface Totals {
  guests: GuestBreakdown[];
  bryansTotal: number;
  bryanCoveredBy: string[];
  bryanPerPersonShare: number;
  sharedFoodItems: string[];
  sharedFoodTotal: number;
  taxTotal: number;
  tipTotal: number;
  totalCollected: number;
  totalRemaining: number;
}

export function calculateTotals(receipt: Receipt): Totals {
  const bryan = receipt.participates.find((g) => g.name === "Bryan")!;
  const nonBryan = receipt.participates.filter((g) => g.name !== "Bryan");

  // Number of people sharing the shared food
  const sharedCount = receipt.participates.filter((g) => g.shared).length;

  // Per-person share of the shared food
  const sharedPerPerson = sharedCount > 0 ? receipt.foodShared.total / sharedCount : 0;

  // Tax and tip are split equally among everyone except Bryan
  const taxTipSplitCount = nonBryan.length;
  const taxPerPerson = receipt.tax / taxTipSplitCount;
  const tipPerPerson = receipt.tip / taxTipSplitCount;

  // People who opt-in to cover Bryan's meal (everyone who hasn't paid = they haven't opted out)
  // For now, everyone except Bryan covers his meal
  const bryanCoveredBy = nonBryan.map((g) => g.name);
  const bryansTotal =
    bryan.total + (bryan.shared ? sharedPerPerson : 0);
  const bryanPerPersonShare =
    bryanCoveredBy.length > 0 ? bryansTotal / bryanCoveredBy.length : 0;

  const guests: GuestBreakdown[] = receipt.participates.map((guest) => {
    const isBryan = guest.name === "Bryan";

    const subtotal = guest.total;
    const sharedTotal = guest.shared ? sharedPerPerson : 0;
    const taxShare = isBryan ? 0 : taxPerPerson;
    const tipShare = isBryan ? 0 : tipPerPerson;
    const bryanSplitShare = isBryan ? 0 : bryanPerPersonShare;

    const totalOwed = isBryan
      ? 0
      : subtotal + sharedTotal + taxShare + tipShare + bryanSplitShare;

    const remainingBalance = guest.paid ? 0 : totalOwed;

    return {
      name: guest.name,
      items: guest.items,
      subtotal,
      sharedTotal: round(sharedTotal),
      taxShare: round(taxShare),
      tipShare: round(tipShare),
      totalOwed: round(totalOwed),
      amountPaid: guest.paid,
      remainingBalance: round(remainingBalance),
      isBryanSplit: !isBryan,
    };
  });

  const totalCollected = guests
    .filter((g) => g.amountPaid)
    .reduce((sum, g) => sum + g.totalOwed, 0);
  const totalRemaining = guests
    .filter((g) => !g.amountPaid)
    .reduce((sum, g) => sum + g.remainingBalance, 0);

  return {
    guests,
    bryansTotal: round(bryansTotal),
    bryanCoveredBy,
    bryanPerPersonShare: round(bryanPerPersonShare),
    sharedFoodItems: receipt.foodShared.items,
    sharedFoodTotal: receipt.foodShared.total,
    taxTotal: receipt.tax,
    tipTotal: receipt.tip,
    totalCollected: round(totalCollected),
    totalRemaining: round(totalRemaining),
  };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
