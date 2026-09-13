# 0013 — 语音接线用**对话 id + `config.auto_voice`**,剧本里不留 voice 语句

- **状态**: **Draft(2026-09-12,等发起人点头;未点头前不实现)**

## Context

ADR-0012 要把 TTS 生成加进来。但"生成出语音文件"只是一半 —— 另一半是**引擎怎么知道
哪一句该放哪个文件**。这一半 v1 从来没定过(v1 不生成音频,所以不需要定)。

候选三条:

1. 每句对白前写 `voice "file.ogg"`(Ren'Py 的常规做法);
2. 每句用 `play voice "file.ogg"`(本子集**已有**的语法);
3. 什么都不写,靠 `config.auto_voice` 按**对话标识符**自动找文件。

### 从钉版 SDK 源码读出来的事实(不是猜的)

| 事实 | 出处(钉版 SDK,行号已核) |
|---|---|
| `voice` 语句 / `play voice` 的语音在**下一次交互开始时自动停止**(要用 `voice sustain` 才延续) | `renpy/common/00voice.rpy` + [官方文档 Voice 节](https://www.renpy.org/doc/html/voice.html) |
| `config.auto_voice` 支持 `"voice/{id}.ogg"` 这种带 `{id}` 的字符串,也支持**可调用对象** | `00voice.rpy:364-367` |
| 找文件走 `renpy.loadable(fn, directory="audio")` —— 即**默认 searchpath(`game/`)**;所以 `"voice/x.ogg"` 就是 `game/voice/x.ogg` | `00voice.rpy:372` |
| `{id}` 取的是对话标识符(`translate_identifier` / alternate / deferred 三选一) | `00voice.rpy:348-357` |
| **没有显式 id 时,标识符是内容哈希**:`md5(say 的代码)[:8]`,`label` 前缀拼上 | `renpy/translation/__init__.py:337-357`(`create_translate` 的 `digest`)、`unique_identifier:317` |
| **有显式 `id <name>` 子句时,它就是这个标识符本身** | 同上 `create_translate` 的 `id_identifier` 分支(`__init__.py:362-372`);语法 `finish_say`:`parser.py:1491` `elif l.keyword("id"): identifier = l.require(l.name)` |

**推论(这条决定了整个设计)**:靠内容哈希做文件名 = 改一个字,那一句的语音文件就找不到;
上游 Ren'Py 自己也承认这些 id 不稳定([renpy#5373](https://github.com/renpy/renpy/issues/5373),
2024 年报告、至今是现状)。而本产品**逐场重生成**是常规动作 —— 哈希方案在这里必然烂掉。

**显式 `id` 子句把文件名钉死**:与内容无关,只与我给的 id 有关。

### 实测(2026-09-12,在钉版 SDK 8.5.3 上真跑过;不是只读源码)

`renpy.exe <项目> dialogue None`(**launcher 那个 "Extract Dialogue" 的命令行形态**,
不需要显示)会把全部对白导出成 `dialogue.tab`,第一列就是标识符。一个探针项目跑两遍
(第二遍把台词**整句改写**):

```
第一遍                                      第二遍(同一项目,改掉措辞)
start_e49b1e45  Hello with an explicit…     start_e49b1e45  Hello with an explicit…      ← 没动的行,id 不变
start_90791f80  This line has no id…        start_32447802  This line COMPLETELY…        ← **改一个词,哈希 id 就换了**
pinned_line_001 Different wording…          pinned_line_001 Different wording…          ← 显式 id,**守住了**
```

两条附带事实:① `voice "x.ogg"` 语句**不进**哈希(带它的那句改词后 id 没变);② 子集外
(`if` 块里)的对白**也**出现在导出里 —— 所以"导出清单"这件事不依赖方言子集。

**还没做的那一条**(归 T26,别在这里补):`renpy.loadable()` 在**运行时**对
`config.auto_voice` 那个文件到底认不认(源码路径 `00voice.rpy:372` 读到的是"认")。
这条要一条**真引擎**的守卫(起项目 → 断言那一句的语音文件被采用),不是靠推论 ——
T26 的验收标准里已经写了它。

## Decision

- 语音接线一律走 **`config.auto_voice`**,剧本里**不写 `voice` / 不写 `play voice`**:

  ```python
  # 随项目生成(经写网关 → 进快照)
  config.auto_voice = "voice/{id}.ogg"
  ```

- **对话 id 由我们显式钉**:生成/重生成一场戏时,给每条对白加 `id <稳定id>` 子句
  (id 里只放 `[A-Za-z0-9_]`,见 `parser.py` 的 `l.name`)。id 一旦定下**跨重生成不变**
  (它就是语音文件名的锚,与素材槽的槽名同一种东西)。
- 产物路径 = `game/voice/<id>.ogg`(或本渠道给的格式),**经写网关落盘** → 音频池照旧
  **派生**出它(T17 的池口径不变,池不认识"生成"这回事)。
- 音色 = 登记簿里的**音色档案**(音色 id + 参考样本),跨场同角色同一把嗓子;
  换音色是**设定改动**(ADR-0012)。
- **`voice` 语句不进方言子集** —— 既然 auto_voice 够用,就不为它扩语法。
  将来真要写 `voice "x"`(比如做双语配音),按方言子集契约走独立一票。

## Consequences

- **要改子集的只有一处**:对白行支持尾部 `id <name>` 子句(契约 + 解析器 + 模板 + 慢带)。
  它**仍是子集内**(写进去的是引擎认的语法,只是我们现在不解析)——与"扩语法"是两回事,
  但同样要过真 SDK lint。
- **场景指纹的口径要重新想一遍**:id 子句是**制作信息,不是叙述内容**(ADR-0003/0009 铁律)。
  现在场景指纹是"原始文本哈希",加了 id 会让**每一次生成语音都令审读戳失效** ——
  那是不可接受的(人得重盖一遍)。所以指纹要**剔除 id 子句**再算,这一条必须有守卫。
- 音频池的 `unused` 徽标会变得很有用:生成了一批语音但没接上 id 的,会在那里显形。
- 语音文件与对白的对应关系**不是账本里的真相源**:真相是 `.rpy` 里的 id + `game/voice/` 下
  的文件;`.studio/` 只记"这句是用哪个音色、哪次任务的产物"(制作信息)。
