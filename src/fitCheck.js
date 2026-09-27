'use strict';

/**
 * 纸张规格与出血 / 安全边距适配检查。
 *
 * 坐标系：纸张坐标系（与正面同一视角），原点位于纸张左上角，x 向右、y 向下，单位 mm。
 * - 每张纸沿竖直中线对折：左页位可用矩形 = [0, W/2] × [0, H]，右页位 = [W/2, W] × [0, H]；
 * - 背面页位与正面共用同一纸张坐标系（长边翻转左右页位不变、短边翻转左右互换，
 *   各页位放置的页码由拼版算法决定），因此每个页位的可用矩形只取决于它位于纸面左半 / 右半；
 * - 内容方向 rotation：正面与短边翻转的背面为 0°，长边翻转的背面为 180°
 *   （180° 旋转不改变矩形适配结果，仅随结果返回便于前端展示与核对）。
 *
 * 成品页在页位内居中放置，并叠加爬移偏移 offsetMm（正 = 向右）：
 * - trim     成品页矩形（pageWidth × pageHeight，即裁切线）；
 * - bleedBox trim 四边各外扩出血 bleed，必须完全落在纸张矩形内
 *            （折线一侧的出血进入相邻页位属正常工艺，仅纸张外边界构成约束）；
 * - safeBox  trim 四边各内缩安全边距 safety；2 × safety 超过成品页宽 / 高时
 *            安全区不存在，记为超限。
 *
 * 每个页位输出 { ok, rotation, rect, trim, bleedBox, safeBox, violations }，
 * violations 中每条超限原因都带 code（机器可读）与 message（含具体超出量）。
 */

const EPS = 1e-9;

/** 保留 4 位小数（与拼版核心一致，避免浮点尾数进入 JSON）。 */
function round4(n) {
  const r = Math.round(n * 10000) / 10000;
  return Object.is(r, -0) ? 0 : r;
}

/** 超限原因消息中的 mm 数值：先按 round4 去掉浮点尾数。 */
function fmt(n) {
  return String(round4(n));
}

const FIELD_LABELS = {
  paperWidth: '纸张宽',
  paperHeight: '纸张高',
  pageWidth: '成品页宽',
  pageHeight: '成品页高',
  bleedMm: '出血',
  safetyMm: '安全边距',
};

/**
 * 解析非负长度参数（mm）。
 * 缺省（undefined / null）视为 0（未设置）；空串、负数、非数字返回 NaN 由调用方报错。
 */
function toNonNegativeMm(value) {
  if (value === undefined || value === null) return 0;
  if (typeof value === 'string' && value.trim() === '') return NaN;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return NaN;
  return n;
}

/**
 * 解析适配检查输入。
 * 纸张宽 / 高与成品页宽 / 高全部缺省（或为 0）时不启用检查（向后兼容）；
 * 一旦提供其中任意一项（或单独给出出血 / 安全边距），四项尺寸必须全部 > 0。
 */
function parseFitInput(input) {
  const dims = {
    paperWidth: toNonNegativeMm(input && input.paperWidth),
    paperHeight: toNonNegativeMm(input && input.paperHeight),
    pageWidth: toNonNegativeMm(input && input.pageWidth),
    pageHeight: toNonNegativeMm(input && input.pageHeight),
    bleedMm: toNonNegativeMm(input && input.bleedMm),
    safetyMm: toNonNegativeMm(input && input.safetyMm),
  };
  Object.keys(dims).forEach((key) => {
    if (Number.isNaN(dims[key])) {
      throw new Error(`${FIELD_LABELS[key]}必须为 ≥ 0 的数字（单位 mm）`);
    }
  });

  const anySize = dims.paperWidth > 0 || dims.paperHeight > 0 || dims.pageWidth > 0 || dims.pageHeight > 0;
  if (!anySize) {
    if (dims.bleedMm > 0 || dims.safetyMm > 0) {
      throw new Error('已设置出血 / 安全边距，但未提供纸张与成品页尺寸：纸张宽高与成品页宽高必须同时大于 0（单位 mm）');
    }
    return { enabled: false, ...dims };
  }
  if (!(dims.paperWidth > 0) || !(dims.paperHeight > 0) || !(dims.pageWidth > 0) || !(dims.pageHeight > 0)) {
    throw new Error('启用纸张适配检查时，纸张宽 / 高与成品页宽 / 高必须同时大于 0（单位 mm）');
  }
  return { enabled: true, ...dims };
}

/**
 * 检查单个页位。
 *
 * @param {object} rect 页位可用矩形 { x, y, width, height }（纸张坐标系，mm）
 * @param {object} opts { paperWidth, paperHeight, pageWidth, pageHeight, bleedMm, safetyMm, offsetMm, rotation }
 * @returns {object} { ok, rotation, rect, trim, bleedBox, safeBox, violations }
 */
