const API = "/api";
const PIN_KEY = "savings-pin";

const MAIN_GOAL_CENTS = 1_850_000; // $18,500 — one-time group goal
const DEFAULT_YEARLY_GOAL_CENTS = 75_000; // $750
const DAY_MS = 24 * 60 * 60 * 1000;
const YEAR_MS = 365 * DAY_MS; // each member's year = 365 days from their registration

const money = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "USD" });
const dateFmt = new Intl.DateTimeFormat("fr-FR", {
  day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
});
const dayFmt = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", year: "numeric" });

let pin = "";
let isAdmin = false;
let data = { people: [], payments: [] };
let currentProfileId = null;

const $ = (id) => document.getElementById(id);
const fmt = (cents) => money.format(cents / 100);

// ---------- Storage of the admin password on this device (convenience only) ----------
function savePin(value) { try { localStorage.setItem(PIN_KEY, value); } catch {} }
function readPin() { try { return localStorage.getItem(PIN_KEY) || ""; } catch { return ""; } }
function clearPin() { try { localStorage.removeItem(PIN_KEY); } catch {} }

// ---------- API ----------
async function api(method, body, usePin = pin) {
  let res;
  try {
    res = await fetch(API, {
      method,
      headers: { "Content-Type": "application/json", "x-pin": usePin },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error("Connexion impossible. Vérifiez votre connexion internet.");
  }
  const result = await res.json().catch(() => ({ error: "Erreur du serveur. Réessayez." }));
  if (res.status === 401) {
    if (isAdmin) setAdmin(false);
    throw new Error(result.error || "Mot de passe incorrect.");
  }
  if (!res.ok) throw new Error(result.error || "La requête a échoué.");
  return result;
}

// ---------- Calculations ----------
const personById = (id) => data.people.find((p) => p.id === id);
const personName = (id) => (personById(id) || {}).name || "Inconnu";
const paymentsOf = (id) => data.payments.filter((p) => p.personId === id);
const totalFor = (id) => paymentsOf(id).reduce((s, p) => s + p.cents, 0);
const groupTotal = () => data.payments.reduce((s, p) => s + p.cents, 0);
const byNewest = (a, b) => b.date.localeCompare(a.date);

function goalsOf(person) {
  const goals = Array.isArray(person.goals) && person.goals.length
    ? person.goals
    : [{ from: person.created, cents: DEFAULT_YEARLY_GOAL_CENTS }];
  return [...goals].sort((a, b) => a.from.localeCompare(b.from));
}

const currentGoal = (person) => goalsOf(person).at(-1).cents;

// Goal of a year = the latest goal set before that year ended
// (so a change applies to the current year, and finished years keep their goal).
function goalForYear(goals, yearEnd) {
  let goal = goals[0].cents;
  for (const g of goals) if (Date.parse(g.from) < yearEnd) goal = g.cents;
  return goal;
}

// Splits a member's deposits into 365-day years starting at registration.
// Anything paid above a year's goal carries over to the next year.
function yearsOf(person, now = Date.now()) {
  const start = Date.parse(person.created);
  const goals = goalsOf(person);
  const count = Math.max(1, Math.floor((now - start) / YEAR_MS) + 1);
  const deposits = new Array(count).fill(0);
  for (const p of paymentsOf(person.id)) {
    const i = Math.min(count - 1, Math.max(0, Math.floor((Date.parse(p.date) - start) / YEAR_MS)));
    deposits[i] += p.cents;
  }

  const years = [];
  let carryIn = 0;
  for (let i = 0; i < count; i++) {
    const yStart = start + i * YEAR_MS;
    const yEnd = yStart + YEAR_MS;
    const goal = goalForYear(goals, yEnd);
    const progress = carryIn + deposits[i];
    const done = progress >= goal;
    const carryOut = done ? progress - goal : 0;
    years.push({ number: i + 1, start: yStart, end: yEnd, goal, deposits: deposits[i], carryIn, progress, done, carryOut });
    carryIn = carryOut;
  }
  return years;
}

// Pace of the current year: compares what is saved with what should be saved by today.
function statusOf(year, now = Date.now()) {
  if (year.done) return { label: "Objectif atteint ✓", cls: "ok" };
  const daysElapsed = Math.floor((now - year.start) / DAY_MS);
  const expected = Math.floor((year.goal * daysElapsed) / 365);
  if (year.progress >= expected) return { label: "Dans les temps", cls: "ok" };
  return { label: "En retard", cls: "warn" };
}

const daysLeft = (year, now = Date.now()) => Math.max(0, Math.ceil((year.end - now) / DAY_MS));

function plural(n, one, many) { return `${n} ${n > 1 ? many : one}`; }

function durationText(months) {
  const y = Math.floor(months / 12);
  const m = months % 12;
  if (!y) return plural(m, "mois", "mois");
  if (!m) return plural(y, "an", "ans");
  return `${plural(y, "an", "ans")} ${plural(m, "mois", "mois")}`;
}

// ---------- UI helpers ----------
let toastTimer;
function toast(message, bad = false) {
  const el = $("toast");
  el.textContent = message;
  el.classList.toggle("bad", bad);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2800);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function emptyText(text) { return el("p", "muted", text); }

function setBar(bar, cents, goal) {
  const pct = goal > 0 ? Math.min(100, (cents / goal) * 100) : 0;
  bar.style.width = `${pct}%`;
}

function avatar(person, size = "") {
  const box = el("div", `avatar ${size}`);
  const initials = person.name.split(" ").filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("");
  box.textContent = initials;
  if (person.photo) {
    const img = new Image();
    img.alt = "";
    img.src = `${API}?photo=${encodeURIComponent(person.id)}&v=${encodeURIComponent(person.photo)}`;
    img.onload = () => box.replaceChildren(img);
  }
  return box;
}

function parseCents(value) {
  const cents = Math.round(parseFloat(String(value).replace(",", ".")) * 100);
  return Number.isFinite(cents) ? cents : NaN;
}

async function busy(button, task) {
  button.disabled = true;
  try { await task(); } catch (err) { toast(err.message, true); } finally { button.disabled = false; }
}

// ---------- Payment rows (edit / delete for admin) ----------
function paymentRow(payment, showName) {
  const row = el("div", "payment");

  const left = el("div");
  if (showName) left.appendChild(el("div", "who", personName(payment.personId)));
  const when = el("div", "when", dateFmt.format(new Date(payment.date)));
  if (payment.edited) when.textContent += " · modifié";
  left.appendChild(when);

  const right = el("div", "pay-right");
  right.appendChild(el("div", "amount", fmt(payment.cents)));

  if (isAdmin) {
    const actions = el("div", "pay-actions");
    const edit = el("button", "link", "Modifier");
    edit.type = "button";
    edit.addEventListener("click", () => editPaymentInline(row, payment));
    const del = el("button", "link danger", "Supprimer");
    del.type = "button";
    del.addEventListener("click", () => {
      if (!confirm(`Supprimer le paiement de ${fmt(payment.cents)} (${personName(payment.personId)}) ?`)) return;
      busy(del, async () => {
        data = await api("POST", { action: "deletePayment", paymentId: payment.id });
        render();
        toast("Paiement supprimé");
      });
    });
    actions.append(edit, del);
    right.appendChild(actions);
  }

  row.append(left, right);
  return row;
}

function editPaymentInline(row, payment) {
  const form = el("form", "pay-edit");
  const wrap = el("div", "money");
  wrap.appendChild(el("span", "", "$"));
  const input = el("input");
  input.type = "number";
  input.inputMode = "decimal";
  input.min = "0.01";
  input.step = "0.01";
  input.required = true;
  input.value = (payment.cents / 100).toFixed(2);
  input.setAttribute("aria-label", "Nouveau montant");
  wrap.appendChild(input);
  const save = el("button", "btn primary small", "OK");
  save.type = "submit";
  const cancel = el("button", "btn ghost small", "Annuler");
  cancel.type = "button";
  cancel.addEventListener("click", render);
  form.append(wrap, save, cancel);

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const cents = parseCents(input.value);
    if (!(cents > 0)) return toast("Entrez un montant supérieur à 0.", true);
    busy(save, async () => {
      data = await api("POST", { action: "editPayment", paymentId: payment.id, cents });
      render();
      toast("Paiement modifié");
    });
  });

  row.querySelector(".pay-right").replaceWith(form);
  input.focus();
  input.select();
}

