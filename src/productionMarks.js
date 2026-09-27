'use strict';

/**
 * 双面生产标记（duplex production marks）。
 *
 * 仅在启用纸张适配检查（给出纸张 / 成品页尺寸）后可启用：为每张纸的正、背面
 * 生成三类印刷生产标记（标记均由水平 / 竖直线段组成，单位 mm）：
 * - crop     裁切线：四个成品页外角（左页位左上 / 左下、右页位右上 / 右下），
 *            每角一段水平线与一段竖直线（共 8 条），自出血框外固定间隙起
 *            向最近的纸边方向延伸；
 * - fold     折线标：纸张中线（折线 / 订口）上、下两端各一段自纸边向内的竖线；
 * - register 套准十字：左、右两侧出血框外各一个十字（一横一竖两线段），
 *            每侧按固定候选位置顺序（出血框垂直居中 → 四分之一 → 四分之三）
 *            尝试，第一个两线段全部合法的候选落位。
 *
 * 落位规则（对每个标记按固定候选位置顺序依次尝试）：
 * 1. 线段必须完整落在纸张矩形内（端点可贴纸张边缘）；
 * 2. 线段不得与本面两侧（左 / 右页位）的出血框正长度相交（仅端点 / 边界相接不算）；
 * 3. 线段不得与同一面已放置的标记相交。
 * 候选位置全部不可用则该标记省略，并在 omitted 中逐候选给出原因
 * （segment-outside-paper / segment-hits-bleed-box / segment-hits-mark）。
 *
 * 坐标约定与 src/fitCheck.js 一致：纸张坐标系（与正面同一视角），原点在
 * 纸张左上角，x 向右、y 向下。背面标记不在背面视角独立排版，而是先按正面
 * 规则生成正面标记，再对每条线段做正背同一物理位置的坐标变换：
 * - 长边翻转：绕水平长边翻转，(x, y) -> (x, H - y)；
 * - 短边翻转：绕垂直短边翻转，(x, y) -> (W - x, y)。
 * 因此正 / 背面标记在纸张上的物理位置完全重合（套准），翻面后标记互相对齐；
 * 正面无可用位置而省略的标记，背面在同一物理位置同步省略（无标记可对齐）。
 * 标记坐标直接取自适配检查的 trim / bleedBox（trim 已含爬移偏移），
 * 爬移参数或纸张 / 成品页尺寸变化重新计算时，全部标记随之同步重算。
 *
 * 同一面内的放置顺序固定：裁切线（左上 → 右上 → 右下 → 左下，每角先水平
 * 后竖直）→ 折线标（上 → 下）→ 套准十字（左 → 右，每侧三个候选），
 * 相交判定因此与输出都是唯一确定的。
 */

const EPS = 1e-9;

/** 标记起点与出血框之间的固定间隙（mm）。 */
const MARK_GAP_MM = 2;
/** 折线标 / 套准十字 / 裁切线尺寸上限（mm），避免异常尺寸吞掉整页。 */
const MAX_MARK_SIZE_MM = 100;
/** 标记尺寸缺省值（mm）。 */
const DEFAULT_MARK_SIZE_MM = 5;

const CORNER_LABELS = {
  tl: '左上角',
  tr: '右上角',
  br: '右下角',
  bl: '左下角',
};
const SIDE_LABELS = {
  left: '左侧',
  right: '右侧',
};

/** 保留 4 位小数（与拼版核心一致，避免浮点尾数进入 JSON）。 */
function round4(n) {
  const r = Math.round(n * 10000) / 10000;
  return Object.is(r, -0) ? 0 : r;
}

function roundSeg(seg) {
  return { x1: round4(seg.x1), y1: round4(seg.y1), x2: round4(seg.x2), y2: round4(seg.y2) };
}

/* ------------------------------ 参数解析 ------------------------------ */

/**
 * 解析标记尺寸（mm）。缺省 / null / 空串取缺省值；非数字、≤ 0 或超过上限报错。
 */
function parseMarkSizeMm(value) {
  if (value === undefined || value === null) return DEFAULT_MARK_SIZE_MM;
  if (typeof value === 'string' && value.trim() === '') return DEFAULT_MARK_SIZE_MM;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error('双面生产标记尺寸必须为 > 0 的数字（单位 mm）');
  }
  if (n > MAX_MARK_SIZE_MM) {
    throw new Error(`双面生产标记尺寸不能超过 ${MAX_MARK_SIZE_MM} mm（收到 ${n} mm）`);
  }
  return n;
}

