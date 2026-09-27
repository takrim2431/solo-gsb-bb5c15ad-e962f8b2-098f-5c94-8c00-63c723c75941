'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeImposition } = require('../src/imposition');

test('8 页 2 张/帖 左装订 短边翻转：经典 [8,1]/[2,7] 布局', () => {
  const r = computeImposition({ totalPages: 8, sheetsPerSignature: 2, binding: 'left', flip: 'short' });
  assert.equal(r.signatureCount, 1);
  assert.equal(r.blankPages, 0);
  const [s1, s2] = r.signatures[0].sheets;
  assert.deepEqual([s1.front.left.page, s1.front.right.page], [8, 1]);
  assert.deepEqual([s1.back.left.page, s1.back.right.page], [2, 7]);
  assert.deepEqual([s2.front.left.page, s2.front.right.page], [6, 3]);
  assert.deepEqual([s2.back.left.page, s2.back.right.page], [4, 5]);
});

test('长边翻转：背面左右页位不变', () => {
  const r = computeImposition({ totalPages: 8, sheetsPerSignature: 2, binding: 'left', flip: 'long' });
  const [s1, s2] = r.signatures[0].sheets;
  assert.deepEqual([s1.back.left.page, s1.back.right.page], [7, 2]);
  assert.deepEqual([s2.back.left.page, s2.back.right.page], [5, 4]);
});

test('右装订：正面镜像，第 1 页在左', () => {
  const r = computeImposition({ totalPages: 8, sheetsPerSignature: 2, binding: 'right', flip: 'short' });
  const [s1] = r.signatures[0].sheets;
  assert.deepEqual([s1.front.left.page, s1.front.right.page], [1, 8]);
  assert.deepEqual([s1.back.left.page, s1.back.right.page], [7, 2]);
});

test('右装订 + 长边翻转', () => {
  const r = computeImposition({ totalPages: 8, sheetsPerSignature: 2, binding: 'right', flip: 'long' });
  const [s1] = r.signatures[0].sheets;
  assert.deepEqual([s1.front.left.page, s1.front.right.page], [1, 8]);
  assert.deepEqual([s1.back.left.page, s1.back.right.page], [2, 7]);
});

test('不足整帖自动补空白页', () => {
  const r = computeImposition({ totalPages: 10, sheetsPerSignature: 2, binding: 'left', flip: 'short' });
  assert.equal(r.signatureCount, 2);
  assert.equal(r.paddedPages, 16);
  assert.equal(r.blankPages, 6);
  const sig2 = r.signatures[1];
  assert.equal(sig2.pageStart, 9);
  assert.equal(sig2.pageEnd, 16);
  const [s1, s2] = sig2.sheets;
  // 第 1 张：正面 [空白(16), 9]，背面 [10, 空白(15)]
  assert.equal(s1.front.left.blank, true);
  assert.equal(s1.front.right.page, 9);
  assert.equal(s1.back.left.page, 10);
  assert.equal(s1.back.right.blank, true);
  // 第 2 张：全部为空白页
  assert.equal(s2.front.left.blank, true);
  assert.equal(s2.front.right.blank, true);
  assert.equal(s2.back.left.blank, true);
  assert.equal(s2.back.right.blank, true);
});

test('多帖拆分：16 页 1 张/帖 -> 4 帖，每帖 4 页', () => {
  const r = computeImposition({ totalPages: 16, sheetsPerSignature: 1, binding: 'left', flip: 'short' });
  assert.equal(r.signatureCount, 4);
  assert.equal(r.pagesPerSignature, 4);
  const sig2 = r.signatures[1];
  assert.deepEqual([sig2.pageStart, sig2.pageEnd], [5, 8]);
  const sheet = sig2.sheets[0];
  assert.deepEqual([sheet.front.left.page, sheet.front.right.page], [8, 5]);
  assert.deepEqual([sheet.back.left.page, sheet.back.right.page], [6, 7]);
});

