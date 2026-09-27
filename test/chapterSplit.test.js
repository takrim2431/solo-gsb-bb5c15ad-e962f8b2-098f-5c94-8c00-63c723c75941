'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeImposition } = require('../src/imposition');

/* ------------------------------ 测试辅助 ------------------------------ */

const BASE = { binding: 'left', flip: 'short' };

/** 章节优先分帖快捷调用。 */
function chapterImpose(totalPages, sheetsPerSignature, chapterStarts, extra = {}) {
  return computeImposition({
    totalPages,
    sheetsPerSignature,
    chapterSplit: true,
    chapterStarts,
    ...BASE,
    ...extra,
  });
}

/** 各帖 [pageStart, pageEnd, actualSheetCount, blankPages]。 */
function sigRanges(r) {
  return r.signatures.map((s) => [s.pageStart, s.pageEnd, s.actualSheetCount, s.blankPages]);
}

/** 收集拼版结果中的全部页位（每张纸正反 × 左右）。 */
function allSlotsOf(r) {
  const slots = [];
  r.signatures.forEach((sig) => {
    sig.sheets.forEach((sheet) => {
      slots.push(sheet.front.left, sheet.front.right, sheet.back.left, sheet.back.right);
    });
  });
  return slots;
}

/**
 * 由帖对象还原帖内页位序列（左装订 + 短边翻转布局的逆变换）：
 * 第 i 张纸 front.right = slots[2i]，back.left = slots[2i+1]，
 * front.left = slots[len-1-2i]，back.right = slots[len-2-2i]。
 */
function slotsOfSig(sig) {
  const len = sig.actualSheetCount * 4;
  const slots = new Array(len);
  sig.sheets.forEach((sheet, i) => {
    slots[2 * i] = sheet.front.right;
    slots[2 * i + 1] = sheet.back.left;
    slots[len - 1 - 2 * i] = sheet.front.left;
    slots[len - 2 - 2 * i] = sheet.back.right;
  });
  return slots;
}

/**
 * 独立暴力实现（记忆化递归 + 完整方案比较器），用于交叉验证 DP 结果：
 * 费用按 (拆分次数, 补白页数, 帖数) 字典序比较，仍并列时按边界序列
 * 「前帖优先装满」（逐位比较，边界更大者优先）。
 */
function bruteForcePlan(totalPages, maxSheets, starts) {
  const ends = new Set(starts.map((s, i) => (i + 1 < starts.length ? starts[i + 1] - 1 : totalPages)));
  const maxPages = maxSheets * 4;
  const memo = new Map();
  function better(costA, boundsA, costB, boundsB) {
    for (let i = 0; i < 3; i++) {
      if (costA[i] !== costB[i]) return costA[i] < costB[i];
    }
    for (let i = 0; i < Math.min(boundsA.length, boundsB.length); i++) {
      if (boundsA[i] !== boundsB[i]) return boundsA[i] > boundsB[i];
    }
    return false;
  }
  function solve(p) {
    if (p > totalPages) return { cost: [0, 0, 0], bounds: [] };
    if (memo.has(p)) return memo.get(p);
    let best = null;
    for (let q = p; q <= Math.min(totalPages, p + maxPages - 1); q++) {
      const len = q - p + 1;
      const isEnd = ends.has(q);
      let pad;
      if (isEnd) {
        pad = (4 - (len % 4)) % 4;
      } else {
        if (len % 4 !== 0) continue;
        pad = 0;
      }
      const rest = solve(q + 1);
      const cost = [rest.cost[0] + (isEnd ? 0 : 1), rest.cost[1] + pad, rest.cost[2] + 1];
      const bounds = [q, ...rest.bounds];
      if (!best || better(cost, bounds, best.cost, best.bounds)) {
        best = { cost, bounds };
      }
    }
    memo.set(p, best);
    return best;
  }
  return solve(1);
}

/** 可复现的伪随机数（mulberry32）。 */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------ 基本规划 ------------------------------ */

