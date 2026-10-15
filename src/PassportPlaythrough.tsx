import { useEffect, useRef, useState } from 'react';
import { Button } from './ui';
import './playthrough.css';

const chapters = [
  ['Briefing', 'A traveller presents a passport under the name Ruth Ellis and gives a hurried account. Inspect the documents, establish who owns the passport through the interview, keep evidence and file a finding.'],
  ['Open the passport', 'Open the burgundy passport and read the identity page. The printed name is Ruth Ellis; the signature is R. Ellis.'],
  ['Turn the page', 'Check the travel history. The Oslo entry gives you a useful detail to ask about.'],
  ['Request the arrival card', 'Ask for the arrival card, then compare its signature with the passport. The card is signed M. Ellis.'],
  ['Compare signatures', 'The signatures differ. This is a lead to investigate, not proof of who owns the passport.'],
  ['Use the UV lamp', 'Illuminate the passport. The document is genuine, so focus on who is using it.'],
  ['Present relevant documents', 'Present the passport and arrival card at the desk so the question has clear context.'],
  ['Ask, then follow up', 'Send the editable example question about the signatures. Read the scripted evasive reply, then ask who owns the passport. The disclosure is supplied practice text, not a model result.'],
  ['Keep evidence', 'Keep the scripted ownership disclosure as evidence. In a real interview, preserve the actual reply that supports your finding.'],
  ['Decide and file', 'Choose HOLD or CLEAR, write a short finding and file this practice case. Then you can start the real playthrough.'],
] as const;
const replies = [
  'I signed the card in a hurry. It is a family trip; the initials do not tell you anything.',
  'The passport belongs to my sister, Ruth Ellis. I am Mara Ellis, and I borrowed it for this trip.',
];

