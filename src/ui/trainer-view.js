// Trainer view for the Ranges tab: deals spots from a chart and scores answers.
import { nextSpot, scoreAnswer, updateReview, updateStats, accuracy } from '../preflop/trainer.js';
import { POSITIONS, spotFrequencies, describeSpot, raiseLabel, parseSpotId } from '../preflop/charts.js';
import { spotSizes } from '../preflop/checks.js';
import { cardToString } from '../engine/cards.js';
import { createRng, randomSeed } from '../engine/rng.js';
import { createActionGrid } from './action-grid.js';
import { el, field, pct, fmt } from './dom.js';
import { load, save } from '../storage/store.js';

const SUIT_SYMBOLS = { s: '♠', h: '♥', d: '♦', c: '♣' };
const KEYS = { f: 'fold', c: 'call', r: 'raise', a: 'allin' };
const statsKey = (chartId) => `trainer:stats:${chartId}`;

function actionLabel(spotId, action) {
  if (action === 'raise') return raiseLabel(spotId);
  if (action === 'call') return parseSpotId(spotId).type === 'RFI' ? 'Limp' : 'Call';
  return action === 'allin' ? 'All-in' : 'Fold';
}

function cardFace(card) {
  const s = cardToString(card);
  return el('span', { class: `card suit-${s[1]}`, text: `${s[0]}${SUIT_SYMBOLS[s[1]]}`, 'aria-label': s });
}

/** Story of the hand so far, e.g. "UTG opens to 2.5bb, folds to you." */
function storyOf(chart, spot) {
  const sizes = spotSizes(chart, spot.spotId);
  if (spot.type === 'RFI') return `Folded to you in the ${spot.hero}.`;
  if (spot.type === 'vsOpen') return `${spot.villain} opens to ${fmt(sizes.open)}bb. Folds to you in the ${spot.hero}.`;
  return `You opened to ${fmt(sizes.open)}bb from the ${spot.hero}. ${spot.villain} 3-bets to ${fmt(sizes.threeBet)}bb.`;
}

/**
 * createTrainerView({ getChart, getCurrentSpot }) → { element, refresh(), isActive(on) }.
 * getChart() returns the selected chart; getCurrentSpot() the spot open in the editor.
 */
