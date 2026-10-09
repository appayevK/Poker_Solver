// Modal range grid editor.
import { el } from './dom.js';
import { createRangeGrid } from './range-grid.js';

/**
 * Opens the range grid in a modal dialog. Resolves to the chosen range Map, or null
 * when the dialog is cancelled (Cancel button or Escape).
 */
export function openRangeDialog({ title = 'Range', range = new Map(), confirmLabel = 'Use range' } = {}) {
  return new Promise((resolve) => {
    const grid = createRangeGrid({ range });
    const done = el('button', { type: 'button', class: 'primary', text: confirmLabel });
    const cancel = el('button', { type: 'button', text: 'Cancel' });
    const dialog = el('dialog', { class: 'range-dialog' }, [
      el('h3', { text: title }),
      grid,
      el('div', { class: 'range-dialog-actions' }, [cancel, done]),
    ]);
    let value = null;
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(value);
    });
    cancel.addEventListener('click', () => dialog.close());
    done.addEventListener('click', () => {
      value = grid.getRange();
      dialog.close();
    });
    document.body.append(dialog);
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
  });
}
