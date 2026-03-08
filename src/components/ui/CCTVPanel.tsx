import { useCallback, useMemo, useState } from 'react';
import type { CameraCountry, CameraFeed } from '../../types/camera';
import { buildApiUrl } from '../../runtime/bootstrap';
import MobileModal from './MobileModal';

const IMAGE_PROXY = '/cctv/image';
const PAGE_SIZE = 30;

interface CCTVPanelProps {
  cameras: CameraFeed[];
  isLoading: boolean;
  error: string | null;
  totalOnline: number;
  totalCameras: number;
  availableCountries: CameraCountry[];
  countryFilter: string;
  selectedCameraId: string | null;
  onCountryFilterChange: (code: string) => void;
  onSelectCamera: (camera: CameraFeed | null) => void;
  onFlyToCamera: (camera: CameraFeed) => void;
  isMobile?: boolean;
}

function proxyUrl(url: string): string {
  return `${buildApiUrl(IMAGE_PROXY)}?url=${encodeURIComponent(url)}`;
}

function CameraThumbnail({
  camera,
  isSelected,
  onSelect,
}: {
  camera: CameraFeed;
  isSelected: boolean;
  onSelect: (cam: CameraFeed) => void;
}) {
  const [imageError, setImageError] = useState(false);

  return (
    <button
      onClick={() => onSelect(camera)}
      className={`
        relative overflow-hidden rounded border transition-all duration-200
        ${isSelected
          ? 'border-wv-cyan/60 ring-1 ring-wv-cyan/30'
          : 'border-wv-border/50 hover:border-wv-border'}
      `}
    >
      <div className="relative aspect-video bg-wv-dark">
        {imageError ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-wv-muted">
            <span className="text-[10px] font-bold tracking-wider">SIGNAL LOST</span>
            <span className="mt-0.5 text-[8px]">NO FEED</span>
          </div>
        ) : (
          <img
            src={proxyUrl(camera.imageUrl)}
            alt={camera.name}
            loading="lazy"
            onError={() => setImageError(true)}
            className="h-full w-full object-cover"
          />
        )}
        <div className="absolute left-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-wv-red data-[online=true]:bg-wv-green" data-online={camera.available}>
          <span className="sr-only">{camera.available ? 'online' : 'offline'}</span>
        </div>
        <div className="absolute right-0.5 top-0.5 rounded bg-black/70 px-1 py-0.5 text-[7px] uppercase tracking-wider text-wv-muted">
          {camera.source}
        </div>
      </div>
      <div className="bg-wv-dark/80 px-1 py-0.5">
        <div className="truncate text-[8px] text-wv-text">{camera.name}</div>
        <div className="truncate text-[7px] text-wv-muted">{camera.region}</div>
      </div>
    </button>
  );
}

function CameraPreview({
  camera,
  flag,
  onFlyTo,
}: {
  camera: CameraFeed;
  flag: string;
  onFlyTo: () => void;
}) {
  const [imageError, setImageError] = useState(false);

  return (
    <div className="border-b border-wv-border px-3 py-2 shrink-0">
      <div className="overflow-hidden rounded border border-wv-cyan/30">
        <div className="relative aspect-video bg-wv-dark">
          {imageError ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center text-wv-muted">
              <span className="text-[12px] font-bold tracking-wider">SIGNAL LOST</span>
              <span className="mt-1 text-[9px]">CAMERA OFFLINE OR UNREACHABLE</span>
            </div>
          ) : (
            <img
              src={proxyUrl(camera.imageUrl)}
              alt={camera.name}
              onError={() => setImageError(true)}
              className="h-full w-full object-cover"
            />
          )}
        </div>
        <div className="space-y-0.5 bg-wv-dark/80 p-2">
          <div className="truncate text-[10px] font-bold text-wv-text">{camera.name}</div>
          <div className="text-[9px] text-wv-muted">
            {flag} {camera.region}, {camera.countryName}
          </div>
          <div className="text-[9px] text-wv-muted">
            {camera.latitude.toFixed(4)} deg, {camera.longitude.toFixed(4)} deg
          </div>
          {camera.viewDirection && (
            <div className="text-[9px] text-wv-muted">
              View: {camera.viewDirection}
            </div>
          )}
          <button
            onClick={onFlyTo}
            className="mt-1.5 flex w-full items-center justify-center gap-1 rounded border border-wv-cyan/30 bg-wv-cyan/10 px-2 py-1.5 text-[9px] font-bold tracking-wider text-wv-cyan transition-all duration-200 hover:bg-wv-cyan/20"
          >
            <span>LOC</span> FLY TO LOCATION
          </button>
        </div>
      </div>
    </div>
  );
}

