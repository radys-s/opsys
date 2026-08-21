# OP sys

Ovládací centrum pracovních režimů pro Windows 11.

Není to operační systém a není to debloat nástroj. Je to vrstva nad čistými
Windows: přepne pracovní režim, obnoví projektový kontext a **navrhne** seznam
procesů, které do režimu nepatří. Rozhodnutí zůstává na tobě — aplikace nikdy
nic neukončí sama.

Šest režimů — Development, Škola, AI / Lab, Hry, Unlock, Config — je současný
**obsah**, ne architektura. Režimy jsou data v `profiles/*.toml`, ne kód.
Škola není samostatná konfigurace: je to vrstva nad Developmentem
(`extends = "development"`).

---

## Spuštění

Hlavní vývojová smyčka — frontend v prohlížeči proti mock datům, bez Tauri
a bez Windows:

```bash
npm install && npm run dev
```

Otevře se na `http://127.0.0.1:1420`. Všechno je ovladatelné: přepínání
režimů, metriky, potvrzovací dialog i Config obrazovka.

Desktopová aplikace (potřebuje Rust toolchain):

```bash
npm run tauri dev
```

Další příkazy:

| Příkaz | Co dělá |
| --- | --- |
| `npm run test` | testy frontendu (parser TOML, dědičnost profilů) |
| `npm run build` | kontrola typů + produkční build frontendu |
| `npm run typecheck` | jen kontrola typů |
| `cargo test --manifest-path src-tauri/Cargo.toml` | testy Rustu |
| `node scripts/make-icons.mjs` | přegeneruje ikony z palety |

> `cargo` cokoli chce, aby předtím proběhlo `npm run build` — `tauri-build`
> při kompilaci kontroluje, že existuje složka `dist/`.

---

## Co je kde

```
profiles/          režimy jako data (TOML)
src/               frontend (TypeScript, bez frameworku)
  lib/             typy, TOML parser, dědičnost profilů, most na backend
  mock/            web-only mock systému
  ui/              komponenty (hlavička, metriky, dlaždice, panely, dialog)
  style.css        vizuální tokeny a celý vzhled
src-tauri/         backend (Rust)
  src/provider/    SystemProvider: trait, MockProvider, WindowsProvider
  src/profiles.rs  načtení a slučování profilů
  src/commands.rs  příkazy pro frontend + vynucení invariantů
tests/             testy frontendu
scripts/           generátor ikon
```

Frontend nesahá na systém přímo. Mluví jedině přes `OpSysApi`
([src/lib/api.ts](src/lib/api.ts)), který má dvě implementace: `WebMockApi`
v prohlížeči a `TauriApi` v desktopové aplikaci. Díky tomu je UI v obou
případech tentýž kód.

---

## Jak přidat profil

Vytvoř `profiles/muj-rezim.toml`. Klíč `id` je nepovinný — když chybí, odvodí
se z názvu souboru. Pořadí dlaždic určuje `order`.

```toml
schema  = 1
id      = "muj-rezim"
name    = "Můj režim"
order   = 35
tagline = "Krátký popisek pod název"
summary = "Věta nebo dvě do hlavičky obrazovky."
layer   = "on"          # "off" = vrstva vypnutá, režim nic nedělá

[context]
label = "Aktivní projekt"
path  = "{PROJECTS}/neco"
repo  = "github.com/tomas/neco"
note  = "Co je rozdělané."

[[launch]]
id       = "editor"
label    = "Visual Studio Code"
kind     = "app"          # app | url | folder | shell
target   = "code"
args     = ["{CONTEXT_PATH}"]
note     = "otevře kořen projektu"
optional = false

[[kill]]
id       = "steam"
label    = "Steam"
match    = "steam.exe"    # jméno procesu, nerozlišují se velká písmena
reason   = "Proč do tohohle režimu nepatří."
severity = "suggest"      # soft | suggest | strong
```

### Jedno pravidlo, na kterém se dá ošklivě uklouznout

**Klíče kořene profilu musí stát před první sekcí `[..]` nebo `[[..]]`.**
Tak funguje TOML: co napíšeš za sekcí, patří do ní.

