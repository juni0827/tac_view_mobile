import { useCallback, useEffect, useRef } from 'react';
import {
  Viewer as CesiumViewer,
  Cesium3DTileset,
  Cartesian3,
  Color,
  Ion,
  Math as CesiumMath,
  PostProcessStage,
  GoogleMaps,
  OpenStreetMapImageryProvider,
  createGooglePhotorealistic3DTileset,
} from 'cesium';
import { Viewer, Globe, Scene, Camera, useCesium } from 'resium';
import EntityClickHandler from './EntityClickHandler';
import type { CameraFeed } from '../../types/camera';
import type { TrackedEntityInfo } from '../../types/trackedEntity';
import {
  CRT_SHADER,
  NVG_SHADER,
  FLIR_SHADER,
  SHADER_DEFAULTS,
  type ShaderMode,
} from '../../shaders/postprocess';
import { getRuntimeClientConfig } from '../../runtime/bootstrap';

interface GlobeViewerProps {
  shaderMode: ShaderMode;
  mapTiles: 'google' | 'osm';
  onCameraChange?: (lat: number, lon: number, alt: number, heading: number, pitch: number) => void;
  onViewerReady?: (viewer: CesiumViewer) => void;
  onTrackEntity?: (info: TrackedEntityInfo | null) => void;
  onCctvClick?: (cameraData: CameraFeed) => void;
  children?: React.ReactNode;
}

// Default camera: Sydney, Australia — zoomed out to see the full globe
const DEFAULT_POSITION = Cartesian3.fromDegrees(151.2093, -33.8688, 20_000_000);
const DEFAULT_HEADING = CesiumMath.toRadians(0);
const DEFAULT_PITCH = CesiumMath.toRadians(-90);

// Stable constants — prevents resium from recreating the Viewer on every render
const CONTEXT_OPTIONS = {
  webgl: {
    alpha: false,
    depth: true,
    stencil: false,
    antialias: true,
    preserveDrawingBuffer: true,
  },
};
const SCENE_BG_COLOR = new Color(0.04, 0.04, 0.04, 1.0);

/** Apply OpenStreetMap imagery to the viewer as a fallback */
function applyOSM(viewer: CesiumViewer) {
  if (viewer.isDestroyed()) return;
  const osmProvider = new OpenStreetMapImageryProvider({
    url: 'https://tile.openstreetmap.org/',
  });
  viewer.imageryLayers.removeAll();
  viewer.imageryLayers.addImageryProvider(osmProvider);
}

/**
 * Inner component that lives inside <Viewer> so it can use useCesium().
 * Manages PostProcessStage lifecycle safely.
 */
function ShaderManager({ shaderMode }: { shaderMode: ShaderMode }) {
  const { viewer } = useCesium();
  const shaderStageRef = useRef<PostProcessStage | null>(null);

  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) return;

    // Remove existing shader
    if (shaderStageRef.current) {
      try {
        viewer.scene.postProcessStages.remove(shaderStageRef.current);
      } catch {
        // Stage may already have been removed if viewer was recreated
      }
      shaderStageRef.current = null;
    }

    if (shaderMode === 'none') return;

    let fragmentShader: string;
    let uniforms: Record<string, unknown>;

    switch (shaderMode) {
      case 'crt':
        fragmentShader = CRT_SHADER;
        uniforms = { ...SHADER_DEFAULTS.crt };
        break;
      case 'nvg':
        fragmentShader = NVG_SHADER;
        uniforms = { ...SHADER_DEFAULTS.nvg };
        break;
      case 'flir':
        fragmentShader = FLIR_SHADER;
        uniforms = { ...SHADER_DEFAULTS.flir };
        break;
      default:
        return;
    }

    const stage = new PostProcessStage({ fragmentShader, uniforms });
    viewer.scene.postProcessStages.add(stage);
    shaderStageRef.current = stage;

    return () => {
      if (shaderStageRef.current && viewer && !viewer.isDestroyed()) {
        try {
          viewer.scene.postProcessStages.remove(shaderStageRef.current);
        } catch {
          // Cleanup best-effort
        }
        shaderStageRef.current = null;
      }
    };
  }, [shaderMode, viewer]);

  return null;
}

