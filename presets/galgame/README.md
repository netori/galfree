# 「Galgame 制作」agent preset

一个专用的 agent 模式:在一个会话里,用 GALFree 把一部 Ren'Py galgame 从**一句主题**做到
**能发布的成品** —— 设定集 →(请人盖定稿戳)→ 逐场生成 → 补素材 → 接线音频 → 试玩 → 发布。

## 怎么装:**不用装**

**装了 `dsh-galfree` 这个插件,bundle 里就带着这个 preset。** 没有"再拷几个文件到
`~/.dsh/.agent-presets/galgame/`"那一步了 —— 那个目录**已经没有任何东西在读**
(0.1.7 起用户 preset 目录机制被删掉了:preset 现在是一行 Loader 声明,
`@deepseek-ai/dsh-agent-preset` 的 `skills/editing-cordis-compositions/SKILL.md` 明写
"Nothing reads that directory any more")。

这个 preset 就是本包 `cordis.patch.yml` 里 `preset-galgame` 那一行,与插件本体
(`galfree` 那一行)是**同一次 insert**:

```yaml
- insert:
    - id: galfree
      name: 'dsh-galfree'
    - id: preset-galgame
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: galgame
        name: Galgame 制作
        description: …
        order: 5
        plugins: [ … standard 的行表 + 两处改动 … ]
```

所以:

| 你想要 | 做什么 |
|---|---|
| 让它出现 | 装 `dsh-galfree`(插件市场装,或 profile 的 `dsh.profile.bundles` 加一行),**重启宿主** |
| 升级它 | 升级 `dsh-galfree`;preset 跟着插件一起更新,不会各走各的 |
| 卸掉它 | 卸掉 `dsh-galfree`;两行一起消失 |

> **从旧版本升上来的话**:`~/.dsh/.agent-presets/galgame/` 那个旧目录(0.1.5 时代手工拷的
> 四件套)**已经没用了**,留着不会生效,也不会冲突 —— 删掉即可。旧版"两种装法(A 插件装部署 /
> B 插件交给 preset 授予)二选一"的纠结也随之消失:现在两样在同一个 bundle 里,
> 不存在"preset 在、插件不在"的常规装法。

## 它到底加了什么(先说清楚,免得预期错位)

| 东西 | 谁提供 |
|---|---|
| **流程指引**(顺序 / 闸门 / 完成判据 / 谁来做 / 如实呈现的纪律) | **GALFree 插件**注入系统提示的 `galfree-workflow` 段(T19)。指引与接缝同源,改接缝它自动跟着变 |
| **工具面**(`galfree_project_status` / `galfree_generate_scene` / `galfree_publish` … 共 16 个) | 同一个插件(T20) |
| **板上的「下一步」**(`progress.nextActions[]`,带 `actor` 与跳转目标) | 同一个插件(T21);面板上也有一行 |
| **skills** | 组装里保留了 standard 的 `skill-filesystem` + `tool-skill` 两行 ⇒ 这个模式能看到**部署里注册的全部 skill**(本机包括 `mattpocock-skills-dsh-zh` 那一套与技能市场的;写剧本要用的那个就在里面)。**没有额外挑**:挑哪些 skill 是部署的事,preset 只保证这套机制在场 |
| **这个 preset 自己** | ① 一段**立场**(persona):galgame 制作现场、按指引走、只报事实、一次推进一环;② 一个**前置检查行**(`galfree-guard` → `dsh-galfree/guard`):确认插件那一行**真的在跑**(工具名代表**版本下限**),不在就**带原因地拒绝**,而不是静默少一堆工具 |

也就是说这个 preset 的姿态仍然是**要求**插件在场,而不是**授予**插件能力 —— 只不过现在
"要求"变成了结构上的:两行在同一个 bundle 里,装了插件才有这个 preset。

## 手选,还是设成默认?

两种都行,**默认值交给你**(它会影响的不是这一个会话,而是所有**新**会话):

| 做法 | 怎么改 | 影响 |
|---|---|---|
| 每次手选 | 新建会话时在 preset 选择器里挑「Galgame 制作」 | 其它会话不受影响;注意**只有还没产出任何内容(没消息、没工具调用)的会话能切 preset** |
| 设为默认 | 设置命名空间 `agent-presets.default` 填 `galgame`(**只在会话创建时读取**,改完对已存在的会话无效) | 之后每个新会话都进这个模式 |

