import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../runtime/bootstrap';

export interface RoadSegment {
  id: string;
  name: string;
  highway: string;
  maxspeed: number;
  geometry: Array<{ lat: number; lon: number }>;
  length_meters: number;
}

export interface TrafficVehicle {
  id: string;
  roadId: string;
  distanceAlongRoad: number;
  velocity: number;
  heading: number;
  timeCreated: number;
}

interface TrafficRoadResponse {
  roads: RoadSegment[];
}

export function useTraffic(
  enabled: boolean,
  latitude: number,
  longitude: number,
  altitude: number,
  reactUpdateMs = 120,
) {
  const [roads, setRoads] = useState<RoadSegment[]>([]);
  const [vehicles, setVehicles] = useState<TrafficVehicle[]>([]);
  const [loading, setLoading] = useState(false);

  const animationFrameRef = useRef<number | null>(null);
  const vehiclesRef = useRef<TrafficVehicle[]>([]);
  const fetchedBboxRef = useRef<string | null>(null);
  const retryCountRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const roadMapRef = useRef<Map<string, RoadSegment>>(new Map());

  const shouldFetchRoads = altitude < 5_000_000;

  const calculateBbox = useCallback((lat: number, lon: number, alt: number) => {
    const scale = Math.max(0.01, Math.min(alt / 111000, 1.0));
    return {
      south: lat - scale,
      west: lon - scale,
      north: lat + scale,
      east: lon + scale,
    };
  }, []);

  const bboxKey = useCallback((lat: number, lon: number, alt: number) => {
    const precision = 3;
    return `${lat.toFixed(precision)},${lon.toFixed(precision)},${alt.toFixed(0)}`;
  }, []);

  useEffect(() => {
    if (!enabled || !shouldFetchRoads) {
      setRoads([]);
      setVehicles([]);
      vehiclesRef.current = [];
      roadMapRef.current.clear();
      fetchedBboxRef.current = null;
      return;
    }

    const currentKey = bboxKey(latitude, longitude, altitude);
    if (fetchedBboxRef.current === currentKey) return;

    const bbox = calculateBbox(latitude, longitude, altitude);
    const span = Math.max(bbox.north - bbox.south, bbox.east - bbox.west);
    if (span > 2) return;

    let cancelled = false;

    const fetchRoads = async () => {
      setLoading(true);

      const params = new URLSearchParams({
        south: bbox.south.toString(),
        west: bbox.west.toString(),
        north: bbox.north.toString(),
        east: bbox.east.toString(),
      });

      const controller = new AbortController();
      const timeoutId = window.setTimeout(() => controller.abort(), 20_000);

      try {
        const res = await apiFetch(`/traffic/roads?${params}`, {
          signal: controller.signal,
        });
        window.clearTimeout(timeoutId);

        if (!res.ok) throw new Error(`Traffic API HTTP ${res.status}`);
        if (cancelled) return;

        const data: TrafficRoadResponse = await res.json();
        if (cancelled) return;

        fetchedBboxRef.current = currentKey;
        retryCountRef.current = 0;
        setRoads(data.roads);
        roadMapRef.current = new Map(data.roads.map((road) => [road.id, road]));

        const nextVehicles = spawnTrafficVehicles(data.roads);
        vehiclesRef.current = nextVehicles;
        setVehicles(nextVehicles);
      } catch {
        window.clearTimeout(timeoutId);
        if (cancelled) return;

        retryCountRef.current += 1;
        const backoff = Math.min(5000 * Math.pow(2, retryCountRef.current - 1), 30_000);
        retryTimerRef.current = window.setTimeout(() => {
          if (!cancelled) {
            void fetchRoads();
          }
        }, backoff);
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void fetchRoads();

    return () => {
      cancelled = true;
      if (retryTimerRef.current) {
        window.clearTimeout(retryTimerRef.current);
      }
    };
  }, [altitude, bboxKey, calculateBbox, enabled, latitude, longitude, shouldFetchRoads]);

  useEffect(() => {
    if (!enabled || !shouldFetchRoads || roads.length === 0 || vehiclesRef.current.length === 0) {
      return;
    }

    let lastFrameTime = performance.now();
    let lastReactUpdate = 0;

    const animate = (now: number) => {
      const deltaTime = (now - lastFrameTime) / 1000;
      lastFrameTime = now;

      vehiclesRef.current = vehiclesRef.current.map((vehicle) => {
        const road = roadMapRef.current.get(vehicle.roadId);
        if (!road) return vehicle;

        let newDistance = vehicle.distanceAlongRoad + vehicle.velocity * deltaTime;
        if (newDistance > road.length_meters) {
          newDistance -= road.length_meters;
        }

        return { ...vehicle, distanceAlongRoad: newDistance };
      });

      if (now - lastReactUpdate >= reactUpdateMs) {
        lastReactUpdate = now;
        setVehicles([...vehiclesRef.current]);
      }

      animationFrameRef.current = window.requestAnimationFrame(animate);
    };

    animationFrameRef.current = window.requestAnimationFrame(animate);
    return () => {
      if (animationFrameRef.current) {
        window.cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [enabled, reactUpdateMs, roads, shouldFetchRoads]);

  useEffect(() => {
    return () => {
      if (animationFrameRef.current) {
        window.cancelAnimationFrame(animationFrameRef.current);
      }
      if (retryTimerRef.current) {
        window.clearTimeout(retryTimerRef.current);
      }
    };
  }, []);

  return { roads, vehicles, loading, shouldFetchRoads };
}

function spawnTrafficVehicles(roads: RoadSegment[]): TrafficVehicle[] {
  const vehicles: TrafficVehicle[] = [];

  roads.forEach((road) => {
    const density = getVehicleDensity(road.highway);
    const roadLengthKm = road.length_meters / 1000;
    const numVehicles = Math.max(1, Math.floor(roadLengthKm * density));

    for (let index = 0; index < numVehicles; index += 1) {
      vehicles.push({
        id: `vehicle:${road.id}:${index}:${Date.now()}`,
        roadId: road.id,
        distanceAlongRoad: (index / numVehicles) * road.length_meters,
        velocity: getVehicleBaseSpeed(road.highway),
        heading: 0,
        timeCreated: Date.now(),
      });
    }
  });

  return vehicles;
}

function getVehicleBaseSpeed(roadClass: string): number {
  const speedMap: Record<string, number> = {
    motorway: 110,
    trunk: 90,
    primary: 60,
    secondary: 50,
    tertiary: 40,
    residential: 30,
  };

  return (speedMap[roadClass] || 30) / 3.6;
}

function getVehicleDensity(roadClass: string): number {
  const densityMap: Record<string, number> = {
    motorway: 2.0,
    trunk: 1.5,
    primary: 1.0,
    secondary: 0.5,
    tertiary: 0.3,
    residential: 0.2,
  };

  return densityMap[roadClass] || 0.2;
}

export function getHeadingForPosition(road: RoadSegment, distanceAlongRoad: number): number {
  if (road.geometry.length < 2) return 0;

  let accumulatedDistance = 0;
  for (let index = 0; index < road.geometry.length - 1; index += 1) {
    const start = road.geometry[index];
    const end = road.geometry[index + 1];
    const segmentLength = distanceBetweenPoints(start.lat, start.lon, end.lat, end.lon);

    if (accumulatedDistance + segmentLength >= distanceAlongRoad) {
      return bearing(start.lat, start.lon, end.lat, end.lon);
    }

    accumulatedDistance += segmentLength;
  }

  return 0;
}

function distanceBetweenPoints(lat1: number, lon1: number, lat2: number, lon2: number): number {
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

function bearing(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const lat1Rad = (lat1 * Math.PI) / 180;
  const lat2Rad = (lat2 * Math.PI) / 180;
  const deltaLon = ((lon2 - lon1) * Math.PI) / 180;

  const y = Math.sin(deltaLon) * Math.cos(lat2Rad);
  const x = Math.cos(lat1Rad) * Math.sin(lat2Rad) -
    Math.sin(lat1Rad) * Math.cos(lat2Rad) * Math.cos(deltaLon);

  const heading = Math.atan2(y, x);
  return ((heading * 180) / Math.PI + 360) % 360;
}
