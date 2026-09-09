/**
 * ULID 生成（自实现，约 25 行，不引第三方包）。
 * 格式：10 位时间戳 + 16 位随机数，Crockford base32（去掉 I / L / O / U）。
 */

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_LEN = 10;
const RAND_LEN = 16;

function randomBytes(n: number): Uint8Array {
  const bytes = new Uint8Array(n);
  const cryptoObj = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;
  if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
    cryptoObj.getRandomValues(bytes);
    return bytes;
  }
  // 极老的运行时兜底：单测与非浏览器环境下不会走到这里
  for (let i = 0; i < n; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return bytes;
}

export function ulid(now: number = Date.now()): string {
  let time = '';
  let t = Math.max(0, Math.floor(now));
  for (let i = 0; i < TIME_LEN; i += 1) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }

  const bytes = randomBytes(RAND_LEN);
  let rand = '';
  for (let i = 0; i < RAND_LEN; i += 1) rand += CROCKFORD[bytes[i] & 31];

  return time + rand;
}

export type IdPrefix = 'tab' | 'job' | 'ses' | 'col' | 'trk' | 'n' | 'mk' | 'draft';

/** newId('tab') → 'tab_01J8XQ7T2R4V6M8N0P2Q4S6T' */
export function newId<P extends string>(prefix: P, now: number = Date.now()): `${P}_${string}` {
  return `${prefix}_${ulid(now)}` as `${P}_${string}`;
}
