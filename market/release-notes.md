**适配 DSH 0.1.7**(预构建安装包):里面已经有 `lib/index.js`(宿主半)、
`lib/client.js`(工作台半)与 **「Galgame 制作」agent preset**。装上就能用 ——
**不需要 git,也不需要 pnpm 的构建授权**(不存在安装期构建这一步)。

```
dsh plugin --profile web add "https://github.com/netori/galfree/releases/download/v0.1.2/dsh-galfree-0.1.2.tgz"
```

`dsh-market` / 社区市场里的条目指的也是这份资产,所以从市场一键装走的是同一条路。

**⚠️ 这一版要求宿主 ≥ DSH 0.1.7,而且只有它能在 0.1.7 上用。**
0.1.1 及更早那几版在 0.1.7 上的表现是**插件装不上/加载失败**:插件原来用的那套设置
API(`ctx.settings.register` + 客户端的 `settingsScope` / `settings.plugin.item`)
在 0.1.7 里被**整体删掉**,`apply` 第一句就抛,于是工具面、`/api/galfree/*` 路由与
工作台面板**一起没有**。0.1.2 把两半都迁到了新模型(宿主侧 `Config` 字段声明 `volatile`
并现读引用;客户端走 `ctx.configForms`),schema 库也换成宿主的 `@deepseek-ai/schemastery`。
**升级插件不会动你的项目**:`.studio/`、`.rpy`、快照链一个字节都不碰。

**这一版的界面在哪**:侧边栏「GALFree 工作台」入口照旧;**渠道配置换地方了** ——
0.1.7 把「设置 → 插件配置」整个撤掉,插件的配置面现在长在 **Plugins 页**(侧边栏的「插件」)
里本 bundle 的「配置」入口上(新建项目默认父目录、钉版 SDK 路径、图像/音乐/语音三条生成渠道)。

**「Galgame 制作」模式不用再手工装**:0.1.7 删掉了
`$DSH_HOME/.agent-presets/<id>/` 那个目录机制(随包文档原话:"Nothing reads that directory
any more"),旧的"拷四个文件进去"装法**静默失效**。preset 现在是随插件 bundle 一起发的
**声明行** —— 装完插件重启宿主,新建会话时 preset 选择器里就有「Galgame 制作」。
如果你之前装过旧目录,可以删掉 `~/.dsh/.agent-presets/galgame/`(没人读它了)。

**已知边界**(如实说明,不是缺陷):
- 图像渠道要自己在 Plugins 页里填端点与密钥(插件不预置任何渠道);
- 钉版 Ren'Py SDK 首次使用时要下载(约 155MB);
- 工作台里没有画面预览 —— 画面真实性由「试玩」承担(会真开游戏窗口);
- 这个 preset 要求插件**在场**(它只加立场与前置检查,不授予工具)。
