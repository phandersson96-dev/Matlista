// Cloudflare Worker för Matlista. Två uppgifter:
// 1. Hämtar ett recept från en webbadress. Den returnerar bara receptdata (namn, ingredienser,
//    portioner, instruktioner), aldrig hela sidan, och svarar bara appen själv. Då kan den inte
//    användas som öppen proxy.
// 2. Skickar påminnelser som notiser kl 18 kvällen före, t.ex. att ta fram kycklingen ur frysen.
//    Kräver en KV-lagring kopplad som MATLISTA och en Cron Trigger varje timme (se guiden).

const ALLOWED_ORIGINS = ["https://phandersson96-dev.github.io"];
const APP_URL = "https://phandersson96-dev.github.io/Matlista/";
const FIREBASE_PROJECT = "matlista-fd0d5";
const MAX_BYTES = 3_000_000;
const SEND_HOUR = 18;

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowed = ALLOWED_ORIGINS.includes(origin);
    const cors = {
      "Access-Control-Allow-Origin": allowed ? origin : ALLOWED_ORIGINS[0],
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Vary": "Origin",
    };
    const reply = (status, body) => new Response(JSON.stringify(body), {
      status, headers: { ...cors, "Content-Type": "application/json; charset=utf-8" },
    });

    if (request.method === "OPTIONS") return new Response(null, { status: allowed ? 204 : 403, headers: cors });
    if (!allowed) return reply(403, { error: "forbidden" });

    const path = new URL(request.url).pathname;
    if (path.startsWith("/push/")) return handlePush(request, env, path, reply);
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

  // Körs varje timme av Cron Trigger. Skickar bara när klockan är 18 i Sverige.
  async scheduled(event, env, ctx) {
    if (!env.MATLISTA) return;
    const { date, hour } = stockholmNow(new Date(event.scheduledTime || Date.now()));
    if (hour !== SEND_HOUR) return;
    ctx.waitUntil(sendDue(env, date));
  },
};

// ---------- Påminnelser ----------

async function handlePush(request, env, path, reply) {
  if (!env.MATLISTA) return reply(503, { error: "no-storage" });
  const kv = env.MATLISTA;
  const vapid = await vapidKeys(kv);
  if (path === "/push/key") return reply(200, { publicKey: vapid.publicKey });
  if (request.method !== "POST") return reply(405, { error: "method" });
  // Bara inloggade i Matlista får ändra något: Firebase-reglerna avgör, precis som i appen.
  if (!(await allowedUser(request.headers.get("Authorization") || ""))) return reply(401, { error: "auth" });

  let body;
  try { body = await request.json(); } catch { return reply(400, { error: "bad-json" }); }
  const subs = (await kv.get("subs", "json")) || [];

  if (path === "/push/subscribe") {
    const sub = cleanSubscription(body.subscription);
    if (!sub) return reply(400, { error: "bad-subscription" });
    const rest = subs.filter((s) => s.endpoint !== sub.endpoint);
    await kv.put("subs", JSON.stringify([...rest, sub].slice(-10)));
    return reply(200, { ok: true });
  }
  if (path === "/push/unsubscribe") {
    await kv.put("subs", JSON.stringify(subs.filter((s) => s.endpoint !== body.endpoint)));
    return reply(200, { ok: true });
  }
  if (path === "/push/schedule") {
    const reminders = (Array.isArray(body.reminders) ? body.reminders : []).slice(0, 100).map((r) => ({
      date: String(r.date || "").slice(0, 10), title: String(r.title || "").slice(0, 120),
      body: String(r.body || "").slice(0, 300), tag: String(r.tag || "").slice(0, 60),
    })).filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date) && r.title);
    await kv.put("schedule", JSON.stringify(reminders));
    return reply(200, { ok: true, count: reminders.length });
  }
  if (path === "/push/test") {
    const sub = subs.find((s) => s.endpoint === body.endpoint);
    if (!sub) return reply(404, { error: "not-subscribed" });
    const status = await sendPush(sub, { title: "🔔 Påminnelserna fungerar", body: "Så här ser det ut kl 18 kvällen före.", tag: "test" }, vapid);
    return reply(status < 300 ? 200 : 502, { status });
  }
  return reply(404, { error: "not-found" });
}

