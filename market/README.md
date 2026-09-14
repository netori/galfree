# 申请进入 DSH 插件市场的现状(2026-09-14)

对照 `awesome-dsh-plugin/awesome-dsh-plugin` 的
[contributing.md](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md)
逐条核过。**投稿数据是 `market/netori__galfree.yml`**(一个文件就是全部投稿;
两个 README 由 `data/plugins/*.yml` 自动生成,不要手工编辑)。

## 一句话结论

**代码这一侧全部达标;卡住的只有一件与代码无关的事:仓库是 `private`。**

## 逐条核验

| 要求 | 现状 | 判定 |
|---|---|---|
| `package.json` 声明 `dsh.bundle` manifest | `{"bundle":{"patch":"./cordis.patch.yml"}}`,且 `cordis.patch.yml` 实在 | ✅ |
| 不是只声明 `dsh.client`(最常见被拒原因) | bundle 与 client 都有 | ✅ |
| 仓库有真实可用代码,非占位/纯 README | `src/` 137 文件 / 约 33.8k 行 / 56 个测试文件 | ✅ |
| 仓库创建满 1 天 | 创建于 2026-09-11 | ✅ |
| 活跃维护 | 121 commits,持续提交 | ✅ |
| 加 `dsh-plugin` topic | **未加**(且私有仓库上没意义) | ⛔ 待办 |
| 描述如实、无营销词 | 只陈述功能(见 yml) | ✅ |
| 分类贴合 | `dev`(全流程工作台,非 UI 主题) | ✅ |
| 非纯聚合包(meta-package) | 自身做事,不是依赖清单 | ✅ |
| 依赖指向原作者 | 依赖仅 `extract-zip` / `schemastery`,无他人包副本 | ✅ |
| 一个 PR 最多 3 条 | 只投 1 条 | ✅ |

## ⛔ 唯一的硬阻塞:仓库可见性

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
