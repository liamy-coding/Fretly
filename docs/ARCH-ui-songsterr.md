# 弦格 Fretly — 练习页播放器化改造 · 落地架构方案

> 依据：`docs/PRD-ui-songsterr.md` ｜ 已核对真实代码：`tabRender.ts` / `TabCanvas.tsx` / `PracticePage.tsx` / `PracticeToolbar.tsx` / `practiceController.ts` / `archGuard.test.ts` / `package.json` / `vite.config.ts`

---

## 1. 数据流与状态归属

**结论（三层，各司其职）：**

| 量 | 频率 | 归属 | 理由 |
|---|---|---|---|
| `scrollLeft` | 每帧 | **rAF 内直接写 `container.scrollLeft`，不存任何 state** | 每帧 setState → 60fps 重渲染整棵练习页树（含右栏和弦图），必然掉帧。`currentTick` 已是「不进 store」的既有先例，跟随滚动沿用同一原则 |
| `followEnabled` | 极低频 | **`TabCanvas` 内部 `useState<boolean>`**（不入 `usePracticeStore`） | ① 唯一消费者是 TabCanvas 自己的 rAF 与浮层按钮，store 化只会新增一条跨层订阅；② store 是「跨组件共享」工具，而此状态无第二个订阅者（PracticeToolbar 不读它）；③ 现有 store 字段全是「控制器驱动的域状态」，跟随是纯视图偏好，放进去会污染语义 |
| 浮层按钮显隐 | 低频 | **由 `followEnabled` 反向驱动**：`!follow && isPlaying` 才渲染 | 用一个 prop 即可，不新增第二个标志位（避免 PRD §8 的「3s 自动消失 vs 移动端 3s 自动恢复」双逻辑冲突） |

**跨组件「请求恢复跟随」信号**：这里有个**必须提前定死**的坑 —— `focusMarker` / `seek(0)` 必须强制恢复跟随，但调用方是 `PracticePage`/`PracticeToolbar`，`followEnabled` 却在 TabCanvas 内。若为此把状态搬进 store 就推翻了上面的结论。**采用 `followNonce: number`（+1 触发）方案**：父层持有 `const [followNonce, setFollowNonce] = useState(0)`，`seek(0)` / 换曲 / `focusMarker` 时 `setFollowNonce(n => n + 1)`，TabCanvas 用 `useEffect(..., [followNonce])` 重置 `followEnabled = true` 并启动平滑复位。非零初值即可覆盖 TabCanvas 重挂载场景。

**自动恢复的权威判定点**（PRD §5.2「再次点击播放/暂停/切小节自动恢复」）：全部由 `followNonce` 一个入口驱动，`seek(0)`、`nextMeasure`、`focusMarker`、`tab.id` 变化、`togglePlay` 各加一次 `setFollowNonce`。**注意**：拖动之后的「点击暂停→播放」也走这条路径，符合 PRD，但需在 `togglePlay` 里显式加 nonce（否则用户以为点播放能救回来却发现没救）。

---

## 2. `layoutTab` 单行模式的签名与实现

```ts
export function layoutTab(measureCount: number, opts?: { singleRow?: boolean }): TabRenderLayout
// 默认 opts?.singleRow !== true → 与现状逐字节等价（现有 5 条断言零改动）
```

内部：`const perRow = opts?.singleRow ? Math.max(1, measureCount) : ROW_MEASURES;` 循环体完全复用。单行时 `rows.length === 1`，`rows[0].measures` 为 N 个小节盒（`x = i * MEASURE_W`）。**不新增 `firstRowMeasures` 参数**（PRD §5.4 提过）—— 无需求支撑，只会增大纯函数测试面。`MeasureBox.w` 仍为 `MEASURE_W=250`，不改，以保证 `contentXOf` 与节拍空间映射一致。

**`totalTabSize` 尺寸上限（真实风险，PRD 未提）**：单行宽度 = `250 × N`，N=132 即触 32767px 上限。对策（两层，都要做）：

