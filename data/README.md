# Data

- `preflop-equity-169.json` — exact preflop equity of every hand class vs every other (169×169, row vs column, grid order from `handClasses()`), averaged over all non-conflicting combo matchups. Regenerate with `npm run build:equity` (~70 s).
- `charts/` — preflop cash chart presets (editable in the app)
- `payouts/presets.json` — tournament payout structures for ICM
