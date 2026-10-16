import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, onAuthStateChanged,
  signInWithPopup, signInWithRedirect, signOut,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, onSnapshot, addDoc, setDoc, updateDoc, deleteDoc,
  runTransaction, writeBatch, serverTimestamp, Timestamp, increment,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { firebaseConfig, recipeImportUrl } from "./config.js";
import { scaleIngredient, isBasic, DEFAULT_BASICS, mergeQty, itemKey } from "./ingredients.js";

const DAY = 24 * 60 * 60 * 1000;
// Standardlistan. Varor från innan det fanns flera listor saknar listId och hör hit.
const MAIN_LIST = "veckohandling";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});
const itemsCol = collection(db, "items");
const recurringCol = collection(db, "recurring");
const listsCol = collection(db, "lists");
const historyCol = collection(db, "history");
const menusCol = collection(db, "menus");
const recipesCol = collection(db, "recipes");
const settingsCol = collection(db, "settings");

const $ = (id) => document.getElementById(id);
const show = (id, on) => { $(id).hidden = !on; };

let items = [];
let recurring = [];
let lists = [];
let history = [];
let menus = {};
let recipes = [];
let basics = DEFAULT_BASICS;
let historyLoaded = false;
let listsLoaded = false;
let pendingList = null;
let unsubscribers = [];
let currentUser = null;

// Sådant som bara gäller den här telefonen sparas lokalt.
const local = {
  get(key, fallback) { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* privat läge */ } },
};
let currentList = local.get("list", MAIN_LIST);
let sortMode = local.get("sort", "recent");
// Handla-läge: bara då går det att bocka av, så att inget bockas av av misstag.
let shopping = local.get("shopping", "0") === "1";

const listOf = (x) => x.listId || MAIN_LIST;
const onCurrent = (x) => listOf(x) === currentList;
const normalize = (s) => s.trim().toLocaleLowerCase("sv");
// Initialen på den som lade till varan, t.ex. P eller E.
const myInitial = () => ((currentUser?.displayName || currentUser?.email || "?").trim()[0] || "?").toLocaleUpperCase("sv");
const historyId = (name) => "h_" + encodeURIComponent(normalize(name));

// ---------- Inloggning ----------

$("signIn").onclick = async () => {
  show("loginError", false);
  const provider = new GoogleAuthProvider();
  try {
    await signInWithPopup(auth, provider);
  } catch (err) {
    if (err.code === "auth/popup-blocked" || err.code === "auth/operation-not-supported-in-this-environment") {
      await signInWithRedirect(auth, provider);
    } else if (err.code !== "auth/popup-closed-by-user" && err.code !== "auth/cancelled-popup-request") {
      $("loginError").textContent = "Inloggningen misslyckades: " + err.message;
      show("loginError", true);
    }
  }
};
$("signOut").onclick = () => signOut(auth);

onAuthStateChanged(auth, (user) => {
  unsubscribers.forEach((u) => u());
  unsubscribers = [];
  show("signOut", !!user);
  show("login", !user);
  show("denied", false);
  show("app", !!user);
  if (user) start(user);
});

// Vilka konton som får komma åt listan bestäms av reglerna i Firebase.
function denied(user) {
  unsubscribers.forEach((u) => u());
  unsubscribers = [];
  show("app", false);
  show("denied", true);
  $("deniedEmail").textContent = user.email;
}

function start(user) {
  currentUser = user;
  const onError = (err) => { if (err.code === "permission-denied") denied(user); else console.error(err); };
  const watch = (col, fn) => unsubscribers.push(onSnapshot(col, (snap) => fn(snap.docs.map((d) => ({ id: d.id, ...d.data() }))), onError));
  watch(itemsCol, (docs) => {
    items = docs;
    renderItems();
    renderRecurring();
    addDueRecurring();
    seedHistory();
  });
  watch(recurringCol, (docs) => {
    recurring = docs;
    renderRecurring();
    addDueRecurring();
  });
  watch(listsCol, (docs) => {
    lists = docs;
    listsLoaded = true;
    if (lists.some((l) => l.id === pendingList)) pendingList = null;
    if (!lists.some((l) => l.id === MAIN_LIST)) {
      setDoc(doc(listsCol, MAIN_LIST), { name: "Veckohandling", createdAt: serverTimestamp() });
    }
    renderLists();
  });
  watch(menusCol, (docs) => {
    menus = Object.fromEntries(docs.map((d) => [d.id, d]));
    renderMenu();
  });
  watch(recipesCol, (docs) => {
    recipes = docs;
    renderRecipes();
  });
  watch(settingsCol, (docs) => {
    const b = docs.find((d) => d.id === "basics");
    basics = b && Array.isArray(b.items) ? b.items : DEFAULT_BASICS;
  });
  handleShare();
  watch(historyCol, (docs) => {
    history = docs;
    historyLoaded = true;
    seedHistory();
  });
}

// Kolla återkommande varor igen när appen öppnas från bakgrunden.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") addDueRecurring();
});

// ---------- Listor ----------

function sortedLists() {
  const all = lists.some((l) => l.id === MAIN_LIST) ? [...lists] : [{ id: MAIN_LIST, name: "Veckohandling" }, ...lists];
  return all.sort((a, b) => (b.id === MAIN_LIST) - (a.id === MAIN_LIST) || a.name.localeCompare(b.name, "sv"));
}

