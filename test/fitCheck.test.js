'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeImposition } = require('../src/imposition');

const BASE = { totalPages: 8, sheetsPerSignature: 2, binding: 'left', flip: 'short' };

/** 收集拼版结果中的全部页位（每张纸正反 × 左右）。 */
function allSlots(r) {
  const slots = [];
  r.signatures.forEach((sig) => {
    sig.sheets.forEach((sheet) => {
      slots.push(sheet.front.left, sheet.front.right, sheet.back.left, sheet.back.right);
    });
  });
  return slots;
}

test('未提供尺寸：fit.enabled=false，页位不带 fit 字段（向后兼容）', () => {
  const r = computeImposition(BASE);
  assert.equal(r.fit.enabled, false);
  assert.equal(r.input.paperWidth, 0);
  assert.equal(r.input.bleedMm, 0);
  allSlots(r).forEach((s) => assert.equal(s.fit, undefined));
});

test('全部适配：440×310 纸张放 210×297 成品页，出血 3mm、安全边距 5mm', () => {
  const r = computeImposition({
    ...BASE,
    paperWidth: 440, paperHeight: 310, pageWidth: 210, pageHeight: 297, bleedMm: 3, safetyMm: 5,
  });
  assert.equal(r.fit.enabled, true);
  assert.equal(r.fit.ok, true);
  assert.equal(r.fit.failCount, 0);
  assert.equal(r.fit.totalSlots, 8);
  assert.equal(r.fit.slotWidth, 220);
  assert.equal(r.fit.slotHeight, 310);
  allSlots(r).forEach((s) => {
    assert.equal(s.fit.ok, true);
    assert.deepEqual(s.fit.violations, []);
  });
  // 左页位：rect / trim / bleedBox / safeBox 数值（trim 居中于页位）
  const left = r.signatures[0].sheets[0].front.left.fit;
  assert.deepEqual(left.rect, { x: 0, y: 0, width: 220, height: 310 });
  assert.deepEqual(left.trim, { x: 5, y: 6.5, width: 210, height: 297 });
  assert.deepEqual(left.bleedBox, { x: 2, y: 3.5, width: 216, height: 303 });
  assert.deepEqual(left.safeBox, { x: 10, y: 11.5, width: 200, height: 287 });
  // 右页位：可用矩形从纸张中线起算
  const right = r.signatures[0].sheets[0].front.right.fit;
  assert.deepEqual(right.rect, { x: 220, y: 0, width: 220, height: 310 });
  assert.deepEqual(right.trim, { x: 225, y: 6.5, width: 210, height: 297 });
});

test('成品页超过页位：报 page-too-wide / page-too-tall，并连带出血超界', () => {
  const r = computeImposition({ ...BASE, paperWidth: 420, paperHeight: 297, pageWidth: 215, pageHeight: 300 });
  assert.equal(r.fit.ok, false);
  const f = r.signatures[0].sheets[0].front.left.fit;
  const codes = f.violations.map((v) => v.code);
  assert.ok(codes.includes('page-too-wide'));
  assert.ok(codes.includes('page-too-tall'));
  // 页位 210×297 放不下 215×300，居中后 trim 四边均溢出页位 -> 出血框（bleed=0）超出纸张
  assert.ok(codes.includes('bleed-overflow-left'));
  assert.ok(codes.includes('bleed-overflow-top'));
  // 超限原因带具体超出量
  assert.match(f.violations.find((v) => v.code === 'page-too-wide').message, /215mm 超过页位可用宽 210mm/);
});

test('出血超出纸张：左页位超左 / 上 / 下，折线侧（右）不视为超限', () => {
  const r = computeImposition({ ...BASE, paperWidth: 420, paperHeight: 297, pageWidth: 210, pageHeight: 297, bleedMm: 3 });
  const left = r.signatures[0].sheets[0].front.left.fit;
  const codes = left.violations.map((v) => v.code);
  assert.ok(codes.includes('bleed-overflow-left'));
  assert.ok(codes.includes('bleed-overflow-top'));
  assert.ok(codes.includes('bleed-overflow-bottom'));
  // 折线一侧的出血进入相邻页位属正常工艺，不构成超限
  assert.ok(!codes.includes('bleed-overflow-right'));
  // 右页位镜像：超右侧
  const right = r.signatures[0].sheets[0].front.right.fit;
  assert.ok(right.violations.map((v) => v.code).includes('bleed-overflow-right'));
  assert.ok(!right.violations.map((v) => v.code).includes('bleed-overflow-left'));
  // 具体超出量：页位 210 宽正好等于页宽，出血 3mm 全部悬在纸外
  assert.match(left.violations.find((v) => v.code === 'bleed-overflow-left').message, /超出纸张 3mm/);
});

