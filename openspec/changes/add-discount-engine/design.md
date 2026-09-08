## Context

`app/` is a dependency-free TypeScript domain library. `pricing.ts` already
provides `lineTotalKopecks`, `subtotalKopecks`, `shippingKopecks` and
`tierPercent`, and `types.ts` fixes `Order`, `LineItem` and `Coupon`. Both are a
protected contract: the engine consumes them and changes neither.

Two constraints shape everything below. Money is stored as integer kopecks, and
floating-point arithmetic on amounts is forbidden — so every rounding rule has to
be expressible in integers. And `Coupon` can be scoped to a category, which means
the engine cannot track a single running total; it needs per-category remainders
that stay consistent with the order-level figures.

The behaviour itself is already decided in `docs/spec/pricing-discounts.md`
(D-1…D-24). This document records only how those decisions are realised.

## Goals / Non-Goals

**Goals:**

- One deterministic procedure: the same cart and codes always produce the same
  breakdown, independent of implementation order or cart line splitting.
- A breakdown that reconciles exactly, so finance can rebuild the total from its
  parts and support can explain any single kopeck.
- Total integer arithmetic, including the rounding rule.
- No exception path for coupon data: every code resolves to an applied discount
  or a machine-readable reason.

**Non-Goals:**

- A cap on the aggregate discount (deliberately out of scope; see Risks).
- Coupon redemption history, single-use codes, per-customer limits.
- Free-shipping coupons, tax, currencies other than UAH, refunds.
- Customer-facing wording — the engine returns reason codes only.

## Decisions

**Per-category remainders as the core state.** The engine keeps
`R[standard]`, `R[fresh]`, `R[digital]`, always iterated in that declared order,
and every discount decrements them. The order-level goods remainder is their sum
by construction, so the reported totals cannot drift from the category bases that
category coupons are computed against. The alternative — one running total plus
proportional allocation into categories — needs a second rounding step and a rule
for distributing the remainder, which is more machinery for a worse guarantee.

**Rounding once per (discount x category), half-up, in integers.**
`floor((base * pct + 50) / 100)` computes half-up exactly without touching a
float. Rounding per line was rejected: it accumulates drift and makes the total
depend on how the same goods are split into lines. Rounding on the order total
was rejected because category coupons need the per-category base anyway, and two
different granularities in one engine is how a kopeck goes missing. The visible
consequence is that the tier discount can differ by one kopeck from rounding the
whole subtotal at once — pinned by scenario AC-9 so it can never be "fixed" by
accident.

**One money bound, checked on the sum, enforced by throwing.** The goods base and
every money-valued coupon field — a line total, a fixed coupon `value`, a
`minSubtotalKopecks` — are bounded by `MAX_MONEY_KOPECKS` (1e9 kopecks, 10M UAH),
picked from the arithmetic rather than the business:
`base * pct <= 1e9 * 100 = 1e11 < 2^53`, so no intermediate product can lose
precision and the rounding rule above stays exact everywhere.

The bound deliberately stops there. `shippingKopecks` is seeded behaviour this
change does not touch, so `totalKopecks` can exceed the bound by the shipping fee
— scenario AC-26 prices 1000000000 goods at a total of 1000004900. Extending the
bound to the total would mean either trimming a legitimate cheque or raising on a
perfectly priceable order; the bound exists for the exactness of the products,
not to cap what a customer may spend.

Checking a line alone is not enough — two individually safe lines can sum past
the range — but the two obvious repairs are both worse than throwing. Capping
line by line makes the priced total depend on the order of `order.items`
(`[1e9, 1]` prices at 1e9, `[1, 1e9]` at 1), which contradicts the engine's own
promise that the same cart always costs the same. Zeroing the whole base is
order-independent but fails open: the customer walks away with the goods for the
price of shipping. A `RangeError` on the *sum* is the only outcome that is both
order-independent and closed on money. It narrows "never throws on order data"
exactly as far as the broken-clock rule already narrowed it — and no further: a
single malformed line still contributes 0 rather than being fatal.

