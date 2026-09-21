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
- ✅ T15(出图操作与素材板动作面):素材板上「补全全部待填」/「生成此槽」/「重 roll(可改词)」,
  进度徽标与**只追加的重试历史**(含被替换那一版的指纹 → 能从快照找回上一张);
  agent「美术指导」工具面 5 个(`galfree_image_channel` / `galfree_art_queue` /
  `galfree_generate_image` / `galfree_reroll_image` / `galfree_fill_missing_art`)——
  与面板**同一条队列、同一份推导**,没有第二管线
- ⏳ **这一行之后的历史**(T16 参考链 … T32 声音锚)不再在这份清单里逐票罗列 ——
  现状以 `CONTEXT.md` 的「进行中」节 + `docs/handoff-*.md`(每票一份交接)为准,
  接缝契约在 `docs/contracts/stage-zero.md`。三句话概括:T16 参考链(同一张脸)、
  T17–T18 音频接线与本地发布、T19–T22 工具面/指引/nextActions/preset、
  T23–T24 中文字体与试玩不卡人、T25–T32 三条生成线(图像已有;**音乐/语音各一条渠道**;
  语音的**声音锚** = 每个角色一份参考样本)+ 封面 + 界面换皮 + 快照回滚。

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
npm test               # 快集成带(无网络、无真 SDK;全在 ProjectService 接缝上)
npm run test:slow      # 慢集成带(真钉版 SDK lint/compile + 路由适配层契约;发版前必跑)
npm run build          # lib/index.js(ESM host)+ lib/client.js(web bundle)
```

## 安装(人工验收)

装载后侧边栏出现「GALFree 工作台」入口。三条装法,**推荐第一条**。

### ① 从插件市场装 / 预构建包(不需要 git,也不需要构建授权)

`v0.1.0` 起,发行物挂在 GitHub Release 上,资产名**不带版本号**,所以
`latest/download` 这条链接不会随发版腐烂:

```
dsh plugin add https://github.com/netori/galfree/releases/latest/download/dsh-galfree.tgz
```

实测(冷 store,桌面端自带的 pnpm 11.8.0):**768ms 装完**,`lib/index.js` /
`lib/client.js` / `cordis.patch.yml` 全部就位,**不跑任何安装期构建** ——
所以没有 `allowBuilds` 那一步,也不需要机器上装过 git
(`file:` / tarball 依赖 pnpm 不跑 `prepare`,包里的 `prepare` 原样留着也无事)。

**市场条目**(`dsh-market` / 社区市场会读到的那条)在
[`market/netori__galfree.yml`](market/netori__galfree.yml):`url` + `name` + `category` +
双语句描述 + `tarball:` 字段。市场的 `installTargetFor()` 规则是
**repo 验过的 npm 包 > 作者提供的预构建 tarball > `github:owner/repo`** ——
我们走的是第二条,所以市场给用户的安装目标就是上面这条 `.tgz`。
本地自检(复刻市场的 tarball 绑定校验 + `latest/download` 腐烂陷阱):

```bash
node scripts/check-market-entry.mjs market/netori__galfree.yml
```

⚠️ 条目进市场**要往 `awesome-dsh-plugin` 提 PR**(一个文件 = 全部投稿,见
`market/README.md`)。**目前还没提** —— 所以现在市场里搜不到,得先用上面那条命令。

**发到 npm 是另一条更省事的路**(市场会优先用它,而且不用往 `awesome-dsh-plugin` 提条目):
`package.json` 已经为此备好 `repository` 与 `publishConfig`(指向官方 registry),
只差一次 `npm login` + `npm publish --access public`。本机当前 `npm whoami` 未登录(ENEEDAUTH),
所以这一步要么在本机登录,要么交给 CI(见 `market/README.md`)。

### ② 从仓库源码装(会现场构建一次,要过 pnpm 的构建授权)

**从仓库安装时它会现场构建一次**(仓库里不带 `lib/`,`package.json` 的 `prepare`
负责构建;这是 DSH 对 git 插件的既定方式)。pnpm 默认**拦下**安装期构建脚本,所以第一次
会失败并打印一个 key —— 把那个 key 原样填进 profile 的 `pnpm-workspace.yaml` 的
`allowBuilds`,再装一次即可(`~/.dsh/profiles/<profile>/pnpm-workspace.yaml`)。

### 从仓库装,第一次一定失败 —— 那一步是设计如此(2026-09-19 冷 store 实测)

**症状**(原话,用桌面端自带的 pnpm 11.8.0 在一个**空 store** 的干净目录里复现):

```
[ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED] Failed to prepare git-hosted package fetched from
"https://codeload.github.com/netori/galfree/tar.gz/<commit>": The git-hosted package
"dsh-galfree@0.1.0" needs to execute build scripts but is not in the "allowBuilds" allowlist.

