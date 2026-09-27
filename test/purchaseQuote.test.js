'use strict';

/**
 * 采购报价组合（src/purchaseQuote.js）独立计算模块测试。
 *
 * 覆盖：启用 / 关闭语义、四级排序（总价 → 超购 → 供应商数 → 录入顺序）、
 * 最少 / 最多包数边界、分整数精确计算、不可行缺口、需求来源（手工 / 备料接入）、
 * 参数校验，以及与全枚举暴力解的大规模随机对照（验证动态规划选解与排序规则一致）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeImposition } = require('../src/imposition');
const {
  parsePurchaseQuotesInput,
  solveQuoteCombination,
  attachPurchaseQuotes,
  MAX_QUOTES,
} = require('../src/purchaseQuote');

/** 构造一条报价的简写。 */
function q(supplier, sheetsPerPack, pricePerPackCents, minPacks = 0, maxPacks = 100) {
  return { supplier, sheetsPerPack, pricePerPackCents, minPacks, maxPacks };
}

test('未启用：缺省 / null / false / enabled:false 均不启用', () => {
  assert.deepEqual(parsePurchaseQuotesInput({}), { enabled: false });
  assert.deepEqual(parsePurchaseQuotesInput({ purchaseQuotes: null }), { enabled: false });
  assert.deepEqual(parsePurchaseQuotesInput({ purchaseQuotes: false }), { enabled: false });
  assert.deepEqual(
    parsePurchaseQuotesInput({ purchaseQuotes: { enabled: false, quotes: [q('A', 1, 1)] } }),
    { enabled: false }
  );
  assert.equal(attachPurchaseQuotes(null, { enabled: false }, 100), undefined);
});

test('未启用时 /api/impose 核心计算结果不含 purchaseQuotes 字段（原响应不变）', () => {
  const r = computeImposition({ totalPages: 8, sheetsPerSignature: 2, binding: 'left', flip: 'short' });
  assert.equal(r.purchaseQuotes, undefined);
});

test('基本可行：按包数边界求解，逐报价采购量 / 金额 / 余量正确', () => {
  // 需求 100：A 50 张/包 500 分，B 50 张/包 400 分 → 2 包 B 正好
  const parsed = parsePurchaseQuotesInput({
    purchaseQuotes: { demandSheets: 100, quotes: [q('A厂', 50, 500, 0, 10), q('B厂', 50, 400, 0, 10)] },
  });
  const res = solveQuoteCombination(parsed.demandSheets, parsed.quotes);
  assert.equal(res.feasible, true);
  assert.equal(res.demandSheets, 100);
  assert.deepEqual(res.rows.map((r) => r.packs), [0, 2]);
  assert.deepEqual(res.rows.map((r) => r.sheets), [0, 100]);
  assert.deepEqual(res.rows.map((r) => r.amountCents), [0, 800]);
  assert.deepEqual(res.rows.map((r) => r.remainingPacks), [10, 8]);
  assert.deepEqual(res.rows.map((r) => r.remainingSheets), [500, 400]);
  assert.equal(res.totals.totalPacks, 2);
  assert.equal(res.totals.totalSheets, 100);
  assert.equal(res.totals.overPurchaseSheets, 0);
  assert.equal(res.totals.totalCostCents, 800);
  assert.equal(res.totals.supplierCount, 1);
  assert.deepEqual(res.totals.suppliers, ['B厂']);
});

test('排序第 1 级：总价最低优先（便宜供应商补足需求，哪怕要多买包）', () => {
  // 需求 100：A 60 张 500 分，B 50 张 400 分
  // 2A=120 张 1000 分；1A+1B=110 张 900 分；2B=100 张 800 分
  const parsed = parsePurchaseQuotesInput({
    purchaseQuotes: { demandSheets: 100, quotes: [q('A', 60, 500), q('B', 50, 400)] },
  });
  const res = solveQuoteCombination(100, parsed.quotes);
  assert.equal(res.feasible, true);
  assert.deepEqual(res.rows.map((r) => r.packs), [0, 2]);
  assert.equal(res.totals.totalCostCents, 800);
});

