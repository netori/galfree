**适配 DSH 0.2.0**(预构建安装包):里面已经有 `lib/index.js`(宿主半)、
`lib/client.js`(工作台半)与 **「Galgame 制作」agent preset**。装上就能用 ——
**不需要 git,也不需要 pnpm 的构建授权**(不存在安装期构建这一步)。

```
dsh plugin --profile web add "https://github.com/netori/galfree/releases/download/v0.2.0/dsh-galfree-0.2.0.tgz"
```

`dsh-market` / 社区市场里的条目指的也是这份资产;而市场**主路径**是 npm
(`dsh plugin --profile web add dsh-galfree`),两边装到的是同一版。

**⚠️ 这一版修的是"装上了却不见"。** 0.1.2 的 peer 范围写的是 `>=0.1.5-0 <0.2.0-0`,
而 `dsh-app-boot` 会对每一条 `@deepseek-ai/dsh*` peer 逐个跑 `semver.satisfies(宿主版本, 范围)`,
**任何一个不满足就整条 entry 禁掉** —— 在 DSH 0.2.0-rc.2 上就是:包在 `node_modules` 里、
profile 里的配置行也在,但工具面、`/api/galfree/*` 路由与工作台面板**一起没有**,
宿主日志里只有一行"skipping"。0.2.0 把上限放开到 `<0.3.0-0`
(且 `peerDependenciesMeta.optional` **不豁免**这类检查 —— 别指望它)。**升级插件不会动你的项目**:
`.studio/`、`.rpy`、快照链一个字节都不碰。

**这一版新增的三件事**(都是"生成完了"与"玩起来是对的"之间的那几步):

- **舞台层**:现代 Ren'Py 不再自动定义图片名,所以 `scene bg ferry` 会变成灰底占位、
  `show 角色 表情` 会**直接抛异常把游戏打崩**;两个立绘还会叠在同一处。现在整备一次
  (`galfree_stage` 的 sync / 面板上的「整备舞台」)就会写出显式 `image` 定义与 `at` 站位子句,
  落在生成物 `game/zz_galfree_stage.rpy` 里 —— 只接管 `gf_` 开头的名字,人写的 `at left`
  与自定义 transform 一个字节都不动。
- **演出字色**:`gf_c_device / gf_c_warn / gf_c_cold / gf_c_accent` 四个槽,**只在标了
  `# galfree:perf` 的演出场用**,每 20 行对白最多 1 处、每场最多 2 种色。配额不是拍的:
  颜色只在单色基线上才有重音;四个槽的对比度都按 WCAG SC 1.4.3 Note 5 验过 ≥ 4.5:1。
- **语音接线改成函数形态**:不同的 TTS 给不同的容器 —— 小米 MiMo 只给 `wav/mp3/pcm`
  (向上游要 ogg 会被回 `Unsupported audio format: ogg`),本地 IndexTTS 给 ogg。
  老形态(字符串)只能钉**一个**后缀,钉错了的表现是**引擎不报错、试玩也照过、就是没声音**。
  现在按磁盘上真有的后缀找,而且**配音落盘那一刻就顺手把接线修好**(同一个写批)。

**已知边界**(如实说明,不是缺陷):
- 图像/音乐/语音三条渠道都要自己在 Plugins 页里填端点与密钥(插件不预置任何渠道);
  语音那一段的模板现在只有小米 MiMo 一条;
- 钉版 Ren'Py SDK 首次使用时要下载(约 155MB);
- 工作台里没有画面预览 —— 画面真实性由「试玩」承担(会真开游戏窗口);
- `mimo-v2.5-tts-voiceclone` **没接**(样本要随每次请求重发,是成本形状问题),传它的
  model id 会被明确拒绝;
- 这个 preset 要求插件**在场**(它只加立场与前置检查,不授予工具)。
