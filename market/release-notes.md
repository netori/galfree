**预构建安装包**(334 KB):里面已经有 `lib/index.js`(宿主半)、`lib/client.js`(工作台半)
与 **`presets/galgame/`**(「Galgame 制作」那个 agent preset)。装上就能用 ——
**不需要 git,也不需要 pnpm 的构建授权**(不存在安装期构建这一步)。

```
dsh plugin --profile web add "https://github.com/netori/galfree/releases/download/v0.1.1/dsh-galfree-0.1.1.tgz"
```

`dsh-market` / 社区市场里的条目指的也是这份资产(条目 PR
[awesome-dsh-plugin#5678](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/5678)),
所以从市场一键装走的是同一条路。

**这一版比 0.1.0 多了什么**:`presets/galgame/` 进了发行包。原因是查出来一个真实缺陷 ——
preset 的 `guard.mjs` 在插件缺席时会报错并叫人去看 `presets/galgame/README.md`,
而 0.1.0 的包里**根本没有 `presets/`**,那条指引是悬空的;从市场装的人也就拿不到
这个 preset(它不在插件里,是旁边一个目录)。0.1.1 把四个文件(外加插件自身测试用的参考副本)
一起发了,安装方式写在 preset 的 README 里:

```powershell
# 从你装好的插件里拷出来(profile 名按自己的改)
$src = "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-galfree\presets\galgame"
$dst = "$env:USERPROFILE\.dsh\.agent-presets\galgame"
New-Item -ItemType Directory -Force -Path $dst | Out-Null
Copy-Item "$src\preset.yml", "$src\agent.cordis.yml", "$src\guard.mjs", "$src\README.md" -Destination $dst
```

**装完在哪**:侧边栏出现「GALFree 工作台」入口;设置里多一段 `dsh-galfree`
(新建项目的默认父目录、钉版 SDK 路径、图像/音乐/语音三条生成渠道);
拷完 preset 并重启宿主后,新建会话时能在 preset 选择器里选「Galgame 制作」。

**已知边界**(如实说明,不是缺陷):
- 图像渠道要自己在设置里填端点与密钥(插件不预置任何渠道);
- 钉版 Ren'Py SDK 首次使用时要下载(约 155MB);
- 工作台里没有画面预览 —— 画面真实性由「试玩」承担(会真开游戏窗口);
- 这个 preset 要求插件**在场**(它只加立场与前置检查,不授予工具);插件没装时
  会话创建会**带原因地失败**并指名那一行,而不是静默少几个工具。
