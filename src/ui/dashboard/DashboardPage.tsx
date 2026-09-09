/**
 * 档案页（架构 §2.10-56，T-24）：指标卡、打卡日历、熟练度列表、速度曲线、难点标记。
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Tab, TabId } from '@/types/tab';
import type { PracticeSession } from '@/types/app';
import { tabRepo } from '@/storage/tabRepo';
import { aggregateSessions, averageSpeedPct, computeMasteryFactors, masteryTier } from '@/core/mastery';
import { localDateKey } from '@/core/constants';
import { CalendarHeatmap, TempoLine } from '@/ui/charts';
import { Button, Card, DifficultyDots, EmptyState, Icon, cn } from '@/ui/kit';

interface MarkerRow {
  tabId: TabId;
  tabTitle: string;
  measure: number;
  note: string;
  markerId: string;
}

export default function DashboardPage() {
  const navigate = useNavigate();
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [sessions, setSessions] = useState<PracticeSession[]>([]);
  const [loading, setLoading] = useState(true);
  const now = new Date();

  useEffect(() => {
    void (async () => {
      try {
        const metas = await tabRepo.list();
        const full = await Promise.all(metas.map((m) => tabRepo.get(m.id)));
        const tabsList = full.filter((t): t is Tab => Boolean(t));
        const sessionsList = await tabRepo.listSessions();
        setTabs(tabsList);
        setSessions(sessionsList);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const agg = useMemo(() => aggregateSessions(sessions, now), [sessions, now]);

  const masteryItems = useMemo(() => {
    const totalMeasures = (t: Tab) => t.tracks[0]?.measures.length ?? 0;
    return tabs
      .map((t) => ({ tab: t, factors: computeMasteryFactors(t.practice, totalMeasures(t), now.toISOString()) }))
      .sort((a, b) => b.tab.practice.mastery - a.tab.practice.mastery);
  }, [tabs, now]);

  const speedSeries = useMemo(() => {
    const tab = masteryItems[0]?.tab;
    if (!tab) return [];
    const mine = sessions
      .filter((s) => s.tabId === tab.id)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
      .slice(-12)
      .map((s) => ({
        label: s.startedAt.slice(5, 10).replace('-', '/'),
        bpm: s.endBpm || s.startBpm,
      }));
    // 并入 bestBpm 作为折线末点，确保有数据
    if (mine.length === 0 && tab.practice.bestBpm > 0) {
      return [{ label: '最佳', bpm: tab.practice.bestBpm }];
    }
    return mine;
  }, [masteryItems, sessions]);

  const markers = useMemo<MarkerRow[]>(() => {
    const rows: MarkerRow[] = [];
    for (const t of tabs) {
      for (const m of t.markers) {
        rows.push({ tabId: t.id, tabTitle: t.title, measure: m.measure, note: m.note, markerId: m.id });
      }
    }
    return rows.sort((a, b) => b.measure - a.measure).slice(0, 12);
  }, [tabs]);

  const speedPct = averageSpeedPct(
    tabs.map((t) => ({ bestBpm: t.practice.bestBpm, targetBpm: t.practice.targetBpm })),
  );

  if (loading) return <div className="p-8 text-ink-soft">加载中…</div>;

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4 pb-24">
      <h1 className="text-lg font-bold">练习档案</h1>

      {/* 指标卡 */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric icon="dashboard" label="本周练习" value={`${agg.weekMinutes} 分钟`} />
        <Metric icon="flag" label="连续打卡" value={`${agg.streak} 天`} />
        <Metric icon="practice" label="平均速度" value={`${speedPct}%`} />
        <Metric icon="library" label="近 7 天活跃曲目" value={`${agg.activeTabs} 首`} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* 打卡日历 */}
        <Card className="p-4">
          <h2 className="mb-2 text-sm font-semibold">打卡日历（近 12 周）</h2>
          <CalendarHeatmap minutesByDay={agg.minutesByDay} todayKey={localDateKey(now)} />
        </Card>

        {/* 速度曲线 */}
        <Card className="p-4">
          <h2 className="mb-1 text-sm font-semibold">速度曲线</h2>
          {speedSeries.length > 0 ? (
            <>
              <p className="mb-1 truncate text-xs text-ink-soft">{masteryItems[0]?.tab.title}（最近练习的 BPM）</p>
              <TempoLine points={speedSeries} targetBpm={masteryItems[0]?.tab.practice.targetBpm} />
            </>
          ) : (
            <EmptyState title="暂无速度数据" desc="完成一次练习后会在这里看到 BPM 变化曲线。" />
          )}
        </Card>
      </div>

      {/* 熟练度列表 */}
      <Card className="p-4">
        <h2 className="mb-3 text-sm font-semibold">熟练度</h2>
        {masteryItems.length === 0 ? (
          <EmptyState title="还没有曲目" desc="去谱库导入或练习一首曲子吧。" />
        ) : (
          <ul className="divide-y divide-line">
            {masteryItems.slice(0, 10).map(({ tab }) => (
              <li key={tab.id} className="flex items-center gap-3 py-2">
                <span
                  className={cn(
                    'h-9 w-9 shrink-0 rounded-lg text-center text-xs font-bold leading-9',
                    tab.practice.mastery >= 90
                      ? 'bg-yellow-100 text-yellow-700'
                      : tab.practice.mastery >= 70
                        ? 'bg-green-100 text-green-700'
                        : tab.practice.mastery >= 40
                          ? 'bg-blue-100 text-blue-700'
                          : 'bg-gray-100 text-gray-500',
                  )}
                >
                  {tab.practice.mastery}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{tab.title}</div>
                  <div className="flex items-center gap-2 text-xs text-ink-soft">
                    <span>{masteryTier(tab.practice.mastery)}</span>
                    <DifficultyDots value={tab.difficultyOverride ?? tab.difficulty} />
                    <span>最佳 {tab.practice.bestBpm || '—'} BPM</span>
                  </div>
                </div>
                <Button size="xs" variant="outline" onClick={() => navigate(`/practice/${tab.id}`)}>
                  练习
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* 难点标记（错题本入口） */}
      <Card className="p-4">
        <h2 className="mb-3 text-sm font-semibold">难点标记</h2>
        {markers.length === 0 ? (
          <EmptyState icon="flag" title="还没有难点标记" desc="练习页中可在某小节添加难点，方便回炉。" />
        ) : (
          <ul className="divide-y divide-line">
            {markers.map((row) => (
              <li key={`${row.tabId}:${row.markerId}`} className="flex items-center gap-3 py-2">
                <Icon name="flag" size={15} className="shrink-0 text-amber" />
                <div className="min-w-0 flex-1 text-sm">
                  <span className="font-medium">{row.tabTitle}</span>
                  <span className="ml-2 text-ink-soft">第 {row.measure + 1} 小节</span>
                  {row.note && <span className="ml-2 truncate text-ink-soft">· {row.note}</span>}
                </div>
                <Button size="xs" onClick={() => navigate(`/practice/${row.tabId}?focus=${row.measure}`)}>
                  专项练
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function Metric({ icon, label, value }: { icon: 'dashboard' | 'flag' | 'practice' | 'library'; label: string; value: string }) {
  return (
    <Card className="flex items-center gap-3 p-4">
      <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-soft text-brand">
        <Icon name={icon} size={20} />
      </span>
      <div className="min-w-0">
        <div className="text-xs text-ink-soft">{label}</div>
        <div className="truncate text-lg font-bold">{value}</div>
      </div>
    </Card>
  );
}
