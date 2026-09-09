/**
 * 谱库页（架构 §2.10-49，T-20）：曲目网格/列表、搜索/筛选/排序、歌单侧栏、导入；
 * 同文件提供 TabDetailPage（/tab/:id 元信息编辑/导出/删除/重置/歌单）。
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { applyFilters, applySort, type LibrarySort } from '@/state/useLibraryStore';
import { useLibraryStore } from '@/state/useLibraryStore';
import { useAppStore } from '@/state/useAppStore';
import { tabRepo } from '@/storage/tabRepo';
import { exportAscii, exportJson, exportPdf, tabToAscii, tabToJson } from '@/io/exporters';
import { importerById } from '@/io/importers';
import type { Tab, TabId } from '@/types/tab';
import type { Collection } from '@/types/app';
import type { TabMetaLike } from '@/state/useLibraryStore';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  DifficultyDots,
  EmptyState,
  Field,
  Icon,
  Modal,
  Segmented,
  Select,
  Spinner,
  TextField,
  cn,
} from '@/ui/kit';
import { emptyPractice } from '@/core/tabFactory';
import { nowIso } from '@/core/constants';

const KEY_OPTIONS = [
  'C', 'G', 'D', 'A', 'E', 'B', 'F#', 'Gb', 'Db', 'Ab', 'Eb', 'Bb', 'F',
  'Am', 'Em', 'Bm', 'F#m', 'C#m', 'G#m', 'D#m', 'A#m', 'Fm', 'Cm', 'Gm', 'Dm',
];

function sourceBadge(s: Tab['source']) {
  switch (s.type) {
    case 'builtin':
      return <Badge>内置</Badge>;
    case 'transcribed':
      return <Badge tone="amber">扒谱 · 待校对</Badge>;
    case 'imported':
      return <Badge tone="brand">导入</Badge>;
    default:
      return <Badge tone="success">手写</Badge>;
  }
}

function MasteryPill({ mastery }: { mastery: number }) {
  const tier =
    mastery >= 90 ? 'bg-yellow-100 text-yellow-700' : mastery >= 70 ? 'bg-green-100 text-green-700' : mastery >= 40 ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-500';
  return <span className={cn('rounded-full px-2 py-0.5 text-xs font-semibold', tier)}>{mastery}</span>;
}

// ── 主页面 ────────────────────────────────────────────────────────
export default function LibraryPage() {
  const navigate = useNavigate();
  const store = useLibraryStore();
  const viewMode = useAppStore((s) => s.settings.libraryView);
  const patch = useAppStore((s) => s.patchSettings);
  const [showImport, setShowImport] = useState(false);

  useEffect(() => {
    void store.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const visible = useMemo(() => {
    let metas: readonly TabMetaLike[] = store.metas;
    const scope = store.scope;
    if (scope.kind === 'collection') {
      const col = store.collections.find((c) => c.id === scope.id);
      if (col) {
        const ids = new Set(col.tabIds);
        metas = metas.filter((m) => ids.has(m.id));
      } else {
        metas = [];
      }
    } else if (scope.kind === 'builtin') {
      metas = metas.filter((m) => m.source.type === 'builtin');
    } else if (scope.kind === 'recent') {
      metas = metas.filter((m) => m.lastPracticedAt);
    }
    metas = applyFilters(metas, store.filters, store.search);
    return applySort(metas, store.sort);
  }, [store.metas, store.scope, store.collections, store.filters, store.search, store.sort]);

  const activeColId = store.scope.kind === 'collection' ? (store.scope as { id: string }).id : null;

  return (
    <div className="flex gap-4 p-4 pb-24">
      {/* 侧栏 */}
      <aside className="hidden w-44 shrink-0 flex-col gap-1 md:flex">
        <NavItem icon="library" label="全部曲谱" active={store.scope.kind === 'all'} onClick={() => store.setScope({ kind: 'all' })} />
        <NavItem icon="dashboard" label="最近练习" active={store.scope.kind === 'recent'} onClick={() => store.setScope({ kind: 'recent' })} />
        <NavItem icon="grid" label="内置示范" active={store.scope.kind === 'builtin'} onClick={() => store.setScope({ kind: 'builtin' })} />
        <div className="my-2 border-t border-line" />
        <div className="flex items-center justify-between px-1">
          <span className="text-xs font-semibold text-ink-soft">歌单</span>
          <button
            type="button"
            aria-label="新建歌单"
            className="text-ink-soft hover:text-brand"
            onClick={() => {
              const name = window.prompt('歌单名称');
              if (name) void store.createCollection(name);
            }}
          >
            <Icon name="plus" size={14} />
          </button>
        </div>
        {store.collections.map((c) => (
          <NavItem
            key={c.id}
            icon="list"
            label={`${c.name} (${c.tabIds.length})`}
            active={activeColId === c.id}
            onClick={() => store.setScope({ kind: 'collection', id: c.id })}
            onDelete={
              c.tabIds.length === 0
                ? () => void store.deleteCollection(c.id)
                : undefined
            }
          />
        ))}
        {store.collections.length === 0 && <p className="px-1 text-xs text-gray-400">还没有歌单</p>}
      </aside>

      {/* 主体 */}
      <main className="min-w-0 flex-1 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="mr-auto text-lg font-bold">谱库</h1>
          <div className="relative">
            <Icon name="search" size={16} className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400" />
            <TextField
              className="pl-7"
              placeholder="搜索标题 / 艺人 / 标签"
              value={store.search}
              onChange={(e) => store.setSearch(e.target.value)}
            />
          </div>
          <Segmented
            value={viewMode}
            onChange={(v) => patch({ libraryView: v })}
            options={[
              { value: 'grid', label: <Icon name="grid" size={15} /> },
              { value: 'list', label: <Icon name="list" size={15} /> },
            ]}
          />
          <Select<LibrarySort>
            value={store.sort}
            onChange={(v) => store.setSort(v)}
            options={[
              { value: 'recent', label: '最近练习' },
              { value: 'added', label: '最近添加' },
              { value: 'mastery', label: '熟练度' },
              { value: 'difficulty', label: '难度' },
              { value: 'bpm', label: 'BPM' },
            ]}
          />
          <Button icon="upload" onClick={() => setShowImport(true)}>
            导入
          </Button>
        </div>

        {/* 筛选条 */}
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <select
            className="rounded-lg border border-line bg-surface px-2 py-1.5 text-xs text-ink"
            value=""
            onChange={(e) => {
              const v = e.target.value;
              if (!v) return;
              if (v === '__clear') {
                store.setFilters({ keys: [] });
                return;
              }
              const cur = store.filters.keys;
              store.setFilters({ keys: cur.includes(v as never) ? cur.filter((k) => k !== v) : [...cur, v as never] });
            }}
          >
            <option value="" disabled>
              {store.filters.keys.length ? `调性 ${store.filters.keys.length}` : '调性'}
            </option>
            {store.filters.keys.length > 0 && <option value="__clear">清除调性筛选</option>}
            {KEY_OPTIONS.filter((k) => !store.filters.keys.includes(k as never)).map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
          <select
            className="rounded-lg border border-line bg-surface px-2 py-1.5 text-xs text-ink"
            value=""
            onChange={(e) => {
              const v = e.target.value;
              if (!v) return;
              if (v === '__clear') {
                store.setFilters({ difficulties: [] });
                return;
              }
              const d = Number(v) as 1 | 2 | 3 | 4 | 5;
              const cur = store.filters.difficulties;
              store.setFilters({ difficulties: cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d] });
            }}
          >
            <option value="" disabled>
              {store.filters.difficulties.length ? `难度 ${store.filters.difficulties.length}` : '难度'}
            </option>
            {store.filters.difficulties.length > 0 && <option value="__clear">清除难度筛选</option>}
            {['1', '2', '3', '4', '5'].map((d) => (
              <option key={d} value={d}>
                {d} 级
              </option>
            ))}
          </select>
          {(store.filters.keys.length > 0 || store.filters.difficulties.length > 0 || store.search) && (
            <button
              type="button"
              className="text-brand hover:underline"
              onClick={() => {
                store.resetFilters();
                store.setSearch('');
              }}
            >
              清除筛选
            </button>
          )}
        </div>

        {store.loading && store.metas.length === 0 ? (
          <div className="flex justify-center py-16">
            <Spinner />
          </div>
        ) : visible.length === 0 ? (
          <EmptyState
            icon="library"
            title="这里还没有曲谱"
            desc="导入你的第一份 Guitar Tab，或从右侧歌单查看内容。首次启动会自动预装 4 首内置示范曲。"
          >
            <Button icon="upload" onClick={() => setShowImport(true)} className="mt-2">
              导入曲谱
            </Button>
          </EmptyState>
        ) : (
          <div className={cn('grid gap-3', viewMode === 'grid' ? 'grid-cols-1 sm:grid-cols-2 xl:grid-cols-3' : 'grid-cols-1')}>
            {visible.map((m) =>
              viewMode === 'grid' ? (
                <Card key={m.id} className="flex flex-col gap-2 p-3 hover:shadow-md">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h3 className="truncate font-semibold">{m.title}</h3>
                      <p className="truncate text-xs text-ink-soft">{m.artist}</p>
                    </div>
                    {sourceBadge(m.source as Tab['source'])}
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-ink-soft">
                    <span>♩ {m.bpm}</span>
                    <span>{m.timeSignature[0]}/{m.timeSignature[1]}</span>
                    <span>{m.key}</span>
                    <DifficultyDots value={m.difficultyOverride ?? m.difficulty} />
                    <span className="ml-auto">
                      <MasteryPill mastery={m.mastery} />
                    </span>
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" className="flex-1" icon="practice" onClick={() => navigate(`/practice/${m.id}`)}>
                      练习
                    </Button>
                    <Button size="sm" variant="outline" className="flex-1" onClick={() => navigate(`/tab/${m.id}`)}>
                      详情
                    </Button>
                  </div>
                </Card>
              ) : (
                <Card key={m.id} className="flex items-center gap-3 p-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-semibold">{m.title}</span>
                      <span className="truncate text-xs text-ink-soft">{m.artist}</span>
                    </div>
                    <div className="mt-1 flex items-center gap-2 text-xs text-ink-soft">
                      {sourceBadge(m.source as Tab['source'])}
                      <span>♩ {m.bpm}</span>
                      <span>{m.key}</span>
                      <DifficultyDots value={m.difficultyOverride ?? m.difficulty} />
                    </div>
                  </div>
                  <MasteryPill mastery={m.mastery} />
                  <Button size="sm" variant="outline" onClick={() => navigate(`/tab/${m.id}`)}>
                    详情
                  </Button>
                  <Button size="sm" icon="practice" onClick={() => navigate(`/practice/${m.id}`)}>
                    练习
                  </Button>
                </Card>
              ),
            )}
          </div>
        )}
      </main>

      <ImportModal open={showImport} onClose={() => setShowImport(false)} onImported={(tab) => { navigate(`/tab/${tab.id}`); }} />
    </div>
  );
}

