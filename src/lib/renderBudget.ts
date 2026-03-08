import type { RenderBudget, RenderCameraState } from '../types/rendering';

const FRAME_WINDOW_MS = 3_000;
const GOOGLE_RESOLUTION_STEP = 0.05;
const GOOGLE_RESOLUTION_MIN = 0.75;
const GOOGLE_RESOLUTION_MAX = 1.0;
const TARGET_FPS = 60;

export function buildRenderBudget(camera: RenderCameraState, tracked: boolean): RenderBudget {
  if (tracked || camera.altitude < 250_000) {
    return {
      flights: 2_600,
      satellites: 40,
      earthquakes: 320,
      cctv: 900,
      ships: 2_000,
      dynamicLayerIntervalMs: 80,
      staticLayerIntervalMs: 600,
      occlusionIntervalMs: 120,
      trackedUpdateIntervalMs: 16,
      trafficReactUpdateMs: 100,
    };
  }

  if (camera.altitude < 1_500_000) {
    return {
      flights: 1_800,
      satellites: 32,
      earthquakes: 240,
      cctv: 420,
      ships: 1_200,
      dynamicLayerIntervalMs: 100,
      staticLayerIntervalMs: 900,
      occlusionIntervalMs: 180,
      trackedUpdateIntervalMs: 16,
      trafficReactUpdateMs: 120,
    };
  }

  if (camera.altitude < 7_500_000) {
    return {
      flights: 1_100,
      satellites: 22,
      earthquakes: 180,
      cctv: 220,
      ships: 700,
      dynamicLayerIntervalMs: 120,
      staticLayerIntervalMs: 1_200,
      occlusionIntervalMs: 260,
      trackedUpdateIntervalMs: 16,
      trafficReactUpdateMs: 140,
    };
  }

  return {
    flights: 700,
    satellites: 14,
    earthquakes: 120,
    cctv: 120,
    ships: 420,
    dynamicLayerIntervalMs: 150,
    staticLayerIntervalMs: 1_600,
    occlusionIntervalMs: 320,
    trackedUpdateIntervalMs: 16,
    trafficReactUpdateMs: 160,
  };
}

export function shouldRefreshCameraQuery(
  previous: RenderCameraState | null,
  next: RenderCameraState,
) {
  if (!previous) {
    return true;
  }

  const altitudeDelta = Math.abs(next.altitude - previous.altitude);
  const altitudeThreshold = Math.max(20_000, previous.altitude * 0.08);
  const latitudeDelta = Math.abs(next.latitude - previous.latitude);
  const longitudeDelta = Math.abs(next.longitude - previous.longitude);
  const geoThreshold = next.altitude < 500_000
    ? 0.06
    : next.altitude < 2_000_000
      ? 0.12
      : next.altitude < 10_000_000
        ? 0.3
        : 0.8;

  return altitudeDelta >= altitudeThreshold || latitudeDelta >= geoThreshold || longitudeDelta >= geoThreshold;
}

export class RenderBudgetController {
  private frameTimes: Array<{ at: number; duration: number }> = [];

  private resolutionScale = 1;

  private governorActive = false;

  pushFrame(now: number, duration: number, mapTiles: 'google' | 'osm') {
    this.frameTimes.push({ at: now, duration });

    while (this.frameTimes.length > 0 && now - this.frameTimes[0]!.at > FRAME_WINDOW_MS) {
      this.frameTimes.shift();
    }

    if (mapTiles !== 'google') {
      this.resolutionScale = 1;
      this.governorActive = false;
      return;
    }

    const averageFrameTime = this.getAverageFrameTime();
    const fps = averageFrameTime > 0 ? 1_000 / averageFrameTime : TARGET_FPS;

    if (fps < TARGET_FPS - 1 && this.resolutionScale > GOOGLE_RESOLUTION_MIN) {
      this.resolutionScale = Math.max(GOOGLE_RESOLUTION_MIN, this.resolutionScale - GOOGLE_RESOLUTION_STEP);
      this.governorActive = true;
      return;
    }

    if (fps >= TARGET_FPS - 0.25 && this.resolutionScale < GOOGLE_RESOLUTION_MAX) {
      this.resolutionScale = Math.min(GOOGLE_RESOLUTION_MAX, this.resolutionScale + GOOGLE_RESOLUTION_STEP);
      this.governorActive = this.resolutionScale < GOOGLE_RESOLUTION_MAX;
    } else if (this.resolutionScale >= GOOGLE_RESOLUTION_MAX) {
      this.governorActive = false;
    }
  }

  getAverageFrameTime() {
    if (this.frameTimes.length === 0) {
      return 16.67;
    }

    const total = this.frameTimes.reduce((sum, frame) => sum + frame.duration, 0);
    return total / this.frameTimes.length;
  }

  getMaxFrameTime() {
    if (this.frameTimes.length === 0) {
      return 16.67;
    }

    return this.frameTimes.reduce((max, frame) => Math.max(max, frame.duration), 0);
  }

  getFps() {
    const averageFrameTime = this.getAverageFrameTime();
    return averageFrameTime > 0 ? 1_000 / averageFrameTime : TARGET_FPS;
  }

  getResolutionScale() {
    return this.resolutionScale;
  }

  isGovernorActive() {
    return this.governorActive;
  }
}