**A fixed coupon consumes categories in declared order.** Its own amount is
unaffected by the order; only a later category-scoped coupon can observe the
difference. An arbitrary-but-fixed rule is predictable; a proportional split
would need another rounding decision.

**The minimum charge is a separate breakdown field, not a shrunken discount.**
When an order with goods value reaches zero, adding
`minimumChargeAdjustmentKopecks = 1` keeps `appliedCoupons` truthful about what
each code actually gave. Trimming the last coupon by a kopeck instead would make
the reported discount a lie, and would need a further rule for the case where
that coupon gave exactly one kopeck and would have to be re-classified as
rejected.

**Malformed order lines are neutralised, not rejected.** Coupon data is
validated strictly, so staying blind to order data would be an asymmetry: a
negative line total would start a category remainder below zero, leave
`roundHalfUp` (defined only for a non-negative base) undefined, and hand out free
money to a crafted cart. Clamping at the line rather than the category stops one
corrupt line from eating a sound neighbour.

The shape of the line is checked before the line is read: `lineTotalKopecks`
dereferences its argument, so a `null` entry would throw and break the very
promise this decision makes. And a line that contributed nothing does not make
its category present — otherwise a cart whose only `fresh` line is corrupt would
report a fresh coupon as `no_remaining_amount` ("that category is already
discounted") when the truth is `category_absent` ("there are no such goods"), and
the distinction those two reasons exist for would be lost.

**Time is an injected parameter, and a broken one is fatal.** `options.now`
defaults to `new Date()` but is always passed by tests; an Invalid Date throws,
because every comparison against `NaN` is false and the silent outcome would be
every expired coupon applying at once. Expiry is otherwise untestable, and a function that reads
the clock twice can price the same order two ways.

**Fail closed on coupon data.** A percentage outside 0-100, a non-integer value,
a negative amount or an unparseable date makes the coupon `invalid_coupon`. A
negative discount would raise the bill, which is the most expensive failure mode
here; a fractional percentage would reintroduce floats.

The two union-typed fields are validated for the same reason, because TypeScript
unions are erased exactly like `number` is: a `kind` outside `percent | fixed`
otherwise falls through to the fixed branch and pays its `value` out in kopecks,
and a `category` outside the declared three is reported as `category_absent` —
a statement about the cart, for a defect in the coupon. Both are decided before
the `category_absent` check so the reason always names what is actually wrong.

The same reasoning covers the shapes, not just the values. `priceOrder` takes
three externally-shaped inputs — `order.items`, `catalogue` and `order.coupons` —
and each is `T[]` only in the type. The lookup skips any catalogue candidate that
is not an object carrying a string `code`; a coupon entry that is not a string is
`unknown_code` under an empty code, since it can name nothing and stringifying it
would show the customer a code they never typed. Raising on any of the three
would let one malformed row in a marketing feed, or one bad entry in a cart, take
down pricing for every order — the failure the no-throw rule exists to prevent,
arriving one level up from the field it was written for.

**Rejection reasons are ordered.** Without a fixed precedence two correct
implementations agree on the money and disagree on the reason, which makes any
test asserting a reason flaky.

## Risks / Trade-offs

- **No aggregate cap.** Enough valid coupons cascade towards 100% off goods.
  Measured: 17 coupons at 50%, and chains at 10-30% stall at a few kopecks
  because a coupon yielding zero is rejected. The realistic exposure is not a
  free order but an invisible one — three codes at 30% is 65.7% off while no
  single code looks generous. Bounded by the goods value and, on physical
  orders, by shipping. A cap is business policy and needs its own ticket.
- **Order-dependence is customer-visible** when a fixed coupon meets a
  category coupon (AC-16). Accepted as the cost of honouring the typed order;
  support can explain it in one sentence.
- **"100% off" promotions still charge one kopeck** on digital orders. Marketing
  must not promise "completely free". The alternative — allowing a zero total —
  produces orders that no payment provider will authorise.
- **Per-category rounding can favour the customer by up to ~1.5 kopecks** per
  order versus rounding the subtotal once. Accepted: bounded, deterministic, and
  it buys a rule that does not depend on cart shape.