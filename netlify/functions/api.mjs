import { randomUUID } from "node:crypto";
import { getStore } from "@netlify/blobs";

// Admin password: required to add or change anything. Viewing is public.
// It can also be set as ADMIN_PASSWORD in Netlify (Site configuration > Environment variables),
// which then takes priority over the value written here.
const APP_PASSWORD = process.env.ADMIN_PASSWORD || "2026Bank";

const KEY = "data";
const EMPTY = { people: [], payments: [] };
const DEFAULT_YEARLY_GOAL_CENTS = 75_000; // $750
const MAX_CENTS = 100_000_000;
const MAX_PHOTO_BYTES = 600_000;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

const cleanName = (value) => String(value || "").trim().replace(/\s+/g, " ");
const validCents = (cents) => Number.isInteger(cents) && cents > 0 && cents <= MAX_CENTS;

// Members registered before goals existed get the default yearly goal from their registration date.
function normalize(data) {
  data.people = Array.isArray(data.people) ? data.people : [];
  data.payments = Array.isArray(data.payments) ? data.payments : [];
  for (const p of data.people) {
    if (!Array.isArray(p.goals) || !p.goals.length) {
      p.goals = [{ from: p.created, cents: DEFAULT_YEARLY_GOAL_CENTS }];
    }
  }
  return data;
}

function checkName(data, name, exceptId) {
  if (!name) return "Le nom est obligatoire.";
  if (name.length > 60) return "Le nom est trop long (60 caractères max).";
  if (data.people.some((p) => p.id !== exceptId && p.name.toLowerCase() === name.toLowerCase())) {
    return `« ${name} » est déjà inscrit(e).`;
  }
  return null;
}

// Applies one change to the data. Returns an error message, or null on success.
function applyAction(data, body) {
  normalize(data);

  if (body.action === "register") {
    const name = cleanName(body.name);
    const nameError = checkName(data, name);
    if (nameError) return nameError;
    const goal = body.yearlyGoalCents ?? DEFAULT_YEARLY_GOAL_CENTS;
    if (!validCents(goal)) return "Entrez un objectif annuel supérieur à 0.";
    const created = new Date().toISOString();
    data.people.push({ id: randomUUID(), name, created, goals: [{ from: created, cents: goal }] });
    return null;
  }

  if (body.action === "editMember") {
    const person = data.people.find((p) => p.id === body.personId);
    if (!person) return "Membre introuvable.";
    const name = cleanName(body.name);
    const nameError = checkName(data, name, person.id);
    if (nameError) return nameError;
    const goal = body.yearlyGoalCents;
    if (!validCents(goal)) return "Entrez un objectif annuel supérieur à 0.";
    person.name = name;
    if (person.goals[person.goals.length - 1].cents !== goal) {
      person.goals.push({ from: new Date().toISOString(), cents: goal });
    }
    return null;
  }

  if (body.action === "setPhoto") {
    const person = data.people.find((p) => p.id === body.personId);
    if (!person) return "Membre introuvable.";
    person.photo = body.version;
    return null;
  }

  if (body.action === "deposit") {
    const person = data.people.find((p) => p.id === body.personId);
    if (!person) return "Choisissez un membre inscrit.";
    const cents = body.cents;
    if (!Number.isInteger(cents) || cents <= 0) return "Entrez un montant supérieur à 0.";
    if (cents > MAX_CENTS) return "Montant trop élevé.";
    data.payments.push({
      id: randomUUID(),
      personId: person.id,
      cents,
      date: new Date().toISOString(),
    });
    return null;
  }

  if (body.action === "editPayment") {
    const payment = data.payments.find((p) => p.id === body.paymentId);
    if (!payment) return "Paiement introuvable.";
    const cents = body.cents;
    if (!Number.isInteger(cents) || cents <= 0) return "Entrez un montant supérieur à 0.";
    if (cents > MAX_CENTS) return "Montant trop élevé.";
    payment.cents = cents;
    payment.edited = new Date().toISOString();
    return null;
  }

  if (body.action === "deletePayment") {
    const index = data.payments.findIndex((p) => p.id === body.paymentId);
    if (index === -1) return "Paiement introuvable.";
    data.payments.splice(index, 1);
    return null;
  }

  return "Action inconnue.";
}

// Read-modify-write with an ETag check, so two saves at the same moment can't overwrite each other.
async function save(store, body) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const current = await store.getWithMetadata(KEY, { type: "json" });
    const data = current ? current.data : structuredClone(EMPTY);

    const error = applyAction(data, body);
    if (error) return json({ error }, 400);

    const result = current
      ? await store.setJSON(KEY, data, { onlyIfMatch: current.etag })
      : await store.setJSON(KEY, data, { onlyIfNew: true });

    if (result.modified) return json(data);
  }
  return json({ error: "Serveur occupé, réessayez." }, 409);
}

async function getPhoto(id) {
  const photos = getStore({ name: "savings-photos", consistency: "strong" });
  const bytes = await photos.get(id, { type: "arrayBuffer" });
  if (!bytes) return new Response("Not found", { status: 404 });
  return new Response(bytes, {
    headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=31536000, immutable" },
  });
}

async function uploadPhoto(store, body) {
  const data = normalize((await store.get(KEY, { type: "json" })) || structuredClone(EMPTY));
  if (!data.people.some((p) => p.id === body.personId)) return json({ error: "Membre introuvable." }, 400);

  const match = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(body.image || ""));
  if (!match) return json({ error: "Image invalide." }, 400);
  const bytes = Buffer.from(match[1], "base64");
  if (bytes.length < 3 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
    return json({ error: "Image invalide." }, 400);
  }
  if (bytes.length > MAX_PHOTO_BYTES) return json({ error: "Image trop lourde." }, 400);

  const photos = getStore({ name: "savings-photos", consistency: "strong" });
  await photos.set(body.personId, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
  return save(store, { action: "setPhoto", personId: body.personId, version: Date.now() });
}

export default async (req) => {
  const store = getStore({ name: "savings", consistency: "strong" });

  // Viewing is public.
  if (req.method === "GET") {
    const photoId = new URL(req.url).searchParams.get("photo");
    if (photoId) {
      if (!/^[A-Za-z0-9-]{1,64}$/.test(photoId)) return new Response("Not found", { status: 404 });
      return getPhoto(photoId);
    }
    const data = (await store.get(KEY, { type: "json" })) || structuredClone(EMPTY);
    return json(normalize(data));
  }

  if (req.method !== "POST") return json({ error: "Méthode non autorisée." }, 405);

  // Every change needs the admin password.
  if (req.headers.get("x-pin") !== APP_PASSWORD) return json({ error: "Mot de passe incorrect." }, 401);

  let body;
  try {
    body = await req.json();
  } catch {
    body = null;
  }
  if (!body || typeof body !== "object") return json({ error: "Requête invalide." }, 400);

  if (body.action === "login") return json({ ok: true });
  if (body.action === "photo") return uploadPhoto(store, body);
  if (body.action === "setPhoto") return json({ error: "Action inconnue." }, 400);

  return save(store, body);
};

export const config = { path: "/api" };
