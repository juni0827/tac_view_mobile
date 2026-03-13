import type { OntologyEntity } from '../types/ontology';

const KM_PER_DEGREE_LATITUDE = 111.32;
const EARTH_RADIUS_KM = 6371;

function toRadians(value: number) {
  return (value * Math.PI) / 180;
}

function getEntityFocus(entity: Pick<OntologyEntity, 'geometry'>) {
  if (entity.geometry.latitude != null && entity.geometry.longitude != null) {
    return {
      latitude: entity.geometry.latitude,
      longitude: entity.geometry.longitude,
    };
  }

  const points = Array.isArray(entity.geometry.data.points)
    ? entity.geometry.data.points as Array<Record<string, unknown>>
    : [];

  if (points.length === 0) {
    return null;
  }

  let latitudeSum = 0;
  let longitudeSum = 0;
  let count = 0;

  for (const point of points) {
    const latitude = Number(point.latitude);
    const longitude = Number(point.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      continue;
    }

    latitudeSum += latitude;
    longitudeSum += longitude;
    count += 1;
  }

  if (count === 0) {
    return null;
  }

  return {
    latitude: latitudeSum / count,
    longitude: longitudeSum / count,
  };
}

export function haversineKm(
  latitudeA: number,
  longitudeA: number,
  latitudeB: number,
  longitudeB: number,
) {
  const dLat = toRadians(latitudeB - latitudeA);
  const dLon = toRadians(longitudeB - longitudeA);
  const latARad = toRadians(latitudeA);
  const latBRad = toRadians(latitudeB);
  const term = Math.sin(dLat / 2) ** 2
    + Math.cos(latARad) * Math.cos(latBRad) * Math.sin(dLon / 2) ** 2;
  const centralAngle = 2 * Math.atan2(Math.sqrt(term), Math.sqrt(1 - term));
  return EARTH_RADIUS_KM * centralAngle;
}

export function calculateRadiusBbox(latitude: number, longitude: number, radiusKm: number) {
  const safeRadiusKm = Math.max(1, radiusKm);
  const latitudeDelta = safeRadiusKm / KM_PER_DEGREE_LATITUDE;
  const longitudeScale = Math.max(Math.cos(toRadians(latitude)), 0.05);
  const longitudeDelta = safeRadiusKm / (KM_PER_DEGREE_LATITUDE * longitudeScale);

  return {
    south: Math.max(-90, latitude - latitudeDelta),
    west: Math.max(-180, longitude - longitudeDelta),
    north: Math.min(90, latitude + latitudeDelta),
    east: Math.min(180, longitude + longitudeDelta),
  };
}

export function filterEntitiesByRadius(
  items: OntologyEntity[],
  latitude: number,
  longitude: number,
  radiusKm: number,
) {
  return items.filter((item) => {
    const focus = getEntityFocus(item);
    if (!focus) {
      return false;
    }

    return haversineKm(latitude, longitude, focus.latitude, focus.longitude) <= radiusKm;
  });
}
