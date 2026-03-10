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
        ontologyOverpassUrls: ['https://overpass.example/api'],
        wikidataEntityDataUrl: 'https://wikidata.example/entity',
        wikidataUserAgent: 'TacViewTest/1.0',
        geonamesUsername: 'file-geonames-user',
        geonamesApiUrl: 'https://geonames.example',
      },
    }), 'utf8');

    process.env.TAC_VIEW_CONFIG_PATH = configPath;
    process.env.TAC_VIEW_AUTH_TOKEN = 'desktop-token';
    process.env.VITE_GOOGLE_API_KEY = 'env-google';
    process.env.GEONAMES_USERNAME = 'env-geonames-user';

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
    expect(runtime.server.ontologyOverpassUrls).toEqual(['https://overpass.example/api']);
    expect(runtime.server.wikidataEntityDataUrl).toBe('https://wikidata.example/entity');
    expect(runtime.server.wikidataUserAgent).toBe('TacViewTest/1.0');
    expect(runtime.server.geonamesUsername).toBe('env-geonames-user');
    expect(runtime.server.geonamesApiUrl).toBe('https://geonames.example');
    expect(process.env.ONTOLOGY_OVERPASS_URLS).toBe('https://overpass.example/api');
    expect(process.env.WIKIDATA_ENTITY_DATA_URL).toBe('https://wikidata.example/entity');
    expect(process.env.WIKIDATA_USER_AGENT).toBe('TacViewTest/1.0');
    expect(process.env.GEONAMES_USERNAME).toBe('env-geonames-user');
    expect(process.env.GEONAMES_API_URL).toBe('https://geonames.example');

    await rm(tempDir, { recursive: true, force: true });
  });
});