// ---------- Rendering ----------
function sortedPeople() {
  return [...data.people].sort((a, b) => a.name.localeCompare(b.name));
}

function renderDashboard(people) {
  const total = groupTotal();
  const reached = total >= MAIN_GOAL_CENTS;
  $("main-total").textContent = fmt(total);
  $("main-goal").textContent = fmt(MAIN_GOAL_CENTS);
  setBar($("main-bar"), total, MAIN_GOAL_CENTS);
  $("main-percent").textContent = `${Math.min(100, Math.floor((total / MAIN_GOAL_CENTS) * 100))} %`;
  $("main-remaining").textContent = reached ? "" : `Reste ${fmt(MAIN_GOAL_CENTS - total)}`;
  $("main-status").hidden = !reached;

  const forecast = $("main-forecast");
  const yearlyRate = people.reduce((s, p) => s + currentGoal(p), 0);
  forecast.hidden = reached;
  if (reached) {
    forecast.textContent = "";
  } else if (yearlyRate > 0) {
    const months = Math.max(1, Math.round(((MAIN_GOAL_CENTS - total) / yearlyRate) * 12));
    forecast.textContent = `Au rythme des objectifs annuels (${fmt(yearlyRate)} par an) : objectif principal atteint dans ~${durationText(months)}.`;
  } else {
    forecast.textContent = "Inscrivez des membres pour voir l'estimation.";
  }

  const list = $("yearly-list");
  list.replaceChildren(...(people.length
    ? people.map((p) => {
        const year = yearsOf(p).at(-1);
        const status = statusOf(year);
        const row = el("button", "member-row");
        row.type = "button";
        row.addEventListener("click", () => { showView("members"); openProfile(p.id); });

        const info = el("div", "grow");
        const top = el("div", "row-between");
        top.append(el("span", "name", p.name), el("span", `pill ${status.cls}`, status.label));
        const bar = el("div", "bar");
        const fill = el("div");
        bar.appendChild(fill);
        setBar(fill, year.progress, year.goal);
        const sub = el("div", "muted small-text", `Année ${year.number} · ${fmt(year.progress)} / ${fmt(year.goal)}`);
        info.append(top, bar, sub);
        row.append(avatar(p), info);
        return row;
      })
    : [emptyText("Aucun membre pour le moment.")]));
}

