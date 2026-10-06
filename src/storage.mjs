import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const SAFE_SEGMENT = /^[a-z0-9][a-z0-9-]{0,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;

function validateSegment(value, name) {
  if (typeof value !== 'string' || !SAFE_SEGMENT.test(value)) {
    throw new TypeError(`${name} must match ${SAFE_SEGMENT}.`);
  }
}

function contentHash(body) {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

/**
 * Saves response snapshots without changing their JSON text. Identical raw
 * pages share an object within a store/source; this does not deduplicate the
 * business events that may appear on different pages or in later revisions.
 */
export class SnapshotStore {
  constructor({ rootDir, storeId }) {
    if (typeof rootDir !== 'string' || rootDir.trim() === '') {
      throw new TypeError('rootDir must be a non-empty directory path.');
    }
    validateSegment(storeId, 'storeId');
    this.storeId = storeId;
    this.storeDir = path.resolve(rootDir, storeId);
  }

  async savePage({ source, body }) {
    validateSegment(source, 'source');
    if (typeof body !== 'string') {
      throw new TypeError('body must be the original JSON response string.');
    }
    // Reject non-JSON responses before creating any directory or file.
    JSON.parse(body);

    const hash = contentHash(body);
    const relativePath = `objects/${source}/${hash}.json`;
    const directory = path.join(this.storeDir, 'objects', source);
    const filename = path.join(directory, `${hash}.json`);
    await mkdir(directory, { recursive: true });
    try {
      await writeFile(filename, body, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // A prior interrupted write can leave a truncated file at the correct
      // hash path. Validate its bytes before treating it as a saved snapshot;
      // existing objects remain immutable even when they are damaged.
      const existing = await readFile(filename);
      if (
        contentHash(existing) !== hash ||
        !existing.equals(Buffer.from(body, 'utf8'))
      ) {
        throw new Error('Snapshot integrity check failed for existing object.');
      }
    }
    return { hash, relativePath };
  }

  async saveRun(manifest) {
    if (
      !manifest ||
      typeof manifest !== 'object' ||
      Array.isArray(manifest) ||
      typeof manifest.id !== 'string' ||
      !UUID.test(manifest.id)
    ) {
      throw new TypeError('manifest.id must be a valid UUID.');
    }
    if (manifest.storeId !== undefined && manifest.storeId !== this.storeId) {
      throw new TypeError('manifest.storeId must match this store.');
    }
    // Serialize before writing, so a cyclic/unsupported manifest cannot leave
    // an empty file that blocks a later attempt with the same execution ID.
    const body = JSON.stringify(manifest, null, 2);
    if (body === undefined) throw new TypeError('manifest must serialize to JSON.');

    const id = manifest.id.toLowerCase();
    const relativePath = `runs/${id}.json`;
    const directory = path.join(this.storeDir, 'runs');
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, `${id}.json`), `${body}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    return { id, relativePath };
  }

  async readPage({ source, hash }) {
    validateSegment(source, 'source');
    if (typeof hash !== 'string' || !SHA256.test(hash)) {
      throw new TypeError('hash must be a lowercase SHA-256 hex digest.');
    }
    const body = await readFile(
      path.join(this.storeDir, 'objects', source, `${hash}.json`),
      'utf8',
    );
    if (contentHash(body) !== hash) {
      throw new Error('Snapshot integrity check failed.');
    }
    return body;
  }
}
