// Ranges tab: preflop cash charts (6-max 100bb), chart editor, compare, range checks
// and the preflop trainer.
import {
  listCharts,
  loadChart,
  saveChart,
  deleteChart,
  duplicateChart,
  isBuiltIn,
  validateChart,
  chartWarnings,
  parseSpotId,
  spotIdProblem,
  describeSpot,
  raiseLabel,
  spotFrequencies,
  spotRange,
  setSpotAction,
  diffCharts,
  continueRange,
  POSITIONS,
  ACTIONS,
  BASELINE_ID,
} from '../../preflop/charts.js';
import { defendCheck, bluffCheck, blockerEffect, spotSizes } from '../../preflop/checks.js';
import { createActionGrid } from '../action-grid.js';
import { createTrainerView } from '../trainer-view.js';
import { runEquity } from '../../workers/client.js';
import { rangeToString, handClasses } from '../../engine/ranges.js';
import { el, field, pct, fmt } from '../dom.js';
import { load, save } from '../../storage/store.js';

const STORAGE_KEY = 'rangesTab';
const CLASSES = handClasses();
const COMBOS = CLASSES.map((c) => (c.length === 2 ? 6 : c[2] === 's' ? 4 : 12));
const TYPE_LABELS = { RFI: 'RFI', vsOpen: 'vs open', vs3bet: 'vs 3-bet' };

function actionName(spotId, action) {
  if (action === 'raise') return raiseLabel(spotId);
  if (action === 'call') return parseSpotId(spotId).type === 'RFI' ? 'Limp' : 'Call';
  return action === 'allin' ? 'All-in' : 'Fold';
}

/** Class-level frequencies → range Map (rounded to 4 decimals). */
function freqsToRange(freqs) {
  const range = new Map();
  for (let c = 0; c < 169; c++) {
    const w = Math.round(freqs[c] * 1e4) / 1e4;
    if (w > 0) range.set(CLASSES[c], w);
  }
  return range;
}

function shareOf(freqs) {
  let combos = 0;
  for (let c = 0; c < 169; c++) combos += freqs[c] * COMBOS[c];
  return { combos, share: combos / 1326 };
}

