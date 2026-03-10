import type { AirportCoords } from '../data/airports';
import type { Flight } from '../hooks/useFlights';

const EARTH_RADIUS_KM = 6371;
const FEET_PER_METER = 3.28084;
const HISTORY_RETENTION_MS = 12 * 60 * 1000;
const HISTORY_MAX_POINTS = 18;
const HISTORY_MIN_SAMPLE_MS = 4000;
const HISTORY_MIN_DISTANCE_KM = 1.25;
const HISTORY_MIN_ALTITUDE_DELTA_METERS = 120;
const LOCAL_FLOW_ALTITUDE_DELTA_METERS = 2200;
const PREDICTION_STEPS_MINUTES = [2, 2, 3, 4, 4, 5, 6];

export interface FlightPathPoint {
  latitude: number;
  longitude: number;
  altitude: number;
}

export interface FlightTrackSample extends FlightPathPoint {
  timestamp: number;
  heading: number | null;
  speedKnots: number | null;
  verticalRate: number | null;
}

export interface FlightPathGeometry {
  completed: FlightPathPoint[];
  remaining: FlightPathPoint[];
}

interface FlowSnapshot {
  altitude: number | null;
  heading: number | null;
  sampleCount: number;
  speedKnots: number | null;
  verticalRate: number | null;
}

type FlightPhase = 'approach' | 'climb' | 'cruise' | 'departure' | 'descent';

export function appendFlightTrackSample(
  history: FlightTrackSample[],
  flight: Flight,
  timestamp = Date.now(),
) {
  const sample: FlightTrackSample = {
    latitude: flight.latitude,
    longitude: normalizeLongitude(flight.longitude),
    altitude: flight.altitude,
    timestamp,
    heading: flight.heading,
    speedKnots: flight.velocityKnots,
    verticalRate: flight.verticalRate,
  };

  const retained = history.filter((entry) => timestamp - entry.timestamp <= HISTORY_RETENTION_MS);
  const last = retained[retained.length - 1];
  if (last) {
    const elapsedMs = sample.timestamp - last.timestamp;
    const distanceKm = haversineKm(last.latitude, last.longitude, sample.latitude, sample.longitude);
    const altitudeDelta = Math.abs(sample.altitude - last.altitude);
    if (
      elapsedMs < HISTORY_MIN_SAMPLE_MS &&
      distanceKm < HISTORY_MIN_DISTANCE_KM &&
      altitudeDelta < HISTORY_MIN_ALTITUDE_DELTA_METERS
    ) {
      return retained;
    }
  }

  const next = [...retained, sample];
  return next.length > HISTORY_MAX_POINTS
    ? next.slice(next.length - HISTORY_MAX_POINTS)
    : next;
}

export function buildFlightPathGeometry(
  flight: Flight,
  options: {
    airspaceRangeKm?: number;
    destination?: AirportCoords | null;
    history: FlightTrackSample[];
    nearbyFlights: Flight[];
    origin?: AirportCoords | null;
  },
): FlightPathGeometry {
  const history = options.history.filter((entry) => Date.now() - entry.timestamp <= HISTORY_RETENTION_MS);
  const completed = buildCompletedPath(flight, history, options.origin);
  const remaining = buildPredictedPath(
    flight,
    history,
    options.nearbyFlights,
    options.origin,
    options.destination,
    options.airspaceRangeKm,
  );
  return { completed, remaining };
}

function buildCompletedPath(
  flight: Flight,
  history: FlightTrackSample[],
  origin?: AirportCoords | null,
) {
  if (history.length >= 2) {
    const points = downsamplePoints(history.map(toPoint), 10);
    if (origin && shouldPrefixOrigin(origin, points[0]!, flight.altitudeFeet)) {
      return [{ latitude: origin.lat, longitude: origin.lon, altitude: 450 }, ...points];
    }
    return points;
  }

  const backtrack = buildBacktrackPath(flight, history[0] ?? null);
  if (origin && backtrack.length > 0 && shouldPrefixOrigin(origin, backtrack[0]!, flight.altitudeFeet)) {
    return [{ latitude: origin.lat, longitude: origin.lon, altitude: 450 }, ...backtrack];
  }
  return backtrack;
}

