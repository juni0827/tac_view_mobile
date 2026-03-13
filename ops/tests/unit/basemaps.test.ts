import { describe, expect, it } from 'vitest';
import {
  getDefaultMapTiles,
  getGoogle3dFailureNotice,
  getGooglePhotoFailureNotice,
  getMissingGoogle3dNotice,
  getOsm3dFailureNotice,
} from '../../../app/src/lib/basemaps';

describe('basemap helpers', () => {
  it('defaults to google only when a google key exists', () => {
    expect(getDefaultMapTiles('google-key')).toBe('google');
    expect(getDefaultMapTiles('')).toBe('osm');
  });

  it('returns a clear missing google key notice', () => {
    expect(getMissingGoogle3dNotice()).toContain('client.googleApiKey');
    expect(getMissingGoogle3dNotice()).toContain('appData/tac_view/config.json');
  });

  it('adds a cesium ion hint for osm 3d failures without a token', () => {
    const notice = getOsm3dFailureNotice('terrain', new Error('network down'), false);

    expect(notice).toContain('OSM TERRAIN unavailable');
    expect(notice).toContain('network down');
    expect(notice).toContain('client.cesiumIonToken');
  });

  it('formats google 3d failures as an osm fallback notice', () => {
    expect(getGoogle3dFailureNotice(new Error('quota exceeded'))).toContain('SATELLITE + RELIEF');
  });

  it('formats google satellite failures with an optional terrain token hint', () => {
    const notice = getGooglePhotoFailureNotice(new Error('request denied'), false);

    expect(notice).toContain('GOOGLE SATELLITE unavailable');
    expect(notice).toContain('request denied');
    expect(notice).toContain('client.cesiumIonToken');
  });
});
