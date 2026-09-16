// papers.js — past exam papers as pages the scanner can read.
//
// Climby's core skill is reading a picture of a page. A PDF page rendered to
// an image is a perfect photograph: flat, lit, sharp. So nothing about the AI
// path changes — the picker turns "the 2024 paper, page 3" into exactly what
// the camera would have produced, and hands it to the scanner through the same
// door the phone uses. The student then names the problem, as with a textbook.
//
// The PDFs come from our own backend, which mirrors the Ministry's files (they
// send no CORS headers). pdf.js does the rendering, loaded on first use.
const Papers = (() => {
  const $ = id => document.getElementById(id);
  const BACKEND = window.CLIMBY_BACKEND;
  const PDFJS = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js';
  const PDFJS_WORKER = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';

  let catalogue = null;
  let exam = null, subject = null;
  let docCache = {};        // paper id -> pdf.js document, so re-opening is instant
  let pdfReady = null;      // promise: pdf.js loaded and its worker wired

  function t(key, vars) { return window.t ? window.t(key, vars) : key; }
  function lang() { return window.I18n ? I18n.get() : 'en'; }
  function label(entry) { return (entry && entry.label && (entry.label[lang()] || entry.label.en)) || ''; }

  // pdf.js wants a Worker. The CSP allows workers only from our origin or a
  // blob, so the worker script is fetched as text and handed over as a blob
  // URL — the same code, from a source the policy accepts.
  function loadPdfJs() {
    if (pdfReady) return pdfReady;
    pdfReady = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = PDFJS;
      s.onload = async () => {
        try {
          const src = await fetch(PDFJS_WORKER).then(r => r.text());
          window.pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
          resolve(window.pdfjsLib);
        } catch (e) { reject(e); }
      };
      s.onerror = reject;
      document.head.appendChild(s);
    });
    return pdfReady;
  }

  async function loadCatalogue() {
    if (catalogue) return catalogue;
    const res = await fetch(BACKEND + '/papers');
    if (!res.ok) throw new Error('catalogue');
    catalogue = await res.json();
    return catalogue;
  }

  // ---------- the picker ----------

  function open() {
    $('entryStage').classList.add('hidden');
    $('paperPicker').classList.remove('hidden');
    $('paperPages').innerHTML = '';
    $('paperPages').classList.add('hidden');
    setStatus(t('papers.loading'));
    loadCatalogue().then(cat => {
      setStatus('');
      // Default to the exam with the most papers — today that is НВО 7 maths.
      const counts = {};
      cat.papers.forEach(p => { counts[p.exam] = (counts[p.exam] || 0) + 1; });
      exam = exam || Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
      renderTabs();
    }).catch(() => setStatus(t('papers.errCatalogue')));
  }

  function close() {
    $('paperPicker').classList.add('hidden');
    $('entryStage').classList.remove('hidden');
  }

  function setStatus(text) {
    const el = $('paperStatus');
    el.textContent = text;
    el.classList.toggle('hidden', !text);
  }

  function renderTabs() {
    const cat = catalogue;
    const exams = Object.keys(cat.exams).filter(e => cat.papers.some(p => p.exam === e));
    const tabs = $('paperExams');
    tabs.innerHTML = '';
    exams.forEach(e => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'paper-tab' + (e === exam ? ' is-active' : '');
      b.textContent = label(cat.exams[e]);
      b.setAttribute('aria-pressed', e === exam ? 'true' : 'false');
      b.addEventListener('click', () => { exam = e; subject = null; renderTabs(); });
      tabs.appendChild(b);
    });

    const subjects = Object.keys(cat.subjects).filter(s => cat.papers.some(p => p.exam === exam && p.subject === s));
    subject = subjects.includes(subject) ? subject : subjects[0];
    const chips = $('paperSubjects');
    chips.innerHTML = '';
    chips.classList.toggle('hidden', subjects.length < 2);
    subjects.forEach(s => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'paper-chip' + (s === subject ? ' is-active' : '');
      b.textContent = label(cat.subjects[s]);
      b.setAttribute('aria-pressed', s === subject ? 'true' : 'false');
      b.addEventListener('click', () => { subject = s; renderTabs(); });
      chips.appendChild(b);
    });

    renderYears();
  }

  function renderYears() {
    const grid = $('paperYears');
    grid.innerHTML = '';
    const rows = catalogue.papers
      .filter(p => p.exam === exam && p.subject === subject)
      .sort((a, b) => b.year - a.year);
    rows.forEach(p => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'paper-card';
      card.dataset.id = p.id;
      const year = document.createElement('span');
      year.className = 'paper-year';
      year.textContent = String(p.year);
      const meta = document.createElement('span');
      meta.className = 'paper-meta';
      meta.textContent = label(catalogue.exams[p.exam]) + ' · ' + label(catalogue.subjects[p.subject]);
      card.append(year, meta);
      card.addEventListener('click', () => openPaper(p, card));
      grid.appendChild(card);
    });
  }

  // ---------- one paper: its pages as thumbnails ----------

  async function getDoc(paper) {
    if (docCache[paper.id]) return docCache[paper.id];
    const lib = await loadPdfJs();
    const doc = await lib.getDocument({ url: BACKEND + '/papers/' + paper.id + '.pdf' }).promise;
    docCache[paper.id] = doc;
    return doc;
  }

  async function renderPage(doc, n, width) {
    const page = await doc.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: width / base.width });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    return canvas;
  }

  async function openPaper(paper, card) {
    document.querySelectorAll('.paper-card.is-active').forEach(c => c.classList.remove('is-active'));
    card.classList.add('is-active');
    const strip = $('paperPages');
    strip.innerHTML = '';
    strip.classList.remove('hidden');
    setStatus(t('papers.loadingPaper', { year: paper.year }));
    try {
      const doc = await getDoc(paper);
      setStatus('');
      // Thumbnails first, small and fast, so the strip appears at once; the
      // full-size render happens only for the page that is chosen.
      for (let n = 1; n <= doc.numPages; n++) {
        const slot = document.createElement('button');
        slot.type = 'button';
        slot.className = 'paper-page';
        slot.setAttribute('aria-label', t('papers.page', { n }));
        const num = document.createElement('span');
        num.className = 'paper-page-num';
        num.textContent = String(n);
        slot.appendChild(num);
        strip.appendChild(slot);
        slot.addEventListener('click', () => choosePage(paper, doc, n, slot));
        renderPage(doc, n, 180).then(c => { c.className = 'paper-thumb'; slot.insertBefore(c, num); });
      }
      strip.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (err) {
      setStatus(t('papers.errPaper'));
    }
  }

  async function choosePage(paper, doc, n, slot) {
    slot.classList.add('is-busy');
    try {
      // 1400px wide reads as a sharp photograph to the model; larger only costs.
      const canvas = await renderPage(doc, n, 1400);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
      close();
      if (window.Scanner) Scanner.acceptPhoto(dataUrl);
    } catch (err) {
      setStatus(t('papers.errPaper'));
    } finally {
      slot.classList.remove('is-busy');
    }
  }

  function init() {
    const btn = $('entryPaperBtn');
    if (!btn) return;
    btn.addEventListener('click', open);
    $('paperBack').addEventListener('click', close);
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !$('paperPicker').classList.contains('hidden')) close();
    });
    window.addEventListener('climby:lang-changed', () => { if (catalogue && !$('paperPicker').classList.contains('hidden')) renderTabs(); });
  }

  document.addEventListener('DOMContentLoaded', init);

  return { open, close };
})();

window.Papers = Papers;
