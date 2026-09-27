'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeImposition } = require('../src/imposition');
const { suggestNextObservation, COMBO_ORDER } = require('../src/verification');

const BASE = { totalPages: 8, sheetsPerSignature: 2, binding: 'left', flip: 'short' };
// 基准布局（左装订 / 短边翻转），第 1 帖：
//   第 1 张：正面 [8, 1]，背面 [2, 7]；第 2 张：正面 [6, 3]，背面 [4, 5]
// 其余三种组合（第 1 张）：
//   左装订 / 长边翻转：正面 [8, 1]，背面 [7, 2]（背面内容倒置）
//   右装订 / 短边翻转：正面 [1, 8]，背面 [7, 2]
//   右装订 / 长边翻转：正面 [1, 8]，背面 [2, 7]（背面内容倒置）

function verify(observations, overrides = {}) {
  return computeImposition({ ...BASE, ...overrides, observations }).verification;
}

/** 构造一条观察的便捷函数。 */
function obs(patch) {
  return { signature: 1, sheet: 1, side: 'front', position: 'left', page: 8, orientation: 'upright', ...patch };
}

/* ------------------------------ 兼容与开关 ------------------------------ */

test('无观察时原流程兼容：verification.enabled = false，结果其余部分不变', () => {
  const plain = computeImposition(BASE);
  assert.deepEqual(plain.verification, { enabled: false });
  const emptyArr = computeImposition({ ...BASE, observations: [] });
  assert.deepEqual(emptyArr.verification, { enabled: false });
  const strip = (r) => {
    const c = JSON.parse(JSON.stringify(r));
    delete c.verification;
    delete c.meta.generatedAt;
    return c;
  };
  assert.deepEqual(strip(emptyArr), strip(plain));
});

test('核验不改变当前设置下的拼版结果', () => {
  const withObs = computeImposition({ ...BASE, observations: [obs({})] });
  const without = computeImposition(BASE);
  const strip = (r) => {
    const c = JSON.parse(JSON.stringify(r));
    delete c.verification;
    delete c.meta.generatedAt;
    return c;
  };
  assert.deepEqual(strip(withObs), strip(without));
});

/* ------------------------------ 结论判定 ------------------------------ */

test('唯一零差异组合 = 当前设置：验证通过', () => {
  const v = verify([
    obs({}),
    obs({ side: 'back', page: 2, orientation: 'upright' }),
  ]);
  assert.equal(v.enabled, true);
  assert.equal(v.observationCount, 2);
  assert.equal(v.conclusion.status, 'verified');
  assert.equal(v.conclusion.verified, true);
  assert.equal(v.conclusion.matchesCurrent, true);
  assert.deepEqual(v.conclusion.combination, { binding: 'left', flip: 'short' });
  assert.deepEqual(v.conclusion.tied, []);
  // 候选按规则排序：当前设置（零差异）排第一
  const first = v.candidates[0];
  assert.equal(first.rank, 1);
  assert.equal(first.isCurrent, true);
  assert.equal(first.zeroDiff, true);
  assert.equal(first.wrongObservations, 0);
  assert.equal(first.wrongFields, 0);
  // 其余三种组合均有差异
  v.candidates.slice(1).forEach((c) => assert.ok(c.wrongObservations > 0));
});

test('唯一零差异组合为其他设置：验证通过但标记与当前设置不一致', () => {
  // 观察对应「右装订 / 长边翻转」：正面左页位第 1 页，背面左页位第 2 页且内容倒置
  const v = verify([
    obs({ page: 1 }),
    obs({ side: 'back', page: 2, orientation: 'rotated' }),
  ]);
  assert.equal(v.conclusion.status, 'verified');
  assert.equal(v.conclusion.verified, true);
  assert.equal(v.conclusion.matchesCurrent, false);
  assert.deepEqual(v.conclusion.combination, { binding: 'right', flip: 'long' });
});

