//! Windows provider — v této verzi **jen pro čtení**.
//!
//! Co umí: seznam procesů, obsazenou a celkovou RAM, vytížení CPU a teplotu,
//! pokud ji stroj vůbec vydá (na spoustě notebooků ne — pak vrací `None`
//! a UI napíše „není k dispozici", místo aby si číslo vymyslelo).
//!
//! Co neumí a v této verzi umět nemá: spustit aplikaci a ukončit proces.
//! Obě zápisové metody zůstávají nedopsané (`todo!()`) a [`ProviderInfo::can_write`]
//! hlásí `false`, takže je vrstva příkazů vůbec nezavolá — místo pádu vrátí
//! uživateli srozumitelnou hlášku. Invariant 6.
//!
//! Provider se nepoužije sám od sebe: aktivuje ho až `OPSYS_PROVIDER=windows`.

use std::collections::BTreeMap;
use std::sync::Mutex;

use sysinfo::{Components, System};

use super::{
    is_protected, Metrics, ProcessInfo, ProviderError, ProviderInfo, ProviderKind, SystemProvider,
};

pub struct WindowsProvider {
    /// `sysinfo` potřebuje pro obnovení `&mut`, proto zámek.
    system: Mutex<System>,
}

impl WindowsProvider {
    pub fn new() -> Self {
        let mut system = System::new_all();
        system.refresh_all();
        Self {
            system: Mutex::new(system),
        }
    }

    fn locked(&self) -> Result<std::sync::MutexGuard<'_, System>, ProviderError> {
        self.system
            .lock()
            .map_err(|_| ProviderError::System("Stav systému je nedostupný.".to_string()))
    }
}

impl Default for WindowsProvider {
    fn default() -> Self {
        Self::new()
    }
}

/// Teplota z prvního senzoru, který vrátí použitelnou hodnotu.
///
/// Na hodně strojích nevrátí použitelnou hodnotu žádný — Windows ji bez
/// ovladače výrobce přes WMI často nevydá. `None` je legitimní výsledek,
/// ne chyba.
fn read_temperature() -> Option<f32> {
    let components = Components::new_with_refreshed_list();
    components
        .iter()
        .map(|component| component.temperature())
        .find(|value| value.is_finite() && *value > 0.0)
}

fn bytes_to_mb(bytes: u64) -> u64 {
    bytes / 1024 / 1024
}

impl SystemProvider for WindowsProvider {
    fn info(&self) -> ProviderInfo {
        ProviderInfo {
            kind: ProviderKind::Windows,
            label: "WindowsProvider".to_string(),
            // Klíčové: dokud je zápis nedopsaný, nesmí ho nikdo zavolat.
            can_write: false,
            note: "Jen pro čtení. Spouštění a ukončování v této verzi neimplementováno."
                .to_string(),
        }
    }

    fn metrics(&self) -> Result<Metrics, ProviderError> {
        let mut system = self.locked()?;
        system.refresh_all();

        Ok(Metrics {
            ram_used_mb: bytes_to_mb(system.used_memory()),
            ram_total_mb: bytes_to_mb(system.total_memory()),
            cpu_percent: system.global_cpu_usage(),
            temp_c: read_temperature(),
        })
    }

    fn processes(&self) -> Result<Vec<ProcessInfo>, ProviderError> {
        let mut system = self.locked()?;
        system.refresh_all();

        let mut out: Vec<ProcessInfo> = system
            .processes()
            .iter()
            .map(|(pid, process)| {
                let name = process.name().to_string_lossy().to_string();
                let label = name
                    .strip_suffix(".exe")
                    .unwrap_or(&name)
                    .to_string();

                ProcessInfo {
                    pid: pid.as_u32(),
                    protected: is_protected(&name),
                    label,
                    name,
                    memory_mb: bytes_to_mb(process.memory()),
                    cpu_percent: (process.cpu_usage() * 10.0).round() / 10.0,
                }
            })
            .collect();

        out.sort_by(|a, b| b.memory_mb.cmp(&a.memory_mb));
        Ok(out)
    }

