/**
 * Načtení a sloučení profilů režimů.
 *
 * Režimy nejsou kód — jsou to data v `profiles/*.toml`. Tenhle soubor je
 * jediné místo, které rozumí jejich dědičnosti. Stejná pravidla implementuje
 * `src-tauri/src/profiles.rs`; obě strany kryje stejná sada testů.
 *
 * Pravidla slučování (`extends = "rodic"`):
 *   - skaláry (name, order, tagline, summary, layer, view) — dítě přepisuje
 *   - [context] — slučuje se po klíčích, dítě přepisuje jen to, co uvede
 *   - [[launch]] / [[kill]] — dítě položku se stejným `id` nahradí na jejím
 *     původním místě, novou připojí na konec
 *   - remove_launch / remove_kill — odeberou zděděnou položku podle `id`
 *
 * Chyba v jednom souboru nesmí shodit celou aplikaci (invariant 1: fail-safe),
 * proto se problémy sbírají do `problems` a vrací vedle úspěšně načtených dat.
 */

import { parseToml, TomlError, type TomlTable, type TomlValue } from './toml';
import type {
  KillRule,
  LaunchItem,
  LaunchKind,
  LayerState,
  Profile,
  ProfileBundle,
  ProfileProblem,
  ProfileView,
  ProjectContext,
  RawProfile,
  Severity,
} from './types';

const LAUNCH_KINDS: LaunchKind[] = ['app', 'url', 'folder', 'shell'];
const SEVERITIES: Severity[] = ['soft', 'suggest', 'strong'];
const MAX_INHERITANCE_DEPTH = 8;

class ProfileError extends Error {}

const ROOT_KEYS = [
  'schema', 'id', 'extends', 'name', 'order', 'tagline', 'summary', 'layer', 'view',
  'context', 'launch', 'kill', 'remove_launch', 'remove_kill',
];
const CONTEXT_KEYS = ['label', 'path', 'repo', 'note'];
const LAUNCH_KEYS = ['id', 'label', 'kind', 'target', 'args', 'note', 'optional'];
const KILL_KEYS = ['id', 'label', 'match', 'reason', 'severity'];

/**
 * Neznámý klíč je vždycky chyba, ne detail.
 *
 * Typický případ: `remove_launch` napsané až za sekcí [[launch]]. TOML ho pak
 * přiřadí do té sekce a profil se tváří, že funguje. Tohle to zastaví hned.
 */
function assertKnownKeys(table: TomlTable, allowed: string[], where: string): void {
  for (const key of Object.keys(table)) {
    if (allowed.includes(key)) continue;
    const hint = ROOT_KEYS.includes(key)
      ? ` — "${key}" patří do kořene profilu, napiš ho nad první sekci`
      : '';
    throw new ProfileError(`${where}: neznámý klíč "${key}"${hint}`);
  }
}

// ---- čtení jednoho souboru -------------------------------------------------

function str(table: TomlTable, key: string, where: string): string | undefined {
  const v = table[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'string') throw new ProfileError(`${where}.${key} musí být řetězec`);
  return v;
}

function num(table: TomlTable, key: string, where: string): number | undefined {
  const v = table[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'number') throw new ProfileError(`${where}.${key} musí být číslo`);
  return v;
}

function bool(table: TomlTable, key: string, where: string): boolean | undefined {
  const v = table[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') throw new ProfileError(`${where}.${key} musí být true/false`);
  return v;
}

function strArray(table: TomlTable, key: string, where: string): string[] {
  const v = table[key];
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new ProfileError(`${where}.${key} musí být pole řetězců`);
  return v.map((entry, i) => {
    if (typeof entry !== 'string') throw new ProfileError(`${where}.${key}[${i}] musí být řetězec`);
    return entry;
  });
}

function tables(table: TomlTable, key: string): TomlTable[] {
  const v = table[key];
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new ProfileError(`${key} musí být sekce [[${key}]]`);
  return v.map((entry, i) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new ProfileError(`${key}[${i}] musí být tabulka`);
    }
    return entry as TomlTable;
  });
}

