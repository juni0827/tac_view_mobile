import { useCallback, useEffect, useRef } from 'react';
import {
  Viewer as CesiumViewer,
  Cesium3DTileset,
  Cartesian3,
  Color,
  GoogleMaps,
  Ion,
  Math as CesiumMath,
  OpenStreetMapImageryProvider,
  PostProcessStage,
  createGooglePhotorealistic3DTileset,
} from 'cesium';
import { Camera, Globe, Scene, Viewer, useCesium } from 'resium';
import EntityClickHandler from './EntityClickHandler';
import type { CameraFeed } from '../../types/camera';
import type { TrackedEntityInfo } from '../../types/trackedEntity';
import { updatePerformanceSnapshot } from '../../lib/performanceStore';
import { RenderBudgetController } from '../../lib/renderBudget';
import {
  CRT_SHADER,
  FLIR_SHADER,
  NVG_SHADER,
  SHADER_DEFAULTS,
  type ShaderMode,
} from '../../shaders/postprocess';
import { getRuntimeClientConfig } from '../../runtime/bootstrap';

interface GlobeViewerProps {
  shaderMode: ShaderMode;
  mapTiles: 'google' | 'osm';
  onCameraChange?: (lat: number, lon: number, alt: number, heading: number, pitch: number) => void;
  onCameraMoveEnd?: (lat: number, lon: number, alt: number, heading: number, pitch: number) => void;
  onViewerReady?: (viewer: CesiumViewer) => void;
  onRenderFailure?: (error: unknown) => void;
  onTrackEntity?: (info: TrackedEntityInfo | null) => void;
  onCctvClick?: (cameraData: CameraFeed) => void;
  children?: React.ReactNode;
}

const DEFAULT_POSITION = Cartesian3.fromDegrees(151.2093, -33.8688, 20_000_000);
const DEFAULT_HEADING = CesiumMath.toRadians(0);
const DEFAULT_PITCH = CesiumMath.toRadians(-90);
const CONTEXT_OPTIONS = {
  webgl: {
    alpha: false,
    depth: true,
    stencil: false,
    antialias: true,
    preserveDrawingBuffer: false,
  },
};
const SCENE_BG_COLOR = new Color(0.04, 0.04, 0.04, 1.0);

function applyOSM(viewer: CesiumViewer) {
  if (viewer.isDestroyed()) {
    return;
  }

  const provider = new OpenStreetMapImageryProvider({
    url: 'https://tile.openstreetmap.org/',
  });
  viewer.imageryLayers.removeAll();
  viewer.imageryLayers.addImageryProvider(provider);
}

function ShaderManager({ shaderMode }: { shaderMode: ShaderMode }) {
  const { viewer } = useCesium();
  const shaderStageRef = useRef<PostProcessStage | null>(null);

  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) {
      return;
    }

    if (shaderStageRef.current) {
      try {
        viewer.scene.postProcessStages.remove(shaderStageRef.current);
      } catch {
        // Best-effort cleanup.
      }
      shaderStageRef.current = null;
    }

    if (shaderMode === 'none') {
      return;
    }

    let fragmentShader = '';
    let uniforms: Record<string, unknown> = {};

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
      if (!viewer.isDestroyed() && shaderStageRef.current) {
        try {
          viewer.scene.postProcessStages.remove(shaderStageRef.current);
        } catch {
          // Best-effort cleanup.
        }
      }
      shaderStageRef.current = null;
    };
  }, [shaderMode, viewer]);

  return null;
}