function render() {
  const people = sortedPeople();

  document.querySelectorAll("[data-admin]").forEach((n) => (n.hidden = !isAdmin));
  $("admin-badge").hidden = !isAdmin;
  $("admin-btn").hidden = isAdmin;
  $("lock-btn").hidden = !isAdmin;
  if (!isAdmin) {
    $("register-form").hidden = true;
    $("edit-form").hidden = true;
  }

  renderDashboard(people);

  // Deposit: person dropdown
  const select = $("person-select");
  const previous = select.value;
  select.replaceChildren(new Option("Choisir un membre…", ""));
  people.forEach((p) => select.appendChild(new Option(p.name, p.id)));
  if (people.some((p) => p.id === previous)) select.value = previous;
  $("deposit-empty").hidden = people.length > 0;

  // Records: every payment, newest first
  const payments = [...data.payments].sort(byNewest);
  $("records-list").replaceChildren(...(payments.length
    ? payments.map((p) => paymentRow(p, true))
    : [emptyText("Aucun paiement enregistré pour le moment.")]));

  // Members list
  $("members-list").replaceChildren(...(people.length
    ? people.map((p) => {
        const li = el("li");
        const btn = el("button");
        btn.type = "button";
        const left = el("span", "member-left");
        left.append(avatar(p, "small"), el("span", "", p.name));
        btn.append(left, el("span", "", `${fmt(totalFor(p.id))} ›`));
        btn.addEventListener("click", () => openProfile(p.id));
        li.appendChild(btn);
        return li;
      })
    : [emptyText(isAdmin
        ? "Aucun membre. Appuyez sur « + Inscrire » pour en ajouter un."
        : "Aucun membre pour le moment.")]));

  if (currentProfileId) {
    if (personById(currentProfileId)) renderProfile();
    else closeProfile();
  }
}

