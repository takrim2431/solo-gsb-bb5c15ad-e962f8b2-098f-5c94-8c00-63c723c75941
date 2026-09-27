'use strict';

/**
 * 试印核验（trial print verification）。
 *
 * 针对当前拼版输入录入 1～12 条实物观察（帖 / 张 / 正背面 / 左右页位 /
 * 看到的页码或空白 / 内容朝向），用同一输入分别重算
 * 「左/右装订 × 长/短边翻转」四种设置，逐条比对页码、空白与朝向：
 *
 * - 页码 / 空白字段：观察为空白时期望页位必须为空白；观察为页码时必须与期望页码一致；
 * - 朝向字段：仅当观察与期望页位均非空白时比对（空白页无内容朝向可言，记为跳过）；
 *   正面恒为正向；背面长边翻转为倒置（180°）、短边翻转为正向。
 *
 * 每种设置统计错误观察数（任一字段不符即计）与错误字段总数，
 * 候选按「错误观察数最少 → 错误字段数最少 → 当前设置优先 → 固定组合顺序」排序。
 * 结论：
 * - 唯一零差异组合           → verified（验证通过，可标记该组合）；
 * - 并列最优（含多个零差异） → undetermined（无法判定，返回全部并列组合，不强行推荐），
 *                             并从未观察页位计算「下一处观察建议」（见 suggestNextObservation）；
 * - 唯一最优但仍有差异       → failed（验证未通过，给出最接近的组合与差异数）。
 *
 * 非法索引（帖 / 张越界）、重复观察（同一帖 / 张 / 面 / 页位）与非法字段值
 * 均抛出明确错误；无观察（缺省 / null / 空数组）时返回 { enabled: false }，原流程不变。
 */

const MAX_OBSERVATIONS = 12;

/** 固定组合顺序：候选排序的最终并列打破规则。 */
const COMBO_ORDER = [
  { binding: 'left', flip: 'short' },
  { binding: 'left', flip: 'long' },
  { binding: 'right', flip: 'short' },
  { binding: 'right', flip: 'long' },
];

const SIDE_VALUES = ['front', 'back'];
const POSITION_VALUES = ['left', 'right'];
const ORIENTATION_VALUES = ['upright', 'rotated'];

const BINDING_TEXT = { left: '左装订', right: '右装订' };
const FLIP_TEXT = { long: '长边翻转', short: '短边翻转' };
const SIDE_TEXT = { front: '正面', back: '背面' };
const POSITION_TEXT = { left: '左页位', right: '右页位' };
const ORIENTATION_TEXT = { upright: '正向', rotated: '倒置' };

/** 解析帖 / 张 / 页码这类正整数索引：接受整数或纯数字字符串，其余返回 NaN。 */
function toPositiveInt(value) {
  const n = typeof value === 'number' ? value : (typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN);
  return Number.isInteger(n) ? n : NaN;
}

function comboText(combo) {
  return `${BINDING_TEXT[combo.binding]} · ${FLIP_TEXT[combo.flip]}`;
}

/** 期望内容朝向：正面恒为正向；背面长边翻转倒置（180°）、短边翻转正向。 */
function expectedOrientation(side, flip) {
  if (side === 'front') return 'upright';
  return flip === 'long' ? 'rotated' : 'upright';
}

/**
 * 校验并规范化观察列表。
 * structure = { signatureCount, sheetCounts, totalPages }（由基准拼版结果给出，
 * 四种组合的帖 / 张结构相同，故以基准结果校验即可）。
 * 返回带 1 起始序号 index 的规范观察数组；任何非法值、越界索引或重复观察都抛出明确错误。
 */
