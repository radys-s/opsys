//! Vrstva příkazů — to, co frontend vidí přes `invoke`.
//!
//! Dvě věci, které se tu hlídají a nikde jinde:
//!
//! 1. **Vypnutá vrstva** (`layer = "off"`, tedy Unlock a Config) nespouští
//!    a nenabízí nic. Kontroluje se tady, ne až v UI — invariant 3 nesmí jít
//!    obejít jiným klientem.
//! 2. **Provider bez zápisu** (`can_write == false`) se na zápisové metody
//!    vůbec nevolá. Díky tomu je `todo!()` ve Windows provideru nedosažitelný
//!    a uživatel místo pádu dostane větu, co se stalo — invariant 6.

use std::collections::BTreeMap;

use serde::Serialize;
use tauri::State;

use crate::profiles::{
    expand_placeholders, has_unresolved_placeholder, KillRule, LaunchItem, LayerState, Profile,
    ProfileBundle, ProjectContext,
};
use crate::provider::{
    LaunchOutcome, ProcessInfo, Snapshot, SystemProvider, TerminateOutcome,
};

pub struct AppState {
    pub provider: Box<dyn SystemProvider>,
    pub bundle: ProfileBundle,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedLaunch {
    pub item: LaunchItem,
    pub resolved_target: String,
    pub resolved_args: Vec<String>,
    pub available: bool,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KillCandidate {
    pub rule: KillRule,
    pub process: ProcessInfo,
}

const LAYER_OFF: &str =
    "Vrstva je v tomto režimu vypnutá — OP sys nic nespouští ani neukončuje.";
const READ_ONLY: &str =
    "Aktivní provider je jen pro čtení — v této verzi se nic reálně neprovádí.";

/// Placeholdery pro rozbalení cest: od provideru plus kontext samotného profilu.
fn placeholder_vars(provider: &dyn SystemProvider, profile: &Profile) -> BTreeMap<String, String> {
    let mut vars = provider.known_paths();

    if let Some(path) = &profile.context.path {
        let expanded = expand_placeholders(path, &vars);
        vars.insert("CONTEXT_PATH".to_string(), expanded);
    }
    if let Some(repo) = &profile.context.repo {
        vars.insert("CONTEXT_REPO".to_string(), repo.clone());
    }
    vars
}

fn resolve_launch_for(provider: &dyn SystemProvider, profile: &Profile) -> Vec<ResolvedLaunch> {
    if profile.layer == LayerState::Off {
        return Vec::new();
    }

    let vars = placeholder_vars(provider, profile);

    profile
        .launch
        .iter()
        .map(|item| {
            let resolved_target = expand_placeholders(&item.target, &vars);
            let resolved_args: Vec<String> = item
                .args
                .iter()
                .map(|arg| expand_placeholders(arg, &vars))
                .collect();

            let unresolved = has_unresolved_placeholder(&resolved_target);
            let available =
                !unresolved && provider.target_available(item.kind.as_str(), &resolved_target);

            let detail = if unresolved {
                "Cesta obsahuje nerozbalený placeholder."
            } else if available {
                "Připraveno."
            } else {
                "Cíl nenalezen."
            };

            ResolvedLaunch {
                item: item.clone(),
                resolved_target,
                resolved_args,
                available,
                detail: detail.to_string(),
            }
        })
        .collect()
}

// ---- příkazy ---------------------------------------------------------------

#[tauri::command]
pub fn profiles(state: State<'_, AppState>) -> ProfileBundle {
    state.bundle.clone()
}

#[tauri::command]
pub fn snapshot(state: State<'_, AppState>) -> Result<Snapshot, String> {
    state.provider.snapshot().map_err(|err| err.to_string())
}

#[tauri::command]
pub fn resolve_context(profile_id: String, state: State<'_, AppState>) -> ProjectContext {
    let Some(profile) = state.bundle.find(&profile_id) else {
        return ProjectContext::default();
    };

    let vars = placeholder_vars(state.provider.as_ref(), profile);
    let expand = |value: &Option<String>| {
        value
            .as_ref()
            .map(|text| expand_placeholders(text, &vars))
    };

    ProjectContext {
        label: profile.context.label.clone(),
        path: expand(&profile.context.path),
        repo: expand(&profile.context.repo),
        note: expand(&profile.context.note),
    }
}

#[tauri::command]
pub fn resolve_launch(profile_id: String, state: State<'_, AppState>) -> Vec<ResolvedLaunch> {
    match state.bundle.find(&profile_id) {
        Some(profile) => resolve_launch_for(state.provider.as_ref(), profile),
        None => Vec::new(),
    }
}

/// Spáruje pravidla profilu s tím, co opravdu běží.
///
/// Oddělené od příkazu schválně: tohle je místo, kde platí, že profil
/// nesmí přebít denylist provideru, a chce to přímý test.
fn candidates_for(profile: &Profile, running: &[ProcessInfo]) -> Vec<KillCandidate> {
    if profile.layer == LayerState::Off {
        return Vec::new();
    }

    let mut out: Vec<KillCandidate> = Vec::new();
    for rule in &profile.kill {
        for process in running {
            // Chráněné procesy se do nabídky nedostanou, ani když je profil
            // vyjmenuje.
            if process.protected {
                continue;
            }
            if !process.name.eq_ignore_ascii_case(&rule.match_name) {
                continue;
            }
            out.push(KillCandidate {
                rule: rule.clone(),
                process: process.clone(),
            });
        }
    }
    out
}

#[tauri::command]
pub fn kill_candidates(
    profile_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<KillCandidate>, String> {
    let Some(profile) = state.bundle.find(&profile_id) else {
        return Ok(Vec::new());
    };

    let running = state.provider.processes().map_err(|err| err.to_string())?;
    Ok(candidates_for(profile, &running))
}

/// Volá se výhradně po potvrzení uživatele v dialogu (invariant 2).
#[tauri::command]
pub fn terminate(pids: Vec<u32>, state: State<'_, AppState>) -> Vec<TerminateOutcome> {
    let info = state.provider.info();

    if !info.can_write {
        return pids
            .into_iter()
            .map(|pid| TerminateOutcome {
                pid,
                name: String::new(),
                ok: false,
                message: READ_ONLY.to_string(),
            })
            .collect();
    }

    // Jméno k PID se dohledá jen pro hlášku; když se seznam mezitím změnil,
    // není to důvod operaci odmítnout.
    let running = state.provider.processes().unwrap_or_default();

    pids.into_iter()
        .map(|pid| {
            let name = running
                .iter()
                .find(|process| process.pid == pid)
                .map(|process| process.name.clone())
                .unwrap_or_else(|| "neznámý".to_string());

            match state.provider.terminate(pid) {
                Ok(()) => TerminateOutcome {
                    pid,
                    name,
                    ok: true,
                    message: "Ukončeno v simulaci — reálný proces běží dál.".to_string(),
                },
                Err(err) => TerminateOutcome {
                    pid,
                    name,
                    ok: false,
                    message: err.to_string(),
                },
            }
        })
        .collect()
}

#[tauri::command]
pub fn launch_all(profile_id: String, state: State<'_, AppState>) -> Vec<LaunchOutcome> {
    let Some(profile) = state.bundle.find(&profile_id) else {
        return Vec::new();
    };

    if profile.layer == LayerState::Off {
        return vec![LaunchOutcome {
            id: profile.id.clone(),
            label: profile.name.clone(),
            ok: false,
            message: LAYER_OFF.to_string(),
        }];
    }

    let info = state.provider.info();
    let resolved = resolve_launch_for(state.provider.as_ref(), profile);

    resolved
        .into_iter()
        .map(|entry| {
            if !info.can_write {
                return LaunchOutcome {
                    id: entry.item.id,
                    label: entry.item.label,
                    ok: false,
                    message: READ_ONLY.to_string(),
                };
            }
            if !entry.available {
                return LaunchOutcome {
                    id: entry.item.id,
                    label: entry.item.label,
                    ok: false,
                    message: entry.detail,
                };
            }

            match state.provider.launch(
                entry.item.kind.as_str(),
                &entry.resolved_target,
                &entry.resolved_args,
            ) {
                Ok(()) => LaunchOutcome {
                    id: entry.item.id,
                    label: entry.item.label,
                    ok: true,
                    message: format!("Spuštěno v simulaci: {}", entry.resolved_target),
                },
                Err(err) => LaunchOutcome {
                    id: entry.item.id,
                    label: entry.item.label,
                    ok: false,
                    message: err.to_string(),
                },
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::profiles as profile_data;
    use crate::provider::mock::MockProvider;

    fn state() -> AppState {
        AppState {
            provider: Box::new(MockProvider::new()),
            bundle: profile_data::load_from_dir(
                &profile_data::find_profiles_dir().expect("složka profiles/"),
            ),
        }
    }

    #[test]
    fn vypnuta_vrstva_nic_nenabizi() {
        let state = state();
        let unlock = state.bundle.find("unlock").unwrap();

        assert!(resolve_launch_for(state.provider.as_ref(), unlock).is_empty());
        assert_eq!(unlock.layer, LayerState::Off);
    }

    #[test]
    fn placeholdery_se_rozbali_z_provideru() {
        let state = state();
        let dev = state.bundle.find("development").unwrap();
        let resolved = resolve_launch_for(state.provider.as_ref(), dev);

        let editor = resolved.iter().find(|r| r.item.id == "editor").unwrap();
        assert!(
            !editor.resolved_args[0].contains('{'),
            "placeholder se nerozbalil: {}",
            editor.resolved_args[0]
        );
        assert!(editor.available, "code má být v mocku dostupný");
    }

    #[test]
    fn profil_neprebije_denylist_provideru() {
        let state = state();
        let running = state.provider.processes().unwrap();
        assert!(
            running.iter().any(|p| p.name == "explorer.exe" && p.protected),
            "explorer.exe má v mocku běžet a být chráněný"
        );

        // Profil, který se výslovně pokouší nabídnout chráněný proces.
        let mut zlomyslny = state.bundle.find("development").unwrap().clone();
        zlomyslny.kill.push(KillRule {
            id: "explorer".to_string(),
            label: "Průzkumník".to_string(),
            match_name: "explorer.exe".to_string(),
            reason: "pokus obejít denylist".to_string(),
            severity: crate::profiles::Severity::Strong,
        });

        let candidates = candidates_for(&zlomyslny, &running);
        assert!(
            !candidates.iter().any(|c| c.process.name == "explorer.exe"),
            "chráněný proces se dostal do nabídky k ukončení"
        );
        // ostatní pravidla profilu fungují dál
        assert!(candidates.iter().any(|c| c.process.name == "steam.exe"));
    }

    #[test]
    fn vypnuta_vrstva_nenabizi_ani_ukonceni() {
        let state = state();
        let running = state.provider.processes().unwrap();
        let unlock = state.bundle.find("unlock").unwrap();

        assert!(candidates_for(unlock, &running).is_empty());
    }
}