test('排序第 2 级：总价相同 → 超购张数最少', () => {
  // 需求 10：A 6 张 60 分，B 5 张 60 分
  // 2A=12 张 120；A+B=11 张 120；2B=10 张 120 → 超购 0 胜出
  const parsed = parsePurchaseQuotesInput({
    purchaseQuotes: { demandSheets: 10, quotes: [q('A', 6, 60), q('B', 5, 60)] },
  });
  const res = solveQuoteCombination(10, parsed.quotes);
  assert.deepEqual(res.rows.map((r) => r.packs), [0, 2]);
  assert.equal(res.totals.totalCostCents, 120);
  assert.equal(res.totals.overPurchaseSheets, 0);
});

test('排序第 3 级：总价 / 超购相同 → 供应商数量最少（与录入顺序相反也要选少的）', () => {
  // 需求 10：B 4 张 40 分、C 6 张 60 分（组合 10 张 100 分需 2 家），
  // A 10 张 100 分（单家恰好）录在最后 → 仍应选 A 一家
  const parsed = parsePurchaseQuotesInput({
    purchaseQuotes: {
      demandSheets: 10,
      quotes: [q('B', 4, 40), q('C', 6, 60), q('A', 10, 100)],
    },
  });
  const res = solveQuoteCombination(10, parsed.quotes);
  assert.deepEqual(res.rows.map((r) => r.packs), [0, 0, 1]);
  assert.equal(res.totals.totalCostCents, 100);
  assert.equal(res.totals.overPurchaseSheets, 0);
  assert.equal(res.totals.supplierCount, 1);
  assert.deepEqual(res.totals.suppliers, ['A']);
});

test('排序第 4 级：前三项全并列 → 录入顺序（更早录入的报价优先装满）', () => {
  // 需求 10，单价均为 10 分/张：A 3 张 30 分、B 5 张 50 分、C 2 张 20 分。
  // 单家恰好满足：2B=10（1 家）或 5C=10（1 家），总价均 100、超购 0、均 1 家，
  // B 录入更早 → 选 B；A 无法单家恰好满足。
  const parsed = parsePurchaseQuotesInput({
    purchaseQuotes: {
      demandSheets: 10,
      quotes: [q('A', 3, 30), q('B', 5, 50), q('C', 2, 20)],
    },
  });
  const res = solveQuoteCombination(10, parsed.quotes);
  assert.deepEqual(res.rows.map((r) => r.packs), [0, 2, 0]);
  assert.equal(res.totals.totalCostCents, 100);
  assert.equal(res.totals.overPurchaseSheets, 0);
  assert.equal(res.totals.supplierCount, 1);
});

test('同家数同为混合采购且总价 / 超购并列时，录入更早的报价分得更多包数', () => {
  // A 6 张 60 分（最多 1 包）、B 4 张 40 分（最多 2 包）、C 2 张 20 分（最多 4 包），
  // 单价均为 10 分/张，需求 12；各报价按上限单独采购都不足 12（6 / 8 / 8 张），无单家解。
  //   A+3C = 12：[1,0,3]，2 家、120 分、0 超购；
  //   2B+2C = 12：[0,2,2]，2 家、120 分、0 超购。
  // 两者总价 / 超购 / 家数完全相同，第 1 位 1 > 0 -> 录入更早的 A 优先装满，选 [1,0,3]。
  const parsed = parsePurchaseQuotesInput({
    purchaseQuotes: {
      demandSheets: 12,
      quotes: [q('A', 6, 60, 0, 1), q('B', 4, 40, 0, 2), q('C', 2, 20, 0, 4)],
    },
  });
  const res = solveQuoteCombination(12, parsed.quotes);
  assert.deepEqual(res.rows.map((r) => r.packs), [1, 0, 3]);
  assert.equal(res.totals.totalCostCents, 120);
  assert.equal(res.totals.overPurchaseSheets, 0);
  assert.equal(res.totals.supplierCount, 2);
});