function oneOf<T extends string>(value: string | undefined, allowed: T[], where: string): T | undefined {
  if (value === undefined) return undefined;
  if (!(allowed as string[]).includes(value)) {
    throw new ProfileError(`${where} musí být jedno z: ${allowed.join(', ')} (je "${value}")`);
  }
  return value as T;
}

function readContext(table: TomlTable | undefined): Partial<ProjectContext> | undefined {
  if (table === undefined) return undefined;
  assertKnownKeys(table, CONTEXT_KEYS, 'context');
  return {
    label: str(table, 'label', 'context'),
    path: str(table, 'path', 'context'),
    repo: str(table, 'repo', 'context'),
    note: str(table, 'note', 'context'),
  };
}

function readLaunch(table: TomlTable, index: number): LaunchItem {
  const where = `launch[${index}]`;
  assertKnownKeys(table, LAUNCH_KEYS, where);
  const id = str(table, 'id', where);
  const label = str(table, 'label', where);
  const target = str(table, 'target', where);
  if (!id) throw new ProfileError(`${where}: chybí id`);
  if (!label) throw new ProfileError(`${where} (${id}): chybí label`);
  if (!target) throw new ProfileError(`${where} (${id}): chybí target`);

  return {
    id,
    label,
    kind: oneOf(str(table, 'kind', where), LAUNCH_KINDS, `${where}.kind`) ?? 'app',
    target,
    args: strArray(table, 'args', where),
    note: str(table, 'note', where),
    optional: bool(table, 'optional', where) ?? false,
  };
}

function readKill(table: TomlTable, index: number): KillRule {
  const where = `kill[${index}]`;
  assertKnownKeys(table, KILL_KEYS, where);
  const id = str(table, 'id', where);
  const label = str(table, 'label', where);
  const match = str(table, 'match', where);
  if (!id) throw new ProfileError(`${where}: chybí id`);
  if (!label) throw new ProfileError(`${where} (${id}): chybí label`);
  if (!match) throw new ProfileError(`${where} (${id}): chybí match`);

  return {
    id,
    label,
    match,
    reason: str(table, 'reason', where) ?? '',
    severity: oneOf(str(table, 'severity', where), SEVERITIES, `${where}.severity`) ?? 'suggest',
  };
}

/** Odvodí id z názvu souboru, když ho profil neuvede. */
export function idFromFileName(file: string): string {
  return file.replace(/^.*[/\\]/, '').replace(/\.toml$/i, '');
}

export function parseProfile(source: string, file: string): RawProfile {
  const table: TomlTable = parseToml(source);
  assertKnownKeys(table, ROOT_KEYS, 'profil');
  const contextTable = table.context;
  if (contextTable !== undefined && (typeof contextTable !== 'object' || Array.isArray(contextTable))) {
    throw new ProfileError('context musí být sekce [context]');
  }

  return {
    file,
    schema: num(table, 'schema', 'profil'),
    id: str(table, 'id', 'profil') ?? idFromFileName(file),
    extends: str(table, 'extends', 'profil'),
    name: str(table, 'name', 'profil'),
    order: num(table, 'order', 'profil'),
    tagline: str(table, 'tagline', 'profil'),
    summary: str(table, 'summary', 'profil'),
    layer: oneOf(str(table, 'layer', 'profil'), ['on', 'off'] as LayerState[], 'layer'),
    view: oneOf(str(table, 'view', 'profil'), ['modes', 'config'] as ProfileView[], 'view'),
    context: readContext(contextTable as TomlTable | undefined),
    launch: tables(table, 'launch').map(readLaunch),
    kill: tables(table, 'kill').map(readKill),
    removeLaunch: strArray(table, 'remove_launch', 'profil'),
    removeKill: strArray(table, 'remove_kill', 'profil'),
  };
}

// ---- dědičnost -------------------------------------------------------------

function emptyProfile(id: string): Profile {
  return {
    schema: 1,
    id,
    name: id,
    order: 1000,
    tagline: '',
    summary: '',
    layer: 'on',
    view: 'modes',
    context: { label: 'Kontext' },
    launch: [],
    kill: [],
  };
}