export default function GlobeViewer({ shaderMode, mapTiles, onCameraChange, onViewerReady, onTrackEntity, onCctvClick, children }: GlobeViewerProps) {
  const viewerRef = useRef<CesiumViewer | null>(null);
  const google3dReadyRef = useRef(false);
  const google3dTilesetRef = useRef<Cesium3DTileset | null>(null);
  const { googleApiKey, cesiumIonToken } = getRuntimeClientConfig();

  const loadGoogleTiles = useCallback(async (viewer: CesiumViewer) => {
    if (googleApiKey) {
      GoogleMaps.defaultApiKey = googleApiKey;
    }
    if (cesiumIonToken) {
      Ion.defaultAccessToken = cesiumIonToken;
    }

    const globe = viewer.scene.globe;
    viewer.imageryLayers.removeAll();
    if (globe) globe.show = false;

    const tileset = await createGooglePhotorealistic3DTileset();
    if (viewer.isDestroyed()) return;

    viewer.scene.primitives.add(tileset);
    google3dTilesetRef.current = tileset;
    google3dReadyRef.current = true;
  }, [cesiumIonToken, googleApiKey]);

  // Apply Google 3D Tiles on viewer ready
  const handleViewerReady = useCallback(async (viewer: CesiumViewer) => {
    viewerRef.current = viewer;

    // Configure globe defaults
    const globe = viewer.scene.globe;
    if (globe) {
      globe.baseColor = Color.BLACK;
      globe.depthTestAgainstTerrain = true;
      globe.showGroundAtmosphere = true;
      globe.translucency.enabled = false;
      globe.translucency.frontFaceAlpha = 1.0;
      globe.translucency.backFaceAlpha = 1.0;
    }

    // Only attempt Google tiles if mapTiles === 'google'
    if (mapTiles === 'google' && googleApiKey) {
      try {
        // Clear imagery & hide the globe so its black surface doesn't bleed
        // through gaps in the Google 3D tileset
        await loadGoogleTiles(viewer);
      } catch (err) {
        console.warn('Google 3D Tiles failed to load — falling back to OSM.', err);
        if (globe) globe.show = true;
        applyOSM(viewer);
      }
    } else {
      if (globe) globe.show = true;
      applyOSM(viewer);
    }

    // Fly to default position
    viewer.camera.flyTo({
      destination: DEFAULT_POSITION,
      orientation: {
        heading: DEFAULT_HEADING,
        pitch: DEFAULT_PITCH,
        roll: 0,
      },
      duration: 3,
    });

    // Camera move listener — report position to parent
    viewer.camera.changed.addEventListener(() => {
      if (!onCameraChange || viewer.isDestroyed()) return;
      const carto = viewer.camera.positionCartographic;
      onCameraChange(
        CesiumMath.toDegrees(carto.latitude),
        CesiumMath.toDegrees(carto.longitude),
        carto.height,
        CesiumMath.toDegrees(viewer.camera.heading),
        CesiumMath.toDegrees(viewer.camera.pitch),
      );
    });
    // Lower the threshold so it fires more frequently
    viewer.camera.percentageChanged = 0.01;

    onViewerReady?.(viewer);
  }, [googleApiKey, loadGoogleTiles, mapTiles, onCameraChange, onViewerReady]);

  // React to mapTiles changes after initial mount
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || viewer.isDestroyed()) return;

    const globe = viewer.scene.globe;

    if (mapTiles === 'google' && !google3dReadyRef.current && googleApiKey) {
      // Switch to Google 3D Tiles — hide globe & strip OSM imagery
      (async () => {
        try {
          await loadGoogleTiles(viewer);
        } catch (err) {
          console.warn('Google 3D Tiles failed, staying on OSM.', err);
          if (globe) globe.show = true;
          applyOSM(viewer);
        }
      })();
    } else if (mapTiles === 'osm') {
      // Remove Google 3D tileset (if present) and switch to OSM
      if (google3dTilesetRef.current) {
        try {
          viewer.scene.primitives.remove(google3dTilesetRef.current);
        } catch { /* already removed */ }
        google3dTilesetRef.current = null;
      }
      google3dReadyRef.current = false;
      if (globe) globe.show = true;
      applyOSM(viewer);
    }
  }, [googleApiKey, loadGoogleTiles, mapTiles]);

  return (
    <Viewer
      full
      ref={(e) => {
        if (e?.cesiumElement && e.cesiumElement !== viewerRef.current) {
          handleViewerReady(e.cesiumElement);
        }
      }}
      animation={false}
      baseLayerPicker={false}
      baseLayer={false as never}
      shouldAnimate={true}
      fullscreenButton={false}
      geocoder={false}
      homeButton={false}
      infoBox={false}
      navigationHelpButton={false}
      sceneModePicker={false}
      selectionIndicator={false}
      timeline={false}
      orderIndependentTranslucency={false}
      contextOptions={CONTEXT_OPTIONS}
    >
      <Scene backgroundColor={SCENE_BG_COLOR} />
      {/* Globe is always shown so its spherical geometry contributes to the
          depth buffer — this occludes billboards/labels on the far side of
          Earth. When Google 3D Tiles are active they render on top visually,
          but the globe still provides the depth sphere underneath. */}
      <Globe
        enableLighting={true}
        depthTestAgainstTerrain={true}
        baseColor={Color.BLACK}
      />
      <Camera />
      <ShaderManager shaderMode={shaderMode} />
      <EntityClickHandler onTrackEntity={onTrackEntity} onCctvClick={onCctvClick} />
      {children}
    </Viewer>
  );
}
