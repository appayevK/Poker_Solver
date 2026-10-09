// Decision panel for the Equity tab: chip-EV of calling, betting and jamming, with
// optional rake and a PKO bounty adjustment.
import { requiredEquity, callEV, betEV, breakEvenFoldFreq, mdf, jamDetails } from '../calc/ev.js';
import { bountyChipValue, pkoRequiredEquity, pkoCallEV, startingDollarsPerChip } from '../calc/pko.js';
import { el, field, readNumber, pct, fmt, signed } from './dom.js';
import { load, save } from '../storage/store.js';

const STORAGE_KEY = 'decisionPanel';
const DEFAULTS = {
  pot: '150',
  amount: '50',
  heroStack: '1000',
  villainStack: '800',
  bb: '10',
  equity: '35',
  foldFreq: 40,
  rejam: false,
  rake: false,
  rakePercent: '5',
  rakeCap: '',
  preflopNoDrop: false,
  pko: false,
  bounty: '5',
  startingBounty: '5',
  startingStack: '1000',
  rate: '',
  headValueFactor: '0',
  heroCovers: true,
};

/** Returns { element, setEquityResult(result) }. */
export function createDecisionPanel() {
  const saved = load(STORAGE_KEY, null);
  const state = { ...DEFAULTS, ...(saved && typeof saved === 'object' ? saved : {}) };
  const persist = () => save(STORAGE_KEY, state);
  const inputs = {};

  const num = (key, props = {}) => {
    const input = el('input', { type: 'number', inputMode: 'decimal', step: 'any', min: 0, value: state[key], ...props });
    input.addEventListener('input', () => {
      state[key] = input.value;
      persist();
      update();
    });
    inputs[key] = input;
    return input;
  };
  const check = (key, label) => {
    const input = el('input', { type: 'checkbox', checked: !!state[key] });
    input.addEventListener('change', () => {
      state[key] = input.checked;
      persist();
      update();
    });
    inputs[key] = input;
    return el('label', { class: 'check' }, [input, el('span', { text: label })]);
  };

  // -- inputs ---------------------------------------------------------------

  const useEquityBtn = el('button', { type: 'button', class: 'small', text: 'Use P1 equity', disabled: true });
  let lastEquity = null;
  useEquityBtn.addEventListener('click', () => {
    if (lastEquity === null) return;
    inputs.equity.value = (lastEquity * 100).toFixed(2);
    state.equity = inputs.equity.value;
    persist();
    update();
  });

  const foldSlider = el('input', { type: 'range', min: 0, max: 100, step: 1, value: state.foldFreq, 'aria-label': 'Villain fold frequency' });
  const foldOut = el('output', { class: 'dp-fold-out' });
  foldSlider.addEventListener('input', () => {
    state.foldFreq = Number(foldSlider.value);
    persist();
    update();
  });

  const rakeFields = el('div', { class: 'dp-row' }, [
    field('Rake %', num('rakePercent', { max: 100 })),
    field('Cap (chips)', num('rakeCap', { placeholder: 'none' })),
    check('preflopNoDrop', 'Preflop pot, no flop no drop (GG cash)'),
  ]);
  const pkoFields = el('div', { class: 'dp-row' }, [
    field("Villain's bounty $", num('bounty')),
    field('Starting bounty $', num('startingBounty')),
    field('Starting stack', num('startingStack')),
    field('$ per chip', num('rate', { placeholder: 'auto' })),
    field('Head-value factor', num('headValueFactor', { max: 1, step: 0.05 })),
    check('heroCovers', 'I cover villain'),
  ]);

  // -- outputs --------------------------------------------------------------

  const card = (title) => {
    const heading = el('h4', { text: title });
    const body = el('dl');
    const badge = el('div', { class: 'badge' });
    const node = el('div', { class: 'dp-card' }, [heading, body, badge]);
    return { node, heading, body, badge };
  };
  const callCard = card('Call');
  const betCard = card('Bet');
  const jamCard = card('Jam');
  const pkoCard = card('PKO call');
  const message = el('p', { class: 'dp-msg', role: 'alert' });

  const rejamCheck = check('rejam', 'Jam over the bet I face');

  const element = el('section', { class: 'decision-panel' }, [
    el('h2', { text: 'Decision' }),
    el('p', {
      class: 'muted',
      text: "Pot includes villain's bet. EVs are relative to folding now. Stacks are chips behind.",
    }),
    el('div', { class: 'dp-row' }, [
      field('Pot', num('pot')),
      field('To call / bet', num('amount')),
      field('Hero stack', num('heroStack')),
      field('Villain stack', num('villainStack')),
      field('Big blind', num('bb')),
      field('Equity %', num('equity', { max: 100 })),
    ]),
    el('div', { class: 'dp-toggles' }, [useEquityBtn, check('rake', 'Rake'), check('pko', 'PKO bounty')]),
    rakeFields,
    pkoFields,
    message,
    el('div', { class: 'dp-cards' }, [callCard.node, pkoCard.node]),
    el('label', { class: 'dp-fold' }, [el('span', { text: 'Villain folds' }), foldSlider, foldOut]),
    el('div', { class: 'dp-cards' }, [betCard.node, jamCard.node]),
  ]);
  jamCard.node.append(rejamCheck);

  // -- maths ----------------------------------------------------------------

  function rows(dl, pairs) {
    dl.replaceChildren(...pairs.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: v })]));
  }

  function verdict(badge, ev, positive, negative) {
    badge.className = 'badge';
    if (ev === null || !Number.isFinite(ev)) {
      badge.textContent = '';
      return;
    }
    badge.classList.add(ev > 1e-9 ? 'good' : ev < -1e-9 ? 'bad' : 'neutral');
    badge.textContent = ev > 1e-9 ? positive : ev < -1e-9 ? negative : 'Break-even';
  }

  function safe(cardObj, fn) {
    try {
      fn();
      cardObj.node.classList.remove('error');
    } catch (err) {
      rows(cardObj.body, [['', err.message]]);
      verdict(cardObj.badge, null);
      cardObj.node.classList.add('error');
    }
  }

  function update() {
    const v = (k) => readNumber(inputs[k]);
    const pot = v('pot');
    const amount = v('amount');
    const heroStack = v('heroStack');
    const villainStack = v('villainStack');
    const bb = v('bb');
    const eqPct = v('equity');
    const equity = eqPct === null ? null : eqPct / 100;
    const foldFreq = Number(foldSlider.value) / 100;
    foldOut.textContent = `${foldSlider.value}%`;

    rakeFields.hidden = !state.rake;
    pkoFields.hidden = !state.pko;
    pkoCard.node.hidden = !state.pko;
    const preflop = state.rake && state.preflopNoDrop;
    const rake = state.rake ? { percent: v('rakePercent') ?? 0, cap: v('rakeCap') ?? Infinity, noFlopNoDrop: preflop } : undefined;

    const missing = [['Pot', pot], ['To call / bet', amount]].filter(([, x]) => x === null).map(([k]) => k);
    message.textContent = missing.length ? `Enter ${missing.join(' and ')}.` : '';
    if (missing.length) {
      for (const c of [callCard, betCard, jamCard, pkoCard]) {
        c.body.replaceChildren();
        verdict(c.badge, null);
      }
      return;
    }
    const chips = (x) => (bb && bb > 0 ? `${signed(x)} chips · ${signed(x / bb)} bb` : `${signed(x)} chips`);
    const noEquity = ['EV', 'enter your equity'];

    callCard.heading.textContent = `Call ${amount ?? '?'}`;
    safe(callCard, () => {
      const req = requiredEquity(pot, amount, { rake });
      const pairs = [['Required equity', pct(req)]];
      let ev = null;
      if (equity !== null) {
        ev = callEV({ pot, toCall: amount, equity, rake });
        pairs.push(['Your equity', pct(equity)], ['Call EV', chips(ev)]);
      }
      pairs.push(["MDF vs villain's bet", amount <= pot ? pct(mdf(pot - amount, amount)) : '–']);
      rows(callCard.body, pairs);
      verdict(callCard.badge, ev, '+EV call', '−EV call: fold');
    });

    betCard.heading.textContent = `Bet ${amount ?? '?'} into ${pot ?? '?'}`;
    safe(betCard, () => {
      const pairs = [
        ['Break-even fold frequency', pct(breakEvenFoldFreq(pot, amount, { rake, preflop }))],
        ["Villain's MDF", pct(mdf(pot, amount))],
      ];
      let ev = null;
      if (equity !== null) {
        ev = betEV({ pot, bet: amount, foldFreq, equityWhenCalled: equity, rake, preflop });
        pairs.unshift([`Bet EV at ${pct(foldFreq, 0)} folds`, chips(ev)]);
      } else pairs.unshift(noEquity);
      rows(betCard.body, pairs);
      verdict(betCard.badge, ev, '+EV bet', '−EV bet');
    });

    safe(jamCard, () => {
      if (heroStack === null || villainStack === null) throw new Error('Enter both stacks to see the jam');
      const toCall = state.rejam ? amount : 0;
      const details = jamDetails({ heroStack, villainStack, pot, foldFreq, equityWhenCalled: equity ?? 0, toCall, rake, preflop });
      const ev = equity === null ? null : details.ev;
      jamCard.heading.textContent = `Jam (risking ${fmt(details.risk)})`;
      rows(jamCard.body, [
        ev === null ? noEquity : [`Jam EV at ${pct(foldFreq, 0)} folds`, chips(ev)],
        ['Break-even fold frequency (0% equity)', pct(breakEvenFoldFreq(pot, details.risk, { rake, preflop }))],
      ]);
      verdict(jamCard.badge, ev, '+EV jam', '−EV jam');
    });

    if (state.pko) {
      safe(pkoCard, () => {
        const rate = v('rate');
        const startingBounty = v('startingBounty');
        const startingStack = v('startingStack');
        const perChip = rate ?? startingDollarsPerChip({ startingBounty, startingStack });
        const bountyChips = bountyChipValue({
          bounty: v('bounty') ?? 0,
          startingBounty,
          startingStack,
          headValueFactor: v('headValueFactor') ?? 0,
          rate: rate ?? undefined,
        });
        const heroCovers = !!state.heroCovers;
        const plain = requiredEquity(pot, amount);
        const withBounty = pkoRequiredEquity({ pot, toCall: amount, bountyChips, heroCovers });
        const pairs = [
          ['Bounty worth', heroCovers ? `${fmt(bountyChips)} chips${bb ? ` · ${fmt(bountyChips / bb)} bb` : ''} at $${fmt(perChip, 6)}/chip` : 'nothing: villain covers you'],
          ['Required equity', `${pct(plain)} → ${pct(withBounty)} with bounty`],
        ];
        let ev = null;
        if (equity !== null) {
          ev = pkoCallEV({ pot, toCall: amount, equity, bountyChips, heroCovers });
          pairs.push(['PKO call EV', chips(ev)]);
        }
        rows(pkoCard.body, pairs);
        verdict(pkoCard.badge, ev, '+EV call with bounty', '−EV call even with bounty');
      });
    }
  }

  update();

  return {
    element,
    /** Remembers P1's equity from an equity result for the "Use P1 equity" button. */
    setEquityResult(result) {
      const p = result?.players?.[0];
      if (!p) return;
      lastEquity = p.equity;
      useEquityBtn.disabled = false;
      useEquityBtn.textContent = `Use P1 equity (${pct(p.equity)})`;
    },
  };
}
