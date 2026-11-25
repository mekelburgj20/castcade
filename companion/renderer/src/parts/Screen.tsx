import type { ReactNode } from 'react';

/**
 * The Arcaid look (2026-11-25): the window's page shell, on the model of Arcaid's `parts/ArcaidPage`. The fixed dark
 * kit on the arcade carpet (`.cc-screen`, aw-castcade.css; never the Arcaid Witness picture), the title row and the
 * tab bar in a header that stays at the top, then the tab. `overlays` (the toasts) are drawn after the tab, still on
 * the ground. Castcade has no room themes: this is its only look.
 */
export function Screen({ title, tabs, overlays, children }: { title: ReactNode; tabs?: ReactNode; overlays?: ReactNode; children: ReactNode }) {
  return (
    <div className="cc-screen">
      <header className="cc-top">
        {title}
        {tabs}
      </header>
      <main className="cc-main">{children}</main>
      {overlays}
    </div>
  );
}

/**
 * The tab bar under the title row. The tab showing is the lead (pink) with the panel's light bar under it, and says
 * so to a screen reader (`aria-current`).
 */
export function TabBar<T extends string>({ items, current, onSelect, label = 'Views' }: {
  items: ReadonlyArray<{ id: T; label: string }>;
  current: T;
  onSelect: (id: T) => void;
  label?: string;
}) {
  return (
    <nav className="cc-tabs" aria-label={label}>
      {items.map((t) => (
        <button key={t.id} type="button" className="cc-tab" aria-current={t.id === current ? 'page' : undefined} onClick={() => onSelect(t.id)}>
          {t.label}
        </button>
      ))}
    </nav>
  );
}
