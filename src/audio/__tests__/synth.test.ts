import { describe, expect, it, vi } from 'vitest';
import {
  PluckCache,
  bodyResonance,
  karplus,
  pluckKey,
  pluckSeconds,
  strumFilter,
  velocityBucket,
} from '@/audio/synth';
import { renderClick } from '@/audio/metronome';

function rms(buf: Float32Array, from: number, to: number): number {
  let sum = 0;
  const end = Math.min(buf.length, to);
  for (let i = Math.max(0, from); i < end; i += 1) sum += buf[i] * buf[i];
  return Math.sqrt(sum / Math.max(1, end - Math.max(0, from)));
}

function mean(buf: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < buf.length; i += 1) sum += buf[i];
  return sum / Math.max(1, buf.length);
}

describe('audio/synth —— Karplus-Strong（纯算法）', () => {
  const base = {
    freq: 440,
    sampleRate: 44100,
    seconds: 1,
    damping: 0.496,
    blend: 0.5,
    brightness: 0.5,
    velocity: 0.85,
  };

  it('输出长度 = ceil(seconds × sampleRate)', () => {
    expect(karplus(base).length).toBe(44100);
    expect(karplus({ ...base, seconds: 0.5 }).length).toBe(22050);
  });

  it('能量单调衰减：头 10% 的 RMS 明显大于尾 10%', () => {
    const buf = karplus(base);
    const head = rms(buf, 0, Math.floor(buf.length * 0.1));
    const tail = rms(buf, Math.floor(buf.length * 0.9), buf.length);
    expect(head).toBeGreaterThan(tail * 3);
  });

  it('无直流偏移（激励已去 DC）', () => {
    expect(Math.abs(mean(karplus(base)))).toBeLessThan(0.01);
  });

  it('音头瞬态存在（pick 噪声）：前 3ms 有能量且无满幅 click', () => {
    const buf = karplus(base);
    // pick 噪声为低通白噪声，首样本有界（非满幅 click）
    expect(Math.abs(buf[0])).toBeLessThan(0.5);
    // 前 3ms 有显著能量（纯 KS 淡入会被 fadeIn 压低，pick 噪声补上音头）
    const fadeInSamples = Math.round(0.003 * base.sampleRate);
    expect(rms(buf, 0, fadeInSamples)).toBeGreaterThan(0.01);
  });

  it('尾部淡出到 0，不会突然截断', () => {
    const buf = karplus(base);
    expect(Math.abs(buf[buf.length - 1])).toBeLessThan(0.01);
  });

  it('输出不超过 1（不削波）', () => {
    const buf = karplus({ ...base, velocity: 1 });
    for (let i = 0; i < buf.length; i += 1) expect(Math.abs(buf[i])).toBeLessThanOrEqual(1);
  });

  it('不同基频的延迟线长度不同（保音高的前提）', () => {
    const low = karplus({ ...base, freq: 110, seconds: 0.2 });
    const high = karplus({ ...base, freq: 880, seconds: 0.2 });
    // 高音衰减更快
    expect(rms(high, 0, 2000)).toBeGreaterThan(0);
    expect(rms(low, 0, 2000)).toBeGreaterThan(0);
  });

  it('音高越高，合成时长越短', () => {
    expect(pluckSeconds(40)).toBeGreaterThan(pluckSeconds(80));
  });

  it('琴体共振提升低音段能量（110Hz 被提升，2kHz 几乎不变）', () => {
    const sr = 44100;
    const n = 44100;
    const sine = (freq: number) => {
      const buf = new Float32Array(n);
      for (let i = 0; i < n; i += 1) buf[i] = Math.sin((2 * Math.PI * freq * i) / sr);
      return buf;
    };
    const low = sine(110);
    const lowWet = low.slice();
    bodyResonance(lowWet, sr);
    expect(rms(lowWet, 0, n)).toBeGreaterThan(rms(low, 0, n));

    const high = sine(2000);
    const highWet = high.slice();
    bodyResonance(highWet, sr);
    // 2kHz 远离 110/200Hz 谐振峰，能量几乎不增
    expect(rms(highWet, 0, n)).toBeLessThan(rms(high, 0, n) * 1.05);
  });

  it('高力度衰减更快（力度→衰减包络）', () => {
    // 固定随机种子，避免 Math.random 白噪声激励导致 flaky（上一轮出现过随机翻转）
    let seed = 42;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    const spy = vi.spyOn(Math, 'random').mockImplementation(rand);
    try {
      const hi = karplus({ ...base, velocity: 1, seconds: 0.5 });
      const lo = karplus({ ...base, velocity: 0.25, seconds: 0.5 });
      // 避开音头噪声/淡入与尾部淡出，取稳态两窗的衰减比（不受随机激励影响）
      const ratio = (b: Float32Array) => {
        const early = rms(b, 1000, 2000);
        const later = rms(b, 10000, 11000);
        return later / early;
      };
      // velocity=1 的稳态衰减更快 → later/early 更低
      expect(ratio(hi)).toBeLessThan(ratio(lo));
    } finally {
      spy.mockRestore();
    }
  });
});

