// Multi-action 13x13 grid: each cell is split by action frequency (raise, call,
// all-in, fold). Optional painting: pick an action and a frequency, then click or drag.
//
// createActionGrid({ frequencies, editable, onChange }) returns an element with
// setFrequencies(f), getFrequencies(), setEditable(bool), setBrush({ action, frequency }),
// setHighlight(class | null) and setDiff(Set of classes).
// frequencies = { raise: number[169], call: number[169], allin: number[169] }; fold is the rest.

import { handClasses } from '../engine/ranges.js';
import { el } from './dom.js';

const CLASSES = handClasses();
const ACTIONS = ['raise', 'call', 'allin'];
const COLORS = { raise: 'var(--act-raise)', call: 'var(--act-call)', allin: 'var(--act-allin)' };
const EPS = 1e-9;

const copy = (f) => Object.fromEntries(ACTIONS.map((a) => [a, Float64Array.from(f?.[a] ?? new Float64Array(169))]));
const round = (x) => Math.round(x * 1e4) / 1e4;

/** CSS background splitting a cell by its action frequencies. */
function cellBackground(f, c) {
  const stops = [];
  let at = 0;
  for (const a of ACTIONS) {
    const w = f[a][c];
    if (w <= EPS) continue;
    const end = Math.min(100, at + w * 100);
    stops.push(`${COLORS[a]} ${at}% ${end}%`);
    at = end;
  }
  if (!stops.length) return '';
  if (at < 100) stops.push(`transparent ${at}% 100%`);
  return `linear-gradient(to right, ${stops.join(', ')})`;
}

export function createActionGrid({ frequencies, editable = false, onChange } = {}) {
  let freqs = copy(frequencies);
  let brush = { action: 'raise', frequency: 1 };
  let canEdit = editable;
  let stroke = null;
  let highlight = null;
  let diff = new Set();

  const root = el('div', { class: 'action-grid' });
  const cellsEl = el('div', { class: 'ag-cells', role: 'grid', 'aria-label': 'Chart grid' });
  const cells = CLASSES.map((cls, i) => {
    const row = Math.floor(i / 13);
    const col = i % 13;
    const kind = row === col ? 'pair' : col > row ? 'suited' : 'offsuit';
    const cell = el('div', { class: `ag-cell ${kind}`, text: cls, role: 'gridcell' });
    cell.dataset.cls = cls;
    cellsEl.append(cell);
    return cell;
  });
  root.append(cellsEl);

  function renderCell(c) {
    const cell = cells[c];
    cell.style.backgroundImage = cellBackground(freqs, c);
    let active = 0;
    const parts = [];
    for (const a of ACTIONS) {
      active += freqs[a][c];
      if (freqs[a][c] > EPS) parts.push(`${a === 'allin' ? 'all-in' : a} ${Math.round(freqs[a][c] * 100)}%`);
    }
    const fold = Math.max(0, 1 - active);
    if (fold > EPS) parts.push(`fold ${Math.round(fold * 100)}%`);
    cell.classList.toggle('dark', fold < 0.5);
    cell.classList.toggle('hl', highlight === CLASSES[c]);
    cell.classList.toggle('diff', diff.has(CLASSES[c]));
    cell.title = `${CLASSES[c]}: ${parts.join(', ')}`;
  }
  const renderAll = () => CLASSES.forEach((_, c) => renderCell(c));

  /** Applies the brush to class c: the brush action gets the brush frequency, others shrink to fit. */
  function paint(c, erase) {
    const { action, frequency } = brush;
    if (action === 'fold') {
      const others = ACTIONS.reduce((s, a) => s + freqs[a][c], 0);
      const room = 1 - frequency;
      if (others > room + EPS) for (const a of ACTIONS) freqs[a][c] = round((freqs[a][c] * room) / others);
    } else {
      freqs[action][c] = erase ? 0 : frequency;
      const room = 1 - freqs[action][c];
      const others = ACTIONS.filter((a) => a !== action).reduce((s, a) => s + freqs[a][c], 0);
      if (others > room + EPS) for (const a of ACTIONS) if (a !== action) freqs[a][c] = round((freqs[a][c] * room) / others);
    }
    renderCell(c);
  }

  function paintLine(index) {
    if (index === stroke.last) return;
    const from = stroke.last ?? index;
    const r0 = Math.floor(from / 13);
    const c0 = from % 13;
    const dr = Math.floor(index / 13) - r0;
    const dc = (index % 13) - c0;
    const steps = Math.max(Math.abs(dr), Math.abs(dc), 1);
    for (let t = stroke.last === null ? 0 : 1; t <= steps; t++) {
      const c = Math.round(r0 + (dr * t) / steps) * 13 + Math.round(c0 + (dc * t) / steps);
      if (stroke.seen.has(c)) continue;
      stroke.seen.add(c);
      paint(c, stroke.erase);
    }
    stroke.last = index;
  }

  function endStroke() {
    if (!stroke) return;
    stroke = null;
    window.removeEventListener('pointerup', endStroke);
    window.removeEventListener('pointercancel', endStroke);
    onChange?.(copy(freqs));
  }

  cellsEl.addEventListener('pointerdown', (e) => {
    if (!canEdit) return;
    const cell = e.target.closest('.ag-cell');
    if (!cell || e.button > 0) return;
    e.preventDefault();
    if (cell.hasPointerCapture?.(e.pointerId)) cell.releasePointerCapture(e.pointerId);
    const c = cells.indexOf(cell);
    // Clicking a cell that already has the brush's frequency clears that action instead.
    const erase = brush.action !== 'fold' && Math.abs(freqs[brush.action][c] - brush.frequency) < 1e-6;
    stroke = { seen: new Set(), last: null, erase };
    window.addEventListener('pointerup', endStroke);
    window.addEventListener('pointercancel', endStroke);
    paintLine(c);
  });
  cellsEl.addEventListener('pointermove', (e) => {
    if (!stroke) return;
    const target = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('.ag-cell');
    if (target && cellsEl.contains(target)) paintLine(cells.indexOf(target));
  });

  root.setFrequencies = (f) => {
    freqs = copy(f);
    renderAll();
  };
  root.getFrequencies = () => copy(freqs);
  root.setEditable = (on) => {
    canEdit = on;
    root.classList.toggle('editable', on);
  };
  root.setBrush = (b) => {
    brush = { ...brush, ...b };
  };
  root.setHighlight = (cls) => {
    highlight = cls;
    renderAll();
  };
  root.setDiff = (set) => {
    diff = set ?? new Set();
    renderAll();
  };

  root.setEditable(canEdit);
  renderAll();
  return root;
}
