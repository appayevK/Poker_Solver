# Build plan

## Architecture
- Single page app, five tabs (Review, Ranges, Equity/EV, ICM, Nash) on one shared engine.
- Heavy maths (equity runs, Nash iterations) in Web Workers so the UI never freezes.
- Precomputed data shipped with the app: 169×169 preflop equity table, evaluator lookup tables.
- Hands, notes, leak tags and edited ranges persist between sessions.

## Core engine (`src/engine`)
- 5–7 card evaluator (bitmask / lookup based), target millions of evals per second.
- Range parser: `22+, A2s+, KTo+, 76s`, per-hand weights.
- Combo counting with card removal / blockers.
- Equity: exact enumeration with a board or HU preflop; Monte Carlo for multiway and range vs range preflop.

## 1. Equity / EV (`src/calc/ev.js`, `src/calc/pko.js`)
- Hand vs hand, hand vs range, range vs range, optional board.
- Decision EV: fold / call / jam, pot odds, required equity, break-even fold equity.
- Bet EV from equity when called, fold frequency and sizing.
- PKO: half of bounty paid immediately, half added to own bounty; convert to chip value and adjust required equity.

## 2. ICM (`src/calc/icm.js`)
- Malmuth-Harville with memoised recursion, up to ~10 players.
- Per-player $EV, $EV of a jam/call, risk premium vs chip EV.
- Combined ICM + PKO.

## 3. Nash push/fold (`src/nash`)
- HU push/fold via fictitious play / CFR over 169 hands; validate against published charts.
- 3–9 handed: jam/fold per position, call ranges behind; multiway equities computed on demand and cached.
- Modes: chip EV, ICM, PKO; antes and BB ante.
- Output: range grid of jam frequencies, compare-my-jam check.

## 4. Preflop cash (`src/preflop`)
- No full preflop solve in-browser. Editable charts (RFI, 3-bet, defend, 4-bet) for 6-max 100bb.
- Trainer: random spots, pick an action, scored against the chart.
- Range checks: defend-range equity vs open range, bluff break-even frequency.

## 5. Hand review (`src/review`)
- Two inputs into one internal hand format: GGPoker parser (cash, Rush & Cash, PKO) and manual entry.
- Replayer: pot, SPR, pot odds, equity vs assigned villain range, option EVs, ICM/PKO adjustment.
- Leak flags: jam size vs effective stack, calls below required equity, big Nash deviations.
- Notes, tags, later batch import with filters and stats.

## 6. Pre-solved flop library (`src/flops`)
- Solve a representative flop subset offline with TexasSolver (console version, run locally; never bundled) for a few common spots: SRP BTN vs BB, SRP CO vs BB, 3BP SB vs BTN, 3BP BB vs BTN. Ranges come from the baseline preflop chart.
- Simple bet tree; turn and river are solved underneath but only flop decisions are stored and shown.
- Flop tab: any board maps to its stored strategy (exact or nearest texture), 13×13 action-mix grid with per-combo detail, texture reports with plain-language takeaways, and a flop trainer.

## 7. Exploits and pool spots
- Exploit maths in the EV tab (how much to deviate when villain over-folds or over-calls).
- "Pool" versions of key flop spots where villain is locked to a common low-stakes mistake, with a GTO / pool toggle in the Flop tab.

## Validation
Each phase ends with checks against known values: AA vs KK ≈ 82%, published HU Nash charts, textbook ICM examples.

## Needed from Kerim
- GGPoker hand histories → `tests/fixtures/hand-histories/`: a cash NL25 session is in; Rush & Cash and PKO exports are still needed
- Usual payout structures and bounty settings → `data/payouts/presets.json`

## Out of scope (for now)
Solving postflop spots in the browser. Phase 6 ships pre-solved flop data instead; turn and river strategies are not stored or shown.