async function allowedUser(header) {
  const token = header.replace(/^Bearer\s+/i, "");
  if (!token || token === header) return false;
  const res = await fetch(`https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/settings/basics`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.ok || res.status === 404;
}

function cleanSubscription(s) {
  if (!s || typeof s.endpoint !== "string" || !s.keys?.p256dh || !s.keys?.auth) return null;
  let url;
  try { url = new URL(s.endpoint); } catch { return null; }
  if (url.protocol !== "https:" || !isPublicHost(url.hostname)) return null;
  return { endpoint: s.endpoint, keys: { p256dh: String(s.keys.p256dh), auth: String(s.keys.auth) } };
}

export function stockholmNow(d) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Stockholm", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
  }).formatToParts(d).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: parseInt(parts.hour, 10) };
}

async function sendDue(env, date) {
  const kv = env.MATLISTA;
  if ((await kv.get("sent")) === date) return;
  await kv.put("sent", date);
  const due = ((await kv.get("schedule", "json")) || []).filter((r) => r.date === date);
  if (!due.length) return;
  const vapid = await vapidKeys(kv);
  const subs = (await kv.get("subs", "json")) || [];
  const gone = new Set();
  for (const sub of subs) {
    for (const r of due) {
      const status = await sendPush(sub, r, vapid);
      if (status === 404 || status === 410) gone.add(sub.endpoint);
    }
  }
  if (gone.size) await kv.put("subs", JSON.stringify(subs.filter((s) => !gone.has(s.endpoint))));
}

// ---------- Web Push (VAPID + aes128gcm, RFC 8291/8292) ----------

const enc = new TextEncoder();
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const concat = (...arrs) => {
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let i = 0;
  for (const a of arrs) { out.set(a, i); i += a.length; }
  return out;
};

// Nycklarna skapas första gången och sparas i KV, så det finns inget att klistra in.
async function vapidKeys(kv) {
  let stored = await kv.get("vapid", "json");
  if (!stored) {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    stored = {
      publicKey: b64url(await crypto.subtle.exportKey("raw", pair.publicKey)),
      privateJwk: await crypto.subtle.exportKey("jwk", pair.privateKey),
    };
    await kv.put("vapid", JSON.stringify(stored));
  }
  return stored;
}

async function vapidHeader(endpoint, vapid) {
  const header = b64url(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64url(enc.encode(JSON.stringify({
    aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: APP_URL,
  })));
  const key = await crypto.subtle.importKey("jwk", vapid.privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${header}.${claims}`));
  return `vapid t=${header}.${claims}.${b64url(sig)}, k=${vapid.publicKey}`;
}

async function hmac(key, data) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}

export async function encryptPayload(sub, payload) {
  const uaPublic = fromB64url(sub.keys.p256dh);
  const authSecret = fromB64url(sub.keys.auth);
  const local = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", local.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, local.privateKey, 256));

  const prkKey = await hmac(authSecret, shared);
  const ikm = await hmac(prkKey, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic, new Uint8Array([1])));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(enc.encode("Content-Encoding: aes128gcm\0"), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, concat(enc.encode("Content-Encoding: nonce\0"), new Uint8Array([1])))).slice(0, 12);

  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, concat(enc.encode(payload), new Uint8Array([2]))));
  const rs = new Uint8Array([0, 0, 16, 0]); // 4096
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, cipher);
}

async function sendPush(sub, message, vapid) {
  try {
    const body = await encryptPayload(sub, JSON.stringify(message));
    const res = await fetch(sub.endpoint, {
      method: "POST",
      headers: {
        Authorization: await vapidHeader(sub.endpoint, vapid),
        TTL: "43200",
        Urgency: "high",
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
      },
      body,
    });
    return res.status;
  } catch {
    return 0;
  }
}

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
