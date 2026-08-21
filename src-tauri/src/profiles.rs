//! Načtení a sloučení profilů režimů.
//!
//! Režimy nejsou kód — jsou to data v `profiles/*.toml`. Šest režimů je
//! současný obsah, ne architektura: přidání sedmého znamená přidat soubor.
//!
//! Pravidla slučování (`extends = "rodic"`) — shodná s `src/lib/profiles.ts`:
//!   - skaláry (name, order, tagline, summary, layer, view) — dítě přepisuje
//!   - `[context]` — slučuje se po klíčích, dítě přepisuje jen to, co uvede
//!   - `[[launch]]` / `[[kill]]` — dítě položku se stejným `id` nahradí na
//!     jejím původním místě, novou připojí na konec
//!   - `remove_launch` / `remove_kill` — odeberou zděděnou položku podle `id`
//!
//! Chyba v jednom souboru nesmí shodit aplikaci (invariant 1: fail-safe).
//! Problémy se sbírají do [`ProfileBundle::problems`] a vrací vedle dat.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

const MAX_INHERITANCE_DEPTH: usize = 8;

// ---- výčty -----------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Soft,
    #[default]
    Suggest,
    Strong,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LaunchKind {
    #[default]
    App,
    Url,
    Folder,
    Shell,
}

