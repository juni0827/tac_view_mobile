/// <reference lib="webworker" />

import type { GroupWorkerRequest, GroupWorkerResponse } from './groupModel';
import { createGroupStore, applyGroupInputPatch, setGroupStoreCameraState, setGroupStoreSelection } from './groupStore';
import { buildVisualIntelligenceStateFromStore } from './visualIntelligence';

const store = createGroupStore();

function publishState(payload: {
  forceMicro?: boolean;
  forceMeso?: boolean;
  forceCloud?: boolean;
} = {}) {
  const state = buildVisualIntelligenceStateFromStore(store, {
    now: Date.now(),
    ...payload,
  });
  const response: GroupWorkerResponse = {
    type: 'state',
    state,
  };
  self.postMessage(response);
}

self.postMessage({ type: 'ready' } satisfies GroupWorkerResponse);

self.onmessage = (event: MessageEvent<GroupWorkerRequest>) => {
  const message = event.data;

  switch (message.type) {
    case 'patchInput':
      applyGroupInputPatch(store, message.patch);
      publishState({
        forceMicro: true,
        forceMeso: true,
        forceCloud: true,
      });
      break;
    case 'setCameraState':
      setGroupStoreCameraState(store, message.camera);
      break;
    case 'setSelection':
      setGroupStoreSelection(store, message.selection);
      publishState();
      break;
    case 'tick':
      publishState({
        forceMicro: message.payload?.forceMicro,
        forceMeso: message.payload?.forceMeso,
        forceCloud: message.payload?.forceCloud,
      });
      break;
    case 'dispose':
      self.close();
      break;
    default:
      break;
  }
};
