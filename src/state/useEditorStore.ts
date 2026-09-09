/**
 * 校对编辑器 Store（T-16 / 架构 §2.9-43、§9.8）：草稿 Tab、选区、
 * 撤销/重做快照栈（≥50 步）、待确认清单（derivePending）与确认动作、自动保存。
 *
 * 语义约定：
 *  - `pending` = 当前**待处理**清单（open），全部为低置信（< CONF_LOW）音符/和弦；
 *    用户「确认」= 接受现状 → 把底层 note/chord.confidence 抬到 CONF_MID →
 *    derivePending 自然不再返回 → 从 open 清单消失。撤销可逆。
 *  - 撤销/重做存整份 Tab 结构化快照（cloneTab = JSON 往返），容量 MAX_UNDO=50。
 *  - 自动保存：dirty 后 800ms 节流落库。来源是 job 草稿 → jobRepo.saveDraft；
 *    已入库 tab / 手动新建 → tabRepo.put；离开页面前请调 flush() 兜底。
 */
import { create } from 'zustand';
import type { ChordEvent, JobId, Note, NoteId, Tab, TabId, Tick } from '@/types/tab';
import type { PendingItem } from '@/types/app';
import { CONF_LOW, CONF_MID, MAX_FRET, nowIso, round2 } from '@/core/constants';
import { allPositions } from '@/core/fretboard';
import {
  cloneTab,
  createEmptyTab,
  regenerateAllMeasures,
  regenerateMeasure,
} from '@/core/tabFactory';
import { newId } from '@/core/id';
import { jobRepo } from '@/storage/jobRepo';
import { tabRepo } from '@/storage/tabRepo';
import { useAppStore } from '@/state/useAppStore';

export const MAX_UNDO = 50;
export const AUTOSAVE_MS = 800;

export interface EditorOrigin {
  kind: 'job' | 'library' | 'manual';
  jobId?: JobId;
  tabId?: TabId;
}

export interface EditorSelection {
  measureIndex: number;
  noteIds: NoteId[];
}

/** 低置信候选：指板上所有可弹位置里取「低把位优先」的前 3（近似 DP 的 emit 代价） */
function candidatesForMidi(midi: number): PendingItem['candidates'] {
  const ps = allPositions(midi, Math.min(15, MAX_FRET));
  // 粗略 emit 代价：品位主项 + 越靠近低音弦微增，与 fretboardDP 的松弛一致
  const ranked = ps
    .map((p) => ({
      ...p,
      cost: round2(p.fret * 1 + (p.string === 6 ? 0.4 : p.string === 1 ? 0.1 : 0.2)),
    }))
    .sort((a, b) => a.cost - b.cost || b.string - a.string);
  return ranked.slice(0, 3).map(({ string, fret, cost }) => ({ string, fret, cost }));
}

/**
 * 派生待确认清单：遍历首轨所有小节，收集 confidence < CONF_LOW 的音符与和弦。
 * 纯函数、可单测。id 格式 `${kind}:${measureIndex}:${noteId|tick}`。
 */
export function derivePending(tab: Tab | null | undefined): PendingItem[] {
  if (!tab) return [];
  const items: PendingItem[] = [];
  const measure = tab.tracks[0]?.measures ?? [];
  for (const m of measure) {
    for (const note of m.notes) {
      if (note.confidence < CONF_LOW) {
        items.push({
          id: `note:${m.index}:${note.id}`,
          kind: 'note',
          measureIndex: m.index,
          noteId: note.id,
          confidence: note.confidence,
          confirmed: false,
          candidates: candidatesForMidi(fretToMidiOf(tab, note)),
        });
      }
    }
    for (const chord of m.chords) {
      if (chord.confidence < CONF_LOW) {
        items.push({
          id: `chord:${m.index}:${chord.tick}`,
          kind: 'chord',
          measureIndex: m.index,
          confidence: chord.confidence,
          confirmed: false,
        });
      }
    }
  }
  return items;
}