1. **弹性小节宽（首选，同时满足「谱面占满视口」）**：单行模式按谱面总长取 `measureW = clamp(MEASURE_W, 视口宽 × 1.4 / N, MEASURE_W)`。N ≥ 150 时自然压到 250 附近并渐近退化；同时小曲（N=20）每小节变宽、更长，符合播放器观感。
2. **节数降级（兜底）**：`MAX_SINGLE_ROW_MEASURES = 120`（`src/core/constants.ts`）。超出则 `singleRow=false` 并 toast 提示回退折行。导入路径已限 `MAX_IMPORT_JSON_MB = 20`，200+ 小节的曲谱基本不可能出现，此分支只作为防线。

**长谱横向定位（PRD §5.4 的「补一次行首」）**：现有 `drawTab` 的弦名判定是 `box.x === 0`，单行模式下**只有第一个小节**满足 → 滚动到第 30 小节后完全没有参照物。改为「每 `4` 小节画一次弦名 + 小节号」，实现方式：在 `DrawOpts` 增加 `stringLabelEvery?: number`，条件从 `box.x === 0` 改为 `box.index % (opts.stringLabelEvery ?? Number.MAX_SAFE_INTEGER) === 0`（**保留 `box.x === 0` 作为 OR 条件**，折行模式行为不变）；同时新增小节号绘制（`MeasureBox` 已有 `index`，**无需改动 `TabRenderLayout` 结构**）。

---

## 3. 自动跟随滚动算法

### 3.1 缓动 / 安全带 / 锚点 → **抽成纯函数**（利于单测）

新增 `src/ui/tab/follow.ts`（属 ui 层，不触碰 core 层依赖守卫）：

```ts
export interface FollowInput {
  containerW: number;   // 视口宽（clientWidth）
  contentW: number;     // 谱面总宽（= renderW）
  anchorRatio: number;  // 桌面 1/3，移动 <1024px 时 1/2
  targetX: number;      // 当前小节（或播放头）的谱面绝对 x
  scrollLeft: number;
  dt: number;
  ratio: number;        // 播放比例（≤0.6 时缓动减半）
}
export interface FollowOut {
  shouldScroll: boolean;
  nextScrollLeft: number;
  deadband: number;     // 半屏安全带宽度（调用方可复用判「立即贴合」）
}
export function stepFollow(i: FollowInput): FollowOut;
export function currentFollowTargetX(layout: TabRenderLayout, tick: number, timeSignature: TimeSignature): number;
```

`stepFollow` 核心：

```
anchorPx = containerW * anchorRatio
delta    = (targetX - anchorPx) - scrollLeft          // 目标位移（CSS px）
deadband = containerW * 0.5                            // 安全带半宽
if (|delta| <= deadband) return { shouldScroll: false, nextScrollLeft: scrollLeft, deadband }
k        = (ratio <= SLOW_FOLLOW_RATIO ? FOLLOW_EASE_SLOW : FOLLOW_EASE) * Math.min(dt / 16.67, 3)
eased    = delta >= 0 ? Math.max(FOLLOW_MIN_STEP, delta * k) : Math.min(-FOLLOW_MIN_STEP, delta * k)
next     = clamp(scrollLeft + eased, 0, contentW - containerW)
```

要点：① 用**与帧间隔无关**的 `k·(dt/16.67)`（dt 有上界 clamp，避免切标签页回来一次跳一大截）；② **不做对称 `1-e^(-λt)`**，因为它永不真正到 0，会持续发 `scroll` 事件自我触发解除跟随 —— 故给 `FOLLOW_MIN_STEP = 1px` 的**最小步长支配**，到就一步到位，此后 `|delta| <= deadband` 必然成立、自动停手，**天然无抖动**；③ `delta` 用「小节左边界 - 锚点」，但**判安全带用小节中心**（长小节下更贴近 PRD §7「第 5 小节完整处于视口内」的验收），两者取其一后写进 `follow.ts` 的 doc 注释固定下来，避免实现漂移。

### 3.2 区分「程序滚动」与「用户滚动」—— 本方案最关键的三道闸

