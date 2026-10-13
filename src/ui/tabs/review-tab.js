// Review tab: import GGPoker hand histories or enter live hands, browse the hand library,
// step through a hand with per-decision analysis and leak flags, and see session stats.
import { parseGGFile } from '../../review/gg-parser.js';
import { validateHand, toBB, formatAmount, heroPlayer, results } from '../../review/hand.js';
import { buildStates, analyseDecision, postedState } from '../../review/replayer.js';
import { analyseHand, rangeFor, quickFlags } from '../../review/analyse-hand.js';
import { detectLeaks } from '../../review/leak-flags.js';
import { sessionStats, detectSessionLeaks } from '../../review/session-leaks.js';
import { renderManualEntry } from '../../review/manual-entry.js';
import { openHandDB, createMemoryHandDB } from '../../storage/hand-db.js';
import { createRangeGrid } from '../range-grid.js';
import { rangeToString } from '../../engine/ranges.js';
import { cardToString } from '../../engine/cards.js';
import { el, field, pct, fmt, signed } from '../dom.js';
import { load, save } from '../../storage/store.js';

const STORAGE_KEY = 'reviewTab';
const SUIT_SYMBOLS = { s: '♠', h: '♥', d: '♦', c: '♣' };
const STREET_NAMES = { preflop: 'Preflop', flop: 'Flop', turn: 'Turn', river: 'River' };
const FORMAT_NAMES = { cash: 'Cash', mtt: 'MTT', pko: 'PKO' };
const POSITIONS = ['UTG', 'UTG+1', 'MP', 'LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB'];

let dbPromise = null;
function getDB() {
  dbPromise ??= openHandDB().catch(() => createMemoryHandDB());
  return dbPromise;
}

function cardFace(card, small = false) {
  const s = cardToString(card);
  return el('span', { class: `card suit-${s[1]}${small ? ' small' : ''}`, text: `${s[0]}${SUIT_SYMBOLS[s[1]]}`, 'aria-label': s });
}

const cardsRow = (cards, small) => el('span', { class: 'rv-cards' }, (cards ?? []).map((c) => cardFace(c, small)));
const bbText = (x) => `${fmt(x, 1)} bb`;
const shortDate = (d) => (d ? d.replace('T', ' ').slice(5, 16) : '–');

function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/** 'raises to $0.63'; with you = true, 'raise to $0.63' (for "You ..."). */
function describeAction(a, hand, you = false) {
  const text = describeThird(a, hand);
  return you ? text.replace(/^(\w+?)s\b/, '$1') : text;
}

function describeThird(a, hand) {
  const amount = (x) => formatAmount(x, hand);
  switch (a.type) {
    case 'post':
      return `posts ${{ sb: 'the small blind', bb: 'the big blind', ante: 'the ante', straddle: 'a straddle', dead: 'a dead blind' }[a.post]} ${amount(a.amount)}`;
    case 'fold':
      return 'folds';
    case 'check':
      return 'checks';
    case 'call':
      return `calls ${amount(a.amount)}${a.isAllIn ? ' (all-in)' : ''}`;
    case 'bet':
      return `bets ${amount(a.amount)}${a.isAllIn ? ' (all-in)' : ''}`;
    case 'raise':
      return `raises to ${amount(a.to)}${a.isAllIn ? ' (all-in)' : ''}`;
    default:
      return a.type;
  }
}

