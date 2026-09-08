# Design: add-discount-engine

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

- One deterministic procedure: the same cart, codes and `options.now` always
  produce the same breakdown, independent of implementation order or cart line
  splitting. The clock is the single exception, and only when it is not
  injected: `options.now` defaults to `new Date()`, so two otherwise identical
  calls that omit it can straddle a coupon's expiry and differ.
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

**One money bound, checked on the sum, enforced by throwing.** Two things are
bounded by `MAX_MONEY_KOPECKS` (1e9 kopecks, 10M UAH): the **goods base**, meaning
the accumulated sum of the contributing lines, and the **money-valued coupon
fields**, a fixed `value` and a `minSubtotalKopecks`. An individual line total is
not among them and is never validated against the bound — a line of 2e9 is carried
into the base and stopped by the check on the sum, which raises, rather than being
refused as an out-of-range field the way an oversized coupon value is refused as
`invalid_coupon` (AC-26). The number is picked from the arithmetic rather than the
business: `base * pct <= 1e9 * 100 = 1e11 < 2^53`, so no intermediate product can
lose precision and the rounding rule above stays exact everywhere. A line whose
own product overflows to `Infinity` raises as well: `Number.isInteger` rejects it,
so treating it as corrupt data would ship those goods free while a merely large
line of 2e9 raises — the cart would get cheaper as it got bigger.

The bound deliberately stops there. `shippingKopecks` is seeded behaviour this
change does not touch, so `totalKopecks` can exceed the bound by the shipping fee
— scenario AC-26 prices 1000000000 goods at a total of 1000004900. Extending the
bound to the total would mean either trimming a legitimate cheque or raising on a
perfectly priceable order; the bound exists for the exactness of the products,
not to cap what a customer may spend.

Checking a line alone is not enough — two individually safe lines can sum past
the range — but the two obvious repairs are both worse than throwing. Neither
per-line variant survives, and for different reasons. Taking lines while the
running sum stays under the bound makes the priced total depend on the order of
`order.items` — `[1e9, 1]` prices at 1e9 and `[1, 1e9]` at 1 — contradicting the
engine's own promise that the same cart always costs the same. Clamping each
line to the bound instead is order-independent (both orders give 1e9 + 1), but
it silently rewrites a line of 2e9 as 1e9: the goods leave at half price and
nothing in the breakdown says so. Zeroing the whole base is
order-independent but fails open: the customer walks away with the goods for the
price of shipping. A `RangeError` on the *sum* is the only outcome that is both
order-independent and closed on money. It narrows "never throws on order data"
exactly as far as the broken-clock rule already narrowed it — and no further: a
single malformed line still contributes 0 rather than being fatal.

**An _unscoped_ fixed coupon consumes categories in declared order.** A fixed
coupon that carries a `category` is not spread at all: the whole amount comes off
that category's remainder, clamped to it. For the unscoped case the coupon's own
amount is unaffected by the order; only a later category-scoped coupon can
observe the difference. An arbitrary-but-fixed rule is predictable; a proportional split
would need another rounding decision.

**The minimum charge is a separate breakdown field, not a shrunken discount.**
It applies only where the original `subtotalKopecks` was above zero *and* the
whole total, shipping included, comes out at exactly zero — so a physical order
keeps its shipping total untouched and is never topped up by a kopeck; in
practice only a fully discounted digital order reaches it. There, adding
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

Each factor is judged on its own, not through the product it happens to make.
`50.5 * 2`, `-100 * -1` and `-0.5 * -200` all arrive as clean non-negative
integers, so a check on `lineTotalKopecks` alone waves them through — yet half a
kopeck is not money and a line priced below zero and counted below zero is not
goods. The product is still checked afterwards, and still earns its place: two
enormous but individually valid factors multiply to `Infinity`, which no test of
the factors would catch.

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
and a `category` outside the declared three would be reported as
`category_absent` — a statement about the cart, for a defect in the coupon. Both
are therefore `invalid_coupon`, decided before the `category_absent` check so the
reason always names what is actually wrong.

The same reasoning covers the shapes, not just the values. `priceOrder` takes
three externally-shaped inputs — `order.items`, `catalogue` and `order.coupons` —
and each is `T[]` only in the type. The lookup skips any catalogue candidate that
is not an object carrying a string `code`; a coupon entry that is not a string is
`unknown_code` under an empty code, since it can name nothing and stringifying it
would show the customer a code they never typed. Raising on any of the three
would let one malformed row in a marketing feed, or one bad entry in a cart, take
down pricing for every order — the failure the no-throw rule exists to prevent,
arriving one level up from the field it was written for.

Two fields need their *type* checked rather than only their value, because they
are handed to operations that convert before they compare. `RegExp.test` converts
with `ToString` and `lineTotalKopecks` multiplies; both raise on a symbol instead
of producing a non-matching string or a `NaN` that the following check would
absorb. Every other field is compared with `===` or inspected with
`Number.isInteger`, neither of which converts, so no guard is needed there.

The guarding stops at the element. A `null` entry in a cart is customer data and
must price; the call's own shape — `order` and `options` as objects, the three
collections as arrays, `now` as a `Date` — is the caller's contract, and every
level of it is checked explicitly. Checking only the innermost level would leave
the same defect one floor up: a non-object `options` reads `.now` as absent and
reaches the wall clock, which is the nondeterministic expiry the `now` rule
exists to prevent. Drawing
the line anywhere further out would mean inventing a total for a call that does
not describe an order — and the most likely invention, treating a missing array
as an empty one, is the worst of them: it prices as a valid empty cart and moves
on through checkout rather than surfacing the bug.

Neutralising a line at step 0 is not enough on its own, because the engine hands
the same array to a seeded function later: `shippingKopecks` walks `order.items`
to decide the all-digital waiver, and a non-object entry throws there. Shipping is
therefore computed from the shape-valid lines. They are the right set rather than
the contributing ones: a line with a corrupt amount still represents physical
goods in the cart, so dropping it could waive the fee on a cart that is not
all-digital — a pricing change D-2 explicitly does not make.

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
- **Per-category rounding can favour the customer by at most 1 kopeck** per
  order versus rounding the subtotal once — checked exhaustively for every
  percentage 0-100: three half-up roundings can exceed a single rounding of
  their sum by one kopeck and never by more, because three fractions that each
  round up sum to at least 1.5, which the single rounding then rounds up too.
  Accepted: bounded, deterministic, and it buys a rule that does not depend on
  cart shape.