建议:先手选用一两次,确认它就是你想要的"galgame 模式",再决定要不要设成默认。

## 怎么验它真的装上了(AC1 / AC2)

1. 新开一个**空**会话,选「Galgame 制作」;
2. 只给它一句主题,例如「做个雨天天台的 galgame」;
3. **期望**(这就是 AC1 与 AC2 要看到的东西):
   - 它先**读板** —— 调 `galfree_project_status`,而不是凭记忆开写;
   - 然后**自己动手做前两步**:`galfree_create_project` 建项目、`galfree_story_bible` 写设定集
     (这两步 #28 之后都是 agent 的活,不该再推给人);
   - 写到该盖章时**停下来请人**:说清"请你在工作台盖「设定定稿」戳",并说明没盖章时生成会被
     `bible-not-final` 拒 —— 而不是自己往下生成,也不是把"要盖戳"当成自己的活;
   - 盖章之后继续按顺序推进(逐场生成 → 补素材 → 接线音频 → 试玩 → 发布),
     每一步都拿板上的字段当判据,并且**如实报**("lint 有 2 个 error"而不是"差不多好了")。
4. 插件那一行被关掉 / 没激活成功时:preset 在名单里**带原因地显示成不可用**(指名
   `galfree-guard` 这一行,并列出少了哪些工具、去哪儿开),不是少几个工具就放你进去。

> 第 3 条里"建项目 / 写设定集由 agent 自己做"是 #28 之后的现状;早先的版本里这两步只能人点,
> 如果你看到 agent 把这两步推给人,那就是它的信息过期了(先查 `galfree_*` 工具在不在)。

## 维护(给改这个 preset 的人)

本目录三个文件,分工是**一个真相三种形态**:

| 文件 | 是什么 |
|---|---|
| `agent.cordis.yml` | **给人读的那一份**:行 + 注释标准(0.1.7 的 standard 行表 + 两处改动)。运行时**不读**它 |
| `preset.yml` | **展示元数据**(name / description / order)。宿主**不读**它;它是 patch 那一行的元数据来源 |
| `standard.reference.cordis.yml` | **快照**:0.1.7 随包 `standard` 的行表(来源与版本写在表头)。运行时**不读**它 |
| `guard.mjs` | 前置检查插件的实现,经 `package.json` 的 `exports["./guard"]` 暴露给 preset 那一行 |

**唯一"生效"的形态是 `cordis.patch.yml` 里的 `preset-galgame` 那一行**,它必须与
`agent.cordis.yml` **逐行相等**(`src/preset.test.ts` 逐行深度比对,抄错、漂了就红)。

- **宿主升级之后**:把随包的那份重新取出来覆盖 `standard.reference.cordis.yml`
  (0.1.7 起它在 `@deepseek-ai/dsh-web-app` 的 `presets/standard.patch.yml` 里,是
  `preset-standard` 行的 `config.plugins`;它在宿主安装位置里,不在本仓库的 node_modules
  —— Windows 桌面版在 `resources/app.asar` 内,解包脚本见 `.scratch/asar-extract.mjs`),
  跑 `npx vitest run src/preset.test.ts`:**红出来的差异就是你要跟进的漂移**,
  跟完再把同样的改动抄进 `cordis.patch.yml`。
  换句话说:它把"看起来有没有漂"变成一次显式的动作(升级后重新快照),
  而不是假装自己能看见宿主的当前版本。
- **guard 行引用的形态不能随手改**:preset 的 `plugins` 行由 registry 挂载时,解析基准是
  **profile 目录**(声明这一行的 Loader 树的 baseUrl),不是插件包目录 —— 本机实测
  `./guard.mjs` 在真宿主里只会得到 `never started`。所以是
  `dsh-galfree/guard`(`package.json` 的 `exports["./guard"]` + `files` 里的 `presets`)。
  这三样(行名 / exports / files)由测试一起钉住。
- **`guard.mjs` 里那份"版本下限"的工具名与插件真实注册的名字由测试钉在一起**:
  工具改名 → 测试红;而"查工具 ⇒ 指引也在"这条蕴含关系也有一条真宿主守卫盯着。
  guard 为什么要"等一会儿"再判工具在不在(宿主行并行激活 + 本插件的工具走懒注入)、
  以及本机实测到的现象,都写在 `guard.mjs` 的文件头里。
