## Purpose

Defines how an order's payable total is reduced by loyalty tiers and coupons:
the base each discount applies to, the order they combine in, the rounding rule,
the floor on the total, and how a coupon that does not apply is reported. All
amounts are whole kopecks. Scenario names carry the `AC-N` ids from
`docs/spec/pricing-discounts.md` so the specification, the code and the tests
share one vocabulary.

## ADDED Requirements

### Requirement: Tier discount base and rounding

The engine SHALL apply the loyalty percentage from `tierPercent(order)` to the
goods subtotal only, never to shipping, and SHALL apply it to every product
category without exclusion. The discount for each category MUST be rounded to
whole kopecks exactly once, half-up, as `floor((base * pct + 50) / 100)`; the
reported tier discount is the sum over categories. Rounding MUST NOT be
performed per line item.

#### Scenario: AC-1 — Gold tier reduces goods but not shipping

- **WHEN** a Gold customer orders one `standard` line of 100000 kopecks to UA
  with no coupons
- **THEN** the tier discount is 10000, the coupon discount is 0, shipping is
  4900, and the total is 94900

#### Scenario: AC-9 — half a kopeck rounds up, once per category

- **WHEN** a Gold customer orders `standard` 12345 and `fresh` 12345, so each
  category yields 12345 x 10% = 1234.5 kopecks
- **THEN** each category rounds half-up to 1235, the reported tier discount is
  2470, and the total is 27120 — not the 2469 that rounding the combined 24690
  subtotal would produce

### Requirement: Sequential stacking of tier and coupons

The engine SHALL apply discounts sequentially: the tier first, then coupons, each
computed on the amount remaining after the previous discount. Percentages MUST
NOT be summed before being applied.

#### Scenario: AC-2 — a coupon applies to the post-tier remainder

- **WHEN** a Gold customer orders 100000 kopecks of `standard` goods and enters
  `SAVE15` (percent 15, no category, no threshold)
- **THEN** the tier discount is 10000, the coupon discount is 13500 (15% of
  90000, not of 100000), and the total is 81400 — additive stacking would have
  produced 79900

### Requirement: Multiple coupons apply in the order typed

The engine SHALL apply every eligible coupon, cascading, in the order the codes
appear in `order.coupons`. Two coupons scoped to the same category MUST both
apply, each to that category's remaining amount. A fixed-amount coupon without a
category MUST consume category remainders in the declared order `standard`,
`fresh`, `digital`, clamped to each remainder, and any unused value MUST be
discarded rather than carried anywhere.

#### Scenario: AC-3 — two coupons on the same category both apply

- **WHEN** an order of `standard` 40000 and `fresh` 60000 carries `FRESH10`
  (percent 10, fresh) followed by `FRESH20` (percent 20, fresh)
- **THEN** both apply to the fresh remainder — 6000, then 10800 of the remaining
  54000 — giving a coupon discount of 16800 and a total of 88100, where summing
  the percentages would have given 18000

#### Scenario: AC-16 — the typed order changes the outcome

- **WHEN** an order of `standard` 5000 and `fresh` 20000 carries `SAVE200`
  (fixed 20000, no category) and `FRESH50` (percent 50, fresh)
- **THEN** entering `SAVE200` first yields a coupon discount of 22500 and a total
  of 7400, while entering `FRESH50` first yields 25000 and a total of 4900

### Requirement: Category-scoped coupons

A coupon carrying a `category` SHALL be computed on that category's remaining
amount only, never on the whole order. If the order contains no *contributing*
line of that category, the coupon MUST be rejected with reason `category_absent`
— a line neutralised as malformed does not make its category present, so the
reason describes the cart rather than the state of the engine.

#### Scenario: AC-8 — a category percentage uses the category base

- **WHEN** an order of `fresh` 20000 and `standard` 80000 carries `FRESH25`
  (percent 25, category fresh)
- **THEN** the coupon discount is 5000, not 25000, and the total is 99900

#### Scenario: AC-15 — a coupon for an absent category is reported as such

- **WHEN** an order containing only `standard` 100000 carries `DIGI10`
  (percent 10, category digital)
- **THEN** the coupon is rejected with reason `category_absent`, distinct from
  `no_remaining_amount`, and the total is 104900

### Requirement: Coupon eligibility is decided without throwing

