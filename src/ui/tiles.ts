/** Mřížka dlaždic režimů. Aktivní dlaždice má výplň, accent rámeček a linku dole. */

import { el, mount, sectionHead } from './dom';
import type { Profile } from '../lib/types';

export interface TilesView {
  root: HTMLElement;
  update(profiles: Profile[], activeId: string): void;
}

export function createTiles(onSelect: (id: string) => void): TilesView {
  const grid = el('div', { class: 'modes' });
  const count = el('span', { class: 'label', text: '' });
  const root = el('section', {}, [sectionHead('Režimy', count), grid]);

  function update(profiles: Profile[], activeId: string): void {
    count.textContent = `${profiles.length} profilů`;

    const tiles = profiles.map((profile, index) => {
      const isActive = profile.id === activeId;
      const off = profile.layer === 'off';

      const foot = off
        ? [el('span', { text: 'vrstva vypnuta' })]
        : [
            el('span', {}, [el('span', { class: 'n', text: String(profile.launch.length) }), ' spustí']),
            el('span', {}, [el('span', { class: 'n', text: String(profile.kill.length) }), ' nabídne']),
          ];

      return el(
        'button',
        {
          class: `tile${isActive ? ' is-active' : ''}${off ? ' tile-off' : ''}`,
          attrs: {
            type: 'button',
            'data-mode': profile.id,
            'aria-pressed': String(isActive),
          },
          on: { click: () => onSelect(profile.id) },
        },
        [
          el('div', { class: 'tile-top' }, [
            el('span', { class: 'tile-index', text: String(index + 1).padStart(2, '0') }),
            isActive ? el('span', { class: 'dot', attrs: { style: 'color:var(--accent)' } }) : null,
          ]),
          el('div', { class: 'tile-name', text: profile.name }),
          el('div', { class: 'tile-tagline', text: profile.tagline }),
          el('div', { class: 'tile-foot' }, foot),
        ],
      );
    });

    mount(grid, ...tiles);
  }

  return { root, update };
}
