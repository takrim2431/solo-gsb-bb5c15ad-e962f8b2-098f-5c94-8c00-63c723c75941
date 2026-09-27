'use strict';

/**
 * 拼版计算有界线程池（worker_threads）。
 *
 * 容量模型（固定）：
 * - WORKER_COUNT = 2 个工作线程，每个线程同一时刻只执行 1 项任务；
 * - 另有 QUEUE_CAPACITY = 8 项先进先出（FIFO）等待任务；
 * - 同时容纳上限 = 2 + 8 = 10 项，满载时新任务立即以 { status: 'rejected' } 拒绝
 *   （由 server.js 映射为 503 与中文原因）。
 *
 * 任务语义：
 * - 每项任务从「开始执行」（派发给工作线程）起计时，超过 timeoutMs（默认 5000ms）
 *   以 { status: 'timeout' } 结算（映射 504），并终止、更换该工作线程；
 * - 工作线程意外退出时，其当前任务以 { status: 'crashed' } 结算（映射 500），
 *   并补建线程；其他线程上的任务与等待队列不受影响；
 * - 每项任务只结算一次：工作线程消息按任务 id 校验，迟到 / 串号消息一律忽略，
 *   不会串到后续任务；
 * - cancel()：任务仍在等待队列时将其移除（释放容量）；已在执行时终止并补建
 *   该工作线程。被取消的任务以 { status: 'cancelled' } 结算，调用方不应再响应。
 *
 * 线程就绪握手：每个工作线程启动后须先回发 ready，就绪前不派发任务；
 * 池的 ready 在全部初始线程就绪后兑现。所有线程 unref，不阻止进程退出。
 */

const path = require('path');
const { Worker } = require('worker_threads');

const WORKER_COUNT = 2;
const QUEUE_CAPACITY = 8;
const DEFAULT_TIMEOUT_MS = 5000;

const WORKER_SCRIPT = path.join(__dirname, 'impositionWorker.js');

class ImpositionPool {
  /**
   * @param {object} [options]
   * @param {number} [options.timeoutMs] 单项任务执行超时（毫秒），缺省 5000
   * @param {boolean} [options.testHooks] 是否向工作线程开启测试钩子（__testSlowMs / __testExitWorker）
   */
  constructor(options = {}) {
    this.timeoutMs = (Number.isInteger(options.timeoutMs) && options.timeoutMs > 0)
      ? options.timeoutMs
      : DEFAULT_TIMEOUT_MS;
    this.testHooks = Boolean(options.testHooks);

    /** @type {Array<{worker: import('worker_threads').Worker|null, ready: boolean, task: object|null}>} */
    this.slots = [];
    /** @type {Array<object>} FIFO 等待队列 */
    this.queue = [];
    this.nextTaskId = 1;
    this.closed = false;

    const initialReady = [];
    for (let i = 0; i < WORKER_COUNT; i += 1) {
      const slot = { worker: null, ready: false, task: null };
      this.slots.push(slot);
      initialReady.push(this._spawnWorkerUntilReady(slot));
    }
    /** 全部初始工作线程就绪后兑现。 */
    this.ready = Promise.all(initialReady).then(() => undefined);
  }

  /**
   * 提交一项计算任务。
   * @param {object} input 拼版计算入参（computeImposition 的请求体）
   * @returns {{ promise: Promise<object>, cancel: () => boolean }}
   *   promise 以 { status: 'ok', result } / { status: 'invalid', message } /
   *   { status: 'timeout' } / { status: 'crashed' } / { status: 'cancelled' } /
   *   { status: 'rejected' } 之一兑现（不 reject）；cancel 取消任务，返回是否取消成功。
   */
  submit(input) {
    if (this.closed || this._activeCount() >= WORKER_COUNT + QUEUE_CAPACITY) {
      return { promise: Promise.resolve({ status: 'rejected' }), cancel: () => false };
    }
    let task;
    const promise = new Promise((resolve) => {
      task = {
        id: this.nextTaskId,
        input,
        state: 'queued',
        slot: null,
        timer: null,
        resolve,
      };
    });
    this.nextTaskId += 1;
    this.queue.push(task);
    this._pump();
    return { promise, cancel: () => this._cancel(task) };
  }

  /** 关闭线程池：清空等待队列并终止全部工作线程（用于服务关停）。 */
  async close() {
    this.closed = true;
    const queued = this.queue.splice(0);
    for (const task of queued) task.resolve({ status: 'cancelled' });
    const workers = this.slots.map((s) => s.worker).filter(Boolean);
    await Promise.all(workers.map((w) => w.terminate().catch(() => {})));
  }

  /** 当前占用容量（执行中 + 等待中）。 */
  _activeCount() {
    let running = 0;
    for (const slot of this.slots) if (slot.task) running += 1;
    return running + this.queue.length;
  }

