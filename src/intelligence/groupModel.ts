import type { IntelFeedItem } from '../components/ui/IntelFeed';
import type { CameraFeed } from '../types/camera';
import type { TrackedEntityInfo } from '../types/trackedEntity';
import type { RenderCameraState } from '../types/rendering';
import type { Flight } from '../hooks/useFlights';
import type { Ship } from '../hooks/useShips';
import type { SatellitePosition } from '../hooks/useSatellites';

export type GroupScale = 'micro' | 'meso' | 'cloud';
export type GroupDomain = 'air' | 'surface' | 'ground';
export type GroupSelectionKind = 'track' | 'micro' | 'meso' | 'cloud' | 'facility' | 'satellite';

export interface GlobePoint {
  latitude: number;
  longitude: number;
  altitude: number;
}

export interface PredictedPath {
  id: string;
  label: string;
  confidence: number;
  points: GlobePoint[];
}

export interface DestinationCandidate {
  id: string;
  label: string;
  latitude: number;
  longitude: number;
  altitude: number;
  confidence: number;
  kind: 'airport' | 'facility' | 'projected' | 'coverage';
}

export interface RelatedEntitySummary {
  id: string;
  name: string;
  entityType: 'aircraft' | 'ship' | 'satellite' | 'earthquake' | 'cctv' | 'facility' | 'group';
  latitude: number;
  longitude: number;
  altitude: number;
  confidence: number;
}

export interface RelationshipArc {
  id: string;
  sourceId: string;
  targetId: string;
  label: string;
  inferred: boolean;
  confidence: number;
  positions: GlobePoint[];
}

export interface CoverageOverlay {
  id: string;
  label: string;
  latitude: number;
  longitude: number;
  radiusKm: number;
  confidence: number;
}

export interface FacilityRing {
  id: string;
  label: string;
  latitude: number;
  longitude: number;
  radiusKm: number;
  confidence: number;
}

export interface AnomalyMarker {
  id: string;
  label: string;
  latitude: number;
  longitude: number;
  altitude: number;
  severity: 'low' | 'medium' | 'high';
}

export interface AltitudeStem {
  from: GlobePoint;
  to: GlobePoint;
}

export interface TrackHistorySample {
  timestamp: number;
  latitude: number;
  longitude: number;
  altitude: number;
  heading: number | null;
  speedKnots: number | null;
}

export interface MotionTrack {
  id: string;
  name: string;
  domain: GroupDomain;
  entityType: 'aircraft' | 'ship';
  latitude: number;
  longitude: number;
  altitude: number;
  heading: number | null;
  speedKnots: number | null;
  updatedAt: number;
}

export interface MicroGroupTrack {
  id: string;
  label: string;
  scale: 'micro';
  domain: GroupDomain;
  memberIds: string[];
  representativeTrackIds: string[];
  centroid: GlobePoint;
  dominantHeading: number | null;
  dominantSpeed: number;
  dispersionMeters: number;
  uncertaintyRadiusMeters: number;
  cohesionScore: number;
  persistenceScore: number;
  confidence: number;
  anchorTrackId: string;
  lastSeenAt: number;
  parentMesoId: string | null;
}

export interface MesoGroupTrack {
  id: string;
  label: string;
  scale: 'meso';
  domain: GroupDomain;
  microGroupIds: string[];
  representativeTrackIds: string[];
  centroid: GlobePoint;
  dominantHeading: number | null;
  dominantSpeed: number;
  footprintRadiusMeters: number;
  persistenceScore: number;
  confidence: number;
  lastSeenAt: number;
}

export interface ActivityCloudCell {
  cellId: string;
  latitude: number;
  longitude: number;
  density: number;
  sampleCount: number;
  dominantHeading: number | null;
  representativeIds: string[];
}

export interface ActivityCloud {
  id: string;
  label: string;
  scale: 'cloud';
  domain: GroupDomain;
  cellSizeKm: number;
  cells: ActivityCloudCell[];
  densityScore: number;
  dominantHeading: number | null;
  confidence: number;
  viewportKey: string;
  lastComputedAt: number;
}

export interface TieredGroupSnapshot {
  microGroups: MicroGroupTrack[];
  mesoGroups: MesoGroupTrack[];
  activityClouds: ActivityCloud[];
  revision: number;
  computedAt: number;
}

export interface SelectionContext {
  entityId: string;
  entityKind: GroupSelectionKind;
  entityType: TrackedEntityInfo['entityType'];
  entityName: string;
  focus: GlobePoint;
  altitudeStem: AltitudeStem | null;
  predictedPaths: PredictedPath[];
  destinationCandidates: DestinationCandidate[];
  relatedEntities: RelatedEntitySummary[];
  relationships: RelationshipArc[];
  coverageOverlays: CoverageOverlay[];
  facilityRings: FacilityRing[];
  anomalyMarkers: AnomalyMarker[];
  relatedMicroGroups: Array<Pick<MicroGroupTrack, 'id' | 'memberIds' | 'parentMesoId' | 'label'>>;
  relatedMesoGroups: Array<Pick<MesoGroupTrack, 'id' | 'microGroupIds' | 'representativeTrackIds' | 'label'>>;
  relatedClouds: Array<Pick<ActivityCloud, 'id' | 'label' | 'cells'>>;
  representativeTrackIds: string[];
  childMicroGroupIds: string[];
  topCells: ActivityCloudCell[];
}

export interface VisualIntelligenceStats {
  microCount: number;
  mesoCount: number;
  cloudCount: number;
  cloudCellCount: number;
  revision: number;
}

export interface VisualIntelligenceState {
  tieredGroups: TieredGroupSnapshot;
  selectionContext: SelectionContext | null;
  feedItems: IntelFeedItem[];
  stats: VisualIntelligenceStats;
}

export interface InputPatchBucket<T> {
  upsert: T[];
  removeIds: string[];
}

export interface GroupInputPatch {
  at?: number;
  flights?: InputPatchBucket<Flight>;
  ships?: InputPatchBucket<Ship>;
  satellites?: InputPatchBucket<SatellitePosition>;
  cameras?: InputPatchBucket<CameraFeed>;
}

export interface GroupSourceSnapshot {
  flights: Flight[];
  ships: Ship[];
  satellites: SatellitePosition[];
  cameras: CameraFeed[];
}

export interface GroupWorkerTickPayload {
  at?: number;
  forceMicro?: boolean;
  forceMeso?: boolean;
  forceCloud?: boolean;
  forceSelection?: boolean;
}

export type GroupWorkerRequest =
  | { type: 'patchInput'; patch: GroupInputPatch }
  | { type: 'setCameraState'; camera: RenderCameraState }
  | { type: 'setSelection'; selection: TrackedEntityInfo | null }
  | { type: 'tick'; payload?: GroupWorkerTickPayload }
  | { type: 'dispose' };

export type GroupWorkerResponse =
  | { type: 'state'; state: VisualIntelligenceState }
  | { type: 'ready' };

export const EMPTY_TIERED_GROUPS: TieredGroupSnapshot = {
  microGroups: [],
  mesoGroups: [],
  activityClouds: [],
  revision: 0,
  computedAt: 0,
};

export const EMPTY_VISUAL_INTELLIGENCE_STATE: VisualIntelligenceState = {
  tieredGroups: EMPTY_TIERED_GROUPS,
  selectionContext: null,
  feedItems: [],
  stats: {
    microCount: 0,
    mesoCount: 0,
    cloudCount: 0,
    cloudCellCount: 0,
    revision: 0,
  },
};
