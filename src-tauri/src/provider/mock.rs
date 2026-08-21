//! Výchozí provider. Deterministická data, nulový dopad na stroj.
//!
//! Zrcadlo `src/mock/mockSystem.ts` — stejné procesy, stejné cesty, stejná
//! pravidla. Cílem je, aby `npm run dev` v prohlížeči a `npm run tauri dev`
//! ukazovaly totéž a UI se dalo vyvíjet bez Windows.
//!
//! Hodnota metriky je čistá funkce čísla ticku, ne náhoda. Metriky se hýbou,
//! ale běh je reprodukovatelný.

use std::collections::{BTreeMap, HashSet};
use std::sync::Mutex;

use super::{
    is_protected, Metrics, ProcessInfo, ProviderError, ProviderInfo, ProviderKind, Snapshot,
    SystemProvider,
};

const RAM_TOTAL_MB: u64 = 16 * 1024;

/// Cíle, které mock považuje za nainstalované.
const KNOWN_TARGETS: &[&str] = &[
    "code", "wt", "steam", "discord", "explorer", "jupyter", "python", "git",
];

struct Seed {
    pid: u32,
    name: &'static str,
    label: &'static str,
    base_memory_mb: f64,
    base_cpu: f64,
}

/// Systémové procesy jsou v tabulce schválně — je na čem ověřit, že se
/// do nabídky k ukončení nikdy nedostanou.
#[rustfmt::skip]
const SEEDS: &[Seed] = &[
    Seed { pid: 4, name: "System", label: "Windows — jádro", base_memory_mb: 24.0, base_cpu: 0.4 },
    Seed { pid: 892, name: "svchost.exe", label: "Windows — služby", base_memory_mb: 128.0, base_cpu: 0.8 },
    Seed { pid: 1204, name: "explorer.exe", label: "Průzkumník", base_memory_mb: 172.0, base_cpu: 1.2 },
    Seed { pid: 1440, name: "dwm.exe", label: "Správce oken", base_memory_mb: 148.0, base_cpu: 2.1 },
    Seed { pid: 2312, name: "MsMpEng.exe", label: "Ochrana v reálném čase", base_memory_mb: 246.0, base_cpu: 3.4 },

    Seed { pid: 3120, name: "Code.exe", label: "Visual Studio Code", base_memory_mb: 412.0, base_cpu: 2.6 },
    Seed { pid: 3148, name: "Code.exe", label: "Code — jazykový server", base_memory_mb: 318.0, base_cpu: 4.1 },
    Seed { pid: 3402, name: "node.exe", label: "Node — dev server", base_memory_mb: 264.0, base_cpu: 5.2 },
    Seed { pid: 3418, name: "node.exe", label: "Node — watcher", base_memory_mb: 118.0, base_cpu: 1.1 },
    Seed { pid: 3660, name: "wt.exe", label: "Windows Terminal", base_memory_mb: 86.0, base_cpu: 0.5 },
    Seed { pid: 3712, name: "git.exe", label: "Git — fetch", base_memory_mb: 34.0, base_cpu: 0.2 },

    Seed { pid: 4208, name: "chrome.exe", label: "Chrome — hlavní okno", base_memory_mb: 486.0, base_cpu: 3.8 },
    Seed { pid: 4232, name: "chrome.exe", label: "Chrome — panel (dokumentace)", base_memory_mb: 318.0, base_cpu: 1.4 },
    Seed { pid: 4266, name: "chrome.exe", label: "Chrome — panel (video)", base_memory_mb: 542.0, base_cpu: 6.7 },
    Seed { pid: 4290, name: "chrome.exe", label: "Chrome — GPU proces", base_memory_mb: 224.0, base_cpu: 2.9 },
    Seed { pid: 4512, name: "msedge.exe", label: "Edge", base_memory_mb: 288.0, base_cpu: 1.6 },

    Seed { pid: 5104, name: "steam.exe", label: "Steam", base_memory_mb: 356.0, base_cpu: 1.9 },
    Seed { pid: 5140, name: "steamwebhelper.exe", label: "Steam — overlay", base_memory_mb: 402.0, base_cpu: 2.4 },
    Seed { pid: 5320, name: "EpicGamesLauncher.exe", label: "Epic Games Launcher", base_memory_mb: 298.0, base_cpu: 1.3 },
    Seed { pid: 5602, name: "Discord.exe", label: "Discord", base_memory_mb: 334.0, base_cpu: 2.2 },
    Seed { pid: 5730, name: "Spotify.exe", label: "Spotify", base_memory_mb: 268.0, base_cpu: 1.8 },

    Seed { pid: 6104, name: "ms-teams.exe", label: "Microsoft Teams", base_memory_mb: 462.0, base_cpu: 2.7 },
    Seed { pid: 6350, name: "Docker Desktop.exe", label: "Docker Desktop", base_memory_mb: 512.0, base_cpu: 1.5 },
    Seed { pid: 6402, name: "ollama.exe", label: "Ollama — server", base_memory_mb: 1180.0, base_cpu: 7.4 },
    Seed { pid: 6688, name: "python.exe", label: "Python — jupyter kernel", base_memory_mb: 624.0, base_cpu: 8.9 },
];