    fn known_paths(&self) -> BTreeMap<String, String> {
        let mut paths = BTreeMap::new();

        // Žádná cesta se nezadrátovává — čte se z prostředí. Když proměnná
        // chybí, placeholder se nerozbalí a UI to označí, místo aby hádalo.
        if let Some(home) = std::env::var_os("USERPROFILE") {
            let home = home.to_string_lossy().replace('\\', "/");
            paths.insert("DESKTOP".to_string(), format!("{home}/Desktop"));
            paths.insert("DOWNLOADS".to_string(), format!("{home}/Downloads"));
            paths.insert("PROJECTS".to_string(), format!("{home}/Projekty"));
            paths.insert("HOME".to_string(), home);
        }
        paths
    }

    fn target_available(&self, kind: &str, target: &str) -> bool {
        match kind {
            "url" => target.starts_with("http://") || target.starts_with("https://"),
            "folder" => std::path::Path::new(target).is_dir(),
            _ => {
                // Absolutní cesta k souboru, nebo něco, co leží v PATH.
                let path = std::path::Path::new(target);
                if path.is_absolute() {
                    return path.is_file();
                }
                which_in_path(target).is_some()
            }
        }
    }

    fn launch(&self, _kind: &str, _target: &str, _args: &[String]) -> Result<(), ProviderError> {
        // Záměrně nedopsáno. Spouštění procesů je zápisová operace a ta patří
        // až do verze, kde je pokrytá testy a potvrzovacím tokem v UI.
        // Vrstva příkazů sem nikdy nedojde: info().can_write == false.
        todo!("spuštění aplikace na Windows — až po verifikaci zápisových operací")
    }

    fn terminate(&self, _pid: u32) -> Result<(), ProviderError> {
        // Záměrně nedopsáno. Ukončení cizího procesu je nevratná operace
        // a v tomto návrhu se nesmí stát vůbec. Vrstva příkazů sem nedojde:
        // info().can_write == false.
        todo!("ukončení procesu na Windows — až po verifikaci zápisových operací")
    }
}

/// Najde spustitelný soubor v `PATH`. Read-only — jen se dívá, jestli existuje.
fn which_in_path(target: &str) -> Option<std::path::PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    let exts: Vec<String> = std::env::var("PATHEXT")
        .unwrap_or_else(|_| ".EXE;.CMD;.BAT;.COM".to_string())
        .split(';')
        .map(|ext| ext.to_ascii_lowercase())
        .collect();

    for dir in std::env::split_paths(&path_var) {
        let direct = dir.join(target);
        if direct.is_file() {
            return Some(direct);
        }
        for ext in &exts {
            let candidate = dir.join(format!("{target}{ext}"));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hlasi_se_jako_jen_pro_cteni() {
        let provider = WindowsProvider::new();
        let info = provider.info();

        assert_eq!(info.kind, ProviderKind::Windows);
        assert!(
            !info.can_write,
            "Windows provider nesmí v této verzi hlásit, že umí zapisovat"
        );
    }

    #[test]
    fn cte_procesy_a_pamet() {
        let provider = WindowsProvider::new();

        let metrics = provider.metrics().unwrap();
        assert!(metrics.ram_total_mb > 0, "celková RAM musí být kladná");
        assert!(metrics.ram_used_mb <= metrics.ram_total_mb);

        let procs = provider.processes().unwrap();
        assert!(!procs.is_empty(), "na běžícím systému musí být procesy");
    }

    #[test]
    fn systemove_procesy_jsou_oznacene_jako_chranene() {
        let provider = WindowsProvider::new();
        let procs = provider.processes().unwrap();

        // Na běžících Windows vždycky poběží aspoň jeden z chráněných procesů.
        assert!(
            procs.iter().any(|p| p.protected),
            "žádný proces nebyl označen jako chráněný"
        );
    }

    #[test]
    fn dostupnost_cilu_v_path() {
        let provider = WindowsProvider::new();
        // cmd je na každém Windows stroji
        assert!(provider.target_available("app", "cmd"));
        assert!(!provider.target_available("app", "urcite-neexistujici-program-xyz"));
        assert!(provider.target_available("url", "https://example.test"));
    }
}
