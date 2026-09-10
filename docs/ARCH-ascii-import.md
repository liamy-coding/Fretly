# ARCH · 任务甲：增强 ASCII 六线谱导入器

| 项目 | 内容 |
| --- | --- |
| 上游 PRD | `docs/PRD-ascii-import.md`（v1.0 · 任务甲） |
| 现状代码 | `src/io/importers.ts:69-257`、`src/io/exporters.ts:22-48` |
| 范围 | **纯解析层增量改造**。零新增运行时依赖、零 UI 视觉改动、零 `tabToAscii` 格式改动 |
| 交付对象 | 工程师（照本实现）、QA（照 §7 写测试） |

---

## 0. 前置事实核对（我实测确认，非推测）

在动手前我用 node 复算了 PRD 样例的关键数值，发现 **PRD 样例 A / 样例 F 的期望值与其自己声明的算法互相矛盾**。这是本设计必须裁决的第一件事，因为它直接决定 6 行弦行的**列对齐基准**。

| 核对项 | 结论 |
| --- | --- |
| 样例 A 文本 `e\|--0---0-\|--2---2-\|`，按 PRD R1「`startTick` = 列偏移 × 120，相对小节起点」 | 尾 `\|` 是**收口**记号、不占小节内容列时，第 0 小节段 = `--0---0-`，`0` 在段内 index 2 / 6 → `startTick = **240 / 720**`。PRD 声称 `{240, 1200}` → **720 ≠ 1200，PRD 自相矛盾** |
| 同上，若剥掉行首 `\|` 再切段 | 段 = `-0---0-`，`0` 在 index 1 / 5 → `startTick = **120 / 600**`，与 240/1200 相差更远 |
| 样例 A 第 1 小节声称 `{0, 960}`（列 0 / 8） | 只有「`\|` 占 1 列且小节内容起点 = `\|` 后一列」时，`--2---2-` 的 `2` 才落在小节内 index 2 / 6 = 240 / 720 ticks，**仍然不是 `{0,960}`** |
| 能否让某一行**同时**满足 `{240,1200}` 与 `{0,960}` | **不能**。两小节的步长要求分别是 960 与 960，但第一小节两个音符间距实际 480。除非把 `\|` 计为 2 列宽。这是 PRD 在这一行手算的**算错**，不是设计分歧 |
| 样例 F（单小节 6 行 × 8 列） | 第 0 小节 = `--s-----`，右边界 = 8。闷音 `col=2` → 剩余 6 列 = 720 ticks。PRD 只要求「`durationTick < 行宽对应 tick`」，**但行宽就是 8 列 = 960**，所以该约束在同小节场景下恒真、无区分度。真正要断言的必须跨小节（详见 §7.3） |

**本设计的处理**：**以 PRD 声明的算法为准，修正其手算数值**（PRD §6 规则 7 已授权：「若某新规则与既有断言冲突，以既有断言为准并回报团队」——此处是 PRD 内部冲突，按声明算法执行）。样例 A 的正确期望值见 §7.2。**我已把此矛盾回报 team-lead**。

> 之所以坚持「首 `|` 剥离、尾 `|` 收口、`|` 之间即小节」这条语义，是因为它有**唯一一个能被既有断言强制的判据**：`io.test.ts:107-113` 要求 `1|---0--` 这种**行首即 `\|`** 的块解析为 **1 个小节**。若首 `|` 产生一个空小节，这条断言会得到 2 个小节 → 红。首 `|` 剥离不是我的偏好，是既有测试逼出来的唯一解。

---

## 1. 现状剖析：9 个缺陷的**根因**（哪个设计选择导致它）

不复述现象，只指出设计层面的病根。前 5 条由 team-lead 实测确认，后 4 条为 Explore 发现 + team-lead 复现。

| # | 缺陷 | **根因（设计选择）** |
| --- | --- | --- |
| 1 | `\|` 被丢弃 | **把「文本」降维成「一维列网格」**。`importers.ts:90` 的 `content: m[3].replace(/[|\s]/g, '')` 在**入口就把结构信息扔掉**，等价于声明「ASCII 只是列坐标的载体，小节结构由列数推导」。于是唯一的结构来源变成了 `asciiColsPerMeasure(ts)` —— 一个**我们的内部约定**。文本里明明存在作者写下的真值，却被主动删除。后续 `:112` 的 `measureCount = ceil(width / colsPerMeasure)` 是这个选择的必然结果，不是独立 bug。 |
| 2 | 标题被元数据污染 | **`parseAscii` 把「取第一段非弦行」当作标题策略**（`:74-79`），语义是「第一段文字就是标题」。它假设输入是**裸谱面**，而真实输入是**带头部的文档**。设计上缺少「头部区 / 谱面区」的相位划分，所以 `Title: X` 被当成一个普通句子。 |
| 3 | 5 行谱零导入 | **`for (let i = 0; i + 6 <= lines.length;)` + `if (label !== (j + 1) as StringNumber) break;`（`:82,:88`）把「6 行」和「弦号必须是 1..6 顺序且齐全」编码成了**块存在的必要条件**。这是「六线谱=恰好 6 行」的领域假设直接写成循环条件。块识别与块内容校验**耦合在同一个循环里**，导致「不完整」无法表达为「部分成功」，只能表达为「不存在」。 |
| 4 | 末音符时值膨胀 | **时值计算与空间容器解耦**。`:175` 的 `nextCol = i + 1 < list.length ? list[i + 1].col : width` 里，`width` 是**块内最大行宽**，不是小节右边界。设计上「同弦下一个音符」是唯一约束源，**跨弦事件**和**小节边界**根本没进入计算。根因是时值在 `for (const list of byString.values())` 这个**按弦分组的循环里**计算，而小节边界信息在该作用域内不存在。 |
| 5 | `sectionLabel` 恒空 | **`Measure.sectionLabel` 只被当作渲染字段，没被当作解析输出**。解析器 `:210` 直接字面量 `sectionLabel: ''`。设计缺一层「行级上下文 → 小节属性」的传播通道：段落标记是**行间事件**，而流水线只处理「行 → 音符」，没有任何承接行间事件的中间态。 |
| 6 | **3/4 拍往返不一致（P0）** | **`asciiToTab` 丢掉了拍号这个必需参数**。`importers.ts:224` 调 `parseAscii(text)` 不传 `ts`，默认 `[4,4]`；而 `tabToAscii` 用 `tab.timeSignature` 定列宽（3/4 → 12 列）。**导出与导入对「一小节几列」的约定不一致**，往返必然错位。更深一层：拍号**已经写在表头第 2 行**（`exporters.ts:26` 的 `${ts[0]}/${ts[1]}`），但解析端**没有读取通道**——信息的单向丢失，而非信息不存在。 |
| 7 | `'v'` 越界 | **`as` 强转绕过了联合类型的唯一防线**。`importers.ts:43` 的 `TECHNIQUE_CHARS` 是独立维护的字符白名单，与 `types/tab.ts:52` 的 `Technique` 联合类型**没有任何编译期绑定**；`:152` 的 `c as Technique` 主动放弃检查。根因是**「字符集」与「类型」存在两处真值源**，且用 `as` 缝合。下游 `ui/tab/tabRender.ts:309-313` 取 `techniques[0]` 直接 `fillText`，`'v'` 会被渲染成字面 `v`。 |
| 8 | 不走 `validateTab` | **ASCII 路径被当成「可信输入」**。`jsonImporter` 走 `validateTab`（`:274`），因为 JSON 是外部文件；ASCII 被认为「由我们自己解析出来的，必然合法」。这是「解析器输出天然正确」的错误不变量假设。实际上 `'v'` 越界（缺陷 7）就是这条假设已经被打破的**实证**。 |
| 9 | ASCII 无体积守卫 | **守卫建在「文件」这一维度上**。`isFileTooLarge(kind, sizeBytes)`（`importHelpers.ts:37`）只处理 `File`；ASCII 走 `textarea`（`isTextInput('ascii') === true`），**没有 `File` 对象，守卫天然失效**。而 `maxImportMb()`（`:28-30`）对 ASCII 也返回 XML 的 8MB —— 一个**用错语义的兜底**。根因是 `ImportKind` 只有文件视角的安全模型，粘贴文本是另一个输入面（text-input surface），未被建模。 |

### 1.1 缺陷 6 为什么最严重

它不是「某一类输入解析错了」，而是**「本产品自己产出的文件自己读不回」**——往返一致性是本项目 `io.test.ts:70` 明确守着的核心契约，3/4 拍整条路径**无人守**（只有 4/4 拍的 SONG_MORNING 在测）。同类风险还潜伏在 Tuning/BPM 上：表头里写了，但没人读。

---

## 2. 改造后的解析流水线

### 2.1 阶段划分（6 阶段，每阶段纯函数、无 DOM）

原则：**先把「行」分类，再把「块」组装，最后把「块」投影为小节**。每一阶段的输出都是下一阶段唯一的输入，阶段之间不共享可变状态。

```
输入 text: string
      │
      ▼
┌─────────────────────────────────────────────────────────────┐
│ S1  normalizeLines                                          │
│     入：text                                                 │
│     出：RawLine[] { raw, trimmed, kind, ... }                │
│     职责：\\r\\n 归一、逐行去尾空白、给每行打**单一**标签：    │
│           'kv' | 'section' | 'string' | 'blank' | 'other'    │
│     要点：行分类是**互斥**的，且 string 行的判定包含          │
│           RISK-1 边界（弦号 + 终止符 + 至少一个音符字符）      │
└─────────────────────────────────────────────────────────────┘
      │
      ▼
┌─────────────────────────────────────────────────────────────┐
│ S2  extractHeader                                           │
│     入：RawLine[]                                            │
│     出：{ title, artist, tuning, bpm, tsFromHeader, warnings }│
│     职责：只扫**第一个 string 行之前**的前导区，收白名单 KV；  │
│           执行标题回退链；从表头第 2 行提取拍号（缺陷 6 关键） │
└─────────────────────────────────────────────────────────────┘
      │
      ▼
┌─────────────────────────────────────────────────────────────┐
│ S3  groupBlocks                                             │
│     入：RawLine[] + 段落标记流                                │
│     出：RawBlock[] { lines: {label, content}[], sectionLabel }│
│     职责：把**连续的** string 行聚成块；1~6 行都合法；         │
│           空行 / 非 string 行强制断块（防止两块被合并）；      │
│           把「上一个出现的段落标记」烧进块的 sectionLabel      │
│     要点：块内弦号互异，但**允许跳号**（缺陷 3 修复点）        │
└─────────────────────────────────────────────────────────────┘
      │
      ▼
┌─────────────────────────────────────────────────────────────┐
│ S4  splitMeasures（★核心算法）                               │
│     入：RawBlock                                               │
│     出：MeasureSegment[] { startCol, endCol, measureIndex }   │
│           —— 全局统一的「列 → 小节」映射表                    │
│     决策：块内有任一 `|` → 小节线模式；否则列数兜底模式        │
│     要点：**先定小节边界，再解析音符**（与现状相反）           │
└─────────────────────────────────────────────────────────────┘
      │
      ▼
┌─────────────────────────────────────────────────────────────┐
│ S5  readBlockNotes                                          │
│     入：RawBlock + MeasureSegment[] + (colsPerMeasure, per)   │
│     出：BlockNotes { notes: AsciiNote[], partial, failedAt }  │
│     职责：字符级扫描（品位/闷音/技法/未识别）、时值三步收束、  │
│           小节容量裁剪、列→tick 换算                          │
│     要点：**同一份字符流只扫一遍**，行内列号就是全局列号        │
└─────────────────────────────────────────────────────────────┘
      │
      ▼
┌─────────────────────────────────────────────────────────────┐
│ S6  assemble                                               │
│     入：各块 BlockNotes + header                               │
│     出：ParsedAscii                                           │
│     职责：全局小节序号 / 全局 startTick 累加、partial 归并、    │
│           failedAt 取最小、warnings 去重                       │
└─────────────────────────────────────────────────────────────┘
      │
      ▼
ParsedAscii → asciiToTab → validateTab → ImportResult
```

### 2.2 端到端文字流程（样例 D 走一遍）

