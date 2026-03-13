import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  apiFetch,
  buildApiUrlFromBase,
  resolveWebBootstrap,
  setRuntimeBootstrapForTests,
} from '../../../app/src/runtime/bootstrap';

describe('runtime bootstrap helpers', () => {
  afterEach(() => {
    setRuntimeBootstrapForTests(null);
    vi.unstubAllGlobals();
  });

  it('builds api URLs from a bootstrap base', () => {
    expect(buildApiUrlFromBase('http://127.0.0.1:3011/api', '/flights')).toBe(
      'http://127.0.0.1:3011/api/flights',
    );
    expect(buildApiUrlFromBase('http://127.0.0.1:3011/api/', 'health')).toBe(
      'http://127.0.0.1:3011/api/health',
    );
  });

  it('resolves web bootstrap from Vite env values', () => {
    expect(resolveWebBootstrap({
      VITE_GOOGLE_API_KEY: 'google-key',
      VITE_CESIUM_ION_TOKEN: 'ion-token',
    }, true)).toEqual({
      apiBaseUrl: '/api',
      authToken: '',
      clientConfig: {
        googleApiKey: 'google-key',
        cesiumIonToken: 'ion-token',
      },
      platform: 'web',
    });
  });

  it('adds the desktop auth token to apiFetch headers', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    setRuntimeBootstrapForTests({
      apiBaseUrl: 'http://127.0.0.1:4010/api',
      authToken: 'desktop-token',
      clientConfig: {
        googleApiKey: '',
        cesiumIonToken: '',
      },
      platform: 'windows',
    });

    await apiFetch('/health');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://127.0.0.1:4010/api/health');
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get('x-tac-view-token')).toBe('desktop-token');
  });
});