impl LaunchKind {
    pub fn as_str(self) -> &'static str {
        match self {
            LaunchKind::App => "app",
            LaunchKind::Url => "url",
            LaunchKind::Folder => "folder",
            LaunchKind::Shell => "shell",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LayerState {
    #[default]
    On,
    Off,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProfileView {
    #[default]
    Modes,
    Config,
}

// ---- položky ---------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LaunchItem {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub kind: LaunchKind,
    pub target: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(default)]
    pub optional: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct KillRule {
    pub id: String,
    pub label: String,
    /// Jméno procesu. `match` je v Rustu klíčové slovo, v TOML i v JSON
    /// zůstává `match`.
    #[serde(rename = "match")]
    pub match_name: String,
    #[serde(default)]
    pub reason: String,
    #[serde(default)]
    pub severity: Severity,
}

trait HasId {
    fn id(&self) -> &str;
}

impl HasId for LaunchItem {
    fn id(&self) -> &str {
        &self.id
    }
}

impl HasId for KillRule {
    fn id(&self) -> &str {
        &self.id
    }
}

// ---- kontext ---------------------------------------------------------------

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RawContext {
    pub label: Option<String>,
    pub path: Option<String>,
    pub repo: Option<String>,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectContext {
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repo: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

impl Default for ProjectContext {
    fn default() -> Self {
        Self {
            label: "Kontext".to_string(),
            path: None,
            repo: None,
            note: None,
        }
    }
}

// ---- profily ---------------------------------------------------------------

/// Profil tak, jak stojí v souboru — před sloučením s rodičem.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RawProfile {
    pub schema: Option<u32>,
    pub id: Option<String>,
    pub extends: Option<String>,
    pub name: Option<String>,
    pub order: Option<i64>,
    pub tagline: Option<String>,
    pub summary: Option<String>,
    pub layer: Option<LayerState>,
    pub view: Option<ProfileView>,
    pub context: Option<RawContext>,
    #[serde(default)]
    pub launch: Vec<LaunchItem>,
    #[serde(default)]
    pub kill: Vec<KillRule>,
    #[serde(default)]
    pub remove_launch: Vec<String>,
    #[serde(default)]
    pub remove_kill: Vec<String>,
}

/// Profil po vyhodnocení dědičnosti.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub schema: u32,
    pub id: String,
    pub name: String,
    pub order: i64,
    pub tagline: String,
    pub summary: String,
    pub layer: LayerState,
    pub view: ProfileView,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extends: Option<String>,
    pub context: ProjectContext,
    pub launch: Vec<LaunchItem>,
    pub kill: Vec<KillRule>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileProblem {
    pub file: String,
    pub message: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileBundle {
    pub profiles: Vec<Profile>,
    pub problems: Vec<ProfileProblem>,
}

impl ProfileBundle {
    pub fn find(&self, id: &str) -> Option<&Profile> {
        self.profiles.iter().find(|profile| profile.id == id)
    }
}

// ---- parsování -------------------------------------------------------------

pub fn id_from_file_name(file: &str) -> String {
    let base = file.rsplit(['/', '\\']).next().unwrap_or(file);
    base.strip_suffix(".toml")
        .or_else(|| base.strip_suffix(".TOML"))
        .unwrap_or(base)
        .to_string()
}

pub fn parse_profile(source: &str, file: &str) -> Result<RawProfile, String> {
    let mut raw: RawProfile = toml::from_str(source).map_err(|err| err.to_string())?;
    if raw.id.is_none() {
        raw.id = Some(id_from_file_name(file));
    }
    Ok(raw)
}

// ---- dědičnost -------------------------------------------------------------

fn empty_profile(id: &str) -> Profile {
    Profile {
        schema: 1,
        id: id.to_string(),
        name: id.to_string(),
        order: 1000,
        tagline: String::new(),
        summary: String::new(),
        layer: LayerState::default(),
        view: ProfileView::default(),
        extends: None,
        context: ProjectContext::default(),
        launch: Vec::new(),
        kill: Vec::new(),
    }
}

/// Dítě nahradí položku se stejným id na jejím místě, jinak ji připojí na konec.
fn merge_by_id<T: HasId + Clone>(parent: &[T], child: &[T], remove: &[String]) -> Vec<T> {
    let mut out: Vec<T> = parent
        .iter()
        .filter(|item| !remove.iter().any(|id| id == item.id()))
        .cloned()
        .collect();

    for item in child {
        match out.iter().position(|existing| existing.id() == item.id()) {
            Some(at) => out[at] = item.clone(),
            None => out.push(item.clone()),
        }
    }
    out
}

fn apply_raw(base: &Profile, raw: &RawProfile) -> Profile {
    let mut context = base.context.clone();
    if let Some(raw_context) = &raw.context {
        if let Some(label) = &raw_context.label {
            context.label = label.clone();
        }
        if raw_context.path.is_some() {
            context.path = raw_context.path.clone();
        }
        if raw_context.repo.is_some() {
            context.repo = raw_context.repo.clone();
        }
        if raw_context.note.is_some() {
            context.note = raw_context.note.clone();
        }
    }

    Profile {
        schema: raw.schema.unwrap_or(base.schema),
        id: raw.id.clone().unwrap_or_else(|| base.id.clone()),
        name: raw.name.clone().unwrap_or_else(|| base.name.clone()),
        order: raw.order.unwrap_or(base.order),
        tagline: raw.tagline.clone().unwrap_or_else(|| base.tagline.clone()),
        summary: raw.summary.clone().unwrap_or_else(|| base.summary.clone()),
        layer: raw.layer.unwrap_or(base.layer),
        view: raw.view.unwrap_or(base.view),
        extends: raw.extends.clone(),
        context,
        launch: merge_by_id(&base.launch, &raw.launch, &raw.remove_launch),
        kill: merge_by_id(&base.kill, &raw.kill, &raw.remove_kill),
    }
}

fn resolve_one(
    raw: &RawProfile,
    by_id: &BTreeMap<String, RawProfile>,
    seen: &mut Vec<String>,
) -> Result<Profile, String> {
    let id = raw.id.clone().unwrap_or_default();

    if seen.iter().any(|existing| *existing == id) {
        seen.push(id);
        return Err(format!("cyklická dědičnost: {}", seen.join(" -> ")));
    }
    if seen.len() >= MAX_INHERITANCE_DEPTH {
        return Err(format!(
            "dědičnost je hlubší než {MAX_INHERITANCE_DEPTH} úrovní"
        ));
    }

    let base = match &raw.extends {
        None => empty_profile(&id),
        Some(parent_id) => {
            let parent = by_id.get(parent_id).ok_or_else(|| {
                format!("extends = \"{parent_id}\" — takový profil neexistuje")
            })?;
            seen.push(id);
            let resolved = resolve_one(parent, by_id, seen)?;
            seen.pop();
            resolved
        }
    };

    Ok(apply_raw(&base, raw))
}

pub fn resolve_profiles(raws: Vec<(String, RawProfile)>) -> ProfileBundle {
    let mut problems: Vec<ProfileProblem> = Vec::new();
    let mut by_id: BTreeMap<String, RawProfile> = BTreeMap::new();
    let mut files: BTreeMap<String, String> = BTreeMap::new();

    for (file, raw) in raws {
        let id = raw.id.clone().unwrap_or_else(|| id_from_file_name(&file));
        if by_id.contains_key(&id) {
            problems.push(ProfileProblem {
                file,
                message: format!("duplicitní id \"{id}\", soubor se přeskakuje"),
            });
            continue;
        }
        files.insert(id.clone(), file);
        by_id.insert(id, raw);
    }

    let mut profiles: Vec<Profile> = Vec::new();
    for (id, raw) in &by_id {
        let mut seen: Vec<String> = Vec::new();
        match resolve_one(raw, &by_id, &mut seen) {
            Ok(profile) => profiles.push(profile),
            Err(message) => problems.push(ProfileProblem {
                file: files.get(id).cloned().unwrap_or_else(|| id.clone()),
                message,
            }),
        }
    }

    profiles.sort_by(|a, b| a.order.cmp(&b.order).then_with(|| a.id.cmp(&b.id)));
    ProfileBundle { profiles, problems }
}

pub fn load_from_sources(sources: Vec<(String, String)>) -> ProfileBundle {
    let mut raws: Vec<(String, RawProfile)> = Vec::new();
    let mut problems: Vec<ProfileProblem> = Vec::new();

    for (file, source) in sources {
        match parse_profile(&source, &file) {
            Ok(raw) => raws.push((file, raw)),
            Err(message) => problems.push(ProfileProblem { file, message }),
        }
    }

    let mut bundle = resolve_profiles(raws);
    problems.append(&mut bundle.problems);
    bundle.problems = problems;
    bundle
}

// ---- hledání složky profilů ------------------------------------------------

/// Najde složku `profiles/`.
///
/// Pořadí: proměnná `OPSYS_PROFILES_DIR`, pak pracovní adresář a jeho rodič
/// (při `tauri dev` je cwd `src-tauri/`), pak okolí spustitelného souboru.
/// Když se nenajde nic, vrátí `None` — aplikace pak naběhne prázdná, ne rozbitá.
pub fn find_profiles_dir() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Some(from_env) = std::env::var_os("OPSYS_PROFILES_DIR") {
        candidates.push(PathBuf::from(from_env));
    }

    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("profiles"));
        if let Some(parent) = cwd.parent() {
            candidates.push(parent.join("profiles"));
        }
    }

    if let Ok(exe) = std::env::current_exe() {
        // Z target/debug/opsys.exe je to ke kořeni projektu několik úrovní.
        let mut dir: Option<PathBuf> = exe.parent().map(Path::to_path_buf);
        for _ in 0..5 {
            let Some(current) = dir else { break };
            candidates.push(current.join("profiles"));
            dir = current.parent().map(Path::to_path_buf);
        }
    }

    candidates.into_iter().find(|path| path.is_dir())
}

pub fn load_from_dir(dir: &Path) -> ProfileBundle {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(err) => {
            return ProfileBundle {
                profiles: Vec::new(),
                problems: vec![ProfileProblem {
                    file: dir.display().to_string(),
                    message: format!("složku profilů nelze číst: {err}"),
                }],
            }
        }
    };