function renderLists() {
  const all = sortedLists();
  if (pendingList && !all.some((l) => l.id === pendingList)) all.push({ id: pendingList, name: "…" });
  // Listan kan ha tagits bort på den andra telefonen.
  if (listsLoaded && !all.some((l) => l.id === currentList)) currentList = MAIN_LIST;
  const sel = $("listSelect");
  sel.innerHTML = "";
  for (const l of all) {
    const open = items.filter((i) => listOf(i) === l.id && !i.checked).length;
    sel.add(new Option(open ? `${l.name} (${open})` : l.name, l.id));
  }
  sel.value = currentList;
}

function selectList(id) {
  currentList = id;
  local.set("list", id);
  renderLists();
  renderItems();
  renderRecurring();
}

$("listSelect").onchange = (e) => selectList(e.target.value);

$("newList").onclick = async () => {
  const name = (prompt("Vad ska listan heta?") || "").trim();
  if (!name) return;
  const ref = doc(listsCol);
  pendingList = ref.id;
  selectList(ref.id);
  await setDoc(ref, { name, createdAt: serverTimestamp() });
};

$("listMenu").onclick = () => {
  const list = sortedLists().find((l) => l.id === currentList);
  openSheet(list.name, (body) => {
    body.append(option("Byt namn", async () => {
      const name = (prompt("Nytt namn på listan:", list.name) || "").trim();
      if (name) await setDoc(doc(listsCol, list.id), { name }, { merge: true });
    }));
    if (list.id !== MAIN_LIST) {
      body.append(option("Ta bort listan", async () => {
        const its = items.filter((i) => listOf(i) === list.id);
        const recs = recurring.filter((r) => listOf(r) === list.id);
        if (!confirm(`Ta bort ${list.name}${its.length ? ` och dess ${its.length} varor` : ""}?`)) return;
        const batch = writeBatch(db);
        its.forEach((i) => batch.delete(doc(itemsCol, i.id)));
        recs.forEach((r) => batch.delete(doc(recurringCol, r.id)));
        batch.delete(doc(listsCol, list.id));
        await batch.commit();
        selectList(MAIN_LIST);
      }, "danger"));
    }
  });
};

// ---------- Lägga till ----------

$("interval").onchange = (e) => {
  if (e.target.value !== "custom") return;
  const n = parseInt(prompt("Hur många dagar mellan gångerna?", "10"), 10);
  if (n > 0) {
    let opt = [...e.target.options].find((o) => o.value === String(n));
    if (!opt) {
      opt = new Option(`Var ${n}:e dag`, String(n));
      e.target.add(opt, e.target.options.length - 1);
    }
    e.target.value = String(n);
  } else {
    e.target.value = "0";
  }
};

$("addForm").onsubmit = async (e) => {
  e.preventDefault();
  const name = $("name").value.trim();
  const qty = $("qty").value.trim();
  const intervalDays = parseInt($("interval").value, 10) || 0;
  if (!name) return;

  const existing = items.find((i) => onCurrent(i) && !i.checked && normalize(i.name) === normalize(name));
  if (existing && !confirm(`${existing.name}${existing.qty ? ` (${existing.qty})` : ""} finns redan på listan. Lägg till ändå?`)) {
    return;
  }

  $("name").value = "";
  $("qty").value = "";
  $("interval").value = "0";
  hideSuggestions();
  $("name").focus();

  const listId = currentList;
  let recurringId = null;
  if (intervalDays > 0) {
    // Ny återkommande vara: läggs på listan direkt, nästa gång räknas från när den beställs.
    const ref = await addDoc(recurringCol, {
      name, qty, intervalDays, listId, onList: true, nextDue: null, addedBy: myInitial(), createdAt: serverTimestamp(),
    });
    recurringId = ref.id;
  }
  await addDoc(itemsCol, { name, qty, listId, checked: false, recurringId, addedBy: myInitial(), createdAt: serverTimestamp() });
  remember(name, qty);
};

// ---------- Förslag ----------

// Allt ni har lagt till sparas, så att de vanligaste varorna kan föreslås när ni skriver.
function remember(name, qty) {
  setDoc(doc(historyCol, historyId(name)), {
    name, qty, count: increment(1), lastAdded: serverTimestamp(),
  }, { merge: true });
}

// Första gången: fyll historiken med det som redan finns på listorna.
let seeded = false;
function seedHistory() {
  if (seeded || !historyLoaded || history.length || !items.length) return;
  seeded = true;
  const batch = writeBatch(db);
  const seen = new Set();
  for (const it of items) {
    const id = historyId(it.name);
    if (seen.has(id)) continue;
    seen.add(id);
    batch.set(doc(historyCol, id), { name: it.name, qty: it.qty || "", count: 1, lastAdded: serverTimestamp() });
  }
  batch.commit();
}

let activeSuggestion = -1;

function suggestionsFor(text) {
  const q = normalize(text);
  if (!q) return [];
  const score = (h) => {
    const n = normalize(h.name);
    if (n.startsWith(q)) return 0;
    if (n.split(/\s+/).some((w) => w.startsWith(q))) return 1;
    if (n.includes(q)) return 2;
    return -1;
  };
  return history
    .map((h) => ({ h, s: score(h) }))
    .filter((x) => x.s >= 0 && normalize(x.h.name) !== q)
    .sort((a, b) => a.s - b.s
      || (b.h.count || 0) - (a.h.count || 0)
      || (b.h.lastAdded?.toMillis?.() || 0) - (a.h.lastAdded?.toMillis?.() || 0))
    .slice(0, 6)
    .map((x) => x.h);
}

