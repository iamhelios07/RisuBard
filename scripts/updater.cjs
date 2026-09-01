/**
 * Portable updater — runs with the bundled bin/node, no npm dependencies.
 * Downloads the latest portable zip/tar.gz from GitHub Releases,
 * replaces app files while preserving save/.
 * On Windows, bundled Node (bin/) is staged and copied by update.bat
 * after this process exits, to avoid self-replacement file locks.
 */

const https = require('https');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { Transform, pipeline } = require('stream');

const REPO = 'rpaddict/RisuBard';
const ROOT = path.resolve(__dirname, '..');

const isWin = process.platform === 'win32';
const REQUIRED_ENTRIES = ['dist', 'server', 'package.json'];
const REQUIRED_DIST_FILES = ['index.html'];
const REQUIRED_WIN_ENTRIES = ['bin'];
const MANAGED_BACKUP_PATH_ROOTS = new Set(['server', 'dist', 'scripts', 'bin', 'node_modules', '.update-tmp']);

function log(msg) { process.stdout.write(`[updater] ${msg}\n`); }
function error(msg) { process.stderr.write(`[ERROR] ${msg}\n`); process.exit(1); }

function getCurrentVersion() {
    const markerPath = path.join(ROOT, '.installed-version');
    if (fs.existsSync(markerPath)) {
        return fs.readFileSync(markerPath, 'utf-8').trim();
    }
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
        return 'v' + pkg.version;
    } catch {
        return 'unknown';
    }
}

// If the user moved the server-backup directory to a custom location *inside*
// ROOT (e.g. <ROOT>/data/backups), the server writes the absolute path here so
// the updater can preserve the top-level segment instead of wiping it.
// Outside-ROOT paths return null (updater never touches them anyway).
function getCustomBackupKeepEntry() {
    const markerPath = path.join(ROOT, 'save', '__backup_path');
    try {
        if (!fs.existsSync(markerPath)) return null;
        const raw = fs.readFileSync(markerPath, 'utf-8').trim();
        if (!raw) return null;
        const abs = path.resolve(raw);
        const rel = path.relative(ROOT, abs);
        if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
        if (!rel) {
            error('Custom backup directory points at the RisuBard app root. Move it to a separate folder before updating.');
        }
        const top = rel.split(path.sep)[0];
        if (MANAGED_BACKUP_PATH_ROOTS.has(top)) {
            error(`Custom backup directory is inside RisuBard app files (${rel}). Move it to a separate folder such as data/backups before updating.`);
        }
        return top || null;
    } catch {
        return null;
    }
}

const MAX_REDIRECTS = 10;

function httpsGet(url, redirectCount = 0) {
    return new Promise((resolve, reject) => {
        if (redirectCount > MAX_REDIRECTS) return reject(new Error('Too many redirects'));
        const parsedUrl = new URL(url);
        const get = parsedUrl.protocol === 'https:' ? https.get : http.get;
        get(parsedUrl, { headers: { 'User-Agent': 'RisuBard-Updater' } }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                const redirectUrl = new URL(res.headers.location, parsedUrl).toString();
                return httpsGet(redirectUrl, redirectCount + 1).then(resolve, reject);
            }
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error(`HTTP ${res.statusCode}`));
            }
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
        }).on('error', reject);
    });
}

function downloadToFile(url, dest, redirectCount = 0) {
    return new Promise((resolve, reject) => {
        if (redirectCount > MAX_REDIRECTS) return reject(new Error('Too many redirects'));
        const parsedUrl = new URL(url);
        const get = parsedUrl.protocol === 'https:' ? https.get : http.get;
        get(parsedUrl, { headers: { 'User-Agent': 'RisuBard-Updater' } }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                const redirectUrl = new URL(res.headers.location, parsedUrl).toString();
                return downloadToFile(redirectUrl, dest, redirectCount + 1).then(resolve, reject);
            }
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error(`HTTP ${res.statusCode}`));
            }

            const total = parseInt(res.headers['content-length'] || '0', 10);
            let downloaded = 0;
            let lastPct = '';
            const progress = new Transform({
                transform(chunk, encoding, callback) {
                    downloaded += chunk.length;
                    if (total > 0) {
                        const pct = ((downloaded / total) * 100).toFixed(1);
                        if (pct !== lastPct) {
                            lastPct = pct;
                            process.stdout.write(`\r[updater] Downloading... ${pct}%  `);
                        }
                    }
                    callback(null, chunk);
                },
            });

            pipeline(res, progress, fs.createWriteStream(dest), (err) => {
                process.stdout.write('\n');
                if (!err) return resolve();
                fs.rm(dest, { force: true }, () => reject(err));
            });
        }).on('error', reject);
    });
}

