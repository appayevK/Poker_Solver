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
2. EV calculator, ICM, PKO conversion
3. Nash push/fold (HU → multi-player → ICM / bounty modes)
4. Hand review (manual entry → GG parser)
5. Preflop charts and trainer, leak flags, batch stats

See [docs/PLAN.md](docs/PLAN.md) for details.

### Phase 1 notes

- **Cards** are integers `rank * 4 + suit` (ranks `23456789TJQKA` → 0..12, suits `cdhs` → 0..3), so `'AsKd'` → `[51, 45]`.
- **Hand strength** from `evaluate(cards)` (5–7 cards) is `category << 20 | kickers`, category 0 (high card) … 8 (straight flush). Higher is better, equal is a split. Kickers are a 13-bit mask of the best ranks (high card, flush), rank nibbles (two pair, full house, quads), or a rank plus a kicker mask (pair, trips); straights store their top rank, so the wheel is lowest. Built from rank-count and per-suit bitmasks with lookup tables made once at load.
- **Evaluator speed** (`npm run bench`, Node 24, Ryzen 9 8940HX laptop): about **12 M** random 7-card `evaluate()` calls per second, and about 49 M/s for `BoardEvaluator.evalHole()`, which reuses a fixed 5-card board and is what the equity code uses. Target was 2 M/s. Throughput roughly halves when the laptop throttles on battery.
- **Ranges** are a `Map`. Class keys (`'AKs'`, `'QQ'`) hold the weight of every combo in the class. Specific-combo keys (`'AsKs'`, higher card first) override that weight for one combo, so `AKs, AsKs:0` means AKs without AsKs. Setting a class clears the overrides inside it. `rangeToString` groups by weight and compresses pairs (`QQ+`, `QQ-99`), kickers (`A2s+`, `A5s-A2s`), suited+offsuit pairs of classes (`AT+`) and connector runs (`T9s-65s`). It always round-trips through `parseRange`. `rangePercent` returns a fraction of 1326.
- **Exact equity** enumerates each runout once and evaluates every live combo of every player on it. Heads-up matchups are then summed with a sort-and-sweep that uses per-card weight sums for card removal; multiway walks the non-conflicting combo tuples. When a spot is fully suit-symmetric (no board, no dead cards, ranges made of whole classes), only the 134,459 suit-canonical boards are enumerated, each weighted by its orbit size. That makes class vs class preflop take about 50 ms.
- **Auto method**: `chooseMethod` estimates exact run time and uses enumeration below about 1.5 s. Otherwise it falls back to Monte Carlo, which rejection-samples combo tuples so card removal matches exact enumeration, uses a seedable xoshiro128** PRNG and reports a standard error. All of this runs in `src/workers/equity.worker.js` behind `runEquity()` in `src/workers/client.js`.
- **Preflop table**: `data/preflop-equity-169.json` (221 KB, committed) holds exact 169×169 class-vs-class equities, averaged over all non-conflicting combo matchups. The builder sweeps the canonical boards once instead of enumerating each matchup. `preflopEquity(a, b)` reads it synchronously in Node; browsers call `await loadPreflopTable()` first.
