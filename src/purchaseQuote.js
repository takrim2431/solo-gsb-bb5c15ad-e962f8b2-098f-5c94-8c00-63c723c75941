'use strict';

/**
 * 采购报价组合（purchase quote combination）。
 *
 * 在已知需求张数（手工填写，或取印刷备料汇总的整包采购张数）后，
 * 用户录入多条本地报价，系统在满足需求与各报价边界（最少 / 最多可购包数）
 * 的全部整数包组合中，按以下优先级逐项比较确定唯一方案：
 *
 *   1. 总价最低（totalCostCents 最小）；
 *   2. 超购张数最少（采购张数 − 需求张数 最小）；
 *   3. 供应商数量最少（实际采购包数 > 0 的报价条数最少）；
 *   4. 录入顺序（前三项均并列时，从第 1 条报价起逐条比较，让录入更早的
 *      报价采购更多包数——与章节优先分帖「前帖优先装满」同一原则）。
 *
 * 价格一律按「分」（pricePerPackCents，整数）精确计算，全程整数运算，
 * 禁止使用浮点比较单价或总价。
 *
 * 输入（API 字段 purchaseQuotes，缺省 / null / false / { enabled: false }
 * 时整个模块不启用）：
 * - demandSheets?  手工需求张数（≥1 的整数）；缺省时取印刷备料的整包采购张数，
 *                  两者都没有则报错（未启用备料时必须手工填写）；
 * - quotes[]       报价列表（1 ~ MAX_QUOTES 条），每条：
 *   - supplier            供应商名称（非空字符串，同次请求内不可重复）；
 *   - sheetsPerPack       每包张数（≥1 的整数）；
 *   - pricePerPackCents   每包价格（分，≥0 的整数；如 1234 = 12.34 元）；
 *   - minPacks            最少可购包数（≥0 的整数，0 = 不设下限）；
 *   - maxPacks            最多可购包数（≥1 的整数，且 ≥ minPacks）。
 *
 * 无可行组合（即使所有报价都按上限采购，总张数仍不足需求）时返回
 * feasible: false 与具体缺口（gapSheets = 需求 − 尽最大可购张数），
 * rows 按各报价上限给出「尽最大可购」的逐报价采购量 / 金额（余量为 0）。
 *
 * 求解（solveQuoteCombination，纯函数，独立可测）——双引擎：
 * 各报价先满足强制最少包数，设额外采购 y_i ∈ [0, maxPacks−minPacks]，
 * 只需考虑额外张数 < 缺口 R + 最大包型 sMax（达到 R + sMax 时必可删掉某个
 * 至少 1 包的报价而仍满足需求，且总价不增），窗口宽度 cap = R + sMax − 1。
 *
 * - 稠密引擎（cap ≤ DENSE_STATE_LIMIT）：以额外张数为下标的余数滑动窗口
 *   最小值 DP，同一采购张数只保留（总价 → 供应商数 → 录入顺序）最优状态；
 *   金额在业务上限内为精确整数（≤ 8×10^5×10^9 = 8×10^14 < 2^53），
 *   窗口顺序键 cost − j×price 用 BigInt cross-product 比较，不做浮点比较；
 *   录入顺序向量按 B 进制拆为 4 个精确 double 分量做字典序比较，
 *   并逐阶段记录来源张数用于方案回溯。
 * - 枚举引擎（cap 更大时，典型为真实印刷包型 250～520 张/包、需求上千万）：
 *   取每分单价最便宜（cross-product 比较，同价取录入最早）的报价为整包
 *   兜底供应商，DFS 其余报价在窗口内的额外包数，叶节点由兜底整包补足；
 *   每个节点用「每张 cross-product 金额下界」剪枝，节点数有预算护栏。
 *
 * 两引擎的正确性均由随机全枚举暴力对照测试保证（稠密引擎为本模块
 * purchaseQuote.test.js 中的 4000 组；枚举键 / 剪枝另经 10 万组原型对照）。
 */

