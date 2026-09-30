# 方言子集 galfree-subset-1(环节零接缝契约 · 第一块)

结构解析器与剧本生成**只承诺本子集**内可靠(ADR-0009)。子集外语法的处理规则:
**如实报告 + 所在场景降级只读,不静默、不覆盖、可解析部分仍产出**。
生成侧(agent 写剧本)只允许产出本子集内的语法。类型定义见 `src/service/rpy/dialect.ts`,解析器为 `src/service/rpy/parse.ts` 的纯函数 `parseRpy(files)`。

## 词法

- 文件为 UTF-8,行尾 LF;注释 `#` 至行尾(字符串内不算)。
- 缩进:空格,块体相对块头至少 +4(解析器只要求"更深",推荐 4)。
- 字符串:`"..."`,支持 `\"` `\\` `\n`;**不支持**相邻字符串拼接(`""`)与三引号多行串。
- 标识符(label 名 / 说话人变量):`[A-Za-z_][A-Za-z0-9_]*`。

## 顶层语法(列 0)

| 形态 | 处理 |
|---|---|
| `label <NAME>:` + 场景块 | 场景节点(分支图节点) |
| `define <var> = Character("<显示名>")` | 角色登记(说话人显示名来源) |
| `image <名…> = <任意>` | 图像定义登记(表达式不透明) |
| `define` / `default`(其他) | 不透明声明,跳过 |
| `screen` / `transform` / `style` / `init` / `python` / `translate` / `testcase` / `flow` 等块 | **子集外**:warning(顶层问题)+ 整块跳过 |
| 其他无法识别的列 0 行 | warning + 跳过该行 |

## 场景内语句(label 块体)

| 形态 | 语句 |
|---|---|
| `"文本"` | dialogue(旁白,speaker=null) |
| `<var> "文本"` | dialogue(speaker=var) |
| 上述 + ` with <trans>` | 同上(转场修饰) |
| 上述 + 行尾 `id <name>` | 同上,并记下 `id`(**语音文件名的那根锚**,见下) |

每条 dialogue 附带 `showing`:该句发生时刻画面的图像引用快照(背景 + 在场立绘),
由解析器维护舞台状态得出 —— 兑现"对白行(说话人/文本/图像引用)"三要素。

### 行尾 `id <name>` 子句(T26 / ADR-0013)

**为什么要它**:Ren'Py 的 `config.auto_voice = "voice/{id}.ogg"` 按**对话标识符**找语音文件,
而不给显式 id 时那个标识符是**内容哈希**(`renpy/translation/__init__.py:337-357` 的
`md5(say 的代码)[:8]`)—— **改一个字,那一句的语音文件就找不到了**。而本产品逐场重生成是常规动作。
显式 `id` 子句给出的标识符与内容无关,所以文件名锚必须是它(实测见 ADR-0013)。

- **形态**:`e "文本" id ch1_0007`;可与 `with` 子句**任意顺序**(引擎 `finish_say` 是个循环,
  `parser.py:1479-1493`)。`name` 照抄引擎的 `l.name`:字母/下划线开头,其余字母数字下划线。
- **它是制作信息,不是叙述内容**(ADR-0003/0009):`sceneFingerprint` 会**剔掉行尾 id 子句**
  再算(`dialogue-id.ts` 的 `sceneTextForFingerprint`),否则每生成一次语音都会令审读戳失效。
  剔除只发生在行尾子句上 —— `e "这句话里有 id 这个词。"` 不会被误剔。
- **两种坏形态是 error,不是 warning**(与 `duplicate-label` 同级):名字不合规则、同一场里重名
  (重名会让两句抢同一个语音文件)。
- **生成侧**:`stampDialogueIds(source, label)` 给一场戏的对白按序号盖 id
  (`<label>_0000` 起,**幂等**,改台词不掉 id);块构造里的行不碰(那些行本来就子集外)。
- **慢带证据**:`dialogue-id.slow.test.ts` —— 真 `lint` 干净 + `renpy <项目> dialogue None`
  导出的标识符**就是我们盖的那个**(不是引擎的哈希)。
| `scene <名…>` / `show <tag> [属性…] [at <变换…>] [with …]` / `hide <tag>` | image 引用(**素材槽派生输入**);`at` 子句是**立绘站位**,见下 |

### `at` 子句与舞台层(T39,2026-09-30)

`at` 里的名字是 `transform` 的名字,**可以逗号分隔多个**。两条必须记住的事实:

1. **引擎的 `at a, b` 是 a 在内层、b 在外层**(`renpy/exports/displayexports.py:494`:
   `for i in at_list: img = i(child=img)`)。所以"动作 + 站位"要写
   `at <动作>, <站位>` —— 站位在外,才算在**缩放之后**定位。
2. **以 `gf_` 开头的站位名归插件管**:「整备舞台」会按"此刻台上有几个人"把它们重排。
   要自己钉死位置,用引擎自带的 `left`/`center`/`right` 或你自己的 `transform` ——
   那些一律不碰(`stage.ts` 的 `isManagedPlacement` 只认表里的名,判据刻意写得很窄)。

定位名与效果定义在生成物 `game/zz_galfree_stage.rpy`(见「舞台层」小节)。
| `menu:` 块 | 选项菜单;选项 = `"文案":` + 块体;菜单提示 = 纯字符串行 |
| `jump <LABEL>` | 跳转边 |
| `call <LABEL> [from …]` | 调用边 |
| `return` | 返回 |
| `with <trans>` | 转场 |
| `pause [秒数]` | 停顿 |
| `play music|sound|voice "文件" [loop]` / `stop …` | 音频接线(T17 的语法基础) |

