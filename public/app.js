'use strict';

/* 骑马钉拼版预演前端：调用 /api/impose 获取拼版结果，用原生 Canvas 逐张绘制纸面。 */

const BINDING_TEXT = { left: '左装订', right: '右装订' };
const FLIP_TEXT = { long: '长边翻转', short: '短边翻转' };
const SIDE_TEXT = { front: '正面', back: '背面' };
const POSITION_TEXT = { left: '左页位', right: '右页位' };
const ORIENTATION_TEXT = { upright: '正向', rotated: '倒置' };
const VERIFY_STATUS_TEXT = { verified: '验证通过', undetermined: '无法判定', failed: '验证未通过' };
const MAX_OBSERVATIONS = 12;

const CANVAS_W = 1240;
const CANVAS_H = 720;

const form = document.getElementById('imposeForm');
const errorBox = document.getElementById('errorBox');
const resultCard = document.getElementById('resultCard');
const summaryBox = document.getElementById('summary');
const sheetSelect = document.getElementById('sheetSelect');
const prevBtn = document.getElementById('prevBtn');
const nextBtn = document.getElementById('nextBtn');
const exportBtn = document.getElementById('exportBtn');
const canvas = document.getElementById('sheetCanvas');
const tableBody = document.querySelector('#sheetTable tbody');
const jsonPreview = document.getElementById('jsonPreview');
const balancedSplitBox = document.getElementById('balancedSplit');
const chapterSplitBox = document.getElementById('chapterSplit');
const chapterStartsInput = document.getElementById('chapterStarts');
const productionMarksBox = document.getElementById('productionMarks');
const markSizeInput = document.getElementById('markSizeMm');
const materialPrepBox = document.getElementById('materialPrepEnabled');
const prepCopiesInput = document.getElementById('prepCopies');
const prepMakereadyInput = document.getElementById('prepMakeready');
const prepWasteRateInput = document.getElementById('prepWasteRate');
const prepSheetsPerPackInput = document.getElementById('prepSheetsPerPack');
const materialPrepCard = document.getElementById('materialPrepCard');
const prepSummary = document.getElementById('prepSummary');
const prepFormula = document.getElementById('prepFormula');
const prepTableBody = document.querySelector('#prepTable tbody');
const prepTableFoot = document.querySelector('#prepTable tfoot');
const purchaseQuotesBox = document.getElementById('purchaseQuotesEnabled');
const quoteManualDemandBox = document.getElementById('quoteManualDemand');
const quoteDemandInput = document.getElementById('quoteDemandSheets');
const quoteEditor = document.getElementById('quoteEditor');
const quoteRowsBox = document.getElementById('quoteRows');
const addQuoteBtn = document.getElementById('addQuoteBtn');
const quoteCountHint = document.getElementById('quoteCountHint');
const purchaseQuoteCard = document.getElementById('purchaseQuoteCard');
const quoteFormula = document.getElementById('quoteFormula');
const quoteGapBox = document.getElementById('quoteGap');
const quoteSummary = document.getElementById('quoteSummary');
const quoteTableBody = document.querySelector('#quoteTable tbody');
const quoteTableFoot = document.querySelector('#quoteTable tfoot');
const dualVersionBox = document.getElementById('dualVersionEnabled');
const dvCopiesAInput = document.getElementById('dvCopiesA');
const dvCopiesBInput = document.getElementById('dvCopiesB');
const dvChangedPagesInput = document.getElementById('dvChangedPages');
const dualVersionCard = document.getElementById('dualVersionCard');
const dvFormula = document.getElementById('dvFormula');
const dvSummary = document.getElementById('dvSummary');
const dvTableBody = document.querySelector('#dvTable tbody');
const dvTableFoot = document.querySelector('#dvTable tfoot');
const stockBatchesBox = document.getElementById('stockBatchesEnabled');
const batchEditor = document.getElementById('batchEditor');
const batchRowsBox = document.getElementById('batchRows');
const addBatchBtn = document.getElementById('addBatchBtn');
const batchCountHint = document.getElementById('batchCountHint');
const stockBatchCard = document.getElementById('stockBatchCard');
const batchFormula = document.getElementById('batchFormula');
const batchGapBox = document.getElementById('batchGap');
const batchSummary = document.getElementById('batchSummary');
const batchSigTableBody = document.querySelector('#batchSigTable tbody');
const batchSigTableFoot = document.querySelector('#batchSigTable tfoot');
const batchLotTableBody = document.querySelector('#batchLotTable tbody');
const batchLotTableFoot = document.querySelector('#batchLotTable tfoot');
const MAX_BATCH_ROWS = 12;
const MAX_QUOTE_ROWS = 8;
const obsForm = document.getElementById('obsForm');
const obsSignature = document.getElementById('obsSignature');
const obsSheet = document.getElementById('obsSheet');
const obsSide = document.getElementById('obsSide');
const obsPosition = document.getElementById('obsPosition');
const obsPage = document.getElementById('obsPage');
const obsOrientation = document.getElementById('obsOrientation');
const fillCurrentBtn = document.getElementById('fillCurrentBtn');
const obsError = document.getElementById('obsError');
const obsCount = document.getElementById('obsCount');
const obsList = document.getElementById('obsList');
const verifyBtn = document.getElementById('verifyBtn');
const clearObsBtn = document.getElementById('clearObsBtn');
const verifyResult = document.getElementById('verifyResult');

/* 章节优先分帖与均衡分帖互斥；勾选章节模式时才允许填写章节起始页 */
chapterSplitBox.addEventListener('change', () => {
  chapterStartsInput.disabled = !chapterSplitBox.checked;
  if (chapterSplitBox.checked) {
    balancedSplitBox.checked = false;
    chapterStartsInput.focus();
  }
});
balancedSplitBox.addEventListener('change', () => {
  if (balancedSplitBox.checked) {
    chapterSplitBox.checked = false;
    chapterStartsInput.disabled = true;
  }
});

/* 双面生产标记尺寸输入仅在勾选启用时可填 */
productionMarksBox.addEventListener('change', () => {
  markSizeInput.disabled = !productionMarksBox.checked;
});
markSizeInput.disabled = true;

/* 印刷备料参数仅在勾选启用时可填 */
materialPrepBox.addEventListener('change', () => {
  [prepCopiesInput, prepMakereadyInput, prepWasteRateInput, prepSheetsPerPackInput].forEach((el) => {
    el.disabled = !materialPrepBox.checked;
  });
  if (materialPrepBox.checked) prepCopiesInput.focus();
});
[prepCopiesInput, prepMakereadyInput, prepWasteRateInput, prepSheetsPerPackInput].forEach((el) => {
  el.disabled = true;
});

/* 双版本共版参数仅在勾选启用时可填 */
dualVersionBox.addEventListener('change', () => {
  [dvCopiesAInput, dvCopiesBInput, dvChangedPagesInput].forEach((el) => {
    el.disabled = !dualVersionBox.checked;
  });
  if (dualVersionBox.checked) dvCopiesAInput.focus();
});
[dvCopiesAInput, dvCopiesBInput, dvChangedPagesInput].forEach((el) => {
  el.disabled = true;
});

/* ------------------------------ 采购报价组合 ------------------------------ */

/** 渲染一条报价录入行（字段顺序即录入顺序，服务端按此序号做第 4 级排序）。 */
function addQuoteRow(initial) {
  const row = document.createElement('div');
  row.className = 'quote-row';
  const values = initial || { supplier: '', sheetsPerPack: '', price: '', minPacks: 0, maxPacks: '' };
  row.innerHTML = `
    <input class="q-supplier" type="text" maxlength="50" placeholder="如 华泰纸行" value="${escapeAttr(values.supplier)}">
    <input class="q-sheets" type="number" min="1" max="100000000" step="1" placeholder="如 500" value="${escapeAttr(values.sheetsPerPack)}">
    <input class="q-price" type="number" min="0" step="0.01" placeholder="如 123.45" value="${escapeAttr(values.price)}">
    <input class="q-min" type="number" min="0" max="100000" step="1" placeholder="0" value="${escapeAttr(values.minPacks)}">
    <input class="q-max" type="number" min="1" max="100000" step="1" placeholder="如 20" value="${escapeAttr(values.maxPacks)}">
    <button type="button" class="ghost small-btn q-del">删除</button>
  `;
  row.querySelector('.q-del').addEventListener('click', () => {
    row.remove();
    updateQuoteCountHint();
  });
  quoteRowsBox.appendChild(row);
  updateQuoteCountHint();
}

