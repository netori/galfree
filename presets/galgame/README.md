# 「Galgame 制作」agent preset

一个专用的 agent 模式:在一个会话里,用 GALFree 把一部 Ren'Py galgame 从**一句主题**做到
**能发布的成品** —— 设定集 →(请人盖定稿戳)→ 逐场生成 → 补素材 → 接线音频 → 试玩 → 发布。

## 它到底加了什么(先说清楚,免得预期错位)

| 东西 | 谁提供 |
|---|---|
| **流程指引**(顺序 / 闸门 / 完成判据 / 谁来做 / 如实呈现的纪律) | **GALFree 插件**注入系统提示的 `galfree-workflow` 段(T19)。指引与接缝同源,改接缝它自动跟着变 |
| **工具面**(`galfree_project_status` / `galfree_generate_scene` / `galfree_publish` … 共 16 个) | 同一个插件(T20) |
| **板上的「下一步」**(`progress.nextActions[]`,带 `actor` 与跳转目标) | 同一个插件(T21);面板上也有一行 |
| **skills** | 组装里保留了 standard 的 `skill-filesystem` + `tool-skill` 两行 ⇒ 这个模式能看到**部署里注册的全部 skill**(本机包括 `mattpocock-skills-dsh-zh` 那一套与技能市场的;写剧本要用的那个就在里面)。**没有额外挑**:挑哪些 skill 是部署的事,preset 只保证这套机制在场 |
| **这个 preset 自己** | ① 一段**立场**(persona):galgame 制作现场、按指引走、只报事实、一次推进一环;② 一个**前置检查行**(`guard.mjs`):确认插件在场(工具名代表**版本下限**),不在就**带原因地拒绝**而不是静默少一堆工具 |

所以这个 preset 的姿态是**要求**插件在场,而不是**授予**插件能力 —— 为什么必须这样,见下面「两种装法」。

> **插件从哪来**:GALFree 是部署级插件(本机是 profile 的 `dsh.profile.bundles` 里一行
> `dsh-galfree`,指向本仓库的 checkout)。装法:插件市场里装,或者在 profile 的
> `package.json` 的 `dsh.profile.bundles` 加一行(本机是 `"dsh-galfree": "link:<仓库路径>"`)
> 再重启宿主。

## 装进哪、怎么装

preset 的规则很简单:**一个 preset = 一个目录,目录名就是 id**。用户 preset 放在
`<dshHome>/.agent-presets/<id>/`(本机 `~/.dsh/.agent-presets/`),id 必须匹配
`[a-z0-9][a-z0-9-]*`。

**四个文件就是全部**(`preset.yml` / `agent.cordis.yml` / `guard.mjs` / `README.md`);
`standard.reference.cordis.yml` 不要拷 —— 它只是仓库里的对照物,给 `src/preset.test.ts`
检查"组装 = standard + 两处改动"用,preset 运行时用不到。

### 从市场 / npm 装的用户:文件就在你装好的插件目录里

市场装的是**插件**,preset 不是自动生效的 —— 但 `0.1.1` 起**那份 preset 随包一起发**,
所以不必再来仓库取:

```powershell
# 从你装好的插件里拷出来(profile 名按你自己的改:web / desktop / …)
$src = "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-galfree\presets\galgame"
$dst = "$env:USERPROFILE\.dsh\.agent-presets\galgame"
New-Item -ItemType Directory -Force -Path $dst | Out-Null
Copy-Item "$src\preset.yml", "$src\agent.cordis.yml", "$src\guard.mjs", "$src\README.md" -Destination $dst
```