test('观察不足以区分（仅正面页位）：并列最优返回无法判定，不强行推荐', () => {
  const v = verify([obs({})]);
  assert.equal(v.conclusion.status, 'undetermined');
  assert.equal(v.conclusion.verified, false);
  assert.equal(v.conclusion.combination, null);
  // 正面左页位第 8 页：左装订的两种翻转均零差异
  assert.deepEqual(v.conclusion.tied, [
    { binding: 'left', flip: 'short' },
    { binding: 'left', flip: 'long' },
  ]);
  // 「当前设置优先」只用于排序：当前设置排第一，但结论仍为无法判定
  assert.equal(v.candidates[0].isCurrent, true);
  assert.equal(v.candidates[0].tied, true);
  assert.equal(v.candidates[1].tied, true);
  assert.match(v.conclusion.message, /无法判定/);
});

test('唯一最优但仍有差异：验证未通过并给出最接近组合', () => {
  const v = verify([
    obs({ side: 'back', position: 'left', page: 2, orientation: 'upright' }),
    obs({ side: 'back', position: 'right', page: 7, orientation: 'upright' }),
    obs({ side: 'front', position: 'left', page: 1, orientation: 'upright' }),
  ]);
  assert.equal(v.conclusion.status, 'failed');
  assert.equal(v.conclusion.verified, false);
  assert.equal(v.conclusion.combination, null);
  // 左装订 / 短边翻转仅第 3 条（正面左页位）不符，唯一最优
  assert.deepEqual(v.conclusion.best, { binding: 'left', flip: 'short', wrongObservations: 1, wrongFields: 1 });
  assert.equal(v.candidates[0].binding, 'left');
  assert.equal(v.candidates[0].flip, 'short');
});

/* ------------------------------ 排序规则 ------------------------------ */

test('排序：错误观察数最少 → 错误字段数最少 → 固定组合顺序', () => {
  // 各组合得分：左/短 (1,1)；右/短 (2,2)；右/长 (2,2)；左/长 (2,3)
  const v = verify([
    obs({ side: 'back', position: 'left', page: 2, orientation: 'upright' }),
    obs({ side: 'front', position: 'left', page: 8, orientation: 'upright' }),
    obs({ side: 'front', position: 'right', page: 8, orientation: 'upright' }),
  ]);
  assert.equal(v.conclusion.status, 'failed');
  assert.deepEqual(
    v.candidates.map((c) => `${c.binding}/${c.flip}`),
    ['left/short', 'right/short', 'right/long', 'left/long']
  );
  assert.deepEqual(
    v.candidates.map((c) => [c.wrongObservations, c.wrongFields]),
    [[1, 1], [2, 2], [2, 2], [2, 3]]
  );
  // 右/短 与 右/长 并列 (2,2)：均非当前设置，按固定组合顺序排列
  assert.equal(v.candidates[1].flip, 'short');
  assert.equal(v.candidates[2].flip, 'long');
});

test('排序：分数相同时当前设置优先（结论仍为无法判定）', () => {
  // 当前设置改为右装订 / 长边翻转；观察仅正面左页位第 1 页（右装订两种翻转均零差异）
  const v = verify([obs({ page: 1 })], { binding: 'right', flip: 'long' });
  assert.equal(v.conclusion.status, 'undetermined');
  assert.deepEqual(v.conclusion.tied, [
    { binding: 'right', flip: 'long' },
    { binding: 'right', flip: 'short' },
  ]);
  assert.equal(v.candidates[0].binding, 'right');
  assert.equal(v.candidates[0].flip, 'long');
  assert.equal(v.candidates[0].isCurrent, true);
  assert.equal(v.candidates[1].binding, 'right');
  assert.equal(v.candidates[1].flip, 'short');
});

/* ------------------------------ 字段比对细节 ------------------------------ */

test('朝向字段：长边翻转的背面期望倒置，短边翻转期望正向', () => {
  // 观察背面左页位第 2 页、倒置：唯一对应「右装订 / 长边翻转」
  const v = verify([obs({ side: 'back', page: 2, orientation: 'rotated' })]);
  assert.equal(v.conclusion.status, 'verified');
  assert.deepEqual(v.conclusion.combination, { binding: 'right', flip: 'long' });
  const longCand = v.candidates.find((c) => c.binding === 'right' && c.flip === 'long');
  assert.equal(longCand.details[0].orientationMatch, true);
  const shortCand = v.candidates.find((c) => c.binding === 'left' && c.flip === 'short');
  // 左 / 短背面左页位也是第 2 页，但朝向为正向 -> 仅朝向字段不符
  assert.equal(shortCand.details[0].pageMatch, true);
  assert.equal(shortCand.details[0].orientationMatch, false);
  assert.equal(shortCand.wrongFields, 1);
});

