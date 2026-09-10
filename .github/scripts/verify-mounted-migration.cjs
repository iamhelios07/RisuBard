'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const fromApp = file => require(path.resolve('server/node', file));
const volume = fromApp('v2-migration-volume.cjs');
const root = '/app/save';
const mode = process.argv[2];
if (mode === 'hold-lock') {
    const lock = volume.acquireVolumeLock(root);
    fs.writeFileSync(path.join(root, 'lock-ready'), lock.token);
    setInterval(() => {}, 1000);
} else if (mode === 'contend') {
    assert.throws(() => volume.acquireVolumeLock(root), /다른 이관 작업/);
    console.log('Another PID namespace cannot acquire the live lock.');
} else if (mode === 'reacquire') {
    volume.acquireVolumeLock(root).release();
    console.log('Kernel released the crashed container lock.');
} else (async () => {
    assert.equal(process.env.RISUBARD_MIGRATION_HOST, '0.0.0.0');
    assert.equal(process.env.RISUBARD_MIGRATION_IN_PLACE, '1');
    const { createFileKv } = fromApp('file-kv.cjs');
    const { encodeRisuSaveLegacy } = fromApp('utils.cjs');
    const { inventory } = fromApp('v2-migration-gate.cjs');
    const store = createFileKv({ dataRoot: root });
    store.kvSet('assets/picture', Buffer.from('original image'));
    const database = { characters: [{ chaId: 'smoke', name: 'Smoke', image: 'assets/picture', chats: [
        { id: 'chat', name: 'Chat', message: [{ role: 'user', data: 'Keep this message' }] },
    ] }], modules: [], personas: [], botPresets: [], loreBook: [] };
    store.kvSet('database/database.bin', Buffer.from(encodeRisuSaveLegacy(database)));
    // Ensure the old compatibility projection does not override a newer V1 write.
    database.characters[0].chats[0].message.push({ role: 'user', data: 'Newest canonical message' });
    fromApp('user-data-repository.cjs').createUserDataRepository({ dataRoot: root }).importLegacyDatabase(database, { mode: 'sync' });
    fs.writeFileSync(path.join(root, '__password'), 'migration-validation');
    const before = inventory(root, true), inode = fs.statSync(root).ino;
    const backup = volume.volumeBackup(root, crypto.randomUUID());
    await fromApp('v2-migration-worker.cjs').migrate(root, backup);
    assert.equal(fs.statSync(root).ino, inode);
    assert.deepEqual(inventory(backup, true), before);
    const child = spawn(process.execPath, ['server/node/server.cjs'], {
        env: { ...process.env, RISUBARD_DATA_ROOT: root, PORT: '18727', OPEN_BROWSER: '0', RISU_UPDATE_CHECK: 'false' },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const url = 'http://127.0.0.1:18727';
    try {
        let ready = false;
        for (let n = 0; n < 300; n++) {
            if (child.exitCode !== null) throw new Error('Server exited: ' + output);
            try { if ((await fetch(url + '/api/test_auth')).ok) { ready = true; break; } } catch {}
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.ok(ready, output);
        const auth = await (await fetch(url + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'migration-validation' }) })).json();
        assert.equal(auth.status, 'success');
        const headers = { 'risu-auth': auth.token };
        const catalog = await (await fetch(url + '/api/native/catalog', { headers })).json();
        assert.equal(catalog.value.characters.length, 1);
        const query = new URLSearchParams({ kind: 'chat', id: 'chat', parentId: 'smoke' });
        const document = await (await fetch(url + '/api/native/document?' + query, { headers })).json();
        assert.deepEqual(document.value.message.map(message => message.data), ['Keep this message', 'Newest canonical message']);
        const repo = fromApp('user-data-repository.cjs').createUserDataRepository({ dataRoot: root, readOnly: true });
        const character = repo.exportLegacyDatabase().characters[0];
        assert.deepEqual(createFileKv({ dataRoot: root }).kvGet(character.image), Buffer.from('original image'));
        assert.deepEqual(inventory(backup, true), before);
        console.log('Mounted migration, original archive, assets, and restarted server API data verified.');
    } finally {
        child.kill();
        if (child.exitCode === null && child.signalCode === null) await new Promise(resolve => child.once('exit', resolve));
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