const MAX_DEMAND_SHEETS = 100000000;   // 需求张数上限 1 亿
const MAX_QUOTES = 8;                  // 报价条数上限
const MAX_SHEETS_PER_PACK = 100000000; // 每包张数上限 1 亿
const MAX_PACK_BOUND = 100000;         // 单报价最少 / 最多包数上限
const MAX_PRICE_CENTS = 1000000000;    // 每包价格上限：10 亿元 = 1e9 分
const MAX_SUPPLIER_LEN = 50;           // 供应商名称长度上限
const DENSE_STATE_LIMIT = 1000000;     // 稠密 DP 单维状态上限（超出改走枚举引擎）
const MAX_ENUM_NODES = 3000000;        // 枚举引擎节点护栏（超出返回明确错误）
const PACK_BASE = MAX_PACK_BOUND * 2 + 1; // 录入顺序向量编码基数（总包数 ≤ 200000 < B）

/**
 * 解析整数参数：接受整数或纯数字字符串，布尔 / null / 空串等返回 NaN。
 * 与拼版核心 / 备料模块的 toInteger 保持一致语义。
 */
function toInteger(value) {
  const n = Number(value);
  return Number.isInteger(n) ? n : NaN;
}

/**
 * 解析并校验采购报价组合输入（需求张数来源在 attach 阶段结合备料结果确定）。
 * @returns {{enabled: false} | {enabled: true, demandSheets: number|null, quotes: Array}}
 */
function parsePurchaseQuotesInput(input) {
  const raw = input && input.purchaseQuotes;
  if (raw === undefined || raw === null || raw === false) {
    return { enabled: false };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('采购报价组合参数 purchaseQuotes 必须为对象（含可选 demandSheets 与 quotes 报价列表）');
  }
  if (raw.enabled === false) {
    return { enabled: false };
  }
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
    throw new Error('采购报价组合开关 enabled 必须为布尔值（true / false）');
  }

  // 需求张数：缺省（undefined / null / 空串）时稍后回退到印刷备料整包采购张数。
  let demandSheets = null;
  if (raw.demandSheets !== undefined && raw.demandSheets !== null && raw.demandSheets !== '') {
    demandSheets = toInteger(raw.demandSheets);
    if (!Number.isInteger(demandSheets) || demandSheets < 1 || demandSheets > MAX_DEMAND_SHEETS) {
      throw new Error(`采购需求张数 demandSheets 必须为 1 ~ ${MAX_DEMAND_SHEETS.toLocaleString('en-US')} 的整数（或留空取印刷备料整包采购张数）`);
    }
  }

  if (!Array.isArray(raw.quotes)) {
    throw new Error('采购报价 quotes 必须为数组（每条含 supplier / sheetsPerPack / pricePerPackCents / minPacks / maxPacks）');
  }
  if (raw.quotes.length < 1) {
    throw new Error('采购报价至少录入 1 条（供应商 / 每包张数 / 每包价格 / 最少 / 最多可购包数）');
  }
  if (raw.quotes.length > MAX_QUOTES) {
    throw new Error(`采购报价最多录入 ${MAX_QUOTES} 条（收到 ${raw.quotes.length} 条）`);
  }

  const quotes = raw.quotes.map((q, i) => {
    const where = `第 ${i + 1} 条报价`;
    if (!q || typeof q !== 'object' || Array.isArray(q)) {
      throw new Error(`${where}必须为对象（供应商 / 每包张数 / 每包价格 / 最少 / 最多可购包数）`);
    }
    const supplier = typeof q.supplier === 'string' ? q.supplier.trim() : '';
    if (supplier === '') {
      throw new Error(`${where}供应商名称不能为空`);
    }
    if (supplier.length > MAX_SUPPLIER_LEN) {
      throw new Error(`${where}供应商名称长度不能超过 ${MAX_SUPPLIER_LEN} 个字符`);
    }
    const sheetsPerPack = toInteger(q.sheetsPerPack);
    if (!Number.isInteger(sheetsPerPack) || sheetsPerPack < 1 || sheetsPerPack > MAX_SHEETS_PER_PACK) {
      throw new Error(`${where}每包张数必须为 1 ~ ${MAX_SHEETS_PER_PACK.toLocaleString('en-US')} 的整数`);
    }
    const pricePerPackCents = toInteger(q.pricePerPackCents);
    if (!Number.isInteger(pricePerPackCents) || pricePerPackCents < 0 || pricePerPackCents > MAX_PRICE_CENTS) {
      throw new Error(`${where}每包价格（分）必须为 0 ~ ${MAX_PRICE_CENTS.toLocaleString('en-US')} 的整数（pricePerPackCents，如 1234 表示 12.34 元）`);
    }
    const minPacks = toInteger(q.minPacks);
    if (!Number.isInteger(minPacks) || minPacks < 0 || minPacks > MAX_PACK_BOUND) {
      throw new Error(`${where}最少可购包数必须为 0 ~ ${MAX_PACK_BOUND.toLocaleString('en-US')} 的整数`);
    }
    const maxPacks = toInteger(q.maxPacks);
    if (!Number.isInteger(maxPacks) || maxPacks < 1 || maxPacks > MAX_PACK_BOUND) {
      throw new Error(`${where}最多可购包数必须为 1 ~ ${MAX_PACK_BOUND.toLocaleString('en-US')} 的整数`);
    }
    if (maxPacks < minPacks) {
      throw new Error(`${where}最多可购包数（${maxPacks}）不能少于最少可购包数（${minPacks}）`);
    }
    return {
      index: i + 1,
      supplier,
      sheetsPerPack,
      pricePerPackCents,
      minPacks,
      maxPacks,
    };
  });

  // 供应商名称同次请求内不可重复：供应商数量这一排序维度依赖报价与供应商一一对应。
  const seen = new Set();
  quotes.forEach((q) => {
    if (seen.has(q.supplier)) {
      throw new Error(`供应商名称重复：「${q.supplier}」（同一供应商的不同报价请合并为一条，或在名称中加以区分）`);
    }
    seen.add(q.supplier);
  });

  return { enabled: true, demandSheets, quotes };
}