```
输入：
  Title: Wonderwall
  Artist: Oasis
  Tuning: E A D G B E
  BPM: 87
  Album: (What's the Story) Morning Glory?
  （空行）
  [Intro]
  e|--0---0-|
  B|--3---3-|
  ...

S1 → Title:/Artist:/Tuning:/BPM:/Album: = 'kv'（Album 是 kv 但键不在白名单）
     空行 = 'blank'
     [Intro] = 'section'
     e|... = 'string'（弦号 e + 终止符 | + 内容含 '0'）
S2 → title='Wonderwall'（剥前缀）、artist='Oasis'、
     tuning=['E','A','D','G','B','E']、bpm=87、
     'Album' 命中 KV 形状但键不在白名单 → **静默忽略，不置 partial**
     tsFromHeader = undefined（表头无 `· X/Y`）
S3 → 一个块，6 行；sectionLabel='Intro'（来自最近的 section 行）
S4 → 块内 6 行都含 `|` → 小节线模式
     perRowSegCount = [1,1,1,1,1,1] → 众数 = 1 → measureCount = 1
     段边界取各行并集的 [0, 7)（见 §3.1）
S5 → 逐行扫字符；'0'@col2/6 → (1弦,0) t=240/720 ……
     时值收束：同弦下一音符 / 下一任意弦事件 / 本小节右边界
S6 → 1 个小节，index=0，startTick=0，sectionLabel='Intro'
     partial=false，failedAt=undefined
     → asciiToTab：title='Wonderwall'、artist='Oasis'、bpm=87
```

---

## 3. 核心算法裁决

### 3.1 小节线切分算法（缺陷 1 / R1 / R3 / RISK-3）

#### 决策 D1：**模式判定按块，且是「任一行含 `|`」即整块进入小节线模式**

- **块内任一 string 行含 `|` → 整块走小节线模式（R1）**；块内**所有**行都不含 `|` → 整块走列数兜底模式（R2）。
- 理由：逐行判定会产生「有的行按 `|` 切、有的行按 16 列切」的**两套坐标系**，同一小节内不同弦的音符 tick 语义不同，是灾难。PRD §8 Q1 倾向逐块判定，我确认并**加强为「块内任一行为真」**，因为 `|` 是结构声明，缺少个别 `|` 是书写瑕疵而非语义差异。
- 「含 `|`」的判定范围是**弦内容区**（弦号与其后的终止符之后的全部字符）。

#### 决策 D2：**列坐标系裁决 —— 弦号、终止符、`|` 一律零宽**

这是本节最关键的一条，它统一了所有行、消除了「行首 `|` 是否占列」的歧义，并让既有断言自然成立。

```
列坐标定义（Column Space）
──────────────────────────────────────────
 列 0 ── 弦内容区第一个字符
 每个**字符**占 1 列；`|` 占 1 列

弦内容区的起点（定义在物理行上，与 `|` 无关）：
 1. 取 LINE_RE 捕获组 m[3] 的物理起点 = 弦号后第一个字符（含可能的 `|` 或空格）
    ★ 前置条件（防止同列多音抵消）：若该物理字符是 `|` 或空白，
      起点**向后跳过全部连续的 `|` 与空白**，落到第一个非 `|` 非空白字符
    例：'e|--0---0-' → m[3] 物理起点 = 1（'|'）→ 跳到 2 → 列 0 是第一个 '-' 
 2. 行尾**在 FIRST_BAR 之前**的空白与 `|` 裁掉（trailing 收口）
 3. 若整行裁完后为空 → 该行无内容区
```

于是：`e|--0---0-|--2---2-|` 的内容区 = `--0---0-|--2---2-`（尾 `|` 裁掉），`0` 在列 2 / 6。

**为什么这条定义是对的**：它有两个独立锚点被迫满足 ——
1. `io.test.ts:107-113`：`1|---0--` 内容区 = `---0--`（`|` 与空格被跳过），该行**不含** `|` → 兜底模式 → 1 个小节 ✔（若有 2 行含 `|` 则另当别论，此例仅 1 行）
2. `asciiToTab` 往返 16 小节。原实现对 `e|CELL|CELL|CELL|CELL|` 的语义是「剥掉所有 `|` 与空白后取前 16/32/48/64 列」，即 `CELL` 的第 k 列落在 16m+k；本定义的 `CELL` 第 k 列也落在列 16m+k。**两套语义在「导出格式」这一族输入上逐列等价**（§10 [START] 有 diff 级论证）→ 16 小节与 signature 断言不破。

#### 决策 D3：**`|` 的分段规则（barSegments）**

在**内容区**上（尾 `|` 已裁）执行：

```
bars ← 内容区中所有字符 == '|' 的列号，升序
segments ← []
prev ← 0
for b in bars:
    if b > prev: segments.push([prev, b))     // ★ 要求 b > prev，不是 b >= prev
    prev ← b + 1
if |content| > prev: segments.push([prev, |content|))
```

- `b > prev` 这个严格大于**实现了「连续的 `||` 不产生空小节」**（`prev = b+1`，下一根 `|` 的列 = b+1 = prev → 不 push）。
- **行首 `|` 自然不产生空小节**：因为内容区定义已经把行首的 `|` 剔除了；即便残留（如 `e| |--0--` 这类畸形），`[0, 0)` 也会被 `b > prev` 消掉。
- 尾 `|` 由内容区定义裁剪；即便残留，`[prev, prev)` 同样被消掉。
- 分段的两端是**列号半开区间**，直接就是「本小节的列范围」。

#### 决策 D4：**跨行 `|` 位置不一致（挪位）→ 众数定小节数 + 并集定边界**

- `perRowSegCount[i]` = 第 i 行的 section 个数。
- **`measureCount = mode(perRowSegCount)`**（出现次数最多者；并列取**最小**值）。
- `measureCount = max(1, measureCount)`（全行无 section 时保底 1，防 `width=0`）。
- 若 `perRowSegCount` 不全等 → `partial = true`（R4/PRD R1 措辞），且 `failedAt` 不因此设置（这是结构瑕疵，不是识别失败）。
- **第 m 小节的列范围** = 取所有 `perRowSegCount[i] >= m+1` 的行，其第 m 段的并集：

```
starts = [ segStart_i(m) for 行 i 且 segCount_i >= m+1 ]
ends   = [ segEnd_i(m)   for 同行 ]
startCol_m = min(starts)
endCol_m   = max(ends)
```

- **为什么用并集而不是剪裁**：某行多写一段内容是它自己的信息，剪掉是丢数据；并集让该内容至少能被解析出来。某行少写段 → 它在后续小节 `segCount_i < m+1` → 该行在这些小节**自然无音符**（决策 D5），等价于「该弦在这些小节无音符」，正是 PRD R1 要求的「多退少补」。
- **为什么并列取最小值**：`measureCount` 决定小节数，取小值更保守，避免个别行多敲一根 `|` 就凭空多出一堆空小节。

#### 决策 D5：**某行完全没有 `|`（但块是 `|` 模式）→ 该行只有第 0 段，后续小节该行无音符**

- 该行的 `perRowSegCount = 0`（0 段）或按「`bars` 为空 → 只有 `[0, |content|)` 一段」处理。
  **裁决：`bars` 为空 → `segments = [[0, |content|)]`，即 `segCount = 1`。**
  这样「整块有 `|` 但某行是光秃秃的 `E|--------`」会被视为「该弦只覆盖第 0 小节」，其列范围并入第 0 小节的并集（因 `endCol_0 = max(...)` 会把它算进去）。这是一行空内容，不会引入音符，只影响第 0 小的右边界（且右边界还会被 `per` 截断，无害）。
  若某行 `content` 为空（长度 0）→ `segCount = 0`，该行在所有小节都无音符。
- **行内无 `|` 但有超长内容**：其内容全部归入第 0 小节，若超 16 列 → 触发 §3.6 的容量裁剪 + `partial` + `failedAt`。符合 PRD「信小节线」。

#### 决策 D6：**列数兜底模式（R2）保持现状语义**

`segments` 按 `colsPerMeasure = asciiColsPerMeasure(ts)` 机械切：

```
measureCount = max(1, ceil(blockWidth / colsPerMeasure))
seg m = [ m*colsPerMeasure, min(blockWidth, (m+1)*colsPerMeasure) )
```

其中 `blockWidth = max over lines |content_i|`。
**注意**：`io.test.ts:86-105`（`e|---0---@---`，块宽 12，4/4）→ `measureCount = ceil(12/16) = 1`；
`io.test.ts:107-113`（块宽 6）→ 1；`qa-import-roundtrip.test.ts:78-91`（块宽 7）→ 1。三条全部保 1 个小节 ✔

#### 3.1.1 小节线切分伪代码

```
function splitMeasures(block, ts, colsPerMeasure): { segments, partialByMismatch }
  contents ← block.lines.map(l => l.content)          // 已按 D2 定义裁好
  blockWidth ← max(|c| for c in contents)             // 0 时用 0
  hasBar ← contents.some(c => c.includes('|'))

  if !hasBar:
      n ← max(1, ceil(blockWidth / colsPerMeasure))
      return { segments: [ [m*colsPerMeasure, min(blockWidth,(m+1)*colsPerMeasure)) for m in 0..n ), partialByMismatch: false }

  perRow ← []
  for c in contents:
      bars ← [i for i,ch in c if ch == '|']
      segs ← []
      prev ← 0
      for b in bars:
          if b > prev: segs.push([prev, b))
          prev ← b + 1
      if |c| > prev: segs.push([prev, |c|))
      if segs is empty: segs ← [[0, |c|]]            // D5
      perRow.push(segs)

  counts ← perRow.map(segs => |segs|)
  measureCount ← max(1, modeMin(counts))
  partialByMismatch ← counts 不全等

  segments ← []
  for m in 0 .. measureCount-1:
      starts ← [segs[m][0] for segs in perRow if |segs| >= m+1 and |segs[m]| > 0]
      ends   ← [segs[m][1] for segs in perRow if |segs| >= m+1 and |segs[m]| > 0]
      if starts is empty: segments.push([0, 0))       // 空小节
      else: segments.push([ min(starts), max(ends) ))
  return { segments, partialByMismatch }
```

> 复杂度 O(行数 × 行宽)，全程一次遍历 + 一次转置，实测输入量级（<1MB）无性能顾虑。

#### 决策 D6b（= team-lead 追问 1）：**容量溢出与裁剪规则 —— 确定性规则**

**先纠正一个我原设计的盲点。** 我用 node 复算了样例 B，发现**「段宽 18 列」并不等于「某音符 `startTick >= per`」**：

```
样例 B 段内容 = '--0---0---0---0---'（18 列）
4 个音符在相对列 2 / 6 / 10 / 14 → startTick = 240 / 720 / 1200 / 1680
                                                      ★ 全部 < 1920 = per
最大音符列 14 < 16（= per / 120）  →  没有任何 startTick 越界
```

**结论：样例 B 的 `partial` 不能由 `startTick` 判定得出。** 若工程师只写「`startTick >= per` 就 partial」，样例 B 会得到 `partial === false` → 断言红。
（能触发 `startTick` 越界的阈值是**音符落在相对列 ≥ 16**，样例 B 差 2 列没到。）

所以溢出必须**两步判定，两个独立触发源**：

| 触发源 | 判定式 | 置位 |
| --- | --- | --- |
| **S1 · 段宽溢出** | `段宽 > colsPerMeasure`（样例 B：`18 > 16` ✔） | `partial = true`，`failedAt = 该小节全局序号` |
| **S2 · 音符起点溢出** | 存在音符 `相对列 c` 使 `c * ASCII_COL_TICKS >= per`（即 `c >= colsPerMeasure`） | `partial = true`，`failedAt = min(已有, 该小节序号)` |

**S1 是样例 B 唯一命中项**，也是「列数溢出拍号容量」这句 PRD 措辞的字面实现。**S1 与 S2 都必须实现**，缺一条会漏。

**裁剪规则（确定性，按序执行）**——三条，全部是 `clamp`：

```
对每个音符 n（位于小节 m，段内相对列 c，自身占 colSpan 列，时值 durTick 见 §3.6）：

① 起点裁剪（仅 S2 场景会真正生效，S1 场景是 no-op）
     maxStart = per - MIN_NOTE_TICKS                    // 1920 - 60 = 1860
     startTick = clamp(c * ASCII_COL_TICKS, 0, maxStart)

② 终点裁剪（★ 样例 B 真正生效的一条）
     右边界 = per - startTick
     durationTick = clamp(durTick, MIN_NOTE_TICKS, min(per, 右边界))

③ 不变量（必须写成断言）
     startTick >= 0
     durationTick >= MIN_NOTE_TICKS                      // 60，保底可听
     startTick + durationTick <= per                     // ★ 样例 B 的硬断言
```

**关键点解释**：

