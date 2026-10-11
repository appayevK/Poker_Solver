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
| **Flop** | Pre-solved flop strategies (TexasSolver) for common 6-max 100bb spots: explore any board, texture reports, flop trainer |

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
  flops/                 Flop library: canonical flops, textures, subset, spots, solver
                         input and extraction, lookups, reports, flop trainer
  ui/                    Range grid, mix grid and one module per tab
  workers/               Web Workers for heavy computation
  storage/               Persistence for hands, notes, ranges
  styles/                CSS
data/                    Precomputed tables, chart presets, payout presets
  flops/                 Flop subset, spots, solved flop data and index
scripts/                 Build scripts for precomputed data
  flops/                 TexasSolver pipeline (configs, solves, extraction, index)
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
npm run flops:bench   # one TexasSolver solve per flop spot + time / RAM estimate (needs TEXASSOLVER_PATH)
npm run flops:all     # solve the whole flop library overnight (see phase 6 notes)
```

`SLOW_TESTS=1 npm test` also runs the full 7-card category count (133,784,560 hands, ~7 s).

## Build order

1. ~~Engine, range grid, equity calculator~~ **Done** (see phase 1 notes below)
2. ~~EV calculator, ICM, PKO conversion~~ **Done** (see phase 2 notes below)
3. ~~Nash push/fold (HU → multi-player → ICM / bounty modes)~~ **Done** (see phase 3 notes below)
4. Hand review (manual entry → GG parser) — **pending**: waiting for real GGPoker exports in `tests/fixtures/hand-histories/`
5. ~~Preflop charts and trainer~~ **Done** (see phase 5 notes below); leak flags and batch stats come with hand review (phase 4)
6. ~~Pre-solved flop library and Flop tab~~ **Done** (see phase 6 notes below)
7. Exploits and pool spots — planned

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

### Phase 6 notes

- **TexasSolver** ([github.com/bupticybee/TexasSolver](https://github.com/bupticybee/TexasSolver)), v0.2.0, console build.
  - **Licence:** AGPL-3.0. Free for personal study. Building it into other software or offering it as a service needs a commercial licence from its author.
  - **Never bundled:** this repo contains none of its code or binaries. The scripts write plain-text input files, run your own copy of `console_solver`, and read the JSON it dumps. Only the extracted flop strategies are committed.
  - **Install:** download the v0.2.0 release for your OS from its GitHub releases page and unzip it anywhere, e.g. `C:\TexasSolver` (the folder holding `console_solver.exe` and `resources\`).
  - **`TEXASSOLVER_PATH`:** point the scripts at that folder once, then open a new terminal. Without it the scripts stop and explain what to set.
    ```powershell
    setx TEXASSOLVER_PATH "C:\TexasSolver"
    ```
  - **Syntax:** the input commands follow the release's own sample input and docs. Small test solves confirmed what the numbers mean:
    - `bet 33` bets 33% of the pot;
    - `raise 50` raises by 50% of the pot after calling (about 3x);
    - the `allin` flag adds an all-in to every bet and raise of that player on that street, leads included;
    - bets are rounded to whole chips, so the scripts use 10 chips per bb;
    - amounts in the dump are the chips each action adds.
- **Overnight run:** `npm run flops:all` makes the inputs, runs every solve, extracts the data and builds the index.
  - **Resumable:** stop it with Ctrl+C or reboot, run it again, and it carries on from the solve that was in progress.
  - **Benchmark first:** `npm run flops:bench` solves one flop per spot, then prints a time and RAM summary and an estimate for the whole library.
  - **Steps on their own:**
    - `node scripts/flops/make-configs.js [--spot id] [--limit n] [--threads n] [--tree laptop|full]`
    - `node scripts/flops/run-solves.js [--spot id] [--limit n] [--dry-run] [--bench] [--max-gb n] [--force] [--retry-memory]`
    - `npm run flops:extract`
  - **Output:** the runner prints each solve's time, iterations, exploitability and peak RAM, with an ETA. Solver inputs, outputs and logs go to `solver-work/` (gitignored). Only the flop is dumped, so an SRP solve's output is about 150 KB.
  - **Memory guard:** each solve's memory is checked every second.
    - A solve over `--max-gb` (default: the lower of 3.5 GB and 75% of the RAM free at start) is stopped before the laptop starts swapping. It is logged as a memory failure and skipped on later runs unless you pass `--retry-memory`.
    - Before each solve, the runner waits until there is enough free RAM for that spot's last measured peak.
    - Threads default to all logical cores but two (30 on the laptop below), which keeps the machine responsive.
- **Spots** (`data/flops/spots.json`): ranges come from the baseline chart and pot and stack from its sizes, so editing the chart changes the spots.

  | Spot | OOP range | IP range | Pot / stack |
  |---|---|---|---|
  | SRP BTN vs BB | BB's call vs a BTN open | BTN open | 5.5 / 97.5 bb |
  | SRP CO vs BB | BB's call vs a CO open | CO open | 5.5 / 97.5 bb |
  | 3BP SB vs BTN | SB's 3-bet vs a BTN open | BTN's call vs the 3-bet | 21 / 90 bb |
  | 3BP BB vs BTN | BB's 3-bet vs a BTN open | BTN's call vs the 3-bet | 20.5 / 90 bb |

  A spot the chart can't describe gives its own stack, preflop money and ranges. This 30 bb MTT example is not solved; it shows the fields:
  ```jsonc
  {
    "id": "mtt-btn-bb-30",
    "label": "MTT 30bb BTN vs BB",
    "format": "mtt",
    "type": "SRP",
    "ip": "BTN",
    "oop": "BB",
    "aggressor": "ip",          // the preflop raiser
    "preflop": "BTN opens 2.1bb, SB folds, BB calls (1bb BB ante)",
    "stack": 30,                // starting stack in bb (default: 100, as in the chart)
    "invested": 2.1,            // each player's preflop money (default: from the chart's sizes)
    "dead": 1.5,                // SB's blind + the BB ante: pot 2 × 2.1 + 1.5 = 5.7, stack 27.9
    "ranges": {                 // range strings instead of chart spots (illustrative: use your own)
      "ip": { "range": "22+,A2s+,K2s+,Q5s+,J7s+,T7s+,97s+,86s+,76s,65s,54s,A2o+,K9o+,QTo+,JTo" },
      "oop": { "range": "22-TT,A2s-AJs,K2s+,Q2s+,J5s+,T6s+,96s+,85s+,75s+,64s+,54s,A2o-AJo,K7o+,Q9o+,J9o+,T9o,A5s:0.5" }
    }
  }
  ```
  To solve it, add it to `spots.json` and run `make-configs` and `run-solves` with `--spot mtt-btn-bb-30`, then `npm run flops:extract`.
- **Bet tree** (`src/flops/tree-config.js`, the one place to change sizes). There are two presets, and `laptop` is the default:

  | Preset | Flop | Turn | River |
  |---|---|---|---|
  | `laptop` | IP bets 33% or 75%. OOP bets 33% in 3-bet pots only. OOP check-raises 50%. IP raises 50% in 3-bet pots only (vs a c-bet or a check-raise) | bet 66%, all-in | bet 75%, all-in |
  | `full` | as `laptop`, but IP can also raise a check-raise 50% in single-raised pots | bet 50% or 100%, raise 50%, all-in | as the turn |

  - **Shared rules:** a bet or raise that would put in more than 67% of the remaining stack goes all-in, and TexasSolver allows at most 4 raises per street. In single-raised pots OOP never leads into the preflop raiser.
  - **Solver settings:** a solve stops at 0.5% of the pot exploitability or 300 iterations, with isomorphism on. Only the flop is dumped: turn and river are solved underneath but not stored.
  - **Memory** (peak of one solve, measured on SRP BTN vs BB, the widest ranges, flop AsTh5d):
    - `full` needs 15.8 GB, which thrashes a 16 GB laptop. Use `--tree full` only with 32 GB or more.
    - `laptop` needs 3.0 GB.
    - 3-bet pots are much smaller: 0.6–0.8 GB with `laptop`.
    - The thread count barely changes memory.
  - **Benchmark** (`laptop`, 30 threads, Ryzen 9 8940HX laptop, flop AsTh5d):

    | Spot | Time | Iterations | Exploitability | Peak RAM |
    |---|---|---|---|---|
    | SRP BTN vs BB | 3 min 30 s | 191 | 0.48% of the pot | 3.0 GB |
    | SRP CO vs BB | 1 min 54 s | 191 | 0.48% | 1.6 GB |
    | 3BP SB vs BTN | 31 s | 91 | 0.49% | 0.8 GB |
    | 3BP BB vs BTN | 28 s | 101 | 0.46% | 0.6 GB |

    The whole library (4 spots × 80 flops) takes about 8.5 hours. All 80 flops of 3BP BB vs BTN took 29 minutes (median 21 s per flop, exploitability 0.33–0.50% of the pot, peak RAM 0.7 GB).
- **Flop subset** (`data/flops/subset.json`, `npm run flops:subset`):
  - **Size:** the 22,100 flops reduce to 1,755 under suit relabelling. 80 representatives cover all 14 texture groups: A-high, K-high, Q/J-high, middle and low boards, each dry or wet, plus paired high, paired low, trips and monotone.
  - **Choice:** each group gets representatives in proportion to its size, at least 3, or 1 for groups under 30 flops (low dry, trips). Within a group they are picked by k-medoids on texture features (high card, connectedness, suits, pairing), and every canonical flop is assigned to its closest representative.
  - **Weights:** `weight` is the number of canonical flops a representative stands for (summing to 1,755). `raw` counts real flops (summing to 22,100), and that is what reports weight by.
- **Lookups** (`src/flops/library.js`):
  - `canonicalFlop(cards)` gives the canonical key and the suit permutation.
  - `nearestFlop(spot, cards)` returns the exact canonical flop when it is solved. Otherwise it returns the nearest solved flop by texture distance, with suits mapped by role (flush suit to flush suit, then by highest card).
  - `strategyFor(spot, cards, node)` gives per-combo and per-class frequencies in the real suits.
  - `loadIndex()` and `loadFlop(spot, key)` load the data.
- **Stored decisions:** OOP's first action, IP vs a check, OOP facing each IP bet, and in 3-bet pots IP facing OOP's 33% bet.
  - Each one also stores how often it comes up (`line`).
  - A decision that almost never happens has a mix the solver barely tested. An example is "BTN vs check" in 3BP BB vs BTN on ace-high boards, where BB bets every hand.
  - The Flop tab flags these decisions, reports weight them down, and the trainer skips them.
- **Data** (`data/flops/`):
  - **Per flop:** one JSON file holds the combos per player, the range weights and the per-combo action frequencies, quantised to 0–255 and base64-encoded, plus solve info (iterations, exploitability, tree).
  - **Sizes:** about 13 KB per flop for SRP BTN vs BB, 8 KB for SRP CO vs BB and 5–7 KB for 3-bet pots. `index.json` holds the summaries the tab needs, about 1.3 KB per flop. The full library comes to roughly 3 MB.
  - **Build:** `vite.config.js` copies the folder to `dist/data/flops/`.
  - **Committed so far:** all 80 flops of 3BP BB vs BTN plus the benchmark flop of each other spot (about 0.56 MB: 449 KB of flop files and a 105 KB index in total). Run `npm run flops:all` overnight to solve the rest.
- **Flop tab:**
  - **Explore:** type a board or pick a solved flop (grouped by texture) and get the exact or nearest solve. Choose a decision, then see the mix grid and per-combo detail in your board's suits.
  - **Reports:** action frequencies by texture group, weighted by real flop counts and by how often the decision comes up, with plain-language takeaways.
  - **Trainer:** deals a spot, flop, decision and hand from the library with random suits. Answers are scored like the preflop trainer (correct at 50%+, acceptable at 15–50%), with stats per spot and per texture. Keys 1–9 answer, Enter deals the next hand.
  - Works at phone width.
- **Caveats:**
  - Results are only as good as the baseline preflop ranges they come from, and those are approximate, not solver output.
  - The `laptop` tree has few turn and river sizes.
  - A nearest-flop answer borrows a similar board's strategy.
  - 0.5% of the pot is a study-grade solve, not a perfect one.
  - The solves have no rake.