  /** 把等待队列头部的任务派发给空闲且已就绪的线程（FIFO）。 */
  _pump() {
    if (this.closed) return;
    for (const slot of this.slots) {
      if (this.queue.length === 0) return;
      if (slot.task || !slot.ready || !slot.worker) continue;
      const task = this.queue.shift();
      task.state = 'running';
      task.slot = slot;
      slot.task = task;
      // 执行计时从派发（开始执行）起算
      task.timer = setTimeout(() => this._onTimeout(slot, task), this.timeoutMs);
      if (typeof task.timer.unref === 'function') task.timer.unref();
      slot.worker.postMessage({ id: task.id, input: task.input });
    }
  }

  /**
   * 终止并更换槽位上的工作线程（超时 / 运行中取消 / 线程退出后补建共用）。
   * 旧线程的迟到消息因槽位已换新线程而被忽略，不会串到后续任务。
   */
  _killAndReplace(slot) {
    const worker = slot.worker;
    slot.worker = null;
    slot.ready = false;
    if (worker) worker.terminate().catch(() => {});
    this._spawnWorkerUntilReady(slot);
  }

  /** 为槽位补建线程直至就绪（启动即退出的线程自动重试），就绪后尝试派发。 */
  _spawnWorkerUntilReady(slot) {
    if (this.closed) return Promise.resolve();
    return new Promise((resolve) => {
      const spawn = () => {
        if (this.closed) { resolve(); return; }
        const worker = new Worker(WORKER_SCRIPT, {
          workerData: { testHooks: this.testHooks },
        });
        // 就绪握手后 unref（此时消息端口已创建，unref 才真正生效），
        // 使线程池不阻止进程退出（如测试进程结束）
        slot.worker = worker;
        slot.ready = false;

        const onReadyMessage = (msg) => {
          if (msg && msg.type === 'ready') {
            worker.unref();
            slot.ready = true;
            worker.off('message', onReadyMessage);
            resolve();
            this._pump();
          }
        };
        worker.on('message', onReadyMessage);

        worker.on('message', (msg) => this._onWorkerMessage(slot, worker, msg));
        worker.on('error', (err) => this._onWorkerError(slot, worker, err));
        worker.on('exit', (code) => this._onWorkerExit(slot, worker, code, spawn));
      };
      spawn();
    });
  }

  _onWorkerMessage(slot, worker, msg) {
    if (!msg || slot.worker !== worker) return; // 已更换线程：迟到消息忽略
    if (msg.type !== 'result' && msg.type !== 'error') return; // ready 等控制消息
    const task = slot.task;
    if (!task || task.id !== msg.id) return; // 串号 / 迟到消息：忽略，绝不结算后续任务
    this._finishSlot(slot, task);
    if (msg.type === 'result') {
      task.resolve({ status: 'ok', result: msg.result });
    } else {
      task.resolve({ status: 'invalid', message: msg.message });
    }
    this._pump();
  }

  _onWorkerError(slot, worker, err) {
    if (slot.worker !== worker) return;
    // 线程级错误：exit 事件随后由 _onWorkerExit 统一结算与补建，这里仅记录。
    console.error(`拼版工作线程错误: ${(err && err.message) || err}`);
  }

  _onWorkerExit(slot, worker, code, respawn) {
    if (slot.worker !== worker) return; // 已被更换的旧线程退出：忽略
    slot.worker = null;
    slot.ready = false;
    const task = slot.task;
    if (task) {
      // 线程意外退出：当前任务记 500，只结算一次
      this._finishSlot(slot, task);
      task.resolve({ status: 'crashed' });
    }
    if (!this.closed) respawn(); // 补建线程，其他任务继续
  }

  _onTimeout(slot, task) {
    if (slot.task !== task) return; // 已结算（防御）
    this._finishSlot(slot, task);
    task.resolve({ status: 'timeout' });
    this._killAndReplace(slot); // 终止并更换该线程
  }

  /**
   * 取消任务：等待中 -> 移出队列（释放容量）；执行中 -> 终止并补建线程。
   * @returns {boolean} 是否取消成功（已结算的任务返回 false）
   */
  _cancel(task) {
    if (task.state === 'queued') {
      const index = this.queue.indexOf(task);
      if (index === -1) return false;
      this.queue.splice(index, 1);
      task.state = 'done';
      task.resolve({ status: 'cancelled' });
      return true;
    }
    if (task.state === 'running') {
      const slot = task.slot;
      this._finishSlot(slot, task);
      task.resolve({ status: 'cancelled' });
      this._killAndReplace(slot);
      return true;
    }
    return false;
  }

  /** 任务离开槽位：清计时器、置状态、腾空槽位（保证每项只结算一次）。 */
  _finishSlot(slot, task) {
    if (task.timer) {
      clearTimeout(task.timer);
      task.timer = null;
    }
    task.state = 'done';
    if (slot && slot.task === task) slot.task = null;
  }
}

/**
 * 创建拼版计算线程池。
 * @param {object} [options] 见 ImpositionPool 构造函数
 * @returns {ImpositionPool}
 */
function createImpositionPool(options) {
  return new ImpositionPool(options);
}

module.exports = {
  createImpositionPool,
  ImpositionPool,
  WORKER_COUNT,
  QUEUE_CAPACITY,
  DEFAULT_TIMEOUT_MS,
};
