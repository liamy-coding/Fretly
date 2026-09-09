/**
 * 手写基础 UI 件（架构 §2.10-45，T-18）：Button/Slider/Select/Modal/Toast/Progress/
 * Badge/EmptyState/Segmented/Toggle + 高频 hooks（useRaf/useDebounce/useHotkeys）。
 * 无第三方 UI 库；Tailwind v4 CSS-first（design tokens 在 styles/index.css）。
 */
import {
  type ButtonHTMLAttributes,
  type CSSProperties,
  type InputHTMLAttributes,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { useAppStore, type ToastType } from '@/state/useAppStore';

// ── 工具 ──────────────────────────────────────────────────────────
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

// ── 图标（内联 SVG，stroke 风格 24×24）──────────────────────────
const ICON_PATHS: Record<string, ReactNode> = {
  play: <path d="M8 5v14l11-7z" />,
  pause: <path d="M7 5h4v14H7zM13 5h4v14h-4z" />,
  stop: <rect x="6" y="6" width="12" height="12" rx="1" />,
  skipBack: <path d="M6 6h2v12H6zM20 6l-10 6 10 6z" />,
  skipFwd: <path d="M16 6h2v12h-2zM4 6l10 6-10 6z" />,
  loop: <path d="M17 2l4 4-4 4M3 11V9a2 2 0 012-2h14M7 22l-4-4 4-4M21 13v2a2 2 0 01-2 2H5" />,
  metronome: (
    <>
      <path d="M4 20h16" />
      <path d="M12 20L8 6l-3 14M12 20l4-14 3 14" />
      <path d="M12 5v2" />
    </>
  ),
  back: <path d="M15 6l-6 6 6 6" />,
  forward: <path d="M9 6l6 6-6 6" />,
  up: <path d="M6 15l6-6 6 6" />,
  down: <path d="M6 9l6 6 6-6" />,
  check: <path d="M5 13l4 4L19 7" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  plus: <path d="M12 5v14M5 12h14" />,
  trash: <path d="M4 7h16M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2M6 7l1 13h10l1-13" />,
  edit: <path d="M4 20h4L20 8l-4-4L4 16v4zM13 6l4 4" />,
  download: <path d="M12 4v11M7 11l5 5 5-5M4 20h16" />,
  upload: <path d="M12 16V5M7 10l5-5 5 5M4 20h16" />,
  mic: (
    <>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0014 0M12 18v3" />
    </>
  ),
  flag: <path d="M6 21V4l12 4-12 4" />,
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </>
  ),
  list: <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />,
  grid: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </>
  ),
  library: <path d="M4 5a2 2 0 012-2h5v18H6a2 2 0 01-2-2V5zM13 3h5a2 2 0 012 2v14a2 2 0 01-2 2h-5z" />,
  practice: (
    <>
      <path d="M4 5a2 2 0 012-2h12a2 2 0 012 2v12a2 2 0 01-2 2h-5l-3 3-3-3H6a2 2 0 01-2-2z" />
      <circle cx="12" cy="11" r="2" />
    </>
  ),
  transcribe: (
    <>
      <path d="M9 3H5a2 2 0 00-2 2v14a2 2 0 002 2h4M15 3h4a2 2 0 012 2v5" />
      <path d="M13 21h5a2 2 0 002-2v-2M3 12h6M3 16h4M13 8h4" />
    </>
  ),
  dashboard: (
    <>
      <rect x="3" y="3" width="8" height="8" rx="1" />
      <rect x="13" y="3" width="8" height="5" rx="1" />
      <rect x="13" y="10" width="8" height="11" rx="1" />
      <rect x="3" y="13" width="8" height="8" rx="1" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19 12a7 7 0 00-.2-1.6l2-1.6-2-3.4-2.4 1a7 7 0 00-2.7-1.6L13 2h-2l-.7 2.8a7 7 0 00-2.7 1.6l-2.4-1-2 3.4 2 1.6A7 7 0 005 12c0 .5.1 1.1.2 1.6l-2 1.6 2 3.4 2.4-1a7 7 0 002.7 1.6L11 22h2l.7-2.8a7 7 0 002.7-1.6l2.4 1 2-3.4-2-1.6c.1-.5.2-1 .2-1.6z" />
    </>
  ),
};

export type IconName = keyof typeof ICON_PATHS & string;

export function Icon({
  name,
  size = 18,
  className,
  strokeWidth = 1.8,
}: {
  name: IconName;
  size?: number;
  className?: string;
  strokeWidth?: number;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {ICON_PATHS[name]}
    </svg>
  );
}

// ── Button ────────────────────────────────────────────────────────
type BtnVariant = 'primary' | 'ghost' | 'outline' | 'danger' | 'success' | 'subtle';

