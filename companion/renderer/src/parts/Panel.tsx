import type { ReactNode } from 'react';

/** The group colours: the kit's own, plus violet (its pink and cyan mixed); red is for a group that can do harm. */
export type Tone = 'cyan' | 'pink' | 'violet' | 'ice' | 'red';

/**
 * The Arcaid look (2026-11-25): the two building blocks of a tab, on the model of Arcaid's `parts/Panel`.
 *
 * `PanelGroup` is a set of related panels under one title, in ONE colour: the title, and the label, border and top
 * light bar of every panel inside take it (`.cc-group` in aw-castcade.css). The first group of a tab is titled with the
 * tab's own name. Panels sit one under another in the window, two to a row once it is 900 px wide.
 */
export function PanelGroup({ id, tone = 'cyan', title, sub, children }: {
  id: string;
  tone?: Tone;
  title: string;
  /** One plain line under the title: what is in this group. */
  sub?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className={`cc-group cc-group--${tone}`}>
      <header>
        <h2 id={`${id}-title`} className="cc-group__title">
          {title}
        </h2>
        {sub && <p className="cc-group__sub">{sub}</p>}
      </header>
      <div className="cc-group__panels">{children}</div>
    </section>
  );
}

/**
 * One card under a label: the kit's panel and label (`.aw-panel`, `.aw-label`). `title` may be a `<label>` for the
 * panel's one field. A panel with no title is one whose first line says what it is. `wide` spans both columns of a
 * wide window. `attention` wears pink whatever its group (the update banner).
 *
 * `min-w-0` (`.cc-panel`): one long unbroken value (a path, an id) never widens the column.
 */
export function Panel({ title, id, wide = false, attention = false, className = '', role, children }: {
  title?: ReactNode;
  id?: string;
  wide?: boolean;
  attention?: boolean;
  className?: string;
  role?: string;
  children: ReactNode;
}) {
  const cls = ['aw-panel', 'cc-panel', wide && 'cc-panel--wide', attention && 'cc-panel--attention', className].filter(Boolean).join(' ');
  return (
    <section id={id} role={role} className={cls}>
      {title && <h3 className="aw-label">{title}</h3>}
      {children}
    </section>
  );
}