    let mut sources: Vec<(String, String)> = Vec::new();
    let mut problems: Vec<ProfileProblem> = Vec::new();

    for entry in entries.flatten() {
        let path = entry.path();
        let is_toml = path
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.eq_ignore_ascii_case("toml"))
            .unwrap_or(false);
        if !is_toml {
            continue;
        }

        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| path.display().to_string());

        match fs::read_to_string(&path) {
            Ok(source) => sources.push((name, source)),
            Err(err) => problems.push(ProfileProblem {
                file: name,
                message: format!("soubor nelze přečíst: {err}"),
            }),
        }
    }

    sources.sort_by(|a, b| a.0.cmp(&b.0));

    let mut bundle = load_from_sources(sources);
    problems.append(&mut bundle.problems);
    bundle.problems = problems;
    bundle
}

/// Načte profily tam, kde jsou. Když nikde nejsou, vrátí prázdný balík
/// s vysvětlením — aplikace naběhne a řekne proč je prázdná.
pub fn load() -> ProfileBundle {
    match find_profiles_dir() {
        Some(dir) => load_from_dir(&dir),
        None => ProfileBundle {
            profiles: Vec::new(),
            problems: vec![ProfileProblem {
                file: "profiles/".to_string(),
                message: "složka profiles/ nebyla nalezena — nastav OPSYS_PROFILES_DIR"
                    .to_string(),
            }],
        },
    }
}

