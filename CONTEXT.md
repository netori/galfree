# CONTEXT — 词汇表(Glossary)

**GALFree** — DSH galgame 制作工作台插件(工作区 `DSH_creator`)的领域语言。这里**只**记录已达成的术语共识;实现细节进 spec/代码,架构权衡进 `docs/adr/`。

## 术语

- **全流程(full pipeline)** — 插件目标范围:选题 → 剧本与分支叙事 → 立绘/背景/CG → 组装 → 可玩成品 → 本地发布。
  _避免_:"一条龙"、"全自动"(全流程 ≠ 无人参与)。
- **成品(game)** — 以 Ren'Py 项目形态存在、可被 SDK 运行/打包的 galgame。ADR-0001。
- **项目(project)** — 一部制作中的 galgame;权威载体 = 磁盘上一个 Ren'Py 项目目录(ADR-0003)。v1 项目**只从插件模板新建**,导入既有 Ren'Py 项目不进 v1(R5-Q4)。
- **发布(publish)** — v1 边界 = 钉版 SDK `build_dists` 产出本地发行目录/zip;**无**平台上传、**无**在线分发集成(R5-Q3)。
- **工作台(workbench)** — 插件内置的人用 Web 面板(ADR-0002);实时可视化 = 结构化视图,画面真实性由**试玩**承担。
- **DSH 端** — 运行插件的 DSH 进程一侧(agent 工具 + Host 服务),与工作台相对。
- **写网关(write gateway)** — 项目文件的唯一插件内落盘通道:Host 串行写、带版本戳(ADR-0004)。外部编辑器修改叫**观察**(监听→刷新),不叫同步。
- **快照(snapshot)** — 写网关每个写批提交后自动执行的本地 git commit,作者 `GALFree`(ADR-0011)。回滚与审计链由此而来;永不 push。
- **试玩(playtest)** — 一键用**钉版 SDK** 启动游戏真实运行,非实时嵌窗。技术通过(日志干净)可推导;"玩过了、行"是审读戳(ADR-0008)。
- **钉版 SDK(pinned SDK)** — 插件发版锁定版本、Host 自动下载供给的 Ren'Py SDK(ADR-0006);设置可覆盖路径。
- **图像子系统(image channel)** — 插件自建的生图设施:自有渠道(端点+密钥+模型目录)、素材任务队列;**不依赖 dsh-imagegen**(ADR-0010,取代 0007)。
- **项目元数据(`.studio/`)** — 目录内承载 Ren'Py 不表达的制作信息的文件。**铁律:只放引用与制作信息,永不复制叙述内容;悬空引用=校验错误**(ADR-0009)。
- **环节(subsystem stage)** — 横向建造的子系统:环节零(接缝契约)→ 剧本 → 组装试玩 → 素材 → 音频/发布(ADR-0005)。
- **环节零(stage zero)** — 接缝契约本身:脚手架 + 写网关骨架 + `.studio/` 契约 + 钉版 SDK 与最小校验回路。环节零交付 = 第一个可演示物。
- **进度(progress)** — 由项目文件+校验结果**机械推导**的状态,可全量重算,任何侧不得手改(ADR-0008)。
- **审读戳(review stamp)** — 人主观认可("这一幕定稿")的记录,存 `.studio/`;agent 不得擅设,重生成清戳(ADR-0008)。粒度在 spec 定(方向:场景级、素材槽级)。
- **分支图(branch graph)** — 从 `.rpy` 解析出的派生视图(可弃可重算);图上编辑=翻译成 `.rpy` 写(ADR-0009)。
- **素材槽(asset slot)** — 剧本对一个图像素材的待填位(立绘表情差分/背景/CG),被 `.rpy` 引用、由 `.studio/` 挂制作信息,填没填进推导进度。
- **音频渠道(audio channel)** — 音乐与语音**各一条**(ADR-0012:三条生成线各自一条渠道):各有一组端点 + 密钥 + 模型目录,设置里两段(`music*` / `voice*`),没配时按用途如实拒绝(`no-music-channel` / `no-voice-channel`)。任务账本仍是**一份**(`.studio/audio-tasks.json`),每条任务按自己的 `purpose` 找渠道。**用途只由目标路径判**(`game/voice/` 下 = 语音),调用方不声明(递了不一致的值当场拒)。入口:agent `galfree_generate_audio`(建)/ `galfree_audio_queue`(读 / 跑 / 重 roll),面板两张卡上的「新建任务」——**同一条写路、同一份账本**(T33)。
- **界面换皮(theme)** — 给 **Ren'Py 自带的界面生成器**(`gui7`)一组参数(主色/辅色/明暗/分辨率),在 staging 副本里跑一次引擎、把整套 `game/gui/*.png` 经写网关落盘 + 一条快照。**不是 AI 出图**(那整套图是九宫格模板画的,尺寸全是有意的像素值);`game/gui/` 下的封面三张例外(生成器不覆盖,归封面那条)。事实记 `.studio/theme.json`,`progress.theme` 推导"还是不是当前这一版"(记录分辨率 ≠ 项目现在 → 要重出)。
- **角色登记簿(character registry)** — `.studio/characters.json`:外观设定卡+画风锚+参考图链;图像子系统任务的强制一致性锚。
- **音色档案 / 声音锚(voice profile / voice anchor)** — 角色登记簿里那个角色的**嗓子**:参考样本(**服务端音色库里的文件名**,如 `xiao_tang.wav`)+ 可选情感输入(`follow`/`reference`/`vector`/`text`)+ 可选 `speaker`(LoRA 适配器名,**不是音色**)。音色**只由参考样本决定**(实测:同路径 ⇒ 同 speaker embedding 缓存命中 ⇒ 同一把嗓子),所以"跨场同角色同一把嗓子"= 这个文件名永不变。建语音任务时按台词派生的说话人**自动携链**;缺档案 → 任务上如实降级 `voice-anchor-missing`。**两个命名空间不许混**:服务端只在它自己的 `voices/` 目录里按名找,项目里的 `game/voice/…` 与它不是一个命名空间(写入前就拦)。换音色 = 设定改动。见 ADR-0012 / 契约「语音的声音锚」节。
- **设定集(story bible)** — 项目的第一记忆源:世界观、角色设定(同步落角色登记簿)、章节大纲、分支骨架。创作双模式(R6-Q3):**主题模式**(人给主题 → agent 产设定集 → 人编辑并盖"设定定稿"戳 → 按场景生成)与**大纲模式**(人给大纲 → agent 据此产登记簿与分支骨架,不覆盖人的大纲)。下游所有生成以设定集为上下文。
- **方言子集(dialect subset)** — 环节零钉死的 `.rpy` 生成/解析语法子集;结构解析器只承诺子集内可靠。

