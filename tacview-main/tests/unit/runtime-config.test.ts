import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  applyRuntimeConfigToEnv,
  getClientRuntimeConfig,
  loadRuntimeConfig,
} from '../../server/runtime-config.js';

const originalEnv = { ...process.env };

describe('runtime config', () => {
  afterEach(async () => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }

    for (const [key, value] of Object.entries(originalEnv)) {
      process.env[key] = value;
    }
  });

  it('merges config file values with environment overrides', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'tac-view-config-'));
    const configPath = path.join(tempDir, 'config.json');

    await writeFile(configPath, JSON.stringify({
      client: {
        googleApiKey: 'file-google',
        cesiumIonToken: 'file-ion',
      },
      server: {
        openskyClientId: 'file-opensky-id',
      },
    }), 'utf8');

    process.env.TAC_VIEW_CONFIG_PATH = configPath;
    process.env.TAC_VIEW_AUTH_TOKEN = 'desktop-token';
    process.env.VITE_GOOGLE_API_KEY = 'env-google';

    const runtime = await loadRuntimeConfig();

    expect(runtime.mode).toBe('desktop');
    expect(runtime.configPath).toBe(configPath);
    expect(runtime.authToken).toBe('desktop-token');
    expect(runtime.snapshotDir).toBe(path.join(tempDir, 'snapshots'));
    expect(getClientRuntimeConfig(runtime)).toEqual({
      googleApiKey: 'env-google',
      cesiumIonToken: 'file-ion',
    });

    applyRuntimeConfigToEnv(runtime);
    expect(process.env.OPENSKY_CLIENT_ID).toBe('file-opensky-id');

    await rm(tempDir, { recursive: true, force: true });
  });
});
