/* Local disk persistence for manual places. Never reads remote provider data. */
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  MAX_PLACES_JSON_BYTES,
  PLACE_SCHEMA,
  validatePlacesDocument,
} from '../src/argus/personalPlaces.js';

export function defaultPlacesPath() {
  return path.join(homedir(), '.maker-team', 'personal-places.json');
}

async function storageFile(databasePath) {
  let info;
  try {
    info = await lstat(databasePath);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(
      'personal places storage must be a regular file, not a symlink',
    );
  }
  return info;
}

function checkSize(bytes) {
  if (bytes > MAX_PLACES_JSON_BYTES) {
    throw new Error('personal places JSON exceeds size limit');
  }
}

export async function loadPlaces(databasePath = defaultPlacesPath()) {
  const info = await storageFile(databasePath);
  if (!info) return [];
  checkSize(info.size);
  const flags = constants.O_RDONLY
    | (constants.O_NOFOLLOW ?? 0)
    | (constants.O_NONBLOCK ?? 0);
  const file = await open(databasePath, flags);
  try {
    const opened = await file.stat();
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino) {
      throw new Error('personal places storage changed while opening');
    }
    checkSize(opened.size);
    // Bound actual reads too: a file may grow after stat. Never read it all first.
    const buffer = Buffer.alloc(MAX_PLACES_JSON_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    checkSize(length);
    const json = new TextDecoder('utf-8', { fatal: true }).decode(
      buffer.subarray(0, length),
    );
    return validatePlacesDocument(JSON.parse(json)).places;
  } finally {
    await file.close();
  }
}

export async function savePlaces(places, databasePath = defaultPlacesPath()) {
  const document = validatePlacesDocument({ schema: PLACE_SCHEMA, places });
  const json = JSON.stringify(document, null, 2);
  checkSize(Buffer.byteLength(json, 'utf8'));
  await storageFile(databasePath);
  await mkdir(path.dirname(databasePath), { recursive: true });
  const temp = databasePath + '.' + process.pid + '-' + randomUUID() + '.tmp';
  // POSIX mode limits access on creation/replacement.
  // This is not a Windows ACL guarantee.
  const file = await open(temp, 'wx', 0o600);
  try {
    try {
      await file.writeFile(json, 'utf8');
    } finally {
      await file.close();
    }
    await storageFile(databasePath);
    await rename(temp, databasePath);
  } finally {
    await unlink(temp).catch((err) => {
      if (err.code !== 'ENOENT') throw err;
    });
  }
}

// HOLD: cross-process read/modify/write can lose updates, and path components can
// change between checks and rename. Concurrency and hostile directory replacement
// require a separate locking/path-ownership design; these checks are not a lock.
