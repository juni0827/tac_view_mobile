import type { CameraFeed } from '../types/camera';
import type { TrackedEntityInfo } from '../types/trackedEntity';
import type { RenderCameraState } from '../types/rendering';
import type { Flight } from '../hooks/useFlights';
import type { Ship } from '../hooks/useShips';
import type { SatellitePosition } from '../hooks/useSatellites';
import {
  EMPTY_VISUAL_INTELLIGENCE_STATE,
  type GroupInputPatch,
  type GroupSourceSnapshot,
  type GroupWorkerRequest,
  type GroupWorkerResponse,
  type VisualIntelligenceState,
} from './groupModel';
import { applyGroupInputPatch, createGroupStore, setGroupStoreCameraState, setGroupStoreSelection } from './groupStore';
import { buildVisualIntelligenceStateFromStore } from './visualIntelligence';

type Listener = () => void;

interface RuntimeBridge {
  postMessage(message: GroupWorkerRequest): void;
  dispose(): void;
}

function makeFlightSignature(flight: Flight) {
  return [
    flight.latitude,
    flight.longitude,
    flight.altitude,
    flight.heading,
    flight.velocityKnots,
    flight.originAirport,
    flight.destAirport,
    flight.airline,
  ].join('|');
}

function makeShipSignature(ship: Ship) {
  return [
    ship.latitude,
    ship.longitude,
    ship.heading,
    ship.cog,
    ship.sog,
    ship.destination ?? '',
    ship.shipType ?? '',
  ].join('|');
}

function makeSatelliteSignature(satellite: SatellitePosition) {
  const firstOrbitPoint = satellite.orbitPath[0];
  const lastOrbitPoint = satellite.orbitPath[satellite.orbitPath.length - 1];
  return [
    satellite.latitude,
    satellite.longitude,
    satellite.altitude,
    satellite.orbitPath.length,
    firstOrbitPoint?.latitude ?? '',
    firstOrbitPoint?.longitude ?? '',
    lastOrbitPoint?.latitude ?? '',
    lastOrbitPoint?.longitude ?? '',
  ].join('|');
}

function makeCameraSignature(camera: CameraFeed) {
  return [
    camera.latitude,
    camera.longitude,
    camera.available,
    camera.lastUpdated,
    camera.name,
  ].join('|');
}

function diffCollection<T>(
  nextItems: T[],
  previousSignatures: Map<string, string>,
  getId: (item: T) => string,
  getSignature: (item: T) => string,
) {
  const seen = new Set<string>();
  const upsert: T[] = [];

  for (const item of nextItems) {
    const id = getId(item);
    const signature = getSignature(item);
    seen.add(id);

    if (previousSignatures.get(id) !== signature) {
      previousSignatures.set(id, signature);
      upsert.push(item);
    }
  }

  const removeIds: string[] = [];
  for (const id of Array.from(previousSignatures.keys())) {
    if (!seen.has(id)) {
      previousSignatures.delete(id);
      removeIds.push(id);
    }
  }

  return { upsert, removeIds };
}

function isPatchEmpty(patch: GroupInputPatch) {
  return !patch.flights
    && !patch.ships
    && !patch.satellites
    && !patch.cameras;
}

class LocalRuntimeBridge implements RuntimeBridge {
  private readonly store = createGroupStore();

  private readonly onState: (state: VisualIntelligenceState) => void;

  constructor(onState: (state: VisualIntelligenceState) => void) {
    this.onState = onState;
  }

  postMessage(message: GroupWorkerRequest) {
    switch (message.type) {
      case 'patchInput':
        applyGroupInputPatch(this.store, message.patch);
        this.onState(buildVisualIntelligenceStateFromStore(this.store, {
          now: Date.now(),
          forceMicro: true,
          forceMeso: true,
          forceCloud: true,
        }));
        break;
      case 'setCameraState':
        setGroupStoreCameraState(this.store, message.camera);
        break;
      case 'setSelection':
        setGroupStoreSelection(this.store, message.selection);
        this.onState(buildVisualIntelligenceStateFromStore(this.store, { now: Date.now() }));
        break;
      case 'tick':
        this.onState(buildVisualIntelligenceStateFromStore(this.store, {
          now: message.payload?.at ?? Date.now(),
          forceMicro: message.payload?.forceMicro,
          forceMeso: message.payload?.forceMeso,
          forceCloud: message.payload?.forceCloud,
        }));
        break;
      case 'dispose':
        break;
      default:
        break;
    }
  }

