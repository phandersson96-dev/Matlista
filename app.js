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
import { scaleIngredient, isBasic, DEFAULT_BASICS, mergeQty, itemKey } from "./ingredients.js?v=17";

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
// Det som brukar ligga i frysen. Står det i en rätt kommer en påminnelse kvällen före.
const DEFAULT_FROZEN = ["kyckling", "kött", "fisk"];
let frozen = DEFAULT_FROZEN;
let menusFresh = false;
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
  const watch = (col, fn) => unsubscribers.push(onSnapshot(col, (snap) => fn(snap.docs.map((d) => ({ id: d.id, ...d.data() })), snap), onError));
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
  watch(menusCol, (docs, snap) => {
    menus = Object.fromEntries(docs.map((d) => [d.id, d]));
    if (!snap.metadata.fromCache) menusFresh = true;
    renderMenu();
    syncReminders();
  });
  watch(recipesCol, (docs) => {
    recipes = docs;
    renderRecipes();
    syncReminders();
  });
  watch(settingsCol, (docs) => {
    const b = docs.find((d) => d.id === "basics");
    basics = b && Array.isArray(b.items) ? b.items : DEFAULT_BASICS;
    const f = docs.find((d) => d.id === "frozen");
    frozen = f && Array.isArray(f.items) ? f.items : DEFAULT_FROZEN;
    syncReminders();
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
    body.append(option("+ Ny lista", () => $("newList").click()));
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
    body.append(option(`Logga ut (${currentUser.email})`, () => signOut(auth)));
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
  $("sortToggle").textContent = sortMode === "alpha" ? "A–Ö ⇅" : "Senaste ⇅";
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
    if (it.addedBy && it.addedBy !== myInitial()) {
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
  const left = mine.filter((i) => !i.checked).length;
  $("listCount").textContent = left ? `${left} ${left === 1 ? "vara" : "varor"} · ` : "";
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
    const rec = recurring.find((r) => r.id === it.recurringId);
    body.append(option(rec ? `Ändra hur ofta (${intervalText(rec.intervalDays).toLowerCase()})` : "Gör återkommande", () => repeatMenu(it)));
    body.append(option("Ta bort varan", () => {
      if (confirm(`Ta bort ${it.name}?`)) removeItem(it);
    }, "danger"));
  });
}

// Ändra hur ofta en vara kommer tillbaka, eller gör en vanlig vara återkommande.
function repeatMenu(it) {
  const rec = recurring.find((r) => r.id === it.recurringId);
  openSheet(`Hur ofta behövs ${it.name}?`, (body) => {
    const choose = (n) => setRepeat(it, rec, n);
    for (const n of [7, 14, 28]) {
      body.append(option(intervalText(n) + (rec?.intervalDays === n ? " ✓" : ""), () => choose(n)));
    }
    const custom = rec && ![7, 14, 28].includes(rec.intervalDays);
    body.append(option(custom ? `${intervalText(rec.intervalDays)} ✓` : "Var X:e dag…", () => {
      const n = parseInt(prompt("Hur många dagar mellan gångerna?", rec?.intervalDays || 10), 10);
      if (n > 0) choose(n);
    }));
    if (rec) body.append(option("Sluta upprepa", () => choose(0), "danger"));
  });
}

