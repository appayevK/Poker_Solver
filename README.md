# Poker Solver

An all-in-one browser study tool for No-Limit Hold'em: hand review, preflop ranges, EV / ICM / PKO calculations and basic Nash push/fold. Covers both MTTs (incl. PKO bounties) and cash (NL10, Rush & Cash).

For off-table study only. Do not use while playing.

## Sections

| Tab | What it does |
|---|---|
| **Review** | Import GGPoker hand histories or enter hands manually, replay street by street, see equity / EV at each decision, flag leaks |
| **Ranges** | 13×13 range grid, preflop cash charts, trainer mode |
| **Equity / EV** | Hand/range equity, pot odds, required equity, fold equity, PKO bounty adjustment |
| **ICM** | Malmuth-Harville $EV, risk premium, ICM + bounty decisions |
| **Nash** | Push/fold equilibria (HU → 9-handed), chip EV / ICM / PKO modes |

## Project layout

```
index.html               App shell
src/
  main.js                Entry point, wires tabs together
  engine/                Shared maths: cards, evaluator, ranges, combos, equity
  calc/                  EV, ICM, PKO bounty maths
  nash/                  Push/fold equilibrium solvers
  review/                Hand format, GG parser, manual entry, replayer, leak flags
  preflop/               Cash charts and trainer
  ui/                    Range grid and one module per tab
  workers/               Web Workers for heavy computation
  storage/               Persistence for hands, notes, ranges
  styles/                CSS
data/                    Precomputed tables, chart presets, payout presets
scripts/                 Build scripts for precomputed data
tests/                   Unit tests (Vitest) + hand-history fixtures
docs/PLAN.md             Full build plan
```

## Getting started

```bash
npm install
npm run dev           # local dev server
npm test              # run unit tests (~5 s)
npm run bench         # hand evaluator throughput
npm run build:equity  # regenerate data/preflop-equity-169.json (~70 s)
```

`SLOW_TESTS=1 npm test` also runs the full 7-card category count (133,784,560 hands, ~7 s).

## Build order

1. ~~Engine, range grid, equity calculator~~ **Done** (see phase 1 notes below)
2. ~~EV calculator, ICM, PKO conversion~~ **Done** (see phase 2 notes below)
3. ~~Nash push/fold (HU → multi-player → ICM / bounty modes)~~ **Done** (see phase 3 notes below)
4. Hand review (manual entry → GG parser) — **pending**: waiting for real GGPoker exports in `tests/fixtures/hand-histories/`
5. ~~Preflop charts and trainer~~ **Done** (see phase 5 notes below); leak flags and batch stats come with hand review (phase 4)

See [docs/PLAN.md](docs/PLAN.md) for details.

### Phase 1 notes

- **Cards** are integers `rank * 4 + suit` (ranks `23456789TJQKA` → 0..12, suits `cdhs` → 0..3), so `'AsKd'` → `[51, 45]`.
- **Hand strength** from `evaluate(cards)` (5–7 cards) is `category << 20 | kickers`, category 0 (high card) … 8 (straight flush). Higher is better, equal is a split. Kickers are a 13-bit mask of the best ranks (high card, flush), rank nibbles (two pair, full house, quads), or a rank plus a kicker mask (pair, trips); straights store their top rank, so the wheel is lowest. Built from rank-count and per-suit bitmasks with lookup tables made once at load.
- **Evaluator speed** (`npm run bench`, Node 24, Ryzen 9 8940HX laptop): about **12 M** random 7-card `evaluate()` calls per second, and about 49 M/s for `BoardEvaluator.evalHole()`, which reuses a fixed 5-card board and is what the equity code uses. Target was 2 M/s. Throughput roughly halves when the laptop throttles on battery.
- **Ranges** are a `Map`. Class keys (`'AKs'`, `'QQ'`) hold the weight of every combo in the class. Specific-combo keys (`'AsKs'`, higher card first) override that weight for one combo, so `AKs, AsKs:0` means AKs without AsKs. Setting a class clears the overrides inside it. `rangeToString` groups by weight and compresses pairs (`QQ+`, `QQ-99`), kickers (`A2s+`, `A5s-A2s`), suited+offsuit pairs of classes (`AT+`) and connector runs (`T9s-65s`). It always round-trips through `parseRange`. `rangePercent` returns a fraction of 1326.
- **Exact equity** enumerates each runout once and evaluates every live combo of every player on it. Heads-up matchups are then summed with a sort-and-sweep that uses per-card weight sums for card removal; multiway walks the non-conflicting combo tuples. When a spot is fully suit-symmetric (no board, no dead cards, ranges made of whole classes), only the 134,459 suit-canonical boards are enumerated, each weighted by its orbit size. That makes class vs class preflop take about 50 ms.
- **Auto method**: `chooseMethod` estimates exact run time and uses enumeration below about 1.5 s. Otherwise it falls back to Monte Carlo, which rejection-samples combo tuples so card removal matches exact enumeration, uses a seedable xoshiro128** PRNG and reports a standard error. All of this runs in `src/workers/equity.worker.js` behind `runEquity()` in `src/workers/client.js`.
- **Preflop table**: `data/preflop-equity-169.json` (221 KB, committed) holds exact 169×169 class-vs-class equities, averaged over all non-conflicting combo matchups. The builder sweeps the canonical boards once instead of enumerating each matchup. `preflopEquity(a, b)` reads it synchronously in Node; browsers call `await loadPreflopTable()` first.

