/**
 * Web-only mock systému.
 *
 * Zrcadlo `MockProvider`u v Rustu (`src-tauri/src/provider/mock.rs`) — stejné
 * procesy, stejné cesty, stejná pravidla. Díky tomu jde celé UI vyvíjet
 * v prohlížeči bez Tauri a bez Windows (požadavek 6).
 *
 * Data jsou deterministická: hodnota metriky je čistá funkce čísla ticku,
 * ne `Math.random()`. Stejný tick ⇒ stejné číslo, vždycky. Metriky se tedy
 * hýbou, ale běh je reprodukovatelný a testovatelný.
 *
 * Invariant 6: nic tady neukončuje reálný proces. `terminate()` jen přepne
 * příznak v poli v paměti a vrátí zprávu, že šlo o simulaci.
 */

import type {
  Metrics,
  ProcessInfo,
  ProviderInfo,
  Snapshot,
  TerminateOutcome,
} from '../lib/types';

const RAM_TOTAL_MB = 16 * 1024;

/** Cesty, které mock hlásí místo skutečných známých složek Windows. */
export const MOCK_PATHS: Record<string, string> = {
  HOME: 'C:/Users/mock',
  PROJECTS: 'C:/Users/mock/Projekty',
  DESKTOP: 'C:/Users/mock/Desktop',
  DOWNLOADS: 'C:/Users/mock/Downloads',
};

/**
 * Procesy, které mock odmítne ukončit i po potvrzení.
 *
 * Invariant 1 (fail-safe): ukončení kteréhokoli z nich znamená rozbité
 * Windows. Denylist sedí ve vrstvě provideru schválně — profil ho nesmí
 * obejít, ať už do něj napíše cokoli.
 */
export const PROTECTED_PROCESSES = [
  'system',
  'system idle process',
  'registry',
  'smss.exe',
  'csrss.exe',
  'wininit.exe',
  'winlogon.exe',
  'services.exe',
  'lsass.exe',
  'svchost.exe',
  'explorer.exe',
  'dwm.exe',
  'fontdrvhost.exe',
  'ctfmon.exe',
  'memcompression',
];

export function isProtected(name: string): boolean {
  return PROTECTED_PROCESSES.includes(name.toLowerCase());
}

interface MockProcessSeed {
  pid: number;
  name: string;
  label: string;
  /** Základ spotřeby RAM v MB; kolem něj se deterministicky kolísá. */
  baseMemoryMb: number;
  /** Základ vytížení CPU v procentech. */
  baseCpu: number;
}

/**
 * Pevná tabulka procesů. Obsahuje záměrně i systémové procesy — aby bylo
 * na čem ověřit, že se do nabídky k ukončení nikdy nedostanou.
 */
const SEEDS: MockProcessSeed[] = [
  { pid: 4, name: 'System', label: 'Windows — jádro', baseMemoryMb: 24, baseCpu: 0.4 },
  { pid: 892, name: 'svchost.exe', label: 'Windows — služby', baseMemoryMb: 128, baseCpu: 0.8 },
  { pid: 1204, name: 'explorer.exe', label: 'Průzkumník', baseMemoryMb: 172, baseCpu: 1.2 },
  { pid: 1440, name: 'dwm.exe', label: 'Správce oken', baseMemoryMb: 148, baseCpu: 2.1 },
  { pid: 2312, name: 'MsMpEng.exe', label: 'Ochrana v reálném čase', baseMemoryMb: 246, baseCpu: 3.4 },

  { pid: 3120, name: 'Code.exe', label: 'Visual Studio Code', baseMemoryMb: 412, baseCpu: 2.6 },
  { pid: 3148, name: 'Code.exe', label: 'Code — jazykový server', baseMemoryMb: 318, baseCpu: 4.1 },
  { pid: 3402, name: 'node.exe', label: 'Node — dev server', baseMemoryMb: 264, baseCpu: 5.2 },
  { pid: 3418, name: 'node.exe', label: 'Node — watcher', baseMemoryMb: 118, baseCpu: 1.1 },
  { pid: 3660, name: 'wt.exe', label: 'Windows Terminal', baseMemoryMb: 86, baseCpu: 0.5 },
  { pid: 3712, name: 'git.exe', label: 'Git — fetch', baseMemoryMb: 34, baseCpu: 0.2 },

  { pid: 4208, name: 'chrome.exe', label: 'Chrome — hlavní okno', baseMemoryMb: 486, baseCpu: 3.8 },
  { pid: 4232, name: 'chrome.exe', label: 'Chrome — panel (dokumentace)', baseMemoryMb: 318, baseCpu: 1.4 },
  { pid: 4266, name: 'chrome.exe', label: 'Chrome — panel (video)', baseMemoryMb: 542, baseCpu: 6.7 },
  { pid: 4290, name: 'chrome.exe', label: 'Chrome — GPU proces', baseMemoryMb: 224, baseCpu: 2.9 },
  { pid: 4512, name: 'msedge.exe', label: 'Edge', baseMemoryMb: 288, baseCpu: 1.6 },

  { pid: 5104, name: 'steam.exe', label: 'Steam', baseMemoryMb: 356, baseCpu: 1.9 },
  { pid: 5140, name: 'steamwebhelper.exe', label: 'Steam — overlay', baseMemoryMb: 402, baseCpu: 2.4 },
  { pid: 5320, name: 'EpicGamesLauncher.exe', label: 'Epic Games Launcher', baseMemoryMb: 298, baseCpu: 1.3 },
  { pid: 5602, name: 'Discord.exe', label: 'Discord', baseMemoryMb: 334, baseCpu: 2.2 },
  { pid: 5730, name: 'Spotify.exe', label: 'Spotify', baseMemoryMb: 268, baseCpu: 1.8 },

  { pid: 6104, name: 'ms-teams.exe', label: 'Microsoft Teams', baseMemoryMb: 462, baseCpu: 2.7 },
  { pid: 6350, name: 'Docker Desktop.exe', label: 'Docker Desktop', baseMemoryMb: 512, baseCpu: 1.5 },
  { pid: 6402, name: 'ollama.exe', label: 'Ollama — server', baseMemoryMb: 1180, baseCpu: 7.4 },
  { pid: 6688, name: 'python.exe', label: 'Python — jupyter kernel', baseMemoryMb: 624, baseCpu: 8.9 },
];

