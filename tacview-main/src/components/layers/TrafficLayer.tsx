import { useEffect, useMemo, useRef } from 'react';
import { useCesium } from 'resium';
import {
  PolylineCollection,
  PointPrimitiveCollection,
  Cartesian3,
  Color,
  Material,
  type PointPrimitive,
} from 'cesium';
import type { RoadSegment, TrafficVehicle } from '../../hooks/useTraffic';

interface TrafficLayerProps {
  roads: RoadSegment[];
  vehicles: TrafficVehicle[];
  visible: boolean;
  showRoads?: boolean;
  showVehicles?: boolean;
  congestionMode?: boolean;
}

export default function TrafficLayer({
  roads,
  vehicles,
  visible,
  showRoads = true,
  showVehicles = true,
  congestionMode = false,
}: TrafficLayerProps) {
  const { viewer } = useCesium();
  const polylineCollectionRef = useRef<PolylineCollection | null>(null);
  const pointCollectionRef = useRef<PointPrimitiveCollection | null>(null);
  const renderedRoadsRef = useRef(new Set<string>());
  const pointMapRef = useRef(new Map<string, PointPrimitive>());

  const roadMap = useMemo(() => {
    const map = new Map<string, RoadSegment>();
    for (const road of roads) {
      map.set(road.id, road);
    }
    return map;
  }, [roads]);

  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) return;

    const polylines = new PolylineCollection();
    const points = new PointPrimitiveCollection();

    viewer.scene.primitives.add(polylines);
    viewer.scene.primitives.add(points);

    polylineCollectionRef.current = polylines;
    pointCollectionRef.current = points;

    return () => {
      if (!viewer.isDestroyed()) {
        viewer.scene.primitives.remove(polylines);
        viewer.scene.primitives.remove(points);
      }

      polylineCollectionRef.current = null;
      pointCollectionRef.current = null;
      renderedRoadsRef.current.clear();
      pointMapRef.current.clear();
    };
  }, [viewer]);

  useEffect(() => {
    const polylines = polylineCollectionRef.current;
    if (!viewer || viewer.isDestroyed() || !polylines) return;

    if (!visible || !showRoads || roads.length === 0) {
      polylines.show = false;
      return;
    }

    polylines.show = true;

    const nextRoadIds = new Set(roads.map((road) => road.id));
    if (nextRoadIds.size < renderedRoadsRef.current.size) {
      polylines.removeAll();
      renderedRoadsRef.current.clear();
    }

    for (const road of roads) {
      if (renderedRoadsRef.current.has(road.id)) continue;

      const positions = road.geometry.map((point) =>
        Cartesian3.fromDegrees(point.lon, point.lat, 0),
      );

      if (positions.length < 2) continue;

      polylines.add({
        positions,
        width: getRoadWidth(road.highway),
        material: Material.fromType('Color', {
          color: getRoadColor(road.highway, congestionMode),
        }),
      });

      renderedRoadsRef.current.add(road.id);
    }
  }, [congestionMode, roads, showRoads, viewer, visible]);

  useEffect(() => {
    const points = pointCollectionRef.current;
    if (!viewer || viewer.isDestroyed() || !points) return;

    if (!visible || !showVehicles || vehicles.length === 0 || roadMap.size === 0) {
      points.show = false;
      return;
    }

    points.show = true;

    const nextIds = new Set(vehicles.map((vehicle) => vehicle.id));
    for (const [vehicleId, primitive] of pointMapRef.current) {
      if (!nextIds.has(vehicleId)) {
        points.remove(primitive);
        pointMapRef.current.delete(vehicleId);
      }
    }

    for (const vehicle of vehicles) {
      const road = roadMap.get(vehicle.roadId);
      if (!road) continue;

      const { lat, lon } = getPositionAlongRoad(road, vehicle.distanceAlongRoad);
      const position = Cartesian3.fromDegrees(lon, lat, 0);
      const existing = pointMapRef.current.get(vehicle.id);

      if (existing) {
        existing.position = position;
        existing.color = getVehicleColor(road.highway);
        continue;
      }

      const primitive = points.add({
        position,
        pixelSize: 3,
        color: getVehicleColor(road.highway),
        outlineColor: Color.WHITE,
        outlineWidth: 0.5,
      });

      pointMapRef.current.set(vehicle.id, primitive);
    }
  }, [roadMap, showVehicles, vehicles, viewer, visible]);

  useEffect(() => {
    if (polylineCollectionRef.current) {
      polylineCollectionRef.current.show = visible && showRoads;
    }
    if (pointCollectionRef.current) {
      pointCollectionRef.current.show = visible && showVehicles;
    }
  }, [showRoads, showVehicles, visible]);

  return null;
}