function extractArchive(archivePath, destinationPath) {
    const archiveName = path.basename(archivePath).toLowerCase();

    if (archiveName.endsWith('.zip')) {
        try {
            execFileSync(isWin ? 'tar.exe' : 'tar', [
                '-xf',
                archivePath,
                '-C',
                destinationPath,
            ], { stdio: 'inherit' });
            return;
        } catch (e) {
            if (!isWin) throw e;
            log('tar.exe extraction failed; falling back to PowerShell...');
            execFileSync('powershell.exe', [
                '-NoLogo',
                '-NoProfile',
                '-NonInteractive',
                '-Command',
                'Expand-Archive -LiteralPath $env:RISUBARD_ARCHIVE -DestinationPath $env:RISUBARD_DESTINATION -Force',
            ], {
                stdio: 'inherit',
                env: {
                    ...process.env,
                    RISUBARD_ARCHIVE: archivePath,
                    RISUBARD_DESTINATION: destinationPath,
                },
            });
            return;
        }
    }

    if (archiveName.endsWith('.tar.gz') || archiveName.endsWith('.tgz')) {
        execFileSync(isWin ? 'tar.exe' : 'tar', [
            '-xzf',
            archivePath,
            '-C',
            destinationPath,
        ], { stdio: 'inherit' });
        return;
    }

    throw new Error(`Unsupported archive format: ${path.basename(archivePath)}`);
}

function getPlatformSuffix() {
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    if (isWin) return `win-${arch}`;
    if (process.platform === 'darwin') return `macos-${arch}`;
    return `linux-${arch}`;
}

function resolveExtractedRoot(extractedDir) {
    const entries = fs.readdirSync(extractedDir, { withFileTypes: true });
    if (entries.length === 1 && entries[0].isDirectory()) {
        return path.join(extractedDir, entries[0].name);
    }
    return extractedDir;
}

function validateExtractedRoot(extractedRoot) {
    for (const entry of REQUIRED_ENTRIES) {
        if (!fs.existsSync(path.join(extractedRoot, entry))) {
            throw new Error(`Downloaded package is missing required entry: ${entry}`);
        }
    }
    if (isWin) {
        for (const entry of REQUIRED_WIN_ENTRIES) {
            if (!fs.existsSync(path.join(extractedRoot, entry))) {
                throw new Error(`Downloaded Windows package is missing required entry: ${entry}`);
            }
        }
    }
    for (const file of REQUIRED_DIST_FILES) {
        if (!fs.existsSync(path.join(extractedRoot, 'dist', file))) {
            throw new Error(`Downloaded package is missing dist/${file}`);
        }
    }
}

function restoreBackupIntoRoot(backupDir, overwrite = true) {
    if (!fs.existsSync(backupDir)) return;
    for (const entry of fs.readdirSync(backupDir)) {
        const src = path.join(backupDir, entry);
        const dest = path.join(ROOT, entry);
        try {
            if (overwrite && fs.existsSync(dest)) {
                fs.rmSync(dest, { recursive: true, force: true });
            }
            if (!fs.existsSync(dest)) {
                fs.renameSync(src, dest);
            }
        } catch { /* best effort */ }
    }
}

function listFilesRecursive(dir, baseDir = dir, files = []) {
    if (!fs.existsSync(dir)) return files;

    function walk(currentDir) {
        for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
            const fullPath = path.join(currentDir, entry.name);
            if (entry.isDirectory()) {
                walk(fullPath);
                continue;
            }
            if (entry.isFile()) {
                files.push(path.relative(baseDir, fullPath));
            }
        }
    }

    walk(dir);
    files.sort();
    return files;
}

