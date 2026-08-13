const fs = require('fs');
const path = require('path');
const { getDriveClient } = require('../config/googleAuth');
const { getMediaDir, getCampusDir } = require('./playlist');
const { setSyncStatus } = require('../state');

// Tracks modifiedTime per Drive file id so unchanged files are skipped.
const SYNC_MANIFEST_PATH = path.join(getMediaDir(), '.sync-manifest.json');

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

// folder: zone name (e.g. "featured") or null for a loose campus-root file.
function localPathFor(campusDir, folder, name) {
  return folder ? path.join(campusDir, folder, name) : path.join(campusDir, name);
}

function removeLocalFile(fullPath, label) {
  try {
    fs.unlinkSync(fullPath);
    console.log(`[drive-sync]   removed (no longer on Drive): ${label}`);
    return true;
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`[drive-sync]   could not remove ${label}: ${err.message}`);
    return false;
  }
}

async function downloadFile(drive, file, destPath) {
  const dest = fs.createWriteStream(destPath);
  const res = await drive.files.get(
    { fileId: file.id, alt: 'media' },
    { responseType: 'stream' }
  );
  await new Promise((resolve, reject) => {
    res.data.on('end', resolve).on('error', reject).pipe(dest);
  });
}

// Downloads `file` into campusDir/[folder/]file.name if it's new or changed,
// tracking it in `manifest` keyed by Drive file id (this id is the source of
// truth for "did this come from Drive", used later to prune deletions/
// renames - see syncDriveFolder). If the same file id previously lived under
// a different name/folder (renamed or moved on Drive), the stale local copy
// under the old name is removed here rather than left behind as an orphan.
async function syncOneFile(drive, file, manifest, campusDir, folder, seenFileIds, label) {
  seenFileIds.add(file.id);
  const known = manifest[file.id];
  const destPath = localPathFor(campusDir, folder, file.name);

  if (known && (known.name !== file.name || known.folder !== folder)) {
    removeLocalFile(localPathFor(campusDir, known.folder, known.name), `${label} (renamed to "${file.name}")`);
  }

  const needsDownload = !known || known.modifiedTime !== file.modifiedTime || !fs.existsSync(destPath);
  if (needsDownload) {
    console.log(`[drive-sync]   downloading: ${label}`);
    await downloadFile(drive, file, destPath);
    manifest[file.id] = { name: file.name, folder, modifiedTime: file.modifiedTime };
    return true;
  }

  console.log(`[drive-sync]   up to date: ${label}`);
  return false;
}

async function listChildren(drive, folderId) {
  let pageToken;
  const all = [];
  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name, modifiedTime, mimeType)',
      pageToken,
      pageSize: 200,
    });
    all.push(...res.data.files);
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return all;
}

const FOLDER_MIME = 'application/vnd.google-apps.folder';

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

