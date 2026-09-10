/**
 * 练习控制条（架构 §2.10-51，T-21；播放器化重排 PRD §2-4 / §6）。
 * 三组：播放（左）｜ 速度（中）｜ 开关（右），组间竖线分隔。
 * 位置紧贴页头下方，使「播放固定左、速度固定中、开关固定右」形成肌肉记忆。
 * 不新增子组件，仅重排现有元素。
 */
import { practiceController } from '@/state/practiceController';
import { usePracticeStore } from '@/state/usePracticeStore';
import { useSettings } from '@/state/useAppStore';
import { measureStartTick } from '@/core/tick';
import { Button, Icon, IconButton, Segmented, Slider, cn } from '@/ui/kit';
import type { Tab } from '@/types/tab';

export default function PracticeToolbar({ tab, onResetFollow }: { tab: Tab | null; onResetFollow?: () => void }) {
  const isPlaying = usePracticeStore((s) => s.isPlaying);
  const currentBpm = usePracticeStore((s) => s.currentBpm);
  const loop = usePracticeStore((s) => s.loop);
  const metronomeOn = usePracticeStore((s) => s.metronomeOn);
  const subdivision = usePracticeStore((s) => s.subdivision);
  const demoOn = usePracticeStore((s) => s.demoOn);
  const demoVolume = usePracticeStore((s) => s.demoVolume);
  const settings = useSettings();

  if (!tab) return null;

  const baseBpm = tab.bpm;
  const currentRatio = Math.round((currentBpm / baseBpm) * 100) / 100;

  const singleMeasureLoop = () => {
    const m = tab.tracks[0]?.measures[usePracticeStore.getState().currentMeasure];
    if (!m) return;
    practiceController.setLoop({
      start: measureStartTick(m.index, tab.timeSignature),
      end: measureStartTick(m.index + 1, tab.timeSignature),
    });
  };

  const metronomeSettings = settings.metronome;

  return (
    <div className="rounded-xl border border-line bg-surface px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {/* ── 组 1：播放 ────────────────────────────────────────── */}
        <div className="flex items-center gap-1">
          <IconButton
            name="skipBack"
            label="回开头"
            disabled={!tab}
            onClick={() => {
              practiceController.seek(0);
              onResetFollow?.();
            }}
          />
          <Button
            size="sm"
            icon={isPlaying ? 'pause' : 'play'}
            onClick={() => {
              // 点击播放/暂停也恢复跟随（PRD §5.2）—— 拖动后想救回来时点播放即可
              onResetFollow?.();
              void practiceController.togglePlay();
            }}
            className="min-w-[74px]"
          >
            {isPlaying ? '暂停' : '播放'}
          </Button>
          <IconButton
            name="skipFwd"
            label="下一小节"
            onClick={() => {
              practiceController.nextMeasure();
              onResetFollow?.();
            }}
          />
        </div>

        <div className="hidden h-6 w-px shrink-0 bg-line sm:block" aria-hidden="true" />

        {/* ── 组 2：速度 ────────────────────────────────────────── */}
        <div className="flex min-w-[170px] flex-1 items-center gap-2 sm:max-w-xs">
          <span className="shrink-0 text-xs text-ink-soft">速度</span>
          <Slider
            ariaLabel="练习速度比例"
            min={50}
            max={150}
            step={5}
            value={Math.round(currentRatio * 100)}
            onChange={(v) => practiceController.setRatio(v / 100)}
          />
          <span className="w-16 shrink-0 text-right font-mono text-xs font-semibold text-brand">
            {Math.round(currentRatio * 100)}% · {currentBpm}
          </span>
        </div>

        <div className="hidden h-6 w-px shrink-0 bg-line sm:block" aria-hidden="true" />

        {/* ── 组 3：开关（循环 / 节拍器 / 示范）──────────────────── */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <div className="flex items-center gap-1">
            <IconButton name="loop" label="整曲循环" active={Boolean(loop)} onClick={() => practiceController.toggleLoop()} />
            <button
              type="button"
              title="单小节循环"
              onClick={singleMeasureLoop}
              className={cn(
                'inline-flex h-9 items-center rounded-lg border px-2 text-xs font-medium',
                loop && loop.end - loop.start <= 1920 ? 'border-brand bg-brand-soft text-brand' : 'border-line text-ink-soft',
              )}
            >
              A-B
            </button>
            {loop && (
              <button
                type="button"
                className="text-xs text-ink-soft hover:text-red-600"
                onClick={() => practiceController.setLoop(null)}
              >
                取消
              </button>
            )}
          </div>

          <div className="flex items-center gap-1">
            <IconButton
              name="metronome"
              label="节拍器"
              active={metronomeOn}
              onClick={() => practiceController.setMetronomeOn(!metronomeOn)}
            />
            {metronomeOn && metronomeSettings.enabled && (
              <Segmented
                value={subdivision}
                onChange={(v) => practiceController.setSubdivision(v)}
                options={[
                  { value: '1/4', label: '1/4' },
                  { value: '1/8', label: '1/8' },
                  { value: '1/16', label: '1/16' },
                ]}
              />
            )}
          </div>

          <div className="flex items-center gap-1 text-xs text-ink-soft">
            <span className="inline-flex items-center gap-0.5" title="示范音轨">
              <Icon name="practice" size={14} />
            </span>
            <button
              type="button"
              aria-label="示范音轨开关"
              onClick={() => practiceController.setDemo(!demoOn, demoVolume)}
              className={cn('h-4 w-4 rounded-full border', demoOn ? 'border-success bg-success' : 'border-line bg-gray-200')}
            />
            <input
              type="range"
              aria-label="示范音量"
              className="w-16 accent-brand"
              min={0}
              max={100}
              value={Math.round(demoVolume * 100)}
              onChange={(e) => practiceController.setDemo(demoOn, Number(e.target.value) / 100)}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
