export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function normalizeLongitude(longitude: number): number {
  const normalized = ((longitude + 180) % 360 + 360) % 360 - 180;
  return normalized === -180 ? 180 : normalized;
}

export function isRenderableLatitude(latitude: unknown): latitude is number {
  return isFiniteNumber(latitude) && latitude >= -90 && latitude <= 90;
}

export function isRenderableLongitude(longitude: unknown): longitude is number {
  return isFiniteNumber(longitude) && longitude >= -3600 && longitude <= 3600;
}

export function isRenderableAltitude(
  altitude: unknown,
  {
    min = -1_000,
    max = 50_000_000,
  }: { min?: number; max?: number } = {},
): altitude is number {
  return isFiniteNumber(altitude) && altitude >= min && altitude <= max;
}

export function sanitizeHeading(heading: unknown): number | null {
  if (!isFiniteNumber(heading)) {
    return null;
  }

  return ((heading % 360) + 360) % 360;
}

export function sanitizeNullableNumber(
  value: unknown,
  {
    min = Number.NEGATIVE_INFINITY,
    max = Number.POSITIVE_INFINITY,
  }: { min?: number; max?: number } = {},
): number | null {
  if (!isFiniteNumber(value) || value < min || value > max) {
    return null;
  }

  return value;
}
