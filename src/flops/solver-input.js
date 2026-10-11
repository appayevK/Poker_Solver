// TexasSolver console input files, in the syntax of the release's
// resources/text/commandline_sample_input.txt (command per line, comma-separated
// arguments, ranges as comma-separated classes with optional ":weight").

import { TREE, SOLVER } from './tree-config.js';
import { solverRange } from './spots.js';
import { parseCards, cardToString } from '../engine/cards.js';

const sizes = (list) => list.map((x) => String(x)).join(',');

/**
 * Flop raise sizes for a player. tree.flop.raise is either one list for both players
 * or { oop: list | { SRP, 3BP }, ip: list | { SRP, 3BP } }.
 */
export function flopRaiseSizes(tree, player, spotType) {
  const r = tree.flop.raise;
  if (Array.isArray(r)) return r;
  const v = r?.[player];
  return Array.isArray(v) ? v : v?.[spotType] ?? [];
}

/**
 * Input file text for one (spot, flop) solve.
 * spot: a resolved spot (spots.js); flop: '3 cards'; dumpPath: where the strategy is written;
 * threads: solver threads. Amounts are scaled to whole chips (TREE.scale per bb).
 */
export function buildSolverInput({ spot, flop, dumpPath, threads, tree = TREE, solver = SOLVER }) {
  const board = parseCards(flop).map(cardToString).join(',');
  const chips = (bb) => {
    const x = bb * tree.scale;
    if (Math.abs(x - Math.round(x)) > 1e-9) throw new Error(`${bb}bb is not a whole number of chips at scale ${tree.scale}`);
    return Math.round(x);
  };
  const lines = [
    `set_pot ${chips(spot.pot)}`,
    `set_effective_stack ${chips(spot.stack)}`,
    `set_board ${board}`,
    `set_range_ip ${solverRange(spot.ranges.ip)}`,
    `set_range_oop ${solverRange(spot.ranges.oop)}`,
  ];
  // One line per (player, street, kind); kinds without sizes are left out.
  const add = (player, street, kind, list) => {
    if (list?.length) lines.push(`set_bet_sizes ${player},${street},${kind},${sizes(list)}`);
  };
  add('oop', 'flop', 'bet', tree.flop.oopBet[spot.type] ?? []);
  add('oop', 'flop', 'raise', flopRaiseSizes(tree, 'oop', spot.type));
  if (tree.flop.allin) lines.push('set_bet_sizes oop,flop,allin');
  add('ip', 'flop', 'bet', tree.flop.ipBet);
  add('ip', 'flop', 'raise', flopRaiseSizes(tree, 'ip', spot.type));
  if (tree.flop.allin) lines.push('set_bet_sizes ip,flop,allin');
  for (const street of ['turn', 'river']) {
    for (const player of ['oop', 'ip']) {
      add(player, street, 'bet', tree[street].bet);
      add(player, street, 'raise', tree[street].raise);
      if (tree[street].allin) lines.push(`set_bet_sizes ${player},${street},allin`);
    }
  }
  lines.push(
    `set_allin_threshold ${tree.allinThreshold}`,
    'build_tree',
    `set_thread_num ${threads}`,
    `set_accuracy ${solver.accuracy}`,
    `set_max_iteration ${solver.maxIterations}`,
    `set_print_interval ${solver.printInterval}`,
    `set_use_isomorphism ${solver.isomorphism}`,
    'start_solve',
    `set_dump_rounds ${solver.dumpRounds}`,
    `dump_result ${dumpPath.replace(/\\/g, '/')}`,
  );
  return `${lines.join('\n')}\n`;
}
