import { afterEach, expect, test, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'

const { inventory, recoverSwap } = require('./v2-migration-gate.cjs')
const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })) })
function fixture() {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-volume-')); roots.push(parent)
    const root = path.join(parent, 'save'); fs.mkdirSync(root)
    const id = crypto.randomUUID(), control = path.join(root, '.risubard-v2-migration')
    return { root, parent, id, control, backup: path.join(control, 'backups', `save.v1-${id}`) }
}

test('migrates inside a mounted save root and keeps the complete original on that volume', () => {
    const { root, parent, backup } = fixture()
    const { createFileKv } = require('./file-kv.cjs'), { encodeRisuSaveLegacy } = require('./utils.cjs')
    createFileKv({ dataRoot: root }).kvSet('database/database.bin', Buffer.from(encodeRisuSaveLegacy({
        characters: [{ chaId: 'a', name: 'Alice', chats: [{ id: 'chat', name: 'Chat', message: [{ role: 'user', data: 'Keep this message' }] }] }],
        modules: [], personas: [], botPresets: [], loreBook: [],
    })))
    fs.mkdirSync(path.join(root, 'trash')); fs.writeFileSync(path.join(root, 'trash/old.txt'), 'old recovery data')
    const before = inventory(root, true), inode = fs.statSync(root).ino
    const script = `const fs = require('fs'), root = process.argv[1], rename = fs.renameSync;
        fs.renameSync = (from, to) => { if (from === root) throw Object.assign(Error('mount is busy'), {code:'EBUSY'}); return rename(from,to) };
        require('./server/node/v2-migration-worker.cjs').migrate(root, process.argv[2]).catch(e => {console.error(e);process.exitCode=1})`
    execFileSync(process.execPath, ['-e', script, root, backup], { stdio: 'pipe' })
    expect(fs.statSync(root).ino).toBe(inode)
    expect(inventory(backup, true)).toEqual(before)
    expect(fs.existsSync(path.join(root, 'settings/native-runtime.json'))).toBe(true)
    expect(fs.readdirSync(parent)).toEqual(['save'])
    const data = require('./user-data-repository.cjs').createUserDataRepository({ dataRoot: root }).exportLegacyDatabase()
    expect(data.characters[0].chats[0].message[0].data).toBe('Keep this message')
})

test.each([1, 2, 3, 4, 5, 6])('startup rolls back a volume swap interrupted after move %s without deleting either copy', cut => {
    const { root, backup } = fixture()
    fs.mkdirSync(path.join(root, 'kv')); fs.writeFileSync(path.join(root, 'kv/old.bin'), 'old database')
    fs.writeFileSync(path.join(root, 'old.txt'), 'original text')
    fs.mkdirSync(path.join(root, 'trash')); fs.writeFileSync(path.join(root, 'trash/recovery.txt'), 'original recovery')
    const before = inventory(root, true)
    const volume = require('./v2-migration-volume.cjs')
    const control = volume.prepareVolume(root)
    const stage = fs.mkdtempSync(path.join(control, 'save.v2-stage-')) + '-output'; fs.mkdirSync(stage)
    fs.mkdirSync(path.join(stage, 'kv')); fs.writeFileSync(path.join(stage, 'kv/new.bin'), 'converted database')
    fs.mkdirSync(path.join(stage, 'settings')); fs.writeFileSync(path.join(stage, 'settings/layout.json'), '{"schemaVersion":2}')
    fs.writeFileSync(path.join(stage, 'new.txt'), 'new text')
    const converted = inventory(stage, true), rename = fs.renameSync
    let moved = 0
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
        rename(from, to)
        if ([root, stage].includes(path.dirname(String(from))) && ++moved === cut) throw Error('simulated process termination')
    })
    expect(() => volume.publishVolume(root, stage, backup)).toThrow('simulated process termination')
    vi.restoreAllMocks()
    recoverSwap(root)
    expect(inventory(root, true)).toEqual(before)
    expect(inventory(stage, true)).toEqual(converted)
    expect(() => recoverSwap(root)).not.toThrow()
})