function normalizeObservations(raw, structure) {
  const { signatureCount, sheetCounts, totalPages } = structure;
  const seen = new Map();
  return raw.map((entry, i) => {
    const no = i + 1;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`第 ${no} 条观察必须为对象（含 signature / sheet / side / position / page / orientation）`);
    }
    const signature = toPositiveInt(entry.signature);
    if (!Number.isInteger(signature) || signature < 1 || signature > signatureCount) {
      throw new Error(`第 ${no} 条观察：帖号必须为 1 ~ ${signatureCount} 的整数（收到 ${JSON.stringify(entry.signature)}）`);
    }
    const sheetCount = sheetCounts[signature - 1];
    const sheet = toPositiveInt(entry.sheet);
    if (!Number.isInteger(sheet) || sheet < 1 || sheet > sheetCount) {
      throw new Error(`第 ${no} 条观察：第 ${signature} 帖共 ${sheetCount} 张，张号必须为 1 ~ ${sheetCount} 的整数（收到 ${JSON.stringify(entry.sheet)}）`);
    }
    const side = entry.side;
    if (!SIDE_VALUES.includes(side)) {
      throw new Error(`第 ${no} 条观察：面必须为 'front'（正面）或 'back'（背面）`);
    }
    const position = entry.position;
    if (!POSITION_VALUES.includes(position)) {
      throw new Error(`第 ${no} 条观察：页位必须为 'left'（左页位）或 'right'（右页位）`);
    }
    if (entry.page === undefined) {
      throw new Error(`第 ${no} 条观察：缺少 page 字段（看到的页码，或 null 表示空白页）`);
    }
    let page = null;
    if (entry.page !== null) {
      const p = toPositiveInt(entry.page);
      if (!Number.isInteger(p) || p < 1 || p > totalPages) {
        throw new Error(`第 ${no} 条观察：page 必须为 1 ~ ${totalPages} 的整数页码，或 null 表示空白页（收到 ${JSON.stringify(entry.page)}）`);
      }
      page = p;
    }
    const orientation = entry.orientation;
    if (!ORIENTATION_VALUES.includes(orientation)) {
      throw new Error(`第 ${no} 条观察：内容朝向必须为 'upright'（正向）或 'rotated'（倒置）`);
    }
    const key = `${signature}/${sheet}/${side}/${position}`;
    if (seen.has(key)) {
      throw new Error(`重复观察：第 ${no} 条与第 ${seen.get(key)} 条指向同一页位（第 ${signature} 帖 第 ${sheet} 张 ${SIDE_TEXT[side]} ${POSITION_TEXT[position]}）`);
    }
    seen.set(key, no);
    return { index: no, signature, sheet, side, position, page, blank: page === null, orientation };
  });
}

/** 单条观察与某一设置下拼版结果的逐字段比对。 */
function compareObservation(obs, layout) {
  const slot = layout.signatures[obs.signature - 1].sheets[obs.sheet - 1][obs.side][obs.position];
  const expected = {
    blank: slot.blank,
    page: slot.blank ? null : slot.page,
    orientation: expectedOrientation(obs.side, layout.input.flip),
  };
  const pageMatch = obs.blank ? slot.blank : (!slot.blank && slot.page === obs.page);
  // 任一侧为空白时没有内容朝向可比，朝向字段记为跳过（null，不计入错误字段）
  const orientationMatch = obs.blank || slot.blank ? null : obs.orientation === expected.orientation;
  const wrongFields = (pageMatch ? 0 : 1) + (orientationMatch === false ? 1 : 0);
  return {
    observation: obs.index,
    signature: obs.signature,
    sheet: obs.sheet,
    side: obs.side,
    position: obs.position,
    observed: { blank: obs.blank, page: obs.page, orientation: obs.orientation },
    expected,
    pageMatch,
    orientationMatch,
    wrongFields,
    match: wrongFields === 0,
  };
}

/** 某一设置（候选组合）的整体评分：逐条比对 + 错误观察数 / 错误字段数。 */
function scoreCandidate(combo, layout, observations) {
  const details = observations.map((obs) => compareObservation(obs, layout));
  const wrongObservations = details.filter((d) => !d.match).length;
  const wrongFields = details.reduce((sum, d) => sum + d.wrongFields, 0);
  return {
    binding: combo.binding,
    flip: combo.flip,
    isCurrent: false,
    tied: false,
    rank: 0,
    zeroDiff: wrongObservations === 0,
    wrongObservations,
    wrongFields,
    details,
  };
}

/** 排序：错误观察数最少 → 错误字段数最少 → 当前设置优先 → 固定组合顺序。 */
function rankCandidates(candidates, current) {
  const fixedOrder = new Map(COMBO_ORDER.map((c, i) => [`${c.binding}/${c.flip}`, i]));
  candidates.forEach((c) => {
    c.isCurrent = c.binding === current.binding && c.flip === current.flip;
  });
  candidates.sort((a, b) =>
    a.wrongObservations - b.wrongObservations
    || a.wrongFields - b.wrongFields
    || Number(b.isCurrent) - Number(a.isCurrent)
    || fixedOrder.get(`${a.binding}/${a.flip}`) - fixedOrder.get(`${b.binding}/${b.flip}`)
  );
  candidates.forEach((c, i) => {
    c.rank = i + 1;
  });
}

