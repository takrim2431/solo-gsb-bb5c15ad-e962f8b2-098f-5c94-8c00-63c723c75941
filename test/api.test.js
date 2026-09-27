'use strict';

/**
 * /api/impose 接口层测试：重点覆盖「无法判定」时的下一处观察建议
 * 在真实 HTTP 接口上的可用性、导出数据结构、无建议场景与兼容性。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { app } = require('../server');

const BASE = { totalPages: 8, sheetsPerSignature: 2, binding: 'left', flip: 'short' };

function obs(patch) {
  return { signature: 1, sheet: 1, side: 'front', position: 'left', page: 8, orientation: 'upright', ...patch };
}

/** 启动测试服务器（随机端口），返回 base URL 与关闭函数。 */
async function startServer() {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          let parsed;
          try {
            parsed = JSON.parse(raw);
          } catch (err) {
            reject(err);
            return;
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

test('GET /api/health 健康检查', async () => {
  const srv = await startServer();
  try {
    const res = await new Promise((resolve, reject) => {
      http.get(`${srv.baseUrl}/api/health`, (r) => {
        let raw = '';
        r.on('data', (c) => { raw += c; });
        r.on('end', () => resolve({ status: r.statusCode, body: JSON.parse(raw) }));
      }).on('error', reject);
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true });
  } finally {
    await srv.close();
  }
});

test('无法判定：响应 verification.nextSuggestion 含定位、各候选预期值与结果分组', async () => {
  const srv = await startServer();
  try {
    const res = await postJson(`${srv.baseUrl}/api/impose`, { ...BASE, observations: [obs({})] });
    assert.equal(res.status, 200);
    const v = res.body.verification;
    assert.equal(v.enabled, true);
    assert.equal(v.conclusion.status, 'undetermined');
    const s = v.nextSuggestion;
    assert.ok(s, '并列最优时应返回建议');
    assert.equal(s.signature, 1);
    assert.equal(s.sheet, 1);
    assert.ok(['front', 'back'].includes(s.side));
    assert.ok(['left', 'right'].includes(s.position));
    assert.ok(Number.isInteger(s.groupCount) && s.groupCount >= 2);
    assert.ok(Number.isInteger(s.worstRemainingCandidates));
    assert.equal(s.candidates.length, v.conclusion.tied.length);
    s.candidates.forEach((c) => {
      assert.ok(['left', 'right'].includes(c.binding));
      assert.ok(['long', 'short'].includes(c.flip));
      assert.equal(typeof c.blank, 'boolean');
      if (c.blank) {
        assert.equal(c.page, null);
      } else {
        assert.ok(c.page >= 1 && c.page <= BASE.totalPages);
        assert.ok(['upright', 'rotated'].includes(c.orientation));
      }
    });
    assert.equal(s.outcomeGroups.length, s.groupCount);
    const groupedCombos = s.outcomeGroups.flatMap((g) => g.combinations).length;
    assert.equal(groupedCombos, v.conclusion.tied.length);
    // 定位真实存在于导出的拼版清单中
    const slot = res.body.signatures[s.signature - 1].sheets[s.sheet - 1][s.side][s.position];
    assert.ok(slot);
    assert.equal(typeof slot.blank, 'boolean');
  } finally {
    await srv.close();
  }
});

test('建议随观察增删自动重算：新增并列观察后建议同步刷新且不与已有观察重叠', async () => {
  const srv = await startServer();
  const input = { totalPages: 10, sheetsPerSignature: 2, binding: 'left', flip: 'short' };
  try {
    // 观察第 2 帖第 2 张（全空白张）正面左页位为空白：四种组合零差异并列
    const first = await postJson(`${srv.baseUrl}/api/impose`, {
      ...input,
      observations: [
        { signature: 2, sheet: 2, side: 'front', position: 'left', page: null, orientation: 'rotated' },
      ],
    });
    assert.equal(first.status, 200);
    const v1 = first.body.verification;
    assert.equal(v1.conclusion.status, 'undetermined');
    assert.equal(v1.conclusion.tied.length, 4);
    const s1 = v1.nextSuggestion;
    assert.ok(s1);
    assert.equal(s1.worstRemainingCandidates, 1);
    assert.equal(s1.groupCount, 4);

    // 「增」：在同一全空白张再补一条空白观察（四种组合仍一致 -> 保持 4 路并列），
    // 服务端重算后建议必须仍可给出，且不与任何已观察页位重叠。
    const observations = [
      { signature: 2, sheet: 2, side: 'front', position: 'left', page: null, orientation: 'rotated' },
      { signature: 2, sheet: 2, side: 'front', position: 'right', page: null, orientation: 'rotated' },
    ];
    const second = await postJson(`${srv.baseUrl}/api/impose`, { ...input, observations });
    assert.equal(second.status, 200);
    const v2 = second.body.verification;
    assert.equal(v2.conclusion.tied.length, 4);
    const s2 = v2.nextSuggestion;
    assert.ok(s2, '仍有可区分页位时应继续给建议');
    const keys = new Set(observations.map((o) => `${o.signature}/${o.sheet}/${o.side}/${o.position}`));
    assert.ok(!keys.has(`${s2.signature}/${s2.sheet}/${s2.side}/${s2.position}`));
    // 「删」：去掉新增的观察后结果应与首次完全一致（无状态接口的同步刷新）
    const third = await postJson(`${srv.baseUrl}/api/impose`, {
      ...input,
      observations: [observations[0]],
    });
    assert.equal(third.status, 200);
    assert.deepEqual(third.body.verification.nextSuggestion, s1);
    // 建议页位的预期值与导出清单中该页位的当前设置结果一致
    const current = s2.candidates.find(
      (c) => c.binding === input.binding && c.flip === input.flip
    );
    const slot = second.body.signatures[s2.signature - 1].sheets[s2.sheet - 1][s2.side][s2.position];
    assert.equal(current.blank, slot.blank);
    assert.equal(current.page, slot.blank ? null : slot.page);
  } finally {
    await srv.close();
  }
});

test('无建议场景：1 页册子两种翻转无法区分时 nextSuggestion 为 null', async () => {
  const srv = await startServer();
  try {
    const res = await postJson(`${srv.baseUrl}/api/impose`, {
      totalPages: 1,
      sheetsPerSignature: 1,
      binding: 'left',
      flip: 'short',
      observations: [
        { signature: 1, sheet: 1, side: 'front', position: 'left', page: null, orientation: 'upright' },
        { signature: 1, sheet: 1, side: 'front', position: 'right', page: 1, orientation: 'upright' },
      ],
    });
    assert.equal(res.status, 200);
    const v = res.body.verification;
    assert.equal(v.conclusion.status, 'undetermined');
    assert.equal(v.nextSuggestion, null);
    assert.match(v.conclusion.message, /已无可以继续区分/);
  } finally {
    await srv.close();
  }
});

test('verified / failed 与无观察：nextSuggestion 不出 / 核验不启用（兼容性）', async () => {
  const srv = await startServer();
  try {
    const verified = await postJson(`${srv.baseUrl}/api/impose`, {
      ...BASE,
      observations: [
        obs({}),
        obs({ side: 'back', position: 'left', page: 2, orientation: 'upright' }),
      ],
    });
    assert.equal(verified.body.verification.conclusion.status, 'verified');
    assert.equal(verified.body.verification.nextSuggestion, null);

    const failed = await postJson(`${srv.baseUrl}/api/impose`, {
      ...BASE,
      observations: [
        obs({ side: 'back', position: 'left', page: 2, orientation: 'upright' }),
        obs({ side: 'back', position: 'right', page: 7, orientation: 'upright' }),
        obs({ side: 'front', position: 'left', page: 1, orientation: 'upright' }),
      ],
    });
    assert.equal(failed.body.verification.conclusion.status, 'failed');
    assert.equal(failed.body.verification.nextSuggestion, null);

    const noObs = await postJson(`${srv.baseUrl}/api/impose`, BASE);
    assert.deepEqual(noObs.body.verification, { enabled: false });

    const emptyObs = await postJson(`${srv.baseUrl}/api/impose`, { ...BASE, observations: [] });
    assert.deepEqual(emptyObs.body.verification, { enabled: false });
  } finally {
    await srv.close();
  }
});

test('非法请求仍返回 400（核验流程接入建议计算不影响错误处理）', async () => {
  const srv = await startServer();
  try {
    const res = await postJson(`${srv.baseUrl}/api/impose`, {
      ...BASE,
      observations: [obs({}), obs({ page: 1 })], // 同一页位重复观察
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /重复观察/);
  } finally {
    await srv.close();
  }
});

const FIT_FIELDS = {
  paperWidth: 460, paperHeight: 330, pageWidth: 210, pageHeight: 297, bleedMm: 3, safetyMm: 5,
};

test('双面生产标记：响应含顶层汇总与逐张正背面坐标 / 省略结构', async () => {
  const srv = await startServer();
  try {
    const res = await postJson(`${srv.baseUrl}/api/impose`, {
      ...BASE, ...FIT_FIELDS, productionMarks: true, markSizeMm: 5,
    });
    assert.equal(res.status, 200);
    const pm = res.body.productionMarks;
    assert.equal(pm.enabled, true);
    assert.equal(pm.markSizeMm, 5);
    assert.equal(pm.placedCount, 48); // 2 张 × 2 面 × 12
    assert.equal(pm.omittedCount, 0);
    assert.equal(pm.sheets.length, 2);
    assert.ok(['long', 'short'].includes(pm.flip));
    const sheetPm = res.body.signatures[0].sheets[0].productionMarks;
    assert.equal(sheetPm.front.placed.length, 12);
    assert.deepEqual(sheetPm.front.omitted, []);
    // 背面标记带正背坐标变换与配对 id，坐标确为线段对象
    const backReg = sheetPm.back.placed.find((m) => m.id === 'register-left');
    assert.equal(backReg.pairedWith, 'register-left');
    assert.equal(backReg.transform.flip, BASE.flip);
    assert.ok(backReg.segments.every((s) => ['x1', 'y1', 'x2', 'y2'].every((k) => typeof s[k] === 'number')));
  } finally {
    await srv.close();
  }
});

test('双面生产标记：纸张过小时标记省略并返回逐候选原因', async () => {
  const srv = await startServer();
  try {
    const res = await postJson(`${srv.baseUrl}/api/impose`, {
      ...BASE, paperWidth: 426, paperHeight: 303, pageWidth: 210, pageHeight: 297, bleedMm: 3,
      productionMarks: true,
    });
    assert.equal(res.status, 200);
    const pm = res.body.productionMarks;
    assert.equal(pm.placedCount, 0);
    assert.ok(pm.omittedCount > 0);
    const sheetPm = res.body.signatures[0].sheets[0].productionMarks;
    const reg = sheetPm.front.omitted.find((o) => o.id === 'register-left');
    assert.equal(reg.attempts.length, 3); // 三个候选垂直位置全部尝试
    assert.match(reg.reason, /候选位置/);
    // 背面同步省略并指向正面同名标记
    const backReg = sheetPm.back.omitted.find((o) => o.id === 'register-left');
    assert.equal(backReg.reasonCode, 'paired-front-omitted');
    assert.equal(backReg.pairedWith, 'register-left');
  } finally {
    await srv.close();
  }
});

test('双面生产标记：未启用适配检查 / 尺寸非法返回 400；缺省参数不启用', async () => {
  const srv = await startServer();
  try {
    const noFit = await postJson(`${srv.baseUrl}/api/impose`, { ...BASE, productionMarks: true });
    assert.equal(noFit.status, 400);
    assert.match(noFit.body.error, /必须同时启用纸张适配检查/);

    const badSize = await postJson(`${srv.baseUrl}/api/impose`, {
      ...BASE, ...FIT_FIELDS, productionMarks: true, markSizeMm: 0,
    });
    assert.equal(badSize.status, 400);
    assert.match(badSize.body.error, /标记尺寸/);

    const off = await postJson(`${srv.baseUrl}/api/impose`, { ...BASE, ...FIT_FIELDS });
    assert.equal(off.status, 200);
    assert.deepEqual(off.body.productionMarks, { enabled: false });
    assert.equal(off.body.signatures[0].sheets[0].productionMarks, undefined);
  } finally {
    await srv.close();
  }
});

test('印刷备料：响应 materialPrep 含逐帖数据与整包采购汇总；未启用不带该字段', async () => {
  const srv = await startServer();
  try {
    const prep = { copies: 1000, makereadySheets: 10, processWasteRate: 0.03, sheetsPerPack: 500 };
    const res = await postJson(`${srv.baseUrl}/api/impose`, { ...BASE, materialPrep: prep });
    assert.equal(res.status, 200);
    const mp = res.body.materialPrep;
    assert.equal(mp.enabled, true);
    assert.equal(mp.copies, 1000);
    assert.equal(mp.processWasteRate, 0.03);
    assert.equal(mp.signatures.length, res.body.signatureCount);
    // BASE 为 8 页 2 张/帖 -> 1 帖：2 张 × 1000 = 2000，ceil(2010/0.97) = 2073
    mp.signatures.forEach((row, i) => {
      assert.equal(row.signature, i + 1);
      assert.equal(row.actualSheetCount, 2);
      assert.equal(row.netSheets, 2000);
      assert.equal(row.makereadySheets, 10);
      assert.equal(row.requiredSheets, 2073);
    });
    const t = mp.totals;
    assert.equal(t.requiredSheets, 2073);
    assert.equal(t.purchasePacks, 5); // ceil(2073/500)
    assert.equal(t.purchaseSheets, 2500);
    assert.equal(t.packRemainder, 427);

    // 未启用：响应不含 materialPrep 字段（原响应不变）
    const off = await postJson(`${srv.baseUrl}/api/impose`, BASE);
    assert.equal(off.status, 200);
    assert.equal('materialPrep' in off.body, false);
  } finally {
    await srv.close();
  }
});

test('印刷备料：非法参数返回 400', async () => {
  const srv = await startServer();
  try {
    const badRate = await postJson(`${srv.baseUrl}/api/impose`, {
      ...BASE,
      materialPrep: { copies: 1000, makereadySheets: 10, processWasteRate: 1, sheetsPerPack: 500 },
    });
    assert.equal(badRate.status, 400);
    assert.match(badRate.body.error, /过程损耗率/);

    const badPack = await postJson(`${srv.baseUrl}/api/impose`, {
      ...BASE,
      materialPrep: { copies: 1000, makereadySheets: 10, processWasteRate: 0.03, sheetsPerPack: 0 },
    });
    assert.equal(badPack.status, 400);
    assert.match(badPack.body.error, /每包张数/);
  } finally {
    await srv.close();
  }
});

/* ------------------------------ 采购报价组合 ------------------------------ */

const QUOTES = {
  demandSheets: 4500,
  quotes: [
    { supplier: '华泰纸行', sheetsPerPack: 500, pricePerPackCents: 9800, minPacks: 0, maxPacks: 20 },
    { supplier: '恒丰纸业', sheetsPerPack: 500, pricePerPackCents: 9500, minPacks: 0, maxPacks: 20 },
  ],
};

test('采购报价组合：手工需求张数，响应含逐报价采购量 / 金额 / 余量与总价；未启用不带字段', async () => {
  const srv = await startServer();
  try {
    const res = await postJson(`${srv.baseUrl}/api/impose`, { ...BASE, purchaseQuotes: QUOTES });
    assert.equal(res.status, 200);
    const pq = res.body.purchaseQuotes;
    assert.equal(pq.enabled, true);
    assert.equal(pq.feasible, true);
    assert.equal(pq.demandSheets, 4500);
    assert.equal(pq.demandSource, 'manual');
    assert.equal(pq.priceUnit, 'cents');
    // 恒丰更便宜：9 包 × 500 = 4500 恰好满足
    assert.deepEqual(pq.rows.map((r) => r.packs), [0, 9]);
    assert.deepEqual(pq.rows.map((r) => r.sheets), [0, 4500]);
    assert.deepEqual(pq.rows.map((r) => r.amountCents), [0, 85500]);
    assert.deepEqual(pq.rows.map((r) => r.remainingPacks), [20, 11]);
    assert.deepEqual(pq.rows.map((r) => r.remainingSheets), [10000, 5500]);
    assert.equal(pq.totals.totalPacks, 9);
    assert.equal(pq.totals.totalSheets, 4500);
    assert.equal(pq.totals.overPurchaseSheets, 0);
    assert.equal(pq.totals.totalCostCents, 85500);
    assert.equal(pq.totals.supplierCount, 1);
    assert.deepEqual(pq.totals.suppliers, ['恒丰纸业']);
    // 回显规范化后的报价（录入顺序保留）
    assert.equal(pq.quotes.length, 2);
    assert.equal(pq.quotes[0].supplier, '华泰纸行');
    assert.equal(pq.quotes[1].pricePerPackCents, 9500);

    // 未启用：响应不含 purchaseQuotes 字段（原响应不变）
    const off = await postJson(`${srv.baseUrl}/api/impose`, BASE);
    assert.equal(off.status, 200);
    assert.equal('purchaseQuotes' in off.body, false);
    // 显式关闭同样不带字段
    const disabled = await postJson(`${srv.baseUrl}/api/impose`, { ...BASE, purchaseQuotes: { enabled: false, ...QUOTES } });
    assert.equal(disabled.status, 200);
    assert.equal('purchaseQuotes' in disabled.body, false);
  } finally {
    await srv.close();
  }
});

test('采购报价组合：缺省需求张数时接入印刷备料整包采购张数（materialPrep + purchaseQuotes 同请求）', async () => {
  const srv = await startServer();
  try {
    // BASE 8 页 2 张/帖 1 帖：copies 1000、开机 10、3% -> 需领 2073；
    // 每包 500 -> 5 包 = 2500 张整包采购（purchaseSheets）。
    const prep = { copies: 1000, makereadySheets: 10, processWasteRate: 0.03, sheetsPerPack: 500 };
    const res = await postJson(`${srv.baseUrl}/api/impose`, {
      ...BASE,
      materialPrep: prep,
      purchaseQuotes: {
        quotes: [
          { supplier: '华泰纸行', sheetsPerPack: 500, pricePerPackCents: 10000, minPacks: 0, maxPacks: 20 },
        ],
      },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.materialPrep.totals.purchaseSheets, 2500);
    const pq = res.body.purchaseQuotes;
    assert.equal(pq.enabled, true);
    assert.equal(pq.feasible, true);
    assert.equal(pq.demandSource, 'materialPrep');
    assert.equal(pq.demandSheets, 2500);
    assert.deepEqual(pq.rows.map((r) => r.packs), [5]);
    assert.equal(pq.totals.totalSheets, 2500);
    assert.equal(pq.totals.totalCostCents, 50000);
    assert.equal(pq.totals.overPurchaseSheets, 0);
  } finally {
    await srv.close();
  }
});

test('采购报价组合：手工需求张数优先于备料整包采购张数', async () => {
  const srv = await startServer();
  try {
    const prep = { copies: 1000, makereadySheets: 10, processWasteRate: 0.03, sheetsPerPack: 500 };
    const res = await postJson(`${srv.baseUrl}/api/impose`, {
      ...BASE,
      materialPrep: prep,
      purchaseQuotes: {
        demandSheets: 500,
        quotes: [
          { supplier: '华泰纸行', sheetsPerPack: 500, pricePerPackCents: 10000, minPacks: 0, maxPacks: 20 },
        ],
      },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.purchaseQuotes.demandSource, 'manual');
    assert.equal(res.body.purchaseQuotes.demandSheets, 500);
    assert.deepEqual(res.body.purchaseQuotes.rows.map((r) => r.packs), [1]);
  } finally {
    await srv.close();
  }
});

test('采购报价组合：无可行组合返回 200 + feasible:false 与具体缺口（导出 JSON 可见）', async () => {
  const srv = await startServer();
  try {
    const res = await postJson(`${srv.baseUrl}/api/impose`, {
      ...BASE,
      purchaseQuotes: {
        demandSheets: 1000,
        quotes: [
          { supplier: '华泰纸行', sheetsPerPack: 60, pricePerPackCents: 500, minPacks: 0, maxPacks: 5 },
          { supplier: '恒丰纸业', sheetsPerPack: 50, pricePerPackCents: 400, minPacks: 0, maxPacks: 10 },
        ],
      },
    });
    assert.equal(res.status, 200);
    const pq = res.body.purchaseQuotes;
    assert.equal(pq.enabled, true);
    assert.equal(pq.feasible, false);
    assert.equal(pq.gapSheets, 200);
    assert.equal(pq.maxPurchasableSheets, 800);
    assert.match(pq.reason, /差 200 张/);
    assert.deepEqual(pq.rows.map((r) => r.packs), [5, 10]);
    assert.deepEqual(pq.rows.map((r) => r.remainingPacks), [0, 0]);
    assert.equal(pq.totals.totalSheets, 800);
    assert.equal(pq.totals.overPurchaseSheets, 0);
  } finally {
    await srv.close();
  }
});

test('采购报价组合：最少包数强制边界与超购选择经接口生效', async () => {
  const srv = await startServer();
  try {
    const res = await postJson(`${srv.baseUrl}/api/impose`, {
      ...BASE,
      purchaseQuotes: {
        demandSheets: 100,
        quotes: [
          { supplier: 'A', sheetsPerPack: 50, pricePerPackCents: 500, minPacks: 0, maxPacks: 10 },
          { supplier: 'B', sheetsPerPack: 50, pricePerPackCents: 1000, minPacks: 1, maxPacks: 5 },
        ],
      },
    });
    assert.equal(res.status, 200);
    const pq = res.body.purchaseQuotes;
    assert.equal(pq.feasible, true);
    // 至少 1 包 B（50 张），其余由便宜的 A 补足 -> [1,1]，总价 1500 分
    assert.deepEqual(pq.rows.map((r) => r.packs), [1, 1]);
    assert.equal(pq.totals.totalCostCents, 1500);
    assert.equal(pq.totals.overPurchaseSheets, 0);
  } finally {
    await srv.close();
  }
});

test('采购报价组合：价格按分精确计算（12.34 元类输入以整数分上送，无浮点尾数）', async () => {
  const srv = await startServer();
  try {
    const res = await postJson(`${srv.baseUrl}/api/impose`, {
      ...BASE,
      purchaseQuotes: {
        demandSheets: 10,
        quotes: [
          { supplier: 'A', sheetsPerPack: 3, pricePerPackCents: 100, minPacks: 0, maxPacks: 10 },
          { supplier: 'B', sheetsPerPack: 7, pricePerPackCents: 234, minPacks: 0, maxPacks: 10 },
        ],
      },
    });
    assert.equal(res.status, 200);
    const pq = res.body.purchaseQuotes;
    assert.deepEqual(pq.rows.map((r) => r.packs), [1, 1]);
    assert.equal(pq.totals.totalCostCents, 334); // 100 + 234
    assert.equal(pq.totals.overPurchaseSheets, 0);
  } finally {
    await srv.close();
  }
});

test('采购报价组合：未启用备料又未给需求张数 / 非法参数返回 400', async () => {
  const srv = await startServer();
  try {
    const noDemand = await postJson(`${srv.baseUrl}/api/impose`, {
      ...BASE,
      purchaseQuotes: { quotes: [{ supplier: 'A', sheetsPerPack: 500, pricePerPackCents: 100, minPacks: 0, maxPacks: 5 }] },
    });
    assert.equal(noDemand.status, 400);
    assert.match(noDemand.body.error, /需求张数/);

    const dupSupplier = await postJson(`${srv.baseUrl}/api/impose`, {
      ...BASE,
      purchaseQuotes: {
        demandSheets: 100,
        quotes: [
          { supplier: 'A', sheetsPerPack: 50, pricePerPackCents: 100, minPacks: 0, maxPacks: 5 },
          { supplier: 'A', sheetsPerPack: 40, pricePerPackCents: 90, minPacks: 0, maxPacks: 5 },
        ],
      },
    });
    assert.equal(dupSupplier.status, 400);
    assert.match(dupSupplier.body.error, /供应商名称重复/);

    const badBound = await postJson(`${srv.baseUrl}/api/impose`, {
      ...BASE,
      purchaseQuotes: {
        demandSheets: 100,
        quotes: [{ supplier: 'A', sheetsPerPack: 50, pricePerPackCents: 100, minPacks: 4, maxPacks: 3 }],
      },
    });
    assert.equal(badBound.status, 400);
    assert.match(badBound.body.error, /不能少于最少可购包数/);

    const emptyQuotes = await postJson(`${srv.baseUrl}/api/impose`, {
      ...BASE,
      purchaseQuotes: { demandSheets: 100, quotes: [] },
    });
    assert.equal(emptyQuotes.status, 400);
    assert.match(emptyQuotes.body.error, /至少录入 1 条/);

    const badDemand = await postJson(`${srv.baseUrl}/api/impose`, {
      ...BASE,
      purchaseQuotes: {
        demandSheets: 0,
        quotes: [{ supplier: 'A', sheetsPerPack: 50, pricePerPackCents: 100, minPacks: 0, maxPacks: 5 }],
      },
    });
    assert.equal(badDemand.status, 400);
    assert.match(badDemand.body.error, /需求张数/);
  } finally {
    await srv.close();
  }
});

/* ------------------------------ 双版本共版印刷 ------------------------------ */

test('双版本共版：响应 dualVersion 含逐面印版归属 / 印次与汇总；未启用不带该字段', async () => {
  const srv = await startServer();
  try {
    // BASE 8 页 2 张/帖 1 帖：第 1 张正面 [8,1]、背面 [2,7]；第 2 张正面 [6,3]、背面 [4,5]
    const res = await postJson(`${srv.baseUrl}/api/impose`, {
      ...BASE,
      dualVersion: { copiesA: 1000, copiesB: 500, changedPages: '2, 5-6' },
    });
    assert.equal(res.status, 200);
    const dv = res.body.dualVersion;
    assert.equal(dv.enabled, true);
    assert.equal(dv.copiesA, 1000);
    assert.equal(dv.copiesB, 500);
    assert.deepEqual(dv.changedPages, [2, 5, 6]); // 区间展开 + 去重排序
    assert.equal(dv.rows.length, 4);
    // 页 2 在第 1 张背面，页 5、6 在第 2 张背面与正面
    const split = dv.rows.filter((row) => !row.shared);
    assert.equal(split.length, 3);
    split.forEach((row) => {
      assert.deepEqual(row.plates, [
        { plate: 'A', impressions: 1000 },
        { plate: 'B', impressions: 500 },
      ]);
    });
    const sharedRow = dv.rows.find((row) => row.shared);
    assert.deepEqual(sharedRow.plates, [{ plate: 'shared', impressions: 1500 }]);
    const t = dv.totals;
    assert.equal(t.sideCount, 4);
    assert.equal(t.sharedSideCount, 1);
    assert.equal(t.splitSideCount, 3);
    assert.equal(t.plateCount, 1 + 3 * 2);
    assert.equal(t.savedPlateCount, 1);
    assert.equal(t.impressions, 4 * 1500);
    // 逐面行定位真实存在于导出的拼版清单中
    dv.rows.forEach((row) => {
      const side = res.body.signatures[row.signature - 1].sheets[row.sheet - 1][row.side];
      assert.equal(side.left.blank ? null : side.left.page, row.leftPage);
      assert.equal(side.right.blank ? null : side.right.page, row.rightPage);
    });

    // 未启用：响应不含 dualVersion 字段（原响应不变）
    const off = await postJson(`${srv.baseUrl}/api/impose`, BASE);
    assert.equal(off.status, 200);
    assert.equal('dualVersion' in off.body, false);
    // 显式关闭同样不带字段
    const disabled = await postJson(`${srv.baseUrl}/api/impose`, {
      ...BASE,
      dualVersion: { enabled: false, copiesA: 1, copiesB: 1, changedPages: [2] },
    });
    assert.equal(disabled.status, 200);
    assert.equal('dualVersion' in disabled.body, false);
  } finally {
    await srv.close();
  }
});

test('双版本共版：非法参数返回 400', async () => {
  const srv = await startServer();
  try {
    const outOfRange = await postJson(`${srv.baseUrl}/api/impose`, {
      ...BASE,
      dualVersion: { copiesA: 100, copiesB: 50, changedPages: [2, 9] },
    });
    assert.equal(outOfRange.status, 400);
    assert.match(outOfRange.body.error, /超出范围/);

    const badCopies = await postJson(`${srv.baseUrl}/api/impose`, {
      ...BASE,
      dualVersion: { copiesA: 100, copiesB: 0, changedPages: [2] },
    });
    assert.equal(badCopies.status, 400);
    assert.match(badCopies.body.error, /B 版成品份数/);

    const emptyPages = await postJson(`${srv.baseUrl}/api/impose`, {
      ...BASE,
      dualVersion: { copiesA: 100, copiesB: 50, changedPages: [] },
    });
    assert.equal(emptyPages.status, 400);
    assert.match(emptyPages.body.error, /不能为空/);

    const badRange = await postJson(`${srv.baseUrl}/api/impose`, {
      ...BASE,
      dualVersion: { copiesA: 100, copiesB: 50, changedPages: ['5-3'] },
    });
    assert.equal(badRange.status, 400);
    assert.match(badRange.body.error, /起点不能大于终点/);
  } finally {
    await srv.close();
  }
});

/* ------------------------------ 库存批次领纸 ------------------------------ */

// 8 页、每帖 1 张 -> 2 帖各 1 张；份数 10、无损耗 -> 每帖需领纸 10 张
const PREP10 = { copies: 10, makereadySheets: 0, processWasteRate: 0, sheetsPerPack: 100 };
const BASE_SIG2 = { totalPages: 8, sheetsPerSignature: 1, binding: 'left', flip: 'short' };

test('库存批次领纸：响应含逐帖领用 / 缺口与逐批剩余张数；未启用不带该字段', async () => {
  const srv = await startServer();
  try {
    // 任务示例：两帖各需 10 张，通用批与仅供第 1 帖的批各 10 张 -> 均无缺口
    const res = await postJson(`${srv.baseUrl}/api/impose`, {
      ...BASE_SIG2,
      materialPrep: PREP10,
      stockBatches: {
        batches: [
          { lot: 'ALL', availableSheets: 10 },
          { lot: 'S1', availableSheets: 10, allowedSignatures: [1] },
        ],
      },
    });
    assert.equal(res.status, 200);
    const sb = res.body.stockBatches;
    assert.equal(sb.enabled, true);
    assert.equal(sb.demandSource, 'materialPrep.requiredSheets');
    assert.deepEqual(
      sb.signatures.map((s) => [s.requiredSheets, s.drawnSheets, s.gapSheets]),
      [[10, 10, 0], [10, 10, 0]]
    );
    assert.deepEqual(sb.signatures[0].allocations, [{ batch: 2, lot: 'S1', sheets: 10 }]);
    assert.deepEqual(sb.signatures[1].allocations, [{ batch: 1, lot: 'ALL', sheets: 10 }]);
    assert.deepEqual(sb.batches.map((b) => b.remainingSheets), [0, 0]);
    assert.equal(sb.totals.fullyCovered, true);
    assert.equal(sb.totals.gapSheets, 0);

    // 未启用：响应不含 stockBatches 字段（原响应不变）
    const off = await postJson(`${srv.baseUrl}/api/impose`, { ...BASE_SIG2, materialPrep: PREP10 });
    assert.equal(off.status, 200);
    assert.equal('stockBatches' in off.body, false);
    // 显式关闭同样不带字段
    const disabled = await postJson(`${srv.baseUrl}/api/impose`, {
      ...BASE_SIG2,
      materialPrep: PREP10,
      stockBatches: { enabled: false, batches: [{ lot: 'A', availableSheets: 1 }] },
    });
    assert.equal(disabled.status, 200);
    assert.equal('stockBatches' in disabled.body, false);
  } finally {
    await srv.close();
  }
});

test('库存批次领纸：库存不足时响应 200 并给出逐帖缺口与逐批剩余（导出 JSON 可见）', async () => {
  const srv = await startServer();
  try {
    const res = await postJson(`${srv.baseUrl}/api/impose`, {
      ...BASE_SIG2,
      materialPrep: PREP10,
      stockBatches: { batches: [{ lot: 'ALL', availableSheets: 15 }] },
    });
    assert.equal(res.status, 200);
    const sb = res.body.stockBatches;
    assert.equal(sb.totals.fullyCovered, false);
    assert.equal(sb.totals.gapSheets, 5);
    assert.deepEqual(
      sb.signatures.map((s) => [s.drawnSheets, s.gapSheets]),
      [[10, 0], [5, 5]]
    );
    assert.equal(sb.batches[0].drawnSheets, 15);
    assert.equal(sb.batches[0].remainingSheets, 0);
  } finally {
    await srv.close();
  }
});

test('库存批次领纸：未启用备料 / 重复批号 / 无效帖号返回 400 明确错误', async () => {
  const srv = await startServer();
  try {
    const noPrep = await postJson(`${srv.baseUrl}/api/impose`, {
      ...BASE_SIG2,
      stockBatches: { batches: [{ lot: 'A', availableSheets: 10 }] },
    });
    assert.equal(noPrep.status, 400);
    assert.match(noPrep.body.error, /需先启用印刷备料/);

    const dupLot = await postJson(`${srv.baseUrl}/api/impose`, {
      ...BASE_SIG2,
      materialPrep: PREP10,
      stockBatches: {
        batches: [
          { lot: 'A01', availableSheets: 10 },
          { lot: 'A01', availableSheets: 5 },
        ],
      },
    });
    assert.equal(dupLot.status, 400);
    assert.match(dupLot.body.error, /批号重复/);

    const badSig = await postJson(`${srv.baseUrl}/api/impose`, {
      ...BASE_SIG2,
      materialPrep: PREP10,
      stockBatches: { batches: [{ lot: 'A', availableSheets: 10, allowedSignatures: [3] }] },
    });
    assert.equal(badSig.status, 400);
    assert.match(badSig.body.error, /帖号 3 超出范围（1 ~ 2）/);

    const tooMany = await postJson(`${srv.baseUrl}/api/impose`, {
      ...BASE_SIG2,
      materialPrep: PREP10,
      stockBatches: { batches: Array.from({ length: 13 }, (_, i) => ({ lot: `L${i}`, availableSheets: 1 })) },
    });
    assert.equal(tooMany.status, 400);
    assert.match(tooMany.body.error, /最多录入 12 个/);
  } finally {
    await srv.close();
  }
});