function fretToMidiOf(tab: Tab, note: { string: number; fret: number }): number {
  const open: Record<number, number> = { 6: 40, 5: 45, 4: 50, 3: 55, 2: 59, 1: 64 };
  return (open[note.string] ?? 40) + note.fret;
}

interface EditorState {
  draft: Tab | null;
  origin: EditorOrigin | null;
  pending: PendingItem[];
  pendingTotal: number;
  past: Tab[];
  future: Tab[];
  canUndo: boolean;
  canRedo: boolean;
  dirty: boolean;
  saving: boolean;
  lastSavedAt: string | null;
  selection: EditorSelection | null;

  openJobDraft(jobId: JobId): Promise<boolean>;
  openLibraryTab(tabId: TabId): Promise<boolean>;
  newTab(seed?: Partial<Tab>): Tab | null;
  setSelection(sel: EditorSelection | null): void;
  /** 通用可撤销变更：mutator 作用于草稿副本并返回新 Tab */
  mutate(mutator: (tab: Tab) => Tab): void;
  updateMeta(
    patch: Partial<Pick<Tab, 'title' | 'artist' | 'key' | 'capo' | 'bpm' | 'difficultyOverride' | 'tags'>>,
  ): void;
  setNote(noteId: NoteId, patch: Partial<Pick<Note, 'fret' | 'string' | 'durationTick' | 'velocity' | 'stroke' | 'finger'>>): void;
  deleteNote(noteId: NoteId): void;
  setMeasureChord(measureIndex: number, chord: Omit<ChordEvent, 'tick'> & { tick?: Tick }): void;
  applyPattern(measureIndexes: number[], patternId: string): void;
  confirmPending(ids: string[]): void;
  confirmAllPending(): void;
  undo(): void;
  redo(): void;
  /** 立即落库（自动保存 + 离开页面兜底） */
  flush(): Promise<void>;
  /** 入库出口：jod 草稿 → 新谱面入库；已入库 → 覆盖更新。返回入库后的 Tab */
  saveToLibrary(): Promise<Tab | null>;
  discard(): void;
}

function touch(tab: Tab): Tab {
  return { ...tab, updatedAt: nowIso(), revision: tab.revision + 1 };
}

let autosaveTimer: ReturnType<typeof setTimeout> | null = null;