/** 属性值转义，避免回填值破坏 HTML。 */
function escapeAttr(v) {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function updateQuoteCountHint() {
  quoteCountHint.textContent = `已录入 ${quoteRowsBox.children.length} / ${MAX_QUOTE_ROWS} 条`;
  addQuoteBtn.disabled = quoteRowsBox.children.length >= MAX_QUOTE_ROWS;
}

addQuoteBtn.addEventListener('click', () => addQuoteRow());

/**
 * 把「元」价格字符串精确换算为整数分：仅允许最多两位小数，全程字符串 / 整数运算，
 * 不经过浮点（禁止 parseFloat('123.45') * 100 这类比较）。非法时返回 null。
 */
function yuanToCents(raw) {
  const s = String(raw).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const dot = s.indexOf('.');
  if (dot < 0) return Number(s) * 100;
  const yuan = s.slice(0, dot);
  const frac = (s.slice(dot + 1) + '00').slice(0, 2);
  return Number(yuan) * 100 + Number(frac);
}

/** 收集并校验报价录入；返回 { quotes, demandSheets } 或抛出带明确信息的 Error。 */
function collectPurchaseQuotes() {
  const rows = [...quoteRowsBox.querySelectorAll('.quote-row')];
  if (rows.length === 0) {
    throw new Error('采购报价组合至少录入 1 条报价');
  }
  if (rows.length > MAX_QUOTE_ROWS) {
    throw new Error(`采购报价最多录入 ${MAX_QUOTE_ROWS} 条`);
  }
  const quotes = [];
  const names = new Set();
  rows.forEach((row, i) => {
    const where = `第 ${i + 1} 条报价`;
    const supplier = row.querySelector('.q-supplier').value.trim();
    if (!supplier) throw new Error(`${where}：供应商名称不能为空`);
    if (names.has(supplier)) throw new Error(`${where}：供应商名称与前面重复（「${supplier}」）`);
    names.add(supplier);
    const sheetsPerPack = Number(row.querySelector('.q-sheets').value);
    if (!Number.isInteger(sheetsPerPack) || sheetsPerPack < 1) {
      throw new Error(`${where}（${supplier}）：每包张数必须为 ≥ 1 的整数`);
    }
    const priceCents = yuanToCents(row.querySelector('.q-price').value);
    if (priceCents === null) {
      throw new Error(`${where}（${supplier}）：每包价格必须为 ≥ 0 的数字，最多两位小数（元）`);
    }
    const minPacks = Number(row.querySelector('.q-min').value);
    if (!Number.isInteger(minPacks) || minPacks < 0) {
      throw new Error(`${where}（${supplier}）：最少可购包数必须为 ≥ 0 的整数`);
    }
    const maxRaw = row.querySelector('.q-max').value.trim();
    if (maxRaw === '') {
      throw new Error(`${where}（${supplier}）：请填写最多可购包数`);
    }
    const maxPacks = Number(maxRaw);
    if (!Number.isInteger(maxPacks) || maxPacks < 1) {
      throw new Error(`${where}（${supplier}）：最多可购包数必须为 ≥ 1 的整数`);
    }
    if (maxPacks < minPacks) {
      throw new Error(`${where}（${supplier}）：最多可购包数不能少于最少可购包数`);
    }
    quotes.push({ supplier, sheetsPerPack, pricePerPackCents: priceCents, minPacks, maxPacks });
  });

  let demandSheets;
  if (quoteManualDemandBox.checked) {
    demandSheets = Number(quoteDemandInput.value);
    if (!Number.isInteger(demandSheets) || demandSheets < 1) {
      throw new Error('手工需求张数必须为 ≥ 1 的整数');
    }
  }
  return { quotes, demandSheets };
}

/** 报价组合区块启用状态与可编辑性同步。 */
function syncPurchaseQuotesUI() {
  const on = purchaseQuotesBox.checked;
  quoteEditor.hidden = !on;
  quoteManualDemandBox.disabled = !on;
  // 需求张数：启用后，勾选「手工填写」才可编辑；否则取备料整包采购张数（由服务端回退）。
  quoteDemandInput.disabled = !on || !quoteManualDemandBox.checked;
  if (on && quoteRowsBox.children.length === 0) {
    addQuoteRow();
    addQuoteRow();
  }
}
purchaseQuotesBox.addEventListener('change', syncPurchaseQuotesUI);
quoteManualDemandBox.addEventListener('change', () => {
  quoteDemandInput.disabled = !quoteManualDemandBox.checked;
  if (quoteManualDemandBox.checked) quoteDemandInput.focus();
});
syncPurchaseQuotesUI();

/* ------------------------------ 库存批次领纸 ------------------------------ */

/** 渲染一条批次录入行（字段顺序即录入顺序，服务端按此序号给出批次编号）。 */
function addBatchRow(initial) {
  const row = document.createElement('div');
  row.className = 'batch-row';
  const values = initial || { lot: '', availableSheets: '', allowedSignatures: '' };
  row.innerHTML = `
    <input class="b-lot" type="text" maxlength="50" placeholder="如 A01" value="${escapeAttr(values.lot)}">
    <input class="b-sheets" type="number" min="1" max="100000000" step="1" placeholder="如 5000" value="${escapeAttr(values.availableSheets)}">
    <input class="b-sigs" type="text" placeholder="留空 = 通用批，如 1, 3" value="${escapeAttr(values.allowedSignatures)}">
    <button type="button" class="ghost small-btn b-del">删除</button>
  `;
  row.querySelector('.b-del').addEventListener('click', () => {
    row.remove();
    updateBatchCountHint();
  });
  batchRowsBox.appendChild(row);
  updateBatchCountHint();
}

function updateBatchCountHint() {
  batchCountHint.textContent = `已录入 ${batchRowsBox.children.length} / ${MAX_BATCH_ROWS} 个批次`;
  addBatchBtn.disabled = batchRowsBox.children.length >= MAX_BATCH_ROWS;
}

addBatchBtn.addEventListener('click', () => addBatchRow());

/** 批次区块启用状态与可编辑性同步；启用时默认给两行便于录入。 */
function syncStockBatchesUI() {
  const on = stockBatchesBox.checked;
  batchEditor.hidden = !on;
  if (on && batchRowsBox.children.length === 0) {
    addBatchRow();
    addBatchRow();
  }
}
stockBatchesBox.addEventListener('change', syncStockBatchesUI);
syncStockBatchesUI();

/**
 * 收集并校验批次录入；返回 { batches } 或抛出带明确信息的 Error。
 * 允许帖号留空（通用批）时不上送 allowedSignatures；无法解析的帖号 token
 * 原样上送，由服务端给出明确错误（与章节起始页同一处理原则）。
 */
function collectStockBatches() {
  const rows = [...batchRowsBox.querySelectorAll('.batch-row')];
  if (rows.length === 0) {
    throw new Error('库存批次领纸至少录入 1 个批次');
  }
  if (rows.length > MAX_BATCH_ROWS) {
    throw new Error(`库存批次最多录入 ${MAX_BATCH_ROWS} 个`);
  }
  const batches = [];
  const lots = new Set();
  rows.forEach((row, i) => {
    const where = `第 ${i + 1} 个批次`;
    const lot = row.querySelector('.b-lot').value.trim();
    if (!lot) throw new Error(`${where}：批号不能为空`);
    if (lots.has(lot)) throw new Error(`${where}：批号与前面重复（「${lot}」）`);
    lots.add(lot);
    const availableSheets = Number(row.querySelector('.b-sheets').value);
    if (!Number.isInteger(availableSheets) || availableSheets < 1) {
      throw new Error(`${where}（批号「${lot}」）：可用张数必须为 ≥ 1 的整数`);
    }
    const sigRaw = row.querySelector('.b-sigs').value.trim();
    if (sigRaw === '') {
      batches.push({ lot, availableSheets }); // 通用批：不上送 allowedSignatures
    } else {
      const allowedSignatures = sigRaw
        .split(/[,，、;；\s]+/)
        .filter(Boolean)
        .map((token) => {
          const n = Number(token);
          return Number.isInteger(n) ? n : token;
        });
      batches.push({ lot, availableSheets, allowedSignatures });
    }
  });
  return { batches };
}

/** 解析章节起始页输入：支持逗号 / 顿号 / 分号 / 空白分隔；无法解析的 token 原样上送，由服务端给出明确错误。 */
function parseChapterStarts(raw) {
  return raw
    .split(/[,，、;；\s]+/)
    .filter(Boolean)
    .map((token) => {
      const n = Number(token);
      return Number.isInteger(n) ? n : token;
    });
}

/**
 * 解析 B 版改动页码输入：支持单页与区间（如 "3, 5-8, 12"）。
 * 区间 token（连字符两侧可有空格，如 "5 - 8"）整体原样上送；其余按逗号 / 空白拆分，
 * 数字转整数、无法解析的 token 原样上送，完整校验（范围 / 去重 / 区间方向）由服务端执行。
 */
function parseChangedPagesInput(raw) {
  return raw
    .split(/[,，、;；]+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .flatMap((token) => {
      if (/^\d+\s*[-–—~]\s*\d+$/.test(token)) return [token];
      return token.split(/\s+/).filter(Boolean).map((t) => {
        const n = Number(t);
        return Number.isInteger(n) ? n : t;
      });
    });
}

const state = {
  result: null,
  flat: [], // 展平的 (帖, 张) 索引，便于逐张浏览
  idx: 0,
  observations: [], // 试印核验观察（规范化后的本地副本，index 为 1 起始序号）
  highlight: null,  // 核验定位高亮 { si, shi, side, position }
  lastPayload: null, // 最近一次成功生成拼版的请求体（核验时原样复用并附加观察）
};

/* ------------------------------ 数据获取与渲染 ------------------------------ */

/** 将本地观察转换为服务端请求格式（page 为 null 表示看到空白页）。 */
function observationPayload() {
  return state.observations.map((o) => ({
    signature: o.signature,
    sheet: o.sheet,
    side: o.side,
    position: o.position,
    page: o.blank ? null : o.page,
    orientation: o.orientation,
  }));
}

/** 根据当前结果重建展平索引（核验刷新后结构不变，索引保持稳定）。 */
function rebuildFlat() {
  state.flat = [];
  state.result.signatures.forEach((sig, si) => {
    sig.sheets.forEach((sheet, shi) => state.flat.push({ si, shi }));
  });
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorBox.hidden = true;

  try {
    const chapterSplit = chapterSplitBox.checked;
    const payload = {
      totalPages: Number(document.getElementById('totalPages').value),
      sheetsPerSignature: Number(document.getElementById('sheetsPerSignature').value),
      balancedSplit: balancedSplitBox.checked,
      chapterSplit,
      chapterStarts: chapterSplit ? parseChapterStarts(chapterStartsInput.value) : [],
      binding: document.getElementById('binding').value,
      flip: document.getElementById('flip').value,
      paperThickness: Number(document.getElementById('paperThickness').value),
      maxCompensation: Number(document.getElementById('maxCompensation').value),
      paperWidth: Number(document.getElementById('paperWidth').value),
      paperHeight: Number(document.getElementById('paperHeight').value),
      pageWidth: Number(document.getElementById('pageWidth').value),
      pageHeight: Number(document.getElementById('pageHeight').value),
      bleedMm: Number(document.getElementById('bleedMm').value),
      safetyMm: Number(document.getElementById('safetyMm').value),
      productionMarks: productionMarksBox.checked,
      // 仅勾选启用时上送尺寸；留空 / 未勾选时由服务端取缺省（不参与未启用流程）
      markSizeMm: productionMarksBox.checked && markSizeInput.value.trim() !== ''
        ? Number(markSizeInput.value)
        : undefined,
      // 印刷备料：仅勾选时上送；过程损耗率百分数换算为小数（3% -> 0.03）
      materialPrep: materialPrepBox.checked
        ? {
            copies: Number(prepCopiesInput.value),
            makereadySheets: Number(prepMakereadyInput.value),
            processWasteRate: Number(prepWasteRateInput.value) / 100,
            sheetsPerPack: Number(prepSheetsPerPackInput.value),
          }
        : undefined,
      // 采购报价组合：仅勾选时上送；价格在收集阶段已精确换算为整数分。
      // demandSheets 未手工填写时不上送，由服务端回退到备料整包采购张数。
      purchaseQuotes: (() => {
        if (!purchaseQuotesBox.checked) return undefined;
        const { quotes, demandSheets } = collectPurchaseQuotes();
        return { demandSheets, quotes };
      })(),
      // 双版本共版印刷：仅勾选时上送；改动页码在前端做轻量分词，完整校验由服务端执行
      dualVersion: dualVersionBox.checked
        ? {
            copiesA: Number(dvCopiesAInput.value),
            copiesB: Number(dvCopiesBInput.value),
            changedPages: parseChangedPagesInput(dvChangedPagesInput.value),
          }
        : undefined,
      // 库存批次领纸：仅勾选时上送；需先启用印刷备料（未启用时服务端返回明确错误）。
      // 允许帖号留空 = 通用批（不上送 allowedSignatures）。
      stockBatches: (() => {
        if (!stockBatchesBox.checked) return undefined;
        return collectStockBatches();
      })(),
    };
    // 已录入观察时随生成一并核验；无观察时请求体与原流程完全一致
    const requestBody = state.observations.length ? { ...payload, observations: observationPayload() } : payload;

    const resp = await fetch('/api/impose', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });
    const data = await resp.json();
    if (!resp.ok) {
      throw new Error(data.error || `服务器返回 ${resp.status}`);
    }
    state.result = data;
    state.lastPayload = payload; // 仅生成成功后更新，保证「开始核验」比对的就是当前展示的结果
    rebuildFlat();
    state.idx = 0;
    state.highlight = null;
    resultCard.hidden = false;
    renderAll();
  } catch (err) {
    errorBox.textContent = `生成失败：${err.message}`;
    errorBox.hidden = false;
  }
});

prevBtn.addEventListener('click', () => {
  if (state.idx > 0) {
    state.idx -= 1;
    state.highlight = null;
    renderSheetNav();
    draw();
  }
});

nextBtn.addEventListener('click', () => {
  if (state.idx < state.flat.length - 1) {
    state.idx += 1;
    state.highlight = null;
    renderSheetNav();
    draw();
  }
});

sheetSelect.addEventListener('change', () => {
  state.idx = Number(sheetSelect.value);
  state.highlight = null;
  renderSheetNav();
  draw();
});

