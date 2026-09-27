'use strict';

/**
 * 库存批次领纸（inventory batch paper drawing）。
 *
 * 在印刷备料（materialPrep）算出各帖需领纸 requiredSheets 之后，用户录入
 * 1～12 个库存批次（批号 / 可用张数 / 允许使用的帖号），系统把批次库存分配
 * 给各帖，求**总缺口最小**的领用方案：
 *
 * - 批次可拆给多帖、同帖可跨批次（分配单位为整张纸，整数）；
 * - 每批领用合计不得超过其可用张数（库存约束）；
 * - 每批只能分给允许使用的帖（未填写允许帖号 = 通用批，全部帖可用）；
 * - 总缺口 = Σ（各帖需领纸 − 各帖实际领用），等价于总领用最大。
 *
 * 求解（solveBatchAllocation，纯函数，独立可测）：建模为最大流——
 * 源 -> 各批次（容量 = 可用张数），批次 -> 允许的帖（容量无限），
 * 帖 -> 汇（容量 = 该帖需领纸）。最大流即最大总领用，总需求减去它即最小总缺口。
 * 用 Dinic 算法求解；邻接边按「批次录入顺序 → 帖号升序」固定次序遍历，
 * 同一输入必得同一分配（确定性输出）。批次数 ≤ 12、帖数 ≤ 2500，
 * 增广路长度 ≤ 2×批次数 + 3，实际运行远低于该上界。
 *
 * 输入（API 字段 stockBatches，缺省 / null / false / { enabled: false }
 * 时整个模块不启用）：
 * - batches[]  批次列表（1 ~ MAX_BATCHES 个），每个：
 *   - lot                 批号（非空字符串，≤ 50 字符，同次请求内不可重复）；
 *   - availableSheets     可用张数（≥1 的整数）；
 *   - allowedSignatures?  允许使用的帖号数组（1 ~ 帖数的整数，不可重复）；
 *                         缺省 / null / 空数组 = 通用批（全部帖可用）。
 *
 * 启用本模块必须同时启用印刷备料（各帖需求取自 materialPrep.signatures 的
 * requiredSheets）；未启用备料时启用本模块返回明确错误。
 *
 * 输出（顶层 stockBatches 段）：逐帖 signatures 给出需领纸 / 各批次领用明细 /
 * 领用合计 / 缺口；逐批 batches 给出可用张数 / 允许帖号 / 领用合计 / 剩余张数 /
 * 领用去向；totals 汇总需求 / 库存 / 领用 / 剩余 / 缺口与是否全部满足。
 * 未启用时 parse 返回 { enabled: false }，attachStockBatches 不写入任何字段，
 * 原响应完全不变。
 */

const MAX_BATCHES = 12;               // 批次数上限
const MAX_AVAILABLE_SHEETS = 100000000; // 单批可用张数上限 1 亿
const MAX_LOT_LEN = 50;               // 批号长度上限

/** 解析整数参数：接受整数或纯数字字符串，布尔 / null / 空串等返回 NaN。 */
function toInteger(value) {
  const n = Number(value);
  return Number.isInteger(n) ? n : NaN;
}

/**
 * 解析并校验库存批次领纸输入（帖号范围在 attach 阶段结合拼版结果校验）。
 * @returns {{enabled: false} | {enabled: true, batches: Array}}
 */
