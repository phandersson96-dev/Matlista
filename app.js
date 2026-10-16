import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, onAuthStateChanged,
  signInWithPopup, signInWithRedirect, signOut,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, onSnapshot, addDoc, setDoc, updateDoc,
  runTransaction, writeBatch, serverTimestamp, Timestamp, increment,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { firebaseConfig } from "./config.js";

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

const $ = (id) => document.getElementById(id);
const show = (id, on) => { $(id).hidden = !on; };

let items = [];
let recurring = [];
let lists = [];
let history = [];
let historyLoaded = false;
let listsLoaded = false;
let pendingList = null;
let unsubscribers = [];

// Sådant som bara gäller den här telefonen sparas lokalt.
const local = {
  get(key, fallback) { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* privat läge */ } },
};
let currentList = local.get("list", MAIN_LIST);
let sortMode = local.get("sort", "recent");

const listOf = (x) => x.listId || MAIN_LIST;
const onCurrent = (x) => listOf(x) === currentList;
const normalize = (s) => s.trim().toLocaleLowerCase("sv");
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
      name, qty, intervalDays, listId, onList: true, nextDue: null, createdAt: serverTimestamp(),
    });
    recurringId = ref.id;
  }
  await addDoc(itemsCol, { name, qty, listId, checked: false, recurringId, createdAt: serverTimestamp() });
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
      name: r.name, qty: r.qty || "", listId: listOf(r), checked: false, recurringId, createdAt: serverTimestamp(),
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
    cb.onchange = () => updateDoc(doc(itemsCol, it.id), { checked: cb.checked });
    const text = document.createElement("span");
    text.className = "text";
    text.textContent = it.name;
    label.append(cb, text);
    if (it.qty) label.append(badge(it.qty));
    if (it.recurringId) label.append(badge("🔁"));
    const more = document.createElement("button");
    more.className = "icon";
    more.textContent = "⋯";
    more.setAttribute("aria-label", `Mer för ${it.name}`);
    more.onclick = () => itemMenu(it);
    const del = document.createElement("button");
    del.className = "icon";
    del.textContent = "✕";
    del.setAttribute("aria-label", `Ta bort ${it.name}`);
    del.onclick = () => removeItem(it);
    li.append(label, more, del);
    list.append(li);
  }
  show("empty", mine.length === 0);
  show("done", mine.some((i) => i.checked));
  renderLists();
}

async function removeItem(it) {
  const batch = writeBatch(db);
  batch.delete(doc(itemsCol, it.id));
  if (it.recurringId) scheduleNext(batch, it.recurringId);
  await batch.commit();
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
    body.append(option("Ta bort", () => removeItem(it), "danger"));
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
  if (!confirm(`Ta bort ${checked.length} avbockade varor från listan?`)) return;
  const batch = writeBatch(db);
  for (const it of checked) {
    batch.delete(doc(itemsCol, it.id));
    if (it.recurringId) scheduleNext(batch, it.recurringId);
  }
  await batch.commit();
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

// ---------- Meny ----------

function openSheet(title, build) {
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
  navigator.serviceWorker.register("sw.js");
}