/**
 * 完整方案向量的录入顺序比较：从第 1 条报价起逐包数比较，
 * 首个不同处包数更大的方案优先（更早录入的报价优先装满）。
 * @returns {boolean} vecA 是否严格优于 vecB
 */
function entryVectorBetter(vecA, vecB) {
  for (let i = 0; i < vecA.length; i += 1) {
    if (vecA[i] !== vecB[i]) return vecA[i] > vecB[i];
  }
  return false; // 完全相同
}

/** 不可达状态的金额标记（业务金额上限 8×10^14，远小于 INF）。 */
const INF = Number.POSITIVE_INFINITY;

const popcount = (x) => {
  let c = 0;
  let v = x;
  while (v) { c += v & 1; v >>>= 1; }
  return c;
};

/**
 * 稠密引擎：余数滑动窗口最小值 DP（typed array 存储，BigInt 比较窗口顺序键）。
 * @returns {number[]} 各报价总包数向量
 */
function solveDense({ n, mins, extra, sizes, prices, minCost, baseMask, required, cap }) {
  // 工作数组：金额 / 供应商位掩码 / 录入顺序向量的 4 个 B 进制分量
  // （g[k] = packs[2k]·B + packs[2k+1]，< B² = 4×10^10，double 精确表示）。
  const makeWorkSets = () => ({
    cost: new Float64Array(cap + 1).fill(INF),
    mask: new Int32Array(cap + 1),
    g: [0, 1, 2, 3].map(() => new Float64Array(cap + 1)),
  });

  let prev = makeWorkSets();
  prev.cost[0] = minCost;
  prev.mask[0] = baseMask;
  // 初始向量 = 各报价最少包数
  for (let i = 0; i < n; i += 1) {
    if (mins[i]) prev.g[i >> 1][0] += (i & 1) === 0 ? mins[i] * PACK_BASE : mins[i];
  }

  // 逐阶段记录「本阶段张数 -> 上一阶段张数」，用于最终回溯包数向量。
  const choices = [];

  for (let i = 0; i < n; i += 1) {
    const s = sizes[i];
    const p = prices[i];
    const k = extra[i];
    const inBase = mins[i] > 0;
    const cur = makeWorkSets();
    const choice = new Int32Array(cap + 1).fill(-1);
    const ci = i >> 1;
    const odd = i & 1;
    const pBig = BigInt(p);

    /** 候选（来源张数 srcAmt、来源位置 j、本报价额外包数 y）在目标张数处是否优于当前 best。 */
    function writeBest(ta, srcAmt, j, y) {
      const packsI = mins[i] + y;
      const cost = prev.cost[srcAmt] + packsI * p; // ≤ 8×10^14，整数精确
      const mask = inBase || y === 0 ? prev.mask[srcAmt] : (prev.mask[srcAmt] | (1 << i));
      const deltaG = odd ? packsI : packsI * PACK_BASE;
      const gv = prev.g[ci][srcAmt] + deltaG;

      const oldCost = cur.cost[ta];
      let better;
      if (cost < oldCost) {
        better = true;
      } else if (cost === oldCost) {
        const oldSup = popcount(cur.mask[ta]);
        const newSup = popcount(mask);
        if (newSup !== oldSup) {
          better = newSup < oldSup;
        } else {
          // 录入顺序：按 B 进制分量字典序（仅 ≤ i 的位置可能不同）
          better = false;
          for (let h = 0; h < 4; h += 1) {
            const nv = h === ci ? gv : prev.g[h][srcAmt];
            const ov = cur.g[h][ta];
            if (nv !== ov) { better = nv > ov; break; }
          }
        }
      } else {
        better = false;
      }
      if (better) {
        cur.cost[ta] = cost;
        cur.mask[ta] = mask;
        for (let h = 0; h < 4; h += 1) {
          cur.g[h][ta] = h === ci ? gv : prev.g[h][srcAmt];
        }
        choice[ta] = srcAmt;
      }
    }

    // 按对 s 的余数分组，组内位置 j 对应张数 r + j·s。
    for (let r = 0; r < s && r <= cap; r += 1) {
      const jMax = Math.floor((cap - r) / s);
      // 单调队列元素：{ j, key(BigInt = cost − j×p), sup, g:[4] }
      const deque = [];
      let head = 0;

      const tailDominates = (inc, dq) => {
        // 顺序键（BigInt 精确整数 cross-product，绝不使用浮点）
        const ka = BigInt(inc.cost) - BigInt(inc.j) * pBig;
        const kb = BigInt(dq.cost) - BigInt(dq.j) * pBig;
        if (ka !== kb) return ka < kb;
        if (inc.sup !== dq.sup) return inc.sup < dq.sup;
        for (let h = 0; h < 4; h += 1) {
          if (inc.g[h] !== dq.g[h]) return inc.g[h] > dq.g[h];
        }
        return inc.j < dq.j; // 同键：更早来源在目标处买入更多包（录入顺序）
      };

      for (let jt = 0; jt <= jMax; jt += 1) {
        const ta = r + jt * s;

        // y = 0：沿用上一阶段同张数状态（本报价只买最少包数）。
        if (prev.cost[ta] !== INF) writeBest(ta, ta, jt, 0);

        // 新滑入窗口的来源（位置 jt − 1，对应在目标处买入 y = 1）。
        const inJ = jt - 1;
        if (inJ >= 0) {
          const inAmt = r + inJ * s;
          if (prev.cost[inAmt] !== INF) {
            const inc = { j: inJ, cost: prev.cost[inAmt], sup: popcount(prev.mask[inAmt]), g: prev.g.map((arr) => arr[inAmt]) };
            while (deque.length > head && tailDominates(inc, deque[deque.length - 1])) deque.pop();
            deque.push(inc);
          }
        }
        // 丢弃窗口外来源（买入 y = jt − j > k）。
        while (head < deque.length && deque[head].j < jt - k) head += 1;

        if (head < deque.length) {
          const src = deque[head];
          const y = jt - src.j; // 1 ≤ y ≤ k
          writeBest(ta, r + src.j * s, src.j, y);
        }
      }
    }

    choices.push(choice);
    prev = cur;
  }

  // 终选：张数 ≥ required 的状态中按「总价 → 超购（张数）→ 供应商数 → 录入顺序」取唯一最优。
  let bestAmt = -1;
  for (let amt = required; amt <= cap; amt += 1) {
    if (prev.cost[amt] === INF) continue;
    if (bestAmt < 0) { bestAmt = amt; continue; }
    const c = prev.cost[amt];
    const bc = prev.cost[bestAmt];
    if (
      c < bc ||
      (c === bc &&
        (amt < bestAmt ||
          (amt === bestAmt &&
            (popcount(prev.mask[amt]) < popcount(prev.mask[bestAmt]) ||
              (popcount(prev.mask[amt]) === popcount(prev.mask[bestAmt]) &&
                (() => {
                  for (let h = 0; h < 4; h += 1) {
                    if (prev.g[h][amt] !== prev.g[h][bestAmt]) return prev.g[h][amt] > prev.g[h][bestAmt];
                  }
                  return false;
                })())))))
    ) {
      bestAmt = amt;
    }
  }

  /* istanbul ignore if */
  if (bestAmt < 0) {
    throw new Error('采购报价组合求解失败：未找到满足需求的组合');
  }

  // 回溯各报价额外包数。
  const extraPacks = new Array(n).fill(0);
  let amt = bestAmt;
  for (let i = n - 1; i >= 0; i -= 1) {
    const srcAmt = choices[i][amt];
    extraPacks[i] = (amt - srcAmt) / sizes[i];
    amt = srcAmt;
  }
  return extraPacks.map((y, i) => mins[i] + y);
}

