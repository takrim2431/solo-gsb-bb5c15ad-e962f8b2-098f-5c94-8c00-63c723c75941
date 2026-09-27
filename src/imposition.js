'use strict';

const { parseFitInput, attachFit } = require('./fitCheck');
const { parseProductionMarksInput, attachProductionMarks } = require('./productionMarks');
const { attachVerification } = require('./verification');
const { parseMaterialPrepInput, attachMaterialPrep } = require('./materialPrep');
const { parsePurchaseQuotesInput, attachPurchaseQuotes } = require('./purchaseQuote');
const { parseDualVersionInput, attachDualVersion } = require('./dualVersion');
const { parseStockBatchesInput, attachStockBatches } = require('./stockBatches');

/**
 * 骑马钉（saddle-stitch）拼版计算核心。
 *
 * 基本概念：
 * - 一「帖」由若干张纸叠放后对折而成；每张纸正、反面各印 2 页，
 *   故 每帖页数 = 每帖张数 × 4。
 * - 同一帖内，第 i 张纸（由外向内，i 从 0 起）：
 *     小号页对 = start + 2i（正面）与 start + 2i + 1（其背面）
 *     大号页对 = end   - 2i（正面）与 end   - 2i - 1（其背面）
 * - 装订方向决定正面左右页位：
 *     左装订：正面左位放大号页、右位放小号页（第 1 页在右侧，书脊在左）；
 *     右装订：镜像（第 1 页在左侧，书脊在右）。
 * - 背面页位按双面翻转方式做坐标变换（纸张坐标系，与正面同一视角）：
 *     长边翻转：绕水平长边翻转，(x, y) -> (x, H - y)，左右页位不变，内容旋转 180°；
 *     短边翻转：绕垂直短边翻转，(x, y) -> (W - x, y)，左右页位互换，内容方向不变。
 * - 成品页数不足整帖时，在末尾自动补空白页。
 *
 * 分帖模式：
 * - 固定分帖（balancedSplit / chapterSplit 缺省 / false，默认）：每帖固定
 *   sheetsPerSignature 张，末帖不足部分整体补白。
 * - 均衡分帖（balancedSplit = true）：仍以每帖张数为上限，先按上限求出最少帖数，
 *   再把整本所需纸张 ceil(总页数 / 4) 在这些帖间均匀分配，各帖实际张数差不超过 1；
 *   各帖按自身页数连续编号，空白页只会出现在末帖末尾（页码最大的若干页位）。
 *   每帖返回 actualSheetCount；顶层 balanced.savedBlankPages 给出相对固定分帖
 *   少补的空白页数；爬移补偿按各帖实际层数（实际张数）独立重算。
 * - 章节优先分帖（chapterSplit = true + chapterStarts 递增章节起始页）：
 *   在每帖不超过张数上限、每帖纸张数为整数（页数为 4 的倍数）的前提下规划连续页段，
 *   按「章节被拆分次数最少 → 补白页总数最少 → 帖数最少 → 前帖优先装满」的顺序
 *   确定唯一方案；章节末尾允许插入帖内补白，后续真实页码保持连续并正确进入下一帖。
 *   每帖返回覆盖章节 chapters、真实页范围 pageStart/pageEnd 与补白页数 blankPages；
 *   顶层 chapters 汇总章节列表、拆分次数与各帖实际张数。
 *
 * 爬移补偿（creep compensation）：
 * - 内帖书背处向外隆起，内层纸页裁切后会比外层短，需要把内层页位向外侧平移补偿。
 * - 每帖第 i 张纸（由外向内，i 从 0 起）的补偿量：
 *     creep = min(i × 纸张厚度 × 2, 最大补偿量)（单位 mm）
 *   （乘 2 是因为每张纸在折缝两侧各贡献一个厚度；每帖独立从 i=0 起算。）
 * - 偏移符号：左装订时左页位取正、右页位取负；右装订时符号整体反转。
 * - 每个页位（含空白页）都带 offsetMm；纸张厚度或最大补偿量任一为 0（或缺省）时
 *   全部 offsetMm 为 0，页码拼版结果与不启用时完全一致。
 *
 * 试印核验（trial print verification）：
 * - 可选录入 1～12 条实物观察（帖 / 张 / 正背面 / 左右页位 / 看到的页码或空白 / 内容朝向），
 *   服务端用同一输入重算「左/右装订 × 长/短边翻转」四种设置并逐条比对，
 *   按「错误观察数最少 → 错误字段数最少 → 当前设置优先 → 固定组合顺序」排序候选；
 *   仅唯一零差异组合判定验证通过，并列最优时返回无法判定及并列组合（不强行推荐），
 *   并从未观察页位按「最坏剩余候选最少 → 结果分组最多 → 非空白 → 背面 →
 *   帖/张/左→右 顺序」计算唯一的下一处观察建议（无页位可区分时明确为 null）。
 * - 非法索引、重复观察返回明确错误；无观察（缺省 / 空数组）时 verification 为
 *   { enabled: false }，原流程完全不变。
 *
 * 双面生产标记（duplex production marks）：
 * - 仅在启用适配检查后可启用（productionMarks = true，可选 markSizeMm 指定尺寸）；
 *   为每张纸正、背面生成裁切线（8 条外角线段）、折线标（中线上下各 1 条）与
 *   套准十字（左右两侧，每侧按「居中 → 1/4 → 3/4」固定候选顺序尝试）。
 * - 每个标记的线段须完整落在纸内、避开两侧出血框且不与同面已放置标记相交，
 *   按候选顺序取首个全部合法的位置；全部候选不可用则省略并逐候选返回原因。
 * - 背面标记由正面标记逐线段按长边（x,y->x,H-y）/ 短边（x,y->W-x,y）翻转
 *   做同一物理位置的坐标变换，保证正背套准；正面省略的标记背面同步省略。
 * - 标记坐标取自 trim / bleedBox（含爬移偏移），纸张尺寸或爬移参数变化时
 *   在同一次重算中同步重算。未启用（缺省 / false）时不带任何标记字段，
 *   现有响应完全不变。
 *
 * 印刷备料（printing material preparation）：
 * - 可选提供 materialPrep { copies, makereadySheets, processWasteRate, sheetsPerPack }
 *   （成品份数 / 每帖开机损耗张数 / 过程损耗率 / 每包张数），在拼版完成后
 *   按各帖实际张数逐帖计算净用纸 = 实际张数 × 份数，并以
 *   需领纸 = ceil((净用纸 + 开机损耗) / (1 − 过程损耗率)) 逐帖向上取整，
 *   再汇总各帖需领纸后按每包张数向上取整采购；严禁先合并各帖再计算损耗。
 * - 逐帖返回净用纸 / 开机损耗 / 过程损耗（含取整余量）/ 需领纸，
 *   顶层 materialPrep.totals 给出汇总与整包采购（包数 / 采购张数 / 包余）。
 * - materialPrep 缺省 / null / false 时不启用，不写入任何备料字段，原响应完全不变。
 *
 * 采购报价组合（purchase quote combination）：
 * - 可选提供 purchaseQuotes { demandSheets?, quotes: [{ supplier, sheetsPerPack,
 *   pricePerPackCents, minPacks, maxPacks }] }，需求张数缺省时自动接入印刷备料
 *   汇总后的整包采购张数（未启用备料又未填需求张数则返回明确错误），也允许手工填写。
 * - 在满足需求与各报价最少 / 最多可购包数边界的全部整数包组合中，按
 *   「总价最低 → 超购张数最少 → 供应商数量最少 → 录入顺序（更早录入优先装满）」
 *   确定唯一方案；价格一律以分（整数）精确计算，全程不做浮点比较。
 * - 逐报价返回采购包数 / 张数 / 金额（分）/ 可购余量；无可行组合时返回
 *   feasible: false 与具体缺口张数（rows 按各报价上限给出尽最大可购量）。
 * - purchaseQuotes 缺省 / null / false 时不启用，不写入任何字段，原响应完全不变。
 *
 * 双版本共版印刷清单（dual-version shared-plate printing）：
 * - 可选提供 dualVersion { copiesA, copiesB, changedPages }（A 版份数 / B 版份数 /
 *   B 版相对 A 版改动的真实页码；改动页支持单页与区间写法，自动去重并校验
 *   1 ~ totalPages 范围），沿用当前分帖、补白、装订与翻转后的页位，
 *   逐张逐面判定该面是否含 B 版改动页：无改动的面共用一块印版（印次 = A + B），
 *   含改动页的面拆成 A、B 两块印版各按自身份数印刷，同张纸正背面独立判定。
 * - 顶层 dualVersion 段逐面给出帖 / 张 / 面 / 页码 / 印版归属与各印版印次，
 *   并汇总面数、印版数（含较全部拆版节省的印版数）与总印次。
 * - dualVersion 缺省 / null / false 时不启用，不写入任何字段，原响应完全不变。
 *
 * 库存批次领纸（inventory batch paper drawing）：
 * - 可选提供 stockBatches { batches: [{ lot, availableSheets, allowedSignatures? }] }
 *   （1～12 个库存批次：批号 / 可用张数 / 允许使用的帖号；允许帖号缺省 = 通用批），
 *   各帖需求取自印刷备料的 requiredSheets，因此**必须先启用 materialPrep**，
 *   未启用备料时启用本模块返回明确错误。
 * - 批次可拆给多帖、同帖可跨批次；每批领用不超过可用张数，且只能分给允许的帖。
 *   以最大流求总缺口最小（= 总领用最大）的分配：源 -> 批次（容量 = 可用张数）、
 *   批次 -> 允许的帖（容量无限）、帖 -> 汇（容量 = 需领纸）。
 * - 顶层 stockBatches 段逐帖给出需领纸 / 各批次领用明细 / 缺口，逐批给出
 *   领用合计 / 剩余张数 / 领用去向，并汇总需求 / 库存 / 领用 / 缺口。
 * - stockBatches 缺省 / null / false 时不启用，不写入任何字段，原响应完全不变。
 */

