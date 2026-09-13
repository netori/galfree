# IndexTTS 2.5:音色一致性调研(2026-09-13)

## 1. 结论(三句以内,能落地)

1. **能**:IndexTTS 2.5 的音色**只由参考音频决定** —— 把「一个角色一份参考音频」固定成
   `voices/<角色id>.wav` 并每次都传同一个 `audio`,音色就是同一个(同路径 ⇒ 同 speaker
   embedding ⇒ 进程内缓存命中)。
2. **`speaker` 不是音色**:它只选 LoRA 适配器(`runs/exp1_<name>/`),本机 `runs/` 是**空的**,
   所以现在多角色**只能靠多份参考音频**,不能靠 `speaker` 区分。
3. **逐句波形不可复现**(采样参数无 seed),但**音色不漂**;"用文字描述一个不存在的音色"这件事
   本地**做不到**,只能先弄到一段参考音频(自己录 / 别家 voice design 造 / 已有素材剪)。

## 2. 本机那份服务的事实(路径 + 参数表 + 出处)

### 2.1 整合包位置

| 事实 | 出处 |
|---|---|
| 整合包根目录 = `F:\creative_app\yzy-index-tts-2.5-260824\` | 进程实证:`F:\creative_app\yzy-index-tts-2.5-260824\.venv\Scripts\python.exe -u webui.py --host 127.0.0.1 --port 9000`(PID 24212,`Get-CimInstance Win32_Process`) |
| API 服务文件 = `F:\creative_app\yzy-index-tts-2.5-260824\app_api.py`(636 行) | 该文件本体 |
| 它是**上游 git clone + 本地新增**:remote = `https://github.com/index-tts/index-tts.git`(commit `ee40fa7`);`git status` 里 `?? app_api.py`、`?? local_tts_splitter/`、`?? train_lora.py` **全是未跟踪** | `git remote -v` / `git ls-files --error-unmatch app_api.py`(报 `did not match`) |
| **服务现在没在跑**:探测 `127.0.0.1:9005` 连接被拒;**9000 上跑的是 `webui.py`** | `Invoke-WebRequest` 实测 |
| 监听默认 `0.0.0.0:9005` | `app_api.py:96-97`(`--host` default `0.0.0.0`,`--port` default `9005`);另见文件头 docstring `app_api.py:6`、`:11` |

> ⚠️ 下面参数表全部是**读源码**得到的;因为 9005 没在跑,没有打接口验证过。

### 2.2 `TTSRequest` 全部字段(`app_api.py:464-493`)

| 字段 | 类型 | 默认值 | 语义 | 行号 |
|---|---|---|---|---|
| `speaker` | `str` | **必传** | **LoRA 适配器名**,不是音色。`default`=底模;其它名 ⇒ `runs/exp1_<speaker>/` | 466 |
| `audio` | `str` | **必传** | **参考音频文件名**(音色的真正来源),在 `voices/` 里按名解析 | 467 |
| `text` | `str` | **必传** | 待转换文本(台词原文) | 468 |
| `lang` | `str` | `"ZH"` | 语言,强制 `.upper()` | 470 / 355 |
| `fp16` | `bool` | `True` | 半精度(实际走 bf16,`build_tts` 里判 BF16 支持) | 471 / 210-221 |
| `duration_factor` | `float` | `1.0` | 语速/时长:>1 变慢,<1 变快(官方域 0.5–2.0) | 472 / 357 |
| `diffusion_steps` | `int` | `25` | 扩散步数 | 473 / 358 |
| `segment_pause_ms` | `int` | `300` | 分段之间插的静音 | 474 / 122 |
| `fade_out_ms` | `int` | `30` | 每段末尾淡出(消咔哒声) | 475 / 123 |
| `max_text_tokens_per_segment` | `int` | `min(160, cfg.max_text_tokens)` | 单段文本 token 上限 | 476 / 158 |
| `emo_control_method` | `int` | `0` | **0=情绪跟着音色参考音频走;1=独立情感参考音频;2=情感向量;3=情感描述文本** | 478 / 388-399 |
| `emo_ref_audio` | `Optional[str]` | `None` | 情感参考音频(**也在 `voices/` 里解析**) | 479 / 389 |
| `emo_weight` | `float` | `0.65` | 情感强度 —— **就是官方的 `emo_alpha`**(调用时传成 `emo_alpha=emo_weight`) | 480 / 417 |
| `emo_text` | `Optional[str]` | `None` | 情感描述文本(仅 method=3 用) | 481 / 418 |
| `emo_vector` | `Optional[List[float]]` | `None` | 8 维:`[喜,怒,哀,惧,厌恶,低落,惊喜,平静]`,必须恰好 8 个 | 482 / 393-396 |
| `do_sample` | `bool` | `True` | GPT2 采样开关 | 484 / 371 |
| `top_p` | `float` | `0.8` | 采样 | 485 / 372 |
| `top_k` | `int` | `30` | 采样(≤0 则传 None) | 486 / 373 |
| `temperature` | `float` | `0.4` | 采样 | 487 / 374 |
| `length_penalty` | `float` | `0.0` | 采样 | 488 / 375 |
| `num_beams` | `int` | `3` | 采样 | 489 / 376 |
| `repetition_penalty` | `float` | `8.0` | 采样 | 490 / 377 |
| `max_mel_tokens` | `int` | `min(1500, cfg.max_mel_tokens)` | 输出长度上限 | 491 / 157 |
| `return_type` | `str` | `"file"` | `file`=回 wav 字节;`json`=回 `{ok,sampling_rate,segments,path,filename}` | 493 / 504-511 |

