// Session statistics and session-level leak flags, over hands in time order.
//
//   tightAfterLoss       VPIP in the `window` hands after a big loss (hero loses a pot of
//                        at least `bigLossBB`) drops by `vpipDrop` or more against the
//                        hands before it.
//   aggressionAfterLoss  hero's aggression (bets + raises as a share of bets, raises and
//                        calls) rises by `aggressionRise` or more after a big loss, or while
//                        hero is down at least `bigLossBB` over the last `window` hands.
// Both need at least `minHands` hands on each side (and `minActions` actions for
// aggression) so a handful of hands cannot trigger them.

import { results, toBB } from './hand.js';

export const SESSION_DEFAULTS = { bigLossBB: 30, window: 20, minHands: 8, vpipDrop: 0.1, aggressionRise: 0.15, minActions: 6 };

/** Hero's numbers for one hand. */
export function handStats(hand) {
  const hero = hand.hero;
  const pre = hand.actions.filter((a) => a.street === 'preflop' && a.type !== 'post');
  let raisesBefore = 0;
  let threeBetChance = false;
  let threeBet = false;
  let acted = false;
  for (const a of pre) {
    if (a.player === hero && !acted) {
      acted = true;
      if (raisesBefore === 1) {
        threeBetChance = true;
        threeBet = a.type === 'raise';
      }
    }
    if (a.type === 'raise' || a.type === 'bet') raisesBefore++;
  }
  const mine = hand.actions.filter((a) => a.player === hero && a.type !== 'post');
  const r = hero ? results(hand).get(hero) : null;
  return {
    id: hand.id,
    date: hand.date,
    format: hand.format,
    position: hand.players.find((p) => p.isHero)?.position ?? null,
    vpip: pre.some((a) => a.player === hero && (a.type === 'call' || a.type === 'raise' || a.type === 'bet')),
    pfr: pre.some((a) => a.player === hero && (a.type === 'raise' || a.type === 'bet')),
    threeBetChance,
    threeBet,
    aggressive: mine.filter((a) => a.type === 'bet' || a.type === 'raise').length,
    calls: mine.filter((a) => a.type === 'call').length,
    netBB: r ? toBB(r.net, hand) : 0,
    investedBB: r ? toBB(r.invested, hand) : 0,
  };
}

const share = (list, key) => (list.length ? list.filter((s) => s[key]).length / list.length : 0);
function aggression(list) {
  const agg = list.reduce((s, x) => s + x.aggressive, 0);
  const calls = list.reduce((s, x) => s + x.calls, 0);
  return { value: agg + calls ? agg / (agg + calls) : 0, actions: agg + calls };
}

/** Summary over hands: { hands, vpip, pfr, threeBet, netBB, bbPer100, aggression, byPosition }. */
export function sessionStats(hands) {
  const stats = hands.map(handStats);
  const chances = stats.filter((s) => s.threeBetChance);
  const byPosition = {};
  for (const s of stats) {
    const k = s.position ?? '?';
    byPosition[k] ??= { hands: 0, netBB: 0, vpip: 0 };
    byPosition[k].hands++;
    byPosition[k].netBB += s.netBB;
    byPosition[k].vpip += s.vpip ? 1 : 0;
  }
  for (const v of Object.values(byPosition)) v.vpip /= v.hands;
  const netBB = stats.reduce((sum, s) => sum + s.netBB, 0);
  return {
    hands: stats.length,
    vpip: share(stats, 'vpip'),
    pfr: share(stats, 'pfr'),
    threeBet: chances.length ? chances.filter((s) => s.threeBet).length / chances.length : 0,
    threeBetChances: chances.length,
    netBB,
    bbPer100: stats.length ? (netBB / stats.length) * 100 : 0,
    aggression: aggression(stats).value,
    byPosition,
  };
}

/** Session-level flags: [{ type, handIndex, handId, severity, message }]. */
export function detectSessionLeaks(hands, options = {}) {
  const o = { ...SESSION_DEFAULTS, ...options };
  const sorted = [...hands].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const stats = sorted.map(handStats);
  const flags = [];
  let quietUntil = -1;
  stats.forEach((s, i) => {
    if (i <= quietUntil || !(s.netBB <= -o.bigLossBB)) return;
    const before = stats.slice(Math.max(0, i - o.window), i);
    const after = stats.slice(i + 1, i + 1 + o.window);
    if (before.length < o.minHands || after.length < o.minHands) return;
    const loss = `losing ${Math.round(-s.netBB)} bb in hand ${s.id}`;
    const vBefore = share(before, 'vpip');
    const vAfter = share(after, 'vpip');
    if (vBefore - vAfter >= o.vpipDrop) {
      flags.push({
        type: 'tightAfterLoss',
        handIndex: i,
        handId: s.id,
        severity: vBefore - vAfter >= 2 * o.vpipDrop ? 'high' : 'medium',
        message: `After ${loss} you played ${Math.round(vAfter * 100)}% of hands over the next ${after.length}, down from ${Math.round(vBefore * 100)}% before. Tightening up after a big loss gives away the blinds and makes you easy to read; stick to your ranges.`,
      });
      quietUntil = i + after.length;
    }
    const aBefore = aggression(before);
    const aAfter = aggression(after);
    if (aBefore.actions >= o.minActions && aAfter.actions >= o.minActions && aAfter.value - aBefore.value >= o.aggressionRise) {
      flags.push({
        type: 'aggressionAfterLoss',
        handIndex: i,
        handId: s.id,
        severity: aAfter.value - aBefore.value >= 2 * o.aggressionRise ? 'high' : 'medium',
        message: `After ${loss} ${Math.round(aAfter.value * 100)}% of your bets, raises and calls were bets or raises, up from ${Math.round(aBefore.value * 100)}%. Getting more aggressive to win it back is a classic tilt pattern.`,
      });
      quietUntil = i + after.length;
    }
  });
  // Aggression while down over the recent hands (a falling stack), vs the rest.
  const down = [];
  const rest = [];
  stats.forEach((s, i) => {
    const recent = stats.slice(Math.max(0, i - o.window), i).reduce((sum, x) => sum + x.netBB, 0);
    (recent <= -o.bigLossBB ? down : rest).push(s);
  });
  const aDown = aggression(down);
  const aRest = aggression(rest);
  if (down.length >= o.minHands && rest.length >= o.minHands && aDown.actions >= o.minActions && aRest.actions >= o.minActions && aDown.value - aRest.value >= o.aggressionRise) {
    flags.push({
      type: 'aggressionAfterLoss',
      handIndex: stats.indexOf(down[0]),
      handId: down[0].id,
      severity: 'medium',
      message: `While you were down ${o.bigLossBB}+ bb over the last ${o.window} hands, ${Math.round(aDown.value * 100)}% of your bets, raises and calls were bets or raises, against ${Math.round(aRest.value * 100)}% otherwise.`,
    });
  }
  return flags;
}
