/**
 * 百炼(Qwen-TTS)批量配音 —— 把导出的语音清单逐行合成成 OGG,落到一个**投放目录**。
 *
 * 它**不写项目**:产物落进 `--out`,再由 `galfree_voice_batch(action:"import", drop_dir:…)`
 * 经**写网关**收进 `game/voice/`(ADR-0003/0004:项目文件的一切写走网关)。
 *
 * ## 为什么必须转成 .ogg
 *
 * 模板写死 `define config.auto_voice = "voice/{id}.ogg"`,而引擎那条路是
 * `renpy.loadable(fn, directory="audio")` → `transfn()` → **精确路径的 isfile**
 * (实测 SDK:`renpy/loader.py` 的 `loadable` / `loadable_core`,与
 * `renpy/common/00voice.rpy:372`)。所以后缀**必须**对上,mp3/wav 找不着。
 * 百炼回的是 wav,于是这里叫 ffmpeg 转 ogg(vorbis)。
 *
 * ## 用法
 *
 *   node --experimental-strip-types scripts/tts-bailian.mjs \
 *     --project D:/GALGAME/before_the_rain \
 *     --characters su_qing,xia_wan \
 *     --out .scratch/voice-out
 *
 * 密钥:环境变量 `DASHSCOPE_API_KEY`,否则读 `~/.dsh/.credentials.yaml` 的 `QWEN_API_KEY`。
 *
 * ## 音色 id 从哪来
 *
 * 插件登记簿的 `voiceProfile` 是 **IndexTTS 形状**的(`sample` = 服务端音色库文件名),
 * **没有"云端 voice_id"这个字段** —— 所以本脚本从 `voiceProfile.note` 里按
 * `voice_id <id>` 取。这算一个真实的建模缺口,见文件尾的"已知"。
 *
 * 可重入:已经存在的产物会跳过(中断了直接再跑)。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { readRpyFiles } from '../src/service/rpy/files.ts'
import { parseRpy, deriveGraph } from '../src/service/rpy/parse.ts'
import { dialogueRowsOf } from '../src/service/dialogue-id.ts'

const MODEL = 'qwen3-tts-vd-2026-01-26'
const ENDPOINT = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation'
const CONCURRENCY = 3
const MAX_ATTEMPTS = 4

// ── 参数 ────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}
const projectRoot = resolve(argOf('project', process.cwd()))
const wanted = argOf('characters', 'su_qing,xia_wan').split(',').map((s) => s.trim()).filter((s) => s !== '')
const outDir = resolve(argOf('out', '.scratch/voice-out'))
const dryRun = argv.includes('--dry-run')

// ── 密钥 ────────────────────────────────────────────────────────────
let KEY = process.env.DASHSCOPE_API_KEY ?? ''
if (KEY === '') {
  const cred = join(homedir(), '.dsh', '.credentials.yaml')
  if (existsSync(cred)) {
    for (const line of readFileSync(cred, 'utf8').split('\n')) {
      const m = /^\s*QWEN_API_KEY\s*:\s*(.+?)\s*$/.exec(line)
      if (m) { KEY = m[1].replace(/^["']|["']$/g, ''); break }
    }
  }
}
if (KEY === '' && !dryRun) { console.error('没有密钥:设 DASHSCOPE_API_KEY,或在 ~/.dsh/.credentials.yaml 里配 QWEN_API_KEY'); process.exit(1) }

// ── 音色 id:从登记簿的 voiceProfile.note 里取 ──────────────────────
const charactersFile = join(projectRoot, '.studio', 'characters.json')
if (!existsSync(charactersFile)) { console.error('找不到', charactersFile); process.exit(1) }
const registry = JSON.parse(readFileSync(charactersFile, 'utf8'))
const voiceIdOf = new Map()
for (const c of registry.characters ?? []) {
  const note = c.voiceProfile?.note ?? ''
  const m = /voice_id\s+([A-Za-z0-9_-]+)/.exec(note)
  if (m) voiceIdOf.set(c.id, m[1])
}

// ── 清单:用插件自己的解析器(与 voiceBatch 逐字一致)──────────────
const files = await readRpyFiles(join(projectRoot, 'game'))
const graph = deriveGraph(parseRpy(files))
const rows = dialogueRowsOf(graph.scenes)
const targets = rows.filter((r) => r.speaker !== null && wanted.includes(r.speaker))

console.log(`项目:${projectRoot}`)
console.log(`角色:${wanted.join(', ')}`)
console.log(`清单:${targets.length} 行 / ${targets.reduce((n, r) => n + r.text.length, 0)} 字符`)
for (const who of wanted) {
  const id = voiceIdOf.get(who)
  const n = targets.filter((r) => r.speaker === who).length
  console.log(`  ${who.padEnd(10)} ${String(n).padStart(4)} 行  音色 ${id ?? '✗ 登记簿里没有 voice_id'}`)
}

const missingIds = wanted.filter((w) => !voiceIdOf.has(w))
if (missingIds.length > 0) {
  console.error(`\n这些角色在登记簿的 voiceProfile.note 里找不到 voice_id:${missingIds.join(', ')}`)
  console.error('(插件登记簿没有"云端 voice_id"字段 —— 见本文件尾的"已知")')
  process.exit(1)
}
if (dryRun) { console.log('\n--dry-run:只列清单,不合成'); process.exit(0) }

// ── 合成 ────────────────────────────────────────────────────────────
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function synthesize(voiceId, text) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let res
    try {
      res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: MODEL, input: { text, voice: voiceId } }),
      })
    } catch (error) {
      if (attempt === MAX_ATTEMPTS) throw error
      await sleep(500 * attempt); continue
    }
    if (res.status === 200) {
      const parsed = await res.json()
      const url = parsed?.output?.audio?.url
      if (typeof url !== 'string') throw new Error(`响应里没有 audio.url:${JSON.stringify(parsed).slice(0, 160)}`)
      const audio = await fetch(url)
      return Buffer.from(await audio.arrayBuffer())
    }
    // 限流 / 服务端抖动:退避重试
    if (res.status === 429 || res.status >= 500) {
      await sleep(1000 * attempt); continue
    }
    throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`)
  }
  throw new Error('重试次数用尽')
}

function toOgg(wavBytes, outPath) {
  return new Promise((resolvePromise, reject) => {
    const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', 'pipe:0', '-c:a', 'libvorbis', '-q:a', '4', '-f', 'ogg', outPath], { stdio: ['pipe', 'ignore', 'pipe'] })
    let err = ''
    ff.stderr.on('data', (c) => { err += c.toString() })
    ff.on('error', reject)
    ff.on('close', (code) => code === 0 ? resolvePromise() : reject(new Error(`ffmpeg 退出 ${code}: ${err.slice(0, 200)}`)))
    ff.stdin.end(wavBytes)
  })
}

let done = 0, skipped = 0, failed = 0
const failures = []
const started = Date.now()

async function handle(row) {
  const outPath = join(outDir, `${row.dialogueId}.ogg`)
  if (existsSync(outPath)) { skipped += 1; return }
  try {
    const wav = await synthesize(voiceIdOf.get(row.speaker), row.text)
    await toOgg(wav, outPath)
    done += 1
  } catch (error) {
    failed += 1
    failures.push({ id: row.dialogueId, speaker: row.speaker, error: String(error).slice(0, 200) })
  }
  const seen = done + skipped + failed
  if (seen % 25 === 0) {
    const rate = seen / ((Date.now() - started) / 1000)
    console.log(`  进度 ${seen}/${targets.length}  成功 ${done} 跳过 ${skipped} 失败 ${failed}  (${rate.toFixed(1)}/秒)`)
  }
}

// 简单的并发池
const queue = [...targets]
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (queue.length > 0) {
    const row = queue.shift()
    if (row === undefined) break
    await handle(row)
  }
}))

console.log('')
console.log(`完成:成功 ${done} · 跳过(已存在)${skipped} · 失败 ${failed} · 共 ${targets.length}`)
console.log(`产物目录:${outDir}`)
if (failures.length > 0) {
  console.log('\n失败明细(前 10 条):')
  for (const f of failures.slice(0, 10)) console.log(`  ${f.id} (${f.speaker}) ${f.error}`)
}
console.log('\n下一步:galfree_voice_batch action:"import" drop_dir:"' + outDir + '"')
console.log('(经写网关收进 game/voice/,并逐条报"收进来的/缺的/重复的/对不上 id 的")')

/**
 * ## 已知(值得单独一票)
 *
 * 1. **登记簿没有"云端 voice_id"字段**。`voiceProfile` 是 IndexTTS 形状:
 *    `sample`(服务端音色库文件名)+ `speaker`(LoRA 名)+ `emotion`。
 *    换成任何一家云端 TTS,它要的是一个 **voice_id**,现在只能塞在 `note` 里让脚本正则取。
 *    要正经支持云端,`voiceProfile` 得能表达"这一条档案属于哪条渠道、它的 id 是什么"。
 * 2. 这条路**绕开了插件的音频适配器**(ADAPTERS 里只有 IndexTTS 形状的 `sync-http`)——
 *    走的是"批量清单"那条通用路。要不要给插件加一个 OpenAI 兼容 / 百炼适配器,是 #37 的范围。
 * 3. **没有做响度归一化**:各家 TTS 的默认音量不一致,跨角色听起来可能一大一小。
 *    真听出问题的话,在 ffmpeg 那一步加 `loudnorm` 即可。
 */
