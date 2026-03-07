import { useState, useCallback, useRef } from 'react';
import { apiFetch } from '../runtime/bootstrap';
import { getPreferredGeolocation } from '../runtime/geolocation';

export interface GeoLocation {
  latitude: number;
  longitude: number;
  accuracy: number | null;
  source: 'gps' | 'ip';
  city?: string;
  country?: string;
  countryCode?: string;
  region?: string;
}

export type GeoStatus = 'idle' | 'requesting' | 'success' | 'error';

interface GeolocationApiResponse {
  success: boolean;
  latitude: number;
  longitude: number;
  city?: string;
  country?: string;
  countryCode?: string;
  region?: string;
  error?: string;
}

interface UseGeolocationResult {
  location: GeoLocation | null;
  status: GeoStatus;
  error: string | null;
  locate: () => void;
}

export function useGeolocation(): UseGeolocationResult {
  const [location, setLocation] = useState<GeoLocation | null>(null);
  const [status, setStatus] = useState<GeoStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const locatingRef = useRef(false);

  const ipFallback = useCallback(async (): Promise<GeoLocation> => {
    const res = await apiFetch('/geolocation');
    if (!res.ok) throw new Error(`IP geolocation failed (${res.status})`);

    const data: GeolocationApiResponse = await res.json();
    if (!data.success) {
      throw new Error(data.error || 'IP geolocation unavailable');
    }

    return {
      latitude: data.latitude,
      longitude: data.longitude,
      accuracy: null,
      source: 'ip',
      city: data.city,
      country: data.country,
      countryCode: data.countryCode,
      region: data.region,
    };
  }, []);

  const locate = useCallback(() => {
    if (locatingRef.current) return;

    locatingRef.current = true;
    setStatus('requesting');
    setError(null);

    getPreferredGeolocation()
      .then((position) => {
        setLocation({
          latitude: position.latitude,
          longitude: position.longitude,
          accuracy: position.accuracy,
          source: 'gps',
        });
        setStatus('success');
      })
      .catch(async (geoErr) => {
        console.warn('[GEO] Preferred geolocation failed:', (geoErr as Error).message, 'falling back to IP');
        try {
          const ipGeo = await ipFallback();
          setLocation(ipGeo);
          setStatus('success');
        } catch (ipErr) {
          setError(`Location unavailable: ${(ipErr as Error).message}`);
          setStatus('error');
        }
      })
      .finally(() => {
        locatingRef.current = false;
      });
  }, [ipFallback]);

  return { location, status, error, locate };
}
