'use strict';

/**
 * /api/impose 迁入 worker_threads 有界线程池的自动化验证。
 *
 * 借助可控工作线程（test/helpers/controllableWorker.js）覆盖：
 * - 排队顺序（FIFO）与容量释放（完成 / 超时 / 取消后等待任务继续）；
 * - 满载 503、单项执行超时 504、线程异常退出 500（均为中文原因）；
 * - 每项只结算一次、迟到消息不串到后续请求（响应归属）；
 * - 客户端断开：等待任务移除、运行任务终止并补建线程；
 * - 计算期间首页与健康接口仍可响应；
 * - 成功结果与参数错误 400 响应同同步版本兼容。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('path');
const { createImposePool } = require('../src/imposePool');
const { createApp } = require('../server');

const WORKER = path.join(__dirname, 'helpers', 'controllableWorker.js');
const BASE = { totalPages: 8, sheetsPerSignature: 2, binding: 'left', flip: 'short' };

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 轮询直到条件满足（用于等待线程池进入预期状态，避免基于固定时长的脆弱等待）。 */
async function waitFor(cond, { timeoutMs = 3000, intervalMs = 10 } = {}) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (cond()) return;
    await delay(intervalMs);
  }
  throw new Error('waitFor 超时：条件未满足');
}

/** 启动测试服务器（随机端口），返回 base URL 与关闭函数。 */
async function startServer(app) {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
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
          try {
            resolve({ status: res.statusCode, body: JSON.parse(raw) });
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(raw) });
        } catch (err) {
          reject(err);
        }
      });
    }).on('error', reject);
  });
}

function getText(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text: raw }));
    }).on('error', reject);
  });
}

/** 发送 POST 但保留请求句柄，可手动 destroy 模拟客户端断开。 */
function postRaw(url, body) {
  const data = JSON.stringify(body);
  const req = http.request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
  });
  const response = new Promise((resolve, reject) => {
    req.on('response', (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text: raw }));
    });
    req.on('error', reject);
  });
  req.end(data);
  return { req, response };
}

/* ------------------------------ 线程池行为 ------------------------------ */

test('线程池：FIFO 排队顺序，前项完成后容量释放、等待任务依次执行', async () => {
  // 单线程池：执行严格串行，完成顺序即派发顺序，可精确验证 FIFO
  const pool = createImposePool({ workerFile: WORKER, size: 1, queueLimit: 8, taskTimeoutMs: 5000 });
  try {
    const slow = pool.submit({ ...BASE, __delayMs: 300 }).promise; // 占住唯一线程
    const pages = [12, 16, 20, 24];
    const order = [];
    const queued = pages.map((tp) =>
      pool.submit({ ...BASE, totalPages: tp }).promise.then((r) => {
        order.push(r.input.totalPages);
        return r;
      })
    );
    await waitFor(() => pool.stats().queued === 4);
    await slow;
    const results = await Promise.all(queued);
    assert.deepEqual(order, pages, '等待任务应按先进先出顺序执行');
    results.forEach((r, i) => assert.equal(r.input.totalPages, pages[i]));
    assert.deepEqual(pool.stats(), { workers: 1, running: 0, queued: 0 }, '全部完成后容量应释放');
  } finally {
    pool.close();
  }
});

test('线程池：满载（2 计算中 + 8 等待）时新任务立即以 503 中文原因拒绝', async () => {
  const pool = createImposePool({ workerFile: WORKER, taskTimeoutMs: 5000 });
  try {
    const running = [
      pool.submit({ ...BASE, __delayMs: 300 }).promise,
      pool.submit({ ...BASE, __delayMs: 300 }).promise,
    ];
    const queued = [];
    for (let i = 0; i < 8; i++) queued.push(pool.submit({ ...BASE }).promise);
    await waitFor(() => pool.stats().running === 2 && pool.stats().queued === 8);
    await assert.rejects(pool.submit({ ...BASE }).promise, (err) => {
      assert.equal(err.status, 503);
      assert.match(err.message, /服务繁忙/);
      assert.match(err.message, /队列已满/);
      return true;
    });
    // 被拒绝不影响已在池中的任务
    const all = await Promise.all([...running, ...queued]);
    assert.equal(all.length, 10);
    assert.deepEqual(pool.stats(), { workers: 2, running: 0, queued: 0 });
  } finally {
    pool.close();
  }
});

