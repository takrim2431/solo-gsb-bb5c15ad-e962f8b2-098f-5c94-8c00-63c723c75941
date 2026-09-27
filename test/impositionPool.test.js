'use strict';

/**
 * 拼版计算线程池（/api/impose 迁入 worker_threads）端到端验证。
 *
 * 通过 IMPOSITION_TEST_HOOKS=1 开启可控慢任务（__testSlowMs，忙等）与
 * 线程异常退出（__testExitWorker）测试钩子；IMPOSITION_TIMEOUT_MS=1500
 * 缩短单项执行超时便于自动化验证。覆盖：
 * - 成功结果与参数错误 400 的兼容性（与直接 computeImposition 完全一致）；
 * - 计算期间首页与 /api/health 仍可响应；
 * - 满载（2 执行 + 8 等待）第 11 项返回 503 及中文原因；
 * - 等待队列先进先出（FIFO）派发顺序与响应归属（各请求拿到各自参数的结果）；
 * - 执行超时返回 504、终止并更换线程（后续任务正常、迟到消息不串号）；
 * - 线程意外退出返回 500、补建线程且其他任务继续；
 * - 客户端断开：等待任务移出队列释放容量；运行中任务终止并补建线程。
 */

// 必须在 require('../server') 之前设置：线程池在模块加载时按环境变量创建
process.env.IMPOSITION_TEST_HOOKS = '1';
process.env.IMPOSITION_TIMEOUT_MS = '1500';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { app, imposePool } = require('../server');
const { computeImposition } = require('../src/imposition');

const TIMEOUT_MS = 1500;
const BASE = { totalPages: 8, sheetsPerSignature: 2, binding: 'left', flip: 'short' };

/** 带测试钩子的请求体：slowMs 忙等毫秒数；patch 可附加 __testExitWorker 等。 */
function slowBody(slowMs, patch = {}) {
  return { ...BASE, __testSlowMs: slowMs, ...patch };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 启动测试服务器（随机端口），等待线程池初始线程全部就绪。 */
async function startServer() {
  await imposePool.ready;
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/**
 * POST JSON。abortAfterMs 给定时在客户端断开请求（模拟客户端断开）。
 * 正常响应兑现 { status, body }；客户端断开兑现 { aborted: true, error }。
 */
function post(url, body, { abortAfterMs } = {}) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    let done = false;
    const finish = (value) => {
      if (!done) {
        done = true;
        resolve(value);
      }
    };
    const req = http.request(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          let parsed = null;
          try { parsed = JSON.parse(raw); } catch (err) { /* 非 JSON 响应 */ }
          finish({ status: res.statusCode, body: parsed });
        });
        res.on('error', (err) => finish({ aborted: true, error: String((err && err.code) || err) }));
      }
    );
    req.on('error', (err) => finish({ aborted: true, error: String((err && err.code) || err) }));
    if (abortAfterMs != null) {
      const timer = setTimeout(() => {
        req.destroy();
        finish({ aborted: true, error: 'client-abort' });
      }, abortAfterMs);
      timer.unref();
    }
    req.write(data);
    req.end();
  });
}

/** GET，返回 { status, body, elapsedMs }。 */
function get(url) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: raw, elapsedMs: Date.now() - started }));
    }).on('error', reject);
  });
}

