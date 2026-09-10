'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { fsyncDirectory } = require('./file-store.cjs');

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

function readOwner(file) {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return typeof value === 'number' ? { pid: value } : value;
}

function acquireMigrationLock(lock, claimPrefix) {
    const directory = path.dirname(lock), token = crypto.randomUUID();
    const claim = path.join(directory, `${claimPrefix}${token}.json`), temp = `${claim}.tmp`;
    let kernelFd;
    if (process.platform === 'linux') {
        // Keep this inode permanently. The parent retains the same open file
        // description after flock exits; the kernel releases it on process death,
        // even when another container uses a different PID namespace.
        kernelFd = fs.openSync(`${lock}.flock`, 'a+', 0o600);
        const result = spawnSync('flock', ['-n', '3'], { stdio: ['ignore', 'ignore', 'pipe', kernelFd] });
        if (result.status !== 0) {
            fs.closeSync(kernelFd);
            if (result.status === 1) throw new Error('다른 이관 작업이 실행 중입니다.');
            throw new Error('안전한 이관 잠금을 확보할 수 없습니다. flock 실행 환경을 확인하세요.');
        }
    }
    let acquired = false;
    try {
        const fd = fs.openSync(temp, 'wx', 0o600);
        try {
            fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, identity: processIdentity(process.pid), token, kernelLocked: kernelFd !== undefined }));
            fs.fsyncSync(fd);
        } finally { fs.closeSync(fd); }
        try { fs.linkSync(temp, claim); } finally { fs.unlinkSync(temp); }
        const alive = owner => !(kernelFd !== undefined && owner.kernelLocked) && isLockOwnerAlive(owner);
        for (const name of fs.readdirSync(directory)) {
            if (!name.startsWith(claimPrefix) || !/^[a-f0-9-]{36}\.json$/.test(name.slice(claimPrefix.length)) || path.join(directory, name) === claim) continue;
            let owner;
            try { owner = readOwner(path.join(directory, name)); }
            catch (error) { if (error.code === 'ENOENT') continue; throw error; }
            if (alive(owner)) throw new Error('다른 이관 작업이 실행 중입니다.');
        }
        if (fs.existsSync(lock)) {
            if (alive(readOwner(lock))) throw new Error('다른 이관 작업이 실행 중입니다.');
            fs.unlinkSync(lock);
        }
        fs.linkSync(claim, lock); fsyncDirectory(directory);
        acquired = true;
        return { token, release() {
            try {
                if (readOwner(lock).token !== token) throw new Error('이관 잠금 소유자가 변경되었습니다.');
                fs.unlinkSync(lock); fs.unlinkSync(claim); fsyncDirectory(directory);
            } finally { if (kernelFd !== undefined) fs.closeSync(kernelFd); }
        } };
    } finally {
        if (!acquired) {
            if (fs.existsSync(claim)) fs.unlinkSync(claim);
            if (kernelFd !== undefined) fs.closeSync(kernelFd);
        }
    }
}

function acquireSiblingLock(root) {
    return acquireMigrationLock(`${root}.v2-lock`, `.${path.basename(root)}.v2-owner-`);
}

module.exports = { acquireMigrationLock, acquireSiblingLock, isLockOwnerAlive };