exportBtn.addEventListener('click', () => {
  if (!state.result) return;
  const blob = new Blob([JSON.stringify(state.result, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  a.href = url;
  a.download = `imposition-${ts}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});

function renderAll() {
  renderSummary();
  renderSheetNav();
  renderTable();
  renderMaterialPrep();
  renderPurchaseQuotes();
  renderDualVersion();
  renderStockBatches();
  jsonPreview.textContent = JSON.stringify(state.result, null, 2);
  renderObsPanel();
  draw();
}

/** 本帖覆盖章节的可读文本，如「第 2 章」/「第 2–3 章」（非章节模式返回空串）。 */
function sigChaptersText(sig) {
  if (!sig.chapters || sig.chapters.length === 0) return '';
  const first = sig.chapters[0].index;
  const last = sig.chapters[sig.chapters.length - 1].index;
  return first === last ? `第 ${first} 章` : `第 ${first}–${last} 章`;
}

function renderSummary() {
  const r = state.result;
  const balanced = r.balanced && r.balanced.enabled;
  const chapterMode = r.chapters && r.chapters.enabled;
  const modeText = chapterMode
    ? `章节优先分帖：${r.chapters.count} 章 · 上限 ${r.input.sheetsPerSignature} 张/帖`
    : balanced
      ? `均衡分帖：上限 ${r.input.sheetsPerSignature} 张/帖`
      : `固定分帖：每帖 ${r.input.sheetsPerSignature} 张（${r.pagesPerSignature} 页）`;
  const chips = [
    { text: `成品 ${r.input.totalPages} 页` },
    { text: modeText, cls: balanced ? 'balanced' : chapterMode ? 'chapter' : '' },
    { text: `共 ${r.signatureCount} 帖` },
    { text: `补白后 ${r.paddedPages} 页` },
    { text: r.blankPages > 0 ? `自动补空白页 ${r.blankPages} 页` : '无需补白', cls: r.blankPages > 0 ? 'warn' : '' },
    { text: BINDING_TEXT[r.input.binding] },
    { text: FLIP_TEXT[r.input.flip] },
  ];
  if (chapterMode) {
    const counts = r.chapters.actualSheetCounts;
    chips.push({
      text: `章节起始页：[${r.chapters.starts.join(', ')}]`,
      cls: 'chapter',
    });
    chips.push({
      text: r.chapters.splitCount > 0
        ? `章节被拆分 ${r.chapters.splitCount} 次（第 ${r.chapters.splitChapters.join('、')} 章）`
        : '章节均未被拆分',
      cls: r.chapters.splitCount > 0 ? 'warn' : 'chapter',
    });
    chips.push({
      text: `各帖实际张数 [${counts.join(', ')}]`,
      cls: 'chapter',
    });
  }
  if (balanced) {
    const counts = r.balanced.actualSheetCounts;
    const min = Math.min(...counts);
    const max = Math.max(...counts);
    chips.push({
      text: min === max
        ? `各帖实际均为 ${min} 张`
        : `各帖实际 ${min}～${max} 张（[${counts.join(', ')}]）`,
      cls: 'balanced',
    });
    if (r.balanced.savedBlankPages > 0) {
      chips.push({
        text: `较固定分帖（${r.balanced.fixedPaddedPages} 页）节省空白页 ${r.balanced.savedBlankPages} 页`,
        cls: 'saved',
      });
    } else {
      chips.push({ text: '本页数下与固定分帖用纸相同', cls: 'balanced' });
    }
  }
  chips.push(
    r.creep.enabled
      ? { text: `爬移补偿：纸厚 ${formatMm(r.input.paperThickness)} mm · 上限 ${formatMm(r.input.maxCompensation)} mm`, cls: 'creep' }
      : { text: '爬移补偿：未启用', cls: 'creep-off' },
  );
  if (r.fit && r.fit.enabled) {
    chips.push(
      r.fit.ok
        ? { text: `适配检查：${r.fit.totalSlots} 个页位全部通过`, cls: 'fit-ok' }
        : { text: `适配检查：${r.fit.failCount} / ${r.fit.totalSlots} 页位不适配`, cls: 'fit-fail' }
    );
  }
  if (r.productionMarks && r.productionMarks.enabled) {
    chips.push(
      r.productionMarks.omittedCount === 0
        ? { text: `生产标记：已放置 ${r.productionMarks.placedCount} 个（尺寸 ${formatMm(r.productionMarks.markSizeMm)} mm）`, cls: 'fit-ok' }
        : { text: `生产标记：放置 ${r.productionMarks.placedCount} 个 · 省略 ${r.productionMarks.omittedCount} 个`, cls: 'fit-fail' }
    );
  }
  if (r.materialPrep && r.materialPrep.enabled) {
    const t = r.materialPrep.totals;
    chips.push({
      text: `印刷备料：${formatSheets(t.requiredSheets)} 张 → 整包采购 ${formatSheets(t.purchasePacks)} 包（${formatSheets(t.purchaseSheets)} 张）`,
      cls: 'prep-buy',
    });
  }
  if (r.purchaseQuotes && r.purchaseQuotes.enabled) {
    const pq = r.purchaseQuotes;
    if (pq.feasible) {
      chips.push({
        text: `采购报价组合：${formatYuan(pq.totals.totalCostCents)} 购入 ${formatSheets(pq.totals.totalSheets)} 张（${pq.totals.supplierCount} 家供应商，超购 ${formatSheets(pq.totals.overPurchaseSheets)} 张）`,
        cls: 'quote-ok',
      });
    } else {
      chips.push({
        text: `采购报价组合无可行方案：还差 ${formatSheets(pq.gapSheets)} 张`,
        cls: 'quote-fail',
      });
    }
  }
  if (r.dualVersion && r.dualVersion.enabled) {
    const t = r.dualVersion.totals;
    chips.push({
      text: `双版本共版：印版 ${t.plateCount} 块（共版 ${t.sharedSideCount} 面 · 拆版 ${t.splitSideCount} 面）· 总印次 ${formatSheets(t.impressions)}`,
      cls: 'quote-ok',
    });
  }
  if (r.stockBatches && r.stockBatches.enabled) {
    const t = r.stockBatches.totals;
    chips.push(
      t.fullyCovered
        ? { text: `库存批次领纸：${t.batchCount} 批领用 ${formatSheets(t.drawnSheets)} 张，各帖均无缺口`, cls: 'prep-ok' }
        : { text: `库存批次领纸：领用 ${formatSheets(t.drawnSheets)} 张 · 总缺口 ${formatSheets(t.gapSheets)} 张`, cls: 'quote-fail' }
    );
  }
  summaryBox.innerHTML = '';
  chips.forEach(({ text, cls }) => {
    const span = document.createElement('span');
    span.className = 'chip' + (cls ? ` ${cls}` : '');
    span.textContent = text;
    summaryBox.appendChild(span);
  });
}

/** mm 数值格式化为两位小数（保留正负号）。 */
function formatMm(n) {
  return (Math.round(n * 100) / 100).toFixed(2);
}

/** 一张纸四个页位（正面左右 + 背面左右）。 */
function sheetSlots(sheet) {
  return [sheet.front.left, sheet.front.right, sheet.back.left, sheet.back.right];
}

/** 该张纸是否存在适配检查不合格的页位。 */
function sheetHasFitFail(sheet) {
  return sheetSlots(sheet).some((s) => s.fit && !s.fit.ok);
}

/** 该张纸被省略的生产标记数（正 / 背面合计）；未启用时为 0。 */
function sheetOmittedMarkCount(sheet) {
  const pm = sheet.productionMarks;
  if (!pm) return 0;
  return pm.front.omitted.length + pm.back.omitted.length;
}

function renderSheetNav() {
  const r = state.result;
  const fitOn = r.fit && r.fit.enabled;
  sheetSelect.innerHTML = '';
  state.flat.forEach((pos, i) => {
    const sig = r.signatures[pos.si];
    const sheet = sig.sheets[pos.shi];
    const opt = document.createElement('option');
    opt.value = String(i);
    const chapterNote = sigChaptersText(sig) ? ` · ${sigChaptersText(sig)}` : '';
    const omitNote = sheetOmittedMarkCount(sheet) > 0 ? ` · 省略标记 ${sheetOmittedMarkCount(sheet)}` : '';
    opt.textContent = `第 ${sig.index} 帖（${sig.actualSheetCount} 张${chapterNote}） · 第 ${sheet.index} 张${fitOn && sheetHasFitFail(sheet) ? ' ⚠' : ''}${omitNote}`;
    sheetSelect.appendChild(opt);
  });
  sheetSelect.value = String(state.idx);
  prevBtn.disabled = state.idx === 0;
  nextBtn.disabled = state.idx === state.flat.length - 1;
}

function slotText(slot) {
  return slot.blank ? '空白' : `第 ${slot.page} 页`;
}

function renderTable() {
  const r = state.result;
  const creepOn = r.creep.enabled;
  const fitOn = r.fit && r.fit.enabled;
  const flipNote = r.input.flip === 'long'
    ? '背面：左右页位不变，内容旋转 180°'
    : '背面：左右页位互换';
  const creepNote = creepOn
    ? `爬移：左页位 ${r.input.binding === 'left' ? '+' : '−'} / 右页位 ${r.input.binding === 'left' ? '−' : '+'}，上限 ${formatMm(r.input.maxCompensation)} mm`
    : '爬移补偿未启用，offsetMm 均为 0';
  tableBody.innerHTML = '';
  r.signatures.forEach((sig) => {
    sig.sheets.forEach((sheet) => {
      [
        { name: '正面', side: sheet.front, note: '正面' },
        { name: '背面', side: sheet.back, note: flipNote },
      ].forEach(({ name, side, note }) => {
        const tr = document.createElement('tr');
        // 帖号单元格：各帖实际张数不同于上限时追加标注；章节优先分帖下追加覆盖章节
        const tdSig = document.createElement('td');
        if (name === '正面') {
          const parts = [];
          if (sig.actualSheetCount !== r.input.sheetsPerSignature) parts.push(`${sig.actualSheetCount} 张`);
          if (sigChaptersText(sig)) parts.push(sigChaptersText(sig));
          tdSig.textContent = `${sig.index}${parts.length ? `（${parts.join(' · ')}）` : ''}`;
        } else {
          tdSig.textContent = '';
        }
        tr.appendChild(tdSig);
        [String(sheet.index), name].forEach((t) => {
          const td = document.createElement('td');
          td.textContent = t;
          tr.appendChild(td);
        });
        [side.left, side.right].forEach((slot) => {
          const td = document.createElement('td');
          const main = document.createElement('div');
          main.textContent = slotText(slot);
          if (slot.blank) main.className = 'slot-blank';
          td.appendChild(main);
          const off = document.createElement('div');
          off.className = 'slot-offset' + (creepOn && slot.offsetMm !== 0 ? ' nonzero' : '');
          off.textContent = `偏移 ${slot.offsetMm > 0 ? '+' : ''}${formatMm(slot.offsetMm)} mm`;
          td.appendChild(off);
          if (fitOn && slot.fit) {
            const fitDiv = document.createElement('div');
            if (slot.fit.ok) {
              fitDiv.className = 'slot-fit ok';
              fitDiv.textContent = '✓ 适配';
            } else {
              const vs = slot.fit.violations;
              fitDiv.className = 'slot-fit fail';
              fitDiv.textContent = `⚠ ${vs[0].message}${vs.length > 1 ? `（共 ${vs.length} 项）` : ''}`;
              fitDiv.title = vs.map((v) => v.message).join('\n');
              td.classList.add('fit-fail');
            }
            td.appendChild(fitDiv);
          }
          if (slot.blank) td.classList.add('blank');
          tr.appendChild(td);
        });
        const tdNote = document.createElement('td');
        const pm = sheet.productionMarks;
        if (pm) {
          const sidePm = name === '正面' ? pm.front : pm.back;
          const noteMain = document.createElement('div');
          noteMain.textContent = `${note}；${creepNote}`;
          tdNote.appendChild(noteMain);
          const markDiv = document.createElement('div');
          if (sidePm.omitted.length === 0) {
            markDiv.className = 'slot-fit ok';
            markDiv.textContent = `✓ 生产标记 ${sidePm.placed.length} 个全部落位`;
          } else {
            markDiv.className = 'slot-fit fail';
            const names = sidePm.omitted.map((o) => o.label).join('、');
            markDiv.textContent = `⚠ 省略 ${sidePm.omitted.length} 个标记：${names}（悬停查看原因）`;
            markDiv.title = sidePm.omitted
              .map((o) => `【${o.label}】${o.reasonSummary}`)
              .join('\n');
          }
          tdNote.appendChild(markDiv);
        } else {
          tdNote.textContent = `${note}；${creepNote}`;
        }
        tr.appendChild(tdNote);
        tableBody.appendChild(tr);
      });
    });
  });
}

/* ------------------------------ 印刷备料 ------------------------------ */

/** 过程损耗率（小数）格式化为百分数：0.03 -> 3%，0.035 -> 3.5%。 */
function formatPercent(rate) {
  const pct = Math.round(rate * 100000) / 1000; // 保留最多 3 位小数
  return `${String(pct)}%`;
}

/** 整数千分位格式化。 */
function formatSheets(n) {
  return n.toLocaleString('zh-CN');
}

/** 渲染印刷备料：公式说明、整包采购汇总 chips 与逐帖明细表；未启用时隐藏整个区块。 */
function renderMaterialPrep() {
  const mp = state.result.materialPrep;
  if (!mp || !mp.enabled) {
    materialPrepCard.hidden = true;
    return;
  }
  materialPrepCard.hidden = false;
  prepFormula.textContent =
    `逐帖计算：净用纸 = 每帖实际张数 × 成品份数；需领纸 = ceil((净用纸 + 开机损耗 ${mp.makereadySheets} 张) / (1 − ${formatPercent(mp.processWasteRate)}))，` +
    '各帖分别向上取整后再汇总（不先合并各帖）；汇总后按每包 ' + formatSheets(mp.sheetsPerPack) + ' 张向上取整采购。';

  const t = mp.totals;
  const chips = [
    { text: `成品份数 ${formatSheets(mp.copies)} 份`, cls: 'prep' },
    { text: `共 ${t.signatureCount} 帖`, cls: 'prep' },
    { text: `净用纸合计 ${formatSheets(t.netSheets)} 张`, cls: 'prep' },
    { text: `开机损耗合计 ${formatSheets(t.makereadySheets)} 张`, cls: 'prep-warn' },
    { text: `过程损耗合计 ${formatSheets(t.processWaste)} 张（${formatPercent(mp.processWasteRate)}，含逐帖取整余量）`, cls: 'prep-warn' },
    { text: `需领纸合计 ${formatSheets(t.requiredSheets)} 张`, cls: 'prep-total' },
    { text: `整包采购：${formatSheets(t.purchasePacks)} 包 × ${formatSheets(t.sheetsPerPack)} 张 = ${formatSheets(t.purchaseSheets)} 张`, cls: 'prep-buy' },
    { text: `包余 ${formatSheets(t.packRemainder)} 张`, cls: t.packRemainder > 0 ? 'prep-warn' : 'prep-ok' },
  ];
  prepSummary.innerHTML = '';
  chips.forEach(({ text, cls }) => {
    const span = document.createElement('span');
    span.className = 'chip' + (cls ? ` ${cls}` : '');
    span.textContent = text;
    prepSummary.appendChild(span);
  });

  prepTableBody.innerHTML = '';
  mp.signatures.forEach((row) => {
    const tr = document.createElement('tr');
    [
      `第 ${row.signature} 帖`,
      formatSheets(row.actualSheetCount),
      formatSheets(row.copies),
      formatSheets(row.netSheets),
      formatSheets(row.makereadySheets),
      formatSheets(row.processWaste),
      formatSheets(row.totalWaste),
      formatSheets(row.requiredSheets),
    ].forEach((text) => {
      const td = document.createElement('td');
      td.textContent = text;
      tr.appendChild(td);
    });
    prepTableBody.appendChild(tr);
  });

  prepTableFoot.innerHTML = '';
  const footTr = document.createElement('tr');
  [
    '合计（逐帖取整后汇总）',
    '—',
    '—',
    formatSheets(t.netSheets),
    formatSheets(t.makereadySheets),
    formatSheets(t.processWaste),
    formatSheets(t.totalWaste),
    formatSheets(t.requiredSheets),
  ].forEach((text) => {
    const td = document.createElement('td');
    td.textContent = text;
    footTr.appendChild(td);
  });
  prepTableFoot.appendChild(footTr);
}

/* ------------------------------ 采购报价组合 ------------------------------ */

/** 整数分 → 元文本（1234 -> "12.34"；10 -> "0.10"；0 -> "0.00"），不经过浮点。 */
function formatYuan(cents) {
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const yuan = Math.floor(abs / 100);
  const fen = String(abs % 100).padStart(2, '0');
  return `${neg ? '−' : ''}${yuan.toLocaleString('zh-CN')}.${fen}`;
}

/** 渲染采购报价组合：规则说明、需求 / 缺口 chips、逐报价采购量 / 金额 / 余量明细表。 */
function renderPurchaseQuotes() {
  const pq = state.result.purchaseQuotes;
  if (!pq || !pq.enabled) {
    purchaseQuoteCard.hidden = true;
    return;
  }
  purchaseQuoteCard.hidden = false;
  const sourceText = pq.demandSource === 'materialPrep' ? '印刷备料整包采购张数' : '手工填写';
  quoteFormula.textContent =
    `需求 ${formatSheets(pq.demandSheets)} 张（来源：${sourceText}）；在满足各报价最少 / 最多可购包数的整数包组合中，` +
    '按「总价最低 → 超购张数最少 → 供应商数量最少 → 录入顺序（更早录入优先装满）」确定唯一方案，价格按分（整数）精确计算。';

  quoteGapBox.hidden = pq.feasible;
  if (!pq.feasible) {
    quoteGapBox.textContent = `✗ 无可行组合：${pq.reason}。下表按各报价上限列出尽最大可购量（余量均为 0）。`;
  }

  const t = pq.totals;
  const chips = [
    { text: `需求 ${formatSheets(pq.demandSheets)} 张（${sourceText}）`, cls: 'prep' },
    { text: `采购包数合计 ${formatSheets(t.totalPacks)} 包`, cls: 'prep' },
    { text: `采购张数合计 ${formatSheets(t.totalSheets)} 张`, cls: 'prep-total' },
  ];
  if (pq.feasible) {
    chips.push(
      { text: `总价 ${formatYuan(t.totalCostCents)} 元`, cls: 'prep-buy' },
      {
        text: t.overPurchaseSheets > 0 ? `超购 ${formatSheets(t.overPurchaseSheets)} 张` : '恰好满足，无超购',
        cls: t.overPurchaseSheets > 0 ? 'prep-warn' : 'prep-ok',
      },
      { text: `供应商 ${t.supplierCount} 家：${t.suppliers.join('、')}`, cls: 'prep' },
    );
  } else {
    chips.push(
      { text: `尽最大可购 ${formatSheets(t.totalSheets)} 张`, cls: 'quote-fail' },
      { text: `缺口 ${formatSheets(pq.gapSheets)} 张`, cls: 'quote-fail' },
      { text: `该组合合计金额 ${formatYuan(t.totalCostCents)} 元`, cls: 'prep' },
    );
  }
  quoteSummary.innerHTML = '';
  chips.forEach(({ text, cls }) => {
    const span = document.createElement('span');
    span.className = 'chip' + (cls ? ` ${cls}` : '');
    span.textContent = text;
    quoteSummary.appendChild(span);
  });

  quoteTableBody.innerHTML = '';
  pq.rows.forEach((row) => {
    const tr = document.createElement('tr');
    if (row.packs === 0 && pq.feasible) tr.className = 'quote-row-zero';
    [
      row.index,
      row.supplier,
      formatSheets(row.sheetsPerPack),
      `${formatYuan(row.pricePerPackCents)} 元/包`,
      `${formatSheets(row.minPacks)} ~ ${formatSheets(row.maxPacks)}`,
      formatSheets(row.packs),
      formatSheets(row.sheets),
      `${formatYuan(row.amountCents)} 元`,
      `${formatSheets(row.remainingPacks)} 包 / ${formatSheets(row.remainingSheets)} 张`,
    ].forEach((text) => {
      const td = document.createElement('td');
      td.textContent = text;
      tr.appendChild(td);
    });
    quoteTableBody.appendChild(tr);
  });

  quoteTableFoot.innerHTML = '';
  const footTr = document.createElement('tr');
  [
    '合计',
    '—',
    '—',
    '—',
    '—',
    formatSheets(t.totalPacks),
    formatSheets(t.totalSheets),
    `${formatYuan(t.totalCostCents)} 元`,
    pq.feasible
      ? (t.overPurchaseSheets > 0 ? `超购 ${formatSheets(t.overPurchaseSheets)} 张` : '无超购')
      : `缺口 ${formatSheets(pq.gapSheets)} 张`,
  ].forEach((text) => {
    const td = document.createElement('td');
    td.textContent = text;
    footTr.appendChild(td);
  });
  quoteTableFoot.appendChild(footTr);
}

/* ------------------------------ 双版本共版印刷 ------------------------------ */

/** 渲染双版本共版清单：判定规则、印版 / 印次汇总 chips 与逐面明细表；未启用时隐藏整个区块。 */
function renderDualVersion() {
  const dv = state.result.dualVersion;
  if (!dv || !dv.enabled) {
    dualVersionCard.hidden = true;
    return;
  }
  dualVersionCard.hidden = false;
  dvFormula.textContent =
    `判定规则：${dv.rule}。B 版相对 A 版改动页（去重后 ${dv.changedPageCount} 个）：${dv.changedPages.join('、')}。`;

  const t = dv.totals;
  const chips = [
    { text: `A 版 ${formatSheets(dv.copiesA)} 份`, cls: 'prep' },
    { text: `B 版 ${formatSheets(dv.copiesB)} 份`, cls: 'prep' },
    { text: `改动页 ${dv.changedPageCount} 个`, cls: 'prep-warn' },
    { text: `共版 ${t.sharedSideCount} 面 · 拆版 ${t.splitSideCount} 面（共 ${t.sideCount} 面）`, cls: 'prep' },
    { text: `印版合计 ${t.plateCount} 块（共用 ${t.sharedPlateCount} + 拆分 ${t.splitPlateCount}）`, cls: 'prep-total' },
    { text: `较全部拆版节省印版 ${t.savedPlateCount} 块`, cls: 'prep-buy' },
    { text: `总印次 ${formatSheets(t.impressions)}`, cls: 'prep' },
  ];
  dvSummary.innerHTML = '';
  chips.forEach(({ text, cls }) => {
    const span = document.createElement('span');
    span.className = 'chip' + (cls ? ` ${cls}` : '');
    span.textContent = text;
    dvSummary.appendChild(span);
  });

  const pageText = (p) => (p === null ? '空白' : `第 ${p} 页`);
  dvTableBody.innerHTML = '';
  dv.rows.forEach((row) => {
    const tr = document.createElement('tr');
    if (!row.shared) tr.className = 'dv-split';
    const plateText = row.shared
      ? '共用 1 块（A+B）'
      : '拆 2 块：A 版 + B 版';
    const impressionsText = row.shared
      ? `${formatSheets(row.plates[0].impressions)}（A ${formatSheets(dv.copiesA)} + B ${formatSheets(dv.copiesB)}）`
      : `A 版 ${formatSheets(row.plates[0].impressions)} · B 版 ${formatSheets(row.plates[1].impressions)}`;
    [
      `第 ${row.signature} 帖`,
      `第 ${row.sheet} 张`,
      SIDE_TEXT[row.side],
      pageText(row.leftPage),
      pageText(row.rightPage),
      row.changedPages.length ? row.changedPages.map((p) => `第 ${p} 页`).join('、') : '—',
      plateText,
      impressionsText,
    ].forEach((text) => {
      const td = document.createElement('td');
      td.textContent = text;
      tr.appendChild(td);
    });
    dvTableBody.appendChild(tr);
  });

  dvTableFoot.innerHTML = '';
  const footTr = document.createElement('tr');
  [
    '合计',
    '—',
    `${t.sideCount} 面`,
    '—',
    '—',
    `改动 ${t.splitSideCount} 面`,
    `印版 ${t.plateCount} 块`,
    `总印次 ${formatSheets(t.impressions)}`,
  ].forEach((text) => {
    const td = document.createElement('td');
    td.textContent = text;
    footTr.appendChild(td);
  });
  dvTableFoot.appendChild(footTr);
}

/* ------------------------------ 库存批次领纸 ------------------------------ */

/** 渲染库存批次领纸：规则说明、汇总 chips、逐帖领用 / 缺口表与逐批剩余张数表；未启用时隐藏整个区块。 */
function renderStockBatches() {
  const sb = state.result.stockBatches;
  if (!sb || !sb.enabled) {
    stockBatchCard.hidden = true;
    return;
  }
  stockBatchCard.hidden = false;
  batchFormula.textContent =
    '各帖需求取自印刷备料的需领纸 requiredSheets；批次可拆给多帖、同帖可跨批次，' +
    '每批领用不超过可用张数且只能分给允许的帖（未填允许帖号 = 通用批）。' +
    '按最大流求总缺口最小（= 总领用最大）的分配，同一输入必得同一方案。';

  const t = sb.totals;
  batchGapBox.hidden = t.fullyCovered;
  if (!t.fullyCovered) {
    batchGapBox.textContent = t.availableSheets < t.requiredSheets
      ? `⚠ 库存不足：总需求 ${formatSheets(t.requiredSheets)} 张，全部批次合计仅 ${formatSheets(t.availableSheets)} 张可用，按总缺口最小分配后仍缺 ${formatSheets(t.gapSheets)} 张（逐帖缺口见下表）。`
      : `⚠ 受批次允许帖号限制：总需求 ${formatSheets(t.requiredSheets)} 张，库存合计 ${formatSheets(t.availableSheets)} 张，但部分库存只能用于指定帖而无法补足缺口帖，按总缺口最小分配后仍缺 ${formatSheets(t.gapSheets)} 张（逐帖缺口见下表）。`;
  }

  const chips = [
    { text: `批次 ${t.batchCount} 个 · 共 ${t.signatureCount} 帖`, cls: 'prep' },
    { text: `需求合计 ${formatSheets(t.requiredSheets)} 张（备料需领纸）`, cls: 'prep' },
    { text: `库存合计 ${formatSheets(t.availableSheets)} 张`, cls: 'prep' },
    { text: `领用合计 ${formatSheets(t.drawnSheets)} 张`, cls: 'prep-total' },
    { text: `剩余合计 ${formatSheets(t.remainingSheets)} 张`, cls: t.remainingSheets > 0 ? 'prep-warn' : 'prep' },
    t.fullyCovered
      ? { text: '全部帖均无缺口', cls: 'prep-ok' }
      : { text: `总缺口 ${formatSheets(t.gapSheets)} 张`, cls: 'quote-fail' },
  ];
  batchSummary.innerHTML = '';
  chips.forEach(({ text, cls }) => {
    const span = document.createElement('span');
    span.className = 'chip' + (cls ? ` ${cls}` : '');
    span.textContent = text;
    batchSummary.appendChild(span);
  });

  // 逐帖：需领纸 / 批次领用明细 / 领用合计 / 缺口（缺口 > 0 的行标出）
  batchSigTableBody.innerHTML = '';
  sb.signatures.forEach((row) => {
    const tr = document.createElement('tr');
    if (row.gapSheets > 0) tr.className = 'batch-gap-row';
    const allocText = row.allocations.length
      ? row.allocations.map((a) => `${a.lot} × ${formatSheets(a.sheets)}`).join(' ＋ ')
      : '—（无可用批次）';
    [
      `第 ${row.signature} 帖`,
      formatSheets(row.requiredSheets),
      allocText,
      formatSheets(row.drawnSheets),
      row.gapSheets > 0 ? `缺 ${formatSheets(row.gapSheets)}` : '0',
    ].forEach((text) => {
      const td = document.createElement('td');
      td.textContent = text;
      tr.appendChild(td);
    });
    batchSigTableBody.appendChild(tr);
  });

  batchSigTableFoot.innerHTML = '';
  const sigFootTr = document.createElement('tr');
  [
    '合计',
    formatSheets(t.requiredSheets),
    '—',
    formatSheets(t.drawnSheets),
    t.gapSheets > 0 ? `缺 ${formatSheets(t.gapSheets)}` : '0',
  ].forEach((text) => {
    const td = document.createElement('td');
    td.textContent = text;
    sigFootTr.appendChild(td);
  });
  batchSigTableFoot.appendChild(sigFootTr);

  // 逐批：可用张数 / 允许帖号 / 领用合计 / 剩余张数 / 领用去向
  batchLotTableBody.innerHTML = '';
  sb.batches.forEach((row) => {
    const tr = document.createElement('tr');
    if (row.drawnSheets === 0) tr.className = 'quote-row-zero';
    const allowedText = row.universal ? '全部帖（通用）' : row.allowedSignatures.map((s) => `第 ${s} 帖`).join('、');
    const allocText = row.allocations.length
      ? row.allocations.map((a) => `第 ${a.signature} 帖 × ${formatSheets(a.sheets)}`).join(' ＋ ')
      : '—（未被领用）';
    [
      row.index,
      row.lot,
      formatSheets(row.availableSheets),
      allowedText,
      formatSheets(row.drawnSheets),
      formatSheets(row.remainingSheets),
      allocText,
    ].forEach((text) => {
      const td = document.createElement('td');
      td.textContent = text;
      tr.appendChild(td);
    });
    batchLotTableBody.appendChild(tr);
  });

  batchLotTableFoot.innerHTML = '';
  const lotFootTr = document.createElement('tr');
  [
    '合计',
    '—',
    formatSheets(t.availableSheets),
    '—',
    formatSheets(t.drawnSheets),
    formatSheets(t.remainingSheets),
    '—',
  ].forEach((text) => {
    const td = document.createElement('td');
    td.textContent = text;
    lotFootTr.appendChild(td);
  });
  batchLotTableFoot.appendChild(lotFootTr);
}

/* ------------------------------ 试印核验 ------------------------------ */

function showObsError(message) {
  obsError.textContent = message;
  obsError.hidden = false;
}

/** 填充观察录入表单的帖 / 张下拉（尽量保留当前选择）。 */
function populateObsForm() {
  const r = state.result;
  if (!r) return;
  const prevSig = obsSignature.value;
  obsSignature.innerHTML = '';
  r.signatures.forEach((sig) => {
    const opt = document.createElement('option');
    opt.value = String(sig.index);
    opt.textContent = `第 ${sig.index} 帖（${sig.actualSheetCount} 张）`;
    obsSignature.appendChild(opt);
  });
  if ([...obsSignature.options].some((o) => o.value === prevSig)) {
    obsSignature.value = prevSig;
  }
  refreshObsSheets();
}

function refreshObsSheets() {
  const r = state.result;
  if (!r || !obsSignature.value) return;
  const prevSheet = obsSheet.value;
  const sig = r.signatures[Number(obsSignature.value) - 1];
  obsSheet.innerHTML = '';
  for (let i = 1; i <= sig.actualSheetCount; i++) {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = `第 ${i} 张`;
    obsSheet.appendChild(opt);
  }
  if ([...obsSheet.options].some((o) => o.value === prevSheet)) {
    obsSheet.value = prevSheet;
  }
}

obsSignature.addEventListener('change', refreshObsSheets);

fillCurrentBtn.addEventListener('click', () => {
  if (!state.result) return;
  const pos = state.flat[state.idx];
  const sig = state.result.signatures[pos.si];
  obsSignature.value = String(sig.index);
  refreshObsSheets();
  obsSheet.value = String(sig.sheets[pos.shi].index);
});

obsForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!state.result) return;
  obsError.hidden = true;
  if (state.observations.length >= MAX_OBSERVATIONS) {
    showObsError(`最多录入 ${MAX_OBSERVATIONS} 条观察`);
    return;
  }
  const signature = Number(obsSignature.value);
  const sheet = Number(obsSheet.value);
  const side = obsSide.value;
  const position = obsPosition.value;
  const dup = state.observations.find(
    (o) => o.signature === signature && o.sheet === sheet && o.side === side && o.position === position
  );
  if (dup) {
    showObsError(`该页位已录入为第 ${dup.index} 条观察，同一页位不可重复观察`);
    return;
  }
  const raw = obsPage.value.trim();
  let page = null;
  if (raw !== '') {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > state.result.input.totalPages) {
      showObsError(`页码必须为 1 ~ ${state.result.input.totalPages} 的整数；看到空白页请留空`);
      return;
    }
    page = n;
  }
  state.observations.push({
    index: state.observations.length + 1,
    signature,
    sheet,
    side,
    position,
    page,
    blank: page === null,
    orientation: obsOrientation.value,
  });
  obsPage.value = '';
  afterObservationsChanged();
});

clearObsBtn.addEventListener('click', () => {
  state.observations = [];
  obsError.hidden = true;
  afterObservationsChanged();
});

verifyBtn.addEventListener('click', () => {
  obsError.hidden = true;
  runVerification();
});

/** 观察列表变更后：重渲染列表；若此前已核验过，则自动重核以保证结论与观察一致。 */
function afterObservationsChanged() {
  renderObservations();
  if (state.result && state.result.verification && state.result.verification.enabled) {
    runVerification();
  }
}

/** 以最近一次生成的输入 + 当前观察重新请求 /api/impose 并刷新全部展示。 */
async function runVerification() {
  if (!state.lastPayload) return;
  const payload = { ...state.lastPayload };
  if (state.observations.length) {
    payload.observations = observationPayload();
  }
  try {
    const resp = await fetch('/api/impose', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await resp.json();
    if (!resp.ok) {
      throw new Error(data.error || `服务器返回 ${resp.status}`);
    }
    state.result = data;
    rebuildFlat();
    state.idx = Math.min(state.idx, state.flat.length - 1);
    // 重核后旧的定位高亮可能已指向被删除的观察，统一清除，避免与最新结果不同步
    state.highlight = null;
    renderAll();
  } catch (err) {
    showObsError(`核验失败：${err.message}`);
  }
}

/** 跳到观察 / 差异 / 建议对应的纸张并高亮页位。 */
function jumpToSlot(target, kind = 'locate') {
  const flatIdx = state.flat.findIndex((p) => p.si === target.signature - 1 && p.shi === target.sheet - 1);
  if (flatIdx < 0) return;
  state.idx = flatIdx;
  state.highlight = { si: target.signature - 1, shi: target.sheet - 1, side: target.side, position: target.position, kind };
  renderSheetNav();
  draw();
  canvas.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function renderObsPanel() {
  populateObsForm();
  renderObservations();
  renderVerification();
}

function renderObservations() {
  obsCount.textContent = String(state.observations.length);
  obsList.innerHTML = '';
  state.observations.forEach((obs, i) => {
    obs.index = i + 1; // 删除后重编号，与服务端规范化序号一致
    const li = document.createElement('li');
    const text = document.createElement('span');
    text.className = 'obs-text';
    text.textContent = `#${obs.index} 第 ${obs.signature} 帖 · 第 ${obs.sheet} 张 · ${SIDE_TEXT[obs.side]} · ${POSITION_TEXT[obs.position]} — ${obs.blank ? '空白' : `第 ${obs.page} 页`} · ${ORIENTATION_TEXT[obs.orientation]}`;
    text.title = '点击在预览中定位该页位';
    text.addEventListener('click', () => jumpToSlot(obs));
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'ghost small-btn';
    del.textContent = '删除';
    del.addEventListener('click', () => {
      state.observations.splice(i, 1);
      afterObservationsChanged();
    });
    li.appendChild(text);
    li.appendChild(del);
    obsList.appendChild(li);
  });
  verifyBtn.disabled = state.observations.length === 0;
  clearObsBtn.disabled = state.observations.length === 0;
}

/** 「看到 / 期望」内容的可读文本（空白页不带朝向）。 */
function seenText(slot) {
  return slot.blank ? '空白' : `第 ${slot.page} 页 · ${ORIENTATION_TEXT[slot.orientation]}`;
}

function diffRowText(d) {
  const where = `#${d.observation} 第 ${d.signature} 帖 · 第 ${d.sheet} 张 · ${SIDE_TEXT[d.side]} · ${POSITION_TEXT[d.position]}`;
  if (d.match) {
    return `${where}：看到「${seenText(d.observed)}」，与期望一致 ✓`;
  }
  const parts = [];
  if (!d.pageMatch) {
    parts.push(`页码 / 空白不符：期望「${d.expected.blank ? '空白' : `第 ${d.expected.page} 页`}」`);
  }
  if (d.orientationMatch === false) {
    parts.push(`朝向不符：期望「${ORIENTATION_TEXT[d.expected.orientation]}」`);
  }
  return `${where}：看到「${seenText(d.observed)}」✗ ${parts.join('；')}`;
}

function makeBadge(text, cls) {
  const span = document.createElement('span');
  span.className = `badge ${cls}`;
  span.textContent = text;
  return span;
}

/** 无法判定时展示服务端计算的「下一处观察建议」，点击跳到对应纸张并高亮页位。 */
function renderSuggestion(suggestion) {
  const box = document.createElement('div');
  if (!suggestion) {
    box.className = 'verify-suggestion none';
    const head = document.createElement('div');
    head.className = 'verify-suggestion-head';
    head.innerHTML = '<strong>下一处观察建议</strong>';
    box.appendChild(head);
    const noLine = document.createElement('div');
    noLine.className = 'verify-suggestion-none';
    noLine.textContent = '无建议：剩余未观察页位在各并列组合下的预期完全一致，继续观察也无法区分，建议核对实物或调整拼版输入后重新生成。';
    box.appendChild(noLine);
    verifyResult.appendChild(box);
    return;
  }

  box.className = 'verify-suggestion';
  const head = document.createElement('div');
  head.className = 'verify-suggestion-head';
  const title = document.createElement('strong');
  title.textContent = '下一处观察建议';
  head.appendChild(title);
  const jumpBtn = document.createElement('button');
  jumpBtn.type = 'button';
  jumpBtn.className = 'small-btn suggest-btn';
  jumpBtn.textContent = '查看建议';
  jumpBtn.addEventListener('click', () => jumpToSlot(suggestion, 'suggestion'));
  head.appendChild(jumpBtn);
  box.appendChild(head);

  const loc = document.createElement('div');
  loc.className = 'verify-suggestion-loc';
  loc.textContent = `第 ${suggestion.signature} 帖 · 第 ${suggestion.sheet} 张 · ${SIDE_TEXT[suggestion.side]} · ${POSITION_TEXT[suggestion.position]}`;
  box.appendChild(loc);
  const metric = document.createElement('div');
  metric.className = 'verify-suggestion-metric';
  metric.textContent = `观察该页位可形成 ${suggestion.groupCount} 种结果；最坏情况下剩余 ${suggestion.worstRemainingCandidates} 种候选组合。`;
  box.appendChild(metric);

  // 按结果分组列出各并列组合的预期值（页码 / 空白 + 内容朝向）
  const list = document.createElement('ul');
  list.className = 'suggest-list';
  suggestion.outcomeGroups.forEach((group) => {
    const li = document.createElement('li');
    const value = document.createElement('span');
    value.className = 'suggest-value' + (group.blank ? ' blank' : '');
    value.textContent = group.blank ? '空白' : `第 ${group.page} 页 · ${ORIENTATION_TEXT[group.orientation]}`;
    li.appendChild(value);
    const combos = document.createElement('span');
    combos.className = 'suggest-combos';
    combos.textContent = group.combinations
      .map((cm) => `${BINDING_TEXT[cm.binding]} · ${FLIP_TEXT[cm.flip]}`)
      .join('；');
    li.appendChild(combos);
    list.appendChild(li);
  });
  box.appendChild(list);
  verifyResult.appendChild(box);
}

function renderVerification() {
  const v = state.result && state.result.verification;
  verifyResult.innerHTML = '';
  if (!v || !v.enabled) {
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = state.observations.length
      ? '尚未核验：点击「开始核验」比对四种设置。'
      : '录入观察后点击「开始核验」；不录入观察时流程与之前完全一致。';
    verifyResult.appendChild(hint);
    return;
  }

  const c = v.conclusion;
  const banner = document.createElement('div');
  const bannerCls = c.status === 'verified' ? (c.matchesCurrent ? 'ok' : 'tie') : c.status === 'undetermined' ? 'tie' : 'fail';
  banner.className = `verify-banner ${bannerCls}`;
  const title = document.createElement('strong');
  title.textContent = c.status === 'verified' && !c.matchesCurrent
    ? `${VERIFY_STATUS_TEXT[c.status]}（实物对应其他设置）`
    : VERIFY_STATUS_TEXT[c.status];
  banner.appendChild(title);
  const msg = document.createElement('span');
  msg.textContent = c.message;
  banner.appendChild(msg);
  if (c.tied.length) {
    const tiedLine = document.createElement('div');
    tiedLine.className = 'verify-tied';
    tiedLine.textContent = `并列组合：${c.tied.map((t) => `${BINDING_TEXT[t.binding]} · ${FLIP_TEXT[t.flip]}`).join('；')}`;
    banner.appendChild(tiedLine);
  }
  verifyResult.appendChild(banner);

  // 无法判定时服务端给出的「下一处观察建议」；无可用页位时明确提示无建议
  if (c.status === 'undetermined') {
    renderSuggestion(v.nextSuggestion);
  }

  v.candidates.forEach((cand) => {
    const card = document.createElement('div');
    card.className = 'verify-candidate';
    const head = document.createElement('div');
    head.className = 'verify-candidate-head';
    const name = document.createElement('span');
    name.className = 'verify-candidate-title';
    name.textContent = `#${cand.rank} ${BINDING_TEXT[cand.binding]} · ${FLIP_TEXT[cand.flip]}`;
    head.appendChild(name);
    if (cand.isCurrent) head.appendChild(makeBadge('当前设置', 'current'));
    if (c.status === 'verified' && c.combination.binding === cand.binding && c.combination.flip === cand.flip) {
      head.appendChild(makeBadge('✓ 唯一零差异', 'ok'));
    } else if (cand.tied) {
      head.appendChild(makeBadge('⚠ 并列最优', 'warn'));
    }
    const score = document.createElement('span');
    score.className = 'verify-score';
    score.textContent = `不符观察 ${cand.wrongObservations} 条 · 不符字段 ${cand.wrongFields} 个`;
    head.appendChild(score);
    card.appendChild(head);

    const det = document.createElement('details');
    if (cand.rank === 1) det.open = true;
    const sum = document.createElement('summary');
    sum.textContent = '逐条比对';
    det.appendChild(sum);
    cand.details.forEach((d) => {
      const row = document.createElement('div');
      row.className = `diff-row${d.match ? '' : ' mismatch'}`;
      row.textContent = diffRowText(d);
      if (!d.match) {
        row.title = '点击跳到对应纸张并高亮页位';
        row.addEventListener('click', () => jumpToSlot(d));
      }
      det.appendChild(row);
    });
    card.appendChild(det);
    verifyResult.appendChild(card);
  });
}

/* ------------------------------ Canvas 绘制 ------------------------------ */

function setupCanvas(height) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = CANVAS_W * dpr;
  canvas.height = height * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function draw() {
  const r = state.result;
  if (!r) return;
  const pos = state.flat[state.idx];
  const sig = r.signatures[pos.si];
  const sheet = sig.sheets[pos.shi];
  const { flip, binding } = r.input;
  const fitOn = r.fit && r.fit.enabled;
  const marksOn = r.productionMarks && r.productionMarks.enabled;

  // 当前张全部超限原因（用于底部说明，并据此加高画布）
  const violations = [];
  if (fitOn) {
    [
      ['正面', sheet.front],
      ['背面', sheet.back],
    ].forEach(([sideName, side]) => {
      [
        ['左', side.left],
        ['右', side.right],
      ].forEach(([posName, slot]) => {
        if (slot.fit && !slot.fit.ok) {
          slot.fit.violations.forEach((v) => violations.push(`${sideName}${posName}页位（${slotText(slot)}）：${v.message}`));
        }
      });
    });
  }
  // 当前张被省略的生产标记（逐张提示，用于底部说明）
  const markOmissions = [];
  if (marksOn && sheet.productionMarks) {
    [
      ['正面', sheet.productionMarks.front],
      ['背面', sheet.productionMarks.back],
    ].forEach(([sideName, sidePm]) => {
      sidePm.omitted.forEach((o) => {
        markOmissions.push(`${sideName}「${o.label}」：${o.reasonSummary}`);
      });
    });
  }
  const noteLines = buildNotes(r.input, r.creep, fitOn ? r.fit : null, violations, marksOn ? r.productionMarks : null, markOmissions);
  const canvasH = Math.max(CANVAS_H, 540 + noteLines.length * 25 + 16);
  const ctx = setupCanvas(canvasH);

  // 背景
  ctx.fillStyle = '#f4f6fa';
  ctx.fillRect(0, 0, CANVAS_W, canvasH);

  // 标题区
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#16233b';
  ctx.font = 'bold 22px system-ui, sans-serif';
  const chapterMode = r.chapters && r.chapters.enabled;
  const sigRangeText = chapterMode
    ? `真实页码 ${sig.pageStart}–${sig.pageEnd} · ${sigChaptersText(sig)}${sig.blankPages > 0 ? ` · 本帖补白 ${sig.blankPages} 页` : ''}`
    : `页码 ${sig.pageStart}–${sig.pageEnd}`;
  ctx.fillText(
    `第 ${sig.index} / ${r.signatureCount} 帖 · 第 ${sheet.index} / ${sig.sheets.length} 张（本帖实际 ${sig.actualSheetCount} 张 · ${sigRangeText}）`,
    40, 44
  );
  ctx.font = '14px system-ui, sans-serif';
  ctx.fillStyle = '#5a6b85';
  const sigCreepArr = sig.sheetCompensationMm || r.creep.sheetCompensationMm;
  const creepSubtitle = r.creep.enabled
    ? `　爬移补偿：纸厚 ${formatMm(r.input.paperThickness)} mm · 上限 ${formatMm(r.input.maxCompensation)} mm · 本张补偿 ${formatMm(sigCreepArr[sheet.index - 1])} mm`
    : '　爬移补偿未启用';
  const modeSubtitle = chapterMode
    ? `　章节优先分帖（共 ${r.chapters.count} 章 · 拆分 ${r.chapters.splitCount} 次 · 起始页 [${r.chapters.starts.join(', ')}]）`
    : r.balanced && r.balanced.enabled
      ? `　均衡分帖（各帖实际张数差 ≤ 1）${r.balanced.savedBlankPages > 0 ? ` · 较固定分帖节省 ${r.balanced.savedBlankPages} 个空白页` : ''}`
      : '　固定分帖';
  ctx.fillText(
    `装订：${BINDING_TEXT[binding]}　双面翻转：${FLIP_TEXT[flip]}　成品 ${r.input.totalPages} 页 · 补白 ${r.blankPages} 页 · 共 ${r.paddedPages} 页${creepSubtitle}${modeSubtitle}`,
    40, 70
  );
  if (fitOn) {
    ctx.font = 'bold 14px system-ui, sans-serif';
    if (r.fit.ok) {
      ctx.fillStyle = '#1e7e34';
      ctx.fillText(
        `✓ 适配检查通过：纸张 ${formatMm(r.fit.paperWidth)}×${formatMm(r.fit.paperHeight)} mm，全部 ${r.fit.totalSlots} 个页位适配`,
        40, 94
      );
    } else {
      ctx.fillStyle = '#c92a2a';
      ctx.fillText(
        `✗ 适配检查未通过：${r.fit.failCount} / ${r.fit.totalSlots} 个页位超限（本张 ${violations.length} 项），详见下方说明与清单`,
        40, 94
      );
    }
  }
  if (marksOn) {
    const pm = sheet.productionMarks;
    const omitted = pm ? pm.front.omitted.length + pm.back.omitted.length : 0;
    const placed = pm ? pm.front.placed.length + pm.back.placed.length : 0;
    ctx.font = 'bold 14px system-ui, sans-serif';
    if (omitted === 0) {
      ctx.fillStyle = '#0f766e';
      ctx.fillText(
        `✓ 双面生产标记：本张正背面共放置 ${placed} 个（裁切线 / 折线标 / 套准十字，尺寸 ${formatMm(r.productionMarks.markSizeMm)} mm），正背套准`,
        40, fitOn ? 116 : 94
      );
    } else {
      ctx.fillStyle = '#b35900';
      ctx.fillText(
        `⚠ 双面生产标记：本张放置 ${placed} 个、省略 ${omitted} 个，逐标记原因见下方说明与清单`,
        40, fitOn ? 116 : 94
      );
    }
  }

  const sheetW = 460;
  const sheetH = 340;
  const top = 136;
  const frontRect = { x: 70, y: top, w: sheetW, h: sheetH };
  const backRect = { x: 710, y: top, w: sheetW, h: sheetH };

  // 面板标题
  ctx.textAlign = 'center';
  ctx.fillStyle = '#16233b';
  ctx.font = 'bold 16px system-ui, sans-serif';
  ctx.fillText('正面（第 1 面）', frontRect.x + sheetW / 2, top - 16);
  ctx.fillText(
    flip === 'long' ? '背面（第 2 面 · 内容旋转 180°）' : '背面（第 2 面）',
    backRect.x + sheetW / 2, top - 16
  );

  // 爬移像素比例：示意性放大，保证最大补偿量在页位内至少留 18px 边距且不超过页位宽 35%。
  // 均衡分帖下各帖按实际层数独立计算，故取所有帖补偿量的最大值。
  const perSigCreep = r.signatures.map((sg) => sg.sheetCompensationMm || r.creep.sheetCompensationMm);
  const allCreepVals = perSigCreep.flat();
  const maxCreepMm = r.creep.enabled && allCreepVals.length ? Math.max(...allCreepVals) : 0;
  const creepPxPerMm = maxCreepMm > 0
    ? Math.max(1, Math.min(30, (sheetW / 2 * 0.35 - 18) / maxCreepMm))
    : 0;
  const drawOpts = {
    creepPxPerMm,
    creepEnabled: r.creep.enabled,
    fitEnabled: fitOn,
    marksEnabled: marksOn,
    paperWidth: marksOn ? r.productionMarks.paperWidth : null,
    paperHeight: marksOn ? r.productionMarks.paperHeight : null,
    marks: marksOn && sheet.productionMarks ? sheet.productionMarks : null,
  };

  drawSheet(ctx, frontRect, sheet.front, { rotated: false, isBack: false, sideMarks: drawOpts.marks && drawOpts.marks.front, ...drawOpts });
  drawSheet(ctx, backRect, sheet.back, { rotated: flip === 'long', isBack: true, sideMarks: drawOpts.marks && drawOpts.marks.back, ...drawOpts });
  drawFlipDiagram(ctx, { x: 530, y: top, w: 180, h: sheetH }, flip);

  // 核验定位高亮：点击差异 / 观察 / 建议后，在当前张对应页位画紫色描边
  if (state.highlight && state.highlight.si === pos.si && state.highlight.shi === pos.shi) {
    const hRect = state.highlight.side === 'front' ? frontRect : backRect;
    drawSlotHighlight(ctx, hRect, state.highlight.position, state.highlight.kind === 'suggestion');
  }

  drawNotes(ctx, noteLines);
}

/** 核验定位高亮：在目标页位外画圆角描边并标注（建议 = 青色，普通定位 = 紫色）。 */
function drawSlotHighlight(ctx, sheetRect, position, isSuggestion) {
  const rect = position === 'left'
    ? { x: sheetRect.x, y: sheetRect.y, w: sheetRect.w / 2, h: sheetRect.h }
    : { x: sheetRect.x + sheetRect.w / 2, y: sheetRect.y, w: sheetRect.w / 2, h: sheetRect.h };
  const color = isSuggestion ? '#0f766e' : '#5f3dc4';
  const label = isSuggestion ? '◆ 建议观察位' : '◆ 核验定位';
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 4;
  roundRect(ctx, rect.x + 4, rect.y + 4, rect.w - 8, rect.h - 8, 6);
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.font = 'bold 14px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(label, rect.x + rect.w / 2, rect.y + 24);
  ctx.restore();
}

/** 绘制一张纸的一面：纸面、裁切角线、左右页位、折线与骑马钉。 */
function drawSheet(ctx, rect, side, opts) {
  // 阴影 + 纸面
  ctx.save();
  ctx.fillStyle = 'rgba(15, 30, 60, 0.12)';
  roundRect(ctx, rect.x + 5, rect.y + 7, rect.w, rect.h, 4);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#33415c';
  ctx.lineWidth = 1.6;
  roundRect(ctx, rect.x, rect.y, rect.w, rect.h, 4);
  ctx.fill();
  ctx.stroke();
  ctx.restore();

  drawCropMarks(ctx, rect);

  const midX = rect.x + rect.w / 2;
  drawSlot(ctx, { x: rect.x, y: rect.y, w: rect.w / 2, h: rect.h }, side.left, opts, '左');
  drawSlot(ctx, { x: midX, y: rect.y, w: rect.w / 2, h: rect.h }, side.right, opts, '右');

  // 折线（订口）与骑马钉
  ctx.save();
  ctx.strokeStyle = '#d6336c';
  ctx.lineWidth = 1.4;
  ctx.setLineDash([7, 5]);
  ctx.beginPath();
  ctx.moveTo(midX, rect.y + 2);
  ctx.lineTo(midX, rect.y + rect.h - 2);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = '#8a94a6';
  [0.28, 0.72].forEach((t) => {
    const y = rect.y + rect.h * t;
    roundRect(ctx, midX - 2.5, y - 9, 5, 18, 2.5);
    ctx.fill();
  });
  ctx.fillStyle = '#d6336c';
  ctx.font = '12px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('折线 · 订口（骑马钉）', midX, rect.y + rect.h + 20);
  ctx.restore();

  // 双面生产标记：按纸张 mm 坐标等比映射绘制（与适配框共用同一换算，折线段吸附到折线）
  if (opts.marksEnabled && opts.sideMarks) {
    drawProductionMarks(ctx, rect, side, opts.sideMarks, opts);
  }
}

/**
 * 把生产标记的纸张 mm 坐标映射到画布：与适配框（drawSlot 内 fit 可视化）
 * 使用完全相同的 mm→px 换算——每个页位按自身可用矩形（左 [0,W/2]、
 * 右 [W/2,W]）映射到页位内框（rect 四周内缩 10px），保证裁切线端点与
 * trim 角点、套准十字与出血框边严格对齐；中线上的折线段吸附到画布折线。
 */
function makePaperMapper(rect, side, opts) {
  const pad = 10;
  const slotW = rect.w / 2;
  const left = side.left.fit;
  const sx = (slotW - pad * 2) / left.rect.width;
  const sy = (rect.h - pad * 2) / left.rect.height;
  const foldX = rect.x + rect.w / 2;
  const midMm = opts.paperWidth / 2;
  const mapX = (xMm) => {
    if (Math.abs(xMm - midMm) < 1e-6) return foldX;
    if (xMm < midMm) {
      // 左页位：局部坐标 xMm（rect.x 起）映射到内框
      return rect.x + pad + (xMm - left.rect.x) * sx;
    }
    // 右页位：用右页位 fit.rect（x = W/2）映射到右页位内框
    const rr = side.right.fit.rect;
    return rect.x + slotW + pad + (xMm - rr.x) * sx;
  };
  const mapY = (yMm) => rect.y + pad + (yMm - left.rect.y) * sy;
  return { mapX, mapY };
}

const MARK_STYLE = {
  crop: { color: '#212529', width: 1.4, dash: [] },
  fold: { color: '#d6336c', width: 1.6, dash: [6, 3] },
  register: { color: '#0f766e', width: 1.6, dash: [] },
};

/** 绘制一面的全部已放置生产标记（裁切线 / 折线标 / 套准十字）。 */
function drawProductionMarks(ctx, rect, side, sideMarks, opts) {
  const { mapX, mapY } = makePaperMapper(rect, side, opts);
  ctx.save();
  ctx.lineCap = 'round';
  sideMarks.placed.forEach((mark) => {
    const style = MARK_STYLE[mark.type] || MARK_STYLE.crop;
    ctx.strokeStyle = style.color;
    ctx.lineWidth = style.width;
    ctx.setLineDash(style.dash);
    mark.segments.forEach((seg) => {
      ctx.beginPath();
      ctx.moveTo(mapX(seg.x1), mapY(seg.y1));
      ctx.lineTo(mapX(seg.x2), mapY(seg.y2));
      ctx.stroke();
    });
  });
  ctx.setLineDash([]);
  ctx.restore();
}

/** 绘制一个页位：原始页位虚线框（爬移前）+ 补偿后实线框；页码 / 空白斜纹 / 页首方向 / 背面物理关系标注。 */
function drawSlot(ctx, rect, slot, opts, posName) {
  const pad = 10;
  const inner = { x: rect.x + pad, y: rect.y + pad, w: rect.w - pad * 2, h: rect.h - pad * 2 };

  // 爬移偏移（屏幕像素）：offsetMm 正 = 向右，负 = 向左
  let shiftPx = 0;
  if (opts.creepEnabled && slot.offsetMm) {
    shiftPx = slot.offsetMm * opts.creepPxPerMm;
    // 限制在页位内部，避免超出纸面
    const maxShift = rect.w - pad * 2 - 24;
    shiftPx = Math.max(-maxShift, Math.min(maxShift, shiftPx));
  }

  // 原始页位（爬移补偿前）：虚线框，仅在确有偏移时叠加显示
  if (shiftPx !== 0) {
    ctx.save();
    ctx.strokeStyle = '#b0691a';
    ctx.lineWidth = 1.2;
    ctx.setLineDash([5, 4]);
    ctx.strokeRect(rect.x + pad, rect.y + pad, rect.w - pad * 2, rect.h - pad * 2);
    ctx.setLineDash([]);
    ctx.restore();
  }

  // 适配检查可视化：把页位可用矩形（mm）等比映射到页位内框，
  // 叠加成品页裁切框、出血框与安全区框（trim 坐标已含爬移偏移，故不随 shiftPx 平移）
  if (opts.fitEnabled && slot.fit) {
    const f = slot.fit;
    const sx = inner.w / f.rect.width;
    const sy = inner.h / f.rect.height;
    const map = (box) => ({
      x: inner.x + (box.x - f.rect.x) * sx,
      y: inner.y + (box.y - f.rect.y) * sy,
      w: Math.max(2, box.width * sx),
      h: Math.max(2, box.height * sy),
    });
    ctx.save();
    // 出血框：绿 = 落在纸张内，红 = 超出纸张
    const b = map(f.bleedBox);
    ctx.strokeStyle = f.ok ? '#2f9e44' : '#e03131';
    ctx.lineWidth = 1.4;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(b.x, b.y, b.w, b.h);
    ctx.setLineDash([]);
    // 成品页裁切框
    const t = map(f.trim);
    ctx.strokeStyle = '#1d4ed8';
    ctx.lineWidth = 1.6;
    ctx.strokeRect(t.x, t.y, t.w, t.h);
    // 安全区框
    if (f.safeBox) {
      const s = map(f.safeBox);
      ctx.strokeStyle = '#94a3b8';
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 3]);
      ctx.strokeRect(s.x, s.y, s.w, s.h);
      ctx.setLineDash([]);
    }
    ctx.restore();
  }

  // 不合格页位：红色圆徽标记
  if (opts.fitEnabled && slot.fit && !slot.fit.ok) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(rect.x + rect.w - 18, rect.y + 18, 11, 0, Math.PI * 2);
    ctx.fillStyle = '#e03131';
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('!', rect.x + rect.w - 18, rect.y + 19);
    ctx.textBaseline = 'alphabetic';
    ctx.restore();
  }

  // 补偿后的页位（整体平移 shiftPx 后按原样式绘制）
  ctx.save();
  ctx.translate(shiftPx, 0);

  const cx = inner.x + inner.w / 2;
  const cy = inner.y + inner.h / 2;

  ctx.strokeStyle = shiftPx !== 0 ? '#e8820c' : '#c4ccd9';
  ctx.lineWidth = shiftPx !== 0 ? 1.8 : 1;
  ctx.strokeRect(inner.x, inner.y, inner.w, inner.h);

  if (slot.blank) {
    // 空白页：灰色斜纹（补偿后位置）
    ctx.save();
    ctx.beginPath();
    ctx.rect(inner.x, inner.y, inner.w, inner.h);
    ctx.clip();
    ctx.strokeStyle = '#e3e8f0';
    for (let d = -inner.h; d < inner.w + inner.h; d += 12) {
      ctx.beginPath();
      ctx.moveTo(inner.x + d, inner.y);
      ctx.lineTo(inner.x + d + inner.h, inner.y + inner.h);
      ctx.stroke();
    }
    ctx.restore();
    ctx.fillStyle = '#9aa5b8';
    ctx.font = 'bold 26px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('空白页', cx, cy);
    ctx.textBaseline = 'alphabetic';
  } else {
    ctx.save();
    if (opts.rotated) {
      // 长边翻转：背面内容旋转 180°（页首朝下）
      ctx.translate(cx, cy);
      ctx.rotate(Math.PI);
      ctx.translate(-cx, -cy);
    }
    ctx.fillStyle = '#1d4ed8';
    ctx.font = 'bold 56px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(slot.page), cx, cy - 8);
    ctx.fillStyle = '#5a6b85';
    ctx.font = '14px system-ui, sans-serif';
    ctx.fillText(`第 ${slot.page} 页`, cx, cy + 30);
    ctx.fillStyle = '#94a3b8';
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillText('▲ 页首', cx, inner.y + (shiftPx !== 0 ? 30 : 16));
    ctx.restore();
    ctx.textBaseline = 'alphabetic';
  }

  // 爬移偏移量标注（补偿后框内顶部）
  if (shiftPx !== 0) {
    ctx.fillStyle = '#b0691a';
    ctx.font = 'bold 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    const sign = slot.offsetMm > 0 ? '+' : '';
    ctx.fillText(`爬移 ${sign}${formatMm(slot.offsetMm)} mm`, cx, inner.y + 14);
  }

  // 页位角标
  ctx.fillStyle = '#8a94a6';
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = posName === '左' ? 'left' : 'right';
  ctx.fillText(`${posName}页位`, posName === '左' ? inner.x + 2 : inner.x + inner.w - 2, inner.y + inner.h - 6);

  // 背面页位：标注物理上位于哪一正面页之背（折叠后阅读顺序校验）
  if (opts.isBack && !slot.blank && slot.backOf != null) {
    ctx.fillStyle = '#0f766e';
    ctx.font = '12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`位于正面第 ${slot.backOf} 页之背`, cx, inner.y + inner.h - 22);
  }
  ctx.restore();
}