/**
 * 枚举引擎：最便宜报价整包兜底 + 其余报价窗口内 DFS，每张 cross-product 下界剪枝。
 * @returns {number[]} 各报价总包数向量
 */
function solveEnum({ n, mins, extra, sizes, prices, minCost, required, sMax }) {
  // 每分单价比较：p_i·s_j < p_j·s_i ⇔ i 更便宜；同价取录入更早。
  let bulk = 0;
  for (let i = 1; i < n; i += 1) {
    const lhs = prices[i] * sizes[bulk];
    const rhs = prices[bulk] * sizes[i];
    if (lhs < rhs || (lhs === rhs && i < bulk)) bulk = i;
  }
  const sBulk = sizes[bulk];
  const pBulk = prices[bulk];
  const pBulkBig = BigInt(pBulk);
  const sBulkBig = BigInt(sBulk);
  const others = [];
  for (let i = 0; i < n; i += 1) if (i !== bulk) others.push(i);

  let best = null; // { packs, sheets, cost, suppliers }
  let nodes = 0;

  function consider(packs) {
    let sheets = 0;
    let cost = 0;
    let suppliers = 0;
    for (let i = 0; i < n; i += 1) {
      sheets += packs[i] * sizes[i];
      cost += packs[i] * prices[i];
      if (packs[i] > 0) suppliers += 1;
    }
    const cand = { packs, sheets, cost, suppliers };
    if (
      !best ||
      cand.cost < best.cost ||
      (cand.cost === best.cost &&
        (cand.sheets < best.sheets ||
          (cand.sheets === best.sheets &&
            (cand.suppliers < best.suppliers ||
              (cand.suppliers === best.suppliers && entryVectorBetter(packs, best.packs))))))
    ) {
      best = cand;
    }
  }

  const yo = new Array(n).fill(0);
  function dfs(k, restSheets, restCost) {
    nodes += 1;
    if (nodes > MAX_ENUM_NODES) {
      throw new Error(`采购报价组合规模超出计算上限（枚举节点超过 ${MAX_ENUM_NODES.toLocaleString('en-US')}）：请收紧各报价可购包数区间、减少报价条数，或增大各报价每包张数`);
    }
    if (k === others.length) {
      // 兜底报价整包补足缺口；其余报价已凑够时兜底额外买 0 包（总价更低）。
      const yBulk = restSheets >= required ? 0 : Math.ceil((required - restSheets) / sBulk);
      if (yBulk > extra[bulk]) return;
      const packs = mins.slice();
      packs[bulk] += yBulk;
      others.forEach((oi, j) => { packs[oi] += yo[j]; });
      consider(packs);
      return;
    }
    // 每张金额下界（BigInt cross-product，精确不高估）：
    // 还缺 ≥1 张时，任何补足方式每分单价都不低于兜底，故补到满足需求的
    // 金额至少 ceil(need·p_b/s_b) 分；已花 + 该下界高于当前最优即可剪枝。
    if (best && restSheets < required) {
      const needBig = BigInt(required - restSheets);
      const lbBig = BigInt(minCost) + BigInt(restCost) + (needBig * pBulkBig + sBulkBig - 1n) / sBulkBig;
      if (lbBig > BigInt(best.cost)) return;
    }
    const oi = others[k];
    const s = sizes[oi];
    // 窗口界：其余报价额外张数合计 < required + sMax。
    const yMax = Math.min(extra[oi], Math.floor((required + sMax - 1 - restSheets) / s));
    for (let y = 0; y <= yMax; y += 1) {
      yo[k] = y;
      dfs(k + 1, restSheets + y * s, restCost + y * prices[oi]);
    }
    yo[k] = 0;
  }
  dfs(0, 0, 0);

  /* istanbul ignore if */
  if (!best) {
    throw new Error('采购报价组合求解失败：未找到满足需求的组合');
  }
  return best.packs;
}

