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

// Each campus folder is organized as subfolders (e.g. "main", "recent"),
// one per wall zone - each syncs into the matching local media/<name>/
// directory. Loose files sitting directly in the campus folder root are
// intentionally ignored (with a warning) rather than guessed into a zone.
async function syncDriveFolder() {
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
        `[drive-sync] WARNING: ${looseOtherFiles.length} file(s) sit directly in the "${campus}" campus folder and are ignored - move them into a subfolder (e.g. "main"): ${looseOtherFiles
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
      const known = manifest[file.id];
      const destPath = path.join(campusDir, file.name);
      const needsDownload = !known || known.modifiedTime !== file.modifiedTime || !fs.existsSync(destPath);

      if (needsDownload) {
        console.log(`[drive-sync]   downloading (campus root): ${file.name}`);
        await downloadFile(drive, file, destPath);
        manifest[file.id] = { name: file.name, folder: null, modifiedTime: file.modifiedTime };
        filesSynced += 1;
      } else {
        console.log(`[drive-sync]   up to date: ${file.name}`);
      }
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
        const known = manifest[file.id];
        const destPath = path.join(localSubdir, file.name);
        const needsDownload = !known || known.modifiedTime !== file.modifiedTime || !fs.existsSync(destPath);

        if (needsDownload) {
          console.log(`[drive-sync]   downloading: ${folder.name}/${file.name}`);
          await downloadFile(drive, file, destPath);
          manifest[file.id] = { name: file.name, folder: zoneName, modifiedTime: file.modifiedTime };
          filesSynced += 1;
        } else {
          console.log(`[drive-sync]   up to date: ${folder.name}/${file.name}`);
        }
      }
    }

    saveManifest(manifest);
    console.log(`[drive-sync] done - ${filesSynced} file(s) downloaded, ${seenFiles.length} total tracked.`);
    setSyncStatus({
      inProgress: false,
      lastSyncOk: true,
      lastSyncError: null,
      lastSyncAt: new Date().toISOString(),
      filesSynced,
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