/** 裁切角线。 */
function drawCropMarks(ctx, rect) {
  const len = 14;
  const gap = 5;
  const corners = [
    [rect.x, rect.y, -1, -1],
    [rect.x + rect.w, rect.y, 1, -1],
    [rect.x, rect.y + rect.h, -1, 1],
    [rect.x + rect.w, rect.y + rect.h, 1, 1],
  ];
  ctx.save();
  ctx.strokeStyle = '#8a94a6';
  ctx.lineWidth = 1;
  corners.forEach(([x, y, sx, sy]) => {
    ctx.beginPath();
    ctx.moveTo(x + sx * gap, y);
    ctx.lineTo(x + sx * (gap + len), y);
    ctx.moveTo(x, y + sy * gap);
    ctx.lineTo(x, y + sy * (gap + len));
    ctx.stroke();
  });
  ctx.restore();
}

function drawArrowHead(ctx, x, y, angle, color) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(-9, -5);
  ctx.lineTo(-9, 5);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/** 正背面之间的翻转示意图：翻转轴 + 弧形箭头 + 说明。 */
function drawFlipDiagram(ctx, zone, flip) {
  const cx = zone.x + zone.w / 2;
  const cy = zone.y + zone.h / 2;

  ctx.save();
  // 正面 -> 背面 大箭头
  const ay = zone.y + 34;
  ctx.strokeStyle = '#2563eb';
  ctx.fillStyle = '#2563eb';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(zone.x + 10, ay);
  ctx.lineTo(zone.x + zone.w - 20, ay);
  ctx.stroke();
  drawArrowHead(ctx, zone.x + zone.w - 10, ay, 0, '#2563eb');
  ctx.font = '12px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('翻面印刷', cx, ay - 10);

  // 小纸张图标
  const iw = 84;
  const ih = 60;
  const ix = cx - iw / 2;
  const iy = cy - 46;
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#33415c';
  ctx.lineWidth = 1.4;
  ctx.fillRect(ix, iy, iw, ih);
  ctx.strokeRect(ix, iy, iw, ih);

  const iconCy = iy + ih / 2;
  const radius = iw / 2 + 16;

  ctx.strokeStyle = '#d6336c';
  ctx.lineWidth = 1.2;
  ctx.setLineDash([5, 4]);
  ctx.beginPath();
  if (flip === 'short') {
    ctx.moveTo(cx, iy - 18);
    ctx.lineTo(cx, iy + ih + 18);
  } else {
    ctx.moveTo(ix - 18, iconCy);
    ctx.lineTo(ix + iw + 18, iconCy);
  }
  ctx.stroke();
  ctx.setLineDash([]);

  // 弧形翻转箭头
  ctx.strokeStyle = '#2563eb';
  ctx.lineWidth = 2;
  ctx.beginPath();
  if (flip === 'short') {
    // 绕垂直轴：上方弧形箭头（左 -> 右）
    const a0 = Math.PI * 1.18;
    const a1 = Math.PI * 1.82;
    ctx.arc(cx, iconCy, radius, a0, a1);
    ctx.stroke();
    drawArrowHead(
      ctx,
      cx + radius * Math.cos(a1),
      iconCy + radius * Math.sin(a1),
      a1 + Math.PI / 2,
      '#2563eb'
    );
  } else {
    // 绕水平轴：右侧弧形箭头（上 -> 下）
    const a0 = -Math.PI / 3;
    const a1 = Math.PI / 3;
    ctx.arc(cx, iconCy, radius, a0, a1);
    ctx.stroke();
    drawArrowHead(
      ctx,
      cx + radius * Math.cos(a1),
      iconCy + radius * Math.sin(a1),
      a1 + Math.PI / 2,
      '#2563eb'
    );
  }

  // 说明文字
  ctx.fillStyle = '#16233b';
  ctx.font = 'bold 14px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(FLIP_TEXT[flip], cx, iy + ih + 34);
  ctx.fillStyle = '#5a6b85';
  ctx.font = '12px system-ui, sans-serif';
  ctx.fillText(flip === 'short' ? '绕垂直短边翻转' : '绕水平长边翻转', cx, iy + ih + 54);
  ctx.fillText(flip === 'short' ? '背面左右页位互换' : '背面内容旋转 180°', cx, iy + ih + 72);
  ctx.restore();
}

