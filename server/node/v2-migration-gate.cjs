'use strict';

// Runs before db.cjs: inspecting consent must never open a mutable KV store.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { fork } = require('child_process');
const { resolveDataRoot } = require('./data-root.cjs');
const volume = require('./v2-migration-volume.cjs');

function needsMigration(root) {
    if (!fs.existsSync(root)) return false;
    if (fs.existsSync(path.join(root, 'settings/layout.json'))) {
        const layout = JSON.parse(fs.readFileSync(path.join(root, 'settings/layout.json'), 'utf8'));
        if (layout.schemaVersion === 2) return false;
        throw new Error('지원하지 않는 저장소 레이아웃입니다. 자동 이관을 중단했습니다.');
    }
    return ['risuai.db', 'kv/manifest.json', 'index/sidebar.json', 'settings/app.json'].some(p => fs.existsSync(path.join(root, p)))
        || fs.readdirSync(root).some(name => /^[a-fA-F0-9]+$/.test(name) && name.length % 2 === 0);
}

function inventory(root, hashes = false, options = {}) {
    const entries = [];
    function visit(relative) {
        if (!options.includeMigrationControl && relative === volume.CONTROL_DIRECTORY && volume.hasVolumeControl(root)) return;
        const file = path.join(root, relative), stat = fs.lstatSync(file);
        if (stat.isSymbolicLink()) throw new Error('이관 경로에 링크가 있습니다. 실제 저장 폴더를 사용하세요.');
        if (stat.isDirectory()) {
            entries.push([relative, 'directory']);
            for (const name of fs.readdirSync(file).sort()) visit(path.join(relative, name));
        } else if (stat.isFile()) {
            let hash;
            if (hashes) {
                const digest = crypto.createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024);
                const fd = fs.openSync(file, 'r');
                try { let n; while ((n = fs.readSync(fd, buffer, 0, buffer.length, null))) digest.update(buffer.subarray(0, n)); }
                finally { fs.closeSync(fd); }
                hash = digest.digest('hex');
            }
            entries.push([relative, stat.size, stat.mtimeMs, hash]);
        } else throw new Error('Unsupported migration source file');
    }
    visit('');
    return entries;
}

async function inspect(root, backupPath, statfs = fs.statfsSync) {
    // Isolate decoder dependency initialization until consent is granted.
    const plan = await new Promise((resolve, reject) => {
        const child = fork(path.join(__dirname, 'v2-migration-worker.cjs'), [root, backupPath, '--inspect'], {
            stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true,
        });
        let result, failure;
        child.stderr.on('data', () => {});
        child.on('message', message => { if (message.error) failure = message.error; if (message.inspection) result = message.inspection; });
        child.once('error', reject);
        child.once('exit', code => code === 0 && result ? resolve(result) : reject(new Error(failure || 'Migration planning failed')));
    });
    const stats = statfs(volume.isVolumeBackup(root, backupPath) ? root : path.dirname(root));
    const availableBytes = Number(stats.bavail) * Number(stats.bsize);
    return { sourcePath: root, backupPath, ...plan, availableBytes, enoughSpace: availableBytes >= plan.requiredBytes };
}

function swapPaths(root) {
    return { parent: path.dirname(root), journal: `${root}.v2-swap.json` };
}

function recoverSwap(root) {
    volume.recoverVolume(root);
    const { parent, journal } = swapPaths(root);
    if (!fs.existsSync(journal)) return;
    const state = JSON.parse(fs.readFileSync(journal, 'utf8'));
    if (state.root !== root || !/^[a-f0-9-]{36}$/.test(state.id)
        || state.backup !== path.join(parent, 'backups', `${path.basename(root)}.v1-${state.id}`)
        || path.dirname(state.stage) !== parent || !path.basename(state.stage).startsWith(`${path.basename(root)}.v2-stage-`)) {
        throw new Error('Invalid V2 recovery journal; original data was not changed');
    }
    if (!fs.existsSync(root)) {
        if (!fs.existsSync(state.backup)) throw new Error('V2 recovery source missing');
        fs.renameSync(state.backup, root);
    }
    fs.unlinkSync(journal);
}

