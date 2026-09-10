const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function assertCleanPortable(root) {
    for (const name of ['save', 'backups', '.env', '.installed-version', '.update-tmp']) {
        if (fs.existsSync(path.join(root, name))) {
            throw new Error(`Portable package contains runtime state: ${name}`);
        }
    }
}

function prepareSmokeData(appRoot) {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'risubard-portable-smoke-'));
    const { createUserDataRepository } = require(path.join(appRoot, 'server/node/user-data-repository.cjs'));
    createUserDataRepository({ dataRoot, formatVersion: 2 }).importLegacyDatabase({ characters: [], personas: [], modules: [], botPresets: [], loreBook: [] }, { mode: 'replace' });
    const { createFileKv } = require(path.join(appRoot, 'server/node/file-kv.cjs'));
    createFileKv({ dataRoot }).kvSet('config/server-backup-path', Buffer.from(path.join(dataRoot, 'backups')));
    return dataRoot;
}

if (require.main === module) {
    const [command, root] = process.argv.slice(2);
    if (!root) throw new Error('Portable root is required');
    if (command === 'prepare-smoke') console.log(prepareSmokeData(path.resolve(root)));
    else if (command === 'verify') assertCleanPortable(path.resolve(root));
    else throw new Error('Unknown portable package command');
}

module.exports = { assertCleanPortable, prepareSmokeData };
