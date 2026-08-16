const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getDriveClient } = require('../config/googleAuth');
const { getMediaDir, getCampusDir } = require('./playlist');
const { setSyncStatus } = require('../state');

// Tracks Drive file id -> local name/folder so Recent events.json photo
// ids can be resolved, and so a rename on Drive can drop the old local path.
const SYNC_MANIFEST_PATH = path.join(getMediaDir(), '.sync-manifest.json');

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';

// Shared Drive / "Shared with me" folders return incomplete listings (often
// only files this OAuth user has already opened) unless both of these are
// set. New files added by someone else then look like they don't exist, and
// every already-known file logs "up to date".
const DRIVE_SHARE_OPTS = {
  supportsAllDrives: true,
  includeItemsFromAllDrives: true,
};

// Local-only files that Drive is not the source of truth for. Everything
// else under the campus cache is a one-way mirror of Drive.
function isProtectedLocal(name) {
  const lower = name.toLowerCase();
  if (lower === 'prayers-cache.json') return true;
  if (lower === 'wall-config.json') return true;
  if (lower.startsWith('.')) return true;
  // News ticker is authored locally (see playlist.js getNewsTickerText).
  if (/^news.*\.txt$/i.test(name)) return true;
  return false;
}

function loadManifest() {
  if (!fs.existsSync(SYNC_MANIFEST_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(SYNC_MANIFEST_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveManifest(manifest) {
  fs.writeFileSync(SYNC_MANIFEST_PATH, JSON.stringify(manifest, null, 2));
}

// relPath is relative to the campus dir, using `/` (e.g. "recent/a.jpg",
// "fullscreen_img/sunday.jpg", "events.json"). First path segment is the
// zone folder for playlist lookup; the rest (including nested dirs) is
// the local name inside that zone.
function destFor(campusDir, relPath) {
  return path.join(campusDir, ...relPath.split('/'));
}

function relPathFor(folder, name) {
  return folder ? `${folder}/${name}` : name;
}

function manifestParts(relPath) {
  const idx = relPath.indexOf('/');
  if (idx === -1) return { folder: null, name: relPath };
  return { folder: relPath.slice(0, idx), name: relPath.slice(idx + 1) };
}

// First-level campus subfolders are lowercased so they match playlist
// paths (featured/, recent/, fullscreen_img/). Nested folder names keep
// whatever Drive used.
function childRelDir(parentRel, childName) {
  if (!parentRel) return childName.toLowerCase();
  return `${parentRel}/${childName}`;
}

function removeLocalFile(fullPath, label) {
  try {
    fs.unlinkSync(fullPath);
    console.log(`[drive-sync]   removed (not on Drive): ${label}`);
    return true;
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`[drive-sync]   could not remove ${label}: ${err.message}`);
    return false;
  }
}

function md5File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

// Why this local file is not a match for the Drive file, or null if it is.
// Drive's md5Checksum/size are the source of truth - the manifest's stored
// modifiedTime is not trusted on its own (a truncated previous download
// still "exists" and would otherwise stay stale forever).
async function localMismatchReason(destPath, file) {
  if (!fs.existsSync(destPath)) return 'missing locally';

  let stat;
  try {
    stat = fs.statSync(destPath);
  } catch {
    return 'missing locally';
  }
  if (!stat.isFile()) return 'not a file locally';

  if (file.size != null && file.size !== '' && String(stat.size) !== String(file.size)) {
    return `size differs (local ${stat.size}, Drive ${file.size})`;
  }

  if (file.md5Checksum) {
    const localMd5 = await md5File(destPath);
    if (localMd5 !== file.md5Checksum) {
      return 'content differs from Drive';
    }
  }

  return null;
}

async function downloadFile(drive, file, destPath) {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const tmpPath = `${destPath}.part`;
  const dest = fs.createWriteStream(tmpPath);
  try {
    const res = await drive.files.get(
      { fileId: file.id, alt: 'media', ...DRIVE_SHARE_OPTS },
      { responseType: 'stream' }
    );
    // Must wait for the writable 'finish' (bytes flushed to disk), not the
    // readable 'end' - otherwise a later "file exists" check treats a
    // truncated download as current and never retries.
    await new Promise((resolve, reject) => {
      res.data.on('error', (err) => {
        dest.destroy();
        reject(err);
      });
      dest.on('error', reject);
      dest.on('finish', resolve);
      res.data.pipe(dest);
    });
    fs.renameSync(tmpPath, destPath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // ignore cleanup failure
    }
    throw err;
  }
}

async function listChildren(drive, folderId) {
  let pageToken;
  const all = [];
  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name, modifiedTime, mimeType, md5Checksum, size, shortcutDetails)',
      pageSize: 200,
      pageToken,
      ...DRIVE_SHARE_OPTS,
    });
    all.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return all;
}

async function driveGet(drive, fileId, fields) {
  const res = await drive.files.get({
    fileId,
    fields,
    ...DRIVE_SHARE_OPTS,
  });
  return res.data;
}