test('12 页 3 张/帖：由外向内大小页配对', () => {
  const r = computeImposition({ totalPages: 12, sheetsPerSignature: 3, binding: 'left', flip: 'short' });
  const sheets = r.signatures[0].sheets;
  assert.deepEqual([sheets[0].front.left.page, sheets[0].front.right.page], [12, 1]);
  assert.deepEqual([sheets[1].front.left.page, sheets[1].front.right.page], [10, 3]);
  assert.deepEqual([sheets[2].front.left.page, sheets[2].front.right.page], [8, 5]);
  assert.deepEqual([sheets[2].back.left.page, sheets[2].back.right.page], [6, 7]);
});

test('backOf 标注背面页位的物理承接关系', () => {
  const short = computeImposition({ totalPages: 8, sheetsPerSignature: 2, binding: 'left', flip: 'short' });
  const s1 = short.signatures[0].sheets[0];
  // 短边翻转：背面左位在正面右页（第 1 页）之背
  assert.equal(s1.back.left.backOf, 1);
  assert.equal(s1.back.right.backOf, 8);
  const long = computeImposition({ totalPages: 8, sheetsPerSignature: 2, binding: 'left', flip: 'long' });
  const l1 = long.signatures[0].sheets[0];
  // 长边翻转：背面左位在正面左页（第 8 页）之背
  assert.equal(l1.back.left.backOf, 8);
  assert.equal(l1.back.right.backOf, 1);
});

test('参数校验', () => {
  assert.throws(() => computeImposition({ totalPages: 0, sheetsPerSignature: 1, binding: 'left', flip: 'short' }), /成品页数/);
  assert.throws(() => computeImposition({ totalPages: 8.5, sheetsPerSignature: 1, binding: 'left', flip: 'short' }), /成品页数/);
  assert.throws(() => computeImposition({ totalPages: 8, sheetsPerSignature: 0, binding: 'left', flip: 'short' }), /每帖张数/);
  assert.throws(() => computeImposition({ totalPages: 8, sheetsPerSignature: 1, binding: 'middle', flip: 'short' }), /装订方式/);
  assert.throws(() => computeImposition({ totalPages: 8, sheetsPerSignature: 1, binding: 'left', flip: 'none' }), /翻转方式/);
});

test('缺省调用（旧参数）完全兼容：无爬移字段时所有 offsetMm 为 0 且页码拼版不变', () => {
  const baseline = computeImposition({ totalPages: 8, sheetsPerSignature: 2, binding: 'left', flip: 'short' });
  assert.equal(baseline.creep.enabled, false);
  assert.deepEqual(baseline.creep.sheetCompensationMm, [0, 0]);
  assert.equal(baseline.input.paperThickness, 0);
  assert.equal(baseline.input.maxCompensation, 0);
  baseline.signatures.forEach((sig) => {
    sig.sheets.forEach((sheet) => {
      ['front', 'back'].forEach((sideName) => {
        ['left', 'right'].forEach((pos) => {
          assert.equal(sheet[sideName][pos].offsetMm, 0);
        });
      });
    });
  });
  // 显式传 0 与缺省结果一致（页码布局与经典布局相同）
  const explicit = computeImposition({ totalPages: 8, sheetsPerSignature: 2, binding: 'left', flip: 'short', paperThickness: 0, maxCompensation: 0 });
  assert.equal(explicit.creep.enabled, false);
  assert.deepEqual(
    JSON.parse(JSON.stringify(baseline.signatures, (k, v) => (k === 'offsetMm' ? 0 : v))),
    JSON.parse(JSON.stringify(explicit.signatures, (k, v) => (k === 'offsetMm' ? 0 : v)))
  );
});

test('爬移公式：补偿量 = min(i × 纸张厚度 × 2, 最大补偿量)，由外向内逐张递增', () => {
  // 4 张/帖，纸厚 0.1mm，上限 5mm：0, 0.2, 0.4, 0.6（未触顶）
  const r = computeImposition({ totalPages: 16, sheetsPerSignature: 4, binding: 'left', flip: 'short', paperThickness: 0.1, maxCompensation: 5 });
  assert.equal(r.creep.enabled, true);
  assert.deepEqual(r.creep.sheetCompensationMm, [0, 0.2, 0.4, 0.6]);

  const sheets = r.signatures[0].sheets;
  // 最外层 i=0：补偿 0；i=1：0.2；i=2：0.4；i=3：0.6
  const expectedCreep = [0, 0.2, 0.4, 0.6];
  sheets.forEach((sheet, i) => {
    const creep = expectedCreep[i];
    const neg = creep === 0 ? 0 : -creep;
    assert.equal(sheet.front.left.offsetMm, creep);
    assert.equal(sheet.front.right.offsetMm, neg);
    assert.equal(sheet.back.left.offsetMm, creep);
    assert.equal(sheet.back.right.offsetMm, neg);
  });
});

