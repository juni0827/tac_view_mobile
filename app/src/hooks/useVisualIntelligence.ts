import { useSyncExternalStore } from 'react';
import { groupController } from '../intelligence/groupController';
import {
  EMPTY_VISUAL_INTELLIGENCE_STATE,
  type VisualIntelligenceState,
} from '../intelligence/visualIntelligence';

export function useVisualIntelligence(): VisualIntelligenceState {
  return useSyncExternalStore(
    (listener) => groupController.subscribe(listener),
    () => groupController.getSnapshot(),
    () => EMPTY_VISUAL_INTELLIGENCE_STATE,
  );
}
