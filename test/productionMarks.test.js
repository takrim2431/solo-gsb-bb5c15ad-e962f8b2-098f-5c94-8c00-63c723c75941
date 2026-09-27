'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeImposition } = require('../src/imposition');
const {
  transformSegment,
  segIntersect,
  parseMarkSizeMm,
  DEFAULT_MARK_SIZE_MM,
  MARK_GAP_MM,
  MAX_MARK_SIZE_MM,
} = require('../src/productionMarks');

const FIT = { paperWidth: 460, paperHeight: 330, pageWidth: 210, pageHeight: 297, bleedMm: 3, safetyMm: 5 };
const BASE = { totalPages: 8, sheetsPerSignature: 2, binding: 'left', flip: 'short', ...FIT };

function sheetMarks(r, signature = 1, sheet = 1) {
  return r.signatures[signature - 1].sheets[sheet - 1].productionMarks;
}

test('未启用：productionMarks 仅 { enabled: false }，sheet 不带 productionMarks 字段（向后兼容）', () => {
  const r = computeImposition(BASE);
  assert.deepEqual(r.productionMarks, { enabled: false });
  r.signatures.forEach((sig) => {
    sig.sheets.forEach((sheet) => assert.equal(sheet.productionMarks, undefined));
  });
});

test('未启用适配检查时显式传 productionMarks:false 也不影响响应', () => {
  const r = computeImposition({ totalPages: 8, sheetsPerSignature: 2, binding: 'left', flip: 'short', productionMarks: false });
  assert.deepEqual(r.productionMarks, { enabled: false });
  assert.equal(r.input.productionMarks, false);
  assert.equal(r.input.markSizeMm, 0);
});

test('启用：每张纸正背面各放置 8 裁切线 + 2 折线标 + 2 套准十字（共 12 个/面）', () => {
  const r = computeImposition({ ...BASE, productionMarks: true });
  assert.equal(r.productionMarks.enabled, true);
  assert.equal(r.productionMarks.markSizeMm, DEFAULT_MARK_SIZE_MM);
  assert.equal(r.productionMarks.gapMm, MARK_GAP_MM);
  const m = sheetMarks(r);
  const byType = (arr) => arr.reduce((acc, mark) => {
    acc[mark.type] = (acc[mark.type] || 0) + 1;
    return acc;
  }, {});
  assert.deepEqual(byType(m.front.placed), { crop: 8, fold: 2, register: 2 });
  assert.deepEqual(byType(m.back.placed), { crop: 8, fold: 2, register: 2 });
  assert.deepEqual(m.front.omitted, []);
  assert.deepEqual(m.back.omitted, []);
  // 两张纸（共 2 张）× 2 面 × 12 = 48 个已放置标记
  assert.equal(r.productionMarks.placedCount, 48);
  assert.equal(r.productionMarks.omittedCount, 0);
  // sheets 汇总逐张统计
  assert.deepEqual(r.productionMarks.sheets[0], {
    signature: 1, sheet: 1,
    front: { placedCount: 12, omittedCount: 0 },
    back: { placedCount: 12, omittedCount: 0 },
  });
});

test('裁切线坐标：起点距出血框 2mm，向纸边延伸 5mm，完整落在纸内', () => {
  const r = computeImposition({ ...BASE, productionMarks: true });
  const m = sheetMarks(r);
  // 460 纸张、页位 230：左页位 trim x=10、bleedBox x 7..223；trim 上边 y=16.5
  const tlH = m.front.placed.find((x) => x.id === 'crop-tl-h');
  assert.deepEqual(tlH.segments, [{ x1: 5, y1: 16.5, x2: 0, y2: 16.5 }]);
  // 右上角水平裁切线：右页位 bleedBox 右边界 453 + gap = 455，延伸至 460（贴边）
  const trH = m.front.placed.find((x) => x.id === 'crop-tr-h');
  assert.equal(trH.segments[0].x1, 455);
  assert.equal(trH.segments[0].x2, 460);
  // 上方竖直裁切线：bleedBox 上边界 13.5 - gap = 11.5，向上延伸至 6.5
  const tlV = m.front.placed.find((x) => x.id === 'crop-tl-v');
  assert.equal(tlV.segments[0].y1, 11.5);
  assert.equal(tlV.segments[0].y2, 6.5);
  // 折线标位于纸张中线 x=230
  const foldTop = m.front.placed.find((x) => x.id === 'fold-top');
  assert.deepEqual(foldTop.segments, [{ x1: 230, y1: 0, x2: 230, y2: 5 }]);
  const foldBottom = m.front.placed.find((x) => x.id === 'fold-bottom');
  assert.deepEqual(foldBottom.segments, [{ x1: 230, y1: 330, x2: 230, y2: 325 }]);
});