export function renderReviewTab(root) {
  const saved = load(STORAGE_KEY, null);
  const state = {
    view: 'hands',
    filters: { format: '', position: '', flagged: false, tag: '', search: '', sort: 'date', order: 'desc' },
    ...(saved ?? {}),
  };
  const persist = () => save(STORAGE_KEY, { view: state.view, filters: state.filters });

  const intro = el('p', {
    class: 'muted',
    text: 'Import GGPoker hand histories (PokerCraft lets you download them) or enter a live hand, then step through it with the numbers at each of your decisions.',
  });
  const viewButtons = ['hands', 'session'].map((view) => {
    const b = el('button', { type: 'button', text: view === 'hands' ? 'Hands' : 'Session' });
    b.addEventListener('click', () => {
      state.view = view;
      persist();
      showView();
    });
    return b;
  });
  const importToggle = el('button', { type: 'button', text: 'Import hands' });
  const newHand = el('button', { type: 'button', text: 'New hand' });
  const storageNote = el('p', { class: 'muted small', hidden: true });
  const toolbar = el('div', { class: 'rv-toolbar' }, [el('div', { class: 'segmented', role: 'group', 'aria-label': 'View' }, viewButtons), importToggle, newHand]);

  // -- import -------------------------------------------------------------------
  const pasteBox = el('textarea', { rows: 6, placeholder: 'Paste one or more GGPoker hands here…', 'aria-label': 'Hand histories', spellcheck: false });
  const fileInput = el('input', { type: 'file', accept: '.txt,text/plain', multiple: true, 'aria-label': 'Hand history files' });
  const importBtn = el('button', { type: 'button', class: 'primary', text: 'Import' });
  const importMsg = el('div', { class: 'rv-import-msg', role: 'status' });
  const importPanel = el('div', { class: 'panel rv-import', hidden: true }, [
    el('h3', { text: 'Import hand histories' }),
    pasteBox,
    el('div', { class: 'rv-row' }, [field('Or choose .txt files', fileInput), importBtn]),
    importMsg,
  ]);
  importToggle.addEventListener('click', () => {
    importPanel.hidden = !importPanel.hidden;
    if (!importPanel.hidden) pasteBox.focus();
  });

  async function importTexts(texts) {
    importMsg.replaceChildren(el('p', { text: 'Reading…' }));
    const hands = [];
    const errors = [];
    let problemHands = 0;
    for (const { name, text } of texts) {
      const parsed = parseGGFile(text);
      for (const e of parsed.errors) errors.push(`${name}: hand ${e.id ?? e.index + 1}: ${e.message}`);
      for (const { hand, warnings } of parsed.hands) {
        hand.problems = [...validateHand(hand).map((p) => p.message), ...warnings];
        if (hand.problems.length) problemHands++;
        hand.flags = quickFlags(hand);
        hands.push(hand);
      }
    }
    const db = await getDB();
    const { added, duplicates } = await db.save(hands);
    importMsg.replaceChildren(
      el('p', { text: `Imported ${added} hand${added === 1 ? '' : 's'}${duplicates ? ` (${duplicates} already in the library)` : ''}.${problemHands ? ` ${problemHands} with notes from the parser.` : ''}${errors.length ? ` ${errors.length} could not be read:` : ''}` }),
      ...(errors.length ? [el('ul', { class: 'rv-errors' }, errors.slice(0, 20).map((e) => el('li', { text: e })))] : []),
    );
    pasteBox.value = '';
    fileInput.value = '';
    await refreshList();
  }
  importBtn.addEventListener('click', async () => {
    const texts = [];
    if (pasteBox.value.trim()) texts.push({ name: 'Pasted text', text: pasteBox.value });
    for (const file of fileInput.files) texts.push({ name: file.name, text: await file.text() });
    if (!texts.length) {
      importMsg.replaceChildren(el('p', { text: 'Paste some hands or choose a file first.' }));
      return;
    }
    try {
      await importTexts(texts);
    } catch (err) {
      importMsg.replaceChildren(el('p', { text: `Import failed: ${err.message}` }));
    }
  });

  // -- manual entry -------------------------------------------------------------
  const manualBox = el('div', { class: 'rv-manual', hidden: true });
  newHand.addEventListener('click', () => {
    manualBox.hidden = false;
    renderManualEntry(
      manualBox,
      async (hand, problems) => {
        hand.problems = problems.map((p) => p.message);
        hand.flags = quickFlags(hand);
        const db = await getDB();
        await db.save([hand]);
        manualBox.hidden = true;
        manualBox.replaceChildren();
        await refreshList();
        openHand(hand.id);
      },
      () => {
        manualBox.hidden = true;
        manualBox.replaceChildren();
      },
    );
    manualBox.scrollIntoView({ block: 'nearest' });
  });

  // -- hand list ----------------------------------------------------------------
  const fFormat = el('select', { 'aria-label': 'Format' }, [el('option', { value: '', text: 'All formats' }), ...Object.entries(FORMAT_NAMES).map(([v, t]) => el('option', { value: v, text: t }))]);
  const fPosition = el('select', { 'aria-label': 'Position' }, [el('option', { value: '', text: 'All positions' }), ...POSITIONS.map((p) => el('option', { value: p, text: p }))]);
  const fFlagged = el('input', { type: 'checkbox' });
  const fTag = el('select', { 'aria-label': 'Tag' });
  const fSearch = el('input', { type: 'search', placeholder: 'Search id, cards, notes…', 'aria-label': 'Search' });
  const fSort = el('select', { 'aria-label': 'Sort' }, [
    el('option', { value: 'date:desc', text: 'Newest first' }),
    el('option', { value: 'date:asc', text: 'Oldest first' }),
    el('option', { value: 'result:asc', text: 'Biggest losses' }),
    el('option', { value: 'result:desc', text: 'Biggest wins' }),
  ]);
  fFormat.value = state.filters.format;
  fPosition.value = state.filters.position;
  fFlagged.checked = state.filters.flagged;
  fSearch.value = state.filters.search;
  fSort.value = `${state.filters.sort}:${state.filters.order}`;
  const readFilters = () => {
    const [sort, order] = fSort.value.split(':');
    state.filters = { format: fFormat.value, position: fPosition.value, flagged: fFlagged.checked, tag: fTag.value, search: fSearch.value.trim(), sort, order };
    persist();
    refreshList();
  };
  for (const c of [fFormat, fPosition, fFlagged, fTag, fSort]) c.addEventListener('change', readFilters);
  fSearch.addEventListener('input', debounce(readFilters, 250));

  const listInfo = el('p', { class: 'muted small' });
  const analyseAll = el('button', { type: 'button', text: 'Analyse these hands' });
  const listBody = el('tbody');
  const listTable = el('table', { class: 'rv-table rv-list-table' }, [
    el('thead', {}, [el('tr', {}, ['Date', 'Game', 'Pos', 'Cards', 'Result', 'Flags', 'Tags'].map((h) => el('th', { text: h })))]),
    listBody,
  ]);
  const emptyList = el('div', { class: 'rv-empty' });
  const listView = el('div', { class: 'rv-list' }, [
    el('div', { class: 'panel' }, [
      el('div', { class: 'icm-row rv-filters' }, [
        field('Format', fFormat),
        field('Position', fPosition),
        field('Tag', fTag),
        field('Search', fSearch),
        field('Sort', fSort),
        el('label', { class: 'check' }, [fFlagged, el('span', { text: 'Flagged only' })]),
      ]),
      el('div', { class: 'rv-row' }, [listInfo, analyseAll]),
      el('div', { class: 'table-wrap' }, [listTable]),
      emptyList,
    ]),
  ]);

  let listed = [];
  async function refreshList() {
    const db = await getDB();
    if (db.memory) {
      storageNote.hidden = false;
      storageNote.textContent = 'This browser blocks IndexedDB, so hands are only kept until you close the page.';
    }
    const tags = await db.tags();
    fTag.replaceChildren(el('option', { value: '', text: 'Any tag' }), ...tags.map((t) => el('option', { value: t, text: t })));
    fTag.value = tags.includes(state.filters.tag) ? state.filters.tag : '';
    listed = await db.list(state.filters);
    const total = await db.count();
    listInfo.textContent = total ? `${listed.length} of ${total} hand${total === 1 ? '' : 's'}` : '';
    analyseAll.hidden = !listed.length;
    listTable.hidden = !listed.length;
    emptyList.replaceChildren(
      total
        ? el('p', { class: 'muted', text: 'No hands match these filters.' })
        : el('p', { class: 'muted', text: 'No hands yet. Use "Import hands" to paste or load GGPoker hand histories, or "New hand" to enter a live hand.' }),
    );
    emptyList.hidden = listed.length > 0;
    listBody.replaceChildren(
      ...listed.map((rec) => {
        const s = rec.summary;
        const tr = el('tr', { tabIndex: 0, class: 'rv-click' }, [
          el('td', { text: shortDate(rec.date) }),
          el('td', { text: `${s.stakes} ${rec.variant === 'rushAndCash' ? 'R&C' : FORMAT_NAMES[rec.format]}` }),
          el('td', { text: s.position ?? '–' }),
          el('td', {}, [s.cards ? cardsRow(heroPlayer(rec)?.cards, true) : el('span', { text: '–' })]),
          el('td', { class: s.resultBB > 0 ? 'rv-win' : s.resultBB < 0 ? 'rv-loss' : '', text: signed(s.resultBB, 1) }),
          el('td', {}, [rec.flags?.length ? el('span', { class: 'badge bad', text: String(rec.flags.length), title: rec.flags.map((f) => f.type).join(', ') }) : null]),
          el('td', { class: 'small', text: rec.tags.join(', ') }),
        ]);
        const go = () => openHand(rec.id);
        tr.addEventListener('click', go);
        tr.addEventListener('keydown', (e) => e.key === 'Enter' && go());
        return tr;
      }),
    );
    if (state.view === 'session') renderSession();
  }

  let analysing = false;
  analyseAll.addEventListener('click', async () => {
    if (analysing) {
      analysing = false;
      return;
    }
    analysing = true;
    analyseAll.textContent = 'Stop';
    const db = await getDB();
    const ids = listed.map((r) => r.id);
    let k = 0;
    for (const id of ids) {
      if (!analysing) break;
      k++;
      listInfo.textContent = `Analysing ${k} of ${ids.length}…`;
      const rec = await db.get(id);
      try {
        const { flags } = await analyseHand(rec);
        await db.update(id, { flags, analysedAt: new Date().toISOString() });
      } catch (err) {
        console.error(`Analysis of ${id} failed`, err);
      }
    }
    analysing = false;
    analyseAll.textContent = 'Analyse these hands';
    await refreshList();
  });

  // -- hand view ----------------------------------------------------------------
  const handView = el('div', { class: 'rv-hand', hidden: true });
  let current = null; // { rec, states, posted, step, analyses, flags }

  async function openHand(id) {
    const db = await getDB();
    const rec = await db.get(id);
    if (!rec) return;
    const states = buildStates(rec);
    current = { rec, states, posted: postedState(rec), step: 0, analyses: new Map(), analysed: false, flags: rec.flags ?? [], foldFreq: {} };
    const firstHero = states.findIndex((s) => s.isHero);
    current.step = firstHero >= 0 ? firstHero : 0;
    state.view = 'hand';
    showView();
    renderHand();
    // Analyse every hero decision once, then keep the flags in the library.
    try {
      const { analyses, flags } = await analyseHand(rec);
      if (current?.rec.id !== id) return;
      for (const an of analyses) current.analyses.set(an.actionIndex, an);
      current.flags = flags;
      current.analysed = true;
      await db.update(id, { flags, analysedAt: new Date().toISOString() });
      renderHand();
    } catch (err) {
      console.error(err);
    }
  }

  function closeHand() {
    current = null;
    state.view = 'hands';
    showView();
    refreshList();
  }

  function seatBox(p, hand, { actor, showCards }) {
    const player = hand.players.find((x) => x.name === p.name);
    const cards = player.isHero || showCards ? player.cards ?? hand.shows.find((s) => s.player === p.name)?.cards ?? null : null;
    return el('div', { class: `rv-seat${player.isHero ? ' hero' : ''}${p.folded ? ' folded' : ''}${p.name === actor ? ' actor' : ''}` }, [
      el('div', { class: 'rv-seat-top' }, [el('strong', { text: p.position ?? `Seat ${p.seat}` }), el('span', { class: 'small', text: player.isHero ? 'Hero' : p.name })]),
      el('div', { class: 'small', text: `${bbText(toBB(p.stack, hand))}${p.allIn ? ' · all-in' : ''}` }),
      p.inStreet > 0 ? el('div', { class: 'rv-bet small', text: `in: ${bbText(toBB(p.inStreet, hand))}` }) : null,
      cards ? cardsRow(cards, true) : null,
    ]);
  }

  function renderHand() {
    if (!current) return;
    const { rec: hand, states } = current;
    const step = current.step;
    const last = states.length;
    const prev = step > 0 ? states[step - 1] : null;
    const next = step < last ? states[step] : null;
    const atEnd = step === last;
    // At the end: the uncalled bet is back, and stacks are after the pot was paid.
    const settled = atEnd && prev ? results(hand) : null;
    const table = settled ? prev.table.map((p) => ({ ...p, stack: settled.get(p.name).end, inStreet: 0, allIn: false })) : prev ? prev.table : current.posted.table;
    const pot = settled ? hand.pot ?? prev.potAfter - hand.uncalled.reduce((sum, u) => sum + u.amount, 0) : prev ? prev.potAfter : current.posted.pot;
    const street = next?.street ?? prev?.street ?? 'preflop';
    const boardCards = atEnd ? hand.board : hand.board.slice(0, { preflop: 0, flop: 3, turn: 4, river: 5 }[street]);
    const bb = (x) => bbText(toBB(x, hand));

    // Header and controls.
    const back = el('button', { type: 'button', text: '← Hands' });
    back.addEventListener('click', closeHand);
    const hero = heroPlayer(hand);
    const res = hand.hero ? results(hand).get(hand.hero) : null;
    const header = el('div', { class: 'rv-hand-head' }, [
      back,
      el('div', {}, [
        el('h3', { text: `${hand.table || 'Hand'} · ${formatAmount(hand.blinds.sb, hand)}/${formatAmount(hand.blinds.bb, hand)} ${hand.variant === 'rushAndCash' ? 'Rush & Cash' : FORMAT_NAMES[hand.format]}` }),
        el('p', { class: 'muted small', text: `${hand.id} · ${shortDate(hand.date)}${hero ? ` · Hero ${hero.position}` : ''}${res ? ` · result ${signed(toBB(res.net, hand), 1)} bb` : ''}` }),
      ]),
    ]);
    const go = (k) => {
      current.step = Math.max(0, Math.min(last, k));
      renderHand();
    };
    const ctrl = (label, k, title) => {
      const b = el('button', { type: 'button', text: label, title, disabled: k === step || k < 0 || k > last });
      b.addEventListener('click', () => go(k));
      return b;
    };
    const streetStart = (s) => states.findIndex((x) => x.street === s);
    const controls = el('div', { class: 'rv-controls' }, [
      ctrl('⏮', 0, 'Start'),
      ctrl('◀', step - 1, 'Previous action (←)'),
      ctrl('▶', step + 1, 'Next action (→)'),
      ctrl('⏭', last, 'End'),
      ...['preflop', 'flop', 'turn', 'river'].filter((s) => streetStart(s) >= 0).map((s) => ctrl(STREET_NAMES[s], streetStart(s), `Jump to the ${s}`)),
    ]);

    // Table picture.
    const boards = atEnd && hand.boards ? hand.boards : [boardCards];
    const tablePanel = el('div', { class: 'panel rv-felt' }, [
      el('div', { class: 'rv-board' }, [
        ...boards.map((b, i) => el('div', { class: 'rv-board-row' }, [hand.boards && atEnd ? el('span', { class: 'small muted', text: `Run ${i + 1}` }) : null, b.length ? cardsRow(b) : el('span', { class: 'muted small', text: 'No board yet' })])),
        el('div', { class: 'rv-pot', text: `Pot ${bb(pot)}${prev && prev.pots.length > 1 && !atEnd ? ` (${prev.pots.map((p) => bb(p.amount)).join(' + ')})` : ''}` }),
      ]),
      el('div', { class: 'rv-seats' }, table.map((p) => seatBox(p, hand, { actor: next?.actor, showCards: atEnd }))),
      el('p', { class: 'rv-next', text: next ? `${STREET_NAMES[next.street]}: ${next.actor === hand.hero ? 'Hero' : next.actor} to act${next.callAmount ? `, ${bb(next.callAmount)} to call` : ''}` : 'Hand over.' }),
      controls,
    ]);

    // Action log.
    const log = el(
      'ol',
      { class: 'rv-log' },
      hand.actions.map((a, i) => {
        const si = states.findIndex((s) => s.actionIndex === i);
        const cls = si >= 0 && si === step - 1 ? 'done current' : si >= 0 && si < step - 1 ? 'done' : si === step ? 'next' : '';
        const li = el('li', { class: `${cls}${a.player === hand.hero ? ' hero' : ''}${a.type === 'post' ? ' post' : ''}` }, [
          el('span', { class: 'rv-log-street', text: a.street === 'preflop' ? '' : a.street[0].toUpperCase() }),
          `${a.player === hand.hero ? 'Hero' : a.player} ${describeAction(a, hand)}`,
          current.flags.some((f) => f.actionIndex === i) ? el('span', { class: 'badge bad rv-mini', text: '!' }) : null,
        ]);
        if (si >= 0) li.addEventListener('click', () => go(si));
        return li;
      }),
    );
    const outcome = atEnd
      ? el('div', { class: 'rv-outcome' }, [
          ...hand.collected.map((c) => el('p', { class: 'small', text: `${c.player === hand.hero ? 'Hero' : c.player} collects ${bb(c.amount)}${c.run ? ` (run ${c.run})` : ''}` })),
          hand.rake ? el('p', { class: 'small muted', text: `Rake ${bb(hand.rake)}` }) : null,
        ])
      : null;
    const logPanel = el('div', { class: 'panel rv-log-panel' }, [el('h3', { text: 'Actions' }), log, outcome]);

    const parts = [header, el('div', { class: 'rv-hand-grid' }, [tablePanel, logPanel])];
    if (hand.problems?.length) parts.push(el('div', { class: 'panel rv-problems' }, [el('h3', { text: 'Parser notes' }), el('ul', {}, hand.problems.map((p) => el('li', { class: 'small', text: p })))]));
    if (next?.isHero) parts.push(analysisPanel(next));
    else if (!atEnd) parts.push(el('p', { class: 'muted small rv-hint', text: 'Step to one of your decisions (or click it in the action list) to see the numbers.' }));
    parts.push(flagsPanel(), notesPanel());
    handView.replaceChildren(...parts);
  }

  function analysisPanel(s) {
    const hand = current.rec;
    const an = current.analyses.get(s.actionIndex);
    const bb = (x) => bbText(toBB(x, hand));
    const panel = el('div', { class: 'panel rv-analysis' });
    const range = rangeFor(hand, s);
    const live = s.live;
    const villainSelect = el('select', { 'aria-label': 'Villain' }, [
      ...(s.street === 'preflop' && !s.facing ? [el('option', { value: '', text: 'Nobody yet (an open)' })] : []),
      ...live.map((n) => {
        const p = hand.players.find((x) => x.name === n);
        return el('option', { value: n, text: `${p.position ?? ''} ${n}` });
      }),
    ]);
    villainSelect.value = range.villain ?? '';
    const heroMove = `${STREET_NAMES[s.street]}, pot ${bb(s.pot)}${s.callAmount ? `, ${bb(s.callAmount)} to call` : ''}. You ${describeAction(s.action, hand, true)}.`;
    const rows = [];
    const row = (label, value, note) => rows.push(el('div', { class: 'rv-num' }, [el('span', { class: 'muted small', text: label }), el('strong', { text: value }), note ? el('span', { class: 'small muted', text: note }) : null]));
    if (!an) row('Analysis', 'Calculating…');
    else {
      if (an.equity !== null) row('Equity vs range', pct(an.equity, 1), an.villain ? `vs ${an.villain}` : '');
      if (an.requiredEquity !== null) row('Required equity', pct(an.requiredEquity, 1), `${bb(s.callAmount)} to win ${bb(s.pot)}`);
      if (an.callEV !== null) row('Call EV', `${signed(an.callEV, 2)} bb`, 'vs folding');
      if (an.mdf !== null) row('MDF', pct(an.mdf, 0), 'defend this often vs a pure bluff');
      if (an.breakEvenFoldFreq !== null) row('Break-even folds', pct(an.breakEvenFoldFreq, 0), 'a pure bluff needs this');
      if (an.betEV !== null) row(s.action.type === 'raise' ? 'Raise EV' : 'Bet EV', `${signed(an.betEV, 2)} bb`, `at ${pct(an.foldFreq, 0)} folds`);
      row('Effective stack', bb(s.effectiveStack), s.spr !== null ? `SPR ${fmt(s.spr, 1)}` : '');
      if (an.icm) {
        row('ICM required equity', pct(an.icm.requiredEquity, 1), `chip EV ${pct(an.icm.chipRequiredEquity, 1)}`);
        row('Risk premium', pct(an.icm.riskPremium, 1), an.icm.pko ? 'bounties included' : '');
      }
      if (an.nash) {
        const nashMove = an.nash.action === 'fold' ? 'fold' : an.nash.open ? 'jam' : 'call';
        row('Nash', nashMove, `${pct(an.nash.frequency, 0)} ${an.nash.open ? 'jam' : 'call'} · gap ${signed(an.nash.evGap, 2)} ${an.nash.unit}${an.nash.mode !== 'chipEV' ? ` (${an.nash.mode})` : ''}`);
      }
    }
    const numbers = el('div', { class: 'rv-nums' }, rows);
    const notes = an?.notes?.length ? el('ul', { class: 'rv-notes-list' }, an.notes.map((n) => el('li', { class: 'small muted', text: n }))) : null;

    // Fold-frequency slider for bets and raises.
    let foldControl = null;
    if (s.action.type === 'bet' || s.action.type === 'raise') {
      const slider = el('input', { type: 'range', min: '0', max: '100', step: '5', value: String(Math.round((current.foldFreq[s.actionIndex] ?? 0.4) * 100)), 'aria-label': 'Villain folds' });
      const out = el('output', { text: `${slider.value}%` });
      slider.addEventListener('input', () => (out.textContent = `${slider.value}%`));
      slider.addEventListener('change', () => {
        current.foldFreq[s.actionIndex] = Number(slider.value) / 100;
        rerun(s);
      });
      foldControl = el('label', { class: 'field rv-fold' }, [el('span', { text: 'Villain folds' }), el('div', { class: 'rv-row' }, [slider, out])]);
    }

    // Villain range: the default (chart or table) until the user edits it.
    const source = range.source === 'user' ? 'your range' : range.source === 'chart' ? 'default, from the baseline chart' : 'default, from the review table';
    const rangeLabel = el('p', { class: 'small muted', text: range.villain ? `${range.label} (${source}). After the flop, narrow it to the hands villain would play this way.` : 'Pick a player behind to see your equity if they continue.' });
    const grid = range.range ? createRangeGrid({ range: range.range, onChange: debounce((r) => saveRange(s, villainSelect.value, rangeToString(r)), 400) }) : null;
    const reset = el('button', { type: 'button', class: 'small', text: 'Reset to default', hidden: range.source !== 'user' });
    reset.addEventListener('click', () => saveRange(s, villainSelect.value, null));
    villainSelect.addEventListener('change', () => saveRange(s, villainSelect.value || null, null, true));

    panel.append(
      el('h3', { text: 'Your decision' }),
      el('p', { text: heroMove }),
      numbers,
      notes ?? '',
      el('div', { class: 'rv-range' }, [el('div', { class: 'icm-row' }, [field('Villain', villainSelect), foldControl ?? '', reset]), rangeLabel, grid ?? '']),
    );
    return panel;
  }

  async function saveRange(s, villain, range, villainChanged = false) {
    const hand = current.rec;
    const ranges = { ...(hand.ranges ?? {}) };
    // A new villain starts from their default range.
    // Resetting keeps the chosen villain and goes back to their default range.
    ranges[s.actionIndex] = { villain, range: villainChanged ? null : range };
    hand.ranges = ranges;
    const db = await getDB();
    await db.update(hand.id, { ranges });
    await rerun(s);
  }

  async function rerun(s) {
    const hand = current.rec;
    const r = rangeFor(hand, s);
    current.analyses.delete(s.actionIndex);
    renderHand();
    const an = await analyseDecision(s, { hand, villain: r.villain, villainRange: r.range, foldFreq: current.foldFreq[s.actionIndex] ?? 0.4 });
    if (current?.rec !== hand) return;
    current.analyses.set(s.actionIndex, { ...an, villainRange: r.range, rangeLabel: r.label, rangeSource: r.source === 'user' ? 'user' : 'default', rangeFrom: r.source });
    current.flags = detectLeaks(hand, current.states, [...current.analyses.values()]);
    const db = await getDB();
    await db.update(hand.id, { flags: current.flags });
    renderHand();
  }

  function flagsPanel() {
    const flags = current.flags;
    const panel = el('div', { class: 'panel rv-flags' }, [el('h3', { text: flags.length ? `Flags (${flags.length})` : 'Flags' })]);
    if (!flags.length) {
      panel.append(el('p', { class: 'muted small', text: current.analysed ? 'No leaks flagged in this hand.' : 'Checking…' }));
      return panel;
    }
    for (const f of flags) {
      const si = current.states.findIndex((s) => s.actionIndex === f.actionIndex);
      const b = el('button', { type: 'button', class: 'rv-flag', title: 'Go to this decision' }, [
        el('span', { class: `badge ${f.severity === 'low' ? 'neutral' : 'bad'}`, text: `${f.severity} · ${f.type}` }),
        el('span', { class: 'small', text: ` ${STREET_NAMES[f.street]}: ${f.message}` }),
      ]);
      b.addEventListener('click', () => {
        current.step = Math.max(0, si);
        renderHand();
      });
      panel.append(b);
    }
    return panel;
  }

  function notesPanel() {
    const hand = current.rec;
    const notes = el('textarea', { rows: 3, value: hand.notes ?? '', placeholder: 'Your notes on this hand…', 'aria-label': 'Notes' });
    const tags = el('input', { value: (hand.tags ?? []).join(', '), placeholder: 'e.g. 3-bet pot, tilt, cooler', 'aria-label': 'Tags' });
    const status = el('span', { class: 'small muted', role: 'status' });
    const persistNotes = debounce(async () => {
      const db = await getDB();
      hand.notes = notes.value;
      hand.tags = [...new Set(tags.value.split(',').map((t) => t.trim()).filter(Boolean))];
      await db.update(hand.id, { notes: hand.notes, tags: hand.tags });
      status.textContent = 'Saved';
    }, 400);
    notes.addEventListener('input', () => {
      status.textContent = '';
      persistNotes();
    });
    tags.addEventListener('change', persistNotes);
    return el('div', { class: 'panel rv-notes' }, [el('h3', { text: 'Notes and tags' }), notes, field('Tags (comma separated)', tags), status]);
  }

  // -- session ------------------------------------------------------------------
  const sessionView = el('div', { class: 'rv-session', hidden: true });
  function renderSession() {
    const hands = listed;
    if (!hands.length) {
      sessionView.replaceChildren(el('div', { class: 'panel' }, [el('p', { class: 'muted', text: 'No hands match the current filters.' })]));
      return;
    }
    const s = sessionStats(hands);
    const flags = detectSessionLeaks(hands);
    const stat = (label, value) => el('div', { class: 'stat' }, [el('span', { text: label }), el('strong', { text: value })]);
    const positions = Object.entries(s.byPosition).sort((a, b) => POSITIONS.indexOf(a[0]) - POSITIONS.indexOf(b[0]));
    sessionView.replaceChildren(
      el('div', { class: 'panel' }, [
        el('h3', { text: 'Session' }),
        el('p', { class: 'muted small', text: 'Over the hands matching the filters on the Hands view.' }),
        el('div', { class: 'rv-stats' }, [
          stat('Hands', String(s.hands)),
          stat('VPIP', pct(s.vpip, 0)),
          stat('PFR', pct(s.pfr, 0)),
          stat('3-bet', s.threeBetChances ? pct(s.threeBet, 0) : '–'),
          stat('Aggression', pct(s.aggression, 0)),
          stat('Net', `${signed(s.netBB, 1)} bb`),
          stat('bb/100', signed(s.bbPer100, 1)),
        ]),
        el('div', { class: 'table-wrap' }, [
          el('table', { class: 'rv-table' }, [
            el('thead', {}, [el('tr', {}, ['Position', 'Hands', 'VPIP', 'Net bb'].map((h) => el('th', { text: h })))]),
            el('tbody', {}, positions.map(([pos, v]) => el('tr', {}, [el('td', { text: pos }), el('td', { text: String(v.hands) }), el('td', { text: pct(v.vpip, 0) }), el('td', { class: v.netBB > 0 ? 'rv-win' : v.netBB < 0 ? 'rv-loss' : '', text: signed(v.netBB, 1) })]))),
          ]),
        ]),
      ]),
      el('div', { class: 'panel rv-flags' }, [
        el('h3', { text: 'Session flags' }),
        ...(flags.length
          ? flags.map((f) => {
              const b = el('button', { type: 'button', class: 'rv-flag' }, [el('span', { class: 'badge bad', text: `${f.severity} · ${f.type}` }), el('span', { class: 'small', text: ` ${f.message}` })]);
              b.addEventListener('click', () => openHand(f.handId));
              return b;
            })
          : [el('p', { class: 'muted small', text: 'Nothing flagged. These look for tilt after a big loss (a pot of 30 bb or more), so they need a few dozen hands to say anything.' })]),
      ]),
    );
  }

  // -- views --------------------------------------------------------------------
  function showView() {
    const view = state.view;
    listView.hidden = view !== 'hands';
    sessionView.hidden = view !== 'session';
    handView.hidden = view !== 'hand';
    toolbar.hidden = view === 'hand';
    importPanel.hidden = importPanel.hidden || view === 'hand';
    viewButtons.forEach((b, i) => b.setAttribute('aria-pressed', String(['hands', 'session'][i] === view)));
    if (view === 'session') renderSession();
  }

  const section = el('section', { class: 'rv' }, [el('h2', { text: 'Hand review' }), intro, storageNote, toolbar, importPanel, manualBox, listView, sessionView, handView]);
  // Arrow keys step through the hand; the listener goes away with the tab.
  const onKey = (e) => {
    if (!section.isConnected) {
      document.removeEventListener('keydown', onKey);
      return;
    }
    if (state.view !== 'hand' || !current || ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
    const moves = { ArrowLeft: current.step - 1, ArrowRight: current.step + 1, Home: 0, End: current.states.length };
    if (e.key in moves) {
      e.preventDefault();
      current.step = Math.max(0, Math.min(current.states.length, moves[e.key]));
      renderHand();
    }
  };
  document.addEventListener('keydown', onKey);

  root.append(section);
  if (state.view === 'hand') state.view = 'hands';
  showView();
  refreshList();
}
