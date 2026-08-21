/**
 * Config — v prvním návrhu jen čtecí obrazovka.
 *
 * Ukáže, co se z `profiles/` opravdu načetlo, jak se vyhodnotila dědičnost
 * a který provider běží. Editor profilů je mimo rozsah (viz DECISIONS.md).
 */

import { el, mount, sectionHead } from './dom';
import type { Profile, ProfileProblem, ProviderInfo } from '../lib/types';

function kv(key: string, value: string, accent = false): HTMLElement {
  return el('div', { class: 'kv' }, [
    el('span', { class: 'kv-k', text: key }),
    el('span', { class: `kv-v${accent ? ' accent' : ''}`, text: value }),
  ]);
}

function profileCard(profile: Profile): HTMLElement {
  return el('article', { class: 'config-card' }, [
    el('div', { class: 'config-card-head' }, [
      el('span', { class: 'config-name', text: profile.name }),
      el('span', { class: 'label', text: profile.id }),
    ]),
    kv('Dědí z', profile.extends ?? '—', Boolean(profile.extends)),
    kv('Pořadí', String(profile.order)),
    kv('Vrstva', profile.layer === 'on' ? 'zapnuta' : 'vypnuta'),
    kv('Spustí', profile.launch.length ? profile.launch.map((l) => l.id).join(', ') : '—'),
    kv('Nabídne', profile.kill.length ? profile.kill.map((k) => k.id).join(', ') : '—'),
    kv('Kontext', profile.context.path ?? '—'),
  ]);
}

export interface ConfigView {
  root: HTMLElement;
  update(profiles: Profile[], problems: ProfileProblem[], provider: ProviderInfo | null, transport: string): void;
}

export function createConfig(): ConfigView {
  const providerBox = el('div', { class: 'config-card' });
  const problemsBox = el('div', {});
  const grid = el('div', { class: 'config-grid' });

  const root = el('section', {}, [
    sectionHead('Provider'),
    providerBox,
    problemsBox,
    el('div', { attrs: { style: 'height:22px' } }),
    sectionHead('Načtené profily', el('span', { class: 'label', text: 'jen ke čtení' })),
    grid,
  ]);

  function update(
    profiles: Profile[],
    problems: ProfileProblem[],
    provider: ProviderInfo | null,
    transport: string,
  ): void {
    mount(
      providerBox,
      el('div', { class: 'config-card-head' }, [
        el('span', { class: 'config-name', text: provider?.label ?? 'neznámý' }),
        el('span', { class: 'label', text: transport }),
      ]),
      kv('Druh', provider?.kind ?? '—'),
      kv('Zápis', provider?.canWrite ? 'povolen (simulace)' : 'zakázán — jen čtení', !provider?.canWrite),
      kv('Poznámka', provider?.note ?? '—'),
      kv('Zdroj profilů', 'profiles/*.toml'),
    );

    if (problems.length === 0) {
      mount(problemsBox);
    } else {
      mount(
        problemsBox,
        el('div', { attrs: { style: 'height:12px' } }),
        el('div', { class: 'problems' }, [
          el('span', { class: 'label', text: `Problémy při načítání (${problems.length})` }),
          el(
            'ul',
            {},
            problems.map((p) => el('li', { text: `${p.file}: ${p.message}` })),
          ),
        ]),
      );
    }

    mount(grid, ...profiles.map(profileCard));
  }

  return { root, update };
}
