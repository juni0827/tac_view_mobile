import { getRuntimeBootstrap } from './bootstrap';

export interface RuntimePosition {
  latitude: number;
  longitude: number;
  accuracy: number | null;
}

export async function getPreferredGeolocation(): Promise<RuntimePosition> {
  const runtime = getRuntimeBootstrap();

  if (runtime.platform !== 'web') {
    const { getCurrentPosition } = await import('@tauri-apps/plugin-geolocation');
    const position = await getCurrentPosition({
      enableHighAccuracy: true,
      timeout: 10_000,
      maximumAge: 60_000,
    });

    return {
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
      accuracy: position.coords.accuracy ?? null,
    };
  }

  if (!('geolocation' in navigator)) {
    throw new Error('Browser geolocation unavailable');
  }

  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        resolve({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: position.coords.accuracy ?? null,
        });
      },
      reject,
      {
        enableHighAccuracy: true,
        timeout: 10_000,
        maximumAge: 60_000,
      },
    );
  });
}
