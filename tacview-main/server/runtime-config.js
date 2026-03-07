import 'dotenv/config';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

function readString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : '';
}

function firstDefined(...values) {
  for (const value of values) {
    const normalized = readString(value);
    if (normalized) return normalized;
  }
  return '';
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
    },
  };
}

function mergeRuntimeConfig(fileConfig, envConfig) {
  return {
    client: {
      googleApiKey: firstDefined(envConfig.client.googleApiKey, fileConfig.client.googleApiKey),
      cesiumIonToken: firstDefined(envConfig.client.cesiumIonToken, fileConfig.client.cesiumIonToken),
    },
    server: {
      googleMapsApiKey: firstDefined(envConfig.server.googleMapsApiKey, fileConfig.server.googleMapsApiKey),
      openskyClientId: firstDefined(envConfig.server.openskyClientId, fileConfig.server.openskyClientId),
      openskyClientSecret: firstDefined(envConfig.server.openskyClientSecret, fileConfig.server.openskyClientSecret),
      aisstreamApiKey: firstDefined(envConfig.server.aisstreamApiKey, fileConfig.server.aisstreamApiKey),
      nswTransportApiKey: firstDefined(envConfig.server.nswTransportApiKey, fileConfig.server.nswTransportApiKey),
    },
  };
}

function resolveSnapshotDir(configPath) {
  const envDir = firstDefined(process.env.TAC_VIEW_SNAPSHOT_DIR);
  if (envDir) return path.resolve(envDir);
  if (configPath) return path.join(path.dirname(configPath), 'snapshots');
  return path.resolve(process.cwd(), '.tac_view-cache');
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
}

export function getClientRuntimeConfig(runtimeConfig) {
  return {
    googleApiKey: runtimeConfig.client.googleApiKey,
    cesiumIonToken: runtimeConfig.client.cesiumIonToken,
  };
}
