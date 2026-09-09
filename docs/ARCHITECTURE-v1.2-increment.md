# 弦格 Fretly · 增量设计文档 v1.2（M1 已交付 → 三项增量）

| 项 | 内容 |
|---|---|
| 文档版本 | v1.2-increment |
| 上游 | `docs/ARCHITECTURE.md`（分层/接口/§6 音频/§9 约定/附翻车点自检）、`docs/PRD-increment-v1.1.md` |
| 作者 | 高见远（架构师） |
| 日期 | 2026-09-08 |
| 范围 | 三项增量：① 吉他音色增强 + 进度同步 bug 修复 ② 五线谱→六线谱（MusicXML 主力 + 图片 OCR 辅助） ③ 扫弦方向自动推断 |
| 前提 | M1 已交付：71 TS/TSX、16067 行、`tsc` 0 错、vitest 229 全过、build 成功。本设计为**增量、最小变更**，复用 core/audio/io 能力，不重写已有模块。 |

> **阅读前必读**：本文所有结论基于对源码的**实际阅读**（`synth.ts` / `Transport.ts` / `practiceController.ts` / `usePracticeStore.ts` / `TabCanvas.tsx` / `tabRender.ts` / `musicXmlImporter.ts` / `fretboard.ts` / `rhythm.ts` / `tick.ts`），非凭文档臆测。关键行号已核对。

---

## 0. 优先级总览（实现顺序）

| 顺序 | 改动 | 优先级 | 一句话结论 |
|:--:|---|---|---|
| Batch 1 | **进度同步 bug 修复** | **P0 最高** | 播放头（rAF 直读 `currentTick`）与小节高亮（store 的 `currentMeasure`）**两个来源脱钩** + seek/loadTab 不回写，导致色块滞后/滞留。修复 = 高亮统一从 `currentTick` 派生 + controller 在 seek/play/loadTab 时回写 store。 |
| Batch 2 | **音色增强（增强 KS）** | P0 | 在 `karplus()` 内加：琴体共振（2 个低阶 IIR）、力度→衰减包络、音头噪声。零采样、零 AudioWorklet、零 playbackRate，缓存键不变。 |
| Batch 3 | **五线谱→六线谱（MusicXML）** | P0 | 扩展现有 `musicXmlImporter`：无吉他轨时回退到「有音高的五线谱轨」，新增纯函数 `staffFingering.ts` 做指法分配 + 置信度标记，直接进现有编辑器。 |
| Batch 4 | **扫弦方向推断** | P1（配套 3） | 新增纯函数 `strokeInference.ts`：同 tick 和弦按音高走向标 `D/U`，单音 `null`，分解 `P`。**注意方向约定与 rhythm.ts 需对齐（见 §1.3 ⚠️）。** |
| Batch 5 | **图片/PDF OCR（实验性）** | P1 | 仅「选型调研 + `OmrProvider` 接口预留 + 结果走 staff→tab 管线 + `null` 桩实现」，UI 标注实验性/准确率有限。 |
| Batch 6 | **联调** | P0 | 全量测试 + 守卫测试 + 手工听测/变速不变调验证 + 视觉走查。 |

---

## 1. 三改动的实现方案

### 1.1 改动一：进度同步 bug 修复（P0 最高）

#### 1.1.1 现状与根因（已读源码定位，非猜测）

**两套进度来源（脱钩）：**

| 表现 | 数据来源 | 刷新机制 | 是否连续正确 |
|---|---|---|---|
| 播放头（蓝色竖线） | `TabCanvas` overlay 层 `useRaf` 每帧调 `playheadTick()` → `practiceController.currentTick` → `Transport.currentTick` = `anchorTimeToTick(anchor, ctx.currentTime)` | rAF（60fps，直读 AudioContext 采样时钟） | ✅ 始终正确，跟随 anchor/tempo |
| 小节高亮（浅蓝底**色块**） | React state `usePracticeStore.currentMeasure`，经 `TabCanvas` 的 `highlightMeasure` prop 画在**静态层** | 仅由 `practiceController.handleBoundary` 收到 `'measure'` 边界事件时更新（`setCurrentMeasure`） | ❌ 低频、离散、可滞留 |

**根因（三个子问题，均已定位到具体行）：**

1. **【确定性】seek / 回跳后不回收 `currentMeasure`（主因）**
   - `practiceController.seek()`（`practiceController.ts:230`）只调 `transport.seek()`，**不回写** `store.currentMeasure`，也**不重置** controller 的 `lastEmittedMeasure`。
   - `Transport.seek()` 内部 `resetCursors` 会把 Transport 的 `lastMeasureIndex` 重置为 `measureIndexOf(target)`。
   - 结果：向后 seek 到第 2 小节时，Transport 游标=2，但 `handleBoundary` 的守卫 `if (e.measureIndex > this.lastEmittedMeasure)`（`practiceController.ts:696`）里 `lastEmittedMeasure` 仍是旧值（如 10），于是 `currentMeasure` 永远停留在 10，**播放头在第 2 小节、色块却高亮第 10 小节**。
   - 同理会发生在「整曲播完自动 `stop()` 后再次从头播放」：`stop()` 让 anchor 回 0，但 controller 侧 `lastEmittedMeasure` 不归位，0..N 小节的 `'measure'` 边界事件全部被守卫拦掉。