```
container.addEventListener('scroll', onScroll, { passive: true });

onScroll() {
  if (programmaticScroll) {          // 闸 1：标志位
    programmaticScroll = false;
    return;
  }
  if (lastAutoWriteAt === 0 || performance.now() - lastAutoWriteAt > PROGRAM_SCROLL_GRACE_MS) {
    // 闸 2：时间窗 + 位移比对 —— 只有当本次 scrollLeft 与我们上一帧写入值不一致时才判为用户滚动
    if (Math.abs(el.scrollLeft - lastWrittenScrollLeft) > USER_SCROLL_EPSILON) setFollowEnabled(false);
  }
  // 否则视为程序写入的迟到事件，忽略
}
```

- **闸 1（标志位）**：每次程序写入前一拍 `programmaticScroll = true`；因为每次都写 `scrollLeft`（即使 `el.scrollLeft = el.scrollLeft` 也会触发一次 scroll 事件），浏览器保证同步 emit，所以标志位会被精确消费。
- **闸 2（比对+时间窗）**：防御 `scrollend` 缺失、事件合并、Safari 的异步 emit。**不要依赖 `scrollend`**（Safari < 17 无），`onScroll` 即可，但必须带 `dragging` 短路：拖动中一律不看 `scrollLeft` 差值，由 `pointerdown` 直接解除，避免拖拽中途被程序写入干扰。
- **闸 3（意图事件）**：`wheel`（passive:true，**绝不 `preventDefault`**，否则破坏触控板）+ `pointerdown` 落在滚动容器内（拖动/滚动条）+ 手动 `touchmove`（用 `passive` 监听器配 `pointerdown` 判定）→ **立即** `setFollowEnabled(false)`。三条中任何一条命中都解除，冗余比漏判安全。

**解除跟随**只是 `setFollowEnabled(false)`（一次 setState，低频，安全）；rAF 内仅剩一次 `shouldScroll` 分支判断，**不停 rAF，播放不中断**，符合 PRD §5.2。

---

## 4. 组件改动清单

| 文件 | 改什么 | 为什么 | 风险 |
|---|---|---|---|
| `src/ui/tab/tabRender.ts` | `layoutTab` 加 `opts.singleRow`；`totalTabSize` 支持变宽；`DrawOpts` 加 `stringLabelEvery`；`box.x===0` → `index % N === 0`；新增小节号绘制 | P0 | **低**（默认路径零改动，纯函数，有测试兜）。唯一真实风险：`totalTabSize` 若改签名会连带 `TabCanvas` 的 `useMemo` 依赖，建议只加 `layout.measureW` 字段读取，不改签名 |
| `src/ui/tab/follow.ts`（新建） | `stepFollow` / `currentFollowTargetX` / 常量 | P0 | 低（纯函数） |
| `src/ui/tab/TabCanvas.tsx` | 新增 props `singleRow?: boolean`、`follow?: boolean`、`onFollowChange?`、`resetNonce?: number`；滚动容器 `ref`；`useRaf` 内接跟随；滚动/指针/滚轮监听；「▶ 恢复跟随」浮层（`absolute right-2 top-2 z-10`，容器加 `relative`） | P0 | **中高**。① overlay 的 `canvas.width = w*dpr` 每帧重设 → w 从 1000 变 30000、h 从 200 变 300，**每帧分配 30000×300 后备缓冲**，必须改为只在 `w/h` 变化时重设尺寸（本次同源修复）② `useRaf` 是全局常驻回调，TabCanvas 同时存在于 Practice/Editor，两处都在跑；跟随逻辑必须 `mode === 'practice' && singleRow` 早退。③ 新增 rAF 内 `getBoundingClientRect()` 会触发强制布局，**容器宽高要缓存、只在 `resize` / 首帧取** |
| `src/ui/practice/PracticePage.tsx` | 传 `singleRow`、`follow`、`onFollowChange`、`resetNonce`；页头补 `tab.key` / `tab.capo` / 拍号；主区加 `min-h`；`seek(0)` / 换曲处 bump nonce | P0 | 中。`viewMode !== 'tab'` 时 TabCanvas 卸载，跟随状态随之丢失（切回重新跟随）—— 可接受，需在文档注明 |
| `src/ui/practice/PracticeToolbar.tsx` | 仅重排三组 + 组间分隔线 + 位置紧贴页头下方 | P0 | 低（纯布局）。注意 A-B / 取消按钮在窄屏的换行 |
| `src/core/constants.ts` | `FOLLOW_EASE` / `FOLLOW_EASE_SLOW` / `SLOW_FOLLOW_RATIO` / `FOLLOW_MIN_STEP` / `PROGRAM_SCROLL_GRACE_MS` / `USER_SCROLL_EPSILON` / `MAX_SINGLE_ROW_MEASURES` | P1 | 低（常量，archGuard 扫描无碍） |
| `src/ui/practice/PracticePage.tsx` 右栏 | **不改**；PRD §6「右栏下沉 + 接下来横向滑动条」**建议本次不做** | 见 §7 | — |