- **`startTick` 用 `clamp` 到 `per - MIN_NOTE_TICKS`，而不是「`startTick >= per` 就丢音符」** —— PRD R3 明确「溢出音符**裁剪但不丢弃**」。`clamp` 保证音符留在小节内且仍有 `MIN_NOTE_TICKS` 可听，符合「永不零导入」的产品目标。
- **`maxStart = per - MIN_NOTE_TICKS = 1860` 是 1 列对齐的**：`1860 / 120 = 15.5`，不是整数列。若不强制列对齐，`startTick` 会落在非列网格上。**裁决：`clamp` 后再 `round` 到最近的 `ASCII_COL_TICKS` 网格，且结果仍受 `per - MIN_NOTE_TICKS` 约束**。由于 `MIN_NOTE_TICKS(60) < ASCII_COL_TICKS(120)`，实际能取到的最大网格点是 `15 × 120 = 1800`（`16 × 120 = 1920` 已越界）。**即：起点裁剪实际是「`c > 15` 一律收到 `15 × 120 = 1800`」**。这样 `durationTick` 下限 60 在 `1800 + 60 = 1860 <= 1920` 内成立 ✔
- **②的 `min(per, 右边界)` 中 `per` 是冗余保护**（`右边界 = per - startTick <= per` 已恒成立），保留它作为防御式写法，防止 ①将来被改坏。
- **`MIN_NOTE_TICKS` 的优先级高于「不越界」**：当 `per - startTick < MIN_NOTE_TICKS` 时（只可能出现在 ①被误实现的场景），`clamp(lo=60, hi=<60)` 的行为是**返回 `lo`**（`constants.ts:153-156` 的实现是 `n < lo ? lo : n > hi ? hi : n` —— 注意 `hi < lo` 时先命中 `n < lo` 分支，得 `lo`）。这意味着会**略微越界**而不是产生不可听音符。**裁决：接受。** 因为按 ①的 `maxStart = 1800`（严格 `< per`），`per - startTick >= 120 > 60` **恒成立**，该分支**不可达**。这是一条死代码保护，不是活路径。

**样例 B 的确定性期望值**（可直接写成断言）：

```
输入 6 行 × 段 '--0---0---0---0---'（段宽 18）
measures.length          === 1        （信 |，18 列只切 1 段）
partial                  === true     （S1：18 > 16）
failedAt                 === 0
音符总数                  === 24       （6 弦 × 4 个）
第 e 弦 4 个音符：
  startTick              === [240, 720, 1200, 1680]
  durationTick           === [480, 480, 480, 240]
                            ↑ 前三个到下一个同弦音符（4 列 = 480）
                            ↑ 第四个被 ② 裁到右边界 1920 - 1680 = 240
  startTick+durationTick === [720, 1200, 1680, 1920]   ★ 全部 <= 1920
```

**为什么第四个音符是 240 而不是被 `MIN_NOTE_TICKS` 抬到 60**：`240 > 60`，下限不生效 ✔。这也顺带证明**样例 B 修复前的行为**（原实现给 `nextCol = width = 18` → `durCols = 4` → 480 → 终点 2160，**超容量 240 ticks**）会被 `startTick + durationTick <= per` 这条断言**抓住** ✔ —— 即该断言具备区分度，满足 team-lead 「修复前必红」的要求。

### 3.2 拍号来源裁决（缺陷 6 / R6）

#### 决策 D7：**表头拍号 > `ts` 参数默认值；`ts` 参数退化为「无表头时的默认值」**

优先级从高到低：

1. **文本表头里显式解析出的拍号**（识别 `\b([34])\s*/\s*4\b`，务必加词边界，避免误吃 `BPM 87/4` 这类；仅接受 `[4,4]` 与 `[3,4]`，其余忽略并置 warning）
   - 扫描范围：**前导区（第一个 string 行之前）的全部行**，而不仅第 2 行 —— 更鲁棒。
   - 具体目标：`tabToAscii` 写的 `艺术 家 · 调 C · BPM 87 · 3/4` 里的 `3/4`。
2. `parseAscii(text, ts)` 的 `ts` 实参。
3. 字面默认 `[4, 4]`。

**理由**：
- 语义上，文本拍号是**作者写下的数据**，`ts` 是**调用方给的默认值**；数据 > 默认值。这与 R3「信小节线不信列数」是**同一条原则**（信显式声明，不信内部约定）在另一个维度上的应用。
- 工程上，导出表头**必须**写拍号（`exporters.ts:26` 已在写，且 PRD NG6 禁止改导出格式），所以往返路径上表头**一定存在**，这条规则让 3/4 往返自愈，无需改 `asciiToTab` 的签名。
- **对现有断言零影响**：`io.test.ts` 与 `qa-import-roundtrip.test.ts` 的 ASCII 输入都**没有** `X/Y` 形式的表头；SONG_MORNING 是 4/4，表头写 `4/4`，解析出 `[4,4]`，与 `ts` 默认值一致。

**`asciiToTab` 的连带修正**：`importers.ts:229-235` 的 `timeSignature: [4, 4]` 硬编码改为 `parsed.timeSignature ?? [4, 4]`，`bpm: ASCII_DEFAULT_BPM` 改为 `parsed.bpm ?? ASCII_DEFAULT_BPM`。**这是 R6 之外 PRD 未点名但必须做的一致性修复**——否则解析出了 3/4 却写不进 Tab，往返依然坏。`ParsedAscii.timeSignature` 因此成为必需字段（§4）。

**与 `asciiColsPerMeasure` 的关系**：`colsPerMeasure` 由**裁决后的终值** `ts` 派生，全流程只有一个 `colsPerMeasure`（兜底模式 + 容量溢出判定共用），避免两处不一致。

### 3.3 部分弦块（R4 / 缺陷 3）

#### 决策 D8：**数据结构上「缺失弦」= 该弦不在 `block.lines` 里，不引入占位行**

| 概念 | 数据结构表达 | 结果差异 |
| --- | --- | --- |
| **缺失弦**（块里根本没这一行，如 5 行块缺 6 弦） | `block.lines` 中无 `label === 6` 的项 | 该弦**任何小节都无音符**；不置 `partial`（这是合法输入，非降级） |
| **该弦全程无音符**（行了但内容全是 `-`） | 有 `label === 6` 的项，`content` 全新是 `-`/空 | 同上，**任何小节无音符**；也不置 `partial` |

**结论：二者在 `Tab`/`Measure`/`Note` 这三个输出结构上完全无差别** —— `note.string` 是唯一载体，没音符就是没音符，下游（渲染 `tabRender.ts`、播放 `tabToTabScheduledNotes`、难度 `difficultyFactors`）**没有任何地方需要知道某条弦「是否存在」**。

**因此我明确不引入 `presentStrings` / `missingStrings` 字段。** 理由：
1. 没有任何消费者。加一个全项目无人读的字段违反「只增不改」的最小化精神（PRD §6 允许新增可选字段，但没要求加无用字段）。
2. 它会把「弦是否存在于文本」这一**解析中间态**泄漏进领域模型，增加序列化负担（JSON 往返要带上）且污染语义。
3. 唯一潜在用途是 UI 提示「本谱缺 6 弦」，但 PRD NG7 明确不改 UI，且这属于**锦上添花**，不值得为它动 `ParsedAscii` 结构。

**块识别规则（R4 + RISK-1 防误判边界，PRD 已拍板，此处落为可实现判据）**：

一个物理行是 string 行，当且仅当**同时**满足：

```
① LINE_RE 匹配：^\s*([eEBGDA]|[1-6])(\s*\|\s*|\s+)(.*)$
     —— 弦号后**必须**跟 `|` 或至少一个空白（终止符），排除 'A:' 开头正文
② m[3] 中**至少一个**音符字符：/[\d xX]/.test(m[3])   —— 纯 '---' 不算
③ 两条互斥分支（e/B/G/D/A/E 与 1..6 各自独立）：
   · 若块中已出现字母类弦号 → 本行必须是字母类，且 e/B/G/D/A/E **互异**
   · 若块中已出现数字类弦号 → 本行必须是数字类，且 1..6 **互异**
   —— 禁止 'B'（弦 2）与 '2'（弦 2）在同块共存
④ 单行块（块只有 1 行）额外要求：m[3] 含 '|'
     —— 挡住「一行普通文本恰好以 E/A 开头且含数字」的最坏误判
⑤ 块内 string 行必须**连续**；遇 blank / other / section / kv 行即断块
```

- **②的取舍**：`E|--------` 这种**全空弦行不含音符字符** → 不满足②→ 不是 string 行 → 会导致 6 行块缺一行。
  实测影响：`io.test.ts:86-105` 的 `E|--------3--` 含 `3` ✔；`qa-import-roundtrip.test.ts:94-102` 的 `E|-----------------|` **全是 `-`** → ②不满足 → 块变成 5 行（e/B/G/D/A）→ 仍然 `measure.length > 0` ✔（该断言只要求 `> 0`）。
  **裁决：接受这个行为**。若把②放宽为「含 `-` 即算」，则 `A: --- whatever ---` 这类正文会通过①（`A` + 空格），造成 RISK-1 误判。**②必须严格**。
- **③的取舍**：`io.test.ts:107-113` 用的是数字块 `1|..6|`，`io.test.ts:86-105` 用字母块 `e..E`，两者各自内部一致 ✔。混用（`e` 与 `2` 同块）现实中不存在，禁掉不可能误伤。

**块宽（用于兜底模式）与「缺弦」的交互**：`blockWidth = max over 所有 string 行 |content|`。5 行块与 6 行块的 `blockWidth` 计算方式一致，缺弦不影响其余弦的列对齐 ✔（R4 的「不影响其他弦的解析」由**列坐标系按行独立**天然保证——列号来自各行自己的 content，不存在「以某行为基准对齐其他行」的步骤。**这正是我不做「行对齐/列补齐」的原因**：补齐会在行间引入耦合，而列坐标系已经让「短行 = 后面无内容」自然成立）。

#### 决策 D8b（= team-lead 追问 2）：**`groupBlocks` 的确定性规格 —— 硬性要求**

`blank` 断块是 `io.test.ts:70` 的**必要前提**。我复算了「不断块」的后果，确认这是**单点故障**而非可选优化：

```
导出形态（tabToAscii，16 小节）：
  <标题>
  <艺术家 · 调 C · BPM 87 · 4/4>
  （空行）                        ← ★ 这个 blank 是唯一的块分隔符
  e|CELL0|CELL1|CELL2|CELL3|
  ... 6 行 ...
  （空行）                        ← ★
  e|CELL4|...|CELL7|
  ... 6 行 ...
  （空行）
  ...
  （空行）
  e|CELL12|...|CELL15|
  ... 6 行 ...
  （空行，行尾）

若 groupBlocks 不断块：24 个 string 行连成 1 个块
  → 每行 4 段 → measureCount = mode([4,4,...,4]) = 4
  → 得到 4 小节，而非 16  ✗  io.test.ts:70 变红
正确实现（blank 断块）：4 块 × 每块 4 段 → 4 + 4 + 4 + 4 = 16 ✔
```

**规格（必须逐条实现，T03 的验收项）**：

```ts
interface RawBlock {
  lines: { label: StringNumber; content: string }[];   // 1..6 条，弦号互异
  sectionLabel: string;                                 // 累积状态，见 §OP-5
  /** 块的首行在 lines 数组中的下标，用于 failedAt 反查（调试用） */
  firstLineIndex: number;
}

function groupBlocks(lines: RawLine[]): RawBlock[] {
  const blocks: RawBlock[] = [];
  let cur: RawBlock['lines'] = [];
  let curLabels = new Set<StringNumber>();
  let curKind: 'letter' | 'digit' | null = null;   // D8③ 的族锁定
  let section = '';                                 // 累积段落名（跨块延续）

  const flush = (firstLineIndex: number) => {
    if (cur.length >= 1) blocks.push({ lines: cur, sectionLabel: section, firstLineIndex });
    cur = []; curLabels = new Set(); curKind = null;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    // ① section 行：设段落 + **强制断块**（OP-6 裁决）
    if (line.kind === 'section') { flush(i + 1); section = line.sectionName; continue; }

    // ② 非 string 行（blank / other / kv）→ 强制断块
    if (line.kind !== 'string') { flush(i + 1); continue; }

    // ③ string 行：先做「能否并入当前块」的校验，不能则先 flush 再起新块
    const info = line.stringInfo!;   // { label, family: 'letter'|'digit' }
    const canJoin =
      curKind === null                                  // 块内首行，任意族
        ? true
        : curKind === info.family                       // 族一致
          && !curLabels.has(info.label);                // 弦号未重复

    if (!canJoin) { flush(i + 1); }

    curKind ??= info.family;
    curLabels.add(info.label);
    cur.push({ label: info.label, content: line.content });
  }
  flush(lines.length);
  return blocks;
}
```

**验收方式（写进 T03 的硬性要求，逐条断言）**：

