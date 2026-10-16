// Cloudflare Worker som hämtar ett recept från en webbadress åt Matlista.
// Den returnerar bara receptdata (namn, ingredienser, portioner, instruktioner),
// aldrig hela sidan, och svarar bara appen själv. Då kan den inte användas som öppen proxy.

const ALLOWED_ORIGINS = ["https://phandersson96-dev.github.io"];
const MAX_BYTES = 3_000_000;

export default {
  async fetch(request) {
    const origin = request.headers.get("Origin") || "";
    const allowed = ALLOWED_ORIGINS.includes(origin);
    const cors = {
      "Access-Control-Allow-Origin": allowed ? origin : ALLOWED_ORIGINS[0],
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Vary": "Origin",
    };
    const reply = (status, body) => new Response(JSON.stringify(body), {
      status, headers: { ...cors, "Content-Type": "application/json; charset=utf-8" },
    });

    if (request.method === "OPTIONS") return new Response(null, { status: allowed ? 204 : 403, headers: cors });
    if (!allowed) return reply(403, { error: "forbidden" });
    if (request.method !== "GET") return reply(405, { error: "method" });

    let target;
    try {
      target = new URL(new URL(request.url).searchParams.get("url") || "");
    } catch {
      return reply(400, { error: "bad-url" });
    }
    if (!/^https?:$/.test(target.protocol) || !isPublicHost(target.hostname)) {
      return reply(400, { error: "bad-url" });
    }

    let res;
    try {
      res = await fetch(target.toString(), {
        redirect: "follow",
        headers: {
          "User-Agent": "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36",
          "Accept": "text/html,application/xhtml+xml",
          "Accept-Language": "sv-SE,sv;q=0.9,en;q=0.8",
        },
        cf: { cacheTtl: 3600 },
      });
    } catch {
      return reply(502, { error: "fetch-failed" });
    }
    if (!res.ok) return reply(502, { error: "fetch-failed", status: res.status });
    if (!(res.headers.get("Content-Type") || "").includes("html")) return reply(422, { error: "not-html" });

    const html = (await res.text()).slice(0, MAX_BYTES);
    // Först strukturerad receptdata, annars ett försök att hitta ingredienslistan i texten (bloggar m.m.).
    const recipe = extractRecipe(html) || extractFromText(html);
    if (!recipe) return reply(422, { error: "no-recipe", title: pageTitle(html) });
    return reply(200, { ...recipe, url: res.url || target.toString() });
  },
};

function isPublicHost(host) {
  const h = host.toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return false;
  if (/^[\d.]+$/.test(h) || h.includes(":")) return false; // inga IP-adresser
  return h.includes(".");
}

