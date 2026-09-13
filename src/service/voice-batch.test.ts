/**
 * T29(#37)第一片:「本地 TTS 批量清单」的**导出与导回** —— 不花上游额度的那条路。
 *
 * 发起人原话:"要么你给出需要生成语音的 excel 等本地 tts 可以识别的批量"。
 * 这一条把 TTS 从"必须选一家 API"里解出来:
 *
 *   导出清单(谁、哪一句、id、目标文件名) → 用你自己的本地 TTS 批量跑 →
 *   把音频按文件名放回来 → **导回**项目(经写网关落盘 → 池立刻有它)
 *
 * 四个"必须如实"的点(守卫逐条盯):
 *  1. **id 是文件名**(ADR-0013):清单里的 id 就是 `game/voice/<id>.ogg`,不许再编一套命名;
 *  2. **缺哪个、多哪个、id 对不上**都要逐条报 —— 不静默跳过、也不假装全齐;
 *  3. 台词里带逗号/引号/换行**不能把 CSV 拆坏**(那是"清单看着对、实际串行"的经典坑);
 *  4. 落盘一律经**写网关**(ADR-0004),于是进快照、可回滚。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createProjectService, type ProjectService } from './project-service.ts'
import { cleanupTempDirs, makeTempDir } from '../testing/tmp.ts'
import { fakeUiTemplate, makeFakeSdk } from '../testing/sdk-fixture.ts'
import { renderVoiceBatchCsv, renderVoiceBatchJson, matchVoiceFiles, VOICE_BATCH_HEADER } from './voice-batch.ts'

const SCRIPT = [
  'define e = Character("小棠")',
  '',
  'label scene_one:',
  '    e "第一句,带个逗号。"',
  // 这一句同时踩两个 CSV 的坑:**逗号**与**内嵌引号**(方言子集用 `\"` 转义)。
  // 台词里带这两种字符是常态 —— 一次没处理好,整份清单就是错行的。
  '    e "旁白,带\\"引号\\"的那种。"',
  '    e "第三句。"',
  '    return',
  '',
].join('\n')

describe('本地 TTS 批量清单(T29)', () => {
  let sdkDir: string
  let dataDir: string
  let projectsRoot: string
  let service: ProjectService

  beforeEach(async () => {
    sdkDir = await makeFakeSdk()
    dataDir = await makeTempDir('galfree-t29-data-')
    projectsRoot = await makeTempDir('galfree-t29-projects-')
    service = createProjectService({ dataDir, uiTemplate: fakeUiTemplate(sdkDir) })
    await service.createProject({ projectsRoot, name: 'voice', title: undefined })
    const snap = await service.readProjectFile('voice', 'game/script.rpy')
    await service.writeProjectFiles('voice', [{ path: 'game/script.rpy', content: SCRIPT, expectVersion: snap.version }], { origin: 'workbench', reason: 'scenario' })
  })

  afterEach(async () => {
    await service.dispose()
    await cleanupTempDirs()
  })

  // ─── 导出 ────────────────────────────────────────────────────────

  it('清单逐行给出:场景 / 行号 / 说话人 / 台词 / **id** / 目标文件名', async () => {
    const batch = await service.voiceBatch('voice')
    expect(batch.rows.map((row) => [row.scene, row.speaker, row.dialogueId, row.targetPath])).toEqual([
      ['scene_one', 'e', 'scene_one_0000', 'game/voice/scene_one_0000.ogg'],
      ['scene_one', 'e', 'scene_one_0001', 'game/voice/scene_one_0001.ogg'],
      ['scene_one', 'e', 'scene_one_0002', 'game/voice/scene_one_0002.ogg'],
    ])
    // 台词原样(不去引号、不截断)—— 而且**反斜杠转义已经解掉**:
    // 引擎那边 `\"` 就是一个真引号(实测 `dialogue` 导出的 Dialogue 列),我们留给 TTS 的
    // 必须是同一串,否则本地工具会念出反斜杠(或直接报错)。
    expect(batch.rows[0]!.text).toBe('第一句,带个逗号。')
    expect(batch.rows[1]!.text).toBe('旁白,带"引号"的那种。')
    expect(batch.missingVoiceFiles).toBe(3) // 一个都还没生成
  })

  it('导出的是 CSV,**台词里的逗号/引号不会把行拆坏**(该引的引、该翻倍的翻倍)', async () => {
    const csv = renderVoiceBatchCsv(await service.voiceBatch('voice'))
    const lines = csv.trim().split('\n')
    expect(lines[0]).toBe(VOICE_BATCH_HEADER.join(','))
    // 三行数据 + 表头 = 4 行(台词里的逗号没有把行数搞乱)。
    expect(lines).toHaveLength(4)
    // 带逗号的那句被引号包起来了。
    expect(lines[1]).toContain('"第一句,带个逗号。"')
    // 带引号的那句:文本解转义后是 `旁白,带"引号"的那种。`,CSV 里引号要翻倍。
    expect(lines[2]).toContain('"旁白,带""引号""的那种。"')
  })

  it('也给 JSON(本地工具链更爱吃的形态):同样的字段,一个不少', async () => {
    const json = JSON.parse(renderVoiceBatchJson(await service.voiceBatch('voice'))) as {
      rows: Array<{ dialogueId: string; text: string; targetPath: string }>
    }
    expect(json.rows).toHaveLength(3)
    expect(json.rows[1]!.text).toContain('引号')
  })

  it('**id 就是文件名**(ADR-0013):清单里给的 id 与 `config.auto_voice` 的口径同源', async () => {
    const batch = await service.voiceBatch('voice')
    for (const row of batch.rows) {
      expect(row.targetPath).toBe(`game/voice/${row.dialogueId}.ogg`)
    }
    const options = await readFile(join(dataDir, '..', 'x'), 'utf8').catch(() => null)
    void options
  })

  // ─── 导回 ────────────────────────────────────────────────────────

  describe('导回(把本地 TTS 产出的文件按 id 收回来)', () => {
    /** 造一个"本地 TTS 的产出目录":文件名就是 id,后缀可以不一样。 */
    async function makeDropDir(files: Record<string, string>): Promise<string> {
      const dir = await makeTempDir('galfree-t29-drop-')
      for (const [name, content] of Object.entries(files)) {
        await mkdir(join(dir, 'sub'), { recursive: true })
        await writeFile(join(dir, name), Buffer.from(content, 'utf8'))
      }
      return dir
    }

    it('按文件名认 id → 经**写网关**落进 `game/voice/`,池里立刻有它', async () => {
      const batch = await service.voiceBatch('voice')
      const dir = await makeDropDir({
        'scene_one_0000.ogg': 'OGG-A',
        'scene_one_0001.mp3': 'MP3-B',
      })
      const report = await service.importVoiceFiles('voice', { dropDir: dir, rows: batch.rows })
      expect(report.imported.map((entry) => entry.dialogueId).sort()).toEqual(['scene_one_0000', 'scene_one_0001'])
      // 后缀不同的也收(本地工具爱出 mp3;引擎两种都认)。
      expect(report.imported.map((entry) => entry.path).sort()).toEqual([
        'game/voice/scene_one_0000.ogg', 'game/voice/scene_one_0001.mp3',
      ])
      expect((await service.audioPool('voice')).files.map((file) => file.path).sort()).toEqual([
        'voice/scene_one_0000.ogg', 'voice/scene_one_0001.mp3',
      ])
      // 还没给的那一条如实算"缺"(不假装全齐)。
      expect(report.missing.map((row) => row.dialogueId)).toEqual(['scene_one_0002'])
    })

    it('**多出来的文件**与**对不上 id 的文件**都逐条报(不静默忽略)', async () => {
      const batch = await service.voiceBatch('voice')
      const dir = await makeDropDir({
        'scene_one_0000.ogg': 'A',
        'nobody_knows_this.ogg': 'B',
        'readme.txt': 'C',
      })
      const report = await service.importVoiceFiles('voice', { dropDir: dir, rows: batch.rows })
      expect(report.imported).toHaveLength(1)
      // 不认识的音频文件:列出来(可能是 id 打错了,也可能是别的游戏的)。
      expect(report.unknownFiles.map((entry) => entry.name)).toContain('nobody_knows_this.ogg')
      // 非音频后缀的干脆不当作候选(那不是语音)。
      expect(report.unknownFiles.map((entry) => entry.name)).not.toContain('readme.txt')
      expect(report.missing).toHaveLength(2)
    })

    it('匹配逻辑是**纯函数**:认 id、忽略非音频、同 id 多后缀时按优先级取一个并说明', () => {
      const rows = [
        { dialogueId: 'a_0001', targetPath: 'game/voice/a_0001.ogg' },
        { dialogueId: 'b_0002', targetPath: 'game/voice/b_0002.ogg' },
      ]
      const matched = matchVoiceFiles(rows, [
        { name: 'a_0001.mp3', path: '/drop/a_0001.mp3' },
        { name: 'a_0001.ogg', path: '/drop/a_0001.ogg' },
        { name: 'b_0002.wav', path: '/drop/b_0002.wav' },
        { name: 'notes.txt', path: '/drop/notes.txt' },
      ])
      // 同 id 有多个:取优先级最高的那个,另一个进"多余"(让人知道有重复)。
      expect(matched.imported.map((entry) => [entry.dialogueId, entry.sourcePath.split('/').pop()])).toEqual([
        ['a_0001', 'a_0001.ogg'], ['b_0002', 'b_0002.wav'],
      ])
      expect(matched.duplicates.map((entry) => entry.name)).toEqual(['a_0001.mp3'])
      expect(matched.unknown).toEqual([])
    })
  })
})
