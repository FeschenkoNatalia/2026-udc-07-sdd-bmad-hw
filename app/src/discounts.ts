// Discount engine. Implements docs/spec/pricing-discounts.md — the decision ids
// (D-N) in the comments point at the row that settled each rule.
//
// All amounts are whole kopecks. There is no floating-point arithmetic on money
// anywhere in this file: percentages are applied with an integer half-up formula.

import type { Coupon, LineItem, Order } from "./types.js";
import { lineTotalKopecks, shippingKopecks, tierPercent } from "./pricing.js";

/** Minimum payable amount for an order with goods value, i.e. `subtotal > 0` (D-21). */
export const MINIMUM_CHARGE_KOPECKS = 1;

/**
 * Shared upper bound for every money value — 10 млн грн (D-24). Chosen so that
 * every intermediate product stays exact: base * pct <= 1e9 * 100 = 1e11 < 2^53.
 */
export const MAX_MONEY_KOPECKS = 1_000_000_000;

export type CouponRejectionReason =
  | "unknown_code"
  | "duplicate_code"
  | "invalid_coupon"
  | "expired"
  | "min_subtotal_not_met"
  | "category_absent"
  | "no_remaining_amount";

export interface AppliedCoupon {
  /** Normalised code (D-11). */
  code: string;
  /** Always > 0 (D-18). */
  discountKopecks: number;
}

export interface RejectedCoupon {
  /** The code as typed, trimmed but not upper-cased (D-11). */
  code: string;
  reason: CouponRejectionReason;
}

export interface PriceBreakdown {
  subtotalKopecks: number;
  tierDiscountKopecks: number;
  couponDiscountKopecks: number;
  shippingKopecks: number;
  /** 0 or MINIMUM_CHARGE_KOPECKS — the top-up to the minimum (D-21). */
  minimumChargeAdjustmentKopecks: number;
  totalKopecks: number;
  /** In application order, which is the order the codes were typed. */
  appliedCoupons: AppliedCoupon[];
  /** In the order the codes were typed. */
  rejectedCoupons: RejectedCoupon[];
}

export interface PriceOptions {
  /** Instant the order is priced at; defaults to now. Tests pass it explicitly (D-12). */
  now?: Date;
}

type Category = LineItem["category"];
type Remainders = Record<Category, number>;

/**
 * Fixed category order (D-17). It decides how an order-wide fixed coupon is
 * consumed, so it must never depend on the shape of the cart.
 */
const CATEGORIES: readonly Category[] = ["standard", "fresh", "digital"];

/** Half-up rounding, exactly, in integers (D-4). Requires base >= 0 and integer percent 0..100. */
function roundHalfUp(base: number, percent: number): number {
  return Math.floor((base * percent + 50) / 100);
}

/** Codes are marketing identifiers, not secrets: trim and case-fold both sides (D-11). */
function normalizeCode(code: string): string {
  return code.trim().toUpperCase();
}

/** A money field is valid only inside the shared bound (D-16, D-24). */
function isMoney(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= MAX_MONEY_KOPECKS;
}

/**
 * `expiresAt` must carry an explicit offset (D-12). Without one, `Date.parse`
 * reads the string in the *host* zone, so the same coupon would expire in Kyiv
 * and still be live in UTC. A date without a time is rejected for the same
 * reason: "midnight where?" is exactly the question this rule closes.
 */
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/i;

/** Fail closed on coupon data: a bad value must never turn into a discount (D-16, D-12). */
function isUsable(coupon: Coupon): boolean {
  const valueOk =
    coupon.kind === "percent"
      ? Number.isInteger(coupon.value) && coupon.value >= 0 && coupon.value <= 100
      : isMoney(coupon.value);
  // The threshold is customer money too: at runtime the type guarantees nothing,
  // and `subtotal < NaN` is false, which would make the threshold vanish (D-16).
  const thresholdOk =
    coupon.minSubtotalKopecks === undefined || isMoney(coupon.minSubtotalKopecks);
  const dateOk =
    ISO_WITH_OFFSET.test(coupon.expiresAt) && !Number.isNaN(Date.parse(coupon.expiresAt));
  return valueOk && thresholdOk && dateOk;
}

function noRemainders(): Remainders {
  return { standard: 0, fresh: 0, digital: 0 };
}

/**
 * Prices an order: loyalty tier first, then every eligible coupon, cascading, in
 * the order the customer typed them. Pure — no I/O, no clock outside
 * `options.now`, and neither `order` nor `catalogue` is mutated. Coupon data never
 * throws — an unusable coupon comes back in `rejectedCoupons` — and neither does a
 * single malformed order line, which simply contributes 0 (D-22). Exactly two
 * inputs throw instead of pricing: an invalid `options.now`, which is a caller bug
 * rather than customer data (D-23), and a goods subtotal above
 * `MAX_MONEY_KOPECKS`, which cannot be priced exactly (D-24).
 */