function renderProfile() {
  const person = personById(currentProfileId);
  $("profile-avatar").replaceChildren(avatar(person, "large"));
  $("profile-name").textContent = person.name;
  $("profile-since").textContent = `Inscrit(e) le ${dayFmt.format(new Date(person.created))}`;
  $("profile-total").textContent = fmt(totalFor(person.id));

  const years = yearsOf(person);
  const year = years.at(-1);
  const status = statusOf(year);
  $("year-title").textContent = `Année ${year.number}`;
  $("year-status").textContent = status.label;
  $("year-status").className = `pill ${status.cls}`;
  $("year-range").textContent = `Du ${dayFmt.format(new Date(year.start))} au ${dayFmt.format(new Date(year.end))}`;
  $("year-progress").textContent = fmt(year.progress);
  $("year-goal").textContent = fmt(year.goal);
  setBar($("year-bar"), year.progress, year.goal);

  const details = [];
  if (year.carryIn > 0) details.push(`dont ${fmt(year.carryIn)} reporté(s) de l'année ${year.number - 1}`);
  if (year.done) {
    if (year.progress > year.goal) details.push(`${fmt(year.progress - year.goal)} d'avance pour l'année ${year.number + 1}`);
  } else {
    details.push(`reste ${fmt(year.goal - year.progress)}`);
  }
  details.push(`${plural(daysLeft(year), "jour restant", "jours restants")}`);
  $("year-detail").textContent = details.join(" · ");

  const past = years.slice(0, -1).reverse();
  $("past-card").hidden = past.length === 0;
  $("past-list").replaceChildren(...past.map((y) => {
    const li = el("li");
    const left = el("span", "", `Année ${y.number} : ${fmt(y.progress)} / ${fmt(y.goal)} `);
    left.appendChild(el("strong", y.done ? "ok-text" : "warn-text", y.done ? "✓" : "✗"));
    const right = el("span", "muted small-text", y.carryOut > 0 ? `+${fmt(y.carryOut)} reporté(s)` : "");
    li.append(left, right);
    return li;
  }));

  const payments = paymentsOf(person.id).sort(byNewest);
  $("profile-list").replaceChildren(...(payments.length
    ? payments.map((p) => paymentRow(p, false))
    : [emptyText("Aucun paiement pour le moment.")]));
}

function openProfile(id) {
  currentProfileId = id;
  $("edit-form").hidden = true;
  renderProfile();
  $("members-home").hidden = true;
  $("profile").hidden = false;
  window.scrollTo(0, 0);
}

function closeProfile() {
  currentProfileId = null;
  $("profile").hidden = true;
  $("members-home").hidden = false;
}

function showView(name) {
  if (name === "deposit" && !isAdmin) name = "dashboard";
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === name));
  document.querySelectorAll(".view").forEach((v) => (v.hidden = v.id !== `view-${name}`));
  if (name === "members") closeProfile();
}

const activeView = () => (document.querySelector(".tab.active") || {}).dataset?.view;

// ---------- Admin mode ----------
function setAdmin(on) {
  isAdmin = on;
  if (!on) {
    pin = "";
    clearPin();
    if (activeView() === "deposit") showView("dashboard");
  }
  render();
}

function openLogin() {
  $("pin-error").hidden = true;
  $("pin-input").value = "";
  $("app").hidden = true;
  $("lock").hidden = false;
  $("pin-input").focus();
}

function closeLogin() {
  $("lock").hidden = true;
  $("app").hidden = false;
}

async function login(value, silent = false) {
  try {
    await api("POST", { action: "login" }, value);
    pin = value;
    savePin(value);
    setAdmin(true);
    return true;
  } catch (e) {
    if (!silent) {
      $("pin-error").textContent = e.message;
      $("pin-error").hidden = false;
    } else if (e.message === "Mot de passe incorrect.") {
      clearPin();
    }
    return false;
  }
}