test('爬移上限：补偿量被最大补偿量截断', () => {
  // 4 张/帖，纸厚 1mm（理论 0,2,4,6），上限 3：0, 2, 3, 3
  const r = computeImposition({ totalPages: 16, sheetsPerSignature: 4, binding: 'left', flip: 'short', paperThickness: 1, maxCompensation: 3 });
  assert.deepEqual(r.creep.sheetCompensationMm, [0, 2, 3, 3]);
  const s3 = r.signatures[0].sheets[2];
  assert.equal(s3.front.left.offsetMm, 3);
  assert.equal(s3.front.right.offsetMm, -3);
});

test('左装订：左页位取正、右页位取负', () => {
  const r = computeImposition({ totalPages: 16, sheetsPerSignature: 3, binding: 'left', flip: 'short', paperThickness: 0.2, maxCompensation: 10 });
  assert.deepEqual(r.creep.sheetCompensationMm, [0, 0.4, 0.8]);
  const [s1, s2, s3] = r.signatures[0].sheets;
  assert.equal(s1.front.left.offsetMm, 0);
  assert.equal(s1.front.right.offsetMm, 0);
  assert.ok(s2.front.left.offsetMm > 0);
  assert.ok(s2.front.right.offsetMm < 0);
  assert.equal(s2.front.left.offsetMm, 0.4);
  assert.equal(s2.front.right.offsetMm, -0.4);
  assert.equal(s3.back.left.offsetMm, 0.8);
  assert.equal(s3.back.right.offsetMm, -0.8);
});

test('右装订：符号整体反转（左负右正）', () => {
  const r = computeImposition({ totalPages: 16, sheetsPerSignature: 3, binding: 'right', flip: 'short', paperThickness: 0.2, maxCompensation: 10 });
  const [, s2, s3] = r.signatures[0].sheets;
  assert.equal(s2.front.left.offsetMm, -0.4);
  assert.equal(s2.front.right.offsetMm, 0.4);
  assert.equal(s3.back.left.offsetMm, -0.8);
  assert.equal(s3.back.right.offsetMm, 0.8);
});

test('爬移偏移与翻转方式无关（长/短边翻转偏移一致）', () => {
  const common = { totalPages: 16, sheetsPerSignature: 3, binding: 'left', paperThickness: 0.15, maxCompensation: 4 };
  const longFlip = computeImposition({ ...common, flip: 'long' });
  const shortFlip = computeImposition({ ...common, flip: 'short' });
  longFlip.signatures[0].sheets.forEach((sheet, i) => {
    ['front', 'back'].forEach((sideName) => {
      ['left', 'right'].forEach((pos) => {
        assert.equal(
          sheet[sideName][pos].offsetMm,
          shortFlip.signatures[0].sheets[i][sideName][pos].offsetMm
        );
      });
    });
  });
});

test('空白页也保留爬移偏移', () => {
  // 10 页、2 张/帖 -> 16 页，第 2 帖有 6 个空白页；第 2 帖由外向内仍从 i=0 起算
  const r = computeImposition({ totalPages: 10, sheetsPerSignature: 2, binding: 'left', flip: 'short', paperThickness: 0.1, maxCompensation: 5 });
  assert.deepEqual(r.creep.sheetCompensationMm, [0, 0.2]);
  const sig2 = r.signatures[1];
  const [outer, inner] = sig2.sheets;
  // 第 2 帖第 1 张（i=0）：补偿 0
  assert.equal(outer.front.left.blank, true);
  assert.equal(outer.front.left.offsetMm, 0);
  assert.equal(outer.back.right.blank, true);
  assert.equal(outer.back.right.offsetMm, 0);
  // 第 2 帖第 2 张（i=1）：全部空白，但仍带 ±0.2 的偏移
  assert.equal(inner.front.left.blank, true);
  assert.equal(inner.front.right.blank, true);
  assert.equal(inner.back.left.blank, true);
  assert.equal(inner.back.right.blank, true);
  assert.equal(inner.front.left.offsetMm, 0.2);
  assert.equal(inner.front.right.offsetMm, -0.2);
  assert.equal(inner.back.left.offsetMm, 0.2);
  assert.equal(inner.back.right.offsetMm, -0.2);
});

