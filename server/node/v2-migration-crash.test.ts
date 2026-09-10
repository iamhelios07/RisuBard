import { afterEach, expect, test } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'

const { inventory, recoverSwap, needsMigration } = require('./v2-migration-gate.cjs')
const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })))

test('switching to volume mode during sibling lock acquisition stops before conversion', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-lock-mode-')); roots.push(parent)
    const root = path.join(parent, 'save'); fs.mkdirSync(root)
    fs.writeFileSync(path.join(root, 'original.txt'), 'keep')
    const backup = path.join(parent, 'backups', `save.v1-${crypto.randomUUID()}`)
    const code = `const fs=require('fs'),root=process.argv[1],link=fs.linkSync;
        fs.linkSync=(from,to)=>{link(from,to);if(to===root+'.v2-lock')require('./server/node/v2-migration-volume.cjs').prepareVolume(root)};
        require('./server/node/v2-migration-worker.cjs').migrate(root,process.argv[2]).then(()=>{throw Error('Migration should stop')}).catch(e=>{
            if(!e.message.includes('볼륨 내부 이관')){console.error(e.message);process.exitCode=1}
        })`
    execFileSync(process.execPath, ['-e', code, root, backup], { stdio: 'pipe' })
    expect(fs.readFileSync(path.join(root, 'original.txt'), 'utf8')).toBe('keep')
    expect(fs.existsSync(backup)).toBe(false)
})

test.each(['converting', 'sibling-swap', 'volume-swap'])('real process termination during %s preserves the original and permits retry', async cut => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-killed-')); roots.push(parent)
    const root = path.join(parent, 'save')
    const store = require('./file-kv.cjs').createFileKv({ dataRoot: root })
    store.kvSet('database/database.bin', Buffer.from(require('./utils.cjs').encodeRisuSaveLegacy({
        characters: [{ chaId: 'a', name: 'Alice', chats: [{ id: 'chat', name: 'Chat', message: [{ role: 'user', data: 'Survive process death' }] }] }],
        modules: [], personas: [], botPresets: [], loreBook: [],
    })))
    fs.writeFileSync(path.join(root, 'original-extra.txt'), 'Preserve extra files too')
    const before = inventory(root, true)
    const volume = cut === 'volume-swap'
    const backup = volume ? require('./v2-migration-volume.cjs').volumeBackup(root, crypto.randomUUID())
        : path.join(parent, 'backups', `save.v1-${crypto.randomUUID()}`)
    const code = `const fs=require('fs'),path=require('path'),root=process.argv[1],backup=process.argv[2];
        const stop=()=>{process.stdout.write('CRASH_POINT\\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0)};
        const rename=fs.renameSync;
        fs.renameSync=(from,to)=>{const result=rename(from,to);
            if(${JSON.stringify(cut)}==='sibling-swap'&&from===root)stop();
            if(${JSON.stringify(cut)}==='volume-swap'&&path.dirname(String(from))===root&&path.dirname(String(to))===backup)stop();
            return result};
        require('./server/node/v2-migration-worker.cjs').migrate(root,backup,{onProgress(event){
            if(${JSON.stringify(cut)}==='converting'&&event.phase==='staging'&&event.current===2)stop()
        }}).catch(e=>{console.error(e);process.exitCode=1})`
    const child = spawn(process.execPath, ['-e', code, root, backup], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    try {
        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => reject(Error('Crash point not reached: ' + output)), 15000)
            child.stdout.on('data', chunk => { output += chunk; if (output.includes('CRASH_POINT')) { clearTimeout(timeout); resolve() } })
            child.stderr.on('data', chunk => { output += chunk })
            child.once('error', error => { clearTimeout(timeout); reject(error) })
            child.once('exit', () => { clearTimeout(timeout); reject(Error('Worker exited before termination: ' + output)) })
        })
        expect(() => recoverSwap(root)).toThrow('다른 이관 작업')
    } finally {
        child.kill('SIGKILL')
        if (child.exitCode === null && child.signalCode === null) await new Promise(resolve => child.once('exit', resolve))
    }
    recoverSwap(root)
    expect(inventory(root, true)).toEqual(before)
    expect(needsMigration(root)).toBe(true)
    const retryBackup = volume ? require('./v2-migration-volume.cjs').volumeBackup(root, crypto.randomUUID())
        : path.join(parent, 'backups', `save.v1-${crypto.randomUUID()}`)
    execFileSync(process.execPath, [path.resolve('server/node/v2-migration-worker.cjs'), root, retryBackup], { stdio: 'pipe' })
    expect(inventory(retryBackup, true)).toEqual(before)
    const result = require('./user-data-repository.cjs').createUserDataRepository({ dataRoot: root, readOnly: true }).exportLegacyDatabase()
    expect(result.characters[0].chats[0].message[0].data).toBe('Survive process death')
})
