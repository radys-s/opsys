/**
 * OP sys — sdílené typy.
 *
 * Tvary v tomto souboru jsou kontrakt mezi frontendem a `SystemProvider`em
 * v Rustu. Rust posílá serde JSON v camelCase (viz `src-tauri/src/provider/mod.rs`),
 * takže stejné názvy platí i pro web-only mock. Když měníš tvar tady,
 * měň ho i tam — jinak se web a Tauri rozejdou.
 */

export type Severity = 'soft' | 'suggest' | 'strong';
export type LaunchKind = 'app' | 'url' | 'folder' | 'shell';
export type LayerState = 'on' | 'off';
export type ProfileView = 'modes' | 'config';

/** Projektový kontext, který režim obnovuje. */
export interface ProjectContext {
  label: string;
  path?: string;
  repo?: string;
  note?: string;
}

/** Jedna položka seznamu „režim spustí". */
export interface LaunchItem {
  id: string;
  label: string;
  kind: LaunchKind;
  target: string;
  args: string[];
  note?: string;
  optional: boolean;
}

/** Pravidlo seznamu „režim nabídne ukončit". Nikdy se nevykoná samo. */
export interface KillRule {
  id: string;
  label: string;
  match: string;
  reason: string;
  severity: Severity;
}

/** Profil po vyhodnocení dědičnosti. */
export interface Profile {
  schema: number;
  id: string;
  name: string;
  order: number;
  tagline: string;
  summary: string;
  layer: LayerState;
  view: ProfileView;
  extends?: string;
  context: ProjectContext;
  launch: LaunchItem[];
  kill: KillRule[];
}

/** Profil tak, jak stojí v souboru — před sloučením s rodičem. */
export interface RawProfile {
  file: string;
  schema?: number;
  id?: string;
  extends?: string;
  name?: string;
  order?: number;
  tagline?: string;
  summary?: string;
  layer?: LayerState;
  view?: ProfileView;
  context?: Partial<ProjectContext>;
  launch: LaunchItem[];
  kill: KillRule[];
  removeLaunch: string[];
  removeKill: string[];
}

/** Výsledek načtení složky `profiles/` — chyby se nesou vedle dat, ne místo nich. */
export interface ProfileBundle {
  profiles: Profile[];
  problems: ProfileProblem[];
}

export interface ProfileProblem {
  file: string;
  message: string;
}

export interface ProcessInfo {
  pid: number;
  name: string;
  label: string;
  memoryMb: number;
  cpuPercent: number;
  protected: boolean;
}

export interface Metrics {
  ramUsedMb: number;
  ramTotalMb: number;
  cpuPercent: number;
  /** null = provider hodnotu nemá (typicky notebook bez čitelného senzoru). */
  tempC: number | null;
}

export type ProviderKind = 'mock' | 'windows';

export interface ProviderInfo {
  kind: ProviderKind;
  label: string;
  /** false ⇒ zápisové operace se vůbec nevolají, vrací se strukturovaná chyba. */
  canWrite: boolean;
  note: string;
}

export interface Snapshot {
  provider: ProviderInfo;
  metrics: Metrics;
  processes: ProcessInfo[];
}

/** Položka „spustí" s rozbalenými placeholdery a zjištěnou dostupností. */
export interface ResolvedLaunch {
  item: LaunchItem;
  resolvedTarget: string;
  resolvedArgs: string[];
  available: boolean;
  detail: string;
}

/** Pravidlo × běžící proces. Vzniká jen pro procesy, které opravdu běží. */
export interface KillCandidate {
  rule: KillRule;
  process: ProcessInfo;
}

export interface TerminateOutcome {
  pid: number;
  name: string;
  ok: boolean;
  message: string;
}

export interface LaunchOutcome {
  id: string;
  label: string;
  ok: boolean;
  message: string;
}

/** Jednotné API, které UI vidí. Implementace: web mock, nebo Tauri invoke. */
export interface OpSysApi {
  readonly transport: 'web-mock' | 'tauri';
  profiles(): Promise<ProfileBundle>;
  snapshot(): Promise<Snapshot>;
  /** Kontext s rozbalenými placeholdery — to, co se opravdu ukáže v hlavičce. */
  resolveContext(profileId: string): Promise<ProjectContext>;
  resolveLaunch(profileId: string): Promise<ResolvedLaunch[]>;
  killCandidates(profileId: string): Promise<KillCandidate[]>;
  terminate(pids: number[]): Promise<TerminateOutcome[]>;
  launchAll(profileId: string): Promise<LaunchOutcome[]>;
}