function buildBacktrackPath(flight: Flight, latestSample: FlightTrackSample | null) {
  const currentHeading = normalizeHeading(
    (flight.heading ?? latestSample?.heading ?? inferHeadingFromHistory(latestSample ? [latestSample] : []) ?? 0) + 180,
  );
  const speedKnots = clamp(
    flight.velocityKnots ?? latestSample?.speedKnots ?? 320,
    160,
    520,
  );
  const verticalRate = flight.verticalRate ?? latestSample?.verticalRate ?? 0;
  const points = [15, 9, 4, 0].map((minute) => {
    if (minute === 0) {
      return {
        latitude: flight.latitude,
        longitude: normalizeLongitude(flight.longitude),
        altitude: flight.altitude,
      };
    }

    const distanceKm = speedKnots * 1.852 * (minute / 60);
    const projected = projectPoint(flight.latitude, flight.longitude, currentHeading, distanceKm);
    return {
      latitude: projected.latitude,
      longitude: projected.longitude,
      altitude: Math.max(0, flight.altitude - verticalRate * minute * 60),
    };
  });

  return downsamplePoints(points, 6);
}

function buildPredictedPath(
  flight: Flight,
  history: FlightTrackSample[],
  nearbyFlights: Flight[],
  origin?: AirportCoords | null,
  destination?: AirportCoords | null,
  airspaceRangeKm?: number,
) {
  const inferredHeading = inferHeadingFromHistory(history);
  const inferredSpeedKnots = inferSpeedFromHistory(history);
  const inferredVerticalRate = inferVerticalRateFromHistory(history);
  const flow = deriveLocalFlow(flight, nearbyFlights, airspaceRangeKm);
  const cruiseAltitude = estimateCruiseAltitude(flight, destination, flow);

  let latitude = flight.latitude;
  let longitude = normalizeLongitude(flight.longitude);
  let altitude = flight.altitude;
  let heading = normalizeHeading(flight.heading ?? inferredHeading ?? bearingToDestination(flight, destination) ?? 0);
  let speedKnots = clamp(
    flight.velocityKnots ?? inferredSpeedKnots ?? flow.speedKnots ?? 420,
    160,
    520,
  );
  const baseVerticalRate = flight.verticalRate ?? inferredVerticalRate ?? flow.verticalRate ?? 0;

  const points: FlightPathPoint[] = [{
    latitude,
    longitude,
    altitude,
  }];

  for (const stepMinutes of PREDICTION_STEPS_MINUTES) {
    const destinationDistanceKm = destination
      ? haversineKm(latitude, longitude, destination.lat, destination.lon)
      : null;
    const phase = classifyFlightPhase({
      altitude,
      altitudeFeet: altitude * FEET_PER_METER,
      destination,
      destinationDistanceKm,
      origin,
      originDistanceKm: origin ? haversineKm(latitude, longitude, origin.lat, origin.lon) : null,
      verticalRate: baseVerticalRate,
    });
    const targetHeading = computeTargetHeading({
      currentHeading: heading,
      destination,
      destinationDistanceKm,
      flight,
      flowHeading: flow.heading,
      historyHeading: inferredHeading,
      phase,
    });
    heading = turnTowardHeading(heading, targetHeading, maxTurnPerStep(phase, stepMinutes));

    const targetSpeedKnots = computeTargetSpeedKnots(speedKnots, destinationDistanceKm, flow.speedKnots, phase);
    speedKnots = lerp(speedKnots, targetSpeedKnots, 0.45);

    const targetAltitude = computeTargetAltitude({
      altitude,
      cruiseAltitude,
      destinationDistanceKm,
      phase,
      stepMinutes,
      verticalRate: baseVerticalRate,
      flowVerticalRate: flow.verticalRate,
    });
    altitude = Math.max(0, lerp(altitude, targetAltitude, phase === 'approach' ? 0.72 : 0.56));

    const distanceKm = Math.max(4, speedKnots * 1.852 * (stepMinutes / 60));
    const projected = projectPoint(latitude, longitude, heading, distanceKm);
    latitude = projected.latitude;
    longitude = projected.longitude;

    if (destination && destinationDistanceKm != null && destinationDistanceKm < distanceKm * 1.2) {
      latitude = lerp(latitude, destination.lat, 0.7);
      longitude = normalizeLongitude(lerpLongitude(longitude, destination.lon, 0.7));
      altitude = Math.min(altitude, computeDestinationProfileAltitude(destinationDistanceKm, 'approach'));
    }

    points.push({
      latitude,
      longitude,
      altitude,
    });

    if (destination && destinationDistanceKm != null && destinationDistanceKm < 12) {
      points.push({
        latitude: destination.lat,
        longitude: destination.lon,
        altitude: 300,
      });
      break;
    }
  }

  return downsamplePoints(points, 8);
}