2. **【确定性】`loadTab` 不重置 `currentMeasure`**
   - `practiceController.loadTab()`（`practiceController.ts:158`）调 `usePracticeStore.setTab(tab)`；`setTab`（`usePracticeStore.ts:117`）只 set `tab/tabId/markers/currentBpm`，**不清 `currentMeasure`**。
   - 换曲后首屏会残留上一首的小节号，直到第一个 `'measure'` 边界到来才纠正。

3. **【轻微】离散更新带来的「慢半拍」**
   - `'measure'` 边界事件由 `Transport.pump()`（`setInterval(25ms)`）里 `checkBoundaries` 触发，再经 React setState + 静态层重绘，最坏比 rAF 播放头晚 ~25ms+1 帧。跨小节瞬间能看到色块「追着」播放头，观感像不匹配。

> **对 team-lead 三条猜想的裁定**：
> - 猜想「播放头走 rAF、音频走 25ms，时钟源/相位不一致」——**部分成立**：播放头本身是准的（rAF 直读 `ctx.currentTime`，不经调度器）；真正的错位是**高亮用了 25ms 边界事件推送的 store 值**，而非播放头。
> - 猜想「`highlightMeasure` 用 `currentMeasure`，与 `currentTick` 不同步」——**完全成立，即根因**。
> - 猜想「变速后 BPM 与 anchor.bpm 不同源」——**不成立**：工具栏 `currentBpm` 由 `setTempoInternal` / `tempoApplied` 边界事件与 Transport 同源，未发现脱钩。

**根因置信度**：子问题 1/2 ≈ **95%**（代码路径清晰、可复现）；子问题 3 ≈ 80%（需手工在高 BPM 下观察确认观感）。

#### 1.1.2 结构性修复方案（单一时间源，不打补丁）

原则：**画布上的「播放头 + 小节高亮」都由 `Transport.currentTick` 在 rAF 内派生，保证二者像素级同源；store 的 `currentMeasure` 只服务非画布 UI（右栏和弦预告 / 标难点 / 和弦视图），由 controller 在锚点重置点（seek/play/loadTab/stop）主动回写。**

**改动点 A —— `Transport` 新增派生 getter（单一真相源）：**

```ts
// src/audio/Transport.ts
get currentMeasure(): number {
  return measureIndexOf(this.currentTick, this.opts.timeSignature, this.opts.ticksPerBeat);
}
```
（`measureIndexOf` 已存在于 `core/tick.ts`，纯函数，无需新逻辑。）

**改动点 B —— `TabCanvas` 高亮改到 overlay rAF 层，从 `playheadTick()` 派生：**

- `src/ui/tab/TabCanvas.tsx`：
  - overlay 的 `useRaf` 回调里，在画播放头**之前**先画「当前小节底」：`const mi = measureIndexOf(getTick(), L.tab.timeSignature)`，用已有私有 `findMeasureBox` 找到该小节 box，`fillStyle rgba(37,99,235,0.06)` 填色。
  - **practice 模式**：静态层 `drawTab` 不再接收 `highlightMeasure`（把该 prop 语义保留给 **editor 的选区高亮**，见下）。
  - 新增/复用 prop 契约：
    - `playheadTick?: () => number`（已有，practice 传入）。
    - `highlightMeasure?: number | null`（**保留**，仅 editor 传入 `selection.measureIndex`，静态层画选区底）。
  - 这样 practice 模式的小节高亮与播放头**同帧、同 tick 派生**，子问题 1/2/3 在画布层面全部消失。

**改动点 C —— `PracticePage` 去掉 practice 的 `highlightMeasure` 传参：**

- `src/ui/practice/PracticePage.tsx:199`：删除 `highlightMeasure={currentMeasure}`。`currentMeasure` 仅继续用于右栏 `upcoming`（:96–111）、标难点按钮（:167）、和弦视图（:212）等非画布展示。

**改动点 D —— `practiceController` 在锚点重置点统一回写 store：**

```ts
// src/state/practiceController.ts
/** 播放头锚点被移动后调用：让 store.currentMeasure 立即对齐 Transport，避免滞留 */
private syncMeasureState(): void {
  const tab = this.tab;
  const t = this.transport;
  if (!tab || !t) return;
  const mi = measureIndexOf(t.currentTick, tab.timeSignature);
  this.lastEmittedMeasure = mi;               // 关键：重置守卫，使后续 mi+1… 能正常触发
  usePracticeStore.getState().setCurrentMeasure(mi);
}
```

在以下位置调用：
- `seek(tick)`（:230）末尾；
- `play(...)`（:189）在 `await transport.play(...)` 之后；
- `loadTab`（:158）在 `transport.load(...)` 之后（并显式 `setCurrentMeasure(0)`，双保险）。

**改动点 E —— `usePracticeStore.setTab` 重置 `currentMeasure: 0`**（`usePracticeStore.ts:117`），杜绝换曲残留。

**为什么这是结构性修复而非补丁**：修复后，画布进度**只**来自 `currentTick`（Transport 唯一真相源），store 的 `currentMeasure` 只是它的一次性镜像，即使镜像偶尔滞后，也不影响画布正确性；`lastEmittedMeasure` 的守卫被 `syncMeasureState()` 在每次锚点重置时归位，消除「向后 seek / 重播」的滞留。

#### 1.1.3 衔接点汇总

