import { useState } from 'react';
import type { ShaderMode } from '../../shaders/postprocess';
import type { SatelliteCategory } from '../layers/SatelliteLayer';
import type { GeoStatus } from '../../hooks/useGeolocation';
import MobileModal from './MobileModal';
import type { AltitudeBand } from '../layers/flightLayerUtils';

interface DesignatableGroup {
  id: string;
  label: string;
  kind: 'MESO' | 'MICRO';
  confidence: number;
  memberCount: number;
  latitude: number;
  longitude: number;
  altitude: number;
  distanceKm: number;
}

interface OperationsPanelProps {
  shaderMode: ShaderMode;
  onShaderChange: (mode: ShaderMode) => void;
  layers: {
    flights: boolean;
    satellites: boolean;
    earthquakes: boolean;
    traffic: boolean;
    cctv: boolean;
    ships: boolean;
  };
  onLayerToggle: (layer: 'flights' | 'satellites' | 'earthquakes' | 'traffic' | 'cctv' | 'ships') => void;
  /** Optional per-layer loading state (e.g. ships takes ~20s on first fetch) */
  layerLoading?: Partial<Record<'flights' | 'satellites' | 'earthquakes' | 'traffic' | 'cctv' | 'ships', boolean>>;
  mapTiles: 'google' | 'osm';
  onMapTilesChange: (tile: 'google' | 'osm') => void;
  showPaths: boolean;
  onShowPathsToggle: () => void;
  showPredictions: boolean;
  onShowPredictionsToggle: () => void;
  airspaceRangeKm: 80 | 160 | 320 | 640;
  onAirspaceRangeChange: (range: 80 | 160 | 320 | 640) => void;
  altitudeFilter: Record<AltitudeBand, boolean>;
  onAltitudeToggle: (band: AltitudeBand) => void;
  showSatPaths: boolean;
  onShowSatPathsToggle: () => void;
  satCategoryFilter: Record<SatelliteCategory, boolean>;
  onSatCategoryToggle: (category: SatelliteCategory) => void;
  designatableGroups: DesignatableGroup[];
  selectedGroupId: string | null;
  onGroupDesignate: (group: DesignatableGroup) => void;
  onResetView: () => void;
  onLocateMe: () => void;
  geoStatus: GeoStatus;
  isMobile: boolean;
}

const SHADER_OPTIONS: { value: ShaderMode; label: string; colour: string }[] = [
  { value: 'none', label: 'STANDARD', colour: 'text-wv-text' },
  { value: 'crt', label: 'CRT', colour: 'text-wv-cyan' },
  { value: 'nvg', label: 'NVG', colour: 'text-wv-green' },
  { value: 'flir', label: 'FLIR', colour: 'text-wv-amber' },
];

const LAYER_OPTIONS: { key: 'flights' | 'satellites' | 'earthquakes' | 'traffic' | 'cctv' | 'ships'; label: string; icon: string }[] = [
  { key: 'flights', label: 'LIVE FLIGHTS', icon: '✈' },
  { key: 'satellites', label: 'SATELLITES', icon: '🛰' },
  { key: 'earthquakes', label: 'SEISMIC', icon: '🌍' },
  { key: 'traffic', label: 'STREET TRAFFIC', icon: '🚗' },
  { key: 'cctv', label: 'CCTV FEEDS', icon: '📹' },
  { key: 'ships', label: 'NAVAL / AIS', icon: '🚢' },
];

const ALTITUDE_BANDS: { band: AltitudeBand; label: string; colour: string; dotColour: string }[] = [
  { band: 'cruise', label: 'CRUISE ≥FL350', colour: 'text-[#00D4FF]', dotColour: 'bg-[#00D4FF]' },
  { band: 'high', label: 'HIGH FL200–349', colour: 'text-[#00BFFF]', dotColour: 'bg-[#00BFFF]' },
  { band: 'mid', label: 'MID FL100–199', colour: 'text-[#FFD700]', dotColour: 'bg-[#FFD700]' },
  { band: 'low', label: 'LOW FL030–099', colour: 'text-[#FF8C00]', dotColour: 'bg-[#FF8C00]' },
  { band: 'ground', label: 'NEAR GND <3K', colour: 'text-[#FF4444]', dotColour: 'bg-[#FF4444]' },
];

const SATELLITE_CATEGORIES: { category: SatelliteCategory; label: string; colour: string; dotColour: string; icon: string }[] = [
  { category: 'iss', label: 'ISS', colour: 'text-[#00D4FF]', dotColour: 'bg-[#00D4FF]', icon: '🚀' },
  { category: 'other', label: 'OTHER', colour: 'text-[#39FF14]', dotColour: 'bg-[#39FF14]', icon: '🛰' },
];

