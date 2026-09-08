/**
 * @module snapshot
 * @layer L1 数据层（快照 + 字节级回滚）
 * @owner Kou（工程师，K1）
 *
 * 规范 §4 快照与回滚：每次写入前快照；回滚 = 字节级还原。
 * 实现：
 *  - 快照把目标文件的原始字节复制到 runtime/snapshots/<id>/ 下
 *  - 清单 manifest.jsonl 记录 { id, version, ts, files:[{abs, rel, hash, backup, existed}] }
 *  - 回滚：existed=true → 备份字节原样拷回；existed=false（写入时新建的文件）→ 删除该文件
 *  - 版本号：知识面版本从 v1.0.0 起，每次成功热写后 patch +1（v1.0.0 → v1.0.1）
 *  - 回滚成功后版本号退回快照版本
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { KernelError, sha256hex, readJsonl, writeJsonl, appendJsonl, genId, nowIso } = require('./util.cjs');

/** 版本号格式校验 */
const VERSION_RE = /^v(\d+)\.(\d+)\.(\d+)$/;

/** patch +1 */
function bumpPatch(version) {
  const m = VERSION_RE.exec(version);
  if (!m) {
    throw new KernelError('SNAPSHOT_INVALID_VERSION', `非法版本号: ${version}`, { version });
  }
  return `v${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

/**
 * 创建快照管理器
 * @param {object} opts
 * @param {string} [opts.dataDir='runtime']
 */
function createSnapshotManager({ dataDir = 'runtime' } = {}) {
  const dir = path.join(dataDir, 'snapshots');
  const manifestFile = path.join(dir, 'manifest.jsonl');
  const entries = readJsonl(manifestFile);
  // 重建当前版本：跳过被回滚吞掉的条目；回滚标记行直接给定版本；快照条目按 version_after 推进
  let currentVersion = 'v1.0.0';
  for (const e of entries) {
    if (e.rolled_back) continue;
    if (e.type === 'rollback_marker') {
      currentVersion = e.version;
      continue;
    }
    if (e.version_after) currentVersion = e.version_after;
  }

  /** 当前知识面版本 */
  function getVersion() {
    return currentVersion;
  }

  /** 手动设版本（测试/恢复用，校验格式） */
  function setVersion(v) {
    if (!VERSION_RE.test(v)) {
      throw new KernelError('SNAPSHOT_INVALID_VERSION', `非法版本号: ${v}`, { v });
    }
    currentVersion = v;
    return currentVersion;
  }

  /**
   * 对一组绝对路径做快照（写入前调用）
   * @param {string[]} absPaths
   * @returns {object} 快照记录
   */
  function snapshot(absPaths) {
    const id = genId('SNAP');
    const backupDir = path.join(dir, id);
    fs.mkdirSync(backupDir, { recursive: true });
    const files = absPaths.map((abs, i) => {
      const existed = fs.existsSync(abs);
      if (!existed) {
        return { abs, rel: path.basename(abs), hash: null, backup: null, existed: false };
      }
      const backup = path.join(backupDir, `file-${i}${path.extname(abs) || '.bin'}`);
      fs.copyFileSync(abs, backup); // 字节级复制
      const hash = sha256hex(fs.readFileSync(abs));
      return { abs, rel: path.basename(abs), hash, backup, existed: true };
    });
    const rec = {
      id,
      version: currentVersion, // 快照保存的是"当前版本"的字节态，回滚即回到此版本
      version_after: null,
      ts: nowIso(),
      files,
    };
    entries.push(rec);
    appendJsonl(manifestFile, rec);
    return rec;
  }

  /** 写入成功后调用：patch +1 并回填快照的 version_after（snapshotId 为 null 时只推进版本，无快照可回填） */
  function commitVersion(snapshotId) {
    if (snapshotId == null) {
      currentVersion = bumpPatch(currentVersion);
      return currentVersion;
    }
    const rec = entries.find((x) => x.id === snapshotId);
    if (!rec) {
      throw new KernelError('SNAPSHOT_NOT_FOUND', `快照不存在: ${snapshotId}`, { snapshotId });
    }
    currentVersion = bumpPatch(currentVersion);
    rec.version_after = currentVersion;
    // manifest 为 append-only + 尾部修正：整体重写一次（原型规模）
    const { writeJsonl } = require('./util.cjs');
    writeJsonl(manifestFile, entries);
    return currentVersion;
  }

  /** 按 ID 取快照 */
  function get(snapshotId) {
    return entries.find((x) => x.id === snapshotId) || null;
  }

  /** 全部快照 */
  function list() {
    return entries.slice();
  }

  /**
   * 字节级回滚到指定快照：
   *  - existed=true 的文件：备份字节原样拷回（任何多余字节都被覆盖）
   *  - existed=false 的文件（快照时不存在）：删除（还原"不存在"这个状态）
   * 元数据修正（BUG-2 修复）：同步重写 manifest——被回滚吞掉的后续条目标记
   * rolled_back，并追加 rollback_marker 行记录回滚后版本，保证重建 manager
   * 后 getVersion() 与实际字节态一致（不再返回已被回滚掉的高版本号）。
   * @param {string} snapshotId
   * @returns {{ok: boolean, restored: string[], removed: string[], version: string}}
   */
  function rollback(snapshotId) {
    const rec = get(snapshotId);
    if (!rec || rec.type === 'rollback_marker') {
      throw new KernelError('SNAPSHOT_NOT_FOUND', `快照不存在: ${snapshotId}`, { snapshotId });
    }
    const restored = [];
    const removed = [];
    for (const f of rec.files) {
      if (f.existed) {
        fs.mkdirSync(path.dirname(f.abs), { recursive: true });
        fs.copyFileSync(f.backup, f.abs); // 字节级还原
        restored.push(f.abs);
      } else if (fs.existsSync(f.abs)) {
        fs.unlinkSync(f.abs);
        removed.push(f.abs);
      }
    }
    // 标记回滚点之后的条目为 rolled_back（幂等：已标记的跳过）
    let passed = false;
    for (const e of entries) {
      if (e.type === 'rollback_marker') continue;
      if (e.id === snapshotId) {
        passed = true;
        continue;
      }
      if (passed && !e.rolled_back) e.rolled_back = true;
    }
    // 追加回滚标记行（重建时据此恢复版本），并整体重写 manifest
    entries.push({ id: genId('RB'), type: 'rollback_marker', version: rec.version, ts: nowIso() });
    writeJsonl(manifestFile, entries);
    currentVersion = rec.version; // 版本退回快照版本
    return { ok: true, restored, removed, version: currentVersion };
  }

  return { snapshot, commitVersion, rollback, get, list, getVersion, setVersion, dir };
}

module.exports = { createSnapshotManager, bumpPatch, VERSION_RE };
