/**
 * OP sys — složení aplikace.
 *
 * Drží stav, obsluhuje akce a rozděluje data komponentám. Se systémem mluví
 * výhradně přes `OpSysApi`, takže je jedno, jestli pod ním běží web mock,
 * nebo Rust provider.
 */

import { createApi } from './lib/api';
import { el, mount, must } from './ui/dom';
import { createConfig } from './ui/config';
import { createDialog } from './ui/dialog';
import { createHeader } from './ui/header';
import { createMetrics } from './ui/metrics';
import { createPanels } from './ui/panels';
import { createTiles } from './ui/tiles';
import type {
  KillCandidate,
  OpSysApi,
  Profile,
  ProfileProblem,
  ProjectContext,
  ResolvedLaunch,
  Snapshot,
} from './lib/types';

const POLL_MS = 1500;

type Tone = 'info' | 'ok' | 'warn';

interface State {
  profiles: Profile[];
  problems: ProfileProblem[];
  activeId: string;
  snapshot: Snapshot | null;
  context: ProjectContext | null;
  launch: ResolvedLaunch[];
  kills: KillCandidate[];
  busy: boolean;
}

export async function startApp(mountPoint: HTMLElement): Promise<void> {
  const api: OpSysApi = createApi();

  const state: State = {
    profiles: [],
    problems: [],
    activeId: '',
    snapshot: null,
    context: null,
    launch: [],
    kills: [],
    busy: false,
  };

  // ---- komponenty --------------------------------------------------------

  const header = createHeader();
  const metrics = createMetrics();
  const tiles = createTiles((id) => void selectMode(id));
  const panels = createPanels({
    onLaunchAll: () => void launchAll(),
    onOfferKill: () => dialog.open(state.kills),
  });
  const config = createConfig();
  const dialog = createDialog({ onConfirm: (pids) => void confirmTerminate(pids) });

  // ---- topbar / statusbar ------------------------------------------------

  const providerTag = el('span', { class: 'tag' }, [el('span', { class: 'dot' }), 'provider —']);
  const modeTag = el('span', { class: 'tag tag-warn' }, ['simulace']);

  const topbar = el('header', { class: 'topbar' }, [
    el('div', { class: 'brand' }, [
      el('span', { class: 'brand-mark', text: 'OP SYS' }),
      el('span', { class: 'brand-sub', text: 'ovládací centrum režimů' }),
    ]),
    el('div', { class: 'topbar-meta' }, [providerTag, modeTag]),
  ]);

  const statusMsg = el('div', { class: 'status-msg', text: 'Načítám profily…' });
  const statusTick = el('span', { class: 'value-num', text: 'tick 0' });
  const statusClock = el('span', { class: 'value-num', text: '--:--:--' });

  const statusbar = el('footer', { class: 'statusbar' }, [
    el('span', { text: api.transport === 'tauri' ? 'tauri' : 'web · mock' }),
    el('span', { class: 'sep' }),
    statusTick,
    el('span', { class: 'sep' }),
    statusMsg,
    el('span', { class: 'sep' }),
    statusClock,
  ]);

  const stack = el('div', { class: 'stack' });
  const stage = el('main', { class: 'stage' }, [stack]);

  mount(mountPoint, el('div', { class: 'app' }, [topbar, stage, statusbar]), dialog.root);

  function setStatus(text: string, tone: Tone = 'info'): void {
    statusMsg.textContent = text;
    statusMsg.className = `status-msg${tone === 'info' ? '' : ` ${tone}`}`;
  }

  // ---- vykreslení --------------------------------------------------------

  function activeProfile(): Profile | null {
    return state.profiles.find((p) => p.id === state.activeId) ?? null;
  }

  /** Config má jinou spodní část obrazovky než ostatní režimy. */
  function renderStage(): void {
    const profile = activeProfile();
    const isConfig = profile?.view === 'config';

    mount(
      stack,
      header.root,
      metrics.root,
      tiles.root,
      isConfig ? config.root : panels.root,
    );

    header.update(profile, state.context);
    metrics.update(state.snapshot?.metrics ?? null);
    tiles.update(state.profiles, state.activeId);

    if (isConfig) {
      config.update(state.profiles, state.problems, state.snapshot?.provider ?? null, api.transport);
    } else {
      panels.update(profile, state.launch, state.kills, state.busy);
    }
  }

  /** Lehká obnova — jen to, co se mění s každým snapshotem. */
  function renderLive(): void {
    metrics.update(state.snapshot?.metrics ?? null);

    const provider = state.snapshot?.provider;
    mount(
      providerTag,
      el('span', { class: 'dot' }),
      `provider · ${provider?.kind ?? '—'}`,
    );
    providerTag.className = `tag${provider?.kind === 'mock' ? ' tag-accent' : ''}`;

    modeTag.hidden = provider ? provider.kind !== 'mock' : false;

    if (activeProfile()?.view !== 'config') {
      panels.update(activeProfile(), state.launch, state.kills, state.busy);
    }
  }

  // ---- akce --------------------------------------------------------------

  async function refreshProfileData(): Promise<void> {
    if (!state.activeId) return;
    const [context, launch, kills] = await Promise.all([
      api.resolveContext(state.activeId),
      api.resolveLaunch(state.activeId),
      api.killCandidates(state.activeId),
    ]);
    state.context = context;
    state.launch = launch;
    state.kills = kills;
  }

  async function selectMode(id: string): Promise<void> {
    if (id === state.activeId) return;
    state.activeId = id;

    await refreshProfileData();
    renderStage();

    const profile = activeProfile();
    if (!profile) return;

    if (profile.layer === 'off') {
      setStatus(`${profile.name}: vrstva vypnuta — OP sys nezasahuje.`, 'ok');
    } else {
      setStatus(
        `${profile.name}: ${state.launch.length} ke spuštění, ${state.kills.length} k nabídnutí.`,
      );
    }
  }

  async function launchAll(): Promise<void> {
    if (state.busy) return;
    state.busy = true;
    renderLive();

    try {
      const outcomes = await api.launchAll(state.activeId);
      const ok = outcomes.filter((o) => o.ok).length;
      const failed = outcomes.length - ok;

      setStatus(
        failed === 0
          ? `Simulace: spuštěno ${ok} položek. Reálně se nic nespustilo.`
          : `Simulace: spuštěno ${ok}, ${failed} selhalo (cíl nenalezen).`,
        failed === 0 ? 'ok' : 'warn',
      );
    } catch (err) {
      setStatus(`Spuštění selhalo: ${message(err)}`, 'warn');
    } finally {
      state.busy = false;
      await refreshProfileData();
      renderLive();
    }
  }

  async function confirmTerminate(pids: number[]): Promise<void> {
    dialog.close();
    if (pids.length === 0) return;

    state.busy = true;
    renderLive();

    try {
      const outcomes = await api.terminate(pids);
      const ok = outcomes.filter((o) => o.ok).length;
      const refused = outcomes.filter((o) => !o.ok);

      if (refused.length === 0) {
        setStatus(`Simulace: ukončeno ${ok} procesů. Reálné procesy běží dál.`, 'ok');
      } else {
        setStatus(
          `Simulace: ukončeno ${ok}, odmítnuto ${refused.length} — ${refused[0].message}`,
          'warn',
        );
      }
    } catch (err) {
      setStatus(`Ukončení selhalo: ${message(err)}`, 'warn');
    } finally {
      state.busy = false;
      await refreshProfileData();
      renderLive();
    }
  }

  function message(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  // ---- start -------------------------------------------------------------

  try {
    const bundle = await api.profiles();
    state.profiles = bundle.profiles;
    state.problems = bundle.problems;
    state.activeId = bundle.profiles[0]?.id ?? '';
  } catch (err) {
    setStatus(`Profily se nepodařilo načíst: ${message(err)}`, 'warn');
  }

  try {
    state.snapshot = await api.snapshot();
    await refreshProfileData();
  } catch (err) {
    setStatus(`Provider neodpovídá: ${message(err)}`, 'warn');
  }

  renderStage();
  renderLive();

  if (state.problems.length > 0) {
    setStatus(`${state.problems.length} profilů se nenačetlo — detaily v režimu Config.`, 'warn');
  } else {
    const profile = activeProfile();
    setStatus(
      profile
        ? `${state.profiles.length} profilů načteno. Aktivní: ${profile.name}.`
        : 'Nenačten žádný profil.',
      'ok',
    );
  }

  // ---- smyčka telemetrie -------------------------------------------------

  window.setInterval(() => {
    void (async () => {
      try {
        state.snapshot = await api.snapshot();
        // Seznam k ukončení závisí na tom, co právě běží — obnovuj s ním.
        state.kills = await api.killCandidates(state.activeId);
        renderLive();
      } catch {
        // Výpadek jednoho tiku není důvod cokoli hlásit; příští tik to spraví.
      }
      statusTick.textContent = `tick ${nextTick()}`;
    })();
  }, POLL_MS);

  let tick = 0;
  function nextTick(): number {
    tick += 1;
    return tick;
  }

  window.setInterval(() => {
    statusClock.textContent = new Date().toLocaleTimeString('cs-CZ', { hour12: false });
  }, 1000);
  statusClock.textContent = new Date().toLocaleTimeString('cs-CZ', { hour12: false });

  // ---- klávesnice --------------------------------------------------------

  window.addEventListener('keydown', (event) => {
    if (dialog.isOpen() || event.metaKey || event.ctrlKey || event.altKey) return;

    const index = Number.parseInt(event.key, 10);
    if (!Number.isNaN(index) && index >= 1 && index <= state.profiles.length) {
      event.preventDefault();
      void selectMode(state.profiles[index - 1].id);
    }
  });
}

export function boot(): void {
  const root = must<HTMLElement>('#app');
  void startApp(root).catch((err) => {
    // Fail-safe: i když se aplikace nerozjede, uživatel má vidět proč.
    mount(
      root,
      el('div', { attrs: { style: 'padding:40px;max-width:70ch' } }, [
        el('div', { class: 'label', text: 'OP sys se nespustil' }),
        el('p', { attrs: { style: 'color:var(--warn);margin-top:12px' }, text: String(err) }),
      ]),
    );
  });
}