test('章节优先分帖：每章一帖，章末补白', () => {
  // 章 1–3 / 4–6 / 7–9，上限 1 张：无法合并（合并后超上限），每章一帖、章末各补 1 页
  const r = chapterImpose(9, 1, [1, 4, 7]);
  assert.equal(r.chapters.enabled, true);
  assert.equal(r.signatureCount, 3);
  assert.deepEqual(sigRanges(r), [[1, 3, 1, 1], [4, 6, 1, 1], [7, 9, 1, 1]]);
  assert.equal(r.chapters.splitCount, 0);
  assert.deepEqual(r.chapters.splitChapters, []);
  assert.equal(r.blankPages, 3);
  // 章 1–6 / 7–12，上限 2 张：合并后 12 页超上限，各章独立成帖、章末各补 2 页
  const r2 = chapterImpose(12, 2, [1, 7]);
  assert.deepEqual(sigRanges(r2), [[1, 6, 2, 2], [7, 12, 2, 2]]);
  assert.equal(r2.blankPages, 4);
  assert.equal(r2.chapters.splitCount, 0);
});

test('章节优先分帖：合并相邻章节以减少补白', () => {
  // 章 1–8 / 9–12 / 13–16 / 17–20：逐章一帖需补 12 页；
  // 合并为 [1–8] [9–16] [17–20] 后 0 拆分、0 补白、3 帖
  const r = chapterImpose(20, 2, [1, 9, 13, 17]);
  assert.deepEqual(sigRanges(r), [[1, 8, 2, 0], [9, 16, 2, 0], [17, 20, 1, 0]]);
  assert.equal(r.chapters.splitCount, 0);
  assert.equal(r.blankPages, 0);
  assert.equal(r.paddedPages, 20);
  // 各帖覆盖章节
  assert.deepEqual(r.signatures.map((s) => s.chapters.map((c) => c.index)), [[1], [2, 3], [4]]);
});

test('章节优先分帖：拆分次数优先于补白页数', () => {
  // 章 1–5 / 6–12，上限 1 张（4 页）：第 1 章 5 页 > 4 页必须拆分；
  // [1–4][5]+3 [6–9][10–12]+1（拆分 2 次、补 4 页）不如 [1–4][5–8][9–12]（拆分 2 次、补 0 页）
  const r = chapterImpose(12, 1, [1, 6]);
  assert.deepEqual(sigRanges(r), [[1, 4, 1, 0], [5, 8, 1, 0], [9, 12, 1, 0]]);
  assert.equal(r.chapters.splitCount, 2);
  assert.deepEqual(r.chapters.splitChapters, [1, 2]);
  assert.equal(r.blankPages, 0);
});

test('章节优先分帖：补白页数优先于帖数', () => {
  // 章 1–8 / 9–13 / 14–17 / 18–20：0 拆分的方案中
  // [1–8][9–13]+3 [14–20]+1（补 4 页、3 帖）优于逐章一帖（补 8 页、4 帖）
  const r = chapterImpose(20, 2, [1, 9, 14, 18]);
  assert.deepEqual(sigRanges(r), [[1, 8, 2, 0], [9, 13, 2, 3], [14, 20, 2, 1]]);
  assert.equal(r.chapters.splitCount, 0);
  assert.equal(r.blankPages, 4);
  assert.equal(r.signatureCount, 3);
});

test('章节优先分帖：帖数最少（全书能装入一帖时不拆帖）', () => {
  // 章 1–3 / 4–10，上限 3 张（12 页）：全书 10 页可装入一帖（补 2 页），
  // 优于 [1–3]+1、[4–10]+1（同为 0 拆分、补 2 页，但 2 帖）
  const r = chapterImpose(10, 3, [1, 4]);
  assert.deepEqual(sigRanges(r), [[1, 10, 3, 2]]);
  assert.equal(r.signatureCount, 1);
  assert.equal(r.chapters.splitCount, 0);
  assert.equal(r.blankPages, 2);
});

test('章节优先分帖：前帖优先装满（唯一 tie-break）', () => {
  // 章 1–4 / 5–12 / 13–16，上限 3 张：[1–4][5–16] 与 [1–12][13–16]
  // 同为 0 拆分、0 补白、2 帖 -> 前帖优先装满，选 [1–12][13–16]
  const r = chapterImpose(16, 3, [1, 5, 13]);
  assert.deepEqual(sigRanges(r), [[1, 12, 3, 0], [13, 16, 1, 0]]);
  assert.equal(r.chapters.splitCount, 0);
  assert.equal(r.blankPages, 0);
});

