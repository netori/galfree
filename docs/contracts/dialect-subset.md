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
| `scene <名…>` / `show <tag> [属性…] [at …] [with …]` / `hide <tag>` | image 引用(**素材槽派生输入**) |
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