**`TabCanvas` props 结论**：`singleRow` 与 `follow` 必须新增（不能从 `mode` 推导 —— 编辑器将来也可能要单行，且 `mode` 已在多处当语义开关）；`resetNonce` 走 prop（父层驱动、子层消费，比 context 轻）。EditorPage 三个新 prop 全部省略 → 默认 `false` / `undefined`，**零影响**。

---

## 5. 对既有能力的回归风险

1. **双 Canvas overlay 坐标**：overlay 与静态层共用同一 `layout`/`w`/`h`，单行下 `box.x` 膨胀到 30000 也不会错位；但 `ctx.clearRect(0,0,w,h)` + 逐帧重设 `canvas.width` 是**性能陷阱**（见 §4），必须改成尺寸变化时才重设。播放头 `moveTo(x, 0) → lineTo(x, h)` 在 h=300 的单行下仍正确。
2. **`hitTest` 单行下仍正确**：`measureAt` 用 `y >= r.y && y < r.y + ROW_H` —— 单行只有一行，`y` 恒落在带内，成立；`x` 落在 0..contentW，由 `row.measures.find(x)` 命中，成立。**唯一注意**：`hitTest(tab, layout, x, y)` 收到的 `x` 必须是**已含 scrollLeft 的 canvas 本地坐标**。现有 `canvasPos` 用 `getBoundingClientRect()` 减 `left` —— canvas 在滚动容器内，rect 已随滚动偏移，**语义正确，无需改动**。这是本次最需要写进测试的风险点（见 §6）。
3. **`highlightMeasure`（editor 走静态层）**：单行模式不传给 EditorPage，逻辑分支未触及。`mode === 'editor' ? highlightMeasure : null` 保持不动，editor 仍是折行、仍走静态层，**零影响**。
4. **`touchAction` / 移动端拖拽**：canvas 现在是 `touch-action: pan-x pan-y`，横向拖动由浏览器接管并直接改 `scrollLeft`（不会发 `wheel`，`pointerdown` 是解除跟随的唯一可靠信号）→ 故 `pointerdown` 解除跟随必须在**移动端也生效**（PRD §6 只写了「拖动时禁用跟随」）。**PRD §6 移动端「松手后 3s 自动恢复」建议删除**，改「统一手动点击恢复」（与主理人第 4 条一致），理由：3s 定时器 × 拖动连续触发 = 反复重启定时器，代码量和抖动风险都不划算。
5. **滚动条可见性**：`.fretly-scroll` 当前显式给了 8px 横向滚动条。单行布局下横向滚动是常态，固定 8px 占高且丑 → 改为 `scrollbar-width: none` + `::-webkit-scrollbar { height: 0 }`，滑动手势与浮层按钮即交互入口。

---

## 6. 测试策略

**纯函数单测（vitest node 环境，无 DOM 依赖，本次主战场）：**

- `layoutTab`：`measureCount=0 / 1 / 4 / 5 / 200` 下 `rows.length`、每行小节数、`x = i*250` 递增；**`singleRow?: false` 与「不传 opts」的返回值深比较相等**（守住「默认行为不变」这条硬约束）—— 这条建议和现有 5 条断言并列，**不改动原 5 条**。
- `totalTabSize` 单行：`w = N * measureW`、`h = ROW_H`；N=132 时的降级分支返回折行布局。
- `follow.ts`（抽纯函数的价值就在这）：
  - 安全带：`|delta| ≤ 半屏` → `shouldScroll === false` 且 `nextScrollLeft` 不变；
  - 缓动：`ratio=1` 与 `ratio=0.5` 同输入下，后者的单帧 `|next - scrollLeft|` 严格更小；
  - **收敛性（防抖动核心断言）**：连续迭代 `stepFollow` 100 次，`|delta|` 单调不增，且在第 K 帧后 `shouldScroll` 恒为 `false`（这条能直接抓住「永不收敛 / 到不了位 / 反复微动」三类 bug）；
  - 边界：`contentW < containerW`（短曲不滚动）、`scrollLeft` 不被 clamp 到负数、`dt = 1e4`（切标签页回来自动降幅）。
