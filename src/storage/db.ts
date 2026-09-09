/**
 * IndexedDB（idb 封装）+ localStorage（架构 §9.6 / T-11）。
 *
 * stores：tabs / audios / drafts / sessions / jobs / collections
 * localStorage（前缀 `fretly.`）：settings、seeded、disclaimerAcked、ui.*
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { JobId, Tab, TabId } from '@/types/tab';
import type { Collection, PracticeSession, Settings, TranscriptionJob } from '@/types/app';
import {
  AppError,
  DB_NAME,
  DB_VERSION,
  ERROR_CODES,
  STORAGE_PREFIX,
  clamp,
} from '@/core/constants';

export interface DraftRecord {
  jobId: JobId;
  tab: Tab;
  updatedAt: string;
}

export interface AudioRecord {
  jobId: JobId;
  /** 入库成功后置 null，只保留 peaks */
  blob: Blob | null;
  peaks: [number, number][];
  updatedAt: string;
}

export interface FretlySchema extends DBSchema {
  tabs: { key: string; value: Tab; indexes: { byUpdated: string } };
  collections: { key: string; value: Collection };
  sessions: { key: string; value: PracticeSession; indexes: { byTab: string; byDate: string } };
  jobs: { key: string; value: TranscriptionJob; indexes: { byUpdated: string } };
  drafts: { key: string; value: DraftRecord };
  audios: { key: string; value: AudioRecord };
}

let dbPromise: Promise<IDBPDatabase<FretlySchema>> | null = null;

export function isIndexedDbAvailable(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
  } catch {
    return false;
  }
}

export function openFretlyDb(): Promise<IDBPDatabase<FretlySchema>> {
  if (!isIndexedDbAvailable()) {
    return Promise.reject(new AppError(ERROR_CODES.E_STORAGE_UNAVAILABLE, 'IndexedDB 不可用'));
  }
  if (dbPromise) return dbPromise;

  dbPromise = openDB<FretlySchema>(DB_NAME, DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains('tabs')) {
        const tabs = db.createObjectStore('tabs', { keyPath: 'id' });
        tabs.createIndex('byUpdated', 'updatedAt');
      }
      if (!db.objectStoreNames.contains('collections')) {
        db.createObjectStore('collections', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('sessions')) {
        const sessions = db.createObjectStore('sessions', { keyPath: 'id' });
        sessions.createIndex('byTab', 'tabId');
        sessions.createIndex('byDate', 'startedAt');
      }
      if (!db.objectStoreNames.contains('jobs')) {
        const jobs = db.createObjectStore('jobs', { keyPath: 'id' });
        jobs.createIndex('byUpdated', 'updatedAt');
      }
      if (!db.objectStoreNames.contains('drafts')) {
        db.createObjectStore('drafts', { keyPath: 'jobId' });
      }
      if (!db.objectStoreNames.contains('audios')) {
        db.createObjectStore('audios', { keyPath: 'jobId' });
      }
    },
    blocked() {
      console.warn('[fretly:db] 数据库被其它标签页占用，请关闭后重试');
    },
    blocking() {
      console.warn('[fretly:db] 本标签页正在阻塞数据库升级');
    },
  });

  return dbPromise;
}

/** 供测试与"清空数据"使用：丢弃连接缓存 */
export function resetDbHandle(): void {
  dbPromise = null;
}

// ── 通用 CRUD ─────────────────────────────────────────────────────
type StoreName = 'tabs' | 'collections' | 'sessions' | 'jobs' | 'drafts' | 'audios';

/** idb 的 ObjectStore 联合类型在泛型下难以收窄，这里用最小接口收口 */
interface MinimalStore {
  put(value: unknown): IDBRequest<IDBValidKey>;
  get(key: IDBValidKey): IDBRequest<unknown>;
  delete(key: IDBValidKey): IDBRequest<undefined>;
  getAll(): IDBRequest<unknown[]>;
  getAllKeys(): IDBRequest<IDBValidKey[]>;
  clear(): IDBRequest<undefined>;
}

async function tx<T>(
  store: StoreName,
  mode: IDBTransactionMode,
  fn: (s: MinimalStore) => Promise<T> | T,
): Promise<T> {
  const db = await openFretlyDb();
  const t = db.transaction(store, mode);
  const result = await fn(t.store as unknown as MinimalStore);
  await t.done;
  return result;
}

export async function putRecord<K extends StoreName>(
  store: K,
  value: FretlySchema[K]['value'],
): Promise<void> {
  await tx(store, 'readwrite', (s) => s.put(value));
}

export async function getRecord<K extends StoreName>(
  store: K,
  key: IDBValidKey,
): Promise<FretlySchema[K]['value'] | undefined> {
  const raw = await tx(store, 'readonly', (s) => s.get(key));
  return raw as unknown as FretlySchema[K]['value'] | undefined;
}

