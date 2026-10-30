'use strict';

/* Tiny terminal toolkit: colour, visible-width padding, bars, sparklines and a
 * live-redrawing block. No dependencies. */

const out = process.stdout;
const env = process.env;

const enabled = !('NO_COLOR' in env) && env.TERM !== 'dumb' && (out.isTTY || 'FORCE_COLOR' in env);
const truecolor = /truecolor|24bit/i.test(env.COLORTERM || '') || env.TERM_PROGRAM === 'iTerm.app' || 'WT_SESSION' in env;

let colorOn = enabled;
function setColor(on) { colorOn = on; }

const PALETTE = {
  signal: [[110, 236, 214], 36],
  amber: [[255, 181, 71], 33],
  coral: [[255, 94, 126], 31],
  sky: [[122, 167, 255], 34],
  violet: [[177, 140, 255], 35],
  text: [[227, 234, 247], 37],
  muted: [[131, 148, 184], 90],
  dim: [[62, 80, 118], 90],
};

function paint(name, s) {
  if (!colorOn) return String(s);
  const [rgb, basic] = PALETTE[name];
  const open = truecolor ? `\x1b[38;2;${rgb.join(';')}m` : `\x1b[${basic}m`;
  return `${open}${s}\x1b[39m`;
}
function bgPaint(name, s) {
  if (!colorOn) return String(s);
  const [rgb, basic] = PALETTE[name];
  const open = truecolor ? `\x1b[48;2;${rgb.join(';')}m` : `\x1b[${basic + 10}m`;
  return `${open}${s}\x1b[49m`;
}

const c = Object.fromEntries(Object.keys(PALETTE).map((k) => [k, (s) => paint(k, s)]));
c.bold = (s) => (colorOn ? `\x1b[1m${s}\x1b[22m` : String(s));
c.bg = bgPaint;
c.status = (status, s) => {
  if (status === 'ok') return c.signal(s);
  if (status === 'warn') return c.amber(s);
  if (status === 'fail' || status === 'error') return c.coral(s);
  return c.muted(s);
};

const ANSI = /\x1b\[[0-9;]*m/g;
function strip(s) { return String(s).replace(ANSI, ''); }

/** Display width: wide for CJK/emoji, zero for combining marks. */
function width(s) {
  let w = 0;
  for (const ch of strip(s)) {
    const cp = ch.codePointAt(0);
    if (cp < 32 || (cp >= 0x300 && cp <= 0x36f) || cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) continue;
    w += (cp >= 0x1100 && (cp <= 0x115f || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3)
      || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60)
      || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff))) ? 2 : 1;
  }
  return w;
}
function pad(s, n, align = 'left') {
  const gap = Math.max(0, n - width(s));
  return align === 'right' ? ' '.repeat(gap) + s : s + ' '.repeat(gap);
}
function truncate(s, n) {
  const plain = strip(s);
  if (width(plain) <= n) return s;
  let acc = '';
  for (const ch of plain) {
    if (width(acc + ch) > n - 1) break;
    acc += ch;
  }
  return `${acc}…`;
}

const unicode = process.platform !== 'win32' || 'WT_SESSION' in env || env.TERM_PROGRAM === 'vscode';
const sym = unicode
  ? { ok: '●', warn: '▲', fail: '✕', error: '✕', pending: '○', arrow: '→', tick: '✓', cross: '✕', dot: '·', block: '█', light: '░' }
  : { ok: '*', warn: '!', fail: 'x', error: 'x', pending: 'o', arrow: '->', tick: 'v', cross: 'x', dot: '-', block: '#', light: '.' };

const SPIN = unicode ? ['◜', '◠', '◝', '◞', '◡', '◟'] : ['-', '\\', '|', '/'];

/** Horizontal meter. `parts` are [fraction, colourName] stacked left to right. */
function meter(parts, size) {
  let used = 0;
  let s = '';
  for (const [frac, color] of parts) {
    const n = Math.max(frac > 0 ? 1 : 0, Math.round(frac * size));
    const take = Math.min(n, size - used);
    s += c[color](sym.block.repeat(take));
    used += take;
  }
  return s + c.dim(sym.light.repeat(Math.max(0, size - used)));
}

function sparkline(values) {
  const ticks = unicode ? '▁▂▃▄▅▆▇█' : '_.-~=*#@';
  const ok = values.filter((v) => v != null);
  if (!ok.length) return '';
  const min = Math.min(...ok);
  const max = Math.max(...ok);
  return values.map((v) => {
    if (v == null) return c.coral(sym.cross);
    const i = max === min ? 2 : Math.round(((v - min) / (max - min)) * (ticks.length - 1));
    return c.signal(ticks[i]);
  }).join('');
}

function cols() { return Math.max(60, Math.min(out.columns || 100, 120)); }

/**
 * A block of lines that is redrawn in place while work is in flight, then
 * committed. Falls back to printing once at the end when stdout is not a TTY.
 */
class LiveBlock {
  constructor(render) {
    this.render = render;
    this.lines = 0;
    this.frame = 0;
    this.live = out.isTTY && colorOn;
    if (this.live) {
      out.write('\x1b[?25l');
      this.timer = setInterval(() => this.draw(), 90);
      this.restore = () => out.write('\x1b[?25h');
      process.once('exit', this.restore);
    }
  }

  draw() {
    if (!this.live) return;
    this.frame += 1;
    const text = this.render(SPIN[this.frame % SPIN.length]);
    if (this.lines) out.write(`\x1b[${this.lines}A\x1b[0J`);
    out.write(`${text}\n`);
    this.lines = text.split('\n').length;
  }

  done() {
    if (this.live) {
      clearInterval(this.timer);
      this.draw();
      this.restore();
      process.removeListener('exit', this.restore);
    } else {
      out.write(`${this.render(' ')}\n`);
    }
  }
}

module.exports = { c, sym, strip, width, pad, truncate, meter, sparkline, cols, LiveBlock, setColor, isColor: () => colorOn };
