'use strict';

/**
 * /api/impose 计算线程池（worker_threads 有界线程池）。
 *
 * 模型（默认值即生产配置，均可通过 options 覆盖以便测试）：
 * - 固定 size 个工作线程（默认 2），每个线程同一时刻只执行 1 项任务；
 * - 等待队列 FIFO，最多 queueLimit 项（默认 8）；全部线程忙且队列已满时，
 *   新任务立即以 503（中文原因）拒绝；
 * - 每项任务从「开始执行」（线程就绪并接收任务）起计时，超过 taskTimeoutMs
 *   （默认 5000ms）以 504 结算，并终止、更换该线程；
 * - 线程意外退出时，在跑任务以 500 结算，随即补建线程，其余任务继续；
 * - 每项任务只结算一次；线程回执携带任务 id，仅当与槽位当前任务匹配时才生效，
 *   迟到 / 重复 / 串线消息一律忽略，不会串到后续请求；
 * - cancel()（客户端断开）：等待中的任务直接从队列移除；运行中的任务结算取消，
 *   并终止、更换该线程。
 *
 * submit(input) 返回 { promise, cancel }：promise 成功值为拼版结果；
 * 失败值为带 status 属性的 Error（400 参数错误 / 503 满载 / 504 超时 /
 * 500 线程异常退出 / 499 客户端断开取消）。
 */

const path = require('path');
const { Worker } = require('worker_threads');

const DEFAULTS = {
  size: 2, // 固定工作线程数
  queueLimit: 8, // FIFO 等待任务上限
  taskTimeoutMs: 5000, // 单项执行超时（从开始执行计时）
  workerFile: path.join(__dirname, 'imposeWorker.js'),
};

