import { useState, useEffect, useCallback } from 'react';
import type { IntelFeedItem } from '../components/ui/IntelFeed';
import { apiFetch } from '../runtime/bootstrap';

export interface Earthquake {
  id: string;
  mag: number;
  place: string;
  time: number;
  longitude: number;
  latitude: number;
  depth: number;
}

const POLL_INTERVAL = 60_000; // 60 seconds

interface EarthquakeFeature {
  id: string;
  properties: {
    mag: number;
    place: string;
    time: number;
  };
  geometry: {
    coordinates: [number, number, number];
  };
}

interface EarthquakeApiResponse {
  features: EarthquakeFeature[];
}

export function useEarthquakes(enabled: boolean) {
  const [earthquakes, setEarthquakes] = useState<Earthquake[]>([]);
  const [feedItems, setFeedItems] = useState<IntelFeedItem[]>([]);

  const fetchData = useCallback(async () => {
    if (!enabled) return;

    try {
      const res = await apiFetch('/earthquakes');
      if (!res.ok) throw new Error(`USGS HTTP ${res.status}`);
      const data: EarthquakeApiResponse = await res.json();

      const quakes: Earthquake[] = data.features.map((f) => ({
        id: f.id,
        mag: f.properties.mag,
        place: f.properties.place,
        time: f.properties.time,
        longitude: f.geometry.coordinates[0],
        latitude: f.geometry.coordinates[1],
        depth: f.geometry.coordinates[2],
      }));

      setEarthquakes(quakes);

      // Generate intel feed for significant earthquakes (M4+)
      const significant = quakes.filter((q) => q.mag >= 4.0).slice(0, 5);
      const newFeed: IntelFeedItem[] = significant.map((q) => ({
        id: `eq-${q.id}`,
        time: new Date(q.time).toISOString().slice(11, 19),
        type: 'seismic' as const,
        message: `M${q.mag.toFixed(1)} — ${q.place}`,
      }));
      setFeedItems(newFeed);
    } catch (err) {
      console.error('USGS fetch error:', err);
    }
  }, [enabled]);

  useEffect(() => {
    fetchData();
    if (!enabled) return;
    const timer = setInterval(fetchData, POLL_INTERVAL);
    return () => clearInterval(timer);
  }, [fetchData, enabled]);

  return { earthquakes, feedItems };
}
