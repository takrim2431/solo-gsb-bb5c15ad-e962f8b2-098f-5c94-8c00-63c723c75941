'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeImposition } = require('../src/imposition');
const { solveBatchAllocation } = require('../src/stockBatches');

// 8 页、每帖 1 张 -> 2 帖各 1 张；份数 10、无损耗 -> 每帖需领纸 10 张
const BASE = { totalPages: 8, sheetsPerSignature: 1, binding: 'left', flip: 'short' };
const PREP10 = { copies: 10, makereadySheets: 0, processWasteRate: 0, sheetsPerPack: 100 };

function withPrep(input, prep = PREP10) {
  return computeImposition({ ...BASE, materialPrep: prep, ...input });
}

test('未启用库存批次领纸：响应不含 stockBatches 字段（原响应完全不变）', () => {
  const r = withPrep({});
  assert.equal(r.stockBatches, undefined);
  assert.equal(withPrep({ stockBatches: false }).stockBatches, undefined);
  assert.equal(withPrep({ stockBatches: null }).stockBatches, undefined);
  const disabled = withPrep({ stockBatches: { enabled: false, batches: [{ lot: 'A', availableSheets: 10 }] } });
  assert.equal(disabled.stockBatches, undefined);
});

test('任务示例：两帖各需 10 张，通用批与仅供第 1 帖的批各 10 张 -> 两帖均无缺口', () => {
  const r = withPrep({
    stockBatches: {
      batches: [
        { lot: 'ALL', availableSheets: 10 }, // 通用批（未填允许帖号）
        { lot: 'S1', availableSheets: 10, allowedSignatures: [1] }, // 仅供第 1 帖
      ],
    },
  });
  const sb = r.stockBatches;
  assert.equal(sb.enabled, true);
  // 专用批自动留给第 1 帖、通用批分给第 2 帖（最大流重路由，非顺序贪心）
  assert.deepEqual(
    sb.signatures.map((s) => [s.requiredSheets, s.drawnSheets, s.gapSheets]),
    [[10, 10, 0], [10, 10, 0]]
  );
  assert.deepEqual(sb.signatures[0].allocations, [{ batch: 2, lot: 'S1', sheets: 10 }]);
  assert.deepEqual(sb.signatures[1].allocations, [{ batch: 1, lot: 'ALL', sheets: 10 }]);
  // 逐批剩余张数
  assert.deepEqual(
    sb.batches.map((b) => [b.lot, b.availableSheets, b.drawnSheets, b.remainingSheets]),
    [['ALL', 10, 10, 0], ['S1', 10, 10, 0]]
  );
  assert.equal(sb.batches[0].universal, true);
  assert.equal(sb.batches[0].allowedSignatures, null);
  assert.equal(sb.batches[1].universal, false);
  assert.deepEqual(sb.batches[1].allowedSignatures, [1]);
  const t = sb.totals;
  assert.equal(t.requiredSheets, 20);
  assert.equal(t.availableSheets, 20);
  assert.equal(t.drawnSheets, 20);
  assert.equal(t.remainingSheets, 0);
  assert.equal(t.gapSheets, 0);
  assert.equal(t.fullyCovered, true);
});

test('批次可拆给多帖：通用批 15 张分给两帖，领用不超库存，缺口集中体现', () => {
  const r = withPrep({
    stockBatches: { batches: [{ lot: 'ALL', availableSheets: 15 }] },
  });
  const sb = r.stockBatches;
  assert.deepEqual(
    sb.signatures.map((s) => [s.drawnSheets, s.gapSheets]),
    [[10, 0], [5, 5]]
  );
  // 同一批拆给两帖
  assert.deepEqual(sb.batches[0].allocations, [
    { signature: 1, sheets: 10 },
    { signature: 2, sheets: 5 },
  ]);
  assert.equal(sb.batches[0].drawnSheets, 15); // 领用合计 = 可用张数（不超库存）
  assert.equal(sb.batches[0].remainingSheets, 0);
  assert.equal(sb.totals.gapSheets, 5);
  assert.equal(sb.totals.fullyCovered, false);
});

test('同帖可跨批次：一帖需 10 张，两个批次 6 + 4 恰好凑齐', () => {
  const r = computeImposition({
    totalPages: 4,
    sheetsPerSignature: 1,
    binding: 'left',
    flip: 'short',
    materialPrep: PREP10,
    stockBatches: {
      batches: [
        { lot: 'A', availableSheets: 6 },
        { lot: 'B', availableSheets: 4 },
      ],
    },
  });
  const sb = r.stockBatches;
  assert.equal(sb.signatures.length, 1);
  assert.deepEqual(sb.signatures[0].allocations, [
    { batch: 1, lot: 'A', sheets: 6 },
    { batch: 2, lot: 'B', sheets: 4 },
  ]);
  assert.equal(sb.signatures[0].drawnSheets, 10);
  assert.equal(sb.signatures[0].gapSheets, 0);
  assert.deepEqual(sb.batches.map((b) => b.remainingSheets), [0, 0]);
  assert.equal(sb.totals.fullyCovered, true);
});

