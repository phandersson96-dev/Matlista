import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, onAuthStateChanged,
  signInWithPopup, signInWithRedirect, signOut,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, onSnapshot, addDoc, updateDoc, deleteDoc,
  runTransaction, writeBatch, serverTimestamp, Timestamp,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { firebaseConfig } from "./config.js";

const DAY = 24 * 60 * 60 * 1000;

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});
const itemsCol = collection(db, "items");
const recurringCol = collection(db, "recurring");

const $ = (id) => document.getElementById(id);
const show = (id, on) => { $(id).hidden = !on; };

let items = [];
let recurring = [];
let unsubscribers = [];

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
  unsubscribers.push(onSnapshot(itemsCol, (snap) => {
    items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderItems();
    addDueRecurring();
  }, onError));
  unsubscribers.push(onSnapshot(recurringCol, (snap) => {
    recurring = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderRecurring();
    addDueRecurring();
  }, onError));
}

// Kolla återkommande varor igen när appen öppnas från bakgrunden.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") addDueRecurring();
});

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
  $("name").value = "";
  $("qty").value = "";
  $("interval").value = "0";
  $("name").focus();

  let recurringId = null;
  if (intervalDays > 0) {
    // Ny återkommande vara: läggs på listan direkt, nästa gång räknas från när den beställs.
    const ref = await addDoc(recurringCol, {
      name, qty, intervalDays, onList: true, nextDue: null, createdAt: serverTimestamp(),
    });
    recurringId = ref.id;
  }
  await addDoc(itemsCol, { name, qty, checked: false, recurringId, createdAt: serverTimestamp() });
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
      name: r.name, qty: r.qty || "", checked: false, recurringId, createdAt: serverTimestamp(),
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

function sortTime(x) { return x.createdAt ? x.createdAt.toMillis() : Date.now(); }

function renderItems() {
  const list = $("items");
  list.innerHTML = "";
  const sorted = [...items].sort((a, b) => (a.checked - b.checked) || (sortTime(a) - sortTime(b)));
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
    const del = document.createElement("button");
    del.className = "icon";
    del.textContent = "✕";
    del.setAttribute("aria-label", `Ta bort ${it.name}`);
    del.onclick = async () => {
      const batch = writeBatch(db);
      batch.delete(doc(itemsCol, it.id));
      if (it.recurringId) scheduleNext(batch, it.recurringId);
      await batch.commit();
    };
    li.append(label, del);
    list.append(li);
  }
  show("empty", items.length === 0);
  show("done", items.some((i) => i.checked));
}

$("done").onclick = async () => {
  const checked = items.filter((i) => i.checked);
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
  $("recCount").textContent = recurring.length;
  const sorted = [...recurring].sort((a, b) => a.name.localeCompare(b.name, "sv"));
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

// ---------- Offline / hemskärm ----------

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js");
}
