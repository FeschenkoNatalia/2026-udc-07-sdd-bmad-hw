## Why

The repo ships loyalty tiers that are never applied to a price, and no coupon
engine at all. The originating ticket (`materials/feature-request.md`) is written
by business and is deliberately ambiguous: it does not say how a tier and a promo
code combine, what a discount is computed on, what happens with several codes,
where rounding lands, whether a threshold is checked before or after other
discounts, or whether a total may reach zero.

`docs/spec/pricing-discounts.md` closes 24 of those forks (D-1…D-24) with a
recorded reason for each, and pins 28 acceptance criteria with concrete kopeck
figures. This change carries that document into OpenSpec as a normative
capability plus an implementation plan, so the behaviour is reviewable and
traceable rather than re-decided in code.

## What Changes

- New pure function `priceOrder(order, catalogue, options?)` returning a
  `PriceBreakdown` (subtotal, tier discount, coupon discount, shipping,
  minimum-charge adjustment, total, applied and rejected coupons).
- Tier percentage is applied to goods only, per category, with half-up integer
  rounding — never to shipping.
- Coupons cascade after the tier, in the order the customer typed them; a
  category-scoped coupon reduces only that category's remainder.
- Coupons never throw. An ineligible coupon is reported in `rejectedCoupons`
  with a machine-readable reason, chosen by a fixed priority order.
- An order with a non-zero `subtotalKopecks` whose total reaches zero is charged
  `MINIMUM_CHARGE_KOPECKS = 1`, carried in its own breakdown field. The trigger is
  goods value, not the presence of lines: a cart of zero-priced lines stays at its
  shipping total.
- A line whose total is not a non-negative integer, whose category is outside the
  declared union, or which is not an object at all, contributes 0 to the discount
  base, so corrupt cart data cannot reduce a bill — and a category counts as
  present only where a line actually contributed to it.
- Every coupon field is validated as runtime data, the two union-typed ones
  (`kind`, `category`) included. All three externally-shaped inputs are hardened:
  a malformed catalogue entry is skipped by the lookup and a non-string coupon
  entry is `unknown_code`, rather than either raising.
- `MAX_MONEY_KOPECKS` bounds the goods base and the coupon money fields, not
  undiscounted shipping, so `totalKopecks` may exceed it by the shipping fee.
- A goods subtotal above `MAX_MONEY_KOPECKS` raises instead of being priced:
  capping lines would make the total depend on their order, and zeroing them
  would give the goods away for the price of shipping.
- An invalid `options.now` throws: a broken clock is a caller bug, and silently
  reviving every expired coupon is the worst possible failure mode.
- All money stays in integer kopecks; no floating-point arithmetic on amounts.

## Capabilities

### New Capabilities

- `pricing-discounts`: how loyalty tiers and coupons reduce an order's goods
  total — in what order, on what base, with what rounding, and how a coupon that
  does not apply is reported back to the caller.

### Modified Capabilities

No existing capability changes. `app/src/pricing.ts` and `app/src/types.ts` are
the seeded contract and keep their current behaviour and shapes.

## Impact

- **New:** `app/src/discounts.ts`, re-exported from `app/src/index.ts`.
- **New:** `app/src/discounts.test.ts`, with tests named after AC ids so the
  link to the specification is visible in the vitest output.
- **Unchanged:** `app/src/pricing.ts`, `app/src/types.ts` — signatures and
  shapes are protected; the engine consumes them.
- **Downstream:** checkout must skip the payment step only when the total is
  zero; every order with goods value now has a chargeable total of at least
  1 kopeck.
- **Docs:** `docs/traceability.md` (Task C) maps every AC to code and to a test.