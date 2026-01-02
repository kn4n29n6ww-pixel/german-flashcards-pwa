import {
  openDB, getAllDecks, addDeck, updateDeck, deleteDeck,
  getCardsByDeck, addCard, updateCard, deleteCard, putCard,
  exportAll, wipeAll
} from "./db.js";

/** --------------------------
 *  PWA / Service Worker
 *  -------------------------- */
async function registerSW() {
  if (!("serviceWorker" in navigator)) return;
  try {
    await navigator.serviceWorker.register("./sw.js");
  } catch (e) {
    console.warn("SW registration failed", e);
  }
}

/** --------------------------
 *  Settings
 *  -------------------------- */
const SETTINGS_KEY = "gfc_settings_v1";
function loadSettings() {
  const d = {
    theme: "system", // system | dark | light
    front: "english", // english | german
    ttsVoiceURI: ""
  };
  try {
    return { ...d, ...(JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}) };
  } catch { return d; }
}
function saveSettings(s) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}
let settings = loadSettings();

function applyTheme() {
  const root = document.documentElement;
  let theme = settings.theme;
  if (theme === "system") {
    const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    theme = prefersDark ? "dark" : "light";
  }
  root.dataset.theme = theme;
  document.querySelector("#btnTheme").textContent = theme === "dark" ? "☀️" : "🌙";
}

/** --------------------------
 *  DOM helpers
 *  -------------------------- */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
