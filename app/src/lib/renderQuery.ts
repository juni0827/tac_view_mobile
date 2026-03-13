import type { RenderBudget, RenderCameraState } from '../types/rendering';

export interface SpatialItem {
  id: string;
  latitude: number;
  longitude: number;
}

export class GridSpatialIndex<T extends SpatialItem> {
  private readonly cellSizeDegrees: number;

  private readonly cells = new Map<string, T[]>();

  private readonly items: T[];

  constructor(items: T[], cellSizeDegrees: number) {
    this.items = items;
    this.cellSizeDegrees = cellSizeDegrees;

    for (const item of items) {
      const key = this.toKey(item.latitude, item.longitude);
      const bucket = this.cells.get(key);
      if (bucket) {
        bucket.push(item);
      } else {
        this.cells.set(key, [item]);
      }
    }
  }

  all() {
    return this.items;
  }

  queryRadius(latitude: number, longitude: number, radiusKm: number) {
    if (!Number.isFinite(radiusKm) || radiusKm >= 20_000) {
      return this.items;
    }

    const degrees = radiusKm / 111;
    const latMin = latitude - degrees;
    const latMax = latitude + degrees;
    const lonMin = longitude - degrees;
    const lonMax = longitude + degrees;

    const latCellMin = Math.floor(latMin / this.cellSizeDegrees);
    const latCellMax = Math.floor(latMax / this.cellSizeDegrees);
    const lonCellMin = Math.floor(lonMin / this.cellSizeDegrees);
    const lonCellMax = Math.floor(lonMax / this.cellSizeDegrees);

    const results: T[] = [];
    for (let latCell = latCellMin; latCell <= latCellMax; latCell += 1) {
      for (let lonCell = lonCellMin; lonCell <= lonCellMax; lonCell += 1) {
        const bucket = this.cells.get(`${latCell}:${lonCell}`);
        if (!bucket) {
          continue;
        }
        results.push(...bucket);
      }
    }

    return results;
  }

  private toKey(latitude: number, longitude: number) {
    return `${Math.floor(latitude / this.cellSizeDegrees)}:${Math.floor(longitude / this.cellSizeDegrees)}`;
  }
}

export interface PrioritySelectionOptions<T extends SpatialItem> {
  budget: number;
  camera: RenderCameraState;
  trackedId?: string | null;
  selectedId?: string | null;
  priorityIds?: Set<string>;
  index?: GridSpatialIndex<T>;
  queryRadiusKm?: number;
}

function distanceKm(
  latitudeA: number,
  longitudeA: number,
  latitudeB: number,
  longitudeB: number,
) {
  const earthRadiusKm = 6371;
  const dLat = ((latitudeB - latitudeA) * Math.PI) / 180;
  const dLon = ((longitudeB - longitudeA) * Math.PI) / 180;
  const latARad = (latitudeA * Math.PI) / 180;
  const latBRad = (latitudeB * Math.PI) / 180;

  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(latARad) * Math.cos(latBRad) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthRadiusKm * c;
}

export function estimateQueryRadiusKm(camera: RenderCameraState) {
  if (camera.altitude < 250_000) return 450;
  if (camera.altitude < 1_000_000) return 900;
  if (camera.altitude < 4_000_000) return 2_400;
  if (camera.altitude < 10_000_000) return 4_800;
  return Number.POSITIVE_INFINITY;
}

export function selectPriorityItems<T extends SpatialItem>(
  items: T[],
  options: PrioritySelectionOptions<T>,
) {
  const {
    budget,
    camera,
    trackedId = null,
    selectedId = null,
    priorityIds = new Set<string>(),
    index,
    queryRadiusKm = estimateQueryRadiusKm(camera),
  } = options;

  if (budget <= 0 || items.length === 0) {
    return [] as T[];
  }

  const candidatePool = index
    ? index.queryRadius(camera.latitude, camera.longitude, queryRadiusKm)
    : items;

  if (candidatePool.length <= budget) {
    return candidatePool;
  }

  const scored = candidatePool.map((item) => {
    const distance = distanceKm(camera.latitude, camera.longitude, item.latitude, item.longitude);
    let score = -distance;

    if (item.id === trackedId) {
      score += 1_000_000;
    }
    if (item.id === selectedId) {
      score += 750_000;
    }
    if (priorityIds.has(item.id)) {
      score += 250_000;
    }

    if (distance < 50) {
      score += 15_000;
    } else if (distance < 250) {
      score += 8_000;
    } else if (distance < 1_000) {
      score += 3_500;
    }

    return { item, score };
  });

  scored.sort((left, right) => right.score - left.score);
  return scored.slice(0, budget).map((entry) => entry.item);
}

export function deriveRenderPriorityIds(selectionContext: {
  entityId: string;
  relatedEntities: Array<{ id: string }>;
  relationships: Array<{ sourceId: string; targetId: string }>;
  relatedMicroGroups: Array<{ id: string; memberIds: string[] }>;
  relatedMesoGroups: Array<{ id: string; representativeTrackIds: string[]; microGroupIds: string[] }>;
  relatedClouds: Array<{ id: string; cells: Array<{ representativeIds: string[] }> }>;
  destinationCandidates: Array<{ id: string }>;
} | null) {
  const priorityIds = new Set<string>();

  if (!selectionContext) {
    return priorityIds;
  }

  priorityIds.add(selectionContext.entityId);

  for (const entity of selectionContext.relatedEntities) {
    priorityIds.add(entity.id);
  }
  for (const relationship of selectionContext.relationships) {
    priorityIds.add(relationship.sourceId);
    priorityIds.add(relationship.targetId);
  }
  for (const group of selectionContext.relatedMicroGroups) {
    priorityIds.add(group.id);
    for (const memberId of group.memberIds) {
      priorityIds.add(memberId);
    }
  }
  for (const group of selectionContext.relatedMesoGroups) {
    priorityIds.add(group.id);
    for (const representativeTrackId of group.representativeTrackIds) {
      priorityIds.add(representativeTrackId);
    }
    for (const microGroupId of group.microGroupIds) {
      priorityIds.add(microGroupId);
    }
  }
  for (const cloud of selectionContext.relatedClouds) {
    priorityIds.add(cloud.id);
    for (const cell of cloud.cells) {
      for (const representativeId of cell.representativeIds) {
        priorityIds.add(representativeId);
      }
    }
  }
  for (const candidate of selectionContext.destinationCandidates) {
    priorityIds.add(candidate.id);
  }

  return priorityIds;
}

export function getLayerBudgetCount(budget: RenderBudget, layer: keyof Pick<RenderBudget, 'flights' | 'satellites' | 'earthquakes' | 'cctv' | 'ships'>) {
  return budget[layer];
}