test('线程池基线：成功结果与直接 computeImposition 一致，响应归属正确', async () => {
  const srv = await startServer();
  try {
    const body = { ...BASE, observations: [] };
    const res = await post(`${srv.baseUrl}/api/impose`, body);
    assert.equal(res.status, 200);
    // meta.generatedAt 在两次独立计算中必然不同，比较前剔除
    const withoutTimestamp = (value) => {
      const copy = JSON.parse(JSON.stringify(value));
      assert.match(copy.meta.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
      delete copy.meta.generatedAt;
      return copy;
    };
    assert.deepEqual(withoutTimestamp(res.body), withoutTimestamp(computeImposition(body)));
    assert.equal(res.body.input.totalPages, 8);
    assert.deepEqual(res.body.verification, { enabled: false });

    const notFound = await get(`${srv.baseUrl}/api/nope`);
    assert.equal(notFound.status, 404);
    assert.match(notFound.body, /接口不存在/);
  } finally {
    await srv.close();
  }
});

test('参数错误的 400 响应保持兼容（错误消息与同步版本一致）', async () => {
  const srv = await startServer();
  try {
    const dupObs = {
      ...BASE,
      observations: [
        { signature: 1, sheet: 1, side: 'front', position: 'left', page: 8, orientation: 'upright' },
        { signature: 1, sheet: 1, side: 'front', position: 'left', page: 1, orientation: 'upright' },
      ],
    };
    const res = await post(`${srv.baseUrl}/api/impose`, dupObs);
    assert.equal(res.status, 400);
    let syncMessage;
    try {
      computeImposition(dupObs);
    } catch (err) {
      syncMessage = err.message;
    }
    assert.equal(res.body.error, syncMessage);
    assert.match(res.body.error, /重复观察/);

    const missing = await post(`${srv.baseUrl}/api/impose`, { totalPages: 8 });
    assert.equal(missing.status, 400);
    assert.equal(typeof missing.body.error, 'string');
  } finally {
    await srv.close();
  }
});

test('计算期间首页与 /api/health 仍可响应', async () => {
  const srv = await startServer();
  try {
    // 两个 900ms 忙等慢任务占满 2 个工作线程（超时 1500ms 内可正常完成）
    const slow1 = post(`${srv.baseUrl}/api/impose`, slowBody(900, { totalPages: 16 }));
    const slow2 = post(`${srv.baseUrl}/api/impose`, slowBody(900, { totalPages: 24 }));
    await sleep(100); // 确认两个慢任务已进入执行

    const health = await get(`${srv.baseUrl}/api/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(JSON.parse(health.body), { ok: true });
    assert.ok(health.elapsedMs < 500, `健康检查应在计算期间快速响应，实际 ${health.elapsedMs}ms`);

    const home = await get(`${srv.baseUrl}/`);
    assert.equal(home.status, 200);
    assert.match(home.body, /骑马钉/);
    assert.ok(home.elapsedMs < 500, `首页应在计算期间快速响应，实际 ${home.elapsedMs}ms`);

    // 线程被占满时新任务进入等待队列，慢任务结束后照常完成
    const queued = await post(`${srv.baseUrl}/api/impose`, { ...BASE, totalPages: 32 });
    assert.equal(queued.status, 200);
    assert.equal(queued.body.input.totalPages, 32);

    const [r1, r2] = await Promise.all([slow1, slow2]);
    assert.equal(r1.status, 200);
    assert.equal(r1.body.input.totalPages, 16);
    assert.equal(r2.status, 200);
    assert.equal(r2.body.input.totalPages, 24);
  } finally {
    await srv.close();
  }
});

test('满载返回 503 及中文原因；等待队列 FIFO 派发；各响应归属正确', async () => {
  const srv = await startServer();
  try {
    const completionOrder = [];
    const track = (label, promise) => promise.then((res) => {
      completionOrder.push(label);
      return res;
    });

    // 2 个慢任务占满工作线程（400 / 600ms，错开完成时间）
    const b1 = track('b1', post(`${srv.baseUrl}/api/impose`, slowBody(400, { totalPages: 8 })));
    const b2 = track('b2', post(`${srv.baseUrl}/api/impose`, slowBody(600, { totalPages: 16 })));
    // 8 项等待任务各执行 400ms：完成时刻依次为 800/1000/1200/.../2200，
    // 相邻间隔 200ms，仅当严格 FIFO 派发时完成顺序才与提交顺序一致
    const queued = [];
    for (let i = 1; i <= 8; i += 1) {
      queued.push(track(`q${i}`, post(`${srv.baseUrl}/api/impose`, slowBody(400, { totalPages: 8 * (i + 2) }))));
    }
    // 第 11 项：2 执行 + 8 等待已满 -> 立即 503
    const over = await track('over', post(`${srv.baseUrl}/api/impose`, { ...BASE, totalPages: 88 }));
    assert.equal(over.status, 503);
    assert.match(over.body.error, /拼版计算繁忙/);
    assert.match(over.body.error, /队列已满/);

    const results = await Promise.all([b1, b2, ...queued]);
    // FIFO：'over' 的 503 最先返回，随后 b1 -> b2 -> q1..q8 严格按提交顺序完成
    assert.deepEqual(completionOrder, ['over', 'b1', 'b2', 'q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7', 'q8']);
    // 响应归属：每个请求拿到自己参数对应的结果
    results.forEach((res, i) => {
      assert.equal(res.status, 200);
      assert.equal(res.body.input.totalPages, 8 * (i + 1));
    });
  } finally {
    await srv.close();
  }
});

test('执行超时返回 504 并终止、更换线程；迟到消息不串到后续请求', async () => {
  const srv = await startServer();
  try {
    // 两个 2000ms 慢任务超过 1500ms 执行超时；并发的正常任务不受牵连
    const slow1 = post(`${srv.baseUrl}/api/impose`, slowBody(2000, { totalPages: 8 }));
    const slow2 = post(`${srv.baseUrl}/api/impose`, slowBody(2000, { totalPages: 16 }));
    const normal = await post(`${srv.baseUrl}/api/impose`, { ...BASE, totalPages: 24 });
    assert.equal(normal.status, 200);
    assert.equal(normal.body.input.totalPages, 24);

    const [r1, r2] = await Promise.all([slow1, slow2]);
    assert.equal(r1.status, 504);
    assert.match(r1.body.error, /超时/);
    assert.match(r1.body.error, new RegExp(`${TIMEOUT_MS}ms`));
    assert.equal(r2.status, 504);
    assert.match(r2.body.error, /超时/);

    // 两个线程均已终止并更换：新任务正常执行，且结果属于新请求（无迟到消息串号）
    const [n1, n2] = await Promise.all([
      post(`${srv.baseUrl}/api/impose`, slowBody(200, { totalPages: 32 })),
      post(`${srv.baseUrl}/api/impose`, slowBody(200, { totalPages: 40 })),
    ]);
    assert.equal(n1.status, 200);
    assert.equal(n1.body.input.totalPages, 32);
    assert.equal(n2.status, 200);
    assert.equal(n2.body.input.totalPages, 40);
  } finally {
    await srv.close();
  }
});

test('工作线程意外退出：该项返回 500 并补建线程，其他任务继续', async () => {
  const srv = await startServer();
  try {
    // 忙等 150ms 后线程在计算前退出（模拟意外退出）；并发正常任务在另一线程执行
    const crash = post(`${srv.baseUrl}/api/impose`, slowBody(150, { totalPages: 8, __testExitWorker: 'before' }));
    const survivor = await post(`${srv.baseUrl}/api/impose`, { ...BASE, totalPages: 16 });
    assert.equal(survivor.status, 200);
    assert.equal(survivor.body.input.totalPages, 16);

    const crashed = await crash;
    assert.equal(crashed.status, 500);
    assert.match(crashed.body.error, /意外退出/);

    // 已补建线程：两个并行慢任务（各 200ms）都能按时完成，证明容量恢复为 2
    const [n1, n2] = await Promise.all([
      post(`${srv.baseUrl}/api/impose`, slowBody(200, { totalPages: 24 })),
      post(`${srv.baseUrl}/api/impose`, slowBody(200, { totalPages: 32 })),
    ]);
    assert.equal(n1.status, 200);
    assert.equal(n1.body.input.totalPages, 24);
    assert.equal(n2.status, 200);
    assert.equal(n2.body.input.totalPages, 32);
  } finally {
    await srv.close();
  }
});

test('客户端断开：等待中的任务移出队列并释放容量', async () => {
  const srv = await startServer();
  try {
    // 2 个 800ms 慢任务占满线程，随后 8 项排队（第 5 项将在 120ms 后从客户端断开）
    const b1 = post(`${srv.baseUrl}/api/impose`, slowBody(800, { totalPages: 8 }));
    const b2 = post(`${srv.baseUrl}/api/impose`, slowBody(800, { totalPages: 16 }));
    const queued = [];
    for (let i = 1; i <= 8; i += 1) {
      const options = i === 5 ? { abortAfterMs: 120 } : {};
      queued.push(post(`${srv.baseUrl}/api/impose`, slowBody(30, { totalPages: 8 * (i + 2) }), options));
    }
    // 第 5 项（仍在等待队列）客户端断开 -> 移出队列，容量释放 1 项
    const aborted = await queued[4];
    assert.equal(aborted.aborted, true);

    await sleep(300); // 等服务端处理断开事件（此时阻塞任务仍在执行）
    // 释放出的容量可再接纳 1 项新任务
    const extra = post(`${srv.baseUrl}/api/impose`, { ...BASE, totalPages: 80 });
    // 队列再次满（8 项）：新请求立即 503
    const over = await post(`${srv.baseUrl}/api/impose`, { ...BASE, totalPages: 88 });
    assert.equal(over.status, 503);
    assert.match(over.body.error, /拼版计算繁忙/);

    const rest = await Promise.all([b1, b2, ...queued.filter((_, i) => i !== 4), extra]);
    // 除断开的第 5 项外全部成功（2 阻塞 + 7 等待 + 1 补位 = 10 项），且响应归属正确
    assert.equal(rest.length, 10);
    rest.forEach((res) => assert.equal(res.status, 200));
    const pages = rest.map((res) => res.body.input.totalPages).sort((a, b) => a - b);
    assert.deepEqual(pages, [8, 16, 24, 32, 40, 48, 64, 72, 80, 80]);
  } finally {
    await srv.close();
  }
});

test('客户端断开：运行中的任务终止并补建线程，后续任务正常', async () => {
  const srv = await startServer();
  try {
    // 2000ms 慢任务执行期间客户端断开；另一线程的正常任务不受影响
    const slow = post(`${srv.baseUrl}/api/impose`, slowBody(2000, { totalPages: 8 }), { abortAfterMs: 150 });
    const normal = await post(`${srv.baseUrl}/api/impose`, { ...BASE, totalPages: 16 });
    assert.equal(normal.status, 200);
    assert.equal(normal.body.input.totalPages, 16);

    const aborted = await slow;
    assert.equal(aborted.aborted, true);

    await sleep(200); // 等服务端终止该线程并补建
    // 线程已补建：两个并行任务正常完成，响应归属正确
    const [n1, n2] = await Promise.all([
      post(`${srv.baseUrl}/api/impose`, slowBody(200, { totalPages: 24 })),
      post(`${srv.baseUrl}/api/impose`, slowBody(200, { totalPages: 32 })),
    ]);
    assert.equal(n1.status, 200);
    assert.equal(n1.body.input.totalPages, 24);
    assert.equal(n2.status, 200);
    assert.equal(n2.body.input.totalPages, 32);
  } finally {
    await srv.close();
  }
});
