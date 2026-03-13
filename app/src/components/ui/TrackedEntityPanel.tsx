import { useMemo, useState } from 'react';
import type { TrackedEntityInfo, TrackedEntityType } from '../../types/trackedEntity';
import type { OntologyEntityDetail } from '../../types/ontology';

interface TrackedEntityPanelProps {
  trackedEntity: TrackedEntityInfo | null;
  ontologyEntity?: OntologyEntityDetail | null;
  onUnlock?: () => void;
  isMobile?: boolean;
}

const TYPE_LABELS: Record<TrackedEntityType, string> = {
  satellite: 'SATELLITE',
  aircraft: 'AIRCRAFT',
  ship: 'VESSEL',
  earthquake: 'SEISMIC EVENT',
  cctv: 'CCTV SENSOR',
  facility: 'FACILITY',
  group: 'GROUP',
  unknown: 'TARGET',
};

const TYPE_BADGES: Record<TrackedEntityType, string> = {
  satellite: 'SAT',
  aircraft: 'AIR',
  ship: 'AIS',
  earthquake: 'SEIS',
  cctv: 'CCTV',
  facility: 'FAC',
  group: 'GRP',
  unknown: 'OBJ',
};

const TYPE_COLORS: Record<TrackedEntityType, string> = {
  satellite: 'text-wv-green',
  aircraft: 'text-wv-cyan',
  ship: 'text-wv-cyan',
  earthquake: 'text-wv-amber',
  cctv: 'text-wv-red',
  facility: 'text-wv-cyan',
  group: 'text-wv-green',
  unknown: 'text-wv-muted',
};

function parseDescription(html: string): Array<{ key: string; value: string }> {
  const pairs: Array<{ key: string; value: string }> = [];
  const regex = /<b>([^<]+):<\/b>\s*([^<]+)/g;
  let match: RegExpExecArray | null = regex.exec(html);

  while (match) {
    const key = match[1]?.trim();
    const value = match[2]?.trim();
    if (key && value) {
      pairs.push({ key, value });
    }
    match = regex.exec(html);
  }

  return pairs;
}

function flightAwareUrl(registration: string): string {
  return `https://www.flightaware.com/live/flight/${registration.replace(/-/g, '')}`;
}