test('只能分给允许的帖：批次限定第 2 帖时第 1 帖缺口全留', () => {
  const r = withPrep({
    stockBatches: { batches: [{ lot: 'ONLY2', availableSheets: 10, allowedSignatures: [2] }] },
  });
  const sb = r.stockBatches;
  assert.deepEqual(sb.signatures[0].allocations, []);
  assert.equal(sb.signatures[0].gapSheets, 10);
  assert.deepEqual(sb.signatures[1].allocations, [{ batch: 1, lot: 'ONLY2', sheets: 10 }]);
  assert.equal(sb.signatures[1].gapSheets, 0);
  assert.equal(sb.batches[0].remainingSheets, 0);
  assert.equal(sb.totals.gapSheets, 10);
});

test('每批领用不得超库存：库存 5 需求 10 -> 领 5 缺 5', () => {
  const r = withPrep({
    stockBatches: { batches: [{ lot: 'A', availableSheets: 5 }] },
  });
  const sb = r.stockBatches;
  assert.equal(sb.batches[0].drawnSheets, 5);
  assert.equal(sb.batches[0].remainingSheets, 0);
  assert.equal(sb.totals.drawnSheets, 5);
  assert.equal(sb.totals.gapSheets, 15);
});

test('各帖需求取自备料需领纸 requiredSheets（含开机损耗与过程损耗率取整）', () => {
  // 每帖净用纸 1000、开机 10、损耗率 3% -> ceil(1010 / 0.97) = 1042
  const prep = { copies: 1000, makereadySheets: 10, processWasteRate: 0.03, sheetsPerPack: 500 };
  const r = withPrep(
    { stockBatches: { batches: [{ lot: 'BIG', availableSheets: 3000 }] } },
    prep
  );
  assert.deepEqual(r.materialPrep.signatures.map((s) => s.requiredSheets), [1042, 1042]);
  assert.deepEqual(r.stockBatches.signatures.map((s) => s.requiredSheets), [1042, 1042]);
  assert.equal(r.stockBatches.totals.requiredSheets, 2084);
  assert.equal(r.stockBatches.totals.gapSheets, 0);
  assert.equal(r.stockBatches.batches[0].remainingSheets, 3000 - 2084);
});

test('汇总一致性：领用 + 剩余 = 库存；缺口 = 需求 − 领用', () => {
  const r = withPrep({
    stockBatches: {
      batches: [
        { lot: 'A', availableSheets: 7 },
        { lot: 'B', availableSheets: 9, allowedSignatures: [2] },
        { lot: 'C', availableSheets: 100, allowedSignatures: [2] },
      ],
    },
  });
  const t = r.stockBatches.totals;
  assert.equal(t.drawnSheets + t.remainingSheets, t.availableSheets);
  assert.equal(t.gapSheets, t.requiredSheets - t.drawnSheets);
  assert.equal(t.gapSheets, r.stockBatches.signatures.reduce((s, x) => s + x.gapSheets, 0));
  assert.equal(t.drawnSheets, r.stockBatches.batches.reduce((s, x) => s + x.drawnSheets, 0));
  // 逐帖领用与逐批去向交叉一致
  r.stockBatches.signatures.forEach((sig) => {
    assert.equal(sig.drawnSheets, sig.allocations.reduce((s, a) => s + a.sheets, 0));
    assert.equal(sig.gapSheets, sig.requiredSheets - sig.drawnSheets);
  });
  r.stockBatches.batches.forEach((b) => {
    assert.equal(b.drawnSheets, b.allocations.reduce((s, a) => s + a.sheets, 0));
    assert.equal(b.remainingSheets, b.availableSheets - b.drawnSheets);
  });
});

test('未启用备料时启用本模块：返回明确错误', () => {
  assert.throws(
    () => computeImposition({ ...BASE, stockBatches: { batches: [{ lot: 'A', availableSheets: 10 }] } }),
    /需先启用印刷备料/
  );
  // 备料显式关闭同样报错
  assert.throws(
    () => computeImposition({
      ...BASE,
      materialPrep: false,
      stockBatches: { batches: [{ lot: 'A', availableSheets: 10 }] },
    }),
    /需先启用印刷备料/
  );
});

test('重复批号返回明确错误', () => {
  assert.throws(
    () => withPrep({
      stockBatches: {
        batches: [
          { lot: 'A01', availableSheets: 10 },
          { lot: 'A01', availableSheets: 20, allowedSignatures: [1] },
        ],
      },
    }),
    /批号重复：「A01」/
  );
});

