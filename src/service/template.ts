/**
 * 项目模板(ADR-0005:v1 项目只从模板新建;ADR-0006:方言目标钉在环节零子集)。
 *
 * 模板 = 标准 Ren'Py 项目目录 + `.studio/` 契约骨架 + `.gitignore`。
 * 这里是纯数据:渲染不依赖任何上下文,便于接缝测试直接断言磁盘终态。
 */

/** slug 校验:文件系统安全、跨平台可携带;拒绝路径注入与空格/非 ASCII。 */
export const PROJECT_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

export interface TemplateProject {
  name: string
  title: string
  /** 注册表项目 id(写进 .studio/project.json,保证单一真相)。 */
  id: string
}

export interface TemplateFile {
  /** POSIX 相对路径(项目根为界)。 */
  path: string
  content: string
}

/** 模板需要创建的空目录(以 .gitkeep 入 git)。 */
export const TEMPLATE_EMPTY_DIRS = ['game/images', 'game/audio', 'game/fonts', 'game/tl', '.studio/bible', '.studio/tmp'] as const

/** 双引号转义(Ren'Py 字符串字面量)。 */
function rpyEscape(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

export function renderTemplateFiles(project: TemplateProject): TemplateFile[] {
  const { name, title } = project
  return [
    {
      path: 'game/script.rpy',
      content: [
        `# ${title} —— GALFree 模板剧本(方言子集)`,
        '#',
        '# 本文件是叙述与分支结构的唯一真相(ADR-0009)。',
        '# 语法限定在环节零方言子集内:见 docs/contracts/dialect-subset.md。',
        '',
        'label start:',
        '    "从这里开始你的故事。"',
        '    menu:',
        '        "继续":',
        '            jump prologue',
        '        "先到这里":',
        '            return',
        '',
        'label prologue:',
        '    "序章位置:由 agent 逐场生成后覆盖本文件的正文。"',
        '    return',
        '',
      ].join('\n'),
    },
    {
      path: 'game/options.rpy',
      content: [
        `# ${title} —— 项目配置`,
        '',
        `define config.name = _("${rpyEscape(name)}")`,
        `define config.title = _("${rpyEscape(title)}")`,
        'define config.version = "0.1.0"',
        `define config.save_directory = "galfree-${rpyEscape(name)}"`,
        'define config.has_sound = true',
        'define config.has_music = true',
        '',
      ].join('\n'),
    },
    {
      path: '.gitignore',
      content: [
        "# Ren'Py 运行噪声与产物:不进快照(环节零契约)。",
        '*.rpyc',
        '*.pyc',
        'game/cache/',
        'game/saves/',
        'game/backups/',
        'game/log.txt',
        'game/traceback.txt',
        'game/errors.txt',
        'project.log',
        '.DS_Store',
        '# GALFree 临时区(导出缓冲等);账本本体 .studio/*.json 是被管文件。',
        '.studio/tmp/',
        '',
      ].join('\n'),
    },
    {
      path: '.studio/project.json',
      content: `${JSON.stringify(
        { schemaVersion: 1, id: project.id, name, title, dialect: 'galfree-subset-1' },
        null,
        2,
      )}\n`,
    },
    {
      path: '.studio/stamps.json',
      content: `${JSON.stringify({ schemaVersion: 1, stamps: [] }, null, 2)}\n`,
    },
    {
      path: '.studio/slots.json',
      content: `${JSON.stringify({ schemaVersion: 1, slots: [] }, null, 2)}\n`,
    },
    {
      path: '.studio/characters.json',
      content: `${JSON.stringify({ schemaVersion: 1, characters: [] }, null, 2)}\n`,
    },
  ]
}

/** 每个模板空目录的占位文件。 */
export function templateKeepFiles(): TemplateFile[] {
  return TEMPLATE_EMPTY_DIRS.map((dir) => ({ path: `${dir}/.gitkeep`, content: '' }))
}