function setStatus(msg) { $("#footerStatus").textContent = msg; }
function escapeHtml(s) {
  return (s ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;" }[c]));
}
function downloadFile(filename, content, mime="text/plain") {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** --------------------------
 *  CSV utils (simple but solid)
 *  -------------------------- */
function parseCSV(text) {
  // Handles quotes and commas.
  const rows = [];
  let row = [];
  let cur = "";
  let inQuotes = false;

  for (let i=0; i<text.length; i++) {
    const ch = text[i];
    const next = text[i+1];

    if (inQuotes) {
      if (ch === '"' && next === '"') { cur += '"'; i++; continue; }
      if (ch === '"') { inQuotes = false; continue; }
      cur += ch; continue;
    } else {
      if (ch === '"') { inQuotes = true; continue; }
      if (ch === ",") { row.push(cur); cur=""; continue; }
      if (ch === "\r") continue;
      if (ch === "\n") { row.push(cur); rows.push(row); row=[]; cur=""; continue; }
      cur += ch;
    }
  }
  row.push(cur);
  if (row.length > 1 || row[0].trim() !== "") rows.push(row);
  return rows;
}

function toCSV(rows) {
  const esc = (v) => {
    const s = (v ?? "").toString();
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  return rows.map(r => r.map(esc).join(",")).join("\n");
}

/** --------------------------
 *  SRS (simple spaced repetition)
 *  grade: "again" | "good" | "easy"
 *  -------------------------- */
function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
function applySRS(card, grade) {
  const s = card.srs;
  const now = Date.now();

  // Values chosen to feel reasonable without being “too Anki”.
  if (grade === "again") {
    s.lapses += 1;
    s.reps = 0;
    s.ease = clamp(s.ease - 0.20, 1.3, 3.0);
    s.intervalDays = 0.25; // ~6 hours
    s.due = now + s.intervalDays * 24*60*60*1000;
    return;
  }

  if (grade === "good") {
    s.ease = clamp(s.ease + 0.05, 1.3, 3.0);
    if (s.reps === 0) s.intervalDays = 1;
    else s.intervalDays = Math.max(1, s.intervalDays * s.ease);
    s.reps += 1;
    s.due = now + s.intervalDays * 24*60*60*1000;
    return;
  }

  if (grade === "easy") {
    s.ease = clamp(s.ease + 0.15, 1.3, 3.0);
    if (s.reps === 0) s.intervalDays = 2;
    else s.intervalDays = Math.max(2, s.intervalDays * s.ease * 1.3);
    s.reps += 1;
    s.due = now + s.intervalDays * 24*60*60*1000;
  }
}

/** --------------------------
 *  App state
 *  -------------------------- */
let db;
let decks = [];
let selectedDeckId = null;
let selectedDeckCards = [];
let study = {
  active: false,
  mode: "flash", // flash | gender
  deckId: null,
  goal: 20,
  done: 0,
  queue: [],
  current: null,
  flipped: false,
  genderAnswered: false,
  genderCorrect: false
};

/** --------------------------
 *  Tabs
 *  -------------------------- */
function setTab(name) {
  $$(".tab").forEach(b => b.classList.toggle("active", b.dataset.tab === name));
  $$(".panel").forEach(p => p.classList.toggle("active", p.id === `tab-${name}`));
}

/** --------------------------
 *  Render: deck selects
 *  -------------------------- */
function renderDeckSelects() {
  const selects = [$("#studyDeckSelect"), $("#importDeckSelect"), $("#exportDeckSelect")];
  for (const sel of selects) {
    sel.innerHTML = "";
    if (decks.length === 0) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "No decks yet — create one";
      sel.appendChild(opt);
      sel.disabled = true;
    } else {
      sel.disabled = false;
      for (const d of decks) {
        const opt = document.createElement("option");
        opt.value = d.id;
        opt.textContent = d.name;
        sel.appendChild(opt);
      }
    }
  }
  if (selectedDeckId && decks.some(d => d.id === selectedDeckId)) {
    $("#studyDeckSelect").value = selectedDeckId;
    $("#exportDeckSelect").value = selectedDeckId;
    $("#importDeckSelect").value = selectedDeckId;
  }
}

/** --------------------------
 *  Render: decks list
 *  -------------------------- */
async function renderDeckList() {
  const wrap = $("#deckList");
  wrap.innerHTML = "";

  if (decks.length === 0) {
    wrap.innerHTML = `<div class="empty">No decks yet. Create one on the left.</div>`;
    return;
  }

  for (const d of decks) {
    // Count cards quickly by reading index for each deck (small-scale acceptable).
    const cards = await getCardsByDeck(db, d.id);
    const due = cards.filter(c => (c.srs?.due ?? 0) <= Date.now()).length;

    const el = document.createElement("div");
    el.className = "item";
    el.innerHTML = `
      <div>
        <div class="title">${escapeHtml(d.name)}</div>
        <div class="meta">${cards.length} cards • ${due} due</div>
      </div>
      <div class="actions">
        <button class="btn" data-action="select">Select</button>
        <button class="btn" data-action="rename">Rename</button>
        <button class="btn danger" data-action="delete">Delete</button>
      </div>
    `;
    el.querySelector('[data-action="select"]').onclick = async () => {
      selectedDeckId = d.id;
      await loadCardsForSelectedDeck();
      setStatus(`Selected deck: ${d.name}`);
      renderDeckSelects();
    };

    el.querySelector('[data-action="rename"]').onclick = async () => {
      const name = prompt("Rename deck:", d.name);
      if (!name || !name.trim()) return;
      await updateDeck(db, d.id, name);
      await refreshDecks();
      setStatus("Deck renamed.");
    };

    el.querySelector('[data-action="delete"]').onclick = async () => {
      const ok = confirm(`Delete deck "${d.name}" and all its cards?`);
      if (!ok) return;
      await deleteDeck(db, d.id);
      if (selectedDeckId === d.id) {
        selectedDeckId = null;
        selectedDeckCards = [];
      }
      await refreshDecks();
      await loadCardsForSelectedDeck();
      setStatus("Deck deleted.");
    };

    wrap.appendChild(el);
  }
}

/** --------------------------
 *  Cards: load + render
 *  -------------------------- */
async function loadCardsForSelectedDeck() {
  const title = $("#cardsTitle");
  const area = $("#cardsArea");
  const none = $("#noDeckSelected");

  if (!selectedDeckId) {
    title.textContent = "Cards";
    area.classList.add("hidden");
    none.classList.remove("hidden");
    $("#cardList").innerHTML = "";
    return;
  }
  const deck = decks.find(d => d.id === selectedDeckId);
  title.textContent = `Cards • ${deck ? deck.name : ""}`;
  none.classList.add("hidden");
  area.classList.remove("hidden");

  selectedDeckCards = await getCardsByDeck(db, selectedDeckId);
  renderCardList();
  renderStudyStats();
}

function renderCardList() {
  const list = $("#cardList");
  const q = ($("#cardSearch").value || "").toLowerCase().trim();
  list.innerHTML = "";

  const cards = selectedDeckCards.filter(c => {
    if (!q) return true;
    return (
      c.english.toLowerCase().includes(q) ||
      c.german.toLowerCase().includes(q) ||
      (c.article || "").toLowerCase().includes(q) ||
      (c.example || "").toLowerCase().includes(q) ||
      (c.notes || "").toLowerCase().includes(q)
    );
  });

  if (cards.length === 0) {
    list.innerHTML = `<div class="empty">${q ? "No matches." : "No cards yet. Add one above."}</div>`;
    return;
  }

  for (const c of cards) {
    const due = (c.srs?.due ?? 0) <= Date.now();
    const el = document.createElement("div");
    el.className = "item";
    el.innerHTML = `
      <div style="min-width:0">
        <div class="title">${escapeHtml(c.english)}</div>
        <div class="meta">
          ${escapeHtml([c.article, c.german].filter(Boolean).join(" "))}${c.plural ? " • Pl: " + escapeHtml(c.plural) : ""}
          ${due ? " • ✅ due" : ""}
        </div>
      </div>
      <div class="actions">
        <button class="btn" data-action="edit">Edit</button>
        <button class="btn danger" data-action="delete">Delete</button>
      </div>
    `;
    el.querySelector('[data-action="edit"]').onclick = () => fillCardForm(c);
    el.querySelector('[data-action="delete"]').onclick = async () => {
      const ok = confirm("Delete this card?");
      if (!ok) return;
      await deleteCard(db, c.id);
      await loadCardsForSelectedDeck();
      setStatus("Card deleted.");
    };
    list.appendChild(el);
  }
}

function fillCardForm(card) {
  $("#cardId").value = card.id;
  $("#fEnglish").value = card.english;
  $("#fGerman").value = card.german;
  $("#fArticle").value = card.article || "";
  $("#fPlural").value = card.plural || "";
  $("#fExample").value = card.example || "";
  $("#fNotes").value = card.notes || "";
  setStatus("Editing card — make changes and Save.");
}
function clearCardForm() {
  $("#cardId").value = "";
  $("#cardForm").reset();
  $("#fArticle").value = "";
  setStatus("Cleared form.");
}

/** --------------------------
 *  Study: queue + render
 *  -------------------------- */
function renderStudyStats() {
  const deckId = $("#studyDeckSelect").value || selectedDeckId;
  const wrap = $("#studyStats");

  if (!deckId) { wrap.textContent = "Create a deck and add cards to begin."; return; }

  const deckCards = (deckId === selectedDeckId) ? selectedDeckCards : null;

  // If the selected deck isn't loaded in cards panel, we’ll estimate by loading quickly when needed.
  if (!deckCards) {
    wrap.textContent = "Select a deck (then Start).";
    return;
  }

  const due = deckCards.filter(c => (c.srs?.due ?? 0) <= Date.now()).length;
  const newCount = deckCards.filter(c => (c.srs?.reps ?? 0) === 0).length;

  wrap.textContent = `${deckCards.length} cards • ${due} due • ${newCount} new`;
}

function buildStudyQueue(cards, goal) {
  const now = Date.now();
  const due = cards.filter(c => (c.srs?.due ?? 0) <= now);
  const fresh = cards.filter(c => (c.srs?.reps ?? 0) === 0 && (c.srs?.due ?? 0) <= now);
  const notDue = cards.filter(c => (c.srs?.due ?? 0) > now);

  // Queue preference: due first (including new), then some not-due if needed.
  const q = [...due];
  if (q.length < goal) {
    // add unseen/new not already in due (rare but possible) then notDue
    const add = [...fresh, ...notDue].filter(c => !q.some(x => x.id === c.id));
    q.push(...add);
  }

  // Shuffle lightly so it doesn’t feel repetitive.
  for (let i=q.length-1; i>0; i--) {
    const j = Math.floor(Math.random() * (i+1));
    [q[i], q[j]] = [q[j], q[i]];
  }

  return q.slice(0, goal);
}

function setStudyVisible(active) {
  $("#studyEmpty").classList.toggle("hidden", active);
  $("#studyArea").classList.toggle("hidden", !active);
}

function renderCurrentCard() {
  const c = study.current;
  if (!c) return;

  $("#pillMode").textContent = study.mode === "flash" ? "Flashcards" : "Gender quiz";
  $("#pillProgress").textContent = `${study.done} / ${study.goal}`;

  $("#genderResult").textContent = "";

  const face = $("#cardFace");
  const meta = $("#cardMeta");

  if (study.mode === "flash") {
    $("#genderChoices").classList.add("hidden");
    $("#btnShowAnswer").textContent = study.flipped ? "Hide / Flip" : "Show / Flip";

    const frontIsEnglish = settings.front === "english";
    if (!study.flipped) {
      face.textContent = frontIsEnglish ? c.english : [c.article, c.german].filter(Boolean).join(" ");
      meta.textContent = frontIsEnglish ? "" : (c.english || "");
    } else {
      face.textContent = frontIsEnglish ? [c.article, c.german].filter(Boolean).join(" ") : c.english;

      const lines = [];
      if (c.plural) lines.push(`Plural: ${c.plural}`);
      if (c.example) lines.push(`Example: ${c.example}`);
      if (c.notes) lines.push(`Notes: ${c.notes}`);
      meta.textContent = lines.join("\n");
    }
    return;
  }

  // Gender quiz mode:
  $("#genderChoices").classList.remove("hidden");
  $("#btnShowAnswer").textContent = "Reveal";
  const noun = c.german;
  face.textContent = noun;
  const lines = [];
  if (c.english) lines.push(`Meaning: ${c.english}`);
  if (c.plural) lines.push(`Plural: ${c.plural}`);
  meta.textContent = lines.join("\n");

  // Before answer: hide reveal details.
  if (!study.genderAnswered) {
    $("#genderResult").textContent = "Choose der / die / das.";
  } else {
    $("#genderResult").textContent = study.genderCorrect
      ? "✅ Correct."
      : `❌ Not quite. Correct: ${c.article || "(none)"}.`;
  }
}

/** --------------------------
 *  TTS
 *  -------------------------- */
let voiceCache = [];
function refreshVoices() {
  voiceCache = speechSynthesis?.getVoices?.() || [];
  const sel = $("#ttsVoice");
  sel.innerHTML = "";
  const opt0 = document.createElement("option");
  opt0.value = "";
  opt0.textContent = "Auto (preferred German if available)";
  sel.appendChild(opt0);

  for (const v of voiceCache) {
    const opt = document.createElement("option");
    opt.value = v.voiceURI;
    opt.textContent = `${v.name} • ${v.lang}${v.default ? " (default)" : ""}`;
    sel.appendChild(opt);
  }
  sel.value = settings.ttsVoiceURI || "";
}

function speakGerman(card) {
  if (!("speechSynthesis" in window)) {
    setStatus("Text-to-speech not supported in this browser.");
    return;
  }
  const text = [card.article, card.german].filter(Boolean).join(" ");
  if (!text.trim()) return;

  const u = new SpeechSynthesisUtterance(text);
  // choose voice
  const wanted = settings.ttsVoiceURI && voiceCache.find(v => v.voiceURI === settings.ttsVoiceURI);
  if (wanted) {
    u.voice = wanted;
  } else {
    const german = voiceCache.find(v => /^de(-|_)/i.test(v.lang)) || voiceCache.find(v => v.lang === "de-DE");
    if (german) u.voice = german;
  }
  u.lang = (u.voice && u.voice.lang) ? u.voice.lang : "de-DE";
  u.rate = 0.95;
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}

/** --------------------------
 *  Main actions
 *  -------------------------- */
async function refreshDecks() {
  decks = await getAllDecks(db);
  renderDeckSelects();
  await renderDeckList();
}

async function ensureStarterDeck() {
  decks = await getAllDecks(db);
  if (decks.length === 0) {
    const d = await addDeck(db, "Starter");
    await addCard(db, d.id, {
      english: "the house",
      german: "Haus",
      article: "das",
      plural: "Häuser",
      example: "Das Haus ist groß.",
      notes: "Plural changes vowel (Umlaut)."
    });
    decks = await getAllDecks(db);
  }
}

async function startSession() {
  const deckId = $("#studyDeckSelect").value;
  if (!deckId) { alert("Create/select a deck first."); return; }

  const goal = clamp(parseInt($("#sessionGoal").value || "20", 10), 5, 200);
  const cards = await getCardsByDeck(db, deckId);
  if (cards.length === 0) { alert("That deck has no cards."); return; }

  study.active = true;
  study.mode = $("#modeGender").classList.contains("active") ? "gender" : "flash";
  study.deckId = deckId;
  study.goal = Math.min(goal, cards.length);
  study.done = 0;
  study.queue = buildStudyQueue(cards, study.goal);
  study.current = study.queue.shift();
  study.flipped = false;
  study.genderAnswered = false;
  study.genderCorrect = false;

  setStudyVisible(true);
  renderCurrentCard();
  setStatus("Session started.");
}

async function gradeCurrent(grade) {
  if (!study.active || !study.current) return;

  // In gender mode, if user hasn’t answered yet, force them to answer first.
  if (study.mode === "gender" && !study.genderAnswered) {
    $("#genderResult").textContent = "Pick der/die/das first.";
    return;
  }

  const c = study.current;
  applySRS(c, grade);
  await putCard(db, c);

  study.done += 1;

  if (study.done >= study.goal || study.queue.length === 0) {
    study.active = false;
    setStudyVisible(false);
    setStatus("Session complete.");
    // refresh cards panel if same deck is selected
    if (selectedDeckId === study.deckId) await loadCardsForSelectedDeck();
    return;
  }

  study.current = study.queue.shift();
  study.flipped = false;
  study.genderAnswered = false;
  study.genderCorrect = false;
  renderCurrentCard();
}

/** --------------------------
 *  Import / Export
 *  -------------------------- */
async function importCSV() {
  const file = $("#csvFile").files?.[0];
  if (!file) { $("#importMsg").textContent = "Choose a CSV file first."; return; }

  const text = await file.text();
  const rows = parseCSV(text).filter(r => r.some(x => (x || "").trim() !== ""));
  if (rows.length === 0) { $("#importMsg").textContent = "CSV appears empty."; return; }

  // Detect header
  const header = rows[0].map(h => (h || "").trim().toLowerCase());
  const hasHeader = header.includes("english") || header.includes("german") || header.includes("deck");
  const dataRows = hasHeader ? rows.slice(1) : rows;

  const colIndex = (name) => header.indexOf(name);

  let imported = 0;
  const createdDeckIds = new Map(); // deckName -> id

  for (const r of dataRows) {
    // If header exists, use it; otherwise assume fixed order:
    // english,german,article,plural,example,notes (deck optional)
    let deckName = "";
    let english = "", german = "", article="", plural="", example="", notes="";

    if (hasHeader) {
      deckName = colIndex("deck") >= 0 ? (r[colIndex("deck")] || "") : "";
      english = colIndex("english") >= 0 ? (r[colIndex("english")] || "") : "";
      german  = colIndex("german")  >= 0 ? (r[colIndex("german")]  || "") : "";
      article = colIndex("article") >= 0 ? (r[colIndex("article")] || "") : "";
      plural  = colIndex("plural")  >= 0 ? (r[colIndex("plural")]  || "") : "";
      example = colIndex("example") >= 0 ? (r[colIndex("example")] || "") : "";
      notes   = colIndex("notes")   >= 0 ? (r[colIndex("notes")]   || "") : "";
    } else {
      english = r[0] || "";
      german  = r[1] || "";
      article = r[2] || "";
      plural  = r[3] || "";
      example = r[4] || "";
      notes   = r[5] || "";
      deckName = "";
    }

    const fallbackDeckId = $("#importDeckSelect").value || selectedDeckId;
    let deckId = fallbackDeckId;

    const trimmedDeck = (deckName || "").trim();
    if (trimmedDeck) {
      // find or create deck by name
      const existing = decks.find(d => d.name.toLowerCase() === trimmedDeck.toLowerCase());
      if (existing) deckId = existing.id;
      else if (createdDeckIds.has(trimmedDeck)) deckId = createdDeckIds.get(trimmedDeck);
      else {
        const nd = await addDeck(db, trimmedDeck);
        createdDeckIds.set(trimmedDeck, nd.id);
        deckId = nd.id;
      }
    }

    if (!deckId) continue;
    if (!english.trim() || !german.trim()) continue;

    await addCard(db, deckId, { english, german, article, plural, example, notes });
    imported += 1;
  }

  await refreshDecks();
  if (selectedDeckId) await loadCardsForSelectedDeck();
  $("#importMsg").textContent = `Imported ${imported} cards.`;
  setStatus(`Imported ${imported} cards.`);
}

async function exportDeckCSV() {
  const deckId = $("#exportDeckSelect").value;
  if (!deckId) { $("#exportMsg").textContent = "No deck selected."; return; }
  const deck = decks.find(d => d.id === deckId);
  const cards = await getCardsByDeck(db, deckId);

  const rows = [
    ["deck","english","german","article","plural","example","notes"]
  ];
  for (const c of cards) {
    rows.push([
      deck?.name || "",
      c.english || "",
      c.german || "",
      c.article || "",
      c.plural || "",
      c.example || "",
      c.notes || ""
    ]);
  }
  const csv = toCSV(rows);
  downloadFile(`${(deck?.name || "deck").replace(/[^\w\- ]+/g,"").trim() || "deck"}.csv`, csv, "text/csv");
  $("#exportMsg").textContent = `Exported ${cards.length} cards.`;
}

async function exportBackupJSON() {
  const data = await exportAll(db);
  downloadFile(`german-flashcards-backup-${new Date().toISOString().slice(0,10)}.json`, JSON.stringify(data, null, 2), "application/json");
  $("#exportMsg").textContent = `Exported full backup (JSON).`;
}

/** --------------------------
 *  Gender quiz: answer
 *  -------------------------- */
function onGenderChoice(choice) {
  if (!study.current || study.mode !== "gender") return;
  const correct = (study.current.article || "").toLowerCase().trim();
  study.genderAnswered = true;
  study.genderCorrect = (choice === correct) && !!correct;
  renderCurrentCard();
}

/** --------------------------
 *  Wiring
 *  -------------------------- */
function wireTabs() {
  $$(".tab").forEach(b => {
    b.onclick = () => setTab(b.dataset.tab);
  });
}

function wireTheme() {
  $("#btnTheme").onclick = () => {
    // cycle: system -> dark -> light -> system ...
    const cur = settings.theme;
    settings.theme = cur === "system" ? "dark" : cur === "dark" ? "light" : "system";
    saveSettings(settings);
    applyTheme();
    setStatus(`Theme: ${settings.theme}`);
  };
}

function wireDecks() {
  $("#btnAddDeck").onclick = async () => {
    const name = $("#newDeckName").value.trim();
    if (!name) return;
    await addDeck(db, name);
    $("#newDeckName").value = "";
    await refreshDecks();
    setStatus("Deck added.");
  };

  $("#cardSearch").oninput = () => renderCardList();

  $("#btnClearCard").onclick = () => clearCardForm();

  $("#cardForm").onsubmit = async (e) => {
    e.preventDefault();
    if (!selectedDeckId) { alert("Select a deck first."); return; }

    const fields = {
      english: $("#fEnglish").value,
      german: $("#fGerman").value,
      article: $("#fArticle").value,
      plural: $("#fPlural").value,
      example: $("#fExample").value,
      notes: $("#fNotes").value
    };

    const id = $("#cardId").value;
    if (id) {
      await updateCard(db, id, fields);
      setStatus("Card updated.");
    } else {
      await addCard(db, selectedDeckId, fields);
      setStatus("Card added.");
    }

    clearCardForm();
    await loadCardsForSelectedDeck();
  };

  $("#studyDeckSelect").onchange = async () => {
    // If they pick a deck, also set it as selected deck for card management convenience.
    const id = $("#studyDeckSelect").value;
    if (id) {
      selectedDeckId = id;
      await loadCardsForSelectedDeck();
      renderDeckSelects();
    }
  };
}

function wireStudy() {
  $("#modeFlash").onclick = () => {
    $("#modeFlash").classList.add("active");
    $("#modeGender").classList.remove("active");
  };
  $("#modeGender").onclick = () => {
    $("#modeGender").classList.add("active");
    $("#modeFlash").classList.remove("active");
  };

  $("#btnStartSession").onclick = startSession;

  $("#flashcard").onclick = () => {
    if (!study.active || !study.current) return;
    if (study.mode === "flash") {
      study.flipped = !study.flipped;
      renderCurrentCard();
    }
  };
  $("#flashcard").onkeydown = (e) => {
    if (e.key === "Enter" || e.key === " ") $("#flashcard").click();
  };

  $("#btnShowAnswer").onclick = () => {
    if (!study.active || !study.current) return;
    if (study.mode === "flash") {
      study.flipped = !study.flipped;
    } else {
      // reveal correct article
      study.genderAnswered = true;
      study.genderCorrect = false; // if they haven't chosen, it's "unknown"
      $("#genderResult").textContent = `Answer: ${study.current.article || "(none)"}`;
    }
    renderCurrentCard();
  };

  $("#btnSpeak").onclick = () => {
    if (!study.current) return;
    speakGerman(study.current);
  };

  $("#btnAgain").onclick = () => gradeCurrent("again");
  $("#btnGood").onclick = () => gradeCurrent("good");
  $("#btnEasy").onclick = () => gradeCurrent("easy");

  $$("#genderChoices button").forEach(b => {
    b.onclick = () => onGenderChoice(b.dataset.gender);
  });
}

function wireImportExport() {
  $("#btnImportCsv").onclick = importCSV;
  $("#btnExportCsv").onclick = exportDeckCSV;
  $("#btnExportJson").onclick = exportBackupJSON;
}

function wireSettings() {
  $("#frontSetting").value = settings.front;
  $("#frontSetting").onchange = () => {
    settings.front = $("#frontSetting").value;
    saveSettings(settings);
    setStatus(`Front side: ${settings.front}`);
  };

  $("#btnResetAll").onclick = async () => {
    const ok = confirm("This will delete ALL decks and cards on this device. Continue?");
    if (!ok) return;
    await wipeAll(db);
    selectedDeckId = null;
    selectedDeckCards = [];
    study.active = false;
    setStudyVisible(false);
    await ensureStarterDeck();
    await refreshDecks();
    await loadCardsForSelectedDeck();
    setStatus("All data deleted (starter deck restored).");
  };

  $("#ttsVoice").onchange = () => {
    settings.ttsVoiceURI = $("#ttsVoice").value;
    saveSettings(settings);
    setStatus("TTS voice updated.");
  };
}

/** --------------------------
 *  Init
 *  -------------------------- */
(async function init() {
  applyTheme();
  await registerSW();

  db = await openDB();
  await ensureStarterDeck();
  await refreshDecks();

  // choose default selected deck
  selectedDeckId = decks[0]?.id || null;
  renderDeckSelects();
  await loadCardsForSelectedDeck();

  wireTabs();
  wireTheme();
  wireDecks();
  wireStudy();
  wireImportExport();
  wireSettings();

  // Voices can load async
  if ("speechSynthesis" in window) {
    refreshVoices();
    speechSynthesis.onvoiceschanged = () => refreshVoices();
  } else {
    $("#ttsVoice").innerHTML = `<option value="">Speech Synthesis not supported</option>`;
  }

  setStatus("Ready.");
})();