const AIRSPACE_RANGE_OPTIONS: { label: string; range: 80 | 160 | 320 | 640 }[] = [
  { label: 'TERMINAL 80KM', range: 80 },
  { label: 'SECTOR 160KM', range: 160 },
  { label: 'REGIONAL 320KM', range: 320 },
  { label: 'THEATER 640KM', range: 640 },
];

export default function OperationsPanel({
  shaderMode,
  onShaderChange,
  layers,
  layerLoading = {},
  onLayerToggle,
  mapTiles,
  onMapTilesChange,
  showPaths,
  onShowPathsToggle,
  showPredictions,
  onShowPredictionsToggle,
  airspaceRangeKm,
  onAirspaceRangeChange,
  altitudeFilter,
  onAltitudeToggle,
  showSatPaths,
  onShowSatPathsToggle,
  satCategoryFilter,
  onSatCategoryToggle,
  designatableGroups,
  selectedGroupId,
  onGroupDesignate,
  onResetView,
  onLocateMe,
  geoStatus,
  isMobile,
}: OperationsPanelProps) {
  const [mobileOpen, setMobileOpen] = useState(false);

  // Count active layers for the FAB badge
  const activeLayerCount = Object.values(layers).filter(Boolean).length;

  /* ── Shared panel inner content (used by both desktop & mobile) ── */
  const panelContent = (
    <>
      {/* Optics Section */}
      <div className="p-3 border-b border-wv-border">
        <div className="text-[9px] text-wv-muted tracking-widest uppercase mb-2">Optics Mode</div>
        <div className="grid grid-cols-2 gap-1">
          {SHADER_OPTIONS.map(({ value, label, colour }) => (
            <button
              key={value}
              onClick={() => onShaderChange(value)}
              className={`
                px-2 py-1.5 rounded text-[10px] font-bold tracking-wider
                transition-all duration-200
                ${isMobile ? 'min-h-[44px]' : ''}
                ${shaderMode === value
                  ? `${colour} bg-white/10 ring-1 ring-white/20`
                  : 'text-wv-muted hover:text-wv-text hover:bg-white/5'
                }
              `}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Map Tiles Section */}
      <div className="p-3 border-b border-wv-border">
        <div className="text-[9px] text-wv-muted tracking-widest uppercase mb-2">Map Tiles</div>
        <div className="grid grid-cols-2 gap-1">
          {([
            { value: 'google' as const, label: 'GOOGLE 3D', colour: 'text-wv-cyan' },
            { value: 'osm' as const, label: 'OSM', colour: 'text-wv-green' },
          ]).map(({ value, label, colour }) => (
            <button
              key={value}
              onClick={() => onMapTilesChange(value)}
              className={`
                px-2 py-1.5 rounded text-[10px] font-bold tracking-wider
                transition-all duration-200
                ${isMobile ? 'min-h-[44px]' : ''}
                ${mapTiles === value
                  ? `${colour} bg-white/10 ring-1 ring-white/20`
                  : 'text-wv-muted hover:text-wv-text hover:bg-white/5'
                }
              `}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Data Layers Section */}
      <div className="p-3 border-b border-wv-border">
        <div className="text-[9px] text-wv-muted tracking-widest uppercase mb-2">Data Layers</div>
        <div className="flex flex-col gap-1">
          {LAYER_OPTIONS.map(({ key, label, icon }) => {
            const isOn = layers[key];
            const isLoading = !!layerLoading[key];
            return (
              <button
                key={key}
                onClick={() => onLayerToggle(key)}
                className={`
                  flex items-center gap-2 px-2 py-1.5 rounded text-[10px]
                  transition-all duration-200 text-left
                  ${isMobile ? 'min-h-[44px] text-[12px]' : ''}
                  ${isOn
                    ? isLoading ? 'text-wv-amber bg-wv-amber/10' : 'text-wv-green bg-wv-green/10'
                    : 'text-wv-muted hover:text-wv-text hover:bg-white/5'
                  }
                `}
              >
                <span className="text-sm">{icon}</span>
                <span className="tracking-wider">{label}</span>
                {isOn && isLoading ? (
                  <span className="ml-auto flex items-center gap-1.5">
                    <span className="text-[8px] text-wv-amber tracking-wider animate-pulse">LOADING</span>
                    <span className="w-1.5 h-1.5 rounded-full bg-wv-amber animate-pulse" />
                  </span>
                ) : (
                  <span className={`ml-auto w-1.5 h-1.5 rounded-full transition-colors duration-300 ${isOn ? 'bg-wv-green' : 'bg-wv-muted/30'}`} />
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Flight Filters Section */}
      {layers.flights && (
        <div className="p-3">
          <div className="text-[9px] text-wv-muted tracking-widest uppercase mb-2">Flight Filters</div>
          <button
            onClick={onShowPathsToggle}
            className={`
              flex items-center gap-2 px-2 py-1.5 rounded text-[10px] w-full
              transition-all duration-200 text-left mb-1
              ${isMobile ? 'min-h-[44px]' : ''}
              ${showPaths
                ? 'text-wv-cyan bg-wv-cyan/10'
                : 'text-wv-muted hover:text-wv-text hover:bg-white/5'
              }
            `}
          >
            <span className="text-sm">⟿</span>
            <span className="tracking-wider">ROUTE PATHS</span>
            <span className={`ml-auto w-1.5 h-1.5 rounded-full ${showPaths ? 'bg-wv-cyan' : 'bg-wv-muted/30'}`} />
          </button>
          <button
            onClick={onShowPredictionsToggle}
            className={`
              flex items-center gap-2 px-2 py-1.5 rounded text-[10px] w-full
              transition-all duration-200 text-left mb-1
              ${isMobile ? 'min-h-[44px]' : ''}
              ${showPredictions
                ? 'text-wv-green bg-wv-green/10'
                : 'text-wv-muted hover:text-wv-text hover:bg-white/5'
              }
            `}
          >
            <span className="text-sm">P</span>
            <span className="tracking-wider">PREDICTIONS</span>
            <span className={`ml-auto w-1.5 h-1.5 rounded-full ${showPredictions ? 'bg-wv-green' : 'bg-wv-muted/30'}`} />
          </button>
          <div className="text-[8px] text-wv-muted tracking-widest uppercase mt-2 mb-1 px-1">Airspace Range</div>
          <div className="grid grid-cols-2 gap-1">
            {AIRSPACE_RANGE_OPTIONS.map(({ label, range }) => (
              <button
                key={range}
                onClick={() => onAirspaceRangeChange(range)}
                className={`
                  px-2 py-1.5 rounded text-[9px] font-bold tracking-wider text-left
                  transition-all duration-200
                  ${isMobile ? 'min-h-[40px]' : ''}
                  ${airspaceRangeKm === range
                    ? 'text-wv-amber bg-wv-amber/10 ring-1 ring-wv-amber/30'
                    : 'text-wv-muted hover:text-wv-text hover:bg-white/5'
                  }
                `}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="text-[8px] text-wv-muted tracking-widest uppercase mt-2 mb-1 px-1">Altitude Bands</div>
          <div className="flex flex-col gap-0.5">
            {ALTITUDE_BANDS.map(({ band, label, colour, dotColour }) => (
              <button
                key={band}
                onClick={() => onAltitudeToggle(band)}
                className={`
                  flex items-center gap-2 px-2 py-1 rounded text-[9px]
                  transition-all duration-200 text-left
                  ${isMobile ? 'min-h-[40px]' : ''}
                  ${altitudeFilter[band]
                    ? `${colour} bg-white/5`
                    : 'text-wv-muted/40 hover:text-wv-muted hover:bg-white/5 line-through'
                  }
                `}
              >
                <span className={`w-2 h-2 rounded-full ${altitudeFilter[band] ? dotColour : 'bg-wv-muted/20'}`} />
                <span className="tracking-wider">{label}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Satellite Filters Section */}
      {layers.satellites && (
        <div className="p-3 border-t border-wv-border">
          <div className="text-[9px] text-wv-muted tracking-widest uppercase mb-2">Satellite Filters</div>
          <button
            onClick={onShowSatPathsToggle}
            className={`
              flex items-center gap-2 px-2 py-1.5 rounded text-[10px] w-full
              transition-all duration-200 text-left mb-1
              ${isMobile ? 'min-h-[44px]' : ''}
              ${showSatPaths
                ? 'text-wv-green bg-wv-green/10'
                : 'text-wv-muted hover:text-wv-text hover:bg-white/5'
              }
            `}
          >
            <span className="text-sm">⟿</span>
            <span className="tracking-wider">ORBIT PATHS</span>
            <span className={`ml-auto w-1.5 h-1.5 rounded-full ${showSatPaths ? 'bg-wv-green' : 'bg-wv-muted/30'}`} />
          </button>
          <div className="text-[8px] text-wv-muted tracking-widest uppercase mt-2 mb-1 px-1">Categories</div>
          <div className="flex flex-col gap-0.5">
            {SATELLITE_CATEGORIES.map(({ category, label, colour, dotColour }) => (
              <button
                key={category}
                onClick={() => onSatCategoryToggle(category)}
                className={`
                  flex items-center gap-2 px-2 py-1 rounded text-[9px]
                  transition-all duration-200 text-left
                  ${isMobile ? 'min-h-[40px]' : ''}
                  ${satCategoryFilter[category]
                    ? `${colour} bg-white/5`
                    : 'text-wv-muted/40 hover:text-wv-muted hover:bg-white/5 line-through'
                  }
                `}
              >
                <span className={`w-2 h-2 rounded-full ${satCategoryFilter[category] ? dotColour : 'bg-wv-muted/20'}`} />
                <span className="tracking-wider">{label}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="p-3 border-t border-wv-border">
        <div className="text-[9px] text-wv-muted tracking-widest uppercase mb-2">Group Designation</div>
        <div className="text-[8px] text-wv-muted tracking-widest uppercase mb-1 px-1">
          AIRSPACE {airspaceRangeKm}KM
        </div>
        <div className="flex flex-col gap-0.5">
          {designatableGroups.length === 0 ? (
            <div className="px-2 py-1.5 text-[9px] text-wv-muted/70">
              NO GROUPS IN CURRENT AIRSPACE
            </div>
          ) : (
            designatableGroups.map((group) => (
              <button
                key={group.id}
                onClick={() => onGroupDesignate(group)}
                className={`
                  flex items-center gap-2 px-2 py-1.5 rounded text-[9px] text-left
                  transition-all duration-200
                  ${isMobile ? 'min-h-[40px]' : ''}
                  ${selectedGroupId === group.id
                    ? 'text-wv-cyan bg-wv-cyan/10 ring-1 ring-wv-cyan/25'
                    : 'text-wv-muted hover:text-wv-text hover:bg-white/5'
                  }
                `}
              >
                <span className={`w-2 h-2 rounded-full ${group.kind === 'MESO' ? 'bg-wv-amber' : 'bg-wv-cyan'}`} />
                <span className="tracking-wider">{group.label}</span>
                <span className="ml-auto text-[8px] text-wv-muted">
                  {group.memberCount} / {Math.round(group.distanceKm)}KM
                </span>
              </button>
            ))
          )}
        </div>
      </div>

      {/* Locate Me + Reset View */}
      <div className="p-3 border-t border-wv-border flex flex-col gap-1">
        <button
          onClick={onLocateMe}
          disabled={geoStatus === 'requesting'}
          className={`
            w-full px-3 py-2 rounded text-[10px] font-bold tracking-wider
            transition-all duration-200 flex items-center justify-center gap-2
            ${isMobile ? 'min-h-[48px] text-[12px]' : ''}
            ${geoStatus === 'requesting'
              ? 'text-wv-cyan/50 bg-wv-cyan/5 cursor-wait'
              : geoStatus === 'success'
                ? 'text-wv-green bg-wv-green/10 hover:bg-wv-green/20'
                : 'text-wv-cyan bg-wv-cyan/10 hover:bg-wv-cyan/20'
            }
          `}
        >
          <span>{geoStatus === 'requesting' ? '◌' : '◎'}</span>
          <span>
            {geoStatus === 'requesting'
              ? 'LOCATING…'
              : geoStatus === 'success'
                ? 'RE-LOCATE'
                : 'LOCATE ME'
            }
          </span>
        </button>
        <button
          onClick={onResetView}
          className={`w-full px-3 py-2 rounded text-[10px] font-bold tracking-wider
            text-wv-amber bg-wv-amber/10 hover:bg-wv-amber/20
            transition-all duration-200 flex items-center justify-center gap-2
            ${isMobile ? 'min-h-[48px] text-[12px]' : ''}`}
        >
          <span>⟲</span>
          <span>RESET VIEW</span>
        </button>
      </div>
    </>
  );

  /* ── Mobile: FAB + full-screen modal ── */
  if (isMobile) {
    return (
      <>
        {/* Floating Action Button */}
        <button
          onClick={() => setMobileOpen(true)}
          className="fixed top-3 left-3 z-40 w-11 h-11 rounded-lg panel-glass
                     flex items-center justify-center
                     text-wv-green hover:bg-white/10 transition-colors
                     select-none active:scale-95"
          aria-label="Open operations panel"
        >
          <span className="text-lg">⚙</span>
          {activeLayerCount > 0 && (
            <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-wv-green
                             text-[8px] text-wv-black font-bold flex items-center justify-center">
              {activeLayerCount}
            </span>
          )}
        </button>

        <MobileModal
          open={mobileOpen}
          onClose={() => setMobileOpen(false)}
          title="Operations"
          icon="⚙"
          accent="bg-wv-green"
        >
          {panelContent}
        </MobileModal>
      </>
    );
  }

  /* ── Desktop: fixed side panel (unchanged) ── */
  return (
    <div data-testid="operations-panel" className="fixed top-4 left-4 w-56 panel-glass rounded-lg overflow-hidden z-40 select-none max-h-[calc(100vh-2rem)] overflow-y-auto">
      {/* Header */}
      <div className="px-3 py-2 border-b border-wv-border flex items-center gap-2">
        <div className="w-2 h-2 rounded-full bg-wv-green animate-pulse" />
        <span className="text-[10px] text-wv-muted tracking-widest uppercase">Operations</span>
      </div>
      {panelContent}
    </div>
  );
}