test('多帖各自从外层 i=0 起算：各帖同序号纸张补偿量相同', () => {
  const r = computeImposition({ totalPages: 24, sheetsPerSignature: 2, binding: 'left', flip: 'short', paperThickness: 0.3, maxCompensation: 5 });
  assert.equal(r.signatureCount, 3);
  assert.deepEqual(r.creep.sheetCompensationMm, [0, 0.6]);
  r.signatures.forEach((sig) => {
    assert.equal(sig.sheets[0].front.left.offsetMm, 0);
    assert.equal(sig.sheets[1].front.left.offsetMm, 0.6);
    assert.equal(sig.sheets[1].front.right.offsetMm, -0.6);
  });
});

test('任一参数为 0 时偏移全部归零', () => {
  const common = { totalPages: 16, sheetsPerSignature: 3, binding: 'left', flip: 'short' };
  const noThickness = computeImposition({ ...common, paperThickness: 0, maxCompensation: 2 });
  const noCap = computeImposition({ ...common, paperThickness: 0.2, maxCompensation: 0 });
  [noThickness, noCap].forEach((r) => {
    assert.equal(r.creep.enabled, false);
    assert.deepEqual(r.creep.sheetCompensationMm, [0, 0, 0]);
    r.signatures.forEach((sig) => {
      sig.sheets.forEach((sheet) => {
        ['front', 'back'].forEach((sideName) => {
          ['left', 'right'].forEach((pos) => {
            assert.equal(sheet[sideName][pos].offsetMm, 0);
          });
        });
      });
    });
  });
});

test('爬移参数不改变页码拼版结果（启用前后页码布局一致）', () => {
  const strip = (r) => JSON.parse(
    JSON.stringify(r.signatures, (k, v) => (k === 'offsetMm' || k === 'sheetCompensationMm' ? undefined : v))
  );
  const without = computeImposition({ totalPages: 12, sheetsPerSignature: 3, binding: 'right', flip: 'long' });
  const withCreep = computeImposition({ totalPages: 12, sheetsPerSignature: 3, binding: 'right', flip: 'long', paperThickness: 0.12, maxCompensation: 0.3 });
  assert.deepEqual(strip(withCreep), strip(without));
});

test('爬移参数校验', () => {
  assert.throws(
    () => computeImposition({ totalPages: 8, sheetsPerSignature: 1, binding: 'left', flip: 'short', paperThickness: -0.1, maxCompensation: 1 }),
    /纸张厚度/
  );
  assert.throws(
    () => computeImposition({ totalPages: 8, sheetsPerSignature: 1, binding: 'left', flip: 'short', paperThickness: 0.1, maxCompensation: -1 }),
    /最大补偿量/
  );
  assert.throws(
    () => computeImposition({ totalPages: 8, sheetsPerSignature: 1, binding: 'left', flip: 'short', paperThickness: 'abc' }),
    /纸张厚度/
  );
});

/* ------------------------------ 均衡分帖 ------------------------------ */

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

test('缺省时固定分帖：balanced.enabled=false，结果与旧版本一致', () => {
  const r = computeImposition({ totalPages: 10, sheetsPerSignature: 2, binding: 'left', flip: 'short' });
  assert.equal(r.input.balancedSplit, false);
  assert.deepEqual(r.balanced, { enabled: false });
  assert.equal(r.signatureCount, 2);
  assert.equal(r.paddedPages, 16);
  assert.equal(r.blankPages, 6);
  // 各帖仍为固定 2 张
  r.signatures.forEach((sig) => {
    assert.equal(sig.actualSheetCount, 2);
    assert.equal(sig.actualPageCount, 8);
  });
});