function hashFile(filePath) {
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    const fd = fs.openSync(filePath, 'r');

    try {
        let bytesRead;
        do {
            bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
            if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
        } while (bytesRead > 0);
    } finally {
        fs.closeSync(fd);
    }

    return hash.digest('hex');
}

function areDirectoriesEquivalent(a, b) {
    const filesA = listFilesRecursive(a);
    const filesB = listFilesRecursive(b);
    if (filesA.length !== filesB.length) return false;

    for (let i = 0; i < filesA.length; i += 1) {
        if (filesA[i] !== filesB[i]) return false;
        const left = path.join(a, filesA[i]);
        const right = path.join(b, filesB[i]);
        const leftStat = fs.statSync(left);
        const rightStat = fs.statSync(right);
        if (leftStat.size !== rightStat.size) return false;
        if (hashFile(left) !== hashFile(right)) return false;
    }

    return true;
}

function findPortableAsset(release, suffix) {
    const expectedExtension = isWin ? '.zip' : '.tar.gz';
    const expectedEnding = `-${suffix}${expectedExtension}`.toLowerCase();
    return (release.assets || []).find((asset) => (
        typeof asset.name === 'string'
        && typeof asset.browser_download_url === 'string'
        && asset.name.toLowerCase().endsWith(expectedEnding)
    ));
}