### Phase 2 notes

- **EV conventions** (`src/calc/ev.js`): `pot` is everything already in the middle, including villain's bet. Every EV is measured against folding now (fold = 0), in chips or big blinds. `betEV` assumes villain only folds or calls. `jamEV` takes the chips each player has behind and risks only what villain can call: `min(heroStack, toCall + villainStack)`.
- **Rake**: functions that pay out a pot accept `rake: { percent, cap, noFlopNoDrop }`, applied to the final pot (`percent: 5` means 5%). With no flop, no drop (GG cash), pass `preflop: true` and a pot won before the flop goes unraked. A called preflop all-in still deals a flop, so it is raked.
- **PKO model** (`src/calc/pko.js`): busting a player pays you half their bounty in cash, and the other half goes onto your own head. You only win a bounty if you cover the player. Bounties convert to chips at a $/chip rate. Early on, with a 50/50 buy-in split, that rate is `startingBounty / startingStack`, so a starting bounty's cash half is worth half a starting stack.
- **Head-value factor** (0–1, default 0) is how much of the half added to your own head you count as value now. That money is paid to whoever busts you, and you only collect it by winning the tournament. It is worth little early, so the default ignores it.
- **ICM** (`src/calc/icm.js`): Malmuth-Harville, computed once per set of already-placed players (bitmask DP, O(2ⁿ·n)). 10 players take about 1 ms, and the limit is 12 players. Players with 0 chips are out and get 0.
- **Spot $EV**: `spotEV` builds each outcome as a new stack vector and scores it with ICM: hero folds, villain folds, called and win, called and lose, split. Blinds and antes are dead money. When hero folds, the pot goes to villain, as when it is folded to the big blind. A busted hero is paid the place they finish in.
- **Required equity**: `icmRequiredEquity` and `chipRequiredEquity` solve the linear $EV (or chip EV) equation for the break-even equity directly. Risk premium = ICM minus chip-EV required equity.
- **PKO + ICM**: busting villain adds `bounty / 2 × (1 + headValueFactor)` to hero's $EV as cash. When a covering villain busts hero, hero's own bounty goes to villain. That money was never hero's, so only the ICM part changes.

### Phase 3 notes

- **Model** (`src/nash/pushfold.js`): push/fold only. A player folds or goes all-in, and facing an all-in calls or folds; there are no limps and no smaller raises. Stacks and blinds are in big blinds, with blinds 0.5 / 1 by default. Antes can be per player or a single big-blind ante; antes are dead money and blinds are live. Seats are in action order (first to act … SB, BB). Strategies are a jam or call frequency for each of the 169 hand classes.
- **Card removal** (`src/nash/card-removal.js`): a 169×169 matrix counts the compatible combo pairs between two classes (AA vs KK = 36, AA vs AKs = 12). Villain's classes are weighted by that count against hero's hand. The chance that each player behind calls is computed against the jammer's hand. Cards held by players who folded are ignored, which is the standard simplification.
- **One caller** (`maxCallers = 1`): once someone calls, everyone behind folds, so every all-in is heads-up. The decision nodes are "open-jam when folded to" for every seat but the BB, and "call vs a jam from seat X" for every seat behind X. 3-way all-ins (`maxCallers = 2`, the optional stretch) are not implemented; asking for them throws a clear error.
- **Terminal values**: a hand ends in one of these outcomes: folded round to the BB, a steal by the jammer, or jammer vs one caller where the jammer wins or loses. Each outcome's final stack vector is valued once per player:
  - **chip EV**: chips won or lost, in bb.
  - **ICM**: `icmEquity` of the final stacks in $. A busted player gets the payout for the place they finish in, and in heads-up mode the players outside the hand can be included.
  - **PKO**: the ICM value plus `bountyDollarValue` for a player who busts someone they cover. Without payouts it is chip EV plus `bountyChipValue`, at a $/bb rate from the starting bounty and starting stack.
  A class's EV for an action is then a sum of these values weighted by preflop-table equities and the card-removal matrix, so each iteration costs O(nodes × 169²). A split pot counts as half a win and half a loss: exact in chip EV, and a close approximation under ICM.
