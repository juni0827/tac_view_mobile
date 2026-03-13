import type { MapTilesMode } from '../types/rendering';

function normalizeErrorMessage(error: unknown) {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim();
  }

  if (typeof error === 'string' && error.trim().length > 0) {
    return error.trim();
  }

  return 'unknown error';
}

export function getDefaultMapTiles(googleApiKey: string): MapTilesMode {
  return googleApiKey.trim().length > 0 ? 'google' : 'osm';
}

export function getMissingGoogle3dNotice() {
  return 'GOOGLE 3D unavailable: add client.googleApiKey to appData/tac_view/config.json.';
}

export function getGoogle3dFailureNotice(error: unknown) {
  return `GOOGLE 3D unavailable: ${normalizeErrorMessage(error)}. Falling back to SATELLITE + RELIEF.`;
}

export function getGooglePhotoFailureNotice(error: unknown, hasCesiumIonToken: boolean) {
  const tokenHint = hasCesiumIonToken
    ? ''
    : ' Terrain relief also needs client.cesiumIonToken in appData/tac_view/config.json.';
  return `GOOGLE SATELLITE unavailable: ${normalizeErrorMessage(error)}.${tokenHint}`;
}

export function getOsm3dFailureNotice(feature: 'terrain' | 'buildings', error: unknown, hasCesiumIonToken: boolean) {
  const tokenHint = hasCesiumIonToken
    ? ''
    : ' Add client.cesiumIonToken to appData/tac_view/config.json for reliable OSM 3D.';
  return `OSM ${feature.toUpperCase()} unavailable: ${normalizeErrorMessage(error)}.${tokenHint}`;
}
