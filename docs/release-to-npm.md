# 发一版到 npm(作者用;发行物同时挂 GitHub Release)

发 npm 的好处(市场侧):`awesome-dsh-plugin` 的目录会从 registry **自动**采集
npm 映射 —— 条目里**不写任何字段**(手写 `npm:` 会被校验拒绝),市场给用户的安装命令
就变成 `dsh plugin --profile web add dsh-galfree`,装的是预构建包,
不拉整仓、不跑安装期构建、不需要 `allowBuilds` 授权。
(在 npm 映射生效之前,`market/netori__galfree.yml` 里的 `tarball:` 字段是兜底的那条路。)

## 一次性准备

```powershell
npm login --registry=https://registry.npmjs.org/   # 会开浏览器/提示输入,交互式,必须人来跑
npm whoami --registry=https://registry.npmjs.org/  # 应打印你的 npm 用户名
```

本机用户级 `~/.npmrc` 指向的是只读镜像,所以**每条命令都显式带 `--registry`**;
或直接 `cd` 到本仓库(仓库根的 `.npmrc` 已把 registry 钉成官方源)。

### ⚠️ 这个账号开了两步验证 —— 登录不够,得用 automation token(实测)

`npm login` 之后直接发,第一次是这么被拒的:

```
npm error code E403
npm error 403 Forbidden - PUT https://registry.npmjs.org/dsh-galfree
Two-factor authentication or granular access token with bypass 2fa enabled is required to publish packages.
```

两条出路:

1. **automation token(推荐,一次配好以后免验证码)** —— 步骤写在
   [`docs/npm-token-setup.md`](npm-token-setup.md):在 npm 网站生成 **Automation** token,
   用 `Read-Host -AsSecureString` 粘进用户级 `~/.npmrc`(凭据不进仓库、不回显、不进聊天)。
2. **每次带验证码** —— `npm run release:npm -- --otp=123456`。实测这条路的往返约 **7 秒**
   (假码也在这个时间被拒),所以码有 30 秒时效也来得及,但每次发版都要你在场。

## 每次发版

```powershell
# 1) 版本号:改 package.json 的 version(或 npm version patch/minor/major)
# 2) 跑守门:类型检查 + 快带(+ 发版前按纪律跑一次慢带)
npm run typecheck; npm test
# 3) 发布(会先跑 prepare → tsdown,把 lib/ 打进包)
npm run release:npm
#    没配 automation token 就得带验证码:
npm run release:npm -- --otp=123456
#    只想预演:--dry-run
```

`scripts/publish-npm.mjs` 做三件事(任一步失败就停,不会"退出了就当成功"):
① 前置检查(登录没 / 工作区干净没 / 这个版本发过没);
② `npm publish`(官方 registry、public);
③ **从 registry 读回来核对版本号**(发完自检,不是相信退出码)。