/**
 * 解析双面生产标记开关与尺寸。
 * 未启用时尺寸缺省（不校验 markSizeMm，保持未启用时请求行为与现有流程一致）；
 * 启用时必须已开启适配检查（标记坐标依赖 trim / bleedBox）。
 * @returns {{ enabled: boolean, markSizeMm: number }}
 */
function parseProductionMarksInput(input, fitEnabled) {
  if (input && input.productionMarks !== undefined && typeof input.productionMarks !== 'boolean') {
    throw new Error('双面生产标记开关必须为布尔值（true / false）');
  }
  const enabled = Boolean(input && input.productionMarks === true);
  if (!enabled) {
    return { enabled: false, markSizeMm: DEFAULT_MARK_SIZE_MM };
  }
  if (!fitEnabled) {
    throw new Error('启用双面生产标记时必须同时启用纸张适配检查（请提供纸张宽高与成品页宽高，单位 mm）');
  }
  return { enabled: true, markSizeMm: parseMarkSizeMm(input && input.markSizeMm) };
}

/* ------------------------------ 几何工具 ------------------------------ */

/** 一维区间是否正长度重叠（仅端点相接不算）。 */
function rangesOverlap(amin, amax, bmin, bmax) {
  return Math.max(amin, bmin) < Math.min(amax, bmax) - EPS;
}

/**
 * 两条水平 / 竖直线段是否正长度相交（仅在端点 / 角点相接不算）。
 * 候选线段均为轴对齐，故分三种情形：
 * - 同为水平：y 相同且 x 区间正长度重叠；
 * - 同为竖直：x 相同且 y 区间正长度重叠；
 * - 一横一竖：交点为 (vx, hy)，须同时落在两线段内部（端点相接不算相交）。
 */
function segIntersect(a, b) {
  const aH = Math.abs(a.y1 - a.y2) <= EPS;
  const bH = Math.abs(b.y1 - b.y2) <= EPS;
  if (aH && bH) {
    return Math.abs(a.y1 - b.y1) <= EPS
      && rangesOverlap(Math.min(a.x1, a.x2), Math.max(a.x1, a.x2), Math.min(b.x1, b.x2), Math.max(b.x1, b.x2));
  }
  if (!aH && !bH) {
    return Math.abs(a.x1 - b.x1) <= EPS
      && rangesOverlap(Math.min(a.y1, a.y2), Math.max(a.y1, a.y2), Math.min(b.y1, b.y2), Math.max(b.y1, b.y2));
  }
  const h = aH ? a : b;
  const v = aH ? b : a;
  const hxMin = Math.min(h.x1, h.x2);
  const hxMax = Math.max(h.x1, h.x2);
  const vyMin = Math.min(v.y1, v.y2);
  const vyMax = Math.max(v.y1, v.y2);
  // 竖线 x 在横线 x 区间内部、横线 y 在竖线 y 区间内部才算相交（端点相接不算）
  return v.x1 > hxMin + EPS && v.x1 < hxMax - EPS
    && h.y1 > vyMin + EPS && h.y1 < vyMax - EPS;
}

/**
 * 线段是否与矩形框正长度相交 / 重叠。
 * 线段为水平或竖直：其在另一维（退化维）上须严格落在框内或与其边界共线，
 * 在延伸维上与框区间正长度重叠；仅端点 / 边界相接不算。
 */
function segHitsBox(seg, box) {
  const bxMax = box.x + box.width;
  const byMax = box.y + box.height;
  const horizontal = Math.abs(seg.y1 - seg.y2) <= EPS;
  if (horizontal) {
    const y = seg.y1;
    if (y < box.y - EPS || y > byMax + EPS) return false;
    return rangesOverlap(Math.min(seg.x1, seg.x2), Math.max(seg.x1, seg.x2), box.x, bxMax);
  }
  // 竖直线段
  const x = seg.x1;
  if (x < box.x - EPS || x > bxMax + EPS) return false;
  return rangesOverlap(Math.min(seg.y1, seg.y2), Math.max(seg.y1, seg.y2), box.y, byMax);
}

/** 线段是否完整落在纸张矩形内（端点可贴纸张边缘）。 */
function segInsidePaper(seg, paperWidth, paperHeight) {
  return Math.min(seg.x1, seg.x2) >= -EPS && Math.max(seg.x1, seg.x2) <= paperWidth + EPS
    && Math.min(seg.y1, seg.y2) >= -EPS && Math.max(seg.y1, seg.y2) <= paperHeight + EPS;
}