test('均衡分帖：17 页、上限 2 张 -> [2,2,1]，各帖张数差不超过 1', () => {
  const r = computeImposition({ totalPages: 17, sheetsPerSignature: 2, binding: 'left', flip: 'short', balancedSplit: true });
  assert.equal(r.balanced.enabled, true);
  assert.equal(r.signatureCount, 3);
  assert.deepEqual(r.balanced.actualSheetCounts, [2, 2, 1]);
  r.signatures.forEach((sig, i) => {
    assert.equal(sig.actualSheetCount, [2, 2, 1][i]);
    assert.equal(sig.actualPageCount, sig.actualSheetCount * 4);
    assert.equal(sig.sheets.length, sig.actualSheetCount);
  });
  assert.equal(r.paddedPages, 20);
  assert.equal(r.blankPages, 3);
  // 相对固定分帖（3 帖 × 8 = 24 页）少补 4 个空白页
  assert.equal(r.balanced.fixedPaddedPages, 24);
  assert.equal(r.balanced.fixedBlankPages, 7);
  assert.equal(r.balanced.savedBlankPages, 4);
  assert.equal(r.balanced.totalSheets, 5);
  // 各帖页码连续
  assert.deepEqual([r.signatures[0].pageStart, r.signatures[0].pageEnd], [1, 8]);
  assert.deepEqual([r.signatures[1].pageStart, r.signatures[1].pageEnd], [9, 16]);
  assert.deepEqual([r.signatures[2].pageStart, r.signatures[2].pageEnd], [17, 20]);
});

test('均衡分帖：末帖按自身页数编号，空白页只出现在末帖（页码最大的页位）', () => {
  const r = computeImposition({ totalPages: 17, sheetsPerSignature: 2, binding: 'left', flip: 'short', balancedSplit: true });
  // 末帖仅 1 张（17–20）：左装订短边翻转，第 17 页在正面右页位，
  // 其物理正后方（背面左页位）及其余大号页位 18/19/20 均为空白
  const last = r.signatures[2];
  assert.equal(last.sheets.length, 1);
  const sheet = last.sheets[0];
  assert.equal(sheet.front.left.blank, true);   // 20
  assert.equal(sheet.front.right.page, 17);
  assert.equal(sheet.back.left.blank, true);    // 17 之背
  assert.equal(sheet.back.left.backOf, 17);
  assert.equal(sheet.back.right.blank, true);   // 18
  assert.equal(last.blankPages, 3);
  // 前两帖无空白页
  assert.equal(r.signatures[0].blankPages, 0);
  assert.equal(r.signatures[1].blankPages, 0);
  // 整本：非空白页恰好为 1..17 各一次，空白页全在末帖
  const printed = allSlotsOf(r)
    .filter((s) => !s.blank)
    .map((s) => s.page)
    .sort((a, b) => a - b);
  assert.deepEqual(printed, Array.from({ length: 17 }, (_, i) => i + 1));
  r.signatures.slice(0, -1).forEach((sig) => {
    allSlotsOf({ signatures: [sig] }).forEach((s) => assert.equal(s.blank, false));
  });
});

test('均衡分帖：10 页、上限 2 张 -> [2,1]，节省 4 个空白页', () => {
  const r = computeImposition({ totalPages: 10, sheetsPerSignature: 2, binding: 'left', flip: 'short', balancedSplit: true });
  assert.deepEqual(r.balanced.actualSheetCounts, [2, 1]);
  assert.equal(r.paddedPages, 12);
  assert.equal(r.blankPages, 2);
  assert.equal(r.balanced.fixedPaddedPages, 16);
  assert.equal(r.balanced.savedBlankPages, 4);
  assert.deepEqual([r.signatures[0].pageStart, r.signatures[0].pageEnd], [1, 8]);
  assert.deepEqual([r.signatures[1].pageStart, r.signatures[1].pageEnd], [9, 12]);
  // 末帖 1 张（9–12）：左装订短边翻转，正面 [空白(12), 9]，背面 [10, 空白(11)]
  const sheet = r.signatures[1].sheets[0];
  assert.equal(sheet.front.left.blank, true);
  assert.equal(sheet.front.right.page, 9);
  assert.equal(sheet.back.left.page, 10);
  assert.equal(sheet.back.right.blank, true);
});

