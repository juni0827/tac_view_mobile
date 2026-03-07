export type TrackedEntityType =
  | 'satellite'
  | 'aircraft'
  | 'ship'
  | 'earthquake'
  | 'cctv'
  | 'facility'
  | 'group'
  | 'unknown';

export interface TrackedEntityInfo {
  id: string;
  name: string;
  entityType: TrackedEntityType;
  description: string;
}