/**
 * 采购报价组合求解（纯函数，独立可测）。
 *
 * @param {number} demandSheets 需求张数（≥1 整数）
 * @param {Array} quotes 规范化后的报价（parsePurchaseQuotesInput 产出）
 * @returns {object} 组合结果（feasible / rows / totals 或不可行缺口）
 */
function solveQuoteCombination(demandSheets, quotes) {
  const n = quotes.length;
  const mins = quotes.map((q) => q.minPacks);
  const extra = quotes.map((q) => q.maxPacks - q.minPacks);
  const sizes = quotes.map((q) => q.sheetsPerPack);
  const prices = quotes.map((q) => q.pricePerPackCents);

  const minSheets = mins.reduce((sum, m, i) => sum + m * sizes[i], 0);
  const minCost = mins.reduce((sum, m, i) => sum + m * prices[i], 0);
  const maxSheets = quotes.reduce((sum, q) => sum + q.maxPacks * q.sheetsPerPack, 0);

  const buildRows = (packs) => quotes.map((q, i) => {
    const p = packs[i];
    const remainingPacks = q.maxPacks - p;
    return {
      index: q.index,
      supplier: q.supplier,
      sheetsPerPack: q.sheetsPerPack,
      pricePerPackCents: q.pricePerPackCents,
      minPacks: q.minPacks,
      maxPacks: q.maxPacks,
      packs: p,
      sheets: p * q.sheetsPerPack,
      amountCents: p * q.pricePerPackCents,
      remainingPacks,
      remainingSheets: remainingPacks * q.sheetsPerPack,
    };
  });

  // 不可行：所有报价都按上限采购仍凑不满需求。rows 给出「尽最大可购」配置，
  // 余量全部为 0，并明确缺口张数。
  if (maxSheets < demandSheets) {
    const packs = quotes.map((q) => q.maxPacks);
    const totals = {
      totalPacks: packs.reduce((a, b) => a + b, 0),
      totalSheets: maxSheets,
      overPurchaseSheets: 0,
      totalCostCents: quotes.reduce((sum, q) => sum + q.maxPacks * q.pricePerPackCents, 0),
      supplierCount: quotes.filter((q) => q.maxPacks > 0).length,
      suppliers: quotes.filter((q) => q.maxPacks > 0).map((q) => q.supplier),
    };
    return {
      feasible: false,
      reason: `即使所有报价都按上限采购，最多仅能购入 ${maxSheets.toLocaleString('en-US')} 张，距需求 ${demandSheets.toLocaleString('en-US')} 张仍差 ${(demandSheets - maxSheets).toLocaleString('en-US')} 张`,
      gapSheets: demandSheets - maxSheets,
      demandSheets,
      minPurchasableSheets: minSheets,
      maxPurchasableSheets: maxSheets,
      totals,
      rows: buildRows(packs),
    };
  }

  // 强制最少包数已满足需求：额外采购只会增加总价（价格 ≥ 0）与超购，
  // 不可能进入最优解，直接以最少包数为唯一方案。
  if (minSheets >= demandSheets) {
    return buildFeasible(demandSheets, quotes, mins.slice(), buildRows, popcount);
  }

  const required = demandSheets - minSheets; // 额外采购张数下限
  const sMax = Math.max(...sizes);
  const cap = required + sMax - 1; // 最优解额外张数上界（删包论证）
  const baseMask = mins.reduce((mask, m, i) => (m > 0 ? mask | (1 << i) : mask), 0);

  const ctx = { n, mins, extra, sizes, prices, minCost, baseMask, required, sMax, cap };
  // 小窗口用稠密数组 DP；大窗口（真实大需求 + 大包型）用带剪枝的枚举引擎。
  const packs = cap <= DENSE_STATE_LIMIT ? solveDense(ctx) : solveEnum(ctx);

  return buildFeasible(demandSheets, quotes, packs, buildRows, popcount);
}