| 文件 | 改动 | 性质 |
|---|---|---|
| `src/audio/Transport.ts` | +`currentMeasure` getter | 纯派生 |
| `src/ui/tab/TabCanvas.tsx` | overlay rAF 内派生并绘制小节高亮；practice 静态层不再画 `highlightMeasure` | 副作用（canvas） |
| `src/ui/practice/PracticePage.tsx` | 移除 `highlightMeasure={currentMeasure}` | 副作用（React） |
| `src/state/practiceController.ts` | +`syncMeasureState()`；在 seek/play/loadTab 调用 | 副作用（store） |
| `src/state/usePracticeStore.ts` | `setTab` 重置 `currentMeasure: 0` | 副作用（store） |

---

### 1.2 改动二：吉他音色更自然（增强 KS 模型，P0）

#### 1.2.1 现状与约束

`karplus()`（`synth.ts:32`）当前链路：白噪声激励 → 一阶低通（`brightness`）→ 去 DC + 峰归一 → 延迟线循环（`loopGain=2×damping`、`blend` 低通反馈）→ 指数衰减包络 + 3ms 淡入 + 20ms 淡出。

`PluckCache.get()`（:132）以 `(midi, velocityBucket)` 为键缓存 `Float32Array`。`brightness = 0.25 + velocity*0.6`（:146）。

**硬约束（必须守住）**：纯算法合成 Float32Array → AudioBuffer → 按 `(midi, 力度档)` 缓存；禁采样、禁 AudioWorklet、禁 `playbackRate`；合成参数与 tempo 无关（变速不变调）；不回归架构守卫测试。

#### 1.2.2 方案：在 `karplus()` 内部做三处增强（全部纯算法、参数与 tempo 无关）

**增强 1：琴体共振（低阶 IIR 谐振峰）**

在 KS 输出（包络之后）串联 **2 个二阶谐振器**（constant-peak-gain bandpass biquad），模拟木箱体：

| 谐振器 | 中心频率 f | Q | 增益 G | 作用 |
|---|---|:--:|:--:|---|
| A（琴体主共振） | 110 Hz | 4 | 0.35 | 低音弦「木箱体」暖感 |
| B（声板/空气共振） | 200 Hz | 6 | 0.25 | 中低频声板感 |

```ts
// 二阶谐振（direct-form II transposed），系数离线算一次
function resonatorCoeffs(freq: number, q: number, gain: number, sr: number) {
  const w = (2 * Math.PI * freq) / sr;
  const alpha = Math.sin(w) / (2 * q);
  const a0 = 1 + alpha;
  return {
    b0: (alpha * gain) / a0, b1: 0, b2: (-alpha * gain) / a0,
    a1: (-2 * Math.cos(w)) / a0, a2: (1 - alpha) / a0,
  };
}
// 逐采样：y = b0*x + z1; z1 = b1*x - a1*y + z2; z2 = b2*x - a2*y;
```

谐振器是**零 DC、线性时不变**的，只改频谱不改基频 → 不违反变速不变调、不破坏现有「无直流」测试。

**增强 2：力度 → 衰减包络 + 音头亮度**

- 现 `decayRate = 1.2 + freq/400`（:76）。改为**力度调制**：
  ```ts
  const decayRate = (1.2 + freq / 400) * (1 + 0.8 * (velocity - 0.5)); // velocity∈[0,1]
  ```
  强拨弦（velocity 1.0）衰减快 ~1.4×，弱拨弦（0.25）慢 ~0.8×，符合真实拨弦。
- `brightness` 保持 `0.25 + velocity*0.6`（力度→激励亮度已覆盖音头亮度需求），上限放宽到 0.95。

**增强 3：音头噪声（pick attack 瞬态）**

在 KS 信号起音叠加一段 ~12ms 低通白噪声瞬态，去掉「电子起音」：

```ts
const attackLen = Math.round(0.012 * sampleRate);
let lp = 0;
for (let i = 0; i < attackLen; i++) {
  const white = Math.random() * 2 - 1;
  lp += 0.35 * (white - lp);                    // 一阶低通，抑制刺耳高频
  const env = Math.exp(-i / sampleRate / 0.003); // tau=3ms 指数衰减
  out[i] += lp * 0.25 * velocity * env;
}
```

**削波保护（保证「不削波」可测）**：叠加共振+噪声后，算 `peak = max|out[i]|`；若 `peak > 0.98`，整段 `out *= 0.98 / peak`。

> 三处增强的输入只依赖 `(midi, velocity, sampleRate, freq, seconds)` —— **与 tempo 完全无关**，且仍是「每音符确定性」→ **缓存键不变**，`PluckCache` 无需改动。

**和弦共鸣（可选 P1，默认不做）**：让同时发声的弦互相激励会破坏「每音符独立合成」的缓存假设（需在调度时感知同窗和弦集合）。结论：**本增量不做**，仅在 `Synth.rake()` 预留注释位，未来若做则采用「在 demo 总线叠加低幅度（0.08~0.12）的同音/八度泛音拨弦」方案。复杂度：需在 `DemoTrack`/`rake` 层感知和弦，中等，留 M2。

#### 1.2.3 衔接点

| 文件 | 改动 | 性质 |
|---|---|---|
| `src/audio/synth.ts` | `karplus()` 内：+`resonatorCoeffs`/`applyBiquad` 纯助手、+力度衰减、+pick 噪声、+峰归一 | 纯函数（可单测） |
| `src/audio/__tests__/synth.test.ts` | 扩展用例（见 §5） | 测试 |