- **Solver** (`src/nash/fictitious-play.js`): fictitious play. Each iteration plays the best response at every node, then moves the average strategy towards it. The step is 2/(t+2), so later responses carry linearly more weight. This reaches 1e-4 bb in a few hundred iterations, where classic 1/t averaging needs tens of thousands; `'1/t'` and a fixed step remain available as options. Exploitability is the best-response gain per player, and solving stops below 2e-4 bb (or the same fraction of the prize pool in ICM). Displayed ranges round hands to fully played or folded when their EV gap is clear of zero; the raw frequencies stay in `nodes`.
- **Solve times** (Node 24, Ryzen 9 8940HX laptop): heads-up at 10 bb takes about 0.1 s and matches published Nash (SB jams 58%, BB calls 37%). 3-handed at 10 bb takes about 0.1 s, 6-handed at 15 bb about 0.4 s, and 9-handed at 15 bb about 1.4 s. In the browser, solves run in `src/workers/nash.worker.js` behind `solveNash()` (`src/workers/nash-client.js`), with progress and cancel. Solutions are cached in localStorage by a hash of the parameters (the 10 most recent), so a solved spot reopens instantly.
- **`nashAction(solution, { seat, node, handClass })`** returns the Nash action, the jam or call frequency and the EV gap. The Nash tab's "Check my hand" uses it, and the hand-review phase will compare real decisions with it.

### Phase 5 notes

- **Chart format** (`src/preflop/charts.js`): a chart is `{ id, name, notes, stack: 100, players: 6, sizes, spots }`.
  - `sizes` are the default raise sizes: open 2.5bb (SB 3bb); 3-bet 3x the open in position and 4x out of position; 4-bet 2.2x the 3-bet.
  - `spots` are keyed by spot id, with positions in 6-max action order (UTG, HJ, CO, BTN, SB, BB):
    - `RFI:CO`: CO first in;
    - `vsOpen:BB:BTN`: BB facing a BTN open;
    - `vs3bet:CO:BTN`: CO opened and the BTN 3-bet.
  - Each spot maps actions to range strings, `{ raise, call, allin? }`, in the usual notation with optional weights for mixed hands (`A5s:0.5`). Fold is whatever is left over.
  - `validateChart` blocks charts whose ranges don't parse, whose frequencies add up to more than 1 for a hand, or whose spot ids are malformed or inconsistent with the positions.
  - `chartWarnings` reports, without blocking a save, an opener continuing vs a 3-bet with hands it doesn't open.
  - The built-in baseline is read-only. Duplicated, imported or edited charts are saved in localStorage, and charts import and export as JSON.
- **Baseline** (`data/charts/cash-6max-100bb.json`): an approximate study baseline written from general poker knowledge. It is **not solver output** and not copied from any commercial chart.
  - It covers RFI for every position (UTG 16%, HJ 20%, CO 28%, BTN 47%, SB 40% raise-or-fold), every "vs open" spot, and every "vs 3-bet" spot.
  - The blinds are a little tighter than a no-rake baseline because of rake at low stakes; the SB is 3-bet-or-fold.
  - Replace any spot with your own ranges.
- **Ranges tab**:
  - a chart picker with duplicate, rename, delete, import and export;
  - a spot picker by position;
  - a multi-action grid (raise / call / all-in / fold, with mixed cells split by frequency) showing the % of hands, combos and notation per action;
  - an edit mode that paints an action at a frequency, or takes typed notation;
  - compare with another chart;
  - checks:
    - defence vs MDF, with a note that preflop MDF is only a rough guide;
    - Monte Carlo equity of the continuing range vs the opener;
    - the fold frequency a 3-bet or 4-bet bluff needs vs how often the chart folds;
    - the card-removal effect of blocker hands such as A5s.
- **Trainer** (`src/preflop/trainer.js`):
  - **Dealing:** hands are dealt by combo (a pair 6/1326, suited 4/1326, offsuit 12/1326). Facing a 3-bet, hands are also weighted by how often the chart opens them. You can filter by spot type or deal edge hands only (mixed hands and hands on a range boundary).
  - **Scoring:** an answer is **correct** if the chart plays it at least 50% of the time, **acceptable** at 15–50% (a mixed hand), and **wrong** otherwise. Accuracy counts acceptable answers as half.
  - **Spaced repetition:** a wrong hand comes back 3 deals later, and each correct answer on it doubles the gap until it passes 24.
  - **Stats and shortcuts:** stats are saved per spot. Keys: F fold, C call, R raise, A all-in, Enter for the next hand.
