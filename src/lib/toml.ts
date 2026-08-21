/**
 * Minimalistický TOML parser pro web-only režim.
 *
 * Proč vlastní: profily se musí načíst v prohlížeči bez Tauri (požadavek 6)
 * a plná TOML knihovna je na podmnožinu, kterou formát profilů používá,
 * zbytečná závislost. Podporováno je přesně tolik, kolik profily potřebují:
 *
 *   - komentáře #
 *   - tabulky [a], [a.b] a pole tabulek [[a]]
 *   - klíče holé i v uvozovkách, tečkové klíče a.b = 1
 *   - řetězce basic i literální, jednořádkové i trojité
 *   - celá čísla a floaty (včetně podtržítek), true/false
 *   - pole (i víceřádková, s koncovou čárkou) a inline tabulky
 *
 * Nepodporováno záměrně: datumy/časy (vrací se jako řetězec), oktalové
 * a binární literály, inf/nan. Parser raději spadne s číslem řádku,
 * než by tiše vrátil nesmysl.
 */

export type TomlValue = string | number | boolean | TomlValue[] | TomlTable;

export interface TomlTable {
  [key: string]: TomlValue;
}

export class TomlError extends Error {
  constructor(message: string, public readonly line: number) {
    super(`řádek ${line}: ${message}`);
    this.name = 'TomlError';
  }
}

const BARE_KEY = /[A-Za-z0-9_-]/;

export function parseToml(source: string): TomlTable {
  return new Parser(source).parse();
}

class Parser {
  private pos = 0;
  private readonly src: string;
  private readonly root: TomlTable = {};
  private current: TomlTable = this.root;

  constructor(source: string) {
    // BOM zahodit, CRLF sjednotit — soubory chodí z Windows editorů.
    this.src = source.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  }

  parse(): TomlTable {
    for (;;) {
      this.skipIgnorable();
      if (this.eof()) break;

      if (this.peek() === '[') {
        this.parseTableHeader();
        continue;
      }
      this.parseKeyValue();
    }
    return this.root;
  }

  // ---- kurzor -------------------------------------------------------------

  private eof(): boolean {
    return this.pos >= this.src.length;
  }

  private peek(offset = 0): string {
    return this.src[this.pos + offset] ?? '';
  }

  private line(): number {
    let n = 1;
    const limit = Math.min(this.pos, this.src.length);
    for (let i = 0; i < limit; i++) {
      if (this.src[i] === '\n') n++;
    }
    return n;
  }

  private fail(message: string): never {
    throw new TomlError(message, this.line());
  }

  private expect(char: string): void {
    if (this.peek() !== char) {
      this.fail(`očekáváno ${char}, nalezeno ${this.peek() || 'konec souboru'}`);
    }
    this.pos++;
  }

  /** Mezery, konce řádků i komentáře. */
  private skipIgnorable(): void {
    for (;;) {
      const c = this.peek();
      if (c === ' ' || c === '\t' || c === '\n') {
        this.pos++;
      } else if (c === '#') {
        while (!this.eof() && this.peek() !== '\n') this.pos++;
      } else {
        return;
      }
    }
  }

  /** Jen mezery a tabulátory — konec řádku má význam. */
  private skipInlineSpace(): void {
    while (this.peek() === ' ' || this.peek() === '\t') this.pos++;
  }

  /** Za hodnotou smí na řádku zůstat už jen mezera nebo komentář. */
  private finishLine(): void {
    this.skipInlineSpace();
    if (this.peek() === '#') {
      while (!this.eof() && this.peek() !== '\n') this.pos++;
    }
    if (this.eof()) return;
    if (this.peek() !== '\n') this.fail(`nečekaný text ${this.peek()} za hodnotou`);
    this.pos++;
  }

  // ---- struktura ----------------------------------------------------------

  private parseTableHeader(): void {
    this.expect('[');
    const isArray = this.peek() === '[';
    if (isArray) this.pos++;

    this.skipInlineSpace();
    const path = this.parseKeyPath();
    this.skipInlineSpace();

    this.expect(']');
    if (isArray) this.expect(']');
    this.finishLine();

    this.current = isArray ? this.enterArrayTable(path) : this.descend(path);
  }

  /** Sestoupí cestou a vrátí (případně vytvořenou) tabulku. */
  private descend(path: string[]): TomlTable {
    let node: TomlTable = this.root;
    for (const key of path) {
      let next = node[key];
      if (next === undefined) {
        next = {};
        node[key] = next;
      }
      if (Array.isArray(next)) {
        // Cesta prochází polem tabulek — pokračuj v poslední z nich.
        const last = next[next.length - 1];
        if (last === undefined || typeof last !== 'object' || Array.isArray(last)) {
          this.fail(`${key} není pole tabulek`);
        }
        node = last as TomlTable;
      } else if (typeof next === 'object') {
        node = next as TomlTable;
      } else {
        this.fail(`${key} je už definován jako hodnota, nelze z něj udělat tabulku`);
      }
    }
    return node;
  }

  private enterArrayTable(path: string[]): TomlTable {
    const key = path[path.length - 1];
    const parent = this.descend(path.slice(0, -1));
    let arr = parent[key];
    if (arr === undefined) {
      arr = [];
      parent[key] = arr;
    }
    if (!Array.isArray(arr)) this.fail(`${key} už existuje a není pole tabulek`);
    const entry: TomlTable = {};
    (arr as TomlValue[]).push(entry);
    return entry;
  }

