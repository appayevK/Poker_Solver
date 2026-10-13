// Manual hand entry (for live hands) → the internal Hand format.
//
// handFromForm(data) is the pure part: form values in display units ($ or chips) → a
// Hand built with createHand, blinds and antes posted automatically, the unmatched part
// of the last bet returned and the pot paid to the winner(s) when given.
// renderManualEntry(root, onSave) is the form: set up the table, then enter actions street
// by street with only the legal options offered (from legalActions in hand.js), deal the
// board, pick the winner and save. Keys: F fold, K check, C call, B bet, R raise, A all-in.

import { createHand, startState, nextStreet, applyAction, legalActions, validateHand, STREETS, formatAmount } from './hand.js';
import { parseCards, cardToString } from '../engine/cards.js';
import { el, field } from '../ui/dom.js';

/**
 * data = { format: 'cash'|'mtt'|'pko', blinds: { sb, bb, ante, bbAnte }, button, maxSeats,
 *   players: [{ seat, name, stack, bounty }], hero, heroCards: 'AhKd',
 *   actions: [{ street, player, type: fold|check|call|bet|raise|allin, to }],
 *   board: 'AsKd2c7h9s', winners: [names], date, notes, tags, id }
 * Amounts are in $ for cash and chips otherwise; bet and raise take the "to" total.
 */
export function handFromForm(data) {
  const currency = data.format === 'cash' ? '$' : null;
  const scale = currency ? 100 : 1;
  const u = (x) => Math.round(Number(x) * scale);
  const players = data.players.map((p) => ({
    seat: Number(p.seat),
    name: p.name,
    stack: u(p.stack),
    bounty: p.bounty === undefined || p.bounty === '' || p.bounty === null ? null : Number(p.bounty),
    cards: p.name === data.hero && data.heroCards ? data.heroCards : null,
  }));
  const blinds = { sb: u(data.blinds.sb ?? 0), bb: u(data.blinds.bb), ante: u(data.blinds.ante ?? 0), bbAnte: !!data.blinds.bbAnte };
  const sorted = [...players].sort((a, b) => a.seat - b.seat);
  const order = [...sorted.filter((p) => p.seat > data.button), ...sorted.filter((p) => p.seat <= data.button)];
  const sbPlayer = order.length === 2 ? order[1] : order[0];
  const bbPlayer = order.length === 2 ? order[0] : order[1];
  const posts = [];
  if (blinds.ante > 0) {
    for (const p of blinds.bbAnte ? [bbPlayer] : order) posts.push({ street: 'preflop', player: p.name, type: 'post', post: 'ante', amount: Math.min(blinds.ante, p.stack) });
  }
  if (blinds.sb > 0) posts.push({ street: 'preflop', player: sbPlayer.name, type: 'post', post: 'sb', amount: blinds.sb });
  posts.push({ street: 'preflop', player: bbPlayer.name, type: 'post', post: 'bb', amount: blinds.bb });
  const actions = [
    ...posts,
    ...(data.actions ?? []).map((a) => ({ street: a.street, player: a.player, type: a.type, ...(a.to !== undefined && a.to !== null && a.to !== '' ? { to: u(a.to) } : {}) })),
  ];
  const draft = createHand({
    id: data.id,
    site: 'manual',
    format: data.format ?? 'cash',
    date: data.date ?? null,
    table: data.table ?? 'Live',
    maxSeats: data.maxSeats ?? Math.max(6, players.length),
    button: Number(data.button),
    unit: { currency, scale },
    blinds,
    players,
    hero: data.hero ?? null,
    actions,
    board: data.board ?? '',
    notes: data.notes ?? '',
    tags: data.tags ?? [],
  });
  // The unmatched part of the biggest contribution goes back; the pot goes to the winners.
  const totals = new Map(draft.players.map((p) => [p.name, 0]));
  for (const a of draft.actions) totals.set(a.player, totals.get(a.player) + (a.amount ?? 0));
  const ranked = [...totals].sort((x, y) => y[1] - x[1]);
  const uncalled = ranked.length > 1 && ranked[0][1] > ranked[1][1] ? [{ player: ranked[0][0], amount: ranked[0][1] - ranked[1][1] }] : [];
  const pot = [...totals.values()].reduce((s, x) => s + x, 0) - (uncalled[0]?.amount ?? 0);
  const winners = data.winners?.length ? data.winners : null;
  const collected = winners
    ? winners.map((name, i) => ({ player: name, amount: Math.floor(pot / winners.length) + (i < pot % winners.length ? 1 : 0) }))
    : [];
  return createHand({ ...draft, actions: draft.actions, uncalled, collected, pot: winners ? pot : null });
}

