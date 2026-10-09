// Reusable 13x13 range grid: click/drag to select, weights, colour by frequency.
//
// createRangeGrid({ range, onChange, readOnly }) returns an element with
// getRange() / setRange(range) methods. `range` may be a Map or notation string.
// Painting: press on a cell and drag to paint every cell passed over at the slider
// weight. Pressing on a cell that already has that weight clears instead. The cells
// of the last paint stroke stay selected, and moving the slider re-weights them.

import { handClasses, parseRange, rangeToString, rangeCombos, setClassWeight, toRange } from '../engine/ranges.js';
import { comboWeights, CLASS_COMBOS } from '../engine/combos.js';

const CLASSES = handClasses();

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k in node) node[k] = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(c);
  return node;
}

function formatCombos(n) {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

export function createRangeGrid({ range = new Map(), onChange, readOnly = false } = {}) {
  let current = new Map(toRange(range));
  let brush = 1;
  let selection = new Set();
  let stroke = null;

  const root = el('div', { class: 'range-grid' + (readOnly ? ' readonly' : '') });
  const cellsEl = el('div', { class: 'rg-cells', role: 'grid', 'aria-label': 'Range grid' });
  const cells = CLASSES.map((cls, i) => {
    const row = Math.floor(i / 13);
    const col = i % 13;
    const kind = row === col ? 'pair' : col > row ? 'suited' : 'offsuit';
    const cell = el('div', { class: `rg-cell ${kind}`, text: cls, role: 'gridcell' });
    cell.dataset.cls = cls;
    cellsEl.append(cell);
    return cell;
  });

  const stats = el('div', { class: 'rg-stats', 'aria-live': 'polite' });
  const slider = el('input', { type: 'range', min: 1, max: 100, value: 100, 'aria-label': 'Weight' });
  const sliderOut = el('output', { class: 'rg-weight', text: '100%' });
  const clearBtn = el('button', { type: 'button', text: 'Clear' });
  const allBtn = el('button', { type: 'button', text: 'All' });
  const controls = el('div', { class: 'rg-controls' }, [
    el('label', { class: 'rg-slider' }, [el('span', { text: 'Weight' }), slider, sliderOut]),
    clearBtn,
    allBtn,
  ]);
  const text = el('textarea', {
    class: 'rg-text',
    rows: 2,
    spellcheck: false,
    placeholder: 'e.g. 22+, A2s+, KTo+, T9s-65s, A5s:0.5',
    'aria-label': 'Range notation',
    readOnly,
  });
  const error = el('div', { class: 'rg-error', role: 'alert' });

  root.append(cellsEl, stats);
  if (!readOnly) root.append(controls);
  root.append(text, error);

  // -- rendering ------------------------------------------------------------

  function renderCells() {
    const w = comboWeights(current);
    CLASSES.forEach((cls, ci) => {
      const combos = CLASS_COMBOS[ci];
      let sum = 0;
      let live = 0;
      for (const i of combos) {
        sum += w[i];
        if (w[i] > 0) live++;
      }
      const avg = sum / combos.length;
      const cell = cells[ci];
      cell.style.setProperty('--w', avg);
      cell.classList.toggle('on', avg > 0);
      cell.classList.toggle('dark', avg >= 0.6);
      cell.classList.toggle('sel', selection.has(cls));
      const pct = Math.round(avg * 100);
      cell.title =
        avg === 0 ? cls : live < combos.length ? `${cls}: ${pct}% (${live}/${combos.length} combos)` : `${cls}: ${pct}%`;
    });
    const combos = rangeCombos(current);
    stats.textContent = `${formatCombos(combos)} combos · ${((combos / 1326) * 100).toFixed(1)}% of hands`;
  }

  function syncText() {
    text.value = rangeToString(current);
    text.classList.remove('invalid');
    error.textContent = '';
  }

  function emit() {
    onChange?.(new Map(current));
  }

  // -- painting -------------------------------------------------------------

  function classWeight(cls) {
    const w = comboWeights(current);
    const combos = CLASS_COMBOS[CLASSES.indexOf(cls)];
    let sum = 0;
    for (const i of combos) sum += w[i];
    return sum / combos.length;
  }

  function paintOne(index) {
    const cls = CLASSES[index];
    if (stroke.seen.has(cls)) return;
    stroke.seen.add(cls);
    if (stroke.mode === 'add') {
      setClassWeight(current, cls, brush);
      selection.add(cls);
    } else {
      setClassWeight(current, cls, 0);
      selection.delete(cls);
    }
  }

  /** Paints every cell on the line from the previous pointer cell, so fast drags skip nothing. */
  function paintTo(index) {
    if (index === stroke.last) return;
    const from = stroke.last ?? index;
    const r0 = Math.floor(from / 13);
    const c0 = from % 13;
    const dr = Math.floor(index / 13) - r0;
    const dc = (index % 13) - c0;
    const steps = Math.max(Math.abs(dr), Math.abs(dc), 1);
    for (let t = stroke.last === null ? 0 : 1; t <= steps; t++) {
      paintOne(Math.round(r0 + (dr * t) / steps) * 13 + Math.round(c0 + (dc * t) / steps));
    }
    stroke.last = index;
    renderCells();
    syncText();
  }

  function cellAt(x, y) {
    const target = document.elementFromPoint(x, y);
    const cell = target?.closest?.('.rg-cell');
    return cell && cellsEl.contains(cell) ? cell : null;
  }

  function endStroke() {
    if (!stroke) return;
    stroke = null;
    window.removeEventListener('pointerup', endStroke);
    window.removeEventListener('pointercancel', endStroke);
    emit();
  }

  if (!readOnly) {
    cellsEl.addEventListener('pointerdown', (e) => {
      const cell = e.target.closest('.rg-cell');
      if (!cell || e.button > 0) return;
      e.preventDefault();
      // Touch pointers are captured by the first element; release so moves can be hit-tested.
      if (cell.hasPointerCapture?.(e.pointerId)) cell.releasePointerCapture(e.pointerId);
      const cls = cell.dataset.cls;
      const w = classWeight(cls);
      const mode = w > 0 && Math.abs(w - brush) < 1e-9 ? 'remove' : 'add';
      if (mode === 'add') selection = new Set();
      stroke = { mode, seen: new Set(), last: null };
      window.addEventListener('pointerup', endStroke);
      window.addEventListener('pointercancel', endStroke);
      paintTo(cells.indexOf(cell));
    });
    cellsEl.addEventListener('pointermove', (e) => {
      if (!stroke) return;
      const cell = cellAt(e.clientX, e.clientY);
      if (cell) paintTo(cells.indexOf(cell));
    });

    slider.addEventListener('input', () => {
      brush = Number(slider.value) / 100;
      sliderOut.textContent = `${slider.value}%`;
      if (selection.size === 0) return;
      for (const cls of selection) setClassWeight(current, cls, brush);
      renderCells();
      syncText();
      emit();
    });

    clearBtn.addEventListener('click', () => {
      current = new Map();
      selection = new Set();
      renderCells();
      syncText();
      emit();
    });

    allBtn.addEventListener('click', () => {
      current = new Map();
      for (const cls of CLASSES) setClassWeight(current, cls, brush);
      selection = new Set(CLASSES);
      renderCells();
      syncText();
      emit();
    });

    text.addEventListener('input', () => {
      try {
        current = parseRange(text.value);
      } catch (err) {
        text.classList.add('invalid');
        error.textContent = err.message;
        return;
      }
      text.classList.remove('invalid');
      error.textContent = '';
      selection = new Set();
      renderCells();
      emit();
    });
    text.addEventListener('blur', () => {
      if (!text.classList.contains('invalid')) syncText();
    });
  }

  root.getRange = () => new Map(current);
  root.setRange = (r) => {
    current = new Map(toRange(r));
    selection = new Set();
    renderCells();
    syncText();
  };

  renderCells();
  syncText();
  return root;
}
