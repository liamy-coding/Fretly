/**
 * 渐进加速常驻面板（架构 §2.10-52，T-21，PRD §6.2）。
 * 四参数 + 开始/暂停 + 「本轮过了」5 秒窗口 + 每轮柱状图 + 达成提示。
 */
import { practiceController } from '@/state/practiceController';
import { usePracticeStore } from '@/state/usePracticeStore';
import { useSettings } from '@/state/useAppStore';
import type { Step, PassRounds } from '@/core/progressive';
import { defaultProgressiveCfgFromSettings } from '@/state/usePracticeStore';
import { BpmBars } from '@/ui/charts';
import { Button } from '@/ui/kit';
import type { Tab } from '@/types/tab';

export default function ProgressivePanel({ tab }: { tab: Tab | null }) {
  const settings = useSettings();
  const cfg = defaultProgressiveCfgFromSettings(settings);
  const progressive = usePracticeStore((s) => s.progressive);
  const progressiveActive = usePracticeStore((s) => s.progressiveActive);
  const passWindowMsLeft = usePracticeStore((s) => s.passWindowMsLeft);
  const isPlaying = usePracticeStore((s) => s.isPlaying);
  const currentMeasure = usePracticeStore((s) => s.currentMeasure);

  if (!tab) return null;
  const baseBpm = tab.bpm;
  const state = progressive ?? {
    active: false,
    targetBpm: Math.round(baseBpm * settings.defaultTargetRatio),
    startBpm: 0,
    step: cfg.step as Step,
    passRounds: cfg.passRounds as PassRounds,
    currentBpm: 0,
    consecutive: 0,
    rounds: [],
    targetReachedAt: null,
  };

  const startBpm = state.startBpm > 0 ? state.startBpm : Math.round(baseBpm * settings.defaultStartRatio);

  const begin = () => {
    void practiceController.startProgressive({
      startRatio: settings.defaultStartRatio,
      step: cfg.step,
      passRounds: cfg.passRounds,
      targetRatio: settings.defaultTargetRatio,
    });
  };

  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold">渐进加速</h3>
        {state.targetReachedAt ? (
          <span className="rounded-full bg-yellow-100 px-2 py-0.5 text-xs font-semibold text-yellow-700">目标已达成 🎉</span>
        ) : progressiveActive ? (
          <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-semibold text-green-700">训练中</span>
        ) : (
          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-ink-soft">待开始</span>
        )}
      </div>

      <div className="mb-3 flex items-end justify-between rounded-lg bg-canvas px-3 py-2">
        <div>
          <div className="text-xs text-ink-soft">当前目标</div>
          <div className="font-mono text-2xl font-bold text-brand">
            {state.targetBpm}
            <span className="ml-1 text-sm font-normal text-ink-soft">BPM</span>
          </div>
        </div>
        <div className="text-right">
          <div className="text-xs text-ink-soft">从 {startBpm} BPM 起步 · 连续 {state.passRounds} 轮提速 {state.step}</div>
          {!progressiveActive && (
            <div className="mt-1 text-xs text-ink-soft">
              当前循环：第 {currentMeasure + 1} 小节起 · 需先设好 A-B 或整曲
            </div>
          )}
        </div>
      </div>

      <div className="mb-2 grid grid-cols-2 gap-2 text-xs text-ink-soft">
        <div>连续达标：{state.consecutive}/{state.passRounds}</div>
        <div>已完成轮次：{state.rounds.length}</div>
      </div>

      {!progressiveActive ? (
        <Button className="w-full" onClick={begin}>
          开始提速训练（{startBpm} → {state.targetBpm}）
        </Button>
      ) : (
        <div className="space-y-2">
          <div className="flex gap-2">
            <Button
              className="flex-1"
              variant="outline"
              onClick={() => {
                practiceController.pauseProgressive();
              }}
            >
              暂停
            </Button>
            {passWindowMsLeft !== null && (
              <Button className="flex-1" variant="success" onClick={() => practiceController.markPassed()}>
                「本轮过了」
              </Button>
            )}
          </div>
          {passWindowMsLeft !== null && (
            <div className="text-center text-xs text-success">5 秒窗口 · 点击「本轮过了」才能提速</div>
          )}
        </div>
      )}

      {state.rounds.length > 0 && (
        <div className="mt-3">
          <div className="mb-1 text-xs text-ink-soft">每轮成绩（绿=过 黄=没过）</div>
          <BpmBars state={state} />
        </div>
      )}
      {progressiveActive && isPlaying && passWindowMsLeft === null && state.rounds.length === 0 && (
        <div className="mt-2 rounded-lg bg-blue-50 px-3 py-2 text-xs text-blue-700">
          播放中… 每轮结束会有 5 秒确认窗口
        </div>
      )}
    </div>
  );
}
