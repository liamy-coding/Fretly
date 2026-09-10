# ARCH · 导入功能精修方案（三处质量缺口）

> 范围：`ImportModal` 质量精修。**不新建功能**（路线 A 已完成），**不改解析器核心逻辑**，**不新增依赖**。

## 0. 先核实的事实（已读源码，非推测）

| 项 | 真实值 | 位置 |
|---|---|---|
| `jsonImporter.fromText` | **`true`** | `importers.ts:264` |
| `jsonImporter.accept` | `['.json', '.fretly.json']` | `importers.ts:263` |
| `musicXmlImporter` | `accept: ['.xml', '.musicxml']`，`fromText: false` | `musicXmlImporter.ts:385-386` |
| `asciiImporter` | `accept: ['.txt', '.tab']`，`fromText: true` | `importers.ts:251-252` |
| `gpImporter` | `fromText: false`，**未注册进 IMPORTERS** | `importers.ts:304,314` |
| `ConfirmDialog` props | `{ open, title, message, confirmText?, danger?, onConfirm, onCancel }` — **无 `cancelText`**，取消键硬编码「取消」 | `kit.tsx:518-554` |
| 既有体积阈值先例 | `MAX_AUDIO_MB = 50` | `constants.ts:30` |

> ⚠️ **最关键发现**：`jsonImporter.fromText === true`。当前 `doImport` 的 `if (importer.fromText)` 分支让 JSON **只走文本框**，文件选择器永不渲染。这是既有行为（JSON/ASCII 同一分支，MusicXML 走文件），精修时**必须保持**，否则是回归。

## 1. 逐缺口修复方案

统一在 `LibraryPage.tsx` 的 `ImportModal` 内改，**不新增文件**（改动点 <100 行）。

### 缺口 1 · 文件体积守卫

在 `doImport` 的 `parse` 之前加守卫，并把阈值放进 `core/constants.ts`（纯常量 → 可单测）：

```ts
// constants.ts
export const MAX_IMPORT_MB = 8;        // MusicXML / 结构化谱面
export const MAX_IMPORT_JSON_MB = 20;  // Fretly JSON 自带往返导出，放宽
```

```ts
// ImportModal.doImport 内，parse 前
const limitMb = kind === 'json' ? MAX_IMPORT_JSON_MB : MAX_IMPORT_MB;
const sizeMb = (text.length * 2) / 1024 / 1024; // 文本 / fromText 分支
if (!importer.fromText && file && file.size / 1024 / 1024 > limitMb) {
  toast('warn', `文件 ${(file.size/1024/1024).toFixed(1)}MB 超过 ${limitMb}MB 上限，请拆分后再导入`);
  return;
}
```
（`fromText` 分支对粘贴文本用 `text.length` 估算，超限同样提示，避免大段粘贴卡死。）

### 缺口 2 · partial 走确认弹窗

抽出**纯函数**（便于单测，避免渲染 React）：

```ts
// io/importers.ts 或同目录新纯函数文件
export function partialPrompt(r: ImportResult): { title: string; message: string } {
  const at = r.failedAt != null ? `第 ${r.failedAt + 1} 小节附近` : '未知位置';
  const warns = (r.warnings ?? []).join('；') || r.reason || '部分内容未能识别';
  return {
    title: '谱面部分解析成功',
    message: `成功 ${r.parsedMeasures} 小节；${at} 起无法识别。\n${warns}\n是否保留已解析部分并导入？`,
  };
}
```

`doImport` 中把「直接 addTab」改为：`result.partial` 时 `setPending(result.tab)` 并打开 `ConfirmDialog`；`onConfirm` → `void commitImport(pending)`；`onCancel` → 关闭弹窗、清空 `pending`（**不写库**）。非 partial 走原路径不变。

### 缺口 3 · accept / fromText 读导入器字段

```ts
const importer = importerById(kind);
const accept = importer?.accept.join(',') ?? '';   // ['.xml','.musicxml'] → ".xml,.musicxml"
const isTextMode = importer?.fromText ?? false;    // 取代 kind === 'ascii'
```
渲染处：`{isTextMode ? <textarea .../> : <label>…<input accept={accept} …/>`，占位文案用 `accept` 拼出。

## 2. 阈值决策

