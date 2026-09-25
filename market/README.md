# 申请进入 DSH 插件市场的现状

> ## 🔄 现状(2026-09-25 更新)
>
> 1. ✅ **条目在市场里,而且走的是 npm**(PR #5429 收录 → #5572 加 `tarball:` → #5678 钉到 v0.1.1)。
>    2026-09-24 起市场目录已经**自动采集到 npm 映射**,那条条目的 `install` 字段是:
>
>    ```
>    dsh plugin --profile web add dsh-galfree
>    ```
>
>    即**不拉整仓、不跑安装期构建、不需要 allowBuilds 授权**。原先那条
>    `github:netori/galfree`(每个用户都会撞 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`)已经成为历史。
> 2. ✅ **npm 已发**:`dsh-galfree@0.1.0 / 0.1.1 / **0.1.2**`(0.1.2 发布于 2026-09-24)。
>    市场的安装目标既然解析到 npm 包名,用户拿到的就是 registry 的 `latest` ——
>    **发 npm 就等于到市场,不需要"上传新版本"给市场**。
>    而且市场安装会显式绕过 pnpm 的新鲜发布保护
>    (`dshmarket/lib/install.js`:`RELEASE_AGE_OVERRIDE = '--config.minimum-release-age=0'`),
>    所以刚发的版本立刻可装(自己手敲 `dsh plugin add` 才可能被静默换成上一版)。
> 3. 🚀 **当前在提的 PR**:
>    **[awesome-dsh-plugin#5859](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/5859)**
>    —— 把兜底的 `tarball:` 从 v0.1.1 提到 **v0.1.2**。
>    为什么值得提:v0.1.1 在 harness **0.1.7 上装不上**(0.1.7 换掉了整套设置模型,
>    它的 `apply` 第一句就抛,于是工具面/路由/面板一起没有),而 npm 映射**存在时**
>    `installTargetFor()` 优先用 npm、不看 `tarball:` —— 所以这一条改的是**兜底那条路的诚实性**,
>    不是主路径。正文见 `market/pr-body-galfree-012.md`。
> 4. ℹ️ 目录里那条 `version` 字段(抓取时是 `0.1.1`)是**目录自己的缓存**,周期性重建,
>    下次爬取会变 0.1.2;**它不参与安装**,安装目标是 npm 包名。
> 5. ✅ **仓库已公开、已加 `dsh-plugin` topic**(实测 API:`private: false`,`topics: ["dsh-plugin"]`),
>    创建满 1 天 —— 收录门槛全过;下面那些"阻塞"小节都是历史记录。

对照 `awesome-dsh-plugin/awesome-dsh-plugin` 的
[contributing.md](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md)
逐条核过。**投稿数据是 `market/netori__galfree.yml`**(一个文件就是全部投稿;
两个 README 由 `data/plugins/*.yml` 自动生成,不要手工编辑)。

## 一句话结论(2026-09-14 的原始记录,阻塞项见上面的更新)

**代码这一侧全部达标。** 当时列的三类阻塞/待办,**现在三项全部落地**:

1. ✅ **仓库是 `private`** → 2026-09-19 前已公开(评审者读得到,CI 取得到 `package.json`);
2. ✅ **能不能装上**(以前不能,已于 2026-09-14 修):见下节"安装可用性";
3. ✅ 两件可选项:加 `dsh-plugin` topic(**已加**)、发 npm(**已发 0.1.0/0.1.1/0.1.2**)。

## 逐条核验

| 要求 | 现状 | 判定 |
|---|---|---|
| `package.json` 声明 `dsh.bundle` manifest | `{"bundle":{"patch":"./cordis.patch.yml"}}`,且 `cordis.patch.yml` 实在 | ✅ |
| 不是只声明 `dsh.client`(最常见被拒原因) | bundle 与 client 都有 | ✅ |
| 仓库有真实可用代码,非占位/纯 README | `src/` 137 文件 / 约 33.8k 行 / 56 个测试文件 | ✅ |
| 仓库创建满 1 天 | 创建于 2026-09-11 | ✅ |
| 活跃维护 | 121+ commits,持续提交 | ✅ |
| **能从源码装上**(见下节) | 以前**不能**;加 `prepare` 后能 | ✅(已修) |
| 官方 `@deepseek-ai/*` 走 peerDependencies | `@deepseek-ai/dsh-tools` 以前只是 devDependency(运行时却 import 它) | ✅(已修) |
| peer 范围不静默排除预发布版 | 现为 `>=0.1.5-0 <0.2.0-0`。**复核(2026-09-25)**:默认语义下它放行 `0.1.5-rc.2` 与 `0.1.7`,但**放行不了 `0.1.7-rc.2`**(node-semver 要求范围里有一个与该版本元组相同、且自身带预发布标签的比较符;`0.1.5-0` 的元组是 0.1.5)。**没有静态范围能覆盖每个 0.1.x 元组** —— 那要每元组一条 `\|\|` 分支。harness 自己的闸门用 `includePrerelease: true`(`dsh-app-boot` 的 `evaluatePluginCompatibility`),实测放行且**没有把插件行 deny**;市场那份判定是**方向性**的(belowMin/aboveMax),落在区间内就是"无风险"。所以这是 pnpm 的一行 peer 警告,不是安装阻塞 | ⚠️ 已核实,保持 |
| 加 `dsh-plugin` topic | 已加(API 实测 `topics: ["dsh-plugin"]`) | ✅ |
| 描述如实、无营销词 | 只陈述功能(见 yml) | ✅ |
| 分类贴合 | `dev`(全流程工作台,非 UI 主题) | ✅ |
| 非纯聚合包(meta-package) | 自身做事,不是依赖清单 | ✅ |
| 依赖指向原作者 | 依赖仅 `extract-zip`(schema 库走 harness 的 peer),无他人包副本 | ✅ |
| 一个 PR 最多 3 条 | 只投 1 条 | ✅ |

## ✅ 安装可用性(2026-09-14 修,这是当时的第二个硬阻塞)

**症状**:`lib/` 在 `.gitignore` 里(**仓库不带构建产物**),而 `package.json` 又**没有
`prepare` 脚本** ⇒ 任何人从 GitHub 装下来的包里 **`main` 指向的 `lib/index.js` 根本不存在**。
只有作者本机能用(profile 里是 `link:E:/DSH_project/DSH_creator`,本地早已构建过)。

**证据**(不是推理):
- `git clone` 一份干净的 → 目录里**没有 `lib/`**;
- 加了 `"prepare": "npm run build"` 之后再 `npm install` → `lib/index.js` 与 `lib/client.js`
  两个都出来了(实测通过)。

**修法**:`prepare` 脚本(与市场里 `dshmarket` 同一种做法)。
DSH 的安装器原话印证了这条路:*"git-hosted plugins build on install via their prepare
script, which pnpm blocks until allowed — add the exact key pnpm printed above under
`allowBuilds`"* —— 所以从仓库装的人要按提示把 key 填进 `pnpm-workspace.yaml`,这一步写进 README 了。

### 顺带修掉的两处声明问题

- **`@deepseek-ai/dsh-tools` 以前只在 `devDependencies` 里,而 `lib/index.js` 运行时
  `import { defineTool } from "@deepseek-ai/dsh-tools"`** —— 运行时依赖没声明。
  (它**今天能跑**:宿主把 harness 包挂在 `~/.dsh/profiles/node_modules/@deepseek-ai/`,
  向上查找够得到;但这是"碰巧成立",不是声明成立的。市场指南明确要求官方包走
  `peerDependencies`。)现在补成 **optional peer**:插件对工具席位本来就是这个态度
  —— `ctx.inject(['tools'], …)` 缺席就少几个入口,不崩。
- **peer 范围会静默排除预发布版**:harness 发的是 `0.1.5-rc.2` 这种预发布。
  实测(node-semver,`includePrerelease=false`,即 npm/pnpm 的默认解析):

  | 范围 | 0.1.5-alpha.2 | 0.1.5-rc.2 | 0.1.5 |
  |---|---|---|---|
  | `^0.1.5`(直觉写法) | no | no | YES |
  | `>=0.0.1-rc.1 <0.2.0`(指南的 ❌) | no | no | YES |
  | 指南的 ✅ `… <0.1.0 \|\| >=0.1.0-rc.1 <0.2.0-0` | **no** | **no** | YES |
  | **`>=0.1.5-0 <0.2.0-0`(采用)** | **YES** | **YES** | YES |

  ⚠️ 连指南里那个 ✅ 例子都放行不了 `0.1.5-*`(它的比较符落在 `0.1.0` 元组上,而我们的
  版本在 `0.1.5` 元组)—— 规则的实质是"**每个元组各要一条带预发布标签的分支**"。

  **2026-09-24 复核(升到 DSH 0.1.7-rc.2 时)**:这条范围**不用再加分支**。harness 自己的
  兼容性闸门用的是 `semver.satisfies(runtime, range, { includePrerelease: true })`
  (`dsh-app-boot` 的 `evaluatePluginCompatibility`),实测
  `satisfies('0.1.7-rc.2', '>=0.1.5-0 <0.2.0-0', {includePrerelease:true}) === true`,
  而且真机装出来的行**没有被 deny**(`--dump-config` 里 `- id: galfree` 在位、未 disabled)。
  ⚠️ 但上表那套"默认解析"的结论**只对 npm/pnpm 成立** —— 两把尺子不一样,别拿一张表套两处:
  harness 闸门看的是**范围与运行时版本**,pnpm 看的是**这些 peer 在 profile 里装没装**。

## ~~⛔ 头号阻塞:仓库可见性~~(已解决:2026-09-19 前仓库已公开,PR #5429 也据此合并)

> 下面这段是当时(2026-09-14)的记录。**现在 API 实测 `private: false`、`topics: ["dsh-plugin"]`** ——
> 阻塞已消,保留原文只为留档。

```
"private": true    visibility: "private"    (netori/galfree,经 GitHub API 确认)
```

contributing.md 的评审动作是「**A maintainer reads the target repository before
merging**」—— 私有仓库评审者打不开,CI 也取不到 `package.json` 去验 `dsh.bundle`。
另外 `github.com/netori/galfree` 对外是 404,`dsh-plugin` topic 也无法生效。

**这一步只有仓库所有者能拍板**(改可见性对外不可逆)。

### 公开前值得先想的一件事:本机设置里有明文密钥

`~/.dsh/settings.yaml` 的 `dsh-galfree:` 段里存着**明文** `imageApiKey`
(ADR-0010 的知情选择)。它**不在仓库里**(已核:`git grep` 扫描 tracked 文件无真实密钥,
命中的只有测试夹具里的假值),所以公开仓库本身不会泄露它。
但既然仓库要公开,值得顺手确认一次:那把 key 是否愿意继续以明文躺在设置文档里。

## 还没做的(都不阻塞)

1. **`screenshots.json`(可选、推荐)**:contributing 建议在 `package.json` 旁边放
   1–8 张图,市场详情页会像 App Store 那样展示。
   本仓库**目前没有任何图片资产**,README 里也没有图 —— 不声明也能投(市场会退回
   从 README 抽图),只是详情页会空。
   要补的话,得先真的起一次工作台截图再放进来;**不要放占位图**。
2. ~~**发 npm**~~:**已发**(0.1.0 / 0.1.1 / 0.1.2),市场那条条目的安装目标已经是 npm 包名。
3. **`description` 里的措辞**已经如实描述功能,但**没有**写"需要 harness ≥ 0.1.7" ——
   contributing 只要求描述与代码一致,而版本要求属于安装体验;如果维护者问起,
   口径是:0.1.2 适配的是 0.1.7 换掉的那套设置模型,更早的 harness 上跑不了。

## 投稿步骤(公开之后 · 已于 2026-09-19 走完)

1. ✅ 给 `netori/galfree` 加 `dsh-plugin` topic;
2. ✅ fork `awesome-dsh-plugin/awesome-dsh-plugin`;
3. ✅ 把 `market/netori__galfree.yml` 复制成 `data/plugins/netori__galfree.yml`
   (文件名 = `<owner>__<repo>.yml`;
   monorepo 子包会变成 `owner__repo--packages-xxx.yml`,我们不是这种);
4. ✅ 开 PR(只加这一个文件)。
   若 CI 报格式问题,在同一分支推修复即可,不用重开 PR。
5. **后续更新条目**走同一套:改 `data/plugins/netori__galfree.yml` 那一个文件
   (本地先在 `market/netori__galfree.yml` 改好、`npm run check:market` 跑一遍),
   正文模板见 `market/pr-body-galfree-0*.md`。**只改自己那一条**。

## 评审会看什么(照 contributing 的原文)

- 代码是否与条目声明一致(含描述里的数字与 API 名称)——**别夸大**;
  这是"本来不错的插件被打回"的头号原因。
- 分类是否合理(不贴切时维护者直接改,**不会**因此被打回)。
- 是否与已有条目重复(3632 条在列,同功能比谁维护得更好,不是先来后到)。
- 源码是否有可疑之处(混淆、凭证外泄、安装期意外行为)。
- PR 是否动了与它无关的条目。

> 「收录与否不是对你作品的评价」—— 原文明确写了这条,不必把它当裁判。
