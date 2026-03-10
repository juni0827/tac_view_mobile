import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempDir = path.join(rootDir, '.sidecar-build');
const bundlePath = path.join(tempDir, 'tac_view-sidecar.cjs');
const binariesDir = path.join(rootDir, 'src-tauri', 'binaries');

const localTripleMap = {
  win32: {
    x64: 'x86_64-pc-windows-msvc',
    arm64: 'aarch64-pc-windows-msvc',
  },
  darwin: {
    x64: 'x86_64-apple-darwin',
    arm64: 'aarch64-apple-darwin',
  },
  linux: {
    x64: 'x86_64-unknown-linux-gnu',
    arm64: 'aarch64-unknown-linux-gnu',
  },
};

const pkgTargetMap = {
  'x86_64-pc-windows-msvc': { target: 'node24-win-x64', extension: '.exe' },
  'aarch64-pc-windows-msvc': { target: 'node24-win-arm64', extension: '.exe' },
  'x86_64-apple-darwin': { target: 'node24-macos-x64', extension: '' },
  'aarch64-apple-darwin': { target: 'node24-macos-arm64', extension: '' },
  'x86_64-unknown-linux-gnu': { target: 'node24-linux-x64', extension: '' },
  'aarch64-unknown-linux-gnu': { target: 'node24-linux-arm64', extension: '' },
};

function resolveTargetTriple() {
  const explicit =
    process.env.TAC_VIEW_TARGET_TRIPLE ||
    process.env.TAURI_ENV_TARGET_TRIPLE;
  if (explicit) {
    return explicit;
  }

  const platformTargets = localTripleMap[process.platform];
  if (!platformTargets) {
    throw new Error(`Unsupported platform: ${process.platform}`);
  }

  const triple = platformTargets[process.arch];
  if (!triple) {
    throw new Error(`Unsupported architecture: ${process.platform}/${process.arch}`);
  }

  return triple;
}

function run(command, args = []) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    stdio: 'inherit',
    shell: typeof command === 'string' && args.length === 0,
  });

  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(' ')}`.trim());
  }
}

async function main() {
  const targetTriple = resolveTargetTriple();
  const pkgTarget = pkgTargetMap[targetTriple];
  if (!pkgTarget) {
    throw new Error(`Unsupported target triple: ${targetTriple}`);
  }

  await rm(tempDir, { recursive: true, force: true });
  await mkdir(tempDir, { recursive: true });
  await mkdir(binariesDir, { recursive: true });

  await build({
    entryPoints: [path.join(rootDir, 'server', 'bootstrap.js')],
    bundle: true,
    format: 'cjs',
    outfile: bundlePath,
    platform: 'node',
    target: 'node24',
    sourcemap: false,
    banner: {
      js: '#!/usr/bin/env node',
    },
  });

  const outputPath = path.join(
    binariesDir,
    `tac_view-sidecar-${targetTriple}${pkgTarget.extension}`,
  );
  const nativeBindingSourcePath = path.join(
    rootDir,
    'node_modules',
    'better-sqlite3',
    'build',
    'Release',
    'better_sqlite3.node',
  );
  const nativeBindingOutputPath = path.join(
    binariesDir,
    `better_sqlite3-${targetTriple}.node`,
  );
  const relativeBundlePath = path.relative(rootDir, bundlePath);
  const relativeOutputPath = path.relative(rootDir, outputPath);

  const pkgCommand = [
    'npx',
    'pkg',
    `"${relativeBundlePath}"`,
    '--targets',
    pkgTarget.target,
    '--output',
    `"${relativeOutputPath}"`,
    '--compress',
    'GZip',
  ].join(' ');
  run(pkgCommand);
  await copyFile(nativeBindingSourcePath, nativeBindingOutputPath);

  console.log(`[sidecar] built ${outputPath}`);
  console.log(`[sidecar] copied native binding ${nativeBindingOutputPath}`);
}

main().catch((error) => {
  console.error('[sidecar] build failed:', error);
  process.exitCode = 1;
});
