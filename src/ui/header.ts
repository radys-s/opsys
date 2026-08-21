/**
 * Hlavička s názvem aktivního režimu, popisem a projektovým kontextem.
 *
 * Při přepnutí režimu se text nepřepíše skokem — 180 ms crossfade.
 * Při `prefers-reduced-motion` se mění rovnou, bez čekání.
 */

import { el, mount, prefersReducedMotion } from './dom';
import type { Profile, ProjectContext } from '../lib/types';

const SWAP_MS = 180;

function contextRow(key: string, value: string | undefined, muted = false): HTMLElement | null {
  if (!value) return null;
  return el('div', { class: 'context-row' }, [
    el('span', { class: 'context-key', text: key }),
    el('span', { class: `context-val${muted ? ' muted' : ''}`, text: value }),
  ]);
}

export interface HeaderView {
  root: HTMLElement;
  update(profile: Profile | null, context: ProjectContext | null): void;
}

export function createHeader(): HeaderView {
  const label = el('div', { class: 'label', text: 'Aktivní režim' });
  const title = el('h1', { class: 'mode-title', text: '—' });
  const summary = el('p', { class: 'mode-summary', text: '' });
  const context = el('aside', { class: 'context-card' });

  const root = el('section', { class: 'mode-head' }, [
    el('div', {}, [label, title, summary]),
    context,
  ]);

  let shownId: string | null = null;
  let pending: number | undefined;

  function paint(profile: Profile | null, resolved: ProjectContext | null): void {
    if (!profile) {
      title.textContent = 'Žádný profil';
      summary.textContent = 'Ve složce profiles/ nebyl načten použitelný profil.';
      mount(context);
      return;
    }

    title.textContent = profile.name;
    summary.textContent = profile.summary || profile.tagline;

    // Ukazuje se rozbalený kontext od provideru, ne surová šablona z profilu.
    const ctx = resolved ?? profile.context;
    const rows = [
      contextRow(ctx.label || 'Kontext', ctx.path, false),
      contextRow('Repo', ctx.repo),
      contextRow('Poznámka', ctx.note, true),
    ].filter(Boolean) as HTMLElement[];

    mount(
      context,
      el('div', { class: 'label', text: profile.layer === 'off' ? 'Kontext se neobnovuje' : 'Kontext režimu' }),
      el('div', { attrs: { style: 'margin-top:9px' } }, rows.length ? rows : [
        el('div', { class: 'context-row' }, [
          el('span', { class: 'context-val muted', text: 'Tento režim neobnovuje žádný kontext.' }),
        ]),
      ]),
    );
  }

  function update(profile: Profile | null, context: ProjectContext | null): void {
    const nextId = profile?.id ?? null;
    if (nextId === shownId) {
      paint(profile, context);
      return;
    }
    shownId = nextId;

    if (prefersReducedMotion()) {
      paint(profile, context);
      return;
    }

    window.clearTimeout(pending);
    title.classList.add('is-swapping');
    summary.classList.add('is-swapping');

    pending = window.setTimeout(() => {
      paint(profile, context);
      title.classList.remove('is-swapping');
      summary.classList.remove('is-swapping');
    }, SWAP_MS);
  }

  return { root, update };
}