export function extractRecipe(html) {
  const blocks = html.matchAll(/<script[^>]*type=["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi);
  for (const [, raw] of blocks) {
    let data;
    try {
      data = JSON.parse(raw.trim());
    } catch {
      try { data = JSON.parse(raw.trim().replace(/[\u0000-\u001f]+/g, " ")); } catch { continue; }
    }
    const node = findRecipe(data);
    if (node) return normalizeRecipe(node);
  }
  return null;
}

function findRecipe(data) {
  if (!data || typeof data !== "object") return null;
  if (Array.isArray(data)) {
    for (const d of data) { const r = findRecipe(d); if (r) return r; }
    return null;
  }
  const type = [].concat(data["@type"] || []);
  if (type.some((t) => String(t).toLowerCase() === "recipe")) return data;
  if (data["@graph"]) return findRecipe(data["@graph"]);
  if (data.mainEntity) return findRecipe(data.mainEntity);
  return null;
}

function normalizeRecipe(r) {
  return {
    title: clean(r.name || ""),
    servings: parseYield(r.recipeYield),
    ingredients: [].concat(r.recipeIngredient || r.ingredients || []).map(clean).filter(Boolean),
    instructions: flattenInstructions(r.recipeInstructions).map(clean).filter(Boolean),
    image: imageUrl(r.image),
    minutes: isoMinutes(r.totalTime) || (isoMinutes(r.prepTime) + isoMinutes(r.cookTime)) || null,
  };
}

// "PT1H30M" blir 90.
function isoMinutes(d) {
  const m = String(d || "").match(/P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/);
  return m ? (+m[1] || 0) * 1440 + (+m[2] || 0) * 60 + (+m[3] || 0) : 0;
}

function parseYield(y) {
  for (const v of [].concat(y || [])) {
    const m = String(v).match(/\d+/);
    if (m) return parseInt(m[0], 10);
  }
  return null;
}

function flattenInstructions(ins) {
  if (!ins) return [];
  if (typeof ins === "string") return ins.split(/\n+|(?<=\.)\s+(?=[A-ZÅÄÖ])/);
  if (Array.isArray(ins)) return ins.flatMap(flattenInstructions);
  if (ins.itemListElement) return flattenInstructions(ins.itemListElement);
  return [ins.text || ins.name || ""];
}

function imageUrl(img) {
  if (!img) return "";
  if (typeof img === "string") return img;
  if (Array.isArray(img)) return imageUrl(img[0]);
  return img.url || img.contentUrl || "";
}

function clean(s) {
  return decodeEntities(String(s).replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function decodeEntities(s) {
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", aring: "å", auml: "ä", ouml: "ö", Aring: "Å", Auml: "Ä", Ouml: "Ö", eacute: "é", frac12: "½", frac14: "¼", frac34: "¾" };
  return s.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (m, e) => {
    if (e[0] === "#") return String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return named[e] ?? m;
  });
}

// ---------- Recept i vanlig text ----------

const START_RE = /^(ingredienser|ingrediens|du behöver|det här behöver du|detta behöver du|till \d+ (portioner|personer))\b/i;
const STOP_RE = /^(gör så här|så här gör du|så gör du|gör så|instruktioner|instruktion|tillagning|tillvägagångssätt|beskrivning|metod)\b/i;
const END_RE = /^(dela|kommentarer|kommentera|taggar|läs (också|mer)|relaterat|annons|publicerad|smaklig måltid)\b/i;
const QTY_LINE = /^(ca\.?\s*|cirka\s*)?(\d|½|¼|¾|⅓|⅔)/;

function htmlToLines(html) {
  const body = html
    .replace(/<(script|style|noscript|svg|nav|header|footer|aside|form|button)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|li|h[1-6]|div|tr|dt|dd|section|article|blockquote)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n");
  return body.split("\n")
    .map((l) => clean(l).replace(/^[•·\-–*▪◦]\s*/, "").trim())
    .filter(Boolean);
}

const isHeading = (l) => /:$/.test(l) && l.length < 40;
const looksLikeIngredient = (l) => l.length <= 90 && !/[.!?]$/.test(l.replace(/\b(ca|st|förp|msk|tsk|krm|pkt)\.$/i, ""));

export function extractFromText(html) {
  const lines = htmlToLines(html);
  let ingredients = [];
  let after = -1;

  // 1. En rubrik som "Ingredienser" eller "Du behöver", följd av raderna fram till "Gör så här".
  const start = lines.findIndex((l) => START_RE.test(l));
  if (start >= 0) {
    let i = start + 1;
    for (; i < lines.length && ingredients.length < 50; i++) {
      const l = lines[i];
      if (STOP_RE.test(l) || END_RE.test(l)) break;
      if (isHeading(l)) continue;
      if (!looksLikeIngredient(l)) { if (ingredients.length >= 3) break; continue; }
      ingredients.push(l);
    }
    after = i;
  }

  // 2. Annars den längsta följden rader som börjar med en mängd ("2 dl grädde").
  if (ingredients.length < 2) {
    let best = [], cur = [], gap = 0, bestEnd = -1;
    lines.forEach((l, i) => {
      if (QTY_LINE.test(l) && looksLikeIngredient(l)) { cur.push(l); gap = 0; }
      else if (cur.length && gap === 0 && l.length < 40 && looksLikeIngredient(l) && !STOP_RE.test(l)) { cur.push(l); gap = 1; }
      else { if (gap) cur.pop(); if (cur.length > best.length) { best = cur; bestEnd = i; } cur = []; gap = 0; }
    });
    if (cur.length > best.length) { best = cur; bestEnd = lines.length; }
    if (best.filter((l) => QTY_LINE.test(l)).length >= 3) { ingredients = best; after = bestEnd; }
  }
  if (ingredients.length < 2) return null;

  // Instruktioner: raderna efter "Gör så här", tills sidan börjar handla om annat.
  const instructions = [];
  const stop = lines.findIndex((l, i) => i >= after - 1 && STOP_RE.test(l));
  if (stop >= 0) {
    for (let i = stop + 1; i < lines.length && instructions.length < 25; i++) {
      if (END_RE.test(lines[i]) || START_RE.test(lines[i])) break;
      if (lines[i].length > 3) instructions.push(lines[i]);
    }
  }

  const text = lines.join("\n");
  const servings = text.match(/(\d+)\s*(portioner|port\b|personer|pers\b)/i);
  const time = text.match(/(?:tillagningstid|total tid|tid)\s*:?\s*(?:ca\.?\s*)?(\d+)\s*(min|minuter|tim|timmar|h)\b/i);
  return {
    title: metaContent(html, "og:title") || clean((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || "") || pageTitle(html),
    servings: servings ? parseInt(servings[1], 10) : null,
    ingredients,
    instructions,
    image: metaContent(html, "og:image"),
    minutes: time ? parseInt(time[1], 10) * (/^(tim|h)/i.test(time[2]) ? 60 : 1) : null,
    fromText: true,
  };
}

function metaContent(html, prop) {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*>`, "i");
  const tag = (html.match(re) || [])[0];
  const m = tag && tag.match(/content=["']([^"']*)["']/i);
  return m ? clean(m[1]) : "";
}

function pageTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? clean(m[1]) : "";
}
