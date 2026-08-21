/**
 * Potvrzovací dialog pro ukončení procesů.
 *
 * Invariant 2: režim vždycky jen navrhne seznam a čeká na klik. Dialog je
 * jediná cesta, kudy může ukončení odejít do provideru. Nic tu není
 * předvybráno „naslepo" — předvybrané jsou pouze položky se severity
 * `strong`, a i ty jde odškrtnout.
 */

import { el, formatMb, mount } from './dom';
import type { KillCandidate } from '../lib/types';

export interface DialogView {
  root: HTMLElement;
  open(candidates: KillCandidate[]): void;
  close(): void;
  isOpen(): boolean;
}

export function createDialog(handlers: { onConfirm: (pids: number[]) => void }): DialogView {
  const title = el('h2', { class: 'dialog-title', text: 'Potvrdit ukončení' });
  const lede = el('p', { class: 'dialog-lede', text: '' });
  const body = el('div', { class: 'dialog-body' });
  const summary = el('span', { class: 'label', text: '' });

  const cancelBtn = el('button', {
    class: 'btn',
    attrs: { type: 'button' },
    text: 'Zrušit',
    on: { click: () => close() },
  });

  const confirmBtn = el('button', {
    class: 'btn btn-warn',
    attrs: { type: 'button' },
    text: 'Ukončit vybrané',
    on: { click: () => handlers.onConfirm(selectedPids()) },
  });

  const toggleAllBtn = el('button', {
    class: 'btn',
    attrs: { type: 'button' },
    text: 'Vybrat vše',
    on: { click: () => toggleAll() },
  });

  const dialog = el(
    'div',
    { class: 'dialog', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Potvrdit ukončení procesů' } },
    [
      el('div', { class: 'dialog-head' }, [
        el('span', { class: 'label', text: 'Vyžaduje potvrzení' }),
        title,
        lede,
      ]),
      body,
      el('div', { class: 'dialog-foot' }, [
        summary,
        el('div', { class: 'dialog-actions' }, [toggleAllBtn, cancelBtn, confirmBtn]),
      ]),
    ],
  );

  const root = el(
    'div',
    {
      class: 'overlay',
      hidden: true,
      on: {
        click: (event) => {
          if (event.target === root) close();
        },
      },
    },
    [dialog],
  );

  let checks: HTMLInputElement[] = [];
  let current: KillCandidate[] = [];

  function selectedPids(): number[] {
    return checks.filter((c) => c.checked).map((c) => Number(c.value));
  }

  function refreshSummary(): void {
    const pids = new Set(selectedPids());
    const chosen = current.filter((c) => pids.has(c.process.pid));
    const mb = chosen.reduce((sum, c) => sum + c.process.memoryMb, 0);

    summary.textContent = chosen.length
      ? `vybráno ${chosen.length} z ${current.length} · uvolní ~${formatMb(mb)}`
      : `vybráno 0 z ${current.length}`;

    confirmBtn.disabled = chosen.length === 0;
    confirmBtn.textContent = chosen.length ? `Ukončit vybrané (${chosen.length})` : 'Ukončit vybrané';
    toggleAllBtn.textContent = chosen.length === current.length ? 'Zrušit výběr' : 'Vybrat vše';
  }

  function toggleAll(): void {
    const allSelected = checks.every((c) => c.checked);
    for (const check of checks) check.checked = !allSelected;
    refreshSummary();
  }

  function candidateRow(candidate: KillCandidate): HTMLElement {
    const { rule, process } = candidate;
    const input = el('input', {
      type: 'checkbox',
      attrs: { value: String(process.pid) },
      on: { change: refreshSummary },
    }) as HTMLInputElement;

    // Předvybráno je jen to, co profil označil jako důrazné.
    input.checked = rule.severity === 'strong';
    checks.push(input);

    return el('label', { class: 'check-row' }, [
      el('span', { attrs: { style: 'position:relative;display:flex' } }, [input, el('span', { class: 'box' })]),
      el('div', { class: 'row-main' }, [
        el('div', { class: 'row-title', text: `${process.label} · ${process.name}` }),
        el('div', { class: 'row-note', text: rule.reason || rule.label }),
      ]),
      el('div', { class: 'row-meta' }, [
        `PID ${process.pid}`,
        el('br'),
        `${formatMb(process.memoryMb)} · ${process.cpuPercent.toFixed(1)} % CPU`,
      ]),
    ]);
  }

  function open(candidates: KillCandidate[]): void {
    current = candidates;
    checks = [];

    lede.textContent =
      'OP sys nikdy neukončuje nic sám. Zkontroluj seznam, odškrtni, co má běžet dál, ' +
      'a teprve pak potvrď. Systémové procesy se v seznamu neobjeví.';

    mount(body, ...candidates.map(candidateRow));
    refreshSummary();

    root.hidden = false;
    cancelBtn.focus();
    document.addEventListener('keydown', onKeyDown);
  }

  function close(): void {
    root.hidden = true;
    document.removeEventListener('keydown', onKeyDown);
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  }

  return { root, open, close, isOpen: () => !root.hidden };
}
