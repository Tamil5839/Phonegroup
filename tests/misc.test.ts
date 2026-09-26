import { describe, expect, it } from 'vitest';
import { cleanName, parseHostMessage, parseShooterMessage } from '../src/core/protocol';
import { CODE_ALPHABET, generateRoomCode, normalizeRoomCode } from '../src/core/roomCode';
import { buildTimeline, frameAt, timelineDuration, type ClipStyle } from '../src/core/sequence';

describe('room codes', () => {
  it('generates 6-character codes from the unambiguous alphabet', () => {
    for (let i = 0; i < 200; i++) {
      const code = generateRoomCode();
      expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}$/);
      expect(normalizeRoomCode(code)).toBe(code);
    }
    expect(CODE_ALPHABET).toHaveLength(32);
  });

  it('forgives case, spaces and look-alike characters', () => {
    expect(normalizeRoomCode('ab c-12o')).toBe('ABC120');
    expect(normalizeRoomCode('iL0oU9')).toBe('1100V9');
    expect(normalizeRoomCode('ABC12')).toBeNull();
    expect(normalizeRoomCode('ABC12!')).toBeNull();
  });
});

describe('protocol validation', () => {
  it('accepts well-formed messages', () => {
    expect(parseShooterMessage(JSON.stringify({ t: 'ping', id: 1, t0: 5.5 }))).toEqual({ t: 'ping', id: 1, t0: 5.5 });
    expect(parseHostMessage(JSON.stringify({ t: 'countdown', captureId: 'abc', target: 123.4, mode: 'moment' }))).toBeTruthy();
  });

  it('rejects malformed or unknown messages', () => {
    expect(parseShooterMessage('not json')).toBeNull();
    expect(parseShooterMessage(JSON.stringify({ t: 'ping', id: 'x', t0: 1 }))).toBeNull();
    expect(parseShooterMessage(JSON.stringify({ t: 'countdown', captureId: 'a', target: 1, mode: 'moment' }))).toBeNull();
    expect(parseShooterMessage(JSON.stringify({ t: '__proto__' }))).toBeNull();
    expect(parseHostMessage(JSON.stringify({ t: 'countdown', captureId: 'a', target: 1, mode: 'boom' }))).toBeNull();
    expect(
      parseShooterMessage(JSON.stringify({ t: 'hello', v: 1, clientId: 'x'.repeat(100), name: 'a', device: { ua: '', mobile: true } })),
    ).toBeNull();
  });

  it('cleans display names', () => {
    expect(cleanName('  Ana   Lopez  ')).toBe('Ana Lopez');
    expect(cleanName('')).toBe('Shooter');
    expect(cleanName('x'.repeat(40))).toHaveLength(24);
  });
});

describe('clip timelines', () => {
  const styles: ClipStyle[] = ['sweep', 'sweep-life', 'loop'];

  it('keeps clips between 3 and 6 seconds for 4–24 phones at 12–18 fps', () => {
    for (const style of styles) {
      for (let n = 4; n <= 24; n++) {
        for (const fps of [12, 15, 18]) {
          const tl = buildTimeline({ style, count: n, fps, targetMs: 4000 });
          const d = timelineDuration(tl);
          expect(d, `${style} n=${n} fps=${fps}`).toBeGreaterThanOrEqual(2900);
          expect(d, `${style} n=${n} fps=${fps}`).toBeLessThanOrEqual(6600);
          expect(tl.every((f) => f.frame >= 0 && f.frame < n && f.ms > 0)).toBe(true);
        }
      }
    }
  });

  it('sweeps left to right and back', () => {
    const tl = buildTimeline({ style: 'sweep', count: 4, fps: 15, targetMs: 3000 });
    const order = tl.map((f) => f.frame);
    expect(order.slice(0, 7)).toEqual([0, 1, 2, 3, 2, 1, 0]);
    // Every step moves to an adjacent phone.
    for (let i = 1; i < order.length; i++) expect(Math.abs(order[i] - order[i - 1])).toBe(1);
  });

  it('loops seamlessly: the wrap-around is a normal step', () => {
    const tl = buildTimeline({ style: 'loop', count: 5, fps: 15, targetMs: 3000 });
    const order = tl.map((f) => f.frame);
    for (let i = 0; i < order.length; i++) {
      const next = order[(i + 1) % order.length];
      expect(Math.abs(next - order[i])).toBe(1);
    }
    expect(new Set(tl.map((f) => f.ms)).size).toBe(1);
  });

  it('unfreezes on the hero phone at the end of sweep-life', () => {
    const tl = buildTimeline({ style: 'sweep-life', count: 8, fps: 15, heroIndex: 3, heroForward: [1, 2, 3] });
    const tail = tl.slice(-3);
    expect(tail.map((f) => [f.frame, f.sub])).toEqual([
      [3, 1],
      [3, 2],
      [3, 3],
    ]);
    expect(tl[tl.length - 4]).toMatchObject({ frame: 3, sub: 0 });
    expect(tl.slice(0, -3).every((f) => f.sub === 0)).toBe(true);
  });

  it('finds the frame at a given time, looping', () => {
    const tl = [
      { frame: 0, sub: 0, ms: 100 },
      { frame: 1, sub: 0, ms: 50 },
    ];
    expect(frameAt(tl, 0)!.frame).toBe(0);
    expect(frameAt(tl, 120)!.frame).toBe(1);
    expect(frameAt(tl, 160)!.frame).toBe(0);
  });
});