/** 组装可行方案结果（逐报价行 + 合计）。 */
function buildFeasible(demandSheets, quotes, packs, buildRows, countSuppliers) {
  const rows = buildRows(packs);
  const usedMask = packs.reduce((mask, x, i) => (x > 0 ? mask | (1 << i) : mask), 0);
  const totals = {
    totalPacks: packs.reduce((a, b) => a + b, 0),
    totalSheets: rows.reduce((sum, r) => sum + r.sheets, 0),
    overPurchaseSheets: rows.reduce((sum, r) => sum + r.sheets, 0) - demandSheets,
    totalCostCents: rows.reduce((sum, r) => sum + r.amountCents, 0),
    supplierCount: countSuppliers(usedMask),
    suppliers: quotes.filter((_, i) => packs[i] > 0).map((q) => q.supplier),
  };
  return {
    feasible: true,
    demandSheets,
    tieBreak: 'totalCostCents -> overPurchaseSheets -> supplierCount -> entryOrder',
    totals,
    rows,
  };
}

/**
 * 依据印刷备料结果确定需求张数并执行组合求解。
 * 仅在 parsePurchaseQuotesInput 返回 enabled 时调用；否则不写入任何字段。
 *
 * @param {object} result 拼版计算结果
 * @param {{enabled:false}|{enabled:true, demandSheets:number|null, quotes:Array}} parsed
 * @param {number|null} fallbackSheets 印刷备料的整包采购张数（未启用备料时为 null）
 * @returns {object|undefined} 采购报价组合结果（purchaseQuotes 段）
 */