## 进行中(未收口)

- **环节零(T1–T7)到本地发布(T18)全部交付 —— v1 的八张环节票收口**。issues #9–#26 已关闭;
  还开着 **#1(Spec)**(长期开着)与 **v2 的四张票 #27–#30**。接缝契约成文:
  `docs/contracts/stage-zero.md`(含 T8–T19 各节 + 模板界面层 + 两种上游协议)+ `dialect-subset.md`。
  本会话交接见 `docs/handoff-2026-09-12-t18.md` §4(v2 方向)。
- 快带 `npm test`(**25 文件 262 测试**)全绿;慢带 `npm run test:slow`
  (**5 文件 36 通过 + 1 跳过**,跳过的是真上游参考链验证:它花钱,默认不跑)。
  慢带里的**本地发布**那条会真跑 `build_dists` 并**启动打出来的主程序**(实测 60 秒上下)。
  **发版前每次都要重跑**;慢带已改**串行**,跑它的时候别同时跑别的 vitest 进程
  (见过一次 0ms 全红的幻影失败,单独重跑即干净)。
- T14 把**写网关拓宽到二进制**(`WriteOp.content: string | Uint8Array | null`),版本戳
  一律按原始字节 —— 这是"素材经网关落盘"这条铁律的前置,不是旁路。T16 又给它加了一个
  **按字节读**(`readBytes`):参考链把项目内的图内联发给上游时要用,读不产生写。
- T15 的**动作面与 agent 工具面是同一条队列**(结构保证:两边都只是接缝的搬运工)。
  重 roll 覆盖前把被替换那一版的指纹记进尝试历史(`replacedFingerprint`)—— 旧内容留在
  写批前的快照里,"可对比"因此有据可查。
- T16 的**参考链从登记簿自动来**:槽账本的 `requiresCharacters` → 各自登记簿的 `references`
  → 建任务时自动携链(自引用排除、缺文件的如实降级),发送前把字节**内联成 data URL**
  (远端够不着项目内路径)。差分批量按"谁被谁引用"派生出图顺序(主视觉先出),
  `differentialGrid()` 给出同角色差分网格(登记簿 + 槽位历史,纯读),
  `rejections[]` 把人的拒收理由**只追加**地记在被拒的那一版上。
