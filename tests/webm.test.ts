import { describe, expect, it } from 'vitest';
import { setWebmDuration } from '../src/core/webm';

const hex = (s: string) =>
  Uint8Array.from(
    s
      .replace(/\s+/g, '')
      .match(/../g)!
      .map((b) => parseInt(b, 16)),
  );

// EBML header (DocType "webm"), then a Segment holding Info (TimecodeScale, MuxingApp) and a Cluster.
const EBML = '1A45DFA3 87 4282 84 7765626D';
const INFO_BODY = '2AD7B1 83 0F4240 4D80 82 4368';
const CLUSTER = '1F43B675 84 DEADBEEF';

function readDuration(buf: Uint8Array): number | null {
  for (let i = 0; i + 11 <= buf.length; i++) {
    if (buf[i] === 0x44 && buf[i + 1] === 0x89 && buf[i + 2] === 0x88)
      return new DataView(buf.buffer, buf.byteOffset + i + 3, 8).getFloat64(0);
  }
  return null;
}

describe('WebM duration patch', () => {
  it('adds a Duration to a live-recorded (unknown-size) segment', () => {
    const file = hex(`${EBML} 18538067 01FFFFFFFFFFFFFF 1549A966 8A ${INFO_BODY} ${CLUSTER}`);
    const out = setWebmDuration(file, 3250);
    expect(readDuration(out)).toBeCloseTo(3250, 6);
    // The cluster is untouched and still follows the grown Info element.
    expect(Array.from(out.slice(-hex(CLUSTER).length))).toEqual(Array.from(hex(CLUSTER)));
    expect(out.length).toBe(file.length + 11 + 7); // + Duration element, + wider Info size field
  });

  it('respects the TimecodeScale', () => {
    // TimecodeScale = 1 000 (1 µs ticks): 2 s → 2 000 000 ticks.
    const file = hex(`${EBML} 18538067 01FFFFFFFFFFFFFF 1549A966 89 2AD7B1 82 03E8 4D80 82 4368 ${CLUSTER}`);
    expect(readDuration(setWebmDuration(file, 2000))).toBeCloseTo(2_000_000, 3);
  });

  it('overwrites an existing Duration in place', () => {
    const file = hex(`${EBML} 18538067 01FFFFFFFFFFFFFF 1549A966 95 ${INFO_BODY} 4489 88 0000000000000000 ${CLUSTER}`);
    const out = setWebmDuration(file, 1234);
    expect(out.length).toBe(file.length);
    expect(readDuration(out)).toBeCloseTo(1234, 6);
  });

  it('grows a known-size segment', () => {
    const body = `1549A966 8A ${INFO_BODY} ${CLUSTER}`;
    const size = hex(body).length;
    const file = hex(`${EBML} 18538067 01${size.toString(16).padStart(14, '0')} ${body}`);
    const out = setWebmDuration(file, 500);
    const segSizeAt = hex(EBML).length + 4;
    const newSize = new DataView(out.buffer, out.byteOffset + segSizeAt + 1, 7);
    let v = 0;
    for (let i = 0; i < 7; i++) v = v * 256 + newSize.getUint8(i);
    expect(v).toBe(out.length - (segSizeAt + 8));
  });

  it('leaves other files alone', () => {
    const notWebm = hex('000000186674797069736F6D');
    expect(setWebmDuration(notWebm, 1000)).toBe(notWebm);
  });
});