function parseStockBatchesInput(input) {
  const raw = input && input.stockBatches;
  if (raw === undefined || raw === null || raw === false) {
    return { enabled: false };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('库存批次领纸参数 stockBatches 必须为对象（含 batches 批次列表）');
  }
  if (raw.enabled === false) {
    return { enabled: false };
  }
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
    throw new Error('库存批次领纸开关 enabled 必须为布尔值（true / false）');
  }

  if (!Array.isArray(raw.batches)) {
    throw new Error('库存批次 batches 必须为数组（每个批次含 lot / availableSheets / 可选 allowedSignatures）');
  }
  if (raw.batches.length < 1) {
    throw new Error('库存批次至少录入 1 个批次（批号 / 可用张数 / 允许使用的帖号）');
  }
  if (raw.batches.length > MAX_BATCHES) {
    throw new Error(`库存批次最多录入 ${MAX_BATCHES} 个（收到 ${raw.batches.length} 个）`);
  }

  const batches = raw.batches.map((b, i) => {
    const where = `第 ${i + 1} 个批次`;
    if (!b || typeof b !== 'object' || Array.isArray(b)) {
      throw new Error(`${where}必须为对象（批号 lot / 可用张数 availableSheets / 可选允许帖号 allowedSignatures）`);
    }
    const lot = typeof b.lot === 'string' ? b.lot.trim() : '';
    if (lot === '') {
      throw new Error(`${where}批号 lot 不能为空`);
    }
    if (lot.length > MAX_LOT_LEN) {
      throw new Error(`${where}批号「${lot}」长度不能超过 ${MAX_LOT_LEN} 个字符`);
    }
    const availableSheets = toInteger(b.availableSheets);
    if (!Number.isInteger(availableSheets) || availableSheets < 1 || availableSheets > MAX_AVAILABLE_SHEETS) {
      throw new Error(`${where}（批号「${lot}」）可用张数 availableSheets 必须为 1 ~ ${MAX_AVAILABLE_SHEETS.toLocaleString('en-US')} 的整数`);
    }

    // 允许使用的帖号：缺省 / null / 空数组 = 通用批（全部帖可用）；
    // 否则为整数数组（范围结合帖数在 attach 阶段校验），同批内不可重复。
    let allowedSignatures = null;
    if (b.allowedSignatures !== undefined && b.allowedSignatures !== null) {
      if (!Array.isArray(b.allowedSignatures)) {
        throw new Error(`${where}（批号「${lot}」）允许使用的帖号 allowedSignatures 必须为数组（如 [1, 3]；留空表示全部帖通用）`);
      }
      if (b.allowedSignatures.length > 0) {
        const seen = new Set();
        allowedSignatures = b.allowedSignatures.map((v) => {
          const n = typeof v === 'number' || (typeof v === 'string' && v.trim() !== '') ? toInteger(v) : NaN;
          if (!Number.isInteger(n)) {
            throw new Error(`${where}（批号「${lot}」）允许使用的帖号必须为整数（收到非法值：${JSON.stringify(v)}）`);
          }
          if (seen.has(n)) {
            throw new Error(`${where}（批号「${lot}」）允许使用的帖号重复：${n}`);
          }
          seen.add(n);
          return n;
        }).sort((x, y) => x - y);
      }
    }

    return {
      index: i + 1,
      lot,
      availableSheets,
      allowedSignatures, // null = 通用批
    };
  });

  // 批号同次请求内不可重复（批号即批次的唯一标识，逐批剩余张数按批号归属）。
  const lots = new Set();
  batches.forEach((b) => {
    if (lots.has(b.lot)) {
      throw new Error(`批号重复：「${b.lot}」（同一批次的库存请合并为一条录入）`);
    }
    lots.add(b.lot);
  });

  return { enabled: true, batches };
}

/**
 * 库存批次领纸分配求解（纯函数，独立可测）。
 *
 * 最大流建模（Dinic 算法）：
 * - 源 -> 批次 i：容量 = 该批可用张数（每批领用不得超库存）；
 * - 批次 i -> 帖 j：容量无限，仅当帖 j 在该批允许列表内（只能分给允许的帖）；
 * - 帖 j -> 汇：容量 = 该帖需领纸（每帖领用不超过需求，缺口 = 需求 − 领用）。
 * 最大流 = 最大总领用；总缺口 = 总需求 − 最大总领用，即总缺口最小。
 *
 * @param {Array<{availableSheets:number, allowed:Set<number>}>} batches
 *        批次（allowed 为 0 起始帖下标集合，通用批含全部帖）
 * @param {number[]} demands 各帖需领纸（0 起始）
 * @returns {number[][]} allocation[i][j] = 批次 i 分给帖 j 的张数（整数，≥0）
 */
function solveBatchAllocation(batches, demands) {
  const n = batches.length;
  const m = demands.length;
  const S = 0;
  const batchNode = (i) => 1 + i;
  const sigNode = (j) => 1 + n + j;
  const T = 1 + n + m;
  const N = T + 1;
  const INF = Number.MAX_SAFE_INTEGER; // 大于任何可行流量（总量 ≤ 12 × 1e8）

  // 边成对存储（正向偶数 id、反向奇数 id），正向边的流量 = 反向边残量。
  const to = [];
  const cap = [];
  const adj = Array.from({ length: N }, () => []);
  const addEdge = (u, v, c) => {
    const f = to.length;
    to.push(v);
    cap.push(c);
    adj[u].push(f);
    to.push(u);
    cap.push(0);
    adj[v].push(f + 1);
    return f;
  };

  batches.forEach((b, i) => addEdge(S, batchNode(i), b.availableSheets));
  // 记录「批次 -> 帖」边 id，求解后按反向边残量读出分配量；
  // 边按批次录入顺序、帖号升序加入，保证遍历次序固定（确定性输出）。
  const allocEdge = batches.map((b, i) => {
    const ids = new Map();
    [...b.allowed].sort((x, y) => x - y).forEach((j) => {
      ids.set(j, addEdge(batchNode(i), sigNode(j), INF));
    });
    return ids;
  });
  demands.forEach((d, j) => addEdge(sigNode(j), T, d));

  const level = new Int32Array(N);
  const ptr = new Int32Array(N);

  function bfs() {
    level.fill(-1);
    level[S] = 0;
    const queue = [S];
    for (let h = 0; h < queue.length; h += 1) {
      const u = queue[h];
      const edges = adj[u];
      for (let k = 0; k < edges.length; k += 1) {
        const e = edges[k];
        if (cap[e] > 0 && level[to[e]] < 0) {
          level[to[e]] = level[u] + 1;
          queue.push(to[e]);
        }
      }
    }
    return level[T] >= 0;
  }

  function dfs(u, f) {
    if (u === T) return f;
    const edges = adj[u];
    while (ptr[u] < edges.length) {
      const e = edges[ptr[u]];
      const v = to[e];
      if (cap[e] > 0 && level[v] === level[u] + 1) {
        const d = dfs(v, Math.min(f, cap[e]));
        if (d > 0) {
          cap[e] -= d;
          cap[e ^ 1] += d;
          return d;
        }
      }
      ptr[u] += 1;
    }
    return 0;
  }

  while (bfs()) {
    ptr.fill(0);
    while (dfs(S, INF) > 0) {
      // 流量从边残量读取，无需在此累计
    }
  }

  return batches.map((b, i) => {
    const row = new Array(m).fill(0);
    b.allowed.forEach((j) => {
      row[j] = cap[allocEdge[i].get(j) + 1]; // 反向边残量 = 正向边流量
    });
    return row;
  });
}

