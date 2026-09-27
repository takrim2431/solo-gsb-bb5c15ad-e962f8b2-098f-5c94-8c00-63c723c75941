'use strict';

/**
 * 印刷备料（printing material preparation）。
 *
 * 在拼版结果（各帖实际张数）基础上，按成品份数估算用纸采购量。
 *
 * 输入（API 字段 materialPrep，缺省 / null / false 时整个模块不启用）：
 * - copies               成品份数（≥1 的整数，每份成品需用每帖全部纸张一次）；
 * - makereadySheets      每帖开机损耗张数（≥0 的整数，各帖分别加一次）；
 * - processWasteRate     过程损耗率（0 ≤ r < 1，小数表示，如 0.03 = 3%）；
 * - sheetsPerPack        每包张数（≥1 的整数，采购按整包向上取整）。
 *
 * 计算规则（必须逐帖取整后再汇总，禁止先合并各帖再算损耗）：
 * - 净用纸（帖）   = 该帖实际张数 × 成品份数；
 * - 需领纸（帖）   = ceil((净用纸 + 开机损耗) / (1 − 过程损耗率))；
 * - 过程损耗（帖） = 需领纸 − 净用纸 − 开机损耗（≥ 0，含取整余量）；
 * - 汇总           = 各帖净用纸 / 开机损耗 / 需领纸分别求和；
 * - 采购包数       = ceil(需领纸合计 / 每包张数)，采购张数 = 采购包数 × 每包张数，
 *                    包余 = 采购张数 − 需领纸合计。
 *
 * 未启用（materialPrep 缺省 / null / { enabled: false }）时 parse 返回
 * { enabled: false }，attachMaterialPrep 不向结果写入任何字段，原响应完全不变。
 */

const MAX_COPIES = 100000000;       // 成品份数上限 1 亿
const MAX_MAKEREADY = 1000000;      // 每帖开机损耗上限 100 万张
const MAX_SHEETS_PER_PACK = 100000000; // 每包张数上限 1 亿

/**
 * 解析整数参数：接受整数或纯数字字符串，布尔 / null / 空串等返回 NaN。
 * 与拼版核心的 toInteger 保持一致语义。
 */
function toInteger(value) {
  const n = Number(value);
  return Number.isInteger(n) ? n : NaN;
}

/**
 * 解析并校验备料输入。
 * @returns {{enabled: false} | {enabled: true, copies, makereadySheets, processWasteRate, sheetsPerPack}}
 */
function parseMaterialPrepInput(input) {
  const raw = input && input.materialPrep;
  if (raw === undefined || raw === null || raw === false) {
    return { enabled: false };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('印刷备料参数 materialPrep 必须为对象（含 copies / makereadySheets / processWasteRate / sheetsPerPack）');
  }
  if (raw.enabled === false) {
    return { enabled: false };
  }
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
    throw new Error('印刷备料开关 enabled 必须为布尔值（true / false）');
  }

  const copies = toInteger(raw.copies);
  if (!Number.isInteger(copies) || copies < 1 || copies > MAX_COPIES) {
    throw new Error(`成品份数 copies 必须为 1 ~ ${MAX_COPIES.toLocaleString('en-US')} 的整数`);
  }
  const makereadySheets = toInteger(raw.makereadySheets);
  if (!Number.isInteger(makereadySheets) || makereadySheets < 0 || makereadySheets > MAX_MAKEREADY) {
    throw new Error(`每帖开机损耗张数 makereadySheets 必须为 0 ~ ${MAX_MAKEREADY.toLocaleString('en-US')} 的整数`);
  }
  // 过程损耗率：接受数字或纯数字字符串；0 ≤ r < 1（100% 损耗时公式无意义）。
  let rateParsed = raw.processWasteRate;
  if (typeof rateParsed === 'string') {
    rateParsed = rateParsed.trim() === '' ? NaN : Number(rateParsed);
  }
  if (typeof rateParsed !== 'number' || !Number.isFinite(rateParsed) || rateParsed < 0 || rateParsed >= 1) {
    throw new Error('过程损耗率 processWasteRate 必须为 ≥ 0 且 < 1 的小数（如 0.03 表示 3%）');
  }
  const sheetsPerPack = toInteger(raw.sheetsPerPack);
  if (!Number.isInteger(sheetsPerPack) || sheetsPerPack < 1 || sheetsPerPack > MAX_SHEETS_PER_PACK) {
    throw new Error(`每包张数 sheetsPerPack 必须为 1 ~ ${MAX_SHEETS_PER_PACK.toLocaleString('en-US')} 的整数`);
  }

  return {
    enabled: true,
    copies,
    makereadySheets,
    processWasteRate: rateParsed,
    sheetsPerPack,
  };
}