test('volume recovery rejects a journal pointing outside the mounted save', () => {
    const { root, parent, backup } = fixture()
    const { prepareVolume } = require('./v2-migration-volume.cjs')
    const control = prepareVolume(root), outside = path.join(parent, 'outside.txt')
    fs.writeFileSync(outside, 'untouched')
    fs.writeFileSync(path.join(control, 'swap.json'), JSON.stringify({ root, backup, stage: parent,
        oldEntries: ['../outside.txt'], newEntries: [] }))
    expect(() => recoverSwap(root)).toThrow()
    expect(fs.readFileSync(outside, 'utf8')).toBe('untouched')
})

test('startup cannot recover while a migration worker owns the volume lock, even in the same process', () => {
    const { root } = fixture()
    const volume = require('./v2-migration-volume.cjs')
    const lock = volume.acquireVolumeLock(root)
    try {
        expect(() => recoverSwap(root)).toThrow('다른 이관 작업')
        expect(() => volume.acquireVolumeLock(root)).toThrow('다른 이관 작업')
        expect(() => volume.recoverVolume(root, lock.token)).not.toThrow()
    } finally { lock.release() }
    expect(() => recoverSwap(root)).not.toThrow()
})

test('a reused Linux PID with a different start identity does not retain ownership', () => {
    const { isLockOwnerAlive } = require('./v2-migration-volume.cjs')
    const owner = { pid: 17, identity: 'previous-boot:1234' }
    expect(isLockOwnerAlive(owner, () => 'current-boot:4567', () => true)).toBe(false)
    expect(isLockOwnerAlive(owner, () => owner.identity, () => true)).toBe(true)
    // If the platform cannot read start identity, preserve the conservative live-PID check.
    expect(isLockOwnerAlive(owner, () => null, () => true)).toBe(true)
})

test('a crash before the first control marker rename does not prevent startup recovery', () => {
    const { root, control } = fixture()
    fs.mkdirSync(control)
    fs.writeFileSync(path.join(control, `.format.json.${crypto.randomUUID()}.tmp`), '{"schemaVersion":1}')
    expect(() => recoverSwap(root)).not.toThrow()
    expect(() => require('./v2-migration-volume.cjs').prepareVolume(root)).not.toThrow()
    expect(JSON.parse(fs.readFileSync(path.join(control, 'format.json'), 'utf8')).schemaVersion).toBe(1)
})

test('interrupted lock publication leaves a retryable temporary owner record', () => {
    const { root } = fixture()
    const volume = require('./v2-migration-volume.cjs'), control = volume.prepareVolume(root)
    fs.writeFileSync(path.join(control, `.migration-lock-${crypto.randomUUID()}.tmp`), '{"pid":123}')
    const lock = volume.acquireVolumeLock(root)
    expect(() => volume.recoverVolume(root, lock.token)).not.toThrow()
    lock.release()
})

test('two startups cannot both acquire when one pauses before deleting a stale lock', () => {
    const { root } = fixture(), volume = require('./v2-migration-volume.cjs'), control = volume.prepareVolume(root)
    const deadPid = Number(execFileSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' }).trim())
    const lockPath = path.join(control, 'migration.lock')
    fs.writeFileSync(lockPath, JSON.stringify({ pid: deadPid, identity: null, token: crypto.randomUUID() }))
    const unlink = fs.unlinkSync
    let attempted = false, secondAcquired = false
    vi.spyOn(fs, 'unlinkSync').mockImplementation(file => {
        if (file === lockPath && !attempted) {
            attempted = true
            try { volume.acquireVolumeLock(root); secondAcquired = true } catch { /* another live claimant must block it */ }
        }
        unlink(file)
    })
    const first = volume.acquireVolumeLock(root)
    try { expect(attempted).toBe(true); expect(secondAcquired).toBe(false) }
    finally { vi.restoreAllMocks(); first.release() }
})