test('章节优先分帖：超长章强制拆分，拆分处恰好整数张、无帖内补白', () => {
  // 单章 20 页、上限 1 张：只能按 4 页一帖切开
  const r = chapterImpose(20, 1, [1]);
  assert.deepEqual(sigRanges(r), [[1, 4, 1, 0], [5, 8, 1, 0], [9, 12, 1, 0], [13, 16, 1, 0], [17, 20, 1, 0]]);
  assert.equal(r.chapters.splitCount, 4);
  assert.deepEqual(r.chapters.splitChapters, [1]);
  assert.equal(r.blankPages, 0);
});

test('章节优先分帖：首个起始页不为 1 时自动补第 1 章（从第 1 页起）', () => {
  const r = chapterImpose(12, 2, [5, 9]);
  assert.deepEqual(r.chapters.starts, [1, 5, 9]);
  assert.deepEqual(r.chapters.list, [
    { index: 1, pageStart: 1, pageEnd: 4 },
    { index: 2, pageStart: 5, pageEnd: 8 },
    { index: 3, pageStart: 9, pageEnd: 12 },
  ]);
  // 章 1–4 / 5–8 合并一帖，章 9–12 一帖：0 拆分、0 补白
  assert.deepEqual(sigRanges(r), [[1, 8, 2, 0], [9, 12, 1, 0]]);
});

/* ------------------------------ 页位布局与连续性 ------------------------------ */

test('章节优先分帖：章末帖内补白位置正确，后续真实页码连续进入下一帖', () => {
  // [1–8] [9–13]+3 [14–20]+1
  const r = chapterImpose(20, 2, [1, 9, 14, 18]);
  // 逐帖还原页位序列：真实页连续占前部，补白集中在帖尾
  const expectedSlots = [
    [1, 2, 3, 4, 5, 6, 7, 8],
    [9, 10, 11, 12, 13, null, null, null],
    [14, 15, 16, 17, 18, 19, 20, null],
  ];
  r.signatures.forEach((sig, i) => {
    const pages = slotsOfSig(sig).map((s) => (s.blank ? null : s.page));
    assert.deepEqual(pages, expectedSlots[i]);
  });
  // 跨帖真实页码连续：每帖首页 = 上帖末页 + 1
  r.signatures.forEach((sig, i) => {
    if (i > 0) assert.equal(sig.pageStart, r.signatures[i - 1].pageEnd + 1);
  });
  assert.equal(r.signatures[0].pageStart, 1);
  assert.equal(r.signatures[r.signatures.length - 1].pageEnd, 20);
  // 非空白页恰好为 1..20 各一次
  const printed = allSlotsOf(r).filter((s) => !s.blank).map((s) => s.page).sort((a, b) => a - b);
  assert.deepEqual(printed, Array.from({ length: 20 }, (_, i) => i + 1));
});

test('章节优先分帖：第 2 帖第 1 张的具体页位（左装订短边翻转）', () => {
  const r = chapterImpose(20, 2, [1, 9, 14, 18]);
  const sig2 = r.signatures[1]; // 真实页 9–13，补 3 页
  assert.deepEqual([sig2.pageStart, sig2.pageEnd], [9, 13]);
  const [s1, s2] = sig2.sheets;
  // 第 1 张：正面 [空白, 9]，背面 [10, 空白]
  assert.equal(s1.front.left.blank, true);
  assert.equal(s1.front.right.page, 9);
  assert.equal(s1.back.left.page, 10);
  assert.equal(s1.back.right.blank, true);
  // 第 2 张：正面 [空白, 11]，背面 [12, 13]
  assert.equal(s2.front.left.blank, true);
  assert.equal(s2.front.right.page, 11);
  assert.equal(s2.back.left.page, 12);
  assert.equal(s2.back.right.page, 13);
  // 第 3 帖（14–20，补 1 页）首页正确衔接
  const sig3 = r.signatures[2];
  assert.equal(sig3.pageStart, 14);
  assert.equal(sig3.sheets[0].front.right.page, 14);
  assert.equal(sig3.sheets[0].front.left.blank, true); // 唯一补白页在帖尾大号页位
});

