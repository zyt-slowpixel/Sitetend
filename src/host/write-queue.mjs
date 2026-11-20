// @ts-check
// Serializes every write in the host: UI, chat, MCP and the file watcher all go through here.
// Reads do not queue. A failing task never blocks the tasks behind it.
export class WriteQueue {
  constructor() { this._tail = Promise.resolve(); this.pending = 0; this.running = null; }
  /**
   * @template T
   * @param {string} label  shown in status while running
   * @param {() => Promise<T>} task
   * @returns {Promise<T>}
   */
  run(label, task) {
    this.pending++;
    const result = this._tail.then(async () => {
      this.running = label;
      try { return await task(); } finally { this.running = null; this.pending--; }
    });
    this._tail = result.catch(() => {});
    return result;
  }
  get idle() { return this.pending === 0; }
}