function formatTimestamp(value: string | null | undefined) {
  if (!value) {
    return 'N/A';
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toISOString().replace('T', ' ').slice(0, 19);
}

function DetailGrid({
  details,
  trackedEntity,
}: {
  details: Array<{ key: string; value: string }>;
  trackedEntity: TrackedEntityInfo;
}) {
  if (details.length === 0) {
    return null;
  }

  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-1 mt-2 pt-2 border-t border-wv-cyan/10">
      {details.map(({ key, value }) => {
        const isAircraftRegistration = trackedEntity.entityType === 'aircraft'
          && key === 'Registration'
          && value !== 'N/A';

        return (
          <div key={key} className="flex justify-between gap-2">
            <span className="text-[9px] font-mono text-wv-muted uppercase truncate">{key}</span>
            {isAircraftRegistration ? (
              <a
                href={flightAwareUrl(value)}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[10px] font-mono text-wv-cyan tabular-nums text-right underline decoration-wv-cyan/40 hover:decoration-wv-cyan hover:text-white transition-colors"
              >
                {value}
              </a>
            ) : (
              <span className="text-[10px] font-mono text-wv-cyan tabular-nums text-right">{value}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function OntologySummary({ ontologyEntity }: { ontologyEntity: OntologyEntityDetail }) {
  return (
    <div className="mt-2 rounded border border-wv-amber/20 bg-black/20 px-3 py-2">
      <div className="mb-2 text-[9px] font-mono uppercase tracking-[0.25em] text-wv-amber">Ontology</div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[10px] font-mono">
        <div className="flex justify-between gap-2">
          <span className="text-wv-muted">Type</span>
          <span className="text-wv-amber text-right">{ontologyEntity.canonicalType.toUpperCase()}</span>
        </div>
        <div className="flex justify-between gap-2">
          <span className="text-wv-muted">Confidence</span>
          <span className="text-wv-amber text-right">{Math.round(ontologyEntity.confidence * 100)}%</span>
        </div>
        <div className="flex justify-between gap-2">
          <span className="text-wv-muted">Sources</span>
          <span className="text-wv-amber text-right">{ontologyEntity.sourceCount}</span>
        </div>
        <div className="flex justify-between gap-2">
          <span className="text-wv-muted">Relations</span>
          <span className="text-wv-amber text-right">{ontologyEntity.relations.length}</span>
        </div>
        <div className="flex justify-between gap-2">
          <span className="text-wv-muted">Last Seen</span>
          <span className="text-wv-amber text-right">{formatTimestamp(ontologyEntity.lastObservedAt)}</span>
        </div>
        <div className="flex justify-between gap-2">
          <span className="text-wv-muted">Operator</span>
          <span className="text-wv-amber text-right">{ontologyEntity.operator || 'N/A'}</span>
        </div>
      </div>
      {ontologyEntity.aliasList.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {ontologyEntity.aliasList.slice(0, 5).map((alias) => (
            <span
              key={alias}
              className="rounded border border-wv-border px-1.5 py-0.5 text-[9px] font-mono text-wv-text"
            >
              {alias}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export default function TrackedEntityPanel({
  trackedEntity,
  ontologyEntity = null,
  onUnlock,
  isMobile = false,
}: TrackedEntityPanelProps) {
  const [expanded, setExpanded] = useState(false);

  const details = useMemo(
    () => (trackedEntity ? parseDescription(trackedEntity.description) : []),
    [trackedEntity],
  );

  if (!trackedEntity) {
    return null;
  }

  const label = TYPE_LABELS[trackedEntity.entityType];
  const badge = TYPE_BADGES[trackedEntity.entityType];
  const colorClass = TYPE_COLORS[trackedEntity.entityType];

  if (isMobile) {
    return (
      <div className="fixed bottom-8 left-2 right-2 z-50 pointer-events-auto">
        <div className="panel-glass rounded-lg border border-wv-cyan/30 overflow-hidden">
          <button
            onClick={() => setExpanded((value) => !value)}
            className="w-full flex items-center gap-3 px-3 py-2 text-left"
          >
            <span className={`text-[10px] font-mono font-bold ${colorClass}`}>{badge}</span>
            <div className="flex-1 min-w-0">
              <span className="text-[10px] font-mono text-wv-muted uppercase tracking-widest block">{label}</span>
              <span className="text-[11px] font-mono font-bold text-wv-cyan truncate block">{trackedEntity.name}</span>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
              <span className="text-[8px] font-mono text-red-400 uppercase tracking-wider">
                {expanded ? 'LESS' : 'MORE'}
              </span>
            </div>
          </button>

          {expanded && (
            <div className="px-3 pb-2">
              <DetailGrid details={details} trackedEntity={trackedEntity} />
              {ontologyEntity && <OntologySummary ontologyEntity={ontologyEntity} />}
            </div>
          )}

          <button
            onClick={onUnlock}
            className="w-full text-[9px] font-mono uppercase tracking-wider text-wv-muted hover:text-wv-cyan border-t border-wv-cyan/20 px-3 py-2 transition-colors min-h-[36px]"
          >
            Unlock target
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed bottom-20 left-1/2 -translate-x-1/2 z-50 pointer-events-auto">
      <div className="panel-glass rounded border border-wv-cyan/30 px-4 py-3 min-w-[320px] max-w-[520px]">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-3">
            <span className={`text-[10px] font-mono font-bold tracking-widest ${colorClass}`}>{badge}</span>
            <div>
              <span className={`text-[10px] font-mono uppercase tracking-wider ${colorClass} opacity-70`}>
                {label} TRACKING
              </span>
              <h3 className="text-sm font-mono font-bold text-wv-cyan leading-tight">
                {trackedEntity.name}
              </h3>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative">
              <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
              <div className="absolute inset-0 w-2 h-2 rounded-full bg-red-500 animate-ping opacity-50" />
            </div>
            <span className="text-[9px] font-mono text-red-400 uppercase tracking-wider">LOCK</span>
          </div>
        </div>

        <DetailGrid details={details} trackedEntity={trackedEntity} />
        {ontologyEntity && <OntologySummary ontologyEntity={ontologyEntity} />}

        <button
          onClick={onUnlock}
          className="mt-3 w-full text-[9px] font-mono uppercase tracking-wider text-wv-muted hover:text-wv-cyan border border-wv-cyan/20 hover:border-wv-cyan/50 rounded px-2 py-1 transition-colors cursor-pointer"
        >
          Click empty space or press ESC to unlock
        </button>
      </div>
    </div>
  );
}