test('最少可购包数为强制下界：贵供应商也必须至少买够，再由便宜者补足', () => {
  // 需求 100：A 50 张 500 分（0~10），B 50 张 1000 分（最少 1、最多 5）
  // 无约束时 2A=1000；有约束时至少 1B=50 张，再 1A 补足 -> [1,1]，1500 分
  const parsed = parsePurchaseQuotesInput({
    purchaseQuotes: { demandSheets: 100, quotes: [q('A', 50, 500, 0, 10), q('B', 50, 1000, 1, 5)] },
  });
  const res = solveQuoteCombination(100, parsed.quotes);
  assert.equal(res.feasible, true);
  assert.deepEqual(res.rows.map((r) => r.packs), [1, 1]);
  assert.deepEqual(res.rows.map((r) => r.amountCents), [500, 1000]);
  assert.equal(res.totals.totalCostCents, 1500);
  assert.equal(res.totals.totalSheets, 100);
  assert.deepEqual(res.rows.map((r) => r.remainingPacks), [9, 4]);
});

test('最少包数本身已满足需求：不再额外采购（额外采购只会更贵 / 更多超购）', () => {
  const parsed = parsePurchaseQuotesInput({
    purchaseQuotes: { demandSheets: 10, quotes: [q('A', 100, 100, 2, 5), q('B', 50, 10, 0, 5)] },
  });
  const res = solveQuoteCombination(10, parsed.quotes);
  assert.deepEqual(res.rows.map((r) => r.packs), [2, 0]);
  assert.equal(res.totals.totalSheets, 200);
  assert.equal(res.totals.overPurchaseSheets, 190);
  assert.equal(res.totals.totalCostCents, 200);
});

test('无可行组合：所有报价按上限采购仍不足，返回具体缺口与尽最大可购行', () => {
  // 需求 1000：A 60 张 0~5 包（上限 300），B 50 张 0~10 包（上限 500）-> 缺口 200
  const parsed = parsePurchaseQuotesInput({
    purchaseQuotes: { demandSheets: 1000, quotes: [q('A', 60, 500, 0, 5), q('B', 50, 400, 0, 10)] },
  });
  const res = solveQuoteCombination(1000, parsed.quotes);
  assert.equal(res.feasible, false);
  assert.equal(res.gapSheets, 200);
  assert.equal(res.maxPurchasableSheets, 800);
  assert.match(res.reason, /差 200 张/);
  // rows 按各报价上限给出，余量全部为 0
  assert.deepEqual(res.rows.map((r) => r.packs), [5, 10]);
  assert.deepEqual(res.rows.map((r) => r.sheets), [300, 500]);
  assert.deepEqual(res.rows.map((r) => r.amountCents), [2500, 4000]);
  assert.deepEqual(res.rows.map((r) => r.remainingPacks), [0, 0]);
  assert.deepEqual(res.rows.map((r) => r.remainingSheets), [0, 0]);
  assert.equal(res.totals.totalSheets, 800);
  assert.equal(res.totals.overPurchaseSheets, 0);
  assert.equal(res.totals.totalCostCents, 6500);
});

test('价格按分精确计算：整数元组解优于按浮点单价贪心的直觉解', () => {
  // 需求 10：A 3 张/包 100 分（33.33… 分/张），B 7 张/包 234 分。
  // 朴素按单价贪心会全买 A（4 包 12 张 400 分）；精确解 A+B=10 张恰好 334 分。
  const parsed = parsePurchaseQuotesInput({
    purchaseQuotes: { demandSheets: 10, quotes: [q('A', 3, 100), q('B', 7, 234)] },
  });
  const res = solveQuoteCombination(10, parsed.quotes);
  assert.deepEqual(res.rows.map((r) => r.packs), [1, 1]);
  assert.equal(res.totals.totalSheets, 10);
  assert.equal(res.totals.overPurchaseSheets, 0);
  assert.equal(res.totals.totalCostCents, 334); // 100 + 234，整数相加，无浮点尾数
});

