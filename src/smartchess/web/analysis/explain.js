// Template explanations built only from engine and Maia facts. Port of explain.py.

import { cpFromWin, formatCp } from './winprob.js';

export const pawns = win => formatCp(cpFromWin(win));

/** Python's round(x, digits) for the values the facts carry. */
export const round = (x, digits) => Number(x.toFixed(digits));

/** Python's f"{p:.0%}": round half to even. */
function percent(p) {
  const x = p * 100;
  const floor = Math.floor(x);
  const diff = x - floor;
  if (Math.abs(diff - 0.5) < 1e-9) return `${floor % 2 === 0 ? floor : floor + 1}%`;
  return `${Math.round(x)}%`;
}

export const pct = p => (p > 0 && p < 0.005 ? 'less than 1%' : percent(p));

const hardMoment = (c, start) => {
  const h = c.hardest;
  if (!h || h.findProb >= 0.5 || h.loss < 3) return null;
  const prefix = h.path.length ? `after ${start.variationSan(h.path)}, ` : '';
  return `${prefix}you need to find ${h.pos.numbered(h.needed)}, which players at your level find ${pct(h.findProb)} of the time`;
};

const lineOf = (pos, c) => `Line: ${pos.variationSan(c.line.pv.slice(0, 6))}`;

function bestAdvice(a) {
  const c = a.best;
  const text = [lineOf(a.pos, c)];
  const hard = hardMoment(c, a.pos.push(c.move));
  if (hard) text.push(`Careful: ${hard}.`);
  else if (c.naturalness >= 0.3) text.push(`It is also natural: ${pct(c.naturalness)} of players at your level would play it.`);
  return { role: 'best', title: 'Best', candidate: c, text };
}

function simpleAdvice(a) {
  const c = a.simplest;
  const b = a.pos;
  if (a.candidates.length === 1) {
    return { role: 'simple', title: 'Simplest', candidate: c, text: ['No alternative within the margin: here you need the best move.'] };
  }
  if (c.uci === a.best.uci) {
    const text = hardMoment(c, b.push(c.move))
      ? 'The alternatives within the margin are even harder to handle.'
      : 'The best move is also the easiest to handle at your level.';
    return { role: 'simple', title: 'Simplest', candidate: c, text: [text] };
  }
  const text = [
    `You give up little (${formatCp(c.line.cp)} against ${formatCp(a.best.line.cp)}), but playing at your `
    + `level you stay around ${pawns(c.simple)} on average, against ${pawns(a.best.simple)} with the best move.`,
    lineOf(b, c),
  ];
  const hard = hardMoment(c, b.push(c.move));
  if (hard) text.push(`The one tricky moment: ${hard}.`);
  return { role: 'simple', title: 'Simplest', candidate: c, text };
}

function trickyAdvice(a) {
  const c = a.trickiest;
  const b = a.pos;
  const pos = b.push(c.move);
  if (a.candidates.length === 1) {
    return { role: 'tricky', title: 'Trickiest', candidate: c, text: ['No alternative within the margin.'] };
  }
  const text = [];
  if (c.traps.length) {
    const t = c.traps[0];
    const replyPos = pos.push(t.reply);
    let line = `${pct(t.prob)} of players at your opponent's level answer ${pos.numbered(t.reply)}?`;
    if (t.punishment) {
      line += `, and after ${replyPos.numbered(t.punishment)}! you are at ${pawns(t.objectiveAfter)}`
        + ` (players at your level find it ${pct(t.findProb)} of the time)`;
    }
    text.push(`${line}.`);
    if (c.traps.length > 1) text.push(`In total, ${pct(c.errorProb)} of the likely replies are mistakes.`);
  } else if (c.tricky - c.objective >= 2) {
    text.push("No precise trap, but the opponent's most natural replies are inaccurate.");
  }
  if (c.uci === a.best.uci) {
    text.push('It is also the best move.');
  } else {
    if (c.uci === a.simplest.uci) text.push('It is also the simplest.');
    text.push(`Limited risk: against the best reply you stay at ${formatCp(c.line.cp)} (${formatCp(a.best.line.cp)} with the best move).`);
  }
  text.push(`Against a real opponent it scores ${pawns(c.tricky)} on average.`);
  return { role: 'tricky', title: 'Trickiest', candidate: c, text };
}

export const advise = a => [bestAdvice(a), simpleAdvice(a), trickyAdvice(a)];

/** The template drafts as {best, simple, tricky} paragraphs. */
export function drafts(a) {
  return Object.fromEntries(advise(a).map(adv => [adv.role, adv.text.join(' ')]));
}