export function priceOrder(
  order: Order,
  catalogue: Coupon[],
  options: PriceOptions = {},
): PriceBreakdown {
  const now = options.now ?? new Date();
  // A broken clock must fail loudly: every NaN comparison is false, so an invalid
  // `now` would silently bring every expired coupon back to life (D-23).
  if (Number.isNaN(now.getTime())) {
    throw new RangeError("priceOrder: options.now is an Invalid Date");
  }

  // Step 0 — base. A malformed line contributes nothing (D-22): not an integer,
  // negative, or carrying a category outside the declared union — the type
  // guarantees neither at runtime, and an unknown key would leave `subtotal` and
  // the category remainders disagreeing.
  const remaining = noRemainders();
  for (const line of order.items) {
    const lineTotal = lineTotalKopecks(line);
    if (Number.isInteger(lineTotal) && lineTotal >= 0 && CATEGORIES.includes(line.category)) {
      remaining[line.category] += lineTotal;
    }
  }
  const subtotal = CATEGORIES.reduce((sum, category) => sum + remaining[category], 0);

  // An order too large to price exactly fails closed (D-24). Capping line by line
  // was rejected twice over: it makes the total depend on the order of
  // `order.items`, and zeroing the offending line hands the goods over for the
  // price of shipping. A sum is order-independent, and throwing is the only
  // outcome here that does not give money away.
  if (subtotal > MAX_MONEY_KOPECKS) {
    throw new RangeError(
      `priceOrder: goods subtotal ${subtotal} exceeds MAX_MONEY_KOPECKS (${MAX_MONEY_KOPECKS})`,
    );
  }

  // Step 1 — loyalty tier, on goods only, rounded once per category (D-2, D-4, D-14).
  const percent = tierPercent(order);
  let tierDiscount = 0;
  for (const category of CATEGORIES) {
    const part = roundHalfUp(remaining[category], percent);
    remaining[category] -= part;
    tierDiscount += part;
  }

  // Steps 2-3 — coupons, in the order they were typed (D-3).
  const appliedCoupons: AppliedCoupon[] = [];
  const rejectedCoupons: RejectedCoupon[] = [];
  const seen = new Set<string>();
  const categoriesPresent = new Set<Category>(order.items.map((line) => line.category));

  for (const typed of order.coupons) {
    const code = normalizeCode(typed);
    const reject = (reason: CouponRejectionReason): void => {
      rejectedCoupons.push({ code: typed.trim(), reason });
    };

    // Eligibility, in the fixed precedence order of D-20.
    const coupon = catalogue.find((candidate) => normalizeCode(candidate.code) === code);
    if (coupon === undefined) {
      reject("unknown_code");
      continue;
    }
    if (seen.has(code)) {
      reject("duplicate_code");
      continue;
    }
    seen.add(code);
    if (!isUsable(coupon)) {
      reject("invalid_coupon");
      continue;
    }
    if (now.getTime() >= Date.parse(coupon.expiresAt)) {
      reject("expired");
      continue;
    }
    // The threshold is the customer's spend, measured before any discount (D-6).
    if (coupon.minSubtotalKopecks !== undefined && subtotal < coupon.minSubtotalKopecks) {
      reject("min_subtotal_not_met");
      continue;
    }
    if (coupon.category !== undefined && !categoriesPresent.has(coupon.category)) {
      reject("category_absent");
      continue;
    }

    // A category coupon reduces that category only (D-5); an order-wide fixed
    // coupon consumes remainders in declared order and drops its surplus (D-13, D-17).
    const scope: readonly Category[] = coupon.category ? [coupon.category] : CATEGORIES;
    const share = noRemainders();
    if (coupon.kind === "percent") {
      for (const category of scope) {
        share[category] = roundHalfUp(remaining[category], coupon.value);
      }
    } else {
      let left = coupon.value;
      for (const category of scope) {
        const taken = Math.min(left, remaining[category]);
        share[category] = taken;
        left -= taken;
      }
    }

    const amount = CATEGORIES.reduce((sum, category) => sum + share[category], 0);
    if (amount === 0) {
      reject("no_remaining_amount");
      continue;
    }
    for (const category of CATEGORIES) {
      remaining[category] -= share[category];
    }
    appliedCoupons.push({ code, discountKopecks: amount });
  }

  const couponDiscount = appliedCoupons.reduce((sum, entry) => sum + entry.discountKopecks, 0);

  // Step 4 — shipping is never discounted (D-2).
  const shipping = shippingKopecks(order);
  let total = CATEGORIES.reduce((sum, category) => sum + remaining[category], 0) + shipping;

  // Step 5 — an order that holds items is never worth nothing (D-21). The top-up
  // is its own field, so the reported coupon discount stays truthful.
  let minimumChargeAdjustment = 0;
  if (subtotal > 0 && total === 0) {
    minimumChargeAdjustment = MINIMUM_CHARGE_KOPECKS;
    total = MINIMUM_CHARGE_KOPECKS;
  }

  return {
    subtotalKopecks: subtotal,
    tierDiscountKopecks: tierDiscount,
    couponDiscountKopecks: couponDiscount,
    shippingKopecks: shipping,
    minimumChargeAdjustmentKopecks: minimumChargeAdjustment,
    totalKopecks: total,
    appliedCoupons,
    rejectedCoupons,
  };
}
