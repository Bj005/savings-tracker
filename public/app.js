const API = "/api";
const PIN_KEY = "savings-pin";

const money = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "USD" });
const dateFmt = new Intl.DateTimeFormat("fr-FR", {
  day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
});

let pin = "";
let data = { people: [], payments: [] };
let currentProfileId = null;

const $ = (id) => document.getElementById(id);

// ---------- Storage of the PIN on this device (convenience only) ----------
function savePin(value) { try { localStorage.setItem(PIN_KEY, value); } catch {} }
function readPin() { try { return localStorage.getItem(PIN_KEY) || ""; } catch { return ""; } }
function clearPin() { try { localStorage.removeItem(PIN_KEY); } catch {} }

// ---------- API ----------
async function api(method, body) {
  let res;
  try {
    res = await fetch(API, {
      method,
      headers: { "Content-Type": "application/json", "x-pin": pin },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error("Connexion impossible. Vérifiez votre connexion internet.");
  }
  const result = await res.json().catch(() => ({ error: "Erreur du serveur. Réessayez." }));
  if (res.status === 401) {
    lock();
    throw new Error(result.error || "Mot de passe incorrect.");
  }
  if (!res.ok) throw new Error(result.error || "La requête a échoué.");
  return result;
}

// ---------- Helpers ----------
const personName = (id) => (data.people.find((p) => p.id === id) || {}).name || "Inconnu";
const totalFor = (id) => data.payments.filter((p) => p.personId === id).reduce((s, p) => s + p.cents, 0);
const byNewest = (a, b) => b.date.localeCompare(a.date);

let toastTimer;
function toast(message, bad = false) {
  const el = $("toast");
  el.textContent = message;
  el.classList.toggle("bad", bad);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2800);
}

function paymentRow(payment, showName) {
  const row = document.createElement("div");
  row.className = "payment";

  const left = document.createElement("div");
  if (showName) {
    const who = document.createElement("div");
    who.className = "who";
    who.textContent = personName(payment.personId);
    left.appendChild(who);
  }
  const when = document.createElement("div");
  when.className = "when";
  when.textContent = dateFmt.format(new Date(payment.date));
  left.appendChild(when);

  const amount = document.createElement("div");
  amount.className = "amount";
  amount.textContent = money.format(payment.cents / 100);

  row.append(left, amount);
  return row;
}

function emptyText(text) {
  const p = document.createElement("p");
  p.className = "muted";
  p.textContent = text;
  return p;
}

// ---------- Rendering ----------
function render() {
  const people = [...data.people].sort((a, b) => a.name.localeCompare(b.name));

  // Deposit: person dropdown
  const select = $("person-select");
  const previous = select.value;
  select.replaceChildren(new Option("Choisir un membre…", ""));
  people.forEach((p) => select.appendChild(new Option(p.name, p.id)));
  if (people.some((p) => p.id === previous)) select.value = previous;
  $("deposit-empty").hidden = people.length > 0;

  // Records: every payment, newest first
  const records = $("records-list");
  const payments = [...data.payments].sort(byNewest);
  records.replaceChildren(...(payments.length
    ? payments.map((p) => paymentRow(p, true))
    : [emptyText("Aucun paiement enregistré pour le moment.")]));

  // Members list
  const list = $("members-list");
  list.replaceChildren(...(people.length
    ? people.map((p) => {
        const li = document.createElement("li");
        const btn = document.createElement("button");
        btn.type = "button";
        const name = document.createElement("span");
        name.textContent = p.name;
        const arrow = document.createElement("span");
        arrow.textContent = "Voir ›";
        btn.append(name, arrow);
        btn.addEventListener("click", () => openProfile(p.id));
        li.appendChild(btn);
        return li;
      })
    : [emptyText("Aucun membre. Appuyez sur « + Inscrire » pour en ajouter un.")]));

  if (currentProfileId) renderProfile();
}

function renderProfile() {
  const id = currentProfileId;
  $("profile-name").textContent = personName(id);
  $("profile-total").textContent = money.format(totalFor(id) / 100);
  const payments = data.payments.filter((p) => p.personId === id).sort(byNewest);
  $("profile-list").replaceChildren(...(payments.length
    ? payments.map((p) => paymentRow(p, false))
    : [emptyText("Aucun paiement pour le moment.")]));
}

function openProfile(id) {
  currentProfileId = id;
  renderProfile();
  $("members-home").hidden = true;
  $("profile").hidden = false;
}

function closeProfile() {
  currentProfileId = null;
  $("profile").hidden = true;
  $("members-home").hidden = false;
}

function showView(name) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === name));
  document.querySelectorAll(".view").forEach((v) => (v.hidden = v.id !== `view-${name}`));
  if (name === "members") closeProfile();
}

// ---------- Lock / unlock ----------
function lock() {
  pin = "";
  clearPin();
  data = { people: [], payments: [] };
  $("app").hidden = true;
  $("lock").hidden = false;
  $("pin-input").value = "";
  $("pin-input").focus();
}

async function unlock(value) {
  pin = value;
  const error = $("pin-error");
  error.hidden = true;
  try {
    data = await api("GET");
    savePin(pin);
    $("lock").hidden = true;
    $("app").hidden = false;
    render();
  } catch (e) {
    $("app").hidden = true;
    $("lock").hidden = false;
    error.textContent = e.message;
    error.hidden = false;
  }
}

// ---------- Events ----------
$("pin-form").addEventListener("submit", (e) => {
  e.preventDefault();
  unlock($("pin-input").value.trim());
});

$("lock-btn").addEventListener("click", lock);

document.querySelectorAll(".tab").forEach((tab) =>
  tab.addEventListener("click", () => showView(tab.dataset.view)));

$("deposit-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const personId = $("person-select").value;
  const cents = Math.round(parseFloat($("amount-input").value) * 100);
  if (!personId) return toast("Choisissez un membre.", true);
  if (!Number.isFinite(cents) || cents <= 0) return toast("Entrez un montant supérieur à 0.", true);

  const btn = e.submitter || e.target.querySelector("button[type=submit]");
  btn.disabled = true;
  try {
    data = await api("POST", { action: "deposit", personId, cents });
    render();
    toast(`${money.format(cents / 100)} enregistré pour ${personName(personId)}`);
    $("amount-input").value = "";
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
});

$("register-toggle").addEventListener("click", () => {
  $("register-form").hidden = false;
  $("name-input").focus();
});

$("register-cancel").addEventListener("click", () => {
  $("register-form").hidden = true;
  $("name-input").value = "";
});

$("register-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("name-input").value.trim();
  if (!name) return;
  const btn = e.submitter || e.target.querySelector("button[type=submit]");
  btn.disabled = true;
  try {
    data = await api("POST", { action: "register", name });
    render();
    toast(`${name} inscrit(e)`);
    $("name-input").value = "";
    $("register-form").hidden = true;
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
});

$("profile-back").addEventListener("click", closeProfile);

// ---------- Start ----------
const saved = readPin();
if (saved) {
  $("lock").hidden = true;
  unlock(saved);
} else {
  $("pin-input").focus();
}