发成功后同一版还要挂一份到 GitHub Release(市场条目与"不发 npm 的人"用得到)。
**资产名带版本号、条目里的 `tarball:` 钉住 tag** —— 0.1.0 用的是"不带版本号 + `latest/download`"
那种写法,0.1.1 起改成钉 tag:`latest/download` 会在 URL 不变的情况下换成后一版的字节,
条目看起来没改却在装不同的代码,钉 tag 才审计得动(见条目 PR #5678 的说明)。

```powershell
npm pack                                   # 产出 dsh-galfree-<version>.tgz
gh release create v<version> .\dsh-galfree-<version>.tgz -R netori/galfree `
  --title "dsh-galfree <version>" --notes-file market\release-notes.md
# 条目里的 tarball 同步改成:
#   https://github.com/netori/galfree/releases/download/v<version>/dsh-galfree-<version>.tgz
npm run check:market                       # 条目与 tarball 的绑定校验
```

⚠️ 本机**传不上资产**那条**已经过期**(2026-09-24 实测):`uploads.github.com` 在本机解析到
代理的假 IP(`198.18.0.71`),但**经代理是通的** —— `gh release create v0.1.2 <tgz>` 一次就把
351KB 的资产传上去了。真传不动时的兜底仍是:API 建 release + curl 用真实 IP 直连
(`--resolve uploads.github.com:443:<ip>`,真实 IP 用 DoH 问 `https://1.1.1.1/dns-query`)。

## 发完自检(别只看"发布成功")

```powershell
npm view dsh-galfree version dist.tarball --registry=https://registry.npmjs.org/
npm run check:market          # 条目与 tarball 的绑定校验
```

### 三条 0.1.2 发版时现学到的(都写进脚本/文档了,别再踩)

1. **`npm publish` 打印 `+ dsh-galfree@0.1.2` 不等于装得上。** 刚发完那几分钟,
   tarball URL 可能对着一个**负缓存**返回 404(实测:裸 URL 404,加一个随机查询串
   `?cb=<random>` 就 200,几分钟后自愈)。判据别写成"tarball 200":
   **加缓存串再取一次**,或者干脆 `npm install dsh-galfree@<version>` 试一次。
2. **可能被登记成 staged**(npm 的两段式发布):自动化 token 只能"暂存",
   真正发布要人用 2FA 批准。症状是 `npm publish` 成功、版本号被占住,
   再发一次报 `E409 … Cannot publish over previously staged version`。
   查/批准:`npx npm@12 stage list dsh-galfree` → `npx npm@12 stage approve <stage-id>`
   (本机 npm 11.11 **没有** `stage` 子命令,用 `npx npm@12` 跑)。
   ⚠️ 与第 1 条**长得一样**,先按第 1 条排掉缓存再判 staged。
3. **探测用的 npm 参数两个都要给**(已在 `scripts/publish-npm.mjs` 修掉):
   只给 `--fetch-retry-maxtimeout=5000` 会让 npm 自己报
   `minTimeout is greater than maxTimeout`(默认 mintimeout 是 10000)——
   每一次探测都失败,于是"明明发成功了"被读回核对报成"registry 上读不到"。

再按"新用户视角"验收一次:在**冷 store、零 `allowBuilds`** 的干净目录里,

```powershell
pnpm add dsh-galfree    # 应秒装成功,node_modules/dsh-galfree/lib/index.js 就位
```

⚠️ **刚发出去的那一版不要用裸包名验收** —— pnpm 11 的**新鲜发布保护**会静默替你选上一版
(实测 2026-09-22:`pnpm add dsh-galfree` → 装到 **0.1.0**;`pnpm add dsh-galfree@0.1.1` → 装到 **0.1.1**)。
判据因此要写**版本号**,否则"验过了"其实验的是上一版:

```powershell
pnpm add dsh-galfree@<version>     # 钉版本,绕开 hold
node -e "console.log(require('dsh-galfree/package.json').version)"   # 核对装到的是不是那一版
```

**市场不会被这条 hold 影响**:它的 npm 目标会**自动钉到 registry 的 latest**
(`sources.ts` 里那句 "pinned to the registry's latest, so pnpm's fresh-release hold
cannot substitute an older version silently"),所以市场点安装拿到的是最新那一版。
自己手敲 `dsh plugin add dsh-galfree` 的人则可能落在上一版上 —— 要哪一版就写哪一版。

## 两个已知边界

- **npm 上的包带着 `prepare` 脚本**(仓库的 git 安装路径要靠它现场构建;`files` 没带
  devDependencies,所以 registry 安装不会执行它)。实测 tarball 依赖不跑 `prepare`;
  若哪天真跑起来,那一步会因缺 `tsdown` 失败 —— 到时候把构建挪到 `prepack` 即可
  (现在不能挪:挪了 `pnpm add github:netori/galfree` 就装不出 `lib/` 了)。
- **发布不可逆的部分**:npm 允许 72 小时内 unpublish,之后只能弃用(deprecate)。
  发之前用 `npm pack --dry-run` 看一眼文件清单。
