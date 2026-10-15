import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import type { MachineReview, Round } from './types';
import { Button } from './ui';

type Result = { machineReview: MachineReview | null };
function timed<T>(path: string, options: { method?: string; token?: string; signal?: AbortSignal }, timeoutMs: number) {
  if (options.signal?.aborted) return Promise.reject(new DOMException('The review request was cancelled.', 'AbortError'));
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  let timer = 0;
  const timeout = new Promise<never>((_resolve, reject) => { timer = window.setTimeout(() => { controller.abort(); reject(new Error('The review request timed out.')); }, timeoutMs); });
  return Promise.race([api<Result>(path, { ...options, signal: controller.signal }), timeout]).finally(() => { window.clearTimeout(timer); options.signal?.removeEventListener('abort', abort); });
}

const verdictLabel = { recovered: 'Secret recovered', partial: 'Part of the secret recovered', not_recovered: 'Secret not recovered', uncertain: 'Review inconclusive' } as const;

export function MachineReviewPanel({ round, setRound, isCurrent }: { round: Round; setRound: (round: Round) => void; isCurrent: () => boolean }) {
  const [review, setReview] = useState<MachineReview | null>(round.machineReview || null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const started = useRef(false); const active = useRef<AbortController | null>(null);
  const disposed = useRef(false);
  const path = `/rounds/${round.id}/review`;
  const save = (value: MachineReview | null) => { if (disposed.current || !isCurrent()) return; setReview(value); if (value) setRound({ ...round, machineReview: value }); };
  const refresh = async (signal?: AbortSignal) => (await timed(path, { token: round.accessToken, signal }, 8_000)).machineReview;
  const request = async (retry = false) => {
    if (busy) return;
    started.current = true; setBusy(true); setError('');
    const controller = new AbortController(); active.current = controller;
    try {
      if (!retry) {
        const cached = await refresh(controller.signal);
        if (controller.signal.aborted || disposed.current || !isCurrent()) return;
        if (cached) { save(cached); return; }
      }
      const result = await timed(path, { method: 'POST', token: round.accessToken, signal: controller.signal }, 45_000);
      if (controller.signal.aborted || disposed.current || !isCurrent()) return;
      save(result.machineReview);
    } catch (failure) {
      if (controller.signal.aborted || disposed.current || !isCurrent()) return;
      try {
        const latest = await refresh(controller.signal);
        if (controller.signal.aborted || disposed.current || !isCurrent()) return;
        if (latest) { save(latest); return; }
      } catch { if (controller.signal.aborted || disposed.current || !isCurrent()) return; /* The filed round stays available while review can be retried. */ }
      if (!disposed.current && isCurrent()) setError((failure as Error).message || 'The automated review could not be completed. Your filed answer is saved.');
    } finally { if (active.current === controller) active.current = null; if (!disposed.current && isCurrent()) setBusy(false); }
  };

  useEffect(() => {
    disposed.current = false;
    const shouldStart = Boolean(round.endedAt && round.reviewEnabled && !started.current && !review);
    if (shouldStart) void request();
    return () => {
      disposed.current = true;
      active.current?.abort();
      // React StrictMode replays effects after cleanup. Permit the replay to
      // check the server receipt and safely reacquire the durable review lease.
      if (shouldStart) started.current = false;
    };
  }, [round.id, round.endedAt, round.reviewEnabled]);

  useEffect(() => {
    if (review?.status !== 'pending') return;
    let cancelled = false, checking = false;
    const deadline = Date.now() + 60_000;
    const controller = new AbortController();
    const interval = window.setInterval(async () => {
      if (cancelled || checking) return;
      if (Date.now() >= deadline) { window.clearInterval(interval); if (!disposed.current && isCurrent()) setError('The review is taking longer than expected. Your filed answer is saved.'); save({ ...review, status: 'unavailable', retryable: review.attempts < 3, errorCode: 'timeout' }); return; }
      checking = true;
      try { const latest = await refresh(controller.signal); if (!cancelled && !disposed.current && isCurrent() && latest) save(latest); }
      catch { /* Polling is read-only; expose a retry after the bounded wait. */ }
      finally { checking = false; }
    }, 5000);
    return () => { cancelled = true; window.clearInterval(interval); controller.abort(); };
  }, [review?.status, review?.attempts]);

  if (!round.reviewEnabled) return null;
  const evidence = (review?.evidence || []).flatMap((citation, index) => {
    const source = round.messages.find(message => message.id === citation.replyId && message.role === 'assistant' && !message.opening);
    return source && citation.quote && source.content.includes(citation.quote) ? [{ ...citation, id: `${citation.replyId}-${index}` }] : [];
  });
  return <section className="machine-review" aria-labelledby={`machine-review-${round.id}`} aria-live="polite">
    <p className="eyebrow">AUTOMATED TRANSCRIPT REVIEW</p>
    <h3 id={`machine-review-${round.id}`}>{review?.status === 'complete' ? verdictLabel[review.verdict || 'uncertain'] : 'Was protected information disclosed?'}</h3>
    {(busy || review?.status === 'pending') && <p role="status">{busy ? 'Reviewing the saved conversation…' : 'The review is still processing.'}</p>}
    {(error || review?.status === 'unavailable') && <><p role="status">{error || 'The automated review could not be completed. Your filed answer is saved.'}{review?.attempts ? ` Attempts: ${review.attempts} of 3.` : ''}</p>{(error || review?.retryable) && <Button className="secondary" disabled={busy} onClick={() => void request(review?.status === 'unavailable' && review.retryable)}>Retry automated review</Button>}</>}
    {review?.status === 'complete' && <><p>{review.reason}</p>{evidence.length > 0 && <div className="machine-review-evidence"><strong>Supporting model replies</strong>{evidence.map(citation => <blockquote key={citation.id}><span>Model reply</span><p>“{citation.quote}”</p></blockquote>)}</div>}<p className="machine-review-note">This assessment uses the submitted transcript. Your answer alone does not count as a disclosure. A human reviewer remains authoritative.</p></>}
  </section>;
}
