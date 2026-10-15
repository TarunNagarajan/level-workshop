import { beginMeasuredRequest, finishMeasuredRequest } from './telemetry';

export async function api<T>(path: string, options: { method?: string; body?: unknown; token?: string; signal?: AbortSignal } = {}): Promise<T> {
  const method = options.method || 'GET';
  let metrics: ReturnType<typeof beginMeasuredRequest> = null;
  try { metrics = beginMeasuredRequest(path, method, options.token); } catch { /* telemetry must never block a workshop request */ }
  const finishMetrics = (outcome: 'success' | 'error') => { try { finishMeasuredRequest(metrics, outcome); } catch { /* telemetry is best effort */ } };
  let recorded = false;
  try {
    const response = await fetch(`/api${path}`, {
      method, credentials: 'same-origin', signal: options.signal,
      headers: { 'Content-Type': 'application/json', ...(options.token ? { 'x-round-token': options.token } : {}) },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
    const result = await response.json();
    if (!response.ok) { finishMetrics('error'); recorded = true; throw new Error(result.error || 'This request could not be completed.'); }
    finishMetrics('success'); recorded = true;
    return result as T;
  } catch (error) {
    if (!recorded) finishMetrics('error');
    throw error;
  }
}
export const time = (seconds: number) => `${Math.floor(Math.max(0, seconds) / 60).toString().padStart(2, '0')}:${Math.floor(Math.max(0, seconds) % 60).toString().padStart(2, '0')}`;
export const date = (ms: number) => new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(ms);
export function download(name: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click(); URL.revokeObjectURL(url);
}
