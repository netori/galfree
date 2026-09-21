**预构建安装包**(322 KB):里面已经有 `lib/index.js`(宿主半)与 `lib/client.js`(工作台半)。
装上就能用 —— **不需要 git,也不需要 pnpm 的构建授权**(不存在安装期构建这一步)。

```
dsh plugin add https://github.com/netori/galfree/releases/latest/download/dsh-galfree.tgz
```

`dsh-market` / 社区市场里的条目指向的也是这份资产,所以从市场一键装走的是同一条路。

**这份包是什么**:由仓库源码用 `npm pack` 打出,内容与 `v0.1.0` 这个提交一致
(`lib/index.js` + `lib/client.js` + `cordis.patch.yml` + 两份契约文档)。
仓库本身照常支持从源码安装 —— 那条路要先过 pnpm 的 `allowBuilds` 构建授权,
原因与修法写在仓库 README 的安装节。

**装完在哪**:侧边栏出现「GALFree 工作台」入口;设置里多一段 `dsh-galfree`
(新建项目的默认父目录、钉版 SDK 路径、图像/音乐/语音三条生成渠道)。

**已知边界**(如实说明,不是缺陷):
- 图像渠道要自己在设置里填端点与密钥(插件不预置任何渠道);
- 钉版 Ren'Py SDK 首次使用时要下载(约 155MB);
- 工作台里没有画面预览 —— 画面真实性由「试玩」承担(会真开游戏窗口)。
