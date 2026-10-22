// JSON-ready facts about an analysed position. Port of facts.py (position_facts).

import { material, moveMotifs, opponentThreats, piecesSummary } from './motifs.js';
import { pawns, round } from './explain.js';
import { moveUci } from './position.js';
import { formatCp } from './winprob.js';

export const MOMENT_LABELS = { mistake: 'mistake', choice: 'practical choice' };

const line = (pos, moves) => ({ san: moves.length ? pos.variationSan(moves) : '', uci: moves.map(moveUci) });

export function candidateFacts(pos, c) {
  const after = pos.push(c.move);
  const traps = c.traps.slice(0, 3).map(t => {
    const replyPos = after.push(t.reply);
    return {
      reply: after.numbered(t.reply),
      reply_uci: moveUci(t.reply),
      prob: round(t.prob, 3),
      eval_after: pawns(t.objectiveAfter),
      punishment: t.punishment ? replyPos.numbered(t.punishment) : null,
      punishment_uci: t.punishment ? moveUci(t.punishment) : null,
      find_prob: round(t.findProb, 3),
      motifs_punishment: t.punishment ? moveMotifs(replyPos, t.punishment) : [],
    };
  });
  let critical = null;
  const h = c.hardest;
  if (h && h.loss >= 3) {
    critical = {
      after: line(after, h.path),
      needed: h.pos.numbered(h.needed),
      needed_uci: moveUci(h.needed),
      find_prob: round(h.findProb, 3),
      loss_win_pct: round(h.loss, 1),
      fen: h.pos.fen(),
    };
  }
  return {
    move: pos.numbered(c.move),
    san: pos.san(c.move),
    uci: c.uci,
    eval: formatCp(c.line.cp),
    cp: c.line.cp,
    line: line(pos, c.line.pv.slice(0, 8)),
    at_your_level: pawns(c.simple),
    vs_human: pawns(c.tricky),
    win: { objective: round(c.objective, 1), simple: round(c.simple, 1), tricky: round(c.tricky, 1) },
    naturalness: round(c.naturalness, 3),
    opponent_error_prob: round(c.errorProb, 3),
    motifs: moveMotifs(pos, c.move),
    traps,
    critical_moment: critical,
  };
}

export function positionFacts(a, played = null, playedCp = null, playedPv = null, kind = null) {
  const b = a.pos;
  const side = b.turn;
  const opp = side === 'white' ? 'black' : 'white';
  const facts = {
    fen: b.fen(),
    moment: MOMENT_LABELS[kind] ?? null,
    side,
    opponent_side: opp,
    move_number: b.fullmoves,
    user_elo: a.players.userElo,
    opponent_elo: a.players.oppElo,
    eval_note: 'Evaluations are from your point of view: + means better for you.',
    material_balance: material(b, side) - material(b, opp),
    your_pieces: piecesSummary(b, side),
    opponent_pieces: piecesSummary(b, opp),
    opponent_threats: opponentThreats(b),
    best: candidateFacts(b, a.best),
    simple: candidateFacts(b, a.simplest),
    tricky: candidateFacts(b, a.trickiest),
    candidates: a.candidates.map(c => {
      const f = candidateFacts(b, c);
      return {
        san: f.san, uci: f.uci, eval: f.eval, at_your_level: f.at_your_level, vs_human: f.vs_human,
        naturalness: f.naturalness, opponent_error_prob: f.opponent_error_prob,
      };
    }),
  };
  facts.same = {
    simple_is_best: facts.simple.uci === facts.best.uci,
    tricky_is_best: facts.tricky.uci === facts.best.uci,
    tricky_is_simple: facts.tricky.uci === facts.simple.uci,
    only_one_candidate: a.candidates.length === 1,
  };
  if (played) {
    facts.played = {
      move: b.numbered(played),
      san: b.san(played),
      uci: moveUci(played),
      eval: playedCp !== null ? formatCp(playedCp) : null,
      motifs: moveMotifs(b, played),
      line: playedPv && playedPv.length ? line(b, playedPv.slice(0, 8)) : null,
    };
    facts.played.roles = ['best', 'simple', 'tricky'].filter(r => facts[r].uci === facts.played.uci);
  }
  return facts;
}

/**
 * At key moments, judge the user's move by the three options: a move that is the best,
 * simplest or trickiest option is shown as such and never as a mistake.
 */
export function markPlayedOptions(review) {
  for (const [ply, item] of Object.entries(review.critical)) {
    const roles = item.facts.played?.roles ?? [];
    if (!roles.length) continue;
    const p = review.plies[Number(ply)];
    p.judgement = roles[0];
    if (item.kind === 'mistake') {
      item.kind = p.critical_kind = 'choice';
      item.facts.moment = MOMENT_LABELS.choice;
    }
  }
  return review;
}