// Folders, binaries, and shortcuts-to-either. Google-native docs/sheets
// return null and are skipped. Used so nested folders, shortcuts, and
// every zone (featured / recent / fullscreen_img / anything else) all
// take the same one-way path.
async function resolveChild(drive, file) {
  if (!file) return null;

  if (file.mimeType === FOLDER_MIME) {
    return { kind: 'folder', id: file.id, name: file.name };
  }

  if (file.mimeType === SHORTCUT_MIME) {
    let targetId = file.shortcutDetails && file.shortcutDetails.targetId;
    if (!targetId) {
      const meta = await driveGet(drive, file.id, 'shortcutDetails');
      targetId = meta.shortcutDetails && meta.shortcutDetails.targetId;
    }
    if (!targetId) return null;
    const target = await driveGet(drive, targetId, 'id, name, modifiedTime, mimeType, md5Checksum, size');
    if (!target) return null;
    if (target.mimeType === FOLDER_MIME) {
      return { kind: 'folder', id: target.id, name: file.name };
    }
    if (target.mimeType && target.mimeType.startsWith('application/vnd.google-apps')) {
      return null;
    }
    return { kind: 'file', ...target, name: file.name };
  }

  if (file.mimeType && file.mimeType.startsWith('application/vnd.google-apps')) {
    return null;
  }
  return { kind: 'file', ...file };
}

// Downloads `file` to campusDir/relPath unless the local bytes already
// match Drive (size + md5). Manifest is keyed by Drive file id so Recent
// events.json photo ids keep resolving, and a rename/move on Drive drops
// the stale local path.
async function syncOneFile(drive, file, relPath, ctx) {
  ctx.seenFileIds.add(file.id);
  ctx.seenLocalRels.add(relPath);
  const { folder, name } = manifestParts(relPath);
  const known = ctx.manifest[file.id];
  const destPath = destFor(ctx.campusDir, relPath);

  if (known) {
    const oldRel = relPathFor(known.folder, known.name);
    if (oldRel !== relPath && !ctx.seenLocalRels.has(oldRel)) {
      removeLocalFile(destFor(ctx.campusDir, oldRel), `${relPath} (renamed to "${name}")`);
    }
  }

  let mismatch = await localMismatchReason(destPath, file);
  if (!mismatch && !file.md5Checksum && (!known || known.modifiedTime !== file.modifiedTime)) {
    mismatch = fs.existsSync(destPath) ? 'modified on Drive' : 'missing locally';
  }
  if (mismatch) {
    console.log(`[drive-sync]   downloading (${mismatch}): ${relPath}`);
    await downloadFile(drive, file, destPath);
    ctx.manifest[file.id] = {
      name,
      folder,
      modifiedTime: file.modifiedTime,
      md5Checksum: file.md5Checksum || null,
      size: file.size != null ? String(file.size) : null,
    };
    return true;
  }

  ctx.manifest[file.id] = {
    name,
    folder,
    modifiedTime: file.modifiedTime,
    md5Checksum: file.md5Checksum || null,
    size: file.size != null ? String(file.size) : null,
  };
  console.log(`[drive-sync]   up to date: ${relPath}`);
  return false;
}

// Recursively one-way-mirror a Drive folder into campusDir/relDir.
// relDir is '' at the campus root. Every nested folder (recent/,
// fullscreen_img/, future zone folders, and folders inside those) is
// walked the same way - no special cases, nothing ignored except
// Google-native docs and git-managed wall-config.json.
async function syncTree(drive, folderId, relDir, ctx) {
  if (ctx.seenFolderIds.has(folderId)) return;
  ctx.seenFolderIds.add(folderId);

  const localDir = relDir ? destFor(ctx.campusDir, relDir) : ctx.campusDir;
  fs.mkdirSync(localDir, { recursive: true });

  const children = await listChildren(drive, folderId);
  const display = relDir || '(campus root)';
  console.log(
    `[drive-sync] "${display}/" -> ${children.length} item(s): ${
      children.map((c) => c.name).join(', ') || '(empty)'
    }`
  );

  for (const raw of children) {
    const label = relDir ? `${relDir}/${raw.name}` : raw.name;
    const resolved = await resolveChild(drive, raw);

    if (!resolved) {
      if (raw.mimeType && raw.mimeType.startsWith('application/vnd.google-apps')) {
        console.log(`[drive-sync]   skip (Google-native doc type): ${label}`);
      }
      continue;
    }

    if (resolved.kind === 'folder') {
      await syncTree(drive, resolved.id, childRelDir(relDir, resolved.name), ctx);
      continue;
    }

    if (resolved.name.toLowerCase() === 'wall-config.json') {
      console.log(`[drive-sync]   skip (wall-config.json is git-managed, not Drive-managed): ${label}`);
      continue;
    }

    const relPath = relDir ? `${relDir}/${resolved.name}` : resolved.name;
    ctx.seenFiles.push(relPath);
    const downloaded = await syncOneFile(drive, resolved, relPath, ctx);
    if (downloaded) ctx.filesSynced += 1;
  }
}

function walkLocalFiles(dir, relBase, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkLocalFiles(full, rel, out);
    } else if (entry.isFile()) {
      out.push({ rel, full, name: entry.name });
    }
  }
}

