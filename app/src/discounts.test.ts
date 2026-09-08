// Один тест на кожен критерій приймання з docs/spec/pricing-discounts.md.
// Назви тестів навмисно починаються з ID критерію: так звʼязок зі специфікацією
// видно просто у виводі vitest, без зазирання в таблицю простежуваності.

import { describe, it, expect } from "vitest";
import { priceOrder, MAX_MONEY_KOPECKS, MINIMUM_CHARGE_KOPECKS } from "./discounts.js";
import { subtotalKopecks } from "./pricing.js";
import type { Coupon, LineItem, Order } from "./types.js";

/** Спільний момент розрахунку для всіх тестів (D-12). */
const NOW = new Date("2026-09-06T10:00:00.000Z");

const item = (over: Partial<LineItem> = {}): LineItem => ({
  sku: "AA-1",
  name: "Thing",
  unitPriceKopecks: 100_000,
  quantity: 1,
  category: "standard",
  ...over,
});

const order = (over: Partial<Order> = {}): Order => ({
  id: "o1",
  items: [item()],
  country: "UA",
  customerTier: "none",
  coupons: [],
  ...over,
});

const coupon = (
  code: string,
  kind: Coupon["kind"],
  value: number,
  over: Partial<Coupon> = {},
): Coupon => ({ code, kind, value, expiresAt: "2027-01-01T00:00:00.000Z", ...over });

const CATALOGUE: Coupon[] = [
  coupon("SAVE15", "percent", 15),
  coupon("SAVE10", "percent", 10),
  coupon("FULL100", "percent", 100),
  coupon("FRESH10", "percent", 10, { category: "fresh" }),
  coupon("FRESH20", "percent", 20, { category: "fresh" }),
  coupon("FRESH25", "percent", 25, { category: "fresh" }),
  coupon("FRESH50", "percent", 50, { category: "fresh" }),
  coupon("DIGI10", "percent", 10, { category: "digital" }),
  coupon("FIX500", "fixed", 50_000),
  coupon("SAVE200", "fixed", 20_000),
  coupon("MIN1000", "percent", 10, { minSubtotalKopecks: 100_000 }),
  coupon("AUTUMN10", "percent", 10, { expiresAt: "2026-09-01T00:00:00.000Z" }),
  coupon("FLASH20", "percent", 20, { expiresAt: "2026-10-01T00:00:00.000Z" }),
  coupon("LATEMIN", "percent", 10, {
    expiresAt: "2026-09-01T00:00:00.000Z",
    minSubtotalKopecks: 500_000,
  }),
  coupon("BAD120", "percent", 120),
  coupon("BAD125", "percent", 12.5),
  coupon("BADNEG", "fixed", -5_000),
  coupon("BADDATE", "percent", 10, { expiresAt: "завтра" }),
  // Навмисний дубль коду з іншим значенням — для AC-22 (D-9).
  coupon("save10", "percent", 50),
  // D-12: рядок без зсуву й дата без часу — для AC-24.
  coupon("TZLOCAL", "percent", 10, { expiresAt: "2026-09-06T12:00:00" }),
  coupon("DATEONLY", "percent", 10, { expiresAt: "2026-10-01" }),
  // D-16: некоректний поріг — для AC-25.
  coupon("MINNAN", "percent", 10, { minSubtotalKopecks: NaN }),
  coupon("MINNEG", "percent", 10, { minSubtotalKopecks: -1 }),
  coupon("MINFRAC", "percent", 10, { minSubtotalKopecks: 12.5 }),
  // D-24: грошове поле понад межу й рівно на межі — для AC-26.
  coupon("FIXHUGE", "fixed", 2_000_000_000),
  coupon("FIXBOUND", "fixed", 1_000_000_000),
  // D-12: явний зсув, не тільки `Z`, і регістр за RFC 3339 — для AC-24.
  coupon("OFFSET02", "percent", 10, { expiresAt: "2026-10-01T00:00:00+02:00" }),
  coupon("LOWERZ", "percent", 10, { expiresAt: "2026-10-01t00:00:00z" }),
  // D-16: enum-поля поза юніоном — для AC-27. `KINDBAD` без правила пішов би в
  // гілку fixed і роздав би 50 000 копійок.
  coupon("KINDBAD", "percentt" as never, 50_000),
  coupon("CATBAD", "percent", 10, { category: "STANDARD" as never }),
];

const price = (o: Order, now: Date = NOW) => priceOrder(o, CATALOGUE, { now });