async function setRepeat(it, rec, days) {
  const batch = writeBatch(db);
  if (rec && days > 0) {
    const patch = { intervalDays: days };
    if (rec.nextDue) patch.nextDue = Timestamp.fromMillis(rec.nextDue.toMillis() + (days - rec.intervalDays) * DAY);
    batch.update(doc(recurringCol, rec.id), patch);
  } else if (rec) {
    // Varan får ligga kvar på listan men räknas inte längre som återkommande.
    batch.delete(doc(recurringCol, rec.id));
    for (const i of items.filter((x) => x.recurringId === rec.id)) batch.update(doc(itemsCol, i.id), { recurringId: null });
  } else if (days > 0) {
    const ref = doc(recurringCol);
    batch.set(ref, {
      name: it.name, qty: it.qty || "", intervalDays: days, listId: listOf(it),
      onList: true, nextDue: null, addedBy: it.addedBy || myInitial(), createdAt: serverTimestamp(),
    });
    batch.update(doc(itemsCol, it.id), { recurringId: ref.id });
  }
  await batch.commit();
  showUndo(days > 0 ? `${it.name}: ${intervalText(days).toLowerCase()}` : `${it.name} upprepas inte längre`, null);
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
$("copyWeek").onclick = () => chooseWeekToCopy();
$("reminders").onclick = () => reminderSettings();

const MEAL_KEYS = DAYS.flatMap((_, i) => MEALS.map(([m]) => `d${i}_${m}`));
const weekHasFood = (w) => MEAL_KEYS.some((k) => (w?.[k] || "").trim());
// Veckans id "2026-W38" tillbaka till måndagens datum.
function mondayFromId(id) {
  const [y, w] = id.split("-W").map(Number);
  return addDays(mondayOf(new Date(y, 0, 4)), (w - 1) * 7);
}

function chooseWeekToCopy() {
  const target = weekId(weekStart);
  const weeks = Object.keys(menus).filter((id) => id !== target && weekHasFood(menus[id])).sort().reverse();
  openSheet(`Kopiera till vecka ${isoWeek(weekStart).week}`, (body) => {
    if (!weeks.length) {
      const p = document.createElement("p");
      p.className = "muted";
      p.textContent = "Det finns inga andra veckor med mat att kopiera än.";
      body.append(p);
      return;
    }
    const p = document.createElement("p");
    p.className = "muted small";
    p.textContent = "Välj veckan du vill kopiera. Rätter från recepten lägger sina varor på inköpslistan.";
    body.append(p);
    for (const id of weeks) {
      const dishes = MEAL_KEYS.map((k) => (menus[id][k] || "").split("\n")[0].trim()).filter(Boolean);
      const monday = mondayFromId(id);
      const fmt = (d) => d.toLocaleDateString("sv-SE", { day: "numeric", month: "short" });
      body.append(option(`Vecka ${isoWeek(monday).week} (${fmt(monday)}–${fmt(addDays(monday, 6))}): ${dishes.slice(0, 4).join(", ")}${dishes.length > 4 ? " …" : ""}`, () => copyWeek(id)));
    }
  });
}

// Vilka recept som ligger i en måltid: sparade kopplingar, annars recept vars länk står i texten (äldre veckor).
function recipesInMeal(week, key) {
  const text = week[key] || "";
  const found = (week[`${key}_recipes`] || [])
    .map((ref) => ({ recipe: recipes.find((r) => r.id === ref.id), portions: ref.portions || 4 }))
    .filter((x) => x.recipe && text.includes(x.recipe.title));
  for (const r of recipes) {
    if (r.url && text.includes(r.url) && !found.some((x) => x.recipe.id === r.id)) {
      const m = text.match(new RegExp(`${r.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\((\\d+) port\\)`));
      found.push({ recipe: r, portions: m ? parseInt(m[1], 10) : r.servings || 4 });
    }
  }
  return found;
}

function copyWeek(srcId) {
  const src = menus[srcId];
  const targetMonday = weekStart;
  const targetId = weekId(targetMonday);
  if (weekHasFood(menus[targetId]) && !confirm(`Vecka ${isoWeek(targetMonday).week} har redan rätter. Vill du ersätta dem?`)) return;

  // En post per rätt från ett recept, med egna portioner och egna urbockade varor.
  const meals = [];
  DAYS.forEach((dayName, i) => MEALS.forEach(([m, label]) => {
    for (const x of recipesInMeal(src, `d${i}_${m}`)) {
      const unchecked = new Set();
      (x.recipe.ingredients || []).forEach((line, j) => { if (isBasic(scaleIngredient(line, 1).name, basics)) unchecked.add(j); });
      meals.push({ ...x, where: `${dayName} ${label.toLowerCase()}`, unchecked });
    }
  }));

  const commit = async (listId) => {
    const batch = writeBatch(db);
    const data = { updatedAt: serverTimestamp() };
    for (const k of MEAL_KEYS) {
      data[k] = src[k] || "";
      data[`${k}_recipes`] = src[`${k}_recipes`] || [];
    }
    batch.set(doc(menusCol, targetId), data);
    const entries = [];
    for (const meal of meals) {
      const factor = meal.portions / (meal.recipe.servings || 4);
      (meal.recipe.ingredients || []).forEach((line, j) => {
        if (!meal.unchecked.has(j)) entries.push({ ...scaleIngredient(line, factor), recipe: meal.recipe.title });
      });
    }
    queueItems(batch, entries, listId);
    for (const id of new Set(meals.map((m) => m.recipe.id))) {
      batch.update(doc(recipesCol, id), { timesPlanned: increment(1), lastPlanned: serverTimestamp() });
    }
    await batch.commit();
    entries.forEach((e) => remember(e.name, e.qty));
    renderMenu();
    showUndo(`Vecka ${isoWeek(mondayFromId(srcId)).week} kopierad${entries.length ? `, ${entries.length} varor på listan` : ""}`, null);
  };

  if (!meals.length) { commit(MAIN_LIST); return; }

  openSheet(`Kopiera vecka ${isoWeek(mondayFromId(srcId)).week} till vecka ${isoWeek(targetMonday).week}`, (body) => {
    const p = document.createElement("p");
    p.className = "muted small";
    p.textContent = "Välj portioner och bocka ur det ni redan har hemma. Basvarorna är redan urbockade.";
    body.append(p);
    let listId = MAIN_LIST;
    const listSel = document.createElement("select");
    for (const l of sortedLists()) listSel.add(new Option(l.name, l.id));
    listSel.onchange = () => { listId = listSel.value; };
    body.append(field("Inköpslista", listSel));
    const go = button("", async () => { $("sheet").close(); await commit(listId); });
    const updateButton = () => {
      const n = meals.reduce((sum, m) => sum + (m.recipe.ingredients || []).length - m.unchecked.size, 0);
      go.textContent = n ? `Kopiera veckan och lägg ${n} varor på listan` : "Kopiera bara veckan";
    };
    for (const meal of meals) {
      const h = document.createElement("div");
      h.className = "label";
      h.textContent = `${meal.where}: ${meal.recipe.title}`;
      const stepper = document.createElement("div");
      stepper.className = "stepper";
      const count = document.createElement("b");
      const list = document.createElement("div");
      list.className = "checklist";
      const render = () => {
        count.textContent = meal.portions;
        list.innerHTML = "";
        (meal.recipe.ingredients || []).forEach((line, j) => {
          const sc = scaleIngredient(line, meal.portions / (meal.recipe.servings || 4));
          const label = document.createElement("label");
          const cb = document.createElement("input");
          cb.type = "checkbox";
          cb.checked = !meal.unchecked.has(j);
          cb.onchange = () => { cb.checked ? meal.unchecked.delete(j) : meal.unchecked.add(j); updateButton(); };
          const name = document.createElement("span");
          name.textContent = sc.name;
          const q = document.createElement("span");
          q.className = "q";
          q.textContent = sc.qty;
          label.append(cb, name, q);
          list.append(label);
        });
      };
      const minus = button("−", () => { meal.portions = Math.max(1, meal.portions - 1); render(); }, "");
      const plus = button("+", () => { meal.portions += 1; render(); }, "");
      const unit = document.createElement("span");
      unit.className = "muted";
      unit.textContent = "portioner";
      stepper.append(minus, count, plus, unit);
      body.append(h, stepper, list);
      render();
    }
    const actions = document.createElement("div");
    actions.className = "actions";
    actions.append(go);
    body.append(actions);
    updateButton();
  });
}

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
      const text = data[field] || "";
      const view = mealView(id, field, text);
      const remind = data[`${field}_remind`];
      if (remind) {
        const r = document.createElement("div");
        r.className = "remind";
        r.textContent = `🔔 ${remind} (kvällen före)`;
        view.append(r);
      }
      row.append(kind, view);
      if (text || remind) {
        const more = document.createElement("button");
        more.className = "icon more";
        more.setAttribute("aria-label", "Mer");
        more.textContent = "⋯";
        more.onclick = () => mealMenu(id, i, key, data);
        row.append(more);
      }
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

// Rättens namn: första raden som inte är en länk eller anteckning, utan "(6 port)" och "Rester:".
function dishName(text) {
  const line = (text || "").split("\n").map((l) => l.trim())
    .find((l) => l && !/^(https?:\/\/|www\.)/.test(l) && !l.startsWith("📝")) || "";
  return line.replace(/^rester:\s*/i, "").replace(/\s*\(\d+ port\)$/, "").trim();
}

function mealMenu(id, i, meal, data) {
  const key = `d${i}_${meal}`;
  const text = data[key] || "";
  const remind = data[`${key}_remind`] || "";
  const label = MEALS.find(([m]) => m === meal)[1].toLowerCase();
  openSheet(`${DAYS[i]} ${label}`, (body) => {
    if (dishName(text)) body.append(option(`🍲 Rester av ${dishName(text)} en annan dag`, () => leftovers(id, i, meal, text)));
    body.append(option(remind ? `🔔 Ändra påminnelsen (${remind})` : "🔔 Påminn mig kvällen före…", () => {
      const value = prompt("Vad ska påminnelsen säga kvällen före? T.ex. \"Ta upp kycklingen\". Lämna tomt för att ta bort.", remind);
      if (value === null) return;
      setDoc(doc(menusCol, id), { [`${key}_remind`]: value.trim(), updatedAt: serverTimestamp() }, { merge: true });
    }));
  });
}

// Rester: samma rätt en dag till, utan att varorna hamnar på listan igen.
function leftovers(id, i, meal, text) {
  const dish = dishName(text);
  const monday = mondayFromId(id);
  const state = { week: i + 2 > 6 ? 1 : 0, day: (i + 2) % 7, meal };
  openSheet(`Rester av ${dish}`, (body) => {
    const p = document.createElement("p");
    p.className = "muted small";
    p.textContent = "Rätten läggs in en gång till, men inga varor läggs på listan.";
    const weekSeg = seg([["Samma vecka", 0], ["Veckan efter", 1]], () => state.week, (v) => { state.week = v; });
    const daySeg = seg(DAYS.map((d, j) => [d.slice(0, 2), j]), () => state.day, (v) => { state.day = v; });
    const mealSeg = seg(MEALS.map(([k, l]) => [l, k]), () => state.meal, (v) => { state.meal = v; });
    const go = button("Lägg in resterna", async () => {
      $("sheet").close();
      const targetMonday = addDays(monday, state.week * 7);
      const targetId = weekId(targetMonday);
      const key = `d${state.day}_${state.meal}`;
      const before = menus[targetId]?.[key] || "";
      const entry = `Rester: ${dish}`;
      await setDoc(doc(menusCol, targetId), { [key]: before ? `${before}\n${entry}` : entry, updatedAt: serverTimestamp() }, { merge: true });
      const where = `${DAYS[state.day].toLowerCase()} ${MEALS.find(([m]) => m === state.meal)[1].toLowerCase()}`;
      showUndo(`Rester på ${where}${state.week ? " veckan efter" : ""}`, () =>
        setDoc(doc(menusCol, targetId), { [key]: before, updatedAt: serverTimestamp() }, { merge: true }));
    });
    const actions = document.createElement("div");
    actions.className = "actions";
    actions.append(go);
    body.append(p, field("Vecka", weekSeg), field("Dag", daySeg), field("Måltid", mealSeg), actions);
  });
}

// ---------- Påminnelser ----------
// Telefonerna räknar ut kommande påminnelser och skickar dem till Cloudflare, som skickar notisen kl 18 kvällen före.

const dateKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const joinSv = (words) => (words.length > 1 ? `${words.slice(0, -1).join(", ")} och ${words.at(-1)}` : words[0]);

// Samlingsord i frysvarorna: "kött" räknar alla sorters kött, "färs" alla färser osv.
const FROZEN_GROUPS = {
  kött: ["kött", "entrecote", "ryggbiff", "rostbiff", "biff", "oxfile", "fläskfile", "ytterfile", "innerfile", "kalvfile",
    "lammfile", "karre", "kotlett", "högrev", "grytbit", "fransyska", "rulle", "lammstek", "fläskstek", "kalvstek", "oxbringa",
    "bringa", "revben", "fläsksida", "färs", "bacon", "fläskkarre", "flankstek", "picanha", "tri-tip", "lövbiff", "schnitzel"],
  färs: ["färs"],
  köttfärs: ["färs"],
  fisk: ["fisk", "lax", "torsk", "sej", "kolja", "röding", "regnbåge", "räk", "pangasius", "hoki", "tonfisk", "kummel"],
  kyckling: ["kyckling"],
};
const frozenWords = (w) => (FROZEN_GROUPS[w] || [w]).map((x) => x.replace(/[éè]/g, "e"));

function upcomingReminders() {
  const out = [];
  const today = new Date(new Date().setHours(0, 0, 0, 0));
  for (let n = 1; n <= 14; n++) {
    const day = addDays(today, n);
    const week = menus[weekId(mondayOf(day))];
    if (!week) continue;
    const i = (day.getDay() + 6) % 7;
    for (const [meal, label] of MEALS) {
      const key = `d${i}_${meal}`;
      const text = week[key] || "";
      const dish = dishName(text);
      const base = { date: dateKey(addDays(day, -1)), body: `Imorgon ${label.toLowerCase()}: ${dish || "se veckomenyn"}` };
      // Rester är redan lagade, så de räknas inte.
      const hay = [
        ...text.split("\n").filter((l) => !/^rester:/i.test(l.trim()) && !/^(https?:\/\/|www\.)/.test(l.trim())),
        ...recipesInMeal(week, key).flatMap((x) => [x.recipe.title, ...(x.recipe.ingredients || [])]),
      ].join("\n").toLocaleLowerCase("sv").replace(/[éè]/g, "e").replace(/ô/g, "o");
      const found = frozen.map((w) => w.trim().toLocaleLowerCase("sv")).filter((w) => w && frozenWords(w).some((x) => hay.includes(x)));
      if (found.length) out.push({ ...base, title: `🧊 Ta fram ${joinSv(found)} ur frysen`, tag: `frys-${dateKey(day)}-${meal}` });
      const remind = (week[`${key}_remind`] || "").trim();
      if (remind) out.push({ ...base, title: `🔔 ${remind}`, tag: `egen-${dateKey(day)}-${meal}` });
    }
  }
  return out;
}

async function pushApi(path, body) {
  const headers = {};
  if (body) {
    headers["Content-Type"] = "application/json";
    headers.Authorization = `Bearer ${await currentUser.getIdToken()}`;
  }
  const res = await fetch(new URL(`push/${path}`, recipeImportUrl), { method: body ? "POST" : "GET", headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || String(res.status)), { code: data.error || "http" });
  return data;
}

let syncTimer = null;
function syncReminders(force = false) {
  if (!recipeImportUrl || !currentUser || !menusFresh) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(async () => {
    const reminders = upcomingReminders();
    const json = JSON.stringify(reminders);
    if (!force && local.get("pushSchedule", "") === json) return;
    try {
      await pushApi("schedule", { reminders });
      local.set("pushSchedule", json);
    } catch { /* Cloudflare inte uppsatt än, eller inget nät: försöker igen nästa gång */ }
  }, 2000);
}

const b64ToBytes = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const bytesToB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function currentSubscription() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return null;
  const reg = await Promise.race([navigator.serviceWorker.ready, new Promise((r) => setTimeout(r, 3000))]);
  return reg ? reg.pushManager.getSubscription() : null;
}

