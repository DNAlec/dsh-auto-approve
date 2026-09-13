import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import * as mod from '../src/index.mjs'
import { NAME, pathsFor, profilePatchFromBaseUrl, resolveProfilePatchPath } from '../src/util.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

describe('plugin exports', () => {
  it('命名导出 name/inject/apply，没有 default', () => {
    assert.equal(mod.name, '@dnalec/dsh-auto-approve')
    // 不含 webServer：它是 fiber 的必需服务，而 webserver 行只在 web-app bundle 里，
    // 放进来会让 headless / acp / sdk 组合连门控都不挂载。
    assert.deepEqual(mod.inject, ['approval', 'permissionPresets', 'llm', 'timer'])
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
    assert.equal(mod.readSessionCwd({ id: 's', header: { cwd: 'ws' } }), 'ws')
    assert.equal(mod.readSessionCwd({ id: 's', cwd: 'wrong' }), '')
    assert.equal(mod.readSessionCwd(null), '')
    const fail = mod.rpcFail('err.needSessionId')
    assert.equal(fail.ok, false)
    assert.equal(fail.error.code, 'err.needSessionId')
    assert.equal(fail.error.message, 'err.needSessionId')
    assert.deepEqual(fail.error.details, {})
  })

  it('profile patch 路径从 baseUrl 推导，拿不到才回落 profiles/web', () => {
    const home = join(root, 'tmp-home')
    const fallback = pathsFor(home).profilePatch
    assert.equal(fallback, join(home, 'profiles', 'web', 'cordis.patch.yml'))
    assert.equal(
      resolveProfilePatchPath({ baseUrl: 'file:///home/u/.dsh/profiles/dev/' }, {}, fallback),
      join('/home/u/.dsh/profiles/dev', 'cordis.patch.yml'),
    )
    assert.equal(
      resolveProfilePatchPath({ baseUrl: 'file:///home/u/.dsh/profiles/dev/cordis.yml' }, {}, fallback),
      join('/home/u/.dsh/profiles/dev', 'cordis.patch.yml'),
    )
    // 目录 URL 带 query/hash 时 pathname 仍以 / 结尾：不能多切一段
    assert.equal(
      resolveProfilePatchPath({ baseUrl: 'file:///home/u/.dsh/profiles/dev/?x=1' }, {}, fallback),
      join('/home/u/.dsh/profiles/dev', 'cordis.patch.yml'),
    )
    // 根目录 / 非 file: / 非法 URL 一律回落
    assert.equal(profilePatchFromBaseUrl('file:///'), '')
    assert.equal(profilePatchFromBaseUrl('https://x/y/'), '')
    assert.equal(profilePatchFromBaseUrl('file:///a/%2Fb/'), '')
    assert.equal(resolveProfilePatchPath({}, {}, fallback), fallback)
    assert.equal(
      resolveProfilePatchPath({ baseUrl: 'file:///x/y/' }, { profilePatch: '/explicit/cordis.patch.yml' }, fallback),
      '/explicit/cordis.patch.yml',
    )
  })

})