/**
 * Замовлення, на яких AC-20 перевіряє інваріанти розбивки.
 *
 * Список **засіяний на рівні модуля** представницьким набором форм, тож AC-20
 * не залежить від того, чи виконались тести вище: `vitest -t "AC-20"` поодинці
 * бачить рівно цей набір. У повному прогоні `track()` дописує сюди ще й кожне
 * замовлення з інших тестів, і AC-20 перевіряє інваріанти на всіх.
 */
const FIXTURES: Order[] = [
  order({ customerTier: "gold", coupons: ["SAVE15"] }),
  order({ items: [], coupons: ["SAVE10"] }),
  order({ items: [item({ category: "digital" })], coupons: ["FULL100"] }),
  order({ items: [item({ unitPriceKopecks: 30_000 })], coupons: ["FIX500"] }),
  order({ coupons: ["NOSUCH", "AUTUMN10", "BAD120"] }),
  order({
    items: [item(), item({ sku: "BB-1", category: "fresh", unitPriceKopecks: 20_000, quantity: -1 })],
  }),
  order({ items: [item({ unitPriceKopecks: MAX_MONEY_KOPECKS })] }),
];
const track = (o: Order): Order => {
  FIXTURES.push(o);
  return o;
};

describe("priceOrder", () => {
  it("AC-1: Gold-рівень знижує товари, але не доставку", () => {
    const result = price(track(order({ customerTier: "gold" })));
    expect(result.tierDiscountKopecks).toBe(10_000);
    expect(result.couponDiscountKopecks).toBe(0);
    expect(result.shippingKopecks).toBe(4_900);
    expect(result.totalKopecks).toBe(94_900);
  });

  it("AC-2: промокод рахується від залишку після рівня, а не від початкової суми", () => {
    const result = price(track(order({ customerTier: "gold", coupons: ["SAVE15"] })));
    expect(result.tierDiscountKopecks).toBe(10_000);
    expect(result.couponDiscountKopecks).toBe(13_500); // 15% від 90 000, не від 100 000
    expect(result.totalKopecks).toBe(81_400);
    // Складання відсотків (25% від 100 000) дало б 79 900 — різниця 1 500.
    expect(result.totalKopecks).not.toBe(79_900);
  });

  it("AC-3: два промокоди на одну категорію застосовуються обидва, каскадом", () => {
    const result = price(
      track(
        order({
          items: [item({ unitPriceKopecks: 40_000 }), item({ unitPriceKopecks: 60_000, category: "fresh" })],
          coupons: ["FRESH10", "FRESH20"],
        }),
      ),
    );
    expect(result.appliedCoupons).toEqual([
      { code: "FRESH10", discountKopecks: 6_000 },
      { code: "FRESH20", discountKopecks: 10_800 }, // 20% від залишку 54 000
    ]);
    expect(result.couponDiscountKopecks).toBe(16_800); // складання дало б 18 000
    expect(result.totalKopecks).toBe(88_100);
  });

  it("AC-4: знижка більша за суму обрізається, підсумок не стає відʼємним", () => {
    const result = price(track(order({ items: [item({ unitPriceKopecks: 30_000 })], coupons: ["FIX500"] })));
    expect(result.couponDiscountKopecks).toBe(30_000); // а не 50 000
    expect(result.totalKopecks).toBe(4_900); // рівно доставка
  });

  it("AC-5: прострочений промокод пропускається з причиною, а не кидає виняток", () => {
    const result = price(track(order({ coupons: ["AUTUMN10"] })));
    expect(result.couponDiscountKopecks).toBe(0);
    expect(result.totalKopecks).toBe(104_900);
    expect(result.rejectedCoupons).toEqual([{ code: "AUTUMN10", reason: "expired" }]);
  });

  it("AC-6: момент expiresAt уже недійсний, мілісекундою раніше — ще дійсний", () => {
    const atExpiry = price(order({ coupons: ["FLASH20"] }), new Date("2026-10-01T00:00:00.000Z"));
    expect(atExpiry.rejectedCoupons).toEqual([{ code: "FLASH20", reason: "expired" }]);
    expect(atExpiry.totalKopecks).toBe(104_900);

    const justBefore = price(order({ coupons: ["FLASH20"] }), new Date("2026-09-30T23:59:59.999Z"));
    expect(justBefore.couponDiscountKopecks).toBe(20_000);
    expect(justBefore.totalKopecks).toBe(84_900);
  });

  it("AC-7: поріг minSubtotal перевіряється проти вихідної суми, включно", () => {
    const result = price(track(order({ customerTier: "gold", coupons: ["MIN1000"] })));
    // Перевірка після знижки за рівнем дала б 90 000 < 100 000 і відмову.
    expect(result.rejectedCoupons).toEqual([]);
    expect(result.tierDiscountKopecks).toBe(10_000);
    expect(result.couponDiscountKopecks).toBe(9_000);
    expect(result.totalKopecks).toBe(85_900);
  });

  it("AC-8: категорійний промокод рахується від суми своєї категорії", () => {
    const result = price(
      track(
        order({
          items: [item({ unitPriceKopecks: 20_000, category: "fresh" }), item({ unitPriceKopecks: 80_000 })],
          coupons: ["FRESH25"],
        }),
      ),
    );
    expect(result.couponDiscountKopecks).toBe(5_000); // 25% від 20 000, а не від 100 000
    expect(result.totalKopecks).toBe(99_900);
  });

  it("AC-9: пів копійки округлюється вгору, окремо в кожній категорії", () => {
    const result = price(
      track(
        order({
          customerTier: "gold",
          items: [item({ unitPriceKopecks: 12_345 }), item({ unitPriceKopecks: 12_345, category: "fresh" })],
        }),
      ),
    );
    // 12 345 × 10% = 1 234,5 → 1 235 у кожній категорії.
    expect(result.tierDiscountKopecks).toBe(2_470);
    // Округлення від спільних 24 690 дало б 2 469.
    expect(result.tierDiscountKopecks).not.toBe(2_469);
    expect(result.totalKopecks).toBe(27_120);
  });

  it("AC-10: порожнє замовлення не падає й лишається з нулем", () => {
    const result = price(track(order({ items: [], coupons: ["SAVE10"] })));
    expect(result.subtotalKopecks).toBe(0);
    expect(result.tierDiscountKopecks).toBe(0);
    expect(result.couponDiscountKopecks).toBe(0);
    expect(result.shippingKopecks).toBe(0);
    expect(result.minimumChargeAdjustmentKopecks).toBe(0); // товарів немає — D-21 не діє
    expect(result.totalKopecks).toBe(0);
    expect(result.rejectedCoupons).toEqual([{ code: "SAVE10", reason: "no_remaining_amount" }]);
  });

  it("AC-11: невідомий код повертається обрізаним, але не приведеним до верхнього регістру", () => {
    const result = price(track(order({ coupons: [" nosuch "] })));
    expect(result.rejectedCoupons).toEqual([{ code: "nosuch", reason: "unknown_code" }]);
    expect(result.totalKopecks).toBe(104_900);
  });

  it("AC-12: той самий код, введений двічі, зараховується один раз", () => {
    const result = price(track(order({ coupons: ["SAVE10", "SAVE10"] })));
    expect(result.couponDiscountKopecks).toBe(10_000);
    expect(result.totalKopecks).toBe(94_900);
    expect(result.rejectedCoupons).toEqual([{ code: "SAVE10", reason: "duplicate_code" }]);
  });

  it("AC-13: код зіставляється без урахування регістру й пробілів", () => {
    const applied = price(track(order({ coupons: [" save10 "] })));
    expect(applied.appliedCoupons).toEqual([{ code: "SAVE10", discountKopecks: 10_000 }]);
    expect(applied.totalKopecks).toBe(94_900);

    // Нормалізація годує й перевірку дублів.
    const duplicate = price(track(order({ coupons: ["save10", "SAVE10"] })));
    expect(duplicate.couponDiscountKopecks).toBe(10_000);
    expect(duplicate.rejectedCoupons).toEqual([{ code: "SAVE10", reason: "duplicate_code" }]);
  });

  it("AC-14: некоректні дані купона не застосовуються й не кидають винятку", () => {
    const result = price(track(order({ coupons: ["BAD120", "BAD125", "BADNEG", "BADDATE"] })));
    expect(result.couponDiscountKopecks).toBe(0);
    expect(result.totalKopecks).toBe(104_900);
    expect(result.rejectedCoupons).toEqual([
      { code: "BAD120", reason: "invalid_coupon" },
      { code: "BAD125", reason: "invalid_coupon" },
      { code: "BADNEG", reason: "invalid_coupon" },
      { code: "BADDATE", reason: "invalid_coupon" },
    ]);
  });

  it("AC-15: категорійний купон без товарів цієї категорії — category_absent", () => {
    const result = price(track(order({ coupons: ["DIGI10"] })));
    expect(result.rejectedCoupons).toEqual([{ code: "DIGI10", reason: "category_absent" }]);
    expect(result.totalKopecks).toBe(104_900);
  });

  it("AC-16: порядок введення промокодів впливає на підсумок і це видно", () => {
    const items = [
      item({ unitPriceKopecks: 5_000 }),
      item({ unitPriceKopecks: 20_000, category: "fresh" }),
    ];

    const fixedFirst = price(track(order({ items, coupons: ["SAVE200", "FRESH50"] })));
    expect(fixedFirst.couponDiscountKopecks).toBe(22_500); // 20 000 + 50% від решти fresh 5 000
    expect(fixedFirst.totalKopecks).toBe(7_400);

    const percentFirst = price(track(order({ items, coupons: ["FRESH50", "SAVE200"] })));
    expect(percentFirst.couponDiscountKopecks).toBe(25_000); // 10 000 + 15 000, решта 5 000 зникає
    expect(percentFirst.totalKopecks).toBe(4_900);
  });

  it("AC-17: повна знижка зʼїдає товари, але доставку не чіпає", () => {
    const result = price(track(order({ country: "PL", customerTier: "gold", coupons: ["FULL100"] })));
    expect(result.tierDiscountKopecks).toBe(10_000);
    expect(result.couponDiscountKopecks).toBe(90_000);
    expect(result.shippingKopecks).toBe(19_900);
    expect(result.totalKopecks).toBe(19_900);
  });

  it("AC-18: обнулене цифрове замовлення коштує мінімальну копійку", () => {
    const result = price(track(order({ items: [item({ category: "digital" })], coupons: ["FULL100"] })));
    expect(result.couponDiscountKopecks).toBe(100_000); // знижка не переписується
    expect(result.shippingKopecks).toBe(0);
    expect(result.minimumChargeAdjustmentKopecks).toBe(MINIMUM_CHARGE_KOPECKS);
    expect(result.totalKopecks).toBe(1);
  });

  it("AC-19: при кількох причинах відмови повертається перша за пріоритетом", () => {
    // Прострочений І не добирає порогу → expired, бо воно раніше в D-20.
    const both = price(track(order({ coupons: ["LATEMIN"] })));
    expect(both.rejectedCoupons).toEqual([{ code: "LATEMIN", reason: "expired" }]);

    // unknown_code стоїть перед duplicate_code, тож обидва входження — unknown.
    const unknownTwice = price(track(order({ coupons: ["NOSUCH", "NOSUCH"] })));
    expect(unknownTwice.rejectedCoupons).toEqual([
      { code: "NOSUCH", reason: "unknown_code" },
      { code: "NOSUCH", reason: "unknown_code" },
    ]);

    // А ось прострочений код входить у «вже траплявся», тож другий — duplicate.
    const expiredTwice = price(track(order({ coupons: ["AUTUMN10", "AUTUMN10"] })));
    expect(expiredTwice.rejectedCoupons).toEqual([
      { code: "AUTUMN10", reason: "expired" },
      { code: "AUTUMN10", reason: "duplicate_code" },
    ]);
  });

  it("AC-21: зіпсутий рядок замовлення вносить у базу нуль", () => {
    const corrupt = track(
      order({
        items: [item(), item({ unitPriceKopecks: 20_000, quantity: -1, category: "fresh" })],
      }),
    );
    const result = price(corrupt);
    expect(subtotalKopecks(corrupt)).toBe(80_000); // засіяна функція бачить −20 000
    expect(result.subtotalKopecks).toBe(100_000); // рушій зіпсутий рядок не рахує
    expect(result.totalKopecks).toBe(104_900);
  });

  it("AC-22: при дублі коду в каталозі виграє перший запис у масиві", () => {
    const result = price(track(order({ coupons: ["SAVE10"] })));
    expect(result.couponDiscountKopecks).toBe(10_000); // percent 10, а не percent 50
    expect(result.totalKopecks).toBe(94_900);
  });

  it("AC-23: зіпсутий now падає одразу, а не мовчки оживляє прострочені купони", () => {
    const withExpired = order({ coupons: ["AUTUMN10"] });
    expect(() => priceOrder(withExpired, CATALOGUE, { now: new Date("не дата") })).toThrow(
      RangeError,
    );
    // Контроль: з валідним now той самий купон просто відхиляється.
    expect(price(withExpired).rejectedCoupons).toEqual([
      { code: "AUTUMN10", reason: "expired" },
    ]);
  });

  it("AC-24: expiresAt без явного зсуву — invalid_coupon, а не гра в часові пояси", () => {
    const result = price(track(order({ coupons: ["TZLOCAL", "DATEONLY"] })));
    expect(result.couponDiscountKopecks).toBe(0);
    expect(result.totalKopecks).toBe(104_900);
    expect(result.rejectedCoupons).toEqual([
      { code: "TZLOCAL", reason: "invalid_coupon" },
      { code: "DATEONLY", reason: "invalid_coupon" },
    ]);
    // Причина правила: без зсуву `Date.parse` читає рядок у поясі хоста, тож
    // купон був би живий у UTC і простроченим у Києві. Перевіряємо саме рушій,
    // а не парсер: результат однаковий на будь-якому TZ.

    // Зворотний бік D-12: явний зсув — і не тільки `Z` — приймається.
    const withOffset = price(order({ coupons: ["OFFSET02", "LOWERZ"] }));
    expect(withOffset.rejectedCoupons).toEqual([]);
    expect(withOffset.couponDiscountKopecks).toBe(19_000); // 10% від 100 000, далі 10% від 90 000
  });

  it("AC-25: некоректний minSubtotalKopecks не дає порогу мовчки зникнути", () => {
    const result = price(track(order({ coupons: ["MINNAN", "MINNEG", "MINFRAC"] })));
    expect(result.couponDiscountKopecks).toBe(0);
    expect(result.totalKopecks).toBe(104_900);
    expect(result.rejectedCoupons).toEqual([
      { code: "MINNAN", reason: "invalid_coupon" },
      { code: "MINNEG", reason: "invalid_coupon" },
      { code: "MINFRAC", reason: "invalid_coupon" },
    ]);
    // Без правила `subtotal < NaN` хибне, поріг мовчки зникає, і MINNAN дав би 10 000.
  });

  it("AC-26: понад межу — RangeError; рівно межа — рахується", () => {
    // Один рядок понад межу: рушій не занулює його (це віддало б товар за
    // ціною доставки) і не залежить від порядку рядків — він падає.
    const overLine = order({ items: [item({ unitPriceKopecks: 2_000_000_000 })] });
    expect(() => price(overLine)).toThrow(RangeError);

    // Два рядки, кожен у межі, сума — ні. Обидва порядки дають той самий
    // результат: інакше той самий кошик коштував би різного (§1).
    const twoLines = [item({ unitPriceKopecks: 600_000_000 }), item({ sku: "BB-1", unitPriceKopecks: 600_000_000 })];
    expect(() => price(order({ items: twoLines }))).toThrow(RangeError);
    expect(() => price(order({ items: [...twoLines].reverse() }))).toThrow(RangeError);

    // Рівно межа — валідне замовлення, рахується точно.
    const atBound = price(track(order({ items: [item({ unitPriceKopecks: MAX_MONEY_KOPECKS })] })));
    expect(atBound.subtotalKopecks).toBe(MAX_MONEY_KOPECKS);
    expect(atBound.totalKopecks).toBe(MAX_MONEY_KOPECKS + 4_900);

    // Купон рівно на межу — придатний.
    const fixAtBound = price(order({
      items: [item({ unitPriceKopecks: MAX_MONEY_KOPECKS })],
      coupons: ["FIXBOUND"],
    }));
    expect(fixAtBound.rejectedCoupons).toEqual([]);
    expect(fixAtBound.couponDiscountKopecks).toBe(MAX_MONEY_KOPECKS);

    // Грошове поле купона понад межу — invalid_coupon, а не виняток.
    const hugeCoupon = price(track(order({ coupons: ["FIXHUGE"] })));
    expect(hugeCoupon.rejectedCoupons).toEqual([{ code: "FIXHUGE", reason: "invalid_coupon" }]);
    expect(hugeCoupon.totalKopecks).toBe(104_900);

    // Зіпсутий рядок лишається зануленим (D-22), а не приводом упасти.
    const corruptCategory = price(order({
      items: [item(), { ...item({ sku: "CC-1" }), category: "STANDARD" as never }],
    }));
    expect(corruptCategory.subtotalKopecks).toBe(100_000);
    expect(corruptCategory.totalKopecks).toBe(104_900);
  });

  it("AC-27: невідомі kind і category купона — invalid_coupon, а не знижка", () => {
    const result = price(track(order({ coupons: ["KINDBAD", "CATBAD"] })));
    expect(result.couponDiscountKopecks).toBe(0);
    expect(result.totalKopecks).toBe(104_900);
    expect(result.rejectedCoupons).toEqual([
      { code: "KINDBAD", reason: "invalid_coupon" },
      { code: "CATBAD", reason: "invalid_coupon" },
    ]);
    // Без перевірки `kind` купон пішов би в гілку fixed і дав би 50 000; без
    // перевірки `category` він отримав би `category_absent` — причину, яка
    // говорить про кошик, хоча зіпсутий тут купон.
  });

  it("AC-28: зіпсутий рядок і зіпсутий запис каталогу не зупиняють розрахунок", () => {
    // Рядок, якого взагалі немає: `lineTotalKopecks(null)` кинув би TypeError.
    const withNullLine = price(
      track(order({ items: [item(), null as never], coupons: ["SAVE10"] })),
    );
    expect(withNullLine.subtotalKopecks).toBe(100_000);
    expect(withNullLine.couponDiscountKopecks).toBe(10_000);
    expect(withNullLine.totalKopecks).toBe(94_900);

    // Категорію позначає лише придатний рядок: єдиний fresh-рядок зіпсутий, тож
    // fresh-купон — `category_absent`, а не `no_remaining_amount` (D-19, D-22).
    const corruptFresh = price(
      track(
        order({
          items: [item(), item({ sku: "BB-1", category: "fresh", quantity: -1 })],
          coupons: ["FRESH10"],
        }),
      ),
    );
    expect(corruptFresh.rejectedCoupons).toEqual([
      { code: "FRESH10", reason: "category_absent" },
    ]);

    // Зіпсутий запис каталогу пропускається пошуком, а не валить весь виклик.
    const brokenCatalogue = [
      null as never,
      { code: null } as never,
      ...CATALOGUE,
    ];
    const result = priceOrder(order({ coupons: ["SAVE10", "NOSUCH"] }), brokenCatalogue, {
      now: NOW,
    });
    expect(result.appliedCoupons).toEqual([{ code: "SAVE10", discountKopecks: 10_000 }]);
    expect(result.rejectedCoupons).toEqual([{ code: "NOSUCH", reason: "unknown_code" }]);
    expect(result.totalKopecks).toBe(94_900);

    // Третій зовнішній вхід: код, який не є рядком. `normalizeCode` кинув би на
    // `.trim()`; замість цього — `unknown_code` з порожнім кодом, і сусідній
    // валідний код усе одно обробляється (D-11).
    const badCode = price(track(order({ coupons: [null as never, "SAVE10"] })));
    expect(badCode.rejectedCoupons).toEqual([{ code: "", reason: "unknown_code" }]);
    expect(badCode.appliedCoupons).toEqual([{ code: "SAVE10", discountKopecks: 10_000 }]);
    expect(badCode.totalKopecks).toBe(94_900);
  });

  // AC-20 стоїть останнім навмисно, поза числовим порядком: він проходить по
  // FIXTURES, які наповнює track() у тестах вище. Якщо перенести його на місце
  // за номером, він побачить лише частину замовлень.
  it("AC-20: розбивка сходиться копійка в копійку на кожному із замовлень вище", () => {
    expect(FIXTURES.length).toBeGreaterThan(0);
    for (const fixture of FIXTURES) {
      const result = price(fixture);

      expect(result.totalKopecks).toBe(
        result.subtotalKopecks -
          result.tierDiscountKopecks -
          result.couponDiscountKopecks +
          result.shippingKopecks +
          result.minimumChargeAdjustmentKopecks,
      );

      expect(result.couponDiscountKopecks).toBe(
        result.appliedCoupons.reduce((sum, entry) => sum + entry.discountKopecks, 0),
      );

      // Кожен введений код зустрічається рівно один раз.
      expect(result.appliedCoupons.length + result.rejectedCoupons.length).toBe(
        fixture.coupons.length,
      );

      // Інваріант 6 (D-24): база ніколи не виходить за спільну межу.
      expect(result.subtotalKopecks).toBeGreaterThanOrEqual(0);
      expect(result.subtotalKopecks).toBeLessThanOrEqual(MAX_MONEY_KOPECKS);

      expect(result.totalKopecks).toBeGreaterThanOrEqual(result.shippingKopecks);
      if (result.subtotalKopecks > 0) {
        expect(result.totalKopecks).toBeGreaterThanOrEqual(MINIMUM_CHARGE_KOPECKS);
      }
    }
  });
});
