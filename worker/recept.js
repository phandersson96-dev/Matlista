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
    const recipe = extractRecipe(html);
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
  };
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

function pageTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? clean(m[1]) : "";
}
