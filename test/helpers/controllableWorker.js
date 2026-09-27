'use strict';

/**
 * 测试用可控工作线程：在 computeImposition 之上识别以下划线开头的测试字段
 * （计算前剥离，不影响正式参数校验与结果）：
 * - __delayMs:   忙等指定毫秒数，模拟 CPU 密集型慢任务（可控慢任务）；
 * - __crash:     以非零码 process.exit，模拟线程异常退出（不发回任何消息）；
 * - __echoExtra: 正常回执后再补发一条相同 taskId 的迟到重复消息，
 *                验证主线程「每项只结算一次、迟到消息不串到后续请求」。
 *
 * 该文件只在测试中使用（.dockerignore 已排除 test/）。被 node --test 直接
 * 加载时 parentPort 为 null，守卫后为空操作。
 */

const { parentPort } = require('worker_threads');
const { computeImposition } = require('../../src/imposition');

if (parentPort) {
  parentPort.on('message', (msg) => {
    const { taskId, input } = msg || {};
    const { __delayMs, __crash, __echoExtra, ...clean } = input || {};
    if (__delayMs) {
      const end = Date.now() + __delayMs;
      while (Date.now() < end) {
        /* 忙等，模拟重计算占满该线程 */
      }
    }
    if (__crash) {
      process.exit(2); // 仅退出当前 worker 线程，模拟异常退出
    }
    try {
      const result = computeImposition(clean);
      parentPort.postMessage({ taskId, ok: true, result });
      if (__echoExtra) {
        setTimeout(() => parentPort.postMessage({ taskId, ok: true, result }), 10);
      }
    } catch (err) {
      parentPort.postMessage({ taskId, ok: false, error: err.message });
    }
  });
}