`KarplusOptions` 无需改签名（`velocity`/`brightness` 已传入）；`PluckCache`/`Synth`/`DemoTrack` 零改动。

---

### 1.3 改动三：五线谱 → 六线谱（MusicXML 主力）

#### 1.3.1 现状与方案定位

现状 `parseMusicXml`（`musicXmlImporter.ts:95`）：`isGuitarPart`（:71）只认 `string/fret technical`、clef `TAB`、part 名含 guitar；无吉他轨 → 直接 `ok:false` + `COPY.noGuitarTrack`。单音 `lowestFretPosition`（:223），同 tick 多音只留最低品（Q4）。

**方案：扩展现有 `musicXmlImporter`，不新增并列路径。** 分两步：
1. **选轨**：优先吉他轨（现状不变，保真最高）；否则回退到**第一个「有音高」的五线谱轨**（有 `<pitch>`、无 string/fret、clef 非 TAB、非打击乐）。只有「既无吉他轨也无音高轨」才报错。
2. **五线谱轨走新指法管线**（纯函数 `staffFingering.ts`），产出带 `confidence` 的 `Note[]`，沿用 `musicXmlToTab` 组装，直接进现有编辑器。

> 为什么不另建 `staffToTab` 独立 importer：两者 90% 逻辑（XML 解析、小节/tick 换算、和弦 `<harmony>`、组装 Tab）共享；只差「指法分配 + 多音保留 + 方向推断」。分支放在选轨与音符收集处，改动面最小。

#### 1.3.2 指法映射算法（新增纯函数 `src/core/staffFingering.ts`）

**关键决策：音高确定 → 只做「指法分配」，不做「指板 DP 扒谱」。** 复用 `fretboard.allPositions`（:133，已按「低把位优先：fret asc → string desc」排序）与 `OPEN_MIDI`。

**音域折叠（超界降级）**：吉他可弹 MIDI 区间 = `[E2=40, E6=88]`。

```ts
const LO = 40, HI = 88;
function foldIntoRange(midi: number): { midi: number; octaveShifted: boolean } {
  if (midi < LO) return { midi: midi + 12 * Math.ceil((LO - midi) / 12), octaveShifted: true };
  if (midi > HI) return { midi: midi - 12 * Math.ceil((midi - HI) / 12), octaveShifted: true };
  return { midi, octaveShifted: false };
}
```

**旋律（单音序列）指法：贪心最近位置（把位连贯性优化）**

```ts
function assignMelody(midis: number[]): ({ string, fret } | null)[] {
  let prev: { string; fret } | null = null;
  return midis.map((m) => {
    const cands = allPositions(m);            // 已低把位优先
    if (cands.length === 0) return null;
    const best = prev
      ? cands.reduce((a, b) => moveCost(a, prev) < moveCost(b, prev) ? a : b)
      : cands[0];
    prev = best;
    return best;
  });
}
function moveCost(p, prev) {
  return 0.5 * Math.abs(p.fret - prev.fret) + 0.12 * Math.abs(p.string - prev.string) + (p.fret === 0 ? -0.3 : 0);
}
```

**和弦（同 tick 多音）指法：按 MIDI 降序贪心分配不同弦**

```ts
function assignChord(midis: number[]): ({ string; fret } | null)[] {
  const used = new Set<StringNumber>();
  return [...midis]
    .sort((a, b) => b - a)                     // 最低音优先占低音弦
    .map((m) => {
      const pick = allPositions(m).find((c) => !used.has(c.string)) ?? null;
      if (pick) used.add(pick.string);
      return pick;
    });
}
```
`allPositions` 的「低把位优先 + string desc」排序天然让「低音→低弦、高音→高弦」，指位落进低把位。

**把位连贯性（相邻音符）**：旋律用 `assignMelody` 的贪心最近位置即实现「相邻音符把位连贯」；和弦内部用 `assignChord` 的品差约束（`allPositions` 低把位优先已隐式控制）。**不做**完整 Viterbi（音高已知、收益低），符合「70 分初稿 + 校对」产品哲学。

**confidence 标记（低置信 → 进待确认清单）**

```ts
confidence = clamp(1 - cost, 0.3, 1)
// cost 累加：fret>=12 → +0.15；fret>15 → +0.25；octaveShifted → +0.5；和弦品差>4 → +0.15
```
- 正常低把位 → 0.85~1.0（无标记）
- 高把位 fret≥12 → ~0.6（浅灰虚线框，`CONF_MID` 区间）
- 超音域折叠 / 品差超限 → ≤0.45（琥珀框，进 pending）

#### 1.3.3 ⚠️ 与 team-lead 描述的方向约定冲突（必须确认）

team-lead 需求描述「低→高 = 上扫 U，高→低 = 下扫 D」与**已交付的 `rhythm.ts`（:62–75）及物理惯例相反**：

- `rhythm.ts` 的 `D`（下扫）= `[loString → hiString]` = 弦 6→1 = **低音→高音**；
- `rhythm.ts` 的 `U`（上扫）= `sortedAsc(sounded ∩ {1,2,3})` = 弦 1→3 = **高音→低音**。

即：**下扫 D = 低→高，上扫 U = 高→低**（这也是吉他物理事实：下扫先打低音弦）。