function deriveLocalFlow(flight: Flight, nearbyFlights: Flight[], airspaceRangeKm = 220): FlowSnapshot {
  const flowRadiusKm = clamp(airspaceRangeKm, 40, 1200);
  let altitudeSum = 0;
  let altitudeWeight = 0;
  let headingX = 0;
  let headingY = 0;
  let headingWeight = 0;
  let sampleCount = 0;
  let speedSum = 0;
  let speedWeight = 0;
  let verticalRateSum = 0;
  let verticalRateWeight = 0;

  for (const peer of nearbyFlights) {
    if (peer.icao24 === flight.icao24) {
      continue;
    }

    const distanceKm = haversineKm(flight.latitude, flight.longitude, peer.latitude, peer.longitude);
    if (distanceKm > flowRadiusKm) {
      continue;
    }

    const altitudeDelta = Math.abs(peer.altitude - flight.altitude);
    if (altitudeDelta > LOCAL_FLOW_ALTITUDE_DELTA_METERS) {
      continue;
    }

    let weight = Math.max(0.12, 1 - distanceKm / flowRadiusKm);
    if (flight.destAirport && flight.destAirport === peer.destAirport) {
      weight *= 1.8;
    }
    if (flight.originAirport && flight.originAirport === peer.originAirport) {
      weight *= 1.25;
    }
    if (flight.airline && flight.airline === peer.airline) {
      weight *= 1.12;
    }
    if (flight.heading != null && peer.heading != null) {
      weight *= clamp(1 - headingDelta(flight.heading, peer.heading) / 140, 0.45, 1.15);
    }

    sampleCount += 1;

    if (peer.heading != null) {
      headingX += Math.cos(degreesToRadians(peer.heading)) * weight;
      headingY += Math.sin(degreesToRadians(peer.heading)) * weight;
      headingWeight += weight;
    }
    if (peer.velocityKnots != null) {
      speedSum += peer.velocityKnots * weight;
      speedWeight += weight;
    }
    if (peer.verticalRate != null) {
      verticalRateSum += peer.verticalRate * weight;
      verticalRateWeight += weight;
    }

    altitudeSum += peer.altitude * weight;
    altitudeWeight += weight;
  }

  return {
    altitude: altitudeWeight > 0 ? altitudeSum / altitudeWeight : null,
    heading: headingWeight > 0 ? normalizeHeading(radiansToDegrees(Math.atan2(headingY, headingX))) : null,
    sampleCount,
    speedKnots: speedWeight > 0 ? speedSum / speedWeight : null,
    verticalRate: verticalRateWeight > 0 ? verticalRateSum / verticalRateWeight : null,
  };
}

function estimateCruiseAltitude(
  flight: Flight,
  destination: AirportCoords | null | undefined,
  flow: FlowSnapshot,
) {
  const destinationDistanceKm = destination
    ? haversineKm(flight.latitude, flight.longitude, destination.lat, destination.lon)
    : null;

  let baselineFeet = 28000;
  if (destinationDistanceKm != null) {
    if (destinationDistanceKm > 5000) baselineFeet = 39000;
    else if (destinationDistanceKm > 2500) baselineFeet = 37000;
    else if (destinationDistanceKm > 1200) baselineFeet = 34000;
    else if (destinationDistanceKm > 500) baselineFeet = 30000;
    else baselineFeet = 24000;
  } else if (flight.altitudeFeet >= 32000) {
    baselineFeet = 36000;
  }

  const flowAltitudeFeet = flow.altitude != null ? flow.altitude * FEET_PER_METER : null;
  if (flowAltitudeFeet != null && flow.sampleCount >= 3) {
    baselineFeet = lerp(baselineFeet, flowAltitudeFeet, 0.35);
  }

  return Math.max(flight.altitude, baselineFeet / FEET_PER_METER);
}

