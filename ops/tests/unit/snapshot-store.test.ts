import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSnapshotStore } from '../../../app/server/snapshot-store.js';

describe('snapshot store', () => {
  it('writes and reads snapshots using safe file names', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'tac-view-snapshots-'));
    const store = createSnapshotStore(tempDir);

    await store.write('Ships Moving', [{ mmsi: '123456789' }]);
    expect(await store.read('Ships Moving')).toEqual([{ mmsi: '123456789' }]);
    expect(await store.read('missing-key')).toBeUndefined();

    await rm(tempDir, { recursive: true, force: true });
  });
});
