/** Hand a file to the phone's share sheet, or download it where sharing files isn't possible. */
export function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function canShareFiles(): boolean {
  try {
    const probe = new File([new Uint8Array(1)], 'probe.mp4', { type: 'video/mp4' });
    return typeof navigator.canShare === 'function' && navigator.canShare({ files: [probe] });
  } catch {
    return false;
  }
}

export async function shareFile(blob: Blob, name: string, text?: string): Promise<'shared' | 'downloaded' | 'canceled'> {
  const file = new File([blob], name, { type: blob.type });
  if (typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'Frozen moment', text });
      return 'shared';
    } catch (err) {
      if ((err as Error).name === 'AbortError') return 'canceled';
    }
  }
  download(blob, name);
  return 'downloaded';
}

export function deviceInfo(): { ua: string; mobile: boolean } {
  const ua = navigator.userAgent.slice(0, 300);
  return { ua, mobile: /Android|iPhone|iPad|iPod|Mobile/i.test(ua) };
}

export function isIOS(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}
