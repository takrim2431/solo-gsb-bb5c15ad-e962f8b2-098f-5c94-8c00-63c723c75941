'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeImposition } = require('../src/imposition');

// BASE：8 页、每帖 2 张 -> 1 帖 2 张；左装订、短边翻转下页位为
// 第 1 张：正面 [8, 1]、背面 [2, 7]；第 2 张：正面 [6, 3]、背面 [4, 5]
const BASE = { totalPages: 8, sheetsPerSignature: 2, binding: 'left', flip: 'short' };
const DV = { copiesA: 1000, copiesB: 500, changedPages: [2] };

test('未启用双版本共版：响应不含 dualVersion 字段（原响应完全不变）', () => {
  const r = computeImposition({ ...BASE });
  assert.equal(r.dualVersion, undefined);
  const explicitOff = computeImposition({ ...BASE, dualVersion: false });
  assert.equal(explicitOff.dualVersion, undefined);
  const nullOff = computeImposition({ ...BASE, dualVersion: null });
  assert.equal(nullOff.dualVersion, undefined);
  const disabledObj = computeImposition({ ...BASE, dualVersion: { enabled: false, ...DV } });
  assert.equal(disabledObj.dualVersion, undefined);
});

test('逐张逐面判定：含改动页的面拆 A、B 两块版，无改动的面共用一块版（印次 = A + B）', () => {
  const r = computeImposition({ ...BASE, dualVersion: DV });
  const dv = r.dualVersion;
  assert.equal(dv.enabled, true);
  assert.equal(dv.copiesA, 1000);
  assert.equal(dv.copiesB, 500);
  assert.deepEqual(dv.changedPages, [2]);
  assert.equal(dv.changedPageCount, 1);
  assert.equal(dv.rows.length, 4); // 2 张 × 2 面

  // 第 1 张正面 [8, 1]：无改动页 -> 共用 1 块版，印次 1000 + 500 = 1500
  const front1 = dv.rows[0];
  assert.deepEqual(
    { signature: front1.signature, sheet: front1.sheet, side: front1.side, leftPage: front1.leftPage, rightPage: front1.rightPage },
    { signature: 1, sheet: 1, side: 'front', leftPage: 8, rightPage: 1 }
  );
  assert.equal(front1.shared, true);
  assert.deepEqual(front1.changedPages, []);
  assert.deepEqual(front1.plates, [{ plate: 'shared', impressions: 1500 }]);

  // 第 1 张背面 [2, 7]：含改动页 2 -> 拆 A、B 两块版，各按自身份数印刷
  const back1 = dv.rows[1];
  assert.equal(back1.side, 'back');
  assert.deepEqual([back1.leftPage, back1.rightPage], [2, 7]);
  assert.equal(back1.shared, false);
  assert.deepEqual(back1.changedPages, [2]);
  assert.deepEqual(back1.plates, [
    { plate: 'A', impressions: 1000 },
    { plate: 'B', impressions: 500 },
  ]);

  // 第 2 张正背面 [6, 3] / [4, 5]：均无改动页 -> 共用
  assert.equal(dv.rows[2].shared, true);
  assert.equal(dv.rows[3].shared, true);

  // 汇总：4 面，共版 3 面、拆版 1 面；印版 3×1 + 1×2 = 5 块；总印次 4 × 1500 = 6000
  const t = dv.totals;
  assert.equal(t.sideCount, 4);
  assert.equal(t.sharedSideCount, 3);
  assert.equal(t.splitSideCount, 1);
  assert.equal(t.sharedPlateCount, 3);
  assert.equal(t.splitPlateCount, 2);
  assert.equal(t.plateCount, 5);
  assert.equal(t.savedPlateCount, 3); // 全部拆版需 8 块，共版节省 3 块
  assert.equal(t.impressions, 6000);
});

