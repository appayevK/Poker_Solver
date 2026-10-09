import { createRangeGrid } from '../range-grid.js';
import { parseRange, rangeToString } from '../../engine/ranges.js';
import { load, save } from '../../storage/store.js';

const STORAGE_KEY = 'rangesTab.range';

export function renderRangesTab(root) {
  let range = new Map();
  try {
    range = parseRange(String(load(STORAGE_KEY, '')));
  } catch {
    // ignore a corrupt saved range
  }
  const grid = createRangeGrid({
    range,
    onChange: (r) => save(STORAGE_KEY, rangeToString(r)),
  });
  const section = document.createElement('section');
  section.className = 'ranges-tab';
  section.innerHTML =
    '<h2>Ranges</h2><p class="muted">Range editor. Preflop charts and the trainer arrive in phase 5.</p>';
  section.append(grid);
  root.append(section);
}
