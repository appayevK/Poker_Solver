// Flop tab: study the pre-solved flop library (TexasSolver). Explore any board, see
// texture reports with takeaways, and train flop decisions.
import { loadIndex, loadFlop, strategyFor } from '../../flops/library.js';
import { textureReport, takeaways, RARE_LINE } from '../../flops/reports.js';
import { dealFlopQuestion, scoreFlopAnswer, updateFlopStats } from '../../flops/flop-trainer.js';
import { textureLabel, TEXTURE_GROUPS } from '../../flops/texture.js';
import { accuracy } from '../../preflop/trainer.js';
import { createMixGrid, actionColor } from '../mix-grid.js';
import { parseCards, cardToString } from '../../engine/cards.js';
import { comboClass } from '../../engine/ranges.js';
import { createRng, randomSeed } from '../../engine/rng.js';
import { el, field, pct } from '../dom.js';
import { load, save } from '../../storage/store.js';

const STORAGE_KEY = 'flopTab';
const STATS_KEY = 'flopTrainer:stats';
const SUIT_SYMBOLS = { s: '♠', h: '♥', d: '♦', c: '♣' };

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function cardFace(card) {
  const s = cardToString(card);
  return el('span', { class: `card suit-${s[1]}`, text: `${s[0]}${SUIT_SYMBOLS[s[1]]}`, 'aria-label': s });
}

function mixBar(actions, freqs) {
  return el(
    'div',
    { class: 'fl-bar' },
    actions.map((a, i) => {
      const seg = el('span', { title: `${a.label} ${pct(freqs[i], 0)}` });
      seg.style.width = `${freqs[i] * 100}%`;
      seg.style.background = actionColor(a);
      return seg;
    }),
  );
}

function legend(actions, freqs) {
  return el(
    'div',
    { class: 'fl-legend' },
    actions.map((a, i) => {
      const sw = el('span', { class: 'swatch' });
      sw.style.background = actionColor(a);
      return el('span', { class: 'fl-legend-item' }, [sw, el('span', { text: `${a.label} ${freqs ? pct(freqs[i], 0) : ''}` })]);
    }),
  );
}