export function createTrainerView({ getChart, getCurrentSpot, state, persist }) {
  state.trainer ??= { spots: 'all', focus: 'all' };
  const opts = state.trainer;
  const rng = createRng(randomSeed());
  let deal = 0;
  let review = [];
  let current = null;
  let answered = false;
  let session = { correct: 0, acceptable: 0, wrong: 0 };
  let active = false;

  const spotsSelect = el('select', { 'aria-label': 'Spots to train' }, [
    el('option', { value: 'all', text: 'All spots' }),
    el('option', { value: 'RFI', text: 'RFI only' }),
    el('option', { value: 'vsOpen', text: 'Facing an open' }),
    el('option', { value: 'vs3bet', text: 'Facing a 3-bet' }),
    el('option', { value: 'current', text: 'The spot open in Charts' }),
  ]);
  spotsSelect.value = opts.spots;
  const focusSelect = el('select', { 'aria-label': 'Hands to deal' }, [
    el('option', { value: 'all', text: 'All hands' }),
    el('option', { value: 'edges', text: 'Edge hands only' }),
  ]);
  focusSelect.value = opts.focus;
  const resetBtn = el('button', { type: 'button', text: 'Reset stats' });

  const seats = POSITIONS.map((pos) => el('div', { class: `tr-seat seat-${pos}` }, [el('span', { class: 'tr-pos', text: pos }), el('span', { class: 'tr-chip' })]));
  const table = el('div', { class: 'tr-table', 'aria-hidden': 'true' }, [el('div', { class: 'tr-felt' }), ...seats]);
  const story = el('p', { class: 'tr-story' });
  const cardsEl = el('div', { class: 'tr-cards' });
  const buttons = el('div', { class: 'tr-buttons' });
  const feedback = el('div', { class: 'tr-feedback', 'aria-live': 'polite' });
  const miniGrid = createActionGrid({});
  const nextBtn = el('button', { type: 'button', class: 'primary', text: 'Next hand (Enter)' });
  const score = el('p', { class: 'tr-score' });
  const statsEl = el('div', { class: 'tr-stats' });

  const element = el('div', { class: 'trainer' }, [
    el('div', { class: 'icm-row' }, [field('Spots', spotsSelect), field('Hands', focusSelect), resetBtn]),
    el('div', { class: 'tr-layout' }, [
      el('div', { class: 'panel tr-main' }, [table, story, cardsEl, buttons, feedback, nextBtn, score]),
      el('div', { class: 'panel tr-side' }, [el('h3', { text: 'Where this hand sits' }), miniGrid]),
    ]),
    el('div', { class: 'panel' }, [el('h3', { text: 'Stats by spot' }), statsEl]),
  ]);

  const loadStats = () => load(statsKey(getChart().id), {});

  function allowedSpots(chart) {
    const ids = Object.keys(chart.spots);
    if (opts.spots === 'current') return ids.filter((id) => id === getCurrentSpot());
    if (opts.spots === 'all') return ids;
    return ids.filter((id) => parseSpotId(id).type === opts.spots);
  }

  function renderStats() {
    const stats = loadStats();
    const rows = Object.entries(stats).sort((a, b) => b[1].attempts - a[1].attempts);
    if (!rows.length) {
      statsEl.replaceChildren(el('p', { class: 'muted', text: 'No answers yet.' }));
      return;
    }
    statsEl.replaceChildren(
      el('div', { class: 'table-wrap' }, [
        el('table', { class: 'tr-stats-table' }, [
          el('thead', {}, [el('tr', {}, ['Spot', 'Hands', 'Accuracy', 'Recent mistakes'].map((h) => el('th', { text: h })))]),
          el(
            'tbody',
            {},
            rows.map(([id, s]) =>
              el('tr', {}, [
                el('td', { text: describeSpot(id) }),
                el('td', { text: String(s.attempts) }),
                el('td', { text: pct(accuracy(s), 0) }),
                el('td', { text: s.recentMistakes.join(', ') || '–' }),
              ]),
            ),
          ),
        ]),
      ]),
    );
  }

  function renderScore() {
    const total = session.correct + session.acceptable + session.wrong;
    score.textContent = total
      ? `This session: ${session.correct} correct · ${session.acceptable} acceptable · ${session.wrong} wrong · ${pct(accuracy({ attempts: total, ...session }), 0)}${review.length ? ` · ${review.length} hand${review.length === 1 ? '' : 's'} to review` : ''}`
      : 'Shortcuts: F fold · C call · R raise · A all-in · Enter next hand.';
  }

  function deal_() {
    const chart = getChart();
    feedback.replaceChildren();
    nextBtn.hidden = true;
    answered = false;
    try {
      current = nextSpot(chart, { rng, spots: allowedSpots(chart), focus: opts.focus, review, deal });
    } catch (err) {
      current = null;
      story.textContent = err.message;
      cardsEl.replaceChildren();
      buttons.replaceChildren();
      return;
    }
    deal++;
    const sizes = spotSizes(chart, current.spotId);
    seats.forEach((seat, i) => {
      const pos = POSITIONS[i];
      seat.classList.toggle('hero', pos === current.hero);
      seat.classList.toggle('villain', pos === current.villain);
      seat.classList.toggle('button', pos === 'BTN');
      const chip = seat.querySelector('.tr-chip');
      chip.textContent =
        pos === current.villain
          ? current.type === 'vsOpen'
            ? `${fmt(sizes.open)}`
            : `${fmt(sizes.threeBet)}`
          : pos === current.hero && current.type === 'vs3bet'
            ? `${fmt(sizes.open)}`
            : pos === 'SB'
              ? '0.5'
              : pos === 'BB'
                ? '1'
                : '';
    });
    story.textContent = `${storyOf(chart, current)}${current.fromReview ? ' (review)' : ''}`;
    cardsEl.replaceChildren(...current.cards.map(cardFace));
    buttons.replaceChildren(
      ...current.legal.map((action) => {
        const key = Object.keys(KEYS).find((k) => KEYS[k] === action);
        const b = el('button', { type: 'button', class: `tr-action act-${action}`, text: `${actionLabel(current.spotId, action)} (${key.toUpperCase()})` });
        b.addEventListener('click', () => answer(action));
        return b;
      }),
    );
    miniGrid.setFrequencies({ raise: [], call: [], allin: [] });
    miniGrid.setHighlight(null);
  }

  function answer(action) {
    if (!current || answered || !current.legal.includes(action)) return;
    answered = true;
    const chart = getChart();
    const result = scoreAnswer(chart, current, action);
    session[result.verdict]++;
    review = updateReview(review, current, result.verdict, deal);
    save(statsKey(chart.id), updateStats(loadStats(), current, result.verdict));
    const mix = ['raise', 'call', 'allin', 'fold']
      .filter((a) => result.frequencies[a] > 0.005)
      .map((a) => `${actionLabel(current.spotId, a)} ${pct(result.frequencies[a], 0)}`)
      .join(' · ');
    const verdictText = { correct: 'Correct', acceptable: 'Acceptable (mixed hand)', wrong: 'Wrong' }[result.verdict];
    feedback.replaceChildren(
      el('div', { class: `badge ${result.verdict === 'correct' ? 'good' : result.verdict === 'acceptable' ? 'neutral' : 'bad'}`, text: verdictText }),
      el('p', { text: `${current.handClass} in ${describeSpot(current.spotId)}: ${mix}.` }),
    );
    for (const b of buttons.querySelectorAll('button')) b.disabled = true;
    miniGrid.setFrequencies(spotFrequencies(chart, current.spotId));
    miniGrid.setHighlight(current.handClass);
    nextBtn.hidden = false;
    renderScore();
    renderStats();
  }

  nextBtn.addEventListener('click', deal_);
  spotsSelect.addEventListener('change', () => {
    opts.spots = spotsSelect.value;
    persist();
    deal_();
  });
  focusSelect.addEventListener('change', () => {
    opts.focus = focusSelect.value;
    persist();
    deal_();
  });
  resetBtn.addEventListener('click', () => {
    save(statsKey(getChart().id), {});
    session = { correct: 0, acceptable: 0, wrong: 0 };
    review = [];
    renderScore();
    renderStats();
  });

  const onKey = (e) => {
    if (!element.isConnected) {
      document.removeEventListener('keydown', onKey);
      return;
    }
    if (!active || e.ctrlKey || e.metaKey || e.altKey || e.target.matches?.('input, textarea, select')) return;
    const key = e.key.toLowerCase();
    if (KEYS[key] && !answered) {
      e.preventDefault();
      answer(KEYS[key]);
    } else if ((key === 'enter' || key === ' ' || key === 'n') && answered) {
      e.preventDefault();
      deal_();
    }
  };
  document.addEventListener('keydown', onKey);

  return {
    element,
    /** Starts a new deal (call after the chart changes). */
    refresh() {
      renderScore();
      renderStats();
      deal_();
    },
    setActive(on) {
      active = on;
    },
  };
}
