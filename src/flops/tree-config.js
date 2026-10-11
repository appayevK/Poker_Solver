// Bet tree and solver settings for the flop library: change sizes here only.
//
// Sizes are percentages, as TexasSolver reads them (checked against real solves):
//   bet X    bet X% of the pot
//   raise X  raise by X% of the pot after calling; 50 gives about 3.5x a 33% bet
//            and about 2.7x a 75% bet ("about 3x")
//   allin    adds an all-in option to every bet and raise of that player on that
//            street, including leads, so it is left off on the flop; raises still
//            become all-in through the threshold (a bet or raise that would put in
//            more than allinThreshold of the remaining stack goes all-in)
// Flop raise sizes can differ by player and pot type: { oop: [...], ip: { SRP, 3BP } }.
// TexasSolver caps a street at 4 raises. OOP never leads into the previous street's
// aggressor (no "donk" sizes); OOP only bets the flop in 3-bet pots, where it was the
// preflop aggressor.
//
// Memory (peak private memory of one solve, measured on SRP BTN vs BB, the widest
// ranges, flop AsTh5d; thread count barely matters):
//   full    turn/river bet 50+100, raise 50, all-in        15.8 GB (thrashes a 16 GB laptop)
//   laptop  turn bet 66, river bet 75, raises all-in only;
//           in SRPs IP only calls or folds vs a check-raise  3.0 GB
// 3-bet pots need far less (about 0.8 GB with laptop).

export const TREE_PRESETS = {
  laptop: {
    name: 'laptop',
    scale: 10, // solver chips per big blind (TexasSolver rounds bets to whole chips)
    allinThreshold: 0.67,
    flop: {
      ipBet: [33, 75],
      oopBet: { SRP: [], '3BP': [33] },
      raise: { oop: [50], ip: { SRP: [], '3BP': [50] } },
      allin: false,
    },
    turn: { bet: [66], raise: [], allin: true },
    river: { bet: [75], raise: [], allin: true },
  },
  full: {
    name: 'full',
    scale: 10,
    allinThreshold: 0.67,
    flop: {
      ipBet: [33, 75],
      oopBet: { SRP: [], '3BP': [33] },
      raise: { oop: [50], ip: [50] },
      allin: false,
    },
    turn: { bet: [50, 100], raise: [50], allin: true },
    river: { bet: [50, 100], raise: [50], allin: true },
  },
};

/** Default tree: fits a laptop with a few GB free. */
export const TREE = TREE_PRESETS.laptop;

/** A preset by name, or a clear error. */
export function treePreset(name = 'laptop') {
  const tree = TREE_PRESETS[name];
  if (!tree) throw new Error(`Unknown tree "${name}" (use ${Object.keys(TREE_PRESETS).join(' or ')})`);
  return tree;
}

export const SOLVER = {
  accuracy: 0.5, // stop at this exploitability, % of the pot
  maxIterations: 300,
  printInterval: 10,
  isomorphism: 1,
  dumpRounds: 1, // flop decisions only; later streets are solved but not written out
};
