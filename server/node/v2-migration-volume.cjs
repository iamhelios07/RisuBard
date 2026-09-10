'use strict';

// Mounted directories cannot be renamed. Keep the journal, converted tree and
// original entries on the same persistent volume, and recover before any store
// constructor sees a partially published tree.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { atomicWriteJson, fsyncDirectory } = require('./file-store.cjs');
const CONTROL_DIRECTORY = '.risubard-v2-migration';

function hasVolumeControl(root) {
    const control = path.join(root, CONTROL_DIRECTORY);
    if (!fs.existsSync(control)) return false;
    const stat = fs.lstatSync(control);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid V2 volume recovery directory');
    const marker = path.join(control, 'format.json');
    if (!fs.existsSync(marker) && fs.readdirSync(control).every(name => /^\.format\.json\.[a-f0-9-]{36}\.tmp$/.test(name))) return true;
    if (JSON.parse(fs.readFileSync(marker, 'utf8')).schemaVersion !== 1) throw new Error('Invalid V2 volume recovery format');
    return true;
}

function prepareVolume(root) {
    const control = path.join(root, CONTROL_DIRECTORY);
    if (!hasVolumeControl(root)) { fs.mkdirSync(control); fsyncDirectory(root); }
    if (!fs.existsSync(path.join(control, 'format.json'))) atomicWriteJson(control, 'format.json', { schemaVersion: 1 });
    return control;
}

function volumeBackup(root, id) {
    return path.join(root, CONTROL_DIRECTORY, 'backups', `${path.basename(root)}.v1-${id}`);
}

function isVolumeBackup(root, backup) {
    const id = path.basename(backup).slice(`${path.basename(root)}.v1-`.length);
    return /^[a-f0-9-]{36}$/.test(id) && backup === volumeBackup(root, id);
}

function processIdentity(pid) {
    if (process.platform !== 'linux') return null;
    try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        const start = stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/)[19];
        return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() + ':' + start;
    } catch { return null; }
}

function pidAlive(pid) {
    try { process.kill(pid, 0); return true; }
    catch (error) { return error.code !== 'ESRCH'; }
}

function isLockOwnerAlive(owner, identity = processIdentity, alive = pidAlive) {
    if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) throw new Error('이관 잠금 기록을 확인해야 합니다.');
    if (!alive(owner.pid)) return false;
    const current = identity(owner.pid);
    return !owner.identity || !current || owner.identity === current;
}

function acquireVolumeLock(root) {
    const control = prepareVolume(root), lock = path.join(control, 'migration.lock');
    const token = crypto.randomUUID(), temp = path.join(control, `.migration-lock-${token}.tmp`);
    const claim = path.join(control, `.migration-owner-${token}.json`);
    const fd = fs.openSync(temp, 'wx', 0o600);
    try {
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, identity: processIdentity(process.pid), token })); fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    try { fs.linkSync(temp, claim); } finally { fs.unlinkSync(temp); }
    let acquired = false;
    try {
        // Every contender publishes its own immutable claim BEFORE scanning.
        // With two overlapping claims at least one scan sees the other; it
        // withdraws without touching the shared lock. Thus a paused stale-lock
        // reclaimer cannot unlink a newer owner's record (the ABA problem).
        for (const name of fs.readdirSync(control)) {
            if (!/^\.migration-owner-[a-f0-9-]{36}\.json$/.test(name) || path.join(control, name) === claim) continue;
            let owner;
            try { owner = JSON.parse(fs.readFileSync(path.join(control, name), 'utf8')); }
            catch (error) { if (error.code === 'ENOENT') continue; throw error; }
            if (isLockOwnerAlive(owner)) throw new Error('다른 이관 작업이 실행 중입니다.');
        }
        if (fs.existsSync(lock)) {
            if (isLockOwnerAlive(JSON.parse(fs.readFileSync(lock, 'utf8')))) throw new Error('다른 이관 작업이 실행 중입니다.');
            fs.unlinkSync(lock);
        }
        // The claim is already complete and synced. Exclusive link publication
        // also protects against an older worker which has no claim protocol.
        fs.linkSync(claim, lock); fsyncDirectory(control);
        acquired = true;
        return { token, release() {
            if (JSON.parse(fs.readFileSync(lock, 'utf8')).token !== token) throw new Error('이관 잠금 소유자가 변경되었습니다.');
            fs.unlinkSync(lock); fs.unlinkSync(claim); fsyncDirectory(control);
        } };
    } finally { if (!acquired) fs.unlinkSync(claim); }
}

