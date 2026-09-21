/**
 * 市场条目自检:复刻 awesome-dsh-plugin 的 CI 会看的东西 + dsh-market 的
 * `installTargetFor()` 判定,在本地先把结论摆出来(别等 PR 的 CI 告诉你)。
 *
 * 用法:node scripts/check-market-entry.mjs market/netori__galfree.yml
 */
import { readFileSync } from 'node:fs'
import yaml from 'js-yaml'

const file = process.argv[2] ?? 'market/netori__galfree.yml'
const entry = yaml.load(readFileSync(file, 'utf8'))
const fails = []
const notes = []

// ── 1. 形状:contributing.md 的字段要求 ────────────────────────────────
if (typeof entry.url !== 'string') fails.push('缺 url')
if (typeof entry.name !== 'string') fails.push('缺 name')
if (typeof entry.description?.en !== 'string') fails.push('缺 description.en(唯一必填项)')
if (typeof entry.category !== 'string') fails.push('缺 category')
if (entry.npm !== undefined) fails.push('写了 npm: 字段 —— contributing 明确说这个字段会被校验拒绝(映射从 registry 自动采集)')

// 描述只说功能、以句号结尾
if (!/\.$/.test(entry.description?.en ?? '')) notes.push('description.en 建议以句号结尾')
if (!/。$/.test(entry.description?.zh ?? '')) notes.push('description.zh 建议以句号结尾')

// ── 2. url 与 name 必须一致(repo 完全一致)───────────────────────────
const src = /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\/tree\/[^/]+\/(.+?))?\/?$/.exec(entry.url ?? '')
if (src === null) fails.push(`url 不是 github 仓库地址:${entry.url}`)
else if (entry.name !== src[1]) fails.push(`name(${entry.name})与 url 的 ${src[1]} 不一致`)

// ── 3. tarball 字段:dsh-market 的 releaseTarballTarget() 判定 ─────────
let target
if (src === null) {
  target = null
} else if (entry.tarball === undefined) {
  target = src[2] === null ? `github:${src[1]}` : `github:${src[1]}#path:/${src[2]}`
  notes.push('没有 tarball:字段 —— 市场会退回从源码装(那条路要过 pnpm 的 allowBuilds 构建授权)')
} else {
  let u
  try { u = new URL(String(entry.tarball)) } catch { u = null }
  const seg = u === null ? [] : u.pathname.split('/').filter(s => s !== '')
  const ok = u !== null
    && u.protocol === 'https:'
    && u.hostname === 'github.com'
    && (u.pathname.endsWith('.tgz') || u.pathname.endsWith('.tar.gz'))
    && seg.length >= 4 && seg[2] === 'releases'
    && `${seg[0]}/${seg[1]}`.toLowerCase() === src[1].toLowerCase()
  if (!ok) {
    fails.push(`tarball 不通过市场校验(必须 https + github.com + 同一 owner/repo + releases + .tgz):${entry.tarball}`)
    target = `github:${src[1]}`
  } else {
    target = String(entry.tarball)
    // latest/download 的腐烂陷阱:文件名带版本号 ⇒ 下次发版 404
    if (u.pathname.includes('/releases/latest/download/')) {
      const name = seg[seg.length - 1]
      if (/\d+\.\d+\.\d+/.test(name)) fails.push(`资产名带版本号(${name})而 URL 用的是 latest/download —— 下次发版会 404;改名或改成钉住 tag 的形式`)
      else notes.push('latest/download + 不带版本号的文件名:符合 contributing 的建议(不会腐烂)')
    }
  }
}

// ── 4. 包名(repo 名)与目录名规则:data/plugins/<owner>__<repo>.yml ────
if (src !== null) {
  const expected = `${src[1].replace('/', '__')}.yml`
  const actual = file.replace(/\\/g, '/').split('/').pop()
  if (actual !== expected) fails.push(`文件名应为 ${expected}(现在是 ${actual})`)
}

console.log(`条目:${file}`)
console.log(`市场会用它装:${target ?? '(无法判定)'}`)
for (const n of notes) console.log(`  · 提示:${n}`)
if (fails.length > 0) {
  for (const f of fails) console.error(`  ✗ ${f}`)
  process.exit(1)
}
console.log('  ✓ 形状与 tarball 判定都通过')
