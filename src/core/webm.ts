/**
 * MediaRecorder writes WebM files for live streaming: the Segment has an
 * "unknown" size and the Info element has no Duration, so players show 0:00
 * and can't seek. This inserts (or overwrites) the Duration in Segment Info.
 */

const ID_EBML = 0x1a45dfa3;
const ID_SEGMENT = 0x18538067;
const ID_INFO = 0x1549a966;
const ID_TIMECODE_SCALE = 0x2ad7b1;
const ID_DURATION = 0x4489;

interface Element {
  id: number;
  /** Offset of the element's first byte. */
  start: number;
  /** Offset of the element's data. */
  dataStart: number;
  /** Data size, or -1 for "unknown". */
  size: number;
  /** Byte length of the size field. */
  sizeLength: number;
}

function readId(buf: Uint8Array, pos: number): { id: number; length: number } | null {
  const first = buf[pos];
  if (first === undefined || first === 0) return null;
  const length = Math.clz32(first) - 23;
  if (length < 1 || length > 4 || pos + length > buf.length) return null;
  let id = 0;
  for (let i = 0; i < length; i++) id = id * 256 + buf[pos + i];
  return { id, length };
}

function readSize(buf: Uint8Array, pos: number): { size: number; length: number } | null {
  const first = buf[pos];
  if (first === undefined || first === 0) return null;
  const length = Math.clz32(first) - 23;
  if (length < 1 || length > 8 || pos + length > buf.length) return null;
  let value = first & (0xff >> length);
  let allOnes = value === 0xff >> length;
  for (let i = 1; i < length; i++) {
    value = value * 256 + buf[pos + i];
    if (buf[pos + i] !== 0xff) allOnes = false;
  }
  return { size: allOnes ? -1 : value, length };
}

function readElement(buf: Uint8Array, pos: number): Element | null {
  const id = readId(buf, pos);
  if (!id) return null;
  const size = readSize(buf, pos + id.length);
  if (!size) return null;
  return { id: id.id, start: pos, dataStart: pos + id.length + size.length, size: size.size, sizeLength: size.length };
}

function children(buf: Uint8Array, start: number, end: number): Element[] {
  const out: Element[] = [];
  let pos = start;
  while (pos < end) {
    const el = readElement(buf, pos);
    if (!el || el.size < 0) break;
    out.push(el);
    pos = el.dataStart + el.size;
  }
  return out;
}

/** An 8-byte EBML size field. */
function size8(n: number): Uint8Array {
  const out = new Uint8Array(8);
  out[0] = 0x01;
  let v = n;
  for (let i = 7; i >= 1; i--) {
    out[i] = v % 256;
    v = Math.floor(v / 256);
  }
  return out;
}

function readUint(buf: Uint8Array, start: number, length: number): number {
  let v = 0;
  for (let i = 0; i < length; i++) v = v * 256 + buf[start + i];
  return v;
}

/**
 * Returns a copy of `webm` whose Segment Info carries `durationMs`, or the
 * input unchanged if the file doesn't look like WebM.
 */
export function setWebmDuration(webm: Uint8Array, durationMs: number): Uint8Array {
  const header = readElement(webm, 0);
  if (!header || header.id !== ID_EBML || header.size < 0) return webm;
  const segment = readElement(webm, header.dataStart + header.size);
  if (!segment || segment.id !== ID_SEGMENT) return webm;
  const segmentEnd = segment.size < 0 ? webm.length : segment.dataStart + segment.size;

  let pos = segment.dataStart;
  let info: Element | null = null;
  while (pos < segmentEnd) {
    const el = readElement(webm, pos);
    if (!el || el.size < 0) break;
    if (el.id === ID_INFO) {
      info = el;
      break;
    }
    pos = el.dataStart + el.size;
  }
  if (!info) return webm;

  const kids = children(webm, info.dataStart, info.dataStart + info.size);
  const scaleEl = kids.find((k) => k.id === ID_TIMECODE_SCALE);
  const timecodeScale = scaleEl ? readUint(webm, scaleEl.dataStart, scaleEl.size) : 1_000_000;
  const duration = (durationMs * 1e6) / (timecodeScale || 1_000_000);

  const existing = kids.find((k) => k.id === ID_DURATION);
  if (existing && (existing.size === 8 || existing.size === 4)) {
    const out = webm.slice();
    const view = new DataView(out.buffer, out.byteOffset + existing.dataStart, existing.size);
    if (existing.size === 8) view.setFloat64(0, duration);
    else view.setFloat32(0, duration);
    return out;
  }

  // Rebuild Info with a Duration element appended.
  const durationEl = new Uint8Array(2 + 1 + 8);
  durationEl.set([0x44, 0x89, 0x88]); // ID, size = 8 (one-byte vint)
  new DataView(durationEl.buffer).setFloat64(3, duration);
  const oldData = webm.subarray(info.dataStart, info.dataStart + info.size);
  const newSize = oldData.length + durationEl.length;
  const infoId = new Uint8Array([0x15, 0x49, 0xa9, 0x66]);
  const newInfo = new Uint8Array(infoId.length + 8 + newSize);
  newInfo.set(infoId, 0);
  newInfo.set(size8(newSize), 4);
  newInfo.set(oldData, 12);
  newInfo.set(durationEl, 12 + oldData.length);

  const before = webm.subarray(0, info.start);
  const after = webm.subarray(info.dataStart + info.size);
  const out = new Uint8Array(before.length + newInfo.length + after.length);
  out.set(before, 0);
  out.set(newInfo, before.length);
  out.set(after, before.length + newInfo.length);

  // A Segment with a known size must grow by the same amount.
  if (segment.size >= 0) {
    const grown = segment.size + (newInfo.length - (info.dataStart + info.size - info.start));
    if (segment.sizeLength !== 8) return webm; // can't grow a short size field in place
    out.set(size8(grown), segment.start + 4);
  }
  return out;
}
