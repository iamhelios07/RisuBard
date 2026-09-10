import { afterEach, expect, test, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'

const { beforeStartup, inventory } = require('./v2-migration-gate.cjs')
const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })) })

function fixture(missing = false) {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-startup-')); roots.push(parent)
    const root = path.join(parent, 'save')
    const { createFileKv } = require('./file-kv.cjs')
    const { encodeRisuSaveLegacy } = require('./utils.cjs')
    const store = createFileKv({ dataRoot: root })
    store.kvSet('database/database.bin', Buffer.from(encodeRisuSaveLegacy({
        characters: [{ chaId: 'a', name: 'Alice', image: 'assets/picture', chats: [] }],
        modules: [], personas: [], botPresets: [], loreBook: [],
    })))
    if (!missing) store.kvSet('assets/picture', Buffer.from('picture bytes'))
    return { root, parent }
}

async function startGate(root: string, options: Record<string, unknown> = {}) {
    let listening!: (value: { port: number, token: string }) => void
    const ready = new Promise<{ port: number, token: string }>(resolve => { listening = resolve })
    const run = beforeStartup({ root, port: 0, ...options, onListening: (port: number, token: string) => listening({ port, token }) })
    const { port, token } = await Promise.race([ready, run.then(() => { throw Error('Gate exited before listening') })])
    const url = `http://127.0.0.1:${port}`, headers = { 'x-migration-token': token }
    return { url, token, headers, run,
        status: async () => (await fetch(url + '/status', { headers })).json(),
        async settle() {
            for (let attempt = 0; attempt < 150; attempt++) {
                const state = await this.status()
                if (state.phase !== 'checking') return state
                await new Promise(resolve => setTimeout(resolve, 20))
            }
            throw Error('Inspection did not finish')
        },
        async close() { await this.settle(); await fetch(url + '/exit', { method: 'POST', headers }); await run },
    }
}

test('old updater sees the installed version while migration awaits consent without gaining storage access', async () => {
    const { root } = fixture(), before = inventory(root, true)
    const gate = await startGate(root)
    try {
        const response = await fetch(gate.url + '/api/update-check?lang=ko')
        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({ currentVersion: require('../../package.json').version,
            hasUpdate: false, canSelfUpdate: false, migrationRequired: true })
        expect((await fetch(gate.url + '/api/native/catalog')).status).toBe(403)
        expect((await fetch(gate.url + '/start', { method: 'POST' })).status).toBe(403)
        expect(inventory(root, true)).toEqual(before)
    } finally { await gate.close() }
})

test.each([false, true])('a second startup preserves a live sibling journal (old volume control: %s)', oldControl => {
    const { root, parent } = fixture(), before = inventory(root, true)
    const id = '11111111-1111-4111-8111-111111111111'
    const backup = path.join(parent, 'backups', `save.v1-${id}`)
    const stage = `${root}.v2-stage-interrupted-output`, journal = `${root}.v2-swap.json`
    fs.mkdirSync(stage)
    fs.writeFileSync(`${root}.v2-lock`, String(process.pid))
    fs.writeFileSync(journal, JSON.stringify({ root, backup, stage, id }))
    if (oldControl) require('./v2-migration-volume.cjs').prepareVolume(root)
    const { recoverSwap } = require('./v2-migration-gate.cjs')
    expect(() => recoverSwap(root)).toThrow('다른 이관 작업')
    expect(fs.existsSync(journal)).toBe(true)
    expect(inventory(root, true)).toEqual(before)
    fs.mkdirSync(path.dirname(backup))
    fs.renameSync(root, backup)
    fs.unlinkSync(`${root}.v2-lock`)
    recoverSwap(root)
    expect(inventory(root, true)).toEqual(before)
    expect(fs.existsSync(journal)).toBe(false)
})

test('an already migrated standalone save does not require writing its parent directory', async () => {
    const { root } = fixture()
    fs.mkdirSync(path.join(root, 'settings'))
    fs.writeFileSync(path.join(root, 'settings/layout.json'), '{"schemaVersion":2}')
    const open = fs.openSync
    vi.spyOn(fs, 'openSync').mockImplementation((file, flags, mode) => {
        if (path.dirname(String(file)) === path.dirname(root) && flags !== 'r') throw Object.assign(Error('Parent is read only'), { code: 'EACCES' })
        return open(file, flags, mode)
    })
    expect(await beforeStartup({ root })).toBe(true)
})