/* ------------------------------ 正面标记候选 ------------------------------ */

/**
 * 一个面（正面视角）的放置环境：两侧出血框（避开约束）、纸张边界与已放置
 * 标记（相交约束）。place() 按候选顺序返回首个全部线段合法的位置，
 * 并把每次尝试（含逐线段原因）记录在 attempts 中供省略说明使用。
 */
function makePlacer(paperWidth, paperHeight, bleedBoxes) {
  const placed = []; // { id, label, segments }（未圆整坐标，供相交判定）

  function checkSegments(segments) {
    const checks = [];
    segments.forEach((seg, idx) => {
      if (!segInsidePaper(seg, paperWidth, paperHeight)) {
        checks.push({
          segmentIndex: idx,
          code: 'segment-outside-paper',
          message: '线段超出纸张边界（标记无法完整落在纸内）',
        });
        return;
      }
      const hitBox = bleedBoxes.find((box) => segHitsBox(seg, box));
      if (hitBox) {
        checks.push({
          segmentIndex: idx,
          code: 'segment-hits-bleed-box',
          message: `线段与出血框相交（出血框范围 ${round4(hitBox.x)} ~ ${round4(hitBox.x + hitBox.width)} × ${round4(hitBox.y)} ~ ${round4(hitBox.y + hitBox.height)} mm）`,
        });
        return;
      }
      const hitMark = placed.find((m) => m.segments.some((s) => segIntersect(seg, s)));
      if (hitMark) {
        checks.push({
          segmentIndex: idx,
          code: 'segment-hits-mark',
          message: `线段与已放置标记「${hitMark.label}」相交`,
          markId: hitMark.id,
        });
      }
    });
    return checks;
  }

  function place(def) {
    const attempts = [];
    for (const candidate of def.candidates) {
      const checks = checkSegments(candidate.segments);
      attempts.push({
        position: candidate.position,
        positionLabel: candidate.positionLabel,
        ok: checks.length === 0,
        checks,
      });
      if (checks.length === 0) {
        const mark = {
          id: def.id,
          type: def.type,
          label: def.label,
          position: candidate.position,
          positionLabel: candidate.positionLabel,
          segments: candidate.segments,
        };
        placed.push({ id: def.id, label: def.label, segments: candidate.segments });
        return { mark, attempts };
      }
    }
    return { mark: null, attempts };
  }

  return { place };
}

/**
 * 裁切线（8 条，每角水平 / 竖直各一）。
 * 起点在出血框外固定间隙处，向最近的纸边方向延伸 size：
 * 水平线 y = trim 边线、竖直线 x = trim 边线，故几何上与出血框只在
 * 出血框越过 trim 边线（适配超限时才可能）时相交，由相交检查统一判定。
 */
function cropMarkDefs(leftFit, rightFit, size) {
  const gap = MARK_GAP_MM;
  const lb = leftFit.bleedBox;
  const rb = rightFit.bleedBox;
  const lt = leftFit.trim;
  const rt = rightFit.trim;
  const fixedCrop = (cornerLabel, seg) => [{
    position: 0,
    positionLabel: `${cornerLabel}（固定位置）`,
    segments: [seg],
  }];
  const def = (id, label, seg) => ({ id, type: 'crop', label, candidates: fixedCrop(label, seg) });
  return [
    // 左上角（左页位 trim 左上）：水平向左、竖直向上
    def('crop-tl-h', '左上角水平裁切线', { x1: lb.x - gap, y1: lt.y, x2: lb.x - gap - size, y2: lt.y }),
    def('crop-tl-v', '左上角竖直裁切线', { x1: lt.x, y1: lb.y - gap, x2: lt.x, y2: lb.y - gap - size }),
    // 右上角（右页位 trim 右上）：水平向右、竖直向上
    def('crop-tr-h', '右上角水平裁切线', { x1: rb.x + rb.width + gap, y1: rt.y, x2: rb.x + rb.width + gap + size, y2: rt.y }),
    def('crop-tr-v', '右上角竖直裁切线', { x1: rt.x + rt.width, y1: rb.y - gap, x2: rt.x + rt.width, y2: rb.y - gap - size }),
    // 右下角（右页位 trim 右下）：水平向右、竖直向下
    def('crop-br-h', '右下角水平裁切线', { x1: rb.x + rb.width + gap, y1: rt.y + rt.height, x2: rb.x + rb.width + gap + size, y2: rt.y + rt.height }),
    def('crop-br-v', '右下角竖直裁切线', { x1: rt.x + rt.width, y1: rb.y + rb.height + gap, x2: rt.x + rt.width, y2: rb.y + rb.height + gap + size }),
    // 左下角（左页位 trim 左下）：水平向左、竖直向下
    def('crop-bl-h', '左下角水平裁切线', { x1: lb.x - gap, y1: lt.y + lt.height, x2: lb.x - gap - size, y2: lt.y + lt.height }),
    def('crop-bl-v', '左下角竖直裁切线', { x1: lt.x, y1: lb.y + lb.height + gap, x2: lt.x, y2: lb.y + lb.height + gap + size }),
  ];
}

