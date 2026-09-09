import { describe, expect, it } from 'vitest';
import { strumFilter } from '@/audio/synth';

const SR = 44100;

function sine(freq: number, n: number = SR): Float32Array<ArrayBuffer> {
  const buf = new Float32Array(n);
  for (let i = 0; i < n; i += 1) buf[i] = Math.sin((2 * Math.PI * freq * i) / SR);
  return buf;
}

function rms(buf: Float32Array, from: number, to: number): number {
  let sum = 0;
  const start = Math.max(0, from);
  const end = Math.min(buf.length, to);
  for (let i = start; i < end; i += 1) sum += buf[i] * buf[i];
  return Math.sqrt(sum / Math.max(1, end - start));
}

function peak(buf: Float32Array): number {
  let m = 0;
  for (let i = 0; i < buf.length; i += 1) m = Math.max(m, Math.abs(buf[i]));
  return m;
}

describe('audio/synth —— strumFilter（扫弦级高频软化，纯算法）', () => {
  it('频响：6kHz（阻带）衰减 ≥ 3dB，1kHz（通带）几乎不变（< ±10%）', () => {
    const hiIn = sine(6000);
    const hiOut = strumFilter(hiIn, SR);
    // 跳过起始瞬态，取稳态窗
    const db = 20 * Math.log10(rms(hiOut, 2000, SR) / rms(hiIn, 2000, SR));
    expect(db).toBeLessThan(-3);

    const loIn = sine(1000);
    const loOut = strumFilter(loIn, SR);
    const ratio = rms(loOut, 2000, SR) / rms(loIn, 2000, SR);
    expect(ratio).toBeGreaterThan(0.9);
    expect(ratio).toBeLessThan(1.1);
  });

  it('输出不削波：负增益 shelf 只减不增（满幅 6kHz 输出峰值 ≤ 输入且 ≤ 1）', () => {
    const input = sine(6000);
    const output = strumFilter(input, SR);
    expect(peak(output)).toBeLessThanOrEqual(peak(input));
    expect(peak(output)).toBeLessThanOrEqual(1);
  });

  it('不改入参：返回新数组，且原数组逐样本不变（缓存共享引用安全）', () => {
    const input = sine(440);
    const snapshot = input.slice();
    const output = strumFilter(input, SR);
    expect(output).not.toBe(input);
    expect(output.length).toBe(input.length);
    for (let i = 0; i < input.length; i += 1) expect(input[i]).toBe(snapshot[i]);
  });

  it('变速不变调：无重采样（长度不变）且基频不变（过零率不偏移）', () => {
    const input = sine(440);
    const output = strumFilter(input, SR);
    expect(output.length).toBe(input.length);

    const zeroCrossings = (buf: Float32Array): number => {
      let count = 0;
      for (let i = 1000; i < buf.length - 1; i += 1) {
        if ((buf[i] <= 0 && buf[i + 1] > 0) || (buf[i] >= 0 && buf[i + 1] < 0)) count += 1;
      }
      return count;
    };
    expect(Math.abs(zeroCrossings(output) - zeroCrossings(input))).toBeLessThanOrEqual(2);
  });

  it('无直流偏移（H(DC)=1，输入零均值则输出仍零均值）', () => {
    const input = sine(6000);
    const output = strumFilter(input, SR);
    let sum = 0;
    for (let i = 0; i < output.length; i += 1) sum += output[i];
    expect(Math.abs(sum / output.length)).toBeLessThan(0.001);
  });
});
