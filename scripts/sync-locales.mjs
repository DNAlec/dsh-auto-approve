#!/usr/bin/env node
/**
 * 把 locales.mjs 的 zh/en 同步进 client.js 的内联字典。
 *
 * 为什么需要它：client bundle 是浏览器直接加载的纯 JS，不能 import locales.mjs，
 * 所以运行期真正生效的是 client.js 里那两行 `JSON.parse(String.raw`…`)`。
 * locales.mjs 是唯一文案源；本脚本负责把它写进 client.js，避免「改了 locales 忘了 client」。
 *
 *   node scripts/sync-locales.mjs          # 校验（CI / npm run check 用，不同步就非零退出）
 *   node scripts/sync-locales.mjs --write  # 写入 client.js
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { zh, en } from '../locales.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const clientPath = join(root, 'client.js')
const write = process.argv.includes('--write')

/** JSON 里不能出现裸反引号或 `${`：client.js 用的是 String.raw 模板字面量。 */
function toTemplateJson(value) {
  const json = JSON.stringify(value)
  if (json.includes('`')) throw new Error('locales 文案含反引号，无法放进 String.raw 模板')
  if (json.includes('${')) throw new Error('locales 文案含 ${，无法放进 String.raw 模板')
  return json
}

const replacements = [
  { name: 'ZH', json: toTemplateJson(zh) },
  { name: 'EN', json: toTemplateJson(en) },
]

let src = readFileSync(clientPath, 'utf8')
let changed = false
for (const { name, json } of replacements) {
  const re = new RegExp('(const ' + name + ' = JSON\\.parse\\(String\\.raw`)([\\s\\S]*?)(`\\))')
  const hit = re.exec(src)
  if (!hit) throw new Error(`client.js 里找不到 ${name} 的 JSON.parse(String.raw...)`)
  if (hit[2] === json) continue
  changed = true
  src = src.replace(re, `$1${json}$3`)
}

if (!changed) {
  console.log('locales: client.js 内联字典已与 locales.mjs 一致')
  process.exit(0)
}
if (!write) {
  console.error('locales: client.js 内联字典与 locales.mjs 不一致；运行 `npm run locales:sync`')
  process.exit(1)
}
writeFileSync(clientPath, src, 'utf8')
console.log('locales: 已把 locales.mjs 写入 client.js')