因此本文 §1.4 的推断**默认按代码一致**：低→高 = `D`，高→低 = `U`；并提供单一可翻常量，若产品坚持反向，须**同步翻转 rhythm.ts 并全量回归**（不建议，会破坏已上线模板）。

#### 1.3.4 衔接点

| 文件 | 改动 | 性质 |
|---|---|---|
| `src/core/staffFingering.ts` | **新增**：`StaffNote` 中间类型 + `foldIntoRange`/`assignMelody`/`assignChord`/`assignFingering`（→ `Note[]`，含 confidence，stroke 由 `inferStroke` 注入） | 纯函数 |
| `src/io/musicXmlImporter.ts` | **改**：`selectImportPart`（吉他优先→音高轨回退）；staff 轨收集（保留同 tick 多音、读 `<pitch>`）；调 `assignFingering`；`musicXmlToTab` 组装不变 | 纯函数（`parseMusicXml` 壳有 DOMParser 副作用） |
| `src/io/__tests__/io.test.ts` | **改**：新增五线谱 fixture 用例 | 测试 |

`source.importer` 沿用 `'musicxml'`（不新增枚举，避免类型与筛选器改动）；staff 导入时 `source.confidence = avgConfidence`（可选，供曲库展示）。

---

### 1.4 改动四：扫弦方向自动推断（配套 1.3）

#### 1.4.1 方案（新增纯函数 `src/core/strokeInference.ts`）

```ts
import type { Stroke } from '@/types/tab';

/** 同 tick 音符组分类 */
export function classifyGroup(midis: number[]): 'melody' | 'arpeggio' | 'chord' {
  if (midis.length === 1) return 'melody';
  return 'chord'; // 同 tick 多音即和弦（arpeggio 由不同 tick 判定，在调用侧）
}

/**
 * 和弦方向：低→高 = 'D'（下扫），高→低 = 'U'（上扫）。
 * 与 rhythm.ts 的 D=[6→1]、U=[1→3] 严格一致（见 §1.3.3 ⚠️）。
 */
export function inferChordStroke(midisAscending: number[]): 'D' | 'U' {
  // 输入已是升序（低→高）；和弦方向由「音高走向」给出，恒定映射：
  return DEFAULT_CHORD_STROKE; // 'D'：块状和弦默认下扫（自然/常用）
}

export const DEFAULT_CHORD_STROKE: 'D' | 'U' = 'D';
```

**判定规则与边界（写入 `assignFingering` 的调用侧）：**

| 情形 | 判定 | `stroke` |
|---|---|---|
| 单音（同 tick 仅 1 音） | 旋律 | `null` |
| 同 tick ≥2 音（和弦） | 音高走向 → 方向 | `D`（低→高）或 `U`（高→低）；块状默认 `D` |
| 不同 tick 的相邻音 | 分解和弦/琶音 | `P`（逐个拨弦） |
| 源含显式 `<arpeggiate direction="up/down">` | 上/下琶音 | `up→D`（低→高）、`down→U`（高→低） |

> **为什么块状和弦默认 `D` 而非「根据音高走向必然 U/D」**：块状和弦是「同时发声」，本身无时间顺序，「音高走向」只能给出「低到高的跨度方向」，不等于拨弦方向。故：有显式 roll/琶音记号时才反推 `U`；无记号时默认 `D`（与 rhythm 模板的下扫主路径一致）。`DEFAULT_CHORD_STROKE` 单点可翻。

#### 1.4.2 衔接点

| 文件 | 改动 | 性质 |
|---|---|---|
| `src/core/strokeInference.ts` | **新增** | 纯函数 |
| `src/core/staffFingering.ts` | `assignFingering` 调 `classifyGroup`/`inferChordStroke` 注入 `stroke` | 纯函数 |
| `src/core/__tests__/core.test.ts` | 新增方向推断用例 | 测试 |

---

### 1.5 改动五：图片/PDF 五线谱 OCR（实验性 P1）

#### 1.5.1 OMR 库选型调研结论

| 候选 | 形态 | 浏览器可用 | 结论 |
|---|---|:--:|---|
| Audiveris | 桌面 Java | ❌ | 无 wasm 端口 |
| OSMD / Verovio / VexFlow | 渲染（XML→SVG） | — | 无 OCR |
| Tesseract.js | 通用文字 OCR | ✅ | **不识别**五线/符头/符干，不可用 |
| PlayScore / SheetVision / ScanScore | 商业闭源/云端 | ❌ | 违反「无后端/无云端」 |
| 学术 CRNN OMR（PrIMuS 等）+ tf.js | 模型 | ⚠️ | 唯一可行，但需打包 10–50MB 模型、真实扫描图准确率有限 |

**结论**：当前**不存在**「零成本、客户端、可接受精度」的浏览器 OMR 库。本增量只做**接口预留 + 管线打通**，不引入重模型（保包体积）。

#### 1.5.2 方案

- 新增 `src/io/omrProvider.ts`：
  ```ts
  export interface OmrProvider {
    id: string; label: string; enabled: boolean;
    recognize(input: Blob | ArrayBuffer): Promise<OmrResult>; // OmrResult = { staffNotes: StaffNote[]; warnings: string[] }
  }
  export const nullOmrProvider: OmrProvider = { id: 'omr-local', label: '图片/PDF 五线谱识别（实验性）', enabled: false, async recognize() { throw new AppError(E_NOT_IMPLEMENTED, '…'); } };
  ```