// ---- placeholdery ----------------------------------------------------------

/// Rozbalí `{PLACEHOLDER}` podle tabulky. Neznámý placeholder zůstane vidět,
/// aby bylo v UI poznat, že se cesta nevyřešila.
pub fn expand_placeholders(input: &str, vars: &BTreeMap<String, String>) -> String {
    let mut out = String::with_capacity(input.len());
    let mut rest = input;

    while let Some(start) = rest.find('{') {
        let after = &rest[start + 1..];
        let end = match after.find('}') {
            Some(end) => end,
            None => break,
        };

        let key = &after[..end];
        let is_key = !key.is_empty()
            && key
                .chars()
                .all(|c| c.is_ascii_uppercase() || c == '_');

        out.push_str(&rest[..start]);
        match vars.get(key) {
            Some(value) if is_key => out.push_str(value),
            _ => {
                out.push('{');
                out.push_str(key);
                out.push('}');
            }
        }
        rest = &after[end + 1..];
    }

    out.push_str(rest);
    out
}

pub fn has_unresolved_placeholder(input: &str) -> bool {
    let mut rest = input;
    while let Some(start) = rest.find('{') {
        let after = &rest[start + 1..];
        match after.find('}') {
            Some(end) => {
                let key = &after[..end];
                if !key.is_empty()
                    && key.chars().all(|c| c.is_ascii_uppercase() || c == '_')
                {
                    return true;
                }
                rest = &after[end + 1..];
            }
            None => return false,
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    const PARENT: &str = r#"
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
    "#;

    fn bundle_from(pairs: &[(&str, &str)]) -> ProfileBundle {
        load_from_sources(
            pairs
                .iter()
                .map(|(file, source)| ((*file).to_string(), (*source).to_string()))
                .collect(),
        )
    }

    #[test]
    fn dite_dedi_vse_co_neprepise() {
        let child = r#"
            extends = "development"
            id = "skola"
            name = "Škola"
            order = 20
            [context]
            path = "{PROJECTS}/Skola"
        "#;

        let bundle = bundle_from(&[("development.toml", PARENT), ("skola.toml", child)]);
        assert!(bundle.problems.is_empty(), "{:?}", bundle.problems);

        let skola = bundle.find("skola").unwrap();
        assert_eq!(skola.name, "Škola");
        assert_eq!(skola.layer, LayerState::On);
        assert_eq!(skola.context.path.as_deref(), Some("{PROJECTS}/Skola"));
        assert_eq!(skola.context.note.as_deref(), Some("poznamka rodice"));
        assert_eq!(
            skola.launch.iter().map(|l| l.id.as_str()).collect::<Vec<_>>(),
            vec!["editor", "repo"]
        );
    }

    #[test]
    fn remove_launch_odebere_a_nova_polozka_jde_na_konec() {
        let child = r#"
            extends = "development"
            id = "skola"
            remove_launch = ["repo"]
            [[launch]]
            id = "rozvrh"
            label = "Rozvrh"
            kind = "url"
            target = "https://rozvrh.test"
        "#;

        let bundle = bundle_from(&[("development.toml", PARENT), ("skola.toml", child)]);
        let skola = bundle.find("skola").unwrap();
        assert_eq!(
            skola.launch.iter().map(|l| l.id.as_str()).collect::<Vec<_>>(),
            vec!["editor", "rozvrh"]
        );
    }

    #[test]
    fn prepis_podle_id_zachova_pozici() {
        let child = r#"
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
        "#;

        let bundle = bundle_from(&[("development.toml", PARENT), ("skola.toml", child)]);
        let skola = bundle.find("skola").unwrap();
        assert_eq!(
            skola.kill.iter().map(|k| k.id.as_str()).collect::<Vec<_>>(),
            vec!["steam", "discord"]
        );
        assert_eq!(skola.kill[0].severity, Severity::Strong);
        // rodič zůstal nedotčený
        assert_eq!(bundle.find("development").unwrap().kill[0].severity, Severity::Soft);
    }

    #[test]
    fn cyklus_a_chybejici_rodic_se_hlasi_jako_problem() {
        let cycle = bundle_from(&[
            ("a.toml", "id = \"a\"\nextends = \"b\"\n"),
            ("b.toml", "id = \"b\"\nextends = \"a\"\n"),
        ]);
        assert_eq!(cycle.profiles.len(), 0);
        assert_eq!(cycle.problems.len(), 2);
        assert!(cycle.problems[0].message.contains("cyklick"));

        let orphan = bundle_from(&[("x.toml", "id = \"x\"\nextends = \"neni\"\n")]);
        assert!(orphan.profiles.is_empty());
        assert!(orphan.problems[0].message.contains("neexistuje"));
    }

    #[test]
    fn neznamy_klic_je_chyba_a_nezabije_ostatni() {
        let bundle = bundle_from(&[
            ("ok.toml", "id = \"ok\"\nname = \"OK\"\n"),
            ("rozbity.toml", "id = \"rozbity\"\nneznamy_klic = 1\n"),
        ]);
        assert_eq!(bundle.profiles.len(), 1);
        assert_eq!(bundle.profiles[0].id, "ok");
        assert_eq!(bundle.problems.len(), 1);
        assert_eq!(bundle.problems[0].file, "rozbity.toml");
    }

    #[test]
    fn placeholdery() {
        let mut vars = BTreeMap::new();
        vars.insert("PROJECTS".to_string(), "D:/Proj".to_string());

        assert_eq!(
            expand_placeholders("{PROJECTS}/Osobni/{NEZNAMY}", &vars),
            "D:/Proj/Osobni/{NEZNAMY}"
        );
        assert!(has_unresolved_placeholder("{NEZNAMY}/x"));
        assert!(!has_unresolved_placeholder("D:/Proj/x"));
        assert!(!has_unresolved_placeholder("bez zavorek"));
    }

    #[test]
    fn skutecna_slozka_profiles_se_nacte_cela() {
        let dir = find_profiles_dir().expect("složka profiles/ musí být k nalezení");
        let bundle = load_from_dir(&dir);

        assert!(bundle.problems.is_empty(), "{:?}", bundle.problems);
        assert_eq!(
            bundle.profiles.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(),
            vec!["development", "skola", "ai-lab", "hry", "unlock", "config"]
        );

        // Škola je vrstva nad Developmentem
        let skola = bundle.find("skola").unwrap();
        assert_eq!(skola.extends.as_deref(), Some("development"));
        let ids: Vec<&str> = skola.launch.iter().map(|l| l.id.as_str()).collect();
        assert!(ids.contains(&"editor") && ids.contains(&"terminal"));
        assert!(!ids.contains(&"repo"));
        assert!(ids.contains(&"rozvrh"));

        // Unlock je opravdu vypnutá vrstva
        let unlock = bundle.find("unlock").unwrap();
        assert_eq!(unlock.layer, LayerState::Off);
        assert!(unlock.launch.is_empty() && unlock.kill.is_empty());
    }

    #[test]
    fn zadny_profil_neobsahuje_absolutni_cestu() {
        let dir = find_profiles_dir().expect("složka profiles/");
        let bundle = load_from_dir(&dir);

        for profile in &bundle.profiles {
            let mut paths: Vec<&str> = Vec::new();
            if let Some(path) = &profile.context.path {
                paths.push(path);
            }
            for item in &profile.launch {
                paths.push(&item.target);
                for arg in &item.args {
                    paths.push(arg);
                }
            }

            for path in paths {
                // Pozor: `https://` obsahuje `:/` — hledá se písmeno disku
                // na začátku řetězce, ne dvojtečka kdekoli.
                let bytes = path.as_bytes();
                let drive_letter = bytes.len() > 2
                    && bytes[0].is_ascii_alphabetic()
                    && bytes[1] == b':'
                    && (bytes[2] == b'/' || bytes[2] == b'\\');

                assert!(
                    !drive_letter,
                    "{}: absolutní cesta v profilu: {path}",
                    profile.id
                );
                assert!(
                    !path.contains("Users/") && !path.contains("Users\\"),
                    "{}: cesta k uživateli v profilu: {path}",
                    profile.id
                );
            }
        }
    }
}