test('章节优先分帖：右装订 + 长边翻转下页位仍正确', () => {
  const r = chapterImpose(20, 2, [1, 9, 14, 18], { binding: 'right', flip: 'long' });
  const sig2 = r.signatures[1]; // 9–13 + 3 补白
  const [s1] = sig2.sheets;
  // 右装订：第 9 页在正面左页位；长边翻转背面左右页位不变
  assert.equal(s1.front.left.page, 9);
  assert.equal(s1.front.right.blank, true);
  assert.equal(s1.back.left.page, 10);
  assert.equal(s1.back.right.blank, true);
  // 真实页仍恰好覆盖 1..20
  const printed = allSlotsOf(r).filter((s) => !s.blank).map((s) => s.page).sort((a, b) => a - b);
  assert.deepEqual(printed, Array.from({ length: 20 }, (_, i) => i + 1));
});

/* ------------------------------ 汇总与元数据 ------------------------------ */

test('章节优先分帖：顶层 chapters 汇总与每帖 chapters 标注', () => {
  const r = chapterImpose(20, 2, [1, 9, 14, 18]);
  assert.equal(r.chapters.enabled, true);
  assert.deepEqual(r.chapters.starts, [1, 9, 14, 18]);
  assert.equal(r.chapters.count, 4);
  assert.deepEqual(r.chapters.list, [
    { index: 1, pageStart: 1, pageEnd: 8 },
    { index: 2, pageStart: 9, pageEnd: 13 },
    { index: 3, pageStart: 14, pageEnd: 17 },
    { index: 4, pageStart: 18, pageEnd: 20 },
  ]);
  assert.equal(r.chapters.splitCount, 0);
  assert.deepEqual(r.chapters.splitChapters, []);
  assert.equal(r.chapters.maxSheetsPerSignature, 2);
  assert.deepEqual(r.chapters.actualSheetCounts, [2, 2, 2]);
  // 每帖覆盖章节
  assert.deepEqual(
    r.signatures.map((s) => s.chapters.map((c) => [c.index, c.pageStart, c.pageEnd])),
    [[[1, 1, 8]], [[2, 9, 13]], [[3, 14, 17], [4, 18, 20]]]
  );
  // 输入回显
  assert.equal(r.input.chapterSplit, true);
  assert.deepEqual(r.input.chapterStarts, [1, 9, 14, 18]);
  // 与均衡分帖互斥：balanced 保持关闭
  assert.deepEqual(r.balanced, { enabled: false });
});

test('章节优先分帖：被拆分章节在 splitChapters 中正确标注', () => {
  const r = chapterImpose(12, 1, [1, 6]);
  assert.equal(r.chapters.splitCount, 2);
  assert.deepEqual(r.chapters.splitChapters, [1, 2]);
  // 每帖仍标注其覆盖的章节
  assert.deepEqual(r.signatures.map((s) => s.chapters.map((c) => c.index)), [[1], [1, 2], [2]]);
});

/* ------------------------------ 参数校验 ------------------------------ */

test('章节优先分帖：非法、重复、越界起始页均返回明确错误', () => {
  const N = 12;
  // 非数组 / 空数组 / 缺省
  assert.throws(() => chapterImpose(N, 2, undefined), /非空数组/);
  assert.throws(() => chapterImpose(N, 2, []), /非空数组/);
  assert.throws(() => chapterImpose(N, 2, 'not-array'), /非空数组/);
  // 非整数
  assert.throws(() => chapterImpose(N, 2, [1, 2.5]), /整数/);
  assert.throws(() => chapterImpose(N, 2, [1, 'x']), /整数/);
  assert.throws(() => chapterImpose(N, 2, [1, null]), /整数/);
  // 越界
  assert.throws(() => chapterImpose(N, 2, [0]), /超出范围/);
  assert.throws(() => chapterImpose(N, 2, [-3]), /超出范围/);
  assert.throws(() => chapterImpose(N, 2, [1, 13]), /超出范围/);
  // 重复
  assert.throws(() => chapterImpose(N, 2, [3, 3]), /重复：3/);
  assert.throws(() => chapterImpose(N, 2, [1, 5, 5, 9]), /重复：5/);
  // 未递增
  assert.throws(() => chapterImpose(N, 2, [5, 2]), /严格递增/);
  assert.throws(() => chapterImpose(N, 2, [1, 9, 5]), /严格递增/);
});

