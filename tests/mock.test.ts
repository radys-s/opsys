/**
 * Testy web-only mocku.
 *
 * Scénáře odpovídají testům v `src-tauri/src/provider/mock.rs`. Když se
 * obě implementace rozejdou, spadne jedna z těchto dvou sad — což je celý
 * důvod, proč tu duplicita smí být.
 */

import { describe, expect, it } from 'vitest';

import { isProtected, MockSystem } from '../src/mock/mockSystem';

describe('mock systému', () => {
  it('metriky jsou deterministické', () => {
    const a = new MockSystem();
    const b = new MockSystem();

    a.advance();
    b.advance();

    expect(a.metrics()).toEqual(b.metrics());
  });

  it('metriky se mezi tiky mění, ale drží v mezích', () => {
    const system = new MockSystem();
    const cpuValues = new Set<number>();

    for (let i = 0; i < 200; i++) {
      system.advance();
      const m = system.metrics();

      expect(m.ramUsedMb).toBeLessThan(m.ramTotalMb);
      expect(m.cpuPercent).toBeGreaterThanOrEqual(1);
      expect(m.cpuPercent).toBeLessThanOrEqual(99);
      expect(m.tempC).not.toBeNull();
      expect(m.tempC!).toBeGreaterThanOrEqual(30);
      expect(m.tempC!).toBeLessThanOrEqual(95);

      cpuValues.add(m.cpuPercent);
    }

    expect(cpuValues.size, 'metriky se za 200 tiků vůbec nepohnuly').toBeGreaterThan(10);
  });

  it('chráněný proces nejde ukončit ani na přímý pokyn', () => {
    const system = new MockSystem();
    const explorer = system.processes().find((p) => p.name === 'explorer.exe')!;
    expect(explorer.protected).toBe(true);

    const [outcome] = system.terminate([explorer.pid]);
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain('Chráněný');

    // pořád běží
    expect(system.processes().some((p) => p.pid === explorer.pid)).toBe(true);
  });

  it('běžný proces zmizí ze seznamu a podruhé ukončit nejde', () => {
    const system = new MockSystem();
    expect(system.processes().some((p) => p.pid === 5104)).toBe(true);

    expect(system.terminate([5104])[0].ok).toBe(true);
    expect(system.processes().some((p) => p.pid === 5104)).toBe(false);
    expect(system.terminate([5104])[0].ok).toBe(false);
  });

  it('neznámé PID se odmítne, ne tiše projde', () => {
    const system = new MockSystem();
    const [outcome] = system.terminate([999999]);
    expect(outcome.ok).toBe(false);
  });

  it('dostupnost cílů', () => {
    const system = new MockSystem();

    expect(system.targetAvailable('app', 'code')).toBe(true);
    expect(system.targetAvailable('app', 'Code.exe')).toBe(true);
    expect(system.targetAvailable('app', 'neexistujici-program')).toBe(false);
    expect(system.targetAvailable('url', 'https://example.test')).toBe(true);
    expect(system.targetAvailable('url', 'example.test')).toBe(false);
    expect(system.targetAvailable('folder', '{PROJECTS}/x')).toBe(false);
  });

  it('denylist nezávisí na velikosti písmen', () => {
    expect(isProtected('EXPLORER.EXE')).toBe(true);
    expect(isProtected('lsass.exe')).toBe(true);
    expect(isProtected('steam.exe')).toBe(false);
  });

  it('reset vrátí mock do výchozího stavu', () => {
    const system = new MockSystem();
    system.advance();
    system.terminate([5104]);

    system.reset();

    expect(system.currentTick()).toBe(0);
    expect(system.processes().some((p) => p.pid === 5104)).toBe(true);
  });
});