function renderSuggestions() {
  const list = $("suggestions");
  const found = suggestionsFor($("name").value);
  list.innerHTML = "";
  activeSuggestion = -1;
  for (const h of found) {
    const li = document.createElement("li");
    const onList = items.some((i) => onCurrent(i) && !i.checked && normalize(i.name) === normalize(h.name));
    const name = document.createElement("span");
    name.textContent = h.name;
    li.append(name);
    if (onList || h.qty) li.append(badge(onList ? "på listan" : h.qty));
    // pointerdown i stället för click så att tangentbordet inte hinner stängas först.
    li.onpointerdown = (e) => { e.preventDefault(); pickSuggestion(h); };
    list.append(li);
  }
  show("suggestions", found.length > 0);
}

function pickSuggestion(h) {
  $("name").value = h.name;
  if (!$("qty").value && h.qty) $("qty").value = h.qty;
  hideSuggestions();
  $("name").focus();
}

function hideSuggestions() { show("suggestions", false); }

$("name").oninput = renderSuggestions;
$("name").onblur = () => setTimeout(hideSuggestions, 150);
$("name").onkeydown = (e) => {
  const lis = [...$("suggestions").children];
  if ($("suggestions").hidden || !lis.length) return;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    activeSuggestion = (activeSuggestion + (e.key === "ArrowDown" ? 1 : -1) + lis.length) % lis.length;
    lis.forEach((li, i) => li.classList.toggle("active", i === activeSuggestion));
  } else if (e.key === "Enter" && activeSuggestion >= 0) {
    e.preventDefault();
    pickSuggestion(suggestionsFor($("name").value)[activeSuggestion]);
  } else if (e.key === "Escape") {
    hideSuggestions();
  }
};

// ---------- Återkommande ----------

let checking = false;
async function addDueRecurring() {
  if (checking) return;
  checking = true;
  try {
    const now = Date.now();
    for (const r of recurring) {
      if (r.onList || !r.nextDue || r.nextDue.toMillis() > now) continue;
      await addRecurringToList(r.id);
    }
  } finally {
    checking = false;
  }
}

// En transaktion ser till att varan inte läggs till två gånger om båda telefonerna är öppna samtidigt.
async function addRecurringToList(recurringId) {
  const rRef = doc(recurringCol, recurringId);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(rRef);
    if (!snap.exists() || snap.data().onList) return;
    const r = snap.data();
    tx.update(rRef, { onList: true });
    tx.set(doc(itemsCol), {
      name: r.name, qty: r.qty || "", listId: listOf(r), checked: false, recurringId, addedBy: r.addedBy || null, createdAt: serverTimestamp(),
    });
  });
}

// Varan har beställts (eller hoppats över): nästa gång räknas från nu.
function scheduleNext(batch, recurringId) {
  const r = recurring.find((x) => x.id === recurringId);
  if (!r) return;
  batch.update(doc(recurringCol, recurringId), {
    onList: false,
    nextDue: Timestamp.fromMillis(Date.now() + r.intervalDays * DAY),
  });
}

// ---------- Listan ----------

function addedAt(x) { return x.createdAt ? x.createdAt.toMillis() : Date.now(); }

function setShopping(on) {
  shopping = on;
  local.set("shopping", on ? "1" : "0");
  document.body.classList.toggle("shopping", on);
  hideSuggestions();
  renderItems();
  window.scrollTo(0, 0);
}
$("shopStart").onclick = () => setShopping(true);
$("shopEnd").onclick = () => setShopping(false);
document.body.classList.toggle("shopping", shopping);

function renderSort() {
  $("sortToggle").textContent = sortMode === "alpha" ? "⇅ A–Ö" : "⇅ Senaste";
}
$("sortToggle").onclick = () => {
  sortMode = sortMode === "alpha" ? "recent" : "alpha";
  local.set("sort", sortMode);
  renderSort();
  renderItems();
};
renderSort();

function renderItems() {
  const list = $("items");
  list.innerHTML = "";
  const mine = items.filter(onCurrent);
  const byMode = sortMode === "alpha"
    ? (a, b) => a.name.localeCompare(b.name, "sv")
    : (a, b) => addedAt(b) - addedAt(a);
  const sorted = mine.sort((a, b) => (a.checked - b.checked) || byMode(a, b));
  for (const it of sorted) {
    const li = document.createElement("li");
    li.className = it.checked ? "checked" : "";
    const label = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !!it.checked;
    cb.disabled = !shopping;
    cb.onchange = () => updateDoc(doc(itemsCol, it.id), { checked: cb.checked });
    const text = document.createElement("span");
    text.className = "text";
    text.textContent = it.name;
    if (it.fromRecipe) {
      const from = document.createElement("span");
      from.className = "from";
      from.textContent = "till " + it.fromRecipe;
      text.append(from);
    }
    label.append(cb, text);
    if (it.qty) label.append(badge(it.qty));
    if (it.recurringId) label.append(badge("🔁"));
    if (it.addedBy) {
      const who = document.createElement("span");
      who.className = "who";
      who.textContent = it.addedBy;
      who.title = `Tillagd av ${it.addedBy}`;
      label.append(who);
    }
    const more = document.createElement("button");
    more.className = "icon more";
    more.textContent = "⋯";
    more.setAttribute("aria-label", `Mer för ${it.name}`);
    more.onclick = () => itemMenu(it);
    li.append(label, more);
    list.append(li);
  }
  show("empty", mine.length === 0);
  show("done", mine.some((i) => i.checked));
  renderLists();
}

