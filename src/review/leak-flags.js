// Automatic leak detection on reviewed hands.
//
// detectLeaks(hand, states, analyses, options) → [{ type, street, actionIndex, severity,
// message }]. states come from buildStates; analyses from analyseDecision, each with an
// optional rangeSource ('default' | 'user') saying whether the villain range was edited.
//
//   oversizedJam       hero moves all-in for more than `oversizedJamRatio` times what the
//                      short stack already in can reach, while players behind still have
//                      chips: an isolation raise (or a call) does the same job for less.
//   callBelowRequired  hero calls with equity more than `callMargin` below the required
//                      equity (ICM required equity in tournaments when payouts are known).
//   nashDeviation      in a push/fold spot hero's action loses more than `nashLossBB` bb
//                      (or `nashLossShare` of the prize pool under ICM) against Nash.
//   foldedProfitable   hero folds when calling was worth at least `foldedProfitableBB` bb
//                      and the equity cleared the price by `foldedMargin`.
// Postflop flags that rest on a default (unnarrowed) range are marked low severity, since
// the default ranges are wide and only the user can narrow them.

export const LEAK_DEFAULTS = {
  oversizedJamRatio: 2.5,
  callMargin: 0.03,
  nashLossBB: 0.3,
  nashLossShare: 0.001,
  foldedProfitableBB: 1,
  foldedMargin: 0.05,
};

const pts = (x) => `${(x * 100).toFixed(1)}%`;
const bbText = (x) => `${Number(x.toFixed(1))} bb`;

function severityFor(gap, analysis, street) {
  if (street !== 'preflop' && analysis.rangeSource !== 'user') return 'low';
  return gap > 0.1 ? 'high' : 'medium';
}

function rangeCaveat(analysis, street) {
  return street !== 'preflop' && analysis.rangeSource !== 'user' ? ' This uses the default range; narrow it to what villain really has here to confirm.' : '';
}

/** Oversized all-ins found from the hand structure alone (no equity needed). */
export function oversizedJams(hand, states, ratio = LEAK_DEFAULTS.oversizedJamRatio) {
  const flags = [];
  const bb = hand.blinds.bb;
  for (const s of states) {
    const a = s.action;
    if (!s.isHero || !a.isAllIn || (a.type !== 'raise' && a.type !== 'bet')) continue;
    // Opponents who already put chips in voluntarily on this street are "in";
    // live opponents who have not acted yet are "behind".
    const inPlayers = new Set();
    for (let k = 0; k < s.actionIndex; k++) {
      const x = hand.actions[k];
      if (x.street === s.street && x.player !== hand.hero && (x.type === 'call' || x.type === 'bet' || x.type === 'raise')) inPlayers.add(x.player);
    }
    const reach = (p) => p.inStreet + p.stack;
    const opponents = s.table.filter((p) => p.name !== hand.hero && s.live.includes(p.name));
    const inOpp = opponents.filter((p) => inPlayers.has(p.name));
    if (!inOpp.length) continue;
    const short = Math.max(...inOpp.map(reach));
    const behind = opponents.filter((p) => !inPlayers.has(p.name) && !p.allIn && reach(p) > short);
    if (behind.length && a.to > ratio * short) {
      flags.push({
        type: 'oversizedJam',
        street: s.street,
        actionIndex: s.actionIndex,
        severity: a.to > 2 * ratio * short ? 'high' : 'medium',
        message: `You moved all-in for ${bbText(a.to / bb)} when the most the player already in could put in was ${bbText(short / bb)}, with ${behind.length} player${behind.length > 1 ? 's' : ''} still to act behind. A raise to about ${bbText((ratio * short) / bb)} (or a call) isolates just as well and risks far less if someone behind wakes up with a hand.`,
      });
    }
  }
  return flags;
}

/** All hand-level flags. analyses: one per hero decision (from analyseDecision). */
export function detectLeaks(hand, states, analyses = [], options = {}) {
  const o = { ...LEAK_DEFAULTS, ...options };
  const flags = oversizedJams(hand, states, o.oversizedJamRatio);
  for (const an of analyses) {
    if (!an) continue;
    const street = an.street;
    const icmReq = an.icm?.requiredEquity;
    const useIcm = hand.format !== 'cash' && Number.isFinite(icmReq);
    const required = useIcm ? icmReq : an.requiredEquity;
    if (an.kind === 'facingBet' && an.equity !== null && Number.isFinite(required)) {
      const gap = required - an.equity;
      if (an.heroAction === 'call' && gap > o.callMargin) {
        flags.push({
          type: 'callBelowRequired',
          street,
          actionIndex: an.actionIndex,
          severity: severityFor(gap, an, street),
          message: `You called needing ${pts(required)} equity${useIcm ? ' (ICM)' : ''} but had about ${pts(an.equity)} against ${an.villain}'s range: ${pts(gap)} short.${an.callEV !== null && !useIcm ? ` The call cost about ${bbText(-an.callEV)}.` : ''}${rangeCaveat(an, street)}`,
        });
      }
      if (an.heroAction === 'fold' && an.callEV !== null && an.callEV >= o.foldedProfitableBB && -gap >= o.foldedMargin) {
        flags.push({
          type: 'foldedProfitable',
          street,
          actionIndex: an.actionIndex,
          severity: severityFor(-gap, an, street),
          message: `You folded with about ${pts(an.equity)} equity when ${pts(required)} was enough${useIcm ? ' (ICM)' : ''}: calling was worth about +${bbText(an.callEV)}.${rangeCaveat(an, street)}`,
        });
      }
    }
    if (an.nash && an.nash.evLoss !== null) {
      const unit = an.nash.unit;
      const prizePool = hand.tournament?.payouts?.reduce((s, x) => s + x, 0) ?? 0;
      const limit = unit === '$' ? o.nashLossShare * prizePool : o.nashLossBB;
      if (an.nash.evLoss > limit && limit > 0) {
        const nashMove = an.nash.action === 'fold' ? 'fold' : an.nash.open ? 'jam' : 'call';
        const loss = unit === '$' ? `$${an.nash.evLoss.toFixed(2)}` : bbText(an.nash.evLoss);
        flags.push({
          type: 'nashDeviation',
          street,
          actionIndex: an.actionIndex,
          severity: an.nash.evLoss > 3 * limit ? 'high' : 'medium',
          message: `Push/fold spot: Nash says ${nashMove} (${pts(an.nash.frequency)} ${an.nash.open ? 'jam' : 'call'} frequency), you chose to ${an.nash.heroAction}. That gives up about ${loss}${an.nash.mode !== 'chipEV' ? ` (${an.nash.mode === 'icm' ? 'ICM' : 'PKO'})` : ''}.`,
        });
      }
    }
  }
  return flags.sort((x, y) => x.actionIndex - y.actionIndex);
}
