'use strict';

/**
 * 拼版计算工作线程入口（由 src/impositionPool.js 以 worker_threads 启动）。
 *
 * 协议：
 * - 启动完成后向主线程发送 { type: 'ready' }；
 * - 接收 { id, input }，同步执行 computeImposition：
 *     成功 -> 回发 { type: 'result', id, result }
 *     参数错误等业务异常 -> 回发 { type: 'error', id, message }（主线程映射为 400）。
 *
 * 测试钩子（仅当主线程以 IMPOSITION_TEST_HOOKS=1 启动时经 workerData 开启）：
 * - input.__testSlowMs：正整数，计算前先忙等该毫秒数（模拟可控慢任务；
 *   忙等期间本线程无法处理其他消息，用于验证超时终止与首页 / 健康接口可响应）；
 * - input.__testExitWorker：'before' 计算前退出进程，'after' 计算完成后、回发结果前退出
 *   （模拟线程意外退出，用于验证 500 与补建线程）。
 * 两个钩子字段在送入 computeImposition 前剔除，不影响计算与校验。
 */

const { parentPort, workerData } = require('worker_threads');
const { computeImposition } = require('./imposition');

const testHooksEnabled = Boolean(workerData && workerData.testHooks);

/** 忙等 ms 毫秒（独占本线程，不依赖定时器精度）。 */
function busyWait(ms) {
  const sab = new SharedArrayBuffer(4);
  const view = new Int32Array(sab);
  Atomics.wait(view, 0, 0, ms);
}

parentPort.on('message', (msg) => {
  if (!msg || typeof msg.id !== 'number') return;
  const { id } = msg;
  const input = (msg.input && typeof msg.input === 'object') ? { ...msg.input } : {};

  let slowMs = 0;
  let exitWorker = null;
  if (testHooksEnabled) {
    if (Number.isInteger(input.__testSlowMs) && input.__testSlowMs > 0) {
      slowMs = input.__testSlowMs;
    }
    if (input.__testExitWorker === 'before' || input.__testExitWorker === 'after') {
      exitWorker = input.__testExitWorker;
    }
  }
  delete input.__testSlowMs;
  delete input.__testExitWorker;

  try {
    if (slowMs > 0) busyWait(slowMs);
    if (exitWorker === 'before') process.exit(1);
    const result = computeImposition(input);
    if (exitWorker === 'after') process.exit(1);
    parentPort.postMessage({ type: 'result', id, result });
  } catch (err) {
    parentPort.postMessage({ type: 'error', id, message: (err && err.message) || String(err) });
  }
});

parentPort.postMessage({ type: 'ready' });
