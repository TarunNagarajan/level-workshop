import { beginMeasuredRequest, finishMeasuredRequest, setMetricsConsent } from './telemetry';

let recordingAcknowledged = false;
export function setRecordingAcknowledged(value: boolean) { recordingAcknowledged = value; setMetricsConsent(value); }

export class ApiError extends Error {
  status: number;
  submissionId?: string;
  submissionStatus?: string;
  receiptConfirmed: boolean;
  constructor(message: string, status: number, submissionId?: string, submissionStatus?: string, receiptConfirmed = false) { super(message); this.name = 'ApiError'; this.status = status; this.submissionId = submissionId; this.submissionStatus = submissionStatus; this.receiptConfirmed = receiptConfirmed; }
}

export async function api<T>(path: string, options: { method?: string; body?: unknown; token?: string; signal?: AbortSignal } = {}): Promise<T> {
  const method = options.method || 'GET';
  let metrics: ReturnType<typeof beginMeasuredRequest> = null;
  if (recordingAcknowledged) try { metrics = beginMeasuredRequest(path, method, options.token); } catch { /* telemetry must never block a workshop request */ }
  const finishMetrics = (outcome: 'success' | 'error') => { try { finishMeasuredRequest(metrics, outcome); } catch { /* telemetry is best effort */ } };
  let recorded = false;
  let messageController: AbortController | undefined;
  let messageTimeout: ReturnType<typeof setTimeout> | undefined;
  let parentAbort: (() => void) | undefined;
  const isTargetMessage = method === 'POST' && /(?:^|\/)messages\/?$/.test(path);
  try {
    let signal = options.signal;
    if (isTargetMessage) {
      if (options.signal?.aborted) throw new DOMException('This request was cancelled before it was sent.', 'AbortError');
      messageController = new AbortController();
      signal = messageController.signal;
      parentAbort = () => messageController?.abort(options.signal?.reason);
      options.signal?.addEventListener('abort', parentAbort, { once: true });
      messageTimeout = setTimeout(() => messageController?.abort(new DOMException('The server receipt is unknown because the request timed out.', 'TimeoutError')), 45_000);
    }
    const response = await fetch(`/api${path}`, {
      method, credentials: 'same-origin', signal,
      headers: { 'Content-Type': 'application/json', ...(options.token ? { 'x-round-token': options.token } : {}) },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
    const result = await response.json();
    if (!response.ok) { finishMetrics('error'); recorded = true; throw new ApiError(result.error || 'This request could not be completed.', response.status, result.submissionId, result.submissionStatus, result.receiptConfirmed === true); }
    finishMetrics('success'); recorded = true;
    return result as T;
  } catch (error) {
    if (!recorded) finishMetrics('error');
    throw error;
  } finally {
    if (messageTimeout !== undefined) clearTimeout(messageTimeout);
    if (parentAbort) options.signal?.removeEventListener('abort', parentAbort);
  }
}
export const time = (seconds: number) => `${Math.floor(Math.max(0, seconds) / 60).toString().padStart(2, '0')}:${Math.floor(Math.max(0, seconds) % 60).toString().padStart(2, '0')}`;
export const date = (ms: number) => new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(ms);
export function download(name: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const RECORDING_NOTICE_VERSION = 'recording-notice-v1';
export const RECORDING_NOTICE = 'Your submitted prompts, model replies, actions, findings and timing data are saved for project analysis and may be exported by the organizer. Failed requests are recorded too. Do not enter passwords or personal information. Text you have not submitted is not collected.';
