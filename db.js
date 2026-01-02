// IndexedDB wrapper for decks + cards.
// Schema v1:
// - decks: { id, name, createdAt }
// - cards: { id, deckId, english, german, article, plural, example, notes, createdAt, srs:{due, intervalDays, ease, reps, lapses} }

const DB_NAME = "germanFlashcardsDB";
const DB_VERSION = 1;

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error("Transaction aborted"));
    tx.onerror = () => reject(tx.error);
  });
}

export async function openDB() {
  const req = indexedDB.open(DB_NAME, DB_VERSION);
  req.onupgradeneeded = () => {
    const db = req.result;

    const decks = db.createObjectStore("decks", { keyPath: "id" });
    decks.createIndex("by_name", "name", { unique: false });

    const cards = db.createObjectStore("cards", { keyPath: "id" });
    cards.createIndex("by_deck", "deckId", { unique: false });
    cards.createIndex("by_due", "srs.due", { unique: false });
  };
  return reqToPromise(req);
}

export function uid() {
  return Math.random().toString(16).slice(2) + "-" + Date.now().toString(16);
}

export async function getAllDecks(db) {
  const tx = db.transaction("decks", "readonly");
  const store = tx.objectStore("decks");
  const decks = await reqToPromise(store.getAll());
  await txDone(tx);
  decks.sort((a,b) => a.name.localeCompare(b.name));
  return decks;
}

export async function addDeck(db, name) {
  const deck = { id: uid(), name: name.trim(), createdAt: Date.now() };
  const tx = db.transaction("decks", "readwrite");
  tx.objectStore("decks").add(deck);
  await txDone(tx);
  return deck;
}

export async function updateDeck(db, id, name) {
  const tx = db.transaction("decks", "readwrite");
  const store = tx.objectStore("decks");
  const deck = await reqToPromise(store.get(id));
  if (!deck) throw new Error("Deck not found");
  deck.name = name.trim();
  store.put(deck);
  await txDone(tx);
  return deck;
}

export async function deleteDeck(db, id) {
  const tx = db.transaction(["decks","cards"], "readwrite");
  tx.objectStore("decks").delete(id);

  const cardsStore = tx.objectStore("cards");
  const idx = cardsStore.index("by_deck");
  const range = IDBKeyRange.only(id);
  const cursorReq = idx.openCursor(range);
  cursorReq.onsuccess = (e) => {
    const cur = e.target.result;
    if (cur) {
      cur.delete();
      cur.continue();
    }
  };
  await txDone(tx);
}

export async function getCardsByDeck(db, deckId) {
  const tx = db.transaction("cards", "readonly");
  const store = tx.objectStore("cards");
  const idx = store.index("by_deck");
  const cards = await reqToPromise(idx.getAll(IDBKeyRange.only(deckId)));
  await txDone(tx);
  cards.sort((a,b) => a.createdAt - b.createdAt);
  return cards;
}

export function defaultSRS() {
  return {
    due: Date.now(),       // due immediately
    intervalDays: 0,
    ease: 2.3,             // typical starting ease
    reps: 0,
    lapses: 0
  };
}

export async function addCard(db, deckId, fields) {
  const card = {
    id: uid(),
    deckId,
    english: fields.english.trim(),
    german: fields.german.trim(),
    article: (fields.article || "").trim(),
    plural: (fields.plural || "").trim(),
    example: (fields.example || "").trim(),
    notes: (fields.notes || "").trim(),
    createdAt: Date.now(),
    srs: defaultSRS()
  };
  const tx = db.transaction("cards", "readwrite");
  tx.objectStore("cards").add(card);
  await txDone(tx);
  return card;
}

export async function updateCard(db, cardId, fields) {
  const tx = db.transaction("cards", "readwrite");
  const store = tx.objectStore("cards");
  const card = await reqToPromise(store.get(cardId));
  if (!card) throw new Error("Card not found");

  card.english = fields.english.trim();
  card.german = fields.german.trim();
  card.article = (fields.article || "").trim();
  card.plural = (fields.plural || "").trim();
  card.example = (fields.example || "").trim();
  card.notes = (fields.notes || "").trim();

  store.put(card);
  await txDone(tx);
  return card;
}

export async function deleteCard(db, cardId) {
  const tx = db.transaction("cards", "readwrite");
  tx.objectStore("cards").delete(cardId);
  await txDone(tx);
}

export async function putCard(db, card) {
  const tx = db.transaction("cards", "readwrite");
  tx.objectStore("cards").put(card);
  await txDone(tx);
}

export async function exportAll(db) {
  const tx1 = db.transaction("decks", "readonly");
  const decks = await reqToPromise(tx1.objectStore("decks").getAll());
  await txDone(tx1);

  const tx2 = db.transaction("cards", "readonly");
  const cards = await reqToPromise(tx2.objectStore("cards").getAll());
  await txDone(tx2);

  return { version: 1, exportedAt: new Date().toISOString(), decks, cards };
}

export async function wipeAll(db) {
  const tx = db.transaction(["decks","cards"], "readwrite");
  tx.objectStore("decks").clear();
  tx.objectStore("cards").clear();
  await txDone(tx);
}