test('空白观察：空白页位匹配；朝向字段在涉及空白时跳过（不计入错误字段）', () => {
  // 10 页 2 张/帖 -> 第 2 帖第 2 张全部页位为空白（与装订 / 翻转无关）
  const v = computeImposition({
    totalPages: 10,
    sheetsPerSignature: 2,
    binding: 'left',
    flip: 'short',
    observations: [{ signature: 2, sheet: 2, side: 'front', position: 'left', page: null, orientation: 'rotated' }],
  }).verification;
  // 四种组合该页位均为空白 -> 全部零差异 -> 并列，无法判定
  assert.equal(v.conclusion.status, 'undetermined');
  assert.equal(v.conclusion.tied.length, 4);
  v.candidates.forEach((c) => {
    assert.equal(c.wrongObservations, 0);
    assert.equal(c.wrongFields, 0);
    assert.equal(c.details[0].pageMatch, true);
    assert.equal(c.details[0].orientationMatch, null); // 空白无朝向可比，跳过
  });
});

test('空白页位上看到页码：页码字段不符，朝向字段跳过', () => {
  const v = computeImposition({
    totalPages: 10,
    sheetsPerSignature: 2,
    binding: 'left',
    flip: 'short',
    observations: [{ signature: 2, sheet: 2, side: 'front', position: 'left', page: 5, orientation: 'upright' }],
  }).verification;
  // 所有组合该页位均为空白 -> 全部 1 条观察不符、1 个字段不符（朝向跳过）
  assert.equal(v.conclusion.status, 'undetermined');
  assert.equal(v.conclusion.tied.length, 4);
  v.candidates.forEach((c) => {
    assert.equal(c.wrongObservations, 1);
    assert.equal(c.wrongFields, 1);
    assert.equal(c.details[0].pageMatch, false);
    assert.equal(c.details[0].orientationMatch, null);
  });
});

test('空白位置随装订方向变化：左装订的空白页位在右装订下可能持有页码', () => {
  // 10 页 -> 第 2 帖第 1 张正面左页位：左装订为空白（16），右装订为第 9 页
  const v = computeImposition({
    totalPages: 10,
    sheetsPerSignature: 2,
    binding: 'left',
    flip: 'short',
    observations: [{ signature: 2, sheet: 1, side: 'front', position: 'left', page: null, orientation: 'upright' }],
  }).verification;
  // 仅左装订两种组合零差异 -> 并列 2 个
  assert.equal(v.conclusion.status, 'undetermined');
  assert.deepEqual(v.conclusion.tied, [
    { binding: 'left', flip: 'short' },
    { binding: 'left', flip: 'long' },
  ]);
  const right = v.candidates.find((c) => c.binding === 'right' && c.flip === 'short');
  assert.equal(right.details[0].pageMatch, false);
  assert.equal(right.details[0].expected.page, 9);
});

/* ----------------------- 下一处观察建议（无法判定时） ----------------------- */

test('无法判定时给出下一处观察建议：含定位、各候选预期值、结果分组与最坏剩余数', () => {
  // 仅观察第 1 张正面左页位（第 8 页）：左装订两种翻转并列
  const v = verify([obs({})]);
  assert.equal(v.conclusion.status, 'undetermined');
  assert.ok(v.nextSuggestion, '应当返回建议而非 null');
  const s = v.nextSuggestion;
  // 第 1 张背面左页位：左/短=第 2 页正向，左/长=第 7 页倒置，可一次区分两种候选
  assert.deepEqual(
    { signature: s.signature, sheet: s.sheet, side: s.side, position: s.position },
    { signature: 1, sheet: 1, side: 'back', position: 'left' }
  );
  assert.equal(s.groupCount, 2);
  assert.equal(s.worstRemainingCandidates, 1);
  // 各候选预期值（按固定组合顺序）
  assert.deepEqual(s.candidates, [
    { binding: 'left', flip: 'short', blank: false, page: 2, orientation: 'upright' },
    { binding: 'left', flip: 'long', blank: false, page: 7, orientation: 'rotated' },
  ]);
  // 结果分组：两种预期各成一组，组内恰好一个组合
  assert.equal(s.outcomeGroups.length, 2);
  s.outcomeGroups.forEach((g) => {
    assert.equal(g.combinations.length, 1);
    assert.equal(g.blank, false);
    assert.ok(['upright', 'rotated'].includes(g.orientation));
  });
  // 结论消息中包含定位与最坏剩余数提示
  assert.match(v.conclusion.message, /建议下一处观察/);
  assert.match(v.conclusion.message, /最坏情况下剩余 1 种候选/);
});

