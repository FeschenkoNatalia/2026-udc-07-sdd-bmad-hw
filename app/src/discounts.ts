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
 * Upper bound for the goods base and for every coupon money field — 10 млн грн
 * (D-24). Chosen so that every intermediate product stays exact:
 * base * pct <= 1e9 * 100 = 1e11 < 2^53. Shipping is seeded behaviour that sits
 * outside the bound, so `totalKopecks` may reach MAX_MONEY_KOPECKS + shipping.
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
  // The union types are erased at runtime. A `kind` outside them would fall
  // through to the fixed branch and pay its `value` out in kopecks, and a
  // `category` outside them would be compared against a set that can never hold
  // it — `category_absent` for a coupon that is simply malformed (D-16).
  const kindOk = coupon.kind === "percent" || coupon.kind === "fixed";
  const categoryOk =
    coupon.category === undefined || CATEGORIES.includes(coupon.category);
  const valueOk =
    coupon.kind === "percent"
      ? Number.isInteger(coupon.value) && coupon.value >= 0 && coupon.value <= 100
      : isMoney(coupon.value);
  // The threshold is customer money too: at runtime the type guarantees nothing,
  // and `subtotal < NaN` is false, which would make the threshold vanish (D-16).
  const thresholdOk =
    coupon.minSubtotalKopecks === undefined || isMoney(coupon.minSubtotalKopecks);
  // The type check is not redundant with the regex: `RegExp.test` converts its
  // argument with `ToString`, and that *throws* on a symbol instead of returning
  // a non-matching string — so an unusable coupon would abort the whole price
  // rather than land in `rejectedCoupons` (D-8, D-12, D-16).
  const dateOk =
    typeof coupon.expiresAt === "string" &&
    ISO_WITH_OFFSET.test(coupon.expiresAt) &&
    !Number.isNaN(Date.parse(coupon.expiresAt));
  return kindOk && categoryOk && valueOk && thresholdOk && dateOk;
}

function noRemainders(): Remainders {
  return { standard: 0, fresh: 0, digital: 0 };
}

/**
 * Prices an order: loyalty tier first, then every eligible coupon, cascading, in
 * the order the customer typed them. Pure — no I/O, no clock outside
 * `options.now`, and neither `order` nor `catalogue` is mutated. Coupon data never
 * throws — an unusable coupon comes back in `rejectedCoupons`, a malformed
 * catalogue entry is skipped by the lookup, and a code that is not a string is
 * `unknown_code` — and neither does a single malformed order line, which simply
 * contributes 0 (D-22).
 *
 * That guarantee covers the *elements* of the three externally-shaped collections
 * — `order.items`, `catalogue`, `order.coupons` — whatever their runtime type. It
 * does not cover the call's own shape. Four things raise a `RangeError` instead
 * of pricing. Three are caller bugs rather than customer data (D-23): an `order`
 * or `options` that is not an object, a collection that is not an array, and an
 * `options.now` that is not a valid `Date` — `null` included, since it means a
 * mistake rather than "not supplied". The fourth is a goods subtotal above
 * `MAX_MONEY_KOPECKS`, which cannot be priced exactly (D-24). Omitting `options`
 * entirely is legal and keeps the default.
 */
