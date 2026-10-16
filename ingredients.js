// Tolkar ingrediensrader som "2 dl matlagningsgrädde" så att de kan skalas om och läggas på inköpslistan.

const FRACTIONS = { "½": "1/2", "¼": "1/4", "¾": "3/4", "⅓": "1/3", "⅔": "2/3" };
const UNITS = [
  "dl", "cl", "ml", "l", "liter", "msk", "tsk", "krm", "g", "gram", "kg", "hg", "st", "styck",
  "förp", "förpackning", "förpackningar", "paket", "pkt", "burk", "burkar", "påse", "påsar",
  "klyfta", "klyftor", "kruka", "krukor", "knippe", "knippen", "skiva", "skivor", "port", "portion", "portioner",
  "ask", "askar", "nypa", "tub", "tuber", "flaska", "flaskor", "näve", "kvist", "kvistar", "bit", "bitar",
];
const UNIT_RE = new RegExp(`^(${UNITS.join("|")})\\.?(?=\\s|$)\\s*`, "i");
const NUM = String.raw`\d+\s+\d+\/\d+|\d+\/\d+|\d+(?:[.,]\d+)?`;
const QTY_RE = new RegExp(`^(?:ca\\.?|cirka|ungefär)?\\s*(${NUM})(?:\\s*[-–]\\s*(${NUM}))?\\s*`, "i");

function toNumber(s) {
  s = s.trim().replace(",", ".");
  const mixed = s.match(/^(\d+)\s+(\d+)\/(\d+)$/);
  if (mixed) return +mixed[1] + mixed[2] / mixed[3];
  const frac = s.match(/^(\d+)\/(\d+)$/);
  if (frac) return frac[1] / frac[2];
  return parseFloat(s);
}

export function parseIngredient(line) {
  let s = line.trim();
  for (const [f, r] of Object.entries(FRACTIONS)) s = s.replace(new RegExp(`(\\d)?\\s*${f}`, "g"), (m, d) => (d ? `${d} ${r}` : r));
  const q = s.match(QTY_RE);
  if (!q) return { amount: null, max: null, unit: "", name: s };
  s = s.slice(q[0].length);
  const u = s.match(UNIT_RE);
  const unit = u ? u[1].toLowerCase() : "";
  if (u) s = s.slice(u[0].length);
  return { amount: toNumber(q[1]), max: q[2] ? toNumber(q[2]) : null, unit, name: s.trim() };
}

const HALVES = ["dl", "cl", "msk", "tsk", "krm"];
const WEIGHTS = ["g", "gram"];
const PRECISE = ["kg", "hg", "l", "liter", "ml"];

// Avrundar så att det går att handla: hela ägg och burkar, halva deciliter, jämna gram.
export function formatAmount(n, unit) {
  if (WEIGHTS.includes(unit)) n = n >= 20 ? Math.round(n / (n >= 200 ? 10 : 5)) * (n >= 200 ? 10 : 5) : Math.round(n);
  else if (HALVES.includes(unit)) n = Math.max(0.5, Math.round(n * 2) / 2);
  else if (PRECISE.includes(unit)) n = n >= 10 ? Math.round(n) : Math.round(n * 10) / 10;
  else n = Math.max(1, Math.ceil(n - 0.01));
  return String(n).replace(".", ",");
}

// Skalar en ingrediens och ger tillbaka namn och antal som de ska stå på inköpslistan.
export function scaleIngredient(line, factor) {
  const p = parseIngredient(line);
  if (p.amount == null || !p.name) return { name: capitalize(p.name || line.trim()), qty: "" };
  let qty = formatAmount(p.amount * factor, p.unit);
  if (p.max != null) qty += "–" + formatAmount(p.max * factor, p.unit);
  if (p.unit) qty += " " + p.unit;
  return { name: capitalize(p.name), qty };
}

const words = (s) => s.toLocaleLowerCase("sv").split(/[^a-zåäöéü]+/).filter(Boolean);

// En ingrediens räknas som basvara om något ord slutar på basvaran, t.ex. "svartpeppar" på "peppar".
export function isBasic(name, basics) {
  const ws = words(name);
  return basics.some((b) => {
    const bw = b.trim().toLocaleLowerCase("sv");
    return bw && ws.some((w) => w === bw || (bw.length >= 4 && w.endsWith(bw)));
  });
}

export const DEFAULT_BASICS = [
  "salt", "peppar", "mjöl", "socker", "olja", "smör", "vatten", "buljong", "fond", "soja",
  "bakpulver", "vaniljsocker", "oregano", "timjan", "paprikapulver", "curry", "spiskummin",
  "kanel", "chiliflakes", "lagerblad", "ättika",
];

function capitalize(s) { return s ? s[0].toLocaleUpperCase("sv") + s.slice(1) : s; }
