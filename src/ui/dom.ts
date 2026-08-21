/** Pár pomocníků nad DOM. Bez frameworku — projekt je na to dost malý. */

type Props = {
  class?: string;
  text?: string;
  html?: never;
  title?: string;
  type?: string;
  disabled?: boolean;
  hidden?: boolean;
  attrs?: Record<string, string>;
  on?: Partial<Record<keyof HTMLElementEventMap, (event: Event) => void>>;
};

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  children: (Node | string | null | undefined | false)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);

  if (props.class) node.className = props.class;
  if (props.text !== undefined) node.textContent = props.text;
  if (props.title) node.title = props.title;
  if (props.hidden) node.hidden = true;
  if (props.type && 'type' in node) (node as HTMLInputElement).type = props.type;
  if (props.disabled && 'disabled' in node) (node as HTMLButtonElement).disabled = true;

  for (const [key, value] of Object.entries(props.attrs ?? {})) node.setAttribute(key, value);
  for (const [event, handler] of Object.entries(props.on ?? {})) {
    node.addEventListener(event, handler as EventListener);
  }

  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

export function clear(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function mount(node: Element, ...children: (Node | string | null | undefined | false)[]): void {
  clear(node);
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child);
  }
}

export function must<T extends Element>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`V dokumentu chybí prvek "${selector}"`);
  return found;
}

export function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Popisek s vodorovnou linkou — hlavička sekce. */
export function sectionHead(label: string, right?: Node | string): HTMLElement {
  return el('div', { class: 'section-head' }, [
    el('span', { class: 'label', text: label }),
    el('span', { class: 'rule' }),
    right ? (typeof right === 'string' ? el('span', { class: 'label', text: right }) : right) : null,
  ]);
}

export function formatMb(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}
