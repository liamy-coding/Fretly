/**
 * 谱库 Store（T-16）：曲目索引 + 歌单 + 搜索/筛选/排序纯逻辑。
 *
 * 数据源：IndexedDB（tabs / collections）。列表层用轻量 TabMeta，详情由页面按需 get。
 * 搜索/筛选/排序全部客户端计算（无网络请求）；纯函数可单测。
 */
import { create } from 'zustand';
import type { CollId, Collection } from '@/types/app';
import type { Difficulty, KeyName, SourceType, Tab, TabId, TimeSignature } from '@/types/tab';
import { tabRepo } from '@/storage/tabRepo';
import { useAppStore } from '@/state/useAppStore';

export type LibrarySort = 'recent' | 'added' | 'mastery' | 'difficulty' | 'bpm';
export type CollectionScope =
  | { kind: 'all' }
  | { kind: 'recent' }
  | { kind: 'builtin' }
  | { kind: 'collection'; id: string };

export interface LibraryFilters {
  keys: KeyName[];
  difficulties: Difficulty[];
  /** [min, max] BPM 区间 */
  bpm: [number, number];
  sources: SourceType[];
  /** 拍号（便捷筛选） */
  timeSignatures: TimeSignature[];
}

export const DEFAULT_FILTERS: LibraryFilters = {
  keys: [],
  difficulties: [],
  bpm: [40, 240],
  sources: [],
  timeSignatures: [],
};

// ── 纯逻辑（可单测）───────────────────────────────────────────────
export function metaSearchable(meta: Pick<Tab, 'title' | 'artist' | 'tags'>): string {
  return [meta.title, meta.artist, ...(meta.tags ?? [])].join(' ').toLowerCase();
}

export function searchMatches(meta: Tab['title'], term: string): boolean {
  return meta.toLowerCase().includes(term.toLowerCase());
}

export function applyFilters(
  metas: readonly (TabMetaLike & { timeSignature?: TimeSignature })[],
  f: LibraryFilters,
  term: string,
): typeof metas {
  const q = term.trim().toLowerCase();
  const diffOf = (m: { difficulty: Difficulty; difficultyOverride: Difficulty | null }): Difficulty =>
    m.difficultyOverride ?? m.difficulty;

  return metas.filter((m) => {
    if (q.length >= 2 && !metaSearchable(m as unknown as Tab).includes(q)) return false;
    if (f.keys.length > 0 && !f.keys.includes(m.key)) return false;
    if (f.difficulties.length > 0 && !f.difficulties.includes(diffOf(m))) return false;
    if (m.bpm < f.bpm[0] || m.bpm > f.bpm[1]) return false;
    if (f.sources.length > 0 && !f.sources.includes(m.source.type)) return false;
    if (
      f.timeSignatures.length > 0 &&
      m.timeSignature &&
      !f.timeSignatures.some((t) => t[0] === m.timeSignature![0] && t[1] === m.timeSignature![1])
    ) {
      return false;
    }
    return true;
  });
}