const MAX_TOTAL_PAGES = 10000;
const MAX_SHEETS_PER_SIGNATURE = 100;

function toInteger(value) {
  const n = Number(value);
  return Number.isInteger(n) ? n : NaN;
}

/**
 * 解析非负长度参数（mm）。
 * 缺省（undefined / null）视为 0（不启用）；空串等非法值返回 NaN 由调用方报错。
 */
function toNonNegativeMm(value) {
  if (value === undefined || value === null) return 0;
  if (typeof value === 'string' && value.trim() === '') return NaN;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return NaN;
  return n;
}

/** 保留 4 位小数，避免 0.1×3×2 这一类浮点尾数进入 JSON。 */
function round4(n) {
  const r = Math.round(n * 10000) / 10000;
  return Object.is(r, -0) ? 0 : r;
}

/** 生成一个页位；page 为 null 表示补白页（不占用真实页码）。 */
function makeSlot(page) {
  if (page === null) {
    return { page: null, blank: true };
  }
  return { page, blank: false };
}

/**
 * 章节优先分帖：校验并规范化章节起始页。
 * 返回以 1 开头、严格递增的起始页数组（用户未提供 1 时自动补上，第 1 章从第 1 页开始）。
 * 非法（非数组 / 空数组 / 非整数）、重复、未递增或越界（< 1 或 > totalPages）均抛出明确错误。
 */
