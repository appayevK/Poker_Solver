// Payout structure editor: preset, unit (% of pool or $), prize pool and the list.
import presets from '../../data/payouts/presets.json';
import { payoutsFromPercent, checkPayouts } from '../calc/icm.js';
import { el, field } from './dom.js';

export const PAYOUT_PRESETS = presets;

export function presetLabel(key, values) {
  const name = key.replace(/_/g, ' ').replace(/\bsng\b/i, 'SNG').replace(/^\w/, (c) => c.toUpperCase());
  return `${name} (${values.length} paid)`;
}

/** Parses '50, 30, 20' (commas, spaces or semicolons; $ and % signs allowed) into numbers. */
export function parsePayoutList(text) {
  const parts = String(text).split(/[\s,;]+/).filter(Boolean);
  if (parts.length === 0) throw new Error('Enter at least one payout');
  return parts.map((p) => {
    const n = Number(p.replace(/[$%]/g, ''));
    if (!Number.isFinite(n)) throw new Error(`"${p}" is not a number`);
    return n;
  });
}

/**
 * Turns editor state { text, unit: '%' | '$', pool } into { payouts ($), prizePool }.
 * Throws a user-facing error for invalid input.
 */
export function readPayouts({ text, unit, pool }) {
  const values = parsePayoutList(text);
  const poolValue = pool === '' || pool === null || pool === undefined ? null : Number(pool);
  if (unit === '%') {
    if (!(poolValue > 0)) throw new Error('Enter the prize pool');
    return { payouts: payoutsFromPercent(values, poolValue), prizePool: poolValue };
  }
  const payouts = checkPayouts(values);
  const total = payouts.reduce((a, b) => a + b, 0);
  const prizePool = poolValue ?? total;
  if (total > prizePool + 1e-6) throw new Error(`Payouts add up to $${total.toFixed(2)}, more than the prize pool`);
  return { payouts, prizePool };
}

/**
 * Editor bound to a state object { preset, text, unit, pool } that it updates in place.
 * Returns { element, setMessage(text) }; onChange() fires after every edit.
 */
export function createPayoutsEditor(state, onChange) {
  const presetSelect = el('select', { 'aria-label': 'Payout preset' }, [
    ...Object.entries(presets).map(([key, values]) => el('option', { value: key, text: presetLabel(key, values) })),
    el('option', { value: 'custom', text: 'Custom' }),
  ]);
  presetSelect.value = state.preset in presets ? state.preset : 'custom';
  const unitSelect = el('select', { 'aria-label': 'Payout unit' }, [
    el('option', { value: '%', text: '% of pool' }),
    el('option', { value: '$', text: '$ amounts' }),
  ]);
  unitSelect.value = state.unit;
  const poolInput = el('input', { type: 'number', inputMode: 'decimal', min: 0, step: 'any', value: state.pool });
  const listInput = el('input', { value: state.text, spellcheck: false, placeholder: '50, 30, 20' });
  const message = el('div', { class: 'icm-msg', role: 'alert' });

  presetSelect.addEventListener('change', () => {
    state.preset = presetSelect.value;
    if (presetSelect.value !== 'custom') {
      state.text = presets[presetSelect.value].join(', ');
      state.unit = '%';
      listInput.value = state.text;
      unitSelect.value = '%';
    }
    onChange();
  });
  unitSelect.addEventListener('change', () => {
    state.unit = unitSelect.value;
    onChange();
  });
  poolInput.addEventListener('input', () => {
    state.pool = poolInput.value;
    onChange();
  });
  listInput.addEventListener('input', () => {
    state.text = listInput.value;
    state.preset = 'custom';
    presetSelect.value = 'custom';
    onChange();
  });

  const element = el('div', { class: 'payouts-editor' }, [
    el('div', { class: 'icm-row' }, [field('Preset', presetSelect), field('Unit', unitSelect), field('Prize pool $', poolInput)]),
    el('div', { class: 'icm-row' }, [el('label', { class: 'field grow' }, [el('span', { text: 'Payouts, 1st first' }), listInput])]),
    message,
  ]);
  return {
    element,
    setMessage(text) {
      message.textContent = text;
    },
  };
}
