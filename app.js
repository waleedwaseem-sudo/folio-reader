/* Folio: a light EPUB reader. Books live in IndexedDB on this device. */
(() => {
  "use strict";

  const $ = (s, r = document) => r.querySelector(s);
  const FONT_CSS = "https://fonts.googleapis.com/css2?family=Literata:ital,opsz,wght@0,7..72,400;0,7..72,600;1,7..72,400&display=swap";
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
      if (!confirm(`Remove “${b.title}” from this phone? Your reading position goes with it.`)) return;
      await files.del(id);
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
      importingText.textContent = list.length > 1 ? `Adding book ${i + 1} of ${list.length}…` : "Adding book…";
      importingBar.style.transform = `scaleX(${i / list.length})`;
      try {
        await importOne(list[i]);
      } catch (err) {
        console.warn(err);
        failed.push(list[i].name);
      }
    }
    importingBar.style.transform = "scaleX(1)";
    importing.hidden = true;
    importingBar.style.transform = "scaleX(0)";
    if (failed.length) {
      showLibError(
        failed.length === 1
          ? `“${failed[0]}” couldn't be opened as an EPUB. Choose a file that ends in .epub and isn't DRM-protected.`
          : `${failed.length} files couldn't be opened as EPUBs: ${failed.join(", ")}. Choose files that end in .epub and aren't DRM-protected.`
      );
    }
    renderLibrary();
  }

  async function importOne(file) {
    const buf = await file.arrayBuffer();
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
        locations: null,
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
    { size: 100, font: "literata", spacing: "1.6", theme: "white" },
    store.get("settings", {})
  );

  let cur = null; // { id, book, rendition, toc, location }

  function readerCss() {
    const t = THEMES[settings.theme];
    const ff = FONTS[settings.font];
    return `
      html, body { background: transparent !important; color: ${t.ink} !important; }
      body { font-size: ${settings.size}% !important; -webkit-text-size-adjust: 100%; }
      body *:not(img):not(svg):not(image) { color: inherit !important; background-color: transparent !important; border-color: currentColor; }
      p, li, blockquote, dd, dt, div, span { line-height: ${settings.spacing} !important; }
      ${ff ? `body, p, div, span, li, blockquote, h1, h2, h3, h4, h5, h6, em, i, b, strong, a { font-family: ${ff} !important; }` : ""}
      a, a * { color: ${t.link} !important; }
      img, svg, image { max-width: 100%; }
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
    readerEl.dataset.theme = settings.theme;
    setThemeColor(THEMES[settings.theme].page);
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
      const buf = await files.get(id);
      if (!buf) throw new Error("Book file missing");
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

  function onRelocated(loc) {
    if (!cur) return;
    cur.location = loc;
    const ready = cur.book.locations.length() > 0;
    const pct = ready ? cur.book.locations.percentageFromCfi(loc.start.cfi) : null;
    updateFooter(pct);
    const patch = { cfi: loc.start.cfi, lastOpened: Date.now() };
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
    footPct.textContent = pct != null ? Math.round(pct * 100) + "%" : "";
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
        const patch = { cfi: location.start.cfi, lastOpened: Date.now() };
        if (book.locations.length() > 0) patch.pct = location.atEnd ? 1 : book.locations.percentageFromCfi(location.start.cfi);
        await patchBook(id, patch);
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
    const w = tap.clientWidth;
    const x = e.clientX - tap.getBoundingClientRect().left;
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
      const patch = { cfi: cur.location.start.cfi, lastOpened: Date.now() };
      if (cur.book.locations.length() > 0) patch.pct = cur.book.locations.percentageFromCfi(cur.location.start.cfi);
      patchBook(cur.id, patch);
    }
  });

  /* ---------- Boot ---------- */
  showSkeleton();
  applySettings({ relayout: false });
  setThemeColor(getComputedStyle(document.body).backgroundColor);
  renderLibrary();
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  window.Folio = { importFiles, openBook, closeBook };
})();
