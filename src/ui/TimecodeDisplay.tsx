import qrcode from 'qrcode-generator';
import { useEffect, useRef } from 'preact/hooks';
import { cellColors, cellRect, TC_CELLS, TC_PATTERN_HEIGHT, type TimecodeLog } from '../core/timecode';
import { perfToLocal } from '../core/time';
import { counterAt } from '../process/timecodeReader';

function formatClock(t: number): string {
  const d = new Date(t);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/**
 * A running millisecond clock for people, plus a code for cameras: a static
 * QR (carrying `payload`) with a Gray-coded counter underneath that advances
 * every 1/60 s since `epoch`. Every change is logged with the host time it was
 * drawn, so a photo of this screen can be turned back into an exact time.
 */
export function TimecodeDisplay({ payload, epoch, log }: { payload: string; epoch: number; log?: TimecodeLog }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const clockRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const qr = qrcode(0, 'M');
    qr.addData(payload);
    qr.make();
    const modules = qr.getModuleCount();
    const px = Math.max(8, Math.floor(480 / modules));
    const size = modules * px;
    const quiet = 4 * px;
    canvas.width = size + 2 * quiet;
    canvas.height = Math.ceil(size * TC_PATTERN_HEIGHT) + 2 * quiet;
    const ctx = canvas.getContext('2d', { alpha: false })!;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#000';
    for (let r = 0; r < modules; r++) for (let c = 0; c < modules; c++) if (qr.isDark(r, c)) ctx.fillRect(quiet + c * px, quiet + r * px, px, px);
    const cells = Array.from({ length: TC_CELLS }, (_, i) => {
      const rect = cellRect(i);
      const gap = rect.w * 0.06 * size;
      return {
        x: Math.round(quiet + rect.x * size + gap),
        y: Math.round(quiet + rect.y * size + gap),
        w: Math.round(rect.w * size - 2 * gap),
        h: Math.round(rect.h * size - 2 * gap),
      };
    });
    let last = Number.NaN;
    let raf = 0;
    const draw = (ts: number) => {
      const hostTime = perfToLocal(ts);
      const counter = counterAt(hostTime, epoch);
      if (counter !== last) {
        last = counter;
        log?.record(((counter % 4096) + 4096) % 4096, hostTime);
        const colors = cellColors(counter);
        for (let i = 0; i < TC_CELLS; i++) {
          ctx.fillStyle = colors[i] ? '#fff' : '#000';
          ctx.fillRect(cells[i].x, cells[i].y, cells[i].w, cells[i].h);
        }
      }
      if (clockRef.current) clockRef.current.textContent = formatClock(hostTime);
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [payload, epoch, log]);

  return (
    <div class="timecode">
      <canvas ref={canvasRef} role="img" aria-label="Sync code for cameras" />
      <div class="clock" ref={clockRef} aria-hidden="true" />
    </div>
  );
}