/**
 * 向上取整为整数，并消除 0.30000000000000004 / 3/0.97=3.092783505154639 这一类
 * 浮点尾数造成的多取一张（输入先按 9 位小数归整，业务量级下安全无损耗）。
 */
function ceilInt(value) {
  const rounded = Math.round(value * 1e9) / 1e9;
  return Math.ceil(rounded);
}

/**
 * 依据拼版结果逐帖计算备料并附加汇总。
 * 仅在 parseMaterialPrepInput 返回 enabled 时调用；否则不写入任何字段。
 *
 * @param {object} result 拼版计算结果（读取各帖 actualSheetCount）
 * @param {{enabled:true, copies:number, makereadySheets:number, processWasteRate:number, sheetsPerPack:number}} prep
 * @returns {object} 备料结果（materialPrep 段）
 */
function attachMaterialPrep(result, prep) {
  if (!prep.enabled) return undefined;
  const { copies, makereadySheets, processWasteRate, sheetsPerPack } = prep;
  const yieldRate = 1 - processWasteRate;

  const signatures = result.signatures.map((sig) => {
    const netSheets = sig.actualSheetCount * copies;
    const requiredSheets = ceilInt((netSheets + makereadySheets) / yieldRate);
    const totalWaste = requiredSheets - netSheets; // 全部多领的纸
    const processWaste = requiredSheets - netSheets - makereadySheets; // 过程损耗（含取整余量，≥ 0）
    return {
      signature: sig.index,
      actualSheetCount: sig.actualSheetCount,
      copies,
      netSheets,
      makereadySheets,
      processWaste,
      totalWaste,
      requiredSheets,
    };
  });

  const totals = signatures.reduce(
    (acc, row) => {
      acc.netSheets += row.netSheets;
      acc.makereadySheets += row.makereadySheets;
      acc.processWaste += row.processWaste;
      acc.totalWaste += row.totalWaste;
      acc.requiredSheets += row.requiredSheets;
      return acc;
    },
    { netSheets: 0, makereadySheets: 0, processWaste: 0, totalWaste: 0, requiredSheets: 0 }
  );

  // 汇总后再按整包向上采购（不在逐帖阶段按包取整）。
  const purchasePacks = ceilInt(totals.requiredSheets / sheetsPerPack);
  const purchaseSheets = purchasePacks * sheetsPerPack;

  return {
    enabled: true,
    copies,
    makereadySheets,
    processWasteRate,
    sheetsPerPack,
    formula: 'requiredSheets = ceil((netSheets + makereadySheets) / (1 - processWasteRate))，逐帖取整后汇总',
    signatures,
    totals: {
      signatureCount: signatures.length,
      netSheets: totals.netSheets,
      makereadySheets: totals.makereadySheets,
      processWaste: totals.processWaste,
      totalWaste: totals.totalWaste,
      requiredSheets: totals.requiredSheets,
      purchasePacks,
      sheetsPerPack,
      purchaseSheets,
      packRemainder: purchaseSheets - totals.requiredSheets,
    },
  };
}

module.exports = {
  parseMaterialPrepInput,
  attachMaterialPrep,
};