test('建议页位不会指向已观察页位；补观察后建议自动转移到新的未观察页位', () => {
  const v1 = verify([obs({})]);
  const s1 = v1.nextSuggestion;
  assert.ok(s1);
  // 在建议页位补一条观察后重算（此时结论应变为 verified），建议应为 null
  const v2 = verify([
    obs({}),
    obs({ side: 'back', position: 'left', page: 2, orientation: 'upright' }),
  ]);
  assert.equal(v2.conclusion.status, 'verified');
  assert.equal(v2.nextSuggestion, null);

  // 仍并列但建议页位已被观察时，建议必须换到其他页位
  const v3 = verify([
    obs({}),
    obs({ side: 'back', position: 'left', page: 2, orientation: 'rotated' }), // 与左/短、左/长都不符
  ]);
  assert.equal(v3.conclusion.status, 'undetermined');
  const s3 = v3.nextSuggestion;
  assert.ok(s3);
  const blocked = new Set([
    '1/1/front/left',
    '1/1/back/left',
  ]);
  assert.ok(!blocked.has(`${s3.signature}/${s3.sheet}/${s3.side}/${s3.position}`));
});

test('4 种组合并列时：建议页位一次分出 4 组、最坏剩余 1（首要目标最大化区分）', () => {
  // 10 页 2 张/帖，观察第 2 帖第 2 张（全空白张）正面左页位为空白：四种组合零差异并列
  const v = computeImposition({
    totalPages: 10,
    sheetsPerSignature: 2,
    binding: 'left',
    flip: 'short',
    observations: [{ signature: 2, sheet: 2, side: 'front', position: 'left', page: null, orientation: 'rotated' }],
  }).verification;
  assert.equal(v.conclusion.status, 'undetermined');
  assert.equal(v.conclusion.tied.length, 4);
  const s = v.nextSuggestion;
  assert.ok(s);
  // 第 1 帖第 1 张背面左页位在四种组合下页码 / 朝向各不相同 -> 4 组、最坏剩余 1
  assert.deepEqual(
    { signature: s.signature, sheet: s.sheet, side: s.side, position: s.position },
    { signature: 1, sheet: 1, side: 'back', position: 'left' }
  );
  assert.equal(s.groupCount, 4);
  assert.equal(s.worstRemainingCandidates, 1);
  assert.equal(s.candidates.length, 4);
});

test('排序依据：最坏剩余相同时分组数更多者优先（1,1,2 胜过 1,2 之后的 2,2）', () => {
  // 单元方式构造布局：两个未观察页位，A 分为 [1,1,2]（worst 2，3 组），
  // B 分为 [2,2]（worst 2，2 组）-> 首要目标并列时按分组数选 A。
  const tied = [
    { binding: 'left', flip: 'short' },
    { binding: 'left', flip: 'long' },
    { binding: 'right', flip: 'short' },
    { binding: 'right', flip: 'long' },
  ];
  const layouts = buildStubLayouts({
    '1/1/front/left': [ // B 页位：[2,2] 两组
      { blank: true }, { blank: true }, { blank: false, page: 9, orientation: 'upright' }, { blank: false, page: 9, orientation: 'upright' },
    ],
    '1/1/front/right': [ // A 页位：[1,1,2] 三组
      { blank: false, page: 1, orientation: 'upright' },
      { blank: false, page: 2, orientation: 'rotated' },
      { blank: false, page: 9, orientation: 'upright' },
      { blank: false, page: 9, orientation: 'upright' },
    ],
  });
  const s = suggestNextObservation(tied, layouts, new Set());
  assert.deepEqual(
    { signature: s.signature, sheet: s.sheet, side: s.side, position: s.position },
    { signature: 1, sheet: 1, side: 'front', position: 'right' }
  );
  assert.equal(s.groupCount, 3);
  assert.equal(s.worstRemainingCandidates, 2);
});

