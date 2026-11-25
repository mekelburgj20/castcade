import type { ReactNode } from 'react';

/**
 * The Arcaid look (2026-11-25): the small pieces the tabs share (aw-castcade.css). The three states are the kit's:
 * cyan = fine, pink = attention, red = problem. No green, no yellow.
 */
export type State = 'ok' | 'attention' | 'problem';

/**
 * A line that reports (a result, a warning, an error), in its colour, with a rule down its left side: one inset row,
 * the limit of nesting in a panel. `lead` is a short word above it, for a result that needs one.
 */
export function Note({ state, lead, role, children }: { state?: State; lead?: string; role?: 'alert' | 'status'; children: ReactNode }) {
  return (
    <p className={state ? `cc-note cc-note--${state}` : 'cc-note'} role={role}>
      {lead && <span className="cc-note__lead">{lead}</span>}
      {children}
    </p>
  );
}

/** A status chip (the kit's `.aw-chip`: cyan for fine, pink for attention, red for a problem, chrome for neither). */
export function Chip({ state, children }: { state?: State; children: ReactNode }) {
  const tone = state === 'attention' ? ' aw-chip--attention' : state === 'problem' ? ' aw-chip--danger' : state === 'ok' ? '' : ' aw-chip--neutral';
  return <span className={`aw-chip cc-chip${tone}`}>{children}</span>;
}

/**
 * A field with its label above it and its help line under it. `label` is drawn as a `<label>` for `htmlFor` (a plain
 * line when there is no control to name: a folder shown with its buttons); with `line`, the children are one row (the
 * field and its button: Browse…, Paste).
 */
export function Field({ label, htmlFor, help, line = false, children }: { label?: ReactNode; htmlFor?: string; help?: ReactNode; line?: boolean; children: ReactNode }) {
  return (
    <div className="cc-field">
      {label &&
        (htmlFor ? (
          <label className="cc-field__label" htmlFor={htmlFor}>
            {label}
          </label>
        ) : (
          <span className="cc-field__label">{label}</span>
        ))}
      {line ? <div className="cc-field__line">{children}</div> : children}
      {help && <small className="cc-help">{help}</small>}
    </div>
  );
}

/** Loading: placeholders in the shape of what is coming (never a spinner in the middle). */
export function Skeleton({ kind = 'line', width }: { kind?: 'line' | 'chip' | 'field' | 'button' | 'label'; width?: string }) {
  return <span className={`cc-skel cc-skel--${kind}`} style={width ? { width } : undefined} aria-hidden="true" />;
}

/** A list of facts as it will be, its values not here yet: `rows` label and value bars. */
export function SkeletonFacts({ rows }: { rows: number }) {
  return (
    <div className="cc-skel-facts" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <SkeletonRow key={i} n={i} />
      ))}
    </div>
  );
}
function SkeletonRow({ n }: { n: number }) {
  return (
    <>
      <Skeleton width={`${60 + ((n * 17) % 30)}%`} />
      <Skeleton width={`${45 + ((n * 29) % 50)}%`} />
    </>
  );
}
