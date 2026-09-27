'use strict';

/**
 * /api/impose 计算工作线程。
 *
 * 接收主线程投递的 { taskId, input }，复用 computeImposition 同步计算，
 * 回执 { taskId, ok, result | error }：
 * - ok: true  -> 计算成功，主线程转为 200 JSON 响应；
 * - ok: false -> computeImposition 抛出的参数校验错误（中文信息），主线程转为 400。
 *
 * 回执始终携带 taskId，主线程据此把结果归属到对应请求，迟到 / 重复消息一律忽略。
 */

const { parentPort } = require('worker_threads');
const { computeImposition } = require('./imposition');

parentPort.on('message', (msg) => {
  const { taskId, input } = msg || {};
  try {
    const result = computeImposition(input || {});
    parentPort.postMessage({ taskId, ok: true, result });
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    parentPort.postMessage({ taskId, ok: false, error: message });
  }
});
