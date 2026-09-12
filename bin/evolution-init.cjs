'use strict';
/**
 * @module evolution-init
 * @layer 宿主接入层（turnkey 脚手架）
 *
 * 把 agent-evolution 接入脚手架复制到目标项目，改好 meta.agent。
 * 用法：
 *   node bin/evolution-init.cjs [targetDir] [--vendor]
 *   targetDir 缺省 = 当前目录
 *   --vendor  额外把 engine/kernel 复制为 lib/evolution-engine、lib/evolution-kernel（生产用，免 ENV）
 *
 * 失败全部 fail-open：复制失败只报错不破坏目标项目。
 */
const fs = require('node:fs');
const path = require('node:path');

const SCAFFOLD = path.resolve(__dirname, '..', 'scaffold');

function copyFileIfExists(src, dest) {
  if (!fs.existsSync(src)) {
    console.warn('[evolution-init] 跳过缺失源文件:', src);
    return false;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  return true;
}

function copyDir(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function setAgent(yamlPath, agent) {
  if (!fs.existsSync(yamlPath)) return;
  let txt = fs.readFileSync(yamlPath, 'utf8');
  txt = txt.replace(/^\s*agent:\s*.*$/m, `  agent: ${agent}`);
  fs.writeFileSync(yamlPath, txt, 'utf8');
}

function main() {
  const args = process.argv.slice(2);
  const vendor = args.includes('--vendor');
  const targetArg = args.find((a) => !a.startsWith('--')) || '.';
  const target = path.resolve(targetArg);
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
    console.error('[evolution-init] 目标目录不存在:', target);
    process.exit(1);
  }
  const agent = path.basename(target).replace(/[^\w.-]/g, '_');
  console.log('[evolution-init] 目标项目:', target, '(agent =', agent + ')');

  const files = ['evolution-host.cjs', 'evolution.yaml', 'tap-helpers.cjs'];
  for (const f of files) copyFileIfExists(path.join(SCAFFOLD, f), path.join(target, f));
  copyDir(path.join(SCAFFOLD, 'seeds'), path.join(target, 'seeds'));
  setAgent(path.join(target, 'evolution.yaml'), agent);
  // 接入文档改名为 EVOLUTION.md 复制，绝不覆盖宿主项目既有的 README.md
  copyFileIfExists(path.join(SCAFFOLD, 'README.md'), path.join(target, 'EVOLUTION.md'));

  if (vendor) {
    const repoRoot = path.resolve(__dirname, '..');
    copyDir(path.join(repoRoot, 'engine'), path.join(target, 'lib', 'evolution-engine'));
    copyDir(path.join(repoRoot, 'kernel', 'src'), path.join(target, 'lib', 'evolution-kernel', 'src'));
    // 让 yaml 用 vendored 内核
    let y = fs.readFileSync(path.join(target, 'evolution.yaml'), 'utf8');
    y = y.replace(/^\s*#?\s*kernelRoot:.*$/m, '  kernelRoot: lib/evolution-kernel/src');
    fs.writeFileSync(path.join(target, 'evolution.yaml'), y, 'utf8');
    console.log('[evolution-init] 已 vendor engine + kernel 到 lib/（无需 ENV）');
  }

  console.log('[evolution-init] 完成。下一步：');
  console.log('  1. 在入口加：const evo = require("./evolution-host.cjs"); evo.init({ autoStart: true });');
  console.log('  2. 报错点加：evo.tapError(err, { taskId: "build" });');
  console.log('  3. 接入文档已写入 EVOLUTION.md（不会覆盖你的 README.md）');
  console.log('  4. （可选）把 .evolution/ 加入 .gitignore');
  console.log('  4. 验证：node -e "require(\'./evolution-host.cjs\').init(); console.log(require(\'./evolution-host.cjs\').status())"');
}

main();