  dispose() {}
}

class GroupController {
  private readonly listeners = new Set<Listener>();

  private readonly flightSignatures = new Map<string, string>();

  private readonly shipSignatures = new Map<string, string>();

  private readonly satelliteSignatures = new Map<string, string>();

  private readonly cameraSignatures = new Map<string, string>();

  private state: VisualIntelligenceState = EMPTY_VISUAL_INTELLIGENCE_STATE;

  private runtime: RuntimeBridge;

  private tickTimer: number | null = null;

  constructor() {
    this.runtime = this.createRuntime();
    this.startTickLoop();
  }

  private createRuntime(): RuntimeBridge {
    if (typeof window === 'undefined' || typeof Worker === 'undefined') {
      return new LocalRuntimeBridge((state) => this.publish(state));
    }

    try {
      const worker = new Worker(new URL('./groupWorker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (event: MessageEvent<GroupWorkerResponse>) => {
        if (event.data.type === 'state') {
          this.publish(event.data.state);
        }
      };
      return {
        postMessage: (message) => worker.postMessage(message),
        dispose: () => worker.terminate(),
      };
    } catch {
      return new LocalRuntimeBridge((state) => this.publish(state));
    }
  }

  private publish(state: VisualIntelligenceState) {
    this.state = state;
    this.listeners.forEach((listener) => listener());
  }

  private startTickLoop() {
    if (this.tickTimer !== null) {
      return;
    }

    this.tickTimer = globalThis.setInterval(() => {
      this.runtime.postMessage({
        type: 'tick',
        payload: { at: Date.now() },
      });
    }, 80) as unknown as number;
  }

  subscribe(listener: Listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getSnapshot() {
    return this.state;
  }

  pushTrackPatch(patch: GroupInputPatch) {
    if (isPatchEmpty(patch)) {
      return;
    }

    this.runtime.postMessage({
      type: 'patchInput',
      patch: {
        at: Date.now(),
        ...patch,
      },
    });
  }

  pushSources(sources: GroupSourceSnapshot) {
    const flights = diffCollection(sources.flights, this.flightSignatures, (flight) => flight.icao24, makeFlightSignature);
    const ships = diffCollection(sources.ships, this.shipSignatures, (ship) => ship.mmsi, makeShipSignature);
    const satellites = diffCollection(sources.satellites, this.satelliteSignatures, (satellite) => `${satellite.noradId}`, makeSatelliteSignature);
    const cameras = diffCollection(sources.cameras, this.cameraSignatures, (camera) => camera.id, makeCameraSignature);

    const patch: GroupInputPatch = {};
    if (flights.upsert.length > 0 || flights.removeIds.length > 0) {
      patch.flights = flights;
    }
    if (ships.upsert.length > 0 || ships.removeIds.length > 0) {
      patch.ships = ships;
    }
    if (satellites.upsert.length > 0 || satellites.removeIds.length > 0) {
      patch.satellites = satellites;
    }
    if (cameras.upsert.length > 0 || cameras.removeIds.length > 0) {
      patch.cameras = cameras;
    }

    this.pushTrackPatch(patch);
  }

  setSelection(selection: TrackedEntityInfo | null) {
    this.runtime.postMessage({
      type: 'setSelection',
      selection,
    });
  }

  setCameraState(camera: RenderCameraState) {
    this.runtime.postMessage({
      type: 'setCameraState',
      camera,
    });
  }

  dispose() {
    if (this.tickTimer !== null) {
      globalThis.clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    this.runtime.postMessage({ type: 'dispose' });
    this.runtime.dispose();
  }
}

export const groupController = new GroupController();
