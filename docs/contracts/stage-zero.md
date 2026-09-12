# 环节零接缝契约(Stage Zero Seam Contract)

GALFree v1 的**唯一测试接缝** = Host 侧项目服务(`src/service/project-service.ts` 的
`ProjectService`)。本文档定稿其接口清单、`.studio/` 布局、校验契约与事件/推送协议;
是后续所有环节票(T8+)的测试骨架。架构权衡不在此重复,见 `docs/adr/`。

- 方言子集语法清单:单独成文于 [dialect-subset.md](./dialect-subset.md)。
- 硬约束来源:ADR-0003/0004/0005/0006/0008/0009/0011(经 `AGENTS.md` 摘要)。

## 总则

1. **磁盘上的项目目录是唯一真相源**(ADR-0003)。服务不在内存里维护第二套项目状态;
   所有状态对象都是"读盘 + 纯函数推导"的产物,可随时全量重算。
2. **项目文件的一切插件内写必须走写网关**(ADR-0004)。网关是快照/审计/校验的挂载点。
   外部(VSCode/git)修改 = **观察**(fs.watch → 事件广播 → 客户端刷新),网关对版本
   漂移做冲突拒绝,绝不覆盖外部内容。
   - 实现注记:DSH `fs` 服务(`ctx.fs`)的 CAS 写只支持文本且面向会话执行世界;
     项目是磁盘任意目录且需要二进制(图像)写与批原子性,故网关自带内容哈希版本戳
     (sha256 前 16 位,`absent` = 不存在)。CAS 语义与 `fs.writeText(expected)` 对齐。
3. **进度是推导的,审读戳只能由人盖**(ADR-0008)。接缝上没有任何"设置进度/进度字段"
   的写方法;`stampScene/stampSlot` 要求 `via:'human'`,agent 侧一律 `stamp-forbidden`。
   戳记**内容指纹**:覆盖写(网关或外部)使指纹变化 → 推导为 `stale`(待复审),
   历史记录保留。
4. **快照 = 写批提交后的本地 git commit**(ADR-0011),作者 `GALFree <galfree@dsh.local>`,
   message 携带 `origin/stage/scene/slot + batchId`。永不 push、不改写用户手动提交。
5. **v1 项目只从模板新建**(ADR-0005)。模板见 `src/service/template.ts`。

## 接口清单(接缝公共面)

构造:`createProjectService({ dataDir, validator?, playtest? })`。`projectRef` = 项目 id
或唯一 name。错误一律 `GalfreeError{code,message,details?}`(按 code 分支,不解析文本)。

### 注册表与模板新建(T1)

| 方法 | 语义 | 错误 code |
|---|---|---|
| `createProject({projectsRoot,name,title?})` | 模板 → `projectsRoot/<name>/`,经网关落盘 + git init + 初始快照;入注册表并**立即激活** | `invalid-name` `project-exists` `git-init-failed` |
| `listProjects()` | `ProjectInfo[]`(含 `active/missing` 派生标志) | — |
| `getProject(id)` / `getActiveProject()` / `setActive(id)` | 注册表 = 指针表(列表 + 单激活 id);内容不落注册表;`setActive` 为数据模型端口(切换 UI 后补,v1 不在路由/面板暴露) | `unknown-project` |

`ProjectInfo = { id, name, title, root, createdAt, active, missing }`。

### 写网关(T2)

| 方法 | 语义 | 错误 code |
|---|---|---|
| `readProjectFile(ref, relPath)` | 现读磁盘 + 版本戳(内容哈希;缺失 = `ABSENT='absent'`,唯一哨兵,可直接回填 `expectVersion`) | `path-escape` |
| `writeProjectFiles(ref, ops[], {origin,reason,scene?,slot?})` | **串行**原子批:每个 op **必须**带 `expectVersion`(CAS;新建传 `'absent'` 断言不存在,缺省 → `expect-required` 拒绝)。先全批校验(快速失败,通常无需回滚),再逐文件落盘;**落盘写前用刚读的旧内容做权威 CAS 复校**,关闭校验→写入之间的外部写 TOCTOU 缝隙;中途失败逐文件回滚 | `version-drift` `expect-required` `write-failed` |
| `observeChanges(ref, listener)` | 订阅 `{path,version,kind:'internal'｜'external'}` | — |
| `writeLog(ref)` | 插桩:每条形如 `{path,batchId,version,reason,origin,at}`;"无旁路写"断言源 | — |
| `gatewayErrors(ref)` | 非致命故障如实呈现:`snapshot-failed`(批已落盘但 git commit 失败)/ `rollback-failed` / `watch-failed` | — |

网关单例:每项目**恰好一个** `WriteGateway`(懒建竞态安全:promise 在 await 前同步
入表),保证"一项目一队列"的串行与单一写日志。

### 快照(T3)

| 方法 | 语义 |
|---|---|
| `snapshotHistory(ref, relPath)` | 单文件历史 `SnapshotEntry[]`(真 git;最新在前) |
| `snapshotDiff(ref, relPath, from, to)` | 两版本 diff 文本 |
| `snapshotRollback(ref, relPath, toCommit)` | `git show` 取旧内容 → **经网关写回** → 自动产生回滚快照;历史只追加 |

### 结构解析与校验回路(T4/T5)

| 方法 | 语义 |
|---|---|
| `branchGraph(ref)` | 方言子集派生骨架 `{dialect,scenes,edges,problems,degraded}`;纯函数、幂等、可全量重算;场景含 `text`(原始文本块)与 `showing`(对白行画面的图像引用) |
| `validateActiveProject()` | `ValidationReport = {ok, problems[], validator:'fake'｜'sdk', at, sdkNote?}`。端口 `ValidatorPort = (ProjectInfo) => Promise<ValidationReport>`:缺省 = 假验证器(子集解析 + 结构规则:悬空跳转/重复 label/缺 start = error);生产装配注入**合成验证器** —— 假 lint 恒跑,钉版/覆盖 SDK 就绪时叠加真 `renpy lint` 并升级 `validator:'sdk'`,未就绪在 `sdkNote` 如实标注 |
| (T5)`SdkProvisioner.ensure()` | 钉版 SDK 下载状态机 `idle→downloading(进度)→verifying(sha256,官方 checksums 钉死)→extracting→ready`;幂等、可 retry |
| (T5)`probeOverrideSdk` | 覆盖路径探测:启动器存在 = 可用;版本 ≠ 钉版 → `mismatch` 警告进状态、**不阻塞**试玩/校验 |

### 推导进度与审读戳(T6)

| 方法 | 语义 |
|---|---|
| `progress(ref)` | 纯推导快照(无时间戳、幂等):场景视图 `{label,readOnly,missingDialogue,dialogueCount,slots[],missingSlots[],stamp,stampable,stampableBlockedBy?,lintErrors,marks[]}` + `lint` + `playtest` + `summary` |
| `stampRecords(ref)` | 历史戳(含失效者) |
| `stampScene(ref,label,{via})` | 人盖场景戳(记场景内容指纹);`via!=='human'` → `stamp-forbidden` |
| `stampSlot(ref,slot,{via})` | 人盖槽戳;未填 → `slot-not-filled` |

**场景视图里的派生便利字段**(均为推导,UI 只渲染、不复述规则):

- `marks[] = {code,severity,label,count?,detail?}` —— 舞台板一行要显示的"这一场怎么了",
  由 `deriveSceneMarks()` 按 `error → warn → info` 排序给出。`label` **不带计数**
  (计数走 `count`),文案与严重度都由接缝定,agent 工具面与工作台读同一份。
  code 取值:`lint-error` / `missing-slots` / `missing-dialogue` / `content-changed` /
  `read-only-degraded` / `settled`(已定稿)/ `clear`(暂时无毛病但未盖戳)。
- `slot.approvable` + `approvableBlockedBy` —— 这一槽**能不能**给人盖戳(与 `stampSlot`
  的守卫同源:未填不可),UI 不再自己复述 `slot-not-filled` 这条规则。
- `scene.stampable` + `stampableBlockedBy` —— 只读降级的场景不可盖戳(先改回子集内)。

戳失效**判定是推导**:盖戳时存内容指纹(场景 = **原始文本块**哈希 —— 含被解析器
跳过的子集外内容,防止"加一段怪代码但戳还绿"的旁路;槽 = 素材文件哈希),推导时对比
当前指纹 → `approved/stale`。任何覆盖写(含外部编辑器)自动"清戳 → 待复审",
无需显式清除动作。指纹统一 `sha256 前 16 hex`(`hash.ts`,与网关版本戳、试玩
`contentFingerprint` 同口径)。

素材槽推导:`show/scene <tag> <attrs…>` 引用即槽;id = `tag attrs…`(空格分隔);
约定路径 `game/images/<tag-attrs…>.png`(`slotAssetPath`)。素材定义(`image x = …`)
可改路径映射(T8 账本)。

### 试玩(T7)

| 方法 | 语义 |
|---|---|
| `playtestStart(ref)` | 钉版 SDK 启动项目 → 退出回传 `{at,exitCode,technicalPass,traceback,fingerprint}`;事实经网关落 `.studio/playtest.json` → 进快照 |
| 板上 `progress.playtest` | 推导:`pass/fail` + 内容再变 → `stale`;SDK 未就绪 → `sdk-not-ready` 如实报错 |

技术通过 = 退出码 0 且日志无 traceback(`extractTraceback`);主观"玩过了、行"
由人盖场景戳表达(审读戳账本同套机制)。

## `.studio/` 布局(契约骨架)