function launchWorker(root, backup, update) {
    return new Promise((resolve, reject) => {
        const child = fork(path.join(__dirname, 'v2-migration-worker.cjs'), [root, backup], {
            stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true,
        });
        let failure = '';
        child.stderr.on('data', () => {});
        child.on('message', message => {
            if (message.error) failure = message.error;
            else if (message.phase) update(message.phase);
        });
        child.once('error', reject);
        child.once('exit', code => code === 0 ? resolve() : reject(new Error(failure || `Migration worker failed (${code})`)));
    });
}

async function beforeStartup(options = {}) {
    const root = path.resolve(options.root || resolveDataRoot());
    let startupError;
    try { recoverSwap(root); if (!needsMigration(root)) return true; }
    catch (error) { startupError = error; }
    const id = crypto.randomUUID();
    const backup = process.env.RISUBARD_MIGRATION_IN_PLACE === '1'
        ? volume.volumeBackup(root, id)
        : path.join(path.dirname(root), 'backups', `${path.basename(root)}.v1-${id}`);
    const token = crypto.randomBytes(32).toString('hex');
    const host = options.host || process.env.RISUBARD_MIGRATION_HOST || '127.0.0.1';
    const networkGate = !['127.0.0.1', '::1', 'localhost'].includes(host);
    const state = { phase: 'checking', sourcePath: root, backupPath: backup, enoughSpace: false };
    state.localBackupDirectory = volume.isVolumeBackup(root, backup) ? '' : path.dirname(root);
    const sslRoot = path.join(process.cwd(), 'server/node/ssl/certificate');
    state.protocol = fs.existsSync(path.join(sslRoot, 'server.key')) && fs.existsSync(path.join(sslRoot, 'server.crt')) ? 'https:' : 'http:';
    return new Promise((resolve, reject) => {
        const handleRequest = async (req, res) => {
            res.setHeader('Cache-Control', 'no-store');
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.setHeader('Referrer-Policy', 'no-referrer');
            let requestUrl;
            try { requestUrl = new URL(req.url, 'http://localhost'); }
            catch { res.writeHead(400); res.end(); return; }
            const localRequest = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)
                && /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(req.headers.host || '');
            const authorized = req.headers['x-migration-token'] === token;
            const openWithToken = req.method === 'GET' && requestUrl.pathname === '/'
                && requestUrl.searchParams.get('migration-token') === token;
            // Network access is opt-in (Docker enables it). The console secret
            // is required to open the page remotely; status and writes always
            // require its header. A hostile Host cannot bypass the local gate.
            if (!localRequest && !(networkGate && (authorized || openWithToken))) {
                res.writeHead(403); res.end('Open the migration URL printed in the server console. For Docker, replace localhost with the Docker host address.'); return;
            }
            if (req.method === 'GET' && requestUrl.pathname === '/api/update-check') {
                // v0.9.25 polls this endpoint after swapping app files. It must
                // be able to finish and reload into consent, even during a slow
                // inspection. This response grants no access to the save.
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
                res.end(JSON.stringify({ currentVersion: require('../../package.json').version,
                    hasUpdate: false, severity: 'none', canSelfUpdate: false, migrationRequired: true })); return;
            }
            if (req.method === 'GET' && requestUrl.pathname === '/') {
                res.setHeader('Content-Type', 'text/html; charset=utf-8');
                res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'nonce-" + token + "'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'");
                res.end(fs.readFileSync(path.join(__dirname, 'v2-migration.html'), 'utf8').replaceAll('__TOKEN__', token)); return;
            }
            if (!authorized) { res.writeHead(403); res.end(); return; }
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            if (req.method === 'GET' && req.url === '/status') { res.end(JSON.stringify(state)); return; }
            if (req.method === 'POST' && req.url === '/backup' && ['ready', 'failed'].includes(state.phase)) {
                const resumePhase = state.phase;
                state.phase = 'backup';
                state.localBackupError = null;
                state.localBackupProgress = null;
                try {
                    const chunks = []; let length = 0;
                    for await (const chunk of req) {
                        length += chunk.length;
                        if (length > 8192) throw new Error('백업 경로 요청이 너무 깁니다.');
                        chunks.push(chunk);
                    }
                    const { directory } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                    require('./v2-local-backup.cjs').backupDestination(root, directory);
                    state.localBackupDirectory = directory.trim();
                    res.end('{}');
                    const child = fork(path.join(__dirname, 'v2-local-backup.cjs'), [root, directory], {
                        stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true,
                    });
                    let result, failure;
                    child.stderr.on('data', () => {});
                    child.on('message', message => {
                        if (message.progress) state.localBackupProgress = message.progress;
                        if (message.result) result = message.result;
                        if (message.error) failure = message.error;
                    });
                    const finish = error => {
                        if (!error && result) state.localBackup = result;
                        else state.localBackupError = error || failure || '백업 생성에 실패했습니다.';
                        try {
                            const stats = fs.statfsSync(volume.isVolumeBackup(root, backup) ? root : path.dirname(root));
                            state.availableBytes = Number(stats.bavail) * Number(stats.bsize);
                            state.enoughSpace = state.availableBytes >= state.requiredBytes;
                        } catch { state.enoughSpace = false; }
                        state.phase = resumePhase;
                    };
                    child.once('error', error => { failure = error.message; });
                    child.once('close', code => finish(code === 0 ? null : failure || '백업 생성에 실패했습니다.'));
                } catch (error) {
                    state.phase = resumePhase; state.localBackupError = error.message;
                    if (!res.writableEnded) { res.writeHead(400); res.end(JSON.stringify({ error: error.message })); }
                }
                return;
            }
            if (req.method === 'POST' && req.url === '/exit' && ['ready', 'failed'].includes(state.phase)) {
                state.phase = 'stopped';
                res.once('finish', () => {
                    server.close(() => resolve(false));
                    server.closeAllConnections();
                });
                res.end('{}'); return;
            }
            if (req.method === 'POST' && req.url === '/start' && state.phase === 'ready') {
                state.phase = 'checking';
                try { Object.assign(state, await (options.inspect || inspect)(root, backup)); }
                catch (error) { state.phase = 'failed'; state.error = error.message; res.writeHead(400); res.end(JSON.stringify({ error: error.message })); return; }
                if (!state.enoughSpace) { state.phase = 'ready'; res.writeHead(507); res.end(JSON.stringify(state)); return; }
                state.phase = 'copy'; res.end('{}');
                (options.worker || launchWorker)(root, backup, phase => { state.phase = phase; }).then(() => {
                    state.phase = 'complete';
                    // Give the page one polling cycle to see completion before
                    // releasing the port to the full application.
                    setTimeout(() => {
                        server.close(() => resolve(true));
                        // Browsers can hold speculative/preconnected sockets
                        // open indefinitely; they must not block app startup.
                        server.closeAllConnections();
                    }, 1500);
                }).catch(error => { state.phase = 'failed'; state.error = error.message; });
                return;
            }
            res.writeHead(409); res.end('{}');
        };
        const server = state.protocol === 'https:'
            ? https.createServer({ key: fs.readFileSync(path.join(sslRoot, 'server.key')), cert: fs.readFileSync(path.join(sslRoot, 'server.crt')) }, handleRequest)
            : http.createServer(handleRequest);
        server.on('error', reject);
        server.listen(options.port ?? Number(process.env.PORT || 7777), host, () => {
            const url = `${state.protocol}//localhost:${server.address().port}/${networkGate ? '?migration-token=' + token : ''}`;
            console.log(`[Server] Preparing V2 migration: ${url}`);
            console.log(`[Server] Original save will be preserved at: ${backup}`);
            if (process.env.OPEN_BROWSER === '1') require('./open-server-browser.cjs').openServerBrowser(url);
            Promise.resolve().then(() => {
                if (startupError) throw startupError;
                return (options.inspect || inspect)(root, backup);
            }).then(info => {
                Object.assign(state, info, { phase: 'ready' });
            }).catch(error => {
                state.phase = 'failed'; state.error = error.message;
                console.error('[V2 migration] Inspection failed:', error.message);
            }).finally(() => {
                console.log(`[Server] V2 migration consent required: ${url}`);
                options.onListening?.(server.address().port, token);
            });
        });
    });
}

module.exports = { beforeStartup, needsMigration, inventory, inspect, recoverSwap };