/** 组装底部图例与规则说明行（含适配检查 / 双面生产标记结果）。 */
function buildNotes(input, creep, fit, violations, marks, markOmissions) {
  const lines = [
    { text: '图例：蓝色数字 = 成品页码；灰色斜纹 = 自动补齐的空白页；红色虚线 = 对折线（订口）；灰色小角线 = 裁切标记。' },
    {
      text: input.flip === 'long'
        ? '长边翻转：纸张绕水平长边翻转，背面左右页位与正面相同，背面内容旋转 180°（页首朝下）。'
        : '短边翻转：纸张绕垂直短边翻转，背面左右页位与正面互换，背面内容方向不变。',
    },
    {
      text: input.binding === 'left'
        ? '左装订：第 1 页位于正面右页位，书脊在左。'
        : '右装订：第 1 页位于正面左页位，书脊在右。',
    },
    { text: '背面每个页位标注了它物理上位于哪一正面页之背；沿折线对折并配帖装订后，页码首尾相接，阅读顺序连续。' },
  ];
  if (input.balancedSplit) {
    lines.push({
      text: '均衡分帖：以每帖张数为上限取最少帖数，整本所需纸张在各帖间均匀分配，各帖实际张数差不超过 1，各帖按自身页数连续编号，空白页只出现在末帖末尾；爬移补偿按各帖实际层数独立重算。',
      color: '#0b7285',
    });
  }
  if (input.chapterSplit) {
    lines.push({
      text: '章节优先分帖：在每帖张数上限与整数张约束下，按「章节被拆分次数最少 → 补白页总数最少 → 帖数最少 → 前帖优先装满」确定唯一方案；章节末尾允许插入帖内空白（灰色斜纹），后续真实页码保持连续并正确进入下一帖。',
      color: '#5f3dc4',
    });
  }
  if (creep && creep.enabled) {
    lines.push(
      {
        text: `爬移补偿：每帖由外向内第 i 张（i 从 0 起）补偿量 = min(i × ${formatMm(input.paperThickness)} mm × 2, ${formatMm(input.maxCompensation)} mm)；画布位移为示意性放大，非真实比例。`,
        color: '#b0691a',
      },
      {
        text: input.binding === 'left'
          ? '符号约定：左装订时左页位向外侧（+，向右）、右页位向外侧（−，向左）平移；橙色实线框为补偿后页位，橙色虚线框为原始页位。'
          : '符号约定：右装订时符号整体反转，右页位向外侧（+，向右）、左页位向外侧（−，向左）平移；橙色实线框为补偿后页位，橙色虚线框为原始页位。',
        color: '#b0691a',
      }
    );
  } else {
    lines.push({ text: '爬移补偿未启用（纸张厚度或最大补偿量为 0）：各页位 offsetMm 均为 0，仅显示原始拼版页位。', color: '#b0691a' });
  }
  if (fit && fit.enabled) {
    lines.push({
      text: `适配检查：纸张 ${formatMm(fit.paperWidth)}×${formatMm(fit.paperHeight)} mm · 页位 ${formatMm(fit.slotWidth)}×${formatMm(fit.slotHeight)} mm · 成品页 ${formatMm(fit.pageWidth)}×${formatMm(fit.pageHeight)} mm · 出血 ${formatMm(fit.bleedMm)} mm · 安全边距 ${formatMm(fit.safetyMm)} mm；蓝框 = 裁切线，绿/红虚框 = 出血范围（红 = 超出纸张），灰点框 = 安全区，红色圆徽 = 页位不适配。`,
    });
    if (violations.length === 0) {
      lines.push({ text: '✓ 本张全部页位适配通过。', color: '#1e7e34' });
    } else {
      violations.slice(0, 5).forEach((v) => lines.push({ text: `⚠ ${v}`, color: '#c92a2a' }));
      if (violations.length > 5) {
        lines.push({ text: `…其余 ${violations.length - 5} 项超限详见下方拼版清单。`, color: '#c92a2a' });
      }
    }
  }
  if (marks && marks.enabled) {
    lines.push({
      text: `双面生产标记（尺寸 ${formatMm(marks.markSizeMm)} mm，标记距出血框 ${formatMm(marks.gapMm)} mm）：黑色实线 = 裁切线，玫红虚线 = 折线标（中线上下），青色 = 套准十字（左右出血框外侧，按「居中 → 1/4 → 3/4」候选顺序落位）；背面标记按${FLIP_TEXT[marks.flip]}做同一物理位置坐标变换（${marks.transform.mapping}），正背标记套准。`,
      color: '#0f766e',
    });
    lines.push({
      text: '落位规则：每个标记的线段须完整落在纸内、避开两侧出血框且不与同面已放置标记相交；候选位置均不可用则省略并返回原因（爬移 / 尺寸变化时随重算同步刷新）。',
      color: '#5a6b85',
    });
    if (!markOmissions || markOmissions.length === 0) {
      lines.push({ text: '✓ 本张正背面全部生产标记落位。', color: '#0f766e' });
    } else {
      markOmissions.slice(0, 6).forEach((o) => lines.push({ text: `⚠ ${o}`, color: '#b35900' }));
      if (markOmissions.length > 6) {
        lines.push({ text: `…其余 ${markOmissions.length - 6} 个省略标记详见下方拼版清单与导出 JSON。`, color: '#b35900' });
      }
    }
  }
  return lines;
}

/** 底部图例与规则说明。 */
function drawNotes(ctx, lines) {
  ctx.save();
  ctx.font = '13px system-ui, sans-serif';
  ctx.textAlign = 'left';
  lines.forEach((line, i) => {
    ctx.fillStyle = line.color || '#5a6b85';
    ctx.fillText(`· ${line.text}`, 70, 540 + i * 25);
  });
  ctx.restore();
}