async function main() {
    const current = getCurrentVersion();
    log(`Current version: ${current}`);
    log('Checking for updates...');

    const data = await httpsGet(`https://api.github.com/repos/${REPO}/releases/latest`);
    const release = JSON.parse(data.toString());
    const latest = release.tag_name;

    if (!latest) error('Could not determine latest version.');

    if (current === latest) {
        log(`Already up to date (${current}).`);
        return;
    }

    log(`New version available: ${latest}`);

    const suffix = getPlatformSuffix();
    const asset = findPortableAsset(release, suffix);
    if (!asset) {
        error(`No portable package found for ${suffix}. Download manually from:\n  ${release.html_url}`);
    }

    const tmpDir = path.join(ROOT, '.update-tmp');
    if (fs.existsSync(tmpDir)) {
        const prevBackup = path.join(tmpDir, 'backup');
        if (fs.existsSync(prevBackup)) {
            log('Restoring files from previous interrupted update...');
            restoreBackupIntoRoot(prevBackup, true);
        }
        fs.rmSync(tmpDir, { recursive: true });
    }
    fs.mkdirSync(tmpDir, { recursive: true });

    const downloadPath = path.join(tmpDir, asset.name);
    log(`Downloading ${asset.name}...`);
    await downloadToFile(asset.browser_download_url, downloadPath);

    log('Extracting...');
    const extractedPath = path.join(tmpDir, 'extracted');
    fs.mkdirSync(extractedPath, { recursive: true });
    extractArchive(downloadPath, extractedPath);

    const extractedDir = path.join(tmpDir, 'extracted');
    const extractedRoot = resolveExtractedRoot(extractedDir);
    validateExtractedRoot(extractedRoot);
    const currentBin = path.join(ROOT, 'bin');
    const newBin = path.join(extractedRoot, 'bin');
    const skipBinReplacement = fs.existsSync(currentBin)
        && fs.existsSync(newBin)
        && areDirectoriesEquivalent(currentBin, newBin);
    if (skipBinReplacement) {
        log('Bundled Node unchanged; skipping bin/ replacement.');
    }

    // Phase 1: move old files to backup (safer than immediate delete)
    log('Replacing files...');
    const keep = new Set(['save', 'backups', '.installed-version', '.update-tmp', 'scripts', '.env', '.npmrc', '.portable']);
    if (isWin || skipBinReplacement) keep.add('bin');
    const customBackupKeep = getCustomBackupKeepEntry();
    if (customBackupKeep && !keep.has(customBackupKeep)) {
        log(`Preserving custom backup directory: ${customBackupKeep}/`);
        keep.add(customBackupKeep);
    }
    const backupDir = path.join(tmpDir, 'backup');
    fs.mkdirSync(backupDir, { recursive: true });

    for (const entry of fs.readdirSync(ROOT)) {
        if (keep.has(entry)) continue;
        try {
            fs.renameSync(path.join(ROOT, entry), path.join(backupDir, entry));
        } catch (e) {
            log(`Error backing up ${entry}: ${e.message}`);
            log('Restoring files already moved to backup...');
            restoreBackupIntoRoot(backupDir, true);
            error(isWin
                ? 'Update failed because some files are in use. Close the running RisuBard window/console first, then run update.bat again.'
                : 'Update failed because some files are in use. Stop the running server first, then try again.');
        }
    }

    // Phase 2: move new files from extracted to root
    const moved = [];
    const skipMove = new Set(['save', 'scripts']);
    if (isWin || skipBinReplacement) skipMove.add('bin');
    try {
        for (const entry of fs.readdirSync(extractedRoot)) {
            if (skipMove.has(entry)) continue;
            const src = path.join(extractedRoot, entry);
            const dest = path.join(ROOT, entry);
            if (fs.existsSync(dest)) {
                fs.rmSync(dest, { recursive: true, force: true });
            }
            fs.renameSync(src, dest);
            moved.push(entry);
        }
        for (const entry of REQUIRED_ENTRIES) {
            if (!moved.includes(entry) && !fs.existsSync(path.join(ROOT, entry))) {
                throw new Error(`Required entry was not installed: ${entry}`);
            }
        }
        for (const file of REQUIRED_DIST_FILES) {
            if (!fs.existsSync(path.join(ROOT, 'dist', file))) {
                throw new Error(`Required file was not installed: dist/${file}`);
            }
        }
    } catch (e) {
        // Restore from backup on failure
        log(`Error moving files: ${e.message}`);
        log('Restoring from backup...');
        restoreBackupIntoRoot(backupDir, true);
        error('Update failed, previous version restored. Please try again.');
    }

    // Phase 3: update scripts/ from new release
    const newScripts = path.join(extractedRoot, 'scripts');
    if (fs.existsSync(newScripts)) {
        if (!fs.existsSync(path.join(ROOT, 'scripts'))) {
            fs.mkdirSync(path.join(ROOT, 'scripts'));
        }
        for (const f of fs.readdirSync(newScripts)) {
            fs.copyFileSync(path.join(newScripts, f), path.join(ROOT, 'scripts', f));
        }
    }

    // Phase 4 (Windows): stage bin/ update for update.bat post-step
    if (isWin) {
        if (!fs.existsSync(newBin)) {
            error('Downloaded Windows package is missing bin/. Update aborted before version finalize.');
        }
        const stagedBin = path.join(tmpDir, 'new-bin');
        const skipBinUpdate = path.join(tmpDir, 'skip-bin-update');
        try { fs.rmSync(stagedBin, { recursive: true, force: true }); } catch { /* noop */ }
        try { fs.rmSync(skipBinUpdate, { force: true }); } catch { /* noop */ }
        if (skipBinReplacement) {
            fs.writeFileSync(skipBinUpdate, 'same');
        } else {
            fs.cpSync(newBin, stagedBin, { recursive: true });
            log('Staged bundled Node update (will be applied after updater exits).');
        }
    }

    // Write version marker after all file replacement is truly complete.
    // On Windows, update.bat finalizes this after bin/ replacement succeeds.
    if (isWin) {
        fs.writeFileSync(path.join(tmpDir, 'latest-version'), latest);
        log('Staged version marker update for post-step finalize.');
    } else {
        fs.writeFileSync(path.join(ROOT, '.installed-version'), latest);
    }

    // Cleanup
    if (isWin) {
        log('Leaving .update-tmp for update.bat post-step cleanup.');
    } else {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); }
        catch { log('Warning: could not remove .update-tmp, you can delete it manually.'); }
    }

    log(`Update complete! ${current} → ${latest}`);
    log('');
    if (isWin) {
        log('Restart by running RisuBard.exe');
    } else {
        log('Restart by running ./start.sh');
    }
}

main().catch((e) => error(e.message));