test('均衡分帖：30 页、上限 3 张 -> [3,3,2]', () => {
  const r = computeImposition({ totalPages: 30, sheetsPerSignature: 3, binding: 'left', flip: 'short', balancedSplit: true });
  assert.deepEqual(r.balanced.actualSheetCounts, [3, 3, 2]);
  assert.equal(r.paddedPages, 32);
  assert.equal(r.blankPages, 2);
  assert.equal(r.balanced.savedBlankPages, 4); // 固定分帖 3 × 12 = 36
  assert.deepEqual(
    r.signatures.map((sig) => [sig.pageStart, sig.pageEnd]),
    [[1, 12], [13, 24], [25, 32]]
  );
});

test('均衡分帖：整本只需 1 帖时结果与固定分帖相同', () => {
  const r = computeImposition({ totalPages: 7, sheetsPerSignature: 2, binding: 'left', flip: 'short', balancedSplit: true });
  assert.equal(r.signatureCount, 1);
  assert.deepEqual(r.balanced.actualSheetCounts, [2]);
  assert.equal(r.paddedPages, 8);
  assert.equal(r.blankPages, 1);
  assert.equal(r.balanced.savedBlankPages, 0);
  const sheet = r.signatures[0].sheets[0];
  assert.equal(sheet.front.left.blank, true);
  assert.equal(sheet.front.right.page, 1);
});

test('均衡分帖：页数恰为整帖上限倍数时与固定分帖页码布局一致', () => {
  const strip = (r) => JSON.parse(
    JSON.stringify(r.signatures, (k, v) => (
      k === 'offsetMm' || k === 'sheetCompensationMm' || k === 'actualSheetCount'
        || k === 'actualPageCount' || k === 'blankPages'
        ? undefined
        : v
    ))
  );
  const fixed = computeImposition({ totalPages: 16, sheetsPerSignature: 2, binding: 'right', flip: 'long' });
  const balanced = computeImposition({ totalPages: 16, sheetsPerSignature: 2, binding: 'right', flip: 'long', balancedSplit: true });
  assert.deepEqual(balanced.balanced.actualSheetCounts, [2, 2]);
  assert.equal(balanced.balanced.savedBlankPages, 0);
  assert.deepEqual(strip(balanced), strip(fixed));
});

test('均衡分帖：装订方向与翻转方式仍决定页位（右装订 + 长边翻转）', () => {
  const r = computeImposition({ totalPages: 10, sheetsPerSignature: 2, binding: 'right', flip: 'long', balancedSplit: true });
  // 首帖 1–8：右装订正面 [1, 8]；长边翻转背面左右不变 -> [2, 7]
  const s1 = r.signatures[0].sheets[0];
  assert.deepEqual([s1.front.left.page, s1.front.right.page], [1, 8]);
  assert.deepEqual([s1.back.left.page, s1.back.right.page], [2, 7]);
  // 末帖 9–12（1 张）：右装订正面 [9, 空白(12)]；长边翻转背面左右不变 -> [10, 空白(11)]
  const last = r.signatures[1].sheets[0];
  assert.equal(last.front.left.page, 9);
  assert.equal(last.front.right.blank, true);
  assert.equal(last.back.left.page, 10);
  assert.equal(last.back.right.blank, true);
});

test('均衡分帖：爬移补偿按各帖实际层数重算（[3,3,2] -> 末帖只有 0/0.2 两层）', () => {
  const r = computeImposition({
    totalPages: 30, sheetsPerSignature: 3, binding: 'left', flip: 'short',
    paperThickness: 0.1, maxCompensation: 5, balancedSplit: true,
  });
  assert.equal(r.creep.enabled, true);
  // 顶层数组仍按上限给出
  assert.deepEqual(r.creep.sheetCompensationMm, [0, 0.2, 0.4]);
  // 各帖按实际张数给出补偿序列
  assert.deepEqual(r.signatures[0].sheetCompensationMm, [0, 0.2, 0.4]);
  assert.deepEqual(r.signatures[1].sheetCompensationMm, [0, 0.2, 0.4]);
  assert.deepEqual(r.signatures[2].sheetCompensationMm, [0, 0.2]);
  // 末帖第 2 张（最内层，i=1）：±0.2
  const inner = r.signatures[2].sheets[1];
  assert.equal(inner.front.left.offsetMm, 0.2);
  assert.equal(inner.front.right.offsetMm, -0.2);
  assert.equal(inner.back.left.offsetMm, 0.2);
  assert.equal(inner.back.right.offsetMm, -0.2);
  // 末帖空白页（28、29、32）也带对应偏移：末帖第 1 张 i=0 补偿为 0
  const outer = r.signatures[2].sheets[0];
  assert.equal(outer.front.left.blank, true); // 第 32 页
  assert.equal(outer.front.left.offsetMm, 0);
});