function createImposePool(options = {}) {
  const config = { ...DEFAULTS, ...options };
  const queue = []; // FIFO 等待任务
  const slots = []; // 工作线程槽位 { worker, task, timer, retired }
  let nextTaskId = 1;
  let closed = false;

  /** 结算任务（每项只结算一次，重复调用为无操作）。 */
  function settleTask(task, outcome) {
    if (task.settled) return;
    task.settled = true;
    if (outcome.ok) {
      task.resolve(outcome.result);
    } else {
      const err = new Error(outcome.error);
      err.status = outcome.status;
      task.reject(err);
    }
  }

  /** 把槽位当前任务按 outcome 结算并释放槽位（不动线程本身）。 */
  function finishSlotTask(slot, outcome) {
    const task = slot.task;
    if (!task) return;
    slot.task = null;
    if (slot.timer) {
      clearTimeout(slot.timer);
      slot.timer = null;
    }
    // 线程回到空闲：不再阻止进程退出（与 runOn 中的 ref 对应）
    if (slot.worker) slot.worker.unref();
    settleTask(task, outcome);
  }

  /** 终止槽位线程并补建一个新线程（超时 / 取消 / 主动更换）。 */
  function retireSlot(slot) {
    if (slot.retired) return;
    slot.retired = true;
    const idx = slots.indexOf(slot);
    if (idx >= 0) slots.splice(idx, 1);
    if (slot.timer) {
      clearTimeout(slot.timer);
      slot.timer = null;
    }
    const worker = slot.worker;
    slot.worker = null;
    if (worker) {
      worker.removeAllListeners(); // terminate 后的 exit 不再触发补建逻辑
      worker.terminate();
    }
    if (!closed) spawnSlot();
  }

  function spawnSlot() {
    const slot = { worker: null, task: null, timer: null, retired: false, online: false };
    const worker = new Worker(config.workerFile);
    slot.worker = worker;

    worker.on('online', () => {
      // 线程就绪（开始执行）：若任务已派发在等待，超时从此时起算
      slot.online = true;
      if (slot.task && !slot.timer) startTimer(slot);
    });

    worker.on('message', (msg) => {
      const task = slot.task;
      // 响应归属：仅接受槽位当前在跑任务的回执；迟到 / 重复 / 串线消息一律忽略
      if (!task || !msg || msg.taskId !== task.id) return;
      finishSlotTask(
        slot,
        msg.ok
          ? { ok: true, result: msg.result }
          : { ok: false, status: 400, error: msg.error }
      );
      pump();
    });

    worker.on('error', () => {
      // 未捕获异常随后必触发 'exit'，统一在 'exit' 中结算与补建
    });

    worker.on('exit', () => {
      if (slot.retired) return; // 主动更换已在 retireSlot 中处理
      slot.retired = true;
      const idx = slots.indexOf(slot);
      if (idx >= 0) slots.splice(idx, 1);
      if (slot.timer) {
        clearTimeout(slot.timer);
        slot.timer = null;
      }
      slot.worker = null;
      // 线程意外退出：在跑任务 500，补建线程，其余任务继续
      finishSlotTask(slot, { ok: false, status: 500, error: '计算线程异常退出，请稍后重试' });
      if (!closed) spawnSlot();
      pump();
    });

    // 不单独阻止进程退出（服务关闭 / 测试结束时随主线程退出）。
    // 注意必须在挂完 'message' 监听之后再 unref：挂监听会把内部 MessagePort
    // 重新 ref，顺序颠倒会导致进程无法自然退出。
    worker.unref();
    slots.push(slot);
    return slot;
  }

  /** 把队列中的等待任务按 FIFO 派发给空闲线程。 */
  function pump() {
    if (closed) return;
    for (const slot of slots) {
      while (queue.length > 0 && !slot.task && !slot.retired) {
        const task = queue.shift();
        if (!task.settled) runOn(slot, task);
      }
    }
  }

  /** 启动槽位当前任务的超时计时（从线程就绪、开始执行起算）。 */
  function startTimer(slot) {
    slot.timer = setTimeout(() => {
      slot.timer = null;
      // 超时：504 结算并终止、更换该线程
      finishSlotTask(slot, {
        ok: false,
        status: 504,
        error: `计算超时（超过 ${config.taskTimeoutMs / 1000} 秒），已终止该任务`,
      });
      retireSlot(slot);
      pump();
    }, config.taskTimeoutMs);
    slot.timer.unref();
  }

  /** 在指定槽位派发任务；已就绪线程立即计时，新建线程待 'online' 后起算。 */
  function runOn(slot, task) {
    task.state = 'running';
    slot.task = task;
    // 任务在跑期间线程保持引用，保证事件循环存活到结算；空闲时再 unref
    slot.worker.ref();
    if (slot.online) startTimer(slot);
    slot.worker.postMessage({ taskId: task.id, input: task.input });
  }

  /**
   * 提交一项计算任务。
   * @returns {{ promise: Promise<object>, cancel: () => void }}
   */
  function submit(input) {
    let task;
    const promise = new Promise((resolve, reject) => {
      task = { id: nextTaskId++, input, state: 'queued', settled: false, resolve, reject };
    });
    if (closed) {
      settleTask(task, { ok: false, status: 503, error: '计算服务已关闭，请稍后重试' });
      return { promise, cancel() {} };
    }
    const idle = slots.find((s) => !s.task && !s.retired);
    if (idle) {
      runOn(idle, task);
    } else if (queue.length < config.queueLimit) {
      queue.push(task);
    } else {
      settleTask(task, {
        ok: false,
        status: 503,
        error: `服务繁忙：${config.size} 项计算中、等待队列已满（${config.queueLimit} 项），请稍后重试`,
      });
    }
    return {
      promise,
      /** 客户端断开：等待中的任务移出队列；运行中的任务结算取消并终止、更换线程。 */
      cancel() {
        if (task.settled) return;
        if (task.state !== 'running') {
          const idx = queue.indexOf(task);
          if (idx >= 0) queue.splice(idx, 1);
          settleTask(task, { ok: false, status: 499, error: '客户端已断开，等待中的任务已取消' });
          return;
        }
        const slot = slots.find((s) => s.task === task);
        if (slot) {
          finishSlotTask(slot, { ok: false, status: 499, error: '客户端已断开，计算任务已取消' });
          retireSlot(slot);
          pump();
        }
      },
    };
  }

  /** 终止全部线程并清空队列（服务 / 测试收尾用；未结算任务不再结算）。 */
  function close() {
    closed = true;
    for (const slot of slots.splice(0)) {
      slot.retired = true;
      if (slot.timer) clearTimeout(slot.timer);
      const worker = slot.worker;
      slot.worker = null;
      if (worker) {
        worker.removeAllListeners();
        worker.terminate();
      }
    }
    queue.length = 0;
  }

  /** 当前容量视图（测试与排障用）。 */
  function stats() {
    return {
      workers: slots.length,
      running: slots.filter((s) => s.task).length,
      queued: queue.length,
    };
  }

  for (let i = 0; i < config.size; i++) spawnSlot();

  return { submit, close, stats };
}

module.exports = { createImposePool };