test('套准十字：首个候选（出血框垂直居中）落位，position=1', () => {
  const r = computeImposition({ ...BASE, productionMarks: true });
  const m = sheetMarks(r);
  const left = m.front.placed.find((x) => x.id === 'register-left');
  assert.equal(left.position, 1);
  assert.equal(left.positionLabel, '出血框垂直居中');
  // 中心 cx = bleedBox.x - 2 = 7 - 2 = 5；y = 165
  assert.deepEqual(left.segments, [
    { x1: 5, y1: 165, x2: 0, y2: 165 },
    { x1: 5, y1: 162.5, x2: 5, y2: 167.5 },
  ]);
  const right = m.front.placed.find((x) => x.id === 'register-right');
  // 中心 cx = bleedBox 右边界 453 + 2 = 455；水平段向右到 460
  assert.deepEqual(right.segments, [
    { x1: 455, y1: 165, x2: 460, y2: 165 },
    { x1: 455, y1: 162.5, x2: 455, y2: 167.5 },
  ]);
});

test('短边翻转：背面标记 = 正面 (W - x, y) 变换，物理位置与正面对齐', () => {
  const r = computeImposition({ ...BASE, flip: 'short', productionMarks: true });
  const m = sheetMarks(r);
  m.front.placed.forEach((f) => {
    const b = m.back.placed.find((x) => x.pairedWith === f.id);
    assert.ok(b, `背面缺少与 ${f.id} 配对的标记`);
    assert.equal(b.side, 'back');
    assert.equal(b.type, f.type);
    f.segments.forEach((seg, i) => {
      const expected = transformSegment(seg, 'short', 460, 330);
      assert.deepEqual(b.segments[i], {
        x1: Math.round(expected.x1 * 10000) / 10000,
        y1: Math.round(expected.y1 * 10000) / 10000,
        x2: Math.round(expected.x2 * 10000) / 10000,
        y2: Math.round(expected.y2 * 10000) / 10000,
      });
    });
  });
  // 左侧套准十字经短边翻转后落到右侧（x: 5 -> 455）
  const backLeft = m.back.placed.find((x) => x.pairedWith === 'register-left');
  assert.equal(backLeft.segments[0].x1, 455);
  assert.equal(backLeft.segments[0].x2, 460);
  assert.deepEqual(r.productionMarks.transform, { flip: 'short', mapping: '(x, y) -> (W - x, y)' });
});

test('长边翻转：背面标记 = 正面 (x, H - y) 变换，x 不变、y 镜像', () => {
  const r = computeImposition({ ...BASE, flip: 'long', productionMarks: true });
  const m = sheetMarks(r);
  const fTop = m.front.placed.find((x) => x.id === 'fold-top');
  const bTop = m.back.placed.find((x) => x.pairedWith === 'fold-top');
  // 正面上方折线标（y 0..5）翻转后到下方（y 330..325），与正面下方折线标物理重合
  assert.deepEqual(bTop.segments, [{ x1: 230, y1: 330, x2: 230, y2: 325 }]);
  const fCrop = m.front.placed.find((x) => x.id === 'crop-tl-h');
  const bCrop = m.back.placed.find((x) => x.pairedWith === 'crop-tl-h');
  assert.equal(bCrop.segments[0].x1, fCrop.segments[0].x1);
  assert.equal(bCrop.segments[0].y1, 330 - fCrop.segments[0].y1);
  assert.deepEqual(r.productionMarks.transform, { flip: 'long', mapping: '(x, y) -> (x, H - y)' });
  // 背面每个标记带变换说明
  bTop.segments.forEach(() => {});
  assert.equal(bTop.transform.flip, 'long');
});

