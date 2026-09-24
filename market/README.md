# 申请进入 DSH 插件市场的现状

> ## 🔄 现状(2026-09-21 更新)
>
> 1. ✅ **仓库已公开**、已加 `dsh-plugin` topic、创建满 1 天 —— 收录门槛全过;
> 2. ✅ **条目早就在市场里了**(PR #5429,2026-09-19 合并)。但**市场给用户的安装命令
>    是从源码构建的那条**:
>
>    ```
>    dsh plugin --profile web add github:netori/galfree
>    ```
>
>    于是每个用户都会撞上 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`(冷 pnpm store 上第一次必红,
>    要人手工往 `pnpm-workspace.yaml` 填一条**带 commit 哈希**的 allowBuilds key,
>    而且上游一 push 那个 key 就失效)—— 这就是"别人安装会报错"的真身。
> 3. 🚀 **修法已提 PR**:
>    **[awesome-dsh-plugin#5572](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/5572)**
>    —— 往我们那条条目加一个 `tarball:` 字段,指向 `v0.1.0` Release 上的预构建资产。
>    合并后市场给的安装目标会变成那份 `.tgz`(参考同类条目,页面上的 `install` 字段会变成
>    `dsh plugin --profile web add "<tarball URL>"`),**不拉整仓、不跑安装期构建、
>    不需要 allowBuilds 授权**。
>
>    为什么这条正是 contributing.md 为这种情形留的路:它写着「不发 npm 也可以:把预构建 tarball
>    附加到 GitHub Release,并用可选的 `tarball:` 字段指向它」,**并注明"如果你的仓库根本无法
>    从源码安装,这一项是必需的"** —— 我们这种"仓库不带 `lib/`、靠 `prepare` 现场构建"的,
>    正是那一种。资产名**不带版本号**,所以 `latest/download` 不会随发版 404。
> 4. ✅ **本地已把 CI 的判据跑过**:`validateEntries()` 全库 0 问题;`tarballProblem()` 通过
>    (`https` + `github.com` + 同 owner/repo + `/releases/` + `.tgz`);下载该 URL 的字节与上传的
>    资产 sha256 一致;用 `installTargetFor()` 的判定规则在**冷 store、零 allowBuilds** 的
>    干净目录里实测安装 **768ms** 成功、`lib/` 就位、宿主半 import 正常。
>    本地自检脚本:`npm run check:market`。
> 5. 🟡 **npm 那条路已备好,但作者决定先不发**(2026-09-21):`package.json` 去掉了
>    `private` 并补了 `repository` / `publishConfig`(官方 registry + public),
>    仓库根 `.npmrc` 钉了官方源,`npm run release:npm` 是可用的发布脚本
>    (前置检查 → publish → 从 registry 读回来核对),流程写在 `docs/release-to-npm.md`。
>    **卡在哪**:`npm login` 是交互式的,只有人能跑(本机当前 `npm whoami` 是 `ENEEDAUTH`)。
>    发了 npm 就不必在 yml 里写任何字段 —— 映射从 registry 自动采集
>    (脚本实测:contributing 明确说**手写 `npm:` 会被校验拒绝**)。
>    发完那条路给用户的命令是 `dsh plugin --profile web add dsh-galfree`,与 `tarball:`
>    这条路等效(都不构建),只是多一个下载量数字。

对照 `awesome-dsh-plugin/awesome-dsh-plugin` 的
[contributing.md](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md)
逐条核过。**投稿数据是 `market/netori__galfree.yml`**(一个文件就是全部投稿;
两个 README 由 `data/plugins/*.yml` 自动生成,不要手工编辑)。

## 一句话结论(2026-09-14 的原始记录,阻塞项见上面的更新)

**代码这一侧全部达标。** 阻塞/待办共三类,都不是"写得对不对"的问题:

1. ⛔ **仓库是 `private`** —— 评审者读不到仓库,CI 也取不到 `package.json`(只有所有者能拍板);
2. ✅ **能不能装上**(以前不能,已于 2026-09-14 修):见下节"安装可用性";
3. 🟡 两件可选项:加 `dsh-plugin` topic、发 npm。

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
| peer 范围不静默排除预发布版 | 换成 `>=0.1.5-0 <0.2.0-0`(实测放行 `0.1.5-rc.2`) | ✅(已修) |
| 加 `dsh-plugin` topic | **未加**(且私有仓库上没意义) | ⛔ 待办 |
| 描述如实、无营销词 | 只陈述功能(见 yml) | ✅ |
| 分类贴合 | `dev`(全流程工作台,非 UI 主题) | ✅ |
| 非纯聚合包(meta-package) | 自身做事,不是依赖清单 | ✅ |
| 依赖指向原作者 | 依赖仅 `extract-zip` / `schemastery`,无他人包副本 | ✅ |
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

## ⛔ 头号阻塞:仓库可见性

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

## 还没做的两件(都不阻塞投稿)

1. **`screenshots.json`(可选、推荐)**:contributing 建议在 `package.json` 旁边放
   1–8 张图,市场详情页会像 App Store 那样展示。
   本仓库**目前没有任何图片资产**,README 里也没有图 —— 不声明也能投(市场会退回
   从 README 抽图),只是详情页会空。
   要补的话,得先真的起一次工作台截图再放进来;**不要放占位图**。
2. **发 npm(可选)**:能免掉用户的构建授权步骤,也让市场显示下载量。
   与收录无关,不发照样能从 GitHub 装。

## 投稿步骤(公开之后)

1. 给 `netori/galfree` 加 `dsh-plugin` topic;
2. fork `awesome-dsh-plugin/awesome-dsh-plugin`;
3. 把 `market/netori__galfree.yml` 复制成 `data/plugins/netori__galfree.yml`
   (文件名 = `<owner>__<repo>.yml`;
   monorepo 子包会变成 `owner__repo--packages-xxx.yml`,我们不是这种);
4. 开 PR(只加这一个文件)。
   若 CI 报格式问题,在同一分支推修复即可,不用重开 PR。

## 评审会看什么(照 contributing 的原文)

- 代码是否与条目声明一致(含描述里的数字与 API 名称)——**别夸大**;
  这是"本来不错的插件被打回"的头号原因。
- 分类是否合理(不贴切时维护者直接改,**不会**因此被打回)。
- 是否与已有条目重复(3632 条在列,同功能比谁维护得更好,不是先来后到)。
- 源码是否有可疑之处(混淆、凭证外泄、安装期意外行为)。
- PR 是否动了与它无关的条目。

> 「收录与否不是对你作品的评价」—— 原文明确写了这条,不必把它当裁判。