function removeItem(it) {
  return removeItems([it], `${it.name} togs bort`);
}

// Tar bort varor och visar "Ångra" en stund, så att ett felklick går att backa.
async function removeItems(toRemove, message) {
  const savedItems = toRemove.map(({ id, ...data }) => ({ id, data }));
  const savedRecurring = recurring
    .filter((r) => toRemove.some((i) => i.recurringId === r.id))
    .map((r) => ({ id: r.id, onList: !!r.onList, nextDue: r.nextDue || null }));
  const batch = writeBatch(db);
  for (const it of toRemove) {
    batch.delete(doc(itemsCol, it.id));
    if (it.recurringId) scheduleNext(batch, it.recurringId);
  }
  await batch.commit();
  showUndo(message, async () => {
    const undo = writeBatch(db);
    savedItems.forEach(({ id, data }) => undo.set(doc(itemsCol, id), data));
    savedRecurring.forEach(({ id, onList, nextDue }) => undo.update(doc(recurringCol, id), { onList, nextDue }));
    await undo.commit();
  });
}

let undoTimer = null;
function showUndo(message, restore) {
  clearTimeout(undoTimer);
  $("undoText").textContent = message;
  // Utan något att ångra blir raden bara en bekräftelse.
  $("undoBtn").hidden = !restore;
  $("undoBtn").onclick = () => {
    clearTimeout(undoTimer);
    show("undo", false);
    restore();
  };
  show("undo", true);
  undoTimer = setTimeout(() => show("undo", false), 7000);
}

function itemMenu(it) {
  openSheet(it.name + (it.qty ? ` (${it.qty})` : ""), (body) => {
    const others = sortedLists().filter((l) => l.id !== listOf(it));
    if (others.length) {
      const label = document.createElement("div");
      label.className = "label";
      label.textContent = "Flytta till";
      body.append(label);
      for (const l of others) body.append(option(l.name, () => moveItem(it, l.id)));
    }
    const label = document.createElement("div");
    label.className = "label";
    label.textContent = "Ändra";
    body.append(label);
    body.append(option("Ändra antal", async () => {
      const qty = prompt(`Antal för ${it.name}:`, it.qty || "");
      if (qty !== null) await updateDoc(doc(itemsCol, it.id), { qty: qty.trim() });
    }));
    body.append(option("Ta bort varan", () => {
      if (confirm(`Ta bort ${it.name}?`)) removeItem(it);
    }, "danger"));
  });
}

async function moveItem(it, listId) {
  const batch = writeBatch(db);
  batch.update(doc(itemsCol, it.id), { listId });
  // En återkommande vara följer med, så att den kommer tillbaka på den nya listan.
  if (it.recurringId && recurring.some((r) => r.id === it.recurringId)) {
    batch.update(doc(recurringCol, it.recurringId), { listId });
  }
  await batch.commit();
}

$("done").onclick = async () => {
  const checked = items.filter((i) => onCurrent(i) && i.checked);
  if (!checked.length) return;
  await removeItems(checked, `${checked.length} ${checked.length === 1 ? "vara" : "varor"} rensades`);
};

function renderRecurring() {
  const list = $("recurring");
  list.innerHTML = "";
  const mine = recurring.filter(onCurrent);
  $("recCount").textContent = mine.length;
  const sorted = mine.sort((a, b) => a.name.localeCompare(b.name, "sv"));
  for (const r of sorted) {
    const li = document.createElement("li");
    const text = document.createElement("span");
    text.className = "text";
    text.textContent = r.name + (r.qty ? ` (${r.qty})` : "");
    const when = document.createElement("span");
    when.className = "when";
    when.textContent = `${intervalText(r.intervalDays)} · ` + (r.onList
      ? "på listan nu"
      : r.nextDue ? `nästa gång ${r.nextDue.toDate().toLocaleDateString("sv-SE", { weekday: "short", day: "numeric", month: "short" })}` : "");
    text.append(when);

    const addNow = document.createElement("button");
    addNow.className = "icon";
    addNow.textContent = "＋";
    addNow.title = "Lägg på listan nu";
    addNow.hidden = !!r.onList;
    addNow.onclick = () => addRecurringToList(r.id);

    const edit = document.createElement("button");
    edit.className = "icon";
    edit.textContent = "✎";
    edit.title = "Ändra intervall";
    edit.onclick = () => {
      const n = parseInt(prompt(`Hur många dagar mellan gångerna för ${r.name}?`, r.intervalDays), 10);
      if (n > 0) {
        const patch = { intervalDays: n };
        if (r.nextDue) patch.nextDue = Timestamp.fromMillis(r.nextDue.toMillis() + (n - r.intervalDays) * DAY);
        updateDoc(doc(recurringCol, r.id), patch);
      }
    };

    const del = document.createElement("button");
    del.className = "icon";
    del.textContent = "✕";
    del.title = "Sluta upprepa";
    del.onclick = async () => {
      if (!confirm(`Sluta upprepa ${r.name}?`)) return;
      const batch = writeBatch(db);
      batch.delete(doc(recurringCol, r.id));
      // Varan får ligga kvar på listan men räknas inte längre som återkommande.
      for (const it of items.filter((i) => i.recurringId === r.id)) {
        batch.update(doc(itemsCol, it.id), { recurringId: null });
      }
      await batch.commit();
    };

    li.append(text, addNow, edit, del);
    list.append(li);
  }
}