export default function GlobeViewer({
  shaderMode,
  mapTiles,
  onCameraChange,
  onCameraMoveEnd,
  onViewerReady,
  onRenderFailure,
  onTrackEntity,
  onCctvClick,
  children,
}: GlobeViewerProps) {
  const viewerRef = useRef<CesiumViewer | null>(null);
  const google3dReadyRef = useRef(false);
  const google3dTilesetRef = useRef<Cesium3DTileset | null>(null);
  const renderErrorCleanupRef = useRef<(() => void) | null>(null);
  const postRenderCleanupRef = useRef<(() => void) | null>(null);
  const cameraChangedCleanupRef = useRef<(() => void) | null>(null);
  const cameraMoveEndCleanupRef = useRef<(() => void) | null>(null);
  const webglContextCleanupRef = useRef<(() => void) | null>(null);
  const onCameraChangeRef = useRef(onCameraChange);
  const onCameraMoveEndRef = useRef(onCameraMoveEnd);
  const onViewerReadyRef = useRef(onViewerReady);
  const onRenderFailureRef = useRef(onRenderFailure);
  const mapTilesRef = useRef(mapTiles);
  const lastFrameAtRef = useRef<number | null>(null);
  const budgetControllerRef = useRef(new RenderBudgetController());
  const { googleApiKey, cesiumIonToken } = getRuntimeClientConfig();

  useEffect(() => {
    onCameraChangeRef.current = onCameraChange;
    onCameraMoveEndRef.current = onCameraMoveEnd;
    onViewerReadyRef.current = onViewerReady;
    onRenderFailureRef.current = onRenderFailure;
    mapTilesRef.current = mapTiles;
  }, [mapTiles, onCameraChange, onCameraMoveEnd, onRenderFailure, onViewerReady]);

  const emitCamera = useCallback(
    (viewer: CesiumViewer, callback?: (lat: number, lon: number, alt: number, heading: number, pitch: number) => void) => {
      if (!callback || viewer.isDestroyed()) {
        return;
      }

      const cartographic = viewer.camera.positionCartographic;
      callback(
        CesiumMath.toDegrees(cartographic.latitude),
        CesiumMath.toDegrees(cartographic.longitude),
        cartographic.height,
        CesiumMath.toDegrees(viewer.camera.heading),
        CesiumMath.toDegrees(viewer.camera.pitch),
      );
    },
    [],
  );

  const loadGoogleTiles = useCallback(async (viewer: CesiumViewer) => {
    if (googleApiKey) {
      GoogleMaps.defaultApiKey = googleApiKey;
    }
    if (cesiumIonToken) {
      Ion.defaultAccessToken = cesiumIonToken;
    }

    const globe = viewer.scene.globe;
    viewer.imageryLayers.removeAll();
    if (globe) {
      globe.show = false;
    }

    const tileset = await createGooglePhotorealistic3DTileset();
    if (viewer.isDestroyed()) {
      return;
    }

    viewer.scene.primitives.add(tileset);
    google3dTilesetRef.current = tileset;
    google3dReadyRef.current = true;
  }, [cesiumIonToken, googleApiKey]);

  const handleViewerReady = useCallback(async (viewer: CesiumViewer) => {
    viewerRef.current = viewer;
    viewer.targetFrameRate = 60;

    renderErrorCleanupRef.current?.();
    renderErrorCleanupRef.current = viewer.scene.renderError.addEventListener((_scene, error) => {
      console.error('[TAC_VIEW] Cesium render failure', error);
      viewer.useDefaultRenderLoop = false;
      onRenderFailureRef.current?.(error);
    });

    postRenderCleanupRef.current?.();
    lastFrameAtRef.current = null;
    postRenderCleanupRef.current = viewer.scene.postRender.addEventListener(() => {
      const now = performance.now();
      const lastFrameAt = lastFrameAtRef.current;
      const duration = lastFrameAt === null ? 16.67 : Math.max(1, now - lastFrameAt);
      lastFrameAtRef.current = now;

      const controller = budgetControllerRef.current;
      controller.pushFrame(now, duration, mapTilesRef.current);

      if (mapTilesRef.current === 'google') {
        const nextScale = controller.getResolutionScale();
        if (Math.abs(viewer.resolutionScale - nextScale) > 0.001) {
          viewer.resolutionScale = nextScale;
        }

        const fxaaEnabled = nextScale >= 0.9;
        try {
          const sceneWithFxaa = viewer.scene as typeof viewer.scene & {
            fxaa?: boolean;
            postProcessStages: typeof viewer.scene.postProcessStages & {
              fxaa?: { enabled: boolean };
            };
          };
          sceneWithFxaa.fxaa = fxaaEnabled;
          const fxaaStage = sceneWithFxaa.postProcessStages.fxaa;
          if (fxaaStage) {
            fxaaStage.enabled = fxaaEnabled;
          }
        } catch {
          // Best-effort only.
        }
      } else if (viewer.resolutionScale !== 1) {
        viewer.resolutionScale = 1;
        try {
          const sceneWithFxaa = viewer.scene as typeof viewer.scene & {
            fxaa?: boolean;
            postProcessStages: typeof viewer.scene.postProcessStages & {
              fxaa?: { enabled: boolean };
            };
          };
          sceneWithFxaa.fxaa = true;
          const fxaaStage = sceneWithFxaa.postProcessStages.fxaa;
          if (fxaaStage) {
            fxaaStage.enabled = true;
          }
        } catch {
          // Best-effort only.
        }
      }

      updatePerformanceSnapshot({
        fps: controller.getFps(),
        frameTimeAvg: controller.getAverageFrameTime(),
        frameTimeMax: controller.getMaxFrameTime(),
        resolutionScale: viewer.resolutionScale,
        googleQualityGovernorActive: controller.isGovernorActive(),
      });
    });

    cameraChangedCleanupRef.current?.();
    const onChanged = () => {
      emitCamera(viewer, onCameraChangeRef.current);
    };
    viewer.camera.changed.addEventListener(onChanged);
    cameraChangedCleanupRef.current = () => {
      try {
        viewer.camera.changed.removeEventListener(onChanged);
      } catch {
        // Best-effort cleanup.
      }
    };

    cameraMoveEndCleanupRef.current?.();
    const onMoveEnd = () => {
      emitCamera(viewer, onCameraMoveEndRef.current);
    };
    viewer.camera.moveEnd.addEventListener(onMoveEnd);
    cameraMoveEndCleanupRef.current = () => {
      try {
        viewer.camera.moveEnd.removeEventListener(onMoveEnd);
      } catch {
        // Best-effort cleanup.
      }
    };

    webglContextCleanupRef.current?.();
    const handleContextLoss = (event: Event) => {
      event.preventDefault();
      const error = new Error('WebGL context lost');
      console.error('[TAC_VIEW] WebGL context lost');
      viewer.useDefaultRenderLoop = false;
      onRenderFailureRef.current?.(error);
    };
    viewer.scene.canvas.addEventListener('webglcontextlost', handleContextLoss, { passive: false });
    webglContextCleanupRef.current = () => {
      viewer.scene.canvas.removeEventListener('webglcontextlost', handleContextLoss);
    };

    const globe = viewer.scene.globe;
    if (globe) {
      globe.baseColor = Color.BLACK;
      globe.depthTestAgainstTerrain = true;
      globe.showGroundAtmosphere = mapTiles === 'google';
      globe.translucency.enabled = false;
      globe.translucency.frontFaceAlpha = 1;
      globe.translucency.backFaceAlpha = 1;
    }
    if (viewer.scene.skyAtmosphere) {
      viewer.scene.skyAtmosphere.show = mapTiles === 'google';
    }
    viewer.scene.fog.enabled = mapTiles === 'google';

    if (mapTiles === 'google' && googleApiKey) {
      try {
        await loadGoogleTiles(viewer);
      } catch (error) {
        console.warn('Google 3D Tiles failed to load, falling back to OSM.', error);
        if (globe) {
          globe.show = true;
        }
        applyOSM(viewer);
      }
    } else {
      if (globe) {
        globe.show = true;
      }
      applyOSM(viewer);
    }

    viewer.camera.flyTo({
      destination: DEFAULT_POSITION,
      orientation: {
        heading: DEFAULT_HEADING,
        pitch: DEFAULT_PITCH,
        roll: 0,
      },
      duration: 3,
    });

    viewer.camera.percentageChanged = 0.01;
    onViewerReadyRef.current?.(viewer);
  }, [emitCamera, googleApiKey, loadGoogleTiles, mapTiles]);

  useEffect(() => {
    return () => {
      renderErrorCleanupRef.current?.();
      renderErrorCleanupRef.current = null;
      postRenderCleanupRef.current?.();
      postRenderCleanupRef.current = null;
      cameraChangedCleanupRef.current?.();
      cameraChangedCleanupRef.current = null;
      cameraMoveEndCleanupRef.current?.();
      cameraMoveEndCleanupRef.current = null;
      webglContextCleanupRef.current?.();
      webglContextCleanupRef.current = null;
    };
  }, []);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || viewer.isDestroyed()) {
      return;
    }

    const globe = viewer.scene.globe;

    if (mapTiles === 'google' && !google3dReadyRef.current && googleApiKey) {
      void (async () => {
        try {
          await loadGoogleTiles(viewer);
        } catch (error) {
          console.warn('Google 3D Tiles failed, staying on OSM.', error);
          if (globe) {
            globe.show = true;
          }
          applyOSM(viewer);
        }
      })();
    } else if (mapTiles === 'osm') {
      if (google3dTilesetRef.current) {
        try {
          viewer.scene.primitives.remove(google3dTilesetRef.current);
        } catch {
          // Best-effort cleanup.
        }
        google3dTilesetRef.current = null;
      }

      google3dReadyRef.current = false;
      if (globe) {
        globe.show = true;
        globe.showGroundAtmosphere = false;
      }
      if (viewer.scene.skyAtmosphere) {
        viewer.scene.skyAtmosphere.show = false;
      }
      viewer.scene.fog.enabled = false;
      viewer.resolutionScale = 1;
      applyOSM(viewer);
    } else if (mapTiles === 'google') {
      if (globe) {
        globe.showGroundAtmosphere = true;
      }
      if (viewer.scene.skyAtmosphere) {
        viewer.scene.skyAtmosphere.show = true;
      }
      viewer.scene.fog.enabled = true;
    }
  }, [googleApiKey, loadGoogleTiles, mapTiles]);

  return (
    <Viewer
      full
      ref={(element) => {
        if (element?.cesiumElement && element.cesiumElement !== viewerRef.current) {
          void handleViewerReady(element.cesiumElement);
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
      showRenderLoopErrors={false}
      timeline={false}
      targetFrameRate={60}
      orderIndependentTranslucency={false}
      contextOptions={CONTEXT_OPTIONS}
    >
      <Scene backgroundColor={SCENE_BG_COLOR} />
      <Globe
        enableLighting={mapTiles === 'google'}
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