function normalizeChapterStarts(raw, totalPages) {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('启用章节优先分帖时，章节起始页 chapterStarts 必须为非空数组');
  }
  const starts = raw.map((v) => {
    // 数字或纯数字字符串可接受；null / 布尔 / 空串 / 其他类型一律视为非法
    const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
    if (!Number.isInteger(n)) {
      throw new Error(`章节起始页必须为整数（收到非法值：${v}）`);
    }
    return n;
  });
  starts.forEach((n) => {
    if (n < 1 || n > totalPages) {
      throw new Error(`章节起始页 ${n} 超出范围（1 ~ ${totalPages}）`);
    }
  });
  for (let i = 1; i < starts.length; i++) {
    if (starts[i] === starts[i - 1]) {
      throw new Error(`章节起始页重复：${starts[i]}`);
    }
    if (starts[i] < starts[i - 1]) {
      throw new Error(`章节起始页必须严格递增（${starts[i - 1]} 之后出现 ${starts[i]}）`);
    }
  }
  return starts[0] === 1 ? starts.slice() : [1, ...starts];
}

/**
 * 章节优先分帖规划（动态规划，保证唯一解）。
 *
 * 约束：
 * - 每帖纸张数为整数（帖内页数为 4 的倍数）且不超过 maxSheets 张；
 * - 帖内补白只允许出现在章节末尾（或全书末尾）；章节中间断开时该帖必须恰好排满整数张。
 *
 * 目标（按优先级逐项比较，保证唯一）：
 *   1. 章节被拆分次数最少（一帖结尾落在章节中间计 1 次拆分）；
 *   2. 补白页总数最少；
 *   3. 帖数最少；
 *   4. 前帖优先装满（并列时让更靠前的帖容纳更多真实页）。
 *
 * @returns {{ segments: Array<{start:number,end:number,sheets:number,blanks:number}>, splits:number, blanks:number }}
 */
