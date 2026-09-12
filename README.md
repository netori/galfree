# GALFree(dsh-galfree)

在 DSH 里自动化制作 Ren'Py galgame 的全流程工作台插件。
领域语言见 [`CONTEXT.md`](CONTEXT.md),架构决策见 [`docs/adr/`](docs/adr/),
**环节零接缝契约**见 [`docs/contracts/stage-zero.md`](docs/contracts/stage-zero.md)。

## 状态

- ✅ 环节零(T1–T7):项目服务接缝、写网关、git 快照、方言子集解析器、
  假/真校验回路、钉版 SDK 供给、推导进度 + 审读戳、试玩控制、工作台
- ✅ 工作台面板:舞台板(场景 × 素材槽 × 印章)、文件树筛选、文件内容预览、
  快照历史 / diff / 回滚、项目切换、SDK 供给卡
- ✅ 新建项目的父目录走**宿主目录选择接缝**(`ctx.directoryPicker`):本机直接开系统
  文件夹选择框,远程/无显示会话用面板内目录浏览器,没装后端就隐藏入口;不选则回落到
  设置里的默认父目录,表单里写明"将创建到哪"
- ✅ 两处**接缝已备、入口缺失**的补齐(经发起人确认):素材槽盖审读戳(接缝早有
  `stampSlot`)、快照回滚(接缝早有 `snapshotRollback`)
- ✅ 路由适配层契约测试(`src/service/routes.slow.test.ts`,**慢带**):状态码映射 /
  方法守卫 / SSE 帧 / 工作台实际调用的每个端点 —— 是接缝纪律的一处记录在案的例外,
  理由见 [`docs/contracts/stage-zero.md`](docs/contracts/stage-zero.md) 测试纪律节
- ✅ T8(角色登记簿 + 素材槽账本):`.studio/characters.json` 接缝 CRUD(经网关写);
  槽清单从 `.rpy` 图像引用**派生**、账本只往上挂制作信息;悬空引用(两个方向)进板并
  **定位到引用它的那条语句**;工作台新增「素材板」(槽视图 + 角色视图,纯渲染)
- ✅ T9(设定集工作周期):`.studio/bible/` 主题/世界观/章节 + 对登记簿的引用;
  人写大纲**逐字导入**、原文即权威(fingerprint 对不上就如实报);「设定定稿」戳只人可盖、
  改动自动待复审;`generationContext` **只给定稿版**(未定稿 409);工作台新增「设定集」卡
- ✅ T10(逐场剧本生成):`generateScene` 一个写批 = 一个快照,**写完当场判定**并原样交回
  (路径 / 解析 / 校验 / 问题 / 板快照);生成物固定落 `game/scenes/<label>.rpy`,手写文件
  不越界(要重生成先由人「搬进生成目录」);**agent 工具** `galfree_generate_scene` /
  `galfree_project_status`;`.rpy` 读取改递归(与真 SDK lint 同口径)
- ✅ T11(对话流结构化编辑器)+ T12(分支图):表单逐行改对白/图像引用,**只改被指向的
  那一行**(git diff 断言最小化);源文本模式并存,两路同走网关;手写文件与子集外场景的
  表单编辑如实拒绝(源文本仍可改);分支图 = 派生骨架的只读导航,点节点定位到编辑器
- ✅ T13(整线组装试玩):项目级完整性推导(入口 / 孤立场景 / 结局可达)+ 把全局问题
  **定位到场景**;**从此场试玩**(副本里覆写入口,用户项目不动;目标场不存在就崩 → 信号
  可红,慢带有真 SDK 断言);traceback 摘要入状态、板可见、agent 可读
- ✅ T14(图像渠道 + 任务队列,Host 直连):插件自有渠道设置(端点 / **密钥明文存本机设置** /
  模型目录带能力声明);任务 = 全结构化一级对象(目标槽、登记簿上下文、参考链、输出路径),
  状态机 `queued → running → awaiting-review|failed` + **只追加的重试历史**;产物一律
  **经写网关落盘**(网关类型拓宽到二进制,版本戳按字节)→ 自动快照 → 槽位推导立刻转「待复审」;
  **不支持参考链就自动降级文生图并附说明**(丢掉的参考图逐张列出,绝不静默)