- **结果进校对编辑器**：`OmrResult.staffNotes` 与 MusicXML 五线谱路径共用 `assignFingering`（`staffFingering.ts`），产出带 `confidence` 的 `Note[]` → 组装 `Tab`（`source.type='transcribed'` 或 `'imported'`）→ 直接进现有编辑器/待确认清单。
- UI 入口：默认隐藏/灰置，文案「实验性 · 准确率有限」；`nullOmrProvider.enabled=false`，未来 M2 接真模型时翻转。

#### 1.5.3 衔接点

| 文件 | 改动 | 性质 |
|---|---|---|
| `src/io/omrProvider.ts` | **新增**（接口 + `null` 桩 + 调研注释） | 纯类型 + 桩 |
| `src/core/staffFingering.ts` | 复用（无改动；`StaffNote` 已被 OMR 复用） | 纯函数 |
| （可选）`src/ui/transcribe/TranscribePage.tsx` | 实验性入口占位（隐藏/灰置） | 副作用 |

---

## 2. 文件清单

### 2.1 新增文件

| 路径（相对 `fretly/`） | 职责 | 预估行数 | 性质 |
|---|---|:--:|:--:|
| `src/core/staffFingering.ts` | 五线谱→六线谱指法分配：`StaffNote` 类型、`foldIntoRange`、`assignMelody`、`assignChord`、`assignFingering`（输出带 `confidence`/`stroke` 的 `Note[]`）；被 MusicXML 与未来 OMR 共用 | ~160 | 纯函数 |
| `src/core/strokeInference.ts` | 扫弦方向推断：`classifyGroup`、`inferChordStroke`、`DEFAULT_CHORD_STROKE` | ~50 | 纯函数 |
| `src/io/omrProvider.ts` | `OmrProvider` 接口 + `nullOmrProvider` 桩（`enabled=false`）+ OMR 选型调研注释 | ~80 | 纯类型/桩 |
| `src/audio/__tests__/transport.test.ts` | Transport 锚点映射/`currentTick`/`currentMeasure`/seek 时序正确性（fake clock） | ~140 | 测试 |

### 2.2 修改文件

| 路径 | 改动 | 性质 |
|---|---|---|
| `src/audio/Transport.ts` | +`currentMeasure` getter（派生自 `currentTick`） | 纯派生 |
| `src/audio/synth.ts` | `karplus()` 内：琴体共振（2 个 biquad）、力度→衰减、pick 噪声、峰归一 | 纯函数 |
| `src/ui/tab/TabCanvas.tsx` | overlay rAF 派生小节高亮；practice 静态层不再画 `highlightMeasure`（保留给 editor 选区） | 副作用 |
| `src/ui/practice/PracticePage.tsx` | 移除 practice 的 `highlightMeasure={currentMeasure}` | 副作用 |
| `src/state/practiceController.ts` | +`syncMeasureState()`；seek/play/loadTab 调用 | 副作用 |
| `src/state/usePracticeStore.ts` | `setTab` 重置 `currentMeasure: 0` | 副作用 |
| `src/io/musicXmlImporter.ts` | 选轨（吉他优先→音高轨回退）+ staff 轨收集 + 调 `assignFingering` | 混（壳 DOMParser） |
| `src/audio/__tests__/synth.test.ts` | 增补音色增强用例 | 测试 |
| `src/io/__tests__/io.test.ts` | 增补五线谱映射/方向/超界用例 | 测试 |
| `src/core/__tests__/core.test.ts` | 增补 `strokeInference` 用例 | 测试 |

> 合计：新增 4 文件、修改 10 文件。**未触碰** `tabFactory/chords/rhythm/mastery/progressive/storage/exporters/其他 UI`，严格最小变更。

---

## 3. 任务列表（6 个 Batch，依赖有序）

> 格式 `T-xx | 依赖 | 文件 | 说明 | 验收`。实现顺序 = 编号顺序；同 Batch 内可并行。

### Batch 1 · 进度同步 bug 修复（P0，最先）

| 任务 | 内容 |
|---|---|
| **T-01** | 依赖：无 ｜ 文件：`src/audio/Transport.ts`、`src/ui/tab/TabCanvas.tsx`、`src/ui/practice/PracticePage.tsx`、`src/state/practiceController.ts`、`src/state/usePracticeStore.ts`、`src/audio/__tests__/transport.test.ts` ｜ 说明：Transport 加 `currentMeasure` getter；TabCanvas overlay rAF 内从 `playheadTick()` 派生并绘制小节高亮、practice 静态层不画 `highlightMeasure`；PracticePage 移除 `highlightMeasure` 传参；controller 加 `syncMeasureState()` 并在 seek/play/loadTab 调用；`setTab` 重置 `currentMeasure`；新增 transport.test.ts（fake clock 验证 seek/回跳/换曲后 `currentMeasure` 立即对齐） ｜ 验收：向后 seek 后色块与播放头同小节；播完自动 stop 再从头播，色块归 0；换曲首屏高亮第 1 小节；播放时画布 60fps 且 React 无每帧重渲染（Profiler）；既有 229 用例不回归 |

### Batch 2 · 音色增强（P0）