用的是本仓库 checkout 就照原来那样从 `presets\galgame\` 拷:

```powershell
$dst = "$env:USERPROFILE\.dsh\.agent-presets\galgame"
New-Item -ItemType Directory -Force -Path $dst | Out-Null
Copy-Item presets\galgame\preset.yml, presets\galgame\agent.cordis.yml, presets\galgame\guard.mjs, presets\galgame\README.md -Destination $dst
```

复制完刷新宿主界面(或重启)。宿主界面里也能**从既有 preset 复制一份**再改 —— 那条路会替你
挑一个不重名的 id,效果一样。

> **别直接改随部署交付的 preset 目录**(宿主自带的那几个):升级会覆盖它。

## 两种装法(二选一,**不能都装**)

这个 preset 与 GALFree 插件的关系有两种摆法,选一种:

### A. 插件装在**部署**里,preset 只加立场与前置检查(本机现状;先用这个)

profile 的 `dsh.profile.bundles` 里已经有 `dsh-galfree`(本机就是),于是**每个会话**都有
`galfree_*` 工具与那段指引;这个 preset 再给它一个专用立场 + 前置检查。

- 好处:装完即可用,不动 profile。
- 代价:`standard` 等别的会话也看得到那 16 个工具(它们不会被用到,但会占提示词)。

### B. 把插件**交给 preset 授予**

只有一种部署该这么写:插件**随宿主安装位置交付**(与 `@deepseek-ai/dsh-*` 那些包放在一起)。
那时把组装末尾那一行换成裸包名:

```yaml
- id: galfree
  name: 'dsh-galfree'
```

这样 `standard` 等会话就没有 GALFree,只有这个模式有。

**为什么本机(profile 装法)不能这么写**:preset 的健康检查从**宿主安装位置**解析包名
(`harnessBase` —— "a row's package name resolves against; the caller's own `ctx.baseUrl`,
which is where the installed harness lives"),而 profile 的 `node_modules` 不在那条向上的路径上
—— 于是插件明明装好了,这个 preset 也会被列成 **broken**("names a module that is not installed"),
不可选、不可复制。

**为什么两个地方都装绝对不行**:GALFree 插件会注册一个设置命名空间与一族 `/api/galfree/*` 路由,
而这两处都是**重复即抛**:

```
settings namespace "dsh-galfree" is already registered
webserver: duplicate GET route "/api/galfree/…"
```

宿主的规则是"重复注册即失败":preset 的组装会在会话创建时抛错并回滚(并指名出错的行)。
换句话说 **A 与 B 是互斥的**;真要换成 B,先把 profile 的 bundles 里那一行去掉再重启。

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
4. 插件没装时:会话创建**失败**,并指名 `galfree-guard` 这一行,错误里带**缺了哪些工具**与怎么装
   —— 不是少几个工具。

> 第 3 条里"建项目 / 写设定集由 agent 自己做"是 #28 之后的现状;早先的版本里这两步只能人点,
> 如果你看到 agent 把这两步推给人,那就是它的信息过期了(先查 `galfree_*` 工具在不在)。

## 维护

- 本目录的 `agent.cordis.yml` 是随包 `standard` 组装的**逐行副本 + 两处改动**(persona、guard 行)。
  测试会拿 `standard.reference.cordis.yml` 逐行比对,**多出来的行只许有 guard 那一行** ——
  所以抄错、漂了、或者你顺手加了没声明的改动,都会红。
- **那份参考副本是一份快照**(来源与版本写在其表头:`@deepseek-ai/dsh-agent-presets` **0.1.5-rc.1**)。
  宿主升级之后:把随包的那份重新取出来覆盖它(它在宿主安装位置里,不在本仓库的 node_modules),
  再跑 `npx vitest run src/preset.test.ts` —— 红出来的差异就是你要跟进的地方。
  换句话说:**它把"看起来有没有漂"变成一次显式的动作**(升级后重新快照),
  而不是假装自己能看见宿主的当前版本。
- `guard.mjs` 里那份"版本下限"的工具名与插件真实注册的名字由测试钉在一起(`src/preset.test.ts`):
  工具改名 → 测试红;而"查工具 ⇒ 指引也在"这条蕴含关系也有一条真宿主守卫盯着。
