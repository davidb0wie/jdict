const DB_NAME = 'jdict';
const DB_VERSION = 1;
const DICT_VERSION = '3.6.2';

let db = null;
let frIndex = null;
let enIndex = null;
let searchMode = 'all';
let currentResults = [];
let searchTimeout = null;

const POS_LABELS = {
  'n':'nom','v1':'verbe ichidan','v5r':'verbe godan','v5k':'verbe godan','v5g':'verbe godan',
  'v5s':'verbe godan','v5t':'verbe godan','v5n':'verbe godan','v5b':'verbe godan',
  'v5m':'verbe godan','v5u':'verbe godan','vk':'verbe irrégulier','vs':'verbe suru',
  'adj-i':'adjectif -i','adj-na':'adjectif -na','adj-no':'adjectif -no','adv':'adverbe',
  'conj':'conjonction','int':'interjection','pn':'pronom','prt':'particule','exp':'expression',
  'aux':'auxiliaire','cop':'copule','pref':'préfixe','suf':'suffixe','num':'numéral','ctr':'compteur'
};

// ── Romaji → Hiragana ────────────────────────────────────────
const ROMAJI_MAP = [
  ['shi','し'],['chi','ち'],['tsu','つ'],['tchi','っち'],
  ['sha','しゃ'],['shu','しゅ'],['sho','しょ'],
  ['cha','ちゃ'],['chu','ちゅ'],['cho','ちょ'],
  ['dzu','づ'],['dzi','ぢ'],
  ['kya','きゃ'],['kyu','きゅ'],['kyo','きょ'],
  ['gya','ぎゃ'],['gyu','ぎゅ'],['gyo','ぎょ'],
  ['sha','しゃ'],['shu','しゅ'],['sho','しょ'],
  ['nya','にゃ'],['nyu','にゅ'],['nyo','にょ'],
  ['hya','ひゃ'],['hyu','ひゅ'],['hyo','ひょ'],
  ['bya','びゃ'],['byu','びゅ'],['byo','びょ'],
  ['pya','ぴゃ'],['pyu','ぴゅ'],['pyo','ぴょ'],
  ['mya','みゃ'],['myu','みゅ'],['myo','みょ'],
  ['rya','りゃ'],['ryu','りゅ'],['ryo','りょ'],
  ['ja','じゃ'],['ji','じ'],['ju','じゅ'],['jo','じょ'],
  ['ka','か'],['ki','き'],['ku','く'],['ke','け'],['ko','こ'],
  ['ga','が'],['gi','ぎ'],['gu','ぐ'],['ge','げ'],['go','ご'],
  ['sa','さ'],['si','し'],['su','す'],['se','せ'],['so','そ'],
  ['za','ざ'],['zi','じ'],['zu','ず'],['ze','ぜ'],['zo','ぞ'],
  ['ta','た'],['ti','ち'],['tu','つ'],['te','て'],['to','と'],
  ['da','だ'],['di','ぢ'],['du','づ'],['de','で'],['do','ど'],
  ['na','な'],['ni','に'],['nu','ぬ'],['ne','ね'],['no','の'],
  ['ha','は'],['hi','ひ'],['hu','ふ'],['he','へ'],['ho','ほ'],
  ['ba','ば'],['bi','び'],['bu','ぶ'],['be','べ'],['bo','ぼ'],
  ['pa','ぱ'],['pi','ぴ'],['pu','ぷ'],['pe','ぺ'],['po','ぽ'],
  ['fa','ふぁ'],['fi','ふぃ'],['fu','ふ'],['fe','ふぇ'],['fo','ふぉ'],
  ['ma','ま'],['mi','み'],['mu','む'],['me','め'],['mo','も'],
  ['ya','や'],['yu','ゆ'],['yo','よ'],
  ['ra','ら'],['ri','り'],['ru','る'],['re','れ'],['ro','ろ'],
  ['wa','わ'],['wi','ゐ'],['we','ゑ'],['wo','を'],
  ['a','あ'],['i','い'],['u','う'],['e','え'],['o','お'],
  ['n','ん']
];

function romajiToHiragana(str) {
  let s = str.toLowerCase().replace(/[- ]/g, '');
  // Double consonant → っ
  s = s.replace(/([bcdfghjklmnpqrstvwxyz])\1/g, 'っ$1');
  let result = '';
  let i = 0;
  while (i < s.length) {
    let matched = false;
    for (const [rom, hira] of ROMAJI_MAP) {
      if (s.startsWith(rom, i)) {
        result += hira;
        i += rom.length;
        matched = true;
        break;
      }
    }
    if (!matched) { result += s[i]; i++; }
  }
  return result;
}