async function enablePush() {
  if (!("PushManager" in window) || !("Notification" in window)) throw Object.assign(new Error(), { code: "unsupported" });
  if ((await Notification.requestPermission()) !== "granted") throw Object.assign(new Error(), { code: "denied" });
  const { publicKey } = await pushApi("key");
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (sub && sub.options.applicationServerKey && bytesToB64(sub.options.applicationServerKey) !== publicKey) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ||= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) });
  await pushApi("subscribe", { subscription: sub.toJSON() });
  syncReminders(true);
}

const PUSH_ERRORS = {
  unsupported: "Den här webbläsaren kan inte visa notiser. Öppna Matveckan från ikonen på hemskärmen och försök igen.",
  denied: "Notiser är blockerade för Matveckan. Tillåt dem i telefonens inställningar (Appar → Chrome eller Matveckan → Aviseringar) och försök igen.",
  "no-storage": "Utskicket är inte uppsatt i Cloudflare än. Följ guiden först.",
  auth: "Kunde inte bekräfta inloggningen. Logga ut och in igen.",
};

async function reminderSettings() {
  const sub = await currentSubscription().catch(() => null);
  const on = !!sub && "Notification" in window && Notification.permission === "granted";
  openSheet("🔔 Påminnelser", (body) => {
    const p = document.createElement("p");
    p.className = "muted small";
    p.textContent = "Kl 18 kvällen före kommer en notis om något i morgondagens rätter ligger i frysen. Egna påminnelser lägger du på en måltid via ⋯ i veckomenyn. Varje telefon slås på för sig.";
    const msg = document.createElement("p");
    msg.className = "small";
    msg.hidden = true;
    const say = (text, error = false) => { msg.textContent = text; msg.className = "small" + (error ? " error" : ""); msg.hidden = false; };
    const fail = (err) => say(PUSH_ERRORS[err.code] || "Något gick fel. Kontrollera nätet och försök igen.", true);

    const status = document.createElement("p");
    status.innerHTML = on ? "✅ <b>På</b> för den här telefonen" : "Av för den här telefonen";
    const actions = document.createElement("div");
    actions.className = "actions";
    if (on) {
      actions.append(button("Skicka en testnotis", async () => {
        try { await pushApi("test", { endpoint: sub.endpoint }); say("Skickad. Den bör synas om några sekunder."); } catch (err) { fail(err); }
      }, "chip wide"));
      actions.append(button("Stäng av på den här telefonen", async () => {
        try { await pushApi("unsubscribe", { endpoint: sub.endpoint }); } catch { /* tas bort automatiskt senare */ }
        await sub.unsubscribe();
        reminderSettings();
      }, "chip wide"));
    } else {
      actions.append(button("Slå på notiser på den här telefonen", async (e) => {
        e.target.disabled = true;
        try { await enablePush(); reminderSettings(); } catch (err) { e.target.disabled = false; fail(err); }
      }));
    }

    const label = document.createElement("div");
    label.className = "label";
    label.textContent = "Brukar ligga i frysen (en per rad). Samlingsord som kyckling, kött, färs och fisk räknar alla sorter.";
    const ta = input(frozen.join("\n"), { multiline: true });
    ta.style.minHeight = "110px";
    ta.style.width = "100%";
    const save = button("Spara frysvarorna", async () => {
      const items = ta.value.split("\n").map((x) => x.trim().toLocaleLowerCase("sv")).filter(Boolean);
      await setDoc(doc(settingsCol, "frozen"), { items });
      say("Sparat.");
    }, "chip wide");
    body.append(p, status, actions, msg, label, ta, save);
  });
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
    a.textContent = m[0].replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
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
  document.querySelectorAll("#recipeFilters button").forEach((b) => b.classList.toggle("on", b.dataset.f === recipeFilter));
  const found = recipes
    .filter((r) => recipeFilter !== "fav" || r.favorite)
    .filter((r) => recipeFilter !== "quick" || (r.minutes && r.minutes <= QUICK_MINUTES))
    .filter((r) => !q || normalize(r.title || "").includes(q) || (r.ingredients || []).some((i) => normalize(i).includes(q)))
    .sort((a, b) => (b.createdAt?.toMillis?.() || Date.now()) - (a.createdAt?.toMillis?.() || Date.now()));
  for (const r of found) {
    const li = document.createElement("li");
    if (r.image) {
      const img = document.createElement("img");
      img.src = r.image;
      img.alt = "";
      img.loading = "lazy";
      img.onerror = () => img.replaceWith(noImage(r.title));
      li.append(img);
    } else {
      li.append(noImage(r.title));
    }
    const text = document.createElement("span");
    text.className = "text";
    const title = document.createElement("span");
    title.className = "title";
    title.textContent = r.title || "Namnlöst recept";
    if (r.favorite) {
      const star = document.createElement("span");
      star.className = "star";
      star.textContent = " ★";
      title.append(star);
    }
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = [
      r.minutes ? `${r.minutes} min` : "",
      r.lastPlanned ? `lagad ${ago(r.lastPlanned.toMillis())}` : "",
      hostOf(r.url),
    ].filter(Boolean).join(" · ") || "eget recept";
    text.append(title, meta);
    li.append(text);
    li.onclick = () => showRecipe(r.id);
    list.append(li);
  }
  show("noRecipes", recipes.length === 0);
}
function noImage(title = "") {
  const d = document.createElement("span");
  d.className = "noimg";
  d.textContent = (title.trim()[0] || "·").toLocaleUpperCase("sv");
  return d;
}
$("recipeSearch").oninput = renderRecipes;