**名字对照(容易踩的)**:

- **没有** `prompt_audio` —— 上游 Python API 叫 `spk_audio_prompt`,**HTTP 层叫 `audio`**(`app_api.py:415`)。
- **没有** `emo_alpha` —— HTTP 层叫 **`emo_weight`**(`app_api.py:480`,只在调 infer 时映射成 `emo_alpha`)。
  ⚠️ 默认值两边**不一致**:本机 `0.65`(`app_api.py:480`)vs 官方 README `emo_alpha` 默认 `1.0`。
- **没有** `use_emo_text` 这个入参 —— 它由 `emo_control_method == 3` **派生**(`app_api.py:418`)。⚠️
- **没有** `voice` —— 参考音频的键就叫 `audio`。
- **没有任何 `seed` / 随机种子字段**(全表 24 个字段里没有)。
- `use_random` **硬编码 `False`**(`app_api.py:418`)⇒ 情感向量那条路走
  `find_most_similar_cosine`(确定性),不走 `random.randint`(`indextts/infer_v2_5.py:784-787`)。

### 2.3 `speaker` / `audio` 各自怎么落到磁盘(这是"一致性"的机制核心)

- **`speaker` → LoRA 目录**:`speaker_lora_dir()`:`default`/空 ⇒ `None`(底模);否则
  `runs/exp1_<speaker>`(`app_api.py:168-172`)。`list_speakers()` 永远返回 `["default"]` +
  `runs/` 下所有含 `adapter_config.json` 的 `exp1_*` 目录(`app_api.py:175-183`)。
  不在列表里 ⇒ **400**(`app_api.py:343-344`)。→ **本机 `runs/` 当前为空,所以只有 `default`。**
- **`audio` → 音频库文件名**:`resolve_voice()` 在 `VOICE_LIB_DIR = "voices"` 里找
  (`app_api.py:115`),支持带/不带扩展名,扩展名白名单
  `.wav/.mp3/.flac/.m4a/.ogg`(`app_api.py:119`);**只 `os.listdir` 一层,不进子目录**
  (`app_api.py:186-189`)。找不到 ⇒ **400** 并把可用清单回给你(`app_api.py:347-350`)。
  → **本机 `voices/` 当前只有一个文件:`测试参考音频.mp3`。**
- 输出落在 `outputs/api_{speaker}_{int(time.time())}.wav`(`app_api.py:442`)——
  **时间戳只到秒**,同 speaker 同一秒内两条请求会撞名。

### 2.4 三个辅助读法

| 端点 | 返回 | 行号 |
|---|---|---|
| `GET /health` | `{status, model_loaded, speaker, qwen_emo}`(**不加载模型**,立即返回) | `app_api.py:538-541` |
| `GET /speakers` | `{speakers: [...]}`,即 LoRA 名清单(恒含 `default`) | `app_api.py:544-546` |
| `GET /voices` | `{voices: [...文件名], dir: <voices/ 的绝对路径>}` | `app_api.py:549-551` |

`qwen_emo=false` 时 `emo_control_method=3` 会被 **400** 拒(`app_api.py:397-399`)。

### 2.5 分句合成:对"音色漂移"的答案

`POST /tts` **不是一次推理**:先把文本切段,逐段 `infer`,再合并
(`app_api.py:425-445`,切分走 `local_tts_splitter`,`app_api.py:283-287`)。