export default function CCTVPanel({
  cameras,
  isLoading,
  error,
  totalOnline,
  totalCameras,
  availableCountries,
  countryFilter,
  selectedCameraId,
  onCountryFilterChange,
  onSelectCamera,
  onFlyToCamera,
  isMobile = false,
}: CCTVPanelProps) {
  const [visible, setVisible] = useState(true);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [paginationState, setPaginationState] = useState<{ key: string; page: number }>({
    key: '',
    page: 0,
  });

  const countryFlagMap = useMemo(
    () => new Map(availableCountries.map((country) => [country.code, country.flag])),
    [availableCountries],
  );

  const selectedCamera = useMemo(
    () => cameras.find((camera) => camera.id === selectedCameraId) ?? null,
    [cameras, selectedCameraId],
  );

  const paginationKey = useMemo(() => {
    const firstCamera = cameras[0]?.id ?? '';
    const lastCamera = cameras[cameras.length - 1]?.id ?? '';
    return `${countryFilter}:${cameras.length}:${firstCamera}:${lastCamera}`;
  }, [cameras, countryFilter]);

  const page = paginationState.key === paginationKey ? paginationState.page : 0;
  const pagedCameras = useMemo(
    () => cameras.slice(0, (page + 1) * PAGE_SIZE),
    [cameras, page],
  );
  const hasMore = pagedCameras.length < cameras.length;

  const handleSelectCamera = useCallback((camera: CameraFeed) => {
    onSelectCamera(camera.id === selectedCameraId ? null : camera);
  }, [onSelectCamera, selectedCameraId]);

  const handleFlyTo = useCallback(() => {
    if (!selectedCamera) {
      return;
    }

    onFlyToCamera(selectedCamera);
    if (isMobile) {
      setVisible(false);
      setMobileOpen(false);
    }
  }, [isMobile, onFlyToCamera, selectedCamera]);

  const handleLoadMore = useCallback(() => {
    setPaginationState((current) => ({
      key: paginationKey,
      page: (current.key === paginationKey ? current.page : 0) + 1,
    }));
  }, [paginationKey]);

  const panelBody = (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="shrink-0 border-b border-wv-border px-3 py-2">
        <div className="mb-1.5 text-[8px] uppercase tracking-widest text-wv-muted">Region Filter</div>
        <div className="flex flex-wrap gap-1">
          <button
            onClick={() => onCountryFilterChange('ALL')}
            className={`rounded px-2 py-1 text-[9px] tracking-wider transition-all duration-200 ${
              countryFilter === 'ALL'
                ? 'bg-white/10 text-wv-cyan ring-1 ring-wv-cyan/40'
                : 'text-wv-muted hover:bg-white/5 hover:text-wv-text'
            }`}
          >
            ALL
          </button>
          {availableCountries.map((country) => (
            <button
              key={country.code}
              onClick={() => onCountryFilterChange(country.code)}
              className={`rounded px-2 py-1 text-[9px] tracking-wider transition-all duration-200 ${
                countryFilter === country.code
                  ? 'bg-white/10 text-wv-cyan ring-1 ring-wv-cyan/40'
                  : 'text-wv-muted hover:bg-white/5 hover:text-wv-text'
              }`}
            >
              {country.flag} {country.code}
            </button>
          ))}
        </div>
      </div>

      <div className="flex shrink-0 items-center justify-between border-b border-wv-border px-3 py-1.5">
        <span className="text-[9px] tracking-wider text-wv-muted">
          CAMERAS ONLINE: <span className="text-wv-green">{totalOnline}</span>
          <span className="text-wv-muted"> / {totalCameras}</span>
        </span>
        {error && <span className="text-[8px] tracking-wider text-wv-red">ERR</span>}
      </div>

      {selectedCamera && (
        <CameraPreview
          key={selectedCamera.id}
          camera={selectedCamera}
          flag={countryFlagMap.get(selectedCamera.country) ?? ''}
          onFlyTo={handleFlyTo}
        />
      )}

      <div className="flex-1 overflow-y-auto p-2">
        {cameras.length === 0 && !isLoading && (
          <div className="py-8 text-center text-wv-muted">
            <div className="text-[11px] font-bold tracking-wider">NO CAMERAS AVAILABLE</div>
            <div className="mt-1 text-[9px]">
              {error ? 'Connection error, retrying...' : 'No feeds found for this region'}
            </div>
          </div>
        )}

        <div className={`grid gap-1.5 ${isMobile ? 'grid-cols-2' : 'grid-cols-3'}`}>
          {pagedCameras.map((camera) => (
            <CameraThumbnail
              key={camera.id}
              camera={camera}
              isSelected={selectedCamera?.id === camera.id}
              onSelect={handleSelectCamera}
            />
          ))}
        </div>

        {hasMore && (
          <button
            onClick={handleLoadMore}
            className={`mt-2 w-full rounded bg-white/5 px-2 py-1.5 tracking-wider text-wv-muted transition-all duration-200 hover:bg-white/10 hover:text-wv-text ${
              isMobile ? 'min-h-[44px] text-[11px]' : 'text-[9px]'
            }`}
          >
            LOAD MORE ({cameras.length - pagedCameras.length} remaining)
          </button>
        )}
      </div>
    </div>
  );

  if (isMobile) {
    return (
      <>
        <button
          onClick={() => setMobileOpen(true)}
          className="fixed right-16 top-3 z-40 flex h-11 w-11 items-center justify-center rounded-lg panel-glass text-wv-red transition-colors hover:bg-white/10 select-none active:scale-95"
          aria-label="Open CCTV surveillance"
        >
          <span className="text-sm font-bold tracking-wider">CAM</span>
          {totalOnline > 0 && (
            <span className="absolute -right-1 -top-1 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-wv-red px-0.5 text-[8px] font-bold text-white">
              {totalOnline > 99 ? '99+' : totalOnline}
            </span>
          )}
        </button>
        <MobileModal
          open={mobileOpen}
          onClose={() => setMobileOpen(false)}
          title="CCTV Surveillance"
          icon="CAM"
          accent="bg-wv-red"
        >
          {panelBody}
        </MobileModal>
      </>
    );
  }

  return (
    <div data-testid="cctv-panel" className="fixed right-4 top-80 z-40 flex max-h-[calc(100vh-22rem)] w-80 flex-col overflow-hidden rounded-lg panel-glass select-none">
      <div
        className="flex shrink-0 cursor-pointer items-center justify-between border-b border-wv-border px-3 py-2"
        onClick={() => setVisible((current) => !current)}
      >
        <div className="flex items-center gap-2">
          <div className="h-2 w-2 rounded-full bg-wv-red animate-pulse" />
          <span className="text-[10px] uppercase tracking-widest text-wv-muted">CCTV Surveillance</span>
        </div>
        <div className="flex items-center gap-2">
          {isLoading && (
            <div className="h-3 w-3 animate-spin rounded-full border border-wv-cyan/40 border-t-wv-cyan" />
          )}
          <span className="text-[10px] text-wv-muted">{visible ? 'ON' : 'OFF'}</span>
        </div>
      </div>
      {visible && panelBody}
    </div>
  );
}