// ---------------------------------------------------------------------------
// Form

const BOARD_NEEDED = { flop: 3, turn: 4, river: 5 };

function walk(hand, street) {
  let s = startState(hand);
  for (const a of hand.actions) {
    if (a.street !== s.street && STREETS.indexOf(a.street) > STREETS.indexOf(s.street)) s = nextStreet(s, a.street, hand);
    s = applyAction(s, a, hand).state;
  }
  if (street !== s.street && STREETS.indexOf(street) > STREETS.indexOf(s.street)) s = nextStreet(s, street, hand);
  return s;
}

/** The manual entry form. onSave(hand) gets a validated Hand; onCancel() closes it. */
export function renderManualEntry(root, onSave, onCancel) {
  const setup = {
    format: 'cash',
    sb: '0.1',
    bb: '0.25',
    ante: '0',
    bbAnte: false,
    count: 6,
    button: 6,
    hero: 'Hero',
    heroCards: '',
    players: Array.from({ length: 9 }, (_, i) => ({ seat: i + 1, name: i === 0 ? 'Hero' : `Seat ${i + 1}`, stack: '25', bounty: '' })),
  };
  let entry = null; // { actions: [], board: [], street }

  const box = el('div', { class: 'panel me-form' });
  root.replaceChildren(box);

  // Local time when the hand was entered, in the same form as GG dates.
  const pad = (n) => String(n).padStart(2, '0');
  const now = new Date();
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  const data = () => ({
    date,
    format: setup.format,
    blinds: { sb: setup.sb, bb: setup.bb, ante: setup.ante, bbAnte: setup.bbAnte },
    button: Number(setup.button),
    maxSeats: setup.count <= 6 ? 6 : 9,
    players: setup.players.slice(0, setup.count).map((p) => ({ ...p, bounty: setup.format === 'pko' ? p.bounty : null })),
    hero: setup.hero,
    heroCards: setup.heroCards,
    actions: entry?.actions ?? [],
    board: entry ? entry.board.map(cardToString).join('') : '',
  });

  function renderSetup() {
    const fmt = el('select', {}, ['cash', 'mtt', 'pko'].map((f) => el('option', { value: f, text: { cash: 'Cash ($)', mtt: 'Tournament (chips)', pko: 'PKO (chips + bounty)' }[f], selected: f === setup.format })));
    fmt.addEventListener('change', () => {
      setup.format = fmt.value;
      renderSetup();
    });
    const num = (key, label) => {
      const input = el('input', { type: 'number', min: '0', step: 'any', inputMode: 'decimal', value: setup[key] });
      input.addEventListener('input', () => (setup[key] = input.value));
      return field(label, input);
    };
    const count = el('select', {}, [2, 3, 4, 5, 6, 7, 8, 9].map((n) => el('option', { value: n, text: `${n} players`, selected: n === setup.count })));
    count.addEventListener('change', () => {
      setup.count = Number(count.value);
      if (setup.button > setup.count) setup.button = setup.count;
      renderSetup();
    });
    const bbAnte = el('input', { type: 'checkbox', checked: setup.bbAnte });
    bbAnte.addEventListener('change', () => (setup.bbAnte = bbAnte.checked));
    const rows = setup.players.slice(0, setup.count).map((p) => {
      const name = el('input', { value: p.name, 'aria-label': `Seat ${p.seat} name` });
      name.addEventListener('input', () => {
        if (setup.hero === p.name) setup.hero = name.value;
        p.name = name.value;
      });
      const stack = el('input', { type: 'number', min: '0', step: 'any', inputMode: 'decimal', value: p.stack, 'aria-label': `Seat ${p.seat} stack` });
      stack.addEventListener('input', () => (p.stack = stack.value));
      const bounty = el('input', { type: 'number', min: '0', step: 'any', inputMode: 'decimal', value: p.bounty, 'aria-label': `Seat ${p.seat} bounty`, placeholder: '$' });
      bounty.addEventListener('input', () => (p.bounty = bounty.value));
      const btn = el('input', { type: 'radio', name: 'me-button', checked: setup.button === p.seat, 'aria-label': `Button on seat ${p.seat}` });
      btn.addEventListener('change', () => (setup.button = p.seat));
      const hero = el('input', { type: 'radio', name: 'me-hero', checked: setup.hero === p.name, 'aria-label': `Seat ${p.seat} is hero` });
      hero.addEventListener('change', () => (setup.hero = p.name));
      return el('tr', {}, [el('td', { text: String(p.seat) }), el('td', {}, [name]), el('td', {}, [stack]), setup.format === 'pko' ? el('td', {}, [bounty]) : null, el('td', {}, [btn]), el('td', {}, [hero])]);
    });
    const cards = el('input', { value: setup.heroCards, placeholder: 'e.g. AhKd', autocomplete: 'off', 'aria-label': 'Hero cards' });
    cards.addEventListener('input', () => (setup.heroCards = cards.value));
    const msg = el('p', { class: 'rt-msg', role: 'status' });
    const start = el('button', { type: 'button', class: 'primary', text: 'Start entering actions' });
    start.addEventListener('click', () => {
      try {
        if (setup.heroCards && parseCards(setup.heroCards).length !== 2) throw new Error('Hero needs exactly two cards');
        entry = { actions: [], board: [], street: 'preflop' };
        handFromForm(data());
        renderActions();
      } catch (err) {
        entry = null;
        msg.textContent = err.message;
      }
    });
    const cancel = el('button', { type: 'button', text: 'Cancel' });
    cancel.addEventListener('click', () => onCancel?.());
    box.replaceChildren(
      el('h3', { text: 'New hand: table' }),
      el('div', { class: 'icm-row' }, [field('Format', fmt), num('sb', 'Small blind'), num('bb', 'Big blind'), num('ante', 'Ante'), el('label', { class: 'check' }, [bbAnte, el('span', { text: 'BB ante' })]), field('Players', count)]),
      el('div', { class: 'table-wrap' }, [
        el('table', { class: 'rv-table me-players' }, [
          el('thead', {}, [el('tr', {}, [el('th', { text: 'Seat' }), el('th', { text: 'Name' }), el('th', { text: setup.format === 'cash' ? 'Stack ($)' : 'Stack' }), setup.format === 'pko' ? el('th', { text: 'Bounty ($)' }) : null, el('th', { text: 'Button' }), el('th', { text: 'Hero' })])]),
          el('tbody', {}, rows),
        ]),
      ]),
      el('div', { class: 'icm-row' }, [field('Hero cards', cards)]),
      msg,
      el('div', { class: 'me-buttons' }, [cancel, start]),
    );
  }

  function renderActions() {
    let hand;
    try {
      hand = handFromForm(data());
    } catch (err) {
      entry.actions.pop();
      box.prepend(el('p', { class: 'rt-msg', text: err.message }));
      return;
    }
    const state = walk(hand, entry.street);
    const legal = legalActions(state, hand);
    const live = state.players.filter((p) => !p.folded);
    const log = el(
      'ol',
      { class: 'me-log' },
      hand.actions.filter((a) => a.type !== 'post').map((a) => el('li', { text: `${a.street}: ${a.player} ${a.type}${a.to ? ` to ${formatAmount(a.to, hand)}` : a.amount ? ` ${formatAmount(a.amount, hand)}` : ''}${a.isAllIn ? ' (all-in)' : ''}` })),
    );
    const undo = el('button', { type: 'button', text: 'Undo', disabled: !entry.actions.length && !entry.board.length });
    undo.addEventListener('click', () => {
      const last = entry.actions[entry.actions.length - 1];
      if (entry.board.length > (BOARD_NEEDED[last?.street] ?? 0)) {
        // Undo the last board cards dealt (back to the previous street).
        const back = STREETS[STREETS.indexOf(entry.street) - 1];
        entry.board = entry.board.slice(0, BOARD_NEEDED[back] ?? 0);
        entry.street = back;
      } else entry.actions.pop();
      renderActions();
    });
    const header = el('p', { class: 'muted small', text: `${entry.street[0].toUpperCase() + entry.street.slice(1)} · pot ${formatAmount(state.pot, hand)}${entry.board.length ? ` · board ${entry.board.map(cardToString).join(' ')}` : ''}` });
    const body = [];
    const keys = new Map();
    if (legal) {
      const amount = el('input', { type: 'number', min: '0', step: 'any', inputMode: 'decimal', placeholder: 'to', 'aria-label': 'Bet or raise to', value: String(legal.minTo / hand.unit.scale) });
      const act = (type, to) => {
        entry.actions.push({ street: entry.street, player: legal.player, type, ...(to !== undefined ? { to } : {}) });
        renderActions();
      };
      const buttons = [];
      const add = (label, key, fn) => {
        const b = el('button', { type: 'button', text: `${label} (${key.toUpperCase()})` });
        b.addEventListener('click', fn);
        keys.set(key, fn);
        buttons.push(b);
      };
      if (legal.options.includes('fold')) add('Fold', 'f', () => act('fold'));
      if (legal.options.includes('check')) add('Check', 'k', () => act('check'));
      if (legal.options.includes('call')) add(`Call ${formatAmount(legal.callAmount, hand)}`, 'c', () => act('call'));
      const sized = legal.options.includes('bet') ? 'bet' : legal.options.includes('raise') ? 'raise' : null;
      if (sized) add(sized === 'bet' ? 'Bet' : 'Raise to', sized === 'bet' ? 'b' : 'r', () => act(sized, amount.value));
      if (legal.maxTo > (legal.toCall ? legal.callAmount : 0)) add(`All-in ${formatAmount(legal.maxTo, hand)}`, 'a', () => act('allin'));
      amount.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && sized) act(sized, amount.value);
      });
      body.push(el('p', { text: `${legal.player} to act${legal.toCall ? ` (${formatAmount(legal.callAmount, hand)} to call)` : ''}` }), el('div', { class: 'me-buttons' }, [...buttons, sized ? field(sized === 'bet' ? 'Bet' : 'Raise to', amount) : null]));
    } else if (live.length > 1 && entry.street !== 'river') {
      const next = STREETS[STREETS.indexOf(entry.street) + 1];
      const allIn = live.filter((p) => !p.allIn).length <= 1;
      const need = (allIn ? 5 : BOARD_NEEDED[next]) - entry.board.length;
      const input = el('input', { placeholder: need === 3 ? 'e.g. Ks9h4h' : need === 1 ? 'e.g. 7d' : `${need} cards`, autocomplete: 'off', 'aria-label': `${next} cards` });
      const deal = el('button', { type: 'button', class: 'primary', text: `Deal ${allIn ? 'the rest of the board' : `the ${next}`}` });
      const msg = el('p', { class: 'rt-msg', role: 'status' });
      const go = () => {
        try {
          const cards = parseCards(input.value);
          if (cards.length !== need) throw new Error(`Enter ${need} card${need > 1 ? 's' : ''}`);
          const all = [...entry.board, ...cards, ...(hand.players.find((p) => p.isHero)?.cards ?? [])];
          if (new Set(all).size !== all.length) throw new Error('A card is already used');
          entry.board.push(...cards);
          entry.street = allIn ? 'river' : next;
          renderActions();
        } catch (err) {
          msg.textContent = err.message;
        }
      };
      deal.addEventListener('click', go);
      input.addEventListener('keydown', (e) => e.key === 'Enter' && go());
      body.push(field(`${allIn ? 'Board' : next[0].toUpperCase() + next.slice(1)} cards`, input), msg, deal);
      queueMicrotask(() => input.focus());
    } else {
      // Hand over: pick the winner(s) and save.
      const checks = live.map((p) => {
        const c = el('input', { type: 'checkbox', checked: live.length === 1 });
        return { name: p.name, c, label: el('label', { class: 'check' }, [c, el('span', { text: p.name })]) };
      });
      const msg = el('p', { class: 'rt-msg', role: 'status' });
      const saveBtn = el('button', { type: 'button', class: 'primary', text: 'Save hand' });
      saveBtn.addEventListener('click', () => {
        const winners = checks.filter((x) => x.c.checked).map((x) => x.name);
        const final = handFromForm({ ...data(), winners });
        const problems = validateHand(final);
        if (problems.length) msg.textContent = `Saved with notes: ${problems.map((p) => p.message).join('; ')}`;
        onSave(final, problems);
      });
      body.push(el('p', { text: live.length === 1 ? `${live[0].name} wins the pot.` : 'Who won? (leave empty if you do not know)' }), el('div', { class: 'me-buttons' }, checks.map((x) => x.label)), msg, saveBtn);
    }
    box.onkeydown = (e) => {
      if (e.target.tagName === 'INPUT' || e.ctrlKey || e.metaKey || e.altKey) return;
      const fn = keys.get(e.key.toLowerCase());
      if (fn) {
        e.preventDefault();
        fn();
      }
    };
    const back = el('button', { type: 'button', text: 'Back to the table' });
    back.addEventListener('click', () => {
      entry = null;
      renderSetup();
    });
    box.replaceChildren(el('h3', { text: 'New hand: actions' }), header, ...body, el('div', { class: 'me-buttons' }, [back, undo]), log);
    box.tabIndex = -1;
    if (legal) box.focus();
  }

  renderSetup();
}