const QUICK_MINUTES = 30;
let recipeFilter = "all";
document.querySelectorAll("#recipeFilters button").forEach((b) => {
  b.onclick = () => { recipeFilter = b.dataset.f; renderRecipes(); };
});

function ago(ms) {
  const days = Math.floor((Date.now() - ms) / DAY);
  if (days <= 0) return "idag";
  if (days === 1) return "igår";
  if (days < 14) return `för ${days} dagar sedan`;
  if (days < 60) return `för ${Math.round(days / 7)} veckor sedan`;
  return `för ${Math.round(days / 30)} månader sedan`;
}

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
      minutes: data.minutes || null, addedBy: myInitial(),
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
    const minutes = input(r.minutes || "", { type: "number", min: 1, placeholder: "T.ex. 30" });
    const ings = input((r.ingredients || []).join("\n"), { multiline: true, placeholder: "En ingrediens per rad, t.ex.\n2 dl matlagningsgrädde\n600 g kycklingfilé" });
    const steps = input((r.instructions || []).join("\n"), { multiline: true, placeholder: "Gör så här (valfritt)" });
    body.append(field("Namn", title), field("Länk", url), field("Portioner i receptet", servings), field("Tillagningstid (minuter)", minutes),
      field("Ingredienser", ings), field("Instruktioner", steps));
    const actions = document.createElement("div");
    actions.className = "actions";
    actions.append(button("Spara", async () => {
      const data = {
        title: title.value.trim() || hostOf(url.value) || "Namnlöst recept",
        url: url.value.trim(),
        servings: parseInt(servings.value, 10) || null,
        minutes: parseInt(minutes.value, 10) || null,
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
      a.textContent = "Öppna på " + hostOf(r.url) + " ↗";
      meta.append(a);
    }
    const extra = [
      r.servings ? `receptet är för ${r.servings} portioner` : "",
      r.minutes ? `${r.minutes} min` : "",
      r.lastPlanned ? `lagad ${ago(r.lastPlanned.toMillis())}` : "",
    ].filter(Boolean).join(" · ");
    if (extra) meta.append(`${r.url ? " · " : ""}${extra}`);
    body.append(meta);

    // Portionsväljare: ingredienserna räknas om direkt.
    const base = r.servings || 4;
    let portions = 4;
    const stepper = document.createElement("div");
    stepper.className = "stepper";
    const count = document.createElement("b");
    const minus = button("−", () => { portions = Math.max(1, portions - 1); renderIngredients(); }, "");
    const plus = button("+", () => { portions += 1; renderIngredients(); }, "");
    const unit = document.createElement("span");
    unit.className = "muted";
    unit.textContent = "portioner";
    stepper.append(minus, count, plus, unit);

    const actions = document.createElement("div");
    actions.className = "actions";
    actions.append(button("Lägg i veckomenyn", () => planRecipe(r, portions)));
    const fav = button(r.favorite ? "★ Favorit" : "☆ Gör till favorit", async () => {
      r.favorite = !r.favorite;
      fav.textContent = r.favorite ? "★ Favorit" : "☆ Gör till favorit";
      await updateDoc(doc(recipesCol, r.id), { favorite: r.favorite });
    }, "option");
    actions.append(fav);

    const h = document.createElement("div");
    h.className = "label";
    h.textContent = "Ingredienser";
    const ul = document.createElement("ul");
    ul.className = "ing";
    function renderIngredients() {
      count.textContent = portions;
      ul.innerHTML = "";
      for (const line of r.ingredients || []) {
        const li = document.createElement("li");
        if (portions === base) {
          li.textContent = line;
        } else {
          const sc = scaleIngredient(line, portions / base);
          li.textContent = sc.qty ? `${sc.qty} ${sc.name.toLocaleLowerCase("sv")}` : line;
        }
        ul.append(li);
      }
    }
    renderIngredients();

    // Egen anteckning, t.ex. "mindre chili". Sparas när man lämnar rutan och följer med in i veckomenyn.
    const note = input(r.note || "", { multiline: true, placeholder: "T.ex. mindre chili, dubbla såsen" });
    note.className = "note";
    note.onblur = async () => {
      const value = note.value.trim();
      if (value === (r.note || "")) return;
      r.note = value;
      await updateDoc(doc(recipesCol, r.id), { note: value });
    };
    body.append(stepper, actions, field("Egen anteckning", note), h, ul);

    if (r.instructions?.length) {
      const d = document.createElement("details");
      const sum = document.createElement("summary");
      sum.textContent = "Gör så här";
      const ol = document.createElement("ol");
      ol.className = "steps";
      for (const step of tidySteps(r.instructions)) {
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

// Instruktioner från bloggar kan vara avbrutna mitt i meningar. Raderna fogas ihop och delas upp i korta steg.
function tidySteps(lines) {
  const text = lines.join("\n").replace(/([^.!?:])\n+(?=[a-zåäöé0-9(])/g, "$1 ");
  const steps = [];
  for (const para of text.split(/\n+/)) {
    const sentences = para.replace(/^\s*(steg\s*)?\d+[.)]\s*/i, "").split(/(?<=[.!?])\s+(?=[A-ZÅÄÖ0-9])/);
    let cur = "";
    for (const sen of sentences) {
      if (cur && (cur + " " + sen).length > 140) { steps.push(cur); cur = sen; }
      else cur = cur ? `${cur} ${sen}` : sen;
    }
    if (cur.trim()) steps.push(cur.trim());
  }
  return steps;
}

// "Lägg i veckomenyn": välj dag och måltid, antal portioner, och bocka ur det ni redan har hemma.
function planRecipe(r, portions = 4) {
  const today = (new Date().getDay() + 6) % 7;
  const thisWeek = mondayOf(new Date());
  const state = { week: 0, day: today, meal: "dinner", portions, listId: MAIN_LIST, unchecked: new Set() };
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

// Lägger varor på listan. Finns varan redan oavbockad läggs mängderna ihop i stället för en ny rad.
// entries: [{ name, qty, recipe }]
function queueItems(batch, entries, listId) {
  const rows = new Map();
  for (const it of items) {
    if (listOf(it) === listId && !it.checked) rows.set(itemKey(it.name), { ref: doc(itemsCol, it.id), data: { ...it }, isNew: false });
  }
  for (const e of entries) {
    const row = rows.get(itemKey(e.name));
    if (row) {
      row.data.qty = mergeQty(row.data.qty, e.qty);
      const from = (row.data.fromRecipe || "").split(", ").filter(Boolean);
      if (e.recipe && !from.includes(e.recipe)) from.push(e.recipe);
      row.data.fromRecipe = from.join(", ");
      row.changed = true;
    } else {
      rows.set(itemKey(e.name), {
        ref: doc(itemsCol), isNew: true, changed: true,
        data: { name: e.name, qty: e.qty, listId, checked: false, recurringId: null, fromRecipe: e.recipe || "", addedBy: myInitial() },
      });
    }
  }
  for (const row of rows.values()) {
    if (!row.changed) continue;
    if (row.isNew) batch.set(row.ref, { ...row.data, createdAt: serverTimestamp() });
    else batch.update(row.ref, { qty: row.data.qty, fromRecipe: row.data.fromRecipe });
  }
}

// Texten som skrivs in i veckomenyn för ett recept.
function menuEntry(r, portions) {
  const base = r.servings || 4;
  return [r.title + (portions !== base ? ` (${portions} port)` : ""), r.note ? `📝 ${r.note}` : "", r.url].filter(Boolean).join("\n");
}

async function addPlannedRecipe(r, state, base, monday) {
  const factor = state.portions / base;
  const batch = writeBatch(db);
  const added = [];
  (r.ingredients || []).forEach((line, i) => {
    if (state.unchecked.has(i)) return;
    const s = scaleIngredient(line, factor);
    added.push({ ...s, recipe: r.title });
  });
  queueItems(batch, added, state.listId);
  // Rätten skrivs in i veckomenyn, under det som redan står där. Vilka recept som ligger där
  // sparas också, så att veckan kan kopieras med varorna senare.
  const id = weekId(monday);
  const key = `d${state.day}_${state.meal}`;
  const week = menus[id] || {};
  const existing = week[key] || "";
  const entry = menuEntry(r, state.portions);
  batch.set(doc(menusCol, id), {
    [key]: existing ? `${existing}\n${entry}` : entry,
    [`${key}_recipes`]: [...(week[`${key}_recipes`] || []), { id: r.id, portions: state.portions }],
    updatedAt: serverTimestamp(),
  }, { merge: true });
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