- **真上游实测把参考链打回来了两次**(2026-09-12,用户渠道 seedance):那个 Go 网关的
  `image` 字段是**单个字符串**(发数组 → 400,已修:目录可声明 `referenceField: "string"`);
  改对形状后又要求 **`images must contain public HTTP(S) URLs`** —— 它不收内联字节、
  也不收项目内路径。因此**对这条渠道:把该模型的「参考链」关掉**,让它如实降级而不是每次撞 400;
  要让链真正生效,缺的是"公网可取的地址"那一环(上游文件上传接口 / 用户图床),**属下一张票**。
  详见契约「参考链一致性回路(T16)」节的实测记录与 `live-chain.slow.test.ts`。
- **模板已补齐界面层**:新建项目从钉版 SDK 拷 `screens.rpy` 等四个界面文件 + 中文字体
  (思源黑体,项目内相对路径),并补 `gui.show_name` 等变量。缺这一层时**连关窗都会崩**,
  试玩永远失败 —— 详见契约"模板的界面层"节与交接文档 §3。
- **已验证**:出图在真上游跑通(异步任务制适配器)、用户项目 `D:\GALGAME\hjm` 已补界面层
  并加了 `rooftop_rain` 的菜单入口与图片定义(板 `lint.ok=true`、无孤立场景)。
- T17 的**音频是接进来的,不是生成的**:池 = `game/` 下的音频文件(派生,`.studio/` 里没有
  音频账本),引用口径 = **相对 `game/` 的路径**(从钉版 SDK 源码读出:searchpath 只有 `game/`、
  `search_prefixes` 只有 `""`),悬空引用 = `missing-audio`(error,定位到哪一场哪一行),
  接线走 `SceneEdit.setAudio` → 网关 + 快照。试听由试玩承担,认可靠人盖场景戳,
  **不做音乐生成与 TTS**。
- T18 的**发布**用钉版 SDK 的 launcher 项目跑 `distribute`(那不是引擎内置命令),
  默认 `pc` 包;前置检查**读同一份推导板**(lint 错 / 素材缺 / 音频悬空 / SDK 未就绪 /
  没声明 `build.name` / 输出目录在源树里 → 逐项拦下),产物落**项目源树之外**,
  事实记 `.studio/publish.json`(路径与状态,不是产物本身),`progress.publish` 推导新鲜度;
  平台上传与在线分发不做。
- **模板现在带 `build.name`,且界面补丁会在发行版里排除 `guisupport.rpy`**:
  没有前者 `build_dists` 会打出 `-pc/` 与 `.exe` 这种空名字的包;带着后者打出来的包
  **启动即 `ModuleNotFoundError: No module named 'gui7'`**。两条都是 T18 的慢带
  (打出真包并**启动主程序**)抓出来的真实模板缺陷,细节见契约的 T18 节。
  界面图(`game/gui/*.png`)是 Ren'Py 首次运行时生成进项目的 —— 所以**发布前先跑一次试玩**
  (前置检查 `gui-images-missing` 会拦)。
- **v2 方向(用户已拍板:A+B+C 全做 + 一个专用 agent 模式)**,四张票在 GitHub:
  **#27** agent 流程指引(往会话注入 playbook 段)/ **#28** 工具面补齐(建项目、设定集、
  编辑场景、音频接线、试玩、快照)/ **#29** 板上的「下一步」(`progress.nextActions[]`)/
  **#30** galgame 专用 agent preset(#30 依赖 #27 与 #28)。
  调研结论与 preset 的机制事实写在 `docs/handoff-2026-09-12-t18.md` §4(**别重查**)。
  **红线不变**:审读戳(场景/槽/设定集定稿)永远只有人能盖。
- **#27 已交付(T19)**:会话里多一段 `galfree-workflow` 的 system prompt section ——
  顺序(建项目 → 设定集 → **请人盖定稿戳** → 剧本 → 素材 → 音频 → 试玩 → 发布)、每一环的闸门、
  完成判据、谁来做、怎么问现状。**判据指板上的真字段、闸门用接缝真抛的码**
  (唯一出处 `src/service/gates.ts`),所以指引不可能跟接缝分叉。
  **工具面只报真的注册了的入口**:还没做的环节如实说"请人在工作台做",#28 补上后指引自动点名。
  宿主没有 systemPrompt 席位时少一段提示,插件不崩、工具照常。契约见「agent 流程指引(T19)」节
  —— 含**已知边界**:AC1 的现场验收要人做一次(重建 `lib/` + 重启宿主 + 新开会话)。