test('排序依据：最坏剩余与分组数相同时非空白优先（空白候选数少者胜）', () => {
  // [左/短, 左/长, 右/短] 三组合并列（右/长不在并列集）。
  const tied = [
    { binding: 'left', flip: 'short' },
    { binding: 'left', flip: 'long' },
    { binding: 'right', flip: 'short' },
  ];
  // 两个页位都是 2 组、最坏剩余 2：left 页位仅 1 个组合预期空白，right 页位 2 个 -> 选 left
  const layouts = buildStubLayouts({
    '1/1/front/left': [
      { blank: false, page: 5 },
      { blank: false, page: 5 },
      { blank: true },
    ],
    '1/1/front/right': [
      { blank: false, page: 5 },
      { blank: true },
      { blank: true },
    ],
  });
  const s = suggestNextObservation(tied, layouts, new Set());
  assert.equal(s.position, 'left');
  assert.equal(s.groupCount, 2);
  assert.equal(s.worstRemainingCandidates, 2);
  const blankGroup = s.outcomeGroups.find((g) => g.blank);
  assert.equal(blankGroup.combinations.length, 1);
});

test('排序依据：前几项全部并列时背面优先、左页位优先', () => {
  const tied = [
    { binding: 'left', flip: 'short' },
    { binding: 'left', flip: 'long' },
  ];
  // 令第 1 张四个页位划分完全一致（同页同朝向的 2 组），应选「背面 → 左页位」
  const same = [
    { blank: false, page: 3, orientation: 'upright' },
    { blank: false, page: 4, orientation: 'rotated' },
  ];
  const layouts = buildStubLayouts({
    '1/1/front/left': same,
    '1/1/front/right': same,
    '1/1/back/left': same,
    '1/1/back/right': same,
  });
  const s = suggestNextObservation(tied, layouts, new Set());
  assert.deepEqual(
    { side: s.side, position: s.position },
    { side: 'back', position: 'left' }
  );
});

test('排序依据：同位同面时按帖号 → 张号顺序取最靠前的页位', () => {
  const tied = [
    { binding: 'left', flip: 'short' },
    { binding: 'left', flip: 'long' },
  ];
  // 两帖各 1 张，全部页位划分一致：应选第 1 帖第 1 张（最靠前）
  const same = [
    { blank: false, page: 1, orientation: 'upright' },
    { blank: false, page: 2, orientation: 'rotated' },
  ];
  const layouts = buildStubLayouts({
    '1/1/front/left': same,
    '1/1/back/left': same,
    '2/1/front/left': same,
    '2/1/back/left': same,
  }, { signatureCount: 2, sheetsPerSignature: 1 });
  const s = suggestNextObservation(tied, layouts, new Set());
  assert.deepEqual(
    { signature: s.signature, sheet: s.sheet, side: s.side, position: s.position },
    { signature: 1, sheet: 1, side: 'back', position: 'left' }
  );
});

test('无建议：所有未观察页位在并列组合下预期完全一致时返回 null 且消息明确说明', () => {
  // 1 页 1 张/帖：观察正面左（空白）、正面右（第 1 页）后，左/短、左/长仍并列，
  // 但其余页位在两种组合下完全相同（1 页装订无法区分长 / 短边翻转）。
  const v = computeImposition({
    totalPages: 1,
    sheetsPerSignature: 1,
    binding: 'left',
    flip: 'short',
    observations: [
      { signature: 1, sheet: 1, side: 'front', position: 'left', page: null, orientation: 'upright' },
      { signature: 1, sheet: 1, side: 'front', position: 'right', page: 1, orientation: 'upright' },
    ],
  }).verification;
  assert.equal(v.conclusion.status, 'undetermined');
  assert.deepEqual(v.conclusion.tied, [
    { binding: 'left', flip: 'short' },
    { binding: 'left', flip: 'long' },
  ]);
  assert.equal(v.nextSuggestion, null);
  assert.match(v.conclusion.message, /已无可以继续区分/);
});

