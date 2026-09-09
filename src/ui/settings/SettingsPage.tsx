/**
 * 设置页（架构 §2.10-57，T-24）：默认训练参数、节拍器/示范音轨、存储与数据管理。
 */
import { useEffect, useState } from 'react';
import { useAppStore, useSettings } from '@/state/useAppStore';
import { Button, Card, ConfirmDialog, Field, Segmented, Select, Slider, Toggle } from '@/ui/kit';
import { clearAllData, exportAllData, isSeeded, reseed } from '@/storage/seed';
import { tabRepo } from '@/storage/tabRepo';

export default function SettingsPage() {
  const patch = useAppStore((s) => s.patchSettings);
  const reset = useAppStore((s) => s.resetSettings);
  const toast = useAppStore((s) => s.toast);
  const settings = useSettings();

  const [confirmClear, setConfirmClear] = useState(false);
  const [deleteText, setDeleteText] = useState('');
  const [storageCount, setStorageCount] = useState<{ tabs: number; sessions: number }>({ tabs: 0, sessions: 0 });

  useEffect(() => {
    void (async () => {
      const [tabs, sessions] = await Promise.all([tabRepo.list(), tabRepo.listSessions()]);
      setStorageCount({ tabs: tabs.length, sessions: sessions.length });
    })();
  }, []);

  const onExport = () => {
    void (async () => {
      try {
        const data = await exportAllData();
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `fretly-backup-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
        toast('success', '已导出全部数据（JSON）');
      } catch (err) {
        toast('error', err instanceof Error ? err.message : '导出失败');
      }
    })();
  };

  const onClear = () => {
    void (async () => {
      try {
        await clearAllData();
        toast('success', '本地数据已清空');
        setConfirmClear(false);
        setDeleteText('');
        reset();
        window.location.hash = '#/library';
      } catch (err) {
        toast('error', err instanceof Error ? err.message : '清空失败');
      }
    })();
  };

  return (
    <div className="mx-auto max-w-2xl space-y-5 p-4 pb-24">
      <div>
        <h1 className="text-lg font-bold">设置</h1>
        <p className="text-sm text-ink-soft">所有设置仅保存在本机浏览器（localStorage / IndexedDB）。</p>
      </div>

      <Card className="p-4">
        <h2 className="mb-3 text-sm font-semibold">渐进加速默认参数</h2>
        <div className="space-y-3">
          <Field label={`起始速度：${Math.round(settings.defaultStartRatio * 100)}%`} hint="进入训练时以目标速度的该比例起步">
            <Slider
              min={50}
              max={100}
              step={5}
              value={Math.round(settings.defaultStartRatio * 100)}
              onChange={(v) => patch({ defaultStartRatio: v / 100 })}
            />
          </Field>
          <Field label="每次提速（BPM）">
            <Select
              value={String(settings.defaultStep) as '3' | '5' | '10'}
              onChange={(v) => patch({ defaultStep: Number(v) as 3 | 5 | 10 })}
              options={[
                { value: '3', label: '3 BPM（精细）' },
                { value: '5', label: '5 BPM（推荐）' },
                { value: '10', label: '10 BPM（激进）' },
              ]}
            />
          </Field>
          <Field label="连续达标轮数">
            <Segmented
              value={String(settings.defaultPassRounds) as '1' | '2' | '3'}
              onChange={(v) => patch({ defaultPassRounds: Number(v) as 1 | 2 | 3 })}
              options={[
                { value: '1', label: '1 轮' },
                { value: '2', label: '2 轮' },
                { value: '3', label: '3 轮' },
              ]}
            />
          </Field>
          <Field label={`目标速度：${Math.round(settings.defaultTargetRatio * 100)}%`} hint="训练目标 = 谱面 BPM × 该比例">
            <Slider
              min={100}
              max={150}
              step={5}
              value={Math.round(settings.defaultTargetRatio * 100)}
              onChange={(v) => patch({ defaultTargetRatio: v / 100 })}
            />
          </Field>
        </div>
      </Card>

      <Card className="p-4">
        <h2 className="mb-3 text-sm font-semibold">节拍器与示范音轨</h2>
        <div className="space-y-3 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-ink">练习页默认开启节拍器</span>
            <Toggle
              label="练习页默认开启节拍器"
              checked={settings.metronome.enabled}
              onChange={(v) => patch({ metronome: { ...settings.metronome, enabled: v } })}
            />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-ink">预备拍（播放前一小节数拍）</span>
            <Toggle
              label="预备拍"
              checked={settings.metronome.countIn}
              onChange={(v) => patch({ metronome: { ...settings.metronome, countIn: v } })}
            />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-ink">示范音轨默认开启</span>
            <Toggle
              label="示范音轨默认开启"
              checked={settings.demoTrack.enabled}
              onChange={(v) => patch({ demoTrack: { ...settings.demoTrack, enabled: v } })}
            />
          </div>
          <Field label={`示范音轨音量：${Math.round(settings.demoTrack.volume * 100)}%`}>
            <Slider
              min={0}
              max={100}
              value={Math.round(settings.demoTrack.volume * 100)}
              onChange={(v) => patch({ demoTrack: { ...settings.demoTrack, volume: v / 100 } })}
            />
          </Field>
          <div className="flex items-center justify-between">
            <span className="text-ink">显示左手手指编号</span>
            <Toggle
              label="显示左手手指编号"
              checked={settings.showFingerNumbers}
              onChange={(v) => patch({ showFingerNumbers: v })}
            />
          </div>
        </div>
      </Card>

      <Card className="p-4">
        <h2 className="mb-3 text-sm font-semibold">存储说明</h2>
        <ul className="space-y-1 text-sm text-ink-soft">
          <li>· 曲谱 / 练习记录 / 扒谱任务：IndexedDB（库 fretly）</li>
          <li>· 偏好设置：localStorage（前缀 fretly.）</li>
          <li>· 当前 {storageCount.tabs} 首曲谱，{storageCount.sessions} 条练习会话</li>
        </ul>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="outline" icon="download" onClick={onExport}>
            导出全部数据（JSON）
          </Button>
          {!isSeeded() && (
            <Button
              variant="outline"
              onClick={() => {
                void reseed().then((n) => toast('success', `已恢复 ${n} 首内置示范曲`));
              }}
            >
              试玩内置示范曲
            </Button>
          )}
          <Button variant="danger" icon="trash" onClick={() => setConfirmClear(true)}>
            清空本地数据
          </Button>
        </div>
      </Card>

      <Card className="p-4">
        <h2 className="mb-2 text-sm font-semibold">关于</h2>
        <p className="text-sm text-ink-soft">
          弦格 Fretly · 纯前端吉他练习工具。扒谱使用本地轻量启发式引擎 · 不限次；音频仅在本机处理，不上传。
        </p>
        <Button
          variant="ghost"
          className="mt-2"
          onClick={() => {
            localStorage.removeItem('fretly.disclaimerAcked');
            patch({ disclaimerAcked: false });
          }}
        >
          重新查看首次使用说明
        </Button>
      </Card>

      <ConfirmDialog
        open={confirmClear}
        title="清空全部本地数据？"
        danger
        confirmText="确认清空"
        onCancel={() => {
          setConfirmClear(false);
          setDeleteText('');
        }}
        onConfirm={() => {
          if (deleteText === 'DELETE') {
            void onClear();
          } else {
            toast('warn', '请输入 DELETE 以确认清空');
          }
        }}
        message={
          <div className="space-y-2">
            <p>将删除所有曲谱、歌单、练习记录与扒谱任务，且不可恢复。</p>
            <p>请先导出备份。若确认，请在下方输入 DELETE：</p>
            <input
              className="mt-1 w-full rounded-lg border border-red-200 px-2.5 py-1.5 text-sm"
              value={deleteText}
              onChange={(e) => setDeleteText(e.target.value)}
              placeholder="DELETE"
            />
          </div>
        }
      />
    </div>
  );
}