/* ------------------------- 下一处观察建议（无法判定时） ------------------------- */

/** 面的并列打破顺序：背面优先（正面恒为正向，朝向信息只有背面能提供）。 */
const SIDE_RANK = { front: 1, back: 0 };
/** 页位的并列打破顺序：同面同位时左页位优先。 */
const POSITION_RANK = { left: 0, right: 1 };

/** 某一设置下指定页位的观察结果（页码 / 空白 + 内容朝向），即建议中「各候选预期值」。 */
function expectedOutcome(layout, signature, sheet, side, position) {
  const slot = layout.signatures[signature - 1].sheets[sheet - 1][side][position];
  return {
    binding: layout.input.binding,
    flip: layout.input.flip,
    blank: slot.blank,
    page: slot.blank ? null : slot.page,
    orientation: expectedOrientation(side, layout.input.flip),
  };
}

/** 结果分组键：空白只按 blank 分组（空白无朝向）；非空白按页码 + 朝向分组。 */
function outcomeKey(outcome) {
  return outcome.blank ? 'blank' : `p${outcome.page}/${outcome.orientation}`;
}

/**
 * 从「尚未观察」的页位中计算下一处观察建议，帮助用户用一次观察最大程度区分并列组合。
 *
 * 对每个未观察页位，取并列最优组合在该页位的预期结果（页码 / 空白 + 内容朝向），
 * 预期相同的组合归为一组——用户在该页位实际看到哪一组，就只能剩下该组的组合。
 * 按以下优先级逐项比较全部未观察页位，取最优的唯一一个（全并列时保证唯一建议）：
 *
 *   1. 最坏情况下剩余候选数最少（最大结果组的大小最小）——首要目标；
 *   2. 可形成的结果分组数最多（组越多区分越细）；
 *   3. 非空白优先（并列组合中预期该页位为空白的个数最少）；
 *   4. 背面优先（背面才有长 / 短边翻转的朝向区分度）；
 *   5. 帖号靠前 → 张号靠前 → 左页位优先。
 *
 * 若所有未观察页位上各并列组合的预期结果都相同（最大组大小 = 并列组合数，
 * 任何观察都无法继续区分），返回 null，由调用方明确给出「无建议」。
 *
 * @param {Array<{binding:string, flip:string}>} tiedCombos 并列最优组合
 * @param {Map<string, object>} layouts 以 `${binding}/${flip}` 为键的四种重算拼版结果
 * @param {Set<string>} observedKeys 已观察页位键（`${signature}/${sheet}/${side}/${position}`）
 * @returns {object|null} 建议（含定位、各候选预期值、结果分组与最坏剩余数），或 null
 */
