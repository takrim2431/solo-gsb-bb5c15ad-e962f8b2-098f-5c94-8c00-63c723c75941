'use strict';

const path = require('path');
const express = require('express');
const { computeImposition } = require('./src/imposition');

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

/**
 * 拼版计算接口。
 * 请求体：{
 *   totalPages, sheetsPerSignature, binding: 'left'|'right', flip: 'long'|'short',
 *   paperThickness?, maxCompensation?,                       // 可选，纸张厚度与爬移最大补偿量（mm，缺省/为 0 不补偿）
 *   balancedSplit?, chapterSplit?, chapterStarts?,           // 可选，分帖模式（均衡 / 章节优先，互斥）
 *   paperWidth?, paperHeight?, pageWidth?, pageHeight?, bleedMm?, safetyMm?, // 可选，适配检查
 *   productionMarks?, markSizeMm?,                          // 可选，双面生产标记（需启用适配检查）
 *   observations?                                            // 可选，试印核验观察（1～12 条；缺省/空数组不启用）
 *   materialPrep?                                            // 可选，印刷备料 { copies, makereadySheets, processWasteRate, sheetsPerPack }；缺省不启用
 *   purchaseQuotes?                                          // 可选，采购报价组合 { demandSheets?, quotes: [{ supplier, sheetsPerPack, pricePerPackCents, minPacks, maxPacks }] }；缺省不启用
 *   dualVersion?                                             // 可选，双版本共版印刷 { copiesA, copiesB, changedPages }；缺省不启用
 *   stockBatches?                                            // 可选，库存批次领纸 { batches: [{ lot, availableSheets, allowedSignatures? }] }；缺省不启用（需先启用 materialPrep）
 * }
 * 响应：拼版清单 JSON（与前端「导出拼版清单 JSON」内容一致）；
 * 启用试印核验时顶层带 verification（观察、四种装订×翻转候选的评分与结论）；
 * 启用双面生产标记时每张纸带 productionMarks（正背面标记线段坐标 / 省略原因），
 * 顶层 productionMarks 给出尺寸、正背坐标变换与放置 / 省略汇总；
 * 启用印刷备料时顶层带 materialPrep（逐帖净用纸 / 开机损耗 / 过程损耗 / 需领纸，
 * 以及汇总后的整包采购包数 / 采购张数 / 包余；逐帖取整后再汇总）；
 * 启用采购报价组合时顶层带 purchaseQuotes（需求张数、逐报价采购包数 / 张数 /
 * 金额（分）/ 余量与总价，按「总价→超购→供应商数→录入顺序」取唯一方案；
 * 无可行组合时 feasible 为 false 并给出具体缺口张数）；
 * 启用双版本共版时顶层带 dualVersion（逐张逐面的页码 / 印版归属（共用或 A、B 拆版）/
 * 各印版印次，以及面数、印版数与总印次汇总）；
 * 启用库存批次领纸时顶层带 stockBatches（各帖需求取自备料需领纸 requiredSheets，
 * 按最大流求总缺口最小的分配：逐帖批次领用明细与缺口、逐批领用合计与剩余张数）。
 */
app.post('/api/impose', (req, res) => {
  try {
    const result = computeImposition(req.body || {});
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.use('/api', (req, res) => {
  res.status(404).json({ error: '接口不存在' });
});

const PORT = Number(process.env.PORT) || 8080;

// 直接运行（node server.js / Docker CMD）时启动服务；被测试 require 时仅导出 app。
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`骑马钉拼版预演已启动: http://localhost:${PORT}`);
  });
}

module.exports = { app, PORT };