- `currentFollowTargetX`：`tick` 落在第 5 小节时返回第 5 小节盒左边界；`tick` 越界（曲尾）返回最后一小节右边界。

**组件层**：项目是 `environment: 'node'`、未装 `@testing-library`（`package.json` 中 `jsdom` 存在但只用于 `@vitest-environment jsdom` 文件头）。**不引入 RTL**，但可以做两类低成本验证：① 用 `@vitest-environment jsdom` 直接 `document.createElement('div')` 手写 DOM，验证「程序写入 scrollLeft → 标志位被消费、不解除跟随」与「外部改 scrollLeft → 解除跟随」的**事件时序契约**（这是 §3.2 三道闸的唯一可测面，值得写）；② `stepFollow` 的常量（`FOLLOW_MIN_STEP` 等）守住「缓动系数减半」的数值不变式。真实滚动与视觉验收放人工（PRD §7 十条已足够）。

---

## 7. 对 PRD 的异议与替代

| PRD 条目 | 问题 | 替代方案（建议） |
|---|---|---|
| §5.4 `layoutTab(measureCount, { singleRow, firstRowMeasures })` | `firstRowMeasures` 无消费方 | 只加 `singleRow` |
| §6 移动端「松手后 3s 自动恢复跟随」 | 与「统一手动点击恢复」冲突，定时器反复重启 | 直接删除，全平台统一手动恢复（与主理人第 4 条一致） |
| §5.2「再次点击播放/暂停/切小节自动恢复」 | 未指明实现入口，易散落成多套逻辑 | 收敛为 `followNonce` 单一入口（§1） |
| §6 右栏下沉 + 「接下来」改横向滑动条 | 与「自动跟随」收益无关，属独立改造，会显著扩大本次改动面（右栏已是独立卡片区） | **本次不做**，单行布局验证有效后单独评估 |
| §6 谱面 `min-h ≥ 2 行谱面高度` | 单行模式只有 1 行（`ROW_H=193`），固定 2 行高度会造成大片留白，与「谱面占最大面积」目标相反 | 改为 `min-h-[ROW_H]` + `max-h` 由视口计算；单行下高度 `h = ROW_H`，容器 `overflow-y: hidden` |

**工作量诚实评估**：核心难点不在单行布局（半天），而在 **TabCanvas 的滚动接管层 + 三道闸的时序正确性**（1~1.5 天，含手测拖拽/滚轮/滚动条/移动端四种路径 × 播放中/暂停两态）。`drawTab` 在大宽度 canvas 上的后备缓冲分配是**必须先修的既有隐患**，否则单行一上就卡。整体建议 **3 天**（含测试与回归），不建议压到 2 天以内。

---

## 8. 给工程师的共享约定

```
- 自动跟随：scrollLeft 一律 rAF 直写 DOM；followEnabled 用 TabCanvas 局部 state
- 强制恢复跟随：只走 resetNonce (+1) 一个入口
- 程序写入 scrollLeft 必须先置 programmaticScroll = true，并在 onScroll 中消费
- 任何 scroll/pointerdown/wheel 监听器都不得 preventDefault（触控板/移动端会废）
- 单行模式仅在 mode==='practice' && singleRow===true 时启用，其余早退
- 新增常量放 src/core/constants.ts；follow 纯函数放 src/ui/tab/follow.ts（不进 core/，避免 R1 守卫争议）
- 禁止 playbackRate / 6-x / 手工重算熟练度（archGuard 三条守卫）
- 不改 tabRender.test.ts 现有 5 条断言；tabRender.test.ts 只做「新增」
```

## 9. Anything UNCLEAR / 假设