function suggestNextObservation(tiedCombos, layouts, observedKeys) {
  const comboCount = tiedCombos.length;
  if (comboCount < 2) return null;

  const structure = layouts.get(`${tiedCombos[0].binding}/${tiedCombos[0].flip}`);
  const fixedOrder = new Map(COMBO_ORDER.map((c, i) => [`${c.binding}/${c.flip}`, i]));

  let best = null;
  structure.signatures.forEach((sig) => {
    sig.sheets.forEach((sheetDoc) => {
      SIDE_VALUES.forEach((side) => {
        POSITION_VALUES.forEach((position) => {
          const signature = sig.index;
          const sheet = sheetDoc.index;
          if (observedKeys.has(`${signature}/${sheet}/${side}/${position}`)) return;

          const expectations = tiedCombos.map((combo) => {
            const layout = layouts.get(`${combo.binding}/${combo.flip}`);
            return expectedOutcome(layout, signature, sheet, side, position);
          });

          // 按预期结果分组（保持出现顺序，并按组内组合的固定顺序排序，输出稳定）
          const groupMap = new Map();
          expectations.forEach((outcome) => {
            const key = outcomeKey(outcome);
            if (!groupMap.has(key)) groupMap.set(key, []);
            groupMap.get(key).push(outcome);
          });
          let groups = [...groupMap.values()].map((members) => ({
            blank: members[0].blank,
            page: members[0].page,
            orientation: members[0].blank ? null : members[0].orientation,
            combinations: members
              .map((m) => ({ binding: m.binding, flip: m.flip }))
              .sort((a, b) => fixedOrder.get(`${a.binding}/${a.flip}`) - fixedOrder.get(`${b.binding}/${b.flip}`)),
          }));
          // 组间顺序：非空白在前、空白在后；其余按组内首组合的固定顺序，保证输出唯一
          groups.sort((a, b) =>
            Number(a.blank) - Number(b.blank)
            || Math.min(...a.combinations.map((c) => fixedOrder.get(`${c.binding}/${c.flip}`)))
              - Math.min(...b.combinations.map((c) => fixedOrder.get(`${c.binding}/${c.flip}`)))
          );

          const worstRemaining = Math.max(...groups.map((g) => g.combinations.length));
          const blankCandidates = expectations.filter((o) => o.blank).length;
          const metrics = [
            worstRemaining,          // 1. 最坏剩余候选数：少者优
            -groups.length,          // 2. 结果分组数：多者优
            blankCandidates,         // 3. 预期空白的组合数：少者优（非空白优先）
            SIDE_RANK[side],         // 4. 背面优先
            signature,               // 5. 帖 / 张 / 左→右 顺序
            sheet,
            POSITION_RANK[position],
          ];
          if (!best || compareMetrics(metrics, best.metrics) < 0) {
            best = {
              metrics,
              suggestion: {
                signature,
                sheet,
                side,
                position,
                candidates: expectations
                  .map((o) => ({ binding: o.binding, flip: o.flip, blank: o.blank, page: o.page, orientation: o.orientation }))
                  .sort((a, b) => fixedOrder.get(`${a.binding}/${a.flip}`) - fixedOrder.get(`${b.binding}/${b.flip}`)),
                outcomeGroups: groups,
                groupCount: groups.length,
                worstRemainingCandidates: worstRemaining,
              },
            };
          }
        });
      });
    });
  });

  // 所有页位的预期都一致（任一组都等于全部并列组合）→ 无法继续区分
  if (!best || best.suggestion.worstRemainingCandidates === comboCount) {
    return null;
  }
  return best.suggestion;
}

