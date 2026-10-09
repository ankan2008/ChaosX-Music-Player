export function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export function formatDuration(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export function formatBitrate(kbps: number): string {
  if (!kbps) return '0 kbps';
  return `${kbps} kbps`;
}

export function formatSampleRate(hz: number): string {
  if (!hz) return '0 Hz';
  return `${(hz / 1000).toFixed(1)} kHz`;
}

export function formatBitDepth(bits: number): string {
  if (!bits) return '0-bit';
  return `${bits}-bit`;
}

export function formatChannels(channels: number): string {
  if (!channels) return 'Unknown';
  if (channels === 1) return 'Mono';
  if (channels === 2) return 'Stereo';
  return `${channels}ch`;
}

export function formatCodec(format: string): string {
  if (!format) return 'Unknown';
  return format.toUpperCase();
}