The engine SHALL NOT throw on coupon data, nor on an individual malformed order
line. The guarantee covers the *elements* of the three externally-shaped
collections — `order.items`, `catalogue` and `order.coupons` — whatever their
runtime type. It does NOT cover the collections themselves: a non-array there is
a violation of the call contract, not customer data, and MUST fail loudly for the
same reason an invalid `now` does — pricing a structurally invalid call would
turn `items: undefined` into a silent empty cart that passes on down the
checkout. In full, four inputs MUST raise a `RangeError` instead of being priced:
an `order` or `options` that is not an object; a collection that is not an array;
an `options.now` that is not a valid `Date`, `null` included, since `null` means a
mistake rather than "not supplied"; and a goods subtotal above
`MAX_MONEY_KOPECKS`, which cannot be priced exactly. The first three are caller
errors rather than customer data — a non-object `options` reads `.now` as absent
and would otherwise fall back to the wall clock, deciding coupon expiry by when
the call happened. Omitting `options` entirely is legal. Nothing else raises. Every code entered MUST
appear exactly once in either `appliedCoupons` or `rejectedCoupons`, both ordered
as typed. A code absent from the catalogue MUST be reported as `unknown_code` on
every occurrence; `duplicate_code` applies only after the code has been found in
the catalogue, so a repeated *known* code is a duplicate regardless of whether
the earlier occurrence was applied or itself rejected. Codes are matched
case-insensitively after trimming surrounding whitespace. The catalogue arrives
from outside the engine, so a candidate that is not an object carrying a string
`code` MUST be skipped by the lookup rather than raising, and an entry of
`order.coupons` that is not a string MUST be reported as `unknown_code` under an
empty code — it can name nothing in the catalogue, and stringifying it would show
the customer a code they never typed. A coupon is invalid at
and after its `expiresAt` instant, compared against an injectable `now`;
`expiresAt` MUST be a string, and MUST be an ISO-8601 date-time carrying an
explicit offset (`Z` or `±HH:MM`); anything else — including a date without a
time — MUST be rejected as `invalid_coupon`, so the outcome cannot depend on the
host time zone. The string check MUST precede the pattern match rather than rely
on it: matching converts its argument with `ToString`, which throws on a symbol
instead of failing to match, and an unusable coupon must never abort a price. A percent coupon's `value` MUST be an integer from 0 to 100 inclusive; anything
outside that — a fraction, a negative, or a percentage above 100 — is
`invalid_coupon`, since a fractional percentage would reintroduce floating-point
money and a value above 100 would discount more than the goods are worth. Every
money-valued coupon field — a fixed `value` and a `minSubtotalKopecks` when
present — MUST be a non-negative integer no greater than `MAX_MONEY_KOPECKS`, or
the coupon is `invalid_coupon`. The two union-typed
fields are validated as data as well: `kind` MUST be exactly `percent` or
`fixed`, and a `category`, when present, MUST be one of `standard`, `fresh`,
`digital`; either outside its union is `invalid_coupon`, decided before
`category_absent` so a malformed coupon is never reported as a fact about the
cart. A
`minSubtotalKopecks` threshold MUST be tested inclusively against the original
goods subtotal, before any discount. When more
than one rejection reason applies, the first of this order MUST be reported:
`unknown_code`, `duplicate_code`, `invalid_coupon`, `expired`,
`min_subtotal_not_met`, `category_absent`, `no_remaining_amount`.

#### Scenario: AC-5 — an expired coupon is skipped, not fatal

- **WHEN** `AUTUMN10` expired on 2026-09-01T00:00:00.000Z and now is
  2026-09-06T10:00:00.000Z
- **THEN** no exception is raised, the coupon discount is 0, the total is 104900,
  and `rejectedCoupons` contains `AUTUMN10` with reason `expired`

#### Scenario: AC-6 — expiry excludes the instant itself

- **WHEN** `FLASH20` (percent 20) expires at 2026-10-01T00:00:00.000Z
- **THEN** at exactly that instant it is rejected as `expired` with a total of
  104900, and one millisecond earlier it applies for 20000 with a total of 84900

#### Scenario: AC-7 — the threshold is measured before other discounts

- **WHEN** a Gold customer orders 100000 and enters `MIN1000` (percent 10,
  `minSubtotalKopecks` 100000)
- **THEN** the threshold is met against the original 100000 inclusively, the
  coupon applies for 9000 on the post-tier remainder, and the total is 85900 —
  testing after the tier discount would have compared 90000 and refused

#### Scenario: AC-11 — an unknown code is reported as typed, not invented