/** Cíle, které mock považuje za nainstalované. Ostatní hlásí jako nenalezené. */
const KNOWN_TARGETS = ['code', 'wt', 'steam', 'discord', 'explorer', 'jupyter', 'python', 'git'];

/** Deterministický hash → číslo v intervalu [0, 1). Nahrazuje Math.random(). */
function hash01(a: number, b: number): number {
  let h = (Math.imul(a, 374761393) + Math.imul(b, 668265263)) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}

/** Kolísání kolem základu: pomalá vlna + drobný deterministický šum. */
function wobble(base: number, tick: number, salt: number, amplitude: number): number {
  const wave = Math.sin((tick + salt) / 7.5);
  const noise = hash01(tick, salt) - 0.5;
  return base * (1 + amplitude * (wave * 0.7 + noise * 0.6));
}

export class MockSystem {
  private tick = 0;
  /** pid → ukončeno (jen v mocku, žádný reálný dopad). */
  private readonly terminated = new Set<number>();

  readonly info: ProviderInfo = {
    kind: 'mock',
    label: 'MockProvider',
    canWrite: true,
    note: 'Simulace. Žádný proces se reálně neukončuje, žádná aplikace se reálně nespouští.',
  };

  /** Posune čas o jeden krok. Volá se z každého snapshotu. */
  advance(): void {
    this.tick += 1;
  }

  currentTick(): number {
    return this.tick;
  }

  processes(): ProcessInfo[] {
    return SEEDS.filter((seed) => !this.terminated.has(seed.pid)).map((seed) => ({
      pid: seed.pid,
      name: seed.name,
      label: seed.label,
      memoryMb: Math.max(8, Math.round(wobble(seed.baseMemoryMb, this.tick, seed.pid, 0.12))),
      cpuPercent: Math.max(0, Math.round(wobble(seed.baseCpu, this.tick, seed.pid + 1, 0.55) * 10) / 10),
      protected: isProtected(seed.name),
    }));
  }

  metrics(): Metrics {
    const procs = this.processes();
    // Základ mimo sledované procesy — cache, ovladače, zbytek systému.
    const baseline = 2600;
    const ramUsedMb = Math.min(
      RAM_TOTAL_MB - 256,
      Math.round(baseline + procs.reduce((sum, p) => sum + p.memoryMb, 0)),
    );

    // Součet přes všechny procesy je na 12 vláknech nadhodnocený — škáluj
    // ho na hodnotu, která odpovídá reálnému vytížení pracovního stroje.
    const cpuRaw = procs.reduce((sum, p) => sum + p.cpuPercent, 0) * 0.55;
    const cpuPercent = Math.max(1, Math.min(99, Math.round(cpuRaw * 10) / 10));

    // Teplota táhne za CPU se zpožděním — sledovat skok metriky je pak čitelnější.
    const tempC = Math.round((38 + cpuPercent * 0.42 + hash01(this.tick, 99) * 3) * 10) / 10;

    return { ramUsedMb, ramTotalMb: RAM_TOTAL_MB, cpuPercent, tempC };
  }

  snapshot(): Snapshot {
    return { provider: this.info, metrics: this.metrics(), processes: this.processes() };
  }

  /** Zjistí, jestli mock „zná" spustitelný cíl. Read-only dotaz. */
  targetAvailable(kind: string, target: string): boolean {
    if (kind === 'url') return /^https?:\/\//.test(target);
    if (kind === 'folder') return !target.includes('{');
    const exe = target.replace(/^.*[/\\]/, '').replace(/\.exe$/i, '').toLowerCase();
    return KNOWN_TARGETS.includes(exe);
  }

  /**
   * Simulované ukončení. Chráněné procesy odmítne i po potvrzení uživatele —
   * potvrzení je nutná, ne postačující podmínka.
   */
  terminate(pids: number[]): TerminateOutcome[] {
    return pids.map((pid) => {
      const seed = SEEDS.find((s) => s.pid === pid);
      if (!seed) {
        return { pid, name: 'neznámý', ok: false, message: 'Proces s tímto PID neběží.' };
      }
      if (isProtected(seed.name)) {
        return {
          pid,
          name: seed.name,
          ok: false,
          message: 'Chráněný systémový proces — provider ho odmítá ukončit.',
        };
      }
      if (this.terminated.has(pid)) {
        return { pid, name: seed.name, ok: false, message: 'Proces už byl v této relaci ukončen.' };
      }
      this.terminated.add(pid);
      return { pid, name: seed.name, ok: true, message: 'Ukončeno v simulaci — reálný proces běží dál.' };
    });
  }

  /** Vrátí mock do výchozího stavu (používá se v testech a v Configu). */
  reset(): void {
    this.tick = 0;
    this.terminated.clear();
  }
}