Add the package to "allowBuilds" in your project's pnpm-workspace.yaml to allow it to run scripts. For example:
allowBuilds:
  dsh-galfree@https://codeload.github.com/netori/galfree/tar.gz/<commit>: true
```

**触发条件(实测出来的,不是推理)**:这条拦的是「**第一次**从 git 装一个
**带 `prepare` 而不带 `lib/`** 的包」—— 也就是**冷 store(cafs 里还没有这份已构建的产物)**。
pnpm 对 git 依赖会先跑 `prepare`(它把 `npm install` → `prepare` → `tsdown` 真跑一遍);
构建脚本默认不许跑,于是它**抛错而不是跳过**,`lib/` 就不会出现。
一旦这份构建产物进了 store,**之后所有安装都直接复用、不再问授权**
(实测:同一台机器、同一个 commit,冷 store 必红;而 store 里有了之后
`allowBuilds` 写不写都过、2.8 秒装完)。

**修法**:把 pnpm 打印的**那一整行 key 逐字**(带 `@https://codeload…` 与 commit 哈希)
填进 `~/.dsh/profiles/<profile>/pnpm-workspace.yaml`,再装一次:

```yaml
allowBuilds:
  'dsh-galfree@https://codeload.github.com/netori/galfree/tar.gz/<commit>': true
```

实测(冷 store + 这一条):构建自动跑起来(`npm-install` → `prepare` → `tsdown` 全在输出里),
`node_modules/dsh-galfree/lib/index.js` 就位,装完。

⚠️ **只写 `dsh-galfree: true` 不行**(冷 store 实测**照样报同一个错**)——
key 认的是**带 commit 的完整依赖键**;而且用 `github:owner/repo` 这种没钉 commit 的写法时,
上游一有新提交键里的哈希就变,**同一个症状会再出现一次**,照新打印的那行再填一条即可。

### 从仓库装不上时的另一条路:预构建 tarball(不需要对方装 git)

作者侧一条命令打出 320KB 的预构建包(里面已含 `lib/` 与 `cordis.patch.yml`):

```bash
npm pack            # 产出 dsh-galfree-0.1.0.tgz
```

对方那侧(`<tgz>` 换成实际路径):

```bash
dsh plugin add file:<tgz>
```

实测两点,都值得记下:
- **这条路完全不碰 git** —— pnpm 对 `file:` / tarball 依赖**不跑 `prepare`**
  (包里的 `prepare` 原样留着也无事),于是**没有构建授权那一步**,
  干净目录里 1.5 秒装完、`lib/index.js` 就位;
- 仍会有 peer 警告(`react` / `@deepseek-ai/*` 由宿主供给),那是预期的,不是失败。

**拿到的是解压好的目录**就用 `link:`(实测 91ms 装完,同样不跑构建脚本、不需要 `allowBuilds`;
改代码重启宿主即可生效):

```yaml
dependencies:
  dsh-galfree: link:E:/DSH_project/DSH_creator
```

**tarball 里有什么**(`npm pack --dry-run` 实列,共 8 个文件):
`package.json` / `lib/index.js` / `lib/client.js` / `cordis.patch.yml` /
`README.md` / `LICENSE` / `docs/contracts/*.md`。
仓库里没有 `templates/` 这个目录 —— 新建项目用的界面文件与中文字体是**装好之后**从钉版 SDK
(或按设置里的 `sdkPath` 指向的既有 SDK)拷进项目的,所以 tarball 里没有它是正常的,
**不表示打包缺料**。

**自己改代码**时不必依赖 `prepare`:在**本仓库目录里**跑

```bash
npm install && npm run build   # 产出 lib/,宿主加载的就是它
```

**改完必须重建 + 重启宿主**:宿主只在启动时载入 `lib/index.js`;面板是按需从磁盘取的,
所以只重建不重启会出现"面板有按钮、宿主没路由"。

设置命名空间 `dsh-galfree` 可配
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