```toml
# ŠPATNĚ — remove_launch spadne dovnitř poslední [[launch]]
[[launch]]
id = "x"
label = "X"
target = "x"
remove_launch = ["repo"]

# SPRÁVNĚ
remove_launch = ["repo"]

[[launch]]
id = "x"
label = "X"
target = "x"
```

Načítání to dnes odchytí a nahlásí jako chybu s návodem, ale je jednodušší
psát skaláry rovnou nahoru.

### Dědičnost

```toml
extends = "development"
```

Pravidla slučování:

| Co | Jak se slučuje |
| --- | --- |
| `name`, `order`, `tagline`, `summary`, `layer`, `view` | dítě přepisuje |
| `[context]` | po klíčích — dítě přepíše jen to, co uvede |
| `[[launch]]`, `[[kill]]` | položka se stejným `id` se nahradí **na svém místě**, nová se připojí na konec |
| `remove_launch`, `remove_kill` | odeberou zděděnou položku podle `id` |

Cykly, chybějící rodič i příliš hluboký řetěz se hlásí jako problém profilu.
Aplikace naběhne dál, jen ten jeden profil chybí — seznam problémů je
v režimu Config.

### Placeholdery

V profilech nesmí být absolutní cesty. Cesty dodává až provider za běhu:

| Placeholder | Mock | Windows |
| --- | --- | --- |
| `{HOME}` | `C:/Users/mock` | `%USERPROFILE%` |
| `{PROJECTS}` | `C:/Users/mock/Projekty` | `%USERPROFILE%/Projekty` |
| `{DESKTOP}` | `C:/Users/mock/Desktop` | `%USERPROFILE%/Desktop` |
| `{DOWNLOADS}` | `C:/Users/mock/Downloads` | `%USERPROFILE%/Downloads` |
| `{CONTEXT_PATH}` | rozbalené `context.path` téhož profilu | |
| `{CONTEXT_REPO}` | `context.repo` téhož profilu | |

Neznámý placeholder se nerozbalí a zůstane vidět — UI takovou položku
označí jako nepřipravenou, místo aby si cestu domyslelo.

---

## Invarianty

Nejsou to zbožná přání, drží je kód:

1. **Fail-safe.** Aplikace nikam nezapisuje, nic nemění trvale. Když spadne
   nebo ji smažeš, Windows jsou přesně tam, kde byly.
2. **Nic bez potvrzení.** Ukončení procesů vede jedině přes dialog. Předvybrané
   jsou jen položky se `severity = "strong"` a i ty jde odškrtnout.
3. **Unlock = vrstva vypnutá.** Nespouští, neukončuje, neblokuje. Vynucuje se
   ve vrstvě příkazů, ne v UI — jiný klient to neobejde.
4. **Žádné blokování** aplikací ani webů. Focus lock je mimo rozsah.
5. **Žádné zásahy** do registru, služeb, updatů, ovladačů ani antiviru.
6. **V této verzi se nic reálně neukončuje.** Výchozí provider je mock;
   Windows provider umí jen číst a hlásí `can_write = false`.

Navíc: seznam chráněných systémových procesů (`explorer.exe`, `lsass.exe`,
`csrss.exe`, …) sedí ve vrstvě provideru. Profil ho nemůže přebít, ať do
`[[kill]]` napíše cokoli.

---

## Windows telemetrie

Čtení skutečných dat je vypnuté a musí se vyžádat:

```bash
$env:OPSYS_PROVIDER = "windows"; npm run tauri dev
```

Provider pak čte seznam procesů, RAM, CPU a teplotu (přes `sysinfo`).
Zápisové operace v této verzi neexistují. Teplota je `Option` — hodně
notebooků ji bez ovladače výrobce nevydá a v takovém případě UI napíše
„není k dispozici" místo vymyšleného čísla.

---

## Co první návrh nemá

Přihlášení, telemetrii ven, automatické aktualizace, instalátor, ikonu v tray,
spouštění po startu Windows, jakýkoli síťový požadavek, jakoukoli AI integraci.
Config je zatím jen čtecí obrazovka — editor profilů přijde později.

Rozhodnutí a jejich důvody jsou v [DECISIONS.md](DECISIONS.md).
