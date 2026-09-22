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

发成功后同一版还要挂一份到 GitHub Release(市场条目与"不发 npm 的人"用得到):

```powershell
npm pack                                   # 产出 dsh-galfree-<version>.tgz
gh release create v<version> .\dsh-galfree-<version>.tgz -R netori/galfree `
  --title "dsh-galfree <version>" --notes-file market\release-notes-v0.1.0.md
```

⚠️ 发布资产名要**不带版本号**,条目里的 `latest/download` 链接才不会随发版 404:

```powershell
# 包名里的版本去掉,再上传
Move-Item .\dsh-galfree-<version>.tgz .\dsh-galfree.tgz
gh release upload v<version> .\dsh-galfree.tgz -R netori/galfree --clobber
```

## 发完自检(别只看"发布成功")

```powershell
npm view dsh-galfree version dist.tarball --registry=https://registry.npmjs.org/
npm run check:market          # 条目与 tarball 的绑定校验
```

再按"新用户视角"验收一次:在**冷 store、零 `allowBuilds`** 的干净目录里,

```powershell
pnpm add dsh-galfree    # 应秒装成功,node_modules/dsh-galfree/lib/index.js 就位
```

## 两个已知边界

- **npm 上的包带着 `prepare` 脚本**(仓库的 git 安装路径要靠它现场构建;`files` 没带
  devDependencies,所以 registry 安装不会执行它)。实测 tarball 依赖不跑 `prepare`;
  若哪天真跑起来,那一步会因缺 `tsdown` 失败 —— 到时候把构建挪到 `prepack` 即可
  (现在不能挪:挪了 `pnpm add github:netori/galfree` 就装不出 `lib/` 了)。
- **发布不可逆的部分**:npm 允许 72 小时内 unpublish,之后只能弃用(deprecate)。
  发之前用 `npm pack --dry-run` 看一眼文件清单。
