# Rozhodnutí

Zadání říkalo: kde chybí rozhodnutí, zvol rozumnou variantu a zapiš ji.
Tohle je ten seznam — co jsem zvolil a proč, včetně věcí, které jsem
neověřil.

---

## 1. Stav ověření

**Frontend je ověřený reálným během.** Dev server běžel, aplikace se načetla
bez chyby v konzoli, proklikal jsem přepínání režimů, potvrzovací dialog,
ukončení dvou procesů, Unlock i Config a ověřil vypočtené styly proti
zadaným tokenům (38 px / 600 / `.06em`, mřížka 46×46, 20 segmentů výšky 12 px
s mezerou 3 px, přechod 650 ms `cubic-bezier(.2,.8,.2,1)`, crossfade 180 ms).
Testy frontendu: 15 zelených.

**Rust ověřený není.** Na stroji, kde projekt vznikl, není nainstalovaný
Rust toolchain (`rustc` ani `cargo`). Backend je napsaný kompletně a prošel
statickou revizí — jednu chybu jsem tak našel a opravil (borrow-check
v `find_profiles_dir`: `Some(ref current)` půjčoval proměnnou, která se
v témž rameni přepisovala). Ale **první skutečná kompilace proběhne až v CI.**
Proto jsou `cargo fmt --check` a `clippy -D warnings` v workflow poradní
(`continue-on-error`) — nemám je čím lokálně srovnat a nechci lhát zeleným
buildem. Až první běh formátování ustálí, `continue-on-error` zmizí.
`cargo test` a `cargo build` blokující jsou.

---

## 2. Architektura

**Tauri v2, Vite, vanilla TypeScript.** Bez frameworku. Celé UI má pět
komponent, které stav jen dostávají a překreslují se; React by tu byl závaží
bez protihodnoty. Jediná runtime závislost frontendu je `@tauri-apps/api`,
a i ta se v prohlížeči nenačte — importuje se dynamicky až ve větvi pro Tauri.

**`OpSysApi` jako jediný most.** UI nevolá `invoke` ani mock napřímo. Dvě
implementace (`WebMockApi`, `TauriApi`) znamenají, že `npm run dev`
a `npm run tauri dev` pouštějí tentýž kód UI. To je celý smysl požadavku 6.

**`resolveContext` jako samostatný příkaz.** Původně hlavička zobrazovala
surový `context.path` z profilu, takže v UI svítilo `{PROJECTS}/Osobni`.
Rozbalovat placeholdery v UI by znamenalo mít tabulku cest na dvou místech;
místo toho je rozbalí provider a UI dostane hotový řetězec.

**Polling po 1500 ms místo událostí.** Přechod metrik trvá 650 ms, takže
1500 ms je pohodlně nad ním a nevzniká trhaná animace. Push z Rustu by byl
efektivnější, ale přidává stavovou synchronizaci, kterou první návrh
nepotřebuje.

---

## 3. Profily

**Formát:** TOML, jeden soubor = jeden režim, `extends` pro dědičnost.
Kompletní popis je v README.

**Slučování seznamů podle `id`.** Zvažoval jsem prosté zřetězení
rodič + dítě. Přepis podle `id` je lepší: Škola potřebuje u Spotify jinou
`severity` než Development, a se zřetězením by v seznamu byly dva Spotify.
Položka se stejným `id` se proto nahradí **na svém původním místě** — pořadí
zděděné z rodiče zůstane čitelné.

**`remove_launch` / `remove_kill`.** Bez nich nejde ze zděděného seznamu nic
odebrat. Škola nechce „Repozitář v prohlížeči" z Developmentu.

**Neznámý klíč je chyba.** Vzniklo z reálné chyby při psaní: v `skola.toml`
stálo `remove_launch` až za sekcemi `[[launch]]`. Podle TOML to patří do
poslední sekce, ne do kořene — profil vypadal správně a tiše nefungoval.
Test to odhalil. Teď obě strany (TS i Rust přes `deny_unknown_fields`)
neznámý klíč odmítnou a u klíče, který patří do kořene, přidají i návod.