export function renderRangesTab(root) {
  const saved = load(STORAGE_KEY, null);
  const state = {
    view: 'charts',
    chartId: BASELINE_ID,
    spotId: 'RFI:CO',
    editing: false,
    brushAction: 'raise',
    brushFreq: 100,
    compareId: '',
    blockerHand: 'A5s',
    ...(saved && typeof saved === 'object' ? saved : {}),
  };
  const persist = () => save(STORAGE_KEY, state);
  let chart = loadChart(state.chartId) ?? loadChart(BASELINE_ID);
  state.chartId = chart.id;
  if (spotIdProblem(state.spotId)) state.spotId = 'RFI:CO';

  // -- chart bar ------------------------------------------------------------------

  const chartSelect = el('select', { 'aria-label': 'Chart' });
  const nameInput = el('input', { 'aria-label': 'Chart name', spellcheck: false });
  const dupBtn = el('button', { type: 'button', text: 'Duplicate' });
  const deleteBtn = el('button', { type: 'button', text: 'Delete' });
  const importInput = el('input', { type: 'file', accept: '.json,application/json', hidden: true });
  const importBtn = el('button', { type: 'button', text: 'Import JSON' });
  const exportBtn = el('button', { type: 'button', text: 'Export JSON' });
  const chartMsg = el('p', { class: 'rt-msg', role: 'status' });
  const notes = el('p', { class: 'muted small rt-notes' });

  function message(text, isError = false) {
    chartMsg.textContent = text;
    chartMsg.classList.toggle('error', isError);
  }

  function fillChartSelect() {
    chartSelect.replaceChildren(...listCharts().map((c) => el('option', { value: c.id, text: c.builtIn ? `${c.name} (built-in)` : c.name })));
    chartSelect.value = chart.id;
  }

  function selectChart(id) {
    const next = loadChart(id);
    if (!next) return;
    chart = next;
    state.chartId = id;
    state.editing = state.editing && !isBuiltIn(id);
    persist();
    renderAll();
  }

  function persistChart() {
    try {
      saveChart(chart);
      return true;
    } catch (err) {
      message(err.message, true);
      return false;
    }
  }

  chartSelect.addEventListener('change', () => selectChart(chartSelect.value));
  nameInput.addEventListener('change', () => {
    if (isBuiltIn(chart.id)) return;
    chart.name = nameInput.value.trim() || chart.name;
    nameInput.value = chart.name;
    if (persistChart()) {
      fillChartSelect();
      message('Renamed.');
    }
  });
  dupBtn.addEventListener('click', () => {
    const copy = duplicateChart(chart);
    try {
      saveChart(copy);
    } catch (err) {
      message(err.message, true);
      return;
    }
    message(`Saved "${copy.name}". You can rename and edit it.`);
    selectChart(copy.id);
  });
  let deleteArmed = null;
  deleteBtn.addEventListener('click', () => {
    if (isBuiltIn(chart.id)) return;
    if (!deleteArmed) {
      deleteBtn.textContent = 'Click again to delete';
      deleteArmed = setTimeout(() => {
        deleteArmed = null;
        deleteBtn.textContent = 'Delete';
      }, 3000);
      return;
    }
    clearTimeout(deleteArmed);
    deleteArmed = null;
    deleteBtn.textContent = 'Delete';
    const name = chart.name;
    deleteChart(chart.id);
    message(`Deleted "${name}".`);
    selectChart(BASELINE_ID);
  });
  importBtn.addEventListener('click', () => importInput.click());
  importInput.addEventListener('change', async () => {
    const file = importInput.files?.[0];
    importInput.value = '';
    if (!file) return;
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch {
      message(`${file.name} is not valid JSON.`, true);
      return;
    }
    if (data && typeof data === 'object' && (!data.id || isBuiltIn(data.id) || listCharts().some((c) => c.id === data.id))) {
      data = duplicateChart(data, { name: data.name || file.name.replace(/\.json$/i, '') });
    }
    const problems = validateChart(data);
    if (problems.length) {
      message(`Not imported: ${problems.slice(0, 3).join('; ')}${problems.length > 3 ? ` (+${problems.length - 3} more)` : ''}`, true);
      return;
    }
    saveChart(data);
    message(`Imported "${data.name}".`);
    selectChart(data.id);
  });
  exportBtn.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(chart, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: `${chart.name.replace(/[^\w.-]+/g, '-')}.json` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  // -- view switch ----------------------------------------------------------------

  const viewButtons = ['charts', 'trainer'].map((view) => {
    const b = el('button', { type: 'button', text: view === 'charts' ? 'Charts' : 'Trainer' });
    b.addEventListener('click', () => {
      state.view = view;
      persist();
      renderView();
    });
    return b;
  });

  // -- spot picker ----------------------------------------------------------------

  const typeRow = el('div', { class: 'segmented small', role: 'group', 'aria-label': 'Spot type' });
  const heroRow = el('div', { class: 'pos-row' });
  const villainRow = el('div', { class: 'pos-row' });
  const villainLabel = el('span', { class: 'muted small' });

  function validFor(type, hero, villain) {
    const id = type === 'RFI' ? `RFI:${hero}` : `${type}:${hero}:${villain}`;
    return !spotIdProblem(id);
  }

  function pickSpot(type, hero, villain) {
    if (type === 'RFI') state.spotId = `RFI:${hero}`;
    else {
      const candidates = POSITIONS.filter((v) => validFor(type, hero, v));
      const v = candidates.includes(villain) ? villain : candidates[candidates.length - 1] ?? candidates[0];
      state.spotId = `${type}:${hero}:${v}`;
    }
    persist();
    renderSpot();
  }

  function renderPicker() {
    const s = parseSpotId(state.spotId);
    typeRow.replaceChildren(
      ...['RFI', 'vsOpen', 'vs3bet'].map((type) => {
        const b = el('button', { type: 'button', text: TYPE_LABELS[type], 'aria-pressed': String(s.type === type) });
        b.addEventListener('click', () => {
          const heroes = POSITIONS.filter((h) => POSITIONS.some((v) => validFor(type, h, v)));
          pickSpot(type, heroes.includes(s.hero) ? s.hero : heroes[heroes.length - 1], s.villain);
        });
        return b;
      }),
    );
    const chip = (pos, pressed, enabled, onClick) => {
      const b = el('button', { type: 'button', class: 'pos-chip', text: pos, 'aria-pressed': String(pressed), disabled: !enabled });
      b.addEventListener('click', onClick);
      return b;
    };
    heroRow.replaceChildren(
      el('span', { class: 'muted small', text: s.type === 'vs3bet' ? 'Opener (you)' : 'You' }),
      ...POSITIONS.map((pos) =>
        chip(pos, pos === s.hero, POSITIONS.some((v) => validFor(s.type, pos, v)), () => pickSpot(s.type, pos, s.villain)),
      ),
    );
    villainRow.hidden = s.type === 'RFI';
    villainLabel.textContent = s.type === 'vsOpen' ? 'Opener' : '3-bettor';
    villainRow.replaceChildren(
      villainLabel,
      ...POSITIONS.map((pos) => chip(pos, pos === s.villain, validFor(s.type, s.hero, pos), () => pickSpot(s.type, s.hero, pos))),
    );
  }

  // -- grid and legend -----------------------------------------------------------

  const spotTitle = el('h3');
  const sizeNote = el('p', { class: 'muted small' });
  const missingNote = el('p', { class: 'muted small' });
  const grid = createActionGrid({ onChange: (f) => applyFrequencies(f) });
  const legend = el('div', { class: 'rt-legend' });
  const editBtn = el('button', { type: 'button', text: 'Edit' });
  const brushAction = el('select', { 'aria-label': 'Paint action' });
  const brushFreq = el('input', { type: 'range', min: 5, max: 100, step: 5, value: state.brushFreq, 'aria-label': 'Paint frequency' });
  const brushOut = el('output', { class: 'rg-weight' });
  const resetSpotBtn = el('button', { type: 'button', text: 'Reset spot to baseline' });
  const editRow = el('div', { class: 'icm-row rt-edit' }, [
    field('Paint', brushAction),
    el('label', { class: 'rg-slider' }, [el('span', { text: 'Frequency' }), brushFreq, brushOut]),
    resetSpotBtn,
  ]);
  const editMsg = el('div', { class: 'rt-msg' });

  const compareCheck = el('input', { type: 'checkbox', checked: !!state.compareId });
  const compareSelect = el('select', { 'aria-label': 'Chart to compare with' });
  const compareGrid = createActionGrid({});
  const compareList = el('div', { class: 'rt-diff' });
  const comparePanel = el('div', { class: 'rt-compare' }, [el('h4'), compareGrid, compareList]);

  function brushState() {
    grid.setBrush({ action: state.brushAction, frequency: Number(state.brushFreq) / 100 });
    brushOut.textContent = `${state.brushFreq}%`;
  }

  editBtn.addEventListener('click', () => {
    if (isBuiltIn(chart.id)) {
      editMsg.replaceChildren(
        el('span', { text: 'The built-in baseline is read-only. ' }),
        Object.assign(el('button', { type: 'button', class: 'small', text: 'Duplicate and edit' }), {
          onclick: () => {
            state.editing = true;
            dupBtn.click();
          },
        }),
      );
      return;
    }
    state.editing = !state.editing;
    persist();
    renderSpot();
  });
  brushAction.addEventListener('change', () => {
    state.brushAction = brushAction.value;
    persist();
    brushState();
  });
  brushFreq.addEventListener('input', () => {
    state.brushFreq = Number(brushFreq.value);
    persist();
    brushState();
  });
  resetSpotBtn.addEventListener('click', () => {
    const base = loadChart(BASELINE_ID);
    if (!base.spots[state.spotId]) return;
    chart.spots[state.spotId] = JSON.parse(JSON.stringify(base.spots[state.spotId]));
    if (persistChart()) message(`${describeSpot(state.spotId)} reset to the baseline.`);
    renderSpot();
  });
  compareCheck.addEventListener('change', () => {
    state.compareId = compareCheck.checked ? compareSelect.value || BASELINE_ID : '';
    persist();
    renderSpot();
  });
  compareSelect.addEventListener('change', () => {
    state.compareId = compareSelect.value;
    compareCheck.checked = true;
    persist();
    renderSpot();
  });

  /** "Saved." plus the first consistency note, if any (e.g. continuing vs a 3-bet with hands not opened). */
  function savedNote() {
    const warnings = chartWarnings(chart);
    return warnings.length ? `Saved. Note: ${warnings[0]}${warnings.length > 1 ? ` (+${warnings.length - 1} more)` : ''}` : 'Saved.';
  }

  /** Writes class-level frequencies from the painted grid back into the chart. */
  function applyFrequencies(freqs) {
    if (!state.editing || isBuiltIn(chart.id)) return;
    for (const action of ACTIONS) setSpotAction(chart, state.spotId, action, freqsToRange(freqs[action]));
    if (persistChart()) {
      editMsg.textContent = savedNote();
      renderLegend();
      renderChecks();
      renderCompare();
    }
  }

  function renderLegend() {
    const id = state.spotId;
    const f = chart.spots[id] ? spotFrequencies(chart, id) : null;
    const rows = [];
    const actions = ACTIONS.filter((a) => state.editing || (chart.spots[id]?.[a] ?? '') !== '' || (a !== 'allin' && !(a === 'call' && parseSpotId(id).type === 'RFI')));
    for (const action of [...actions, 'fold']) {
      const { combos, share } = f ? shareOf(f[action]) : { combos: action === 'fold' ? 1326 : 0, share: action === 'fold' ? 1 : 0 };
      const text =
        action === 'fold'
          ? el('input', { value: f ? rangeToString(spotRange(chart, id, 'fold')) : 'everything', readOnly: true, 'aria-label': 'Fold range' })
          : el('input', { value: chart.spots[id]?.[action] ?? '', readOnly: !state.editing, spellcheck: false, placeholder: state.editing ? 'e.g. QQ+, AKs' : '', 'aria-label': `${actionName(id, action)} range` });
      if (action !== 'fold' && state.editing) {
        text.addEventListener('change', () => {
          const draft = JSON.parse(JSON.stringify(chart));
          try {
            setSpotAction(draft, id, action, text.value);
          } catch (err) {
            editMsg.textContent = err.message;
            text.classList.add('invalid');
            return;
          }
          const problems = validateChart(draft).filter((p) => p.startsWith(id));
          if (problems.length) {
            editMsg.textContent = problems[0];
            text.classList.add('invalid');
            return;
          }
          text.classList.remove('invalid');
          chart = draft;
          if (persistChart()) editMsg.textContent = savedNote();
          renderSpot();
        });
      }
      rows.push(
        el('div', { class: 'rt-legend-row' }, [
          el('span', { class: `swatch act-${action}` }),
          el('strong', { text: actionName(id, action) }),
          el('span', { class: 'muted small', text: `${pct(share, 1)} · ${fmt(combos, 1)} combos` }),
          text,
        ]),
      );
    }
    legend.replaceChildren(...rows);
  }

  function renderCompare() {
    const others = listCharts().filter((c) => c.id !== chart.id);
    compareSelect.replaceChildren(
      ...(others.length
        ? others.map((c) => el('option', { value: c.id, text: c.builtIn ? `${c.name} (built-in)` : c.name }))
        : [el('option', { value: '', text: 'no other charts yet: duplicate one first' })]),
    );
    compareSelect.disabled = !others.length;
    compareCheck.disabled = !others.length;
    if (!others.some((c) => c.id === state.compareId)) state.compareId = '';
    compareCheck.checked = !!state.compareId;
    const on = !!state.compareId;
    if (state.compareId) compareSelect.value = state.compareId;
    const other = on ? loadChart(compareSelect.value) : null;
    comparePanel.hidden = !other;
    if (!other) {
      grid.setDiff(new Set());
      return;
    }
    const diffs = diffCharts(chart, other, state.spotId);
    const set = new Set(diffs.map((d) => d.handClass));
    grid.setDiff(set);
    compareGrid.setFrequencies(other.spots[state.spotId] ? spotFrequencies(other, state.spotId) : {});
    compareGrid.setDiff(set);
    comparePanel.querySelector('h4').textContent = `${other.name}: ${diffs.length} ${diffs.length === 1 ? 'hand differs' : 'hands differ'}`;
    const describe = (f) =>
      ['raise', 'call', 'allin', 'fold']
        .filter((a) => f[a] > 0.005)
        .map((a) => `${actionName(state.spotId, a).toLowerCase()} ${pct(f[a], 0)}`)
        .join(', ');
    compareList.replaceChildren(
      ...diffs.slice(0, 40).map((d) => el('div', { class: 'small', text: `${d.handClass}: ${describe(d.a)} → ${describe(d.b)}` })),
      diffs.length > 40 ? el('div', { class: 'muted small', text: `…and ${diffs.length - 40} more` }) : '',
    );
  }

  // -- checks ---------------------------------------------------------------------

  const checksEl = el('div', { class: 'rt-checks' });
  let equityRun = 0;

  function renderChecks() {
    const id = state.spotId;
    const s = parseSpotId(id);
    const parts = [];
    if (!chart.spots[id] || s.type === 'RFI') {
      checksEl.replaceChildren(el('p', { class: 'muted', text: s.type === 'RFI' ? 'Checks cover spots facing an open or a 3-bet.' : 'This chart has no ranges for this spot.' }));
      return;
    }
    if (s.type === 'vsOpen') {
      const d = defendCheck(chart, id);
      parts.push(
        el('h4', { text: 'Defence vs MDF' }),
        el('p', {
          text: `${s.villain} opens to ${fmt(d.open)}bb, risking ${fmt(d.bet)}bb to win the ${fmt(d.pot)}bb blinds. MDF: ${pct(d.mdf, 1)}. You continue with ${pct(d.defend, 1)} (3-bet ${pct(d.threeBet, 1)}, call ${pct(d.call, 1)}).`,
        }),
        el('p', {
          class: 'muted small',
          text: `Preflop MDF is only a rough guide: it is shared by every player left to act (${d.playersBehind} behind you), and rake, position and the hands' playability matter more than hitting a number.`,
        }),
      );
      const eqOut = el('p', { class: 'small' });
      const eqBtn = el('button', { type: 'button', class: 'small', text: `Equity vs ${s.villain}'s opening range` });
      eqBtn.addEventListener('click', async () => {
        const run = ++equityRun;
        eqBtn.disabled = true;
        eqOut.textContent = 'Running Monte Carlo…';
        try {
          const result = await runEquity({
            method: 'montecarlo',
            players: [continueRange(chart, id), spotRange(chart, `RFI:${s.villain}`, 'raise')],
            iterations: 100000,
          });
          if (run !== equityRun) return;
          eqOut.textContent = `Your continuing range has ${pct(result.players[0].equity, 1)} equity vs ${s.villain}'s opens (±${pct(result.players[0].stdErr, 1)}, all-in equity before position and playability).`;
        } catch (err) {
          eqOut.textContent = err.message;
        } finally {
          eqBtn.disabled = false;
        }
      });
      if (chart.spots[`RFI:${s.villain}`]) parts.push(eqBtn, eqOut);
    }

    const b = bluffCheck(chart, id);
    const verdict =
      b.opponentFolds === null
        ? `The chart has no ${b.kind === '4-bet' ? 'responses to 4-bets' : `${b.responseSpot} spot`}, so it cannot say how often you get folds.`
        : b.opponentFolds >= b.breakEven
          ? `The chart folds ${pct(b.opponentFolds, 1)} of ${s.villain}'s opens to a 3-bet, more than the ${pct(b.breakEven, 1)} needed: pure bluffs show a profit within this chart.`
          : `The chart folds ${pct(b.opponentFolds, 1)} of ${s.villain}'s opens to a 3-bet, less than the ${pct(b.breakEven, 1)} needed: bluffs rely on their equity when called.`;
    parts.push(
      el('h4', { text: `${b.kind} bluffs` }),
      el('p', { text: `A ${b.kind} to ${fmt(b.size)}bb risks ${fmt(b.risk)}bb to win ${fmt(b.pot)}bb, so a pure bluff needs ${pct(b.breakEven, 1)} folds.` }),
      el('p', { class: 'small', text: verdict }),
    );

    const raiseClasses = CLASSES.filter((_, c) => spotFrequencies(chart, id).raise[c] > 0);
    if (raiseClasses.length) {
      const blockerSelect = el('select', { 'aria-label': 'Blocker hand' }, raiseClasses.map((c) => el('option', { value: c, text: c })));
      if (!raiseClasses.includes(state.blockerHand)) state.blockerHand = raiseClasses.includes('A5s') ? 'A5s' : raiseClasses[raiseClasses.length - 1];
      blockerSelect.value = state.blockerHand;
      const out = el('div', { class: 'small' });
      const show = () => {
        const e = blockerEffect(chart, id, state.blockerHand);
        const lines = [];
        if (e.foldShareWith !== null) {
          lines.push(`With ${e.heroClass}, ${s.villain} folds ${pct(e.foldShareWith, 1)} to your ${b.kind} (${pct(e.foldShareAverage, 1)} on average).`);
        } else {
          lines.push(`${e.heroClass} removes ${pct(Math.max(0, e.rangeRemoved), 1)} of ${s.villain}'s 3-betting range.`);
        }
        if (e.blocks.length) {
          lines.push(
            `It blocks ${e.blocks
              .slice(0, 5)
              .map((x) => `${x.handClass} (${fmt(x.remaining, 1)} of ${x.total} combos left)`)
              .join(', ')}.`,
          );
        }
        out.replaceChildren(...lines.map((t) => el('p', { text: t })));
      };
      blockerSelect.addEventListener('change', () => {
        state.blockerHand = blockerSelect.value;
        persist();
        show();
      });
      show();
      parts.push(el('h4', { text: 'Card removal' }), field('Hand', blockerSelect), out);
    }
    checksEl.replaceChildren(...parts);
  }

  // -- layout -----------------------------------------------------------------------

  const trainer = createTrainerView({ getChart: () => chart, getCurrentSpot: () => state.spotId, state, persist });
  const chartsView = el('div', { class: 'rt-charts' }, [
    el('div', { class: 'panel rt-picker' }, [typeRow, heroRow, villainRow]),
    el('div', { class: 'rt-main' }, [
      el('div', { class: 'panel' }, [
        spotTitle,
        sizeNote,
        missingNote,
        grid,
        legend,
        el('div', { class: 'icm-row' }, [editBtn, el('label', { class: 'check' }, [compareCheck, el('span', { text: 'Compare with' })]), compareSelect]),
        editRow,
        editMsg,
        comparePanel,
      ]),
      el('div', { class: 'panel' }, [el('h3', { text: 'Checks' }), checksEl]),
    ]),
  ]);

  const section = el('section', { class: 'ranges-tab' }, [
    el('h2', { text: 'Ranges' }),
    el('div', { class: 'icm-row rt-chartbar' }, [field('Chart', chartSelect), field('Name', nameInput), dupBtn, deleteBtn, importBtn, exportBtn, importInput]),
    notes,
    chartMsg,
    el('div', { class: 'segmented', role: 'group', 'aria-label': 'View' }, viewButtons),
    chartsView,
    trainer.element,
  ]);
  root.append(section);

  function renderSpot() {
    const id = state.spotId;
    const s = parseSpotId(id);
    renderPicker();
    spotTitle.textContent = describeSpot(id);
    const sizes = spotSizes(chart, id);
    sizeNote.textContent =
      s.type === 'RFI'
        ? `Open to ${fmt(sizes.open)}bb. Fold is everything not shown.`
        : s.type === 'vsOpen'
          ? `${s.villain} opens to ${fmt(sizes.open)}bb; 3-bet to ${fmt(sizes.threeBet)}bb (${sizes.heroInPosition ? 'in position' : 'out of position'}).`
          : `You open to ${fmt(sizes.open)}bb, ${s.villain} 3-bets to ${fmt(sizes.threeBet)}bb; 4-bet to ${fmt(sizes.fourBet)}bb.`;
    missingNote.textContent = chart.spots[id] ? '' : 'This chart has no ranges for this spot yet: everything folds. Paint or type ranges to add it.';
    grid.setFrequencies(chart.spots[id] ? spotFrequencies(chart, id) : {});
    grid.setEditable(state.editing && !isBuiltIn(chart.id));
    editBtn.textContent = state.editing && !isBuiltIn(chart.id) ? 'Done editing' : 'Edit';
    editRow.hidden = !(state.editing && !isBuiltIn(chart.id));
    resetSpotBtn.hidden = isBuiltIn(chart.id) || !loadChart(BASELINE_ID).spots[id];
    brushAction.replaceChildren(...['raise', 'call', 'allin', 'fold'].map((a) => el('option', { value: a, text: actionName(id, a) })));
    brushAction.value = state.brushAction;
    brushState();
    renderLegend();
    renderCompare();
    renderChecks();
  }

  function renderView() {
    viewButtons.forEach((b, i) => b.setAttribute('aria-pressed', String(['charts', 'trainer'][i] === state.view)));
    chartsView.hidden = state.view !== 'charts';
    trainer.element.hidden = state.view !== 'trainer';
    trainer.setActive(state.view === 'trainer');
    if (state.view === 'trainer') trainer.refresh();
  }

  function renderAll() {
    fillChartSelect();
    const builtIn = isBuiltIn(chart.id);
    nameInput.value = chart.name;
    nameInput.readOnly = builtIn;
    deleteBtn.disabled = builtIn;
    notes.textContent = chart.notes || '';
    editMsg.replaceChildren();
    renderSpot();
    renderView();
  }

  renderAll();
}