/// Deterministický hash → číslo v intervalu [0, 1). Nahrazuje generátor náhody.
fn hash01(a: u64, b: u64) -> f64 {
    let mut h = a
        .wrapping_mul(374_761_393)
        .wrapping_add(b.wrapping_mul(668_265_263)) as u32;
    h ^= h >> 13;
    h = h.wrapping_mul(1_274_126_177);
    h ^= h >> 16;
    f64::from(h) / f64::from(u32::MAX)
}

/// Kolísání kolem základu: pomalá vlna a drobný deterministický šum.
fn wobble(base: f64, tick: u64, salt: u64, amplitude: f64) -> f64 {
    let wave = (((tick + salt) as f64) / 7.5).sin();
    let noise = hash01(tick, salt) - 0.5;
    base * (1.0 + amplitude * (wave * 0.7 + noise * 0.6))
}

#[derive(Default)]
struct MockState {
    tick: u64,
    /// PID ukončené v simulaci. Reálný proces se nedotkne nic.
    terminated: HashSet<u32>,
}

pub struct MockProvider {
    state: Mutex<MockState>,
}

impl MockProvider {
    pub fn new() -> Self {
        Self { state: Mutex::new(MockState::default()) }
    }

    /// Posune čas o jeden krok a vrátí nové číslo ticku.
    fn advance(&self) -> u64 {
        let mut state = self.state.lock().expect("mock state");
        state.tick += 1;
        state.tick
    }

    fn snapshot_state(&self) -> (u64, HashSet<u32>) {
        let state = self.state.lock().expect("mock state");
        (state.tick, state.terminated.clone())
    }

    fn processes_at(tick: u64, terminated: &HashSet<u32>) -> Vec<ProcessInfo> {
        SEEDS
            .iter()
            .filter(|seed| !terminated.contains(&seed.pid))
            .map(|seed| ProcessInfo {
                pid: seed.pid,
                name: seed.name.to_string(),
                label: seed.label.to_string(),
                memory_mb: wobble(seed.base_memory_mb, tick, u64::from(seed.pid), 0.12)
                    .round()
                    .max(8.0) as u64,
                cpu_percent: ((wobble(seed.base_cpu, tick, u64::from(seed.pid) + 1, 0.55) * 10.0)
                    .round()
                    .max(0.0)
                    / 10.0) as f32,
                protected: is_protected(seed.name),
            })
            .collect()
    }

