import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Entity, BillboardGraphics, LabelGraphics, PolylineGraphics, useCesium } from 'resium';
import {
  ArcType,
  CallbackProperty,
  Cartesian2,
  Cartesian3,
  Color,
  ColorMaterialProperty,
  Ellipsoid,
  HorizontalOrigin,
  LabelStyle,
  Math as CesiumMath,
  NearFarScalar,
  PolylineDashMaterialProperty,
  VerticalOrigin,
} from 'cesium';
import * as Cesium from 'cesium';
import { degreesLat, degreesLong, eciToGeodetic, gstime, propagate } from 'satellite.js';
import type { SatellitePosition } from '../../hooks/useSatellites';

const EllipsoidalOccluder = (Cesium as unknown as { EllipsoidalOccluder: new (
  ellipsoid: typeof Ellipsoid.WGS84,
  cameraPosition: Cartesian3,
) => { isPointVisible(point: Cartesian3): boolean } }).EllipsoidalOccluder;

const SAT_COLOR_ISS = Color.fromCssColorString('#00D4FF');
const SAT_COLOR_DEFAULT = Color.fromCssColorString('#39FF14');

export type SatelliteCategory = 'iss' | 'other';

class MutableSatelliteState {
  satrec: SatellitePosition['satrec'] | null = null;
  position = Cartesian3.ZERO;
  heading = 0;

  reset(sat: SatellitePosition) {
    this.satrec = sat.satrec;
    this.position = Cartesian3.fromDegrees(sat.longitude, sat.latitude, sat.altitude * 1000);
    this.heading = 0;
  }

  updatePosition(position: Cartesian3) {
    this.position = position;
  }

  updateHeading(heading: number) {
    this.heading = heading;
  }
}

function createSatelliteIcon(): HTMLCanvasElement {
  const size = 32;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) {
    return canvas;
  }

  const centerX = size / 2;
  const centerY = size / 2;

  context.fillStyle = '#FFFFFF';
  context.strokeStyle = '#FFFFFF';
  context.lineWidth = 1.2;

  context.beginPath();
  context.moveTo(centerX, centerY - 5);
  context.lineTo(centerX + 4, centerY);
  context.lineTo(centerX, centerY + 5);
  context.lineTo(centerX - 4, centerY);
  context.closePath();
  context.fill();

  context.fillRect(centerX - 14, centerY - 3, 9, 6);
  context.fillRect(centerX + 5, centerY - 3, 9, 6);

  context.beginPath();
  context.moveTo(centerX - 4, centerY);
  context.lineTo(centerX - 14, centerY);
  context.moveTo(centerX + 4, centerY);
  context.lineTo(centerX + 14, centerY);
  context.stroke();

  context.lineWidth = 0.5;
  context.strokeStyle = 'rgba(0,0,0,0.3)';
  for (let index = 1; index < 3; index += 1) {
    context.beginPath();
    context.moveTo(centerX - 14 + index * 3, centerY - 3);
    context.lineTo(centerX - 14 + index * 3, centerY + 3);
    context.moveTo(centerX + 5 + index * 3, centerY - 3);
    context.lineTo(centerX + 5 + index * 3, centerY + 3);
    context.stroke();
  }

  context.fillStyle = '#FFFFFF';
  context.beginPath();
  context.moveTo(centerX, centerY - 10);
  context.lineTo(centerX + 2, centerY - 7);
  context.lineTo(centerX - 2, centerY - 7);
  context.closePath();
  context.fill();

  return canvas;
}

let satelliteIcon: HTMLCanvasElement | null = null;
function getSatelliteIcon(): HTMLCanvasElement {
  if (!satelliteIcon) {
    satelliteIcon = createSatelliteIcon();
  }
  return satelliteIcon;
}