test('同张纸正背面独立判定：改动页在正面时背面仍共版，反之亦然', () => {
  // 页 1 在第 1 张正面、页 2 在第 1 张背面
  const frontChanged = computeImposition({ ...BASE, dualVersion: { copiesA: 10, copiesB: 5, changedPages: [1] } });
  const rows1 = frontChanged.dualVersion.rows;
  assert.equal(rows1[0].shared, false); // 正面 [8, 1] 含页 1 -> 拆版
  assert.deepEqual(rows1[0].changedPages, [1]);
  assert.equal(rows1[1].shared, true); // 背面 [2, 7] 无改动 -> 共版
  assert.equal(frontChanged.dualVersion.totals.splitSideCount, 1);

  const backChanged = computeImposition({ ...BASE, dualVersion: { copiesA: 10, copiesB: 5, changedPages: [2] } });
  const rows2 = backChanged.dualVersion.rows;
  assert.equal(rows2[0].shared, true); // 正面无改动 -> 共版
  assert.equal(rows2[1].shared, false); // 背面含页 2 -> 拆版
});

test('一个面两个页位均为改动页：仍只拆 A、B 两块版', () => {
  // 第 1 张正面为页 8 与页 1
  const r = computeImposition({ ...BASE, dualVersion: { copiesA: 4, copiesB: 3, changedPages: [1, 8] } });
  const front1 = r.dualVersion.rows[0];
  assert.equal(front1.shared, false);
  assert.deepEqual(front1.changedPages, [1, 8]);
  assert.deepEqual(front1.plates, [
    { plate: 'A', impressions: 4 },
    { plate: 'B', impressions: 3 },
  ]);
  assert.equal(r.dualVersion.totals.splitSideCount, 1);
  assert.equal(r.dualVersion.totals.plateCount, 2 + 3); // 拆版 2 块 + 共版 3 块
});

test('改动页码：单页与区间混合、去重并升序；支持数组 / 字符串 / 区间对象', () => {
  const expected = [2, 5, 6, 7];
  const fromArray = computeImposition({ ...BASE, dualVersion: { copiesA: 1, copiesB: 1, changedPages: [7, '5-6', 2, '2', 6] } });
  assert.deepEqual(fromArray.dualVersion.changedPages, expected);

  const fromString = computeImposition({ ...BASE, dualVersion: { copiesA: 1, copiesB: 1, changedPages: '2, 5-7，6' } });
  assert.deepEqual(fromString.dualVersion.changedPages, expected);

  const fromObjects = computeImposition({ ...BASE, dualVersion: { copiesA: 1, copiesB: 1, changedPages: [{ start: 5, end: 7 }, 2, 6] } });
  assert.deepEqual(fromObjects.dualVersion.changedPages, expected);

  // 空白分隔的单页与带空格的区间连字符（逗号分隔时区间整体识别）
  const spaced = computeImposition({ ...BASE, dualVersion: { copiesA: 1, copiesB: 1, changedPages: '2, 5 - 7' } });
  assert.deepEqual(spaced.dualVersion.changedPages, expected);
  const spaceSeparated = computeImposition({ ...BASE, dualVersion: { copiesA: 1, copiesB: 1, changedPages: '2 5 6 7' } });
  assert.deepEqual(spaceSeparated.dualVersion.changedPages, expected);
});

test('空白页位不参与改动判定：含空白页的面无改动页时仍共版', () => {
  // 5 页 -> 1 帖 2 张，补 3 个空白页；页 5 在第 2 张背面右页位
  const r = computeImposition({
    totalPages: 5,
    sheetsPerSignature: 2,
    binding: 'left',
    flip: 'short',
    dualVersion: { copiesA: 100, copiesB: 20, changedPages: [5] },
  });
  const dv = r.dualVersion;
  assert.equal(dv.rows.length, 4);
  const splitRows = dv.rows.filter((row) => !row.shared);
  assert.equal(splitRows.length, 1);
  assert.deepEqual(
    { signature: splitRows[0].signature, sheet: splitRows[0].sheet, side: splitRows[0].side },
    { signature: 1, sheet: 2, side: 'back' }
  );
  // 第 1 张正面 [空白, 1]、第 2 张正面 [空白, 3]：含空白页位但无改动页 -> 共版
  const front1 = dv.rows.find((row) => row.sheet === 1 && row.side === 'front');
  assert.equal(front1.leftPage, null);
  assert.equal(front1.shared, true);
  assert.equal(front1.plates[0].impressions, 120);
});

