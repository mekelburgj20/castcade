/**
 * The Arcaid look (2026-11-25): the window around a story page that draws one tab alone (match-story.tsx,
 * watch-story.tsx): the app's own page shell, title row and tab bar (renderer/src/parts), with the Match tab showing,
 * as App.tsx draws them. And the list page every story shows without a `?state=`.
 */
import type { ReactNode } from 'react';
import { Lamp, PageTitle } from '../src/parts/PageTitle.js';
import { Panel, PanelGroup } from '../src/parts/Panel.js';
import { Screen, TabBar } from '../src/parts/Screen.js';

const TABS = ['Pairing', 'Status', 'Stream', 'Match', 'Settings'].map((label) => ({ id: label, label }));

export function MatchWindow({ children }: { children: ReactNode }) {
  return (
    <Screen title={<PageTitle name="Castcade" end={<Lamp tone="ok">Watching</Lamp>} />} tabs={<TabBar items={TABS} current="Match" onSelect={() => undefined} />}>
      {children}
    </Screen>
  );
}

export function StoryIndex({ title, items }: { title: string; items: Array<{ name: string; says: string }> }) {
  return (
    <Screen title={<PageTitle name="Castcade" />}>
      <PanelGroup id="stories" title={title}>
        <Panel wide>
          <ul className="cc-stack">
            {items.map((x) => (
              <li key={x.name}>
                <a href={`?state=${x.name}`}>{x.name}</a>: {x.says}
              </li>
            ))}
          </ul>
        </Panel>
      </PanelGroup>
    </Screen>
  );
}