function getRoadColor(roadClass: string, congestionMode: boolean): Color {
  if (congestionMode) {
    return Color.fromCssColorString('#00FF00').withAlpha(0.6);
  }

  const colorMap: Record<string, Color> = {
    motorway: Color.fromCssColorString('#FF6B6B').withAlpha(0.7),
    trunk: Color.fromCssColorString('#FF9999').withAlpha(0.7),
    primary: Color.fromCssColorString('#FFA500').withAlpha(0.7),
    secondary: Color.fromCssColorString('#FFD700').withAlpha(0.7),
    tertiary: Color.fromCssColorString('#BFFF00').withAlpha(0.7),
    residential: Color.fromCssColorString('#00BFFF').withAlpha(0.7),
  };

  return colorMap[roadClass] || Color.fromCssColorString('#808080').withAlpha(0.6);
}

function getRoadWidth(roadClass: string): number {
  const widthMap: Record<string, number> = {
    motorway: 3,
    trunk: 2.5,
    primary: 2,
    secondary: 1.5,
    tertiary: 1,
    residential: 0.8,
  };

  return widthMap[roadClass] || 1;
}

function getVehicleColor(roadClass: string): Color {
  const colorMap: Record<string, Color> = {
    motorway: Color.fromCssColorString('#00FF00'),
    trunk: Color.fromCssColorString('#00FF00'),
    primary: Color.fromCssColorString('#FFFF00'),
    secondary: Color.fromCssColorString('#FFFF00'),
    tertiary: Color.fromCssColorString('#FF8800'),
    residential: Color.fromCssColorString('#FF4444'),
  };

  return colorMap[roadClass] || Color.fromCssColorString('#FFFFFF');
}

function getPositionAlongRoad(road: RoadSegment, distanceAlongRoad: number) {
  if (road.geometry.length === 0) {
    return { lat: 0, lon: 0 };
  }

  if (distanceAlongRoad <= 0) {
    const point = road.geometry[0];
    return { lat: point.lat, lon: point.lon };
  }

  let accumulatedDistance = 0;
  for (let index = 0; index < road.geometry.length - 1; index += 1) {
    const start = road.geometry[index];
    const end = road.geometry[index + 1];
    const segmentLength = haversineDistance(start.lat, start.lon, end.lat, end.lon);
    const segmentEnd = accumulatedDistance + segmentLength;

    if (distanceAlongRoad <= segmentEnd) {
      const fraction = (distanceAlongRoad - accumulatedDistance) / segmentLength;
      return {
        lat: start.lat + (end.lat - start.lat) * fraction,
        lon: start.lon + (end.lon - start.lon) * fraction,
      };
    }

    accumulatedDistance = segmentEnd;
  }

  const lastPoint = road.geometry[road.geometry.length - 1];
  return { lat: lastPoint.lat, lon: lastPoint.lon };
}

function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const earthRadius = 6371000;
  const lat1Rad = (lat1 * Math.PI) / 180;
  const lat2Rad = (lat2 * Math.PI) / 180;
  const deltaLat = ((lat2 - lat1) * Math.PI) / 180;
  const deltaLon = ((lon2 - lon1) * Math.PI) / 180;

  const a = Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
    Math.cos(lat1Rad) * Math.cos(lat2Rad) *
    Math.sin(deltaLon / 2) * Math.sin(deltaLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return earthRadius * c;
}
