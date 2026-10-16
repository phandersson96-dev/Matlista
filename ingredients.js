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

// Bloggar skriver ofta mängden i ord: "en gul lök", "ett halvt paket".
const WORD_NUMBERS = {
  "en halv": "1/2", "ett halvt": "1/2", "halv": "1/2", "halvt": "1/2", "en": "1", "ett": "1", "två": "2", "tre": "3",
  "fyra": "4", "fem": "5", "sex": "6", "sju": "7", "åtta": "8", "nio": "9", "tio": "10", "ett par": "2",
};
const WORD_RE = new RegExp(`^(${Object.keys(WORD_NUMBERS).sort((a, b) => b.length - a.length).join("|")})(?=\\s)`, "i");
// Mängden sist: "Grädde 2 dl", "Kycklingfilé, ca 600 g".
const TRAILING_RE = new RegExp(`^(.*?[^\\d\\s,:])[\\s,:]+((?:ca\\.?|cirka)\\s*)?(${NUM})(?:\\s*[-–]\\s*(${NUM}))?\\s*(${UNITS.join("|")})?\\.?$`, "i");

export function parseIngredient(line) {
  let s = line.replace(/^[\s\u200b\u00a0•·*▪◦–-]+/, "").replace(/\u00a0/g, " ").trim();
  for (const [f, r] of Object.entries(FRACTIONS)) s = s.replace(new RegExp(`(\\d)?\\s*${f}`, "g"), (m, d) => (d ? `${d} ${r}` : r));
  s = s.replace(WORD_RE, (w) => WORD_NUMBERS[w.toLocaleLowerCase("sv")]);
  const q = s.match(QTY_RE);
  if (!q) {
    const t = s.match(TRAILING_RE);
    if (t) return { amount: toNumber(t[3]), max: t[4] ? toNumber(t[4]) : null, unit: (t[5] || "").toLowerCase(), name: t[1].trim() };
    return { amount: null, max: null, unit: "", name: s };
  }
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
  let unit = p.unit;
  let n = p.amount * factor, max = p.max != null ? p.max * factor : null;
  // 1000 g visas som 1 kg.
  if (WEIGHTS.includes(unit) && n >= 1000) { unit = "kg"; n /= 1000; if (max != null) max /= 1000; }
  let qty = formatAmount(n, unit);
  if (max != null) qty += "–" + formatAmount(max, unit);
  if (unit) qty += " " + unit;
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

// ---------- Slå ihop mängder ----------
// "2 dl" + "0,5 l" blir "7 dl". Enheter som inte går att räkna om står kvar bredvid varandra: "1 paket + 2 dl".

const DIMENSIONS = {
  volume: { ml: 1, cl: 10, dl: 100, l: 1000, liter: 1000 },
  spoon: { krm: 1, tsk: 5, msk: 15 },
  weight: { g: 1, gram: 1, hg: 100, kg: 1000 },
};
const dimensionOf = (unit) => Object.keys(DIMENSIONS).find((d) => unit in DIMENSIONS[d]);
const countUnit = (unit) => (unit === "st" || unit === "styck" ? "" : unit);

function parseQty(qty) {
  return String(qty || "").split("+").map((part) => part.trim()).filter(Boolean).map((part) => {
    const p = parseIngredient(part + " x");
    return p.amount == null ? { text: part } : { amount: p.amount, max: p.max, unit: p.unit };
  });
}

function trim(n, decimals) {
  return String(Math.round(n * 10 ** decimals) / 10 ** decimals).replace(".", ",");
}

function formatTotal(dim, base, units) {
  const same = units.size === 1 ? [...units][0] : null;
  if (dim === "volume") {
    if (base >= 1000) return `${trim(base / 1000, 2)} l`;
    if (same === "ml" || same === "cl") return `${trim(base / DIMENSIONS.volume[same], 1)} ${same}`;
    return `${trim(Math.max(0.5, Math.round(base / 50) / 2), 1)} dl`;
  }
  if (dim === "spoon") {
    if (same) return `${trim(base / DIMENSIONS.spoon[same], 1)} ${same}`;
    return base >= 15 ? `${trim(Math.round(base / 7.5) / 2, 1)} msk` : `${trim(base / 5, 1)} tsk`;
  }
  if (base >= 1000) return `${trim(base / 1000, 2)} kg`;
  if (same === "hg") return `${trim(base / 100, 1)} hg`;
  return `${Math.round(base)} g`;
}

export function mergeQty(a, b) {
  const parts = [...parseQty(a), ...parseQty(b)];
  if (!parts.length) return "";
  const groups = new Map();
  const order = [];
  for (const p of parts) {
    const dim = p.text ? null : dimensionOf(p.unit);
    const key = p.text ? `text:${p.text}` : dim ? `dim:${dim}` : `unit:${countUnit(p.unit)}`;
    if (!groups.has(key)) { groups.set(key, { dim, unit: countUnit(p.unit || ""), min: 0, max: 0, ranged: false, units: new Set(), text: p.text }); order.push(key); }
    const g = groups.get(key);
    if (p.text) continue;
    const f = dim ? DIMENSIONS[dim][p.unit] : 1;
    g.min += p.amount * f;
    g.max += (p.max ?? p.amount) * f;
    g.ranged ||= p.max != null;
    g.units.add(p.unit);
  }
  return order.map((key) => {
    const g = groups.get(key);
    if (g.text) return g.text;
    if (g.dim) {
      const low = formatTotal(g.dim, g.min, g.units);
      return g.ranged ? `${low.split(" ")[0]}–${formatTotal(g.dim, g.max, g.units)}` : low;
    }
    const n = g.ranged ? `${trim(g.min, 1)}–${trim(g.max, 1)}` : trim(g.min, 1);
    return g.unit ? `${n} ${g.unit}` : n;
  }).join(" + ");
}

// Namn som räknas som samma vara: utan skiftläge och utan parentes, t.ex. "Krossade tomater (400 g)".
export function itemKey(name) {
  return String(name).replace(/\([^)]*\)/g, "").trim().toLocaleLowerCase("sv").replace(/\s+/g, " ");
}
