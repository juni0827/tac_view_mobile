import path from 'node:path';
import { server, runtimeConfig } from './app.js';

function assertDesktopSidecarInvocation() {
  if (process.env.TAC_VIEW_ALLOW_STANDALONE === '1') {
    return;
  }

  const requiredEnvVars = [
    'TAC_VIEW_PORT',
    'TAC_VIEW_AUTH_TOKEN',
    'TAC_VIEW_CONFIG_PATH',
  ];
  const missing = requiredEnvVars.filter((name) => {
    const value = process.env[name];
    return typeof value !== 'string' || value.trim().length === 0;
  });

  if (missing.length === 0) {
    return;
  }

  throw new Error(
    `tac_view-sidecar is not a standalone entry point. Launch tac_view.exe instead. Missing: ${missing.join(', ')}`,
  );
}

export function startServer() {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(runtimeConfig.port, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : runtimeConfig.port;
      const metadata = {
        port,
        token: runtimeConfig.authToken,
        configPath: runtimeConfig.configPath,
      };

      console.log(`READY ${JSON.stringify(metadata)}`);
      console.log(`[TAC_VIEW] Proxy server listening on http://127.0.0.1:${port}`);
      resolve(metadata);
    });
  });
}

const entryFileName = process.argv[1] ? path.basename(process.argv[1]) : '';
const isDirectRun = Boolean(process.pkg) || [
  'bootstrap.js',
  'index.js',
  'tac_view-sidecar.cjs',
  'tac_view-sidecar.mjs',
].includes(entryFileName);

if (isDirectRun) {
  try {
    assertDesktopSidecarInvocation();
    startServer().catch((error) => {
      console.error('[TAC_VIEW] Failed to start server:', error);
      process.exitCode = 1;
    });
  } catch (error) {
    console.error('[TAC_VIEW] Failed to start server:', error);
    process.exitCode = 1;
  }
}