export async function deleteRecord(store: StoreName, key: IDBValidKey): Promise<void> {
  await tx(store, 'readwrite', (s) => s.delete(key));
}

export async function getAllRecords<K extends StoreName>(
  store: K,
): Promise<FretlySchema[K]['value'][]> {
  const raw = await tx(store, 'readonly', (s) => s.getAll());
  return raw as unknown as FretlySchema[K]['value'][];
}

export async function getAllKeys(store: StoreName): Promise<IDBValidKey[]> {
  const raw = await tx(store, 'readonly', (s) => s.getAllKeys());
  return raw as unknown as IDBValidKey[];
}

export async function clearStore(store: StoreName): Promise<void> {
  await tx(store, 'readwrite', (s) => s.clear());
}

/** 删除曲目：谱面本体 + 所有歌单里的引用（历史会话保留，档案页置灰） */
export async function deleteTabEverywhere(tabId: TabId): Promise<void> {
  await deleteRecord('tabs', tabId);
  const collections = await getAllRecords('collections');
  for (const collection of collections) {
    if (!collection.tabIds.includes(tabId)) continue;
    await putRecord('collections', {
      ...collection,
      tabIds: collection.tabIds.filter((id) => id !== tabId),
    });
  }
}

// ── localStorage ──────────────────────────────────────────────────
function hasLocalStorage(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage !== null;
  } catch {
    return false;
  }
}

export const ls = {
  get(key: string, fallback = ''): string {
    if (!hasLocalStorage()) return fallback;
    try {
      return localStorage.getItem(STORAGE_PREFIX + key) ?? fallback;
    } catch {
      return fallback;
    }
  },
  set(key: string, value: string): void {
    if (!hasLocalStorage()) return;
    try {
      localStorage.setItem(STORAGE_PREFIX + key, value);
    } catch {
      console.warn('[fretly:db] localStorage 写入失败');
    }
  },
  getJson<T>(key: string, fallback: T): T {
    const raw = ls.get(key);
    if (!raw) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  },
  setJson(key: string, value: unknown): void {
    ls.set(key, JSON.stringify(value));
  },
  remove(key: string): void {
    if (!hasLocalStorage()) return;
    try {
      localStorage.removeItem(STORAGE_PREFIX + key);
    } catch {
      /* 忽略 */
    }
  },
};

// ── Settings ──────────────────────────────────────────────────────
export const DEFAULT_SETTINGS: Settings = {
  libraryView: 'grid',
  defaultStartRatio: 0.6,
  defaultStep: 5,
  defaultPassRounds: 2,
  defaultTargetRatio: 1,
  metronome: { enabled: true, subdivision: '1/4', countIn: false, voice: false },
  demoTrack: { enabled: true, volume: 0.8 },
  showFingerNumbers: false,
  seeded: false,
  disclaimerAcked: false,
};

const SETTINGS_KEY = 'settings';
let settingsCache: Settings | null = null;
const settingsListeners = new Set<(s: Settings) => void>();

export function loadSettings(): Settings {
  if (settingsCache) return settingsCache;
  const stored = ls.getJson<Partial<Settings>>(SETTINGS_KEY, {});
  const merged: Settings = {
    ...DEFAULT_SETTINGS,
    ...stored,
    metronome: { ...DEFAULT_SETTINGS.metronome, ...(stored.metronome ?? {}) },
    demoTrack: { ...DEFAULT_SETTINGS.demoTrack, ...(stored.demoTrack ?? {}) },
  };
  merged.defaultStartRatio = clamp(merged.defaultStartRatio, 0.3, 1);
  merged.defaultTargetRatio = clamp(merged.defaultTargetRatio, 0.5, 2);
  settingsCache = merged;
  return merged;
}

export function saveSettings(next: Settings): void {
  settingsCache = next;
  ls.setJson(SETTINGS_KEY, next);
  for (const cb of settingsListeners) cb(next);
}

export function patchSettings(patch: Partial<Settings>): Settings {
  const next: Settings = { ...loadSettings(), ...patch };
  saveSettings(next);
  return next;
}

export function onSettingsChange(cb: (s: Settings) => void): () => void {
  settingsListeners.add(cb);
  return () => settingsListeners.delete(cb);
}

/** 跨标签页：另一标签页写了 localStorage 时提示刷新（PRD §4.1 边界条件） */
export function watchExternalChange(cb: (key: string) => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const handler = (e: StorageEvent) => {
    if (e.key && e.key.startsWith(STORAGE_PREFIX)) cb(e.key.slice(STORAGE_PREFIX.length));
  };
  window.addEventListener('storage', handler);
  return () => window.removeEventListener('storage', handler);
}
