#!/usr/bin/env node
/**
 * cargo 包装器：在需要时把 CARGO_HOME 指向项目内的 .cache/cargo。
 *
 * 为什么需要它：某些受限环境（例如本机的文件沙箱）不允许写入工作区之外的目录，
 * 而 cargo 默认要在 ~/.cargo 里写下载缓存，导致依赖根本无法拉取。把 CARGO_HOME
 * 放进仓库内即可解决。
 *
 * 该行为是**可选加入**的：仅当 .cache/cargo 实际存在时才覆盖 CARGO_HOME，
 * 因此普通开发机上不会产生任何影响，也不会把本机路径写进仓库配置。
 *
 * stdio 必须是 'inherit'：不能让 Node 去管道捕获子进程输出。
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const localCargoHome = join(repoRoot, '.cache', 'cargo');

const env = { ...process.env };
if (!env.CARGO_HOME && existsSync(localCargoHome)) {
  env.CARGO_HOME = localCargoHome;
}

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('usage: node scripts/run-cargo.mjs <cargo args...>');
  process.exit(2);
}

const result = spawnSync('cargo', args, { stdio: 'inherit', env, cwd: repoRoot });
if (result.error) {
  console.error(`failed to launch cargo: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
