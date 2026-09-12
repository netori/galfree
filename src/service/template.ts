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

/**
 * **界面文件**:必须从钉版 SDK 的 GUI 模板整份拷进项目。
 *
 * 为什么不能自己仿造(实测教训):Ren'Py 的 UI 有一半住在 `screens.rpy` 里 ——
 * 尤其是 `yesno_prompt`(关窗确认)。早先的模板只给 `script.rpy` + `options.rpy`,
 * 于是 `game/screens.rpy` 一缺,`layout` 对象上就没有 `yesno_prompt`,
 * **点窗口的关闭按钮直接 `AttributeError` 崩**;`gui.rpy` 里的 130 个 `gui.*`
 * 变量与 `screens.rpy` 的 84 处引用也是一整套,拆开就成了打地鼠。
 *
 * 所以做法是:**整份采用 SDK 的 GUI 模板**,跟着 SDK 走(升 SDK 也不同步歪)。
 * 这些文件住在"手写文件"那一侧,生成器按铁律不碰 —— 与"生成只允许方言子集"不冲突。
 */
export const TEMPLATE_UI_FILES = ['screens.rpy', 'gui.rpy', 'guisupport.rpy', 'testcases.rpy'] as const

/**
 * **图片名必须显式定义** —— 模板脚本里要提醒的一条 Ren'Py 现状(实测)。
 *
 * 现代 Ren'Py 把 `config.automatic_images` 置为 `None`(见 SDK 的 `00obsolete.rpy`),
 * 也就是**不再**把 `game/images/bg-rooftop.png` 自动定义成图片名 `bg rooftop`。
 * 后果很实在:素材槽出图落到 `game/images/<槽名>.png`(约定路径),
 * 但剧本里 `scene bg rooftop` **不会自动认它** —— 会显示成灰底占位 + 图片名。
 *
 * 所以"出图"与"图上屏"之间还差一行显式定义:
 *     image bg rooftop = "images/bg-rooftop.png"
 * 这条留给生成器/模板(见素材环节的后续票),此处只把事实记下来,别让人对着灰底猜。
 */
export const TEMPLATE_IMAGE_DEFINITION_NOTE = 'image <名字> = "<路径>"'

/** 中文字体补丁的文件名(init 顺序靠后,所以用 zz_ 前缀保证它在 gui.rpy 之后跑)。 */
export const TEMPLATE_UI_PATCH = 'zz_galfree_ui.rpy'

/**
 * 中文字体:从 SDK 拷 `sdk-fonts/SourceHanSansLite.ttf`(思源黑体精简版,2.77MB)。
 *
 * 为什么用 SDK 自带的而不是系统字体(实测教训):
 *  - **绝对路径不行** —— 试过直接指向 `C:\Windows\Fonts\msyh.ttc`,Ren'Py 静默回退成
 *    默认字体,中文照样是方块(不报错,最坑的一种失败);
 *  - **项目内相对路径是标准做法**,而且拷到别的机器不会因为"那台没装雅黑"变方块;
 *  - 思源黑体**开源可携带**,2.77MB 也不算负担,比塞 19MB 的系统字体干净。
 */
export const TEMPLATE_CJK_FONT = { source: 'SourceHanSansLite.ttf', target: 'fonts/SourceHanSansLite.ttf' } as const

/**
 * 中文字体与界面变量补丁。
 *
 * 两件事:
 *  1. 把界面字体指到**项目里那份**中文字体(SDK 的 gui.rpy 钉的是 DejaVuSans,不含中文字形);
 *  2. `gui.show_name` 等变量:screens.rpy 依赖它们,缺一个主菜单就崩(实测崩在 gui.show_name)。
 *
 * 字体在项目里缺失时**保持默认**并留下说明 —— 宁可是方块,也不写一个不存在的路径
 * (那会让启动直接失败,比方块糟得多)。
 */
export function renderUiPatch(hasFont: boolean): TemplateFile {
  return {
    path: `game/${TEMPLATE_UI_PATCH}`,
    content: [
      '# GALFree:中文字体与界面变量补丁(模板生成;手写文件,生成器不碰)。',
      '#',
      '# SDK 的 gui.rpy 把界面字体钉在 DejaVuSans.ttf,它不含中文字形 —— 中文会显示成方块。',
      '# 这里指到项目自带的中文字体(SDK 的 sdk-fonts/SourceHanSansLite.ttf,思源黑体)。',
      '# 注意:**必须用项目内相对路径**。试过写成 C:/Windows/Fonts/msyh.ttc 这种绝对路径,',
      "# Ren'Py 会静默回退成默认字体(不报错),中文照样是方块。",
      '',
      hasFont ? `define gui.text_font = "${TEMPLATE_CJK_FONT.target}"` : '# 字体文件没拷成功,保持默认字体(中文会显示成方块)。',
      hasFont ? `define gui.name_text_font = "${TEMPLATE_CJK_FONT.target}"` : '',
      hasFont ? `define gui.interface_text_font = "${TEMPLATE_CJK_FONT.target}"` : '',
      '',
      '# 中文断行:按字断(合法值是 eastasian / unicode / western…,**没有 "chinese"** ——',
      '#  写错会在渲染时抛 Exception: Unknown language,把整个对话屏打崩。这是个实测过的坑)。',
      hasFont ? 'define gui.language = "eastasian"' : '',
      '',
      '# ── 图片名要显式定义(实测)──────────────────────────────────────────',
      '# 现代 Ren\'Py 关掉了自动图片定义(config.automatic_images = None),所以',
      '# game/images/bg-rooftop.png **不会**自动变成图片名 "bg rooftop"。素材槽出图落在',
      '# 约定路径上,但剧本里 scene/show 要用它,得先写一行:',
      `#     ${TEMPLATE_IMAGE_DEFINITION_NOTE}`,
      '# 不写就会显示成灰底占位 + 图片名(那是 Ren\'Py 的"找不到图"提示,不是图坏了)。',
      '',
    ].filter((line, index, all) => !(line === '' && all[index - 1] === '')).join('\n'),
  }
}

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
        "# 只写 Ren'Py 真正认识的 config 变量与真正存在的字面量。两条实测过的坑:",
        '#  1. 没有 config.title 这个变量(窗口标题的真相是 config.name),',
        '#     写错会在启动时抛 "config.X is not a known configuration variable";',
        '#  2. 布尔字面量是 True/False(不是 true/false),',
        '#     写错会在编译期抛 NameError: name \'true\' is not defined。',
        `define config.name = _("${rpyEscape(title)}")`,
        'define config.version = "0.1.0"',
        // save_directory 要的是稳定的 ASCII 目录名,所以用 slug 而不是可能含中文的标题。
        `define config.save_directory = "galfree-${rpyEscape(name)}"`,
        'define config.has_sound = True',
        'define config.has_music = True',
        // screens.rpy 的主菜单读这两个;缺了会 AttributeError(实测崩在 gui.show_name)。
        'define gui.show_name = True',
        'define gui.about = _p("")',
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
