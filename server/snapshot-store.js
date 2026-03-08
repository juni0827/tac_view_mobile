import fs from 'node:fs/promises';
import path from 'node:path';

function toSnapshotPath(rootDir, key) {
  const safeKey = key.replace(/[^a-z0-9_-]+/gi, '_').toLowerCase();
  return path.join(rootDir, `${safeKey}.json`);
}

export function createSnapshotStore(rootDir) {
  async function ensureDir() {
    await fs.mkdir(rootDir, { recursive: true });
  }

  return {
    rootDir,
    async read(key) {
      try {
        const snapshotPath = toSnapshotPath(rootDir, key);
        const raw = await fs.readFile(snapshotPath, 'utf8');
        const parsed = JSON.parse(raw);
        return parsed.value;
      } catch (error) {
        if (error.code === 'ENOENT') return undefined;
        console.warn(`[SNAPSHOT] Read failed for ${key}:`, error.message);
        return undefined;
      }
    },
    async write(key, value) {
      try {
        await ensureDir();
        const snapshotPath = toSnapshotPath(rootDir, key);
        await fs.writeFile(
          snapshotPath,
          JSON.stringify(
            {
              updatedAt: new Date().toISOString(),
              value,
            },
            null,
            2,
          ),
          'utf8',
        );
      } catch (error) {
        console.warn(`[SNAPSHOT] Write failed for ${key}:`, error.message);
      }
    },
  };
}