test('章节优先分帖：开关必须为布尔值，且与均衡分帖互斥', () => {
  assert.throws(
    () => computeImposition({ totalPages: 8, sheetsPerSignature: 2, ...BASE, chapterSplit: 'yes', chapterStarts: [1] }),
    /章节优先分帖开关必须为布尔值/
  );
  assert.throws(
    () => computeImposition({ totalPages: 8, sheetsPerSignature: 2, ...BASE, chapterSplit: 1, chapterStarts: [1] }),
    /章节优先分帖开关必须为布尔值/
  );
  assert.throws(
    () => computeImposition({ totalPages: 8, sheetsPerSignature: 2, ...BASE, chapterSplit: true, balancedSplit: true, chapterStarts: [1] }),
    /不能同时启用/
  );
});

test('关闭章节优先分帖时：chapterStarts 被忽略，固定 / 均衡分帖结果不变', () => {
  const common = { totalPages: 23, sheetsPerSignature: 3, ...BASE, paperThickness: 0.1, maxCompensation: 1 };
  // 固定分帖：提供 chapterStarts 但不开启章节模式 -> 与缺省完全一致
  const fixedBase = computeImposition(common);
  const fixedIgnored = computeImposition({ ...common, chapterStarts: [1, 5, 9] });
  const fixedOff = computeImposition({ ...common, chapterSplit: false, chapterStarts: [1, 5, 9] });
  [fixedIgnored, fixedOff].forEach((r) => {
    delete r.meta.generatedAt;
    const base = JSON.parse(JSON.stringify(fixedBase));
    delete base.meta.generatedAt;
    assert.deepEqual(r, base);
    assert.deepEqual(r.chapters, { enabled: false });
    assert.deepEqual(r.input.chapterStarts, []);
  });
  // 均衡分帖：同样不受 chapterStarts 影响
  const balancedBase = computeImposition({ ...common, balancedSplit: true });
  const balancedIgnored = computeImposition({ ...common, balancedSplit: true, chapterStarts: [1, 5, 9] });
  delete balancedBase.meta.generatedAt;
  delete balancedIgnored.meta.generatedAt;
  assert.deepEqual(balancedIgnored, balancedBase);
  assert.equal(balancedIgnored.balanced.enabled, true);
  assert.deepEqual(balancedIgnored.chapters, { enabled: false });
});

/* ------------------------------ 与爬移 / 适配检查组合 ------------------------------ */

test('章节优先分帖：爬移补偿按各帖实际层数独立重算', () => {
  const r = chapterImpose(20, 2, [1, 9, 13, 17], { paperThickness: 0.1, maxCompensation: 5 });
  assert.equal(r.creep.enabled, true);
  assert.deepEqual(r.creep.sheetCompensationMm, [0, 0.2]); // 顶层仍按上限给出
  assert.deepEqual(r.signatures[0].sheetCompensationMm, [0, 0.2]);
  assert.deepEqual(r.signatures[1].sheetCompensationMm, [0, 0.2]);
  assert.deepEqual(r.signatures[2].sheetCompensationMm, [0]); // 末帖仅 1 张
  // 末帖唯一一张纸 i=0：偏移 0
  const only = r.signatures[2].sheets[0];
  assert.equal(only.front.left.offsetMm, 0);
  assert.equal(only.front.right.offsetMm, 0);
});

test('章节优先分帖：适配检查按实际页位统计（含章末补白页位）', () => {
  const r = chapterImpose(20, 2, [1, 9, 14, 18], {
    paperWidth: 440, paperHeight: 310, pageWidth: 210, pageHeight: 297, bleedMm: 3, safetyMm: 5,
  });
  assert.equal(r.fit.enabled, true);
  assert.equal(r.fit.totalSlots, 24); // 3 帖 × 2 张 × 4 页位
  assert.equal(r.fit.failCount, 0);
  allSlotsOf(r).forEach((s) => assert.ok(s.fit && s.fit.ok));
});

/* ------------------------------ 确定性与不变量 ------------------------------ */

test('章节优先分帖：同一输入规划结果唯一且确定', () => {
  const a = chapterImpose(30, 2, [1, 7, 13, 21]);
  const b = chapterImpose(30, 2, [1, 7, 13, 21]);
  delete a.meta.generatedAt;
  delete b.meta.generatedAt;
  assert.deepEqual(a, b);
});

