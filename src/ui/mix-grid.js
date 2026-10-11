// Read-only 13x13 grid where each cell is split by any number of actions.
// createMixGrid({ actions: [{ key, label, color }], onSelect }) returns an element with
// setData({ actions, classes: { [key]: Float64Array(169) }, weights: Float64Array(169) }),
// setHighlight(class | null). Cells with no weight (not in the range) are dimmed.

import { handClasses } from '../engine/ranges.js';
import { el } from './dom.js';

const CLASSES = handClasses();

function background(actions, classes, c) {
  const stops = [];
  let at = 0;
  for (const a of actions) {
    const w = classes[a.key]?.[c] ?? 0;
    if (w <= 1e-6) continue;
    const end = Math.min(100, at + w * 100);
    stops.push(`${a.color} ${at}% ${end}%`);
    at = end;
  }
  if (!stops.length) return '';
  if (at < 99.9) stops.push(`transparent ${at}% 100%`);
  return `linear-gradient(to right, ${stops.join(', ')})`;
}

export function createMixGrid({ onSelect } = {}) {
  let highlight = null;
  const root = el('div', { class: 'mix-grid' });
  const cellsEl = el('div', { class: 'ag-cells', role: 'grid', 'aria-label': 'Strategy grid' });
  const cells = CLASSES.map((cls, i) => {
    const row = Math.floor(i / 13);
    const col = i % 13;
    const kind = row === col ? 'pair' : col > row ? 'suited' : 'offsuit';
    const cell = el('button', { type: 'button', class: `ag-cell mx-cell ${kind}`, text: cls, role: 'gridcell' });
    cell.dataset.cls = cls;
    cellsEl.append(cell);
    return cell;
  });
  root.append(cellsEl);
  cellsEl.addEventListener('click', (e) => {
    const cell = e.target.closest('.mx-cell');
    if (cell && !cell.classList.contains('empty')) onSelect?.(cell.dataset.cls);
  });

  root.setData = ({ actions, classes, weights }) => {
    cells.forEach((cell, c) => {
      const inRange = weights[c] > 1e-9;
      cell.classList.toggle('empty', !inRange);
      cell.style.backgroundImage = inRange ? background(actions, classes, c) : '';
      cell.classList.toggle('hl', highlight === CLASSES[c]);
      const parts = actions.filter((a) => (classes[a.key]?.[c] ?? 0) > 0.005).map((a) => `${a.label} ${Math.round(classes[a.key][c] * 100)}%`);
      cell.title = inRange ? `${CLASSES[c]}: ${parts.join(', ')}` : `${CLASSES[c]}: not in range`;
    });
  };
  root.setHighlight = (cls) => {
    highlight = cls;
    cells.forEach((cell) => cell.classList.toggle('hl', cell.dataset.cls === cls));
  };
  return root;
}

/** Colours for flop actions: checks green-grey, bets red (darker when bigger), calls green, raises purple, folds blue-grey. */
export function actionColor(action) {
  if (action.key === 'check') return 'var(--fa-check)';
  if (action.key === 'call') return 'var(--fa-call)';
  if (action.key === 'fold') return 'var(--fa-fold)';
  if (action.key === 'allin') return 'var(--fa-allin)';
  if (action.key === 'raise') return 'var(--fa-raise)';
  const bet = /^bet(\d+)$/.exec(action.key);
  if (bet) return Number(bet[1]) > 50 ? 'var(--fa-bet-big)' : 'var(--fa-bet-small)';
  return 'var(--muted)';
}
