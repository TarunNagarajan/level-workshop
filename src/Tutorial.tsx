import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { api } from './api';
import { Button } from './ui';
import type { Summary, User } from './types';

type Step = { title: string; text: string; selector: string; path: string; section?: string };
type Bounds = { left: number; top: number; width: number; height: number };

export function Tutorial({ user, path, navigate, close }: { user: User; path: string; navigate: (path: string) => boolean; close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const returnPath = useRef(path);
  const [levelId, setLevelId] = useState(''); const [loaded, setLoaded] = useState(false);
  const [step, setStep] = useState(-1); const [bounds, setBounds] = useState<Bounds | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const steps: Step[] = [
    { title: 'Start with a level.', text: 'Levels is your shared library. Open a draft assigned to you, create a new level, or duplicate a teammate’s draft to explore your own idea.', selector: '[data-tour="library"]', path: '/' },
    ...(levelId ? [
      { title: 'Set the scene.', text: 'Scenario holds the player briefing, the protected truth, and what a successful attempt should reveal. Authors can see the truth. Players using a blind test link cannot.', selector: '[data-tour="scenario"]', path: `/levels/${levelId}`, section: 'scenario' },
      { title: 'Give the target its instructions.', text: 'Instructions defines how the character behaves. Write the system prompt here, then choose whether the player may uncover permitted clues or must break an instruction that protects the secret.', selector: '[data-tour="instructions"]', path: `/levels/${levelId}`, section: 'instructions' },
      { title: 'Save a version, then test it.', text: 'Save draft keeps your edits. Save version freezes a testable copy. Use Start test in this panel to talk to the target. Blind test creates a player link; History keeps earlier versions.', selector: '[data-tour="preview"]', path: `/levels/${levelId}`, section: 'scenario' },
    ] : []),
    { title: 'Review what happened.', text: 'Tests stores the conversations. Open one, select the target replies that support your finding, and record whether the secret was recovered. Reviews are done by a person for now.', selector: '[data-tour="nav-attempts"]', path: '/attempts' },
    { title: 'Work with your team.', text: user.role === 'admin' ? 'Team is where you share the name-only workshop link. Assign a level to an author under its Round tab. The assigned author can edit it; you can review and approve it. You can reopen this guide from Quick tour.' : 'Team shows your fellow authors. Everyone can read drafts and review tests. You can edit levels assigned to you, or duplicate a draft to make your own version. You can reopen this guide from Quick tour.', selector: '[data-tour="nav-team"]', path: '/team' },
  ];
  const current = steps[step];
  useEffect(() => {
    dialog.current?.showModal();
    api<Summary[]>('/levels').then(rows => setLevelId(rows.find(l => l.draft.theme === 'Harry Potter')?.id || rows[0]?.id || '')).catch(() => {}).finally(() => setLoaded(true));
  }, []);
  useEffect(() => {
    setBounds(null);
    if (!current) return;
    let target: Element | null = null; let positioned = false;
    const update = () => {
      if (current.section && document.querySelector('[data-tour="editor-tabs"]')) window.dispatchEvent(new CustomEvent('workshop:tutorial-section', { detail: current.section }));
      target = document.querySelector(current.selector);
      if (!target) return;
      if (!positioned) { target.scrollIntoView({ block: 'center', behavior: 'instant' }); positioned = true; }
      const rect = target.getBoundingClientRect();
      const left = Math.max(5, rect.left - 5); const top = Math.max(5, rect.top - 5);
      setBounds({ left, top, width: Math.max(0, Math.min(rect.right + 5, window.innerWidth - 5) - left), height: Math.max(0, Math.min(rect.bottom + 5, window.innerHeight - 5) - top) });
    };
    const workspace = document.querySelector('.workspace');
    const observer = new MutationObserver(update);
    if (workspace) observer.observe(workspace, { childList: true, subtree: true });
    const resize = new ResizeObserver(update); if (workspace) resize.observe(workspace);
    window.addEventListener('resize', update); window.addEventListener('scroll', update, true); update();
    return () => { observer.disconnect(); resize.disconnect(); window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true); };
  }, [step, levelId]);
  const move = (next: number) => {
    setError('');
    if (next >= 0 && !navigate(steps[next].path)) return;
    setStep(next);
  };
  const finish = async (result: 'completed' | 'skipped') => {
    setBusy(true); setError('');
    try {
      await api('/tutorial', { method: 'PUT', body: { result } });
      navigate(returnPath.current); close();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return createPortal(<dialog ref={dialog} className={`tour-dialog ${bounds ? 'has-highlight' : ''}`} aria-labelledby="tour-title" aria-describedby="tour-description" onCancel={event => { event.preventDefault(); if (!busy) void finish('skipped'); }}>
    {bounds && <div className="tour-highlight" data-testid="tour-highlight" style={bounds} aria-hidden="true" />}
    <section className={`tour-card ${step < 0 ? 'tour-intro' : ''}`}>
      <div className="tour-top"><span className="eyebrow">{step < 0 ? 'A QUICK WALK-THROUGH' : `STEP ${step + 1} OF ${steps.length}`}</span><button className="icon-button" aria-label="Close tour" disabled={busy} onClick={() => void finish('skipped')}><X size={17} /></button></div>
      <h2 id="tour-title">{current?.title || 'Find your way around.'}</h2>
      <p id="tour-description">{current?.text || 'Take a minute to see where you write a level, test the target, and review a conversation. The guide uses an existing draft without changing it.'}</p>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="tour-actions"><Button className="text-button" disabled={busy} onClick={() => void finish('skipped')}>Skip tour</Button><div>{step >= 0 && <Button className="secondary" disabled={busy} onClick={() => move(step - 1)}>Back</Button>}<Button autoFocus className="primary" disabled={!loaded} loading={busy} onClick={() => step === steps.length - 1 ? void finish('completed') : move(step + 1)}>{step < 0 ? 'Show me around' : step === steps.length - 1 ? 'Finish tour' : 'Next'}</Button></div></div>
    </section>
  </dialog>, document.body);
}
