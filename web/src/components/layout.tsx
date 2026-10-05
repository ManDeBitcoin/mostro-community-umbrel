import type { ReactNode } from 'react';
import { Icon } from './ui';

/** How good or bad a state is. Colours and icons follow from it. */
export type Tone = 'good' | 'warn' | 'bad' | 'info' | 'neutral';

const TONE_ICON: Record<Tone, string> = { good: 'check', warn: 'alert', bad: 'alert', info: 'info', neutral: 'dot' };

/** The top of every page: which part of the panel this is, its name and what it is for. */
export function PageHeader({ group, title, description, actions }: { group: string; title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-header">
      <div className="page-header-text">
        <span className="page-kicker">{group}</span>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="page-header-actions">{actions}</div>}
    </header>
  );
}

/** A titled block of a page. */
export function Panel({ id, title, description, aside, children, className = '' }: { id?: string; title?: ReactNode; description?: ReactNode; aside?: ReactNode; children: ReactNode; className?: string }) {
  const headingId = id ? `${id}-title` : undefined;
  return (
    <section className={`panel ${className}`.trim()} id={id} aria-labelledby={title ? headingId : undefined}>
      {(title || aside) && (
        <div className="panel-head">
          <div>
            {title && <h2 id={headingId}>{title}</h2>}
            {description && <p>{description}</p>}
          </div>
          {aside && <div className="panel-aside">{aside}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className={`badge tone-${tone}`}>
      <i aria-hidden="true" />
      {children}
    </span>
  );
}

/** A message that explains a state and, when there is one, offers the way out. */
export function Callout({ tone = 'info', title, children, action }: { tone?: Tone; title?: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className={`callout tone-${tone}`} role={tone === 'bad' ? 'alert' : 'status'}>
      <span className="callout-icon">
        <Icon name={TONE_ICON[tone]} size={17} />
      </span>
      <div className="callout-body">
        {title && <strong>{title}</strong>}
        {children && <span>{children}</span>}
      </div>
      {action && <div className="callout-action">{action}</div>}
    </div>
  );
}

/** One number with its meaning. A button when it leads somewhere. */
export function Stat({ label, value, hint, tone = 'neutral', onClick }: { label: string; value: ReactNode; hint?: ReactNode; tone?: Tone; onClick?: () => void }) {
  const content = (
    <>
      <span className="stat-label">{label}</span>
      <strong className="stat-value">{value}</strong>
      {hint && <span className="stat-hint">{hint}</span>}
    </>
  );
  return onClick ? (
    <button type="button" className={`stat tone-${tone} is-link`} onClick={onClick}>
      {content}
    </button>
  ) : (
    <div className={`stat tone-${tone}`}>{content}</div>
  );
}

export function FactGrid({ children }: { children: ReactNode }) {
  return <dl className="fact-grid">{children}</dl>;
}

export function Fact({ label, value, hint, mono = false }: { label: string; value: ReactNode; hint?: ReactNode; mono?: boolean }) {
  return (
    <div className="fact">
      <dt>{label}</dt>
      <dd className={mono ? 'mono' : undefined}>{value}</dd>
      {hint && <small>{hint}</small>}
    </div>
  );
}

/** A value to copy, with its own button. */
export function CopyField({ label, value, copied, onCopy }: { label: string; value: string; copied: boolean; onCopy: () => void }) {
  return (
    <div className="copy-field">
      <span className="field-label">{label}</span>
      <div className="copy-box">
        <code>{value}</code>
        <button type="button" className="copy-button" onClick={onCopy}>
          {copied ? 'Copiado ✓' : 'Copiar'}
        </button>
      </div>
    </div>
  );
}

export function EmptyState({ icon = 'info', title, children, action }: { icon?: string; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty-state">
      <Icon name={icon} size={26} />
      <strong>{title}</strong>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

/** A link that reads as text and leads to another page of the panel. */
export function LinkButton({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button type="button" className="link-button" onClick={onClick}>
      {children}
      <Icon name="next" size={13} />
    </button>
  );
}