- **WHEN** the customer enters `" nosuch "`, absent from the catalogue
- **THEN** it is rejected with reason `unknown_code` under the code `nosuch` —
  trimmed but NOT upper-cased, unlike an applied coupon — the total stays
  104900, and any other codes entered are still processed

#### Scenario: AC-12 — a repeated code counts once

- **WHEN** the customer enters `SAVE10` (percent 10) twice on an order of 100000
- **THEN** the coupon discount is 10000, the total is 94900, and the second
  occurrence is rejected with reason `duplicate_code`

#### Scenario: AC-13 — codes match case-insensitively after trimming

- **WHEN** the catalogue holds `SAVE10` and the customer types `" save10 "`
- **THEN** the coupon applies for 10000 with a total of 94900 and is reported
  under the normalised code `SAVE10`; entering `save10` and `SAVE10` together
  makes the second occurrence a `duplicate_code`

#### Scenario: AC-14 — malformed coupon data is refused, never applied

- **WHEN** the catalogue holds a percent of 120, a percent of 12.5, a fixed value
  of -5000, and an unparseable `expiresAt`, and all four are entered
- **THEN** none applies, no exception is raised, the total stays 104900, and all
  four are rejected with reason `invalid_coupon`

#### Scenario: AC-24 — an `expiresAt` without an offset is refused

- **WHEN** `TZLOCAL` carries `expiresAt` of `2026-09-06T12:00:00` and `DATEONLY`
  carries `2026-10-01`, and both are entered
- **THEN** both are rejected with reason `invalid_coupon`, the total stays
  104900, and the outcome does not depend on the host time zone — without the
  rule the same string is 12:00 in UTC and 09:00 in Kyiv, so the coupon would
  apply on one server and expire on another

#### Scenario: AC-25 — a malformed threshold cannot silently vanish

- **WHEN** an order of 100000 enters `MINNAN` (`minSubtotalKopecks` NaN), `MINNEG`
  (-1) and `MINFRAC` (12.5), all percent 10
- **THEN** none applies, the coupon discount is 0, the total stays 104900, and all
  three are rejected with reason `invalid_coupon` — an unchecked NaN threshold
  compares false and would let a "spend 1000 UAH" code apply to a 10 UAH basket

#### Scenario: AC-27 — a coupon outside its own unions is malformed, not applied

- **WHEN** an order of 100000 enters `KINDBAD` (`kind` `percentt`, value 50000)
  and `CATBAD` (percent 10, `category` `STANDARD`)
- **THEN** neither applies, the coupon discount is 0, the total stays 104900, and
  both are rejected with reason `invalid_coupon` — an unchecked `kind` falls
  through to the fixed branch and pays out 50000 kopecks, and an unchecked
  `category` reports `category_absent`, blaming the cart for a broken coupon

#### Scenario: AC-23 — a broken call fails loudly

- **WHEN** `priceOrder` is called with `options.now` set to an Invalid Date on an
  order carrying the expired coupon `AUTUMN10`
- **THEN** the call raises a `RangeError` instead of returning a breakdown, so the
  expired coupon cannot come back to life through comparisons against `NaN`
- **WHEN** `options.now` is `null`, or any value that is not a `Date`
- **THEN** the call raises rather than falling back to the wall clock, which would
  make the same order price differently depending on when it was asked
- **WHEN** `order` or `options` is not an object, or `order.items`,
  `order.coupons` or `catalogue` is not an array — `items: "x"` included, which is
  iterable and would otherwise be walked character by character and priced as an
  empty, free cart
- **THEN** the call raises a `RangeError`; omitting `options` entirely stays legal
  and keeps the default

#### Scenario: AC-22 — the first catalogue entry wins on a duplicated code

- **WHEN** the catalogue holds `SAVE10` (percent 10) and, later in the array,
  `save10` (percent 50), and the customer enters `SAVE10`
- **THEN** the first entry wins: the coupon discount is 10000 and the total is
  94900

#### Scenario: AC-19 — the first matching rejection reason wins

- **WHEN** a coupon is both expired and short of its `minSubtotalKopecks`
- **THEN** the reported reason is `expired`; when an unknown code is entered
  twice, both occurrences report `unknown_code` rather than the second reporting
  `duplicate_code`; and when an expired code is entered twice, the first reports
  `expired` and the second `duplicate_code`

### Requirement: Floor on the payable total