| # | 断言 | 期望 |
| --- | --- | --- |
| A1 | `parseAscii(tabToAscii(sourceTab)).measures.length` | **`=== 16`** |
| A2 | `groupBlocks(normalizeAsciiLines(tabToAscii(sourceTab))).length` | **`=== 4`**（blank 断块生效的直接证据） |
| A3 | 每个块的 `lines.length` | **`=== 6`** |
| A4 | 每个块内 `label` 集合 | **`=== {1,2,3,4,5,6}`**（互异，D8③） |
| A5 | 把 `tabToAscii` 输出里的所有空行删掉后再解析 | **`measures.length !== 16`**（**反向断言**：证明 blank 断块确实是必要前提，删掉它就是错的） |

**A5 是本条的关键**：它把「`blank` 断块」从「实现细节」升级为**有测试保护的契约**。将来任何人为了「容忍空行缺失」而移除断块逻辑，A5 会红。**注意 A5 的期望是「不等于 16」，不是「等于 4」** —— 因为删空行后 24 行连块的 `mode` 是 4 段 → 4 小节；断言「`!== 16`」比写死 4 更鲁棒（若将来块内弦号互异规则变了，A5 仍能正确表达「这个输入不该得到 16」）。

**跨块小节序号与 `startTick` 连续累加**（PRD R5）：`assemble`（S6）里 `measures.push({ index: measures.length, startTick: measures.length * per, ... })`。由于 `measures` 是**跨块累积的同一个数组**，`index` 与 `startTick` 天然全局连续。**这是 PRD R5「后一块接续前一块」的实现方式**——不需要额外状态，只要别在每个块内重置 `measures`。T03 验收：第 4 块第 0 小的 `index === 12`、`startTick === 12 * 1920 = 23040`。

### 3.4 `'v'` 字符裁决（缺陷 7）

#### 决策 D9：**`'v'` 是笔误，从 `TECHNIQUE_CHARS` 移除；不扩充 `Technique` 联合类型**

**理由（三条，按权重）**：

1. **语义重叠 + 已有专门字段**。`Technique` 承载的是**奏法**（`h` 槌弦 / `p` 勾弦 / `s` 滑音 / `x` 闷音 / `^` 推弦），而 `Stroke = 'D' | 'U' | 'P' | 'X' | null`（`types/tab.ts:51`）已经**专门表达拨弦方向**（下拨 / 上拨 / 拨片 / 闷扫）。`v` 在六线谱惯例里读作「下拨」——它属于 `Stroke` 的语义域，**不属于 `Technique`**。把它塞进 `Technique` 是**字段误用**，不是类型缺失。
2. **重名会制造下游歧义**。若把 `'v'` 加进 `Technique`，则同一个「下拨」概念在系统里有两条表达路径（`techniques:['v']` 与 `stroke:'D'`），任何 `switch(technique)` 或渲染逻辑都要处理两种真值源。`ui/tab/tabRender.ts:309-313` 会把 `'v'` 当技法字面渲染到谱面上——**用户会看到谱面上多出一个 `v`**，而这是纯噪音。
3. **它是三处不一致里唯一的「野生」值**。`Technique` 联合类型（`types/tab.ts:52`）是设计意图的权威声明；`TECHNIQUE_CHARS`（`importers.ts:43`）是一个**独立维护的字符表**，`'v'` 出现在那里而不是类型里，最简解释就是**当初写字符表时手滑**。

**具体落地**：
- `importers.ts:43` 改为 `const TECHNIQUE_CHARS = new Set(['h', 'p', 's', '^'])`。
- **不保留任何 `as Technique` 强转**（缺陷 7 的根因）。把字符表与类型**编译期绑定**：

```ts
// 唯一真值源：类型字面量数组用 satisfies 绑到 Technique，再派生 Set
const TECHNIQUE_CHARS_ARRAY = ['h', 'p', 's', '^'] as const satisfies readonly Technique[];
const TECHNIQUE_CHARS: ReadonlySet<string> = new Set<string>(TECHNIQUE_CHARS_ARRAY);
```

  `satisfies` 保证：**若将来有人从 `Technique` 里删掉 `'h'`，这一行立刻编译报错**。字符表再也不能与类型脱钩。
- `'v'` 落入 `ALLOWED_CHARS` 之外的**未识别字符分支** → 按 `-` 处理 + `partial = true`（R9 语义）。这既守住类型，又**不丢音符**（用户若真粘了 `-5v7-`，两个音 5 与 7 都保留，只是被标记 partial 提示「有字符没认出来」）。
- **不修改 `types/tab.ts`**（PRD §6 规则 6）。

### 3.5 音符字符识别：两位数品位 vs 两个相邻单数品位（RISK-6）

#### 决策 D10：**改用「单字符预读」（peek）代替「贪心吃到 2 位」，并把判定钉在「下一字符是否是音符字符」上**

**现状（`importers.ts:120-141`）会误吃**：`while (... && digits.length < 2)` 无条件吃满 2 位。

```
输入 '-12-'
  原实现：col=1 读到 '12' → fret=12，col 跳到 3。产 1 个音符（12 品）
输入 '-1-2-'  （同位两个单数品：1 品与 2 品，共 3 列跨度）
  原实现：col=1 读 '1'，下一位 '-' 非数字 → digits='1' → fret=1 ✔ 不会误吃
输入 '--12'   （意图：1 品与 2 品相邻？还是 12 品？）
  原实现：吃 '12' → fret=12

★ 真正的误吃场景是【音符跨弦同列对齐】被破坏：
  e|-1-|
  B|-12|     ← B 弦的 '1' 与 '2' 是两列上的两个独立音符，但原实现会吃成 fret=12
  D|-2-|
  原实现：B 弦 '1' 后紧跟 '2' → 吃成 12 → 该弦少 1 个音符、且品位错成 12（超过合理把位）
```

注意原实现**确实会**误吃：只要是「相邻两列各一个数字」且行内相邻，就无条件合成 2 位数——`-12` 与 `1`+`2` 在文本上**无法区分**，这是 ASCII 六线谱的**固有歧义**，PRD RISK-6 已拍板「沿用现有规则：最多 2 位合成一个品位」。

**但我要在既有规则上加一条判据，把绝大部分误吃挡掉**，而**不改变 PRD 认可的「`12` → 12 品」行为**：

```
读取 col 处字符 c1：
  若 c1 不是数字 → 走闷音/技法/未识别分支
  若 c1 是数字：
      c2 ← content[col+1]   （若越界则视为非数字）
      若 c2 是数字：
          取两位 → fret = c1*10 + c2，消费 2 列，col += 2
      否则：
          取一位 → fret = c1，消费 1 列，col += 1
```

——这**就是**现有行为，我不改。**"钉在下一字符"** 指的就是「下一位是数字才续读」，这已经排除了 `-1-2-` 的误吃。**真正的增量在别处**：

#### 决策 D10 的增量：用**列占位**表达「两位数占 2 列」，并让相邻数字不再继续合并

```
读取 col 处字符 c1（数字）：
  若 content[col] 与 content[col+1] 都是数字 → fret = 两位，消费 2 列
  该音符记录 colStart = col, colSpan = 消费列数（1 或 2）
```

**关键点**：一旦消费了 2 列，`col` 跳到 `col+2`，**不会再从 `col+1` 重新起读**。因此 `-123-` 会读出 `12` 然后读 `3`（两个音符：12 品、3 品），而不是 `1`,`23`。这与原实现一致，且与 `tabToAscii` 的写回规则（`exporters.ts:38` 的 `for i < digits.length` 逐位写）**互为逆**：

- 导出：`fret=12` 写 `grid[col]='1'; grid[col+1]='2'` → 占 2 列
- 导入：读 `'12'` → 12 品，占 2 列 ✔ 往返一致

**结论（给工程师的明确指令）**：
1. **保留**「最多 2 位合成」规则，**不要**改成 `parseInt` 无上限（会吃掉 `123`）。
2. **不要**试图用启发式在 `1`+`2` 与 `12` 之间做语义猜测（PRD NG5 精神：不猜）。当前列宽约定（1 列 = 1/16）已经让 10/11/12 品这类两位数**必然**写成相邻两位，区分它们需要额外信息（如空格/制表），而 ASCII 惯例不提供。
3. **必须新增**：`AsciiNote.colSpan`，用于 §3.6 的「下一事件」计算 —— 原实现 `durCols = nextCol - col` 在两位品时会**多算 1 列**（因为没算自己占 2 列）。这是缺陷 4 的一个隐藏子项：`--12--0--` 里 `12` 的时值应为 `5-2=3` 列而不是 `5-2=3`（此处恰巧对，因为 nextCol 是下一个音符的**起始列**，与自身宽度无关）→ **实际无 bug**，但 `colSpan` 对「同一列两个音符」的排序稳定性有用（两位品的起始列要正确）。**裁决：新增 `colSpan` 仅用于 (a) 排序稳定、(b) 时值下限判定时区分「紧邻的下一位」**，不改变时值公式。

### 3.6 音符时值收束（缺陷 4 / R8）

#### 决策 D11：**沿用 PRD R8 的三者取最小，但「下一任意弦事件」的补偿量按 `h+c ≥ base` 闭合求最大 h，`base` 由小节格局自动选定**

PRD R8 的三约束：

```
durationCols(n) = min(
    同弦下一音符列 - n.col,                 // ① 同弦
    本小节右边界 - n.col,                   // ② 小节容量
    下一任意弦事件列 - n.col                // ③ 跨弦
)
durationTick = clamp(durationCols * ASCII_COL_TICKS, MIN_NOTE_TICKS, per)
```

**①与②都是纯函数式、无歧义。③ 有一个必须解决的连带问题：某行最后一个音符之后没有「下一事件」，`h(n)` 无定义，会退化到原来的「拉到行尾」**——也就是缺陷 4 没有被这个公式修好，只是换了个地方。

**解决方案（数学闭包）**：为每个**行**定义一个保守的右侧补充量 `base_line`：

```
h(i) ≝ 行内「物理列 i 右侧最近的一个列号 j > i，使 j ∈ 该行的某小节内容区」
       （j 可指向行尾；若 i 右侧无任何小节内容，则 h(i) = 行内容区长度 - i）

对任意音符 n（位于行 i、小节 m、列 c、结束列 e = c + span）：
    h(n) ≝ h_i(e)                  // 从「音符结束位置」起算，不是起始位置
    d_③(n) ≝ h(n) + c(n) ≥ base ? h(n) : base - c(n)
    base ≝ min over p ∈ [c(n), e(n)) of ( h_i(p) + p )
```

- **`h+c ≡ base` 恒成立时（对齐语境，如 6 行都写满 16 列/小节）**：`d_③ = h`，退化为「到行尾的距离」——**正确**，因为这正是「下一次该弦/任何弦发声位置」。
- **`h+c` 随列变化时（未对齐语境）**：`d_③ = base - c`，是该行在「下一个事件列可能落在哪」这一信息缺失下的**最大不越界猜测**。
- **`clamp(..., MIN_NOTE_TICKS, per)`**：`MIN_NOTE_TICKS` 保持下限（60）；`per` 保持上限（防溢出）。

**`base` 的化简（避免工程师去算 min over a range）**：

```
定义 `right(j)` ≝ 行内 j 右侧最近的「可能内容列」
base ≝ min over p ∈ [c, e) of ( right(p) + p )
```

由于 `p ∈ [c, e)` 且 `span ≤ 2`，`p` 最多 2 个取值：**`base = min( right(c)+c, right(c+1)+(c+1) )`（`span=1` 时只取第一项）**。实现上是常数时间，不是循环。

**反例验证（样例 F 的跨小节版本）**——注意 PRD 样例 F 本身是单小节、尺寸太小，`< 行宽` 恒真、无区分度（§0 已指出）。工程师必须用这个加强版：

```
输入（每行 1 个小节，块宽 8；单小节 4/4 仍有 16 列容量，故需 3 个小节才溢出）：
  e|--------|--------|--------|
  B|--------|--------|--------|
  G|--s-----|--------|--------|
  D|--------|--------|--------|
  A|--5-----|--------|--------|
  E|--------|--------|--------|
→ 8 列/小节 < 16 列容量 → 不判溢出；3 行 × 3 段 → measureCount = 3 ✔
  闷音 (G 弦, col 2, 小节 0)：① 同弦无下一音 → ∞；② 7-2 = 5；③ base-c
     h_2(3) 从列 3 右侧——同行的下一小节内容从列 9 开始，故 h=6；base 小节 0 段内 min(right(p)+p)=11
     → d_③ = (6+3 ≥ 11)? 6 : 11-3 = 6  → 6
  → durationCols = min(∞,5,6) = 5 → 600 ticks ✔（原实现给 8-2=6 列 = 720）
```