test('爬移变化后标记同步重算：内层纸张 bleedBox 随 offsetMm 平移，裁切线起点跟随', () => {
  const r = computeImposition({
    ...BASE, paperThickness: 0.5, maxCompensation: 5,
    productionMarks: true,
  });
  // 第 2 张由外向内 i=1：creep = min(1 × 0.5 × 2, 5) = 1mm；左页位 +1
  assert.deepEqual(r.creep.sheetCompensationMm, [0, 1]);
  const s1 = sheetMarks(r, 1, 1);
  const s2 = sheetMarks(r, 1, 2);
  const c1 = s1.front.placed.find((x) => x.id === 'crop-tl-h');
  const c2 = s2.front.placed.find((x) => x.id === 'crop-tl-h');
  // 第 1 张 bleedBox 左边界 7、起点 5；第 2 张整体 +1mm 后起点 6
  assert.equal(c1.segments[0].x1, 5);
  assert.equal(c2.segments[0].x1, 6);
});

test('标记尺寸开关：自定义 markSizeMm 生效，缺省 5mm', () => {
  const r = computeImposition({ ...BASE, productionMarks: true, markSizeMm: 10 });
  assert.equal(r.productionMarks.markSizeMm, 10);
  const foldTop = sheetMarks(r).front.placed.find((x) => x.id === 'fold-top');
  assert.deepEqual(foldTop.segments, [{ x1: 230, y1: 0, x2: 230, y2: 10 }]);
});

test('纸张过小无可用位置：标记省略并逐候选返回原因，背面同步省略', () => {
  // 426×303 纸张放 210×297 + 出血 3：两侧出血框几乎贴满纸张，
  // 裁切线 / 套准十字没有纸面空间（折线标与出血框相交），全部省略
  const r = computeImposition({
    ...BASE, paperWidth: 426, paperHeight: 303,
    productionMarks: true,
  });
  const m = sheetMarks(r);
  assert.equal(m.front.placed.length, 0);
  assert.equal(m.front.omitted.length, 12);
  assert.equal(m.back.placed.length, 0);
  assert.equal(m.back.omitted.length, 12);
  const crop = m.front.omitted.find((o) => o.id === 'crop-tl-h');
  assert.equal(crop.type, 'crop');
  assert.equal(crop.reasonCode, 'segment-outside-paper');
  assert.match(crop.reason, /候选位置 0/);
  assert.match(crop.reason, /线段超出纸张边界/);
  assert.ok(crop.attempts[0].checks.some((c) => c.code === 'segment-outside-paper'));
  // 套准十字：3 个候选全部尝试
  const reg = m.front.omitted.find((o) => o.id === 'register-left');
  assert.equal(reg.attempts.length, 3);
  assert.deepEqual(reg.attempts.map((a) => a.position), [1, 2, 3]);
  assert.match(reg.reason, /候选位置 1/);
  assert.match(reg.reason, /候选位置 3/);
  // 折线标与出血框相交（中线两侧出血框在中线上相接）
  const fold = m.front.omitted.find((o) => o.id === 'fold-top');
  assert.equal(fold.reasonCode, 'segment-hits-bleed-box');
  // 背面省略原因指向正面同名标记
  const backReg = m.back.omitted.find((o) => o.id === 'register-left');
  assert.equal(backReg.reasonCode, 'paired-front-omitted');
  assert.equal(backReg.pairedWith, 'register-left');
  assert.match(backReg.reasonSummary, /正面同名标记已省略/);
  assert.match(backReg.reason, /与正面同一物理位置/);
  assert.match(backReg.reason, /背面同步省略/);
  // 顶层汇总
  assert.equal(r.productionMarks.placedCount, 0);
  assert.equal(r.productionMarks.omittedCount, 48); // 2 张 × 2 面 × 12
});