```
<project>/                      # 标准 Ren'Py 项目(唯一真相源)
  .gitignore                    # logs/cache/saves/.studio/tmp 不入快照
  game/
    script.rpy                  # 方言子集模板入口(label start + menu + jump)
    options.rpy                 # config.name/version/save_directory
    images/ audio/ fonts/ tl/   # Ren'Py 搜索目录(.gitkeep 入快照)
  .studio/
    project.json                # {schemaVersion,id,name,title,dialect}
    characters.json             # 角色登记簿骨架(T8 填充)
    slots.json                  # 素材槽制作信息账本(T8 填充;槽本身从 .rpy 派生)
    stamps.json                 # 审读戳账本 {schemaVersion,stamps:[{target,fingerprint,at}]}
    playtest.json               # 试玩事实账本 {schemaVersion,last,history[]}
    bible/                      # 设定集(T9)
    tmp/                        # 临时区(不追踪)
```

铁律(ADR-0009):`.studio/` **只放引用与制作信息,永不复制叙述内容**;
悬空引用(槽/戳指向不存在的 label、文件)= 校验错误,进推导板。
`target` 命名:`scene:<label>` / `slot:<槽id>`。

## 事件 / 推送协议(工作台刷新)

- HTTP 路由族前缀 `/api/galfree`(仅回环;精确路径匹配):
  - `GET /state` → `{projects, activeId, tree, activeRoot, activeMissing, gatewayErrors[]}`
  - `POST /projects/create` → 201(**新建即激活**)
  - `POST /projects/activate` → `{project}` —— **环节零之后的追加例外**:环节零当时
    无 activate 路由(切换 UI 明确"后补",见 spec User Story 29 / #9「切换 UI 不做」),
    此处由**发起人明确批准**解除该延迟。只动注册表激活位,不写任何项目文件
  - `GET /progress` → 推导快照;`POST /stamps/scene|slot`(**仅人**经由工作台触发;agent 工具面永远不接此端口)
  - `POST /playtest` → `{run}`;`GET /sdk` → `{requested,dir,launcherReady,version,mismatch,provision}`、`POST /sdk/ensure` → 触发下载(首次使用进度可见)
  - `GET /snapshots?path=` / `GET /snapshots/diff?path=&from=&to=`
  - `POST /snapshots/rollback` → `{result}`(`{path,to}`)—— 回滚是**写**:经接缝的
    `snapshotRollback` 走网关落盘,并自动产生一条回滚快照(历史不改写)
  - `GET /files/content?path=` → `{path,content,version,bytes}` —— 只读预览;读走网关口径
    (磁盘为真 + 当前版本戳),不产生写
  - `GET /picker` → `{kind, defaultProjectsRoot}` —— 目录选择**能力**(不做假设,如实上报)
  - `POST /picker/pick` → `{path, cancelled}` —— 开宿主屏幕上的 OS 选择器;取消是正常结果
    (`cancelled:true`,面板什么都不改),超时则中止并报 `picker-timeout`
  - `GET /picker/list?path=` / `POST /picker/create-directory` → 应用内浏览后端的列举与建目录
  - `GET /validate` → `ValidationReport`
  - 错误响应 `{error, code}` + 状态码:漂移/越权/缺版本戳/未就绪 = 409;
    目标不存在(含项目目录被挪走)= 404;请求体不合法 = 400;路径存在但方法不对 = 405 + `Allow`;
    选择器不可用 = 501、超时 = 504;浏览后端的类型化失败(目录不可读/已存在/建不出)= 409 并透出业务码
- `GET /events`(**SSE**):仅推 `{type:'external-change'}`(外部写观察,100ms 合并;
  网关自写不推 —— 写窗口(1.5s TTL)内该路径的监听事件按自身写噪声抑制,
  Windows 截断写的中间态不可信,窗口内的真实外部改动由 8s 轮询兜底)。
  客户端收到即重拉 `/state`+`/progress`;轮询 8s 兜底。
  后续环节扩展帧型(`batch-committed`、`queue-progress`)保持"事件轻、状态拉"原则。

### 目录选择(接缝在宿主,插件自带降级底座)

新建项目的父目录优先用**宿主的目录选择接缝** `ctx.directoryPicker`(GUI 宿主装配
`dsh-host-directory-picker-auto`,按启动时的宿主处境挑一个后端)。它是**能力式**约定,
插件不假设存在哪种交互。

**但能力不能是单点。** 那个装配用的是运行时 Loader 动态 create
(`ctx.loader.create({ name })`),它自己的 effect 一旦失败是静默的 —— 后端没挂上,
`ctx.directoryPicker` 就不存在。把"能不能选文件夹"押在那条链上,等于把用户可见功能
押在别人的启动时序上。因此:

| 情形 | 目录数据来源 | 面板表现 |
|---|---|---|
| 宿主 `native`(OS 选择器可用) | 宿主 | 额外给「开系统对话框」按钮;它若报错就把浏览器打开,不让人卡在死按钮上 |
| 宿主 `browse` | 宿主 `list`/`createDirectory` 优先 | 面板内抽屉:逐层进入、面包屑、新建文件夹、隐藏项开关 |
| **宿主后端缺席** | **插件自带 `directory-listing.ts`** | 同一个抽屉照常工作 |

`/picker` 因此回报 `{kind, browse, native, defaultProjectsRoot}`:`browse` 是恒真的底座
能力,`native` 才是"有则更好"的增强。手输路径随时可用,并经 `/picker/inspect` 即时校验
(存在与否、是不是目录),面板不猜。

`defaultProjectsRoot`(设置里的默认父目录)随 `/state` 与 `/picker` 一起下发,面板据此在
表单里**显式写出"将创建到 `<父目录>\<项目名>`"** —— 不选文件夹也不会建到人不知道的地方。

## 素材槽与角色登记簿(T8 之后追加)

`.studio/` 的**铁律**在这里第一次真正被执行:`.studio/` 只放**引用与制作信息**,永不复制
叙述内容。落地成两层:

| 文件 | 放什么 | 不放什么 |
|---|---|---|
| `.studio/characters.json` | 角色登记簿:外观设定卡(结构化字段)、画风锚、参考图链、`voice`(对 `.rpy` 变量名的**引用**) | 台词、场景正文 |
| `.studio/slots.json` | 槽的制作信息:`requiresCharacters`(引用登记簿 id)、提示词、画风锚 | 槽清单本身 —— 它**永远从 `.rpy` 的图像引用派生** |

**槽清单是推导的,账本是挂上去的。** `deriveSlots()`(纯函数)从 `.rpy` 的 `show/scene`
语句派生槽与它的定位(`origin` = 文件、行、原始语句、引用它的场景),再把账本挂上来。
因此:

- 改 `.rpy` 的图像引用 → 槽清单自动变,**没有任何"上报槽"的入口**;
- 账本挂了制作信息但 `.rpy` 里没人引用 → `dangling-slot-ref`(**error**);
- 账本要求 `requiresCharacters` 里的角色,但登记簿没这个 id → `dangling-character-ref`
  (**error**),且**定位到引用该槽的那条 `.rpy` 语句**(问题会在运行剧本时咬人);
- `.rpy` 里有 `define X = Character(...)` 但登记簿还没登记 → `unregistered-character`
  (**warning**):剧本可以先写、设定后补,那是工作周期而不是结构缺陷。

以上四类与 lint 汇总同源进板(`progress.problems` → `lint`/`summary`),因此舞台板与
素材板读的是同一份判断。

**接缝方法**:`characters(ref)` / `upsertCharacter(ref, record)` / `removeCharacter(ref, id)` /
`slotLedger(ref)` / `upsertSlot(ref, record)` / `removeSlot(ref, slot)` —— 全部经网关写
(自动快照)。写入前 `assertCharacterValid` / `assertSlotValid` 拦下两类错误:id/`voice`
必须是合法标识符,所有文本字段有长度上限(挡住"把正文抄进设定卡"这条最可能的违规路径)。

**路由**:`GET /cast`(账本读)、`POST /cast/characters/upsert|remove`、
`POST /cast/slots/upsert|remove`;`GET /progress` 额外给出 `slots[]`(带 `ledger` 与
`origin`)与 `characters[]`(带 `defined` / `definedAt` / `slots[]`,可见性是推导的)。

**工作台素材板**(T8):账本形态 —— 槽视图 + 角色视图,**纯渲染派生对象,没有出图动作**
(出图属 T14/T15)。

## 设定集(T9 之后追加)

设定集是项目的**第一记忆源**:世界观、章节大纲、分支骨架。两条边界由 T9 钉死,写成契约:

1. **角色设定以登记簿为家**。设定集只放 `{id}` 引用(T8 的登记簿是单一真相),不复制
   外观卡 —— 否则同一张脸会有两处说法,迟早漂移。`writeBible` 收到角色内容时顺手把它
   写进登记簿(T9:"同步写登记簿"),设定集里只留 id。
2. **大纲模式的原文即权威**。人导入的原文**逐字**躺在 `.studio/bible/outline.md`,
   设定集里只存**引用**(`{path,fingerprint,chars,importedAt}`)。`importOutline` 只做
   一件事:原样落盘 + 记指纹,任何"顺手整理"都是违规。原文被外部改过 → 板上如实报
   `outline-fingerprint-mismatch`(**error**),而不是拿旧指纹假装它还是那份权威原文。

**两个"被改过"是两件事,分别判**:

| 指纹 | 管什么 | 变了会怎样 |
|---|---|---|
| `bibleFingerprint`(主题/世界观/章节/角色引用) | 派生物 | 定稿戳 → 待复审(`stale`) |
| `outline.fingerprint` | 人的原文 | `outline-fingerprint-mismatch` 进板 |

**「设定定稿」戳**:target = `bible`,只由人盖(与场景/槽戳同一条 `#requireHuman` 守卫,
agent 侧无入口)。

**下游只读定稿版**:`generationContext(ref)` 在"没盖戳"或"盖过但内容又变了"时**抛
`bible-not-final`(路由 409)**,不偷偷给草稿 —— 这样"设定集是第一记忆源"才是可断言的,
而不是口头约定。上下文里带 `fingerprint`(下游据此知道要不要重取)、章节(引用 label)、
**来自登记簿的**角色、人的原文(逐字)、以及 `missingCharacters`(设定集引用但登记簿
还没登记的缺口,如实列出)。

**骨架是派生的**,不落盘:落盘的只有人的意图、人的原文、以及对登记簿的引用。

**路由**:`GET /bible`(账本 + 原文)、`POST /bible/patch`(人编辑)、
`POST /bible/import-outline`(逐字导入)、`POST /bible/stamp`(人盖定稿戳)、
`GET /bible/context`(定稿版上下文;未定稿 = 409)。`GET /progress` 额外给出
`bible{stamp,chapters,characters,hasOutline,outlineFingerprintOk}`。

**工作台设定集卡**(T9):人编辑主题/世界观、逐字导入大纲、盖定稿戳;**面板不生成内容**
(生成属 T10)。

## 逐场剧本生成(T10 之后追加)

**归属规则(本票钉死):一个 label 只归一个文件。**

| 文件 | 谁的 | 生成器 |
|---|---|---|
| `game/script.rpy` | **手写/模板**的家 | 不碰 |
| `game/scenes/<label>.rpy` | **生成**的家(一文件一场景) | 只写这里 |

想生成一个还活在别处的 label(例如模板的 `start`)→ 如实拒绝(`scene-label-elsewhere`)
并指出它在哪;要重生成它,先由人**搬家**:`relocateScene(ref,label,{via:'human'})` 把那段
**原样**搬进生成目录(逐字不变,含注释与缩进),一个写批完成 —— 它重写的是人的手写文件,
所以 `via` 必须是 human。

**一个写批 = 一个快照**,批次粒度到场:每次 `generateScene` 恰好写一个文件、产生一条
commit,message 带场景名(`reason:'scene'`)。

**写完当场判定**,结果原样交回(不吞):

```
generateScene(ref,{label,source,nextLabel?,requireContext?}) → {
  path, label, action:'created'|'regenerated',
  parseOk,      // 子集能否解析(false = 含子集外降级)
  validation,   // 校验回路结果(快带假 / 生产合成真 SDK)
  issues[],     // 目标文件与全局结构问题(含 dangling-jump 这类)
  progress,     // 写完之后的推导板快照(板立刻反映)
  context,      // 定稿设定集上下文(requireContext 时)
  wroteAt
}
```

`requireContext:true`(agent 工具默认)时先过 T9 的门:**没定稿设定集就拒绝生成**,
不偷偷用草稿。**生成"失败"照常落盘并如实上报**:语法错/悬空跳转会留在仓库与快照里
(可回滚),板立刻显示问题 —— 假装成功才是事故。

**`.rpy` 读取是递归的**(`src/service/rpy/files.ts`,唯一出处):Ren'Py 会加载 `game/`
下任意深度的 `.rpy`,真 SDK 的 lint 也是递归看的,所以方言解析、分支图、假验证器必须与它
同口径。定位信息用 `game/` 下的**相对 POSIX 路径**(如 `scenes/start.rpy`)。

**agent 工具**(cordis 懒注入 `ctx.tools`;没有工具席位只少两个入口):

| 工具 | 作用 |
|---|---|
| `galfree_generate_scene` | 生成/重生成一场;返回落盘路径、校验结果、问题清单、板快照 |
| `galfree_project_status` | 读推导状态(场景/槽/角色/设定集/lint/试玩),与阶段板同源 |

校验不通过**不抛错**,而是把 issues 交回让模型当场修后重生成;接缝的拒绝(归属违规、
未定稿)也原样交回,因为那是**可执行的指令**。

**路由**:`POST /scenes/relocate`(人发起搬家)。**工作台**:舞台板每场展开后,住在手写
文件的场景带一个「搬进生成目录」按钮(它是人的动作,不是 agent 的)。

## 场景编辑器与分支图(T11/T12 之后追加)

**两个视图,同一份真相(`.rpy`)。** 表单逐行改(说话人/文本/图像引用),源文本模式直接改
文件;两路都走网关(版本戳 + 快照 + 写日志),写完当场判定并交回(与 T10 同形状的
`EditSceneReport`)。

**最小化 diff 是硬约束,做法是不重新生成文件**:`行模型 → 只改被指定的那一行 → 拼回`,
未编辑的行按**原文逐字**回写。所以:

- `sceneForm(ref,label)` 给出 `rows[]`(每行带 `kind`/`line`/`raw` 与可编辑字段)与
  `source`(该文件全文)。**注释与空行也如实列出来** —— 不列出来,编辑一次就会把它们吃掉。
- `editScene(ref,{label,edit})`,`edit` 五种:`setDialogue` / `setImage` /
  `insertStatement`(锚点优先:给那一行的原文,调用方不必知道文件头占几行)/
  `deleteStatement` / `replaceSource`。
- 改一句对白 → 该文件的 diff **只有那一行**(有 git diff 断言)。

**边界(与 T10 的归属规则同源)**:

| 谁 | 什么能用 |
|---|---|
| 停在**手写文件**的场景(如模板 `start`) | 表单编辑**拒绝**(`scene-not-editable`,409,并指出它在哪、先搬家);**源文本模式可以改**(那是人自己的文件) |
| **子集外降级**的场景 | 表单编辑**拒绝**(`scene-read-only`);源文本仍可改,降级由解析器如实标注 |
| 生成目录里的场景 | 两种模式都可用 |

**分支图(T12)= 派生骨架的纯渲染,只读导航**:`GET /scenes/graph` 给
`{nodes,edges,problems,degraded}`;节点带**戳状态**(来自推导)与子集外**只读徽标 + 原因**。
**图上编辑明确出范围**(spec):点节点只做一件事 —— 打开那一场的编辑器。

**工作台**:「场景」卡 = 分支图(点节点定位)+ 编辑器(逐行表单 / 源文本两个 tab);
舞台板每场展开后有「编辑这一场」入口。

## 整线组装试玩(T13 之后追加)

**项目级完整性 = 纯推导**(`src/service/completeness.ts`):`completeness(ref)` 给
`{entry, reachable[], orphans[], endingReachable, problems[]}`。三件事:

1. **定位**:把全局问题(悬空跳转等)落到它所在的场景 —— 板要说"是这一幕的问题 + 哪一行",
   而不只是"项目里有个问题"。`locateScene()` 按文件 + 行区间归属。
2. **可达**:从主菜单入口 `start` 沿 jump/call/菜单选项走,走不到的场是 **`orphan-scene`**
   (error)。孤立场景是真实的坑:剧本写了、玩不到。
3. **结局可达**:从入口能否走到一个含 `return` 的场景;走不到是 **`no-ending-reachable`**
   (error)。**`return` 可能藏在菜单选项体里**(模板的 `start` 就是这样),递归查 —— 只看
   顶层会把这种项目误判成"结局不可达",那是比漏报更糟的假阳性。

`progress.completeness` 把三者交给面板(阶段板上一枚徽标);问题与 lint 同源进板。

**从某场试玩**(`playtestStart(ref, fromLabel)`):

- 实现是**在副本里覆写 `start`** 跳向目标场,再把整份拷贝交给 SDK 跑 —— 副本用完即删,
  **用户项目一个字节都不动**。不在用户项目里塞临时 `.rpy`(`.rpy` 是唯一真相,试玩副本不是)。
- 信号是可红的:目标场不存在 → 启动即崩出 traceback。所以"窗口活着"= 那一场真的跑起来了,
  而不是"没报错"的空断言(慢带有真 SDK 断言)。
- 运行事实(含 `from`:从哪一场跑的)照旧经网关落 `.studio/playtest.json` 并进快照;
  `progress.playtest.from` 让板说得出"这次是从第几场试的"。

**路由**:`POST /playtest` 接受 `{from}`,不存在的场 → 404(`unknown-scene`)。

## 图像渠道与任务队列(T14 之后追加)

素材出图**不依赖 dsh-imagegen**(ADR-0010):插件自带渠道配置、任务模型与执行队列。
边界如下。

### 写网关的类型拓宽:文本与二进制同一口子

素材环节要落 PNG,而"项目文件的一切插件内写必须走网关"(ADR-0004)是铁律 ——
所以 `WriteOp.content` 是 `string | Uint8Array | null`(**不**给图像开旁路)。
版本戳口径不变:一律按**原始字节**取 sha256 前 16 位,读/写/外部监听三处同口径
(否则二进制文件的"内部写噪声抑制"会失效,网关会把自己的写当成外部改动上报)。
回滚底本同样按字节留。

### 渠道:端点在设置里,能力声明在模型目录里

| 在哪 | 放什么 |
|---|---|
| 插件设置(`dsh-galfree` 命名空间) | `imageBaseUrl`(OpenAI 兼容基址)、`imageApiKey`、`imageChannelName`、`imageModels`(JSON 数组) |
| 模型目录的每一条 | `id` + `capabilities`(见下) |

**密钥明文存本机设置文档** —— 这是 ADR-0010 的知情选择(与 dsh-imagegen 同风险面)。
三条硬边界:密钥**不进项目目录**、不进快照、不进任务账本(账本里只有渠道名与模型 id);
接缝的 `imageChannel()` 只回报 `apiKeyConfigured` 布尔,不回传密钥本身。
没填端点 = 没渠道 → 出图动作在接缝上抛 **`no-image-channel`**(路由 503),绝不假装能出图。

**设置命名空间 ≠ 设置有界面(实测两遍才走对)。** Host 半 `ctx.settings.register(ns, schema)`
只让设置**可读写**。界面上有两条路,只有第二条对第三方插件可靠:

1. **`settings.plugin.item`(keyed by ns)—— 行不通**。表面上写着"插件自己提供那张卡",
   但「插件配置」标签页的实现是把 slot 注册表与**宿主自己的命名空间清单交叉比对**来决定
   渲染谁(`new ConfigurablePluginsTabController(settingsScope.describe(), () => slots.entries("settings.plugin.item"))`),
   插件拿不到那套过滤依据 —— **实测:卡注册进去了,那一页里仍然不出现**。
2. **自己贡献一个 `settings.section`(走这条)**。宿主自己的功能页(「Agent 预设」等)
   就是这么做的,设置左侧直接多一项,**不依赖任何枚举**:

```
ctx.slots.inject('settings.section', () => ctx.slots.register(
  { name: 'settings.section', id: 'galfree', order: 40, label: () => 'GALFree' },
  ChannelSettingsSection))
```

写入走宿主既有的一套:读 `ctx.settingsScope.describe()` 的共享镜像拿「当前值 + revision」,
保存时提交 `ctx.remote.settings.mutate(ns, ops, revision)`(`ops` = `{op:'set',path:[field],value}`
或 `{op:'unset',path:[field]}`;revision 围栏保证并发改动被拒而不是被静默覆盖),成功后
`describe.acceptView(response.value)` 把应答折回镜像。渠道配置**长在设置里,不在工作台面板里**
—— 面板里再开一处渠道配置面就是第二真相面(不做)。

**镜像是宿主持有的,读它得到的对象身份不保证稳定。** 表单把镜像同步进 React 状态时
必须**按内容比对**(内容没变就返回原 state),否则「渲染 → setState → 渲染」会自锁成死循环:
页面看着还在,按钮点不动(靠渲染回路里的点击超时才发现的那个 bug)。

**能力声明是"协议不合要如实降级"的唯一依据**:

```
capabilities: { textToImage, imageToImage, referenceChain, aspectRatioParam, b64Json }
```

目录缺省口径:**文生图/尺寸参数/b64 缺省为真**(v1 的目录绝大多数是 OpenAI 兼容文生图端点),
**参考链/图生图缺省为假** —— 能力宁可少说,不能凭空许诺。`imageModels(channel)` 只列
声明了文生图的模型(聊天/嵌入模型不进这个列表)。

### 模型发现:只填 URL 与密钥(T14 续)

配置成本压到最低 —— 人只填**端点 + 密钥**,其余自动:

- `POST /channel/models {baseUrl, apiKey}` → `{models[], total, endpoint}`。走**注入的出网端口**
  (`GET {base}/models`,OpenAI 兼容形状);密钥由请求体带过来,**不落任何地方**,只用于这一次出网。
  未装配端口 → 503 `discovery-unavailable`(面板如实说"这台宿主没装配",不假装拉到空清单)。
- **能力推断在接缝**(`src/service/discovery.ts`,纯函数):已知家族按实测/文档给并标**确定**;
  没认出来的按**保守默认**(只文生图 + 尺寸参数 + 内联返回)并标**待确认**,面板显示
  「能力待确认」提示人去勾。**参考链是最少见的一档,默认一律不开** —— 没验过的能力开出去,
  上游不认、任务会失败,而失败本该可以避免。
- **非图像模型不隐藏**(嵌入/语音/聊天只排到清单末尾并标「不像图像模型」):模型命名千奇百怪,
  藏起来人就没法手选,最后兜底的还是人。
- **列表 ≠ 目录**:清单 = 上游拉到的**全部**模型(每个都带勾选框);目录 = **被勾上的那些**。
  (第一版把"已选中的模型"当成列表本身,没勾的模型根本不显示 —— 界面看着能用,实际只能勾到
  已经勾过的东西。这条语义别再写错。)
- 面板里的模型选择器(`src/client/model-picker.tsx`)只管界面;拉取与推断全在接缝。

**渲染自锁的坑(踩过两次,同一个形状)**:勾选回调改 `imageModels` 文本 → 文本变化又反过来
同步清单 → 若同步无脑 `setState(新数组)`,每次渲染都触发下一次渲染,主线程被占死
(**界面看着在,按钮点不动**)。凡"外部状态 ↔ React 状态"双向同步,都要**按内容比对**,
内容没变就返回旧引用(`sameRows` / `sameScope`)。

### 两种上游协议(实测后补的第二种)

模型目录里的 `adapter` 决定走哪种协议 —— **声明而不是猜**:

| adapter | 形状 | 端点 |
|---|---|---|
| `openai-compatible`(**默认**) | 同步:一次调用直接回图片(`data[0].b64_json`) | `POST {base}/images/generations`(**复数**) |
| `async-task` | **异步任务制**:提交回 `{task_id,status:'queued'}` → 轮询到终态 → 终态给 `result_url` → 再取二进制 | `POST {base}/image/generations`(**单数**) |

`async-task` 的可选字段(都有默认值;面板写目录时会把路径一并写死,免得人记):

```
adapter: "async-task",
paths:  { submit: "/image/generations" },
async:  { submitPath, pollPath: ".../{taskId}", pollIntervalMs: 3000, pollMaxAttempts: 60,
          successStatuses: ["SUCCESS", ...], failureStatuses: ["FAILURE", ...] }
```

三条**如实报**的硬规矩(都在 seam 测试里钉住):
1. 上游明说失败 → `fail_reason` 原话进任务历史;
2. 轮询到上限还没终态 → "上游没在时限内给结果",**附最后一次状态**(不是干说"超时");
3. 终态给了 URL 但图取不到 → 算失败并说清,**不落空文件**。

**协议错配要给可执行的指引,不能只说"失败了"**:同步适配器撞上 404 会提示
"提交路径可能是单数 / 该换成 async-task";同步适配器收到"任务形状"的应答会直说
"上游回的是任务,请把 adapter 改成 async-task"。这两条都是被真实的 404 教出来的。

**写网关的二进制结论在这里又一次兑现**:异步终态给的是 URL,取回来的字节与同步适配器
的 b64 走**同一条落盘路**(`WriteOp.content: Uint8Array`),同一个写批、同一份快照 ——
协议不同不影响"产物一律经网关"这条铁律。

### 任务 = 一级结构化对象

落 `.studio/image-tasks.json`(经网关 → 自动快照)。字段:`id` / `slot` / `outputPath` /
`state` / `channel` / `model` / `prompt` / `requiresCharacters` / `artStyleAnchor` /
`size` / `quality` / `referenceImages` / `degradation?` / `attempts[]` / 时间戳 / `lastError?`。

- **状态机**:`queued → running → awaiting-review | failed`。`failed` 不会被队列自动重跑
  —— 重试是人的动作(`retryGenerationTask`),不是自动重试循环。
- **重试历史 = `attempts[]`,只追加**:每次尝试记 `{n, startedAt, finishedAt, outcome,
  error?|fingerprint?+bytes?}`。失败把**上游原话**带进 `error`(状态码 + 它说的那句话)。
- **`outputPath` 恒等于槽位的约定路径**(`slotAssetPath(slot)`,见 `slot-naming.ts`):
  出图不能对着一个不存在的槽写文件,否则产出永远是悬空引用 → 建任务时校验槽在
  `.rpy` 派生的清单里,不在则 **`unknown-slot`**。
- `prompt` 是**制作信息**(给上游的指令),不是叙述内容 —— 铁律照旧:账本里没有台词/正文。

### 降级:改了参数就必须说(AC3)

`degradeInput(model, input)` 把"人要的参数"收敛成"上游能收的参数",每一次收敛都记进
任务的 `degradation{code,message,droppedReferenceImages[],notes[]}`:

- 不支持参考链 → 丢参考图 + 说明"本次按文生图发出"(这是最容易让人误以为
  "跨批次同一张脸"生效的地方,不能含糊);被丢的参考图**列出来**,让人确认丢了什么;
- 支持参考链却声明不支持图生图 → 按**目录自相矛盾**如实报,不挑一个默默用;
- 不支持尺寸参数 → 不发 `size`,说明改用了模型默认档。

**降级不是失败**:任务照常跑完。没有 `degradation` 字段 = 请求原样发出 ——
不存在"改了但不说"的第三种。

### 执行在 Host 侧

`runGenerationTask(ref,id)`:置 `running` → 出网 → 解码 → **经网关落盘**(`reason:'slot'`,
自动快照)→ 记账 `awaiting-review`。落盘后槽位的"已填"推导立刻变绿,板不需要任何人上报;
失败不产半成品。`runGenerationQueue(ref)` 串行推进所有 `queued`;
`createTasksForMissingSlots(ref,{model})` 把板上"待填"的槽展开成任务集
(展开依据是**推导**,不是人维护的待办表)。

**出网是可注入端口**(`ImageHttpClient`):生产 `createNodeHttpClient()`(原生 fetch),
快带注入打到**本地假 HTTP 上游**的实现 —— 同一个端口的两个实现,协议形状不因测试而变。

### 戳的生命周期(复用 T6,没有新机制)

产物落盘后槽位是 `filled + stamp:'pending'` → 板显示「待复审」;人盖戳 → `approved`;
重生成覆盖写 → 指纹变化 → 旧戳自动变 `stale`(待复审)。`SlotProgress` 新增
**`awaitingReview`**(纯推导:`filled && stamp !== 'approved'`),面板与 T15 的待复审队列
都读这一个布尔,不在适配器里重算规则。

### 路由

- `GET /channel` → `{configured,name?,baseUrl?,apiKeyConfigured,models[]}`(**无密钥**)
- `GET /tasks` → `{tasks[]}`(最新在前)
- `POST /tasks/create` `{slot,model,prompt,size?,quality?,referenceImages?,run?}` → 201 `{task}`
  (缺省 `run:true`;`run:false` 只入队)
- `POST /tasks/fill-missing` `{model,prompts?,run?}` → 201 `{tasks[]}`(待填槽 → 任务集)
- `POST /tasks/run` → `{tasks[]}`(推进队列里排队中的)
- `POST /tasks/retry` `{id,run?}` → `{task}`(保历史,追加一次尝试)

错误码:`no-image-channel` = 503(能力未就绪,与 SDK 未就绪同性质)、
`unknown-image-model` / `unknown-slot` / `invalid-slot` = 400、`unknown-task` = 404。

**工作台的出图动作面属 T15**(T14 只把账本与队列做出来)。

## 出图操作与素材板动作面(T15 之后追加)

**动作面与 agent 工具面是同一条队列、同一份推导** —— 这是 T15 的 AC3,也是结构保证:
两边都只是 `ProjectService` 的搬运工(面板经 `/tasks*` 路由,agent 经 5 个工具),
没有"面板专用的状态",也没有"工具专用的账"。

| 动作 | 面板 | agent 工具 | 接缝 |
|---|---|---|---|
| 看渠道与模型 | 素材板工具栏 | `galfree_image_channel` | `imageChannel()` |
| 看队列与重试历史 | 槽行徽标 + 「历史(n)」 | `galfree_art_queue` | `generationTasks()` |
| 生成此槽 | 槽行「生成此槽」 | `galfree_generate_image` | `createGenerationTask()` |
| 补全全部待填 | 工具栏「补全全部待填(n)」 | `galfree_fill_missing_art` | `createTasksForMissingSlots()` |
| 只重 roll 该槽 | 槽行「重 roll」(+ 改词框) | `galfree_reroll_image` | `retryGenerationTask()` |

**重 roll 保留上一产物为历史(可对比)。** 覆盖写之前,把"正在被替换的那一版"的指纹记进
本次尝试(`attempt.replacedFingerprint`)。文件必然被覆盖(槽位的约定路径只有一个),
但旧内容留在**写批前的快照**里 —— 有了指纹就能对上是历史上哪一版,`snapshotHistory` 与
回滚都能用。所以"可对比"不是口头承诺,是有据可查的。

**改词重 roll**:`retryGenerationTask(ref, id, {prompt})` —— 面板的「重 roll」输入框与
agent 的 `galfree_reroll_image {prompt}` 走的是同一个入口("把小棠的怒颜重 roll 得更夸张"
就是这么落地的)。给了空字符串则**拒绝**(要么不给=沿用原词,要么给一句能用的)。

**"补全全部"先过渠道与模型两道门,哪怕一个槽都不缺。** 这里修过一个**静默失败**:
早先校验写在"遍历待填槽"的循环里,于是"没配渠道 + 槽刚好都填满"会静默返回空数组 ——
人以为补全跑完了,实际一个任务都没建。静默失败比报错坏得多。

**面板的进度是推出来的**:有任务处于 `queued|running` 时按 2.5s 轮询 `/tasks` 并重取推导,
不在面板里攒状态。失败原因、降级说明都按接缝原话显示,不美化。

## 参考链一致性回路(T16 之后追加)

跨批次"同一张脸"原本只是**声明**:登记簿里有 `references`,任务参数里有 `referenceImages`,
但没有任何东西把这两端接起来。T16 接上这一条,并把它做成可核查的处境。

### 链从登记簿自动来,不从人手抄

建任务时 `referenceImages` **没显式给**就从登记簿推导(`resolveReferenceChain`,纯函数):

- 槽账本的 `requiresCharacters` → 各自登记簿的 `references`(顺序 = 人挑的顺序,按路径去重);
- **自引用被排除并标注**(槽把自己的产物当参考 = 循环,`excludedSelf` 如实列出);
- **文件不存在的参考发不出去** → 进 `missing`,由降级机制如实记账。

于是"主视觉 → 表情/姿势差分"不再靠人手抄路径:人把主视觉**登记进链**(面板角色视图 /
`upsertCharacter`)之后,这个角色所有差分的任务都会自动带上它。

### 链上的图以**内联字节**发出

远端的 `image_url` 要的是可取的地址,而链上的图是**项目内的文件** —— 一个
`game/images/x.png` 对面什么也取不到。因此发送前把字节内联成 data URL
(`WriteGateway.readBytes` → `dataUrlOf`,与 b64 内联同一条口径)。

- 账本里存的仍然是**路径**(引用),图片内容只在这一次出网里出现,不落 `.studio/`;
- 建任务时筛过一遍"文件在不在";跑的时候若发现它**中途被删了**,如实报错(少发一张
  而不吭声,就是"链看起来生效了其实没有")。

### 差分批量:顺序由引用关系派生

`createDifferentialTasks(ref,{character,model,run?})` —— 把一个角色还没出图的槽一次补齐。
它与 **"补全全部待填"共用同一条闸门**(`#createOrderedTasks`),规矩因此是同一套:

| 规矩 | 为什么 |
|---|---|
| 出图顺序 = **被引用者先出**(`sortSlotsByReference`) | 主视觉先落地,差分才有锚。依据是"谁的产物出现在别人的链里",**不是**槽名里带 `base` |
| `run:true` 时**建一个跑一个**(不是先建齐再统一跑) | 差分建任务时主视觉已在磁盘上,链才是真的。先建齐的话,差分建任务那一刻主视觉还不存在,会被如实标成 `reference-missing` —— 诚实但回路没闭合 |
| 三道门先过(渠道 / 模型 / 角色在登记簿),**一个槽都不缺也要拦** | "看着跑完了其实什么都没做"是最坏的一种失败 |
| `run:false` 只入队 | 链按**建任务那一刻**的磁盘状态解析,主视觉没出时差分会被如实标成缺链(不假装) |

`createDifferentialTasks` 默认 `run:true`(这条回路的全部意义就是顺序执行);
`createTasksForMissingSlots` 保持 T15 的默认(只入队,由 `/tasks/run` 推进)。
**提示词的家是槽账本**(`.studio/slots.json`),所以两条批量都不接受 `prompts` 覆盖 ——
要单独改词用 `galfree_generate_image` / 「生成此槽」,不开第二个入口。

### 降级:改了参数就必须说(纪律不变,多一条来源)

`degradeInput` 现在多认一摞 `missingReferenceImages`(此刻磁盘上还没有的):

- 模型不支持参考链 / 目录自相矛盾 → 原规矩(能力是第一判据,`requested` 才是"人要发的");
- 能力够、但**某张文件不存在** → `code:'reference-missing'`,被丢的那张列进
  `droppedReferenceImages` 并说明"先把它出出来(或从参考链里去掉)"。

降级照旧**不是失败**:任务跑完,事实记在任务上,人和 agent 都读得到。

### 拒收注记:变了的是"为什么重 roll"

`GenerationTask.rejections[]`(**只追加**):`{attempt,fingerprint?,note,via:'human'|'agent',at}`。

- `retryGenerationTask(ref,id,{note,via})` 追加一条,并指向**被拒的那一版**(尝试号 + 产物指纹)
  —— 不是一句无主的话;
- 空注记(`'   '` 或 `''`)→ `empty-note`;超长(> `MAX_REJECTION_NOTE_CHARS` = 600 字)→
  `note-too-long`。**要么说清为什么,要么别记**(静默记一条没理由的"打回"对下一个看历史的人毫无价值);
  这两个码与 `unknown-character` 一起归 400(请求体不合法),不是 500;
- `via` 是历史的一部分:工作台记 `human`,agent 替人转述记 `agent`(人的话别记成 agent 的话)。
  缺省方向是 **`human`** —— 拒收注记本质上是人的判断,忘了标也不会把人的话记成机器的话;
- 注记是**制作信息**(脸太圆/眼神太凶),长度上限与设定卡字段同一把尺子但**单独取名**
  (`MAX_REJECTION_NOTE_CHARS`),不许把剧本抄进来。

### 对比视图:渲染自登记簿 + 槽位历史

`differentialGrid(ref)`(纯读,**不产生任何写**;快带里以网关写日志不变为断言):

```
DifferentialRow = { character, name, styleAnchor?, references[{path,exists,slot?,note?}], main, cells[] }
DifferentialCell = { slot, assetPath, role:'main'|'variant', filled, stamp, awaitingReview,
                     fingerprint, taskId?, history[{taskId,n,outcome,fingerprint?,replacedFingerprint?,error?,rejection?}],
                     degradation?, lastError? }
```

- `role:'main'` = **登记簿的参考链指到了这一格的产物**(登记簿指认,不是槽名启发式),
  `main` = 那一格的槽名(没指认出来 = `null`,面板显示"没有主视觉");
- `history` = 该槽**全部任务**的尝试史(按任务创建时间老→新接起来,每条带着 `taskId`)——
  不是"最近一个任务":同一格可能先后建过多个任务,只取最近一个会让旧任务上的**拒收注记
  从视图里消失**,而那恰好是 AC3 要能回读的东西。`cell.taskId` 才是"重 roll 从哪个任务走";
- 版本谱系靠 `replacedFingerprint` 串起来:当前版与"被它替换掉的那一版"能对上号,
  旧内容留在写批前的快照里(`snapshotHistory` 可回看/回滚)。

### 路由与工具面(与接缝同源)

| 路由 | 语义 |
|---|---|
| `GET /reference-chain?slot=` | 链处境:就绪/缺图/自引用(纯读);缺 slot = 400 |
| `POST /tasks/differentials` `{character,model,run?}` | 差分批量 → 201 `{tasks}`(提示词取槽账本) |
| `GET /differentials` | 同角色差分网格(纯读) |
| `GET /asset?path=` | 素材**字节**(只读):`content-type` 按后缀,`ETag` = 内容指纹,`cache-control: no-cache`(重 roll 换图后旧图不许赖着)、缺文件 404 + `asset-missing` |

`POST /tasks/retry` 多认一个 `note`(面板带 = `via:'human'`)。

agent 工具面新增两个、扩了两个:**`galfree_character_art`**(差分批量)、
**`galfree_reference_chain`**(链 + 网格;`references` 给了就**写链** —— 那是设定改动,
与登记角色同级,不是主观认可)、`galfree_reroll_image` 多一个 `note`,
`galfree_art_queue` 多回 `rejections` 与每次尝试的 `rejection{note,via,at}`。

写链走 `upsertCharacter`(origin `agent`、自动快照),整条替换;**不给空链入口**
(要清空得说清楚,免得"我改了一条"变成"链没了")。

### 真上游验证(慢带,默认不跑)

`src/service/live-chain.slow.test.ts` —— 把"`referenceChain: true` 这条声明"拿到真上游面前对一次。
T14 起契约里"能力声明是降级的唯一依据"一直靠一个**从未被真模型验过的声明**在跑,这条慢带就是补这个。

- 只在给了 `GALFREE_LIVE_BASE_URL` / `GALFREE_LIVE_API_KEY` / `GALFREE_LIVE_MODEL`
  (可选 `GALFREE_LIVE_ADAPTER`、`GALFREE_LIVE_REFERENCE_FIELD`)时跑;
  **没给就跳过并出声**(打印怎么跑),不静默通过;
- 它断言三件与上游态度无关的事:①链**真发出去了**(记录型出网客户端看到请求体里内联的字节,
  且解出来正是主视觉那张);②文生图基线**真通**(端点/密钥/模型/协议有一样不对就红);
  ③结论**如实**(`awaiting-review` ⟺ 文件在且是 PNG;`failed` ⟹ 原因非空且是上游原话);
- 上游**不接受**这条链时,它不改判成"通过",而是把上游原话打印出来并明确报告:
  该模型的 `referenceChain` 声明**未被证实**。这是这条慢带存在的意义,不是它的失败。
- **它花钱**(真出 2 张图),所以默认不跑。

#### 实测记录:用户渠道(seedance / `zhenzhen-image-g-v2.5-flare`,2026-09-12)

| 观察 | 上游原话 | 结论 |
|---|---|---|
| 文生图 | — | **通**(产物落盘、是 PNG) |
| 参考图发**数组** | `400 invalid_request: json: cannot unmarshal array into Go struct field .Alias.image of type string` | 这个网关的 `image` 字段是**单个字符串** → 目录里要声明 `"referenceField": "string"`(面板:模型行的「参考图字段」) |
| 参考图发**内联 data URL**(改对形状后) | `400 invalid_parameter: images must contain public HTTP(S) URLs` | 它**只收公网可取的 HTTP(S) 地址**:内联字节与项目内路径都不收 |

**因此**:对这类上游,`referenceChain: true` 这条声明**在当前实现下达不成** ——
参考图是项目内的本地文件,插件拿不出公网地址。诚实的做法是**把该模型的「参考链」关掉**:
任务会在建的时候就如实降级("参考链被丢弃,本次按文生图发出"),而不是每次出图撞 400。
要让链真正生效,需要"公网可取的地址"这一环(上游自带的文件上传接口 / 用户自己的图床),
那是**下一张票**的事,不是把内联换成别的东西就能绕过去的。

对应的三条**可执行指引**已经焊在适配器里(`protocolHint`,都被真实拒绝教出来):
404 → 可能是单数路径、该换 `async-task`;数组进了字符串字段 → 去设置改「参考图字段」;
要求公网 URL → 说清"该模型的参考链在你的渠道上不可用",并给出下一步。

## 音频接线(T17 之后追加)

**v1 的音频 = 把 BGM/SE 文件接进剧本**,没有音乐生成、没有 TTS(spec User Story 18 与
Out of Scope 都写明)。试听由**试玩**承担,主观认可由**人盖场景戳**表达 —— 面板里没有播放器,
这一票也不打算加一个。

### 池是派生的:丢文件进去就能选,没有手工登记

`audioPool(ref)` / `GET /audio`:

```
AudioPoolView = {
  files:      [{ path, bytes }]        // game/ 下的音频文件(递归),path 相对 game/
  references: [{ ref, action, channel, scene, file, line, snippet, found, resolved? }]
  missing:    AudioReference[]         // 引用了但池里没有的
  unused:     string[]                 // 池里有、没人引用的(**信息,不是 lint 噪声**)
}
```

- 池成员 = `game/` 下后缀在 `AUDIO_EXTENSIONS`(ogg/oga/opus/mp3/wav/m4a/flac/aac)里的文件;
  `cache`/`saves`/隐藏目录不扫。**`.studio/` 里没有音频账本** —— 文件删掉,池自己空掉,
  不存在"取消登记"这种动作(与槽清单同一态度:推导的,不是人维护的)。
- `references` 只收**带文件的引用**(`play`);`stop <channel>` 不带文件,不是对文件的引用。
- 菜单选项体里的 `play` 也算引用(那同样是会响的接线)。
- **`GET /progress` 额外给出 `audio`**(同一份池视图:files / references / missing / unused;
  悬空引用已经并进 `problems`)。面板读它,不另开第二处真相;`GET /audio` 是同一个接缝方法的
  按需读法(编辑器打开/刷新时取最新的一份)。
- **观察**:池本身不监听 —— 它由"网关观察 → SSE → 面板重取推导 → `progress.audio` 变 →
  编辑器重读"这条既有链路看见。面板拿池的**成员版本键**(路径清单拼的,不是内容哈希)
  做依赖,所以人拿外部工具往 `game/audio/` 里丢文件,编辑器自己就会多出那一项。读不到池
  时面板显示"音频库读不到"(不把失败画成"一个文件都没有")。

### 引用口径就是 Ren'Py 的口径(从钉版 SDK 源码读出来的)

`play music "audio/rain.ogg"` 里的字符串是**相对 `game/` 的路径**:

- `renpy.py:predefined_searchpath()` 给的默认 searchpath 只有 `renpy.config.gamedir`(即 `game/`);
- `config.search_prefixes` 默认是 `[""]`(SDK `config.py:673`)。

所以**不存在"自动在 `audio/` 里找"这回事**:`"rain.ogg"` 只在文件真是 `game/rain.ogg` 时才算数。
校验因此既不误报也不漏报 —— 而**误报比漏报更糟**(板会天天喊狼来了)。
匹配先精确、再大小写不敏感(Windows 的文件系统就是这样的,在那上面报"缺失"是假阳性);
大小写不一致时池照常认它,`resolved` 给出真实路径。

### 悬空引用 = error,定位到"哪一场的哪一行"

`deriveAudio()`(纯函数)从场景与池推出 `missing-audio`(**error**):
`场景 <label> 要播「<ref>」,但 game/<ref> 不存在…`,带 `file` + `line` + `snippet`。
它与槽的悬空引用同一条路数:**进 `progress.problems` → 进板**,文件一放进去问题自己消失。
编辑报告(`editScene`)也当场带上这一条 —— 不必等下一次刷板。

`unused` 只是**信息**(丢进来还没接线是正常工作顺序,不该每次报错),面板以徽标呈现。

### 接线写在 `.rpy` 里,写批照旧

- 表单编辑新增 `SceneEdit.setAudio { line, action, channel, file, loop }` →
  `serializeAudio()` 产出 `play <channel> "<file>" [loop]` / `stop <channel>`,
  **缩进跟原行**(与 T11 的最小化 diff 同一条纪律);
- `play` 不给文件 → 接缝拒绝(`invalid-audio`,400):宁可不写,也不落一行 `play music ""`;
- 走 `editScene` → **经网关 + 自动快照**(AC3),与别的编辑没有第二条路;
- 表单行模型带 `action`,**`stop` 行不会被编辑动作悄悄变成 `play`**(round-trip 保真)。

面板:音频行给 动作 / 声道 / 文件(`<datalist>` 列池里的路径)/ `loop`;
场景卡上三枚徽标 —— 音频库个数、缺音频(红)、没用上(灰)。

### 慢带:真引擎认不认

`src/service/audio.slow.test.ts` —— 一段真接了 BGM/SE 的剧本过**真钉版 SDK lint** 且判干净,
池与真磁盘一致(删文件 → `missing-audio` 立刻上板)。方言子集契约要求"扩语法要过慢集成带验证",
这条就是音频语法的那个证据:**我们自己解析得对 ≠ 引擎认**。

### 已知边界(这一票**没有**覆盖的,别当成"已经管了")

1. **只有子集内的形态会被校验**。`play <channel> "<文件>" [loop]` 之外的一切
   —— `play music "x.ogg" fadeout 1.0`、`queue`、放在 `if`/`while`/`for` 块里的 `play`
   —— 都落在方言子集之外:那一场**整场只读降级**(warning),语句根本没进 `references`,
   所以也不会额外报 `missing-audio`。这是**如实**的(板说的是"这一场我看不懂"),
   但不是"引用已校验"。扩张子集要按方言子集契约走:改 `dialect-subset.md` + 解析器 + 模板,
   并过慢集成带 —— 那是**另一张票**。
2. **池是磁盘真相当下的读**(与槽的悬空引用同一口径),不是从写网关的版本索引推的:
   网关管的是**写**,不是"项目里现在有什么"(ADR-0003 磁盘为真相)。
3. **`voice` 声道照解析器如实呈现**(`play voice …` 在子集里),但 v1 **不生成任何音频**:
   没有音乐生成、没有 TTS,试听靠试玩。

## 本地发布(T18 之后追加)

**一键把项目打成可发行物**(spec User Story 19):钉版 SDK 的 `build_dists`,默认 `pc` 包
(Windows + Linux)。平台上传与在线分发**不做**(spec Out of Scope)—— 这一票只把产物放到
磁盘上,并把路径与状态说清楚。

### 构建命令的形状(从钉版 SDK 源码读出来的)

`distribute` **不是引擎内置命令**,它由 **launcher 项目**注册
(`launcher/game/distribute.rpy:1833`)。所以调用形状是:

```
renpy.exe <SDK>/launcher distribute --destination <输出目录> --package <包名…> <项目目录>
```

- `--destination` 支持绝对路径(相对路径是相对**项目父目录**,见 `distribute.rpy:642`),
  我们一律给绝对路径;
- 默认包名 `pc`(`renpy/common/00build.rpy`:PC = Windows + Linux);Android 要另配 Android SDK,
  属于"可选",由调用方给 `packages`。
- Windows 上这里 `windowsHide: true` 是对的(命令行构建不该弹窗)—— **与试玩那条相反**
  (试玩必须让游戏窗口出现在人眼前,那一课写在 `playtest.ts` 的注释里)。

### 前置检查:用板上的判断,不另算一套

`publishReadiness(ref)` / `GET /publish` 给出 `{ready, blockers[], destination, packages}`,阻塞项来自
**同一份 `progress()`**:

| code | 触发 |
|---|---|
| `publish-unavailable` | 这台宿主没装配发布端口(能力未就绪 = 503,与"没配渠道"同性质) |
| `sdk-not-ready` | 钉版 SDK 未就绪(没有构建器) |
| `lint-errors` | 板上有 error 级问题(悬空跳转、孤立场景、结局不可达…) |
| `missing-slots` | 还有没填的素材槽(空槽发出去就是灰底) |
| `missing-audio` | 音频引用悬空(那一段会静默没声音) |
| `build-identity-missing` | 项目没声明 `build.name`(包名与主程序名会是空的 —— 见慢带那两条) |
| `gui-images-missing` | 界面图还没生成(先在 SDK 里跑一次试玩) |
| `destination-in-project` | 输出目录配到了项目源树里(见下) |

后两条只在**装配了发布端口**时才算(没端口就没得发,先报那一条)。

**前置没过就不构建**(`publish()` 返回 `ok:false` + 逐项缺项),不产出半成品 ——
"宁可不发,也不出一个缺素材的包"。板说缺、发布说能出,两边迟早分叉,所以这里只读板。

### 产物落在项目源树之外(可配置)

- 输出目录 = 设置里的「发布输出目录」+ `<项目名>`;留空 = **数据目录下的 `publish/<项目名>`**。
- 配到项目里面 → 如实拒绝(`destination-in-project`):源树是唯一真相,不是构建垃圾场
  (产物进了项目,`git status` 就再也不干净,"改了什么"也看不清了)。
- 快带以 `git status --porcelain` 为空 + 项目根下没有 `dist*` 目录为断言。

### 产物清单:比对目录,不猜文件名

构建前后各扫一遍输出目录,`artifacts` = **这次真的多出来的文件**(名字 + 绝对路径 + 字节)。
猜 `<name>-pc.zip` 这类命名,在换包名/换版本号时会静默漏报。

### 事实与新鲜度

一次发布 = 一条 `.studio/publish.json`(`{at, ok, packages, destination, artifacts, exitCode,
logTail, fingerprint}`,history 留最近 20 条),经网关写 → 进快照(记录的是**路径与状态**,
不是产物本身)。`progress.publish` 由账本 + 当前内容指纹推导:

- 没发布过 = `null`(如实,不是"发过了但是空的");
- 内容在发布之后又变了 → `stale: true`(产物代表的不再是当前这一版);
- 构建失败 → `ok:false` + `logTail`(上游原话,不吞成"失败了")。

### 路由与工具面

| 路由 | 语义 |
|---|---|
| `GET /publish` | 前置检查 + 上次发布的推导视图(纯读) |
| `POST /publish` `{packages?, outputDir?}` | 一键发布 → 200 `{report}`;没装配端口 → 503 `publish-unavailable` |

agent:**`galfree_publish`**(`readiness_only:true` 只看前置;给了 `packages` 就构建),
`galfree_project_status` 多一段 `publish`。

### 慢带:产物主程序真能启动(AC3)

`src/service/publish.slow.test.ts` —— 真项目 → 前置就绪 → **真 `build_dists`** →
产物在项目之外且 > 1MB → 解压 → 找到包里的主程序 → **启动它、进程活着、没有 traceback** →
杀掉;顺带断言项目里没有 `dists/`。这条慢带存在的理由很直白:
**构建命令退出码 0 ≠ 打出来的东西能跑**(lint/compile 对启动期错误都返回 0 的教训,同一个形状)。

### 这条慢带抓出来的两个**真模板缺陷**(都已修,别再踩)

| 现象(实测) | 根因 | 修法 |
|---|---|---|
| 包名 `-pc.zip`、主程序 `.exe` | Ren'Py 的 `build.name` 缺省是 `None` → `directory_name`/`executable_name` 全空(`renpy/common/00build.rpy`) | 模板的 `options.rpy` 写 `define build.name = "<项目名>"`;发布前置新增 `build-identity-missing` 拦老项目 |
| 启动即 `ModuleNotFoundError: No module named 'gui7'` | 模板从 SDK 拷的 `guisupport.rpy` 里有一段 `init 100 python in gui:` 会 import **gui7**(它只住在 `<sdk>/launcher/game/`)来生成界面图 —— 发行版里没有 SDK | 界面补丁里 `build.classify("game/guisupport.rpy"/".rpyc", None)` **发行版排除**它,`gui.scale` 由补丁自己提供;在 SDK 里跑照常生成界面图 |

两条附带结论,都写进代码注释了:

- **只排 `.rpy` 等于没排**:跑的是编译出来的 `.rpyc`(我第一次就是这么栽的);
- **别用"项目里放一个空壳 gui7"这条歪路**:Ren'Py 的导入钩子优先解析 `game/` 下的模块,
  空壳会把**真的 gui7 也挡住**,于是"在 SDK 里跑"这条路上的界面图生成同样挂掉(试过、错)。

界面图本身(`game/gui/*.png`,含哨兵 `textbox.png`)是 Ren'Py **首次运行时**生成进项目的,
所以发布前置新增 `gui-images-missing`:**先在 SDK 里跑一次(`试玩`),界面图会像别的素材一样
落进项目并进快照,再发布**才是完整的。

## agent 流程指引(T19 / #27 之后追加)

新会话原先只拿得到**工具的名字与描述**(`src/service/tools.ts`)+ 推导看板:没有顺序、没有完成判据、
没有"哪一步必须请人"。它能"走错时被纠正",但不被"带着走"。T19 往会话的 system prompt 注入一段
playbook(`src/service/playbook.ts`)。

### 一段 section:名字固定、位置固定

| 项 | 值 | 理由 |
|---|---|---|
| section 名 | `galfree-workflow` | 宿主里唯一(重名注册会抛) |
| order | `4900` | 第一方工具段(1000–2900)之后、生成的工具 SDK(5000)之前:紧挨工具说明读起来才顺,又不会被那一大坨参考淹掉 |
| 文本 | **每次组装现算**(`text: () => …`) | 工具面是可选席位、可能晚于本段就位;固化成字符串就会报一个那一刻并不存在的入口 |
| 装配 | `ctx.inject(['systemPrompt'], …)` | 与工具席位同一个态度:宿主没有这个席位就少一段提示 —— **插件不崩、工具照常**(面板与路由照旧) |

### 判据与闸门**不抄第二遍**:指到接缝的真字段 / 真错误码

每一步的"做完了"写成**推导板上的字段路径**(`BoardCriterion.path`,如 `summary.missingSlots` /
`playtest.state` / `publish.stale`),闸门写成**接缝真的会抛的码**(`GATE`,`src/service/gates.ts`)。于是:

- 指引里**没有**"8 个槽""5 场戏"这种会过期的数 —— 要数字就读板;
- `gates.ts` 是这几个码的**唯一出处**:接缝在抛它(`project-service` / `playtest` / `publish` /
  路由的状态码映射),指引在讲它 —— 改一处两边一起改。它**只收指引会讲到的那几道闸门**,
  不是"所有错误码的字典";
- **每一环都有闸门**,包括第一环(一部都还没有时,工具只会让你先去建一个)。闸门分两族:
  *接缝抛的拒绝*(有码,点名)与*不是拒绝的那种*(发布那格是 `blockers[]`,不是一个码 ——
  那就把**形状**讲清楚,绝不编一个码出来);
- 守卫(`src/service/playbook.test.ts`)拿一个**真项目**推导出来的快照逐条解析那些路径
  (字段改名就红),并**真去撞**每一道有码的闸门、拿接缝实际抛出来的码跟文本比对
  (闸门没拦住也算红);没有码的那道(发布)则验接缝**真的会拦**(`readiness.ready === false`
  且 `blockers` 非空)。

### 工具面:只报真的注册了的入口

每一步挂一组工具名,但渲染时**现问** `ctx.tools.get(name) !== undefined`(每次组装问一次,
探针是 `toolPresenceProbe`,与真宿主守卫共用同一个)。于是还没做的环节会如实显示成
"**目前没有 agent 入口** —— 请人在工作台做",而不是报一个调不通的工具名;#28 把工具补上之后,
指引**自动**点名,不用改文本。

> 保守的失败方向:探测不到就**当没有** —— 宁可说"请人做",也绝不能把整段系统提示搞崩。

这一层还有一条**反向**守卫:注册出来的工具名,要么被某一环认领、要么在"查询工具"白名单里
(`galfree_project_status` / `galfree_art_queue` / `galfree_reference_chain`)。**指引里写错一个
工具名会红**,而不是静默变成"没有 agent 入口" —— 那是反方向的谎。

### 真宿主守卫(为什么不能只用假 ctx)

`playbook.test.ts` 最后一组真挂一次 cordis + `dsh-system-prompt` + `dsh-tools`,用**与入口同一条路**
(`ctx.inject([...])` + 同一个 `toolPresenceProbe`)装配,再真 `assemble()` 一次。这一层坏掉的形态
全是"默默坏":段名重了会让整段提示装配失败、排序没进组装、`ctx.tools.get` 看不见**本插件自己**
注册的工具(于是指引谎报"没有 agent 入口")。假 ctx 一个都测不出来,真挂一次只要几十毫秒。

### 红线不变

审读戳(场景 / 素材槽 / 设定定稿)**永远只有人能盖**:指引把这条写成整段话放在显眼处并点名
`stamp-forbidden`,每一环另有"人:"那一行(定稿戳 / 场景戳 / 试听 / 发布取舍);工具面里没有、
也不会有它的 agent 入口。

### 已知边界(这一票**没有**覆盖的,别当成"已经管了")

- **AC1 的现场验收要人做一次**:这条 AC 是"空会话只给一句主题,agent 说得出顺序与下一步",
  它不是快带能自动断言的形态(要么真起一个会话)。已做的:文本可用性用一次**代理实验**看过
  (把这段指引给一个没有上下文的 agent,它给出的正是"先请人建项目 + 写设定集 + 盖定稿戳"
  这条顺序);**真宿主的那一次**要等 `lib/` 重建 + 宿主重启 + 新开会话 —— 那是人的一步
  (与面板的人工验收同一批)。
- **指引只讲流程,不讲台词**:它不替 agent 编剧情,也不改任何接缝判断。

## 模板的界面层(T7 之后补齐的一块,实测换来的)
**新建项目必须整份带上 SDK 的 GUI 模板**(`screens.rpy` / `gui.rpy` / `guisupport.rpy` / `testcases.rpy`),
外加一份**项目内**的中文字体。这不是"锦上添花",是"能不能跑"的问题 —— 下面三条都是实测:

1. **没有 `screens.rpy` → 点窗口关闭按钮直接崩。** Ren'Py 的 `yesno_prompt`(关窗确认)
   只在 `renpy.has_screen("yesno_prompt")` 成立时才挂到 `layout` 上;没有该 screen 时会抛
   `AttributeError: 'Layout' object has no attribute 'yesno_prompt'`。
   后果:**试玩永远以失败收场** —— 游戏跑得再好,一退出就崩。
2. **中文字体必须是"项目内的相对路径"。** SDK 的 `gui.rpy` 把界面字体钉在 `DejaVuSans.ttf`
   (不含中文字形 → 中文全是方块)。补丁改用 SDK 自带的 `sdk-fonts/SourceHanSansLite.ttf`
   (思源黑体,2.77MB,开源可携带)并**拷进项目**。试过直接写绝对路径
   `C:/Windows/Fonts/msyh.ttc`:Ren'Py **静默回退**成默认字体(不报错),中文照样是方块。
3. **`gui.language` 没有 `"chinese"` 这个值。** 写错会在渲染时抛
   `Exception: Unknown language: chinese`,把整个对话屏打崩。合法值是
   `unicode` / `eastasian` / `western` / `japanese-*` / `korean-with-spaces` / `anywhere`;
   中文用 `eastasian`。

界面文件取不到时**如实拒绝建项目**(`sdk-ui-missing`),而且**先取齐模板内容再建目录** ——
拒绝得干干净净,不留"建了一半"的空壳。字体拿不到**不阻断**(补丁会在注释里说明中文会显示成方块):
项目本身是好的,没必要为少一个字体不让建。

另外两件**记录在案的事实**(不在本票范围,但别再对着现象猜):

- **解析范围划界**:方言子集只解析**叙述文件** —— `game/script.rpy` 与 `game/scenes/**`
  (`isNarrativeFile`)。`screens.rpy` / `gui.rpy` / `options.rpy` 是 Ren'Py 自己的界面与配置,
  不按子集解析。实测量过:把它们算进来会一次产出 **265 条 warning**(239 条来自 `gui.rpy`
  的 `init` 块),把板上真正有用的判断整个淹掉。
- **图片名不会自动定义**:现代 Ren'Py 关了 `config.automatic_images`(见 SDK 的 `00obsolete.rpy`),
  `game/images/bg-rooftop.png` **不会**自动成为图片名 `bg rooftop`。素材槽出图落在约定路径上,
  但剧本要用它得显式写一行 `image bg rooftop = "images/bg-rooftop.png"`。
  缺这一行时画面是**灰底 + 图片名**(Ren'Py 的"找不到图"提示,不是图坏了)。
  "出图"到"图上屏"之间这一环留给素材环节的后续票。

## 测试纪律(spec Testing Decisions 落地)

- 只在 `ProjectService` 公共接口上断言外部可观察行为:磁盘终态、推导对象、
  校验结果、(后续)队列事件。不测适配器、不断言内部结构、无 DOM 测试。
- 真 git + 临时目录参与断言;图像上游用假 HTTP;校验快带用假验证器。
- 慢集成带 = `*.slow.test.ts`(`npm run test:slow`):真钉版 SDK lint/compile 冒烟;
  CI 默认跳过,发版前必跑。GUI 启动试玩本身由人经工作台验收(非自动化面)。
- **模板必须有"真启动"断言**(慢带):`lint` 与 `compile` 对启动期错误(例如写错
  config 变量名)**都返回退出码 0** —— 实测。环节零交付的模板就带着两个这种错
  (`config.title` 不存在、布尔写成小写 `true`),用户新建的第一个项目一启动就崩,
  而当时慢带还没跑过一次。所以 `模板真能启动` 这条端到端断言是模板可用性的唯一证据,
  外加一条秒级的静态护栏(快带)。

### 记录在案的一处例外:路由适配层契约测试(环节零之后追加)

`src/service/routes.slow.test.ts` 用真 HTTP 驱动 `makeRoutes`,断言的是**薄适配器
自己的对外行为**:状态码映射、方法守卫、回环 Host 守卫、SSE 帧形状,以及"工作台
实际调用的每个端点都存在"。它**不是**第二个接缝:

- 断言面不碰任何项目逻辑(项目逻辑仍只经 `ProjectService` 断言,见其余 seam 测试);
- 它住在**慢带**,快集成带保持 100% 符合上面的接缝纪律;
- 例外的理由已被现实证明:这一层在环节零期间没人走过,于是"坏 JSON → 500"
  与"项目目录消失 → 500"两个错误映射静默存活到了交付之后。

### 记录在案的第二处例外:插件装配契约测试(T19 之后追加)

T19 往会话的 system prompt 注入一段指引,这带来了两条**住在快带**的适配层断言
—— 上面那条"快集成带保持 100% 接缝纪律"因此被**显式修订**为"除下表两处":

| 文件 | 断言什么 | 为什么不碰接缝纪律 |
|---|---|---|
| `src/service/playbook.test.ts` 的"真宿主装配"组 | 真挂 cordis + `dsh-system-prompt` + `dsh-tools`,真 `assemble()` 一次,断言这一段**进得了组装**、排序在 persona 前后缀之间、`ctx.tools.get` 看得见本插件注册的工具 | 不碰项目逻辑;坏掉的形态全是"默默坏"(段名重了会让整段提示装配失败、排序没进组装、探测看不见自己的工具 → 指引谎报"没有 agent 入口"),假 ctx 一个都测不出来,真挂一次几十毫秒 |
| `src/index.test.ts` 的"插件入口装配"组 | `apply()` 装到一个**最小假 ctx** 上:有 `systemPrompt` 席位就多一段、没有就少一段(插件不崩、路由与工具照常) | 同上;这是 AC3(懒注入)唯一的可自动化的形态 —— 真宿主没有"没有这个席位"的部署可测 |

两条都**不引入新接缝**:接缝仍然是 `ProjectService`;这里断言的是"插件自己装得上"。
下面 T19 那节说的字段路径 / 闸门码同源守卫,断言的仍是真 `ProjectService` 推导出来的
快照与真抛出来的错误码。

若将来要把适配层断言收回到 seam(例如改成只断言接缝抛出的错误码映射),删掉那两个文件即可,
接缝纪律的其他部分不受影响。