export function Button({
  variant = 'primary',
  size = 'md',
  icon,
  children,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: BtnVariant;
  size?: 'xs' | 'sm' | 'md';
  icon?: IconName;
}) {
  const sizes = { xs: 'px-2 py-1 text-xs', sm: 'px-2.5 py-1.5 text-sm', md: 'px-3.5 py-2 text-sm' };
  const variants: Record<BtnVariant, string> = {
    primary: 'bg-brand text-white hover:bg-blue-700 disabled:bg-blue-300',
    ghost: 'text-ink-soft hover:bg-black/5 hover:text-ink',
    outline: 'border border-line text-ink hover:bg-black/5',
    danger: 'bg-red-600 text-white hover:bg-red-700',
    success: 'bg-success text-white hover:bg-green-700',
    subtle: 'bg-brand-soft text-brand hover:bg-blue-100',
  };
  return (
    <button
      type="button"
      className={cn(
        'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45',
        sizes[size],
        variants[variant],
        className,
      )}
      {...rest}
    >
      {icon && <Icon name={icon} size={size === 'xs' ? 14 : size === 'sm' ? 15 : 16} />}
      {children}
    </button>
  );
}

// ── IconButton ────────────────────────────────────────────────────
export function IconButton({
  name,
  label,
  active,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { name: IconName; label: string; active?: boolean }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      className={cn(
        'inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border transition-colors disabled:opacity-40',
        active
          ? 'border-brand bg-brand-soft text-brand'
          : 'border-line bg-surface text-ink-soft hover:bg-black/5 hover:text-ink',
        className,
      )}
      {...rest}
    >
      <Icon name={name} size={18} />
    </button>
  );
}

// ── Segmented ─────────────────────────────────────────────────────
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  className,
}: {
  options: { value: T; label: ReactNode }[];
  value: T;
  onChange: (v: T) => void;
  className?: string;
}) {
  return (
    <div className={cn('inline-flex rounded-lg border border-line bg-surface p-0.5', className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn(
            'rounded-md px-2.5 py-1 text-sm font-medium transition-colors',
            value === o.value ? 'bg-brand text-white' : 'text-ink-soft hover:text-ink',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ── Slider ────────────────────────────────────────────────────────
export function Slider({
  min = 0,
  max = 100,
  step = 1,
  value,
  onChange,
  className,
  ariaLabel,
}: {
  min?: number;
  max?: number;
  step?: number;
  value: number;
  onChange: (v: number) => void;
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      aria-label={ariaLabel}
      onChange={(e) => onChange(Number(e.target.value))}
      className={cn(
        'h-1.5 w-full cursor-pointer appearance-none rounded-full bg-line accent-brand',
        className,
      )}
    />
  );
}

// ── Select ────────────────────────────────────────────────────────
export function Select<T extends string>({
  value,
  onChange,
  options,
  className,
  ariaLabel,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <select
      value={value}
      aria-label={ariaLabel}
      onChange={(e) => onChange(e.target.value as T)}
      className={cn(
        'rounded-lg border border-line bg-surface px-2 py-1.5 text-sm text-ink outline-none focus:border-brand',
        className,
      )}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

// ── Toggle ────────────────────────────────────────────────────────
export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-5.5 w-10 shrink-0 items-center rounded-full px-0.5 transition-colors',
        checked ? 'bg-brand' : 'bg-gray-300',
      )}
    >
      <span
        className={cn(
          'inline-block h-4.5 w-4.5 transform rounded-full bg-white shadow transition-transform',
          checked ? 'translate-x-4.5' : 'translate-x-0',
        )}
      />
    </button>
  );
}

// ── Checkbox ──────────────────────────────────────────────────────
export function Checkbox({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: ReactNode;
}) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-ink">
      <input
        type="checkbox"
        className="h-4 w-4 accent-brand"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
}

// ── TextField / Field ─────────────────────────────────────────────
export function TextField({
  className,
  ...rest
}: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'w-full rounded-lg border border-line bg-surface px-2.5 py-1.5 text-sm text-ink outline-none placeholder:text-gray-400 focus:border-brand',
        className,
      )}
      {...rest}
    />
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-ink-soft">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-gray-400">{hint}</span>}
    </label>
  );
}