- ⏳ 素材动作面(T15)、参考链回路(T16)、音频/发布(T17–T18)

## 工程

```
src/
  index.ts            Host 半(cordis apply:路由/设置/装配)
  client/             工作台 Client 半(sidebar.panellist + main 面板)
    panel.tsx           装配层:拉接缝状态、分发、把人的动作送回去
    stage-board.tsx     舞台板(读 scene.marks / stampable —— 不自己判断)
    file-inspector.tsx  文件内容 / 快照历史 / diff / 回滚
    directory-picker.tsx 目录选择(OS 选择框 / 面板内浏览器,按宿主能力)
    project-switcher.tsx 注册表激活位切换
    sdk-card.tsx        钉版 SDK 供给
    ui.tsx              Chip / 印章 / 提示条 / diff 视图
    types.ts            视图类型(与 routes 响应形状一一对应)
    panel.module.css    设计令牌 + 版式(配色全走宿主 --dsw-* token)
  routes.ts           /api/galfree 薄适配器
  service/            ★ 项目服务(seam)——独占逻辑全在这里
    project-service.ts   注册表 + 模板新建 + 全部环节方法
    progress.ts          推导引擎(含 deriveSceneMarks:舞台标记的唯一出处)
    images.ts            图像子系统:渠道/模型能力/适配器/降级判定/任务账本(纯逻辑)
    write-gateway.ts     串行 CAS 原子批 + 二进制写 + 外部观察(唯一写通道)
    snapshot.ts          写批后 git commit(作者 GALFree,永不 push)
    rpy/                 方言子集解析器 + 分支骨架派生(纯函数)
    validation/          校验回路契约 + 假验证器 + 真 SDK 适配器 + 合成端口
    sdk-provision.ts     钉版 SDK 下载状态机(校验和钉死)
    stamps.ts playtest.ts registry.ts template.ts hash.ts
docs/contracts/       接缝契约(dialect-subset.md / stage-zero.md)
```

## 常用命令

```bash
npm run typecheck      # tsc --noEmit
npm test               # 快集成带(无网络、无真 SDK;125 tests,全在 ProjectService 接缝上)
npm run test:slow      # 慢集成带(真钉版 SDK lint/compile + 路由适配层契约;发版前必跑)
npm run build          # lib/index.js(ESM host)+ lib/client.js(web bundle)
```

## 安装(人工验收)

以本仓库为插件源,按标准 DSH 插件流程安装(设置 → 插件 → 从本地/仓库添加);
装载后侧边栏出现「GALFree 工作台」入口。设置命名空间 `dsh-galfree` 可配
`defaultProjectsRoot`(新建项目默认父目录)与 `sdkPath`(既有 SDK 路径覆盖),
以及图像渠道(T14):

| 设置项 | 说明 |
|---|---|
| `imageBaseUrl` | OpenAI 兼容端点基址(如 `https://api.example.com/v1`);**留空 = 没配渠道**,出图动作会如实拒绝 |
| `imageApiKey` | 渠道密钥。**明文存在本机设置文档里**(ADR-0010 的知情选择,与 dsh-imagegen 同风险面):它不进项目目录、不进快照、不进任务账本 |
| `imageChannelName` | 渠道名(只在面板/账本里指认用) |
| `imageModels` | 模型目录(JSON 数组),每个模型**要声明能力**,否则按保守缺省 |

`imageModels` 示例(能力缺省口径:文生图/尺寸参数/b64 **为真**,参考链/图生图**为假** ——
能力宁可少说,不能凭空许诺):

```json
[
  { "id": "gpt-image-1", "label": "全能力",
    "capabilities": { "textToImage": true, "imageToImage": true, "referenceChain": true,
                      "aspectRatioParam": true, "b64Json": true } },
  { "id": "basic-model", "label": "只有文生图" }
]
```

## 硬约束(来自 ADR,改前先看契约文档)

- 项目文件一切写走 Host 写网关;`.rpy` 唯一真相;`.studio/` 永不复制叙述内容
- 进度是推导的;审读戳只能由人盖,重生成自动清戳(指纹失效即待复审)
- 不依赖 dsh-imagegen;SDK 用钉版;插件永不 push