**关键断言**（写进测试，见 §7.3）：该闷音的 `durationTick` **必须 < 该行剩余列数 × 120**（此处 6×120=720），即证明③真的收紧了它。PRD 样例 F 的原始断言要替换成这个形态。

### 3.7 `v`、未识别字符与 `partial` 的语义边界（R9）

| 触发源 | 是否置 `partial` | 是否置 `failedAt` | 备注 |
| --- | --- | --- | --- |
| 行内出现未识别字符（含 `'v'`、`@`、`%`…） | ✅ | ✅ 首个小节序号（`measures.length + localMeasureIndex`） | 按 `-` 处理（= 延音），**现有测试语义不变** |
| 小节内内容列数 > `colsPerMeasure`（容量溢出） | ✅ | ✅ | 音符**裁剪不丢**，`startTick+durationTick ≤ per` |
| 块内各行 section 数不一致（RISK-3） | ✅ | ❌ | 结构性瑕疵，无具体位置 |
| `Tuning` 键存在但无法可靠解析 | ✅（PRD R9）+ `warnings` 追加文案 | ❌ | 保持默认 `['E','A','D','G','B','E']` |
| `Album:` 等白名单外 KV 行 | ❌ | ❌ | 静默忽略（PRD R6） |
| 块内缺弦（R4） | ❌ | ❌ | 合法输入 |
| 行数不齐 / 行宽不一 | ❌ | ❌ | 宽松解析的**正常**输入（`qa-import-roundtrip.test.ts:78-91` 要求不报错） |

**`failedAt` 多成因同时出现 → 取最小小节序号**（PRD §8 Q3 确认，我同意）：`failedAt = min(所有候选)`。UI 的 `partialPromptMessage` 用 `failedAt + 1` 展示为 1-based（`importHelpers.ts:53`）。

---

## 4. 类型与接口变更（只增不改）

### 4.1 `ParsedAscii`（`importers.ts:55-61`）

现行字段 **`title / measures / partial / failedAt / reason` 全部保留、类型不变**（PRD §6 规则 4）。

新增（全部可选或必填但向后兼容）：

```ts
export interface ParsedAscii {
  // ── 既有（不改） ──
  title: string;
  measures: Measure[];
  partial: boolean;
  failedAt?: number;
  reason?: string;

  // ── 新增 ──
  /** 表头 Artist/Band/By，未提供则 undefined（asciiToTab 回退 '未知'） */
  artist?: string;
  /** 表头 Tuning 解析结果（6 弦→1 弦）。无法解析时 undefined，Tab 保持默认 */
  tuning?: readonly ['E', 'A', 'D', 'G', 'B', 'E'] | ... ;
  /** 表头 BPM/Tempo，已 clamp 到 [MIN_BPM, MAX_BPM]；未提供则 undefined */
  bpm?: number;
  /** 裁决后的拍号（表头 > ts 参数 > [4,4]）；**必填**，供 asciiToTab 写入 Tab */
  timeSignature: TimeSignature;
  /** 结构化警告，直接透传给 ImportResult.warnings（如 Tuning 解析失败） */
  warnings?: string[];
}
```

**逐字段语义与「为什么需要」**：

| 字段 | 类型 | 语义 | 存在理由 |
| --- | --- | --- | --- |
| `artist` | `string \| undefined` | 表头 `Artist/Band/By` 的**值**（已剥前缀与首尾空白，`slice(0,120)`）。非 `''`（空值视为未提供） | 缺陷 2；`asciiToTab:232` 现在硬编码 `'未知'` |
| `tuning` | 元组 \| `undefined` | 6 弦→1 弦的音名元组。仅当**恰好 6 个合法音名**（或可归一化的 `Drop D` 形式）时给出 | R6；无法解析时 `undefined` 让 `createEmptyTab` 用自己的默认值，避免把半个 tuning 写进 Tab |
| `bpm` | `number \| undefined` | 已 `clamp(round(n), 40, 240)`。非法/越界/非数字 → `undefined` 并加 warning | R6；**必须在此处 clamp**，因为 `validateTab:220` 会把越界 bpm 判为非法——ASCII 路径若塞越界值会被 §5 的 `validateTab` 拦下（缺陷 8 的连带修复） |
| `timeSignature` | `[4,4] \| [3,4]`，**必填** | 裁决后的终值（§3.2 D7） | 缺陷 6；`asciiToTab` 必须用它填 `Tab.timeSignature`。**必填**而非可选：可选会让「忘了传」编译期无感，而这是 P0 往返缺陷 |
| `warnings` | `string[] \| undefined` | 结构化提示，如 `'调弦信息无法识别，已用标准调弦'` | R9/§8 Q4；`ImportResult.warnings`（`types/app.ts:265`）**已存在**且 `importHelpers.ts` 已会展示 |

**明确不新增的字段**（连同理由，避免工程师自行发挥）：

- ❌ `presentStrings` / `missingStrings`：无消费者，见 §3.3 D8。
- ❌ `sectionLabels: string[]`：段落名**已经**写进 `Measure.sectionLabel`（R7 的要求就是写那里），再给一个平行数组是双写、必然不同步。
- ❌ `columnsPerMeasure`：内部中间量，随 `timeSignature` 派生，暴露出去会变成第二个真值源（正是缺陷 6 的病根形态）。

### 4.2 `ImportResult`（`types/app.ts:257-266`）—— **零改动**

`asciiToTab` 用既有字段即可全部表达：`warnings`（已存在）、`partial`、`failedAt`、`reason`。**不新增 `ImportResult` 字段。**

### 4.3 `TabImporter` / `asciiImporter` —— **零改动**

`id/label/accept/fromText/parse` 契约不变（PRD §6 规则 5）。

### 4.4 函数签名

```ts
// 签名保持（PRD §6 规则 4）
export function parseAscii(text: string, ts: TimeSignature = [4, 4]): ParsedAscii

// asciiToTab 保持无参
export function asciiToTab(text: string): ImportResult
```

`asciiToTab` **不新增 `ts` 参数** —— 拍号从文本表头自取（D7）。理由：调用点（`asciiImporter.parse`、`ui/library`）没有 `Tab` 上下文，传不了；若硬加参数，调用方必然传默认 `[4,4]`，等于没改。

### 4.5 常量（新增，放 `src/core/constants.ts`）

```ts
// ── 导入 ──
export const MAX_IMPORT_XML_MB = 8;      // 既有
export const MAX_IMPORT_JSON_MB = 20;    // 既有
/** ASCII 粘贴文本长度上限（字符数）—— 粘贴输入没有 File 对象，按字符数守卫 */
export const MAX_IMPORT_ASCII_CHARS = 1_000_000;   // ≈ 1MB 纯文本 / ≈ 2MB UTF-16
```

并在 `COPY`（`constants.ts:97`）新增：

```ts
export const COPY = {
  ...
  importAsciiTooLarge: `粘贴内容超过 ${MAX_IMPORT_ASCII_CHARS / 10000} 万字符，请分段导入`,
  asciiTuningUnparsed: '调弦信息无法识别，已使用标准调弦',
} as const;
```

**数值裁定 `MAX_IMPORT_ASCII_CHARS`**：SONG_MORNING 16 小节导出的 ASCII 约 2.5KB；一首 3 分钟密集吉他谱（200 小节）导出约 30KB。**1,000,000 字符**是最坏情况（约 1000 倍余量）的宽松上限，目的是挡住「粘贴了一本书」导致 `parseAscii` 的 O(n·w) 扫描卡死主线程，而不是限制正常使用。**在 `parseAscii` **入口**做守卫**（纯函数，便于 node 环境单测），而不是在 UI 层：

```ts
if (text.length > MAX_IMPORT_ASCII_CHARS) → { measures: [], partial: false, reason: COPY.importAsciiTooLarge }
```

**为什么放解析器而不放 UI**：缺陷 9 的根因就是「守卫建在 File 维度」（§1），UI 层的 `isFileTooLarge` 对粘贴文本天然失效。把守卫下沉到**唯一的文本入口** `parseAscii`，任何调用方（未来的剪贴板 API、拖拽 .txt、测试）都无法绕过。

### 4.6 ★ `validateTab` 接线确认与边界审查（team-lead 派工前追问 3）

**确认：是的，方案里 `asciiToTab` 真的调用 `validateTab`。** 这是缺陷 8 的全部内容，不调就是没修。

**关键点（team-lead 提示的风险）**：`validateTab` 会检查 `title` 长度 1–120（`tabFactory.ts:212`）与 `bpm ∈ [40,240]`（`:220`）。我逐条审查了 `validateTab:200-244` 的**全部 14 项检查**，确认对 ASCII 路径的误伤面：

| 检查（`tabFactory.ts` 行号） | ASCII 路径为何不会误伤 |
| --- | --- |
| `schema === SCHEMA`（`:204`） | `createEmptyTab` 写死 `SCHEMA` ✔ |
| `schemaVersion` 主版本（`:206`） | `createEmptyTab` 写死 `'1.1'` ✔ |
| `id` 非空（`:210`） | `createEmptyTab` 生成 `newId('tab')` ✔ |
| **`title` 长度 1–120（`:212`）** | ★ **标题回退链保底 `'导入的六线谱'`（长 6）**，且 `slice(0,120)` 已在解析时截断。**空标题不可能到达 `validateTab`** ✔ —— 这正是标题回退链必须**存在且不可为空**的原因，不只是为了用户体验 |
| **`artist` 是 string（`:213`）** | ★ **必须写 `parsed.artist ?? '未知'`**。若写成 `artist: parsed.artist`（`undefined`）→ `typeof undefined !== 'string'` → **校验失败**。这是本设计里唯一一个「写错就红」的接线点，已写进 §5.1 改动清单 |
| `key` 是 string（`:214`） | `createEmptyTab` 默认 `'C'` ✔ |
| `capo` 整数 0–7（`:216-217`） | `createEmptyTab` 默认 `0` ✔ |
| **`bpm` ∈ [40,240]（`:219-221`）** | ★ **必须 clamp。** `ASCII_DEFAULT_BPM = 90` 在范围内；表头 `BPM:` 值在 §3.2 D7 已 `clamp(round(n), 40, 240)`。**若表头写 `BPM: 500` 而忘记 clamp → 校验失败**。已写进改动清单 |
| `timeSignature` 只能 `[4,4]`/`[3,4]`（`:224-227`） | ★ D7 裁决只产出这两种；表头 `6/8` **必须忽略并回落默认**（已在 D7 写明）。若误把 `6/8` 写进 `Tab` → 校验失败 |
| `ticksPerBeat === 480`（`:229`） | `createEmptyTab` 写死 ✔ |
| `tracks` 非空（`:231-232`） | `createEmptyTab` 建了 1 条 ✔ |
| **`tracks[0].measures` 非空（`:235-238`）** | ★ 与 `asciiToTab:225` 的既有前置判断（`parsed.measures.length === 0 → return ok:false`）**重合**。到达 `validateTab` 时 `measures.length >= 1` 恒成立 ✔ |
| `source` 是对象（`:240`） | `asciiToTab` 传入 `{ type:'imported', importer:'ascii', ... }` ✔ |
| `practice` 是对象（`:241`） | `createEmptyTab` 的 `emptyPractice()` ✔ |

**结论：误伤面 = 0，但前提是 3 个接线点必须写对**（`artist` 用 `??`、`bpm` clamp、`timeSignature` 只允许两种）。这三条会写成 T04 的验收项。

**防御性测试（T05 必加，回应 OP-9）**：

```ts
// 一组「合法解析但字段边界」的输入，证明 validateTab 从不意外失败
const edgeCases = [
  '',                                     // 空文本 → 前置判断拦截，不进 validateTab
  '   \n\n  ',                            // 纯空白
  'Title:\nArtist:\n\ne|--0--|',          // ★ 空 KV 值 → title 走回退链
  'Title: ' + 'x'.repeat(200) + '\n\ne|--0--|',  // ★ 超长标题 → slice(0,120)
  'BPM: 9999\n\ne|--0--|',                // ★ 越界 BPM → clamp
  'BPM: abc\n\ne|--0--|',                 // ★ 非数字 BPM → 忽略 + 默认
  'e|' + '-'.repeat(300) + '0'.repeat(1) + '|',  // ★ 300 列段 → 大幅溢出
];
for (const input of edgeCases) {
  const r = await asciiImporter.parse(input);
  if (r.ok) expect(validateTab(r.tab).ok).toBe(true);   // ★ 永不出现「ok=true 但校验失败」
}
```

**为什么这组测试重要**：缺陷 8 的修复引入了一条**新的失败路径**。按我的审查它不可达，但「不可达」是推理，不是证明。这组测试把推理变成断言 —— 而且它顺带覆盖了 `OP-9`（「解析成功却变完全失败」）这个 team-lead 亲自点出的风险。