test('无效帖号返回明确错误：0 / 超出帖数 / 非整数 / 同批重复', () => {
  assert.throws(
    () => withPrep({ stockBatches: { batches: [{ lot: 'A', availableSheets: 10, allowedSignatures: [0] }] } }),
    /帖号 0 超出范围（1 ~ 2）/
  );
  assert.throws(
    () => withPrep({ stockBatches: { batches: [{ lot: 'A', availableSheets: 10, allowedSignatures: [3] }] } }),
    /帖号 3 超出范围（1 ~ 2）/
  );
  assert.throws(
    () => withPrep({ stockBatches: { batches: [{ lot: 'A', availableSheets: 10, allowedSignatures: ['x'] }] } }),
    /帖号必须为整数/
  );
  assert.throws(
    () => withPrep({ stockBatches: { batches: [{ lot: 'A', availableSheets: 10, allowedSignatures: [1, 1] }] } }),
    /帖号重复：1/
  );
  assert.throws(
    () => withPrep({ stockBatches: { batches: [{ lot: 'A', availableSheets: 10, allowedSignatures: '1' }] } }),
    /allowedSignatures 必须为数组/
  );
});

test('批次列表与字段非法返回明确错误', () => {
  assert.throws(
    () => withPrep({ stockBatches: 'x' }),
    /stockBatches 必须为对象/
  );
  assert.throws(
    () => withPrep({ stockBatches: { enabled: 1, batches: [{ lot: 'A', availableSheets: 1 }] } }),
    /开关 enabled 必须为布尔值/
  );
  assert.throws(
    () => withPrep({ stockBatches: {} }),
    /batches 必须为数组/
  );
  assert.throws(
    () => withPrep({ stockBatches: { batches: [] } }),
    /至少录入 1 个批次/
  );
  assert.throws(
    () => withPrep({
      stockBatches: { batches: Array.from({ length: 13 }, (_, i) => ({ lot: `L${i}`, availableSheets: 1 })) },
    }),
    /最多录入 12 个/
  );
  assert.throws(
    () => withPrep({ stockBatches: { batches: [{ lot: '', availableSheets: 10 }] } }),
    /批号 lot 不能为空/
  );
  assert.throws(
    () => withPrep({ stockBatches: { batches: [{ lot: 'A', availableSheets: 0 }] } }),
    /可用张数/
  );
  assert.throws(
    () => withPrep({ stockBatches: { batches: [{ lot: 'A', availableSheets: 1.5 }] } }),
    /可用张数/
  );
  assert.throws(
    () => withPrep({ stockBatches: { batches: ['x'] } }),
    /必须为对象/
  );
});

test('12 个批次可正常求解；允许帖号数字字符串与乱序输入被规范化', () => {
  const batches = Array.from({ length: 12 }, (_, i) => ({
    lot: `L${i + 1}`,
    availableSheets: 1,
    allowedSignatures: i % 2 === 0 ? ['2', 1] : undefined, // 数字字符串 + 乱序 -> 规范化为 [1, 2]
  }));
  const r = withPrep({ stockBatches: { batches } });
  const sb = r.stockBatches;
  assert.equal(sb.totals.batchCount, 12);
  assert.equal(sb.totals.drawnSheets, 12);
  assert.equal(sb.totals.gapSheets, 8);
  assert.deepEqual(sb.batches[0].allowedSignatures, [1, 2]);
  assert.equal(sb.batches[1].universal, true);
});

test('solveBatchAllocation 纯函数：受限批自动留给唯一允许的帖（重路由）', () => {
  // 与任务示例同构：若通用批先占第 1 帖，专用批将无处可去 -> 必须重路由
  const allocation = solveBatchAllocation(
    [
      { availableSheets: 10, allowed: new Set([0, 1]) },
      { availableSheets: 10, allowed: new Set([0]) },
    ],
    [10, 10]
  );
  assert.deepEqual(allocation, [
    [0, 10],
    [10, 0],
  ]);
});

test('solveBatchAllocation 纯函数：确定性（同一输入两次求解结果一致）', () => {
  const batches = [
    { availableSheets: 8, allowed: new Set([0, 1, 2]) },
    { availableSheets: 6, allowed: new Set([1]) },
    { availableSheets: 5, allowed: new Set([0, 2]) },
  ];
  const demands = [7, 9, 4];
  const first = solveBatchAllocation(batches, demands);
  const second = solveBatchAllocation(batches, demands);
  assert.deepEqual(first, second);
  // 总领用 = 需求 − 最小总缺口 = min(总库存, 可满足上限)
  const drawn = first.flat().reduce((s, x) => s + x, 0);
  assert.equal(drawn, 19); // 库存合计 19，需求合计 20 -> 缺口 1
  first.forEach((row, i) => {
    const per = row.reduce((s, x) => s + x, 0);
    assert.ok(per <= batches[i].availableSheets); // 不超库存
    row.forEach((x, j) => {
      if (!batches[i].allowed.has(j)) assert.equal(x, 0); // 只分给允许的帖
    });
  });
});
