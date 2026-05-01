const DB_NAME = 'jdict';
const DB_VERSION = 1;
const DICT_URL = './data/dictionary.json';

let db = null;
let searchMode = 'all';
let currentResults = [];
let searchTimeout = null;

// Partie de discours → libellé français
const POS_LABELS = {
  'n': 'nom', 'v1': 'verbe ichidan', 'v5r': 'verbe godan', 'v5k': 'verbe godan',
  'v5g': 'verbe godan', 'v5s': 'verbe godan', 'v5t': 'verbe godan', 'v5n': 'verbe godan',
  'v5b': 'verbe godan', 'v5m': 'verbe godan', 'v5u': 'verbe godan', 'vk': 'verbe irrégulier',
  'vs': 'verbe suru', 'adj-i': 'adjectif -i', 'adj-na': 'adjectif -na', 'adj-no': 'adjectif -no',
  'adv': 'adverbe', 'conj': 'conjonction', 'int': 'interjection', 'pn': 'pronom',
  'prt': 'particule', 'exp': 'expression', 'aux': 'auxiliaire', 'cop': 'copule',
  'pref': 'préfixe', 'suf': 'suffixe', 'num': 'numéral', 'ctr': 'compteur'
};

// ── IndexedDB ────────────────────────────────────────────────

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('entries')) {
        const store = d.createObjectStore('entries', { keyPath: 'id' });
        store.createIndex('kanji', 'k', { multiEntry: true });
        store.createIndex('reading', 'r', { multiEntry: true });
      }
      if (!d.objectStoreNames.contains('meta')) {
        d.createObjectStore('meta', { keyPath: 'key' });
      }
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = e => reject(e.target.error);
  });
}

function getMeta(key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('meta', 'readonly');
    const req = tx.objectStore('meta').get(key);
    req.onsuccess = e => resolve(e.target.result?.value);
    req.onerror = e => reject(e.target.error);
  });
}

function setMeta(key, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('meta', 'readwrite');
    tx.objectStore('meta').put({ key, value });
    tx.oncomplete = resolve;
    tx.onerror = e => reject(e.target.error);
  });
}

function bulkInsert(entries) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('entries', 'readwrite');
    const store = tx.objectStore('entries');
    entries.forEach(e => store.put(e));
    tx.oncomplete = resolve;
    tx.onerror = e => reject(e.target.error);
  });
}

// ── Chargement dictionnaire ──────────────────────────────────

async function loadDictionary() {
  setLoading('Connexion à la base de données...');
  db = await openDB();

  const version = await getMeta('version');
  if (version === '3.6.2') {
    showApp();
    return;
  }

  setLoading('Téléchargement du dictionnaire (≈ 15 Mo)...', true, 0);

  const response = await fetch(DICT_URL);
  if (!response.ok) throw new Error('Impossible de télécharger le dictionnaire.');

  const total = parseInt(response.headers.get('Content-Length') || '0');
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (total) updateProgress(received / total * 50, `Téléchargement: ${Math.round(received / 1024 / 1024)} Mo`);
  }

  setLoading('Décompression...', true, 50);
  const blob = new Blob(chunks);
  const text = await blob.text();

  setLoading('Analyse du dictionnaire...', true, 55);
  const data = JSON.parse(text);

  setLoading('Indexation dans la base locale...', true, 60);
  const entries = data.words || data;
  const BATCH = 2000;
  const total_entries = entries.length;

  for (let i = 0; i < total_entries; i += BATCH) {
    const batch = entries.slice(i, i + BATCH).map(compactEntry);
    await bulkInsert(batch);
    const pct = 60 + (i / total_entries) * 38;
    updateProgress(pct, `Indexation: ${i.toLocaleString()} / ${total_entries.toLocaleString()}`);
    await new Promise(r => setTimeout(r, 0));
  }

  await setMeta('version', '3.6.2');
  await setMeta('count', total_entries);
  showApp();
}

