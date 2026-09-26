import { useState } from 'preact/hooks';
import type { DeliveryState, ShooterState } from '../../session/host';
import { Bar, TopBar } from '../components';
import type { ClipResult } from '../host/controller';
import { download, shareFile } from '../share';

export function ResultScreen({
  result,
  delivery,
  shooters,
  onEdit,
  onNew,
  newLabel = 'New moment',
}: {
  result: ClipResult;
  delivery?: Record<string, DeliveryState>;
  shooters?: ShooterState[];
  onEdit: () => void;
  onNew: () => void;
  newLabel?: string;
}) {
  const [shareNote, setShareNote] = useState<string | null>(null);
  const entries = delivery ? Object.entries(delivery) : [];
  const done = entries.filter(([, d]) => d.state === 'done').length;
  const names = new Map((shooters ?? []).map((s) => [s.id, s.name]));
  const isVideo = result.mime.startsWith('video/');

  return (
    <main class="screen">
      <TopBar title="Your frozen moment" />
      {isVideo ? (
        <video class="clip" src={result.url} autoplay loop muted playsInline controls aria-label="The finished clip" />
      ) : (
        <img class="clip" src={result.url} alt="The finished clip (animated)" />
      )}
      {result.method !== 'webcodecs' && (
        <p class="muted small">
          {result.method === 'gif'
            ? 'This browser cannot make videos, so the clip is an animated GIF.'
            : result.method === 'webcodecs-webm'
              ? "This browser can't make MP4 files, so the clip is a WebM video."
              : `Made with the browser's recorder (${result.mime}).`}
        </p>
      )}
      {entries.length > 0 && (
        <div class="card stack">
          <div class="row">
            <strong>Sending to everyone</strong>
            <div class="spacer" />
            <span class="chip accent">
              {done}/{entries.length} phones
            </span>
          </div>
          {entries.map(([id, d]) => (
            <div key={id} class="row small">
              <span style={{ width: 110, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{names.get(id) ?? 'Phone'}</span>
              <div style={{ flex: 1 }}>
                {d.state === 'failed' ? <span class="chip bad">Not delivered</span> : <Bar value={d.progress} label={`Sending to ${names.get(id) ?? 'phone'}`} />}
              </div>
            </div>
          ))}
        </div>
      )}
      {shareNote && <div class="notice info small">{shareNote}</div>}
      <div class="bottom-actions">
        <button
          class="btn primary big block"
          onClick={async () => {
            const r = await shareFile(result.blob, result.name, 'Made with Frozen Moment');
            if (r === 'downloaded') setShareNote('Saved to your downloads.');
          }}
        >
          Share
        </button>
        <button class="btn block" onClick={() => download(result.blob, result.name)}>
          Save
        </button>
        <div class="row">
          <button class="btn block" onClick={onEdit}>
            Edit again
          </button>
          <button class="btn block" onClick={onNew}>
            {newLabel}
          </button>
        </div>
      </div>
    </main>
  );
}