function checkSlotFit(rect, opts) {
  const { paperWidth, paperHeight, pageWidth, pageHeight, bleedMm, safetyMm, offsetMm, rotation } = opts;
  const violations = [];

  // 1) 成品页本身须能放入页位
  if (pageWidth - rect.width > EPS) {
    violations.push({
      code: 'page-too-wide',
      message: `成品页宽 ${fmt(pageWidth)}mm 超过页位可用宽 ${fmt(rect.width)}mm（纸张宽 ${fmt(paperWidth)}mm 的一半）`,
    });
  }
  if (pageHeight - rect.height > EPS) {
    violations.push({
      code: 'page-too-tall',
      message: `成品页高 ${fmt(pageHeight)}mm 超过页位可用高 ${fmt(rect.height)}mm（纸张高）`,
    });
  }

  // 成品页在页位内居中，再叠加爬移偏移
  const trim = {
    x: round4(rect.x + (rect.width - pageWidth) / 2 + offsetMm),
    y: round4(rect.y + (rect.height - pageHeight) / 2),
    width: pageWidth,
    height: pageHeight,
  };
  const bleedBox = {
    x: round4(trim.x - bleedMm),
    y: round4(trim.y - bleedMm),
    width: round4(pageWidth + 2 * bleedMm),
    height: round4(pageHeight + 2 * bleedMm),
  };

  // 2) 出血框必须完全落在纸张内（折线侧出血进入相邻页位不视为超限）
  const overflow = [
    ['left', '左', -bleedBox.x],
    ['top', '上', -bleedBox.y],
    ['right', '右', bleedBox.x + bleedBox.width - paperWidth],
    ['bottom', '下', bleedBox.y + bleedBox.height - paperHeight],
  ];
  overflow.forEach(([side, label, excess]) => {
    if (excess > EPS) {
      violations.push({
        code: `bleed-overflow-${side}`,
        message: `${label}侧出血超出纸张 ${fmt(excess)}mm（出血 ${fmt(bleedMm)}mm，含爬移偏移 ${fmt(offsetMm)}mm）`,
      });
    }
  });

  // 3) 安全区：trim 四边内缩 safety 后须仍然存在
  const safeW = pageWidth - 2 * safetyMm;
  const safeH = pageHeight - 2 * safetyMm;
  let safeBox = null;
  if (safeW < -EPS) {
    violations.push({
      code: 'safety-too-wide',
      message: `安全边距 ${fmt(safetyMm)}mm 过大：左右合计 ${fmt(2 * safetyMm)}mm 超过成品页宽 ${fmt(pageWidth)}mm`,
    });
  }
  if (safeH < -EPS) {
    violations.push({
      code: 'safety-too-tall',
      message: `安全边距 ${fmt(safetyMm)}mm 过大：上下合计 ${fmt(2 * safetyMm)}mm 超过成品页高 ${fmt(pageHeight)}mm`,
    });
  }
  if (safeW >= -EPS && safeH >= -EPS) {
    safeBox = {
      x: round4(trim.x + safetyMm),
      y: round4(trim.y + safetyMm),
      width: round4(Math.max(0, safeW)),
      height: round4(Math.max(0, safeH)),
    };
  }

  return { ok: violations.length === 0, rotation, rect, trim, bleedBox, safeBox, violations };
}

/**
 * 对拼版结果逐页位执行适配检查，并把结果附加到 result 上：
 * 每个页位对象（含空白页）增加 fit 字段，顶层返回 fit 汇总。
 *
 * @param {object} result computeImposition 的返回结果（会被原地补充 fit 字段）
 * @param {object} fit    parseFitInput 的解析结果
 * @returns {object} 顶层 fit 汇总
 */
function attachFit(result, fit) {
  if (!fit.enabled) {
    return { enabled: false };
  }
  const { paperWidth, paperHeight, pageWidth, pageHeight, bleedMm, safetyMm } = fit;
  const slotWidth = round4(paperWidth / 2);
  const slotHeight = paperHeight;
  const backRotation = result.input.flip === 'long' ? 180 : 0;

  let failCount = 0;
  let totalSlots = 0;
  result.signatures.forEach((sig) => {
    sig.sheets.forEach((sheet) => {
      [
        { side: sheet.front, rotation: 0 },
        { side: sheet.back, rotation: backRotation },
      ].forEach(({ side, rotation }) => {
        [
          { slot: side.left, x: 0 },
          { slot: side.right, x: slotWidth },
        ].forEach(({ slot, x }) => {
          const rect = { x, y: 0, width: slotWidth, height: slotHeight };
          slot.fit = checkSlotFit(rect, {
            paperWidth,
            paperHeight,
            pageWidth,
            pageHeight,
            bleedMm,
            safetyMm,
            offsetMm: slot.offsetMm || 0,
            rotation,
          });
          totalSlots += 1;
          if (!slot.fit.ok) failCount += 1;
        });
      });
    });
  });

  return {
    enabled: true,
    paperWidth,
    paperHeight,
    pageWidth,
    pageHeight,
    bleedMm,
    safetyMm,
    slotWidth,
    slotHeight,
    ok: failCount === 0,
    totalSlots,
    failCount,
  };
}

module.exports = { parseFitInput, checkSlotFit, attachFit };