function compactEntry(word) {
  const k = (word.kanji || []).map(e => e.text);
  const r = (word.kana || []).map(e => e.text);
  const s = (word.sense || []).map(sense => {
    const fr = (sense.gloss || []).filter(g => g.lang === 'fre').map(g => g.text);
    const en = (sense.gloss || []).filter(g => g.lang === 'eng').map(g => g.text);
    const p = (sense.partOfSpeech || []);
    return { p, fr, en };
  }).filter(s => s.fr.length > 0 || s.en.length > 0);
  return { id: word.id, k, r, s };
}

// ── Recherche ────────────────────────────────────────────────

function search(query) {
  if (!query || query.length < 1) {
    clearResults();
    return;
  }

  const isJapanese = /[　-鿿＀-￯]/.test(query);
  const isFrench = /[a-zA-ZÀ-ÿ]/.test(query);

  if (isJapanese || searchMode === 'ja') {
    searchJapanese(query);
  } else if (isFrench || searchMode === 'fr' || searchMode === 'en') {
    searchMeaning(query);
  } else {
    searchJapanese(query);
  }
}

function searchJapanese(query) {
  const results = [];
  const seen = new Set();

  // Cherche par kanji
  const tx1 = db.transaction('entries', 'readonly');
  const idx1 = tx1.objectStore('entries').index('kanji');
  const range1 = IDBKeyRange.bound(query, query + '￿');
  const req1 = idx1.openCursor(range1);

  req1.onsuccess = e => {
    const cursor = e.target.result;
    if (cursor && results.length < 100) {
      if (!seen.has(cursor.value.id)) {
        seen.add(cursor.value.id);
        results.push(cursor.value);
      }
      cursor.continue();
    } else {
      // Cherche aussi par lecture kana
      const tx2 = db.transaction('entries', 'readonly');
      const idx2 = tx2.objectStore('entries').index('reading');
      const range2 = IDBKeyRange.bound(query, query + '￿');
      const req2 = idx2.openCursor(range2);

      req2.onsuccess = e2 => {
        const c2 = e2.target.result;
        if (c2 && results.length < 150) {
          if (!seen.has(c2.value.id)) {
            seen.add(c2.value.id);
            results.push(c2.value);
          }
          c2.continue();
        } else {
          displayResults(results, query);
        }
      };
    }
  };
}

function searchMeaning(query) {
  const q = query.toLowerCase();
  const results = [];
  const tx = db.transaction('entries', 'readonly');
  const req = tx.objectStore('entries').openCursor();

  req.onsuccess = e => {
    const cursor = e.target.result;
    if (cursor && results.length < 100) {
      const entry = cursor.value;
      const lang = searchMode === 'en' ? 'en' : (searchMode === 'fr' ? 'fr' : null);
      const hit = entry.s.some(sense =>
        (lang !== 'en' && sense.fr.some(g => g.toLowerCase().includes(q))) ||
        (lang !== 'fr' && sense.en.some(g => g.toLowerCase().includes(q)))
      );
      if (hit) results.push(entry);
      cursor.continue();
    } else {
      displayResults(results, query);
    }
  };
}

// ── Affichage ────────────────────────────────────────────────

function displayResults(entries, query) {
  currentResults = entries;
  const container = document.getElementById('results');
  const status = document.getElementById('status-bar');

  if (entries.length === 0) {
    container.innerHTML = `<div class="empty-state"><div class="big">🔍</div><p>Aucun résultat pour « ${escHtml(query)} »</p></div>`;
    status.textContent = 'Aucun résultat';
    return;
  }

  status.textContent = `${entries.length} résultat${entries.length > 1 ? 's' : ''}`;

  container.innerHTML = entries.map((e, i) => {
    const display = e.k[0] || e.r[0] || '';
    const reading = e.k[0] ? (e.r[0] || '') : '';
    const meaning = firstMeaning(e);
    return `<div class="result-item" onclick="showDetail(${i})">
      <div class="result-main">
        <span class="result-kanji">${escHtml(display)}</span>
        ${reading ? `<span class="result-reading">${escHtml(reading)}</span>` : ''}
      </div>
      <div class="result-meaning">${escHtml(meaning)}</div>
    </div>`;
  }).join('');
}

