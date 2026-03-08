export interface RenderCameraState {
  latitude: number;
  longitude: number;
  altitude: number;
  heading: number;
  pitch: number;
  timestamp: number;
}

export interface LayerVisibilityFlags {
  flights: boolean;
  satellites: boolean;
  earthquakes: boolean;
  traffic: boolean;
  cctv: boolean;
  ships: boolean;
}

export interface LayerSelectionState {
  trackedId: string | null;
  selectedId: string | null;
  priorityIds: Set<string>;
}

export interface FrameUpdateState {
  camera: RenderCameraState;
  mapTiles: 'google' | 'osm';
  tracked: boolean;
  now: number;
}

export interface LayerRenderManager<TSnapshot = unknown> {
  setData(snapshot: TSnapshot): void;
  setVisibility(flags: LayerVisibilityFlags): void;
  setSelection(selection: LayerSelectionState): void;
  updateFrame(frameState: FrameUpdateState): void;
  dispose(): void;
}

export interface LayerPerformanceEntry {
  updateMs: number;
  primitives: number;
  visibleCount: number;
}

export interface PerformanceSnapshot {
  fps: number;
  frameTimeAvg: number;
  frameTimeMax: number;
  primitiveCount: number;
  visibleCount: number;
  resolutionScale: number;
  googleQualityGovernorActive: boolean;
  layerUpdates: Record<string, LayerPerformanceEntry>;
  lastUpdated: number;
}

export interface RenderBudget {
  flights: number;
  satellites: number;
  earthquakes: number;
  cctv: number;
  ships: number;
  dynamicLayerIntervalMs: number;
  staticLayerIntervalMs: number;
  occlusionIntervalMs: number;
  trackedUpdateIntervalMs: number;
  trafficReactUpdateMs: number;
}