export function renderFlopTab(root) {
  const saved = load(STORAGE_KEY, null);
  const state = { view: 'explore', spotId: null, board: '', nodeId: 'ip-vs-check', reportNode: 'ip-vs-check', trainerSpot: 'all', ...(saved ?? {}) };
  const persist = () => save(STORAGE_KEY, state);
  let index = null;

  const intro = el('p', {
    class: 'muted',
    text: 'Flop strategies pre-solved with TexasSolver (turn and river are solved underneath but not shown). They are only as good as the baseline preflop ranges they come from.',
  });
  const viewButtons = ['explore', 'reports', 'trainer'].map((view) => {
    const b = el('button', { type: 'button', text: view[0].toUpperCase() + view.slice(1) });
    b.addEventListener('click', () => {
      state.view = view;
      persist();
      renderView();
    });
    return b;
  });
  const spotSelect = el('select', { 'aria-label': 'Spot' });
  const emptyNote = el('div', { class: 'panel' });

  // -- explore ------------------------------------------------------------------
  const boardInput = el('input', { value: state.board, placeholder: 'e.g. Ks9h4h', spellcheck: false, 'aria-label': 'Flop' });
  const solvedSelect = el('select', { 'aria-label': 'Solved flops' });
  const status = el('p', { class: 'fl-status' });
  const boardCards = el('div', { class: 'tr-cards' });
  const nodeRow = el('div', { class: 'fl-nodes' });
  const summary = el('div', { class: 'fl-summary' });
  const comboPanel = el('div', { class: 'fl-combos' });
  const grid = createMixGrid({ onSelect: (cls) => showClass(cls) });
  let current = null;

  const explore = el('div', { class: 'fl-explore' }, [
    el('div', { class: 'panel' }, [
      el('div', { class: 'icm-row' }, [field('Flop', boardInput), field('Solved flops', solvedSelect)]),
      boardCards,
      status,
      nodeRow,
    ]),
    el('div', { class: 'fl-main' }, [
      el('div', { class: 'panel' }, [summary, grid]),
      el('div', { class: 'panel' }, [el('h3', { text: 'Combos' }), comboPanel]),
    ]),
  ]);

  function showClass(cls) {
    if (!current) return;
    grid.setHighlight(cls);
    const rows = [...current.combos.entries()].filter(([, { cards }]) => comboClass(cards[0], cards[1]) === cls);
    if (!rows.length) {
      comboPanel.replaceChildren(el('p', { class: 'muted', text: `${cls}: not in range here.` }));
      return;
    }
    comboPanel.replaceChildren(
      el('p', { class: 'small muted', text: `${cls}: each combo in the real suits of this board. Flush draws and blockers can play differently.` }),
      ...rows.map(([key, { cards, freqs, weight }]) =>
        el('div', { class: 'fl-combo' }, [
          el('span', { class: 'fl-combo-cards' }, cards.map(cardFace)),
          mixBar(current.actions, freqs),
          el('span', { class: 'small', text: current.actions.map((a, i) => (freqs[i] > 0.005 ? `${a.label.replace(/ \(.*\)$/, '')} ${pct(freqs[i], 0)}` : '')).filter(Boolean).join(', ') + (weight < 0.999 ? ` (in range ${pct(weight, 0)})` : '') }),
        ]),
      ),
    );
  }

  async function renderExplore() {
    const spot = index.spots.find((s) => s.id === state.spotId);
    solvedSelect.replaceChildren(
      el('option', { value: '', text: spot?.flops.length ? `${plural(spot.flops.length, 'solved flop')}…` : 'none solved yet' }),
      ...TEXTURE_GROUPS.map((g) => {
        const flops = (spot?.flops ?? []).filter((f) => f.group === g);
        return flops.length ? el('optgroup', { label: g }, flops.map((f) => el('option', { value: f.key, text: `${f.key} · ${f.label}` }))) : null;
      }).filter(Boolean),
    );
    let cards;
    try {
      cards = parseCards(state.board);
      if (cards.length !== 3) throw new Error('Enter three cards, e.g. Ks9h4h');
    } catch (err) {
      status.textContent = state.board ? err.message : 'Enter a flop or pick a solved one.';
      boardCards.replaceChildren();
      current = null;
      return;
    }
    boardCards.replaceChildren(...cards.map(cardFace));
    current = await strategyFor(state.spotId, cards, state.nodeId);
    if (!current) {
      status.textContent = 'No solved flops for this spot yet.';
      return;
    }
    if (!current.nodes.some((n) => n.id === state.nodeId)) state.nodeId = current.node.id;
    const data = await loadFlop(state.spotId, current.flop);
    const solve = data?.solve ? ` Solved in ${data.solve.iterations} iterations to ${data.solve.exploitability}% of the pot (tree "${data.solve.tree}").` : '';
    status.textContent = current.exact
      ? `Exact solve of this flop (${textureLabel(cards)}).${solve}`
      : `Nearest solved flop: ${current.flop} (${current.label}), suits mapped to your board. Not an exact solve.${solve}`;
    nodeRow.replaceChildren(
      ...current.nodes.map((n) => {
        const rare = n.line < RARE_LINE;
        const b = el('button', { type: 'button', class: `pos-chip${rare ? ' rare' : ''}`, text: n.label, title: `Comes up ${pct(n.line, 0)} of the time on this flop`, 'aria-pressed': String(n.id === current.node.id) });
        b.addEventListener('click', () => {
          state.nodeId = n.id;
          persist();
          renderExplore();
        });
        return b;
      }),
    );
    const reached =
      current.line >= 0.995
        ? null
        : el('p', {
            class: `fl-line${current.line < RARE_LINE ? ' rare' : ''}`,
            text:
              current.line < RARE_LINE
                ? `${current.line < 0.0005 ? 'Almost never comes up' : `Comes up only ${pct(current.line, 1)} of the time`} on this flop, so the solver barely tested this mix: don't read much into it.`
                : `Comes up ${pct(current.line, 0)} of the time on this flop.`,
          });
    summary.replaceChildren(el('h3', { text: current.node.label }), ...(reached ? [reached] : []), mixBar(current.actions, current.summary), legend(current.actions, current.summary));
    grid.setData({ actions: current.actions.map((a) => ({ ...a, color: actionColor(a) })), classes: current.classes, weights: current.classWeights });
    grid.setHighlight(null);
    comboPanel.replaceChildren(el('p', { class: 'muted', text: 'Click a hand on the grid to see its combos.' }));
  }

  boardInput.addEventListener('change', () => {
    state.board = boardInput.value.trim();
    persist();
    renderExplore();
  });
  solvedSelect.addEventListener('change', () => {
    if (!solvedSelect.value) return;
    state.board = solvedSelect.value;
    boardInput.value = state.board;
    persist();
    renderExplore();
  });

  // -- reports -------------------------------------------------------------------
  const reportNodeSelect = el('select', { 'aria-label': 'Decision' });
  const reportBody = el('div', { class: 'fl-report' });
  const reports = el('div', { class: 'panel' }, [el('div', { class: 'icm-row' }, [field('Decision', reportNodeSelect)]), reportBody]);

  function renderReports() {
    const spot = index.spots.find((s) => s.id === state.spotId);
    const nodes = new Map();
    for (const f of spot?.flops ?? []) for (const n of f.nodes) if (!nodes.has(n.id) && n.actions.length > 1) nodes.set(n.id, n.label.replace(/ \([\d.]+bb\)$/, ''));
    reportNodeSelect.replaceChildren(...[...nodes].map(([id, label]) => el('option', { value: id, text: label })));
    if (!nodes.has(state.reportNode)) state.reportNode = nodes.keys().next().value;
    reportNodeSelect.value = state.reportNode ?? '';
    if (!state.reportNode) {
      reportBody.replaceChildren(el('p', { class: 'muted', text: 'No solved flops for this spot yet.' }));
      return;
    }
    const report = textureReport(index, state.spotId, state.reportNode);
    const actorNode = spot.flops.flatMap((f) => f.nodes).find((n) => n.id === state.reportNode);
    const actor = actorNode.player === 'oop' ? spot.oop : spot.ip;
    const header = el('tr', {}, [el('th', { text: 'Texture' }), el('th', { text: 'Boards' }), el('th', { text: 'Comes up' }), ...report.actions.map((a) => el('th', { text: a.label })), el('th', { text: 'Mix' })]);
    const row = (name, share, flops, reach, freqs, cls = '') =>
      el('tr', { class: `${cls}${reach < RARE_LINE ? ' rare' : ''}`.trim() }, [
        el('td', { text: name }),
        el('td', { text: `${pct(share, 0)} (${flops})` }),
        el('td', { text: pct(reach, 0) }),
        ...report.actions.map((a) => el('td', { text: pct(freqs[a.key] ?? 0, 0) })),
        el('td', {}, [mixBar(report.actions, report.actions.map((a) => freqs[a.key] ?? 0))]),
      ]);
    const lines = takeaways(report, actor);
    reportBody.replaceChildren(
      el('ul', { class: 'fl-takeaways' }, lines.map((l) => el('li', { text: l }))),
      el('div', { class: 'table-wrap' }, [
        el('table', { class: 'fl-table' }, [
          el('thead', {}, [header]),
          el('tbody', {}, [...report.rows.map((r) => row(r.group, r.share, r.flops, r.reach, r.freqs)), row('All boards', 1, report.overall.flops, report.overall.reach, report.overall.freqs, 'total')]),
        ]),
      ]),
      el('p', {
        class: 'muted small',
        text: `Weighted by how often each texture comes up and how often this decision comes up on it (greyed rows: under ${pct(RARE_LINE, 0)}). Based on ${report.overall.flops} solved flop${report.overall.flops === 1 ? '' : 's'}${report.overall.flops < 30 ? ': patterns become reliable once the full library is solved' : ''}.`,
      }),
    );
  }

  reportNodeSelect.addEventListener('change', () => {
    state.reportNode = reportNodeSelect.value;
    persist();
    renderReports();
  });

  // -- trainer --------------------------------------------------------------------
  const rng = createRng(randomSeed());
  const trainerSpot = el('select', { 'aria-label': 'Spots to train' });
  const question = el('div', { class: 'fl-question' });
  const answerRow = el('div', { class: 'tr-buttons' });
  const feedback = el('div', { class: 'tr-feedback', 'aria-live': 'polite' });
  const nextBtn = el('button', { type: 'button', class: 'primary', text: 'Next (Enter)' });
  const statsEl = el('div', { class: 'tr-stats' });
  const trainer = el('div', {}, [
    el('div', { class: 'panel tr-main' }, [el('div', { class: 'icm-row' }, [field('Spots', trainerSpot)]), question, answerRow, feedback, nextBtn]),
    el('div', { class: 'panel' }, [el('h3', { text: 'Stats' }), statsEl]),
  ]);
  let q = null;
  let answered = false;

  function renderStats() {
    const stats = load(STATS_KEY, {});
    const table = (title, rows) =>
      rows.length
        ? el('div', {}, [
            el('h4', { text: title }),
            el('table', { class: 'tr-stats-table' }, [
              el('tbody', {}, rows.map(([k, s]) => el('tr', {}, [el('td', { text: k }), el('td', { text: plural(s.attempts, 'hand') }), el('td', { text: pct(accuracy(s), 0) })]))),
            ]),
          ])
        : '';
    const spotName = (id) => index.spots.find((s) => s.id === id)?.label ?? id;
    statsEl.replaceChildren(
      table('By spot', Object.entries(stats.spots ?? {}).map(([k, s]) => [spotName(k), s])),
      table('By texture', Object.entries(stats.groups ?? {})),
      Object.keys(stats.spots ?? {}).length ? '' : el('p', { class: 'muted', text: 'No answers yet.' }),
    );
  }

  async function deal() {
    feedback.replaceChildren();
    nextBtn.hidden = true;
    answered = false;
    try {
      q = await dealFlopQuestion(index, loadFlop, { rng, spots: state.trainerSpot === 'all' ? undefined : [state.trainerSpot] });
    } catch (err) {
      question.replaceChildren(el('p', { class: 'muted', text: err.message }));
      answerRow.replaceChildren();
      return;
    }
    question.replaceChildren(
      el('p', { class: 'tr-story', text: `${q.spot.label}: ${q.spot.preflop}. ${q.node.label}.` }),
      el('div', { class: 'tr-cards' }, q.board.map(cardFace)),
      el('p', { class: 'small muted', text: `Your hand (${q.node.player === 'oop' ? q.spot.oop : q.spot.ip}):` }),
      el('div', { class: 'tr-cards' }, q.hand.map(cardFace)),
    );
    answerRow.replaceChildren(
      ...q.actions.map((a, i) => {
        const b = el('button', { type: 'button', class: 'tr-action', text: `${a.label} (${i + 1})` });
        b.style.borderColor = actionColor(a);
        b.addEventListener('click', () => answer(i));
        return b;
      }),
    );
  }

  function answer(i) {
    if (!q || answered) return;
    answered = true;
    const r = scoreFlopAnswer(q, i);
    save(STATS_KEY, updateFlopStats(load(STATS_KEY, {}), q, r.verdict));
    const mix = q.actions.map((a, k) => (q.frequencies[k] > 0.005 ? `${a.label} ${pct(q.frequencies[k], 0)}` : '')).filter(Boolean).join(' · ');
    feedback.replaceChildren(
      el('div', { class: `badge ${r.verdict === 'correct' ? 'good' : r.verdict === 'acceptable' ? 'neutral' : 'bad'}`, text: { correct: 'Correct', acceptable: 'Acceptable (mixed)', wrong: 'Wrong' }[r.verdict] }),
      el('p', { text: `Solver with ${q.handText} on ${q.label}: ${mix}.` }),
      mixBar(q.actions, q.frequencies),
    );
    for (const b of answerRow.querySelectorAll('button')) b.disabled = true;
    nextBtn.hidden = false;
    renderStats();
  }

  nextBtn.addEventListener('click', deal);
  trainerSpot.addEventListener('change', () => {
    state.trainerSpot = trainerSpot.value;
    persist();
    deal();
  });
  const onKey = (e) => {
    if (!trainer.isConnected) {
      document.removeEventListener('keydown', onKey);
      return;
    }
    if (state.view !== 'trainer' || e.target.matches?.('input, select, textarea')) return;
    const n = Number(e.key);
    if (!answered && n >= 1 && q && n <= q.actions.length) {
      e.preventDefault();
      answer(n - 1);
    } else if (answered && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      deal();
    }
  };
  document.addEventListener('keydown', onKey);

  // -- layout ----------------------------------------------------------------------
  const section = el('section', { class: 'flop-tab' }, [
    el('h2', { text: 'Flop library' }),
    intro,
    el('div', { class: 'icm-row' }, [field('Spot', spotSelect), el('div', { class: 'segmented', role: 'group', 'aria-label': 'View' }, viewButtons)]),
    emptyNote,
    explore,
    reports,
    trainer,
  ]);
  root.append(section);

  spotSelect.addEventListener('change', () => {
    state.spotId = spotSelect.value;
    persist();
    renderView();
  });

  function renderView() {
    viewButtons.forEach((b, i) => b.setAttribute('aria-pressed', String(['explore', 'reports', 'trainer'][i] === state.view)));
    const hasData = index.spots.some((s) => s.flops.length);
    emptyNote.hidden = hasData;
    explore.hidden = !hasData || state.view !== 'explore';
    reports.hidden = !hasData || state.view !== 'reports';
    trainer.hidden = !hasData || state.view !== 'trainer';
    if (!hasData) return;
    if (state.view === 'explore') renderExplore();
    else if (state.view === 'reports') renderReports();
    else {
      renderStats();
      deal();
    }
  }

  loadIndex().then((idx) => {
    index = idx;
    const withData = index.spots.filter((s) => s.flops.length);
    spotSelect.replaceChildren(...index.spots.map((s) => el('option', { value: s.id, text: `${s.label} (${plural(s.flops.length, 'flop')})` })));
    if (!index.spots.some((s) => s.id === state.spotId)) state.spotId = (withData[0] ?? index.spots[0])?.id ?? null;
    spotSelect.value = state.spotId ?? '';
    trainerSpot.replaceChildren(el('option', { value: 'all', text: 'All spots' }), ...withData.map((s) => el('option', { value: s.id, text: s.label })));
    trainerSpot.value = withData.some((s) => s.id === state.trainerSpot) ? state.trainerSpot : 'all';
    if (!state.board) state.board = withData[0]?.flops[0]?.key ?? '';
    boardInput.value = state.board;
    emptyNote.replaceChildren(
      el('h3', { text: 'No solved flops yet' }),
      el('p', { text: 'Install TexasSolver, set TEXASSOLVER_PATH, then run npm run flops:bench (one flop per spot) or npm run flops:all (the whole library, overnight). See the README.' }),
    );
    renderView();
  });
}