test('线程池：执行超时返回 504，终止并更换线程，排队任务容量释放后继续', async () => {
  const pool = createImposePool({ workerFile: WORKER, taskTimeoutMs: 200 });
  try {
    // 两个超时任务可能同一节拍 reject，提交后立即挂上断言，避免未处理拒绝
    const t1 = assert.rejects(pool.submit({ ...BASE, __delayMs: 5000 }).promise, (err) => {
      assert.equal(err.status, 504);
      assert.match(err.message, /超时/);
      return true;
    });
    const t2 = assert.rejects(pool.submit({ ...BASE, __delayMs: 5000 }).promise, (err) => {
      assert.equal(err.status, 504);
      return true;
    });
    const q1 = pool.submit({ ...BASE, totalPages: 12 }).promise; // 排队等待容量释放
    const q2 = pool.submit({ ...BASE, totalPages: 16 }).promise;
    await waitFor(() => pool.stats().running === 2 && pool.stats().queued === 2);
    await t1;
    await t2;
    // 超时线程被更换后，排队任务在新线程上完成（容量释放）
    const [r1, r2] = await Promise.all([q1, q2]);
    assert.equal(r1.input.totalPages, 12);
    assert.equal(r2.input.totalPages, 16);
    await waitFor(() => pool.stats().workers === 2);
    assert.deepEqual(pool.stats(), { workers: 2, running: 0, queued: 0 });
  } finally {
    pool.close();
  }
});

test('线程池：线程异常退出时该项 500 并补建线程，其他任务继续', async () => {
  const pool = createImposePool({ workerFile: WORKER, taskTimeoutMs: 5000 });
  try {
    const crash = pool.submit({ ...BASE, __crash: true }).promise;
    const other = pool.submit({ ...BASE, totalPages: 12, __delayMs: 300 }).promise; // 另一线程不受影响
    const queued = pool.submit({ ...BASE, totalPages: 16 }).promise; // 等待补建后的容量
    await assert.rejects(crash, (err) => {
      assert.equal(err.status, 500);
      assert.match(err.message, /异常退出/);
      return true;
    });
    const [rOther, rQueued] = await Promise.all([other, queued]);
    assert.equal(rOther.input.totalPages, 12);
    assert.equal(rQueued.input.totalPages, 16);
    // 线程已补建：线程数恢复，新任务照常执行
    await waitFor(() => pool.stats().workers === 2);
    const again = await pool.submit({ ...BASE, totalPages: 20 }).promise;
    assert.equal(again.input.totalPages, 20);
  } finally {
    pool.close();
  }
});

test('线程池：每项只结算一次，迟到重复消息不串到后续请求（响应归属）', async () => {
  // 单线程池：第一项任务回执后线程会补发一条相同 taskId 的迟到消息，
  // 此时槽位可能已派发第二项任务，迟到消息不得影响其结果
  const pool = createImposePool({ workerFile: WORKER, size: 1, taskTimeoutMs: 5000 });
  try {
    const first = await pool.submit({ ...BASE, totalPages: 8, __echoExtra: true }).promise;
    assert.equal(first.input.totalPages, 8);
    const second = await pool.submit({ ...BASE, totalPages: 20 }).promise;
    assert.equal(second.input.totalPages, 20);
    assert.equal(second.signatureCount, 3); // 20 页 / 每帖 8 页 = 3 帖，确属第二项任务的结果
    await delay(50); // 迟到消息到达窗口内不应再产生任何影响
    assert.deepEqual(pool.stats(), { workers: 1, running: 0, queued: 0 });
  } finally {
    pool.close();
  }
});

