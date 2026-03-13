export interface RuntimeClientConfig {
  googleApiKey: string;
  cesiumIonToken: string;
}

export interface RuntimeBootstrap {
  apiBaseUrl: string;
  authToken: string;
  clientConfig: RuntimeClientConfig;
  platform: string;
}

export function isTauriRuntime() {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

async function loadDesktopBootstrap() {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<RuntimeBootstrap>('get_runtime_bootstrap');
}

export function resolveWebBootstrap(
  env: Record<string, string | undefined>,
  isDev: boolean,
): RuntimeBootstrap {
  const apiBaseUrl = isDev ? '/api' : '/api';
  return {
    apiBaseUrl,
    authToken: '',
    clientConfig: {
      googleApiKey: env.VITE_GOOGLE_API_KEY ?? '',
      cesiumIonToken: env.VITE_CESIUM_ION_TOKEN ?? '',
    },
    platform: 'web',
  };
}

async function loadWebBootstrap(): Promise<RuntimeBootstrap> {
  return resolveWebBootstrap(import.meta.env, import.meta.env.DEV);
}

let bootstrapPromise: Promise<RuntimeBootstrap> | null = null;
let currentBootstrap: RuntimeBootstrap | null = null;

export async function loadRuntimeBootstrap() {
  if (!bootstrapPromise) {
    bootstrapPromise = (isTauriRuntime() ? loadDesktopBootstrap() : loadWebBootstrap()).then((bootstrap) => {
      currentBootstrap = bootstrap;
      return bootstrap;
    });
  }

  return bootstrapPromise;
}

export function getRuntimeBootstrap() {
  if (!currentBootstrap) {
    throw new Error('Runtime bootstrap has not been loaded yet.');
  }

  return currentBootstrap;
}

export function getRuntimeClientConfig() {
  return getRuntimeBootstrap().clientConfig;
}

export function buildApiUrlFromBase(apiBaseUrl: string, pathname: string) {
  const normalizedBase = apiBaseUrl.endsWith('/') ? apiBaseUrl.slice(0, -1) : apiBaseUrl;
  const normalizedPath = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return `${normalizedBase}${normalizedPath}`;
}

export function buildApiUrl(pathname: string) {
  return buildApiUrlFromBase(getRuntimeBootstrap().apiBaseUrl, pathname);
}

export function setRuntimeBootstrapForTests(bootstrap: RuntimeBootstrap | null) {
  currentBootstrap = bootstrap;
  bootstrapPromise = bootstrap ? Promise.resolve(bootstrap) : null;
}

export async function apiFetch(input: string, init: RequestInit = {}) {
  const bootstrap = getRuntimeBootstrap();
  const headers = new Headers(init.headers ?? {});

  if (bootstrap.authToken) {
    headers.set('x-tac-view-token', bootstrap.authToken);
  }

  return fetch(buildApiUrl(input), {
    ...init,
    headers,
  });
}