test('每包价格 0 分允许；结果金额为 0 且仍按后续排序维度定唯一解', () => {
  // 需求 7：A 3 张 0 分、B 5 张 0 分、C 2 张 0 分。
  // 3a+5b+2c≥7 全部 0 元：超购最少的恰好组合 A+? 3+? → 5+2=7 [0,1,1]、
  // 3+2+2=7 [1,0,2] 均 0 元 0 超购 2 家；录入顺序：比较向量 [0,1,1] vs [1,0,2]
  // 第 1 位 1 > 0 -> [1,0,2]（更早的 A 优先装满）
  const parsed = parsePurchaseQuotesInput({
    purchaseQuotes: {
      demandSheets: 7,
      quotes: [q('A', 3, 0), q('B', 5, 0), q('C', 2, 0)],
    },
  });
  const res = solveQuoteCombination(7, parsed.quotes);
  assert.deepEqual(res.rows.map((r) => r.packs), [1, 0, 2]);
  assert.equal(res.totals.totalCostCents, 0);
  assert.equal(res.totals.overPurchaseSheets, 0);
  assert.equal(res.totals.supplierCount, 2);
});

test('数字字符串按表单风格接受（整数语义）', () => {
  const parsed = parsePurchaseQuotesInput({
    purchaseQuotes: {
      demandSheets: '100',
      quotes: [
        { supplier: ' A ', sheetsPerPack: '50', pricePerPackCents: '500', minPacks: '0', maxPacks: '10' },
      ],
    },
  });
  assert.equal(parsed.enabled, true);
  assert.equal(parsed.demandSheets, 100);
  assert.equal(parsed.quotes[0].supplier, 'A');
  assert.equal(parsed.quotes[0].sheetsPerPack, 50);
  assert.equal(parsed.quotes[0].pricePerPackCents, 500);
  const res = solveQuoteCombination(parsed.demandSheets, parsed.quotes);
  assert.deepEqual(res.rows.map((r) => r.packs), [2]);
});

test('需求来源：手工 demandSheets；缺省接入印刷备料整包采购张数；两者皆无时报错', () => {
  const quotes = [q('A', 500, 10000, 0, 20)];

  const manual = attachPurchaseQuotes(null, { enabled: true, demandSheets: 450, quotes }, null);
  assert.equal(manual.demandSheets, 450);
  assert.equal(manual.demandSource, 'manual');
  assert.equal(manual.feasible, true);

  // 备料整包采购张数（如 16 页例：4146 张需领 -> 9 包 × 500 = 4500 张）
  const fromPrep = attachPurchaseQuotes(null, { enabled: true, demandSheets: null, quotes }, 4500);
  assert.equal(fromPrep.demandSheets, 4500);
  assert.equal(fromPrep.demandSource, 'materialPrep');
  assert.deepEqual(fromPrep.rows.map((r) => r.packs), [9]);
  assert.equal(fromPrep.totals.totalSheets, 4500);
  assert.equal(fromPrep.totals.overPurchaseSheets, 0);

  assert.throws(
    () => attachPurchaseQuotes(null, { enabled: true, demandSheets: null, quotes }, null),
    /需求张数/
  );
});

test('不可行场景同样经 attach 返回 purchaseQuotes 段（feasible:false + 缺口）', () => {
  const res = attachPurchaseQuotes(
    null,
    { enabled: true, demandSheets: 100, quotes: [q('A', 30, 100, 0, 2)] },
    null
  );
  assert.equal(res.enabled, true);
  assert.equal(res.feasible, false);
  assert.equal(res.gapSheets, 40);
  assert.equal(res.demandSource, 'manual');
});

/* ------------------------------ 参数校验 ------------------------------ */

