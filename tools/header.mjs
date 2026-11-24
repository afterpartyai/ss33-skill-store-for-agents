#!/usr/bin/env node
// Draws the README header (the ss33.ai skill-stack icon and the SS33 wordmark) as SVG, from the same
// character grid as the ASCII version, so the colours work on GitHub. Writes assets/header-light.svg and
// assets/header-dark.svg (the README picks one with <picture>).
//
//   node tools/header.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const ICON = String.raw`
          ▄▄█▄▄
      ▄▄█████████▄▄
  ▄▄█████████████████▄▄
▀▀█████████████████████▀▀
    ▀▀█████████████▀▀
██▄     ▀▀█████▀▀     ▄██
  ▀███▄     ▀     ▄███▀
██▄   ▀███▄   ▄███▀   ▄██
  ▀███▄   ▀███▀   ▄███▀
      ▀███▄   ▄███▀
          ▀███▀`.slice(1).split("\n");

const WORD = String.raw`
███████╗███████╗██████╗ ██████╗
██╔════╝██╔════╝╚════██╗╚════██╗
███████╗███████╗ █████╔╝ █████╔╝
╚════██║╚════██║ ╚═══██╗ ╚═══██╗
███████║███████║██████╔╝██████╔╝
╚══════╝╚══════╝╚═════╝ ╚═════╝`.slice(1).split("\n");

const CW = 12; // cell width; a terminal cell is about twice as tall as it is wide
const CH = 24;
const WORD_COL = 29; // where the wordmark starts, in cells
const WORD_ROW = 2;
const PAD = 16;

const THEMES = {
  light: { icon: ["#3B82F6", "#1D4ED8"], word: "#16181F", shadow: "#2563EB", brand: "#1D4ED8", tag: "#475569" },
  dark: { icon: ["#60A5FA", "#2563EB"], word: "#F8FAFC", shadow: "#60A5FA", brand: "#60A5FA", tag: "#94A3B8" },
};

// Double-line box drawing: which arms each character has.
const ARMS = { "═": "lr", "║": "ud", "╔": "rd", "╗": "ld", "╚": "ru", "╝": "lu" };

function cell(ch, x, y) {
  const r = (rx, ry, w, h) => `<rect x="${rx}" y="${ry}" width="${w}" height="${h}"/>`;
  if (ch === "█") return { fill: r(x, y, CW, CH) };
  if (ch === "▀") return { fill: r(x, y, CW, CH / 2) };
  if (ch === "▄") return { fill: r(x, y + CH / 2, CW, CH / 2) };
  const arms = ARMS[ch];
  if (!arms) return {};
  const cx = x + CW / 2, cy = y + CH / 2, d = 3, t = 2; // two parallel lines, d either side of the centre
  const parts = [];
  for (const a of arms) {
    for (const o of [-d, d]) {
      if (a === "l") parts.push(r(x, cy + o - t / 2, CW / 2 + d + t / 2, t));
      if (a === "r") parts.push(r(cx - d - t / 2, cy + o - t / 2, CW / 2 + d + t / 2, t));
      if (a === "u") parts.push(r(cx + o - t / 2, y, t, CH / 2 + d + t / 2));
      if (a === "d") parts.push(r(cx + o - t / 2, cy - d - t / 2, t, CH / 2 + d + t / 2));
    }
  }
  return { shadow: parts.join("") };
}

function layer(lines, col, row) {
  const out = { fill: "", shadow: "" };
  lines.forEach((line, i) =>
    [...line].forEach((ch, j) => {
      const c = cell(ch, PAD + (col + j) * CW, PAD + (row + i) * CH);
      out.fill += c.fill ?? "";
      out.shadow += c.shadow ?? "";
    }),
  );
  return out;
}

function svg(theme) {
  const t = THEMES[theme];
  const icon = layer(ICON, 0, 0);
  const word = layer(WORD, WORD_COL, WORD_ROW);
  const wordWidth = Math.max(...WORD.map((l) => [...l].length));
  const width = PAD * 2 + (WORD_COL + wordWidth) * CW;
  const height = PAD * 2 + ICON.length * CH;
  const tagY = PAD + (WORD_ROW + WORD.length + 1.6) * CH;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="SS33: Skill Store 33, agent skills for every task">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${t.icon[0]}"/><stop offset="1" stop-color="${t.icon[1]}"/></linearGradient></defs>
  <g fill="url(#g)" shape-rendering="crispEdges">${icon.fill}</g>
  <g fill="${t.shadow}" shape-rendering="crispEdges">${word.shadow}</g>
  <g fill="${t.word}" shape-rendering="crispEdges">${word.fill}</g>
  <text x="${PAD + WORD_COL * CW}" y="${tagY}" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace" font-size="17"><tspan fill="${t.brand}" font-weight="700">Skill Store 33</tspan><tspan fill="${t.tag}"> · agent skills for every task</tspan></text>
</svg>
`;
}

mkdirSync(join(root, "assets"), { recursive: true });
for (const theme of Object.keys(THEMES)) {
  const file = join(root, "assets", `header-${theme}.svg`);
  writeFileSync(file, svg(theme));
  console.log(`wrote ${file}`);
}
