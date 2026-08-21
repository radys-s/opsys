import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { parseToml, TomlError } from '../src/lib/toml';
import { expandPlaceholders, loadProfiles, parseProfile, resolveProfiles } from '../src/lib/profiles';
import type { RawProfile } from '../src/lib/types';

const PROFILES_DIR = join(process.cwd(), 'profiles');

function readProfileSources(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const file of readdirSync(PROFILES_DIR)) {
    if (file.endsWith('.toml')) out[file] = readFileSync(join(PROFILES_DIR, file), 'utf8');
  }
  return out;
}

function raw(source: string, file = 'test.toml'): RawProfile {
  return parseProfile(source, file);
}

describe('toml parser', () => {
  it('čte skaláry, pole a tabulky', () => {
    const t = parseToml(`
      # komentář
      name = "OP sys"
      order = 10
      ratio = 1.5
      on = true

      [context]
      path = 'C:\\literal\\path'

      [[launch]]
      id = "a"
      args = ["x", "y"]

      [[launch]]
      id = "b"
      args = [
        "prvni",
        "druhy",
      ]
    `);

    expect(t.name).toBe('OP sys');
    expect(t.order).toBe(10);
    expect(t.ratio).toBe(1.5);
    expect(t.on).toBe(true);
    expect((t.context as Record<string, unknown>).path).toBe('C:\\literal\\path');
    expect((t.launch as unknown[]).length).toBe(2);
    expect(((t.launch as Record<string, unknown>[])[1].args as string[])).toEqual(['prvni', 'druhy']);
  });

  it('escapy a inline tabulky', () => {
    const t = parseToml('a = "prvni\\ndruhy"\nb = { x = 1, y = "dva" }\n');
    expect(t.a).toBe('prvni\ndruhy');
    expect(t.b).toEqual({ x: 1, y: 'dva' });
  });

  it('hlásí číslo řádku u chyby', () => {
    let caught: unknown;
    try {
      parseToml('a = 1\nb = "neuzavreny\n');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TomlError);
    expect((caught as TomlError).line).toBe(2);
  });
});

describe('dědičnost profilů', () => {
  const parent = `
    id = "development"
    name = "Development"
    order = 10
    layer = "on"
    [context]
    path = "{PROJECTS}/Osobni"
    note = "poznamka rodice"
    [[launch]]
    id = "editor"
    label = "Editor"
    target = "code"
    [[launch]]
    id = "repo"
    label = "Repo"
    kind = "url"
    target = "https://example.test"
    [[kill]]
    id = "steam"
    label = "Steam"
    match = "steam.exe"
    severity = "soft"
  `;

  it('dítě dědí vše, co nepřepíše', () => {
    const child = `
      extends = "development"
      id = "skola"
      name = "Škola"
      order = 20
      [context]
      path = "{PROJECTS}/Skola"
    `;
    const { profiles, problems } = resolveProfiles([raw(parent, 'development.toml'), raw(child, 'skola.toml')]);
    expect(problems).toEqual([]);

    const skola = profiles.find((p) => p.id === 'skola')!;
    expect(skola.name).toBe('Škola');
    expect(skola.layer).toBe('on');
    expect(skola.context.path).toBe('{PROJECTS}/Skola');
    expect(skola.context.note).toBe('poznamka rodice');
    expect(skola.launch.map((l) => l.id)).toEqual(['editor', 'repo']);
  });

  it('remove_launch odebere zděděnou položku, nová se připojí na konec', () => {
    const child = `
      extends = "development"
      id = "skola"
      remove_launch = ["repo"]
      [[launch]]
      id = "rozvrh"
      label = "Rozvrh"
      kind = "url"
      target = "https://rozvrh.test"
    `;
    const { profiles } = resolveProfiles([raw(parent, 'development.toml'), raw(child, 'skola.toml')]);
    const skola = profiles.find((p) => p.id === 'skola')!;
    expect(skola.launch.map((l) => l.id)).toEqual(['editor', 'rozvrh']);
  });

  it('přepis podle id zachová původní pozici v seznamu', () => {
    const child = `
      extends = "development"
      id = "skola"
      [[kill]]
      id = "steam"
      label = "Steam"
      match = "steam.exe"
      severity = "strong"
      [[kill]]
      id = "discord"
      label = "Discord"
      match = "Discord.exe"
    `;
    const { profiles } = resolveProfiles([raw(parent, 'development.toml'), raw(child, 'skola.toml')]);
    const skola = profiles.find((p) => p.id === 'skola')!;
    expect(skola.kill.map((k) => k.id)).toEqual(['steam', 'discord']);
    expect(skola.kill[0].severity).toBe('strong');
  });

  it('rodič se přepsáním dítěte nezmění', () => {
    const child = `
      extends = "development"
      id = "skola"
      remove_launch = ["repo"]
    `;
    const { profiles } = resolveProfiles([raw(parent, 'development.toml'), raw(child, 'skola.toml')]);
    const dev = profiles.find((p) => p.id === 'development')!;
    expect(dev.launch.map((l) => l.id)).toEqual(['editor', 'repo']);
  });

  it('cyklus a chybějící rodič se hlásí jako problém, ne jako pád', () => {
    const a = raw('id = "a"\nextends = "b"\n', 'a.toml');
    const b = raw('id = "b"\nextends = "a"\n', 'b.toml');
    const cycle = resolveProfiles([a, b]);
    expect(cycle.problems.length).toBe(2);
    expect(cycle.problems[0].message).toContain('cyklick');

    const orphan = resolveProfiles([raw('id = "x"\nextends = "neni"\n', 'x.toml')]);
    expect(orphan.profiles).toEqual([]);
    expect(orphan.problems[0].message).toContain('neexistuje');
  });

  it('chybná položka nezabije ostatní profily', () => {
    const sources = {
      'ok.toml': 'id = "ok"\nname = "OK"\n',
      'rozbity.toml': 'id = "rozbity"\n[[launch]]\nlabel = "bez id"\ntarget = "x"\n',
    };
    const { profiles, problems } = loadProfiles(sources);
    expect(profiles.map((p) => p.id)).toEqual(['ok']);
    expect(problems[0].file).toBe('rozbity.toml');
  });
});

