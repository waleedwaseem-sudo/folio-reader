/* Folio PDF converter.
   Turns a PDF into a reflowable EPUB so it reads like a book on a phone:
   - text is re-flowed into paragraphs (hyphenated line breaks re-joined, ligatures fixed)
   - running headers, footers and page numbers are removed
   - larger text becomes headings, which also build the table of contents
   - two-column pages are read column by column
   - pages with almost no text (scans, full-page figures) are kept as page images
   The PDF's own bookmarks are used for the contents when it has them. */
(() => {
  "use strict";

  const PDFJS_VER = "3.11.174";
  const LIG = { "ﬀ": "ff", "ﬁ": "fi", "ﬂ": "fl", "ﬃ": "ffi", "ﬄ": "ffl", "ﬅ": "st", "ﬆ": "st" };
  const clean = (s) => s
    .replace(/[ﬀ-ﬆ]/g, (c) => LIG[c])
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F�￾￿]/g, "")
    .replace(/ /g, " ");
  const xml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  const pct = (a, p) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };

  let loading;
  function loadPdfJs() {
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    if (!loading) {
      loading = new Promise((res, rej) => {
        const s = document.createElement("script");
        s.src = "vendor/pdf.min.js";
        s.onload = () => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js"; res(window.pdfjsLib); };
        s.onerror = () => { loading = null; rej(new Error("The PDF reader couldn't load. Check your connection and try again.")); };
        document.head.appendChild(s);
      });
    }
    return loading;
  }

  /* ---------- Page text → lines ---------- */
  function collectItems(tc) {
    const items = [];
    for (const it of tc.items) {
      if (!it.str || !it.str.trim()) continue;
      const [a, b, c, d, e, f] = it.transform;
      if (Math.abs(b) > Math.abs(a) * 0.1) continue; // rotated text: margin notes, watermarks
      const size = Math.hypot(c, d) || it.height || 10;
      items.push({ str: it.str, x: e, y: f, w: it.width || 0, size });
    }
    return items;
  }

  function toLines(items) {
    items.sort((p, q) => (q.y - p.y) || (p.x - q.x));
    const lines = [];
    for (const it of items) {
      const L = lines[lines.length - 1];
      if (L && Math.abs(L.y - it.y) < Math.max(L.maxSize, it.size) * 0.5) {
        L.items.push(it);
        L.maxSize = Math.max(L.maxSize, it.size);
      } else {
        lines.push({ y: it.y, maxSize: it.size, items: [it] });
      }
    }
    const out = [];
    for (const L of lines) {
      L.items.sort((p, q) => p.x - q.x);
      let t = "";
      let end = null;
      const bySize = new Map();
      for (const it of L.items) {
        if (end != null) {
          const gap = it.x - end;
          if (gap > it.size * 0.15 && !/\s$/.test(t) && !/^\s/.test(it.str)) t += " ";
        }
        t += it.str;
        end = Math.max(end ?? -Infinity, it.x + it.w);
        const k = Math.round(it.size * 2) / 2;
        bySize.set(k, (bySize.get(k) || 0) + it.str.length);
      }
      const text = clean(t).replace(/\s+/g, " ").trim();
      if (!text) continue;
      let size = 0;
      let best = -1;
      bySize.forEach((n, k) => { if (n > best) { best = n; size = k; } });
      out.push({ text, x: L.items[0].x, xEnd: end, y: L.y, size });
    }
    return out;
  }

  // Splits a page into reading groups: full-width text first, then left column, then right column.
  function pageGroups(items, width) {
    const mid = width / 2;
    let left = 0, right = 0, cross = 0;
    for (const it of items) {
      if (it.x + it.w < mid - 2) left++;
      else if (it.x > mid + 2) right++;
      else cross++;
    }
    const n = items.length;
    const twoCol = n >= 8 && cross < Math.max(2, n * 0.08) && left > n * 0.25 && right > n * 0.25;
    if (!twoCol) return [toLines(items)];
    return [
      toLines(items.filter((i) => i.x <= mid + 2 && i.x + i.w >= mid - 2)),
      toLines(items.filter((i) => i.x + i.w < mid - 2)),
      toLines(items.filter((i) => i.x > mid + 2)),
    ].filter((g) => g.length);
  }

  /* ---------- Outline (bookmarks) ---------- */
  async function resolveOutline(pdf, items, level = 0) {
    const out = [];
    for (const it of items || []) {
      let page = null;
      try {
        let dest = it.dest;
        if (typeof dest === "string") dest = await pdf.getDestination(dest);
        if (Array.isArray(dest) && dest[0] != null) {
          page = typeof dest[0] === "object" ? await pdf.getPageIndex(dest[0]) : Number(dest[0]);
        }
      } catch { /* unresolved bookmark */ }
      const children = level < 2 && it.items && it.items.length ? await resolveOutline(pdf, it.items, level + 1) : [];
      const title = clean(it.title || "").replace(/\s+/g, " ").trim();
      if (title && page != null && page >= 0) out.push({ title, page, children });
      else out.push(...children);
    }
    return out;
  }

  /* ---------- Rendering ---------- */
  async function renderJpeg(page, targetWidth, quality, crop = false) {
    const vp1 = page.getViewport({ scale: 1 });
    const scale = Math.min(2.5, targetWidth / vp1.width);
    const vp = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(vp.width);
    canvas.height = Math.ceil(vp.height);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // "print" intent renders without waiting on animation frames, so conversion keeps going if the app is backgrounded.
    await page.render({ canvasContext: ctx, viewport: vp, intent: "print" }).promise;
    let out = canvas;
    if (crop) {
      const box = contentBox(ctx, canvas.width, canvas.height);
      if (box) {
        out = document.createElement("canvas");
        out.width = box.w;
        out.height = box.h;
        out.getContext("2d").drawImage(canvas, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);
      }
    }
    const blob = await new Promise((r) => out.toBlob(r, "image/jpeg", quality));
    const size = { w: out.width, h: out.height };
    canvas.width = canvas.height = 0; // release memory on iOS
    out.width = out.height = 0;
    return { data: await blob.arrayBuffer(), ...size };
  }

  // Bounding box of the non-white content, ignoring the top and bottom 8% where running headers and page numbers sit.
  function contentBox(ctx, W, H) {
    const top = Math.floor(H * 0.08), bottom = Math.ceil(H * 0.92);
    const { data } = ctx.getImageData(0, 0, W, H);
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    const step = 2;
    for (let y = top; y < bottom; y += step) {
      const row = y * W * 4;
      for (let x = 0; x < W; x += step) {
        const i = row + x * 4;
        if (data[i] < 235 || data[i + 1] < 235 || data[i + 2] < 235) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
    if (x1 < 0) return null;
    const pad = Math.round(Math.min(W, H) * 0.02);
    x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
    x1 = Math.min(W, x1 + pad); y1 = Math.min(H, y1 + pad);
    const w = x1 - x0, h = y1 - y0;
    if (w < W * 0.1 || h < H * 0.05) return null; // too small to be a real figure; keep the full page
    return { x: x0, y: y0, w, h };
  }

  /* ---------- Main ---------- */
  async function convert(buf, fileName, onProgress = () => {}) {
    const pdfjsLib = await loadPdfJs();
    let pdf;
    try {
      pdf = await pdfjsLib.getDocument({
        data: new Uint8Array(buf.slice(0)),
        cMapUrl: `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VER}/cmaps/`,
        cMapPacked: true,
        standardFontDataUrl: `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VER}/standard_fonts/`,
        isEvalSupported: false,
      }).promise;
    } catch (e) {
      if (e && e.name === "PasswordException") throw Object.assign(new Error("This PDF is password-protected."), { userMessage: "is password-protected" });
      throw e;
    }

    const N = pdf.numPages;
    const pages = [];
    const images = [];
    let cover = null;

    for (let p = 0; p < N; p++) {
      onProgress(p, N);
      const page = await pdf.getPage(p + 1);
      const vp = page.getViewport({ scale: 1 });
      const tc = await page.getTextContent();
      const items = collectItems(tc);
      const chars = items.reduce((n, i) => n + i.str.trim().length, 0);
      const groups = pageGroups(items, vp.width);
      let img = null;
      if (chars < 40) {
        try {
          const r = await renderJpeg(page, 1400, 0.82, true);
          img = { name: `img/p${p + 1}.jpg`, ...r };
          images.push(img);
        } catch { /* rendering failed; keep whatever text there is */ }
      }
      if (p === 0) {
        try { cover = await renderJpeg(page, 600, 0.85); } catch { /* no cover */ }
      }
      pages.push({ groups, height: vp.height, img });
      page.cleanup();
    }
    onProgress(N, N);

    /* Running headers, footers and page numbers */
    const norm = (t) => t.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
    const isPageNum = (t) => /^(page\s*)?[#\d]+(\s*(of|\/)\s*\d+)?$/i.test(t) || /^[ivxlcdm]{1,6}$/i.test(t) || /^[-–—]\s*\d+\s*[-–—]$/.test(t);
    const edgeCount = new Map();
    const edgeLines = (pg) => {
      const all = pg.groups.flat();
      if (all.length < 2) return [];
      const byY = [...all].sort((a, b) => b.y - a.y);
      return [...new Set([byY[0], byY[1], byY[byY.length - 1], byY[byY.length - 2]])]
        .filter((l) => l.y > pg.height * 0.85 || l.y < pg.height * 0.15);
    };
    for (const pg of pages) {
      const seen = new Set();
      for (const l of edgeLines(pg)) {
        const k = norm(l.text);
        if (!seen.has(k)) { seen.add(k); edgeCount.set(k, (edgeCount.get(k) || 0) + 1); }
      }
    }
    const threshold = Math.max(3, Math.ceil(N * 0.25));
    for (const pg of pages) {
      const drop = new Set(edgeLines(pg).filter((l) => isPageNum(l.text) || (N >= 4 && edgeCount.get(norm(l.text)) >= threshold)));
      pg.groups = pg.groups.map((g) => g.filter((l) => !drop.has(l))).filter((g) => g.length);
    }

    /* Document-wide measurements */
    const sizeChars = new Map();
    for (const pg of pages) for (const g of pg.groups) for (const l of g) {
      const k = l.size;
      sizeChars.set(k, (sizeChars.get(k) || 0) + l.text.length);
    }
    let body = 10, bestN = -1;
    sizeChars.forEach((n, k) => { if (n > bestN) { bestN = n; body = k; } });
    const gaps = [];
    for (const pg of pages) for (const g of pg.groups) {
      for (let i = 1; i < g.length; i++) {
        const a = g[i - 1], b = g[i];
        if (Math.abs(a.size - body) < 0.6 && Math.abs(b.size - body) < 0.6) {
          const d = a.y - b.y;
          if (d > 0 && d < body * 3) gaps.push(d);
        }
      }
    }
    const lineGap = median(gaps) || body * 1.25;
    for (const pg of pages) {
      pg.groups = pg.groups.map((g) => {
        const bodyLines = g.filter((l) => Math.abs(l.size - body) < 0.6);
        const src = bodyLines.length ? bodyLines : g;
        g.left = pct(src.map((l) => l.x), 0.1);
        g.right = pct(src.map((l) => l.xEnd), 0.9);
        // Line spacing differs between parts of a document (front matter, quotes, notes), so measure it per block of text.
        const local = [];
        for (let i = 1; i < g.length; i++) {
          const d = g[i - 1].y - g[i].y;
          if (d > 0 && d < g[i].size * 3 && Math.abs(g[i].size - g[i - 1].size) < 0.6) local.push(d);
        }
        g.gap = local.length >= 3 ? Math.min(median(local), lineGap * 2) : lineGap;
        return g;
      });
    }

    /* Lines → blocks (headings, paragraphs, page images) */
    const blocks = [];
    let para = null;
    const flush = () => { if (para) { blocks.push(para); para = null; } };
    const listStart = /^([•▪◦‣●○■□–—-]\s|\(?\d{1,3}[.)]\s|\(?[a-z][.)]\s)/;
    const joinLine = (a, b) => {
      if (/­$/.test(a)) return a.slice(0, -1) + b;
      if (/[A-Za-zÀ-ÿ]-$/.test(a) && /^[a-zà-ÿ]/.test(b)) return a.slice(0, -1) + b;
      return a + " " + b;
    };

    pages.forEach((pg, p) => {
      if (pg.img) { flush(); blocks.push({ type: "img", page: p, img: pg.img }); }
      pg.groups.forEach((g) => {
        let prev = null;
        for (const L of g) {
          const ratio = L.size / body;
          const heading = ratio >= 1.15 && L.text.length < 140 && /\p{L}/u.test(L.text);
          if (heading) {
            const level = ratio >= 1.6 ? 1 : ratio >= 1.3 ? 2 : 3;
            if (para && para.type === "h" && para.level === level && para.page === p && prev && prev.y - L.y < L.size * 1.9) {
              para.text += " " + L.text;
            } else {
              flush();
              para = { type: "h", level, text: L.text, page: p };
            }
            prev = L;
            continue;
          }
          const indented = L.x > g.left + body * 0.8 && L.x < g.left + body * 5;
          const isList = listStart.test(L.text);
          let fresh = !para || para.type !== "p" || isList;
          const before = prev || (para && para.last);
          // A sentence that is clearly still going never starts a new paragraph:
          // the previous line ends in a hyphen, or ends without punctuation and this line carries on.
          const gap = prev ? prev.y - L.y : 0;
          const ended = before && /[.!?:;"”’)\]…]$/.test(before.text);
          const carriesOn = !fresh && before && (
            /[\p{L}]-$|\u00AD$/u.test(before.text) ||
            (!ended && /^[\p{Ll}]/u.test(L.text)) ||
            (!ended && before.xEnd >= (prev ? g.right : before.right) - body * 4 && (!prev || gap < g.gap * 2.5))
          );
          if (!fresh && !carriesOn && prev) {
            if (gap > g.gap * 1.45) fresh = true;
            else if (indented) fresh = true;
            else if (prev.xEnd < g.right - body * 4 && ended) fresh = true;
          } else if (!fresh && !carriesOn && !prev) {
            // First line of a page or column: carry the paragraph over unless it clearly ended.
            const last = para.last;
            if (indented) fresh = true;
            else if (last && ended && last.xEnd < last.right - body * 4) fresh = true;
          }
          if (fresh) { flush(); para = { type: "p", text: L.text, page: p }; }
          else para.text = joinLine(para.text, L.text);
          para.last = { text: L.text, xEnd: L.xEnd, right: g.right };
          prev = L;
        }
      });
    });
    flush();
    if (!blocks.length) throw Object.assign(new Error("No readable pages"), { userMessage: "has no readable pages" });

    /* Contents */
    let outline = [];
    try { outline = await resolveOutline(pdf, await pdf.getOutline()); } catch { /* no bookmarks */ }
    const firstBlockOfPage = (page) => blocks.findIndex((b) => b.page >= page);

    // Sections (one XHTML file each) keep long PDFs fast to page through.
    const splits = new Set([0]);
    if (outline.length) {
      for (const o of outline) { const i = firstBlockOfPage(o.page); if (i > 0) splits.add(i); }
    } else {
      const h1 = blocks.filter((b) => b.type === "h" && b.level === 1).length;
      const maxLevel = h1 >= 2 ? 1 : 2;
      blocks.forEach((b, i) => { if (i > 0 && b.type === "h" && b.level <= maxLevel) splits.add(i); });
    }
    const sections = [];
    let curSec = null;
    let chars = 0;
    blocks.forEach((b, i) => {
      const forced = curSec && chars > 60000 && b.page !== blocks[i - 1].page;
      if (!curSec || splits.has(i) || forced) {
        curSec = { id: `s${sections.length + 1}`, blocks: [] };
        sections.push(curSec);
        chars = 0;
      }
      b.section = curSec.id;
      curSec.blocks.push(b);
      chars += b.text ? b.text.length : 400;
    });

    // Anchors: first block on each page, plus every heading.
    const seenPage = new Set();
    blocks.forEach((b, i) => {
      if (!seenPage.has(b.page)) { seenPage.add(b.page); b.id = `p${b.page + 1}`; }
      if (b.type === "h" && !b.id) b.id = `h${i}`;
    });

    let toc;
    if (outline.length) {
      const mk = (nodes) => nodes.map((o) => {
        const i = firstBlockOfPage(o.page);
        const b = blocks[i >= 0 ? i : blocks.length - 1];
        return { label: o.title, href: `${b.section}.xhtml#${b.id}`, children: mk(o.children) };
      });
      toc = mk(outline);
    } else {
      const heads = blocks.filter((b) => b.type === "h" && b.level <= 2);
      if (heads.length) {
        toc = [];
        const nest = heads.filter((h) => h.level === 1).length >= 2; // a lone h1 is the document title
        for (const h of heads) {
          const entry = { label: h.text, href: `${h.section}.xhtml#${h.id}`, children: [] };
          if (nest && h.level === 2 && toc.length && toc[toc.length - 1].level === 1) toc[toc.length - 1].children.push(entry);
          else toc.push(Object.assign(entry, { level: h.level }));
        }
      } else {
        toc = sections.map((s) => {
          const a = s.blocks[0].page + 1, z = s.blocks[s.blocks.length - 1].page + 1;
          return { label: a === z ? `Page ${a}` : `Pages ${a}–${z}`, href: `${s.id}.xhtml`, children: [] };
        });
      }
    }

    /* Metadata */
    let title = "", author = "";
    try {
      const md = await pdf.getMetadata();
      title = clean((md.info && md.info.Title) || "").trim();
      author = clean((md.info && md.info.Author) || "").trim();
    } catch { /* none */ }
    const junkTitle = /^(untitled|microsoft (word|powerpoint)|document\d*$)|\.(docx?|pdf|indd|pptx?|txt|tex|dvi)$/i;
    if (!title || junkTitle.test(title)) {
      const firstHead = blocks.find((b) => b.type === "h" && b.page < 2);
      title = firstHead ? firstHead.text : fileName.replace(/\.pdf$/i, "").replace(/[_]+/g, " ").trim();
    }

    /* Build the EPUB */
    const zip = new JSZip();
    zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
    zip.file("META-INF/container.xml", `<?xml version="1.0" encoding="utf-8"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`);
    zip.file("OEBPS/style.css", [
      "body { margin: 0; }",
      "p { margin: 0 0 0.85em; text-align: start; }",
      "h1, h2, h3 { line-height: 1.25; margin: 1.4em 0 0.6em; font-weight: 600; }",
      "h1 { font-size: 1.6em; } h2 { font-size: 1.3em; } h3 { font-size: 1.1em; }",
      "section > h1:first-child, section > h2:first-child { margin-top: 0; }",
      "figure.page { margin: 0 0 1em; text-align: center; page-break-inside: avoid; break-inside: avoid; }",
      "figure.page img { max-width: 100%; max-height: 95vh; height: auto; }",
    ].join("\n"));

    const head = (t) => `<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en" xml:lang="en"><head><meta charset="utf-8"/><title>${xml(t)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head>`;
    for (const s of sections) {
      const html = s.blocks.map((b) => {
        const id = b.id ? ` id="${b.id}"` : "";
        if (b.type === "img") return `<figure class="page"${id}><img src="${b.img.name}" alt="Page ${b.page + 1}" width="${b.img.w}" height="${b.img.h}"/></figure>`;
        if (b.type === "h") return `<h${b.level}${id}>${xml(b.text)}</h${b.level}>`;
        return `<p${id}>${xml(b.text)}</p>`;
      }).join("\n");
      zip.file(`OEBPS/${s.id}.xhtml`, `${head(title)}<body><section>\n${html}\n</section></body></html>`);
    }
    for (const im of images) zip.file(`OEBPS/${im.name}`, im.data);
    if (cover) zip.file("OEBPS/cover.jpg", cover.data);

    const navList = (items) => `<ol>${items.map((t) => `<li><a href="${t.href}">${xml(t.label)}</a>${t.children && t.children.length ? navList(t.children) : ""}</li>`).join("")}</ol>`;
    zip.file("OEBPS/nav.xhtml", `${head("Contents")}<body><nav epub:type="toc" id="toc"><h1>Contents</h1>${navList(toc)}</nav></body></html>`);

    const uid = "folio-pdf-" + (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36));
    const manifest = [
      `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`,
      `<item id="css" href="style.css" media-type="text/css"/>`,
      cover ? `<item id="cover" href="cover.jpg" media-type="image/jpeg" properties="cover-image"/>` : "",
      ...sections.map((s) => `<item id="${s.id}" href="${s.id}.xhtml" media-type="application/xhtml+xml"/>`),
      ...images.map((im, i) => `<item id="im${i}" href="${im.name}" media-type="image/jpeg"/>`),
    ].join("");
    const spine = sections.map((s) => `<itemref idref="${s.id}"/>`).join("");
    const modified = new Date().toISOString().replace(/\.\d+Z$/, "Z");
    zip.file("OEBPS/content.opf", `<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">${uid}</dc:identifier><dc:title>${xml(title)}</dc:title>${author ? `<dc:creator>${xml(author)}</dc:creator>` : ""}<dc:language>en</dc:language><meta property="dcterms:modified">${modified}</meta>${cover ? `<meta name="cover" content="cover"/>` : ""}</metadata><manifest>${manifest}</manifest><spine>${spine}</spine></package>`);

    await pdf.destroy();
    return zip.generateAsync({ type: "arraybuffer", mimeType: "application/epub+zip" });
  }

  // Bump when the conversion improves; books with a stored source PDF are re-converted on open.
  window.FolioPDF = { convert, VERSION: 2 };
})();