test('均衡分帖：不启用爬移时所有页位 offsetMm 为 0', () => {
  const r = computeImposition({ totalPages: 30, sheetsPerSignature: 3, binding: 'left', flip: 'short', balancedSplit: true });
  assert.equal(r.creep.enabled, false);
  r.signatures.forEach((sig) => {
    assert.deepEqual(sig.sheetCompensationMm, Array(sig.actualSheetCount).fill(0));
  });
  allSlotsOf(r).forEach((s) => assert.equal(s.offsetMm, 0));
});

test('均衡分帖：适配检查按实际纸张总数统计页位（32 页位含空白）', () => {
  const r = computeImposition({
    totalPages: 30, sheetsPerSignature: 3, binding: 'left', flip: 'short', balancedSplit: true,
    paperWidth: 440, paperHeight: 310, pageWidth: 210, pageHeight: 297, bleedMm: 3, safetyMm: 5,
  });
  assert.equal(r.fit.enabled, true);
  assert.equal(r.fit.totalSlots, 32);
  allSlotsOf(r).forEach((s) => {
    assert.ok(s.fit);
    assert.equal(s.fit.ok, true);
  });
});

test('均衡分帖：穷举页数与上限，实际张数不超限、差不超过 1、空白只在末帖', () => {
  for (let totalPages = 1; totalPages <= 130; totalPages++) {
    for (let maxSheets = 1; maxSheets <= 6; maxSheets++) {
      const r = computeImposition({ totalPages, sheetsPerSignature: maxSheets, binding: 'left', flip: 'short', balancedSplit: true });
      const counts = r.balanced.actualSheetCounts;
      assert.equal(counts.length, r.signatureCount);
      counts.forEach((n) => assert.ok(n >= 1 && n <= maxSheets));
      const spread = Math.max(...counts) - Math.min(...counts);
      assert.ok(spread <= 1, `页数 ${totalPages} 上限 ${maxSheets}: 张数 spread=${spread}`);
      assert.equal(r.paddedPages, counts.reduce((a, b) => a + b * 4, 0));
      assert.equal(r.blankPages, r.paddedPages - totalPages);
      assert.equal(r.balanced.savedBlankPages, r.balanced.fixedPaddedPages - r.paddedPages);
      // 非空白页恰好覆盖 1..totalPages
      const printed = allSlotsOf(r).filter((s) => !s.blank).map((s) => s.page).sort((a, b) => a - b);
      assert.deepEqual(printed, Array.from({ length: totalPages }, (_, i) => i + 1));
      // 空白页只在末帖
      r.signatures.slice(0, -1).forEach((sig) => assert.equal(sig.blankPages, 0));
      assert.equal(r.signatures[r.signatures.length - 1].blankPages, r.blankPages);
    }
  }
});

test('均衡分帖开关必须为布尔值', () => {
  assert.throws(
    () => computeImposition({ totalPages: 8, sheetsPerSignature: 2, binding: 'left', flip: 'short', balancedSplit: 'yes' }),
    /均衡分帖/
  );
  assert.throws(
    () => computeImposition({ totalPages: 8, sheetsPerSignature: 2, binding: 'left', flip: 'short', balancedSplit: 1 }),
    /均衡分帖/
  );
});

test('显式 balancedSplit=false 与缺省结果一致', () => {
  const common = { totalPages: 23, sheetsPerSignature: 3, binding: 'left', flip: 'long', paperThickness: 0.1, maxCompensation: 1 };
  const a = computeImposition(common);
  const b = computeImposition({ ...common, balancedSplit: false });
  // 生成时间与 balanced 元数据外完全一致
  delete a.meta.generatedAt;
  delete b.meta.generatedAt;
  assert.deepEqual(b, a);
});