describe('placeholdery', () => {
  it('rozbalí známé a nechá neznámé viditelné', () => {
    const out = expandPlaceholders('{PROJECTS}/Osobni/{NEZNAMY}', { PROJECTS: 'D:/Proj' });
    expect(out).toBe('D:/Proj/Osobni/{NEZNAMY}');
  });
});

describe('skutečná složka profiles/', () => {
  const bundle = loadProfiles(readProfileSources());

  it('načte se bez jediného problému', () => {
    expect(bundle.problems).toEqual([]);
  });

  it('obsahuje všech šest režimů ve správném pořadí', () => {
    expect(bundle.profiles.map((p) => p.id)).toEqual([
      'development',
      'skola',
      'ai-lab',
      'hry',
      'unlock',
      'config',
    ]);
  });

  it('Škola je vrstva nad Developmentem', () => {
    const dev = bundle.profiles.find((p) => p.id === 'development')!;
    const skola = bundle.profiles.find((p) => p.id === 'skola')!;

    expect(skola.extends).toBe('development');
    // zdědila editor i terminál
    expect(skola.launch.map((l) => l.id)).toContain('editor');
    expect(skola.launch.map((l) => l.id)).toContain('terminal');
    // odebrala repo, přidala školní položky
    expect(skola.launch.map((l) => l.id)).not.toContain('repo');
    expect(skola.launch.map((l) => l.id)).toContain('rozvrh');
    // přísnější severity u Spotify než v Developmentu
    expect(dev.kill.find((k) => k.id === 'spotify')!.severity).toBe('soft');
    expect(skola.kill.find((k) => k.id === 'spotify')!.severity).toBe('suggest');
  });

  it('Unlock je opravdu vypnutá vrstva', () => {
    const unlock = bundle.profiles.find((p) => p.id === 'unlock')!;
    expect(unlock.layer).toBe('off');
    expect(unlock.launch).toEqual([]);
    expect(unlock.kill).toEqual([]);
  });

  it('žádný profil neobsahuje absolutní cestu', () => {
    for (const profile of bundle.profiles) {
      const paths = [profile.context.path ?? '', ...profile.launch.flatMap((l) => [l.target, ...l.args])];
      for (const p of paths) {
        expect(p, `${profile.id}: ${p}`).not.toMatch(/^[A-Za-z]:[\\/]/);
        expect(p, `${profile.id}: ${p}`).not.toMatch(/Users[\\/]/);
      }
    }
  });
});