  private parseKeyValue(): void {
    const path = this.parseKeyPath();
    this.skipInlineSpace();
    this.expect('=');
    this.skipInlineSpace();
    const value = this.parseValue();
    this.finishLine();

    let node = this.current;
    for (const key of path.slice(0, -1)) {
      let next = node[key];
      if (next === undefined) {
        next = {};
        node[key] = next;
      }
      if (typeof next !== 'object' || Array.isArray(next)) this.fail(`${key} není tabulka`);
      node = next as TomlTable;
    }
    node[path[path.length - 1]] = value;
  }

  private parseKeyPath(): string[] {
    const path: string[] = [this.parseKeyPart()];
    for (;;) {
      this.skipInlineSpace();
      if (this.peek() !== '.') return path;
      this.pos++;
      this.skipInlineSpace();
      path.push(this.parseKeyPart());
    }
  }

  private parseKeyPart(): string {
    const c = this.peek();
    if (c === '"' || c === "'") return this.parseString();
    let out = '';
    while (BARE_KEY.test(this.peek())) {
      out += this.peek();
      this.pos++;
    }
    if (out === '') this.fail('očekáván klíč');
    return out;
  }

  // ---- hodnoty ------------------------------------------------------------

  private parseValue(): TomlValue {
    const c = this.peek();
    if (c === '"' || c === "'") return this.parseString();
    if (c === '[') return this.parseArray();
    if (c === '{') return this.parseInlineTable();

    let raw = '';
    while (!this.eof() && !',]}\n#'.includes(this.peek())) {
      raw += this.peek();
      this.pos++;
    }
    raw = raw.trim();
    if (raw === '') this.fail('očekávána hodnota');
    if (raw === 'true') return true;
    if (raw === 'false') return false;

    const numeric = raw.replace(/_/g, '');
    if (/^[+-]?\d+$/.test(numeric)) return Number.parseInt(numeric, 10);
    if (/^[+-]?(\d+\.\d+|\d+)([eE][+-]?\d+)?$/.test(numeric)) return Number.parseFloat(numeric);

    // Datum/čas a cokoli dalšího necháváme jako řetězec — profily to nepoužívají.
    return raw;
  }

  private parseString(): string {
    const quote = this.peek();
    const triple = this.peek(1) === quote && this.peek(2) === quote;
    const literal = quote === "'";

    this.pos += triple ? 3 : 1;
    // Víceřádkový řetězec ignoruje odřádkování hned za uvozovkami.
    if (triple && this.peek() === '\n') this.pos++;

    let out = '';
    for (;;) {
      if (this.eof()) this.fail('neuzavřený řetězec');
      const c = this.peek();

      if (c === quote) {
        if (!triple) {
          this.pos++;
          return out;
        }
        if (this.peek(1) === quote && this.peek(2) === quote) {
          this.pos += 3;
          return out;
        }
      }
      if (!triple && c === '\n') this.fail('neuzavřený řetězec');

      if (!literal && c === '\\') {
        this.pos++;
        out += this.readEscape(triple);
        continue;
      }
      out += c;
      this.pos++;
    }
  }

  private readEscape(triple: boolean): string {
    const e = this.peek();
    this.pos++;
    switch (e) {
      case 'n':
        return '\n';
      case 't':
        return '\t';
      case 'r':
        return '\r';
      case '"':
        return '"';
      case '\\':
        return '\\';
      case 'b':
        return '\b';
      case 'f':
        return '\f';
      case 'u':
      case 'U': {
        const len = e === 'u' ? 4 : 8;
        const hex = this.src.slice(this.pos, this.pos + len);
        if (!new RegExp(`^[0-9a-fA-F]{${len}}$`).test(hex)) this.fail('neplatný unicode escape');
        this.pos += len;
        return String.fromCodePoint(Number.parseInt(hex, 16));
      }
      case '\n': {
        // Zpětné lomítko na konci řádku spolkne následující bílé znaky.
        if (!triple) this.fail('zpětné lomítko na konci řádku patří jen do víceřádkového řetězce');
        while (!this.eof() && ' \t\n'.includes(this.peek())) this.pos++;
        return '';
      }
      default:
        this.fail(`neznámý escape \\${e}`);
    }
  }

  private parseArray(): TomlValue[] {
    this.expect('[');
    const out: TomlValue[] = [];
    for (;;) {
      this.skipIgnorable();
      if (this.eof()) this.fail('neuzavřené pole');
      if (this.peek() === ']') {
        this.pos++;
        return out;
      }
      out.push(this.parseValue());
      this.skipIgnorable();
      if (this.peek() === ',') {
        this.pos++;
        continue;
      }
      if (this.peek() !== ']') this.fail('v poli chybí čárka');
    }
  }

  private parseInlineTable(): TomlTable {
    this.expect('{');
    const out: TomlTable = {};
    this.skipInlineSpace();
    if (this.peek() === '}') {
      this.pos++;
      return out;
    }
    for (;;) {
      this.skipInlineSpace();
      const key = this.parseKeyPart();
      this.skipInlineSpace();
      this.expect('=');
      this.skipInlineSpace();
      out[key] = this.parseValue();
      this.skipInlineSpace();
      if (this.peek() === ',') {
        this.pos++;
        continue;
      }
      if (this.peek() === '}') {
        this.pos++;
        return out;
      }
      this.fail('v inline tabulce chybí čárka nebo uzavírací závorka');
    }
  }
}