Discounts SHALL NOT drive any category remainder below zero, and surplus coupon
value MUST be discarded rather than carried to another category or order.
Shipping MUST NOT be discounted. When `subtotalKopecks` is greater than zero and
the total would otherwise be exactly zero, the engine MUST charge
`MINIMUM_CHARGE_KOPECKS` (1) and report it in `minimumChargeAdjustmentKopecks`
without altering the reported coupon discount. The condition is
`subtotalKopecks > 0`, not "the order holds items": an order whose only line
prices at zero has no goods value and MUST remain at a total of its shipping. An
order with no items MUST remain at a total of zero.

#### Scenario: AC-4 — a coupon larger than the order is clamped

- **WHEN** an order of 30000 kopecks carries `FIX500` (fixed 50000)
- **THEN** the coupon discount is 30000, the goods remainder is 0, the total is
  4900 — exactly the shipping — and the surplus 20000 is discarded

#### Scenario: AC-17 — a full discount still leaves shipping payable

- **WHEN** a Gold customer orders `standard` 100000 to PL and enters `FULL100`
  (percent 100)
- **THEN** goods are reduced to zero by 10000 + 90000, shipping remains 19900,
  and the total is 19900

#### Scenario: AC-18 — a zeroed digital order is charged one kopeck

- **WHEN** an order of `digital` items worth 100000 carries `FULL100`
  (percent 100), so shipping is 0
- **THEN** the coupon discount is still reported as 100000,
  `minimumChargeAdjustmentKopecks` is 1, and the total is 1

#### Scenario: AC-10 — an empty order stays at zero

- **WHEN** the order has no items and `SAVE10` is entered
- **THEN** no exception is raised, every amount including
  `minimumChargeAdjustmentKopecks` is 0, the total is 0, and `SAVE10` is rejected
  with reason `no_remaining_amount`

### Requirement: Malformed order lines are neutralised

The engine SHALL NOT reject an order line by line. A line that is not an object,
a line whose `unitPriceKopecks` or `quantity` is not a non-negative integer —
checked on each factor, not only on their product, since `50.5 * 2` and
`-100 * -1` both come out as clean non-negative integers while half a kopeck is
not money and a negatively-priced, negatively-counted line is not goods — a line whose `lineTotalKopecks` is not a non-negative
integer, or one whose `category` falls
outside the declared union, MUST contribute 0 to the discount base, so that no category remainder can start below zero and the reported
subtotal always equals the sum of the category remainders. The shape check MUST
precede reading the line, since `lineTotalKopecks` raises on a non-object and
multiplies the two amount fields — a symbol or bigint raises there rather than
yielding the `NaN` the integer check would absorb — and it
MUST also be applied before the shipping fee is computed, since
`shippingKopecks` walks the same array to test its all-digital waiver. Shipping
is therefore read from the shape-valid lines; lines carrying a bad amount or an
unknown category stay in that set, so a cart of digital goods plus one corrupt
line is still charged shipping rather than silently waived. A
category counts as present, for the purpose of `category_absent`, only where at
least one line contributed to it: a cart whose only `fresh` line is corrupt holds
no fresh goods. The reported `subtotalKopecks` is therefore
the sum of the contributing lines, which equals `subtotalKopecks(order)` for any
well-formed order. The remaining order fields, `country` and `customerTier`, are
NOT validated here: they are consumed by the seeded `shippingKopecks` and
`tierPercent`, where any unexpected value falls to a declared default — anything
other than `"UA"` ships internationally, an unknown tier gives 0%. Neither
default gives money away, and both belong to `pricing.ts`, which this change does
not touch.

The goods subtotal MUST NOT exceed `MAX_MONEY_KOPECKS` (1000000000); an order
that does MUST raise a `RangeError` rather than be priced. The check is on the
sum, never line by line: capping lines would make the priced total depend on the
order of `order.items`, and zeroing an oversized line would hand the goods over
for the price of shipping. Checking after accumulation is safe, though not
because addition preserves the exact value — it does not: `MAX_SAFE_INTEGER +
(MAX_SAFE_INTEGER - 1)` yields `18014398509481980` for an exact
`18014398509481981`, rounding *down* by one. It is safe because of scale and
monotonicity: precision is only lost beyond `2^53`, six orders of magnitude above
the bound, where one ulp is 2 kopecks, so a sum understated by a few kopecks at
that size is still vastly above the bound; and accumulating non-negative
contributions can never decrease the running total (`fl(s + x) >= s` for
`x >= 0`), so a sum that has passed the bound cannot fall back under it. The
bound is chosen so every intermediate product stays exact:
`base * pct <= 1e9 * 100 = 1e11 < 2^53`. It covers the goods base
and the money-valued coupon fields, not `shippingKopecks`, which is seeded
behaviour left untouched; `totalKopecks` may therefore reach
`MAX_MONEY_KOPECKS` plus shipping.

