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
npm run dev      # local dev server
npm test         # run unit tests
```

## Build order

1. Engine, range grid, equity calculator
2. EV calculator, ICM, PKO conversion
3. Nash push/fold (HU → multi-player → ICM / bounty modes)
4. Hand review (manual entry → GG parser)
5. Preflop charts and trainer, leak flags, batch stats

See [docs/PLAN.md](docs/PLAN.md) for details.