function removeEmptyDirs(dir, keepRoot) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      removeEmptyDirs(path.join(dir, entry.name), false);
    }
  }
  if (keepRoot) return;
  try {
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch {
    // ignore
  }
}

// Root org folder contains one subfolder per campus (e.g. "milpitas") -
// find the one matching CAMPUS and return its Drive folder id.
async function resolveCampusFolder(drive, rootFolderId, campus) {
  const rootEntries = await listChildren(drive, rootFolderId);
  const campusFolders = rootEntries.filter((f) => f.mimeType === FOLDER_MIME);
  const match = campusFolders.find((f) => f.name.toLowerCase() === campus.toLowerCase());

  if (!match) {
    const available = campusFolders.map((f) => f.name).join(', ') || '(none found)';
    throw new Error(`CAMPUS "${campus}" not found under Drive root - available: ${available}`);
  }
  return match;
}

// Guards against overlapping runs stepping on each other - both read-
// modify-write the same manifest file and the same local directories, so
// two runs interleaved (e.g. the node-cron schedule firing while a manual
// "Check Now" sync is still downloading, or two nodemon dev-restarts close
// together each kicking off their own startup sync) can otherwise race:
// one run's prune pass can delete a file the other run just legitimately
// downloaded, before it gets the chance to re-download it. A second call
// while one is already in flight just joins that same run instead of
// starting its own.
let syncPromise = null;

function syncDriveFolder() {
  if (syncPromise) {
    console.log('[drive-sync] sync already in progress - joining that run instead of starting a new one');
    return syncPromise;
  }
  syncPromise = runSync().finally(() => {
    syncPromise = null;
  });
  return syncPromise;
}

// One-way mirror of the whole campus Drive folder into media/<campus>/.
// Drive is the only source of truth: every file and every nested folder
// (featured/, recent/, fullscreen_img/, events.json, and anything else
// added later) is downloaded if local bytes differ, then any local file
// Drive does not have is deleted. prayers-cache.json and news*.txt are
// local-only and left alone.
async function runSync() {
  const rootFolderId = process.env.DRIVE_ROOT_FOLDER_ID;
  const campus = process.env.CAMPUS;

  if (!rootFolderId || !campus) {
    setSyncStatus({
      lastSyncOk: false,
      lastSyncError: 'DRIVE_ROOT_FOLDER_ID and/or CAMPUS not configured',
      lastSyncAt: new Date().toISOString(),
    });
    return;
  }

  setSyncStatus({ inProgress: true });
  console.log(`[drive-sync] starting sync - root folder ${rootFolderId}, campus "${campus}"`);
  const campusDir = getCampusDir();
  fs.mkdirSync(campusDir, { recursive: true });

  const ctx = {
    campusDir,
    manifest: loadManifest(),
    filesSynced: 0,
    seenFiles: [],
    seenFileIds: new Set(),
    seenLocalRels: new Set(),
    seenFolderIds: new Set(),
  };

  try {
    const drive = getDriveClient();
    const campusFolder = await resolveCampusFolder(drive, rootFolderId, campus);
    console.log(`[drive-sync] resolved campus "${campus}" -> folder id ${campusFolder.id}`);

    await syncTree(drive, campusFolder.id, '', ctx);

    // Drop manifest entries for Drive ids we didn't see this run (deleted
    // or replaced). File deletion itself is the filesystem walk below, so
    // a same-path / new-id replace cannot delete a file we just downloaded.
    for (const fileId of Object.keys(ctx.manifest)) {
      if (!ctx.seenFileIds.has(fileId)) delete ctx.manifest[fileId];
    }

    // Strict mirror: any local file under the campus cache that Drive does
    // not currently own is removed, whether or not a previous manifest
    // tracked it (old /upload leftovers, copies, truncated .part files).
    let filesPruned = 0;
    const localFiles = [];
    walkLocalFiles(campusDir, '', localFiles);
    for (const local of localFiles) {
      if (isProtectedLocal(local.name)) continue;
      if (ctx.seenLocalRels.has(local.rel)) continue;
      if (removeLocalFile(local.full, local.rel)) filesPruned += 1;
    }
    removeEmptyDirs(campusDir, true);

    saveManifest(ctx.manifest);
    console.log(
      `[drive-sync] done - ${ctx.filesSynced} file(s) downloaded, ${filesPruned} file(s) pruned, ${ctx.seenFileIds.size} total tracked.`
    );
    setSyncStatus({
      inProgress: false,
      lastSyncOk: true,
      lastSyncError: null,
      lastSyncAt: new Date().toISOString(),
      filesSynced: ctx.filesSynced,
      filesPruned,
      filesSeen: ctx.seenFiles,
    });
  } catch (err) {
    console.error('[drive-sync] FAILED:', err.message);
    setSyncStatus({
      inProgress: false,
      lastSyncOk: false,
      lastSyncError: err.message,
      lastSyncAt: new Date().toISOString(),
    });
  }
}

module.exports = { syncDriveFolder };