- **MusicXML 用 `MAX_IMPORT_MB = 8`**：MusicXML 是未压缩文本，普通吉他谱 100–500KB；复杂钢琴谱（多声部+歌词+全曲）可达 2–8MB。8MB 已覆盖真实上限，同时避开「几十 MB 卡死主线程」的最坏情况。
- **JSON 用 `MAX_IMPORT_JSON_MB = 20`**：Fretly JSON 是本 App 的导出格式，含 `practice`/`markers`，同一谱面比 MusicXML 更大；且它是自产自销、格式可信，放宽到 20MB 即可，无需对称。
- 不用单一阈值：两者体积/来源差异明显，共用会误伤 JSON。
- 拒绝策略用 **warn + return**（不抛错、不弹窗），阈值行为对用户透明。

## 3. partial 确认弹窗交互

复用 `ConfirmDialog`（`kit.tsx:518`），**注意无 `cancelText`**，取消键固定「取消」：

```tsx
<ConfirmDialog
  open={pendingTab != null}
  title={prompt.title}
  message={<pre className="whitespace-pre-wrap font-sans">{prompt.message}</pre>}
  confirmText="保留已解析部分并导入"
  onConfirm={() => void commitImport(pendingTab!)}
  onCancel={() => setPendingTab(null)}
/>
```
- 文案：标题「谱面部分解析成功」；正文含**成功小节数 + 失败位置（`failedAt+1`）+ 警告/原因**；询问「是否保留已解析部分并导入？」。
- 「保留并导入」= `addTab(tab)` → `onImported` → 关窗，语义同现状但改为知情确认。
- 「取消」= 丢弃、不入库。
- 不使用 `danger`（数据可恢复，非破坏性操作）。

## 4. accept 字段格式

现值为**字符串数组、已含前导点**：JSON `['.json','.fretly.json']`、MusicXML `['.xml','.musicxml']`、ASCII `['.txt','.tab']`。
HTML `<input accept>` 需**逗号分隔字符串**，直接 `importer.accept.join(',')` 即可，无格式转换。硬编码 `.musicxml,.xml` 与真实值同集合仅顺序不同，替换后行为等价。

## 5. 风险与回归点

| 风险 | 判断 | 说明 |
|---|---|---|
| `jsonImporter.fromText === true` | **高** | JSON 仍走文本框，**不要**因「文件守卫」把 JSON 改成文件模式。守卫的 `!importer.fromText` 分支只对 MusicXML 生效。 |
| accept 顺序 | 低 | `.xml` 在前更符合系统文件框习惯，非回归。 |
| partial 二次点击 | 中 | 需 `pending` state 防重复入库；确认前 disabled 导入按钮。 |
| `gpImporter` | 低 | 未注册，精修不触及；`importerById` 已天然不暴露。 |
| 解析器核心 | 无 | 三处全在 UI/常量层，`parse()` 一行不改。 |

## 6. 测试策略

项目为 **vitest + node 环境**，DOM 用例靠文件头 `// @vitest-environment jsdom`；**未安装 `@testing-library`**，不应引入。

结论：**纯逻辑抽出后在 node 环境单测，不直接测 React 组件**。

- **T-1（纯函数，node）**：`partialPrompt()` — partial+failedAt、无 failedAt、含 warnings 三分支文案正确。
- **T-2（纯逻辑，node）**：体积守卫判定函数（如 `checkImportSize(kind, sizeBytes) → {ok, limitMb}`）— 边界 8/20MB、超限返回 false。
- **T-3（纯逻辑，node）**：`accept` 拼接 — 各 importer `accept.join(',')` 结果与预期一致；`jsonImporter.fromText === true`、`musicXmlImporter.fromText === false` 断言（锁死关键事实，防回归）。
- **T-4（jsdom，可选）**：仅当确需渲染时，用 `react-dom/client` + `act` 手写最小渲染，断言 super-threshold 时 `addTab` 未被调用；不引入新依赖。
- 既有 `src/io/__tests__/io.test.ts` 覆盖解析器，**保持不动**。

## 7. 任务分解（≤5）

- **T01**：常量 + 纯函数（`MAX_IMPORT_MB`/`MAX_IMPORT_JSON_MB`、`partialPrompt`、`checkImportSize`）+ 对应单测。
- **T02**：`ImportModal` 接入三处改动（体积守卫 / partial 确认 / accept 读字段）+ 类型检查。
- **T03**：回归自测（JSON 文本模式、MusicXML 文件模式、ASCII 粘贴、partial 取消不入库）。
