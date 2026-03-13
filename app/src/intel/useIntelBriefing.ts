import { useEffect, useMemo, useState } from 'react';
import type { IntelFeedItem } from '../components/ui/IntelFeed';
import { apiFetch } from '../runtime/bootstrap';
import type { RenderCameraState } from '../types/rendering';
import type { IntelBriefingItem, IntelBriefingResponse } from './types';

const POLL_INTERVAL_MS = 3 * 60 * 1000;
const DEFAULT_LIMIT = 10;

function deriveRadiusKm(camera: RenderCameraState) {
  return Math.max(200, Math.min(1600, Math.round(camera.altitude / 12000)));
}

function formatTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return new Date().toISOString().slice(11, 19);
  }
  return date.toISOString().slice(11, 19);
}

function trimMessage(value: string, maxLength = 120) {
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

function toFeedItem(item: IntelBriefingItem): IntelFeedItem {
  const prefix = item.source.toUpperCase();
  const suffix = item.locationLabel ? ` - ${item.locationLabel}` : '';
  return {
    id: `${item.source}-${item.id}`,
    time: formatTime(item.publishedAt),
    type: item.category === 'conflict' ? 'conflict' : 'osint',
    message: trimMessage(`${prefix}: ${item.title}${suffix}`),
    href: item.url ?? undefined,
  };
}

export function useIntelBriefing(camera: RenderCameraState) {
  const [items, setItems] = useState<IntelBriefingItem[]>([]);

  const queryState = useMemo(() => ({
    latitude: Number(camera.latitude.toFixed(2)),
    longitude: Number(camera.longitude.toFixed(2)),
    radiusKm: deriveRadiusKm(camera),
  }), [camera.altitude, camera.latitude, camera.longitude]);

  useEffect(() => {
    let cancelled = false;
    let timeoutId: number | null = null;

    const fetchBriefing = async () => {
      try {
        const params = new URLSearchParams({
          lat: String(queryState.latitude),
          lon: String(queryState.longitude),
          radiusKm: String(queryState.radiusKm),
          limit: String(DEFAULT_LIMIT),
        });
        const res = await apiFetch(`/intel/briefing?${params}`);
        if (!res.ok) {
          throw new Error(`Intel briefing HTTP ${res.status}`);
        }

        const payload: IntelBriefingResponse = await res.json();
        if (!cancelled) {
          setItems(payload.items);
        }
      } catch (error) {
        console.warn('[INTEL] Briefing fetch failed:', error);
        if (!cancelled) {
          setItems([]);
        }
      } finally {
        if (!cancelled) {
          timeoutId = window.setTimeout(fetchBriefing, POLL_INTERVAL_MS);
        }
      }
    };

    void fetchBriefing();

    return () => {
      cancelled = true;
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [queryState.latitude, queryState.longitude, queryState.radiusKm]);

  return {
    items,
    feedItems: items.map(toFeedItem),
  };
}