export function priceOrder(
  order: Order,
  catalogue: Coupon[],
  options: PriceOptions = {},
): PriceBreakdown {
  // Step -1 — the call's own shape, which is the caller's contract rather than
  // customer data (D-23). Every violation here fails loudly, because the
  // alternatives all price something the caller did not describe: `for...of`
  // accepts *any* iterable, so `items: "x"` would walk its characters, skip each
  // as a non-object and return a total of 0 — a cart silently priced as empty and
  // free; and a non-object `options` would read `.now` as `undefined` and fall
  // back to the wall clock, deciding coupon expiry by when the call happened.
  if (order === null || typeof order !== "object") {
    throw new RangeError("priceOrder: order must be an object");
  }
  if (options === null || typeof options !== "object") {
    throw new RangeError("priceOrder: options must be an object");
  }
  for (const [name, value] of [
    ["order.items", order.items],
    ["order.coupons", order.coupons],
    ["catalogue", catalogue],
  ] as const) {
    if (!Array.isArray(value)) {
      throw new RangeError(`priceOrder: ${name} must be an array`);
    }
  }

  // `??` would treat `null` as "not supplied" and quietly fall back to the wall
  // clock, making the price non-deterministic; only `undefined` means absent.
  // A broken clock must fail loudly: every NaN comparison is false, so an invalid
  // `now` would silently bring every expired coupon back to life (D-23).
  const now = options.now === undefined ? new Date() : options.now;
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new RangeError("priceOrder: options.now is not a valid Date");
  }

  // Step 0 — base. A malformed line contributes nothing (D-22): not an object,
  // not an integer, negative, or carrying a category outside the declared union
  // — the type guarantees none of it at runtime, and an unknown key would leave
  // `subtotal` and the category remainders disagreeing. The shape check comes
  // first: `lineTotalKopecks(null)` throws, and D-22 promises it never does.
  // Only a contributing line marks its category present, so a category coupon
  // over a cart whose only `fresh` line is corrupt is `category_absent` — there
  // are no such goods — rather than `no_remaining_amount` (D-19, D-22).
  const remaining = noRemainders();
  const categoriesPresent = new Set<Category>();
  const wellFormedLines: LineItem[] = [];
  for (const line of order.items) {
    if (line === null || typeof line !== "object") continue;
    wellFormedLines.push(line);
    // Same coercion trap as `expiresAt`, in the seeded helper: `lineTotalKopecks`
    // multiplies the two fields, and a symbol or bigint throws on that
    // multiplication rather than yielding `NaN` for the check below (D-22).
    // Each factor must be a non-negative whole number in its own right, not just
    // their product: `50.5 * 2` and `-100 * -1` both come out as clean
    // non-negative integers, yet half a kopeck is not money and a cart line with
    // a negative price and a negative quantity is not goods (D-22).
    if (
      !Number.isInteger(line.unitPriceKopecks) ||
      line.unitPriceKopecks < 0 ||
      !Number.isInteger(line.quantity) ||
      line.quantity < 0
    ) {
      continue;
    }
    const lineTotal = lineTotalKopecks(line);
    if (Number.isInteger(lineTotal) && lineTotal >= 0 && CATEGORIES.includes(line.category)) {
      remaining[line.category] += lineTotal;
      categoriesPresent.add(line.category);
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

  for (const typed of order.coupons) {
    // The third externally-shaped input, after `order.items` and `catalogue`:
    // `string[]` is a type, not a runtime guarantee, and `normalizeCode` calls
    // `.trim()`. An entry that is not a string cannot name a catalogue coupon,
    // so it is `unknown_code` — the answer D-11 already gives an empty code —
    // and it is reported as "" rather than stringified, because putting `null`
    // into the response would show the customer a code they never typed (D-11).
    if (typeof typed !== "string") {
      rejectedCoupons.push({ code: "", reason: "unknown_code" });
      continue;
    }
    const code = normalizeCode(typed);
    const reject = (reason: CouponRejectionReason): void => {
      rejectedCoupons.push({ code: typed.trim(), reason });
    };

    // Eligibility, in the fixed precedence order of D-20. The catalogue arrives
    // from outside: an entry that is not an object with a string `code` is
    // skipped by the lookup rather than normalised, so one bad row cannot throw
    // its way out of a price (D-8, D-16).
    const coupon = catalogue.find(
      (candidate) =>
        candidate !== null &&
        typeof candidate === "object" &&
        typeof candidate.code === "string" &&
        normalizeCode(candidate.code) === code,
    );
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

  // Step 4 — shipping is never discounted (D-2). It is read from the shape-valid
  // lines rather than the raw array: `shippingKopecks` dereferences every entry
  // to test the all-digital waiver, so a `null` line would throw here — after
  // step 0 had already promised it would only contribute 0 (D-22). Lines with a
  // bad amount or an unknown category stay in: dropping them could waive
  // shipping on a cart that is not really all-digital, and D-2 leaves the
  // seeded shipping rule alone.
  const shipping = shippingKopecks(
    wellFormedLines.length === order.items.length ? order : { ...order, items: wellFormedLines },
  );
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
