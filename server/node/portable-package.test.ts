import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, expect, test } from 'vitest'

const require = createRequire(import.meta.url)
const { assertCleanPortable, prepareSmokeData } = require('../../scripts/portable-package.cjs')
const roots: string[] = []
function root() { const p = mkdtempSync(join(tmpdir(), 'risubard-package-test-')); roots.push(p); return p }
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }) })

test.each(['save', 'backups', '.env', '.installed-version', '.update-tmp'])('rejects packaged runtime state: %s', name => {
    const p = root()
    writeFileSync(join(p, name), 'runtime state')
    expect(() => assertCleanPortable(p)).toThrow(name)
})

test('accepts program files and rejects an empty save directory', () => {
    const p = root()
    mkdirSync(join(p, 'server')); writeFileSync(join(p, 'package.json'), '{}')
    expect(() => assertCleanPortable(p)).not.toThrow()
    mkdirSync(join(p, 'save'))
    expect(() => assertCleanPortable(p)).toThrow('save')
})

test('smoke data and configured backups stay outside the package', () => {
    const data = prepareSmokeData(resolve('.')); roots.push(data)
    const { createFileKv } = require('./file-kv.cjs')
    const backup = createFileKv({ dataRoot: data }).kvGet('config/server-backup-path').toString()
    expect(backup).toBe(join(data, 'backups'))
    expect(existsSync(join(data, 'kv', 'manifest.json'))).toBe(true)
    expect(data.startsWith(resolve('.') + require('node:path').sep)).toBe(false)
    expect(require('./v2-migration-gate.cjs').needsMigration(data)).toBe(false)
})