export function PassportPlaythrough({ onStartReal }: { onStartReal: () => void }) {
  const [open, setOpen] = useState(false), [step, setStep] = useState(0), [maxStep, setMaxStep] = useState(0), [done, setDone] = useState(false);
  const [opened, setOpened] = useState(false), [page, setPage] = useState(false), [card, setCard] = useState(false), [compared, setCompared] = useState(false), [uv, setUv] = useState(false);
  const [presented, setPresented] = useState<string[]>([]), [question, setQuestion] = useState('The passport says Ruth Ellis and the arrival card is signed M. Ellis. Why are the signatures different?');
  const [followup, setFollowup] = useState('Who owns the passport?'), [repliesSeen, setRepliesSeen] = useState(0), [kept, setKept] = useState(false);
  const [decision, setDecision] = useState<'HOLD' | 'CLEAR' | ''>(''), [finding, setFinding] = useState('');
  const launch = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const close = () => { setOpen(false); requestAnimationFrame(() => launch.current?.focus()); };
  useEffect(() => {
    if (!open) return;
    dialog.current?.showModal();
    document.querySelector<HTMLElement>('.practice-close')?.focus();
    return () => { if (dialog.current?.open) dialog.current.close(); };
  }, [open]);
  const advance = () => { const next = Math.min(chapters.length - 1, step + 1); setStep(next); setMaxStep(maximum => Math.max(maximum, next)); };
  const mayAdvance = [true, opened, page, card, compared, uv, presented.includes('passport') && presented.includes('card'), repliesSeen >= 2, kept, Boolean(decision && finding.trim())][step];
  const start = () => { setStep(0); setMaxStep(0); setDone(false); setOpened(false); setPage(false); setCard(false); setCompared(false); setUv(false); setPresented([]); setQuestion('The passport says Ruth Ellis and the arrival card is signed M. Ellis. Why are the signatures different?'); setFollowup('Who owns the passport?'); setRepliesSeen(0); setKept(false); setDecision(''); setFinding(''); setOpen(true); };
  return <>
    <button ref={launch} className="secondary playthrough-launch" onClick={() => setOpen(true)}>Guided playthrough</button>
    {open && <dialog ref={dialog} className="practice-dialog" aria-labelledby="practice-title" aria-describedby="practice-description" onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.target === dialog.current) close(); }}>
        <div className="practice-shade">
        <header className="practice-head"><div><span className="eyebrow">SCRIPTED PRACTICE · {step + 1} OF {chapters.length}</span><h2 id="practice-title">{done ? 'Practice case filed' : chapters[step][0]}</h2></div><button className="practice-close" aria-label="Close guided playthrough" onClick={close}>×</button></header>
        <div className="practice-body" id="practice-description">
          <aside className="practice-steps" aria-label="Playthrough steps">{chapters.map(([title], index) => <button key={title} aria-current={step === index ? 'step' : undefined} onClick={() => { if (index <= maxStep) setStep(index); }} disabled={index > maxStep}>{String(index + 1).padStart(2, '0')} {title}</button>)}</aside>
          <article className="practice-work">
            <p>{done ? 'Your chosen disposition and finding are recorded in this temporary practice panel only. Review whether the finding is supported by the scripted ownership disclosure you kept. This is not live model or test evidence.' : chapters[step][1]}</p>
            {step === 0 && <div className="practice-note">This example runs entirely in your browser. It has no timer, provider request or recorded attempt. A live round’s timer continues while this guide is open.</div>}
            {step >= 1 && step <= 6 && <div className={`practice-desk ${uv ? 'practice-uv' : ''}`} aria-label="Practice inspection desk">
              <div className="practice-passport"><img src="/reference-assets/passport-cover.webp" alt="Burgundy passport" />{opened && <div className="practice-page"><strong>REPUBLIC · PASSPORT</strong><span>RUTH ELLIS</span><small>Signature: R. Ellis</small>{page && <small>TRAVEL HISTORY · OSLO</small>}</div>}</div>
              <button className="practice-card" onClick={() => setCard(true)}>{card ? <>ARRIVAL CARD<strong>M. Ellis</strong></> : 'Request arrival card'}</button>
              {step === 1 && <Button className="primary" onClick={() => setOpened(true)}>{opened ? 'Passport opened' : 'Open passport'}</Button>}
              {step === 2 && <Button className="primary" disabled={!opened} onClick={() => setPage(true)}>{page ? 'Oslo entry found' : 'Turn page'}</Button>}
              {step === 3 && <Button className="primary" onClick={() => setCard(true)}>{card ? 'Arrival card requested' : 'Request arrival card'}</Button>}
              {step === 4 && <Button className="primary" disabled={!card} onClick={() => setCompared(true)}>{compared ? 'Signatures differ: R. Ellis / M. Ellis' : 'Compare signatures'}</Button>}
              {step === 5 && <Button className="primary" onClick={() => setUv(true)}>{uv ? 'UV: genuine document' : 'Switch on UV lamp'}</Button>}
              {step === 6 && <div className="practice-actions">{['passport', 'card'].map(item => <Button key={item} className="secondary" onClick={() => setPresented(current => current.includes(item) ? current : [...current, item])}>{presented.includes(item) ? `${item === 'card' ? 'Arrival card' : 'Passport'} presented` : `Present ${item === 'card' ? 'arrival card' : item}`}</Button>)}</div>}
            </div>}
            {step === 7 && <div className="practice-interview"><label>Example question<textarea value={question} onChange={event => setQuestion(event.target.value)} maxLength={280} /></label><Button className="primary" disabled={!question.trim() || repliesSeen > 0} onClick={() => setRepliesSeen(1)}>Send example question</Button>{repliesSeen > 0 && <blockquote><small>SCRIPTED PRACTICE REPLY · NOT A MODEL RESPONSE</small>{replies[0]}</blockquote>}<label>Follow-up<textarea value={followup} onChange={event => setFollowup(event.target.value)} maxLength={180} /></label><Button className="primary" disabled={repliesSeen !== 1 || !followup.trim()} onClick={() => setRepliesSeen(2)}>Send follow-up</Button>{repliesSeen > 1 && <blockquote><small>SCRIPTED PRACTICE DISCLOSURE · NOT A MODEL RESPONSE</small>{replies[1]}</blockquote>}</div>}
            {step === 8 && <label className="practice-evidence"><input type="checkbox" checked={kept} onChange={event => setKept(event.target.checked)} /> Keep as evidence: “The passport belongs to my sister, Ruth Ellis. I am Mara Ellis, and I borrowed it for this trip.”</label>}
            {step === 9 && !done && <div className="practice-filing"><div className="practice-actions">{(['HOLD', 'CLEAR'] as const).map(value => <button key={value} className={decision === value ? 'selected' : ''} aria-pressed={decision === value} onClick={() => setDecision(value)}>{value}</button>)}</div><label>Your finding<textarea value={finding} onChange={event => setFinding(event.target.value)} placeholder="What did the passenger disclose?" maxLength={600} /></label><Button className="primary" disabled={!decision || !finding.trim()} onClick={() => setDone(true)}>File practice case</Button></div>}
            {done && <div className="practice-complete"><p><strong>{decision} · {finding}</strong></p><p>Evidence kept: scripted ownership disclosure. Check your finding against the reply and documents. This practice example does not guarantee a live model outcome. To begin a real round, select Open the counter on the reference page.</p><Button className="primary" onClick={() => { close(); onStartReal(); }}>Back to real desk</Button></div>}
          </article>
        </div>
        <footer className="practice-footer"><span>{done ? 'You can revisit steps or restart the practice.' : mayAdvance ? 'Action complete. Continue when ready.' : 'Complete the action above to continue.'}</span><div><Button className="secondary" onClick={start}>Restart practice</Button>{step > 0 && <Button className="secondary" onClick={() => setStep(value => value - 1)}>Previous</Button>}{!done && step < chapters.length - 1 && <Button className="primary" disabled={!mayAdvance} onClick={advance}>Continue</Button>}</div></footer>
        </div>
      </dialog>}
  </>;
}