---

## 5. 文件级改动清单

> 原则：**解析纯逻辑全部留在 `src/io/`**（`io/` 层不得 import `ui/`，`archGuard.test.ts:70-76` 的 R1 虽只禁 `core/`，但 `io/` 引入 ui 会造成同层反向依赖，且破坏「`parseAscii` 无 DOM 依赖」的可测性）。新常量放 `src/core/constants.ts`。

### 5.1 `src/io/importers.ts`（主要改动，纯逻辑，无 DOM）

| 位置 | 改动 | 对应缺陷 |
| --- | --- | --- |
| `:17-24` 常量区 | `ASCII_COL_TICKS` / `ASCII_DEFAULT_BPM` / `asciiColsPerMeasure` **原样保留**（`exporters.ts` 依赖） | — |
| `:26-40` `LABEL_TO_STRING` | 保留；**另加** `isLetterLabel(c)` / `isDigitLabel(c)` 判定字母族与数字族（D8 ③） | 3 |
| `:42` `LINE_RE` | 保留；**另加** 终止符/音符字符的独立正则常量 | 3 |
| `:43` `TECHNIQUE_CHARS` | 删 `'v'`；改用 `satisfies readonly Technique[]` 派生（D9） | 7 |
| `:47-53` `AsciiNote` | 新增 `colSpan: number`（D10） | 4 |
| `:55-61` `ParsedAscii` | 按 §4.1 新增 `artist/tuning/bpm/timeSignature/warnings` | 2, 6, 8 |
| `:69-221` `parseAscii` | **重写为 6 阶段流水线**（§2.1）。建议拆出下列**导出**的纯函数（便于单测与变异测试）：<br>· `normalizeAsciiLines(text): RawLine[]`<br>· `classifyLine(line): LineKind`<br>· `extractAsciiHeader(lines): HeaderResult`<br>· `parseTimeSignatureFromHeader(lines): TimeSignature \| null`<br>· `parseTuningValue(value): TuningTuple \| undefined`<br>· `groupAsciiBlocks(lines): RawBlock[]`<br>· `splitMeasures(block, colsPerMeasure): { segments, partialByMismatch }`<br>· `readBlockNotes(block, segments, per, colsPerMeasure): BlockNotes`<br>· `collectBars(content): number[]`<br>· 内部：`nextEventColInLine(line, afterCol): number` | 1,2,3,4,5,6,7,9 |
| `:223-246` `asciiToTab` | ① 入口体积守卫 ② `artist: parsed.artist ?? '未知'` ③ `bpm: parsed.bpm ?? ASCII_DEFAULT_BPM` ④ `timeSignature: parsed.timeSignature` ⑤ `tuning` 有值才覆盖 ⑥ **接 `validateTab`**（缺陷 8）⑦ 透传 `warnings` ⑧ `reason` 在 `partial` 时非空（R9） | 2,6,8,9 |
| `:248-257` `asciiImporter` | 零改动 | — |

**`asciiToTab` 接 `validateTab` 的具体形态**（缺陷 8，PRD 未点名但 §"9 个缺陷"要求）：

```ts
const tab = createEmptyTab({ ... });
tab.tracks[0].measures = parsed.measures;
const valid = validateTab(tab);
if (!valid.ok) {
  // 结构不变量被破坏（如未来某处又漏出越界值）→ 不能静默入库
  return { ok: false, partial: false, parsedMeasures: 0,
           reason: `${COPY.notAsciiTab}：${valid.errors.join('；')}` };
}
return { ok: true, tab, partial, parsedMeasures, failedAt, warnings, reason };
```

注意：`validateTab` 的主要职责是**守卫**而非**挽救**——它在这里的角色是「防止畸形解析结果绕过不变量入库」（缺陷 8 的原话）。若它对合法输入判失败（如 `measures.length === 0`，`tabFactory.ts:237`），返回失败与 `asciiToTab:225` 的既有前置判断一致，不冲突。

### 5.2 `src/core/constants.ts` —— 新增常量与文案（§4.5）

### 5.3 `src/io/exporters.ts` —— **零改动**

`tabToAscii` 格式是往返一致性基准（PRD NG6 / §6 规则 2）。**一行不改。**
唯一要确认的是 `asciiColsPerMeasure` 与 `ASCII_COL_TICKS` 继续从 `importers.ts` 导入且语义不变（PRD §6 规则 3）✔

### 5.4 `src/ui/library/importHelpers.ts` —— 可选、极小

缺陷 9 的主守卫已下沉到 `parseAscii`（§4.5），因此**此处非必需**。
若要让 `maxImportMb('ascii')` 语义自洽（现在返回 XML 的 8，是误用），可改为返回 `MAX_IMPORT_ASCII_CHARS` 派生的 MB 值 —— **但这是 UI 文案层的调整，非本任务必需**，且 `importHelpers.test.ts` 有对应断言。**裁决：不改，避免无谓回归**。仅在 `ASCII` 走 `isTextInput` 的分支里，导入按钮的 disabled 条件可加一条长度判断（P2，非阻塞）。

### 5.5 不改动清单（给工程师的红线）

- ❌ `src/types/tab.ts`（PRD §6 规则 6）
- ❌ `src/types/app.ts` 的 `ImportResult` / `TabImporter`（§4.2/§4.3）
- ❌ `src/io/exporters.ts` 任何一行
- ❌ `src/ui/` 下任何文件（PRD NG7）—— 唯二例外：`importHelpers.ts` 的可选长度提示
- ❌ `parseAscii` 不得引入 `import` 自 `@/ui/`、`document`、`window`、`Blob`、`File` 的任何引用（保 node 环境可测）

---

## 6. 复用与依赖

**零新增运行时依赖。** 全部逻辑用现有工具函数：

| 需要的能力 | 现成函数 | 位置 |
| --- | --- | --- |
| 小节 tick 容量 | `measureTicks(ts)` | `core/tick.ts:21` |
| 数值 clamp | `clamp(n, lo, hi)` | `core/constants.ts:153` |
| 新 id | `newId('n')` | `core/id.ts`（经 `importers.ts:12` 已导入） |
| BPM 边界 | `MIN_BPM` / `MAX_BPM` | `core/constants.ts:17-18` |
| 品位上限 | `MAX_FRET` | `core/constants.ts:25` |
| Tab 构造与校验 | `createEmptyTab` / `validateTab` | `core/tabFactory.ts:77,200` |
| 弦号遍历 | `STRING_NUMBERS` | `core/fretboard.ts:28` |
| 标准调弦 | `STANDARD_TUNING` | `core/fretboard.ts:26` |

**注意一个陷阱**：`archGuard.test.ts:50-57` 禁止 `6 - x` 形式的表达式出现在 `core/fretboard.ts` 之外。ASCII 解析**不需要**任何弦号↔索引换算（`note.string` 直接来自行标签），**工程师不要写 `6 - i` 之类的循环**，也不要用 `diagramIndexOf`。直接遍历 `[1,2,3,4,5,6] as const` 即可。

---

## 7. 测试策略

### 7.1 文件组织

| 文件 | 环境 | 内容 |
| --- | --- | --- |
| `src/io/__tests__/asciiImport.test.ts`（**新增**） | **node**（默认，不写 `@vitest-environment`） | §7.2 PRD 样例 A~H + §7.3 关键断言 + §7.4 纯函数单测 |
| `src/io/__tests__/asciiImport.regression.test.ts`（**新增**，可选拆分） | node | `tabToAscii → parseAscii` 的往返矩阵（4/4 & 3/4）、`validateTab` 接线、体积守卫 |
| `src/io/__tests__/io.test.ts` | jsdom | **零修改**（PRD §6 规则 1） |
| `src/io/__tests__/qa-import-roundtrip.test.ts` | jsdom | **零修改**（PRD §6 规则 2） |

**为什么不新建就放 `io.test.ts`**：该文件是**既有契约锁**，任何改动都会让「零修改」的验收变得含糊。新建文件与之互补，且能在 node 环境跑（无需 jsdom），更快。

### 7.2 PRD 样例覆盖表（A~H）

| 样例 | 测试断言（**已按 §0 修正数值**） | PRD 原文冲突 |
| --- | --- | --- |
| **A** 小节线驱动切分 | `measures.length === 2`；第 0 小节 12 个音符（6 弦 × 2）；`startTick` 集合 = **`{240, 720}`**；第 1 小节 A/E 无音符、e/B/G/D 各 2 个、`startTick` 集合 = **`{240, 720}`**；所有 `startTick < 1920` | ⚠️ PRD 写 `{240,1200}` 与 `{0,960}`，与其自述算法矛盾（§0）。**team-lead 已裁决采纳 `{240,720}`**（含独立复算：`--0---0-` 仅 8 列，而 `{240,1200}` 要求第二个音符在相对列 10，**该列不存在**；且两小节文本形状相同却给出不同相对列，自相矛盾） |
| **B** 列数溢出（单小节 18 列） | `measures.length === 1`（**信 `\|`**）；`partial === true`（**由 D6b-S1「段宽 18 > 16」触发，非 startTick 越界**）；`failedAt === 0`；音符数 = 24；**每个音符 `startTick + durationTick ≤ 1920`**；e 弦 `startTick === [240,720,1200,1680]`、`durationTick === [480,480,480,240]` | ⚠️ 见 D6b：18 列**不会**产生 `startTick >= per`（最大列 14 → 1680 < 1920），`partial` 必须由段宽判定。PRD 未指明这一点 |
| **C** 5 行部分弦块 | `ok === true`；`measures.length >= 1`；出现弦号集合 `=== {1,2,3,4,5}`；`title === 'Wish You Were Here'`；`artist === 'Pink Floyd'`；`reason` 不含 `'未识别到六线谱文本'` | 无冲突 |
| **D** 元数据 | `title === 'Wonderwall'`；`artist === 'Oasis'`；`bpm === 87`；`tuning` 键被解析但**不写入 Tab**（§裁决 3）；`partial` 不因 `Album:` 置真 | 无冲突 |
| **E** 段落标记 | `measures.length === 2`；`measures[0].sectionLabel === 'Intro'`；`measures[1].sectionLabel === 'Verse'` | 无冲突 |
| **F** 末音符时值 | **使用 §3.6 的加强版**（`< 行剩余列 × 120` 且 `≥ 60` 且 `≤ per - startTick`）。PRD 原样单小节版本断言恒真、无区分度（§0），故额外加一条「断言该值**严格小于**行尾距离」 | ⚠️ 断言形态修正。**team-lead 已批准**，并要求确保「修复前必红」（§3.6 已给出 720→600 的收窄证明） |
| **G** 非谱面文本 | `ok === false`；`reason === '未识别到六线谱文本'`（文案逐字） | 无冲突 |
| **H** 往返一致 | 沿用 `io.test.ts:70-78`（16 小节 + signature 相等），**外加 D8b 的 A1~A5 五条验收** | 无冲突 |

### 7.3 必须新增的关键断言（PRD 未明确但不可缺）

1. **★ 3/4 拍往返一致（缺陷 6，P0，PRD 未进样例表但 team-lead 硬性要求）**

```ts
// 构造一个 3/4 拍的 Tab（不可用 buildTabFromChordChart，其 timeSignature 来自 spec，需确认支持 3/4）
const tab34 = createEmptyTab({ title: '三拍', timeSignature: [3, 4], bpm: 90 });
// 填充 4 个小节，每小节 3 个音符（第 1/5/9 列 → 120/600/1080 ticks）
// … 或用 src/data 里已有的 3/4 内置曲

const ascii = tabToAscii(tab34);          // 表头写 '· 3/4'，每小节 12 列
const parsed = parseAscii(ascii);         // 无 ts 实参！必须靠表头自取
expect(parsed.timeSignature).toEqual([3, 4]);
expect(parsed.measures).toHaveLength(4);  // ★ 现状：3
expect(parsed.measures.map(m => m.notes.length)).toEqual([3, 3, 3, 3]); // ★ 现状：[3,1,2]

const result = await asciiImporter.parse(ascii);
expect(result.tab!.timeSignature).toEqual([3, 4]);
expect(result.tab!.tracks[0].measures).toHaveLength(4);
```

   这是一条**往返自愈**断言：它同时锁住 D7（表头拍号优先）、D2（列坐标系）、`asciiToTab` 的 `timeSignature` 接线。**没有它，缺陷 6 会静默回归。**

2. **`'v'` 不进入 `techniques`（缺陷 7）**

