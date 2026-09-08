## 1. Contract and skeleton

- [ ] 1.1 Create `app/src/discounts.ts` with `MINIMUM_CHARGE_KOPECKS`,
      `CouponRejectionReason`, `AppliedCoupon`, `RejectedCoupon`,
      `PriceBreakdown`, `PriceOptions` and the `priceOrder` signature, importing
      `Order`/`Coupon` from `./types.js` and the seeded helpers from
      `./pricing.js` (NodeNext `.js` extensions, named exports only).
- [ ] 1.2 Add the integer helper `roundHalfUp(base, pct)` as
      `Math.floor((base * pct + 50) / 100)`; no floating-point arithmetic on
      amounts anywhere in the file.
- [ ] 1.3 Re-export the public surface from `app/src/index.ts`.

## 2. Per-category remainders and tier discount

- [ ] 2.1 Build `R[standard] / R[fresh] / R[digital]` from `lineTotalKopecks`,
      always iterating categories in the order declared in `types.ts`; a line
      whose total is not a non-negative integer, or whose category is outside the
      declared union, contributes 0 (AC-21, AC-26).
- [ ] 2.2 Apply `tierPercent(order)` to each category remainder, rounding once
      per category; report the sum as `tierDiscountKopecks` (AC-1, AC-9).

## 3. Coupon eligibility

- [ ] 3.1 Normalise entered codes with `trim()` + `toUpperCase()` and resolve
      them against the catalogue, first match wins, skipping any candidate that
      is not an object with a string `code` (AC-13, AC-22, AC-28).
- [ ] 3.2 Implement the rejection checks in the fixed precedence order:
      `unknown_code`, `duplicate_code`, `invalid_coupon`, `expired`,
      `min_subtotal_not_met`, `category_absent` (AC-11, AC-12, AC-14, AC-19).
      The seventh reason, `no_remaining_amount`, is decided at application time
      in 4.3 — it is the tail of the same order, not a separate check here.
- [ ] 3.3 Compare expiry against `options.now` (default `new Date()`), treating
      the `expiresAt` instant itself as expired and an unparseable date as
      `invalid_coupon` (AC-5, AC-6). Raise a `RangeError` on an Invalid Date
      `now` before pricing anything, so a broken clock cannot silently revive
      every expired coupon through comparisons against `NaN` (AC-23).
- [ ] 3.4 Test `minSubtotalKopecks` inclusively against the pre-discount goods
      subtotal (AC-7).

## 4. Coupon application

- [ ] 4.1 Apply eligible coupons in typed order; percent coupons round per
      category in scope, fixed coupons consume remainders in declared order and
      discard any surplus (AC-3, AC-4, AC-16).
- [ ] 4.2 Scope category coupons to that category's remainder only (AC-8).
- [ ] 4.3 Reject a coupon that computes to zero as `no_remaining_amount` instead
      of recording a zero-value application (AC-10).

## 5. Total and minimum charge

- [ ] 5.1 Add undiscounted `shippingKopecks(order)` to the goods remainder
      (AC-17).
- [ ] 5.2 Apply the minimum charge when `subtotalKopecks > 0` and the total is
      0, reporting it in `minimumChargeAdjustmentKopecks` without altering
      `couponDiscountKopecks` (AC-18); leave an empty order at 0 (AC-10).

## 6. Tests named after acceptance criteria

- [ ] 6.1 Create `app/src/discounts.test.ts` with fixtures for orders, items and
      the coupon catalogue, and a fixed `now` of 2026-09-06T10:00:00.000Z.
- [ ] 6.2 Write one test per criterion, titled `AC-N: <short description>`, for
      AC-1 through AC-19 and AC-21 through AC-28.
- [ ] 6.3 Add AC-20 as a reconciliation check asserting
      `total = subtotal - tier - coupons + shipping + minimumChargeAdjustment`
      and `couponDiscount = sum(appliedCoupons)` across every fixture.
- [ ] 6.4 Confirm the 8 seeded tests in `pricing.test.ts` still pass and that
      `npm run typecheck` is clean.

## 7. Traceability

- [ ] 7.1 Fill `docs/traceability.md`: one row per AC mapping to file:symbol and
      to the test name, with no empty cells.
- [ ] 7.2 Run the reverse check — behaviour in code with no AC, AC with no test,
      test with no AC — and record what was found and what was done about it.

## 8. Review-driven hardening

Added after the spec was frozen, from the Task E spec reviewer and the PR review.

- [ ] 8.1 Require an explicit offset on `expiresAt` (`Z` or `±HH:MM`); reject a
      local or date-only string as `invalid_coupon` so the outcome cannot depend
      on the host time zone (AC-24).
- [ ] 8.2 Validate `minSubtotalKopecks` as `undefined` or a non-negative integer
      within `MAX_MONEY_KOPECKS`, so a NaN threshold cannot silently vanish
      (AC-25).
- [ ] 8.3 Introduce `MAX_MONEY_KOPECKS`, enforce it on every coupon money field,
      and raise a `RangeError` when the goods *subtotal* exceeds it — checked on
      the sum so the result cannot depend on line order, and closed rather than
      zeroed so the goods are never given away (AC-26).
- [ ] 8.4 Seed the AC-20 fixture list at module scope so the reconciliation test
      passes when run alone.
- [ ] 8.5 Validate the union-typed coupon fields as data: `kind` exactly
      `percent` or `fixed`, `category` — when present — one of the declared
      three, both `invalid_coupon` otherwise and both decided before
      `category_absent` (AC-27).
- [ ] 8.6 Make malformed shapes non-fatal across all three externally-shaped
      inputs: skip an order line that is not an object before calling
      `lineTotalKopecks`, skip a catalogue candidate that is not an object with a
      string `code`, report a non-string entry of `order.coupons` as
      `unknown_code` under an empty code, and mark a category present only where
      a line actually contributed, so a corrupt-only category reads
      `category_absent` (AC-28).
- [ ] 8.7 Scope `MAX_MONEY_KOPECKS` explicitly to the goods base and the coupon
      money fields, leaving undiscounted shipping outside it, so `totalKopecks`
      above the bound is documented rather than contradictory (AC-26).