/**
 * 依据印刷备料结果（各帖需领纸）求解批次领纸分配并附加到结果。
 * 仅在 parseStockBatchesInput 返回 enabled 时调用；否则不写入任何字段。
 *
 * @param {object} result 拼版计算结果（读取 signatureCount）
 * @param {{enabled:false}|{enabled:true, batches:Array}} parsed
 * @param {object|undefined} materialPrepResult 印刷备料结果（未启用备料时为 undefined）
 * @returns {object|undefined} 库存批次领纸结果（stockBatches 段）
 */
function attachStockBatches(result, parsed, materialPrepResult) {
  if (!parsed || !parsed.enabled) return undefined;
  if (!materialPrepResult || !materialPrepResult.enabled) {
    throw new Error('库存批次领纸需先启用印刷备料（materialPrep）：各帖需求取自备料的需领纸 requiredSheets，未启用备料时无法启用本模块');
  }

  const signatureCount = result.signatureCount;
  // 帖号范围校验（帖数由拼版结果决定，只能在 attach 阶段校验）
  parsed.batches.forEach((b) => {
    if (!b.allowedSignatures) return;
    b.allowedSignatures.forEach((s) => {
      if (s < 1 || s > signatureCount) {
        throw new Error(`第 ${b.index} 个批次（批号「${b.lot}」）允许使用的帖号 ${s} 超出范围（1 ~ ${signatureCount}）`);
      }
    });
  });

  const demands = materialPrepResult.signatures.map((row) => row.requiredSheets);
  const solverBatches = parsed.batches.map((b) => ({
    availableSheets: b.availableSheets,
    allowed: new Set(
      b.allowedSignatures === null
        ? Array.from({ length: signatureCount }, (_, j) => j) // 通用批：全部帖
        : b.allowedSignatures.map((s) => s - 1)
    ),
  }));
  const allocation = solveBatchAllocation(solverBatches, demands);

  // 逐批：领用合计 / 剩余张数 / 领用去向（仅列出实际领用的帖）
  const batches = parsed.batches.map((b, i) => {
    const allocations = [];
    let drawnSheets = 0;
    allocation[i].forEach((sheets, j) => {
      if (sheets > 0) {
        allocations.push({ signature: j + 1, sheets });
        drawnSheets += sheets;
      }
    });
    return {
      index: b.index,
      lot: b.lot,
      availableSheets: b.availableSheets,
      universal: b.allowedSignatures === null,
      allowedSignatures: b.allowedSignatures === null ? null : b.allowedSignatures.slice(),
      drawnSheets,
      remainingSheets: b.availableSheets - drawnSheets,
      allocations,
    };
  });

  // 逐帖：需领纸 / 各批次领用明细 / 领用合计 / 缺口
  const signatures = demands.map((requiredSheets, j) => {
    const allocations = [];
    let drawnSheets = 0;
    parsed.batches.forEach((b, i) => {
      const sheets = allocation[i][j];
      if (sheets > 0) {
        allocations.push({ batch: b.index, lot: b.lot, sheets });
        drawnSheets += sheets;
      }
    });
    return {
      signature: j + 1,
      requiredSheets,
      drawnSheets,
      gapSheets: requiredSheets - drawnSheets,
      allocations,
    };
  });

  const totals = batches.reduce(
    (acc, b) => {
      acc.availableSheets += b.availableSheets;
      acc.drawnSheets += b.drawnSheets;
      acc.remainingSheets += b.remainingSheets;
      return acc;
    },
    {
      signatureCount,
      batchCount: batches.length,
      requiredSheets: demands.reduce((sum, d) => sum + d, 0),
      availableSheets: 0,
      drawnSheets: 0,
      remainingSheets: 0,
      gapSheets: 0,
    }
  );
  totals.gapSheets = totals.requiredSheets - totals.drawnSheets;
  totals.fullyCovered = totals.gapSheets === 0;

  return {
    enabled: true,
    rule: '总缺口最小（= 总领用最大）的最大流分配：批次可拆给多帖、同帖可跨批次，每批领用不超过可用张数且只能分给允许的帖；未填允许帖号的批次为通用批（全部帖可用）',
    demandSource: 'materialPrep.requiredSheets',
    batches,
    signatures,
    totals,
  };
}

module.exports = {
  parseStockBatchesInput,
  solveBatchAllocation,
  attachStockBatches,
  MAX_BATCHES,
};