function attachPurchaseQuotes(result, parsed, fallbackSheets) {
  if (!parsed || !parsed.enabled) return undefined;

  let demandSheets;
  let demandSource;
  if (parsed.demandSheets !== null) {
    demandSheets = parsed.demandSheets;
    demandSource = 'manual';
  } else if (fallbackSheets !== null && Number.isInteger(fallbackSheets) && fallbackSheets >= 1) {
    demandSheets = fallbackSheets;
    demandSource = 'materialPrep';
  } else {
    throw new Error('采购报价组合需要需求张数：请手工填写 demandSheets，或先启用印刷备料以自动接入整包采购张数');
  }

  const solved = solveQuoteCombination(demandSheets, parsed.quotes);
  return {
    enabled: true,
    demandSheets,
    demandSource,
    priceUnit: 'cents',
    tieBreakRule: '总价最低 → 超购张数最少 → 供应商数量最少 → 录入顺序（更早录入优先装满）',
    quotes: parsed.quotes.map(({ index, supplier, sheetsPerPack, pricePerPackCents, minPacks, maxPacks }) => ({
      index, supplier, sheetsPerPack, pricePerPackCents, minPacks, maxPacks,
    })),
    ...solved,
  };
}

module.exports = {
  parsePurchaseQuotesInput,
  solveQuoteCombination,
  attachPurchaseQuotes,
  MAX_QUOTES,
};
