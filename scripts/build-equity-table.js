// Generates data/preflop-equity-169.json: equity of every hand class vs every other.
// Run with: npm run build:equity

import { handClasses } from '../src/engine/ranges.js';
import { exactEquity } from '../src/engine/equity.js';

// TODO: loop over 169 x 169 class pairs, average over combo matchups, write JSON.
console.log('build-equity-table: not implemented yet');
