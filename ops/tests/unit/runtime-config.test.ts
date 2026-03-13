import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  applyRuntimeConfigToEnv,
  getClientRuntimeConfig,
  loadRuntimeConfig,
} from '../../../app/server/runtime-config.js';
import { DEFAULT_OVERPASS_URLS } from '../../../app/server/overpass.js';

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
        acledAccessKey: 'file-acled-key',
        acledEmail: 'ops@example.com',
        reliefwebAppName: 'TacViewTest',
        newsApiKey: 'file-news-key',
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
    expect(runtime.server.acledAccessKey).toBe('file-acled-key');
    expect(runtime.server.acledEmail).toBe('ops@example.com');
    expect(runtime.server.reliefwebAppName).toBe('TacViewTest');
    expect(runtime.server.newsApiKey).toBe('file-news-key');
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
    expect(process.env.ACLED_ACCESS_KEY).toBe('file-acled-key');
    expect(process.env.ACLED_EMAIL).toBe('ops@example.com');
    expect(process.env.RELIEFWEB_APPNAME).toBe('TacViewTest');
    expect(process.env.NEWS_API_KEY).toBe('file-news-key');

    await rm(tempDir, { recursive: true, force: true });
  });

  it('replaces legacy Overpass aliases with the current public mirror set', async () => {
    process.env.ONTOLOGY_OVERPASS_URLS = 'https://overpass-api.de/api/interpreter,https://overpass.kumi.systems/api/interpreter';

    const runtime = await loadRuntimeConfig();

    expect(runtime.server.ontologyOverpassUrls).toEqual(DEFAULT_OVERPASS_URLS);

    applyRuntimeConfigToEnv(runtime);
    expect(process.env.ONTOLOGY_OVERPASS_URLS).toBe(DEFAULT_OVERPASS_URLS.join(','));
  });

  it('falls back to server.googleMapsApiKey when client.googleApiKey is not set', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'tac-view-config-'));
    const configPath = path.join(tempDir, 'config.json');

    await writeFile(configPath, JSON.stringify({
      client: {
        googleApiKey: '',
        cesiumIonToken: 'file-ion',
      },
      server: {
        googleMapsApiKey: 'server-google-key',
      },
    }), 'utf8');

    process.env.TAC_VIEW_CONFIG_PATH = configPath;

    const runtime = await loadRuntimeConfig();

    expect(getClientRuntimeConfig(runtime)).toEqual({
      googleApiKey: 'server-google-key',
      cesiumIonToken: 'file-ion',
    });

    await rm(tempDir, { recursive: true, force: true });
  });
});