**Chyba profilu neshodí aplikaci.** Problémy se sbírají do `problems`
a vracejí vedle úspěšně načtených profilů. Rozbitý soubor znamená jednu
chybějící dlaždici a řádek v Configu, ne černé okno. To je invariant 1
aplikovaný na vlastní data.

**Placeholdery místo cest.** V profilu nesmí být `C:\Users\...`. Tabulku
cest dodává provider — mock deterministické `C:/Users/mock/...`, Windows
čte `%USERPROFILE%`. Neznámý placeholder se **nerozbalí a zůstane vidět**;
UI takovou položku označí jako nepřipravenou. Tiché dosazení prázdného
řetězce by vyrobilo cestu, která někam ukazuje, a to je horší než chyba.
Kontroluje to test, který projde všechny profily a hledá písmeno disku.

**`layer = "off"` je vlastnost dat, ne speciální případ kódu.** Unlock není
`if (mode === 'unlock')`. Je to profil s vypnutou vrstvou a prázdnými
seznamy — a stejnou vlastnost používá i Config. Kdyby přibyl sedmý režim,
který má být pasivní, stačí soubor.

**`view = "config"`** přepíná spodní část obrazovky na přehled profilů.
Zase vlastnost profilu, ne natvrdo zadrátovaná obrazovka.

---

## 4. Bezpečnost a invarianty

**Denylist chráněných procesů ve vrstvě provideru.** `explorer.exe`,
`lsass.exe`, `csrss.exe`, `dwm.exe` a spol. Filtr sedí v provideru, ne
v profilu ani v UI: profil ho nemůže přebít, ať do `[[kill]]` napíše cokoli.
Kryje to přímý test — profil, který se výslovně pokusí nabídnout
`explorer.exe`, ho v nabídce nedostane.

**Potvrzení je nutná, ne postačující podmínka.** I po kliknutí v dialogu
provider chráněný proces odmítne a vrátí důvod.

**`can_write` místo pádu.** Windows provider má zápisové metody nedopsané
(`todo!()`, jak zadání chtělo) — a `todo!()` panikaří. Kdyby se na ně dalo
dosáhnout, aplikace by spadla. Proto provider hlásí `can_write = false`
a vrstva příkazů zápisové metody vůbec nevolá: vrátí uživateli větu, že
aktivní provider je jen pro čtení. `todo!()` tak zůstává značkou
nedokončené práce, ne minou.

**Windows provider se neaktivuje sám.** I na Windows je výchozí mock.
Skutečné čtení systému si musí vyžádat `OPSYS_PROVIDER=windows`. Fail-safe
znamená mimo jiné to, že se aplikace sama od sebe nezačne systému ptát
na víc, než musí.

**CSP bez sítě.** `default-src 'self'` a explicitní `connect-src 'self' ipc:`.
Požadavek „žádný síťový požadavek" tak nedrží jen slušné chování kódu, ale
i prohlížečový engine.

**Vypnutá vrstva se kontroluje v příkazech.** Ne v UI. Invariant 3 nesmí jít
obejít jiným klientem.

---

## 5. Mock

**Deterministický, ne náhodný.** Hodnota metriky je čistá funkce čísla ticku
(celočíselný hash + sinusová vlna). Stejný tick dá vždycky stejné číslo, takže
se metriky hýbou, ale běh je reprodukovatelný a testovatelný. `Math.random()`
by znemožnil test „hodnoty drží v mezích".

**Mock umí zápis (`can_write = true`), ale zápis je simulace.** Ukončení jen
přepne příznak v poli v paměti. Bez toho by se nedal vyvinout ani otestovat
potvrzovací tok, což je jedna z věcí, které měl první návrh dodat.

**Vytížení CPU se škáluje na 0,55.** Součet přes všechny procesy dával přes
70 %, což vypadalo jako trvale zahlcený stroj a ukazatel visel u výstražného
prahu. Po škálování sedí kolem 35–40 % a výstražný stav něco znamená.

**Systémové procesy jsou v tabulce schválně.** Je pak na čem ověřit, že se
do nabídky nedostanou.

