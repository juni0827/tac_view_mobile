import { useEffect, useRef } from 'react';
import { useCesium } from 'resium';
import {
  BillboardCollection,
  Cartesian2,
  Cartesian3,
  Color,
  DistanceDisplayCondition,
  HorizontalOrigin,
  Label,
  LabelCollection,
  NearFarScalar,
  VerticalOrigin,
  type Billboard,
} from 'cesium';
import type { CameraFeed } from '../../types/camera';
import { recordLayerPerformance } from '../../lib/performanceStore';

interface CCTVLayerProps {
  cameras: CameraFeed[];
  visible: boolean;
  selectedCameraId: string | null;
}

const COUNTRY_COLORS: Record<string, Color> = {
  GB: Color.fromCssColorString('#00D4FF'),
  US: Color.fromCssColorString('#FF9500'),
  AU: Color.fromCssColorString('#39FF14'),
};

const DEFAULT_COLOR = Color.fromCssColorString('#CCCCCC');
const SELECTED_COLOR = Color.fromCssColorString('#FF3B30');

function createCameraIcon(color: string, size = 16): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) {
    return canvas;
  }

  context.fillStyle = color;
  context.beginPath();
  context.roundRect(2, 4, 10, 8, 1);
  context.fill();

  context.beginPath();
  context.moveTo(12, 5);
  context.lineTo(15, 3);
  context.lineTo(15, 13);
  context.lineTo(12, 11);
  context.closePath();
  context.fill();

  context.fillStyle = '#FF3B30';
  context.beginPath();
  context.arc(5, 7, 1.5, 0, Math.PI * 2);
  context.fill();

  return canvas;
}

const iconCache = new Map<string, HTMLCanvasElement>();

function getCameraIcon(country: string, isSelected: boolean) {
  const key = isSelected ? `${country}-selected` : country;
  if (!iconCache.has(key)) {
    const color = isSelected
      ? '#FF3B30'
      : COUNTRY_COLORS[country]?.toCssColorString() || '#CCCCCC';
    iconCache.set(key, createCameraIcon(color, 20));
  }
  return iconCache.get(key)!;
}

export default function CCTVLayer({ cameras, visible, selectedCameraId }: CCTVLayerProps) {
  const { scene } = useCesium();
  const billboardCollectionRef = useRef<BillboardCollection | null>(null);
  const labelCollectionRef = useRef<LabelCollection | null>(null);
  const primitiveMapRef = useRef<Map<string, { billboard: Billboard; label: Label }>>(new Map());

  useEffect(() => {
    if (!scene) {
      return;
    }

    const billboards = new BillboardCollection({ scene });
    const labels = new LabelCollection({ scene });

    scene.primitives.add(billboards);
    scene.primitives.add(labels);

    billboardCollectionRef.current = billboards;
    labelCollectionRef.current = labels;

    return () => {
      if (!scene.isDestroyed()) {
        scene.primitives.remove(billboards);
        scene.primitives.remove(labels);
      }
      billboardCollectionRef.current = null;
      labelCollectionRef.current = null;
      primitiveMapRef.current.clear();
    };
  }, [scene]);

  useEffect(() => {
    const billboards = billboardCollectionRef.current;
    const labels = labelCollectionRef.current;
    if (!billboards || !labels) {
      return;
    }

    const startedAt = performance.now();

    if (!visible) {
      billboards.show = false;
      labels.show = false;
      recordLayerPerformance('cctv', {
        updateMs: performance.now() - startedAt,
        primitives: primitiveMapRef.current.size * 2,
        visibleCount: 0,
      });
      return;
    }

    billboards.show = true;
    labels.show = true;

    const activeIds = new Set(cameras.map((camera) => camera.id));
    for (const [cameraId, primitives] of primitiveMapRef.current) {
      if (!activeIds.has(cameraId)) {
        billboards.remove(primitives.billboard);
        labels.remove(primitives.label);
        primitiveMapRef.current.delete(cameraId);
      }
    }

    for (const camera of cameras) {
      const isSelected = camera.id === selectedCameraId;
      const position = Cartesian3.fromDegrees(camera.longitude, camera.latitude, 50);
      const baseColor = COUNTRY_COLORS[camera.country] || DEFAULT_COLOR;
      const color = isSelected ? SELECTED_COLOR : baseColor;
      const existing = primitiveMapRef.current.get(camera.id);

      if (existing) {
        existing.billboard.position = position;
        existing.billboard.image = getCameraIcon(camera.country, isSelected) as unknown as string;
        existing.billboard.color = color;
        existing.billboard.scale = isSelected ? 1.5 : 1.0;
        existing.billboard.disableDepthTestDistance = isSelected ? Number.POSITIVE_INFINITY : 0;
        existing.label.position = position;
        existing.label.text = camera.name;
        continue;
      }

      const billboard = billboards.add({
        position,
        image: getCameraIcon(camera.country, isSelected) as unknown as string,
        scale: isSelected ? 1.5 : 1.0,
        color,
        verticalOrigin: VerticalOrigin.CENTER,
        horizontalOrigin: HorizontalOrigin.CENTER,
        scaleByDistance: new NearFarScalar(5_000, 1.2, 500_000, 0.4),
        translucencyByDistance: new NearFarScalar(1_000, 1.0, 2_000_000, 0.3),
        distanceDisplayCondition: new DistanceDisplayCondition(0, 2_000_000),
        disableDepthTestDistance: isSelected ? Number.POSITIVE_INFINITY : 0,
        id: camera,
      });

      const label = labels.add({
        position,
        text: camera.name,
        font: '10px JetBrains Mono, monospace',
        fillColor: Color.WHITE.withAlpha(0.9),
        outlineColor: Color.BLACK,
        outlineWidth: 2,
        style: 2,
        verticalOrigin: VerticalOrigin.TOP,
        horizontalOrigin: HorizontalOrigin.CENTER,
        pixelOffset: new Cartesian2(0, 12),
        scaleByDistance: new NearFarScalar(1_000, 1.0, 100_000, 0.0),
        distanceDisplayCondition: new DistanceDisplayCondition(0, 50_000),
      });

      primitiveMapRef.current.set(camera.id, { billboard, label });
    }

    recordLayerPerformance('cctv', {
      updateMs: performance.now() - startedAt,
      primitives: primitiveMapRef.current.size * 2,
      visibleCount: cameras.length,
    });
  }, [cameras, selectedCameraId, visible]);

  useEffect(() => {
    if (billboardCollectionRef.current) {
      billboardCollectionRef.current.show = visible;
    }
    if (labelCollectionRef.current) {
      labelCollectionRef.current.show = visible;
    }
  }, [visible]);

  return null;
}