音频引用的**口径**(T17 定稿,从钉版 SDK 源码读出):字符串是**相对 `game/` 的路径**
(`renpy.py:predefined_searchpath` 的默认 searchpath 只有 `game/`,`config.search_prefixes`
默认 `[""]`)—— 不存在"自动在 `audio/` 里找"。悬空引用 = error(`missing-audio`),
详见 `stage-zero.md` 的「音频接线(T17 之后追加)」节。

## 场景内子集外(触发只读降级)

- 条件/控制流:`if` / `elif` / `else` / `while` / `for` / `block`
- Python:`python:` / `python.` 一行式
- 屏语言与布局:`add` / `bar` / `vbar` / `imagebutton` / `textbutton` / `input` / `viewport` / `use` / `showscreen` / `window` / `nvl` / `centered`
- `show/scene … :`(ATL 块)、`transform` 引用表达式
- 其他无法识别的行

降级语义:所在场景 `readOnly=true`,每个子集外构造记录一条 warning(含行号与原文 snippet);
块构造跳过整块继续解析后续行;其余场景不受污染。

## 结构校验(fake validator 的 error 集;真 SDK lint 输出映射进同一形状)

| code | 含义 |
|---|---|
| `duplicate-label` | label 重复定义 |
| `dangling-jump` | jump/call/menu 目标 label 不存在(悬空引用=校验错误,ADR-0009 铁律) |
| `no-start-label` | 有场景但缺 `label start:`(主菜单入口) |

`ValidationReport = { ok, problems[], validator: 'fake'|'sdk', at, sdkNote? }`;`ok = 无 error 级问题`。

## 边界与后续

- 本表钉死于环节零;扩语法需先改本文件 + 解析器 + 模板,并过慢集成带(真 SDK lint)验证。
- **T26 的那次追加**(行尾 `id <name>` 子句,见上):它不是"扩到子集外",而是**把子集补全**
  —— 写进去的一直是引擎认的语法,只是我们以前不解析它。同批做掉的还有 `sceneFingerprint`
  剔除该子句(否则语音生成会让人重盖戳)。慢带证据 `dialogue-id.slow.test.ts`。
- `.studio/` 账本对图像引用的挂账见 `stage-zero.md`(T7 收官时定稿的总契约)。

## 舞台层(T39,2026-09-30)

**它修的是两个用户实测报上来的 bug**,两条根因都不是"写错了",而是**少了一环**:

| 现象 | 根因(实测) |
|---|---|
| 自动化创作跑完之后**打开游戏就报错**:`Exception: Image 'qiu_yan' does not accept attributes 'worried'` | 素材图从没被显式定义过图片名。现代 Ren'Py 的 `config.automatic_images` 是 `None`(SDK 的 `00obsolete.rpy`),8.5 的 `images/` 目录扫描只按**文件名字面**注册(`bg-ferry.png` → 名字 `bg-ferry`),而素材槽的口径是 `tag + 属性`(`bg ferry`)—— 两个名字对不上,引擎先找不到 `qiu_yan worried`、退到 `qiu_yan`,多出来的属性无处安放就抛。 |
| **两个立绘同时出现时重叠** | 剧本里的 `show` 没有 `at` 子句,引擎把它们放在同一个默认位置。 |

**做法**(纯推导,可全量重算):`stage.ts` 从 `.rpy` 的 show/scene 引用推出槽清单,再从磁盘看哪些素材真在,
生成 `game/zz_galfree_stage.rpy`(**生成物,可弃可重算**):

1. **图片定义** —— 只为**磁盘上真有的**图写(`image bg ferry = "images/bg-ferry.png"`)。
   还没出的槽不写:写一个不存在的路径会让引擎在显示时读到报错屏,比"灰底占位 + 板上写着缺素材"糟。
2. **站位变换** `gf_*` —— 按在场人数分档(1 人居中 / 2 人左右 / 3 人以上一起缩),
   以及入场与演出动作(`gf_in_*` / `gf_focus` / `gf_recede` / `gf_shake` / `gf_breathe` / `gf_close`)。
   缩放基准从**真立绘的像素高度**算(`gf_sprite_zoom = 屏高 / 立绘图高`),换出图尺寸自动跟上。
3. **演出字色调色板 + 描边**(见 `src/service/text-color.ts`)。描边是彩色字的**安全网**:
   官方文档写明 outlines 只对**整个** Text displayable 生效、对 text tag 无效,所以描边只能整行统一
   —— 于是"彩色字 vs 描边色 ≥ 4.5:1"这条 WCAG 闸门与背景无关,可以机械判。

**入口**:`galfree_stage`(agent)/ 面板「整备舞台」/ `POST /stage/sync`,**一个写批 = 一条快照**;
已经是最新的**什么都不写**(不产生空快照)。`generateScene` / `editScene` 把它并进**同一个写批**
(否则 git 历史里"生成这一场"会变成两条看不出关系的提交,而中间那一刻项目是坏的)。

**派生**:`progress.stage`(`outOfSync` / `report.unplaced` / `report.overlaps` / `report.crowded`)
与 `nextActions` 的 `stage-needs-sync` / `sprite-overlap` —— 板子说得出来,人不必猜。

**边界**:只有 `game/scenes/**`(生成目录)会被重排站位;`script.rpy` 是人的文件,生成器不越界
(与「搬家」同一条线)。但**报告看全项目** —— 手写文件里的重叠也照说。