test('a missing image leaves an error page and local backup available instead of terminating startup', async () => {
    const { root, parent } = fixture(true), before = inventory(root, true)
    const gate = await startGate(root)
    try {
        const state = await gate.settle()
        expect(state).toMatchObject({ phase: 'failed', sourcePath: root })
        expect(state.error).toContain('Missing referenced asset')
        expect((await fetch(gate.url)).status).toBe(200)
        expect((await fetch(gate.url + '/start', { method: 'POST', headers: gate.headers })).status).toBe(409)
        const backup = await fetch(gate.url + '/backup', { method: 'POST',
            headers: { ...gate.headers, 'content-type': 'application/json' }, body: JSON.stringify({ directory: parent }) })
        expect(backup.status).toBe(200)
        for (let attempt = 0; attempt < 150; attempt++) {
            const current = await gate.status()
            if (current.phase === 'failed') {
                expect(current.localBackup?.path).toBeTruthy()
                expect(fs.existsSync(current.localBackup.path)).toBe(true)
                break
            }
            if (attempt === 149) throw Error('Backup did not finish')
            await new Promise(resolve => setTimeout(resolve, 20))
        }
        expect(inventory(root, true)).toEqual(before)
    } finally { await gate.close() }
})

test('slow inspection does not hide the migration page or the old updater restart probe', async () => {
    const { root } = fixture()
    let release!: (value: unknown) => void
    const inspection = new Promise(resolve => { release = resolve })
    // Start on an assigned port even while the worker has not returned a plan.
    const probe = http.createServer()
    await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve))
    const port = (probe.address() as import('node:net').AddressInfo).port
    await new Promise<void>(resolve => probe.close(() => resolve()))
    const started = startGate(root, { port, inspect: () => inspection })
    let response: Response | undefined
    try {
        for (let attempt = 0; attempt < 20; attempt++) {
            response = await fetch(`http://127.0.0.1:${port}/api/update-check`).catch(() => undefined)
            if (response) break
            await new Promise(resolve => setTimeout(resolve, 20))
        }
        expect(response?.status).toBe(200)
    } finally {
        release({ sourcePath: root, enoughSpace: true, requiredBytes: 0, availableBytes: 1 })
        await (await started).close()
    }
})

test('an unreadable layout displays the startup error without opening storage or exiting the server', async () => {
    const { root } = fixture()
    fs.mkdirSync(path.join(root, 'settings'))
    fs.writeFileSync(path.join(root, 'settings/layout.json'), 'invalid json')
    const before = inventory(root, true), gate = await startGate(root)
    try {
        const state = await gate.settle()
        expect(state.phase).toBe('failed')
        expect(state.error).toBeTruthy()
        expect((await fetch(gate.url)).status).toBe(200)
        expect(inventory(root, true)).toEqual(before)
    } finally { await gate.close() }
})

test('network migration requires the secret from the server console and protects status and writes', async () => {
    const { root } = fixture(), listen = vi.spyOn(http.Server.prototype, 'listen')
    const gate = await startGate(root, { host: '0.0.0.0' })
    try {
        expect(listen.mock.calls.some(args => args[1] === '0.0.0.0')).toBe(true)
        // Docker/reverse-proxy requests carry a non-loopback Host even when this test connects locally.
        const remote = (route: string, headers = {}, method = 'GET') => new Promise<{ status: number, headers: http.IncomingHttpHeaders }>((resolve, reject) => {
            const request = http.request(gate.url + route, { method, headers: { host: 'server.example:7777', ...headers } }, response => {
                response.resume(); response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers }))
            }); request.on('error', reject); request.end()
        })
        expect((await remote('/')).status).toBe(403)
        expect((await remote('/?migration-token=wrong')).status).toBe(403)
        const page = await remote('/?migration-token=' + gate.token)
        expect(page.status).toBe(200)
        expect(page.headers['referrer-policy']).toBe('no-referrer')
        expect((await remote('/status')).status).toBe(403)
        expect((await remote('/status', gate.headers)).status).toBe(200)
        expect((await remote('/start', {}, 'POST')).status).toBe(403)
    } finally { await gate.close() }
})