function isLikelyRomaji(str) {
  return /^[a-zA-Z\s-]+$/.test(str) && str.length >= 2;
}

// ── IndexedDB ────────────────────────────────────────────────

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('entries')) {
        const store = d.createObjectStore('entries', { keyPath: 'id' });
        store.createIndex('kanji',   'k', { multiEntry: true });
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

function getEntriesByIds(ids) {
  return new Promise((resolve, reject) => {
    const results = [];
    const tx = db.transaction('entries', 'readonly');
    const store = tx.objectStore('entries');
    let pending = ids.length;
    if (!pending) { resolve([]); return; }
    ids.forEach(id => {
      const req = store.get(id);
      req.onsuccess = e => {
        if (e.target.result) results.push(e.target.result);
        if (--pending === 0) resolve(results);
      };
      req.onerror = () => { if (--pending === 0) resolve(results); };
    });
  });
}

// ── Chargement ───────────────────────────────────────────────

async function loadDictionary() {
  setLoading('Connexion à la base de données...');
  db = await openDB();

  const version = await getMeta('version');

  if (version !== DICT_VERSION) {
    setLoading('Téléchargement du dictionnaire (≈ 32 Mo)...', true, 0);
    const response = await fetch('./data/dictionary.json');
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
      if (total) updateProgress(received / total * 50, `Téléchargement: ${(received/1024/1024).toFixed(0)} Mo / ${(total/1024/1024).toFixed(0)} Mo`);
    }

    setLoading('Analyse...', true, 52);
    const text = await new Blob(chunks).text();
    const entries = JSON.parse(text);

    setLoading('Indexation en base locale...', true, 55);
    const BATCH = 2000;
    for (let i = 0; i < entries.length; i += BATCH) {
      await bulkInsert(entries.slice(i, i + BATCH));
      updateProgress(55 + (i / entries.length) * 43, `Indexation: ${i.toLocaleString()} / ${entries.length.toLocaleString()}`);
      await new Promise(r => setTimeout(r, 0));
    }

    await setMeta('version', DICT_VERSION);
    await setMeta('count', entries.length);
  }

  // Charger les index de sens en mémoire
  setLoading('Chargement des index de recherche...');
  const [frResp, enResp] = await Promise.all([
    fetch('./data/fr-index.json'),
    fetch('./data/en-index.json')
  ]);
  frIndex = await frResp.json();
  enIndex = await enResp.json();

  showApp();
}

// ── Recherche ────────────────────────────────────────────────

function search(query) {
  const q = query.trim();
  if (!q) { clearResults(); return; }

  const isJapanese = /[　-鿿＀-￯]/.test(q);

  if (isJapanese || searchMode === 'ja') {
    searchJapanese(q);
  } else if (searchMode === 'fr') {
    searchByIndex(q, frIndex);
  } else if (searchMode === 'en') {
    searchByIndex(q, enIndex);
  } else {
    // Mode "tout" : essaie romaji puis FR+EN
    if (isLikelyRomaji(q)) {
      const hira = romajiToHiragana(q);
      if (/[ぁ-ゖ]/.test(hira)) {
        searchJapanese(hira);
        return;
      }
    }
    searchByIndexBoth(q);
  }
}

function searchJapanese(query) {
  const results = [];
  const seen = new Set();

  const tx1 = db.transaction('entries', 'readonly');
  const idx1 = tx1.objectStore('entries').index('kanji');
  const req1 = idx1.openCursor(IDBKeyRange.bound(query, query + '￿'));

  req1.onsuccess = e => {
    const cursor = e.target.result;
    if (cursor && results.length < 150) {
      if (!seen.has(cursor.value.id)) { seen.add(cursor.value.id); results.push(cursor.value); }
      cursor.continue();
    } else {
      const tx2 = db.transaction('entries', 'readonly');
      const idx2 = tx2.objectStore('entries').index('reading');
      const req2 = idx2.openCursor(IDBKeyRange.bound(query, query + '￿'));
      req2.onsuccess = e2 => {
        const c2 = e2.target.result;
        if (c2 && results.length < 200) {
          if (!seen.has(c2.value.id)) { seen.add(c2.value.id); results.push(c2.value); }
          c2.continue();
        } else {
          displayResults(results, query);
        }
      };
    }
  };
}