/** 折线标（2 条）：中线 x = paperWidth/2，自上 / 下纸边向内延伸 size。 */
function foldMarkDefs(paperWidth, paperHeight, size) {
  const midX = paperWidth / 2;
  const fixed = (positionLabel, segments) => [{ position: 0, positionLabel, segments }];
  return [
    {
      id: 'fold-top', type: 'fold', label: '上方折线标',
      candidates: fixed('中线上方（固定位置）', [{ x1: midX, y1: 0, x2: midX, y2: size }]),
    },
    {
      id: 'fold-bottom', type: 'fold', label: '下方折线标',
      candidates: fixed('中线下方（固定位置）', [{ x1: midX, y1: paperHeight, x2: midX, y2: paperHeight - size }]),
    },
  ];
}

/**
 * 套准十字（每侧一个，每侧 3 个候选垂直位置）：
 * 居中 → 四分之一 → 四分之三；十字中心在出血框外 gap 处，
 * 水平段向纸边伸出 size，竖直段上下各 size/2；两线段须同时合法。
 */
function registerMarkDef(side, bleedBox, size) {
  const candidates = [
    { position: 1, positionLabel: '出血框垂直居中', y: bleedBox.y + bleedBox.height / 2 },
    { position: 2, positionLabel: '出血框四分之一高度', y: bleedBox.y + bleedBox.height / 4 },
    { position: 3, positionLabel: '出血框四分之三高度', y: bleedBox.y + bleedBox.height * 3 / 4 },
  ].map(({ position, positionLabel, y }) => {
    const cx = side === 'left' ? bleedBox.x - MARK_GAP_MM : bleedBox.x + bleedBox.width + MARK_GAP_MM;
    const dir = side === 'left' ? -1 : 1;
    return {
      position,
      positionLabel,
      segments: [
        { x1: cx, y1: y, x2: cx + dir * size, y2: y },
        { x1: cx, y1: y - size / 2, x2: cx, y2: y + size / 2 },
      ],
    };
  });
  return {
    id: `register-${side}`,
    type: 'register',
    label: `${SIDE_LABELS[side]}套准十字`,
    candidates,
  };
}

/* ------------------------------ 正背变换 ------------------------------ */

/** 线段坐标按翻转方式映射到背面同一物理位置（长边：y 翻转；短边：x 翻转）。 */
function transformSegment(seg, flip, paperWidth, paperHeight) {
  if (flip === 'long') {
    return { x1: seg.x1, y1: paperHeight - seg.y1, x2: seg.x2, y2: paperHeight - seg.y2 };
  }
  return { x1: paperWidth - seg.x1, y1: seg.y1, x2: paperWidth - seg.x2, y2: seg.y2 };
}

/* ------------------------------ 主流程 ------------------------------ */

/** 汇总一次放置尝试的省略原因（逐候选、逐线段）。 */
function describeAttempts(attempts) {
  return attempts
    .map((a) => `候选位置 ${a.position}「${a.positionLabel}」：${a.checks.map((c) => c.message).join('；')}`)
    .join(' ｜ ');
}

/**
 * 为一张纸的正面按固定顺序放置全部标记。
 * 入参 sheet.front.left/right 须已带 fit（trim / bleedBox）。
 * @returns {{ placed: object[], omitted: object[] }}
 */