test('章节优先分帖：穷举页数 / 上限 / 章节模式，约束与不变量恒成立', () => {
  const chapterPatterns = [
    (n) => [1], // 单章
    (n) => [1, Math.max(2, Math.ceil(n / 2))].filter((v, i, a) => v <= n && a.indexOf(v) === i), // 两章
    (n) => [1, 3, 7].filter((v) => v <= n), // 固定碎章
    (n) => Array.from({ length: n }, (_, i) => i + 1), // 每页一章
  ];
  for (let totalPages = 1; totalPages <= 48; totalPages++) {
    for (let maxSheets = 1; maxSheets <= 4; maxSheets++) {
      chapterPatterns.forEach((pattern) => {
        const starts = pattern(totalPages);
        const r = chapterImpose(totalPages, maxSheets, starts);
        // 每帖张数为整数且不超上限
        r.signatures.forEach((sig) => {
          assert.ok(sig.actualSheetCount >= 1 && sig.actualSheetCount <= maxSheets);
          assert.equal(sig.actualPageCount, sig.actualSheetCount * 4);
          assert.equal(sig.sheets.length, sig.actualSheetCount);
        });
        // 帖数与汇总一致
        assert.equal(r.signatureCount, r.signatures.length);
        assert.equal(r.paddedPages, r.signatures.reduce((sum, s) => sum + s.actualPageCount, 0));
        assert.equal(r.blankPages, r.paddedPages - totalPages);
        assert.equal(r.blankPages, r.signatures.reduce((sum, s) => sum + s.blankPages, 0));
        // 逐帖还原页位序列：真实页 = pageStart..pageEnd 连续占前部，补白只在帖尾
        r.signatures.forEach((sig) => {
          const realCount = sig.pageEnd - sig.pageStart + 1;
          const slots = slotsOfSig(sig);
          slots.forEach((slot, j) => {
            if (j < realCount) {
              assert.equal(slot.blank, false);
              assert.equal(slot.page, sig.pageStart + j);
            } else {
              assert.equal(slot.blank, true);
              assert.equal(slot.page, null);
            }
          });
        });
        // 跨帖真实页码连续：首页 = 1，末页 = totalPages，逐帖首尾相接
        assert.equal(r.signatures[0].pageStart, 1);
        assert.equal(r.signatures[r.signatures.length - 1].pageEnd, totalPages);
        r.signatures.forEach((sig, i) => {
          if (i > 0) assert.equal(sig.pageStart, r.signatures[i - 1].pageEnd + 1);
        });
        // 非空白页恰好覆盖 1..totalPages 各一次
        const printed = allSlotsOf(r).filter((s) => !s.blank).map((s) => s.page).sort((a, b) => a - b);
        assert.deepEqual(printed, Array.from({ length: totalPages }, (_, i) => i + 1));
        // 拆分次数 = 结尾落在章节中间（非章末、非书末）的帖数
        const ends = new Set(r.chapters.list.map((c) => c.pageEnd));
        const expectedSplits = r.signatures.filter((s) => !ends.has(s.pageEnd)).length;
        assert.equal(r.chapters.splitCount, expectedSplits);
      });
    }
  }
});

test('章节优先分帖：与独立暴力实现交叉验证（随机章节，含 tie-break）', () => {
  const rand = rng(20260920);
  for (let iter = 0; iter < 400; iter++) {
    const totalPages = 1 + Math.floor(rand() * 40); // 1..40
    const maxSheets = 1 + Math.floor(rand() * 4); // 1..4
    const chapterCount = 1 + Math.floor(rand() * Math.min(5, totalPages));
    const picked = new Set();
    while (picked.size < chapterCount) {
      picked.add(1 + Math.floor(rand() * totalPages));
    }
    const starts = [...picked].sort((a, b) => a - b);
    const r = chapterImpose(totalPages, maxSheets, starts);
    const normalized = r.chapters.starts; // 含自动补上的 1
    const brute = bruteForcePlan(totalPages, maxSheets, normalized);
    // 边界序列（各帖末页）完全一致 -> 方案唯一且相同
    assert.deepEqual(
      r.signatures.map((s) => s.pageEnd),
      brute.bounds,
      `N=${totalPages} S=${maxSheets} starts=${starts}`
    );
    // 三项优化目标一致
    assert.equal(r.chapters.splitCount, brute.cost[0]);
    assert.equal(r.blankPages, brute.cost[1]);
    assert.equal(r.signatureCount, brute.cost[2]);
  }
});
