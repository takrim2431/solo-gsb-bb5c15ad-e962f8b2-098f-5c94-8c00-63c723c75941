'use strict';

const path = require('path');
const express = require('express');
const { createImpositionPool } = require('./src/impositionPool');

const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 拼版计算迁入有界线程池：固定 2 个工作线程（每线程同时 1 项）+ 8 项 FIFO 等待，
// 满载（2 + 8 = 10 项）时新请求返回 503；单项执行超过 IMPOSITION_TIMEOUT_MS
// （默认 5000ms）返回 504 并终止、更换该线程；线程意外退出时该项返回 500 并补建线程。
const IMPOSE_TIMEOUT_MS = (() => {
  const parsed = Number(process.env.IMPOSITION_TIMEOUT_MS);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
})();
const imposePool = createImpositionPool({
  timeoutMs: IMPOSE_TIMEOUT_MS,
  testHooks: process.env.IMPOSITION_TEST_HOOKS === '1',
});

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
 * 计算在工作线程池中异步执行：成功响应与参数错误的 400 响应与同步版本完全一致；
 * 满载返回 503（中文原因），执行超时返回 504，工作线程意外退出返回 500。
 */
app.post('/api/impose', async (req, res) => {
  const body = req.body || {};
  let input = body;
  if (process.env.IMPOSITION_TEST_HOOKS === '1') {
    // 测试钩子字段（__testSlowMs / __testExitWorker）仅在开启钩子时透传给工作线程
    input = { ...body };
    if (!Number.isInteger(input.__testSlowMs) || input.__testSlowMs <= 0) delete input.__testSlowMs;
    if (input.__testExitWorker !== 'before' && input.__testExitWorker !== 'after') delete input.__testExitWorker;
  }

  const job = imposePool.submit(input);
  // 客户端断开（响应未完成前连接关闭）：等待中的任务移出队列（释放容量），
  // 执行中的任务终止并补建线程。正常响应完成后的 'close' 不处理。
  res.on('close', () => {
    if (!res.writableFinished && !res.writableEnded) job.cancel();
  });

  const outcome = await job.promise;
  try {
    if (res.writableEnded || res.destroyed) return; // 连接已断开，无需响应
    switch (outcome.status) {
      case 'ok':
        res.json(outcome.result);
        break;
      case 'invalid':
        res.status(400).json({ error: outcome.message });
        break;
      case 'rejected':
        res.status(503).json({ error: '拼版计算繁忙：当前 2 个计算线程均在执行且等待队列已满（8 项），请稍后重试' });
        break;
      case 'timeout':
        res.status(504).json({ error: `拼版计算超时（超过 ${imposePool.timeoutMs}ms），已终止本次计算，请调整参数后重试` });
        break;
      case 'crashed':
        res.status(500).json({ error: '拼版计算线程意外退出，本次计算未完成，请重试' });
        break;
      default: // cancelled：客户端已断开，不再响应
        break;
    }
  } catch (err) {
    // 响应写入失败（如客户端在计算完成瞬间断开）：任务已结算，忽略即可
  }
});

app.use('/api', (req, res) => {
  res.status(404).json({ error: '接口不存在' });
});

const PORT = Number(process.env.PORT) || 8080;

// 直接运行（node server.js / Docker CMD）时启动服务；被测试 require 时仅导出 app。
if (require.main === module) {
  // 初始工作线程全部就绪后再对外服务，避免启动初期请求排队等待线程创建
  imposePool.ready.then(() => {
    const server = app.listen(PORT, () => {
      console.log(`骑马钉拼版预演已启动: http://localhost:${PORT}`);
    });
    const shutdown = () => {
      server.close(() => process.exit(0));
      imposePool.close().finally(() => process.exit(0));
      setTimeout(() => process.exit(0), 3000).unref();
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
}

module.exports = { app, PORT, imposePool };