test('verified / failed 结论均不出建议（行为不变）', () => {
  const verified = verify([
    obs({}),
    obs({ side: 'back', page: 2, orientation: 'upright' }),
  ]);
  assert.equal(verified.conclusion.status, 'verified');
  assert.equal(verified.nextSuggestion, null);

  const failed = verify([
    obs({ side: 'back', position: 'left', page: 2, orientation: 'upright' }),
    obs({ side: 'back', position: 'right', page: 7, orientation: 'upright' }),
    obs({ side: 'front', position: 'left', page: 1, orientation: 'upright' }),
  ]);
  assert.equal(failed.conclusion.status, 'failed');
  assert.equal(failed.nextSuggestion, null);
});

test('suggestNextObservation：并列组合少于 2 个时返回 null', () => {
  const layouts = buildStubLayouts({}, { signatureCount: 1, sheetsPerSignature: 1 });
  assert.equal(suggestNextObservation([{ binding: 'left', flip: 'short' }], layouts, new Set()), null);
});

/**
 * 构造 suggestNextObservation 所需的桩布局映射。
 * outcomesByKey 为每个「帖/张/面/页位」给出按 COMBO_ORDER 顺序的四个组合预期
 * { blank, page? }（朝向由面 / 翻转推导，与桩页码无关）；未列出的页位在各组合下
 * 统一为空白（空白键与朝向无关 -> 单组不可区分，类似真实拼版的全空白张，不影响选择）。
 */
function buildStubLayouts(outcomesByKey, opts = {}) {
  const signatureCount = opts.signatureCount || 1;
  const sheetsPerSignature = opts.sheetsPerSignature || 1;
  const layouts = new Map();
  COMBO_ORDER.forEach((combo, ci) => {
    const signatures = [];
    for (let si = 1; si <= signatureCount; si += 1) {
      const sheets = [];
      for (let shi = 1; shi <= sheetsPerSignature; shi += 1) {
        const sideObj = {};
        ['front', 'back'].forEach((side) => {
          sideObj[side] = {};
          ['left', 'right'].forEach((position) => {
            const key = `${si}/${shi}/${side}/${position}`;
            const o = outcomesByKey[key] && outcomesByKey[key][ci];
            sideObj[side][position] = o && !o.blank
              ? { blank: false, page: o.page }
              : o
                ? { blank: true, page: null }
                : { blank: true, page: null };
          });
        });
        sheets.push({ index: shi, ...sideObj });
      }
      signatures.push({ index: si, sheets });
    }
    layouts.set(`${combo.binding}/${combo.flip}`, {
      input: { binding: combo.binding, flip: combo.flip },
      signatures,
    });
  });
  return layouts;
}

/* ------------------------------ 输入校验 ------------------------------ */

test('观察记录类型与条数校验', () => {
  assert.throws(() => computeImposition({ ...BASE, observations: 'x' }), /必须为数组/);
  assert.throws(() => computeImposition({ ...BASE, observations: {} }), /必须为数组/);
  const tooMany = Array.from({ length: 13 }, () => obs({}));
  assert.throws(() => computeImposition({ ...BASE, observations: tooMany }), /最多 12 条/);
});

test('非法索引返回明确错误', () => {
  assert.throws(() => verify([obs({ signature: 0 })]), /帖号/);
  assert.throws(() => verify([obs({ signature: 2 })]), /帖号/);
  assert.throws(() => verify([obs({ signature: 1.5 })]), /帖号/);
  assert.throws(() => verify([obs({ sheet: 0 })]), /张号/);
  assert.throws(() => verify([obs({ sheet: 3 })]), /张号/);
});

test('非法字段值返回明确错误', () => {
  assert.throws(() => verify([obs({ side: 'top' })]), /正面|背面/);
  assert.throws(() => verify([obs({ position: 'middle' })]), /页位/);
  assert.throws(() => verify([obs({ page: 9 })]), /页码/);
  assert.throws(() => verify([obs({ page: 1.5 })]), /页码/);
  assert.throws(() => verify([obs({ page: undefined })]), /page/);
  assert.throws(() => verify([obs({ orientation: 'sideways' })]), /朝向/);
  assert.throws(() => verify([null]), /必须为对象/);
});