function planChapterSignatures(totalPages, maxSheets, starts) {
  // 各章最后一页（末章最后一页即全书最后一页）
  const chapterEnds = new Set();
  for (let i = 0; i < starts.length; i++) {
    chapterEnds.add(i + 1 < starts.length ? starts[i + 1] - 1 : totalPages);
  }
  const maxPages = maxSheets * 4;

  // dp[p]：真实页 p..totalPages 的最优方案 { splits, blanks, sigs, end }
  const dp = new Array(totalPages + 2).fill(null);
  dp[totalPages + 1] = { splits: 0, blanks: 0, sigs: 0, end: 0 };
  for (let p = totalPages; p >= 1; p--) {
    let best = null;
    let bestQ = -1;
    const qMax = Math.min(totalPages, p + maxPages - 1);
    for (let q = p; q <= qMax; q++) {
      const len = q - p + 1;
      const isChapterEnd = chapterEnds.has(q);
      let padding;
      if (isChapterEnd) {
        padding = (4 - (len % 4)) % 4; // 章末 / 书末：补白至整数张
      } else {
        if (len % 4 !== 0) continue; // 章节中间断开不允许补白，必须恰好整数张
        padding = 0;
      }
      const rest = dp[q + 1];
      if (!rest) continue;
      const splits = rest.splits + (isChapterEnd ? 0 : 1);
      const blanks = rest.blanks + padding;
      const sigs = rest.sigs + 1;
      if (
        !best ||
        splits < best.splits ||
        (splits === best.splits && blanks < best.blanks) ||
        (splits === best.splits && blanks === best.blanks && sigs < best.sigs) ||
        // 前帖优先装满：前三项均并列时，让本帖（更靠前的帖）容纳更多真实页
        (splits === best.splits && blanks === best.blanks && sigs === best.sigs && q > bestQ)
      ) {
        best = { splits, blanks, sigs };
        bestQ = q;
      }
    }
    dp[p] = best ? { ...best, end: bestQ } : null;
  }
  // 必然可行（末尾帖总能以补白收齐整数张），防御性检查
  if (!dp[1]) {
    throw new Error('章节优先分帖无可行方案');
  }
  const segments = [];
  let p = 1;
  while (p <= totalPages) {
    const q = dp[p].end;
    const len = q - p + 1;
    const sheets = Math.ceil(len / 4);
    segments.push({ start: p, end: q, sheets, blanks: sheets * 4 - len });
    p = q + 1;
  }
  return { segments, splits: dp[1].splits, blanks: dp[1].blanks };
}

/**
 * 计算整本册子的拼版。
 *
 * @param {object} input
 * @param {number} input.totalPages         成品页数（≥1 的整数）
 * @param {number} input.sheetsPerSignature 每帖张数（≥1 的整数）
 * @param {string} input.binding            装订方式：'left' | 'right'
 * @param {string} input.flip               双面翻转方式：'long' | 'short'
 * @param {number} [input.paperThickness]   纸张厚度（mm，≥0，缺省 0 = 不做爬移补偿）
 * @param {number} [input.maxCompensation]  爬移最大补偿量（mm，≥0，缺省 0 = 不做爬移补偿）
 * @param {number} [input.paperWidth]       纸张宽（mm，>0 启用适配检查；四项尺寸全缺省则不检查）
 * @param {number} [input.paperHeight]      纸张高（mm）
 * @param {number} [input.pageWidth]        成品页宽（mm）
 * @param {number} [input.pageHeight]       成品页高（mm）
 * @param {number} [input.bleedMm]          出血（mm，≥0，缺省 0）
 * @param {number} [input.safetyMm]         安全边距（mm，≥0，缺省 0）
 * @param {boolean} [input.balancedSplit]   是否启用均衡分帖（缺省 false = 固定每帖张数）
 * @param {boolean} [input.chapterSplit]    是否启用章节优先分帖（缺省 false；与均衡分帖互斥）
 * @param {Array<number>} [input.chapterStarts] 章节起始页（严格递增，启用章节优先分帖时必填）
 * @param {Array<object>} [input.observations] 试印核验观察（1～12 条；缺省 / 空数组不启用核验）
 * @param {boolean} [input.productionMarks] 是否启用双面生产标记（缺省 false；启用时必须已提供四项尺寸开启适配检查）
 * @param {number} [input.markSizeMm] 生产标记尺寸（mm，>0 且 ≤100，缺省 5；仅启用生产标记时校验）
 * @param {object|boolean} [input.materialPrep] 印刷备料参数（缺省 / null / false 不启用）：
 *   { copies 成品份数（≥1 整数）, makereadySheets 每帖开机损耗张数（≥0 整数）,
 *     processWasteRate 过程损耗率（0 ≤ r < 1，0.03 = 3%）, sheetsPerPack 每包张数（≥1 整数） }
 * @param {object|boolean} [input.purchaseQuotes] 采购报价组合参数（缺省 / null / false 不启用）：
 *   { demandSheets 手工需求张数（可选，缺省取 materialPrep 整包采购张数）,
 *     quotes: [{ supplier 供应商, sheetsPerPack 每包张数, pricePerPackCents 每包价格（分）,
 *     minPacks 最少可购包数, maxPacks 最多可购包数 }] }
 * @param {object|boolean} [input.dualVersion] 双版本共版印刷参数（缺省 / null / false 不启用）：
 *   { copiesA A 版成品份数（≥1 整数）, copiesB B 版成品份数（≥1 整数）,
 *     changedPages B 版相对 A 版改动的真实页码（单页与区间，去重并校验 1 ~ totalPages，
 *     如 [3, "5-8"] 或 "3, 5-8"） }
 * @param {object|boolean} [input.stockBatches] 库存批次领纸参数（缺省 / null / false 不启用；
 *   启用时必须同时启用 materialPrep，各帖需求取自备料需领纸 requiredSheets）：
 *   { batches: [{ lot 批号（非空、不重复）, availableSheets 可用张数（≥1 整数）,
 *     allowedSignatures 允许使用的帖号数组（可选，缺省 / 空数组 = 通用批，全部帖可用） }] }
 *   共 1～12 个批次；批次可拆给多帖、同帖可跨批次，每批领用不超库存、只分给允许的帖，
 *   按最大流求总缺口最小的分配。
 * @returns {object} 拼版结果（按帖 -> 张 -> 正/背面 -> 左/右页位；启用适配检查时每个页位带 fit；
 *                   启用双面生产标记时每张纸带 productionMarks、顶层带 productionMarks 汇总；
 *                   启用试印核验时顶层带 verification：观察、候选评分与结论；
 *                   启用印刷备料时顶层带 materialPrep：逐帖净用纸 / 损耗 / 需领纸与整包采购汇总；
 *                   启用采购报价组合时顶层带 purchaseQuotes：逐报价采购量 / 金额 / 余量、总价与缺口；
 *                   启用双版本共版时顶层带 dualVersion：逐面印版归属 / 印次与印版、印次汇总；
 *                   启用库存批次领纸时顶层带 stockBatches：逐帖批次领用 / 缺口与逐批剩余张数）
 */