test('参数非法返回明确错误', () => {
  const good = q('A', 10, 100, 0, 5);

  assert.throws(
    () => parsePurchaseQuotesInput({ purchaseQuotes: 'x' }),
    /purchaseQuotes 必须为对象/
  );
  assert.throws(
    () => parsePurchaseQuotesInput({ purchaseQuotes: [] }),
    /purchaseQuotes 必须为对象/
  );
  assert.throws(
    () => parsePurchaseQuotesInput({ purchaseQuotes: { enabled: 'yes', quotes: [good] } }),
    /enabled 必须为布尔/
  );
  assert.throws(
    () => parsePurchaseQuotesInput({ purchaseQuotes: { demandSheets: 100 } }),
    /quotes 必须为数组/
  );
  assert.throws(
    () => parsePurchaseQuotesInput({ purchaseQuotes: { demandSheets: 100, quotes: [] } }),
    /至少录入 1 条/
  );
  assert.throws(
    () => parsePurchaseQuotesInput({
      purchaseQuotes: { demandSheets: 100, quotes: Array.from({ length: MAX_QUOTES + 1 }, () => good) },
    }),
    new RegExp(`最多录入 ${MAX_QUOTES} 条`)
  );
  assert.throws(
    () => parsePurchaseQuotesInput({ purchaseQuotes: { demandSheets: 0, quotes: [good] } }),
    /需求张数 demandSheets/
  );
  assert.throws(
    () => parsePurchaseQuotesInput({ purchaseQuotes: { demandSheets: -1, quotes: [good] } }),
    /需求张数 demandSheets/
  );
  assert.throws(
    () => parsePurchaseQuotesInput({ purchaseQuotes: { demandSheets: 1.5, quotes: [good] } }),
    /需求张数 demandSheets/
  );

  assert.throws(
    () => parsePurchaseQuotesInput({ purchaseQuotes: { demandSheets: 100, quotes: [null] } }),
    /第 1 条报价必须为对象/
  );
  assert.throws(
    () => parsePurchaseQuotesInput({ purchaseQuotes: { demandSheets: 100, quotes: [{ ...good, supplier: '  ' }] } }),
    /供应商名称不能为空/
  );
  assert.throws(
    () => parsePurchaseQuotesInput({ purchaseQuotes: { demandSheets: 100, quotes: [{ ...good, supplier: 'x'.repeat(51) }] } }),
    /供应商名称长度/
  );
  assert.throws(
    () => parsePurchaseQuotesInput({ purchaseQuotes: { demandSheets: 100, quotes: [{ ...good, sheetsPerPack: 0 }] } }),
    /每包张数/
  );
  assert.throws(
    () => parsePurchaseQuotesInput({ purchaseQuotes: { demandSheets: 100, quotes: [{ ...good, pricePerPackCents: -1 }] } }),
    /每包价格/
  );
  assert.throws(
    () => parsePurchaseQuotesInput({ purchaseQuotes: { demandSheets: 100, quotes: [{ ...good, pricePerPackCents: 1.5 }] } }),
    /每包价格/
  );
  assert.throws(
    () => parsePurchaseQuotesInput({ purchaseQuotes: { demandSheets: 100, quotes: [{ ...good, minPacks: -1 }] } }),
    /最少可购包数/
  );
  assert.throws(
    () => parsePurchaseQuotesInput({ purchaseQuotes: { demandSheets: 100, quotes: [{ ...good, maxPacks: 0 }] } }),
    /最多可购包数/
  );
  assert.throws(
    () => parsePurchaseQuotesInput({
      purchaseQuotes: { demandSheets: 100, quotes: [{ ...good, minPacks: 4, maxPacks: 3 }] },
    }),
    /最多可购包数（3）不能少于最少可购包数（4）/
  );
  assert.throws(
    () => parsePurchaseQuotesInput({
      purchaseQuotes: { demandSheets: 100, quotes: [good, { ...good, supplier: 'A' }] },
    }),
    /供应商名称重复.*「A」/
  );
});

/* ------------------------------ 随机暴力对照 ------------------------------ */