test('部分省略：大尺寸标记伸出纸张被省略，小尺寸标记正常落位', () => {
  // 460×330 纸面：两侧出血框外水平方向仅有 5mm 空间（出血框左边界 7 − 间隙 2），
  // 尺寸 8 时水平裁切线与套准十字伸出纸外（套准十字 3 个候选均失败）；
  // 竖直裁切线外侧有 11.5mm（13.5 − 2）空间、折线标在纸面中线上，仍可落位。
  const r = computeImposition({ ...BASE, productionMarks: true, markSizeMm: 8 });
  const m = sheetMarks(r);
  const placedIds = m.front.placed.map((x) => x.id).sort();
  assert.deepEqual(placedIds, [
    'crop-bl-v', 'crop-br-v', 'crop-tl-v', 'crop-tr-v',
    'fold-bottom', 'fold-top',
  ]);
  const omittedIds = m.front.omitted.map((o) => o.id).sort();
  assert.deepEqual(omittedIds, [
    'crop-bl-h', 'crop-br-h', 'crop-tl-h', 'crop-tr-h',
    'register-left', 'register-right',
  ]);
  const reg = m.front.omitted.find((o) => o.id === 'register-left');
  assert.equal(reg.attempts.length, 3);
  assert.ok(reg.attempts.every((a) => a.ok === false));
});

test('标记不与出血框相交：常规落位时所有线段与两侧出血框不相交', () => {
  const r = computeImposition({ ...BASE, productionMarks: true });
  const leftBox = r.signatures[0].sheets[0].front.left.fit.bleedBox;
  const rightBox = r.signatures[0].sheets[0].front.right.fit.bleedBox;
  const rectHit = (seg, box) => {
    const minX = Math.min(seg.x1, seg.x2);
    const maxX = Math.max(seg.x1, seg.x2);
    const minY = Math.min(seg.y1, seg.y2);
    const maxY = Math.max(seg.y1, seg.y2);
    return minX < box.x + box.width - 1e-9 && box.x < maxX - 1e-9
      && minY < box.y + box.height - 1e-9 && box.y < maxY - 1e-9;
  };
  sheetMarks(r).front.placed.forEach((mark) => {
    mark.segments.forEach((seg) => {
      assert.equal(rectHit(seg, leftBox), false, `${mark.id} 与左出血框相交`);
      assert.equal(rectHit(seg, rightBox), false, `${mark.id} 与右出血框相交`);
      // 全部线段落在纸张内
      assert.ok(Math.min(seg.x1, seg.x2) >= -1e-9 && Math.max(seg.x1, seg.x2) <= 460 + 1e-9);
      assert.ok(Math.min(seg.y1, seg.y2) >= -1e-9 && Math.max(seg.y1, seg.y2) <= 330 + 1e-9);
    });
  });
});

test('同面已放置标记互不相交（裁切线、折线标、套准十字）', () => {
  const r = computeImposition({ ...BASE, productionMarks: true });
  const marks = sheetMarks(r).front.placed;
  for (let i = 0; i < marks.length; i += 1) {
    for (let j = i + 1; j < marks.length; j += 1) {
      for (const a of marks[i].segments) {
        for (const b of marks[j].segments) {
          assert.equal(segIntersect(a, b), false, `${marks[i].id} 与 ${marks[j].id} 相交`);
        }
      }
    }
  }
});

