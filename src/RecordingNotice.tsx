import { useState } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { api, RECORDING_NOTICE, RECORDING_NOTICE_VERSION } from './api';
import { Button, Mark } from './ui';

export function RecordingNotice({ onAccepted, title = 'Before you enter the workshop' }: { onAccepted: () => void; title?: string }) {
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const accept = async () => {
    if (!checked || busy) return;
    setBusy(true); setError('');
    try {
      await api('/recording/acknowledge', { method: 'POST', body: { version: RECORDING_NOTICE_VERSION, accepted: true } });
      onAccepted();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return <main className="auth-shell recording-notice-shell"><section className="auth-card recording-notice" aria-labelledby="recording-notice-title">
    <Mark /><p className="eyebrow">LEVEL WORKSHOP · RECORDING NOTICE</p><h1 id="recording-notice-title">{title}</h1>
    <p className="recording-notice-copy">{RECORDING_NOTICE}</p>
    <label className="recording-consent"><input type="checkbox" checked={checked} onChange={event => setChecked(event.target.checked)} /><span>I understand and agree to this recording.</span></label>
    {error && <p className="error" role="alert">{error}</p>}
    <Button className="primary full" disabled={!checked} loading={busy} onClick={() => void accept()}>Continue<ArrowUpRight size={16} /></Button>
  </section></main>;
}