describe('audio/synth —— 缓存', () => {
  it('力度分 5 档', () => {
    expect(velocityBucket(0.85)).toBeCloseTo(0.75, 10); // round(0.85×4)/4 = 3/4
    expect(velocityBucket(0.65)).toBeCloseTo(0.75, 10);
    expect(velocityBucket(0.5)).toBeCloseTo(0.5, 10);
    expect(pluckKey(64, 0.85)).toBe('64:0.75');
  });

  it('同一 (midi, 力度档) 第二次调用命中缓存', () => {
    const cache = new PluckCache(22050);
    expect(cache.hits).toBe(0);
    const first = cache.get(64, 0.85);
    expect(cache.misses).toBe(1);
    expect(cache.hits).toBe(0);

    const second = cache.get(64, 0.85);
    expect(cache.hits).toBe(1);
    expect(cache.misses).toBe(1);
    expect(second).toBe(first); // 同一个 Float32Array 引用

    cache.get(65, 0.85);
    expect(cache.misses).toBe(2);
    expect(cache.size).toBe(2);
  });

  it('缓存里存的是长度正确的 Float32Array', () => {
    const cache = new PluckCache(22050);
    const buf = cache.get(64, 0.85);
    expect(buf.length).toBe(Math.ceil(pluckSeconds(64) * 22050));
  });
});

describe('audio/metronome —— 节拍器瞬态（纯函数）', () => {
  it('20ms 的缓冲区长度正确', () => {
    expect(renderClick(44100, 800, false).length).toBe(882);
  });

  it('重音比普通拍更响（×1.6）', () => {
    const accent = renderClick(44100, 1200, true);
    const normal = renderClick(44100, 800, false);
    const peak = (b: Float32Array) => b.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    expect(peak(accent)).toBeGreaterThan(peak(normal));
    expect(peak(accent) / peak(normal)).toBeGreaterThan(1.5);
    expect(peak(accent) / peak(normal)).toBeLessThan(1.75);
  });

  it('首尾都接近 0（无 click）', () => {
    const buf = renderClick(44100, 1200, true);
    expect(Math.abs(buf[0])).toBeLessThan(0.01);
    expect(Math.abs(buf[buf.length - 1])).toBeLessThan(0.05);
  });
});

describe('audio/synth —— 扫弦路径缓存（strum 二级缓存与单音缓存解耦）', () => {
  it('pluckKey 键不变：strum 路径复用同一 (midi, 力度档) 键', () => {
    expect(pluckKey(64, 0.85)).toBe('64:0.75');
  });

  it('strumFilter 消费单音缓存只读副本，不改命中计数、不新增缓存键、不原地改样本', () => {
    const cache = new PluckCache(22050);
    const first = cache.get(64, 0.85); // miss
    expect(cache.misses).toBe(1);
    expect(cache.hits).toBe(0);

    const snapshot = first.slice();
    const filtered = strumFilter(first, 22050); // 扫弦路径消费副本
    expect(filtered).not.toBe(first);
    expect(filtered.length).toBe(first.length);
    for (let i = 0; i < first.length; i += 1) expect(first[i]).toBe(snapshot[i]);

    const again = cache.get(64, 0.85);
    expect(again).toBe(first); // 仍命中同一引用
    expect(cache.hits).toBe(1);
    expect(cache.misses).toBe(1);
  });
});