export const useEditorStore = create<EditorState>((set, get) => ({
  draft: null,
  origin: null,
  pending: [],
  pendingTotal: 0,
  past: [],
  future: [],
  canUndo: false,
  canRedo: false,
  dirty: false,
  saving: false,
  lastSavedAt: null,
  selection: null,

  async openJobDraft(jobId) {
    const tab = await jobRepo.loadDraft(jobId);
    if (!tab) {
      useAppStore.getState().toast('warn', '草稿不存在或已被清理');
      return false;
    }
    const pending = derivePending(tab);
    set({
      draft: cloneTab(tab),
      origin: { kind: 'job', jobId },
      pending,
      pendingTotal: pending.length,
      past: [],
      future: [],
      canUndo: false,
      canRedo: false,
      dirty: false,
      lastSavedAt: null,
      selection: null,
    });
    return true;
  },

  async openLibraryTab(tabId) {
    const tab = await tabRepo.get(tabId);
    if (!tab) {
      useAppStore.getState().toast('warn', '曲谱不存在');
      return false;
    }
    const pending = derivePending(tab);
    set({
      draft: cloneTab(tab),
      origin: { kind: 'library', tabId },
      pending,
      pendingTotal: pending.length,
      past: [],
      future: [],
      canUndo: false,
      canRedo: false,
      dirty: false,
      lastSavedAt: null,
      selection: null,
    });
    return true;
  },

  newTab(seed = {}) {
    const base = createEmptyTab({ title: '未命名曲谱', artist: '未知', ...seed });
    const tab = touch(base);
    set({
      draft: tab,
      origin: { kind: 'manual', tabId: tab.id },
      pending: [],
      pendingTotal: 0,
      past: [],
      future: [],
      canUndo: false,
      canRedo: false,
      dirty: false,
      lastSavedAt: null,
      selection: null,
    });
    return tab;
  },

  setSelection(selection) {
    set({ selection });
  },

  mutate(mutator) {
    const { draft, past } = get();
    if (!draft) return;
    const next = touch(mutator(cloneTab(draft)));
    const nextPast = [...past, cloneTab(draft)].slice(-MAX_UNDO);
    const pending = derivePending(next);
    set({
      draft: next,
      past: nextPast,
      future: [],
      canUndo: true,
      canRedo: false,
      dirty: true,
      pending,
      pendingTotal: Math.max(get().pendingTotal, pending.length),
    });
    scheduleAutosave();
  },

  updateMeta(patch) {
    const { draft } = get();
    if (!draft) return;
    // 元信息 + bpm 联动 targetBpm（保持 target 与练习目标同步）
    get().mutate((tab) => {
      const next = { ...tab, ...patch };
      if (patch.bpm !== undefined) {
        next.practice = { ...tab.practice, targetBpm: patch.bpm };
      }
      return next;
    });
  },

  setNote(noteId, patch) {
    const { draft } = get();
    if (!draft) return;
    get().mutate((tab) => {
      const track = { ...tab.tracks[0]! };
      const measures = track.measures.map((m) => {
        if (!m.notes.some((n) => n.id === noteId)) return m;
        return { ...m, notes: m.notes.map((n) => (n.id === noteId ? { ...n, ...patch } : n)) };
      });
      track.measures = measures;
      return { ...tab, tracks: [track, ...tab.tracks.slice(1)] };
    });
  },

  deleteNote(noteId) {
    const { draft, selection } = get();
    if (!draft) return;
    get().mutate((tab) => {
      const track = { ...tab.tracks[0]! };
      const measures = track.measures.map((m) => ({
        ...m,
        notes: m.notes.filter((n) => n.id !== noteId),
      }));
      track.measures = measures;
      return { ...tab, tracks: [track, ...tab.tracks.slice(1)] };
    });
    if (selection?.noteIds.includes(noteId)) {
      set({ selection: { measureIndex: selection.measureIndex, noteIds: [] } });
    }
  },

  setMeasureChord(measureIndex, chord) {
    get().mutate((tab) => {
      const track = { ...tab.tracks[0]! };
      const measures = track.measures.map((m) => {
        if (m.index !== measureIndex) return m;
        const at = chord.tick ?? 0;
        const others = m.chords.filter((c) => c.tick !== at);
        const next: ChordEvent = {
          tick: at,
          name: chord.name,
          diagram: chord.diagram,
          confidence: chord.confidence ?? 1,
        };
        return { ...m, chords: [...others, next].sort((a, b) => a.tick - b.tick) };
      });
      track.measures = measures;
      return { ...tab, tracks: [track, ...tab.tracks.slice(1)] };
    });
  },

  applyPattern(measureIndexes, patternId) {
    get().mutate((tab) => {
      const idxs = [...new Set(measureIndexes)].sort((a, b) => a - b);
      if (idxs.length === 0) return tab;
      const all = tab.tracks[0]!.measures.map((m) => m.index);
      if (idxs.length === all.length) {
        return regenerateAllMeasures(tab, patternId);
      }
      let next = tab;
      for (const mi of idxs) next = regenerateMeasure(next, mi, patternId);
      return next;
    });
  },

  confirmPending(ids) {
    const { draft, pending } = get();
    if (!draft || ids.length === 0) return;
    const target = new Set(ids);
    const affected = pending.filter((p) => target.has(p.id));
    if (affected.length === 0) return;
    get().mutate((tab) => {
      const track = { ...tab.tracks[0]! };
      const measures = track.measures.map((m) => {
        let notes = m.notes;
        let chords = m.chords;
        const noteIds = new Set(
          affected.filter((p) => p.kind === 'note' && p.measureIndex === m.index && p.noteId).map((p) => p.noteId!),
        );
        if (noteIds.size > 0) {
          notes = m.notes.map((n) =>
            noteIds.has(n.id) ? { ...n, confidence: Math.max(n.confidence, CONF_MID) } : n,
          );
        }
        const chordTicks = new Set(
          affected.filter((p) => p.kind === 'chord' && p.measureIndex === m.index).map((p) => Number(p.id.split(':')[2] ?? 0)),
        );
        if (chordTicks.size > 0) {
          chords = m.chords.map((c) =>
            chordTicks.has(c.tick) ? { ...c, confidence: Math.max(c.confidence, CONF_MID) } : c,
          );
        }
        return { ...m, notes, chords };
      });
      track.measures = measures;
      return { ...tab, tracks: [track, ...tab.tracks.slice(1)] };
    });
  },

  confirmAllPending() {
    const { pending } = get();
    get().confirmPending(pending.map((p) => p.id));
  },

  undo() {
    const { past, draft, future } = get();
    if (past.length === 0 || !draft) return;
    const prev = past[past.length - 1];
    const pending = derivePending(prev);
    set({
      draft: prev,
      past: past.slice(0, -1),
      future: [draft, ...future].slice(0, MAX_UNDO),
      canUndo: past.length - 1 > 0,
      canRedo: true,
      dirty: true,
      pending,
      pendingTotal: Math.max(get().pendingTotal, pending.length),
    });
    scheduleAutosave();
  },

  redo() {
    const { future, draft, past } = get();
    if (future.length === 0 || !draft) return;
    const [next, ...rest] = future;
    const pending = derivePending(next);
    set({
      draft: next,
      future: rest,
      past: [...past, draft].slice(-MAX_UNDO),
      canRedo: rest.length > 0,
      canUndo: true,
      dirty: true,
      pending,
      pendingTotal: Math.max(get().pendingTotal, pending.length),
    });
    scheduleAutosave();
  },

  async flush() {
    const { draft, origin } = get();
    if (!draft || !get().dirty) return;
    set({ saving: true });
    try {
      const next = touch(draft);
      if (origin?.kind === 'job' && origin.jobId) {
        await jobRepo.saveDraft(origin.jobId, next);
      } else if (origin?.kind === 'library' || origin?.kind === 'manual') {
        await tabRepo.put(next);
      }
      set({ draft: next, dirty: false, saving: false, lastSavedAt: nowIso() });
    } catch (err) {
      set({ saving: false });
      const msg = err instanceof Error ? err.message : String(err);
      useAppStore.getState().toast('error', `自动保存失败：${msg}`);
    }
  },

  async saveToLibrary() {
    const { draft, origin } = get();
    if (!draft) return null;
    await get().flush();
    const current = get().draft;
    if (!current) return null;

    try {
      set({ saving: true });
      const saved = await tabRepo.put(cloneTab(current));
      if (origin?.kind === 'job' && origin.jobId) {
        await jobRepo.deleteDraft(origin.jobId);
        await jobRepo.deleteAudioBlob(origin.jobId);
        await jobRepo.patch(origin.jobId, { status: 'archived', resultTabId: saved.id });
      }
      set({
        draft: cloneTab(saved),
        origin: { kind: 'library', tabId: saved.id },
        dirty: false,
        saving: false,
        lastSavedAt: nowIso(),
      });
      useAppStore.getState().toast('success', `《${saved.title}》已入库`);
      return saved;
    } catch (err) {
      set({ saving: false });
      const msg = err instanceof Error ? err.message : String(err);
      useAppStore.getState().toast('error', `入库失败：${msg}`);
      return null;
    }
  },

  discard() {
    set({
      draft: null,
      origin: null,
      pending: [],
      pendingTotal: 0,
      past: [],
      future: [],
      canUndo: false,
      canRedo: false,
      dirty: false,
      saving: false,
      lastSavedAt: null,
      selection: null,
    });
  },
}));

function scheduleAutosave(): void {
  if (typeof window === 'undefined') return;
  if (autosaveTimer !== null) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    autosaveTimer = null;
    void useEditorStore.getState().flush();
  }, AUTOSAVE_MS);
}

/** 编辑器元信息补全：把草稿变成一份可直接入库的 Tab（补 track 数量等） */
export function finalizeTab(tab: Tab): Tab {
  return { ...cloneTab(tab), updatedAt: nowIso() };
}

export { newId };