- **#28 已交付(T20)**:工具面补齐,**七个环节全部有 agent 入口**(建项目 / 设定集 / 场景编辑 /
  音频接线 / 试玩 / 快照历史与回滚)。每个都是接缝的搬运工:同一个动作从面板与从工具走,
  落到同一份账本与推导。**搬家(`relocateScene`)没有 agent 入口** —— 接缝上它 `#requireHuman`
  (它重写人的手写文件),要放开先提 ADR 修订。**审读戳的两道守卫**:显式工具名清单 +
  接缝对 agent 一律 `stamp-forbidden`。AC1 的证据是一段**只经工具调用**的端到端回放(快带)。
  契约见「全流程工具面(T20)」节;本会话交接见 `docs/handoff-2026-09-12-t19-t20.md`。
- **#29 已交付(T21)**:**板上的「下一步」** = `progress.nextActions[]`(纯推导,带 `actor` 与
  跳转 `target`)。它回答的是"接着做什么"(`problems` 回答"哪里坏了"),顺序固定(阻塞在前、
  打磨在后),板上没毛病时给一条 `publish-ready` 而不是空数组。**两个面读同一份**:
  面板舞台板最上面那行「下一步」(点得动)、以及 `galfree_project_status` 带回来的同一份
  (agent 不必自己从 problems 推顺序)。契约见「板上的「下一步」(T21)」节。
- **#30 已交付(T22)**:**galgame 专用 agent preset** 在仓库里可复现(`presets/galgame/`):
  组装 = 随包 `standard` + 两处声明的改动(专用立场、前置检查行),由守卫对着参考副本逐行比对;
  前置检查在**插件缺席时带原因地拒绝**(会话创建失败并指名那一行),而不是静默少几个工具。
  插件与 preset 的两种摆法**互斥**(都装会重复注册设置命名空间与路由),README 写明。
  契约见「galgame 专用 agent preset(T22)」节。
- **#31 已交付(T23)**:**分支选项 / 按钮显示方块字**(用户实测)。根因是 SDK 的 `gui.rpy` 里两条
  **拷贝赋值**(`gui.button_text_font = gui.interface_text_font` /
  `gui.choice_button_text_font = gui.text_font`)—— 中文字体补丁只改了 text/name/interface 三处,
  于是对白正常、选项与按钮读的是被抄走的 DejaVuSans → 方块。补丁现在把那两条按新值重推一遍;
  **模板只修新项目**,老项目要往 `game/zz_galfree_ui.rpy` 补那两行(**目前没有机制主动告知**)。
  守卫在 `ui.slow.test.ts`:init 探针看变量、**运行时探针**看样式 —— 后者才是真值
  (init 阶段读 `style.*.font` 得到的是还没应用完的引擎默认值,这一点也实测过)。
  **两个既有项目已经补上**(2026-09-12,经写网关各一条快照):`hjm`、`before_the_rain`;
  在**副本**上用真引擎复核过:变量与样式(渲染真正用的值)都指到了中文字体,无 traceback。
- **#32 已交付(T24,2026-09-12)**:**试玩卡住**。根因是形状不是 bug —— 工具体同步等游戏窗口
  被关掉、**没观察 `exec.signal`**(宿主取消是协作式的)、缺省上限 15 分钟、面板运行中不能取消。
  现在:`signal` 一路传到子进程;缺省等待 **15 分钟 → 3 分钟**(有界,可按次给);被取消的那一次
  **不记账本**;面板有「取消试玩」(`POST /playtest/cancel` 与宿主中断同一个信号);
  `progress.playtestRunning` 让 agent 起的试玩也看得见。
  **两个实测事实**(改 `spawn-log.ts` 前先读):Windows 上 `child.kill()` 是**同步**的
  (`close` 紧接着来、`exitCode` 也被同步设上,拿它判"退没退"会丢掉超时/取消的原因);
  "我发了信号但它没停"要照实说(`killed` 回执 + 宽限窗口)。契约见「试玩不会把人绊住」节。
