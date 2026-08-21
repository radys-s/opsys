/**
 * Dvousloupcový panel: „režim spustí" a „režim nabídne ukončit".
 *
 * Pravý sloupec nikdy nic neukončí sám. Tlačítko jen otevře potvrzovací
 * dialog se seznamem — invariant 2.
 */

import { el, formatMb, mount, sectionHead } from './dom';
import type { KillCandidate, Profile, ResolvedLaunch, Severity } from '../lib/types';

const SEVERITY_LABEL: Record<Severity, string> = {
  soft: 'volitelné',
  suggest: 'návrh',
  strong: 'důrazně',
};

const KIND_LABEL: Record<string, string> = {
  app: 'aplikace',
  url: 'odkaz',
  folder: 'složka',
  shell: 'příkaz',
};

function emptyState(title: string, body: string): HTMLElement {
  return el('div', { class: 'empty' }, [el('strong', { text: title }), body]);
}

function launchRow(entry: ResolvedLaunch): HTMLElement {
  const { item, resolvedTarget, resolvedArgs, available, detail } = entry;
  const command = [resolvedTarget, ...resolvedArgs].join(' ');

  return el('div', { class: 'row' }, [
    el('span', { class: `row-mark ${available ? 'ok' : 'warn'}` }),
    el('div', { class: 'row-main' }, [
      el('div', { class: 'row-title' }, [
        item.label,
        item.optional ? el('span', { class: 'label', text: '  volitelné' }) : null,
      ]),
      el('div', { class: 'row-note', text: available ? command : `${command} — ${detail}` }),
    ]),
    el('div', { class: `row-meta${available ? '' : ' warn'}`, text: KIND_LABEL[item.kind] ?? item.kind }),
  ]);
}

function killRow(candidate: KillCandidate): HTMLElement {
  const { rule, process } = candidate;

  return el('div', { class: `row${rule.severity === 'strong' ? ' is-strong' : ''}` }, [
    el('span', { class: `row-mark ${rule.severity === 'strong' ? 'warn' : ''}` }),
    el('div', { class: 'row-main' }, [
      el('div', { class: 'row-title', text: `${process.label} · ${process.name}` }),
      el('div', { class: 'row-note', text: rule.reason || rule.label }),
    ]),
    el('div', { class: 'row-meta' }, [
      `PID ${process.pid}`,
      el('br'),
      `${formatMb(process.memoryMb)} · ${SEVERITY_LABEL[rule.severity]}`,
    ]),
  ]);
}

export interface PanelsView {
  root: HTMLElement;
  update(profile: Profile | null, launch: ResolvedLaunch[], kills: KillCandidate[], busy: boolean): void;
}

export function createPanels(handlers: {
  onLaunchAll: () => void;
  onOfferKill: () => void;
}): PanelsView {
  const launchBody = el('div', { class: 'panel-body' });
  const launchCount = el('span', { class: 'label', text: '' });
  const launchBtn = el('button', {
    class: 'btn btn-primary',
    attrs: { type: 'button' },
    text: 'Spustit vše',
    on: { click: handlers.onLaunchAll },
  });
  const launchNote = el('span', { class: 'label', text: '' });

  const killBody = el('div', { class: 'panel-body' });
  const killCount = el('span', { class: 'label', text: '' });
  const killBtn = el('button', {
    class: 'btn btn-warn',
    attrs: { type: 'button' },
    text: 'Nabídnout ukončení',
    on: { click: handlers.onOfferKill },
  });
  const killNote = el('span', { class: 'label', text: '' });

  const root = el('section', {}, [
    sectionHead('Co režim udělá'),
    el('div', { class: 'panels' }, [
      el('div', { class: 'panel' }, [
        el('div', { class: 'panel-head' }, [
          el('span', { class: 'label', text: 'Režim spustí' }),
          launchCount,
        ]),
        launchBody,
        el('div', { class: 'panel-foot' }, [launchNote, launchBtn]),
      ]),
      el('div', { class: 'panel' }, [
        el('div', { class: 'panel-head' }, [
          el('span', { class: 'label', text: 'Režim nabídne ukončit' }),
          killCount,
        ]),
        killBody,
        el('div', { class: 'panel-foot' }, [killNote, killBtn]),
      ]),
    ]),
  ]);

  function update(
    profile: Profile | null,
    launch: ResolvedLaunch[],
    kills: KillCandidate[],
    busy: boolean,
  ): void {
    const layerOff = profile?.layer === 'off';

    // --- levý sloupec
    launchCount.textContent = layerOff ? '' : `${launch.length}`;
    if (layerOff) {
      mount(
        launchBody,
        emptyState(
          'Vrstva vypnuta',
          'Tento režim záměrně nic nespouští. Windows běží bez zásahu OP sys.',
        ),
      );
    } else if (launch.length === 0) {
      mount(launchBody, emptyState('Prázdné', 'Profil nemá žádnou sekci [[launch]].'));
    } else {
      mount(launchBody, ...launch.map(launchRow));
    }

    const missing = launch.filter((l) => !l.available).length;
    launchNote.textContent = layerOff
      ? 'nic ke spuštění'
      : missing > 0
        ? `${missing} cílů nenalezeno`
        : 'vše připraveno';
    launchBtn.disabled = busy || layerOff || launch.length === 0;

    // --- pravý sloupec
    killCount.textContent = layerOff ? '' : `${kills.length}`;
    if (layerOff) {
      mount(
        killBody,
        emptyState(
          'Vrstva vypnuta',
          'Unlock je pojistka: nespouští, neukončuje, neblokuje. Nic tu k potvrzení není.',
        ),
      );
    } else if (kills.length === 0) {
      mount(
        killBody,
        emptyState(
          'Nic k nabídnutí',
          'Žádný z běžících procesů neodpovídá pravidlům tohoto režimu. Systémové procesy se do nabídky nedostanou nikdy.',
        ),
      );
    } else {
      mount(killBody, ...kills.map(killRow));
    }

    const strong = kills.filter((k) => k.rule.severity === 'strong').length;
    killNote.textContent = layerOff
      ? 'nic k ukončení'
      : kills.length === 0
        ? 'čisto'
        : `${strong} důrazných · potvrzuje se ručně`;
    killBtn.disabled = busy || layerOff || kills.length === 0;
    killBtn.textContent = kills.length > 0 ? `Nabídnout ukončení (${kills.length})` : 'Nabídnout ukončení';
  }

  return { root, update };
}
