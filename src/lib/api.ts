/**
 * Jediný most mezi UI a systémem.
 *
 * UI nikdy nesahá na `invoke` ani na mock napřímo — mluví jen přes `OpSysApi`.
 * Díky tomu je `npm run dev` (prohlížeč, mock) a `npm run tauri dev`
 * (Rust provider) tentýž kód UI, jen s jinou implementací mostu.
 */

import { MockSystem, MOCK_PATHS } from '../mock/mockSystem';
import { expandPlaceholders, loadProfiles } from './profiles';
import type {
  KillCandidate,
  LaunchOutcome,
  OpSysApi,
  Profile,
  ProfileBundle,
  ProjectContext,
  ResolvedLaunch,
  Snapshot,
  TerminateOutcome,
} from './types';

/**
 * Profily se do webového buildu zapékají v době sestavení.
 *
 * Prohlížeč nemá přístup k disku, takže složku `profiles/` načte Vite jako
 * text. V Tauri verzi je čte Rust ze souborového systému za běhu.
 */
const PROFILE_SOURCES = import.meta.glob('../../profiles/*.toml', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

function profileSourcesByFileName(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [path, source] of Object.entries(PROFILE_SOURCES)) {
    out[path.replace(/^.*[/\\]/, '')] = source;
  }
  return out;
}

/** Hlásí, že se operace nevykonala, protože vrstva režimu je vypnutá. */
const LAYER_OFF = 'Vrstva je v tomto režimu vypnutá — OP sys nic nespouští ani neukončuje.';

class WebMockApi implements OpSysApi {
  readonly transport = 'web-mock' as const;

  private readonly system = new MockSystem();
  private readonly bundle: ProfileBundle = loadProfiles(profileSourcesByFileName());

  async profiles(): Promise<ProfileBundle> {
    return this.bundle;
  }

  async snapshot(): Promise<Snapshot> {
    this.system.advance();
    return this.system.snapshot();
  }

  private profile(profileId: string): Profile | undefined {
    return this.bundle.profiles.find((p) => p.id === profileId);
  }

  /** Placeholdery se berou z provideru a z kontextu samotného profilu. */
  private vars(profile: Profile): Record<string, string | undefined> {
    return {
      ...MOCK_PATHS,
      CONTEXT_PATH: profile.context.path
        ? expandPlaceholders(profile.context.path, MOCK_PATHS)
        : undefined,
      CONTEXT_REPO: profile.context.repo,
    };
  }

  async resolveContext(profileId: string): Promise<ProjectContext> {
    const profile = this.profile(profileId);
    if (!profile) return { label: 'Kontext' };

    const vars = this.vars(profile);
    const expand = (value: string | undefined) =>
      value === undefined ? undefined : expandPlaceholders(value, vars);

    return {
      label: profile.context.label,
      path: expand(profile.context.path),
      repo: expand(profile.context.repo),
      note: expand(profile.context.note),
    };
  }

  async resolveLaunch(profileId: string): Promise<ResolvedLaunch[]> {
    const profile = this.profile(profileId);
    if (!profile || profile.layer === 'off') return [];

    const vars = this.vars(profile);
    return profile.launch.map((item) => {
      const resolvedTarget = expandPlaceholders(item.target, vars);
      const resolvedArgs = item.args.map((arg) => expandPlaceholders(arg, vars));
      const unresolved = /\{[A-Z_]+\}/.test(resolvedTarget);
      const available = !unresolved && this.system.targetAvailable(item.kind, resolvedTarget);

      let detail: string;
      if (unresolved) detail = 'Cesta obsahuje nerozbalený placeholder.';
      else if (available) detail = 'Připraveno.';
      else detail = 'Cíl nenalezen — mock tenhle program nezná.';

      return { item, resolvedTarget, resolvedArgs, available, detail };
    });
  }

  async killCandidates(profileId: string): Promise<KillCandidate[]> {
    const profile = this.profile(profileId);
    if (!profile || profile.layer === 'off') return [];

    const running = this.system.processes();
    const out: KillCandidate[] = [];

    for (const rule of profile.kill) {
      const needle = rule.match.toLowerCase();
      for (const process of running) {
        // Chráněné procesy se do nabídky nedostanou, ani když je profil vyjmenuje.
        if (process.protected) continue;
        if (process.name.toLowerCase() !== needle) continue;
        out.push({ rule, process });
      }
    }
    return out;
  }

  async terminate(pids: number[]): Promise<TerminateOutcome[]> {
    return this.system.terminate(pids);
  }

  async launchAll(profileId: string): Promise<LaunchOutcome[]> {
    const profile = this.profile(profileId);
    if (!profile) return [];
    if (profile.layer === 'off') {
      return [{ id: profile.id, label: profile.name, ok: false, message: LAYER_OFF }];
    }

    const resolved = await this.resolveLaunch(profileId);
    return resolved.map(({ item, available, resolvedTarget, detail }) => ({
      id: item.id,
      label: item.label,
      ok: available,
      message: available ? `Spuštěno v simulaci: ${resolvedTarget}` : detail,
    }));
  }
}

/** Tenká obálka nad Tauri příkazy. Veškerá logika žije v Rustu. */
class TauriApi implements OpSysApi {
  readonly transport = 'tauri' as const;

  private async call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<T>(command, args);
  }

  profiles(): Promise<ProfileBundle> {
    return this.call<ProfileBundle>('profiles');
  }

  snapshot(): Promise<Snapshot> {
    return this.call<Snapshot>('snapshot');
  }

  resolveContext(profileId: string): Promise<ProjectContext> {
    return this.call<ProjectContext>('resolve_context', { profileId });
  }

  resolveLaunch(profileId: string): Promise<ResolvedLaunch[]> {
    return this.call<ResolvedLaunch[]>('resolve_launch', { profileId });
  }

  killCandidates(profileId: string): Promise<KillCandidate[]> {
    return this.call<KillCandidate[]>('kill_candidates', { profileId });
  }

  terminate(pids: number[]): Promise<TerminateOutcome[]> {
    return this.call<TerminateOutcome[]>('terminate', { pids });
  }

  launchAll(profileId: string): Promise<LaunchOutcome[]> {
    return this.call<LaunchOutcome[]>('launch_all', { profileId });
  }
}

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export function createApi(): OpSysApi {
  return isTauri() ? new TauriApi() : new WebMockApi();
}

export { WebMockApi, TauriApi };