function computeImposition(input) {
  const totalPages = toInteger(input && input.totalPages);
  const sheetsPerSignature = toInteger(input && input.sheetsPerSignature);
  const binding = input && input.binding;
  const flip = input && input.flip;
  const paperThickness = toNonNegativeMm(input && input.paperThickness);
  const maxCompensation = toNonNegativeMm(input && input.maxCompensation);
  const balancedSplit = input && input.balancedSplit === true;
  const chapterSplit = input && input.chapterSplit === true;
  const fit = parseFitInput(input || {});
  const productionMarks = parseProductionMarksInput(input || {}, fit.enabled);
  const materialPrep = parseMaterialPrepInput(input || {});
  const purchaseQuotes = parsePurchaseQuotesInput(input || {});
  const stockBatches = parseStockBatchesInput(input || {});

  if (!Number.isInteger(totalPages) || totalPages < 1 || totalPages > MAX_TOTAL_PAGES) {
    throw new Error(`成品页数必须为 1 ~ ${MAX_TOTAL_PAGES} 的整数`);
  }
  if (!Number.isInteger(sheetsPerSignature) || sheetsPerSignature < 1 || sheetsPerSignature > MAX_SHEETS_PER_SIGNATURE) {
    throw new Error(`每帖张数必须为 1 ~ ${MAX_SHEETS_PER_SIGNATURE} 的整数`);
  }
  if (binding !== 'left' && binding !== 'right') {
    throw new Error("装订方式必须为 'left'（左装订）或 'right'（右装订）");
  }
  if (flip !== 'long' && flip !== 'short') {
    throw new Error("双面翻转方式必须为 'long'（长边翻转）或 'short'（短边翻转）");
  }
  if (Number.isNaN(paperThickness)) {
    throw new Error('纸张厚度必须为 ≥ 0 的数字（单位 mm）');
  }
  if (Number.isNaN(maxCompensation)) {
    throw new Error('最大补偿量必须为 ≥ 0 的数字（单位 mm）');
  }
  if (input && input.balancedSplit !== undefined && typeof input.balancedSplit !== 'boolean') {
    throw new Error('均衡分帖开关必须为布尔值（true / false）');
  }
  if (input && input.chapterSplit !== undefined && typeof input.chapterSplit !== 'boolean') {
    throw new Error('章节优先分帖开关必须为布尔值（true / false）');
  }
  if (chapterSplit && balancedSplit) {
    throw new Error('章节优先分帖与均衡分帖不能同时启用，请只选择一种分帖模式');
  }
  // 双版本共版印刷清单：缺省 / null / false / { enabled: false } 不启用；
  // 启用时校验 A / B 版份数与 B 版改动页码（单页 + 区间，去重并校验 1 ~ totalPages）。
  const dualVersion = parseDualVersionInput(input || {}, totalPages);

  const maxPagesPerSignature = sheetsPerSignature * 4;

  // 固定分帖：每帖固定 sheetsPerSignature 张，末帖整体补白。
  // 均衡分帖：以每帖张数为上限取最少帖数，整本所需纸张在各帖间均匀分配，
  // 各帖实际张数 = base 或 base + 1（多出的 remainder 帖依次靠前分配），差不超过 1。
  // 章节优先分帖：按章节起始页规划连续页段，章节尽量不跨帖，章末允许帖内补白。
  const fixedSignatureCount = Math.ceil(totalPages / maxPagesPerSignature);
  const fixedPaddedPages = fixedSignatureCount * maxPagesPerSignature;

  let signatureCount;
  let sheetCounts;
  let chapterStarts = null; // 规范化后的章节起始页（含自动补上的 1）
  let chapterList = null;   // 各章 { index, pageStart, pageEnd }
  let chapterPlan = null;   // 章节优先分帖规划结果
  if (chapterSplit) {
    chapterStarts = normalizeChapterStarts(input.chapterStarts, totalPages);
    chapterPlan = planChapterSignatures(totalPages, sheetsPerSignature, chapterStarts);
    chapterList = chapterStarts.map((s, i) => ({
      index: i + 1,
      pageStart: s,
      pageEnd: i + 1 < chapterStarts.length ? chapterStarts[i + 1] - 1 : totalPages,
    }));
    signatureCount = chapterPlan.segments.length;
    sheetCounts = chapterPlan.segments.map((seg) => seg.sheets);
  } else {
    // 均衡分帖下最少帖数与固定分帖相同（每帖容量仍为 maxPagesPerSignature）。
    signatureCount = fixedSignatureCount;
    if (balancedSplit) {
      const totalSheetsNeeded = Math.ceil(totalPages / 4);
      const base = Math.floor(totalSheetsNeeded / signatureCount);
      const remainder = totalSheetsNeeded - base * signatureCount;
      sheetCounts = Array.from({ length: signatureCount }, (_, s) => base + (s < remainder ? 1 : 0));
    } else {
      sheetCounts = Array.from({ length: signatureCount }, () => sheetsPerSignature);
    }
  }

  const paddedPages = sheetCounts.reduce((sum, n) => sum + n * 4, 0);

  // 爬移补偿：每帖独立从最外层（i=0）起算，按该帖实际层数（实际张数）给出补偿量。
  // 任一参数为 0 时补偿量恒为 0，拼版页位与原结果完全一致。
  const creepEnabled = paperThickness > 0 && maxCompensation > 0;
  function compensationFor(sheetCount) {
    const arr = [];
    for (let i = 0; i < sheetCount; i++) {
      const creep = creepEnabled ? Math.min(i * paperThickness * 2, maxCompensation) : 0;
      arr.push(round4(creep));
    }
    return arr;
  }
  // 顶层数组按每帖张数上限给出（固定分帖时即各帖补偿量；各帖同序号纸张补偿量相同）。
  const sheetCompensationMm = compensationFor(sheetsPerSignature);
  // 左装订：左页位为正、右页位为负；右装订：符号整体反转。
  const sideSign = binding === 'left' ? 1 : -1;

  const signatures = [];
  let pageCursor = 1;
  for (let s = 0; s < signatureCount; s++) {
    const actualSheetCount = sheetCounts[s];
    const pagesInSignature = actualSheetCount * 4;
    let start;
    let end;
    let sigChapters = null;
    // 本帖页位序列：真实页码或 null（帖内补白）。固定 / 均衡分帖下补白只出现在
    // 页码超出 totalPages 的末尾；章节优先分帖下补白位于章末（帖内），
    // 后续真实页码保持连续并正确进入下一帖。
    const slots = [];
    if (chapterPlan) {
      const seg = chapterPlan.segments[s];
      start = seg.start;
      end = seg.end; // 真实页范围（补白页不占用页码）
      for (let pg = start; pg <= end; pg++) slots.push(pg);
      while (slots.length < pagesInSignature) slots.push(null);
      sigChapters = chapterList.filter((c) => c.pageStart <= end && c.pageEnd >= start);
    } else {
      start = pageCursor;
      end = start + pagesInSignature - 1;
      pageCursor += pagesInSignature;
      for (let j = 0; j < pagesInSignature; j++) {
        const pg = start + j;
        slots.push(pg <= totalPages ? pg : null);
      }
    }
    const sigCompensationMm = compensationFor(actualSheetCount);
    let sigBlankPages = 0;
    const sheets = [];

    for (let i = 0; i < actualSheetCount; i++) {
      const lastSlot = pagesInSignature - 1;
      const lowFront = slots[2 * i];            // 小号页（正面）
      const lowBack = slots[2 * i + 1];         // 小号页之背
      const highFront = slots[lastSlot - 2 * i];     // 大号页（正面）
      const highBack = slots[lastSlot - 2 * i - 1];  // 大号页之背

      // 正面左右页位（左装订：第 1 页在右；右装订镜像）
      const frontLeft = binding === 'left' ? highFront : lowFront;
      const frontRight = binding === 'left' ? lowFront : highFront;

      // 各正面页位「物理正后方」应承接的页（保证折叠后阅读顺序连续）
      const behindLeft = binding === 'left' ? highBack : lowBack;
      const behindRight = binding === 'left' ? lowBack : highBack;

      // 背面坐标变换：
      //   长边翻转 (x,y)->(x,H-y)：左右页位不变，背面内容需旋转 180°；
      //   短边翻转 (x,y)->(W-x,y)：左右页位互换，背面内容方向不变。
      const backLeft = flip === 'long' ? behindLeft : behindRight;
      const backRight = flip === 'long' ? behindRight : behindLeft;

      const front = {
        left: makeSlot(frontLeft),
        right: makeSlot(frontRight),
      };
      const back = {
        left: makeSlot(backLeft),
        right: makeSlot(backRight),
      };
      [front.left, front.right, back.left, back.right].forEach((slot) => {
        if (slot.blank) sigBlankPages += 1;
      });

      // 爬移偏移量：正反面同方向（由装订侧决定），空白页同样保留偏移。
      const creep = sigCompensationMm[i];
      front.left.offsetMm = round4(sideSign * creep);
      front.right.offsetMm = round4(-sideSign * creep);
      back.left.offsetMm = round4(sideSign * creep);
      back.right.offsetMm = round4(-sideSign * creep);

      // 标注每个背面页位物理上位于哪一正面页之后（用于校验折叠后的阅读顺序）
      back.left.backOf = flip === 'long' ? front.left.page : front.right.page;
      back.right.backOf = flip === 'long' ? front.right.page : front.left.page;

      sheets.push({ index: i + 1, front, back });
    }

    const sig = {
      index: s + 1,
      pageStart: start,
      pageEnd: end,
      actualSheetCount,
      actualPageCount: pagesInSignature,
      blankPages: sigBlankPages,
      sheetCompensationMm: sigCompensationMm,
      sheets,
    };
    // 章节优先分帖：标注本帖覆盖的章节（真实页范围即 pageStart/pageEnd，
    // 补白位置 = 本帖末尾 blankPages 个页位，页位对象中 blank: true）
    if (sigChapters) {
      sig.chapters = sigChapters;
    }
    signatures.push(sig);
  }

  // 章节优先分帖汇总：各章跨越的帖数（章节与帖均为连续区间，双指针统计），
  // 被拆分章节 = 跨越 2 帖及以上的章；拆分总次数 = Σ（跨越帖数 − 1）。
  let chaptersSummary = { enabled: false };
  if (chapterPlan) {
    const segments = chapterPlan.segments;
    const splitChapters = [];
    let segIdx = 0;
    chapterList.forEach((c) => {
      while (segIdx < segments.length && segments[segIdx].end < c.pageStart) segIdx += 1;
      let span = 0;
      for (let j = segIdx; j < segments.length && segments[j].start <= c.pageEnd; j++) span += 1;
      if (span > 1) splitChapters.push(c.index);
    });
    chaptersSummary = {
      enabled: true,
      starts: chapterStarts.slice(),
      count: chapterList.length,
      list: chapterList,
      splitCount: chapterPlan.splits,
      splitChapters,
      maxSheetsPerSignature: sheetsPerSignature,
      actualSheetCounts: sheetCounts.slice(),
    };
  }

  const result = {
    meta: {
      app: 'saddle-stitch-imposition',
      version: '1.11.0',
      generatedAt: new Date().toISOString(),
    },
    input: {
      totalPages,
      sheetsPerSignature,
      balancedSplit,
      chapterSplit,
      chapterStarts: chapterStarts ? chapterStarts.slice() : [],
      binding,
      flip,
      paperThickness,
      maxCompensation,
      paperWidth: fit.paperWidth,
      paperHeight: fit.paperHeight,
      pageWidth: fit.pageWidth,
      pageHeight: fit.pageHeight,
      bleedMm: fit.bleedMm,
      safetyMm: fit.safetyMm,
      productionMarks: productionMarks.enabled,
      markSizeMm: productionMarks.enabled ? productionMarks.markSizeMm : 0,
    },
    pagesPerSignature: maxPagesPerSignature,
    signatureCount,
    paddedPages,
    blankPages: paddedPages - totalPages,
    creep: {
      paperThickness,
      maxCompensation,
      enabled: creepEnabled,
      // 按每帖张数上限由外向内第 i 张纸的补偿量（mm）；
      // 固定分帖时与各帖补偿量一致；均衡分帖请以各帖 sheetCompensationMm 为准
      sheetCompensationMm,
    },
    balanced: balancedSplit
      ? {
          enabled: true,
          maxSheetsPerSignature: sheetsPerSignature,
          totalSheets: sheetCounts.reduce((sum, n) => sum + n, 0),
          fixedSignatureCount,
          fixedPaddedPages,
          fixedBlankPages: fixedPaddedPages - totalPages,
          savedBlankPages: fixedPaddedPages - paddedPages,
          actualSheetCounts: sheetCounts.slice(),
        }
      : { enabled: false },
    chapters: chaptersSummary,
    signatures,
  };

  // 纸张规格与出血 / 安全区适配检查：逐页位计算并附加 slot.fit 与顶层 fit 汇总。
  // 未提供纸张 / 成品页尺寸时 fit.enabled = false，页码拼版与爬移结果完全不受影响。
  result.fit = attachFit(result, fit);

  // 双面生产标记：未启用时返回 { enabled: false }，不向 sheet 写入任何字段，
  // 页码拼版 / 适配检查 / 爬移结果与原流程完全一致；启用后逐张附加
  // productionMarks（正面放置、背面按翻转做同一物理位置坐标变换）。
  result.productionMarks = attachProductionMarks(result, productionMarks);

  // 试印核验：observations 缺省 / 为空时返回 { enabled: false }，原流程完全不变；
  // 非法索引、重复观察等抛出明确错误（由调用方转为 400）。
  // 重算四种组合时递归调用自身（不带 observations，不会再次进入核验分支）。
  result.verification = attachVerification(result, input && input.observations, computeImposition);

  // 印刷备料：materialPrep 缺省 / null / false 时不写入任何字段，原响应完全不变；
  // 启用后按各帖实际张数逐帖计算净用纸 / 开机损耗 / 过程损耗 / 需领纸（逐帖 ceil），
  // 再汇总按整包向上采购（禁止先合并各帖再算损耗）。
  const materialPrepResult = attachMaterialPrep(result, materialPrep);
  if (materialPrepResult) {
    result.materialPrep = materialPrepResult;
  }

  // 采购报价组合：purchaseQuotes 缺省 / null / false 时不写入任何字段，原响应完全不变；
  // 需求张数缺省时接入印刷备料的整包采购张数（materialPrep.totals.purchaseSheets），
  // 价格按分整数精确计算，按「总价 → 超购 → 供应商数 → 录入顺序」确定唯一组合；
  // 无可行组合时同样返回 purchaseQuotes 段（feasible: false + 具体缺口）。
  const fallbackSheets = materialPrepResult ? materialPrepResult.totals.purchaseSheets : null;
  const purchaseQuotesResult = attachPurchaseQuotes(result, purchaseQuotes, fallbackSheets);
  if (purchaseQuotesResult) {
    result.purchaseQuotes = purchaseQuotesResult;
  }

  // 库存批次领纸：stockBatches 缺省 / null / false 时不写入任何字段，原响应完全不变；
  // 启用时各帖需求取自备料的需领纸 requiredSheets（未启用备料则抛出明确错误），
  // 以最大流求总缺口最小的分配：批次可拆给多帖、同帖可跨批次，
  // 每批领用不超库存、只分给允许的帖；逐帖给出批次领用与缺口，逐批给出剩余张数。
  const stockBatchesResult = attachStockBatches(result, stockBatches, materialPrepResult);
  if (stockBatchesResult) {
    result.stockBatches = stockBatchesResult;
  }

  // 双版本共版印刷清单：dualVersion 缺省 / null / false 时不写入任何字段，原响应完全不变；
  // 启用后沿用当前分帖 / 补白 / 装订 / 翻转后的页位，逐张逐面判定是否含 B 版改动页——
  // 无改动的面共用一块印版（印次 = A + B），含改动页的面拆成 A、B 两块印版各按自身份数印刷，
  // 同张纸正背面独立判定；逐面给出页码 / 印版归属 / 印次并汇总印版数与总印次。
  const dualVersionResult = attachDualVersion(result, dualVersion);
  if (dualVersionResult) {
    result.dualVersion = dualVersionResult;
  }
  return result;
}

module.exports = { computeImposition };