function computeBearing(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const deltaLon = (lon2 - lon1) * Math.PI / 180;
  const lat1Rad = lat1 * Math.PI / 180;
  const lat2Rad = lat2 * Math.PI / 180;
  const y = Math.sin(deltaLon) * Math.cos(lat2Rad);
  const x = Math.cos(lat1Rad) * Math.sin(lat2Rad)
    - Math.sin(lat1Rad) * Math.cos(lat2Rad) * Math.cos(deltaLon);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

interface SatelliteLayerProps {
  satellites: SatellitePosition[];
  visible: boolean;
  showPaths: boolean;
  categoryFilter: Record<SatelliteCategory, boolean>;
  isTracking?: boolean;
}

export default function SatelliteLayer({
  satellites,
  visible,
  showPaths,
  categoryFilter,
  isTracking,
}: SatelliteLayerProps) {
  if (!visible || satellites.length === 0) {
    return null;
  }

  return (
    <>
      {satellites.map((satellite) => {
        const isIss = satellite.name.includes('ISS') || satellite.noradId === 25544;
        const category: SatelliteCategory = isIss ? 'iss' : 'other';
        if (!categoryFilter[category]) {
          return null;
        }

        return (
          <MemoSatelliteEntity
            key={satellite.noradId}
            sat={satellite}
            color={isIss ? SAT_COLOR_ISS : SAT_COLOR_DEFAULT}
            scale={isIss ? 0.6 : 0.35}
            isIss={isIss}
            hideLabel={Boolean(isTracking)}
            showPaths={showPaths}
            isTracked={Boolean(isTracking)}
          />
        );
      })}
    </>
  );
}

const MemoSatelliteEntity = memo(function SatelliteEntity({
  sat,
  color,
  scale,
  isIss,
  hideLabel,
  showPaths,
  isTracked,
}: {
  sat: SatellitePosition;
  color: Color;
  scale: number;
  isIss: boolean;
  hideLabel: boolean;
  showPaths: boolean;
  isTracked: boolean;
}) {
  const orbitPositions = useMemo(() => {
    if (!sat.orbitPath || sat.orbitPath.length < 2) {
      return null;
    }

    return sat.orbitPath.map((point) =>
      Cartesian3.fromDegrees(point.longitude, point.latitude, point.altitude * 1000),
    );
  }, [sat.orbitPath]);

  const groundTrackPositions = useMemo(() => {
    if (!sat.orbitPath || sat.orbitPath.length < 2) {
      return null;
    }

    return sat.orbitPath.map((point) =>
      Cartesian3.fromDegrees(point.longitude, point.latitude, 0),
    );
  }, [sat.orbitPath]);

  const { viewer } = useCesium();
  const [isFarSide, setIsFarSide] = useState(false);
  const isFarSideRef = useRef(false);
  const [dynamicState] = useState(() => {
    const state = new MutableSatelliteState();
    state.reset(sat);
    return state;
  });

  useEffect(() => {
    dynamicState.reset(sat);

    const updatePosition = () => {
      try {
        const now = new Date();
        const gmst = gstime(now);
        if (!dynamicState.satrec) {
          return;
        }

        const propagation = propagate(dynamicState.satrec, now);
        if (!propagation || typeof propagation.position === 'boolean' || !propagation.position) {
          return;
        }

        const geo = eciToGeodetic(propagation.position, gmst);
        const lat = degreesLat(geo.latitude);
        const lon = degreesLong(geo.longitude);
        dynamicState.updatePosition(Cartesian3.fromDegrees(lon, lat, geo.height * 1000));

        const future = new Date(now.getTime() + 10_000);
        const futureGmst = gstime(future);
        const futurePropagation = propagate(dynamicState.satrec, future);
        if (futurePropagation && typeof futurePropagation.position !== 'boolean' && futurePropagation.position) {
          const futureGeo = eciToGeodetic(futurePropagation.position, futureGmst);
          dynamicState.updateHeading(computeBearing(
            lat,
            lon,
            degreesLat(futureGeo.latitude),
            degreesLong(futureGeo.longitude),
          ));
        }

        if (viewer && !viewer.isDestroyed()) {
          const occluder = new EllipsoidalOccluder(Ellipsoid.WGS84, viewer.camera.positionWC);
          const hidden = !occluder.isPointVisible(dynamicState.position);
          if (hidden !== isFarSideRef.current) {
            isFarSideRef.current = hidden;
            setIsFarSide(hidden);
          }
        }
      } catch {
        // Keep the last known propagated position.
      }
    };

    updatePosition();
    const intervalId = setInterval(updatePosition, 200);
    return () => clearInterval(intervalId);
  }, [dynamicState, sat.altitude, sat.latitude, sat.longitude, sat.satrec, viewer]);

  const positionProperty = useMemo(
    () => new CallbackProperty(() => dynamicState.position, false),
    [dynamicState],
  );

  const rotationProperty = useMemo(
    () => new CallbackProperty(() => -CesiumMath.toRadians(dynamicState.heading), false),
    [dynamicState],
  );

  return (
    <>
      <Entity
        id={`sat-${sat.noradId}`}
        show={!isFarSide}
        position={positionProperty as unknown as never}
        name={sat.name}
        description={`
          <p><b>NORAD ID:</b> ${sat.noradId}</p>
          <p><b>Altitude:</b> ${sat.altitude.toFixed(1)} km</p>
          <p><b>Lat:</b> ${sat.latitude.toFixed(4)} deg</p>
          <p><b>Lon:</b> ${sat.longitude.toFixed(4)} deg</p>
        `}
      >
        <BillboardGraphics
          image={getSatelliteIcon()}
          color={color}
          scale={isTracked ? 1.0 : scale}
          rotation={rotationProperty as unknown as never}
          alignedAxis={Cartesian3.UNIT_Z}
          horizontalOrigin={HorizontalOrigin.CENTER}
          verticalOrigin={VerticalOrigin.CENTER}
          scaleByDistance={new NearFarScalar(1e5, 1.5, 1e8, 0.3)}
        />
        <LabelGraphics
          show={!hideLabel}
          text={sat.name}
          font="9px monospace"
          fillColor={color.withAlpha(0.8)}
          outlineColor={Color.BLACK}
          outlineWidth={2}
          style={LabelStyle.FILL_AND_OUTLINE}
          verticalOrigin={VerticalOrigin.BOTTOM}
          pixelOffset={new Cartesian2(8, -4)}
          scaleByDistance={new NearFarScalar(1e5, 1, 5e7, 0)}
        />
      </Entity>

      {showPaths && orbitPositions && (
        <Entity id={`sat-${sat.noradId}-orbit`} name={`${sat.name} orbit`}>
          <PolylineGraphics
            positions={orbitPositions}
            width={isIss ? 3 : 2}
            material={new ColorMaterialProperty(color.withAlpha(isIss ? 0.7 : 0.4))}
            arcType={ArcType.NONE}
            clampToGround={false}
          />
        </Entity>
      )}

      {showPaths && groundTrackPositions && (
        <Entity id={`sat-${sat.noradId}-gtrack`} name={`${sat.name} ground track`}>
          <PolylineGraphics
            positions={groundTrackPositions}
            width={isIss ? 2 : 1}
            material={new PolylineDashMaterialProperty({
              color: color.withAlpha(isIss ? 0.35 : 0.15),
              dashLength: 8,
            })}
            arcType={ArcType.GEODESIC}
            clampToGround={true}
          />
        </Entity>
      )}

      {showPaths && (
        <Entity id={`sat-${sat.noradId}-nadir`} name={`${sat.name} nadir`}>
          <PolylineGraphics
            positions={[
              Cartesian3.fromDegrees(sat.longitude, sat.latitude, 0),
              Cartesian3.fromDegrees(sat.longitude, sat.latitude, sat.altitude * 1000),
            ]}
            width={1}
            material={new ColorMaterialProperty(color.withAlpha(0.2))}
            arcType={ArcType.NONE}
          />
        </Entity>
      )}
    </>
  );
});