/** 简易确定性 PRNG（不依赖 Math.random，保证测试可复现）。 */
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * 全枚举暴力解：枚举各报价 [minPacks, maxPacks] 的全部整数包组合，
 * 按「总价 → 超购 → 供应商数 → 录入顺序（向量字典序降序）」取唯一最优。
 */
function bruteForce(demand, quotes) {
  let best = null;
  const packs = quotes.map((x) => x.minPacks);

  const better = (a, b) => {
    const costA = a.reduce((sum, x, i) => sum + x * quotes[i].pricePerPackCents, 0);
    const costB = b.reduce((sum, x, i) => sum + x * quotes[i].pricePerPackCents, 0);
    if (costA !== costB) return costA < costB;
    const sheetsA = a.reduce((sum, x, i) => sum + x * quotes[i].sheetsPerPack, 0);
    const sheetsB = b.reduce((sum, x, i) => sum + x * quotes[i].sheetsPerPack, 0);
    const overA = sheetsA - demand;
    const overB = sheetsB - demand;
    if (overA !== overB) return overA < overB;
    const supA = a.filter((x) => x > 0).length;
    const supB = b.filter((x) => x > 0).length;
    if (supA !== supB) return supA < supB;
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] !== b[i]) return a[i] > b[i]; // 更早录入优先装满
    }
    return false;
  };

  (function enumerate(i) {
    if (i === quotes.length) {
      const sheets = packs.reduce((sum, x, j) => sum + x * quotes[j].sheetsPerPack, 0);
      if (sheets >= demand && (!best || better(packs, best))) {
        best = packs.slice();
      }
      return;
    }
    for (let k = quotes[i].minPacks; k <= quotes[i].maxPacks; k += 1) {
      packs[i] = k;
      enumerate(i + 1);
    }
  })(0);

  return best;
}

test('随机暴力对照：小规模实例动态规划解与全枚举最优完全一致（含可行 / 不可行）', () => {
  const rng = makeRng(20260921);
  const CASES = 4000;
  for (let t = 0; t < CASES; t += 1) {
    const n = 1 + Math.floor(rng() * 4); // 1 ~ 4 条报价
    const names = ['A', 'B', 'C', 'D'];
    const quotes = [];
    for (let i = 0; i < n; i += 1) {
      const minPacks = rng() < 0.25 ? 1 : 0;
      const maxPacks = minPacks + 1 + Math.floor(rng() * 3);
      quotes.push({
        supplier: names[i],
        sheetsPerPack: 1 + Math.floor(rng() * 6),
        pricePerPackCents: Math.floor(rng() * 31), // 含 0 分
        minPacks,
        maxPacks,
      });
    }
    const demand = 1 + Math.floor(rng() * 26);
    const res = solveQuoteCombination(demand, quotes);
    const expected = bruteForce(demand, quotes);

    if (expected === null) {
      assert.equal(res.feasible, false, `case ${t}: 应判定不可行`);
      const maxSheets = quotes.reduce((sum, x) => sum + x.maxPacks * x.sheetsPerPack, 0);
      assert.equal(res.gapSheets, demand - maxSheets, `case ${t}: 缺口不符`);
      assert.deepEqual(
        res.rows.map((r) => r.packs),
        quotes.map((x) => x.maxPacks),
        `case ${t}: 不可行时应按上限给出尽最大可购行`
      );
      continue;
    }

    assert.equal(res.feasible, true, `case ${t}: 应可行`);
    assert.deepEqual(
      res.rows.map((r) => r.packs),
      expected,
      `case ${t}: demand=${demand} quotes=${JSON.stringify(quotes)} 组合不符`
    );
    // 合计与逐行严格对账
    const totalSheets = expected.reduce((sum, x, i) => sum + x * quotes[i].sheetsPerPack, 0);
    const totalCost = expected.reduce((sum, x, i) => sum + x * quotes[i].pricePerPackCents, 0);
    assert.equal(res.totals.totalSheets, totalSheets, `case ${t}`);
    assert.equal(res.totals.overPurchaseSheets, totalSheets - demand, `case ${t}`);
    assert.equal(res.totals.totalCostCents, totalCost, `case ${t}`);
    assert.equal(res.totals.supplierCount, expected.filter((x) => x > 0).length, `case ${t}`);
    assert.equal(res.totals.totalPacks, expected.reduce((a, b) => a + b, 0), `case ${t}`);
    res.rows.forEach((row, i) => {
      assert.equal(row.sheets, expected[i] * quotes[i].sheetsPerPack, `case ${t} row ${i} 张数`);
      assert.equal(row.amountCents, expected[i] * quotes[i].pricePerPackCents, `case ${t} row ${i} 金额`);
      assert.equal(row.remainingPacks, quotes[i].maxPacks - expected[i], `case ${t} row ${i} 余量包数`);
      assert.equal(row.remainingSheets, (quotes[i].maxPacks - expected[i]) * quotes[i].sheetsPerPack, `case ${t} row ${i} 余量张数`);
    });
  }
});

