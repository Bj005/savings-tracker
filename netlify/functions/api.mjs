import { getStore } from "@netlify/blobs";

// Password to open the app. Change it here if needed.
const APP_PASSWORD = "2026Bank";

const KEY = "data";
const EMPTY = { people: [], payments: [] };

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

// Applies one change to the data. Returns an error message, or null on success.
function applyAction(data, body) {
  if (body.action === "register") {
    const name = String(body.name || "").trim().replace(/\s+/g, " ");
    if (!name) return "Le nom est obligatoire.";
    if (name.length > 60) return "Le nom est trop long (60 caractères max).";
    if (data.people.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
      return `« ${name} » est déjà inscrit(e).`;
    }
    data.people.push({ id: crypto.randomUUID(), name, created: new Date().toISOString() });
    return null;
  }

  if (body.action === "deposit") {
    const person = data.people.find((p) => p.id === body.personId);
    if (!person) return "Choisissez un membre inscrit.";
    const cents = body.cents;
    if (!Number.isInteger(cents) || cents <= 0) return "Entrez un montant supérieur à 0.";
    if (cents > 100_000_000) return "Montant trop élevé.";
    data.payments.push({
      id: crypto.randomUUID(),
      personId: person.id,
      cents,
      date: new Date().toISOString(),
    });
    return null;
  }

  return "Action inconnue.";
}

export default async (req) => {
  if (req.headers.get("x-pin") !== APP_PASSWORD) return json({ error: "Mot de passe incorrect." }, 401);

  const store = getStore({ name: "savings", consistency: "strong" });

  if (req.method === "GET") {
    const data = (await store.get(KEY, { type: "json" })) || EMPTY;
    return json(data);
  }

  if (req.method !== "POST") return json({ error: "Méthode non autorisée." }, 405);

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Requête invalide." }, 400);
  }

  // Read-modify-write with an ETag check, so two saves at the same moment can't overwrite each other.
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
};

export const config = { path: "/api" };