// ---------- Photo: crop to a square and shrink before upload ----------
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Format d'image non pris en charge.")); };
    img.src = url;
  });
}

async function photoToJpeg(file) {
  const img = await loadImage(file);
  const side = Math.min(img.naturalWidth, img.naturalHeight);
  if (!side) throw new Error("Format d'image non pris en charge.");
  const size = Math.min(400, side);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, size, size);
  ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, size, size);
  return canvas.toDataURL("image/jpeg", 0.85);
}

// ---------- Events ----------
$("admin-btn").addEventListener("click", openLogin);
$("pin-cancel").addEventListener("click", closeLogin);
$("lock-btn").addEventListener("click", () => { setAdmin(false); toast("Mode admin quitté"); });

$("pin-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = e.submitter || e.target.querySelector("button[type=submit]");
  btn.disabled = true;
  $("pin-error").hidden = true;
  const ok = await login($("pin-input").value.trim());
  btn.disabled = false;
  if (ok) {
    closeLogin();
    toast("Mode admin activé");
  }
});

document.querySelectorAll(".tab").forEach((tab) =>
  tab.addEventListener("click", () => showView(tab.dataset.view)));

$("deposit-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const personId = $("person-select").value;
  const cents = parseCents($("amount-input").value);
  if (!personId) return toast("Choisissez un membre.", true);
  if (!(cents > 0)) return toast("Entrez un montant supérieur à 0.", true);

  const btn = e.submitter || e.target.querySelector("button[type=submit]");
  busy(btn, async () => {
    data = await api("POST", { action: "deposit", personId, cents });
    render();
    toast(`${fmt(cents)} enregistré pour ${personName(personId)}`);
    $("amount-input").value = "";
  });
});

$("register-toggle").addEventListener("click", () => {
  $("register-form").hidden = false;
  $("goal-input").value = "750";
  $("name-input").focus();
});

$("register-cancel").addEventListener("click", () => {
  $("register-form").hidden = true;
  $("name-input").value = "";
});

$("register-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("name-input").value.trim();
  const yearlyGoalCents = parseCents($("goal-input").value);
  if (!name) return;
  if (!(yearlyGoalCents > 0)) return toast("Entrez un objectif annuel supérieur à 0.", true);
  const btn = e.submitter || e.target.querySelector("button[type=submit]");
  busy(btn, async () => {
    data = await api("POST", { action: "register", name, yearlyGoalCents });
    render();
    toast(`${name} inscrit(e)`);
    $("name-input").value = "";
    $("register-form").hidden = true;
  });
});

$("profile-back").addEventListener("click", closeProfile);

$("edit-toggle").addEventListener("click", () => {
  const person = personById(currentProfileId);
  if (!person) return;
  $("edit-name").value = person.name;
  $("edit-goal").value = (currentGoal(person) / 100).toFixed(2);
  $("edit-form").hidden = false;
  $("edit-name").focus();
});

$("edit-cancel").addEventListener("click", () => { $("edit-form").hidden = true; });

$("edit-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("edit-name").value.trim();
  const yearlyGoalCents = parseCents($("edit-goal").value);
  if (!name) return;
  if (!(yearlyGoalCents > 0)) return toast("Entrez un objectif annuel supérieur à 0.", true);
  const btn = e.submitter || e.target.querySelector("button[type=submit]");
  busy(btn, async () => {
    data = await api("POST", { action: "editMember", personId: currentProfileId, name, yearlyGoalCents });
    $("edit-form").hidden = true;
    render();
    toast("Profil mis à jour");
  });
});

$("photo-btn").addEventListener("click", () => $("photo-input").click());

$("photo-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file || !currentProfileId) return;
  busy($("photo-btn"), async () => {
    const image = await photoToJpeg(file);
    data = await api("POST", { action: "photo", personId: currentProfileId, image });
    render();
    toast("Photo mise à jour");
  });
});

// ---------- Start ----------
async function start() {
  render();
  try {
    data = await api("GET");
    $("load-error").hidden = true;
  } catch (e) {
    $("load-error").textContent = e.message;
    $("load-error").hidden = false;
  }
  render();
  const saved = readPin();
  if (saved) await login(saved, true);
}

start();
