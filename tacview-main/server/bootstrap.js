import path from 'node:path';
import { server, runtimeConfig } from './app.js';

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
  startServer().catch((error) => {
    console.error('[TAC_VIEW] Failed to start server:', error);
    process.exitCode = 1;
  });
}