    fn metrics_from(procs: &[ProcessInfo], tick: u64) -> Metrics {
        // Základ mimo sledované procesy — cache, ovladače, zbytek systému.
        let baseline_mb = 2600_u64;
        let sum_mb: u64 = procs.iter().map(|p| p.memory_mb).sum();
        let ram_used_mb = (baseline_mb + sum_mb).min(RAM_TOTAL_MB - 256);

        // Součet přes všechny procesy je na 12 vláknech nadhodnocený.
        let cpu_raw: f32 = procs.iter().map(|p| p.cpu_percent).sum::<f32>() * 0.55;
        let cpu_percent = ((cpu_raw * 10.0).round() / 10.0).clamp(1.0, 99.0);

        let temp_c =
            ((38.0 + cpu_percent * 0.42 + hash01(tick, 99) as f32 * 3.0) * 10.0).round() / 10.0;

        Metrics {
            ram_used_mb,
            ram_total_mb: RAM_TOTAL_MB,
            cpu_percent,
            temp_c: Some(temp_c),
        }
    }

    /// Vrátí mock do výchozího stavu. Používá se v testech.
    pub fn reset(&self) {
        let mut state = self.state.lock().expect("mock state");
        state.tick = 0;
        state.terminated.clear();
    }
}

impl Default for MockProvider {
    fn default() -> Self {
        Self::new()
    }
}

impl SystemProvider for MockProvider {
    fn info(&self) -> ProviderInfo {
        ProviderInfo {
            kind: ProviderKind::Mock,
            label: "MockProvider".to_string(),
            can_write: true,
            note: "Simulace. Žádný proces se reálně neukončuje, žádná aplikace se reálně nespouští."
                .to_string(),
        }
    }

    fn metrics(&self) -> Result<Metrics, ProviderError> {
        let (tick, terminated) = self.snapshot_state();
        let procs = Self::processes_at(tick, &terminated);
        Ok(Self::metrics_from(&procs, tick))
    }

    fn processes(&self) -> Result<Vec<ProcessInfo>, ProviderError> {
        let (tick, terminated) = self.snapshot_state();
        Ok(Self::processes_at(tick, &terminated))
    }

    /// Posune čas o krok a spočítá metriky i procesy ze **stejného** ticku.
    ///
    /// Kdyby se tick posouval uvnitř `metrics()`, rozešly by se metriky
    /// se seznamem procesů, ze kterého vznikly. Proto se snapshot skládá tady
    /// a ne v default implementaci traitu.
    fn snapshot(&self) -> Result<Snapshot, ProviderError> {
        let tick = self.advance();
        let (_, terminated) = self.snapshot_state();

        let processes = Self::processes_at(tick, &terminated);
        let metrics = Self::metrics_from(&processes, tick);

        Ok(Snapshot {
            provider: self.info(),
            metrics,
            processes,
        })
    }

    fn known_paths(&self) -> BTreeMap<String, String> {
        let mut paths = BTreeMap::new();
        paths.insert("HOME".to_string(), "C:/Users/mock".to_string());
        paths.insert("PROJECTS".to_string(), "C:/Users/mock/Projekty".to_string());
        paths.insert("DESKTOP".to_string(), "C:/Users/mock/Desktop".to_string());
        paths.insert("DOWNLOADS".to_string(), "C:/Users/mock/Downloads".to_string());
        paths
    }

    fn target_available(&self, kind: &str, target: &str) -> bool {
        match kind {
            "url" => target.starts_with("http://") || target.starts_with("https://"),
            "folder" => !target.contains('{'),
            _ => {
                let file = target.rsplit(['/', '\\']).next().unwrap_or(target);
                let stem = file.strip_suffix(".exe").unwrap_or(file).to_ascii_lowercase();
                KNOWN_TARGETS.contains(&stem.as_str())
            }
        }
    }

    fn launch(&self, _kind: &str, _target: &str, _args: &[String]) -> Result<(), ProviderError> {
        // Simulace: nic se nespouští a čas se neposouvá. Ten se hýbe výhradně
        // se snapshotem, aby zůstalo platit „stejný tick ⇒ stejná čísla".
        Ok(())
    }