function firstMeaning(entry) {
  if (!entry.s || entry.s.length === 0) return '';
  const sense = entry.s[0];
  if (sense.fr.length > 0) return sense.fr.slice(0, 3).join(', ');
  return sense.en.slice(0, 3).join(', ');
}

function showDetail(index) {
  const entry = currentResults[index];
  if (!entry) return;

  const title = entry.k[0] || entry.r[0] || '';
  document.getElementById('detail-header-title').textContent = title;

  const allReadings = [...new Set([...entry.r])];
  const readingChips = allReadings.map(r => `<span class="reading-chip">${escHtml(r)}</span>`).join('');

  const sensesHtml = entry.s.map((sense, i) => {
    const posTags = (sense.p || []).map(p =>
      `<span class="pos-tag">${escHtml(POS_LABELS[p] || p)}</span>`
    ).join('');

    const frGlosses = sense.fr.map(g =>
      `<div class="gloss-fr"><span class="lang-badge">FR</span>${escHtml(g)}</div>`
    ).join('');

    const enGlosses = sense.en.map(g =>
      `<div class="gloss-en"><span class="lang-badge en">EN</span>${escHtml(g)}</div>`
    ).join('');

    return `<div class="sense-block">
      <div class="sense-num">Sens ${i + 1}</div>
      ${posTags ? `<div class="pos-tags">${posTags}</div>` : ''}
      ${frGlosses}
      ${enGlosses}
    </div>`;
  }).join('');

  document.getElementById('detail-body').innerHTML = `
    <div class="detail-writing">
      <div class="detail-kanji-big">${escHtml(entry.k[0] || entry.r[0] || '')}</div>
      <div class="detail-readings">${readingChips}</div>
      ${entry.k.length > 1 ? `<div style="margin-top:8px;color:#666;font-size:0.85rem">${entry.k.slice(1).map(k => escHtml(k)).join('　')}</div>` : ''}
    </div>
    ${sensesHtml}
  `;

  document.getElementById('detail-panel').classList.add('open');
  document.getElementById('detail-panel').scrollTop = 0;
}

function closeDetail() {
  document.getElementById('detail-panel').classList.remove('open');
}

// ── UI helpers ───────────────────────────────────────────────

function setLoading(msg, showProgress = false, pct = 0) {
  document.getElementById('loading-msg').textContent = msg;
  const pc = document.getElementById('progress-container');
  pc.style.display = showProgress ? 'block' : 'none';
  if (showProgress) updateProgress(pct, msg);
}

function updateProgress(pct, text) {
  document.getElementById('progress-fill').style.width = pct + '%';
  document.getElementById('progress-text').textContent = Math.round(pct) + '%';
}

function showApp() {
  document.getElementById('loading-overlay').style.display = 'none';
  document.getElementById('header').style.display = 'block';
  document.getElementById('status-bar').style.display = 'block';

  getMeta('count').then(count => {
    document.getElementById('status-bar').textContent =
      count ? `${parseInt(count).toLocaleString()} entrées — tapez pour chercher` : 'Tapez pour chercher';
  });

  document.getElementById('search-input').addEventListener('input', e => {
    const q = e.target.value.trim();
    document.getElementById('clear-btn').style.display = q ? 'block' : 'none';
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => search(q), 200);
  });
}

function clearSearch() {
  const input = document.getElementById('search-input');
  input.value = '';
  input.focus();
  document.getElementById('clear-btn').style.display = 'none';
  clearResults();
}

function clearResults() {
  document.getElementById('results').innerHTML = '';
  getMeta('count').then(count => {
    document.getElementById('status-bar').textContent =
      count ? `${parseInt(count).toLocaleString()} entrées — tapez pour chercher` : 'Tapez pour chercher';
  });
}

function setFilter(btn) {
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  searchMode = btn.dataset.mode;
  const q = document.getElementById('search-input').value.trim();
  if (q) search(q);
}

function escHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Init ─────────────────────────────────────────────────────

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./service-worker.js').catch(() => {});
}

loadDictionary().catch(err => {
  document.getElementById('loading-msg').textContent = 'Erreur : ' + err.message;
});
