import { useCallback, useEffect, useRef } from 'react';
import {
  Cartesian2,
  Cartesian3,
  ConstantProperty,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  defined,
  Entity as CesiumEntity,
} from 'cesium';
import { useCesium } from 'resium';
import type { CameraFeed } from '../../types/camera';
import type { TrackedEntityInfo, TrackedEntityType } from '../../types/trackedEntity';

function isHelperEntity(name: string | undefined) {
  if (!name) return false;
  const normalized = name.toLowerCase();
  return (
    normalized.includes('orbit') ||
    normalized.includes('ground track') ||
    normalized.includes('nadir') ||
    normalized.includes('trail') ||
    normalized.includes('route-origin') ||
    normalized.includes('route-dest') ||
    normalized.includes('prediction') ||
    normalized.includes('relationship') ||
    normalized.includes('influence ring') ||
    normalized.includes('coverage ring') ||
    normalized.includes('anomaly marker')
  );
}

function isCameraFeed(value: unknown): value is CameraFeed {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.latitude === 'number' &&
    typeof candidate.longitude === 'number' &&
    typeof candidate.name === 'string' &&
    typeof candidate.source === 'string'
  );
}

interface EntityClickHandlerProps {
  onTrackEntity?: (info: TrackedEntityInfo | null) => void;
  onCctvClick?: (cameraData: CameraFeed) => void;
}

interface PickResult {
  id?: unknown;
}

export default function EntityClickHandler({ onTrackEntity, onCctvClick }: EntityClickHandlerProps) {
  const { viewer } = useCesium();
  const viewerRef = useRef(viewer);
  const isTrackingRef = useRef(false);
  const onTrackEntityRef = useRef(onTrackEntity);
  const onCctvClickRef = useRef(onCctvClick);

  useEffect(() => {
    viewerRef.current = viewer;
    onTrackEntityRef.current = onTrackEntity;
    onCctvClickRef.current = onCctvClick;
  }, [onCctvClick, onTrackEntity, viewer]);

  const unlock = useCallback(() => {
    const activeViewer = viewerRef.current;
    if (!activeViewer || activeViewer.isDestroyed()) return;

    isTrackingRef.current = false;
    activeViewer.trackedEntity = undefined;
    activeViewer.selectedEntity = undefined;
    onTrackEntityRef.current?.(null);
  }, []);

  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) return;

    const handler = new ScreenSpaceEventHandler(viewer.scene.canvas);

    handler.setInputAction((movement: { position: Cartesian2 }) => {
      const activeViewer = viewerRef.current;
      if (!activeViewer || activeViewer.isDestroyed()) return;

      const pickedList = activeViewer.scene.drillPick(movement.position, 10) as PickResult[];

      let entity: CesiumEntity | null = null;
      for (const picked of pickedList) {
        if (defined(picked?.id) && picked.id instanceof CesiumEntity) {
          const candidate = picked.id as CesiumEntity;
          if (isHelperEntity(candidate.name)) continue;
          if (candidate.position) {
            entity = candidate;
            break;
          }
        }
      }

      let singlePick: PickResult | undefined;
      if (!entity) {
        singlePick = activeViewer.scene.pick(movement.position) as PickResult | undefined;
        if (defined(singlePick?.id) && singlePick?.id instanceof CesiumEntity) {
          const candidate = singlePick.id as CesiumEntity;
          if (!isHelperEntity(candidate.name) && candidate.position) {
            entity = candidate;
          }
        }
      }

      if (!entity) {
        const allPicks = singlePick ? [...pickedList, singlePick] : pickedList;
        for (const picked of allPicks) {
          if (isCameraFeed(picked?.id)) {
            onCctvClickRef.current?.(picked.id);
            return;
          }
        }
      }

      if (!entity) {
        if (isTrackingRef.current || activeViewer.trackedEntity) {
          unlock();
        }
        return;
      }

      const entityType = classifyEntity(entity);
      const info: TrackedEntityInfo = {
        id: typeof entity.id === 'string' ? entity.id : entity.name || 'unknown',
        name: entity.name || 'Unknown',
        entityType,
        description: typeof entity.description?.getValue(activeViewer.clock.currentTime) === 'string'
          ? entity.description.getValue(activeViewer.clock.currentTime)
          : '',
      };

      const offset = entityType === 'satellite'
        ? new Cartesian3(0, -500_000, 500_000)
        : entityType === 'aircraft'
          ? new Cartesian3(0, -30_000, 30_000)
          : entityType === 'ship'
            ? new Cartesian3(0, -1_200, 2_100)
            : entityType === 'facility'
              ? new Cartesian3(0, -3_500, 5_500)
              : entityType === 'earthquake'
                ? new Cartesian3(0, -40_000, 40_000)
            : new Cartesian3(0, -200_000, 200_000);

      entity.viewFrom = new ConstantProperty(offset) as unknown as never;
      activeViewer.trackedEntity = entity;
      isTrackingRef.current = true;
      onTrackEntityRef.current?.(info);
    }, ScreenSpaceEventType.LEFT_CLICK);

    const handleKeyDown = (event: KeyboardEvent) => {
      const activeViewer = viewerRef.current;
      if (event.key === 'Escape' && (isTrackingRef.current || activeViewer?.trackedEntity)) {
        unlock();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      if (!handler.isDestroyed()) handler.destroy();
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [unlock, viewer]);

  return null;
}

function classifyEntity(entity: CesiumEntity): TrackedEntityType {
  if (typeof entity.id === 'string') {
    if (entity.id.startsWith('group-') || entity.id.startsWith('micro-') || entity.id.startsWith('meso-') || entity.id.startsWith('cloud-')) return 'group';
    if (entity.id.startsWith('facility-')) return 'facility';
    if (entity.id.startsWith('cctv-')) return 'cctv';
    if (entity.id.startsWith('sat-')) return 'satellite';
    if (entity.id.startsWith('flight-')) return 'aircraft';
    if (entity.id.startsWith('ship-')) return 'ship';
    if (entity.id.startsWith('eq-')) return 'earthquake';
  }

  const name = (entity.name || '').toLowerCase();
  let description = '';

  try {
    const value = entity.description?.getValue(new Date() as never);
    if (typeof value === 'string') {
      description = value.toLowerCase();
    }
  } catch {
    description = '';
  }

  if (description.includes('norad') || name.includes('iss') || (description.includes('altitude') && description.includes('km'))) {
    return 'satellite';
  }
  if (description.includes('callsign') || description.includes('icao24') || description.includes('aircraft') || description.includes('squawk')) {
    return 'aircraft';
  }
  if (description.includes('mmsi') || description.includes('imo:') || description.includes('call sign') || description.includes('destination')) {
    return 'ship';
  }
  if (description.includes('magnitude') || description.includes('depth')) {
    return 'earthquake';
  }
  if (description.includes('camera') || description.includes('source') || description.includes('country')) {
    return 'cctv';
  }
  if (description.includes('facility') || description.includes('airport') || description.includes('coverage')) {
    return 'facility';
  }
  return 'unknown';
}