test('爬移偏移把出血推出纸张（右装订第 2 张左页位 offset=-1）', () => {
  // 432×303 纸张：页位 216×303，trim 居中后出血框正好贴边；右装订左页位爬移 -1mm -> 超左 1mm
  const r = computeImposition({
    ...BASE,
    binding: 'right',
    paperWidth: 432, paperHeight: 303, pageWidth: 210, pageHeight: 297,
    bleedMm: 3, paperThickness: 0.5, maxCompensation: 5,
  });
  assert.deepEqual(r.creep.sheetCompensationMm, [0, 1]);
  const sheet2 = r.signatures[0].sheets[1];
  assert.equal(sheet2.front.left.offsetMm, -1);
  const v = sheet2.front.left.fit.violations.find((x) => x.code === 'bleed-overflow-left');
  assert.ok(v);
  assert.match(v.message, /超出纸张 1mm/);
  // 第 1 张（creep=0）出血框贴边但未超出
  assert.equal(r.signatures[0].sheets[0].front.left.fit.ok, true);
});

test('安全边距过大：safety-too-wide / safety-too-tall，safeBox 为 null', () => {
  const r = computeImposition({ ...BASE, paperWidth: 400, paperHeight: 200, pageWidth: 100, pageHeight: 60, safetyMm: 55 });
  const f = r.signatures[0].sheets[0].front.left.fit;
  const codes = f.violations.map((v) => v.code);
  assert.ok(codes.includes('safety-too-wide'));
  assert.ok(codes.includes('safety-too-tall'));
  assert.equal(f.safeBox, null);
  assert.match(f.violations.find((v) => v.code === 'safety-too-wide').message, /左右合计 110mm 超过成品页宽 100mm/);
});

test('页位方向：长边翻转背面 rotation=180，短边翻转背面 rotation=0', () => {
  const common = { ...BASE, paperWidth: 440, paperHeight: 310, pageWidth: 210, pageHeight: 297 };
  const longFlip = computeImposition({ ...common, flip: 'long' });
  assert.equal(longFlip.signatures[0].sheets[0].front.left.fit.rotation, 0);
  assert.equal(longFlip.signatures[0].sheets[0].back.left.fit.rotation, 180);
  assert.equal(longFlip.signatures[0].sheets[0].back.right.fit.rotation, 180);
  const shortFlip = computeImposition({ ...common, flip: 'short' });
  assert.equal(shortFlip.signatures[0].sheets[0].back.left.fit.rotation, 0);
});

test('空白页同样参与适配检查', () => {
  const r = computeImposition({
    totalPages: 10, sheetsPerSignature: 2, binding: 'left', flip: 'short',
    paperWidth: 440, paperHeight: 310, pageWidth: 210, pageHeight: 297,
  });
  const blank = r.signatures[1].sheets[1].front.left;
  assert.equal(blank.blank, true);
  assert.ok(blank.fit);
  assert.equal(blank.fit.ok, true);
  assert.equal(r.fit.totalSlots, 16);
});

test('适配检查不改变页码拼版与爬移结果', () => {
  const strip = (r) => JSON.parse(JSON.stringify(r.signatures, (k, v) => (k === 'fit' ? undefined : v)));
  const common = { ...BASE, paperThickness: 0.1, maxCompensation: 0.15 };
  const without = computeImposition(common);
  const withFit = computeImposition({
    ...common, paperWidth: 440, paperHeight: 310, pageWidth: 210, pageHeight: 297, bleedMm: 3, safetyMm: 5,
  });
  assert.deepEqual(strip(withFit), strip(without));
});

test('汇总统计：failCount 与 totalSlots 正确', () => {
  // 页高 = 纸高、页宽 = 页位宽：上下左右出血全部悬在纸外，8 个页位全不合格
  const r = computeImposition({ ...BASE, paperWidth: 420, paperHeight: 297, pageWidth: 210, pageHeight: 297, bleedMm: 3 });
  assert.equal(r.fit.totalSlots, 8);
  assert.equal(r.fit.failCount, 8);
  assert.equal(r.fit.ok, false);
});

test('适配检查参数校验', () => {
  // 只提供部分尺寸
  assert.throws(() => computeImposition({ ...BASE, paperWidth: 440 }), /必须同时大于 0/);
  assert.throws(() => computeImposition({ ...BASE, paperWidth: 440, paperHeight: 310, pageWidth: 210 }), /必须同时大于 0/);
  // 只给出血 / 安全边距但不给尺寸
  assert.throws(() => computeImposition({ ...BASE, bleedMm: 3 }), /未提供纸张与成品页尺寸/);
  assert.throws(() => computeImposition({ ...BASE, safetyMm: 5 }), /未提供纸张与成品页尺寸/);
  // 负值与非数字
  assert.throws(
    () => computeImposition({ ...BASE, paperWidth: -1, paperHeight: 310, pageWidth: 210, pageHeight: 297 }),
    /纸张宽/
  );
  assert.throws(
    () => computeImposition({ ...BASE, paperWidth: 440, paperHeight: 310, pageWidth: 210, pageHeight: 297, bleedMm: -1 }),
    /出血/
  );
  assert.throws(
    () => computeImposition({ ...BASE, paperWidth: 440, paperHeight: 310, pageWidth: 210, pageHeight: 297, safetyMm: 'x' }),
    /安全边距/
  );
});