function NavItem({
  icon,
  label,
  active,
  onClick,
  onDelete,
}: {
  icon: 'library' | 'dashboard' | 'grid' | 'list';
  label: string;
  active: boolean;
  onClick: () => void;
  onDelete?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group flex items-center justify-between gap-1 rounded-lg px-2 py-1.5 text-left text-sm',
        active ? 'bg-brand-soft font-medium text-brand' : 'text-ink-soft hover:bg-black/5 hover:text-ink',
      )}
    >
      <span className="inline-flex items-center gap-1.5">
        <Icon name={icon} size={15} />
        <span className="truncate">{label}</span>
      </span>
      {onDelete && (
        <span
          role="button"
          tabIndex={0}
          className="opacity-0 group-hover:opacity-100 hover:text-red-600"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.stopPropagation();
              onDelete();
            }
          }}
        >
          <Icon name="trash" size={13} />
        </span>
      )}
    </button>
  );
}

// ── 导入弹窗 ──────────────────────────────────────────────────────
function ImportModal({ open, onClose, onImported }: { open: boolean; onClose: () => void; onImported: (tab: Tab) => void }) {
  const addTab = useLibraryStore((s) => s.addTab);
  const toast = useAppStore((s) => s.toast);
  const [kind, setKind] = useState<'json' | 'musicxml' | 'ascii'>('json');
  const [file, setFile] = useState<File | null>(null);
  const [text, setText] = useState('');
  const [parsing, setParsing] = useState(false);

  const doImport = async () => {
    const importer = importerById(kind);
    if (!importer) return;
    setParsing(true);
    try {
      let result;
      if (importer.fromText) {
        if (!text.trim()) {
          toast('warn', '请粘贴 ASCII 谱内容');
          return;
        }
        result = await importer.parse(text);
      } else {
        if (!file) {
          toast('warn', '请选择文件');
          return;
        }
        result = await importer.parse(file);
      }
      if (!result.ok || !result.tab) {
        toast('error', result.reason ?? '解析失败');
        return;
      }
      if (result.partial) toast('info', `部分解析：成功 ${result.parsedMeasures} 小节`);
      await addTab(result.tab);
      onImported(result.tab);
      onClose();
    } catch (err) {
      toast('error', err instanceof Error ? err.message : '导入失败');
    } finally {
      setParsing(false);
    }
  };

  const asciiMeta = useMemo(() => (text.length > 0 ? guessAsciiMeta(text) : null), [text]);

  return (
    <Modal
      open={open}
      title="导入曲谱"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button icon="upload" onClick={() => void doImport()} disabled={parsing}>
            {parsing ? '解析中…' : '导入'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Segmented
          value={kind}
          onChange={setKind}
          options={[
            { value: 'json', label: 'JSON' },
            { value: 'musicxml', label: 'MusicXML' },
            { value: 'ascii', label: 'ASCII' },
          ]}
        />
        {kind === 'ascii' ? (
          <>
            <textarea
              className="h-40 w-full rounded-lg border border-line p-2 font-mono text-xs outline-none focus:border-brand"
              placeholder="六线谱文本，例如：&#10;e|----0--1--3--|&#10;B|-------------|"
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            {asciiMeta && (
              <p className="text-xs text-ink-soft">
                识别：{asciiMeta.title} · {asciiMeta.measures} 小节
              </p>
            )}
          </>
        ) : (
          <label className="block rounded-xl border border-dashed border-line p-6 text-center text-sm text-ink-soft hover:border-brand">
            <Icon name="upload" size={22} className="mx-auto mb-1 text-gray-300" />
            {file ? <span className="text-ink">{file.name}</span> : `点击选择 ${kind === 'json' ? '.json' : '.musicxml/.xml'} 文件`}
            <input
              type="file"
              className="hidden"
              accept={kind === 'json' ? '.json' : '.musicxml,.xml'}
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </label>
        )}
      </div>
    </Modal>
  );
}

function guessAsciiMeta(text: string): { title: string; measures: number } {
  const titleLine = text.split('\n').find((l) => /^[Tt]itle[:：]/.test(l.trim()));
  const title = titleLine?.replace(/^[Tt]itle[:：]\s*/, '').trim() || 'ASCII 导入谱';
  const body = text.split('\n').filter((l) => /^[eEBGDA]?[|¦:]/.test(l.trim()) || /^[eEBGDA]-/.test(l.trim()));
  const width = Math.max(...body.map((l) => l.length), 0);
  const col = 8;
  const measures = width > 0 ? Math.max(1, Math.floor((width - 2) / (4 * col) + 0.5)) : 1;
  return { title, measures };
}

// ── 曲目详情（/tab/:id）────────────────────────────────────────────
export function TabDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const tabId = id as TabId | undefined;
  const toast = useAppStore((s) => s.toast);
  const lib = useLibraryStore();
  const [tab, setTab] = useState<Tab | null>(null);
  const [loading, setLoading] = useState(true);
  const [metaDraft, setMetaDraft] = useState<Partial<Tab> | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [confirmRemoveFromCol, setConfirmRemoveFromCol] = useState<Collection | null>(null);

  useEffect(() => {
    if (!tabId) return;
    setLoading(true);
    void tabRepo
      .get(tabId)
      .then((t) => {
        setTab(t ?? null);
        if (t) setMetaDraft({ title: t.title, artist: t.artist, key: t.key, bpm: t.bpm, capo: t.capo, tags: t.tags, difficultyOverride: t.difficultyOverride });
      })
      .catch((e) => toast('error', e instanceof Error ? e.message : '读取失败'))
      .finally(() => setLoading(false));
    void lib.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId]);

  if (loading || !tab) {
    return (
      <div className="p-8">
        {loading ? <Spinner /> : <EmptyState title="曲谱不存在" desc="可能已被删除。" />}
      </div>
    );
  }

  const saveMeta = async () => {
    if (!tab || !metaDraft) return;
    const next: Tab = {
      ...tab,
      title: metaDraft.title ?? tab.title,
      artist: metaDraft.artist ?? tab.artist,
      key: metaDraft.key ?? tab.key,
      bpm: metaDraft.bpm ?? tab.bpm,
      capo: (metaDraft.capo ?? 0) as Tab['capo'],
      tags: metaDraft.tags ?? [],
      difficultyOverride: (metaDraft.difficultyOverride ?? null) as Tab['difficultyOverride'],
      updatedAt: nowIso(),
      revision: tab.revision + 1,
    };
    await tabRepo.put(next);
    setTab(next);
    toast('success', '已保存');
  };

  const resetPractice = async () => {
    if (!tab) return;
    const next: Tab = { ...tab, practice: emptyPractice(tab.bpm), updatedAt: nowIso(), revision: tab.revision + 1 };
    await tabRepo.put(next);
    setTab(next);
    toast('success', '练习数据已重置');
  };

  const inCollections = lib.collections.filter((c) => c.tabIds.includes(tab.id));
  const notInCollections = lib.collections.filter((c) => !c.tabIds.includes(tab.id));

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4 pb-24">
      <Button variant="ghost" icon="back" onClick={() => navigate('/library')}>
        返回谱库
      </Button>

      <Card className="p-5">
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-bold">{tab.title}</h1>
              {sourceBadge(tab.source)}
            </div>
            <p className="text-sm text-ink-soft">{tab.artist}</p>
            <div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-ink-soft">
              <span>♩ {tab.bpm}</span>
              <span>拍号 {tab.timeSignature[0]}/{tab.timeSignature[1]}</span>
              <span>调 {tab.key}</span>
              <span>变调夹 {tab.capo} 品</span>
              <span>小节 {tab.tracks[0]?.measures.length ?? 0}</span>
              <DifficultyDots value={tab.difficultyOverride ?? tab.difficulty} />
            </div>
            <div className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              <Stat label="熟练度" value={`${tab.practice.mastery}`} />
              <Stat label="累计" value={`${Math.round(tab.practice.totalSeconds / 60)} 分钟`} />
              <Stat label="最佳 BPM" value={`${tab.practice.bestBpm || '—'}`} />
              <Stat label="轮次" value={`${tab.practice.roundsPassed}/${tab.practice.roundsTotal}`} />
            </div>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button icon="practice" onClick={() => navigate(`/practice/${tab.id}`)}>
            开始练习
          </Button>
          <Button variant="outline" icon="download" onClick={() => exportJson(tab)}>
            JSON
          </Button>
          <Button variant="outline" icon="download" onClick={() => exportAscii(tab)}>
            ASCII
          </Button>
          <Button variant="outline" icon="download" onClick={() => exportPdf()}>
            PDF
          </Button>
          <Button variant="subtle" onClick={() => setConfirmReset(true)}>
            重置练习数据
          </Button>
          <Button variant="danger" icon="trash" onClick={() => setConfirmDelete(true)} className="ml-auto">
            删除
          </Button>
        </div>
      </Card>

      {/* 元信息编辑 */}
      <Card className="p-5">
        <h2 className="mb-3 text-sm font-semibold">元信息</h2>
        {metaDraft && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="标题">
              <TextField value={metaDraft.title ?? ''} onChange={(e) => setMetaDraft({ ...metaDraft, title: e.target.value })} />
            </Field>
            <Field label="艺人">
              <TextField value={metaDraft.artist ?? ''} onChange={(e) => setMetaDraft({ ...metaDraft, artist: e.target.value })} />
            </Field>
            <Field label="调性">
              <select className="w-full rounded-lg border border-line px-2 py-1.5 text-sm" value={metaDraft.key ?? 'C'} onChange={(e) => setMetaDraft({ ...metaDraft, key: e.target.value as Tab['key'] })}>
                {KEY_OPTIONS.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="BPM">
              <TextField type="number" min={40} max={240} value={metaDraft.bpm ?? 90} onChange={(e) => setMetaDraft({ ...metaDraft, bpm: Number(e.target.value) })} />
            </Field>
            <Field label="变调夹">
              <select className="w-full rounded-lg border border-line px-2 py-1.5 text-sm" value={metaDraft.capo ?? 0} onChange={(e) => setMetaDraft({ ...metaDraft, capo: Number(e.target.value) as Tab['capo'] })}>
                {[0, 1, 2, 3, 4, 5, 6, 7].map((c) => (
                  <option key={c} value={c}>
                    {c} 品
                  </option>
                ))}
              </select>
            </Field>
            <Field label="难度覆盖（留空用自动）">
              <select
                className="w-full rounded-lg border border-line px-2 py-1.5 text-sm"
                value={metaDraft.difficultyOverride ?? ''}
                onChange={(e) =>
                  setMetaDraft({
                    ...metaDraft,
                    difficultyOverride: e.target.value ? (Number(e.target.value) as 1 | 2 | 3 | 4 | 5) : null,
                  })
                }
              >
                <option value="">自动</option>
                {['1', '2', '3', '4', '5'].map((d) => (
                  <option key={d} value={d}>
                    {d} 级
                  </option>
                ))}
              </select>
            </Field>
            <Field label="标签（逗号分隔）">
              <TextField value={(metaDraft.tags ?? []).join(', ')} onChange={(e) => setMetaDraft({ ...metaDraft, tags: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} />
            </Field>
          </div>
        )}
        <div className="mt-3 flex justify-end">
          <Button onClick={() => void saveMeta()}>保存元信息</Button>
        </div>
      </Card>

      {/* 歌单 */}
      <Card className="p-5">
        <h2 className="mb-3 text-sm font-semibold">歌单</h2>
        <div className="flex flex-wrap gap-2">
          {inCollections.map((c) => (
            <Badge key={c.id} tone="brand">
              {c.name}
              <button type="button" className="ml-1 hover:text-red-600" onClick={() => setConfirmRemoveFromCol(c)}>
                ×
              </button>
            </Badge>
          ))}
          {notInCollections.length > 0 && (
            <select
              className="rounded-lg border border-line px-2 py-1 text-sm"
              value=""
              onChange={(e) => {
                if (e.target.value) void lib.addToCollection(e.target.value as never, tab.id);
              }}
            >
              <option value="">加入歌单…</option>
              {notInCollections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          )}
          {lib.collections.length === 0 && <p className="text-xs text-gray-400">暂无歌单，可在谱库左侧创建</p>}
        </div>
      </Card>

      {/* 文件解析预览 / 导出文本 */}
      <Card className="p-5">
        <h2 className="mb-2 text-sm font-semibold">数据预览</h2>
        <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
          <pre className="fretly-scroll max-h-56 overflow-auto rounded-lg bg-gray-50 p-2 text-[10px] text-ink-soft">{tabToJson(tab).slice(0, 1800)}</pre>
          <pre className="fretly-scroll max-h-56 overflow-auto rounded-lg bg-gray-50 p-2 text-[10px] leading-relaxed text-ink-soft">{tabToAscii(tab).slice(0, 1800)}</pre>
        </div>
      </Card>

      <ConfirmDialog
        open={confirmDelete}
        title="删除这首曲谱？"
        danger
        confirmText="删除"
        message="将从谱库与所有歌单中移除，不可恢复。"
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => {
          void lib.removeTab(tab.id);
          setConfirmDelete(false);
          navigate('/library');
        }}
      />
      <ConfirmDialog
        open={confirmReset}
        title="重置练习数据？"
        confirmText="重置"
        message="熟练度、练习时长、最佳 BPM 与覆盖小节将清零。曲谱内容不变。"
        onCancel={() => setConfirmReset(false)}
        onConfirm={() => {
          setConfirmReset(false);
          void resetPractice();
        }}
      />
      <ConfirmDialog
        open={confirmRemoveFromCol !== null}
        title="移出歌单？"
        confirmText="移出"
        onCancel={() => setConfirmRemoveFromCol(null)}
        onConfirm={() => {
          if (confirmRemoveFromCol) void lib.removeFromCollection(confirmRemoveFromCol.id, tab.id);
          setConfirmRemoveFromCol(null);
        }}
        message={`从歌单《${confirmRemoveFromCol?.name ?? ''}》移除该曲？`}
      />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-canvas px-3 py-2">
      <div className="text-xs text-ink-soft">{label}</div>
      <div className="text-base font-bold">{value}</div>
    </div>
  );
}
