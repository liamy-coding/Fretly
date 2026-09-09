/**
 * 应用入口壳（架构 §2.1，T-18）：HashRouter + 左导航 + 首启合规声明 +
 * 能力降级页 + Toast 视口。首次访问自动播种内置示范曲。
 */
import { useEffect } from 'react';
import { HashRouter, NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAppStore } from '@/state/useAppStore';
import { useLibraryStore } from '@/state/useLibraryStore';
import { seedBuiltinSongs } from '@/storage/seed';
import { Toasts, Button, Icon, Modal, cn } from '@/ui/kit';
import type { IconName } from '@/ui/kit';
import LibraryPage, { TabDetailPage } from '@/ui/library/LibraryPage';
import PracticePage from '@/ui/practice/PracticePage';
import TranscribePage from '@/ui/transcribe/TranscribePage';
import EditorPage from '@/ui/editor/EditorPage';
import DashboardPage from '@/ui/dashboard/DashboardPage';
import SettingsPage from '@/ui/settings/SettingsPage';

const NAV: { to: string; label: string; icon: IconName; end?: boolean }[] = [
  { to: '/library', label: '谱库', icon: 'library', end: false },
  { to: '/transcribe', label: '扒谱', icon: 'transcribe' },
  { to: '/dashboard', label: '档案', icon: 'dashboard' },
  { to: '/settings', label: '设置', icon: 'settings' },
];

export default function App() {
  const init = useAppStore((s) => s.init);
  const capabilities = useAppStore((s) => s.capabilities);
  const showDisclaimer = useAppStore((s) => s.showDisclaimer);
  const ack = useAppStore((s) => s.ackDisclaimer);

  // 首启：init settings + 播种（完成后刷新谱库，避免首次空列表）
  useEffect(() => {
    init();
    void seedBuiltinSongs().then(() => {
      void useLibraryStore.getState().reload();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const unsupported = !capabilities.indexedDb || !capabilities.audioContext;

  return (
    <HashRouter>
      <div className="flex min-h-screen">
        {/* 左导航（桌面） */}
        <nav className="no-print sticky top-0 hidden h-screen w-44 shrink-0 flex-col border-r border-line bg-surface px-2 py-4 md:flex">
          <NavLink to="/library" className="mb-4 flex items-center gap-2 px-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand text-white">
              <Icon name="practice" size={18} />
            </span>
            <span className="text-sm font-bold">弦格 Fretly</span>
          </NavLink>
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                cn(
                  'mb-0.5 flex items-center gap-2 rounded-lg px-2 py-2 text-sm',
                  isActive ? 'bg-brand-soft font-medium text-brand' : 'text-ink-soft hover:bg-black/5 hover:text-ink',
                )
              }
            >
              <Icon name={item.icon} size={18} />
              {item.label}
            </NavLink>
          ))}
          <div className="mt-auto px-2 text-[10px] leading-relaxed text-gray-400">
            本地引擎 · 不限次
            <br />
            纯前端 · 数据在本机
          </div>
        </nav>

        {/* 移动端顶栏 */}
        <div className="no-print sticky top-0 z-30 flex h-12 items-center justify-between border-b border-line bg-surface px-3 md:hidden">
          <NavLink to="/library" className="flex items-center gap-1.5">
            <span className="flex h-6 w-6 items-center justify-center rounded bg-brand text-white">
              <Icon name="practice" size={13} />
            </span>
            <span className="text-sm font-bold">弦格 Fretly</span>
          </NavLink>
        </div>

        {/* 主内容 */}
        <div className="min-w-0 flex-1">
          {unsupported ? (
            <CapabilityGate />
          ) : (
            <Routes>
              <Route path="/" element={<Navigate to="/library" replace />} />
              <Route path="/library" element={<LibraryPage />} />
              <Route path="/tab/:id" element={<TabDetailPage />} />
              <Route path="/practice/:id" element={<PracticePage />} />
              <Route path="/transcribe" element={<TranscribePage />} />
              <Route path="/transcribe/:jobId/edit" element={<EditorPage />} />
              <Route path="/dashboard" element={<DashboardPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="*" element={<NotFound />} />
            </Routes>
          )}
        </div>
      </div>

      {/* 移动端底部导航 */}
      <nav className="no-print fixed inset-x-0 bottom-0 z-30 flex border-t border-line bg-surface/95 backdrop-blur md:hidden">
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) =>
              cn(
                'flex flex-1 flex-col items-center gap-0.5 py-1.5 text-[10px]',
                isActive ? 'text-brand' : 'text-ink-soft',
              )
            }
          >
            <Icon name={item.icon} size={18} />
            {item.label}
          </NavLink>
        ))}
      </nav>

      <DisclaimerModal open={showDisclaimer} onAck={ack} />
      <Toasts />
      <ScrollReset />
    </HashRouter>
  );
}

function CapabilityGate() {
  const c = useAppStore((s) => s.capabilities);
  return (
    <div className="mx-auto max-w-md p-8 text-center">
      <div className="text-4xl">🎸</div>
      <h1 className="mt-2 text-lg font-bold">浏览器能力受限</h1>
      <p className="mt-2 text-sm text-ink-soft">
        {!c.indexedDb ? '当前环境不支持 IndexedDB，无法保存曲谱与练习记录。' : ''}
        {!c.audioContext ? '当前环境不支持 Web Audio，无法播放示范音轨与节拍器。' : ''}
        请使用最新版 Chrome / Edge / Safari / Firefox 并允许存储。
      </p>
    </div>
  );
}

function DisclaimerModal({ open, onAck }: { open: boolean; onAck: () => void }) {
  const location = useLocation();
  if (!open) return null;
  return (
    <Modal
      open={open}
      title="欢迎使用弦格 Fretly"
      width="max-w-lg"
      onClose={onAck}
      footer={
        <>
          <Button onClick={onAck}>我已了解，开始使用</Button>
        </>
      }
    >
      <div className="space-y-3 text-sm leading-relaxed text-ink-soft">
        <p>
          <b className="text-ink">合规声明：</b>
          本应用仅用于个人吉他学习与自创内容练习。内置示范曲均为原创曲目；扒谱功能仅供你处理<u>有权使用</u>的音频，请勿用于未经授权的商业作品。
        </p>
        <p>
          <b className="text-ink">本地优先：</b>
          所有曲谱、练习记录与音频仅在浏览器本地处理（IndexedDB / localStorage），不会上传到任何服务器。
        </p>
        <p>
          <b className="text-ink">扒谱说明：</b>
          使用本地轻量启发式引擎 · 不限次。效果对单把吉他、干净音色较好；生成结果需要在校对编辑器中确认低置信音符与和弦。
        </p>
        <p className="text-xs text-gray-400">当前在：{location.pathname}</p>
      </div>
    </Modal>
  );
}

function ScrollReset() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return null;
}

function NotFound() {
  return (
    <div className="p-8 text-center">
      <h1 className="text-lg font-bold">404</h1>
      <p className="mt-1 text-sm text-ink-soft">页面不存在。</p>
      <Button className="mt-3" onClick={() => (window.location.hash = '#/library')}>
        回谱库
      </Button>
    </div>
  );
}
