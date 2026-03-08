import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function getScopedCargoTargetDir() {
  const repoKey = crypto
    .createHash('sha1')
    .update(process.platform)
    .update('\0')
    .update(rootDir.toLowerCase())
    .digest('hex')
    .slice(0, 12);

  return path.join(rootDir, '.tauri-target', repoKey);
}

export function getTauriEnv(baseEnv = process.env) {
  if (baseEnv.CARGO_TARGET_DIR) {
    return { ...baseEnv };
  }

  return {
    ...baseEnv,
    CARGO_TARGET_DIR: getScopedCargoTargetDir(),
  };
}

export function getTauriBinaryPath({
  profile = 'debug',
  env = process.env,
  binaryName = process.platform === 'win32' ? 'tac_view.exe' : 'tac_view',
} = {}) {
  const tauriEnv = getTauriEnv(env);
  return path.join(tauriEnv.CARGO_TARGET_DIR, profile, binaryName);
}

function resolveNpxCommand() {
  return 'npx';
}

async function main() {
  const tauriArgs = process.argv.slice(2);
  if (tauriArgs.length === 0) {
    console.error('[tauri-runner] missing Tauri CLI arguments');
    process.exitCode = 1;
    return;
  }

  const env = getTauriEnv();
  console.log(`[tauri-runner] using CARGO_TARGET_DIR=${env.CARGO_TARGET_DIR}`);

  const child = spawn(resolveNpxCommand(), ['tauri', ...tauriArgs], {
    cwd: rootDir,
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }

    process.exitCode = code ?? 1;
  });

  child.on('error', (error) => {
    console.error('[tauri-runner] failed to start Tauri CLI:', error);
    process.exitCode = 1;
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
