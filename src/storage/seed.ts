/**
 * 首次播种与数据导出 / 清空（PRD A-08 / US-25，架构 T-11）。
 * 内置 4 首由 buildTabFromChordChart 现算，不存手写 JSON。
 */
import type { Tab } from '@/types/tab';
import type { Collection, PracticeSession, Settings, TranscriptionJob } from '@/types/app';
import { BUILTIN_SONGS } from '@/data/builtinSongs';
import { buildTabFromChordChart } from '@/core/tabFactory';
import { nowIso } from '@/core/constants';
import { clearStore, getAllRecords, loadSettings, ls, saveSettings } from '@/storage/db';
import { tabRepo } from '@/storage/tabRepo';
import { jobRepo } from '@/storage/jobRepo';

const SEEDED_KEY = 'seeded';

export function isSeeded(): boolean {
  return loadSettings().seeded || ls.get(SEEDED_KEY) === 'true';
}

export function markSeeded(): void {
  ls.set(SEEDED_KEY, 'true');
  saveSettings({ ...loadSettings(), seeded: true });
}

/** 生成 4 首内置曲（纯，可单测） */
export function buildBuiltinTabs(): Tab[] {
  return BUILTIN_SONGS.map((spec) => buildTabFromChordChart(spec));
}

/** 首次访问播种；已播种则直接返回 false。刷新不重复播种。 */
export async function seedBuiltinSongs(): Promise<boolean> {
  if (isSeeded()) return false;
  const existing = await tabRepo.list();
  if (existing.length > 0) {
    // 曲库非空说明用户已清空过或手动导入过，只打标记不再补种
    markSeeded();
    return false;
  }
  for (const tab of buildBuiltinTabs()) {
    await tabRepo.put(tab);
  }
  markSeeded();
  return true;
}

export interface AllDataExport {
  schema: 'fretly.backup';
  exportedAt: string;
  settings: Settings;
  tabs: Tab[];
  collections: Collection[];
  sessions: PracticeSession[];
  jobs: TranscriptionJob[];
}

/** 导出全部数据（设置页「导出全部数据（JSON）」） */
export async function exportAllData(): Promise<AllDataExport> {
  return {
    schema: 'fretly.backup',
    exportedAt: nowIso(),
    settings: loadSettings(),
    tabs: await getAllRecords('tabs'),
    collections: await getAllRecords('collections'),
    sessions: await getAllRecords('sessions'),
    jobs: await getAllRecords('jobs'),
  };
}

/** 清空本地数据（需输入 DELETE 二次确认，由 UI 校验后调用） */
export async function clearAllData(): Promise<void> {
  for (const store of ['tabs', 'collections', 'sessions', 'jobs', 'drafts', 'audios'] as const) {
    await clearStore(store);
  }
  ls.remove(SEEDED_KEY);
  ls.remove('disclaimerAcked');
  ls.remove('ui.libraryView');
  saveSettings({ ...loadSettings(), seeded: false, disclaimerAcked: false });
}

/** 重播种（清空后「试玩内置示范曲」用） */
export async function reseed(): Promise<void> {
  ls.remove(SEEDED_KEY);
  await seedBuiltinSongs();
}

export { jobRepo };