test('重复观察返回明确错误', () => {
  assert.throws(
    () => verify([obs({}), obs({ page: 1 })]),
    /重复观察/
  );
  // 不同页位不算重复
  const v = verify([obs({}), obs({ position: 'right', page: 1 })]);
  assert.equal(v.enabled, true);
});

test('索引与页码接受纯数字字符串', () => {
  const v = verify([obs({ signature: '1', sheet: '1', page: '8' })]);
  assert.equal(v.observations[0].signature, 1);
  assert.equal(v.observations[0].sheet, 1);
  assert.equal(v.observations[0].page, 8);
});

test('均衡分帖：张号按各帖实际张数校验', () => {
  const base = { totalPages: 17, sheetsPerSignature: 2, binding: 'left', flip: 'short', balancedSplit: true };
  // 末帖仅 1 张 -> 第 2 张为非法索引
  assert.throws(
    () => computeImposition({
      ...base,
      observations: [{ signature: 3, sheet: 2, side: 'front', position: 'left', page: 17, orientation: 'upright' }],
    }),
    /张号/
  );
  const v = computeImposition({
    ...base,
    observations: [{ signature: 3, sheet: 1, side: 'front', position: 'right', page: 17, orientation: 'upright' }],
  }).verification;
  assert.equal(v.enabled, true);
  const current = v.candidates.find((c) => c.isCurrent);
  assert.equal(current.details[0].pageMatch, true);
});

/* ------------------------------ 结果结构（导出内容） ------------------------------ */

test('核验结果包含观察、候选评分与结论（用于导出 JSON）', () => {
  const v = verify([obs({})]);
  assert.equal(v.maxObservations, 12);
  assert.deepEqual(v.current, { binding: 'left', flip: 'short' });
  assert.deepEqual(v.observations, [
    { index: 1, signature: 1, sheet: 1, side: 'front', position: 'left', page: 8, blank: false, orientation: 'upright' },
  ]);
  assert.equal(v.candidates.length, 4);
  v.candidates.forEach((c, i) => {
    assert.equal(c.rank, i + 1);
    assert.equal(typeof c.wrongObservations, 'number');
    assert.equal(typeof c.wrongFields, 'number');
    assert.equal(typeof c.zeroDiff, 'boolean');
    assert.equal(c.details.length, 1);
    const d = c.details[0];
    assert.equal(d.observation, 1);
    assert.equal(d.signature, 1);
    assert.equal(d.sheet, 1);
    assert.equal(d.side, 'front');
    assert.equal(d.position, 'left');
    assert.equal(typeof d.pageMatch, 'boolean');
    assert.equal(typeof d.match, 'boolean');
  });
  assert.ok(['verified', 'undetermined', 'failed'].includes(v.conclusion.status));
  assert.equal(typeof v.conclusion.message, 'string');
});

test('12 条观察可正常核验：由基准结果生成的观察唯一对应当前设置', () => {
  const input = { totalPages: 16, sheetsPerSignature: 1, binding: 'left', flip: 'short' };
  const base = computeImposition(input);
  // 从前 3 帖（12 个页位）生成与当前设置一致的观察
  const observations = [];
  outer: for (const sig of base.signatures) {
    for (const sheet of sig.sheets) {
      for (const side of ['front', 'back']) {
        for (const position of ['left', 'right']) {
          const slot = sheet[side][position];
          observations.push({
            signature: sig.index,
            sheet: sheet.index,
            side,
            position,
            page: slot.blank ? null : slot.page,
            orientation: side === 'back' && input.flip === 'long' ? 'rotated' : 'upright',
          });
          if (observations.length === 12) break outer;
        }
      }
    }
  }
  const v = computeImposition({ ...input, observations }).verification;
  assert.equal(v.observationCount, 12);
  assert.equal(v.conclusion.status, 'verified');
  assert.equal(v.conclusion.matchesCurrent, true);
});
