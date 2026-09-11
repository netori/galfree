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
| `createProject({projectsRoot,name,title?})` | 模板 → `projectsRoot/<name>/`,经网关落盘 + git init + 初始快照;入注册表并激活 | `invalid-name` `project-exists` `git-init-failed` |
| `listProjects()` | `ProjectInfo[]`(含 `active/missing` 派生标志) | — |
| `getProject(id)` / `getActiveProject()` / `setActive(id)` | 注册表 = 指针表(列表 + 单激活 id);内容不落注册表 | `unknown-project` |

`ProjectInfo = { id, name, title, root, createdAt, active, missing }`。

### 写网关(T2)

| 方法 | 语义 | 错误 code |
|---|---|---|
| `readProjectFile(ref, relPath)` | 现读磁盘 + 版本戳(内容哈希;缺失=`absent`) | `path-escape` |
| `writeProjectFiles(ref, ops[], {origin,reason,scene?,slot?})` | **串行**原子批:先全批 CAS 校验(任一 `expectVersion` 不符 → 整批不落),再落盘(失败回滚),成功后触发快照钩子 + `internal` 事件 | `version-drift` `write-failed` |
| `observeChanges(ref, listener)` | 订阅 `{path,version,kind:'internal'｜'external'}` | — |
| `writeLog(ref)` | 插桩:每条形如 `{path,batchId,version,reason,origin,at}`;"无旁路写"断言源 | — |

### 快照(T3)

| 方法 | 语义 |
|---|---|
| `snapshotHistory(ref, relPath)` | 单文件历史 `SnapshotEntry[]`(真 git;最新在前) |
| `snapshotDiff(ref, relPath, from, to)` | 两版本 diff 文本 |
| `snapshotRollback(ref, relPath, toCommit)` | `git show` 取旧内容 → **经网关写回** → 自动产生回滚快照;历史只追加 |

### 结构解析与校验回路(T4/T5)

| 方法 | 语义 |
|---|---|
| `branchGraph(ref)` | 方言子集派生骨架 `{dialect,scenes,edges,problems,degraded}`;纯函数、幂等、可全量重算 |
| `validateActiveProject()` | `ValidationReport = {ok, problems[], validator:'fake'｜'sdk', at, sdkNote?}`;假验证器 = 子集解析 + 结构规则(悬空跳转/重复 label/缺 start = error) |
| (T5)`SdkProvisioner.ensure()` | 钉版 SDK 下载状态机 `idle→downloading(进度)→verifying(sha256)→extracting→ready`;幂等、可 retry;`probeOverrideSdk` 版本差异 = 警告入状态、不阻塞 |
| (T5)`SdkValidator.validate` | 真 `renpy lint` 映射进同一 `ValidationReport` 形状 |

### 推导进度与审读戳(T6)

| 方法 | 语义 |
|---|---|
| `progress(ref)` | 纯推导快照(无时间戳、幂等):场景视图 `{label,readOnly,missingDialogue,slots[],missingSlots[],stamp,lintErrors}` + `lint` + `playtest` + `summary` |
| `stampRecords(ref)` | 历史戳(含失效者) |
| `stampScene(ref,label,{via})` | 人盖场景戳(记场景内容指纹);`via!=='human'` → `stamp-forbidden` |
| `stampSlot(ref,slot,{via})` | 人盖槽戳;未填 → `slot-not-filled` |

戳失效**判定是推导**:盖戳时存内容指纹(场景 = 语句结构哈希;槽 = 素材文件哈希),
推导时对比当前指纹 → `approved/stale`。任何覆盖写(含外部编辑器)自动"清戳 → 待复审",
无需显式清除动作。

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
  - `GET /state` → `{projects, activeId, tree, activeRoot, activeMissing}`
  - `POST /projects/create|activate` → 201/200;错误 `{error,code}` + 状态码(漂移/越权=409)
  - `GET /progress` → 推导快照;`POST /stamps/scene|slot`(**仅人**经由工作台触发)
  - `POST /playtest` → `{run}`;`GET /sdk`、`POST /sdk/ensure` → 供给状态机
  - `GET /snapshots?path=` / `GET /snapshots/diff?path=&from=&to=`
  - `GET /validate` → `ValidationReport`
- `GET /events`(**SSE**):仅推 `{type:'external-change'}`(外部写观察,100ms 合并;
  网关自写不推)。客户端收到即重拉 `/state`+`/progress`;轮询 8s 兜底。
  后续环节扩展帧型(`batch-committed`、`queue-progress`)保持"事件轻、状态拉"原则。

## 测试纪律(spec Testing Decisions 落地)

- 只在 `ProjectService` 公共接口上断言外部可观察行为:磁盘终态、推导对象、
  校验结果、(后续)队列事件。不测适配器、不断言内部结构、无 DOM 测试。
- 真 git + 临时目录参与断言;图像上游用假 HTTP;校验快带用假验证器。
- 慢集成带 = `*.slow.test.ts`(`npm run test:slow`):真钉版 SDK lint/compile 冒烟;
  CI 默认跳过,发版前必跑。GUI 启动试玩本身由人经工作台验收(非自动化面)。