| 任务 | 内容 |
|---|---|
| **T-02** | 依赖：T-01 ｜ 文件：`src/audio/synth.ts`、`src/audio/__tests__/synth.test.ts` ｜ 说明：`karplus()` 内加琴体共振（110Hz Q4 G0.35 + 200Hz Q6 G0.25）、`decayRate` 力度调制 `(1.2+freq/400)*(1+0.8*(v-0.5))`、12ms pick 噪声（tau 3ms）、峰归一防削波；**不改** `KarplusOptions`/`PluckCache`/`Synth`/`DemoTrack` ｜ 验收：新增用例全绿（低音段能量提升、早期瞬态存在、velocity=1 不削波、无 DC、高力度衰减更快）；`npm run typecheck` 0 错；手工听测 0.6x/1.0x 同音符基频差 < 10 音分（变速不变调不回归） |

### Batch 3 · 五线谱→六线谱（P0）

| 任务 | 内容 |
|---|---|
| **T-03** | 依赖：T-01 ｜ 文件：`src/core/staffFingering.ts`（新）、`src/io/musicXmlImporter.ts`、`src/io/__tests__/io.test.ts` ｜ 说明：`selectImportPart` 吉他优先→音高轨回退；staff 轨收集（保留同 tick 多音、读 `<pitch>`/`<chord>`）；`assignFingering` 实现 `foldIntoRange`/`assignMelody`/`assignChord` + confidence（fret≥12→+0.15、>15→+0.25、折叠→+0.5、品差>4→+0.15）；本 Batch 和弦 `stroke` 先默认 `'D'`（Batch 4 接推断） ｜ 验收：E4→弦1品0；C 大三和弦（C4/E4/G4）→ 不同弦低把位、无同弦冲突；B2(35) 折叠进 [40,88] 且 confidence<0.45；无吉他轨但有音高轨的文件可导入；仅吉他轨文件行为与 M1 完全一致（回归） |

### Batch 4 · 扫弦方向推断（P1，配套）

| 任务 | 内容 |
|---|---|
| **T-04** | 依赖：T-03 ｜ 文件：`src/core/strokeInference.ts`（新）、`src/core/staffFingering.ts`、`src/core/__tests__/core.test.ts` ｜ 说明：`classifyGroup`/`inferChordStroke`/`DEFAULT_CHORD_STROKE`；`assignFingering` 调之注入 `stroke`（单音 `null`、和弦 `D`/`U`、分解 `P`、`<arpeggiate>` 上/下映射） ｜ 验收：单音→`null`；同 tick 双音→`D`（低→高）或 `U`（高→低）；不同 tick→`P`；`arpeggiate up→D`、`down→U`；**方向与 `rhythm.ts` 的 D=[6→1]/U=[1→3] 一致**（交叉断言） |

### Batch 5 · OCR 实验性（P1）

| 任务 | 内容 |
|---|---|
| **T-05** | 依赖：T-03 ｜ 文件：`src/io/omrProvider.ts`（新）、（可选）`src/ui/transcribe/TranscribePage.tsx` ｜ 说明：`OmrProvider` 接口 + `nullOmrProvider` 桩（`enabled=false`）+ 调研注释（结论见 §1.5.1）；结果复用 `StaffNote`→`assignFingering`→编辑器；UI 入口隐藏/灰置标注「实验性 · 准确率有限」 ｜ 验收：`nullOmrProvider.enabled===false`；接口类型编译通过；`StaffNote` 与 MusicXML 五线谱路径共享同一 `assignFingering`；全站无「AI 云端/额度」文案；**不引入任何模型依赖**（包体积不变） |

### Batch 6 · 联调（P0）

| 任务 | 内容 |
|---|---|
| **T-06** | 依赖：T-02, T-04, T-05 ｜ 文件：全量（`npm run typecheck`/`test`/`build` + 手工走查） ｜ 说明：架构守卫测试扩展（禁 `6 -` 越界、禁 `playbackRate` 全绿）；变速不变调三档实测；进度同步视觉走查；五线谱转谱→校对→入库闭环 ｜ 验收：`tsc` 0 错、vitest 全绿（229+新增）、build 成功；0.5/1.0/1.5x 同音符基频差 < 10 音分；播放头与色块同源一致；五线谱导入后可编辑、低置信进待确认清单、可入库 |

---

## 4. 风险与降险

### 4.1 进度同步 bug 的根因置信度

| 候选根因 | 置信度 | 验证方法 | 兜底 |
|---|:--:|---|---|
| seek/回跳/重播不回收 `currentMeasure`（子问题 1，主因） | **95%** | 单测：fake clock 构造 Transport，向后 seek 断言 `currentMeasure`；或在 UI 播放中点第 2 小节看色块 | `syncMeasureState()` 统一回写，确定性消除 |
| `loadTab`/`setTab` 不重置 `currentMeasure`（子问题 2） | **95%** | 换曲看首屏高亮 | `setTab` 重置 + `loadTab` 显式 set |
| 离散 25ms 更新慢半拍（子问题 3，观感） | 80% | 高 BPM（≥180）下观察跨小节瞬间 | 高亮移到 rAF overlay，从 `currentTick` 同帧派生 |
| 变速后 BPM 与 anchor 不同源（team-lead 猜想） | **排除（~0%）** | 代码核查：`setTempoInternal`/`tempoApplied` 同源 | 无需处理 |

> 若 T-01 落地后仍见错位，兜底：把画布高亮与播放头**全部**收敛为「单点读 `transport.currentTick`」，彻底移除 store 参与画布（已在本方案中实现），并排查是否有第三方组件缓存了 `currentMeasure`。

