//! OP sys — ovládací centrum pracovních režimů pro Windows 11.
//!
//! Není to operační systém ani debloat nástroj. Je to vrstva nad čistými
//! Windows: přepíná pracovní režimy, obnoví projektový kontext a **navrhne**
//! seznam procesů, které do režimu nepatří.
//!
//! Tvrdé invarianty, které drží kód (ne jen dokumentace):
//!
//! 1. **Fail-safe.** Bez běžící aplikace zůstanou Windows plně použitelné.
//!    Nic se nikam nezapisuje, žádná změna není trvalá.
//! 2. **Nic bez potvrzení.** Ukončení procesů projde jedině přes dialog
//!    v UI — viz [`commands::terminate`].
//! 3. **Unlock = vrstva vypnutá.** Vynucuje se ve vrstvě příkazů, ne v UI.
//! 4. Žádné blokování aplikací ani webů.
//! 5. Žádné zásahy do registru, služeb, updatů, ovladačů ani antiviru.
//! 6. V této verzi se nic reálně neukončuje — výchozí je
//!    [`provider::mock::MockProvider`] a Windows provider umí jen číst.

pub mod commands;
pub mod profiles;
pub mod provider;

use commands::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let state = AppState {
        provider: provider::create_provider(),
        bundle: profiles::load(),
    };

    tauri::Builder::default()
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            commands::profiles,
            commands::snapshot,
            commands::resolve_context,
            commands::resolve_launch,
            commands::kill_candidates,
            commands::terminate,
            commands::launch_all,
        ])
        .run(tauri::generate_context!())
        .expect("OP sys se nepodařilo spustit");
}