- **v3 生成线(#33–#39,ADR-0012/0013 已于 2026-09-12 经发起人批准)**:**音乐自动生成 +
  语音(TTS)自动生成 + 封面/主菜单/窗口图标**。批准那次把 v1 的两条边界放宽了
  (契约「音频接线」节的"没有音乐生成、没有 TTS"、ADR-0005 环节 4/5)。
  `docs/adr/0012-generation-channels.md`(三条生成线各自一条渠道;端点可填,聚合站/自建反代/
  本地服务同一条路)/ `docs/adr/0013-voice-wiring-by-dialogue-id.md`(语音接线:
  **对话 id + `config.auto_voice`**,剧本里不写 voice 语句)。
  **#34(T26)已交付**(2026-09-12):方言子集加行尾 `id <name>` 子句;生成侧
  `stampDialogueIds` 按序号盖章(幂等);指纹剔掉该子句,否则每次生成语音都要人重盖戳;
  模板写死 `config.auto_voice = "voice/{id}.ogg"`。真引擎验过:**导出的是我们盖的 id**
  (不是内容哈希)、lint 干净、**缺语音文件不崩**。
  **#35(T27)/#36(T28)/#37(T29)/#38(T30)/#39(T31) 都已交付**;开着的那三张(#36/#37/#38)
  等的是**真机验收**(真打一次上游 / 真出一张封面),不是等开发。
- **#39(T31)已交付(2026-09-13)**:**游戏内界面换皮** —— 不是 AI 出图,是给 Ren'Py 自带的
  `gui7` 生成器一组参数(主色/辅色/明暗/分辨率)。做法:在 **staging 副本**里跑一次钉版引擎,
  收整套 `game/gui/*.png`,经写网关**一个写批**落进项目 + 一条快照;`.studio/theme.json` 记事实,
  `progress.theme` 推导"还是不是当前这一版"(记录分辨率 ≠ 项目现在 → `stale` 要重出)。
  分辨率对不上**如实拒绝**(整套图按 `scale = min(w/1280, h/720)` 缩放,尺寸错了不报错、只是整屏歪)。
  入口:面板「界面换皮」卡 + agent `galfree_theme`;路由 `GET /theme`、`POST /theme/preview|apply`。
  **三条反直觉的引擎事实**(实测过,别照 docstring 想象,详见契约「游戏内界面换皮」节):
  `tint`/`shade` 是**线性 RGB** 插值(`Color('#ff0000').tint(.5)` = `#ff7f7f`,不是 HLS 的 `#df9f9f`);
  `replace_hsv_saturation`→`replace_value` 的中间值**留在浮点里**(转成 RGB 字节再转回来会差一个色阶);
  读 `.hsv` 时分量 **round 到 8 位小数**(`#c94f7c` 的 title 色差的就是这一格)。
  慢带 `theme.slow.test.ts`:真引擎出一套 + 逐值对颜色 + 1080p 按 1.5 重出 + 换完起得来。
  **一条反直觉的 SDK 事实**(决定 #34 的设计,别重查):不给显式 `id` 时,对话标识符是
  **内容哈希**(`renpy/translation/__init__.py:337-357`)—— 改一个字那句语音就找不到;
  显式 `id <name>` 子句给出的标识符**与内容无关**(`renpy/parser.py:1491`),所以文件名锚必须是它。
  **另一条**(决定 #38/#39 的分工,别重查):`game/gui/*.png` 那一整套界面图**不是静态资源**,
  是 `launcher/game/gui7/`(`images.py` + `parameters.py`)按**九宫格模板 + 参数**
  (accent / boring / light / 分辨率,基准 1280×720 按 `scale=min(w/1280,h/720)` 缩放)**程序生成**的
  —— 所以"界面换皮"的正确做法是给那个生成器一组参数(#39),**不是**拿 AI 出 100 张尺寸敏感的图;
  AI 出图该管的是封面 / 主菜单背景 / 窗口图标(#38)。
  **第三条**(#38 的坑):`config.window_icon` 指向的文件不存在时引擎**不兜底**、
  **启动期就崩**(只 `except DownloadNeeded`,`display/core.py:1044-1071`)—— 顺序不能反:
  先落图,再设 config。
- **#40(T32)已交付(2026-09-13)**:**语音的声音锚** —— 每个角色一份参考音频(登记簿的**音色档案**),
  建语音任务时按台词派生的说话人**自动携链**;没有就**如实降级并说明**(而且一个请求都不发出去)。
  起因是发起人的真问题「IndexTTS 没有设计音色的功能,如何保持声音一致性?」—— 调研
  (`docs/research-indextts-voice.md`)坐实三件事:**音色只由参考样本决定**(同路径 ⇒ 同缓存 ⇒ 同一把嗓子)、
  **`speaker` 不是音色**(它只选 LoRA 目录,本机 `runs/` 空 ⇒ 只有 `default`)、
  **`audio` 才是音色**(参考样本**文件名**,服务端只在**它自己的 `voices/`** 里按名找)。
  同时修掉适配器两处错位(`voiceId` 不再当 `speaker` 发;项目内路径不再被当音色库文件名发),
  并把情感显式化(`follow`/`reference`/`vector`/`text` → `emo_control_method` 0/1/2/3;没配就不发)。
  新增:读音色库(`GET /health` `/speakers` `/voices`,**逐端点如实报**;`/speakers` 是 LoRA 名、
  不是音色)、嗓子清单接缝 + 面板(角色视图里改音色、语音卡上看"还差谁没嗓子")、
  agent `galfree_voice_anchor`。路由 `/audio/voice/anchors`(GET)、`/audio/voice/library`(POST)。
  **一条 API 纪律**:`/cast/characters/upsert` 从 T32 起"**没提到的字段就保留**"
  (`voiceProfile: null` = 明确清掉)—— 否则"改一次嗓子把参考链冲掉"会静默发生。
  **现实**(如实告知,不是缺陷):那台服务**没有上传接口**,`voices/` 只能人把文件丢进去;
  想在项目侧闭环走**语音批量清单**(T29)。
- **#41(T33)已交付(2026-09-13)**:**建音频任务的入口** —— 这一票补的是 #36/#37 之间那条缺口:
  适配器、队列、落盘、面板卡都通了,但**没有人能"建"一条音频任务**(22 个工具里没有它;面板只有
  "跑队列/重 roll";客户端那个 `createAudioTask` 是**没有任何组件在调**的死代码)。
  现在:agent `galfree_generate_audio`(音乐与语音**共用一条**:用途按目标路径判,
  `game/voice/` 下 = 语音;模型 id 必须属于那条渠道的目录)+ `galfree_audio_queue`(读 / 跑 / 重 roll),
  面板两张卡各一个「新建任务」表单(模型从渠道目录选,按钮上写着成本)。
  **顺带修掉两处半成品**:`CreateAudioTaskInput.run` 此前只是文档里写着、接缝根本没读
  (面板那条路由自己补跑了一次 ⇒ "面板建的会跑、工具建的只入队");排队数此前在三处各算一遍
  (现收进 `countAudioTasks` 一处;分叉的后果就是 T27 踩过的"面板说的条数 ≠ 真发出去的条数")。
  **成本分两个数**:`attempted`(这一下真跑过几次)与 `pending`(此刻排队中、跑队列会真发的条数)——
  `run` 缺省 true 时"这一跑"已经跑过了,只报队列数就是空话。
  **现实**:能建 ≠ 上游认 —— 第一次真打那家音乐上游仍归 **#36**(真机验收)。
  交接见 `docs/handoff-2026-09-13-t33.md`;契约见「建音频任务的入口」节。
- 遗留:人工验收还欠"点一次试玩看窗口能否正常退出"(#32 的真机那一步);`alice` 还没进角色登记簿(warning);  **参考链在用户渠道上不可用**(上游只要公网 URL,建议关掉该模型的「参考链」);
  **老项目**(`hjm`,旧模板建的)缺 `build.name` 与界面补丁里那两行 `build.classify`,
  发布会被如实拦下。
- **两处已知的测试缺陷已收口(2026-09-14 · commit `7ca9dda`)**:
  1. **快带的偶发失败**(约 1/278)已查清并加守卫:`async-image.test.ts` 里"同步适配器遇到
     异步上游"那条,在机器忙时上游连接**根本没成**(`TypeError: fetch failed`),而此时
     适配器压根没从上游拿到任何东西 —— 断言却期望错误里出现"指向 async-task"那句提示。
     原来那条对"连接就没成"这种结局没有兜底。现在**两种失败分开**:传输层失败如实带回原话、
     且**不许**冒充协议错配(连接没成时说"该换协议"是把人指错方向);
     新守卫 `上游连不上(传输层失败)` 用**变异验证过**(把传输错伪装成协议提示 ⇒ 该条必红)。
  2. **慢带 `EPERM: unlink …\renpy-pinned\renpy.exe`**(此前记为"必红")已修:
     断言里那两条本来都过,红的是 `afterEach` 的清理 —— 实测机制是
     **活着的进程只要 cwd 还落在那个目录里,`rm` 就抛 `EPERM`/`EBUSY`;进程一退立刻删得掉**。
     修法不是放宽断言:`cleanupTempDirs` 现在自己退避重试(约 1.9s,Node 的 `maxRetries`
     默认退避对这个场景不够),并且**返回真删不掉的路径**而不是静默吞掉
     (静默吞掉 = 把"临时目录在漏"变成看不见的事)。守卫在 `src/testing/tmp.test.ts`
     用**一个真子进程占住 cwd** 复现那个窗口,**变异验证过**(换回不重试的旧实现 ⇒ 两条新用例必红)。
     注:刻意**没有**用"文件句柄"去构造这个用例 —— 实测在读句柄下 `rm` 照样成功,
     那种写法是空的(写过一版,验证时发现它是假绿,已换掉)。
- **宿主错误日志里那条反复出现的报错已修(2026-09-14 · commit `8a2f5d1`)**:
  `Error: cannot get property "tools" without inject`(来自 `lib/index.js`)。
  **机制**(真 cordis 上实测):`ctx` 是代理,读一个**没写进本插件 `inject`** 的服务会**抛**,
  不是返回 `undefined` —— 而"可选席位"的定义恰恰是"不依赖它"。两处接缝以前写的是
  `(ctx as { tools?: X }).tools`,类型上盖住了、运行时照抛:
  `toolRegistrySeam`(流程指引的工具探针)与 `directoryPickerSeam`(四个目录选择入口)。
  后果是 playbook 那段在真宿主上**根本装不进系统提示**。
  修法:新增 `optionalService(ctx, name)`,走 cordis 的 **`ctx.get(name)`**(不要求 inject,
  缺席返回 `undefined`),两处接缝都改走它。
  **一条容易上当的边界**:在**非运行态** fiber 上属性读法**碰巧不抛**,
  所以"随手一读没报错"不能当它对 —— 真宿主里这段跑在**嵌套 `inject` 回调**中,那里就是抛。
  守卫在 `src/index.test.ts`(真 Context + 真嵌套 inject),变异验证过(改回属性读法 ⇒ 必红)。
  **改完必须 `npm run build`**:宿主加载的是 `lib/index.js`,不重建就还是旧代码。
- **workspace-registry 的 `session header is missing` 警告与 GALFree 无关**:它出自
  `@deepseek-ai/dsh-workspace` 的 `reportFilteredCandidates()` —— 某条 workspace 记录
  (`~/.dsh/storages/workspace.json` 的 `sessionIds`)引用的会话没被索引到(会话被删/归档),
  于是那条会话被从成员里过滤并记一条 warn。**插件侧一行都不碰 workspace/session**
  (`git grep -i workspace src/` 为空),所以别把它算在本插件头上。
- **CI 已加(2026-09-14 · commit `7f65200` · `.github/workflows/ci.yml`)**:
  在它之前"快带 + 慢带 + 发版前必跑"只写在文档里,没有东西把关。
  - **fast**(push / PR):`npm ci` → typecheck → build → `npm test`,矩阵
    [ubuntu-latest, windows-latest](Windows 与开发机一致;Ubuntu 是跨平台哨兵),
    末尾断言 `lib/index.js` / `lib/client.js` 存在(宿主/面板真正加载的东西)。
  - **slow**:只能 `workflow_dispatch` 手动 —— 它要下 155MB 钉版 SDK、**真起游戏窗口**、
    真打一次包,托管 runner 没有显示器。发版前在有显示器的机器上跑。
  - **上线时它当场抓到两件**(都已修):① `package-lock.json` 与 `package.json` 不同步
    ⇒ `npm ci` 会直接失败;② `src/testing/tmp.test.ts` 两条用例断言的是 Windows 专有行为
    (活进程占着 cwd ⇒ `rm` 抛 EPERM),POSIX 不阻止删除 ⇒ Linux 上会红,已改 `it.skipIf`
    并补一条 POSIX 对照用例。**教训**:CI 的价值之一就是逼出这类"只在开发机上成立"的假设。
  - ⚠️ **Ubuntu 那条腿本机没法验证**(手边只有 Windows)。首次在 GitHub 上跑出来的结果才是
    它的第一次真实验证 —— 如果它红了,那是**真实信息**,别当成 CI 配错了。
  - **首次实跑的结果:Ubuntu 腿红了,抓到 3 个"只在 Windows 上成立"的假设**:
    ① `composite-validator.test.ts` 硬写 `renpy.exe`,而生产是用 `platformLauncherName()`
    去探的(非 Windows 是 `renpy.sh`)⇒ 探不到启动器 ⇒ 验证器升不上去 ⇒
    `expected 'fake' to be 'sdk'`。**已修**(改用 `platformLauncherName()`),这也是
    "CI 的价值就是逼出这类假设"的又一个实例。
    ②③ 都在 `write-gateway.test.ts`,**都还没修**(见下)。
  - **Ubuntu 腿已改成"观测"(不拦合并)**:Windows 腿是门禁(与开发机一致,机械保证落在它身上),
    Ubuntu 腿照跑、结果照看得见,但 `continue-on-error`。**理由不是嫌它红,是②③ 没法验证修法**
    —— 手边只有 Windows,而它们都在写网关的观察/回滚时序里(就地写 + 350ms settle 定时器 +
    断言里固定 sleep)。按本仓库纪律:**没归因就不改、不为让它变绿而掩盖**。
- **两个待修的跨平台问题(2026-09-14 由 CI 的 Ubuntu 腿发现,尚未修)**:
  都在 `src/service/write-gateway.test.ts`,**只有 Linux 上红**:
  1. 「网关自写不伪装成外部修改:网关写批只产生 internal 事件」——
     Linux 上 `forRel.every(kind === 'internal')` 为假,出现了 `external`。
     相关实现:`write-gateway.ts` 的就地写(不是 temp+rename)、`#inFlight`/`#settling` 抑制、
     以及 **350ms 的 settle 复查**(`setTimeout(..., 350)`);而用例只等**固定 400ms**。
     同文件另一条(观察外部改动)用的是 `expect.poll(..., timeout: 4000)` —— 这条是固定 sleep,
     两者不一致,固定 sleep 本身就是个可疑点。
     **要修的其实是"抑制逻辑在各平台都成立"**,不是把断言放宽。
  2. 「落盘中途失败 → 已写文件回滚为旧内容」—— 用例用"把已存在文件当目录"
     (`game/script.rpy/impossible-child.rpy`)来逼出落盘失败,期望 `write-failed`;
     **Linux 上先得到 `read-failed`**:`read()` 只把 `ENOENT`/`EISDIR` 当"缺失"
     (`write-gateway.ts:115`),而 POSIX 读这种路径给的是 **ENOTDIR** ⇒ 在读那一步就抛了,
     于是**回滚根本没被验到**(这条用例在 Linux 上其实是空的)。
     候选修法(二选一,都得在 Linux 上验):把 `ENOTDIR` 也归入"缺失"(语义上更准:祖先不是
     目录 ⇒ 该文件确定不存在),或换一种跨平台的方式逼出"第一个文件写成功之后才失败"。
  - **同时问自己一句**(未决):插件的 Linux 支持到什么程度是承诺?
    `platformLauncherName()` 是有 `renpy.sh` 分支的,说明当初是打算支持的。
- **`reference-chain.test.ts` 的负载敏感 flake:查过,但**没能复现**,所以**没有动它**
  (2026-09-14):
  - 症状:满带跑时偶发 `expected 'failed' to be 'awaiting-review'`(那一条跑的是真本地 HTTP
    假上游);该文件单独跑 28–35 秒,**满载下 65–72 秒**。
  - 复现尝试:**连跑 3 次满带全绿**;算上先前那次,约 **5 次里红 1 次**(≈20%)。
  - 已做(唯一能确定有用的事):5 处 `awaiting-review` 断言收进 `expectAwaitingReview()`,
    失败时把 `state` 与 **`lastError` 原话**一起报出来 —— 下次再红就能直接归因,
    不必再从头复现(与 `async-image` 那条"两种失败要说得出区别"同一件事)。
  - **量过的一个候选方案,结论是不做**:把 worker 数压到 4(本机 24 核)⇒ **125 秒 vs 87 秒**,
    慢 44%,而对稳定性只是**推测**有益。拿 44% 的墙钟时间换一个没证据的好处,不划算。
  - **没做归因就不修**:`async-image` 那条同类的、文档记过的成因是满载时 `fetch failed`,
    但**那不是这条的证据** —— 按本仓库的纪律("看着像"不等于事实),不据此加"重试"来掩盖。