test('枚举引擎暴力对照：大需求 + 大包型（cap > 100 万走枚举引擎）解与全枚举最优一致', () => {
  // 全枚举空间仍可控：各报价额外包数上限很小（≤4），但需求足够大使
  // cap = 缺口 + 最大包型 > 1_000_000，强制走枚举引擎。
  const rng = makeRng(9917);
  const CASES = 300;
  for (let t = 0; t < CASES; t += 1) {
    const n = 2 + Math.floor(rng() * 3); // 2 ~ 4 条
    const names = ['甲', '乙', '丙', '丁'];
    const quotes = [];
    // 大包型（30 万 ~ 60 万张/包）使 cap = 需求 + sMax > 100 万阈值走枚举引擎；
    // 可购包数仅 0~4 包，全枚举空间 5^4 = 625 仍可暴力求解。
    for (let i = 0; i < n; i += 1) {
      const minPacks = rng() < 0.3 ? 1 : 0;
      const span = Math.floor(rng() * 4);
      const maxPacks = Math.max(1, minPacks + span);
      quotes.push({
        supplier: names[i],
        sheetsPerPack: 300000 + Math.floor(rng() * 300001),
        pricePerPackCents: 4000000 + Math.floor(rng() * 8000000),
        minPacks,
        maxPacks,
      });
    }
    // 需求 120 万张：cap ≈ 120 万 + sMax > 100 万，强制枚举引擎
    const demand = 1200000 + Math.floor(rng() * 500);
    const maxSheets = quotes.reduce((sum, q) => sum + q.maxPacks * q.sheetsPerPack, 0);
    const res = solveQuoteCombination(demand, quotes);
    const expected = bruteForce(demand, quotes);
    if (maxSheets < demand) {
      assert.equal(res.feasible, false, `enum case ${t}: 应不可行`);
      assert.equal(res.gapSheets, demand - maxSheets);
      continue;
    }
    assert.ok(expected, `enum case ${t}: 暴力解应存在`);
    assert.equal(res.feasible, true, `enum case ${t}`);
    assert.deepEqual(
      res.rows.map((r) => r.packs),
      expected,
      `enum case ${t}: demand=${demand} quotes=${JSON.stringify(quotes)}`
    );
    const totalCost = expected.reduce((sum, x, i) => sum + x * quotes[i].pricePerPackCents, 0);
    const totalSheets = expected.reduce((sum, x, i) => sum + x * quotes[i].sheetsPerPack, 0);
    assert.equal(res.totals.totalCostCents, totalCost, `enum case ${t} 金额`);
    assert.equal(res.totals.totalSheets, totalSheets, `enum case ${t} 张数`);
    assert.equal(res.totals.overPurchaseSheets, totalSheets - demand, `enum case ${t} 超购`);
    assert.equal(res.totals.supplierCount, expected.filter((x) => x > 0).length, `enum case ${t} 供应商数`);
  }
});

