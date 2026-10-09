// Small DOM helpers shared by the UI modules.

/** el('div', { class: 'x', text: 'hi', 'aria-label': 'y' }, [children]) */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k in node) node[k] = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) node.append(c);
  return node;
}

/** A labelled form field: <label class="field"><span>Label</span>{input}{extra}</label> */
export function field(label, input, ...extra) {
  return el('label', { class: 'field' }, [el('span', { text: label }), input, ...extra]);
}

/** Number from an input, or null when empty or not a number. */
export function readNumber(input) {
  if (input.value.trim() === '') return null;
  const n = Number(input.value);
  return Number.isFinite(n) ? n : null;
}

/** 0.4567 → '45.67%' */
export const pct = (x, digits = 2) => `${(x * 100).toFixed(digits)}%`;

/** Rounds to at most `digits` decimals and drops trailing zeros: 12.5, 3, 0.25 */
export function fmt(x, digits = 2) {
  if (!Number.isFinite(x)) return '–';
  return String(Number(x.toFixed(digits)));
}

/** Signed number: +12.5 / -3 / 0 */
export function signed(x, digits = 2) {
  if (!Number.isFinite(x)) return '–';
  const s = fmt(x, digits);
  return x > 0 && s !== '0' ? `+${s}` : s;
}