    fn terminate(&self, pid: u32) -> Result<(), ProviderError> {
        let seed = SEEDS
            .iter()
            .find(|s| s.pid == pid)
            .ok_or_else(|| ProviderError::System("Proces s tímto PID neběží.".to_string()))?;

        // Potvrzení uživatele je nutná, ne postačující podmínka.
        if is_protected(seed.name) {
            return Err(ProviderError::Unsupported(
                "Chráněný systémový proces — provider ho odmítá ukončit.".to_string(),
            ));
        }

        let mut state = self.state.lock().expect("mock state");
        if !state.terminated.insert(pid) {
            return Err(ProviderError::System(
                "Proces už byl v této relaci ukončen.".to_string(),
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metriky_jsou_deterministicke() {
        let a = MockProvider::new();
        let b = MockProvider::new();

        let first = a.metrics().unwrap();
        let second = b.metrics().unwrap();

        assert_eq!(first.ram_used_mb, second.ram_used_mb);
        assert_eq!(first.cpu_percent, second.cpu_percent);
        assert_eq!(first.temp_c, second.temp_c);
    }

    #[test]
    fn metriky_drzi_v_rozumnych_mezich() {
        let provider = MockProvider::new();
        for _ in 0..200 {
            let snapshot = provider.snapshot().unwrap();
            let m = snapshot.metrics;
            assert!(m.ram_used_mb < m.ram_total_mb, "RAM přeteklo: {m:?}");
            assert!((1.0..=99.0).contains(&m.cpu_percent), "CPU mimo rozsah: {m:?}");
            let temp = m.temp_c.unwrap();
            assert!((30.0..=95.0).contains(&temp), "teplota mimo rozsah: {m:?}");
        }
    }

    #[test]
    fn snapshot_posouva_cas_a_metriky_se_meni() {
        // Dva po sobě jdoucí tiky se teoreticky trefit můžou; přes delší běh
        // se ale hodnoty měnit musí, jinak se čas neposouvá vůbec.
        let provider = MockProvider::new();
        let mut seen: Vec<f32> = Vec::new();
        for _ in 0..20 {
            seen.push(provider.snapshot().unwrap().metrics.cpu_percent);
        }
        let distinct = seen
            .iter()
            .filter(|value| (**value - seen[0]).abs() > f32::EPSILON)
            .count();
        assert!(distinct > 0, "metriky se za 20 snapshotů vůbec nezměnily");

        // ...ale pro daný tick jsou pořád deterministické
        let a = MockProvider::new();
        let b = MockProvider::new();
        assert_eq!(
            a.snapshot().unwrap().metrics.cpu_percent,
            b.snapshot().unwrap().metrics.cpu_percent
        );
    }

    #[test]
    fn chraneny_proces_nejde_ukoncit() {
        let provider = MockProvider::new();
        // explorer.exe je v tabulce procesů a je chráněný
        let err = provider.terminate(1204).unwrap_err();
        assert!(matches!(err, ProviderError::Unsupported(_)));

        let still_running = provider.processes().unwrap();
        assert!(still_running.iter().any(|p| p.pid == 1204));
    }

    #[test]
    fn bezny_proces_zmizi_ze_seznamu() {
        let provider = MockProvider::new();
        assert!(provider.processes().unwrap().iter().any(|p| p.pid == 5104));

        provider.terminate(5104).unwrap();
        assert!(!provider.processes().unwrap().iter().any(|p| p.pid == 5104));

        // druhé ukončení téhož PID musí selhat, ne tiše projít
        assert!(provider.terminate(5104).is_err());
    }

    #[test]
    fn systemove_procesy_jsou_oznacene() {
        let provider = MockProvider::new();
        let procs = provider.processes().unwrap();

        let explorer = procs.iter().find(|p| p.name == "explorer.exe").unwrap();
        assert!(explorer.protected);

        let steam = procs.iter().find(|p| p.name == "steam.exe").unwrap();
        assert!(!steam.protected);
    }

    #[test]
    fn dostupnost_cilu() {
        let provider = MockProvider::new();
        assert!(provider.target_available("app", "code"));
        assert!(provider.target_available("app", "Code.exe"));
        assert!(!provider.target_available("app", "neexistujici-program"));
        assert!(provider.target_available("url", "https://example.test"));
        assert!(!provider.target_available("url", "example.test"));
        assert!(!provider.target_available("folder", "{PROJECTS}/x"));
    }
}