### 4.2 音色增强如何不回归「变速不变调」

- 增强输入仅 `(midi, velocity, sampleRate, freq, seconds)`，**不含 tempo/ratio**；`Synth.pluck` 的 `when` 仍由 `Transport.onSchedule` 给出，合成参数不变。
- 琴体共振/噪声为**零 DC、线性时不变**滤波器，只改频谱不改基频。
- 缓存键 `(midi, velocityBucket)` 不变 → 变速只改「同一 buffer 的调度时刻」，天然保音高。
- 守卫测试扩展：仍扫描 `playbackRate` 全项目 0 命中；新增「合成输出与 tempo 参数无关」断言（同 `midi` 在两种 BPM 下产出相同 `Float32Array`）。

### 4.3 五线谱指法如何不越界 fretboard

- **所有 `6 - x` 方向换算只走 `fretboard.ts`**（`diagramIndexOf/stringOf/fretAt/soundedStrings`）。`staffFingering.ts` 只调 `allPositions`/`OPEN_MIDI`/`STRING_NUMBERS`，**不自写**任何 `6 - x`。
- 音域折叠与品位 clamp 均在 `[0, MAX_FRET]`，和弦分配用 `allPositions` 的候选集（已含 `fret ∈ [0,24]` 约束）。
- 守卫测试：扫描 `staffFingering.ts`/`strokeInference.ts` 无 `6 - ` 形式索引换算。

### 4.4 其他

- **包体积**：音色增强纯算法零依赖；OCR 桩零依赖。全量新增依赖为 0。
- **回归面**：改动集中在 `synth.ts`（纯函数内部）、`TabCanvas`/`practiceController`/`PracticePage`（UI 高亮路径）、`musicXmlImporter`（选轨分支）。节奏引擎、和弦库、存储、扒谱 DSP **不触碰**。

---

## 5. 测试计划

### 5.1 进度同步时序正确性（`transport.test.ts`，fake clock）

- 固定 anchor `{ctxTime:0, tick:0, bpm:120}`：`anchorTickToTime` 与 `anchorTimeToTick` 互为逆；`currentTick` 随 fake `ctx.currentTime` 单调递增。
- 向后 seek：`transport.seek(1920)` 后 `currentMeasure === 1`；继续推进时间跨入 3840 时 `currentMeasure === 2`（守卫不吞事件）。
- 整曲 `stop()` 后 anchor 回 0 → `currentMeasure === 0`。
- `measureIndexOf(anchorTimeToTick(...))` 与 rAF 播放头用的 tick 同一函数（交叉断言：高亮与播放头同源）。

### 5.2 音色增强输出边界（`synth.test.ts` 扩展）

- 低音段（< 300 Hz）加共振后能量提升（对比关闭共振的基线）。
- 早期瞬态存在：前 12ms RMS 显著高于纯 KS 包络预测值（pick 噪声）。
- `velocity=1` 仍 `max|out[i]| ≤ 1`（峰归一）。
- 无 DC：`|mean(out)| < 0.01`（谐振器/噪声均零均值）。
- 高 `velocity` 的衰减快于低 `velocity`（`decayRate` 力度调制）。
- 同 `(midi, velocity)` 两次 `cache.get` 命中同一引用（缓存键未变）。

### 5.3 五线谱转六线谱音高/方向正确性

- 音高：`E4(64)→弦1品0`、`A3(57)→弦3品2`（低把位）、`E2(40)→弦6品0`。
- 和弦：`C4/E4/G4` 分配结果弦互异、无同弦冲突、品差 ≤ 合理范围。
- 超界：`B2(35)`→ 折叠 +1 octave 且 `confidence < 0.45`；`C7(96)`→ 折叠 −1 octave。
- 方向：单音 `null`、同 tick 双音 `D/U`（低→高=D、高→低=U）、不同 tick `P`、`arpeggiate` 上/下映射。
- 方向一致性交叉断言：`inferChordStroke` 输出与 `stringsForChar('D'/'U')` 的弦序方向一致。

### 5.4 回归

- 既有 229 用例全绿；`tsc` 0 错；`build` 成功。
- 架构守卫：全项目 `playbackRate` 0 命中、`6 - ` 仅 `fretboard.ts`、新模块无越界。

---

## 6. 待明确事项（Anything UNCLEAR）

1. **【高优先级】扫弦方向约定**：team-lead 描述「低→高=U、高→低=D」与已交付 `rhythm.ts` 及物理惯例相反。本设计默认 `低→高=D`、`高→低=U`（与 rhythm.ts 一致），并设 `DEFAULT_CHORD_STROKE` 单点可翻。**请主理人确认**；若坚持反向，需同步改 rhythm.ts + 全量回归（不建议）。
2. **块状和弦的默认方向**：同时发声和弦无时间顺序，「音高走向」只能给跨度方向；本设计默认 `D`（下扫），仅显式琶音记号才反推 `U`。是否需要「和弦跨度 >4 弦才标 D、否则留待人工」的额外策略，可后续定。
3. **staff 导入的 `source.confidence`**：是否写入平均置信度供曲库展示（建议写，仅显示用）。
4. **OCR 是否本期暴露 UI 入口**：默认隐藏/灰置；若需可点但置灰提示，需 1 处 UI 占位（可选）。