// Each campus folder is organized as subfolders (e.g. "featured", "recent"),
// one per wall zone - each syncs into the matching local media/<name>/
// directory. Loose files sitting directly in the campus folder root are
// intentionally ignored (with a warning) rather than guessed into a zone.
//
// One-way mirror: Drive is the master copy. Besides downloading new/changed
// files, every run also prunes local files that this manifest previously
// pulled from Drive but that Drive no longer has (deleted, or replaced under
// a new id) - see the prune pass at the end. Local files this manifest never
// tracked (e.g. on-site fallback uploads via /upload, which land directly in
// the Featured cache) are deliberately left alone - only Drive-sourced files
// are ever removed automatically.
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
  const manifest = loadManifest();
  let filesSynced = 0;
  const seenFiles = [];
  const seenFileIds = new Set();

  try {
    const drive = getDriveClient();
    const campusFolder = await resolveCampusFolder(drive, rootFolderId, campus);
    console.log(`[drive-sync] resolved campus "${campus}" -> folder id ${campusFolder.id}`);

    const rootEntries = await listChildren(drive, campusFolder.id);

    const subfolders = rootEntries.filter((f) => f.mimeType === FOLDER_MIME);
    const looseFiles = rootEntries.filter((f) => f.mimeType !== FOLDER_MIME);

    console.log(
      `[drive-sync] found ${subfolders.length} subfolder(s): ${
        subfolders.map((f) => f.name).join(', ') || '(none)'
      }`
    );

    // Loose files sitting directly in the campus folder root aren't a wall
    // zone, but a loose .json here (e.g. events.json) is legitimate data the
    // frontend reads directly - sync those straight into the campus root.
    // Anything else loose is genuinely unplaced content, so it's still just
    // logged and skipped rather than guessed into a zone.
    const looseJsonFiles = looseFiles.filter((f) => f.name.toLowerCase().endsWith('.json'));
    const looseOtherFiles = looseFiles.filter((f) => !f.name.toLowerCase().endsWith('.json'));
    if (looseOtherFiles.length > 0) {
      console.log(
        `[drive-sync] WARNING: ${looseOtherFiles.length} file(s) sit directly in the "${campus}" campus folder and are ignored - move them into a subfolder (e.g. "featured"): ${looseOtherFiles
          .map((f) => f.name)
          .join(', ')}`
      );
    }

    for (const file of looseJsonFiles) {
      if (file.name.toLowerCase() === 'wall-config.json') {
        console.log(`[drive-sync]   skip (wall-config.json is git-managed, not Drive-managed): ${file.name}`);
        continue;
      }

      seenFiles.push(file.name);
      const downloaded = await syncOneFile(drive, file, manifest, campusDir, null, seenFileIds, `(campus root): ${file.name}`);
      if (downloaded) filesSynced += 1;
    }

    for (const folder of subfolders) {
      const zoneName = folder.name.toLowerCase();
      const localSubdir = path.join(campusDir, zoneName);
      fs.mkdirSync(localSubdir, { recursive: true });

      const children = await listChildren(drive, folder.id);
      console.log(
        `[drive-sync] "${folder.name}/" -> ${children.length} item(s): ${
          children.map((c) => c.name).join(', ') || '(empty)'
        }`
      );

      for (const file of children) {
        if (file.mimeType && file.mimeType.startsWith('application/vnd.google-apps')) {
          console.log(`[drive-sync]   skip (Google-native doc type): ${folder.name}/${file.name}`);
          continue;
        }
        if (file.name.toLowerCase() === 'wall-config.json') {
          console.log(
            `[drive-sync]   skip (wall-config.json is git-managed, not Drive-managed): ${folder.name}/${file.name}`
          );
          continue;
        }

        seenFiles.push(`${zoneName}/${file.name}`);
        const downloaded = await syncOneFile(
          drive,
          file,
          manifest,
          campusDir,
          zoneName,
          seenFileIds,
          `${folder.name}/${file.name}`
        );
        if (downloaded) filesSynced += 1;
      }
    }

    // One-way mirror prune: any manifest entry we didn't see this run came
    // from Drive previously and is no longer there (deleted, or superseded
    // by a different file id) - remove its local copy and forget it. Only
    // ever touches files this same manifest downloaded in the first place,
    // so it can't reach out and delete unrelated local content (e.g. an
    // on-site /upload fallback file that was never Drive's to begin with).
    let filesPruned = 0;
    for (const [fileId, entry] of Object.entries(manifest)) {
      if (seenFileIds.has(fileId)) continue;
      const label = entry.folder ? `${entry.folder}/${entry.name}` : entry.name;
      removeLocalFile(localPathFor(campusDir, entry.folder, entry.name), label);
      delete manifest[fileId];
      filesPruned += 1;
    }

    saveManifest(manifest);
    console.log(
      `[drive-sync] done - ${filesSynced} file(s) downloaded, ${filesPruned} file(s) pruned, ${seenFiles.length} total tracked.`
    );
    setSyncStatus({
      inProgress: false,
      lastSyncOk: true,
      lastSyncError: null,
      lastSyncAt: new Date().toISOString(),
      filesSynced,
      filesPruned,
      filesSeen: seenFiles,
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