- 切分档位(中文按**字**数):`min 25 / target 50 / soft_max 65 / hard_max 85`
  (`local_tts_splitter/config.py`,`SplitConfig`)。
- **段与段之间不会重新克隆音色**:speaker 条件是**按参考音频路径缓存**的
  (`indextts/infer_v2_5.py:344-350` 四个 `cache_*`;`:725`、`:774` 比对路径;命中就复用
  `:777-780`)。同一路径 ⇒ 整条文本用同一份 speaker 条件 ⇒ **分句不引入音色漂移**。
- **参考音频只取前 15 秒**:`self._load_and_cut_audio(spk_audio_prompt, 15, verbose)`
  (`indextts/infer_v2_5.py:740`)—— 超长参考音频的尾部**被丢掉**。
- 情感参考音频缺省 = 音色参考音频:`emo_audio_prompt = spk_audio_prompt`
  (`indextts/infer_v2_5.py:720`)⇒ **method=0 时参考音频的情绪会渗进每一句**。

## 3. 官方能力边界(带链接)

来源:[官方 README](https://github.com/index-tts/index-tts)、
[技术报告 arXiv:2601.03888v3](https://arxiv.org/html/2601.03888v3)、
[Demo 页](https://index-tts.github.io/index-tts2-5.github.io/);
本机副本 `F:\creative_app\yzy-index-tts-2.5-260824\README.md` 与 `docs\README2.5_ZH.md`。

**它能控制的"声音输入"**(官方 README §1–§7):参考音频克隆(`spk_audio_prompt`)、
**独立情感参考音频**(`emo_audio_prompt`)、情感强度 `emo_alpha`(0.0–1.0,默认 1.0)、
情感向量 `emo_vector` 8 维 `[happy, angry, sad, afraid, disgusted, melancholic, surprised, calm]`
+ `use_random`(默认 `False`)、文本自推情感 `use_emo_text`(2.5 需 `use_qwen_emo=True`,否则
`RuntimeError`)、显式情感描述 `emo_text`、语速 `duration_factor`(0.5–2.0,默认 1.0)、
以及拼音/CMU/假名发音控制。

**没有的能力**:

- **没有 voice design / 用文字描述音色** —— README 的 seven 个用法、技术报告的"四项关键改进"、
  Demo 页的六个章节里都**没有**这一类;能给的只有音频(参考音频 / 情感音频)。
- **没有上游预置音色库** —— 上游只带 `examples/voice_01..12.wav` 示例提示音;
  本机 `examples/` 里就是这些 + `emo_sad.wav` / `emo_hate.wav`。
- **没有 seed 参数** —— 本机 `indextts/infer_v2_5.py:611-614` 的 `infer()` 签名里没有,
  `app_api.py` 也没有。

**音色一致性的官方说法**:

- **音色与情感是解耦的**:「The timbre prompt determines the speaker's voice characteristics,
  while the emotion prompt controls the emotional style… The two prompts can come from
  different speakers or even different languages.」(README §"Speaker and Emotion Disentangle")
  ⇒ **音色只看 timbre prompt,即我们的 `audio`。**
- **别开随机**:「Use `use_random` to introduce stochasticity during inference (default: False).
  **Note:** Enabling random sampling **reduces the voice cloning fidelity**.」(README §4)
- **定量指标只有 ref↔生成 的 SS**(技术报告 Table 2):IndexTTS 2.5 说话人相似度
  test-zh **0.848** / test-en **0.855** / test-ja **0.833** / test-es **0.808**
  (Ground Truth 对照:0.776 / 0.820 / 0.611 / 0.627)。
- **长句有风险**(技术报告 §3.1.1):「due to the hallucination tendency inherent in
  autoregressive generation, its control over pronunciation degrades on longer utterances,
  occasionally leading to mispronunciations.」——本机用 50 字切段正是规避这个。
- **训练数据是 ≤25 秒单说话人段**(技术报告 §2 Segment Merging:short ASR segments merged
  "based on speaker consistency, textual coherence, and inter-segment silence",max 25 s)。

## 4. "同一角色一致"怎么做(具体步骤)

机制一句话:**音色 = 参考音频文件的字节内容;同路径 ⇒ 进程内 speaker 条件缓存命中 ⇒ 同一把嗓子。**

1. **给每个角色定一段 5–15 秒的参考音频**:单人、无背景音乐、无混响、情绪中性偏平。
   **别超过 15 秒**——超出部分会被截掉(`indextts/infer_v2_5.py:740`)。
2. **丢进 `F:\creative_app\yzy-index-tts-2.5-260824\voices\`**,文件名用角色 id,例如
   `xiao_tang.wav`。**不用重启服务**:`list_ref_voices()` 每次请求都现 `os.listdir`
   (`app_api.py:186-189`),`GET /voices` 立刻能看到。
3. **每次合成固定三件套**:`speaker="default"` + `audio="xiao_tang.wav"` + `lang="ZH"`。
   跨场、跨批次都传**同一个字符串**——这就是"同一把嗓子"的全部。
4. **要换情绪,换情感输入,不换 `audio`**:
   - `emo_control_method=1` + `emo_ref_audio="xiao_tang_angry.wav"`(情绪参考**也在 `voices/`**
     ——`app_api.py:389`);`emo_weight` 调强度(缺省 0.65)。
   - 或 `emo_control_method=2` + `emo_vector=[0,0,0,0,0,0,0,1]`(平静)。
   - **别用 method=0 又指望音色中性** —— 那时情绪参考就是音色参考(`infer_v2_5.py:720`)。
5. **要更硬的锁(可选,重量级)**:LoRA 微调一份说话人 —— 流程是
   `slice_audio.py`(长录音切 3–10 s 短句)→ `build_lst.py` → `extract_features.py`
   → `train_lora.py --out runs/exp1_<角色>`(用法见 `train_lora.py` 文件头),
   之后 `speaker="<角色>"` 会在 `build_tts` 里带上 `lora_dir`(`app_api.py:222`)。
   ⚠️ **`audio` 仍然必传**(`app_api.py:345-350`)——LoRA 不替代参考音频。
   ⚠️ 这条路**没实测过**:本机 `runs/` 与 `finetune_data/` 都是空的。

## 5. 做不到的情况与替代方案

| 做不到 | 出处 | 替代方案 |
|---|---|---|
| **"用文字描述一个不存在的音色"** | 官方 README / 报告 / Demo 页均无此能力(§3) | 先弄到一段**音频**再克隆:①自己录 ②用别家的 voice design(ElevenLabs 那一派)造一段参考音频,丢进 `voices/` ③从已有素材剪一段(注意 `DISCLAIMER` / 许可) |
| **靠 `speaker` 区分多个角色** | `speaker` 只指 LoRA,且本机 `runs/` 空 ⇒ `/speakers` 只有 `default`(`app_api.py:175-183`) | **每个角色一份参考音频**(同一 `speaker="default"`),或为每个角色训一份 LoRA |
| **预置音色库** | 上游只有 `examples/voice_0*.wav`;本机 `voices/` 只有 `测试参考音频.mp3` | 自建:`voices/` 就是你的音色库,靠命名约定管理 |
| **逐句波形完全可复现** | `app_api.py:484-490` 开着采样且**无 seed**(§2.2) | 接受"音色稳定、韵律微变";要严格复现只能改服务代码加 seed(本次不做) |
| **换参考音频但想保持同一音色** | 音色身份 = 那个文件的路径/内容(`app_api.py:192-205` + `infer_v2_5.py:774`) | 不改名、不重录、不换格式;改名 = 换音色 |
| **跨机部署** | 整合包服务与插件必须同机(适配器读服务端绝对路径,`audio-adapter-indextts.ts:118-121`) | 走"本地批量清单"那条路(T29) |
| **`emo_control_method=3`(情感描述文本)** | `qwen_emo=false` 时直接 400(`app_api.py:397-399`) | 启动加 `--qwen_emo`,或改用 method 1/2 |

## 6. 对工作台的三条建议(接线口径 / 目录约定 / 面板要显示什么)

### 6.1 接线口径:`speaker` 与 `audio` 是两个正交概念,别互串

- **事实**:`audio`(参考音频)**才是音色**;`speaker` 只是 LoRA 名。当前适配器
  `src/service/audio-adapter-indextts.ts:71` 把 `task.voiceId` 当 `speaker` 发出去
  ——**语义错位**(`voiceId` 是"哪把嗓子",服务端的 `speaker` 是"哪份 LoRA")。
  本机 `runs/` 为空 ⇒ 任何非 `default` 的 `voiceId` 都会吃到 **400**(`app_api.py:343-344`)。
- **更要紧的坑**:`audio-adapter-indextts.ts:74` 的
  `options.audio ?? input.task.referenceAudio[0]?.path` 会把**项目内相对路径**
  (`game/voice/...`)当"音频库文件名"发出去 —— 而服务端只在 `voices/` 里按名找
  (`app_api.py:192-205`),**一定被拒**。要么在模型目录 `note` 里写音频库文件名,要么把参考音频
  同步进 `voices/` 再用文件名引用。
- **请求体只发了 5 个字段**(`speaker/audio/text/lang/return_type`,
  `audio-adapter-indextts.ts:92-100`),**情感与采样全用服务端默认** ⇒ 落到
  `emo_control_method=0` ⇒ **情绪被参考音频绑死**。要"同一个人"就得把
  `emo_control_method`(至少 0/1/2)显式化,否则面板上"调情绪"是假的。

### 6.2 目录约定:参考音频是"音色档案",一次录定、永不改名

- 名字锚建议 `voices/<角色id>.<ext>`(服务端只认 `voices/` 下**一层**文件名,
  无子目录:`app_api.py:186-189`)。
- **改名 = 换音色**,所以名字一旦被任务引用就锁死;要换音色必须显式改登记簿条目。
- 参考音频 ≤15 秒、单人、干净(`infer_v2_5.py:740`)。
- 这是**另一条锚**,与 `game/voice/<对话 id>.ogg`(ADR-0013)分工不同:
  前者锚"谁的嗓子",后者锚"哪句话";两者不要混在一个命名空间里。

### 6.3 面板要显示什么

- **`GET /voices` 的真实列表 + `dir`**(`app_api.py:549-551` 会回绝对路径)——
  让"这个角色用的参考音频在不在库里"当场可见,而不是等一次 400。
- **`GET /speakers` 要如实说"只有 `default`,没有训练过的说话人"**(`runs/` 为空,
  `app_api.py:175-183`),别把 `default` 渲染成一个可选音色。
- **`GET /health` 的 `model_loaded` / `qwen_emo`**(`app_api.py:538-541`):
  `qwen_emo=false` 时把"情感描述文本"那一项**提前禁掉**,别等人点了才吃 400
  (`app_api.py:397-399`)。
- 显示"**这个角色用的是哪段参考音频**"—— 这正是"同一把嗓子"唯一可核对的那一栏。

## 7. 没查到 / 不确定的(如实列)

1. **没打接口验证**:9005 当前没在跑(探测连接被拒,9000 上跑的是 `webui.py`)。§2 的参数表是
   **读源码**得到的,不是实测的;也没跑过一次真合成(要占显存)。
2. **没查到官方对"同一参考音频反复合成的音色漂移/一致性"的定量说法**。技术报告只给
   ref↔生成 的 SS(0.808–0.855,Table 2),**没有 run-to-run 方差**。所以 §4 里
   "分句不漂"是**机制推导**(同路径 ⇒ 同缓存条件),不是实测。
3. **官方没有 seed 参数**(`indextts/infer_v2_5.py:611-614` 签名里没有),API 也没有
   ⇒ "完全可复现"**没有出处**,所以不进结论。
4. **没有上传接口** —— `voices/` **只能丢文件**(`os.listdir`,`app_api.py:186-189`),
   没查到任何 HTTP 上传/注册端点。
5. **LoRA 那条路没实测**:`train_lora.py` / `slice_audio.py` / `extract_features.py` 只读了文件头,
   本机 `runs/` 与 `finetune_data/` **都是空的**,`/speakers` 从未有过 `default` 以外的值。
6. **本机 API 是第三方 fork 的产物**:`app_api.py` / `local_tts_splitter/` / `train_lora.py`
   都**不在上游**(`git status` 显示 untracked)。所以**上游参数名与本机 API 参数名不一致**
   (`emo_alpha`→`emo_weight`、`use_emo_text`→`emo_control_method==3`);我按**本机源码**写。
   **没查到** yzy 为什么把 `emo_weight` 默认定成 `0.65`(官方默认 1.0)。
7. **`outputs/` 里有 2 个文件**,但没去比对它们的波形/音色 —— 不构成任何一致性证据。
8. **多语言清单口径有小冲突**:官方 README 说 ZH/EN/JA/**ES/AR** 五种,而技术报告摘要只列
   ZH/EN/JA/ES 四种(Table 1 里确有 Arabic 列)。本机 `app_api.py` 不过问语言合法性,
   `lang` 只是原样 `.upper()` 传下去(`app_api.py:355`),**没查到非法 lang 会被谁拦**。