/** 等长元组字典序比较：a < b 返回 -1，相等 0，a > b 1。 */
function compareMetrics(a, b) {
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/**
 * 结论。排序只决定展示顺序；是否可判定只看评分前两项是否并列：
 * 唯一零差异 → verified；并列最优（含多个零差异）→ undetermined；唯一最优但有差异 → failed。
 */
function conclude(candidates, current, observationCount) {
  const best = candidates[0];
  const tied = candidates.filter(
    (c) => c.wrongObservations === best.wrongObservations && c.wrongFields === best.wrongFields
  );
  tied.forEach((c) => {
    c.tied = tied.length > 1;
  });
  const bestRef = {
    binding: best.binding,
    flip: best.flip,
    wrongObservations: best.wrongObservations,
    wrongFields: best.wrongFields,
  };
  if (best.zeroDiff && tied.length === 1) {
    return {
      status: 'verified',
      verified: true,
      matchesCurrent: best.isCurrent,
      combination: { binding: best.binding, flip: best.flip },
      tied: [],
      best: bestRef,
      message: best.isCurrent
        ? `验证通过：全部 ${observationCount} 条观察与当前设置（${comboText(best)}）完全一致。`
        : `验证通过：实物唯一对应「${comboText(best)}」，与当前设置（${comboText(current)}）不一致，请核对拼版设置。`,
    };
  }
  if (tied.length > 1) {
    return {
      status: 'undetermined',
      verified: false,
      matchesCurrent: null,
      combination: null,
      tied: tied.map((c) => ({ binding: c.binding, flip: c.flip })),
      best: bestRef,
      message: best.zeroDiff
        ? `无法判定：${tied.length} 种设置（${tied.map(comboText).join('；')}）与全部 ${observationCount} 条观察均一致，观察不足以区分，请补充更有区分度的观察（如背面页位）。`
        : `无法判定：${tied.length} 种设置（${tied.map(comboText).join('；')}）并列最优（各 ${best.wrongObservations} 条观察不符、共 ${best.wrongFields} 个字段不符），请补充观察后再核验。`,
    };
  }
  return {
    status: 'failed',
    verified: false,
    matchesCurrent: null,
    combination: null,
    tied: [],
    best: bestRef,
    message: `验证未通过：四种设置均存在差异；最接近的是「${comboText(best)}」（${best.wrongObservations} 条观察不符、共 ${best.wrongFields} 个字段不符），请检查观察录入或拼版设置。`,
  };
}

/**
 * 在拼版结果上执行试印核验。
 *
 * @param {object} result               computeImposition 的基准结果（当前设置）
 * @param {Array|undefined|null} rawObservations 原始观察记录（缺省 / null / 空数组 = 不启用）
 * @param {function} recompute          以覆盖输入重算拼版的函数（即 computeImposition）
 * @returns {object} verification 结果（未启用时为 { enabled: false }）
 */
function attachVerification(result, rawObservations, recompute) {
  if (rawObservations === undefined || rawObservations === null) {
    return { enabled: false };
  }
  if (!Array.isArray(rawObservations)) {
    throw new Error(`观察记录 observations 必须为数组（1～${MAX_OBSERVATIONS} 条）`);
  }
  if (rawObservations.length === 0) {
    return { enabled: false };
  }
  if (rawObservations.length > MAX_OBSERVATIONS) {
    throw new Error(`观察记录最多 ${MAX_OBSERVATIONS} 条（收到 ${rawObservations.length} 条）`);
  }

  const structure = {
    signatureCount: result.signatureCount,
    sheetCounts: result.signatures.map((sig) => sig.actualSheetCount),
    totalPages: result.input.totalPages,
  };
  const observations = normalizeObservations(rawObservations, structure);
  const current = { binding: result.input.binding, flip: result.input.flip };

  // 同一输入重算四种「装订 × 翻转」组合；核验只关心页码 / 空白 / 朝向，
  // 与纸张适配检查 / 双面生产标记无关，重算时关闭适配输入与生产标记以避免
  // 无谓的逐页位检查（及「生产标记依赖适配检查」的参数校验）。
  const layouts = new Map();
  const candidates = COMBO_ORDER.map((combo) => {
    const layout = recompute({
      ...result.input,
      binding: combo.binding,
      flip: combo.flip,
      paperWidth: 0,
      paperHeight: 0,
      pageWidth: 0,
      pageHeight: 0,
      bleedMm: 0,
      safetyMm: 0,
      productionMarks: false,
    });
    layouts.set(`${combo.binding}/${combo.flip}`, layout);
    return scoreCandidate(combo, layout, observations);
  });
  rankCandidates(candidates, current);
  const conclusion = conclude(candidates, current, observations.length);

  // 无法判定（并列最优）时，从未观察页位计算「下一处观察建议」；
  // 已验证 / 未通过结论不出建议（保持既有行为）。所有页位都不能继续区分时明确为 null。
  let nextSuggestion = null;
  if (conclusion.status === 'undetermined') {
    const observedKeys = new Set(
      observations.map((obs) => `${obs.signature}/${obs.sheet}/${obs.side}/${obs.position}`)
    );
    nextSuggestion = suggestNextObservation(conclusion.tied, layouts, observedKeys);
    conclusion.message += nextSuggestion
      ? ` 建议下一处观察：第 ${nextSuggestion.signature} 帖第 ${nextSuggestion.sheet} 张${SIDE_TEXT[nextSuggestion.side]}${POSITION_TEXT[nextSuggestion.position]}（可形成 ${nextSuggestion.groupCount} 种结果，最坏情况下剩余 ${nextSuggestion.worstRemainingCandidates} 种候选）。`
      : ' 已无可以继续区分并列组合的未观察页位：其余页位在各并列组合下的预期完全一致，补充观察也无法进一步判定。';
  }

  return {
    enabled: true,
    maxObservations: MAX_OBSERVATIONS,
    observationCount: observations.length,
    current,
    observations,
    candidates,
    conclusion,
    nextSuggestion,
  };
}

module.exports = {
  attachVerification,
  suggestNextObservation,
  expectedOutcome,
  MAX_OBSERVATIONS,
  COMBO_ORDER,
};