function searchByIndex(query, idx) {
  const q = query.toLowerCase();
  const ids = idx[q] || [];
  // Cherche aussi les mots qui commencent par q
  if (ids.length === 0) {
    const partialIds = [];
    for (const word of Object.keys(idx)) {
      if (word.startsWith(q) && partialIds.length < 50) {
        partialIds.push(...idx[word]);
      }
    }
    const uniqueIds = [...new Set(partialIds)].slice(0, 50);
    getEntriesByIds(uniqueIds).then(entries => displayResults(entries, query));
    return;
  }
  getEntriesByIds(ids.slice(0, 50)).then(entries => displayResults(entries, query));
}

function searchByIndexBoth(query) {
  const q = query.toLowerCase();
  const frIds = new Set(frIndex[q] || []);
  const enIds = new Set(enIndex[q] || []);

  // Cherche aussi partiellement
  if (frIds.size === 0 && enIds.size === 0) {
    for (const word of Object.keys(frIndex)) {
      if (word.startsWith(q)) for (const id of frIndex[word]) frIds.add(id);
      if (frIds.size >= 50) break;
    }
    for (const word of Object.keys(enIndex)) {
      if (word.startsWith(q)) for (const id of enIndex[word]) enIds.add(id);
      if (enIds.size >= 50) break;
    }
  }

  // FR en priorité, puis EN
  const combined = [...frIds];
  for (const id of enIds) { if (!frIds.has(id)) combined.push(id); }
  getEntriesByIds(combined.slice(0, 50)).then(entries => displayResults(entries, query));
}

// ── Affichage ────────────────────────────────────────────────

function displayResults(entries, query) {
  currentResults = entries;
  const container = document.getElementById('results');
  const status = document.getElementById('status-bar');

  if (!entries || entries.length === 0) {
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
  if (!entry.s || !entry.s.length) return '';
  const sense = entry.s[0];
  if (sense.fr && sense.fr.length) return sense.fr.slice(0, 3).join(', ');
  return (sense.en || []).slice(0, 3).join(', ');
}

function showDetail(index) {
  const entry = currentResults[index];
  if (!entry) return;

  const title = entry.k[0] || entry.r[0] || '';
  document.getElementById('detail-header-title').textContent = title;

  const readingChips = [...new Set(entry.r)].map(r => `<span class="reading-chip">${escHtml(r)}</span>`).join('');

  const sensesHtml = entry.s.map((sense, i) => {
    const posTags = (sense.p || []).map(p => `<span class="pos-tag">${escHtml(POS_LABELS[p] || p)}</span>`).join('');
    const frGlosses = (sense.fr || []).map(g => `<div class="gloss-fr"><span class="lang-badge">FR</span>${escHtml(g)}</div>`).join('');
    const enGlosses = (sense.en || []).map(g => `<div class="gloss-en"><span class="lang-badge en">EN</span>${escHtml(g)}</div>`).join('');
    return `<div class="sense-block">
      <div class="sense-num">Sens ${i + 1}</div>
      ${posTags ? `<div class="pos-tags">${posTags}</div>` : ''}
      ${frGlosses}${enGlosses}
    </div>`;
  }).join('');

  document.getElementById('detail-body').innerHTML = `
    <div class="detail-writing">
      <div class="detail-kanji-big">${escHtml(entry.k[0] || entry.r[0] || '')}</div>
      <div class="detail-readings">${readingChips}</div>
      ${entry.k.length > 1 ? `<div style="margin-top:8px;color:#666;font-size:0.85rem">${entry.k.slice(1).map(k => escHtml(k)).join('　')}</div>` : ''}
    </div>
    ${sensesHtml}`;

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
  if (showProgress) updateProgress(pct, '');
}

function updateProgress(pct, text) {
  document.getElementById('progress-fill').style.width = pct + '%';
  document.getElementById('progress-text').textContent = text || (Math.round(pct) + '%');
}

function showApp() {
  document.getElementById('loading-overlay').style.display = 'none';
  document.getElementById('header').style.display = 'block';
  document.getElementById('status-bar').style.display = 'block';

  getMeta('count').then(count => {
    document.getElementById('status-bar').textContent =
      count ? `${parseInt(count).toLocaleString()} entrées • japonais, romaji, français, anglais` : 'Prêt';
  });

  document.getElementById('search-input').addEventListener('input', e => {
    const q = e.target.value.trim();
    document.getElementById('clear-btn').style.display = q ? 'block' : 'none';
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => search(q), 200);
  });

  document.getElementById('search-input').focus();
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
      count ? `${parseInt(count).toLocaleString()} entrées • japonais, romaji, français, anglais` : 'Prêt';
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
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Init ─────────────────────────────────────────────────────

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./service-worker.js').catch(() => {});
}

loadDictionary().catch(err => {
  document.getElementById('loading-msg').textContent = 'Erreur : ' + err.message;
  console.error(err);
});