// ── Badge / Tag ───────────────────────────────────────────────────
export function Badge({
  children,
  tone = 'neutral',
  className,
}: {
  children: ReactNode;
  tone?: 'neutral' | 'brand' | 'amber' | 'success' | 'danger' | 'gold';
  className?: string;
}) {
  const tones = {
    neutral: 'bg-gray-100 text-gray-600',
    brand: 'bg-brand-soft text-brand',
    amber: 'bg-amber-50 text-amber-700',
    success: 'bg-green-50 text-success',
    danger: 'bg-red-50 text-red-600',
    gold: 'bg-yellow-50 text-yellow-700',
  };
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

// ── Progress ──────────────────────────────────────────────────────
export function Progress({
  value,
  max = 100,
  className,
  barClass,
}: {
  value: number;
  max?: number;
  className?: string;
  barClass?: string;
}) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div className={cn('h-2 w-full overflow-hidden rounded-full bg-gray-200', className)}>
      <div
        className={cn('h-full rounded-full bg-brand transition-all duration-300', barClass)}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

// ── Spinner / EmptyState / Card ───────────────────────────────────
export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={cn('animate-spin text-brand', className)} width="18" height="18" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 00-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function EmptyState({
  icon = 'library',
  title,
  desc,
  children,
}: {
  icon?: IconName;
  title: string;
  desc?: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-line bg-canvas/60 px-6 py-12 text-center">
      <div className="text-gray-300">
        <Icon name={icon} size={40} />
      </div>
      <h3 className="text-sm font-semibold text-ink">{title}</h3>
      {desc && <p className="max-w-sm text-sm text-ink-soft">{desc}</p>}
      {children}
    </div>
  );
}

export function Card({ className, children, style }: { className?: string; children: ReactNode; style?: CSSProperties }) {
  return (
    <div style={style} className={cn('rounded-xl border border-line bg-surface', className)}>
      {children}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-md bg-gray-200', className)} />;
}

// ── Modal / Confirm ───────────────────────────────────────────────
export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  width = 'max-w-md',
}: {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: string;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} aria-hidden="true" />
      <div className={cn('relative w-full rounded-2xl bg-surface p-5 shadow-2xl', width)}>
        <div className="mb-3 flex items-start justify-between gap-3">
          <h3 className="text-base font-semibold text-ink">{title}</h3>
          <IconButton name="close" label="关闭" className="border-0 bg-transparent" onClick={onClose} />
        </div>
        <div className="max-h-[70vh] overflow-y-auto fretly-scroll">{children}</div>
        {footer && <div className="mt-4 flex justify-end gap-2">{footer}</div>}
      </div>
    </div>
  );
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmText = '确定',
  danger,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmText?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal
      open={open}
      title={title}
      onClose={onCancel}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            取消
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm}>
            {confirmText}
          </Button>
        </>
      }
    >
      <div className="text-sm text-ink-soft">{message}</div>
    </Modal>
  );
}

// ── Toast viewport ────────────────────────────────────────────────
const TOAST_STYLE: Record<ToastType, string> = {
  success: 'border-green-200 bg-green-50 text-green-800',
  error: 'border-red-200 bg-red-50 text-red-800',
  warn: 'border-amber-200 bg-amber-50 text-amber-800',
  info: 'border-blue-200 bg-blue-50 text-blue-800',
};

export function Toasts() {
  const toasts = useAppStore((s) => s.toasts);
  const dismiss = useAppStore((s) => s.dismissToast);
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-80 flex-col gap-2">
      {toasts.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => dismiss(t.id)}
          className={cn(
            'pointer-events-auto rounded-xl border px-3.5 py-2.5 text-left text-sm shadow-lg',
            TOAST_STYLE[t.type],
          )}
        >
          {t.text}
        </button>
      ))}
    </div>
  );
}

// ── Difficulty bar ────────────────────────────────────────────────
export function DifficultyDots({ value, max = 5 }: { value: number; max?: number }) {
  return (
    <span className="inline-flex items-center gap-0.5" title={`难度 ${value}/${max}`}>
      {Array.from({ length: max }, (_, i) => (
        <span
          key={i}
          className={cn('h-1.5 w-1.5 rounded-full', i < value ? 'bg-amber' : 'bg-gray-200')}
        />
      ))}
    </span>
  );
}

// ── hooks ─────────────────────────────────────────────────────────
export function useRaf(cb: (now: number, dt: number) => void): void {
  const cbRef = useRef(cb);
  cbRef.current = cb;
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = now - last;
      last = now;
      cbRef.current(now, dt);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
}

export function useDebouncedValue<T>(value: T, delayMs = 250): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

export function useHotkeys(
  map: { key: string; handler: () => void; mod?: boolean; shift?: boolean }[],
  deps: unknown[] = [],
): void {
  const refs = useRef(map);
  refs.current = map;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      for (const h of refs.current) {
        const modOk = h.mod ? e.metaKey || e.ctrlKey : !(e.metaKey || e.ctrlKey);
        const shiftOk = h.shift ? e.shiftKey : !e.shiftKey;
        if (modOk && shiftOk && e.key.toLowerCase() === h.key.toLowerCase()) {
          e.preventDefault();
          h.handler();
          return;
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

export function useMounted(): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted;
}

// 唯一 select id 帮助（表单可访问性）
export function useUniqueId(): string {
  return useId();
}