export type TabMetaLike = {
  id: TabId;
  title: string;
  artist: string;
  key: KeyName;
  bpm: number;
  timeSignature: TimeSignature;
  difficulty: Difficulty;
  difficultyOverride: Difficulty | null;
  source: { type: SourceType };
  tags: string[];
  mastery: number;
  lastPracticedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export function applySort(metas: readonly TabMetaLike[], sort: LibrarySort): TabMetaLike[] {
  const arr = [...metas];
  switch (sort) {
    case 'added':
      return arr.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    case 'mastery':
      return arr.sort((a, b) => b.mastery - a.mastery || b.updatedAt.localeCompare(a.updatedAt));
    case 'difficulty':
      return arr.sort(
        (a, b) =>
          (a.difficultyOverride ?? a.difficulty) - (b.difficultyOverride ?? b.difficulty) ||
          b.updatedAt.localeCompare(a.updatedAt),
      );
    case 'bpm':
      return arr.sort((a, b) => a.bpm - b.bpm || b.updatedAt.localeCompare(a.updatedAt));
    case 'recent':
    default:
      // 有练习记录按 lastPracticedAt 倒序在前；无记录的按 createdAt 倒序在后
      return arr.sort((a, b) => {
        const aHas = a.lastPracticedAt ? 1 : 0;
        const bHas = b.lastPracticedAt ? 1 : 0;
        if (aHas !== bHas) return bHas - aHas;
        const key = (x: TabMetaLike) => x.lastPracticedAt ?? x.createdAt;
        return key(b).localeCompare(key(a));
      });
  }
}

// ── Store ─────────────────────────────────────────────────────────
interface LibraryState {
  metas: TabMetaLike[];
  collections: Collection[];
  loaded: boolean;
  loading: boolean;
  search: string;
  filters: LibraryFilters;
  sort: LibrarySort;
  scope: CollectionScope;

  reload(): Promise<void>;
  loadMeta(id: TabId): Promise<Tab | undefined>;
  addTab(tab: Tab): Promise<void>;
  removeTab(id: TabId): Promise<void>;
  updateTab(tab: Tab): Promise<void>;

  setSearch(term: string): void;
  setFilters(patch: Partial<LibraryFilters>): void;
  resetFilters(): void;
  setSort(sort: LibrarySort): void;
  setScope(scope: CollectionScope): void;

  createCollection(name: string): Promise<Collection | null>;
  renameCollection(id: CollId, name: string): Promise<void>;
  deleteCollection(id: CollId): Promise<void>;
  addToCollection(collectionId: CollId, tabId: TabId): Promise<void>;
  removeFromCollection(collectionId: CollId, tabId: TabId): Promise<void>;
}

export const useLibraryStore = create<LibraryState>((set, get) => ({
  metas: [],
  collections: [],
  loaded: false,
  loading: false,
  search: '',
  filters: DEFAULT_FILTERS,
  sort: 'recent',
  scope: { kind: 'all' },

  async reload() {
    set({ loading: true });
    try {
      const [metas, collections] = await Promise.all([tabRepo.list(), tabRepo.collections()]);
      set({ metas, collections, loaded: true, loading: false });
    } catch (err) {
      set({ loading: false });
      const msg = err instanceof Error ? err.message : String(err);
      useAppStore.getState().toast('error', `读取谱库失败：${msg}`);
    }
  },

  async loadMeta(id) {
    return tabRepo.get(id);
  },

  async addTab(tab) {
    await tabRepo.put(tab);
    await get().reload();
    useAppStore.getState().toast('success', `已导入《${tab.title}》`);
  },

  async removeTab(id) {
    const meta = get().metas.find((m) => m.id === id);
    await tabRepo.remove(id);
    await get().reload();
    useAppStore.getState().toast('success', `已删除《${meta?.title ?? '曲目'}》`);
  },

  async updateTab(tab) {
    await tabRepo.put(tab);
    await get().reload();
  },

  setSearch(search) {
    set({ search });
  },

  setFilters(patch) {
    set({ filters: { ...get().filters, ...patch } });
  },

  resetFilters() {
    set({ filters: DEFAULT_FILTERS });
  },

  setSort(sort) {
    set({ sort });
  },

  setScope(scope) {
    set({ scope });
  },

  async createCollection(name) {
    const trimmed = name.trim();
    if (!trimmed) {
      useAppStore.getState().toast('error', '歌单名称不能为空');
      return null;
    }
    if (get().collections.some((c) => c.name === trimmed)) {
      useAppStore.getState().toast('error', '已有同名歌单');
      return null;
    }
    const collection = await tabRepo.createCollection(trimmed);
    await get().reload();
    set({ scope: { kind: 'collection', id: collection.id } });
    return collection;
  },

  async renameCollection(id, name) {
    const trimmed = name.trim();
    const collection = get().collections.find((c) => c.id === id);
    if (!collection || !trimmed) return;
    if (get().collections.some((c) => c.id !== id && c.name === trimmed)) {
      useAppStore.getState().toast('error', '已有同名歌单');
      return;
    }
    await tabRepo.putCollection({ ...collection, name: trimmed });
    await get().reload();
  },

  async deleteCollection(id) {
    await tabRepo.removeCollection(id);
    await get().reload();
    set({ scope: { kind: 'all' } });
  },

  async addToCollection(collectionId, tabId) {
    await tabRepo.addToCollection(collectionId, tabId);
    await get().reload();
  },

  async removeFromCollection(collectionId, tabId) {
    await tabRepo.removeFromCollection(collectionId, tabId);
    await get().reload();
  },
}));
