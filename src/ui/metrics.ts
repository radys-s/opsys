/**
 * Segmentové ukazatele RAM / CPU / teplota.
 *
 * Ne plynulý progress bar: 20 dílků, mezera 3px, výška 12px. Dílky se
 * vytvoří jednou a pak se jen přepíná jejich stav — díky tomu má CSS
 * co animovat (650 ms) a nepřekresluje se celý strom.
 */

import { el, formatMb } from './dom';
import type { Metrics } from '../lib/types';

const SEGMENTS = 20;

interface MeterSpec {
  key: 'ram' | 'cpu' | 'temp';
  label: string;
  /** Rozsah stupnice — zobrazuje se pod ukazatelem, aby čísla dávala smysl. */
  min: number;
  max: number;
  /** Podíl stupnice, od kterého ukazatel přepne do výstražné barvy. */
  warnAt: number;
}

const SPECS: MeterSpec[] = [
  { key: 'ram', label: 'RAM', min: 0, max: 1, warnAt: 0.85 },
  { key: 'cpu', label: 'CPU', min: 0, max: 100, warnAt: 0.85 },
  { key: 'temp', label: 'Teplota', min: 30, max: 95, warnAt: 0.72 },
];

interface Meter {
  root: HTMLElement;
  value: HTMLElement;
  segments: HTMLElement[];
  foot: [HTMLElement, HTMLElement];
}

function buildMeter(spec: MeterSpec): Meter {
  const value = el('div', { class: 'meter-value value-num', text: '—' });
  const segments = Array.from({ length: SEGMENTS }, () => el('span', { class: 'seg' }));
  const footLeft = el('span', { text: '' });
  const footRight = el('span', { text: '' });

  const root = el('div', { class: 'meter', attrs: { 'data-metric': spec.key } }, [
    el('div', { class: 'meter-head' }, [el('span', { class: 'label', text: spec.label }), value]),
    el('div', { class: 'meter-track' }, segments),
    el('div', { class: 'meter-foot' }, [footLeft, footRight]),
  ]);

  return { root, value, segments, foot: [footLeft, footRight] };
}

function setSegments(meter: Meter, ratio: number, warn: boolean): void {
  const lit = Math.round(Math.max(0, Math.min(1, ratio)) * SEGMENTS);
  meter.segments.forEach((seg, i) => seg.classList.toggle('is-on', i < lit));
  meter.root.classList.toggle('is-warn', warn);
}

export interface MetricsView {
  root: HTMLElement;
  update(metrics: Metrics | null): void;
}

export function createMetrics(): MetricsView {
  const meters = new Map<MeterSpec['key'], Meter>();
  const root = el('section', { class: 'metrics' });

  for (const spec of SPECS) {
    const meter = buildMeter(spec);
    meters.set(spec.key, meter);
    root.append(meter.root);
  }

  function update(metrics: Metrics | null): void {
    const ram = meters.get('ram')!;
    const cpu = meters.get('cpu')!;
    const temp = meters.get('temp')!;

    if (!metrics) {
      for (const meter of meters.values()) {
        meter.value.textContent = '—';
        setSegments(meter, 0, false);
      }
      return;
    }

    // RAM
    const ramRatio = metrics.ramTotalMb > 0 ? metrics.ramUsedMb / metrics.ramTotalMb : 0;
    ram.value.textContent = '';
    ram.value.append(
      document.createTextNode(formatMb(metrics.ramUsedMb).replace(/ (MB|GB)$/, '')),
      el('span', { class: 'unit', text: ` / ${formatMb(metrics.ramTotalMb)}` }),
    );
    setSegments(ram, ramRatio, ramRatio >= 0.85);
    ram.foot[0].textContent = `${Math.round(ramRatio * 100)} % obsazeno`;
    ram.foot[1].textContent = `volno ${formatMb(metrics.ramTotalMb - metrics.ramUsedMb)}`;

    // CPU
    const cpuRatio = metrics.cpuPercent / 100;
    cpu.value.textContent = '';
    cpu.value.append(
      document.createTextNode(metrics.cpuPercent.toFixed(1)),
      el('span', { class: 'unit', text: '%' }),
    );
    setSegments(cpu, cpuRatio, cpuRatio >= 0.85);
    cpu.foot[0].textContent = '0 %';
    cpu.foot[1].textContent = '100 %';

    // Teplota — provider ji nemusí mít.
    if (metrics.tempC === null) {
      temp.value.textContent = '';
      temp.value.append(el('span', { class: 'unit', text: 'není k dispozici' }));
      setSegments(temp, 0, false);
      temp.foot[0].textContent = 'senzor nečitelný';
      temp.foot[1].textContent = '';
    } else {
      const spec = SPECS[2];
      const tempRatio = (metrics.tempC - spec.min) / (spec.max - spec.min);
      temp.value.textContent = '';
      temp.value.append(
        document.createTextNode(metrics.tempC.toFixed(1)),
        el('span', { class: 'unit', text: '°C' }),
      );
      setSegments(temp, tempRatio, tempRatio >= spec.warnAt);
      temp.foot[0].textContent = `${spec.min} °C`;
      temp.foot[1].textContent = `${spec.max} °C`;
    }
  }

  return { root, update };
}