function computeTargetHeading(input: {
  currentHeading: number;
  destination?: AirportCoords | null;
  destinationDistanceKm: number | null;
  flight: Flight;
  flowHeading: number | null;
  historyHeading: number | null;
  phase: FlightPhase;
}) {
  const destinationBearing = bearingToDestination(
    { latitude: input.flight.latitude, longitude: normalizeLongitude(input.flight.longitude) },
    input.destination,
  );
  const phaseWeights = {
    approach: { current: 0.14, destination: 0.5, flow: 0.28, history: 0.08 },
    climb: { current: 0.4, destination: 0.16, flow: 0.2, history: 0.24 },
    cruise: { current: 0.22, destination: 0.32, flow: 0.28, history: 0.18 },
    departure: { current: 0.5, destination: 0.1, flow: 0.2, history: 0.2 },
    descent: { current: 0.18, destination: 0.46, flow: 0.24, history: 0.12 },
  }[input.phase];

  const candidates: Array<{ heading: number | null; weight: number }> = [
    { heading: input.currentHeading, weight: phaseWeights.current },
    { heading: input.historyHeading, weight: phaseWeights.history },
    { heading: input.flowHeading, weight: phaseWeights.flow },
    {
      heading: destinationBearing,
      weight: destinationBearing == null
        ? 0
        : phaseWeights.destination * destinationWeightFactor(input.destinationDistanceKm),
    },
  ];

  return weightedAverageHeading(candidates) ?? input.currentHeading;
}

function computeTargetSpeedKnots(
  currentSpeedKnots: number,
  destinationDistanceKm: number | null,
  flowSpeedKnots: number | null,
  phase: FlightPhase,
) {
  let target = currentSpeedKnots;
  if (flowSpeedKnots != null) {
    target = lerp(target, flowSpeedKnots, 0.35);
  }

  switch (phase) {
    case 'departure':
      target = clamp(target, 200, 320);
      break;
    case 'climb':
      target = clamp(target, 240, 440);
      break;
    case 'cruise':
      target = clamp(target, 300, 520);
      break;
    case 'descent':
      target = clamp(target * 0.9, 220, 460);
      break;
    case 'approach':
      target = clamp(target * 0.72, 145, 250);
      break;
  }

  if (destinationDistanceKm != null) {
    if (destinationDistanceKm < 220) target = Math.min(target, 320);
    if (destinationDistanceKm < 120) target = Math.min(target, 240);
    if (destinationDistanceKm < 60) target = Math.min(target, 190);
  }

  return target;
}

function computeTargetAltitude(input: {
  altitude: number;
  cruiseAltitude: number;
  destinationDistanceKm: number | null;
  phase: FlightPhase;
  stepMinutes: number;
  verticalRate: number;
  flowVerticalRate: number | null;
}) {
  const stepSeconds = input.stepMinutes * 60;
  const verticalRate = Math.abs(input.verticalRate) > 0.5
    ? input.verticalRate
    : input.flowVerticalRate ?? input.verticalRate;

  switch (input.phase) {
    case 'departure':
    case 'climb': {
      const climbRate = Math.max(verticalRate, 6.5);
      return Math.min(input.cruiseAltitude, input.altitude + climbRate * stepSeconds);
    }
    case 'cruise':
      return lerp(input.altitude, input.cruiseAltitude, 0.25);
    case 'descent': {
      const descentRate = Math.min(verticalRate, -7);
      const profileAltitude = computeDestinationProfileAltitude(input.destinationDistanceKm, 'descent');
      const boundedProfile = Math.min(profileAltitude, input.altitude);
      return Math.max(450, Math.min(
        input.altitude,
        lerp(input.altitude + descentRate * stepSeconds, boundedProfile, 0.35),
      ));
    }
    case 'approach': {
      const descentRate = Math.min(verticalRate, -5);
      const profileAltitude = computeDestinationProfileAltitude(input.destinationDistanceKm, 'approach');
      const boundedProfile = Math.min(profileAltitude, input.altitude);
      return Math.max(250, Math.min(
        input.altitude,
        lerp(input.altitude + descentRate * stepSeconds, boundedProfile, 0.5),
      ));
    }
  }
}