function intervalText(days) {
  if (days === 7) return "Varje vecka";
  if (days === 14) return "Varannan vecka";
  if (days === 28) return "Var fjärde vecka";
  return `Var ${days}:e dag`;
}

function badge(t) {
  const s = document.createElement("span");
  s.className = "badge";
  s.textContent = t;
  return s;
}

// ---------- Flikar ----------

let tab = local.get("tab", "list");
function setTab(t) {
  tab = t;
  local.set("tab", t);
  show("listView", t === "list");
  show("recipeView", t === "recipes");
  show("menuView", t === "menu");
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === t));
  if (t === "menu") renderMenu();
  window.scrollTo(0, 0);
}
document.querySelectorAll("#tabs button").forEach((b) => { b.onclick = () => setTab(b.dataset.tab); });

// ---------- Veckomeny ----------

const DAYS = ["Måndag", "Tisdag", "Onsdag", "Torsdag", "Fredag", "Lördag", "Söndag"];
const MEALS = [["lunch", "Lunch"], ["dinner", "Middag"]];

function mondayOf(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}
function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}
// ISO-veckonummer: veckan hör till det år dess torsdag ligger i.
function isoWeek(monday) {
  const thu = addDays(monday, 3);
  const jan4 = new Date(thu.getFullYear(), 0, 4);
  const week = 1 + Math.round((thu - mondayOf(jan4)) / (7 * DAY));
  return { year: thu.getFullYear(), week };
}
const weekId = (monday) => {
  const { year, week } = isoWeek(monday);
  return `${year}-W${String(week).padStart(2, "0")}`;
};

let weekStart = mondayOf(new Date());
let editing = null;

$("weekPrev").onclick = () => { weekStart = addDays(weekStart, -7); renderMenu(); };
$("weekNext").onclick = () => { weekStart = addDays(weekStart, 7); renderMenu(); };
$("weekToday").onclick = () => { weekStart = mondayOf(new Date()); renderMenu(); };

function renderMenu() {
  if (tab !== "menu" || editing) return;
  const id = weekId(weekStart);
  const data = menus[id] || {};
  const fmt = (d) => d.toLocaleDateString("sv-SE", { day: "numeric", month: "short" });
  $("weekNo").textContent = `Vecka ${isoWeek(weekStart).week}`;
  $("weekDates").textContent = `${fmt(weekStart)} – ${fmt(addDays(weekStart, 6))}`;
  const thisWeek = weekId(mondayOf(new Date())) === id;
  show("weekToday", !thisWeek);
  const todayIdx = thisWeek ? (new Date().getDay() + 6) % 7 : -1;

  const days = $("days");
  days.innerHTML = "";
  DAYS.forEach((dayName, i) => {
    const card = document.createElement("div");
    card.className = "day" + (i === todayIdx ? " today" : "");
    const h = document.createElement("h3");
    h.textContent = dayName;
    const date = document.createElement("span");
    date.className = "muted";
    date.textContent = i === todayIdx ? "idag" : fmt(addDays(weekStart, i));
    h.append(date);
    card.append(h);
    for (const [key, label] of MEALS) {
      const field = `d${i}_${key}`;
      const row = document.createElement("div");
      row.className = "meal";
      const kind = document.createElement("span");
      kind.className = "kind";
      kind.textContent = label;
      row.append(kind, mealView(id, field, data[field] || ""));
      card.append(row);
    }
    days.append(card);
  });
}

function mealView(id, field, text) {
  const view = document.createElement("div");
  view.className = "view" + (text ? "" : " empty");
  if (text) linkify(view, text); else view.textContent = "Lägg till…";
  view.onclick = (e) => {
    if (e.target.closest("a")) return;
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.rows = 1;
    const grow = () => { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + "px"; };
    ta.oninput = grow;
    ta.onblur = async () => {
      const value = ta.value.replace(/\s+$/, "");
      editing = null;
      if (value !== text) {
        await setDoc(doc(menusCol, id), { [field]: value, updatedAt: serverTimestamp() }, { merge: true });
      }
      renderMenu();
    };
    editing = field;
    view.replaceWith(ta);
    grow();
    ta.focus();
  };
  return view;
}

// Gör webbadresser klickbara och visar dem kortare, t.ex. "ica.se/recept/kycklinggratang…".
function linkify(el, text) {
  const re = /(https?:\/\/[^\s]+|www\.[^\s]+)/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    el.append(text.slice(last, m.index));
    const url = m[0].startsWith("http") ? m[0] : "https://" + m[0];
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = "🔗 " + m[0].replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
    el.append(a);
    last = m.index + m[0].length;
  }
  el.append(text.slice(last));
}

// ---------- Recept ----------

const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; } };