/** Dítě nahradí položku se stejným id na jejím místě, jinak ji připojí na konec. */
function mergeById<T extends { id: string }>(parent: T[], child: T[], remove: string[]): T[] {
  const removed = new Set(remove);
  const out = parent.filter((item) => !removed.has(item.id));

  for (const item of child) {
    const at = out.findIndex((existing) => existing.id === item.id);
    if (at === -1) out.push(item);
    else out[at] = item;
  }
  return out;
}

function applyRaw(base: Profile, raw: RawProfile): Profile {
  const context: ProjectContext = { ...base.context };
  if (raw.context) {
    if (raw.context.label !== undefined) context.label = raw.context.label;
    if (raw.context.path !== undefined) context.path = raw.context.path;
    if (raw.context.repo !== undefined) context.repo = raw.context.repo;
    if (raw.context.note !== undefined) context.note = raw.context.note;
  }

  return {
    schema: raw.schema ?? base.schema,
    id: raw.id ?? base.id,
    name: raw.name ?? base.name,
    order: raw.order ?? base.order,
    tagline: raw.tagline ?? base.tagline,
    summary: raw.summary ?? base.summary,
    layer: raw.layer ?? base.layer,
    view: raw.view ?? base.view,
    extends: raw.extends,
    context,
    launch: mergeById(base.launch, raw.launch, raw.removeLaunch),
    kill: mergeById(base.kill, raw.kill, raw.removeKill),
  };
}

/** Vyhodnotí `extends` — s detekcí cyklu i příliš hlubokého řetězu. */
function resolveOne(raw: RawProfile, byId: Map<string, RawProfile>, seen: string[]): Profile {
  const id = raw.id ?? idFromFileName(raw.file);

  if (seen.includes(id)) {
    throw new ProfileError(`cyklická dědičnost: ${[...seen, id].join(' -> ')}`);
  }
  if (seen.length >= MAX_INHERITANCE_DEPTH) {
    throw new ProfileError(`dědičnost je hlubší než ${MAX_INHERITANCE_DEPTH} úrovní`);
  }

  let base = emptyProfile(id);
  if (raw.extends) {
    const parent = byId.get(raw.extends);
    if (!parent) throw new ProfileError(`extends = "${raw.extends}" — takový profil neexistuje`);
    base = resolveOne(parent, byId, [...seen, id]);
  }
  return applyRaw(base, raw);
}

export function resolveProfiles(raws: RawProfile[]): ProfileBundle {
  const problems: ProfileProblem[] = [];
  const byId = new Map<string, RawProfile>();

  for (const raw of raws) {
    const id = raw.id ?? idFromFileName(raw.file);
    if (byId.has(id)) {
      problems.push({ file: raw.file, message: `duplicitní id "${id}", soubor se přeskakuje` });
      continue;
    }
    byId.set(id, raw);
  }

  const profiles: Profile[] = [];
  for (const raw of byId.values()) {
    try {
      profiles.push(resolveOne(raw, byId, []));
    } catch (err) {
      problems.push({ file: raw.file, message: err instanceof Error ? err.message : String(err) });
    }
  }

  profiles.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  return { profiles, problems };
}

/** Načte celou složku profilů: `{ 'development.toml': '<obsah>' }`. */
export function loadProfiles(sources: Record<string, string>): ProfileBundle {
  const raws: RawProfile[] = [];
  const problems: ProfileProblem[] = [];

  for (const [file, source] of Object.entries(sources)) {
    try {
      raws.push(parseProfile(source, file));
    } catch (err) {
      const message =
        err instanceof TomlError || err instanceof ProfileError ? err.message : String(err);
      problems.push({ file, message });
    }
  }

  const bundle = resolveProfiles(raws);
  return { profiles: bundle.profiles, problems: [...problems, ...bundle.problems] };
}

/** Rozbalí `{PLACEHOLDER}` podle tabulky. Neznámý placeholder zůstane vidět. */
export function expandPlaceholders(input: string, vars: Record<string, string | undefined>): string {
  return input.replace(/\{([A-Z_]+)\}/g, (whole, key: string) => vars[key] ?? whole);
}

export function unresolvedPlaceholders(input: string): string[] {
  return [...input.matchAll(/\{([A-Z_]+)\}/g)].map((m) => m[1]);
}

export type { TomlValue };