function computeDestinationProfileAltitude(distanceKm: number | null, phase: 'approach' | 'descent') {
  if (distanceKm == null) {
    return phase === 'approach' ? 300 : 900;
  }

  if (phase === 'approach') {
    return clamp(distanceKm * 55, 250, 4500);
  }
  return clamp(distanceKm * 40, 450, 11000);
}

function classifyFlightPhase(input: {
  altitude: number;
  altitudeFeet: number;
  destination?: AirportCoords | null;
  destinationDistanceKm: number | null;
  origin?: AirportCoords | null;
  originDistanceKm: number | null;
  verticalRate: number;
}): FlightPhase {
  if (input.destination && input.destinationDistanceKm != null) {
    if (input.destinationDistanceKm < 80 && input.altitudeFeet < 15000) {
      return 'approach';
    }
    if (input.verticalRate < -2 || (input.destinationDistanceKm < 240 && input.altitudeFeet < 26000)) {
      return 'descent';
    }
  }

  if (input.origin && input.originDistanceKm != null && input.originDistanceKm < 120 && input.altitudeFeet < 18000) {
    return 'departure';
  }

  if (input.verticalRate > 2 || input.altitudeFeet < 18000) {
    return 'climb';
  }

  return 'cruise';
}

function inferHeadingFromHistory(history: FlightTrackSample[]) {
  if (history.length < 2) {
    return null;
  }

  for (let index = history.length - 1; index >= 1; index -= 1) {
    const current = history[index]!;
    const previous = history[index - 1]!;
    const distanceKm = haversineKm(previous.latitude, previous.longitude, current.latitude, current.longitude);
    if (distanceKm >= 1) {
      return bearingBetween(previous.latitude, previous.longitude, current.latitude, current.longitude);
    }
  }

  return null;
}

function inferSpeedFromHistory(history: FlightTrackSample[]) {
  if (history.length < 2) {
    return null;
  }

  const current = history[history.length - 1]!;
  const previous = history[history.length - 2]!;
  const elapsedHours = (current.timestamp - previous.timestamp) / 3600000;
  if (elapsedHours <= 0) {
    return null;
  }

  const distanceNm = haversineKm(previous.latitude, previous.longitude, current.latitude, current.longitude) / 1.852;
  return distanceNm / elapsedHours;
}

function inferVerticalRateFromHistory(history: FlightTrackSample[]) {
  if (history.length < 2) {
    return null;
  }

  const current = history[history.length - 1]!;
  const previous = history[history.length - 2]!;
  const elapsedSeconds = (current.timestamp - previous.timestamp) / 1000;
  if (elapsedSeconds <= 0) {
    return null;
  }

  return (current.altitude - previous.altitude) / elapsedSeconds;
}

function shouldPrefixOrigin(origin: AirportCoords, firstPoint: FlightPathPoint, altitudeFeet: number) {
  return altitudeFeet < 18000 && haversineKm(origin.lat, origin.lon, firstPoint.latitude, firstPoint.longitude) < 90;
}

function bearingToDestination(
  source: { latitude: number; longitude: number } | Flight,
  destination?: AirportCoords | null,
) {
  if (!destination) {
    return null;
  }
  return bearingBetween(source.latitude, normalizeLongitude(source.longitude), destination.lat, destination.lon);
}

function bearingBetween(lat1: number, lon1: number, lat2: number, lon2: number) {
  const deltaLon = degreesToRadians(lon2 - lon1);
  const lat1Rad = degreesToRadians(lat1);
  const lat2Rad = degreesToRadians(lat2);
  const y = Math.sin(deltaLon) * Math.cos(lat2Rad);
  const x = Math.cos(lat1Rad) * Math.sin(lat2Rad) -
    Math.sin(lat1Rad) * Math.cos(lat2Rad) * Math.cos(deltaLon);
  return normalizeHeading(radiansToDegrees(Math.atan2(y, x)));
}