function placeFrontMarks(sheet, paperWidth, paperHeight, size) {
  const leftFit = sheet.front.left.fit;
  const rightFit = sheet.front.right.fit;
  const placer = makePlacer(paperWidth, paperHeight, [leftFit.bleedBox, rightFit.bleedBox]);
  const defs = [
    ...cropMarkDefs(leftFit, rightFit, size),
    ...foldMarkDefs(paperWidth, paperHeight, size),
    registerMarkDef('left', leftFit.bleedBox, size),
    registerMarkDef('right', rightFit.bleedBox, size),
  ];

  const placed = [];
  const omitted = [];
  defs.forEach((def) => {
    const { mark, attempts } = placer.place(def);
    if (mark) {
      placed.push({
        id: mark.id,
        type: mark.type,
        label: mark.label,
        position: mark.position,
        positionLabel: mark.positionLabel,
        segments: mark.segments.map(roundSeg),
      });
      return;
    }
    const lastChecks = attempts[attempts.length - 1].checks;
    omitted.push({
      id: def.id,
      type: def.type,
      label: def.label,
      reasonCode: lastChecks[0] ? lastChecks[0].code : 'no-position-available',
      reasonSummary: lastChecks.map((c) => c.message).join('；') || '无可用位置',
      reason: describeAttempts(attempts),
      attempts,
    });
  });
  return { placed, omitted };
}

/**
 * 在完整拼版结果上附加双面生产标记：
 * 每个 sheet 增加 productionMarks: { front: {placed, omitted}, back: {...} }，
 * 并返回顶层 productionMarks 汇总。未启用时仅返回 { enabled: false }，
 * 拼版 / 适配检查 / 试印核验结果完全不受影响。
 *
 * @param {object} result computeImposition 的返回结果（fit 已附加且 enabled）
 * @param {{ enabled: boolean, markSizeMm: number }} opts parseProductionMarksInput 结果
 * @returns {object} 顶层 productionMarks 汇总
 */
function attachProductionMarks(result, opts) {
  if (!opts.enabled) {
    return { enabled: false };
  }
  const { markSizeMm } = opts;
  const paperWidth = result.fit.paperWidth;
  const paperHeight = result.fit.paperHeight;
  const flip = result.input.flip;
  const transformText = flip === 'long'
    ? { flip: 'long', mapping: '(x, y) -> (x, H - y)' }
    : { flip: 'short', mapping: '(x, y) -> (W - x, y)' };

  const sheets = [];
  let placedCount = 0;
  let omittedCount = 0;

  result.signatures.forEach((sig) => {
    sig.sheets.forEach((sheetDoc) => {
      const { placed, omitted } = placeFrontMarks(sheetDoc, paperWidth, paperHeight, markSizeMm);

      // 背面：正面已放置标记逐线段做正背同物理位置坐标变换（正背套准）
      const backPlaced = placed.map((mark) => ({
        ...mark,
        side: 'back',
        segments: mark.segments.map((seg) => roundSeg(transformSegment(seg, flip, paperWidth, paperHeight))),
        transform: transformText,
        pairedWith: mark.id,
      }));
      const frontPlaced = placed.map((mark) => ({ ...mark, side: 'front' }));

      // 正面无位置的标记，背面同一物理位置同步省略（无标记可对齐）
      const frontOmitted = omitted.map((o) => ({ ...o, side: 'front' }));
      const backOmitted = omitted.map((o) => ({
        id: o.id,
        type: o.type,
        label: o.label,
        side: 'back',
        reasonCode: 'paired-front-omitted',
        reasonSummary: `正面同名标记已省略：${o.reasonSummary}`,
        reason: `与正面同一物理位置的「${o.label}」无可用位置，背面同步省略；正面原因：${o.reason}`,
        pairedWith: o.id,
      }));

      placedCount += frontPlaced.length + backPlaced.length;
      omittedCount += frontOmitted.length + backOmitted.length;
      sheetDoc.productionMarks = {
        front: { placed: frontPlaced, omitted: frontOmitted },
        back: { placed: backPlaced, omitted: backOmitted },
      };
      sheets.push({
        signature: sig.index,
        sheet: sheetDoc.index,
        front: { placedCount: frontPlaced.length, omittedCount: frontOmitted.length },
        back: { placedCount: backPlaced.length, omittedCount: backOmitted.length },
      });
    });
  });

  return {
    enabled: true,
    markSizeMm,
    gapMm: MARK_GAP_MM,
    paperWidth,
    paperHeight,
    flip,
    transform: transformText,
    placedCount,
    omittedCount,
    sheets,
  };
}

module.exports = {
  parseProductionMarksInput,
  parseMarkSizeMm,
  attachProductionMarks,
  placeFrontMarks,
  transformSegment,
  segIntersect,
  segHitsBox,
  segInsidePaper,
  DEFAULT_MARK_SIZE_MM,
  MARK_GAP_MM,
  MAX_MARK_SIZE_MM,
};
