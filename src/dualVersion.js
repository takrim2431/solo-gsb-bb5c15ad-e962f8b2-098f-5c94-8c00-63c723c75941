'use strict';

/**
 * 双版本共版印刷清单（dual-version shared-plate printing）。
 *
 * 同一本书的 A、B 两个版本只有少量页面不同（B 版相对 A 版改动了若干真实页码），
 * 印刷时希望尽量共版以节省印版：沿用当前分帖、补白、装订与翻转后的页位，
 * 逐张逐面判定该面是否含有 B 版改动页——
 *
 * - 无改动页的面：A、B 两版内容完全相同，**共用一块印版**，印次 = A 版份数 + B 版份数；
 * - 含改动页的面：拆成 **A、B 两块印版**，各按自身份数印刷（A 版印 A 份、B 版印 B 份）；
 * - 同一张纸的正、背面**独立判定**（正面含改动页不代表背面需要拆版，反之亦然）；
 * - 空白页位不属于任何版本内容，不参与改动判定（含空白页的面只要无改动页仍共版）。
 *
 * 输入（API 字段 dualVersion，缺省 / null / false / { enabled: false } 时整个模块不启用）：
 * - copiesA        A 版成品份数（≥1 的整数）；
 * - copiesB        B 版成品份数（≥1 的整数）；
 * - changedPages   B 版相对 A 版改动的真实页码，支持单页与区间，自动去重并校验范围：
 *                  数组形式如 [3, "5-8", { "start": 10, "end": 12 }]，
 *                  或直接给字符串 "3, 5-8, 10-12"（逗号 / 顿号 / 分号 / 空白分隔，
 *                  区间连字符支持 - – — ~）；每个页码必须为 1 ~ totalPages 的整数，
 *                  区间起点不得大于终点；启用时至少要有 1 个改动页。
 *
 * 输出（顶层 dualVersion 段）：回显份数与去重排序后的改动页，逐面 rows 给出
 * 帖 / 张 / 面 / 左右页位页码 / 本面改动页 / 印版归属（shared 共用 或 A、B 拆版）/
 * 各印版印次，totals 汇总面数、印版数（含较全部拆版节省的印版数）与总印次。
 * 未启用时 parse 返回 { enabled: false }，attachDualVersion 不写入任何字段，
 * 原响应完全不变。
 */

const MAX_COPIES = 100000000; // 成品份数上限 1 亿（与印刷备料一致）

/** 解析整数参数：接受整数或纯数字字符串，布尔 / null / 空串等返回 NaN。 */
function toInteger(value) {
  const n = Number(value);
  return Number.isInteger(n) ? n : NaN;
}

/** 区间写法：数字 + 连字符（- – — ~，两侧可有空格）+ 数字，如 "5-8"、"5 - 8"。 */
const RANGE_PATTERN = /^(\d+)\s*[-–—~]\s*(\d+)$/;

/**
 * 把 changedPages 输入拆成条目数组。
 * 字符串按逗号 / 顿号 / 分号 / 换行分隔；单个 token 不是区间时再按空白细分
 * （同时兼容 "3, 5-8"、"3 5 7" 与 "5 - 8" 这类写法）。数组输入原样返回副本。
 */
function tokenizeChangedPages(raw) {
  if (typeof raw === 'string') {
    const tokens = [];
    raw.split(/[,，、;；\n]+/).forEach((part) => {
      const token = part.trim();
      if (!token) return;
      if (RANGE_PATTERN.test(token)) {
        tokens.push(token);
      } else {
        token.split(/\s+/).filter(Boolean).forEach((t) => tokens.push(t));
      }
    });
    return tokens;
  }
  if (Array.isArray(raw)) return raw.slice();
  throw new Error('改动页码 changedPages 必须为数组或字符串（支持单页与区间，如 [3, "5-8"] 或 "3, 5-8"）');
}

/**
 * 校验并规范化改动页码：逐条目解析（整数 / 数字字符串 / 区间字符串 / { start, end } 对象），
 * 每个页码必须是 1 ~ totalPages 的整数，区间起点不得大于终点；
 * 自动去重并按升序返回。任何非法值都抛出明确错误。
 */
function normalizeChangedPages(raw, totalPages) {
  if (raw === undefined || raw === null) {
    throw new Error('启用双版本共版时，改动页码 changedPages 必填（支持单页与区间，如 [3, "5-8"] 或 "3, 5-8"）');
  }
  const items = tokenizeChangedPages(raw);
  if (items.length === 0) {
    throw new Error('改动页码 changedPages 不能为空（至少填写 1 个 B 版改动页）');
  }
  const pages = new Set();
  const addPage = (n, label) => {
    if (!Number.isInteger(n)) {
      throw new Error(`改动页码必须为整数（收到非法值：${JSON.stringify(label)}）`);
    }
    if (n < 1 || n > totalPages) {
      throw new Error(`改动页码 ${n} 超出范围（1 ~ ${totalPages}）`);
    }
    pages.add(n);
  };
  const addRange = (start, end, label) => {
    if (start > end) {
      throw new Error(`改动页码区间起点不能大于终点（收到：${label}）`);
    }
    for (let p = start; p <= end; p++) addPage(p, label);
  };
  items.forEach((item) => {
    if (typeof item === 'number') {
      addPage(toInteger(item), item);
      return;
    }
    if (typeof item === 'string') {
      const token = item.trim();
      const m = token.match(RANGE_PATTERN);
      if (m) {
        addRange(Number(m[1]), Number(m[2]), `「${item}」`);
        return;
      }
      if (/^\d+$/.test(token)) {
        addPage(Number(token), item);
        return;
      }
      throw new Error(`改动页码条目无法解析（收到：「${item}」，支持单页如 3、区间如 5-8）`);
    }
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const start = toInteger(item.start);
      const end = toInteger(item.end);
      if (!Number.isInteger(start) || !Number.isInteger(end)) {
        throw new Error('改动页码区间对象必须含整数 start / end（如 { "start": 5, "end": 8 }）');
      }
      addRange(start, end, `{ start: ${start}, end: ${end} }`);
      return;
    }
    throw new Error(`改动页码条目无法解析（收到非法类型：${Array.isArray(item) ? 'array' : typeof item}），支持整数、区间字符串 "5-8" 或 { start, end } 对象`);
  });
  return [...pages].sort((a, b) => a - b);
}