test('线程池：取消等待任务释放队列位；取消运行任务终止并补建线程', async () => {
  const pool = createImposePool({ workerFile: WORKER, size: 1, queueLimit: 2, taskTimeoutMs: 10000 });
  try {
    const slow = pool.submit({ ...BASE, __delayMs: 300 }).promise; // 占住唯一线程
    const cancelled = pool.submit({ ...BASE, totalPages: 12 }); // 等待位 1
    const queued = pool.submit({ ...BASE, totalPages: 16 }).promise; // 等待位 2（队满）
    await waitFor(() => pool.stats().queued === 2);
    // 队满时新任务 503；取消一个等待任务后应释放位置
    await assert.rejects(pool.submit({ ...BASE }).promise, (err) => err.status === 503);
    cancelled.cancel();
    await assert.rejects(cancelled.promise, (err) => {
      assert.equal(err.status, 499);
      assert.match(err.message, /客户端已断开/);
      return true;
    });
    assert.equal(pool.stats().queued, 1, '等待任务取消后应立即移出队列');
    const after = await pool.submit({ ...BASE, totalPages: 20 }).promise; // 不再 503
    assert.equal(after.input.totalPages, 20);
    await slow;
    assert.equal((await queued).input.totalPages, 16);

    // 取消运行中的任务：终止并补建线程，后续任务立即在新线程执行
    const running = pool.submit({ ...BASE, __delayMs: 5000 });
    await waitFor(() => pool.stats().running === 1);
    running.cancel();
    await assert.rejects(running.promise, (err) => err.status === 499);
    const t0 = Date.now();
    const next = await pool.submit({ ...BASE, totalPages: 24 }).promise;
    assert.equal(next.input.totalPages, 24);
    assert.ok(Date.now() - t0 < 2000, '取消运行任务后应补建线程立即处理后续任务');
    assert.deepEqual(pool.stats(), { workers: 1, running: 0, queued: 0 });
  } finally {
    pool.close();
  }
});

/* ------------------------------ HTTP 接口行为 ------------------------------ */

test('HTTP：成功结果与参数错误 400 响应同同步版本兼容', async () => {
  const pool = createImposePool({ workerFile: WORKER, taskTimeoutMs: 5000 });
  const srv = await startServer(createApp(pool));
  try {
    const ok = await postJson(`${srv.baseUrl}/api/impose`, BASE);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.input.totalPages, 8);
    assert.equal(ok.body.signatureCount, 1);
    assert.equal(ok.body.signatures.length, 1);

    const bad = await postJson(`${srv.baseUrl}/api/impose`, { ...BASE, totalPages: 0 });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /成品页数必须为/);

    const badBinding = await postJson(`${srv.baseUrl}/api/impose`, { ...BASE, binding: 'top' });
    assert.equal(badBinding.status, 400);
    assert.match(badBinding.body.error, /装订方式/);
  } finally {
    await srv.close();
    pool.close();
  }
});

test('HTTP：满载时新请求返回 503 及中文原因，已在池中的请求不受影响', async () => {
  const pool = createImposePool({ workerFile: WORKER, taskTimeoutMs: 10000 });
  const srv = await startServer(createApp(pool));
  try {
    const pending = [];
    for (let i = 0; i < 10; i++) {
      // 前 2 个占住线程，后 8 个占满等待队列
      pending.push(postJson(`${srv.baseUrl}/api/impose`, { ...BASE, __delayMs: i < 2 ? 500 : 30 }));
    }
    await waitFor(() => pool.stats().running === 2 && pool.stats().queued === 8);
    const rejected = await postJson(`${srv.baseUrl}/api/impose`, BASE);
    assert.equal(rejected.status, 503);
    assert.match(rejected.body.error, /服务繁忙/);
    const results = await Promise.all(pending);
    results.forEach((r) => assert.equal(r.status, 200));
  } finally {
    await srv.close();
    pool.close();
  }
});

test('HTTP：执行超时返回 504，线程终止更换后后续请求正常', async () => {
  const pool = createImposePool({ workerFile: WORKER, taskTimeoutMs: 300 });
  const srv = await startServer(createApp(pool));
  try {
    const slow = await postJson(`${srv.baseUrl}/api/impose`, { ...BASE, __delayMs: 5000 });
    assert.equal(slow.status, 504);
    assert.match(slow.body.error, /超时/);
    // 超时线程已终止并更换：后续请求正常
    const ok = await postJson(`${srv.baseUrl}/api/impose`, { ...BASE, totalPages: 12 });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.input.totalPages, 12);
  } finally {
    await srv.close();
    pool.close();
  }
});