#### Scenario: AC-21 — a corrupt line contributes nothing

- **WHEN** an order holds a `standard` line of 100000 and a `fresh` line with
  `quantity: -1` at 20000, so its line total is -20000
- **THEN** no exception is raised, the corrupt line contributes 0, the reported
  `subtotalKopecks` is 100000 rather than the 80000 that `subtotalKopecks(order)`
  would compute, and the total is 104900

#### Scenario: AC-26 — an unpriceable order fails closed, the boundary itself prices

- **WHEN** the goods subtotal exceeds the bound — one line at 2000000000, two
  lines of 600000000 in either order, or two lines that are each a safe integer
  whose sum is not (`MAX_SAFE_INTEGER` and `MAX_SAFE_INTEGER - 1`)
- **THEN** `priceOrder` raises a `RangeError` and returns no breakdown, the same
  way round, so the priced result never depends on the order of `order.items`
- **WHEN** a line prices at exactly `MAX_MONEY_KOPECKS`
- **THEN** the order prices normally: `subtotalKopecks` is 1000000000 and the
  total is 1000004900
- **WHEN** `FIXBOUND` (fixed exactly at the bound) and `FIXHUGE` (fixed
  2000000000) are entered
- **THEN** the first is eligible and the second is rejected with reason
  `invalid_coupon`, without raising
- **WHEN** a line carries a `category` outside the declared union
- **THEN** it contributes 0 and no exception is raised: `subtotalKopecks` is
  100000 and the total is 104900

#### Scenario: AC-28 — a malformed line or catalogue entry is skipped, not fatal

- **WHEN** `order.items` holds `null` beside a `standard` line of 100000 and
  `SAVE10` is entered, in either position
- **THEN** no exception is raised, `subtotalKopecks` is 100000, the coupon
  discount is 10000, shipping is 4900 and the total is 94900
- **WHEN** the cart is a `digital` line of 100000 plus `null`
- **THEN** shipping is 0 and the total is 100000; where the second line is
  instead a shape-valid line with a corrupt amount, shipping stays 4900 because
  the cart is not all-digital
- **WHEN** the only `fresh` line is corrupt (`quantity: -1`) and `FRESH10` is
  entered
- **THEN** the reason is `category_absent`, not `no_remaining_amount`: a line
  that contributed nothing does not make its category present
- **WHEN** the catalogue begins with `null` and an entry whose `code` is `null`,
  and `SAVE10` and `NOSUCH` are entered
- **THEN** both malformed entries are skipped by the lookup, `SAVE10` applies for
  10000, `NOSUCH` is `unknown_code`, and the total is 94900
- **WHEN** `order.coupons` is `[null, "SAVE10"]`
- **THEN** the first entry is `unknown_code` under an empty code, `SAVE10` still
  applies for 10000, the total is 94900, and every entry is still accounted for
  exactly once
- **WHEN** a coupon's `expiresAt` is a symbol, or a line's `unitPriceKopecks` or
  `quantity` is a symbol or bigint — values that raise on primitive conversion
  rather than converting badly
- **THEN** the coupon is `invalid_coupon` and the line contributes 0 while
  remaining in the cart for the shipping test, and no exception escapes

### Requirement: The breakdown reconciles exactly

Every returned breakdown MUST satisfy
`total = subtotal - tierDiscount - couponDiscount + shipping + minimumChargeAdjustment`,
and `couponDiscount` MUST equal the sum of `appliedCoupons[i].discountKopecks`.
`minimumChargeAdjustmentKopecks` MUST be 0 or 1, and 1 only where the total would
otherwise be exactly zero. `subtotalKopecks` MUST stay within
`[0, MAX_MONEY_KOPECKS]` on any input, which is what keeps every intermediate
product exact; `totalKopecks` adds undiscounted shipping on top of it.

#### Scenario: AC-20 — the arithmetic is auditable on any input

- **WHEN** the engine is called with each of a fixed, explicitly listed set of
  order shapes — and, separately, with every order any other scenario prices
- **THEN** the reconciliation identity holds exactly in integer kopecks, and
  every entered code appears exactly once across `appliedCoupons` and
  `rejectedCoupons`
- The set MUST NOT be accumulated from whatever other tests happened to run, so
  that checking this scenario alone covers exactly what a full run covers