1. **锚点用「小节左边界」还是「播放头 x」**：PRD §5.1 写「当前小节 x 与锚点的差值」，§7-1 又写「第 5 小节靠左 1/3」。已在 §3.1 定为「驱动量=小节左边界、安全带判定=小节中心」，需 PM 确认无异议。
2. **父层与子层「跟随状态」是否需要双向同步**：本方案 `follow` 只作**初始值**、`onFollowChange` 只作**上报**（不回流），避免 setState 回环。若 PM 要求页头也显示「跟随中」徽标，则需真双向，届时建议改放 `usePracticeStore`（届时 store 化才有第二个订阅者）。
3. **`MAX_SINGLE_ROW_MEASURES=120` 的降级提示**是否需要 UI 文案（涉及 COPY 常量与合规扫描），本方案假设只 toast 不落文案文件。
4. **变调夹**：按主理人第 6 条仅展示 `tab.capo`，**不改变发声**。`tab.capo` 类型为 `0|1|2|3|4|5|6|7`，展示时 `capo === 0` 建议显示「变调夹：无」而非「0」，需 PM 拍板文案。

---

## 10. 独立 QA 验收记录（2026-09-10）

**结论：PASS。** 由主理人独立执行，不采信工程师自报。

### 10.1 三命令门禁
| 命令 | 结果 |
|---|---|
| `tsc --noEmit` | 0 error |
| `vitest run` | **366 passed / 28 files**（乙改造前 361；本次新增 5 条弹性宽度用例） |
| `vite build` | 成功，`index-*.js 345.62 kB / gzip 114.42 kB` |

### 10.2 变异测试（真实改写源码 → 观察用例是否报警）

| # | 变异内容 | 期望 | 实测 |
|---|---|---|---|
| MUT-1 | `stepFollow` 去掉 1px 最小步长（`Math.max(FOLLOW_MIN_STEP, …)` → `Math.max(0, …)`） | 抖动守卫用例应失败 | ✅ 2 failed |
| MUT-2 | `shouldTreatScrollAsUser` 拆掉闸 2 时间窗（`withinGrace = false`） | 时序契约用例应失败 | ✅ 1 failed |
| MUT-3 | `layoutTab` 折行模式也消费 `measureW` | 「折行忽略 measureW」应失败 | ✅ 1 failed |
| MUT-4 | `anchorRatioForWidth` 恒返 1/3（破移动端居中） | 锚点用例应失败 | ✅ 1 failed |

四处变异**全部被捕获**，随后 `diff` 校验源码已逐字节还原（`RESTORED_CLEAN`）。说明新增断言不是「陪跑断言」，而是真正锚定了实现。

### 10.3 架构守卫复核
`archGuard.test.ts` 8 条全绿：`6-x` 唯一实现在 `core/fretboard.ts`、全项目无 `playbackRate`、`core/` 不反向依赖 `ui/`、`data/` 分层干净、合规文案无违禁词。本次新增的 `ui/tab/follow.ts` 置于 **ui 层而非 core 层**，未触发 R1 争议。

### 10.4 独立发现并修复的缺口（工程师自报 PASS 时遗漏）
1. **弹性小节宽未实现** —— 已在架构层批准，工程师报告「不做」。主理人补做：`layoutTab` 增 `measureW` 选项、`totalTabSize` 改用 `layout.measureW`、`TabCanvas` 用 `ResizeObserver` 同步 `containerW` 并派生 `desiredMeasureW`；新增 `SINGLE_ROW_FILL_RATIO = 1.15`。
2. **`focusMarker` 未触发跟随复位** —— 「难点标记」跳转后画面停在旧位置。已补 `bumpFollow()`。
3. **overlay 画布逐帧重设尺寸（既有隐患）** —— 单行下 `w` 由 ~1000 → ~30000，每帧重设会分配巨型后备缓冲必然卡死。已加 `overlaySizeRef` 缓存，仅在尺寸变化时重设。

### 10.5 遗留（非阻塞，转 甲 任务处理）
- 用户从 Songsterr 页面手工复制的谱面文本，`asciiImporter` 的解析容错仍不足 —— 属 **任务 甲** 范围。