```ts
const parsed = parseAscii(['e|-5v7-', 'B|-----', 'G|-----', 'D|-----', 'A|-----', 'E|-----'].join('\n'));
const all = parsed.measures.flatMap(m => m.notes.flatMap(n => n.techniques));
expect(all).not.toContain('v' as never);      // 类型层面也不该能传
expect(parsed.partial).toBe(true);            // 'v' 按未识别字符处理
// 音符不丢：5 与 7 两个音都在
expect(parsed.measures[0].notes.length).toBe(2);
```

   再加一条**编译期**断言（防回归的根）：
```ts
// 若有人把 'v' 加回类型，此断言会因类型收窄失败而暴露
const t: Technique[] = ['h', 'p', 's', 'x', '^'];   // 逐字列出，不引用常量
```
   并用 **`asciiToTab` 的成功路径必须通过 `validateTab`** 做端到端兜底：
```ts
const r = await asciiImporter.parse(raggedWithV);
expect(r.ok).toBe(true);
expect(validateTab(r.tab).ok).toBe(true);   // ★ 出厂前必然合法
```

3. **两位品位 vs 相邻单数品位（D10）**

```ts
// 一位 + 一位（中间有空隙）→ 两个音符
const a = parseAscii(['e|-1-2-', 'B|----', 'G|----', 'D|----', 'A|----', 'E|----'].join('\n'));
expect(a.measures[0].notes.map(n => [n.fret, n.startTick])).toEqual([[1, 120], [2, 360]]);

// 紧邻两位 → 一个音符（12 品），与 tabToAscii 写回互逆
const b = parseAscii(['e|-12-', 'B|---', 'G|---', 'D|---', 'A|---', 'E|---'].join('\n'));
expect(b.measures[0].notes.map(n => n.fret)).toEqual([12]);
```

4. **块内缺弦不置 `partial`，行不齐也不置 `partial`（R4 与 R9 的边界）**

```ts
// 5 行块 → partial=false
expect(parseAscii(fiveLines).partial).toBe(false);
// 行宽差异大但都有音符字符 → partial=false（qa-import-roundtrip 的语义）
```

5. **`failedAt` 多成因取最小（§8 Q3）**

```ts
// 小节 0 有 'v'，小节 1 有容量溢出 → failedAt === 0
```

6. **体积守卫（缺陷 9）**

```ts
const tooLong = '-'.repeat(MAX_IMPORT_ASCII_CHARS + 1);
const r = await asciiImporter.parse(tooLong);
expect(r.ok).toBe(false);
expect(r.reason).toContain('字符');
// 边界：恰好等于上限 → 放行（用 '>' 而非 '>='，与 isFileTooLarge 语义一致）
```

7. **大块 / 性能退化哨兵**

```ts
// 200 小节导出 → 再导入，小节数与 signature 相等，且 parseAscii 在 500ms 内完成
```

### 7.4 纯函数单测（为变异测试铺路）

新增的导出纯函数逐个单测，**每函数至少 3 个用例**（正常 / 边界 / 畸形）：

| 函数 | 用例示例 |
| --- | --- |
| `collectBars(content)` | `'--0--\|--0--'` → `[5]`；`'\|a\|b\|'` → `[0,2,4]`；`''` → `[]` |
| `splitMeasures`（`\|` 模式） | 单 `\|`；连续 `\|\|`；行首/行尾 `\|`；两行段数不同；某行无 `\|` |
| `parseTimeSignatureFromHeader` | `'… · 3/4'` → `[3,4]`；`'… · 4/4'` → `[4,4]`；`'BPM 87/4'` → `null`（词边界）；`'6/8'` → `null`；无 → `null` |
| `parseTuningValue` | `'E A D G B E'` → 标准；`'Drop D'` → `['D','A','D','G','B','E']`（若实现支持）；`'xxx'` → `undefined` |
| `extractAsciiHeader` | 全 KV；含非白名单 KV；KV 出现在块之后（应忽略）；标题回退链三级 |
| `classifyLine` | 6 类标签各一例；`'A: hello'` → **不是** `string`（RISK-1）；`'E|--------'`（全 `-`）→ **不是** `string` |
| `nextEventColInLine` | 对齐行 `h+c≡base`；未对齐行取 `base`；末音符 + 行尾 |

### 7.5 变异测试（验证断言有效性，PRD DoD 之外的加固）

「测试全绿」不等于「测试能抓 bug」。对本任务做**定点变异**，每一条都必须让**至少一条**断言变红：

| # | 变异 | 必须变红的断言 |
| --- | --- | --- |
| M1 | `content.replace(/[|\s]/g,'')` 恢复（重演缺陷 1） | 样例 A `measures.length === 2` |
| M2 | 把「表头拍号优先」改回「参数优先」（重演缺陷 6） | §7.3-1 的 3/4 往返 |
| M3 | `TECHNIQUE_CHARS` 加回 `'v'` 并保留 `as Technique` | §7.3-2 的 `validateTab(r.tab).ok` |
| M4 | `nextCol = width` 恢复（重演缺陷 4） | 样例 F 加强版（`< 行剩余列 × 120`） |
| M5 | 块循环恢复为 `i + 6 <= lines.length` | 样例 C |
| M6 | 标题回到「第一段非空行」 | 样例 D 的 `title === 'Wonderwall'` |
| M7 | `sectionLabel` 恒 `''` | 样例 E |
| M8 | 去掉 `validateTab` 调用 | §7.3-2 M3 配套（M3 单独不足以暴露，需 M3+M8 组合） |
| M9 | 体积守卫改成 `>=` | §7.3-6 的边界用例 |
| M10 | `b + 1` 改回 `b`（`prev` 推进错误） | `collectBars` 的连续 `\|\|` 用例 + 行首 `\|` 用例 |
| **M11** | **去掉 D6b 的 S1（段宽溢出判定），只保留 S2** | **样例 B 的 `partial === true`**（因 18 列不触发 `startTick >= per`，M11 必红 —— 这正是我复算发现的盲点，见 D6b） |
| **M12** | **去掉 D6b 的 ②（终点裁剪）** | **样例 B 的 `startTick + durationTick ≤ 1920`**（第 4 个音符会回到 2160） |
| **M13** | **`groupBlocks` 的 `blank` 分支改为「不断块」** | **D8b-A2**（`blocks.length === 4`）与 **D8b-A5**（删空行后 `!== 16`）；注意 **D8b-A1 本身也会红**，但 A2/A5 定位更准 |
| **M14** | **`groupBlocks` 去掉「弦号互异」校验** | **D8b-A4**（每块 label 集合 === `{1,2,3,4,5,6}`） |

**M8 的启示**：`validateTab` 接线是**纵深防御**，单靠 M3 不会红（因为 `'v'` 已被 D9 从字符表移除）。这正是 PRD 缺陷 8 值得修的理由——它守的是**未来**的越界，不是当下的。测试里要显式断言 `validateTab(r.tab).ok === true`，才能让 M3+M8 组合暴露。

**M11/M12 的启示（本文件最重要的自我修正）**：我在 D6b 里复算发现，样例 B 的 `partial` **不可能**由 `startTick` 越界推出（18 列最大列 14 → 1680 < 1920）。若工程师按「直觉的单一判定」实现，**样例 B 会 `partial === false` 而断言红，但工程师会以为是断言写错了**。M11 专门把这个盲点固化成一条必红变异。**M12 同理**：只裁起点不裁终点，`startTick + durationTick ≤ per` 立刻暴露。

---

## 8. 与既有契约的逐条对齐（PRD §6 自检表）

| PRD §6 条款 | 本设计如何满足 | 风险 |
| --- | --- | --- |
| 1 · `io.test.ts` 5 条断言零修改 | ①`io.test.ts:70` 16 小节：§10 [START] 证明逐列等价 ②`:80` 导出格式未改 ③`:86` `@`→`-`+partial+标题回退链保留（`测试曲` 在块前首行）④`:107` 行首 `\|` 剥离 → 1 小节 ✔ ⑤`:115` 文案逐字保留 | **中**（见 §10） |
| 2 · `tabToAscii` 往返一致 | 导出零改动；导入对齐语义等价；**新增 3/4 断言覆盖此前无人守的路径** | 低 |
| 3 · 三个常量语义不变 | 原样保留，未改签名 | 无 |
| 4 · `parseAscii` 签名 + `ParsedAscii` 只增不改 | §4.1/§4.4；无字段删除/改型/改名 | 无 |
| 5 · `asciiImporter` 与 `ImportResult` 契约不变 | §4.2/§4.3 零改动 | 无 |
| 6 · 复用 `Measure.sectionLabel` | 写入既有字段，`types/tab.ts` 未改 | 无 |
| 7 · 新规则只能叠加，冲突以既有断言为准 | §3.1 D2 的列坐标系**专为满足 `:107` 而设计**；§7.2 样例 A 数值按算法修正 | 已识别 |

---

## 9. 任务分解（≤5，按依赖排序）

| ID | 任务 | 文件 | 依赖 | 优先级 |
| --- | --- | --- | --- | --- |
| **T01** | **基础设施 + 纯函数骨架**：新增 `MAX_IMPORT_ASCII_CHARS`、`COPY.importAsciiTooLarge`、`COPY.asciiTuningUnparsed`；把 §5.1 列出的纯函数以**签名 + 空实现**落地（`throw new Error('TODO')` 或桩返回），保证 `tsc` 通过、既有测试仍绿 | `core/constants.ts`、`io/importers.ts`（骨架） | — | P0 |
| **T02** | **头部分类 + 元数据 + 拍号**：`normalizeAsciiLines` / `classifyLine` / `extractAsciiHeader` / `parseTimeSignatureFromHeader` / `parseTuningValue`。含 `ParsedAscii` 字段扩展与 `asciiToTab` 的 `artist/bpm/timeSignature/tuning` 接线 | `io/importers.ts` | T01 | P0 |
| **T03** | **块分组 + 小节线切分（核心）**：`groupBlocks`（**按 D8b 逐条实现，含 `blank` 强制断块、弦号互异、族锁定、1~6 行、缺弦、RISK-1 边界 —— 验收 A1~A5 全部通过后才算完成**）与 `splitMeasures`（D2 列坐标系、D3 分段、D4 众数+并集、D5 无 `\|` 行、D6 列数兜底）。**此任务完成后 16 小节往返与样例 A/C 应可断言** | `io/importers.ts` | T02 | P0 |
| **T04** | **音符读取 + 时值收束 + 容量裁剪 + 段落传播 + 组装**：字符级扫描（D10 `colSpan`）、D11 三步收束与 `base` 闭包、**D6b 的两步溢出判定（S1 段宽 + S2 起点）与三条 clamp 裁剪（样例 B 由这里通过）**、`sectionLabel` 传播、`partial/failedAt/warnings` 归并、**`validateTab` 接线（§4.6 三个接线点：`artist ?? ` / `bpm` clamp / `timeSignature` 只两种）**、体积守卫 | `io/importers.ts` | T03 | P0 |
| **T05** | **测试与变异验证**：新增 `asciiImport.test.ts`（样例 A~H + §7.3 七条关键断言 + §4.6 的边界防护测试）与往返回归文件（含 **★3/4 往返**）；执行 §7.5 的 **M1~M14** 定点变异，逐条确认变红后回滚；跑 `npm test` 全绿 + `tsc --noEmit` | `io/__tests__/*`（新增文件） | T04 | P0 |

**任务粒度说明**：全部改动集中在**一个文件**（`importers.ts`），因此按**功能阶段**切分而非按文件切分，每阶段都有可独立验证的产物（T02 可验元数据、T03 可验小节结构、T04 可验音符时间）。T05 与 T04 有重叠但独立成任务，是为了强制「测试与实现分离」，避免实现者自证。

**为什么不拆更多任务**：PRD 非目标 NG1~NG7 已排除 UI/导出/依赖变更，全部工作量落在一个文件的 6 个阶段上；按文件拆会得到 5 个「改同一个文件」的任务，冲突管理成本高于收益。**5 个任务是上限，本设计用满。**

---

## 10. ★ 关键回归风险论证：`io.test.ts:70` 的 16 小节为什么不会破

**这是本设计最大的风险点**，必须给工程师可自检的论证，而不是「应该没问题」。

**约束**：`tabToAscii(SONG_MORNING)`（16 小节，4/4，每行 4 小节）→ `parseAscii` 必须得到 **16** 个小节，且 `signature`（`index:string:fret` 集合）相等。

**导出的真实形态**（`exporters.ts:28-45`）：

```
<标题>
<艺术家 · 调 C · BPM 87 · 4/4>
（空行）
e|CELL0|CELL1|CELL2|CELL3|     ← CELLi 各 16 字符
B|CELL0|CELL1|CELL2|CELL3|
G|...
D|...
A|...
E|...
（空行）
e|CELL4|CELL5|CELL6|CELL7|
...                            ← 共 4 个块 × 6 行
```

**新语义下的逐步推导**：

