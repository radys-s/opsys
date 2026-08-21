//! Hranice mezi aplikací a operačním systémem.
//!
//! Všechno, co by se dotklo reálného stroje, prochází traitem [`SystemProvider`].
//! Existují dvě implementace:
//!
//! - [`mock::MockProvider`] — výchozí. Deterministická data, běží na Linuxu
//!   i macOS, nic reálného nespouští ani neukončuje.
//! - [`windows::WindowsProvider`] — jen na Windows a zatím jen pro čtení.
//!
//! Invariant 6: v této verzi nic reálně neukončujeme. Zápisové operace
//! Windows provideru zůstávají nedopsané a `info().can_write` u něj hlásí
//! `false`, takže je vrstva příkazů vůbec nezavolá.

use std::collections::BTreeMap;
use std::fmt;

use serde::{Deserialize, Serialize};

pub mod mock;

#[cfg(target_os = "windows")]
pub mod windows;

// ---- datové typy sdílené s frontendem --------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessInfo {
    pub pid: u32,
    pub name: String,
    pub label: String,
    pub memory_mb: u64,
    pub cpu_percent: f32,
    /// Systémový proces, který provider odmítne ukončit za všech okolností.
    pub protected: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Metrics {
    pub ram_used_mb: u64,
    pub ram_total_mb: u64,
    pub cpu_percent: f32,
    /// `None` = provider teplotu nemá (běžné na noteboocích bez čitelného senzoru).
    pub temp_c: Option<f32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderKind {
    Mock,
    Windows,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInfo {
    pub kind: ProviderKind,
    pub label: String,
    /// `false` ⇒ vrstva příkazů zápisové operace vůbec nezavolá.
    pub can_write: bool,
    pub note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub provider: ProviderInfo,
    pub metrics: Metrics,
    pub processes: Vec<ProcessInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminateOutcome {
    pub pid: u32,
    pub name: String,
    pub ok: bool,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchOutcome {
    pub id: String,
    pub label: String,
    pub ok: bool,
    pub message: String,
}

// ---- chyby -----------------------------------------------------------------

#[derive(Debug)]
pub enum ProviderError {
    /// Provider operaci umí, ale v této verzi ji záměrně neposkytuje.
    Unsupported(String),
    /// Operace selhala na úrovni systému.
    System(String),
}

impl fmt::Display for ProviderError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ProviderError::Unsupported(msg) => write!(f, "{msg}"),
            ProviderError::System(msg) => write!(f, "{msg}"),
        }
    }
}

impl std::error::Error for ProviderError {}

// ---- chráněné procesy ------------------------------------------------------

/// Procesy, které se nesmí ukončit ani po potvrzení uživatele.
///
/// Invariant 1 (fail-safe): ukončení kteréhokoli z nich znamená rozbitá
/// Windows. Seznam sedí ve vrstvě provideru schválně — profil ho nesmí
/// obejít, ať do sekce `[[kill]]` napíše cokoli.
pub const PROTECTED_PROCESSES: &[&str] = &[
    "system",
    "system idle process",
    "registry",
    "smss.exe",
    "csrss.exe",
    "wininit.exe",
    "winlogon.exe",
    "services.exe",
    "lsass.exe",
    "svchost.exe",
    "explorer.exe",
    "dwm.exe",
    "fontdrvhost.exe",
    "ctfmon.exe",
    "memcompression",
];

pub fn is_protected(name: &str) -> bool {
    let lowered = name.to_ascii_lowercase();
    PROTECTED_PROCESSES.iter().any(|p| *p == lowered)
}

// ---- trait -----------------------------------------------------------------

pub trait SystemProvider: Send + Sync {
    fn info(&self) -> ProviderInfo;

    fn metrics(&self) -> Result<Metrics, ProviderError>;

    fn processes(&self) -> Result<Vec<ProcessInfo>, ProviderError>;

    /// Placeholdery pro cesty (`HOME`, `PROJECTS`, …). Profily nesmí obsahovat
    /// absolutní cesty, takže je dodává až provider.
    fn known_paths(&self) -> BTreeMap<String, String>;

    /// Read-only dotaz: dá se tenhle cíl vůbec spustit?
    fn target_available(&self, kind: &str, target: &str) -> bool;

    /// Zápisová operace. Volá se jen když `info().can_write == true`.
    fn launch(&self, kind: &str, target: &str, args: &[String]) -> Result<(), ProviderError>;

    /// Zápisová operace. Volá se jen když `info().can_write == true`
    /// a jen po výslovném potvrzení uživatele v dialogu.
    fn terminate(&self, pid: u32) -> Result<(), ProviderError>;

    fn snapshot(&self) -> Result<Snapshot, ProviderError> {
        Ok(Snapshot {
            provider: self.info(),
            metrics: self.metrics()?,
            processes: self.processes()?,
        })
    }
}

/// Vybere provider pro tento běh.
///
/// Výchozí je vždy mock — i na Windows. Read-only Windows telemetrii si musí
/// uživatel vyžádat proměnnou prostředí `OPSYS_PROVIDER=windows`. Fail-safe
/// znamená mimo jiné to, že se aplikace sama od sebe nikdy nezačne ptát
/// systému na víc, než musí.
pub fn create_provider() -> Box<dyn SystemProvider> {
    #[cfg(target_os = "windows")]
    {
        if std::env::var("OPSYS_PROVIDER").as_deref() == Ok("windows") {
            return Box::new(windows::WindowsProvider::new());
        }
    }

    Box::new(mock::MockProvider::new())
}