/**
 * 解析并校验双版本共版输入。
 * @param {object} input 请求体
 * @param {number} totalPages 成品页数（用于校验改动页码范围，调用前须已完成自身校验）
 * @returns {{enabled: false} | {enabled: true, copiesA, copiesB, changedPages}}
 */
function parseDualVersionInput(input, totalPages) {
  const raw = input && input.dualVersion;
  if (raw === undefined || raw === null || raw === false) {
    return { enabled: false };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('双版本共版参数 dualVersion 必须为对象（含 copiesA / copiesB / changedPages）');
  }
  if (raw.enabled === false) {
    return { enabled: false };
  }
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
    throw new Error('双版本共版开关 enabled 必须为布尔值（true / false）');
  }
  const copiesA = toInteger(raw.copiesA);
  if (!Number.isInteger(copiesA) || copiesA < 1 || copiesA > MAX_COPIES) {
    throw new Error(`A 版成品份数 copiesA 必须为 1 ~ ${MAX_COPIES.toLocaleString('en-US')} 的整数`);
  }
  const copiesB = toInteger(raw.copiesB);
  if (!Number.isInteger(copiesB) || copiesB < 1 || copiesB > MAX_COPIES) {
    throw new Error(`B 版成品份数 copiesB 必须为 1 ~ ${MAX_COPIES.toLocaleString('en-US')} 的整数`);
  }
  const changedPages = normalizeChangedPages(raw.changedPages, totalPages);
  return { enabled: true, copiesA, copiesB, changedPages };
}

/**
 * 依据拼版结果逐张逐面判定印版归属并附加汇总。
 * 仅在 parseDualVersionInput 返回 enabled 时调用；否则不写入任何字段。
 *
 * @param {object} result 拼版计算结果（读取各帖各张正背面左右页位）
 * @param {{enabled:true, copiesA:number, copiesB:number, changedPages:number[]}} dv
 * @returns {object} 双版本共版清单（dualVersion 段）
 */
function attachDualVersion(result, dv) {
  if (!dv.enabled) return undefined;
  const { copiesA, copiesB, changedPages } = dv;
  const changedSet = new Set(changedPages);
  const sharedImpressions = copiesA + copiesB;

  const rows = [];
  result.signatures.forEach((sig) => {
    sig.sheets.forEach((sheet) => {
      // 同一张的正、背面独立判定
      [
        ['front', sheet.front],
        ['back', sheet.back],
      ].forEach(([side, sideObj]) => {
        const leftPage = sideObj.left.blank ? null : sideObj.left.page;
        const rightPage = sideObj.right.blank ? null : sideObj.right.page;
        const changedOnSide = [leftPage, rightPage]
          .filter((p) => p !== null && changedSet.has(p))
          .sort((a, b) => a - b);
        const shared = changedOnSide.length === 0;
        rows.push({
          signature: sig.index,
          sheet: sheet.index,
          side,
          leftPage,
          rightPage,
          changedPages: changedOnSide,
          shared,
          plates: shared
            ? [{ plate: 'shared', impressions: sharedImpressions }]
            : [
                { plate: 'A', impressions: copiesA },
                { plate: 'B', impressions: copiesB },
              ],
        });
      });
    });
  });

  const sharedSideCount = rows.filter((r) => r.shared).length;
  const splitSideCount = rows.length - sharedSideCount;
  const sharedPlateCount = sharedSideCount; // 共版面各 1 块
  const splitPlateCount = splitSideCount * 2; // 拆版面各 2 块（A、B）
  const plateCount = sharedPlateCount + splitPlateCount;
  const impressions = rows.reduce((sum, r) => sum + r.plates.reduce((s, p) => s + p.impressions, 0), 0);

  return {
    enabled: true,
    copiesA,
    copiesB,
    changedPages,
    changedPageCount: changedPages.length,
    rule: '逐张逐面判定：无改动页的面共用一块印版（印次 = A + B），含改动页的面拆成 A、B 两块印版（各按自身份数印刷），同张纸正背面独立判定',
    rows,
    totals: {
      sideCount: rows.length,
      sharedSideCount,
      splitSideCount,
      sharedPlateCount,
      splitPlateCount,
      plateCount,
      // 较「全部面都拆成 A、B 两块版」（2 × sideCount）节省的印版数
      savedPlateCount: 2 * rows.length - plateCount,
      impressions,
    },
  };
}

module.exports = {
  parseDualVersionInput,
  attachDualVersion,
};
