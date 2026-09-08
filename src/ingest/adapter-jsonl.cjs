/**
 * @module ingest/adapter-jsonl
 * @layer ingest
 * @owner kou
 * JSONL / report 目录扫描适配器：复用 file-tail 的 inode 安全 tail，
 * 语义差别在于每行是一段 JSON（TraceEvent 或 agent report）。
 */

'use strict';

const FileTailAdapter = require('./adapter-file-tail.cjs');

class JsonlAdapter extends FileTailAdapter {
  static kind = 'jsonl';

  constructor(opts = {}) {
    super(Object.assign({ kind: 'jsonl', pollMs: 2000 }, opts));
  }
}

module.exports = JsonlAdapter;