test('HTTP：线程异常退出返回 500，补建线程后后续请求正常', async () => {
  const pool = createImposePool({ workerFile: WORKER, taskTimeoutMs: 5000 });
  const srv = await startServer(createApp(pool));
  try {
    const crashed = await postJson(`${srv.baseUrl}/api/impose`, { ...BASE, __crash: true });
    assert.equal(crashed.status, 500);
    assert.match(crashed.body.error, /异常退出/);
    const ok = await postJson(`${srv.baseUrl}/api/impose`, { ...BASE, totalPages: 12 });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.input.totalPages, 12);
  } finally {
    await srv.close();
    pool.close();
  }
});

test('HTTP：并发请求各自拿到与参数对应的结果（响应归属）', async () => {
  const pool = createImposePool({ workerFile: WORKER, taskTimeoutMs: 5000 });
  const srv = await startServer(createApp(pool));
  try {
    // 10 个请求恰好占满 2 线程 + 8 队列，快慢混合
    const pages = [8, 12, 16, 20, 24, 28, 32, 36, 40, 44];
    const results = await Promise.all(
      pages.map((tp, i) =>
        postJson(`${srv.baseUrl}/api/impose`, { ...BASE, totalPages: tp, __delayMs: i < 2 ? 200 : 0 })
      )
    );
    results.forEach((res, i) => {
      assert.equal(res.status, 200);
      assert.equal(res.body.input.totalPages, pages[i], '响应必须归属到对应请求');
    });
  } finally {
    await srv.close();
    pool.close();
  }
});

test('HTTP：慢任务计算期间首页与健康接口仍可响应', async () => {
  const pool = createImposePool({ workerFile: WORKER, taskTimeoutMs: 10000 });
  const srv = await startServer(createApp(pool));
  try {
    const slow1 = postJson(`${srv.baseUrl}/api/impose`, { ...BASE, __delayMs: 2000 });
    const slow2 = postJson(`${srv.baseUrl}/api/impose`, { ...BASE, __delayMs: 2000 });
    await waitFor(() => pool.stats().running === 2); // 两个线程均已开始忙等计算
    const t0 = Date.now();
    const health = await getJson(`${srv.baseUrl}/api/health`);
    const home = await getText(`${srv.baseUrl}/`);
    const elapsed = Date.now() - t0;
    assert.equal(health.status, 200);
    assert.deepEqual(health.body, { ok: true });
    assert.equal(home.status, 200);
    assert.match(home.text, /骑马钉/);
    assert.ok(elapsed < 1500, `计算期间首页与健康接口应快速响应（实际 ${elapsed}ms）`);
    const results = await Promise.all([slow1, slow2]);
    results.forEach((r) => assert.equal(r.status, 200));
  } finally {
    await srv.close();
    pool.close();
  }
});

test('HTTP：客户端断开时移除等待任务、终止运行任务并补建线程', async () => {
  const pool = createImposePool({ workerFile: WORKER, size: 1, queueLimit: 1, taskTimeoutMs: 10000 });
  const srv = await startServer(createApp(pool));
  try {
    // 运行中的慢任务（随后断开）
    const running = postRaw(`${srv.baseUrl}/api/impose`, { ...BASE, __delayMs: 5000 });
    await waitFor(() => pool.stats().running === 1);
    // 等待任务（随后断开）
    const queuedReq = postRaw(`${srv.baseUrl}/api/impose`, { ...BASE, totalPages: 12 });
    await waitFor(() => pool.stats().queued === 1);

    // 断开等待任务 -> 从队列移除（容量释放）
    queuedReq.req.destroy(new Error('客户端主动断开'));
    await assert.rejects(queuedReq.response);
    await waitFor(() => pool.stats().queued === 0, { timeoutMs: 2000 });

    // 断开运行任务 -> 终止并补建线程
    running.req.destroy(new Error('客户端主动断开'));
    await assert.rejects(running.response);

    // 补建完成后新请求立即被处理（若旧线程仍在跑 5 秒慢任务则会长时间排队）
    const t0 = Date.now();
    const ok = await postJson(`${srv.baseUrl}/api/impose`, { ...BASE, totalPages: 16 });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.input.totalPages, 16);
    assert.ok(Date.now() - t0 < 2000, '运行任务断开后应终止并补建线程处理新请求');
    assert.deepEqual(pool.stats(), { workers: 1, running: 0, queued: 0 });
  } finally {
    await srv.close();
    pool.close();
  }
});
