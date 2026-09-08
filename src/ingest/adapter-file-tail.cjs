/**
 * @module ingest/adapter-file-tail
 * @layer ingest
 * @owner kou
 * inode 安全的文件 tail：记录 dev+ino，文件被轮转/重建时回到 offset 0；
 * 游标持久化在 state/cursors.json，只推进到最后一个完整换行处（半行留待下次）。
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Adapter } = require('./adapter-base.cjs');
const fsx = require('../util/fsx.cjs');
const state = require('../store/state.cjs');
const log = require('../util/log.cjs').createLogger('ingest.file-tail');

const CHUNK = 64 * 1024;

class FileTailAdapter extends Adapter {
  static kind = 'file-tail';

  /**
   * @param {{kind?: string, path?: string, glob?: string, pollMs?: number, agent?: string}} opts
   */
  constructor(opts = {}) {
    super(Object.assign({ kind: 'file-tail' }, opts));
    this.pattern = opts.glob || opts.path || '';
    /** @type {Map<string, string>} 文件 -> 未完成的半行 */
    this.pending = new Map();
    this.seenBytes = 0;
    this.emitted = 0;
  }

  /**
   * 展开待监听文件列表。
   * @returns {string[]}
   */
  files() {
    return fsx.expandGlob(this.pattern);
  }

  /**
   * 游标键。
   * @param {string} file
   * @returns {string}
   */
  cursorKey(file) {
    return `${this.agent}:${this.kind}:${file}`;
  }

  /**
   * 拉取增量。
   * @returns {Promise<number>} emit 条数
   */
  async poll() {
    if (!this.emit) return 0;
    const files = this.files();
    if (files.length === 0) {
      this.lastError = `无匹配文件：${this.pattern}`;
      return 0;
    }
    let n = 0;
    for (const file of files) n += this.readFile(file);
    this.emitted += n;
    return n;
  }

  /**
   * 读取单个文件的增量。
   * @param {string} file
   * @returns {number} emit 条数
   */
  readFile(file) {
    const st = fsx.statSafe(file);
    if (!st) return 0;
    const key = this.cursorKey(file);
    const cur = state.getCursor(key) || { offset: 0, inode: '', line: 0 };
    const inode = `${st.dev}:${st.ino}`;
    // 轮转/重建检测：inode 变化或文件被截断 -> 游标归零
    let offset = 0;
    let lineNo = 0;
    if (cur.inode === inode && Number.isFinite(cur.offset) && st.size >= cur.offset) {
      offset = cur.offset;
      lineNo = cur.line || 0;
    } else {
      this.pending.delete(file);
      if (cur.inode && cur.inode !== inode) {
        log.info('检测到文件轮转，游标归零', { file, from: cur.inode, to: inode });
      }
    }
    if (st.size <= offset) return 0;

    const fd = fs.openSync(file, 'r');
    let emitted = 0;
    try {
      let pos = offset;
      const buf = Buffer.alloc(CHUNK);
      // 注意：游标已回退到「未完成的半行」起始处，因此这里必须以空串开始，
      // 不能再拼接上一次的 pending，否则半行会被重复拼一次。
      let carry = '';
      while (pos < st.size) {
        const want = Math.min(CHUNK, st.size - pos);
        const read = fs.readSync(fd, buf, 0, want, pos);
        if (read <= 0) break;
        carry += buf.slice(0, read).toString('utf8');
        pos += read;
        let idx;
        let last = 0;
        while ((idx = carry.indexOf('\n', last)) >= 0) {
          const raw = carry.slice(last, idx).replace(/\r$/, '');
          last = idx + 1;
          lineNo += 1;
          if (raw.trim().length > 0) {
            this.emit({ text: raw, path: file, line: lineNo, meta: { mtime: st.mtimeMs } });
            emitted += 1;
          }
        }
        carry = carry.slice(last);
      }
      // 只推进到最后一个完整换行处，半行留待下次
      const newOffset = pos - carry.length;
      if (carry.length > 0) this.pending.set(file, carry);
      else this.pending.delete(file);
      this.seenBytes += Math.max(0, newOffset - offset);
      state.setCursor(key, {
        path: file,
        offset: newOffset,
        inode,
        mtime: st.mtimeMs,
        line: lineNo
      });
    } finally {
      fs.closeSync(fd);
    }
    return emitted;
  }

  /**
   * @returns {Promise<{ok: boolean, detail: Object}>}
   */
  async health() {
    const files = this.files();
    return {
      ok: files.length > 0 && !this.lastError,
      detail: {
        kind: this.kind,
        pattern: this.pattern,
        files: files.map((f) => path.basename(f)),
        emitted: this.emitted,
        lastError: this.lastError
      }
    };
  }
}

module.exports = FileTailAdapter;