1. **块划分**：空行是 `blank` → 强制断块 → 恰好 **4 个块**，每块 6 行 ✔（不会被合并成 1 个 24 行块）
   ——这依赖 `groupBlocks` 的「遇 `blank` 即断块」（D8 ⑤），**必须实现**。
2. **列坐标系**：`e|` 后是 `CELL0` 的第一个字符（第 0 位是 `-` 或数字），因为⑥的「跳过连续 `|` 与空白」在此处只跳 0 个字符（字符本身就是非 `|` 非空白）。SOUND: `CELL0` 的第 k 位 → 列 k ✔（**与原实现 `replace(/[|\s]/g,'')` 后取第 k 位完全一致**）
3. **段划分**：每行 4 段（`bars` 在列 16/33/50），且**行尾 `|` 被裁掉**（内容区长 64）。段 = `[0,16) [17,33) [34,50) [51,64)` —— **注意每段起点多了 1**（因为 `|` 占 1 列，`prev = b+1`）。
4. **众数**：6 行都是 4 段 → `measureCount = 4` ✔；不置 `partialByMismatch` ✔
5. **并集边界**：6 行段数相同、`|` 列相同 → `startCol_m = min = 17m`，`endCol_m = max = 16(m+1)+m`。第 m 段 = `[17m, 17m+16)` = **16 列宽**，正好容纳 `CELLm` 的 16 个字符 ✔
6. **音符列 → tick**：`startTick = (col - startCol_m) × 120 = (17m + j - 17m) × 120 = j × 120`
   —— 其中 `j` 是该音符在 `CELLm` 内的**字符下标**。
7. **导出侧的真相**：`exporters.ts:36` 写 `col = round(note.startTick / 120)` 并**写进 `grid[col]`**，即 `CELLm` 的第 `j` 位 = 该弦在该小节内 `startTick = j×120` 的音符（若有）。其余位是 `-` 或数字的第二位。
8. **⇒ 第 6 步的 `j` 就是导出时写入的 `col`，而 `col` 由 `startTick/120` 取整而来。导入得到 `startTick = col × 120`。**

**唯一可能的偏差在 `round` 与「两位品位的第二位」**：

- `startTick` 来自 SONG_MORNING 的节奏展开（`expandPattern`），值均为 tick 网格整数（多为 480 的倍数），`startTick/120` 是整数，`round` 无损 ✔
- 两位品位：`exporters.ts:38` 逐位写入 `grid[col]`、`grid[col+1]`；导入读 `'12'` → `fret=12`，起始列 = `col` ✔ **`fret` 与 `startTick` 都对** → `signature` 相同 ✔
- **一列只有一个音符位**：导出的 `grid` 是**逐弦**的，同一弦同一列不可能有两个音符（后写的覆盖前者）。SONG_MORNING 的节奏型（`strum_quarter` 等）每弦每事件不同 tick，**同位冲突不会发生**。

**最后一道保险**：`io.test.ts:80-84` 断言导出文本 `lines.length % 6 === 0` —— 这只是**导出**格式的自检，与解析无关，但它保证了我的「4 块 × 6 行」前提 ✔

**结论**：在新的列坐标系下，对 `tabToAscii` 生成的输入，导入语义与原实现**逐列等价**（`CELLm` 第 j 位 → 列 `16m+j` → `startTick = j×120`），且小节数从「按 64/16=4 列切」变为「按 `|` 切 = 4 段」，**两者都是 4** → 每块 4 小节 × 4 块 = **16** ✔

**工程师的自检清单**（T03 完成时逐条跑）：
- [ ] `parseAscii(tabToAscii(sourceTab)).measures.length === 16`
- [ ] `signature` 集合相等（用 `io.test.ts:12-16` 的同一实现）
- [ ] 4 个块、每块 6 行、每块 4 小节
- [ ] `io.test.ts` 与 `qa-import-roundtrip.test.ts` **零修改**全绿

---

## 11. 诚实记录的开放问题与残余风险

| # | 问题 | 我的判断 / 处置 | 残余风险 |
| --- | --- | --- | --- |
| **OP-1** | **PRD 样例 A / F 的期望值与其自述算法矛盾**（§0） | 按算法执行，把期望值修正为 `{240,720}`，并在测试注释里写明推导 | **中**。若 PM/team-lead 坚持 PRD 字面值，则必须改列坐标系（让 `\|` 占 2 列宽）——但那样会破坏 `io.test.ts:107`（行首 `\|` 会占 2 列，且 16 小节往返的 `CELL` 起点会整体右移 1 列 → **`io.test.ts:70` 变红**）。**修 PRD 数值是唯一不破契约的解**。已回报 team-lead |
| **OP-2** | 样例 A 第 1 小节声称 `{0,960}`（列 0/8），但文本是 `--2---2-`（`2` 在 index 2/6） | 同上，同源算错。正确值 `{240,720}` | 同上 |
| **OP-3** | 样例 F 单小节版本无区分度（行宽 = 小节宽 → 「`< 行宽`」恒真） | 已在 §3.6 给出跨小节加强版并写成断言 | 低。但需 team-lead 确认「加强版断言」可作为样例 F 的验收替代 |
| **OP-4** | **`Tuning` 解析支持到什么程度**？PRD 只举例 `E A D G B E` / `Drop D` / `D A D G B E` | 裁决：**支持 6 个空格分隔的音名**（含 `#`/`b`）；`Drop D` 特判（→ `['D','A','D','G','B','E']`）；其余一律 `undefined` + warning。**不**实现任意调弦名数据库（PRD NG5 不猜） | **中**。`Tab.tuning` 的类型是 `readonly ['E','A','D','G','B','E']`（`types/tab.ts:151`）——**这是一个字面量元组类型，只能装标准调弦**！所以**非标准调弦根本无法写进 Tab**，只能 `undefined` + warning。**这意味着 `Tuning: D A D G B E` 的解析结果无法落地**。我倾向：解析出来但**不写入 Tab**（保持默认），只加 warning。**这是一个需要 team-lead 拍板的设计缺口**——若要真正支持非标准调弦，得改 `types/tab.ts`（超出 PRD §6 规则 6 授权） |
| **OP-5** | 段落标记是否**跨块**延续（PRD §8 Q2 倾向「是」） | 采纳跨块延续。实现上把「当前段落名」作为 `groupBlocks` 的**累积状态**，而不是块内局部变量。例：`[Chorus]` 后跟 3 个块 → 3 个块的所有小节都是 `'Chorus'` | 低。样例 E 只覆盖「标记紧邻块」；跨块场景无 PRD 样例，需补一条测试 |
| **OP-6** | 段落标记出现在**块中间**（如第 3、4 行弦之间）怎么办 | 裁决：视为**断块 + 设新段落**。即 `[x]` 行强制断块（同 `blank`），其后的行归入新块、新段落。理由：段落在块中间意味着「此处切了新的曲式段」，断块是最自然的解释 | 低。无 PRD 样例 |
| **OP-7** | `classifyLine` 的 `string` 判定②要求「至少一个音符字符」→ `E|--------` 不算 string 行 | `qa-import-roundtrip.test.ts:94-102` 的 `E|-----------------|` 因此不进块 → 块变 5 行，但断言只要 `measures.length > 0` ✔。**代价**：全空弦行会被忽略，若某块**所有行**都是 `---`（零音符）→ 该块不存在 → 可能整体报 `未识别到六线谱文本`。这与 R4「永不零导入」**表面冲突**，但 R4 的原话是「任何包含**至少 1 行可识别弦号**的文本」——纯 `---` 行按 RISK-1 定义**不是**可识别弦号行。**裁决：保持严格**，因为放宽会开放 RISK-1 误判 | **中**。若用户粘一段「全空小节」的谱，会得到「未识别」。这类输入无练习价值，可接受。**已列为开放问题回报** |
| **OP-8** | `'v'` 裁决为「笔误」是否可能误伤真实用户数据？ | `'v'` 会落入未识别字符 → 按 `-` 处理 + `partial` + `reason` 提示。**音符不丢**（前后音符都保留），只是用户会看到「部分字符未识别」的确认弹窗。这是**显式暴露**而非静默错误 | 低。可接受 |
| **OP-9** | `asciiToTab` 接 `validateTab` 后，是否可能出现「解析成功但校验失败」→ 用户从「拿到部分结果」变成「完全失败」？ | `validateTab` 对 ASCII 场景实际会触发的只有：`title` 长度（`:212`，解析时已 `slice(0,120)`）、`bpm` 越界（§4.1 已 clamp）、`measures.length === 0`（`:237`，与 `asciiToTab:225` 既有前置判断一致）。**其余字段由 `createEmptyTab` 保证合法**。因此新增失败路径**不可达** | 低。但**必须**在 T05 里加一条「畸形输入集 → `validateTab` 从不意外失败」的防护性测试 |
| **OP-10** | `MAX_IMPORT_ASCII_CHARS = 1,000,000` 是否与 `MAX_IMPORT_XML_MB = 8`（≈4M 字符）口径一致？ | 不一致，且**故意**：ASCII 是**粘贴**（用户等在那，卡主线程体验最差），XML 是**文件读取**（可异步）。ASCII 用更保守的阈值是合理的 | 低 |
| **OP-11** | 性能：`splitMeasures` 的并集计算是 O(行数 × 小节数)，`readBlockNotes` 是 O(行数 × 行宽)。1M 字符 × 6 行 → 最坏 O(n) 单遍。**无退化风险** | 已在 §7.4 加性能哨兵 | 低 |
| **OP-12** | 本设计未覆盖：ASCII 里的**和弦名行**（如 `Am    F    G`） | PRD NG4 明确「仅在不误判为弦块的前提下忽略，不产 `ChordEvent`」。我的 `classifyLine` 会把它们归为 `other` → 不进块 → 被忽略 ✔。**但要小心 `Am` 不匹配 `LINE_RE`**（`A` 后必须跟 `|` 或空白，`Am` 的 `m` 不是终止符 → 不匹配）✔ | 低 |

---

## 12. 一页速查（给工程师）

```
【必须遵守的 5 条硬约束】
1. io.test.ts 5 条 ASCII 断言 + qa-import-roundtrip.test.ts 3 条 —— 零修改
2. parseAscii(text, ts=[4,4]) 签名不变；ParsedAscii 只增字段
3. exporters.ts 一行不改
4. parseAscii 无 DOM 依赖（可在 node 单测）
5. io/ 不得 import ui/

【6 个阶段的实现顺序】
S1 normalizeLines → S2 extractHeader → S3 groupBlocks
→ S4 splitMeasures（★先定边界）→ S5 readBlockNotes → S6 assemble

【8 个关键决策（照做，别改）】
D1  块内任一行含 | → 整块走小节线模式
D2  弦号/终止符/| 一律零宽；列 0 = 跳过连续 |/空白后第一个字符；行尾 |/空白裁掉
D3  分段：prev=b+1；仅 b>prev 时 push（连续 || 与行首 | 都不产生空小节）
D4  measureCount = mode(各行段数) 且并列取 min；小节边界取各行段的并集
D7  拍号优先级：表头 X/Y  >  ts 参数  >  [4,4]；asciiToTab 必须写 parsed.timeSignature
D9  'v' 是笔误，从 TECHNIQUE_CHARS 删除（satisfies 绑类型），落入未识别字符分支
D11 时值：min(同弦下一音, 小节右边界, 下一任意弦事件)；末事件用 base 闭包
D6b ★溢出两步判定（缺一会漏！）：S1 段宽 > colsPerMeasure → partial；S2 音符起点
    >= per → partial；裁剪三条 clamp：起点/终点/不变量 startTick+durationTick<=per
D8b ★groupBlocks：blank 强制断块（io.test.ts:70 的必要前提）；弦号互异；族锁定

【每条新规则的验证锚点】
D2        → io.test.ts:107（行首 | → 1 小节）+ io.test.ts:70（16 小节）
D3        → collectBars 单测 + 16 小节往返
D4        → 样例 A（2 小节）
D7        → ★3/4 往返（缺陷 6，必写，修复前必红）
D9        → parseAscii + validateTab(tab).ok
D11       → 样例 F 加强版（跨小节，修复前必红：720 → 600）
D6b S1    → 样例 B 的 partial === true（★18 列不触发 S2，只能靠 S1）
D6b ②     → 样例 B 的 startTick+durationTick <= 1920（修复前 2160 必红）
D8b       → A1 16 小节 / A2 4 块 / A3 每块 6 行 / A4 弦号互异 / A5 删空行后 !== 16
RISK-1    → 'A: hello' 与 'E|--------' 都不进块
误伤面    → §4.6 的 7 条边界用例：ok=true 时 validateTab 必须恒通过
```