**Dvě implementace mocku (TS a Rust) jsou vědomá duplicita.** Požadavek 6
chce funkční web bez Tauri, takže prohlížeč musí mít vlastní mock i vlastní
vyhodnocení dědičnosti. Obě strany drží stejná sada testů se stejnými
scénáři — když se rozejdou, spadne jedna z nich.

---

## 6. Vzhled

Tokeny ze zadání jsem vzal doslova a ověřil je na běžící stránce, ne od oka.
Kde zadání nechalo prostor:

**Segmentové ukazatele se staví jednou a pak se jen přepíná stav dílků.**
Kdyby se překreslovaly, CSS by neměl co animovat a přechod 650 ms by zmizel.

**Teplota má stupnici 30–95 °C**, ne 0–100. Nula stupňů u notebooku nic
neznamená; s posunutou nulou nese ukazatel informaci po celé délce.
Výstražný práh je 72 % stupnice, tedy ~77 °C.

**Dolní popisky u metrik nesou skutečná data** (obsazeno %, volno, meze
stupnice), ne dekoraci. Disciplína ze zadání — mono a mřížka jen tam, kde
jsou reálná data — platí i pro drobnosti.

**Předvybrané jsou v dialogu jen položky `severity = "strong"`.** Nulový
předvýběr by znamenal odklikat čtyři checkboxy pokaždé; předvybrat vše by
bylo v rozporu s invariantem 2. `strong` je prostředek, jak v profilu říct
„tohle skoro vždycky chceš" — a i tak jde odškrtnout.

**Přibyly tři severity, ne dvě.** `soft` (volitelné), `suggest` (návrh),
`strong` (důrazně). Dvě nestačily: Spotify v Developmentu a Discord ve Škole
jsou opravdu jiná kategorie.

**Klávesy 1–6** přepínají režim. Mission control se neovládá myší.

**Ikony generuje skript** (`scripts/make-icons.mjs`) ze stejné palety jako UI,
vlastním PNG a ICO enkodérem bez závislostí. Binární soubor v repozitáři, který
nikdo neumí přegenerovat, je dluh; navíc Tauri build ikonu potřebuje a bez ní
by projekt nešlo sestavit. Ověřeno tím, že prohlížeč vygenerované PNG opravdu
dekóduje.

---

## 7. Detaily, které stojí za zmínku

**Vlastní mini-TOML parser v TypeScriptu** (`src/lib/toml.ts`, ~330 řádků)
místo npm závislosti. Formát profilů používá malou podmnožinu TOML a parser
padá s číslem řádku, což je při psaní profilů to hlavní. Datumy a časy
záměrně neumí — vrací je jako řetězec.

**`sysinfo` je závislost jen pro `cfg(windows)`.** Mock ji nepotřebuje, takže
se na jiných platformách vůbec nestahuje. Verze je připnutá na `0.32`,
protože se API mezi minor verzemi mění (`Process::name()` vrací `&OsStr`
až od 0.31, `Component::temperature()` vrací `Option` až od 0.33).

**Složka profilů se hledá, ne zadrátovává.** Pořadí: `OPSYS_PROFILES_DIR`,
pracovní adresář a jeho rodič (při `tauri dev` je cwd `src-tauri/`), pak okolí
spustitelného souboru. Když se nenajde nic, aplikace naběhne prázdná
s vysvětlením — ne rozbitá.

**`bundle.active = false`.** Zadání instalátor nechtělo. `cargo build` udělá
spustitelný soubor a nic dalšího.

**`panic = "abort"` jsem z release profilu vyhodil.** Ušetřilo by pár kilobajtů
a přineslo riziko u kódu, který nemám čím ověřit. `opt-level = "s"`, LTO
a `strip` zůstaly.

---

## 8. Co dělat dřív než cokoli dalšího

1. Nechat proběhnout CI. Je to první kompilace Rustu — počítej s tím, že
   něco padne, a oprav to podle výpisu.
2. Až bude fmt a clippy čisté, zahodit `continue-on-error` z workflow.
3. Teprve pak editor profilů v Configu, nebo zápisové operace ve Windows
   provideru — v tomhle pořadí. Zápis je nevratný a chce vlastní kolo
   testů, editor ne.