function validateSwap(root, state) {
    const control = path.join(root, CONTROL_DIRECTORY);
    const validNames = names => Array.isArray(names) && new Set(names).size === names.length
        && names.every(name => typeof name === 'string' && name !== '' && name !== '.' && name !== '..'
            && name !== CONTROL_DIRECTORY && !/[\\/\0:]/.test(name));
    if (state.root !== root || !isVolumeBackup(root, state.backup || '')
        || typeof state.stage !== 'string' || path.dirname(state.stage) !== control
        || !path.basename(state.stage).startsWith(`${path.basename(root)}.v2-stage-`)
        || !path.basename(state.stage).endsWith('-output')
        || !validNames(state.oldEntries) || !validNames(state.newEntries)) {
        throw new Error('Invalid V2 volume recovery journal; original data was not changed');
    }
    for (const directory of [control, path.dirname(state.backup), state.backup, state.stage]) {
        if (fs.existsSync(directory) && (!fs.lstatSync(directory).isDirectory() || fs.realpathSync(directory) !== directory)) {
            throw new Error('V2 volume recovery paths must be real directories');
        }
    }
}

function move(from, to) {
    fs.renameSync(from, to);
    fsyncDirectory(path.dirname(from));
    fsyncDirectory(path.dirname(to));
}

function recoverVolume(root, lockToken) {
    if (!hasVolumeControl(root)) return;
    const control = path.join(root, CONTROL_DIRECTORY), journal = path.join(control, 'swap.json');
    const lockPath = path.join(control, 'migration.lock');
    if (fs.existsSync(lockPath)) {
        const owner = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        if (lockToken && owner.token !== lockToken) throw new Error('이관 잠금 소유자가 변경되었습니다.');
        if (!lockToken && isLockOwnerAlive(owner)) throw new Error('다른 이관 작업이 실행 중입니다.');
    } else if (lockToken) throw new Error('이관 잠금이 해제되었습니다.');
    if (!fs.existsSync(journal)) return;
    if (!lockToken) {
        const lock = acquireVolumeLock(root);
        try { return recoverVolume(root, lock.token); } finally { lock.release(); }
    }
    const state = JSON.parse(fs.readFileSync(journal, 'utf8'));
    validateSwap(root, state);
    if (!fs.existsSync(state.stage)) throw new Error('V2 volume recovery stage is missing');
    // Move newly published entries back to staging; never delete either copy.
    // An entry still in staging was not published (or has already been restored).
    for (const entry of state.newEntries) {
        const staged = path.join(state.stage, entry), current = path.join(root, entry);
        if (!fs.existsSync(staged)) {
            if (!fs.existsSync(current)) throw new Error(`V2 volume recovery entry missing: ${entry}`);
            move(current, staged);
        }
    }
    for (const entry of state.oldEntries) {
        const original = path.join(state.backup, entry), current = path.join(root, entry);
        if (fs.existsSync(original)) {
            if (fs.existsSync(current)) throw new Error(`V2 volume recovery conflict: ${entry}`);
            move(original, current);
        } else if (!fs.existsSync(current)) throw new Error(`V2 original entry missing: ${entry}`);
    }
    fs.unlinkSync(journal); fsyncDirectory(control);
}

function publishVolume(root, stage, backup) {
    const control = prepareVolume(root), journal = path.join(control, 'swap.json');
    if (fs.existsSync(journal)) throw new Error('V2 volume recovery is required before another migration');
    const state = { root, stage, backup,
        oldEntries: fs.readdirSync(root).filter(name => name !== CONTROL_DIRECTORY),
        newEntries: fs.readdirSync(stage) };
    validateSwap(root, state);
    if (fs.existsSync(backup)) throw new Error('V2 original backup already exists');
    fs.mkdirSync(backup, { recursive: true }); fsyncDirectory(path.dirname(backup));
    atomicWriteJson(control, 'swap.json', state);
    for (const entry of state.oldEntries) move(path.join(root, entry), path.join(backup, entry));
    for (const entry of state.newEntries) move(path.join(stage, entry), path.join(root, entry));
    fs.unlinkSync(journal); fsyncDirectory(control);
}

module.exports = { CONTROL_DIRECTORY, hasVolumeControl, prepareVolume, volumeBackup, isVolumeBackup, publishVolume, recoverVolume, acquireVolumeLock, isLockOwnerAlive };