test('参数校验：开关非布尔值、尺寸非法、未启用适配检查均报错', () => {
  assert.throws(
    () => computeImposition({ ...BASE, productionMarks: 'yes' }),
    /开关必须为布尔值/
  );
  assert.throws(
    () => computeImposition({ totalPages: 8, sheetsPerSignature: 2, binding: 'left', flip: 'short', productionMarks: true }),
    /必须同时启用纸张适配检查/
  );
  assert.throws(() => computeImposition({ ...BASE, productionMarks: true, markSizeMm: 0 }), /标记尺寸必须为 > 0/);
  assert.throws(() => computeImposition({ ...BASE, productionMarks: true, markSizeMm: -2 }), /标记尺寸必须为 > 0/);
  assert.throws(() => computeImposition({ ...BASE, productionMarks: true, markSizeMm: 'x' }), /标记尺寸必须为 > 0/);
  assert.throws(
    () => computeImposition({ ...BASE, productionMarks: true, markSizeMm: MAX_MARK_SIZE_MM + 1 }),
    new RegExp(`不能超过 ${MAX_MARK_SIZE_MM}`)
  );
});

test('parseMarkSizeMm：缺省 / null / 空串取缺省值', () => {
  assert.equal(parseMarkSizeMm(undefined), DEFAULT_MARK_SIZE_MM);
  assert.equal(parseMarkSizeMm(null), DEFAULT_MARK_SIZE_MM);
  assert.equal(parseMarkSizeMm(''), DEFAULT_MARK_SIZE_MM);
  assert.equal(parseMarkSizeMm('  '), DEFAULT_MARK_SIZE_MM);
  assert.equal(parseMarkSizeMm('8'), 8);
  assert.equal(parseMarkSizeMm(8.5), 8.5);
});

test('线段相交原语：共线重叠算相交，端点相接 / 十字端点不算，内部十字算相交', () => {
  // 水平共线重叠
  assert.equal(segIntersect({ x1: 0, y1: 5, x2: 10, y2: 5 }, { x1: 5, y1: 5, x2: 15, y2: 5 }), true);
  // 竖直共线重叠
  assert.equal(segIntersect({ x1: 3, y1: 0, x2: 3, y2: 10 }, { x1: 3, y1: 8, x2: 3, y2: 20 }), true);
  // 仅端点相接（水平）
  assert.equal(segIntersect({ x1: 0, y1: 5, x2: 5, y2: 5 }, { x1: 5, y1: 5, x2: 15, y2: 5 }), false);
  // 十字内部相交
  assert.equal(segIntersect({ x1: 0, y1: 5, x2: 10, y2: 5 }, { x1: 5, y1: 0, x2: 5, y2: 10 }), true);
  // 十字恰在横线端点相接
  assert.equal(segIntersect({ x1: 0, y1: 5, x2: 5, y2: 5 }, { x1: 5, y1: 0, x2: 5, y2: 10 }), false);
  // 不相交 / 平行紧邻不共线
  assert.equal(segIntersect({ x1: 0, y1: 0, x2: 4, y2: 0 }, { x1: 5, y1: 0, x2: 9, y2: 0 }), false);
  assert.equal(segIntersect({ x1: 0, y1: 5, x2: 10, y2: 5 }, { x1: 0, y1: 6, x2: 10, y2: 6 }), false);
});

test('线段与出血框：共线于框边界仅端点相接不算，沿边界正长度重叠算相交', () => {
  const { placeFrontMarks } = require('../src/productionMarks');
  // 直接构造一张带 fit 的最小纸张数据：左/右页位 trim 100×100、出血框 90..110
  const fitLeft = {
    trim: { x: 0, y: 0, width: 100, height: 100 },
    bleedBox: { x: -10, y: -10, width: 120, height: 120 },
  };
  const fitRight = {
    trim: { x: 100, y: 0, width: 100, height: 100 },
    bleedBox: { x: 90, y: -10, width: 120, height: 120 },
  };
  const fakeSheet = { front: { left: { fit: fitLeft }, right: { fit: fitRight } } };
  // 纸张 200×200，尺寸 3：折线标 x=100 落在两侧出血框并集区间内（左框到 110）-> 省略
  const { placed, omitted } = placeFrontMarks(fakeSheet, 200, 200, 3);
  assert.ok(omitted.some((o) => o.id === 'fold-top' && o.reasonCode === 'segment-hits-bleed-box'));
  // 裁切线水平段 y=0（trim 顶边）位于出血框 y 区间 [-10,110] 内，x -12..-15 全程
  // 在出血框（左边界 -10）与纸张之外 -> 先报超出纸张
  const cropH = omitted.find((o) => o.id === 'crop-tl-h');
  assert.equal(cropH.reasonCode, 'segment-outside-paper');
  assert.ok(cropH.attempts[0].checks.some((c) => c.code === 'segment-outside-paper'));
  // 竖直段自 y=-12 向上到 -15 -> 同样出纸
  assert.ok(omitted.some((o) => o.id === 'crop-tl-v' && o.reasonCode === 'segment-outside-paper'));
  // 套准十字：左框左边界 -10 外 2mm = -12，水平段向左伸出纸外 -> 三个候选全失败
  const reg = omitted.find((o) => o.id === 'register-left');
  assert.ok(reg && reg.attempts.length === 3);
  // 放置成功的标记不包含被省略项
  assert.equal(placed.some((p) => p.id === 'fold-top'), false);
});