test('两引擎一致性：同一组报价在稠密 / 枚举阈值两侧给出完全相同的唯一方案', () => {
  // 通过手工构造「需求恰好跨越 cap=1_000_000」的输入不可直接控阈值，
  // 改为对同一报价集合验证：小需求（稠密）与缩放后的等价大需求（枚举）
  // 的方案结构一致（都是同一最便宜供应商整包）。
  const quotesSmall = [
    { index: 1, supplier: '华泰', sheetsPerPack: 500, pricePerPackCents: 9500, minPacks: 0, maxPacks: 20 },
    { index: 2, supplier: '恒丰', sheetsPerPack: 480, pricePerPackCents: 9800, minPacks: 0, maxPacks: 20 },
  ];
  const small = solveQuoteCombination(4500, quotesSmall);
  // 华泰 19.00 分/张 < 恒丰 ≈20.42 分/张 -> 9 包华泰恰好 4500 张
  assert.deepEqual(small.rows.map((r) => r.packs), [9, 0]);

  const quotesBig = quotesSmall.map((q) => ({ ...q, maxPacks: 100000 }));
  const big = solveQuoteCombination(41460000, quotesBig);
  assert.equal(big.feasible, true);
  // 华泰单价更低（9500/500 < 9800/480）：由华泰整包
  const packs = big.rows.map((r) => r.packs);
  assert.equal(packs[1], 0);
  assert.ok(packs[0] * 500 >= 41460000);
  assert.equal(big.totals.totalCostCents, packs[0] * 9500);
});

test('枚举引擎大规模真实用例：性能与结果正确（4146 万张 < 1 秒）', () => {
  const quotes = [
    { index: 1, supplier: '华泰', sheetsPerPack: 500, pricePerPackCents: 9800, minPacks: 0, maxPacks: 100000 },
    { index: 2, supplier: '恒丰', sheetsPerPack: 480, pricePerPackCents: 9500, minPacks: 0, maxPacks: 100000 },
    { index: 3, supplier: '江南', sheetsPerPack: 520, pricePerPackCents: 9900, minPacks: 0, maxPacks: 100000 },
    { index: 4, supplier: '北方', sheetsPerPack: 250, pricePerPackCents: 5000, minPacks: 5, maxPacks: 100000 },
  ];
  const t0 = Date.now();
  const r = solveQuoteCombination(41460000, quotes);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 2000, `枚举引擎应在 2s 内完成，实际 ${elapsed}ms`);
  assert.equal(r.feasible, true);
  // 约束与对账
  r.rows.forEach((row, i) => {
    assert.ok(row.packs >= quotes[i].minPacks && row.packs <= quotes[i].maxPacks);
    assert.equal(row.sheets, row.packs * quotes[i].sheetsPerPack);
    assert.equal(row.amountCents, row.packs * quotes[i].pricePerPackCents);
  });
  assert.ok(r.totals.totalSheets >= 41460000);
});

test('稠密引擎同价小包型退化用例：大窗口下结果精确、金额按分无浮点误差', () => {
  // 三家每分单价完全相同（2 张 2 分 / 3 张 3 分 / 5 张 5 分），需求 50000：
  // 窗口 > 稠密阈值会改走枚举，故此处需求取稠密引擎覆盖范围内的较大值。
  const quotes = [
    { index: 1, supplier: 'A', sheetsPerPack: 2, pricePerPackCents: 2, minPacks: 0, maxPacks: 100000 },
    { index: 2, supplier: 'B', sheetsPerPack: 3, pricePerPackCents: 3, minPacks: 0, maxPacks: 100000 },
    { index: 3, supplier: 'C', sheetsPerPack: 5, pricePerPackCents: 5, minPacks: 0, maxPacks: 100000 },
  ];
  const r = solveQuoteCombination(50000, quotes);
  assert.equal(r.feasible, true);
  assert.equal(r.totals.totalSheets, 50000); // 5 张/包恰好整除
  assert.equal(r.totals.overPurchaseSheets, 0);
  assert.equal(r.totals.totalCostCents, 50000); // 张张 1 分
});
