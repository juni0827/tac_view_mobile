import 'dotenv/config';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeOverpassUrls } from './overpass.js';

function readString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : '';
}

function readStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => readString(entry))
    .filter(Boolean);
}

function firstDefined(...values) {
  for (const value of values) {
    const normalized = readString(value);
    if (normalized) return normalized;
  }
  return '';
}

function firstDefinedArray(...values) {
  for (const value of values) {
    const normalized = readStringArray(value);
    if (normalized.length > 0) {
      return normalized;
    }
  }
  return [];
}

function parseEnvStringArray(value) {
  return readString(value)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseOptionalJson(text, sourceLabel) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid runtime config JSON in ${sourceLabel}: ${error.message}`);
  }
}

async function readDesktopConfig(configPath) {
  if (!configPath) {
    return {};
  }

  try {
    const raw = await fs.readFile(configPath, 'utf8');
    return parseOptionalJson(raw, configPath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {};
    }
    throw error;
  }
}

function readDesktopConfigSync(configPath) {
  if (!configPath) {
    return {};
  }

  try {
    const raw = fsSync.readFileSync(configPath, 'utf8');
    return parseOptionalJson(raw, configPath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {};
    }
    throw error;
  }
}

function normalizeConfigShape(config) {
  const client = config?.client ?? {};
  const server = config?.server ?? {};

  return {
    client: {
      googleApiKey: readString(client.googleApiKey),
      cesiumIonToken: readString(client.cesiumIonToken),
    },
    server: {
      googleMapsApiKey: readString(server.googleMapsApiKey),
      openskyClientId: readString(server.openskyClientId),
      openskyClientSecret: readString(server.openskyClientSecret),
      aisstreamApiKey: readString(server.aisstreamApiKey),
      nswTransportApiKey: readString(server.nswTransportApiKey),
      acledAccessKey: readString(server.acledAccessKey),
      acledEmail: readString(server.acledEmail),
      reliefwebAppName: readString(server.reliefwebAppName),
      newsApiKey: readString(server.newsApiKey),
      ontologyOverpassUrls: readStringArray(server.ontologyOverpassUrls),
      wikidataEntityDataUrl: readString(server.wikidataEntityDataUrl),
      wikidataUserAgent: readString(server.wikidataUserAgent),
      geonamesUsername: readString(server.geonamesUsername),
      geonamesApiUrl: readString(server.geonamesApiUrl),
    },
  };
}

function readEnvConfig(env) {
  return {
    client: {
      googleApiKey: firstDefined(env.VITE_GOOGLE_API_KEY),
      cesiumIonToken: firstDefined(env.VITE_CESIUM_ION_TOKEN),
    },
    server: {
      googleMapsApiKey: firstDefined(env.GOOGLE_MAPS_API_KEY),
      openskyClientId: firstDefined(env.OPENSKY_CLIENT_ID),
      openskyClientSecret: firstDefined(env.OPENSKY_CLIENT_SECRET),
      aisstreamApiKey: firstDefined(env.AISSTREAM_API_KEY),
      nswTransportApiKey: firstDefined(env.NSW_TRANSPORT_API_KEY),
      acledAccessKey: firstDefined(env.ACLED_ACCESS_KEY),
      acledEmail: firstDefined(env.ACLED_EMAIL),
      reliefwebAppName: firstDefined(env.RELIEFWEB_APPNAME),
      newsApiKey: firstDefined(env.NEWS_API_KEY),
      ontologyOverpassUrls: parseEnvStringArray(env.ONTOLOGY_OVERPASS_URLS),
      wikidataEntityDataUrl: firstDefined(env.WIKIDATA_ENTITY_DATA_URL),
      wikidataUserAgent: firstDefined(env.WIKIDATA_USER_AGENT),
      geonamesUsername: firstDefined(env.GEONAMES_USERNAME),
      geonamesApiUrl: firstDefined(env.GEONAMES_API_URL),
    },
  };
}

function mergeRuntimeConfig(fileConfig, envConfig) {
  return {
    client: {
      googleApiKey: firstDefined(
        envConfig.client.googleApiKey,
        envConfig.server.googleMapsApiKey,
        fileConfig.client.googleApiKey,
        fileConfig.server.googleMapsApiKey,
      ),
      cesiumIonToken: firstDefined(envConfig.client.cesiumIonToken, fileConfig.client.cesiumIonToken),
    },
    server: {
      googleMapsApiKey: firstDefined(envConfig.server.googleMapsApiKey, fileConfig.server.googleMapsApiKey),
      openskyClientId: firstDefined(envConfig.server.openskyClientId, fileConfig.server.openskyClientId),
      openskyClientSecret: firstDefined(envConfig.server.openskyClientSecret, fileConfig.server.openskyClientSecret),
      aisstreamApiKey: firstDefined(envConfig.server.aisstreamApiKey, fileConfig.server.aisstreamApiKey),
      nswTransportApiKey: firstDefined(envConfig.server.nswTransportApiKey, fileConfig.server.nswTransportApiKey),
      acledAccessKey: firstDefined(envConfig.server.acledAccessKey, fileConfig.server.acledAccessKey),
      acledEmail: firstDefined(envConfig.server.acledEmail, fileConfig.server.acledEmail),
      reliefwebAppName: firstDefined(envConfig.server.reliefwebAppName, fileConfig.server.reliefwebAppName),
      newsApiKey: firstDefined(envConfig.server.newsApiKey, fileConfig.server.newsApiKey),
      ontologyOverpassUrls: normalizeOverpassUrls(
        firstDefinedArray(envConfig.server.ontologyOverpassUrls, fileConfig.server.ontologyOverpassUrls),
      ),
      wikidataEntityDataUrl: firstDefined(envConfig.server.wikidataEntityDataUrl, fileConfig.server.wikidataEntityDataUrl),
      wikidataUserAgent: firstDefined(envConfig.server.wikidataUserAgent, fileConfig.server.wikidataUserAgent),
      geonamesUsername: firstDefined(envConfig.server.geonamesUsername, fileConfig.server.geonamesUsername),
      geonamesApiUrl: firstDefined(envConfig.server.geonamesApiUrl, fileConfig.server.geonamesApiUrl),
    },
  };
}

function resolveSnapshotDir(configPath) {
  const envDir = firstDefined(process.env.TAC_VIEW_SNAPSHOT_DIR);
  if (envDir) return path.resolve(envDir);
  if (configPath) return path.join(path.dirname(configPath), 'snapshots');
  return path.resolve(process.cwd(), '.build-cache', 'snapshots');
}

export async function loadRuntimeConfig() {
  return loadRuntimeConfigSync();
}

export function loadRuntimeConfigSync() {
  const configPath = firstDefined(process.env.TAC_VIEW_CONFIG_PATH);
  const fileConfig = normalizeConfigShape(readDesktopConfigSync(configPath));
  const envConfig = readEnvConfig(process.env);
  const merged = mergeRuntimeConfig(fileConfig, envConfig);

  return {
    mode: configPath ? 'desktop' : 'web',
    configPath: configPath || null,
    snapshotDir: resolveSnapshotDir(configPath),
    port: Number.parseInt(firstDefined(process.env.TAC_VIEW_PORT, process.env.PORT) || '3001', 10),
    authToken: firstDefined(process.env.TAC_VIEW_AUTH_TOKEN),
    client: merged.client,
    server: merged.server,
  };
}

export function applyRuntimeConfigToEnv(runtimeConfig) {
  process.env.GOOGLE_MAPS_API_KEY = firstDefined(process.env.GOOGLE_MAPS_API_KEY, runtimeConfig.server.googleMapsApiKey);
  process.env.OPENSKY_CLIENT_ID = firstDefined(process.env.OPENSKY_CLIENT_ID, runtimeConfig.server.openskyClientId);
  process.env.OPENSKY_CLIENT_SECRET = firstDefined(process.env.OPENSKY_CLIENT_SECRET, runtimeConfig.server.openskyClientSecret);
  process.env.AISSTREAM_API_KEY = firstDefined(process.env.AISSTREAM_API_KEY, runtimeConfig.server.aisstreamApiKey);
  process.env.NSW_TRANSPORT_API_KEY = firstDefined(process.env.NSW_TRANSPORT_API_KEY, runtimeConfig.server.nswTransportApiKey);
  process.env.ACLED_ACCESS_KEY = firstDefined(process.env.ACLED_ACCESS_KEY, runtimeConfig.server.acledAccessKey);
  process.env.ACLED_EMAIL = firstDefined(process.env.ACLED_EMAIL, runtimeConfig.server.acledEmail);
  process.env.RELIEFWEB_APPNAME = firstDefined(process.env.RELIEFWEB_APPNAME, runtimeConfig.server.reliefwebAppName);
  process.env.NEWS_API_KEY = firstDefined(process.env.NEWS_API_KEY, runtimeConfig.server.newsApiKey);
  process.env.ONTOLOGY_OVERPASS_URLS = runtimeConfig.server.ontologyOverpassUrls.join(',');
  process.env.WIKIDATA_ENTITY_DATA_URL = firstDefined(process.env.WIKIDATA_ENTITY_DATA_URL, runtimeConfig.server.wikidataEntityDataUrl);
  process.env.WIKIDATA_USER_AGENT = firstDefined(process.env.WIKIDATA_USER_AGENT, runtimeConfig.server.wikidataUserAgent);
  process.env.GEONAMES_USERNAME = firstDefined(process.env.GEONAMES_USERNAME, runtimeConfig.server.geonamesUsername);
  process.env.GEONAMES_API_URL = firstDefined(process.env.GEONAMES_API_URL, runtimeConfig.server.geonamesApiUrl);
}

export function getClientRuntimeConfig(runtimeConfig) {
  return {
    googleApiKey: runtimeConfig.client.googleApiKey,
    cesiumIonToken: runtimeConfig.client.cesiumIonToken,
  };
}
