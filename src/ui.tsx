import { useEffect, useRef, type ReactNode } from 'react';
import { X, Loader2 } from 'lucide-react';

export function Mark() { return <svg className="mark" viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M5 5h22v22H5zM5 16h22M16 5v22" stroke="currentColor" strokeWidth="1.25"/><path d="M16 16h11v11H16z" fill="currentColor" opacity=".12"/></svg>; }
export function Status({ value }: { value: string }) {
  const names: Record<string, string> = { draft: 'Draft', testing: 'Testing', revision: 'Needs revision', review: 'In review', approved: 'Approved', solved: 'Solved', partial: 'Partial', unsolved: 'Unsolved', active: 'Accepting', paused: 'Paused' };
  return <span className={`status ${value}`}><i />{names[value] || value}</span>;
}
export function Button({ children, loading, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { loading?: boolean }) {
  return <button {...props} disabled={props.disabled || loading}>{loading && <Loader2 size={14} className="spin" />}{children}</button>;
}
export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="field"><span className="field-label">{label}{hint && <span className="field-hint">{hint}</span>}</span>{children}</label>;
}
export function Modal({ title, children, close, wide = false, error }: { title: string; children: ReactNode; close: () => void; wide?: boolean; error?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return <dialog ref={ref} className={`modal ${wide ? 'wide' : ''}`} onCancel={close} onClick={event => { if (event.target === ref.current) close(); }}>
    <div className="modal-top"><h2>{title}</h2><button className="icon-button" aria-label="Close dialog" onClick={close}><X size={18} /></button></div>
    {error && <p className="error modal-error" role="alert">{error}</p>}
    {children}
  </dialog>;
}
export function Empty({ children }: { children: ReactNode }) { return <div className="empty">{children}</div>; }
