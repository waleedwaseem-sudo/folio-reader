/* Folio: a light EPUB reader. Books live in IndexedDB on this device. */
(() => {
  "use strict";

  const $ = (s, r = document) => r.querySelector(s);
  const FONT_CSS = "https://fonts.googleapis.com/css2?family=Literata:ital,opsz,wght@0,7..72,400..700;1,7..72,400..700&display=swap";
  const THEMES = {
    white: { page: "#FFFFFF", ink: "#1C1D1F", link: "#2F5D8C" },
    paper: { page: "#F4EEE1", ink: "#3A3227", link: "#6B4E1F" },
    night: { page: "#141516", ink: "#C9C6BF", link: "#8DB0D6" },
  };
  const FONTS = {
    literata: '"Literata", ui-serif, Georgia, serif',
    newyork: 'ui-serif, "New York", Georgia, serif',
    book: null,
  };

  /* ---------- Storage ---------- */
  const store = {
    get(k, d) { try { const v = localStorage.getItem("folio:" + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem("folio:" + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  };

  let dbp;
  function db() {
    if (!dbp) {
      dbp = new Promise((res, rej) => {
        const req = indexedDB.open("folio", 1);
        req.onupgradeneeded = () => {
          const d = req.result;
          d.createObjectStore("books", { keyPath: "id" });
          d.createObjectStore("files");
        };
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
      });
    }
    return dbp;
  }
  async function tx(storeName, mode, fn) {
    const d = await db();
    return new Promise((res, rej) => {
      const t = d.transaction(storeName, mode);
      const s = t.objectStore(storeName);
      let out;
      const r = fn(s);
      if (r && "onsuccess" in r) r.onsuccess = () => { out = r.result; };
      t.oncomplete = () => res(out);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error || new Error("Storage write was cancelled"));
    });
  }
  const books = {
    all: () => tx("books", "readonly", (s) => s.getAll()),
    get: (id) => tx("books", "readonly", (s) => s.get(id)),
    put: (b) => tx("books", "readwrite", (s) => s.put(b)),
    del: (id) => tx("books", "readwrite", (s) => s.delete(id)),
  };
  const files = {
    get: (id) => tx("files", "readonly", (s) => s.get(id)),
    put: (id, buf) => tx("files", "readwrite", (s) => s.put(buf, id)),
    del: (id) => tx("files", "readwrite", (s) => s.delete(id)),
  };
  async function patchBook(id, patch) {
    const b = await books.get(id);
    if (b) await books.put(Object.assign(b, patch));
  }

  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

  /* ---------- Library ---------- */
  const grid = $("#grid");
  const empty = $("#empty");
  const editBtn = $("#editBtn");
  const libError = $("#libError");
  let editing = false;
  const coverUrls = new Map();

  function showSkeleton() {
    grid.innerHTML = Array.from({ length: 6 }, () =>
      `<div class="book" aria-hidden="true"><div class="sk sk-cover"></div><div class="sk sk-line w80"></div><div class="sk sk-line w60"></div></div>`
    ).join("");
  }

  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  async function renderLibrary() {
    let list;
    try {
      list = await books.all();
    } catch (e) {
      grid.innerHTML = "";
      showLibError("Your library couldn't be opened. Close Folio fully and open it again.");
      return;
    }
    list.sort((a, b) => (b.lastOpened || b.addedAt) - (a.lastOpened || a.addedAt));
    empty.hidden = list.length > 0;
    editBtn.hidden = list.length === 0;
    if (!list.length) { editing = false; editBtn.textContent = "Edit"; }

    coverUrls.forEach((u) => URL.revokeObjectURL(u));
    coverUrls.clear();

    grid.innerHTML = list.map((b) => {
      let cover;
      if (b.cover) {
        const url = URL.createObjectURL(b.cover);
        coverUrls.set(b.id, url);
        cover = `<img src="${url}" alt="" loading="lazy">`;
      } else {
        cover = `<div class="cover-blank"><strong>${esc(b.title)}</strong><span>${esc(b.author)}</span></div>`;
      }
      const pct = Math.round((b.pct || 0) * 100);
      const progress = b.lastOpened
        ? `<div class="book-progress"><div class="bar"><div class="bar-fill" style="transform:scaleX(${(b.pct || 0).toFixed(3)})"></div></div><span>${pct}%</span></div>`
        : `<div class="book-progress"><span>New</span></div>`;
      return `<article class="book" data-id="${b.id}">
        <button class="book-open" type="button" aria-label="Read ${esc(b.title)}">
          <div class="cover">${cover}</div>
          <span class="book-title">${esc(b.title)}</span>
          <span class="book-author">${esc(b.author || "Unknown author")}</span>
        </button>
        ${progress}
        <button class="book-delete" type="button" aria-label="Remove ${esc(b.title)}" ${editing ? "" : "hidden"}><span><svg class="ic"><use href="#i-trash"/></svg></span></button>
      </article>`;
    }).join("");
  }

  function showLibError(msg) {
    libError.textContent = msg;
    libError.hidden = !msg;
  }

  grid.addEventListener("click", async (e) => {
    const card = e.target.closest(".book");
    if (!card) return;
    const id = card.dataset.id;
    if (e.target.closest(".book-delete")) {
      const b = await books.get(id);
      if (!b) return;
      const msg = b.driveId
        ? `Remove “${b.title}” from this device? It stays in your Google Drive and won't download here again.`
        : `Remove “${b.title}” from this device? Your reading position goes with it.`;
      if (!confirm(msg)) return;
      if (b.driveId) Sync.ignore(b.driveId);
      await files.del(id);
      await files.del(id + ":pdf");
      await books.del(id);
      renderLibrary();
      return;
    }
    if (e.target.closest(".book-open") && !editing) openBook(id);
  });

  editBtn.addEventListener("click", () => {
    editing = !editing;
    editBtn.textContent = editing ? "Done" : "Edit";
    grid.querySelectorAll(".book-delete").forEach((b) => (b.hidden = !editing));
  });

  /* ---------- Import ---------- */
  const importing = $("#importing");
  const importingText = $("#importingText");
  const importingBar = $("#importingBar");

  function onPick(e) {
    const list = Array.from(e.target.files || []);
    e.target.value = "";
    if (list.length) importFiles(list);
  }
  $("#fileInput").addEventListener("change", onPick);
  document.querySelectorAll(".fileInputAlt").forEach((i) => i.addEventListener("change", onPick));

  async function importFiles(list) {
    showLibError("");
    const failed = [];
    importing.hidden = false;
    for (let i = 0; i < list.length; i++) {
      const base = list.length > 1 ? `Adding book ${i + 1} of ${list.length}` : "Adding book";
      importingText.textContent = base + "…";
      importingBar.style.transform = `scaleX(${i / list.length})`;
      try {
        await importAny(await list[i].arrayBuffer(), list[i].name, {}, (done, total) => {
          importingText.textContent = `${base}: optimising PDF for reading, page ${Math.min(done + 1, total)} of ${total}…`;
          importingBar.style.transform = `scaleX(${(i + done / total) / list.length})`;
        });
      } catch (err) {
        console.warn(err);
        failed.push({ name: list[i].name, why: err && err.userMessage });
      }
    }
    importingBar.style.transform = "scaleX(1)";
    importing.hidden = true;
    importingBar.style.transform = "scaleX(0)";
    if (failed.length) showLibError(failMessage(failed));
    renderLibrary();
  }

  function failMessage(failed) {
    if (failed.length === 1) {
      const f = failed[0];
      return f.why
        ? `“${f.name}” ${f.why}, so it couldn't be added.`
        : `“${f.name}” couldn't be opened. Choose an EPUB or PDF that isn't DRM-protected.`;
    }
    return `${failed.length} files couldn't be opened: ${failed.map((f) => f.name).join(", ")}. Choose EPUBs or PDFs that aren't DRM- or password-protected.`;
  }

  const isPdf = (buf) => { const s = new Uint8Array(buf, 0, Math.min(1024, buf.byteLength)); for (let i = 0; i < s.length - 4; i++) if (s[i] === 0x25 && s[i + 1] === 0x50 && s[i + 2] === 0x44 && s[i + 3] === 0x46) return true; return false; };

  // EPUBs are stored as they are; PDFs are converted to a reflowable book first.
  async function importAny(buf, name, extra = {}, onProgress) {
    const sig = new Uint8Array(buf, 0, 2);
    if (sig[0] === 0x50 && sig[1] === 0x4b) return importBuffer(buf, name, extra);
    if (isPdf(buf)) {
      const epub = await window.FolioPDF.convert(buf, name, onProgress);
      return importBuffer(epub, name.replace(/\.pdf$/i, ".epub"), { ...extra, source: "pdf", convVer: window.FolioPDF.VERSION }, buf);
    }
    throw Object.assign(new Error("Unsupported file"), { userMessage: "isn't an EPUB or PDF" });
  }

  async function importBuffer(buf, name, extra = {}, srcPdf = null) {
    const file = { name };
    const sig = new Uint8Array(buf, 0, 4);
    if (sig[0] !== 0x50 || sig[1] !== 0x4b) throw new Error("Not a zip/EPUB file");

    const book = ePub(buf);
    try {
      await book.ready;
      const md = book.packaging.metadata || {};
      let cover = null;
      try {
        const url = await book.coverUrl();
        if (url) cover = await (await fetch(url)).blob();
      } catch { /* no cover */ }

      const id = uid();
      await files.put(id, buf);
      if (srcPdf) await files.put(id + ":pdf", srcPdf);
      await books.put({
        id,
        title: (md.title || file.name.replace(/\.epub$/i, "")).trim(),
        author: (md.creator || "").trim(),
        cover,
        size: buf.byteLength,
        addedAt: Date.now(),
        lastOpened: 0,
        cfi: null,
        pct: 0,
        posAt: 0,
        locations: null,
        ...extra,
      });
    } finally {
      book.destroy();
    }
  }

  /* ---------- Reader ---------- */
  const readerEl = $("#reader");
  const viewer = $("#viewer");
  const chrome = $("#chrome");
  const scrim = $("#scrim");
  const tocSheet = $("#tocSheet");
  const typeSheet = $("#typeSheet");
  const scrub = $("#scrub");
  const scrubLabel = $("#scrubLabel");
  const footChapter = $("#footChapter");
  const footPct = $("#footPct");
  const readerLoading = $("#readerLoading");
  const readerError = $("#readerError");

  const settings = Object.assign(
    { size: 100, font: "literata", spacing: "1.6", theme: "white", margin: "normal", align: "left", bold: false, autoNight: true, footer: "pct" },
    store.get("settings", {})
  );

  let cur = null; // { id, book, rendition, toc, location }

  const MARGINS = { narrow: 16, normal: 24, wide: 40 };
  const darkMQ = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  // Like Apple Books' auto-night theme: follow the phone's dark mode unless turned off.
  const themeName = () => (settings.autoNight && darkMQ && darkMQ.matches ? "night" : settings.theme);
  if (darkMQ && darkMQ.addEventListener) darkMQ.addEventListener("change", () => applySettings({ relayout: false }));

  function readerCss() {
    const t = THEMES[themeName()];
    const ff = FONTS[settings.font];
    const weight = settings.bold ? 500 : 400;
    const align = settings.align === "justify"
      ? "p, li, dd, blockquote { text-align: justify !important; }"
      : "p:not([class*=center]):not([style*=center]):not([align]), li, dd { text-align: left !important; }";
    return `
      html, body { background: transparent !important; color: ${t.ink} !important; }
      body { font-size: ${settings.size}% !important; -webkit-text-size-adjust: 100%; }
      body *:not(img):not(svg):not(image) { color: inherit !important; background-color: transparent !important; border-color: currentColor; }
      p, li, blockquote, dd, dt, div, span { line-height: ${settings.spacing} !important; }
      ${ff ? `body, p, div, span, li, blockquote, h1, h2, h3, h4, h5, h6, em, i, b, strong, a { font-family: ${ff} !important; }` : ""}
      a, a * { color: ${t.link} !important; }
      img, svg, image { max-width: 100%; height: auto; }
      p, li, blockquote, dd { -webkit-hyphens: auto; hyphens: auto; widows: 2; orphans: 2; overflow-wrap: break-word; }
      h1, h2, h3, h4 { -webkit-hyphens: manual; hyphens: manual; text-wrap: balance; break-after: avoid; }
      pre, code { white-space: pre-wrap !important; overflow-wrap: anywhere; }
      table { max-width: 100% !important; }
      ${align}
      body, body *:not(b):not(strong):not(h1):not(h2):not(h3):not(h4):not(h5):not(h6):not(th) { font-weight: ${weight} !important; }
      ${settings.bold ? "b, strong, h1, h2, h3, h4, h5, h6, th { font-weight: 700 !important; }" : ""}
      ::selection { background: rgba(127,127,127,0.3); }
    `;
  }

  function styleContents(contents) {
    const doc = contents.document;
    if (!doc) return;
    if (!doc.getElementById("folio-font")) {
      const link = doc.createElement("link");
      link.id = "folio-font";
      link.rel = "stylesheet";
      link.href = FONT_CSS;
      doc.head.appendChild(link);
    }
    let st = doc.getElementById("folio-style");
    if (!st) {
      st = doc.createElement("style");
      st.id = "folio-style";
      doc.head.appendChild(st);
    }
    st.textContent = readerCss();
  }

  function applySettings({ relayout = true } = {}) {
    store.set("settings", settings);
    readerEl.dataset.theme = themeName();
    readerEl.style.setProperty("--margin", MARGINS[settings.margin] + "px");
    if (!readerEl.hidden) setThemeColor(THEMES[themeName()].page);
    $("#boldToggle").setAttribute("aria-checked", String(!!settings.bold));
    $("#autoNightToggle").setAttribute("aria-checked", String(!!settings.autoNight));
    $("#sizeOut").textContent = settings.size + "%";
    $("#sizeDown").disabled = settings.size <= 70;
    $("#sizeUp").disabled = settings.size >= 200;
    document.querySelectorAll(".seg").forEach((seg) => {
      const val = String(settings[seg.dataset.key]);
      seg.querySelectorAll("button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.value === val)));
    });
    if (cur && cur.rendition) {
      const cfi = cur.location && cur.location.start.cfi;
      cur.rendition.getContents().forEach(styleContents);
      if (relayout) {
        clearTimeout(applySettings.t);
        applySettings.t = setTimeout(() => {
          try { cur && cur.rendition.resize(); } catch { /* ignore */ }
          if (cur && cfi) cur.rendition.display(cfi).catch(() => {});
        }, 60);
      }
    }
  }

  function setThemeColor(c) {
    $('meta[name="theme-color"]').setAttribute("content", c);
  }

  async function openBook(id) {
    const meta = await books.get(id);
    if (!meta) return;
    document.body.classList.add("reading");
    $("#library").hidden = true;
    readerEl.hidden = false;
    readerError.hidden = true;
    readerLoading.hidden = false;
    footChapter.textContent = "";
    footPct.textContent = "";
    $("#bookTitle").textContent = meta.title;
    hideChrome();
    applySettings({ relayout: false });

    try {
      let buf = await files.get(id);
      if (!buf) throw new Error("Book file missing");
      if (meta.source === "pdf" && (meta.convVer || 1) < window.FolioPDF.VERSION) {
        const src = await files.get(id + ":pdf");
        if (src) {
          try {
            buf = await window.FolioPDF.convert(src, meta.title + ".pdf");
            await files.put(id, buf);
            await patchBook(id, { convVer: window.FolioPDF.VERSION, locations: null });
            meta.locations = null;
          } catch (e) { console.warn("Re-conversion failed; using the earlier version", e); }
        }
      }
      const book = ePub(buf);
      await book.ready;
      const rendition = book.renderTo(viewer, {
        width: "100%",
        height: "100%",
        flow: "paginated",
        spread: "none",
        allowScriptedContent: false,
      });
      cur = { id, book, rendition, toc: [], location: null };
      rendition.hooks.content.register(styleContents);
      rendition.on("relocated", onRelocated);

      try {
        await rendition.display(meta.cfi || undefined);
      } catch {
        await rendition.display();
      }
      readerLoading.hidden = true;
      patchBook(id, { lastOpened: Date.now() });

      const nav = await book.loaded.navigation;
      cur.toc = flattenToc(nav.toc || [], book);
      updateFooter();

      // Page count for percentages: cached per book after the first open.
      if (meta.locations) {
        book.locations.load(meta.locations);
        locationsReady();
      } else {
        scrubLabel.textContent = "Working out pages…";
        book.locations.generate(1200).then(() => {
          if (!cur || cur.book !== book) return;
          patchBook(id, { locations: book.locations.save() });
          locationsReady();
        }).catch(() => {});
      }
    } catch (err) {
      console.error(err);
      readerLoading.hidden = true;
      readerError.textContent = "This book couldn't be opened. The file may be damaged or DRM-protected. Go back and try adding it again.";
      readerError.hidden = false;
      showChrome();
    }
  }

  function locationsReady() {
    if (!cur) return;
    scrub.disabled = false;
    const loc = cur.rendition.currentLocation();
    if (loc && loc.start) onRelocated(loc);
  }

  function flattenToc(items, book, level = 0, out = []) {
    for (const it of items) {
      const href = (it.href || "").split("#")[0];
      const sec = book.spine.get(href);
      out.push({ label: (it.label || "").trim(), href: it.href, level, index: sec ? sec.index : -1 });
      if (it.subitems && it.subitems.length) flattenToc(it.subitems, book, level + 1, out);
    }
    return out;
  }

  function currentChapter() {
    if (!cur || !cur.location) return null;
    const idx = cur.location.start.index;
    let best = null;
    for (const t of cur.toc) if (t.index > -1 && t.index <= idx && (!best || t.index >= best.index)) best = t;
    return best;
  }

  /* Reading speed, learnt from how long you spend on each page (like Kindle's time-left estimates). */
  const speed = Object.assign({ secsPerPage: 45, samples: 0 }, store.get("speed", {}));
  let lastTurn = null;
  function learnSpeed(loc) {
    const now = Date.now();
    const d = loc.start.displayed;
    if (lastTurn && d && lastTurn.href === loc.start.href && d.page === lastTurn.page + 1) {
      const secs = (now - lastTurn.t) / 1000;
      if (secs > 3 && secs < 300) {
        const w = speed.samples < 10 ? 1 / (speed.samples + 1) : 0.1;
        speed.secsPerPage = speed.secsPerPage * (1 - w) + secs * w;
        speed.samples++;
        store.set("speed", speed);
      }
    }
    lastTurn = d ? { t: now, page: d.page, href: loc.start.href } : null;
  }

  function locationCounts() {
    if (cur.locCounts || !cur.book.locations.length()) return cur.locCounts;
    const counts = new Map();
    for (const c of cur.book.locations._locations || []) {
      const m = /^epubcfi\(\/6\/(\d+)/.exec(c);
      if (m) counts.set(+m[1], (counts.get(+m[1]) || 0) + 1);
    }
    cur.locCounts = counts;
    return counts;
  }

  function fmtTime(secs, where) {
    const m = Math.round(secs / 60);
    if (m < 1) return `Less than a minute left in ${where}`;
    if (m < 60) return `${m} min left in ${where}`;
    const h = Math.floor(m / 60), mm = m % 60;
    return `${h} h${mm ? ` ${mm} min` : ""} left in ${where}`;
  }

  function timeLeft(loc, scope) {
    const d = loc.start.displayed;
    if (!d) return "";
    const pagesInChapter = Math.max(0, d.total - d.page);
    if (scope === "chapter") return fmtTime((pagesInChapter + 1) * speed.secsPerPage, "chapter");
    const counts = locationCounts();
    const m = /^epubcfi\(\/6\/(\d+)/.exec(loc.start.cfi);
    if (!counts || !m) return "";
    const here = +m[1];
    const pagesPerLoc = d.total / Math.max(1, counts.get(here) || 1);
    let after = 0;
    counts.forEach((n, k) => { if (k > here) after += n; });
    return fmtTime((pagesInChapter + 1 + after * pagesPerLoc) * speed.secsPerPage, "book");
  }

  const FOOTER_MODES = ["pct", "chapter", "book", "none"];
  function footerText(pct) {
    const loc = cur && cur.location;
    if (!loc) return "";
    switch (settings.footer) {
      case "chapter": return timeLeft(loc, "chapter");
      case "book": return cur.book.locations.length() ? timeLeft(loc, "book") : "Working out time left…";
      case "none": return "";
      default: return pct != null ? Math.round(pct * 100) + "%" : "";
    }
  }

  function onRelocated(loc) {
    if (!cur) return;
    cur.location = loc;
    learnSpeed(loc);
    const ready = cur.book.locations.length() > 0;
    const pct = ready ? cur.book.locations.percentageFromCfi(loc.start.cfi) : null;
    updateFooter(pct);
    const patch = { cfi: loc.start.cfi, lastOpened: Date.now(), posAt: Date.now() };
    if (pct != null) patch.pct = loc.atEnd ? 1 : pct;
    clearTimeout(onRelocated.t);
    const id = cur.id;
    onRelocated.t = setTimeout(() => patchBook(id, patch), 400);
  }

  function updateFooter(pct) {
    const ch = currentChapter();
    footChapter.textContent = ch ? ch.label : "";
    const loc = cur && cur.location;
    if (pct == null && cur && cur.book.locations.length() > 0 && loc) pct = cur.book.locations.percentageFromCfi(loc.start.cfi);
    if (loc && loc.atEnd) pct = 1;
    footPct.textContent = footerText(pct);
    if (pct != null && !scrub.matches(":active")) scrub.value = Math.round(pct * 1000);

    let left = "";
    if (loc && loc.start.displayed) {
      const n = loc.start.displayed.total - loc.start.displayed.page;
      left = n <= 0 ? "Last page in chapter" : n === 1 ? "1 page left in chapter" : `${n} pages left in chapter`;
    }
    if (pct != null) scrubLabel.textContent = `${Math.round(pct * 100)}% read${left ? ", " + left.charAt(0).toLowerCase() + left.slice(1) : ""}`;
    else if (left) scrubLabel.textContent = left;
  }

  async function closeBook() {
    hideSheets();
    hideChrome();
    if (cur) {
      clearTimeout(onRelocated.t);
      const { id, location, book } = cur;
      if (location) {
        const patch = { cfi: location.start.cfi, lastOpened: Date.now(), posAt: Date.now() };
        if (book.locations.length() > 0) patch.pct = location.atEnd ? 1 : book.locations.percentageFromCfi(location.start.cfi);
        await patchBook(id, patch);
        Sync.pushPositions();
      }
      try { cur.rendition.destroy(); } catch { /* ignore */ }
      try { book.destroy(); } catch { /* ignore */ }
      cur = null;
    }
    viewer.innerHTML = "";
    scrub.disabled = true;
    readerEl.hidden = true;
    document.body.classList.remove("reading");
    $("#library").hidden = false;
    setThemeColor(getComputedStyle(document.body).backgroundColor);
    renderLibrary();
  }

  /* ---------- Page turning ---------- */
  const next = () => cur && cur.rendition && cur.rendition.next();
  const prev = () => cur && cur.rendition && cur.rendition.prev();

  const tap = $("#tapLayer");
  let start = null;
  tap.addEventListener("pointerdown", (e) => { start = { x: e.clientX, y: e.clientY, t: Date.now() }; });
  tap.addEventListener("pointercancel", () => { start = null; });
  tap.addEventListener("pointerup", (e) => {
    if (!start) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    const dt = Date.now() - start.t;
    start = null;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.2 && dt < 800) {
      if (!chrome.hidden) hideChrome();
      dx < 0 ? next() : prev();
      return;
    }
    if (Math.abs(dx) > 12 || Math.abs(dy) > 12) return;
    if (!chrome.hidden) { hideChrome(); return; }
    const rect = tap.getBoundingClientRect();
    if (e.clientY > rect.bottom - 56 && cur && cur.location) {
      // Tap the bottom line to cycle progress: percent, time left in chapter, time left in book, nothing.
      settings.footer = FOOTER_MODES[(FOOTER_MODES.indexOf(settings.footer) + 1) % FOOTER_MODES.length];
      store.set("settings", settings);
      updateFooter();
      return;
    }
    const w = tap.clientWidth;
    const x = e.clientX - rect.left;
    if (x < w * 0.3) prev();
    else if (x > w * 0.7) next();
    else showChrome();
  });

  document.addEventListener("keydown", (e) => {
    if (readerEl.hidden) return;
    if (e.key === "Escape") { if (!tocSheet.hidden || !typeSheet.hidden) hideSheets(); else if (!chrome.hidden) hideChrome(); return; }
    if (!tocSheet.hidden || !typeSheet.hidden) return;
    if (e.key === "ArrowRight" || e.key === " " || e.key === "PageDown") { e.preventDefault(); next(); }
    if (e.key === "ArrowLeft" || e.key === "PageUp") { e.preventDefault(); prev(); }
  });

  function showChrome() { chrome.hidden = false; readerEl.classList.add("chrome-on"); }
  function hideChrome() { chrome.hidden = true; readerEl.classList.remove("chrome-on"); }

  /* ---------- Sheets ---------- */
  function openSheet(sheet) {
    hideSheets();
    scrim.hidden = false;
    sheet.hidden = false;
    const focusEl = sheet.querySelector('[aria-current="true"]') || sheet.querySelector(".sheet-close");
    focusEl && focusEl.focus({ preventScroll: false });
  }
  function hideSheets() {
    scrim.hidden = true;
    tocSheet.hidden = true;
    typeSheet.hidden = true;
  }
  scrim.addEventListener("click", hideSheets);
  document.querySelectorAll(".sheet-close").forEach((b) => b.addEventListener("click", hideSheets));

  $("#closeBook").addEventListener("click", closeBook);
  $("#typeBtn").addEventListener("click", () => openSheet(typeSheet));
  $("#tocBtn").addEventListener("click", () => {
    const list = $("#tocList");
    const ch = currentChapter();
    if (!cur || !cur.toc.length) {
      list.innerHTML = `<li><p class="setting-label" style="padding:8px">This book doesn't include a table of contents.</p></li>`;
    } else {
      list.innerHTML = cur.toc.map((t, i) =>
        `<li class="lvl-${Math.min(t.level, 2)}"><button type="button" data-i="${i}" ${ch === t ? 'aria-current="true"' : ""}>${esc(t.label)}</button></li>`
      ).join("");
    }
    openSheet(tocSheet);
    const curBtn = list.querySelector('[aria-current="true"]');
    if (curBtn) curBtn.scrollIntoView({ block: "center" });
  });
  $("#tocList").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-i]");
    if (!b || !cur) return;
    const t = cur.toc[+b.dataset.i];
    hideSheets();
    hideChrome();
    cur.rendition.display(t.href).catch(() => {});
  });

  $("#sizeDown").addEventListener("click", () => { settings.size = Math.max(70, settings.size - 10); applySettings(); });
  $("#sizeUp").addEventListener("click", () => { settings.size = Math.min(200, settings.size + 10); applySettings(); });
  document.querySelectorAll(".seg").forEach((seg) => {
    seg.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-value]");
      if (!b) return;
      const key = seg.dataset.key;
      settings[key] = b.dataset.value;
      applySettings({ relayout: key !== "theme" });
    });
  });
  document.querySelectorAll(".switch").forEach((sw) => {
    sw.addEventListener("click", () => {
      const key = sw.dataset.key;
      settings[key] = !settings[key];
      applySettings({ relayout: key === "bold" });
    });
  });

  scrub.addEventListener("input", () => {
    const p = scrub.value / 1000;
    scrubLabel.textContent = `Go to ${Math.round(p * 100)}%`;
  });
  scrub.addEventListener("change", () => {
    if (!cur || !cur.book.locations.length()) return;
    const cfi = cur.book.locations.cfiFromPercentage(scrub.value / 1000);
    if (cfi) cur.rendition.display(cfi).catch(() => {});
  });

  let rt;
  window.addEventListener("resize", () => {
    if (!cur) return;
    clearTimeout(rt);
    rt = setTimeout(() => {
      const cfi = cur && cur.location && cur.location.start.cfi;
      try { cur.rendition.resize(); } catch { /* ignore */ }
      if (cfi) cur.rendition.display(cfi).catch(() => {});
    }, 200);
  });

  // Save position when the app is backgrounded (iOS may kill it without warning).
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && cur && cur.location) {
      clearTimeout(onRelocated.t);
      const patch = { cfi: cur.location.start.cfi, lastOpened: Date.now(), posAt: Date.now() };
      if (cur.book.locations.length() > 0) patch.pct = cur.book.locations.percentageFromCfi(cur.location.start.cfi);
      patchBook(cur.id, patch).then(() => Sync.pushPositions({ keepalive: true }));
    }
  });

  /* ---------- Google Drive sync ---------- */
  // Books: EPUBs in a folder called "Folio" in My Drive are downloaded to each device.
  // Positions: a small positions.json in Folio's hidden app-data folder; the newest position wins.
  const Sync = (() => {
    const CLIENT_ID = (window.FOLIO_CONFIG || {}).googleClientId || "";
    const SCOPES = "https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.appdata";
    const API = "https://www.googleapis.com/drive/v3";
    const UP = "https://www.googleapis.com/upload/drive/v3";
    const panel = $("#drivePanel");
    const panelText = $("#driveText");
    const connectBtn = $("#driveConnect");
    const disconnectBtn = $("#driveDisconnect");
    const syncBtn = $("#syncBtn");
    const row = $("#syncRow");
    const rowText = $("#syncText");
    const rowBarWrap = $("#syncBarWrap");
    const rowBar = $("#syncBar");
    let busy = false;
    let posFileId = null;
    let pushChain = Promise.resolve();

    const state = () => store.get("drive", { connected: false, lastSync: 0, needsTap: false });
    const setState = (p) => store.set("drive", Object.assign(state(), p));
    const token = () => {
      const t = store.get("driveToken", null);
      return t && t.exp > Date.now() + 60000 ? t.value : null;
    };
    const redirectUri = () => location.origin + location.pathname.replace(/index\.html$/, "");
    const authErr = () => Object.assign(new Error("Google sign-in needed"), { auth: true });
    const q = encodeURIComponent;
    const sessionGet = (k) => { try { return sessionStorage.getItem(k); } catch { return null; } };
    const sessionSet = (k, v) => { try { sessionStorage.setItem(k, v); } catch { /* ignore */ } };

    function signIn(silent) {
      const st = uid();
      store.set("driveState", st);
      const p = new URLSearchParams({
        client_id: CLIENT_ID,
        redirect_uri: redirectUri(),
        response_type: "token",
        scope: SCOPES,
        include_granted_scopes: "true",
        state: st,
      });
      if (silent) p.set("prompt", "none");
      sessionSet("folio:silentTried", "1");
      location.assign("https://accounts.google.com/o/oauth2/v2/auth?" + p);
    }

    function handleRedirect() {
      if (!/[#&](access_token|error)=/.test(location.hash)) return;
      const h = new URLSearchParams(location.hash.slice(1));
      history.replaceState(null, "", location.pathname + location.search);
      if (h.get("state") !== store.get("driveState", null)) return;
      if (h.get("access_token")) {
        store.set("driveToken", { value: h.get("access_token"), exp: Date.now() + (Number(h.get("expires_in")) || 3600) * 1000 });
        setState({ connected: true, needsTap: false });
      } else if (state().connected) {
        setState({ needsTap: true });
      } else {
        message("Google Drive wasn't connected. Tap Connect Google Drive to try again.");
      }
    }

    async function api(url, opts = {}) {
      const t = token();
      if (!t) throw authErr();
      const res = await fetch(url, { ...opts, headers: { Authorization: "Bearer " + t, ...(opts.headers || {}) } });
      if (res.status === 401) { store.set("driveToken", null); throw authErr(); }
      if (!res.ok) throw Object.assign(new Error("Drive request failed: " + res.status), { status: res.status });
      return res;
    }

    async function findFolder() {
      const query = "name = 'Folio' and mimeType = 'application/vnd.google-apps.folder' and trashed = false";
      const r = await (await api(`${API}/files?q=${q(query)}&fields=files(id)&spaces=drive&pageSize=10`)).json();
      return r.files && r.files[0] ? r.files[0].id : null;
    }

    async function listBooks(folderId) {
      let out = [];
      let pageToken = "";
      do {
        const query = `'${folderId}' in parents and trashed = false`;
        const r = await (await api(`${API}/files?q=${q(query)}&fields=nextPageToken,files(id,name,mimeType)&pageSize=200${pageToken ? "&pageToken=" + q(pageToken) : ""}`)).json();
        out = out.concat(r.files || []);
        pageToken = r.nextPageToken || "";
      } while (pageToken);
      return out.filter((f) => /\.(epub|pdf)$/i.test(f.name) || f.mimeType === "application/epub+zip" || f.mimeType === "application/pdf");
    }

    async function readRemote() {
      if (!posFileId) {
        const r = await (await api(`${API}/files?spaces=appDataFolder&q=${q("name = 'positions.json'")}&fields=files(id)`)).json();
        posFileId = r.files && r.files[0] ? r.files[0].id : null;
      }
      if (!posFileId) return {};
      try {
        return await (await api(`${API}/files/${posFileId}?alt=media`)).json();
      } catch (e) {
        if (e.auth) throw e;
        return {};
      }
    }

    async function writeRemote(data, keepalive) {
      if (!posFileId) {
        const r = await (await api(`${API}/files?fields=id`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "positions.json", parents: ["appDataFolder"] }),
        })).json();
        posFileId = r.id;
      }
      await api(`${UP}/files/${posFileId}?uploadType=media`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
        keepalive: !!keepalive,
      });
    }

    async function mergePositions({ keepalive = false } = {}) {
      const remote = await readRemote();
      const local = (await books.all()).filter((b) => b.driveId);
      let changed = false;
      for (const b of local) {
        const r = remote[b.driveId];
        const isOpen = cur && cur.id === b.id;
        if (r && r.at > (b.posAt || 0) && !isOpen) {
          await patchBook(b.id, { cfi: r.cfi, pct: r.pct || 0, posAt: r.at, lastOpened: Math.max(b.lastOpened || 0, r.at) });
        } else if (b.cfi && b.posAt && (!r || b.posAt > r.at)) {
          remote[b.driveId] = { cfi: b.cfi, pct: b.pct || 0, at: b.posAt, title: b.title };
          changed = true;
        }
      }
      if (changed) await writeRemote(remote, keepalive);
    }

    function pushPositions(opts) {
      if (!CLIENT_ID || !state().connected || !token()) return Promise.resolve();
      pushChain = pushChain.then(() => mergePositions(opts)).catch(() => { /* retried on next sync */ });
      return pushChain;
    }

    function message(text) {
      row.hidden = !text;
      rowText.textContent = text || "";
      rowBarWrap.hidden = true;
    }

    function progress(text, frac) {
      row.hidden = false;
      rowText.textContent = text;
      rowBarWrap.hidden = frac == null;
      if (frac != null) rowBar.style.transform = `scaleX(${frac})`;
    }

    async function sync({ interactive = false } = {}) {
      if (!CLIENT_ID || !state().connected || busy) return;
      if (!token()) {
        if (interactive) signIn(false);
        else message("Tap Sync to check Google Drive for new books.");
        return;
      }
      busy = true;
      syncBtn.disabled = true;
      syncBtn.setAttribute("aria-label", "Syncing with Google Drive");
      progress("Checking Google Drive…", null);
      let note = "";
      const failed = [];
      try {
        const folderId = await findFolder();
        if (!folderId) {
          note = "There's no folder called Folio in your Google Drive yet. Create one in My Drive, put your EPUBs in it, then tap Sync.";
        } else {
          const remote = await listBooks(folderId);
          const all = await books.all();
          const have = new Set(all.map((b) => b.driveId).filter(Boolean));
          const ignored = new Set(store.get("driveIgnored", []));
          const todo = remote.filter((f) => !have.has(f.id) && !ignored.has(f.id));
          for (let i = 0; i < todo.length; i++) {
            const f = todo[i];
            const base = todo.length > 1 ? `Downloading book ${i + 1} of ${todo.length}` : `Downloading ${f.name}`;
            progress(base + "…", i / todo.length);
            try {
              const buf = await (await api(`${API}/files/${f.id}?alt=media`)).arrayBuffer();
              await importAny(buf, f.name, { driveId: f.id }, (done, total) =>
                progress(`${base}: optimising PDF for reading, page ${Math.min(done + 1, total)} of ${total}…`, (i + done / total) / todo.length));
            } catch (e) {
              if (e.auth) throw e;
              failed.push({ name: f.name, why: e && e.userMessage });
            }
            renderLibrary();
          }
        }
        progress("Syncing reading positions…", null);
        await mergePositions();
        setState(note ? { needsTap: false } : { lastSync: Date.now(), needsTap: false });
      } catch (e) {
        console.warn(e);
        if (e.auth) {
          setState({ needsTap: true });
          note = "Your Google Drive sign-in has expired. Tap Sync to reconnect.";
        } else if (!navigator.onLine) {
          note = "You're offline, so Google Drive wasn't checked. Your books here still open.";
        } else {
          note = "Google Drive couldn't be reached. Tap Sync to try again.";
        }
      } finally {
        busy = false;
        syncBtn.disabled = false;
        syncBtn.setAttribute("aria-label", "Sync with Google Drive");
        message(note);
        if (failed.length) showLibError(failMessage(failed));
        renderPanel();
        renderLibrary();
      }
    }

    function when(ts) {
      if (!ts) return "";
      const d = new Date(ts);
      const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
      const today = new Date().toDateString() === d.toDateString();
      return today ? `today at ${time}` : `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} at ${time}`;
    }

    function renderPanel() {
      if (!CLIENT_ID) { panel.hidden = true; syncBtn.hidden = true; return; }
      const s = state();
      panel.hidden = false;
      syncBtn.hidden = !s.connected;
      connectBtn.hidden = s.connected;
      disconnectBtn.hidden = !s.connected;
      panelText.textContent = s.connected
        ? (s.lastSync ? `Synced with Google Drive ${when(s.lastSync)}.` : "Connected to Google Drive.") + " New books in your Folio folder download here."
        : "Sync books and reading positions across your devices. Put EPUBs in a folder called Folio in your Google Drive.";
    }

    async function disconnect() {
      if (!confirm("Disconnect Google Drive? Books already on this device stay here.")) return;
      const t = store.get("driveToken", null);
      if (t) fetch("https://oauth2.googleapis.com/revoke?token=" + q(t.value), { method: "POST" }).catch(() => {});
      store.set("driveToken", null);
      store.set("drive", { connected: false, lastSync: 0, needsTap: false });
      posFileId = null;
      message("");
      renderPanel();
    }

    function ignore(driveId) {
      const list = store.get("driveIgnored", []);
      if (!list.includes(driveId)) list.push(driveId);
      store.set("driveIgnored", list);
    }

    function init() {
      if (!CLIENT_ID) { renderPanel(); return; }
      handleRedirect();
      renderPanel();
      connectBtn.addEventListener("click", () => signIn(false));
      disconnectBtn.addEventListener("click", disconnect);
      syncBtn.addEventListener("click", () => sync({ interactive: true }));
      const s = state();
      if (!s.connected) return;
      if (token()) sync();
      else if (!s.needsTap && navigator.onLine && !sessionGet("folio:silentTried")) signIn(true);
      else message("Tap Sync to check Google Drive for new books.");
    }

    return { init, sync, pushPositions, ignore };
  })();

  /* ---------- Boot ---------- */
  showSkeleton();
  applySettings({ relayout: false });
  setThemeColor(getComputedStyle(document.body).backgroundColor);
  renderLibrary();
  Sync.init();
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  window.Folio = { importFiles, openBook, closeBook };
})();
