import type { ReactNode } from 'react';
import icon from '../../../build/icon.png';

/**
 * The Arcaid look (2026-11-25): the window's title row, on the model of Arcaid's `parts/PageTitle` (the Arcaid logo
 * and ARCAID in the kit's chrome brand lettering). Here it is Castcade's own: its app icon (`companion/build/icon.png`,
 * the one in the taskbar) and its name in Audiowide (`.aw-brand`, the kit's brand face, used for this and nothing
 * else). `sub` is the line under the name (the Witness edition says so); `end` sits at the row's right (the lamp).
 */
export function PageTitle({ name, sub, end }: { name: string; sub?: string; end?: ReactNode }) {
  return (
    <div className="cc-brandrow">
      <img className="cc-logo" src={icon} alt="" aria-hidden="true" />
      <h1 className="aw-brand cc-brand">
        {name}
        {sub && <span className="aw-brand__sub">{sub}</span>}
      </h1>
      {end && <div className="cc-brandrow__end">{end}</div>}
    </div>
  );
}

/** A lamp and its word (the kit's `.aw-live` pill): a state is never told by colour alone. */
export function Lamp({ tone, children }: { tone: 'ok' | 'attention' | 'problem' | 'none'; children: ReactNode }) {
  return <span className={`cc-lamp cc-lamp--${tone}`}>{children}</span>;
}
