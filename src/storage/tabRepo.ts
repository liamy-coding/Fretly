/**
 * TabRepository 实现（架构 §4.4 / T-11）。
 * 所有写操作统一 bump revision 与 updatedAt；删除曲目时同步从歌单移除。
 */
import type { PracticeStats, Tab, TabId } from '@/types/tab';
import type { Collection, CollId, PracticeSession, TabMeta, TabRepository } from '@/types/app';
import { MAX_TABS, nowIso } from '@/core/constants';
import { newId } from '@/core/id';
import {
  deleteRecord,
  deleteTabEverywhere,
  getAllRecords,
  getRecord,
  putRecord,
} from '@/storage/db';

export function toMeta(tab: Tab): TabMeta {
  return {
    id: tab.id,
    title: tab.title,
    artist: tab.artist,
    key: tab.key,
    bpm: tab.bpm,
    timeSignature: tab.timeSignature,
    difficulty: tab.difficulty,
    difficultyOverride: tab.difficultyOverride,
    source: tab.source,
    tags: tab.tags,
    mastery: tab.practice.mastery,
    lastPracticedAt: tab.practice.lastPracticedAt,
    createdAt: tab.createdAt,
    updatedAt: tab.updatedAt,
  };
}

class IdbTabRepository implements TabRepository {
  async list(): Promise<TabMeta[]> {
    const tabs = await getAllRecords('tabs');
    return tabs.map(toMeta);
  }

  async get(id: TabId): Promise<Tab | undefined> {
    return getRecord('tabs', id);
  }

  async put(tab: Tab): Promise<Tab> {
    const now = nowIso();
    const next: Tab = { ...tab, revision: tab.revision + 1, updatedAt: now };
    await putRecord('tabs', next);
    return next;
  }

  async remove(id: TabId): Promise<void> {
    await deleteTabEverywhere(id);
  }

  async count(): Promise<number> {
    return (await getAllRecords('tabs')).length;
  }

  async canImport(): Promise<boolean> {
    return (await this.count()) < MAX_TABS;
  }

  async patchPractice(id: TabId, patch: Partial<PracticeStats>): Promise<void> {
    const tab = await this.get(id);
    if (!tab) return;
    const next: Tab = {
      ...tab,
      practice: { ...tab.practice, ...patch },
      revision: tab.revision + 1,
      updatedAt: nowIso(),
    };
    await putRecord('tabs', next);
  }

  async collections(): Promise<Collection[]> {
    return getAllRecords('collections');
  }

  async putCollection(c: Collection): Promise<void> {
    await putRecord('collections', c);
  }

  async createCollection(name: string): Promise<Collection> {
    const collection: Collection = {
      id: newId('col'),
      name,
      tabIds: [],
      createdAt: nowIso(),
    };
    await putRecord('collections', collection);
    return collection;
  }

  async removeCollection(id: CollId): Promise<void> {
    await deleteRecord('collections', id);
  }

  async addToCollection(id: CollId, tabId: TabId): Promise<void> {
    const collection = await getRecord('collections', id);
    if (!collection || collection.tabIds.includes(tabId)) return;
    await putRecord('collections', { ...collection, tabIds: [...collection.tabIds, tabId] });
  }

  async removeFromCollection(id: CollId, tabId: TabId): Promise<void> {
    const collection = await getRecord('collections', id);
    if (!collection) return;
    await putRecord('collections', {
      ...collection,
      tabIds: collection.tabIds.filter((t) => t !== tabId),
    });
  }

  async listSessions(from?: string, to?: string): Promise<PracticeSession[]> {
    const all = await getAllRecords('sessions');
    return all
      .filter((s) => {
        if (from && s.startedAt < from) return false;
        if (to && s.startedAt > to) return false;
        return true;
      })
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  async putSession(s: PracticeSession): Promise<void> {
    await putRecord('sessions', s);
  }
}

export const tabRepo: TabRepository & {
  count(): Promise<number>;
  canImport(): Promise<boolean>;
  createCollection(name: string): Promise<Collection>;
  addToCollection(id: CollId, tabId: TabId): Promise<void>;
  removeFromCollection(id: CollId, tabId: TabId): Promise<void>;
} = new IdbTabRepository();
