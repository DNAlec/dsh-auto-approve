import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import * as mod from '../src/index.mjs'
import { NAME } from '../src/util.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

describe('plugin exports', () => {
  it('命名导出 name/inject/apply，没有 default', () => {
    assert.equal(mod.name, '@dnalec/dsh-auto-approve')
    assert.deepEqual(mod.inject, ['approval', 'permissionPresets', 'llm', 'timer', 'webServer'])
    assert.equal(typeof mod.apply, 'function')
    assert.equal('default' in mod, false)
  })

  it('四同步：package.json / patch / NAME / client load id', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    const yml = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
    const client = readFileSync(join(root, 'client.js'), 'utf8')
    assert.equal(pkg.name, NAME)
    assert.equal(mod.name, NAME)
    assert.ok(yml.includes("name: '" + NAME + "'"))
    assert.ok(client.includes("id: '" + NAME + "'"))
    assert.ok(client.includes("exports.name = '" + NAME + "'"))
  })

  it('RPC 路径 host fetch.register 与 client rpc.call 一致', () => {
    const host = readFileSync(join(root, 'src/index.mjs'), 'utf8')
    const client = readFileSync(join(root, 'client.js'), 'utf8')
    assert.ok(host.includes("path: '/api/dsh-auto-approve'"))
    assert.ok(client.includes("rpc.call('/api', 'dsh-auto-approve'"))
  })

  it('session cwd 读 header.cwd；RPC 失败带 message', () => {
    assert.equal(mod.readSessionCwd({ id: 's', header: { cwd: '/tmp/ws' } }), '/tmp/ws')
    assert.equal(mod.readSessionCwd({ id: 's', cwd: '/wrong' }), '')
    assert.equal(mod.readSessionCwd(null), '')
    const fail = mod.rpcFail('err.needSessionId')
    assert.equal(fail.ok, false)
    assert.equal(fail.error.code, 'err.needSessionId')
    assert.equal(fail.error.message, 'err.needSessionId')
    assert.deepEqual(fail.error.details, {})
  })

})
