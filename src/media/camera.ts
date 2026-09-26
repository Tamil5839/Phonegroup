/** Rear camera access with friendly errors. */

export interface CameraHandle {
  stream: MediaStream;
  track: MediaStreamTrack;
  width: number;
  height: number;
  fps: number;
  label: string;
  stop(): void;
}

export class CameraError extends Error {}

function explain(err: unknown): string {
  const name = (err as { name?: string })?.name ?? '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Camera access was blocked. Allow the camera for this site in your browser settings, then reload.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No suitable camera was found on this device.';
    case 'NotReadableError':
    case 'AbortError':
      return 'The camera is busy — close other apps that use it and try again.';
    default:
      return 'The camera could not be started.';
  }
}

/** Open the rear camera at the best resolution the phone offers (ideally 1920×1080 at 30 fps). */
export async function openCamera(video: HTMLVideoElement, facing: 'environment' | 'user' = 'environment'): Promise<CameraHandle> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new CameraError(
      window.isSecureContext
        ? 'This browser has no camera access. Try Chrome or Safari.'
        : 'The camera needs a secure (https://) connection.',
    );
  }
  const attempts: MediaStreamConstraints[] = [
    {
      audio: false,
      video: {
        facingMode: { ideal: facing },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 30 },
      },
    },
    { audio: false, video: { facingMode: { ideal: facing } } },
    { audio: false, video: true },
  ];
  let stream: MediaStream | null = null;
  let lastErr: unknown = null;
  for (const c of attempts) {
    try {
      stream = await navigator.mediaDevices.getUserMedia(c);
      break;
    } catch (err) {
      lastErr = err;
      const name = (err as { name?: string })?.name;
      if (name === 'NotAllowedError' || name === 'SecurityError') break;
    }
  }
  if (!stream) throw new CameraError(explain(lastErr));

  const track = stream.getVideoTracks()[0];
  video.muted = true;
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  video.srcObject = stream;
  try {
    await video.play();
  } catch {
    /* autoplay of a muted camera preview is allowed; retry on first tap otherwise */
  }
  if (!video.videoWidth) {
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      video.addEventListener('loadedmetadata', done, { once: true });
      setTimeout(done, 3000);
    });
  }
  const settings = track.getSettings();
  return {
    stream,
    track,
    width: video.videoWidth || settings.width || 0,
    height: video.videoHeight || settings.height || 0,
    fps: settings.frameRate || 30,
    label: track.label,
    stop() {
      for (const t of stream!.getTracks()) t.stop();
      if (video.srcObject === stream) video.srcObject = null;
    },
  };
}
