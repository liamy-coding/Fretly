# 弦格 Fretly — 导入入口增量需求（路线 A）

> 范围：把已有的 json / musicxml / ascii 导入器接线到 UI。零后端、纯本地、断网可用、不限次。

## 1. 项目信息
- Language：中文；Project Name：`fretly_import_ui`
- 技术栈：沿用 Vite + React18 + TS + Tailwind v4 + zustand + IndexedDB
- 原始需求复述：`src/io/importers.ts` 已有三个完整导入器，但 UI 层零入口，用户无法导入。本次补一个可用的导入入口，让用户用 MuseScore 等免费工具把五线谱导成 MusicXML 后导入 Fretly。

## 2. 产品目标
1. 用户能在 3 步内（打开入口 → 选格式/选文件 → 确认）把外部曲谱导入谱库。
2. 部分解析（partial）可被用户感知并主动决定是否保留，不静默丢数据。
3. 全程浏览器内解析，不上传、不联网、不限次。

## 3. 决策结论

### 3.1 入口位置 —— 主推「谱库页工具栏」
在 `LibraryPage` 顶部工具栏放 **「导入」按钮**（`Button icon="upload"`），与搜索/视图/排序并列。空状态 `EmptyState` 内再放一个同款次级按钮作为引导。
- 理由：谱库是导入产物的归属地，导入后自然回到此处；桌面左导航与移动端均为「入口在谱库页内」，无需改导航结构，成本最低。
- 不做独立 `/import` 页面：无额外信息承载，反而割裂「导入→在谱库看到结果」的心智。
- 移动端：按钮在 `flex-wrap` 容器内自然换行，无需底部导航新增项。

### 3.2 导入后流转 —— 先预览确认，再入库
统一为 **「解析 → 预览确认弹窗 → 入库 → 跳转详情页」**：
- **`ok:true && partial:false`**：预览弹窗显示「识别到 N 小节 · 标题」，主按钮「导入到谱库」。确认后 `addTab` 并 `navigate('/tab/'+id)`。
- **`ok:true && partial:true`**：预览弹窗降级为 warn 语气，显示 `reason` +「已解析 N 小节」+ 若 `failedAt` 有值则提示「第 X 小节起可能不完整」，主按钮文案改为 **「保留已解析部分并导入」**，并给「取消」。
- **`ok:false`**：不进入预览，直接 `toast('error', result.reason)`，保留在当前弹窗让用户重选文件/改文本。
- 理由：导入属"写入用户数据、不可撤回心累"的操作，partial 尤其需要知情同意；纯成功也走预览可统一交互与文案，避免两套路径。

### 3.3 ASCII 特殊流程 —— 单一入口内用「格式分段器」区分
导入弹窗顶部用 `Segmented` 切换格式（JSON / MusicXML / ASCII），依据导入器 `fromText` 字段自动切换输入区：
- `fromText:true`（ASCII、JSON 的文本兜底）：渲染 `<textarea>` 粘贴区 + 实时识别预览（`guessAsciiMeta`）。
- `fromText:false`（MusicXML；文件型）：渲染点选文件区，`accept` 取自该导入器的 `accept` 字段（不硬编码）。
- 理由：三类导入共享「选格式→给输入→预览→入库」骨架，仅输入控件不同；用 `fromText` 驱动而非按 id 写死，后续新增文本型/文件型导入器零改 UI。**注意**：现有实现按 `kind` 硬编码 file/text 与 accept，需改为读 `importerById(kind)` 的 `fromText`/`accept`。

### 3.4 错误与边界 UX（仅用 toast + Modal/ConfirmDialog）
| 场景 | 判定 | 处理 |
|---|---|---|
| 文件过大 | `file.size` > 5 MB | `toast('warn','文件过大（上限 5 MB），请精简后重试')`，不解析 |
| 格式不匹配 | `ok:false` | `toast('error', reason ?? '格式无法识别')` |
| 全部失败 | `ok:false` | 同上；不写库、不跳转 |
| 部分解析 | `ok:true && partial:true` | 见 3.2，走带 warn 语气的预览确认 |
| 空输入 | 未选文件 / 文本为空 | `toast('warn','请先选择文件'/'请粘贴谱面文本')` |
| 解析异常 | catch | `toast('error', err.message)` |
- 预览确认复用 `Modal`（带 footer 主/次按钮）；不发明新组件。`ConfirmDialog` 仅在"覆盖/删除"类语义需要时使用，本流程用 `Modal` 即可。

### 3.5 成功反馈
- 入库由 `addTab` 统一 `toast('success','已导入《标题》')`，UI **不重复 toast**。
- partial 成功时在入库前额外 `toast('info','部分解析：保留 N 小节')`？——**否**：预览弹窗已充分告知，避免双 toast 噪音。
- 入库后 **自动跳转** `navigate('/tab/'+tab.id)` 到详情页，展示「导入」徽章与元信息编辑，引导用户校对。

### 3.6 入口可用性
- 导入器注册表用 `IMPORTERS`（已含 json/musicxml/ascii），**不注册 gp**，UI 天然不暴露 GP。
- 解析期间禁用主按钮并显示 `Spinner` + 「解析中…」，防止重复提交。

## 4. 范围外（本次不做）
- 不做全屏拖拽上传区 / 拖放解析。
- 不做 PDF 直接解析、图片 OCR、拍照识谱。
- 不做 Guitar Pro（.gp3/4/5）二进制解析（`gpImporter` 维持占位，UI 不注册）。
- 不改 `EditorPage` / `openJobDraft`（导入不复用扒谱编辑器链路）。
- 不做导入历史、批量导入、云端同步、导入额度概念（本产品不限次）。

## 5. 待澄清（不阻塞施工）
- 文件体积上限 5 MB 为产品建议值，若架构有更优阈值可覆盖。
- `COPY.reason` 文案需与 `constants.ts` 现有 COPY 常量对齐。