function weightedAverageHeading(candidates: Array<{ heading: number | null; weight: number }>) {
  let x = 0;
  let y = 0;
  let totalWeight = 0;

  for (const candidate of candidates) {
    if (candidate.heading == null || candidate.weight <= 0) {
      continue;
    }
    x += Math.cos(degreesToRadians(candidate.heading)) * candidate.weight;
    y += Math.sin(degreesToRadians(candidate.heading)) * candidate.weight;
    totalWeight += candidate.weight;
  }

  if (totalWeight <= 0) {
    return null;
  }

  return normalizeHeading(radiansToDegrees(Math.atan2(y, x)));
}

function turnTowardHeading(current: number, target: number, maxTurnDeg: number) {
  const delta = ((target - current + 540) % 360) - 180;
  const boundedDelta = clamp(delta, -maxTurnDeg, maxTurnDeg);
  return normalizeHeading(current + boundedDelta);
}

function maxTurnPerStep(phase: FlightPhase, stepMinutes: number) {
  const base = phase === 'approach'
    ? 24
    : phase === 'departure'
      ? 20
      : phase === 'descent'
        ? 16
        : 12;
  return base + stepMinutes * 1.2;
}

function destinationWeightFactor(distanceKm: number | null) {
  if (distanceKm == null) {
    return 0;
  }
  if (distanceKm < 80) return 1.5;
  if (distanceKm < 250) return 1.25;
  if (distanceKm < 900) return 1;
  return 0.72;
}

function downsamplePoints(points: FlightPathPoint[], maxPoints: number) {
  if (points.length <= maxPoints) {
    return points;
  }

  const stride = (points.length - 1) / (maxPoints - 1);
  const reduced: FlightPathPoint[] = [];
  for (let index = 0; index < maxPoints; index += 1) {
    reduced.push(points[Math.round(index * stride)]!);
  }
  return reduced;
}

function projectPoint(latitude: number, longitude: number, headingDeg: number, distanceKm: number) {
  const distanceRad = distanceKm / EARTH_RADIUS_KM;
  const headingRad = degreesToRadians(headingDeg);
  const latitudeRad = degreesToRadians(latitude);
  const longitudeRad = degreesToRadians(longitude);

  const nextLatitude = Math.asin(
    Math.sin(latitudeRad) * Math.cos(distanceRad) +
      Math.cos(latitudeRad) * Math.sin(distanceRad) * Math.cos(headingRad),
  );
  const nextLongitude = longitudeRad + Math.atan2(
    Math.sin(headingRad) * Math.sin(distanceRad) * Math.cos(latitudeRad),
    Math.cos(distanceRad) - Math.sin(latitudeRad) * Math.sin(nextLatitude),
  );

  return {
    latitude: radiansToDegrees(nextLatitude),
    longitude: normalizeLongitude(radiansToDegrees(nextLongitude)),
  };
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number) {
  const lat1Rad = degreesToRadians(lat1);
  const lat2Rad = degreesToRadians(lat2);
  const deltaLat = degreesToRadians(lat2 - lat1);
  const deltaLon = degreesToRadians(lon2 - lon1);

  const a = Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1Rad) * Math.cos(lat2Rad) * Math.sin(deltaLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_KM * c;
}

function headingDelta(left: number, right: number) {
  const delta = Math.abs(left - right) % 360;
  return delta > 180 ? 360 - delta : delta;
}

function normalizeHeading(value: number) {
  const normalized = value % 360;
  return normalized < 0 ? normalized + 360 : normalized;
}

function normalizeLongitude(value: number) {
  let longitude = value;
  while (longitude > 180) longitude -= 360;
  while (longitude < -180) longitude += 360;
  return longitude;
}

function lerp(start: number, end: number, fraction: number) {
  return start + (end - start) * fraction;
}

function lerpLongitude(start: number, end: number, fraction: number) {
  let delta = end - start;
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
  return start + delta * fraction;
}

function clamp(value: number, min: number, max: number) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function degreesToRadians(value: number) {
  return (value * Math.PI) / 180;
}

function radiansToDegrees(value: number) {
  return (value * 180) / Math.PI;
}

function toPoint(point: FlightPathPoint): FlightPathPoint {
  return {
    latitude: point.latitude,
    longitude: point.longitude,
    altitude: point.altitude,
  };
}
