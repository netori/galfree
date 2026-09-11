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

若将来要把适配层断言收回到 seam(例如改成只断言接缝抛出的错误码映射),删掉该
文件即可,接缝纪律的其他部分不受影响。
