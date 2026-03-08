import type { LayerPerformanceEntry, PerformanceSnapshot } from '../types/rendering';

const DEFAULT_SNAPSHOT: PerformanceSnapshot = {
  fps: 60,
  frameTimeAvg: 16.67,
  frameTimeMax: 16.67,
  primitiveCount: 0,
  visibleCount: 0,
  resolutionScale: 1,
  googleQualityGovernorActive: false,
  layerUpdates: {},
  lastUpdated: Date.now(),
};

type Listener = () => void;

const listeners = new Set<Listener>();
let snapshot: PerformanceSnapshot = DEFAULT_SNAPSHOT;

function publish(next: PerformanceSnapshot) {
  snapshot = next;

  if (typeof window !== 'undefined') {
    (
      window as Window & {
        __TAC_VIEW_PERFORMANCE__?: PerformanceSnapshot;
      }
    ).__TAC_VIEW_PERFORMANCE__ = snapshot;
  }

  listeners.forEach((listener) => listener());
}

function recomputeTotals(layerUpdates: Record<string, LayerPerformanceEntry>) {
  let primitiveCount = 0;
  let visibleCount = 0;

  for (const entry of Object.values(layerUpdates)) {
    primitiveCount += entry.primitives;
    visibleCount += entry.visibleCount;
  }

  return { primitiveCount, visibleCount };
}

export function getPerformanceSnapshot() {
  return snapshot;
}

export function subscribePerformanceSnapshot(listener: Listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function updatePerformanceSnapshot(
  partial:
    | Partial<PerformanceSnapshot>
    | ((current: PerformanceSnapshot) => Partial<PerformanceSnapshot>),
) {
  const patch = typeof partial === 'function' ? partial(snapshot) : partial;
  const nextLayerUpdates = patch.layerUpdates ?? snapshot.layerUpdates;
  const totals = recomputeTotals(nextLayerUpdates);

  publish({
    ...snapshot,
    ...patch,
    layerUpdates: nextLayerUpdates,
    primitiveCount: patch.primitiveCount ?? totals.primitiveCount,
    visibleCount: patch.visibleCount ?? totals.visibleCount,
    lastUpdated: Date.now(),
  });
}

export function recordLayerPerformance(layerName: string, entry: Partial<LayerPerformanceEntry>) {
  updatePerformanceSnapshot((current) => {
    const currentEntry = current.layerUpdates[layerName] ?? {
      updateMs: 0,
      primitives: 0,
      visibleCount: 0,
    };

    return {
      layerUpdates: {
        ...current.layerUpdates,
        [layerName]: {
          updateMs: entry.updateMs ?? currentEntry.updateMs,
          primitives: entry.primitives ?? currentEntry.primitives,
          visibleCount: entry.visibleCount ?? currentEntry.visibleCount,
        },
      },
    };
  });
}

export function resetPerformanceSnapshot() {
  publish({
    ...DEFAULT_SNAPSHOT,
    lastUpdated: Date.now(),
  });
}