test('均衡分帖 / 章节优先分帖下沿用各自页位判定', () => {
  // 17 页均衡分帖 -> 各帖实际 [2, 2, 1] 张，页 17 在末帖
  const balanced = computeImposition({
    totalPages: 17,
    sheetsPerSignature: 2,
    binding: 'left',
    flip: 'short',
    balancedSplit: true,
    dualVersion: { copiesA: 10, copiesB: 2, changedPages: [17] },
  });
  const dv = balanced.dualVersion;
  assert.equal(dv.rows.length, 10); // 5 张 × 2 面
  const splitRows = dv.rows.filter((row) => !row.shared);
  assert.equal(splitRows.length, 1);
  assert.equal(splitRows[0].signature, 3); // 末帖
  assert.deepEqual(splitRows[0].changedPages, [17]);
  assert.equal(dv.totals.impressions, 10 * 12);

  // 20 页章节优先分帖 -> 3 帖各 2 张（含章末补白）
  const chapter = computeImposition({
    totalPages: 20,
    sheetsPerSignature: 2,
    binding: 'left',
    flip: 'short',
    chapterSplit: true,
    chapterStarts: [1, 9, 14, 18],
    dualVersion: { copiesA: 10, copiesB: 2, changedPages: ['9-10', 20] },
  });
  const cdv = chapter.dualVersion;
  assert.deepEqual(cdv.changedPages, [9, 10, 20]);
  assert.equal(cdv.rows.length, 12); // 6 张 × 2 面
  assert.equal(cdv.totals.splitSideCount, 3); // 页 9、10、20 各落在一个面
  assert.equal(cdv.totals.plateCount, 12 - 3 + 3 * 2);
});

test('双版本共版参数非法返回明确错误', () => {
  assert.throws(
    () => computeImposition({ ...BASE, dualVersion: { copiesB: 500, changedPages: [2] } }),
    /A 版成品份数/
  );
  assert.throws(
    () => computeImposition({ ...BASE, dualVersion: { copiesA: 0, copiesB: 500, changedPages: [2] } }),
    /A 版成品份数/
  );
  assert.throws(
    () => computeImposition({ ...BASE, dualVersion: { copiesA: 100, copiesB: 1.5, changedPages: [2] } }),
    /B 版成品份数/
  );
  assert.throws(
    () => computeImposition({ ...BASE, dualVersion: { copiesA: 100, copiesB: 500 } }),
    /changedPages 必填/
  );
  assert.throws(
    () => computeImposition({ ...BASE, dualVersion: { copiesA: 100, copiesB: 500, changedPages: [] } }),
    /不能为空/
  );
  assert.throws(
    () => computeImposition({ ...BASE, dualVersion: { copiesA: 100, copiesB: 500, changedPages: '' } }),
    /不能为空/
  );
  assert.throws(
    () => computeImposition({ ...BASE, dualVersion: { copiesA: 100, copiesB: 500, changedPages: [0] } }),
    /超出范围（1 ~ 8）/
  );
  assert.throws(
    () => computeImposition({ ...BASE, dualVersion: { copiesA: 100, copiesB: 500, changedPages: [9] } }),
    /超出范围（1 ~ 8）/
  );
  assert.throws(
    () => computeImposition({ ...BASE, dualVersion: { copiesA: 100, copiesB: 500, changedPages: ['7-9'] } }),
    /超出范围（1 ~ 8）/
  );
  assert.throws(
    () => computeImposition({ ...BASE, dualVersion: { copiesA: 100, copiesB: 500, changedPages: ['5-3'] } }),
    /起点不能大于终点/
  );
  assert.throws(
    () => computeImposition({ ...BASE, dualVersion: { copiesA: 100, copiesB: 500, changedPages: ['abc'] } }),
    /无法解析/
  );
  assert.throws(
    () => computeImposition({ ...BASE, dualVersion: { copiesA: 100, copiesB: 500, changedPages: [2.5] } }),
    /必须为整数/
  );
  assert.throws(
    () => computeImposition({ ...BASE, dualVersion: 'x' }),
    /dualVersion 必须为对象/
  );
  assert.throws(
    () => computeImposition({ ...BASE, dualVersion: { copiesA: 100, copiesB: 500, changedPages: 3 } }),
    /必须为数组或字符串/
  );
});

test('份数接受数字字符串（表单风格）', () => {
  const r = computeImposition({
    ...BASE,
    dualVersion: { copiesA: '1000', copiesB: '500', changedPages: [2] },
  });
  assert.equal(r.dualVersion.enabled, true);
  assert.equal(r.dualVersion.totals.impressions, 6000);
});