function renderRecipes() {
  const list = $("recipes");
  list.innerHTML = "";
  const q = normalize($("recipeSearch").value || "");
  const found = recipes
    .filter((r) => !q || normalize(r.title || "").includes(q) || (r.ingredients || []).some((i) => normalize(i).includes(q)))
    .sort((a, b) => (b.createdAt?.toMillis?.() || Date.now()) - (a.createdAt?.toMillis?.() || Date.now()));
  for (const r of found) {
    const li = document.createElement("li");
    if (r.image) {
      const img = document.createElement("img");
      img.src = r.image;
      img.alt = "";
      img.loading = "lazy";
      img.onerror = () => img.replaceWith(noImage());
      li.append(img);
    } else {
      li.append(noImage());
    }
    const text = document.createElement("span");
    text.className = "text";
    const title = document.createElement("span");
    title.className = "title";
    title.textContent = r.title || "Namnlöst recept";
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = [hostOf(r.url), r.timesPlanned ? `lagad ${r.timesPlanned} ggr` : ""].filter(Boolean).join(" · ") || "eget recept";
    text.append(title, meta);
    li.append(text);
    li.onclick = () => showRecipe(r.id);
    list.append(li);
  }
  show("noRecipes", recipes.length === 0);
}
function noImage() {
  const d = document.createElement("span");
  d.className = "noimg";
  d.textContent = "🍲";
  return d;
}
$("recipeSearch").oninput = renderRecipes;

// Hämtar receptet via importtjänsten i Cloudflare. Går det inte öppnas ett formulär för att skriva in det själv.
$("importForm").onsubmit = (e) => {
  e.preventDefault();
  importRecipe($("importUrl").value.trim());
};