test('segHitsBox：线段沿框边界正长度重叠算相交，仅端点 / 角点相接不算', () => {
  const { segHitsBox } = require('../src/productionMarks');
  const box = { x: 10, y: 20, width: 30, height: 40 }; // 10..40 × 20..60
  // 水平线 y=20（框上边界），x 5..15：与边界 [10,20) 正长度重叠 -> 相交
  assert.equal(segHitsBox({ x1: 5, y1: 20, x2: 15, y2: 20 }, box), true);
  // 水平线 y=19（框外 1mm）-> 不相交
  assert.equal(segHitsBox({ x1: 10, y1: 19, x2: 40, y2: 19 }, box), false);
  // 水平线终点恰在框角 (10,20) -> 仅角点相接，不算
  assert.equal(segHitsBox({ x1: 0, y1: 20, x2: 10, y2: 20 }, box), false);
  // 竖直线 x=10（框左边界），y 25..30 沿边界 -> 相交
  assert.equal(segHitsBox({ x1: 10, y1: 25, x2: 10, y2: 30 }, box), true);
  // 竖直线穿过框内部 -> 相交
  assert.equal(segHitsBox({ x1: 25, y1: 0, x2: 25, y2: 100 }, box), true);
});

test('试印核验重算不受生产标记影响：同时启用时 verification 正常返回', () => {
  const r = computeImposition({
    ...BASE,
    productionMarks: true,
    observations: [
      { signature: 1, sheet: 1, side: 'front', position: 'right', page: 1, orientation: 'upright' },
    ],
  });
  assert.equal(r.verification.enabled, true);
  // 标记仍正常生成
  assert.equal(sheetMarks(r).front.placed.length, 12);
});

test('空白页纸张同样生成生产标记', () => {
  const r = computeImposition({
    totalPages: 10, sheetsPerSignature: 2, binding: 'left', flip: 'short',
    ...FIT, productionMarks: true,
  });
  // 第 2 帖第 2 张全部空白
  const allBlank = [
    r.signatures[1].sheets[1].front.left,
    r.signatures[1].sheets[1].front.right,
    r.signatures[1].sheets[1].back.left,
    r.signatures[1].sheets[1].back.right,
  ].every((s) => s.blank);
  assert.ok(allBlank);
  const m = sheetMarks(r, 2, 2);
  assert.equal(m.front.placed.length, 12);
  assert.equal(m.back.placed.length, 12);
});

test('不启用生产标记时拼版结果与旧版本完全一致（深比较去除 productionMarks 字段）', () => {
  const strip = (r) => JSON.parse(JSON.stringify(r.signatures, (k, v) => (k === 'productionMarks' ? undefined : v)));
  const a = computeImposition({ ...BASE, paperThickness: 0.1, maxCompensation: 0.2 });
  const b = computeImposition({
    ...BASE, paperThickness: 0.1, maxCompensation: 0.2,
    productionMarks: false, markSizeMm: 9,
  });
  assert.deepEqual(strip(b), strip(a));
});