async function importRecipe(url) {
  if (!url) return;
  const existing = recipes.find((r) => r.url && r.url === url);
  if (existing) { $("importUrl").value = ""; showRecipe(existing.id); return; }
  const msg = (text) => { $("importMsg").textContent = text; show("importMsg", !!text); };
  if (!recipeImportUrl) {
    msg("Automatisk import är inte påslagen än. Skriv in receptet själv så länge.");
    editRecipe({ url });
    return;
  }
  msg("Hämtar receptet…");
  $("importBtn").disabled = true;
  try {
    const res = await fetch(`${recipeImportUrl}?url=${encodeURIComponent(url)}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ingredients?.length) throw Object.assign(new Error("no-recipe"), { data });
    const recipe = {
      title: data.title || hostOf(url), url: data.url || url, image: data.image || "",
      servings: data.servings || null, ingredients: data.ingredients, instructions: data.instructions || [],
      addedBy: myInitial(),
    };
    // Hittades receptet i vanlig text får ni granska det innan det sparas.
    if (data.fromText) {
      msg("Receptet låg som vanlig text på sidan. Kolla att ingredienserna blev rätt och tryck Spara.");
      editRecipe(recipe);
      return;
    }
    const ref = await addDoc(recipesCol, { ...recipe, createdAt: serverTimestamp() });
    $("importUrl").value = "";
    msg("");
    showRecipe(ref.id, recipe);
  } catch (err) {
    msg("Kunde inte läsa receptet automatiskt från den sidan. Fyll i det själv, så sparas det ändå.");
    editRecipe({ url, title: err.data?.title || "" });
  } finally {
    $("importBtn").disabled = false;
  }
}

// Delning från webbläsaren ("Dela → Matlista") öppnar appen med länken i adressen.
function handleShare() {
  const params = new URLSearchParams(location.search);
  const shared = [params.get("share_url"), params.get("share_text"), params.get("share_title")].filter(Boolean).join(" ");
  if (!shared) return;
  window.history.replaceState(null, "", location.pathname);
  const url = (shared.match(/https?:\/\/\S+/) || [])[0];
  if (!url) return;
  setTab("recipes");
  $("importUrl").value = url;
  importRecipe(url);
}

$("newRecipe").onclick = () => editRecipe({});

function field(label, input) {
  const l = document.createElement("label");
  l.className = "field";
  const span = document.createElement("span");
  span.textContent = label;
  l.append(span, input);
  return l;
}
function input(value, attrs = {}) {
  const i = document.createElement(attrs.multiline ? "textarea" : "input");
  delete attrs.multiline;
  Object.assign(i, attrs);
  i.value = value ?? "";
  return i;
}
function button(text, onclick, cls = "primary") {
  const b = document.createElement("button");
  b.className = cls;
  b.textContent = text;
  b.onclick = onclick;
  return b;
}

function editRecipe(r) {
  openSheet(r.id ? "Ändra recept" : "Nytt recept", (body) => {
    const title = input(r.title, { placeholder: "T.ex. Kycklinggratäng" });
    const url = input(r.url, { type: "url", placeholder: "https://…" });
    const servings = input(r.servings || "", { type: "number", min: 1, placeholder: "4" });
    const ings = input((r.ingredients || []).join("\n"), { multiline: true, placeholder: "En ingrediens per rad, t.ex.\n2 dl matlagningsgrädde\n600 g kycklingfilé" });
    const steps = input((r.instructions || []).join("\n"), { multiline: true, placeholder: "Gör så här (valfritt)" });
    body.append(field("Namn", title), field("Länk", url), field("Portioner i receptet", servings),
      field("Ingredienser", ings), field("Instruktioner", steps));
    const actions = document.createElement("div");
    actions.className = "actions";
    actions.append(button("Spara", async () => {
      const data = {
        title: title.value.trim() || hostOf(url.value) || "Namnlöst recept",
        url: url.value.trim(),
        servings: parseInt(servings.value, 10) || null,
        ingredients: ings.value.split("\n").map((x) => x.trim()).filter(Boolean),
        instructions: steps.value.split("\n").map((x) => x.trim()).filter(Boolean),
      };
      $("sheet").close();
      if (r.id) {
        await updateDoc(doc(recipesCol, r.id), data);
        showRecipe(r.id, { ...r, ...data });
      } else {
        const recipe = { ...data, image: r.image || "", addedBy: myInitial() };
        const ref = await addDoc(recipesCol, { ...recipe, createdAt: serverTimestamp() });
        $("importUrl").value = "";
        show("importMsg", false);
        showRecipe(ref.id, recipe);
      }
    }));
    body.append(actions);
  });
}

// data används om det nya receptet inte hunnit komma tillbaka från databasen än.
function showRecipe(id, data) {
  const r = recipes.find((x) => x.id === id) || (data && { id, ...data });
  if (!r) return;
  openSheet(r.title || "Recept", (body) => {
    if (r.image) {
      const img = document.createElement("img");
      img.className = "hero";
      img.src = r.image;
      img.alt = "";
      img.onerror = () => img.remove();
      body.append(img);
    }
    const meta = document.createElement("p");
    meta.className = "muted small";
    if (r.url) {
      const a = document.createElement("a");
      a.href = r.url;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = "🔗 Öppna på " + hostOf(r.url);
      meta.append(a);
    }
    if (r.servings) meta.append(`${r.url ? " · " : ""}${r.servings} portioner`);
    body.append(meta);

    const actions = document.createElement("div");
    actions.className = "actions";
    actions.append(button("🍽️ Lägg i veckomenyn", () => planRecipe(r)));
    body.append(actions);

    const h = document.createElement("div");
    h.className = "label";
    h.textContent = "Ingredienser";
    const ul = document.createElement("ul");
    ul.className = "ing";
    for (const i of r.ingredients || []) {
      const li = document.createElement("li");
      li.textContent = i;
      ul.append(li);
    }
    body.append(h, ul);

    if (r.instructions?.length) {
      const d = document.createElement("details");
      const sum = document.createElement("summary");
      sum.textContent = "Gör så här";
      const ol = document.createElement("ol");
      ol.className = "steps";
      for (const step of r.instructions) {
        const li = document.createElement("li");
        li.textContent = step;
        ol.append(li);
      }
      d.append(sum, ol);
      body.append(d);
    }

    const more = document.createElement("div");
    more.className = "actions";
    more.append(
      button("Ändra", () => editRecipe(r), "option"),
      button("Ta bort receptet", async () => {
        if (!confirm(`Ta bort ${r.title}?`)) return;
        $("sheet").close();
        await deleteDoc(doc(recipesCol, r.id));
      }, "option danger"),
    );
    body.append(more);
  });
}

// "Lägg i veckomenyn": välj dag och måltid, antal portioner, och bocka ur det ni redan har hemma.
function planRecipe(r) {
  const today = (new Date().getDay() + 6) % 7;
  const thisWeek = mondayOf(new Date());
  const state = { week: 0, day: today, meal: "dinner", portions: 4, listId: MAIN_LIST, unchecked: new Set() };
  const base = r.servings || 4;
  // Basvaror är urbockade från början.
  (r.ingredients || []).forEach((line, i) => { if (isBasic(scaleIngredient(line, 1).name, basics)) state.unchecked.add(i); });

  openSheet(r.title, (body) => {
    const weekSeg = seg([["Denna vecka", 0], ["Nästa vecka", 1]], () => state.week, (v) => { state.week = v; daySeg.refresh(); });
    const daySeg = seg(DAYS.map((d, i) => [d.slice(0, 2), i]), () => state.day, (v) => { state.day = v; });
    const mealSeg = seg(MEALS.map(([k, label]) => [label, k]), () => state.meal, (v) => { state.meal = v; });

    const stepper = document.createElement("div");
    stepper.className = "stepper";
    const count = document.createElement("b");
    const minus = button("−", () => { state.portions = Math.max(1, state.portions - 1); update(); }, "");
    const plus = button("+", () => { state.portions += 1; update(); }, "");
    minus.type = plus.type = "button";
    const note = document.createElement("span");
    note.className = "muted small";
    note.textContent = r.servings ? `(receptet är för ${r.servings})` : "";
    stepper.append(minus, count, plus, note);

    const listSel = document.createElement("select");
    for (const l of sortedLists()) listSel.add(new Option(l.name, l.id));
    listSel.value = state.listId;
    listSel.onchange = () => { state.listId = listSel.value; };

    const checklist = document.createElement("div");
    checklist.className = "checklist";
    const go = button("", async () => {
      $("sheet").close();
      await addPlannedRecipe(r, state, base, addDays(thisWeek, state.week * 7));
    });

    function update() {
      count.textContent = state.portions;
      checklist.innerHTML = "";
      const factor = state.portions / base;
      (r.ingredients || []).forEach((line, i) => {
        const s = scaleIngredient(line, factor);
        const label = document.createElement("label");
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = !state.unchecked.has(i);
        cb.onchange = () => { cb.checked ? state.unchecked.delete(i) : state.unchecked.add(i); updateButton(); };
        const name = document.createElement("span");
        name.textContent = s.name;
        if (isBasic(s.name, basics)) {
          const tag = document.createElement("span");
          tag.className = "bas";
          tag.textContent = "basvara";
          name.append(tag);
        }
        const q = document.createElement("span");
        q.className = "q";
        q.textContent = s.qty;
        label.append(cb, name, q);
        checklist.append(label);
      });
      updateButton();
    }
    function updateButton() {
      const n = (r.ingredients || []).length - state.unchecked.size;
      go.textContent = n ? `Lägg i menyn och ${n} ${n === 1 ? "vara" : "varor"} på listan` : "Lägg bara i menyn";
    }

    body.append(field("Vecka", weekSeg), field("Dag", daySeg), field("Måltid", mealSeg),
      field("Hur många portioner?", stepper), field("Inköpslista", listSel));
    const h = document.createElement("div");
    h.className = "label";
    h.textContent = "Bocka ur det ni redan har hemma";
    body.append(h, checklist);
    const actions = document.createElement("div");
    actions.className = "actions";
    actions.append(go);
    body.append(actions);
    update();
  });
}

function seg(options, get, set) {
  const wrap = document.createElement("div");
  wrap.className = "seg";
  wrap.refresh = () => [...wrap.children].forEach((b) => b.classList.toggle("on", b.dataset.v === String(get())));
  for (const [label, value] of options) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.dataset.v = String(value);
    b.onclick = (e) => { e.preventDefault(); set(value); wrap.refresh(); };
    wrap.append(b);
  }
  wrap.refresh();
  return wrap;
}

async function addPlannedRecipe(r, state, base, monday) {
  const factor = state.portions / base;
  const batch = writeBatch(db);
  const added = [];
  // Finns varan redan oavbockad på listan läggs mängderna ihop i stället för en ny rad.
  const rows = new Map();
  for (const it of items) {
    if (listOf(it) === state.listId && !it.checked) rows.set(itemKey(it.name), { ref: doc(itemsCol, it.id), data: { ...it }, isNew: false });
  }
  (r.ingredients || []).forEach((line, i) => {
    if (state.unchecked.has(i)) return;
    const s = scaleIngredient(line, factor);
    added.push(s);
    const row = rows.get(itemKey(s.name));
    if (row) {
      row.data.qty = mergeQty(row.data.qty, s.qty);
      const from = (row.data.fromRecipe || "").split(", ").filter(Boolean);
      if (!from.includes(r.title)) from.push(r.title);
      row.data.fromRecipe = from.join(", ");
      row.changed = true;
    } else {
      rows.set(itemKey(s.name), {
        ref: doc(itemsCol), isNew: true, changed: true,
        data: { name: s.name, qty: s.qty, listId: state.listId, checked: false, recurringId: null, fromRecipe: r.title, addedBy: myInitial() },
      });
    }
  });
  for (const row of rows.values()) {
    if (!row.changed) continue;
    if (row.isNew) batch.set(row.ref, { ...row.data, createdAt: serverTimestamp() });
    else batch.update(row.ref, { qty: row.data.qty, fromRecipe: row.data.fromRecipe });
  }
  // Rätten skrivs in i veckomenyn, under det som redan står där.
  const id = weekId(monday);
  const key = `d${state.day}_${state.meal}`;
  const existing = (menus[id] || {})[key] || "";
  const entry = [r.title + (state.portions !== base ? ` (${state.portions} port)` : ""), r.url].filter(Boolean).join("\n");
  batch.set(doc(menusCol, id), { [key]: existing ? `${existing}\n${entry}` : entry, updatedAt: serverTimestamp() }, { merge: true });
  batch.update(doc(recipesCol, r.id), { timesPlanned: increment(1), lastPlanned: serverTimestamp() });
  await batch.commit();
  added.forEach((s) => remember(s.name, s.qty));
  const where = `${DAYS[state.day].toLowerCase()} ${state.meal === "lunch" ? "lunch" : "middag"}`;
  showUndo(added.length ? `${r.title} på ${where}, ${added.length} varor på listan` : `${r.title} på ${where}`, null);
}

$("editBasics").onclick = () => {
  openSheet("Basvaror", (body) => {
    const p = document.createElement("p");
    p.className = "muted small";
    p.textContent = "Saker ni nästan alltid har hemma. De är urbockade från början när ni lägger ett recept i veckomenyn. En per rad.";
    const ta = input(basics.join("\n"), { multiline: true });
    ta.style.minHeight = "260px";
    const actions = document.createElement("div");
    actions.className = "actions";
    actions.append(button("Spara", async () => {
      const items = ta.value.split("\n").map((x) => x.trim().toLocaleLowerCase("sv")).filter(Boolean);
      $("sheet").close();
      await setDoc(doc(settingsCol, "basics"), { items });
    }));
    body.append(p, ta, actions);
  });
};

// ---------- Meny ----------

function openSheet(title, build) {
  if ($("sheet").open) $("sheet").close();
  $("sheetTitle").textContent = title;
  $("sheetBody").innerHTML = "";
  build($("sheetBody"));
  $("sheet").showModal();
}
function option(text, action, cls = "") {
  const b = document.createElement("button");
  b.className = "option " + cls;
  b.textContent = text;
  b.onclick = () => { $("sheet").close(); action(); };
  return b;
}
$("sheetClose").onclick = () => $("sheet").close();
$("sheet").onclick = (e) => { if (e.target === $("sheet")) $("sheet").close(); };

// ---------- Offline / hemskärm ----------

if ("serviceWorker" in navigator) {
  // När en ny version har installerats laddas sidan om, så att gamla och nya filer aldrig blandas.
  const hadController = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (hadController && !reloaded) { reloaded = true; location.reload(); }
  });
  navigator.serviceWorker.register("sw.js").then((reg) => {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") reg.update();
    });
  });
}

setTab(tab);
