// Cites Extractor. Clicking the toolbar button collects the links of the active tab:
//  - on a web page: all external links on the page;
//  - on a PDF: the links/DOIs/arXiv ids in its bibliography (see extract.js).
// Each link's citation metadata (the <meta name="citation_*"> tags Zotero uses) is read and
// saved into the running Zotero desktop app through its local connector port.
// Links with no citation metadata are skipped.

const ZOTERO = "http://127.0.0.1:23119/connector";
const CONCURRENCY = 4;
const FETCH_TIMEOUT_MS = 10000;
const TAB_TIMEOUT_MS = 25000;
const TAB_SETTLE_MS = 3000;
const TAB_CONCURRENCY = 2;
const PDF_TIMEOUT_MS = 60000;
const COUNT_TIMEOUT_MS = 10000;

const log = (...a) => console.log("[P2Z]", ...a);

function collectLinks() {
  const seen = new Set();
  for (const a of document.querySelectorAll("a[href]")) {
    try {
      const u = new URL(a.href, location.href);
      if (!/^https?:$/.test(u.protocol) || u.hostname === location.hostname) continue;
      u.hash = "";
      seen.add(u.href);
    } catch (e) {}
  }
  return [...seen];
}

const TRACKING_PARAMS = /^(utm_.*|fbclid|gclid|ref|source|error|code|pdf|cookies.*)$/i;
const DOI_RE = /10\.\d{4,9}\/[^\s?#]+/;

function cleanUrl(url) {
  const u = new URL(url);
  for (const k of [...u.searchParams.keys()]) if (TRACKING_PARAMS.test(k)) u.searchParams.delete(k);
  return u.href;
}

function doiFromUrl(url) {
  const m = decodeURIComponent(url).match(DOI_RE);
  return m ? m[0].replace(/(\.pdf|[.,;)])+$/i, "").toLowerCase() : null;
}

// One entry per paper: same DOI or same cleaned URL collapses; an HTML page beats a bare PDF link.
function dedupeLinks(urls) {
  const byKey = new Map();
  for (const raw of urls) {
    const url = cleanUrl(raw);
    const key = doiFromUrl(url) || url;
    const prev = byKey.get(key);
    if (!prev || (/\.pdf$|\/pdf\//i.test(prev) && !/\.pdf$|\/pdf\//i.test(url))) byKey.set(key, url);
  }
  return [...byKey.values()];
}

// arxiv.org/pdf/ID and /html/ID carry no metadata; the /abs/ page does.
function metadataUrl(url) {
  const m = url.match(/^https?:\/\/(?:www\.)?arxiv\.org\/(?:pdf|html)\/([^?#]+?)(?:\.pdf)?$/);
  return m ? `https://arxiv.org/abs/${m[1]}` : url;
}

// Returns { doc } for HTML pages, { pdf } (bytes) for PDFs, or null.
async function fetchPage(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { credentials: "include", signal: ctl.signal });
    if (!res.ok) return null;
    const type = res.headers.get("content-type") || "";
    if (/pdf/.test(type)) {
      const bytes = new Uint8Array(await res.arrayBuffer());
      return String.fromCharCode(...bytes.slice(0, 4)) === "%PDF" ? { pdf: bytes } : null;
    }
    if (!/html/.test(type)) return null;
    return { doc: new DOMParser().parseFromString(await res.text(), "text/html") };
  } finally {
    clearTimeout(timer);
  }
}

function toCreator(name) {
  name = name.trim();
  if (name.includes(",")) {
    const [last, first] = name.split(/,(.*)/s);
    return { firstName: (first || "").trim(), lastName: last.trim(), creatorType: "author" };
  }
  const i = name.lastIndexOf(" ");
  return i < 0
    ? { lastName: name, creatorType: "author", fieldMode: 1 }
    : { firstName: name.slice(0, i), lastName: name.slice(i + 1), creatorType: "author" };
}

function buildItem(doc, pageUrl) {
  const all = (n) => [...doc.querySelectorAll(`meta[name="${n}"]`)].map((m) => m.content.trim()).filter(Boolean);
  const one = (...ns) => { for (const n of ns) { const v = all(n)[0]; if (v) return v; } return ""; };

  const title = one("citation_title", "dc.title");
  if (!title) return null;

  const host = new URL(pageUrl).hostname;
  const isPreprint = /(^|\.)(arxiv\.org|biorxiv\.org|medrxiv\.org)$/.test(host);
  const conf = one("citation_conference_title");
  const authors = all("citation_author");
  const pages = [one("citation_firstpage"), one("citation_lastpage")].filter(Boolean).join("-");

  const item = {
    id: Math.random().toString(36).slice(2),
    itemType: isPreprint ? "preprint" : conf ? "conferencePaper" : "journalArticle",
    title,
    creators: (authors.length ? authors : all("dc.creator")).map(toCreator),
    date: one("citation_publication_date", "citation_date", "citation_online_date", "dc.date"),
    DOI: one("citation_doi"),
    abstractNote: one("citation_abstract", "description", "og:description"),
    url: one("citation_abstract_html_url") || pageUrl,
    attachments: [],
  };
  if (isPreprint) {
    item.repository = host.replace(/^www\./, "");
    item.archiveID = one("citation_arxiv_id");
  } else if (conf) {
    item.proceedingsTitle = conf;
    item.pages = pages;
  } else {
    item.publicationTitle = one("citation_journal_title");
    item.volume = one("citation_volume");
    item.issue = one("citation_issue");
    item.pages = pages;
    item.ISSN = one("citation_issn");
  }
  const pdf = one("citation_pdf_url");
  if (pdf) {
    item.attachments.push({
      id: Math.random().toString(36).slice(2),
      title: "Full Text PDF",
      url: pdf.replace(/^http:/, "https:"),
      mimeType: "application/pdf",
    });
  }
  return item;
}

// Downloads the PDF in the browser (so the user's logins/cookies apply) and uploads it to Zotero.
async function uploadAttachment(sessionID, parentItemID, att) {
  const res = await fetch(att.url, { credentials: "include" });
  if (!res.ok) throw new Error(`PDF download ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (String.fromCharCode(...bytes.slice(0, 4)) !== "%PDF") throw new Error("not a PDF (paywall/login page?)");
  const up = await fetch(`${ZOTERO}/saveAttachment`, {
    method: "POST",
    headers: {
      "Content-Type": att.mimeType,
      "X-Zotero-Connector-API-Version": "3",
      "X-Metadata": JSON.stringify({
        sessionID,
        id: att.id,
        parentItemID,
        title: att.title,
        url: att.url,
        contentType: att.mimeType,
      }),
    },
    body: bytes,
  });
  if (!up.ok) throw new Error(`saveAttachment ${up.status} ${(await up.text()).slice(0, 150)}`);
}

async function saveToZotero(item, pageUrl) {
  const sessionID = Math.random().toString(36).slice(2);
  const res = await fetch(`${ZOTERO}/saveItems`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Zotero-Connector-API-Version": "3" },
    body: JSON.stringify({ sessionID, uri: pageUrl, items: [item] }),
  });
  if (!res.ok) throw new Error(`Zotero responded ${res.status}`);
  for (const att of item.attachments) {
    try {
      await uploadAttachment(sessionID, item.id, att);
      log("  attached PDF for", item.title);
    } catch (e) {
      log("  PDF failed for", item.title, "-", e.message);
    }
  }
}

// A bare PDF with no metadata: save it as a standalone attachment; Zotero then tries to
// recognise it (title/authors) itself, and keeps it only as a file if it cannot.
async function saveStandalonePdf(bytes, url) {
  const res = await fetch(`${ZOTERO}/saveStandaloneAttachment`, {
    method: "POST",
    headers: {
      "Content-Type": "application/pdf",
      "X-Zotero-Connector-API-Version": "3",
      "X-Metadata": JSON.stringify({
        sessionID: Math.random().toString(36).slice(2),
        url,
        contentType: "application/pdf",
        title: decodeURIComponent(url.split("/").pop().replace(/\.pdf$/i, "")),
      }),
    },
    body: bytes,
  });
  if (!res.ok) throw new Error(`saveStandaloneAttachment ${res.status}`);
}

let claimedDois = new Set();

// Optional (off by default, see options.html): record the paper's citation count in Zotero's
// Extra field, looked up by DOI on OpenAlex (api.openalex.org). Only the DOI is sent.
let lookupCounts = false;

async function countLookupEnabled() {
  try {
    const { countCitations } = await browser.storage.local.get("countCitations");
    return !!countCitations && (await browser.permissions.contains({ data_collection: ["browsingActivity"] }));
  } catch (e) {
    return false;
  }
}

async function citationCount(item) {
  const doi = item.DOI || (item.archiveID ? `10.48550/arXiv.${item.archiveID.replace(/^arxiv:/i, "")}` : "");
  if (!doi) return null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), COUNT_TIMEOUT_MS);
  try {
    const res = await fetch(`https://api.openalex.org/works/https://doi.org/${doi.split("/").map(encodeURIComponent).join("/")}?select=cited_by_count`, { signal: ctl.signal });
    if (!res.ok) return null;
    const n = (await res.json()).cited_by_count;
    return Number.isInteger(n) ? n : null;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function saveOnce(item, pageUrl) {
  const doi = (item.DOI || "").toLowerCase();
  if (doi) {
    if (claimedDois.has(doi)) { log("skipped (duplicate DOI)", item.title); return "duplicate"; }
    claimedDois.add(doi);
  }
  if (lookupCounts) {
    const n = await citationCount(item);
    if (n !== null) {
      item.extra = [item.extra, `Citations: ${n} (OpenAlex, ${new Date().toISOString().slice(0, 10)})`].filter(Boolean).join("\n");
    }
  }
  await saveToZotero(item, pageUrl);
  log("saved", item.title, item.extra ? `[${item.extra.split("\n").pop()}]` : "");
  return "saved";
}

async function processUrl(url) {
  try {
    const metaUrl = metadataUrl(url);
    const page = await fetchPage(metaUrl);
    if (!page) { log("skipped (unreachable / not HTML or PDF)", url); return "skipped"; }
    if (page.pdf) {
      await saveStandalonePdf(page.pdf, metaUrl);
      log("saved PDF (Zotero will retrieve metadata)", url);
      return "saved";
    }
    const item = buildItem(page.doc, metaUrl);
    if (!item) { log("skipped (no citation metadata)", url); return "skipped"; }
    return await saveOnce(item, metaUrl);
  } catch (e) {
    if (e.name === "AbortError") { log("skipped (timed out)", url); return "skipped"; }
    log("failed", url, e.message);
    return "failed";
  }
}

// Last resort for links the plain fetch could not read (blocked, JS-rendered, no tags):
// load the page in a real background tab, then read the rendered DOM for citation metadata.
function waitForLoad(tabId) {
  return new Promise((resolve) => {
    const done = () => { browser.tabs.onUpdated.removeListener(onUpdated); clearTimeout(timer); resolve(); };
    const onUpdated = (id, info) => { if (id === tabId && info.status === "complete") done(); };
    const timer = setTimeout(done, TAB_TIMEOUT_MS);
    browser.tabs.onUpdated.addListener(onUpdated);
    browser.tabs.get(tabId).then((t) => { if (t.status === "complete") done(); });
  });
}

async function processInTab(url) {
  const tab = await browser.tabs.create({ url, active: false });
  try {
    await waitForLoad(tab.id);
    await new Promise((r) => setTimeout(r, TAB_SETTLE_MS)); // let client-side rendering finish
    let page;
    try {
      [page] = await browser.tabs.executeScript(tab.id, {
        code: "({ html: document.documentElement.outerHTML, type: document.contentType, href: location.href })",
      });
    } catch (e) {
      log("tab: page could not be read (error page / blocked)", url); // e.g. timed-out loads
      return "skipped";
    }
    if (!page || !/html/.test(page.type)) { log("tab: still no luck (not HTML)", url); return "skipped"; }
    const doc = new DOMParser().parseFromString(page.html, "text/html");
    const item = buildItem(doc, page.href);
    if (!item) { log("tab: still no citation metadata", url); return "skipped"; }
    const status = await saveOnce(item, page.href);
    if (status === "saved") log("  (rescued via tab)", url);
    return status;
  } catch (e) {
    log("tab: failed", url, e.message);
    return "failed";
  } finally {
    await browser.tabs.remove(tab.id).catch(() => {});
  }
}

async function pingZotero() {
  const hdrs = { "Content-Type": "application/json", "X-Zotero-Connector-API-Version": "3" };
  try {
    const res = await fetch(`${ZOTERO}/ping`, { method: "POST", headers: hdrs, body: "{}" });
    log("ping status", res.status, (await res.text()).slice(0, 200));
    return res.ok;
  } catch (e) {
    log("ping failed:", e.message, "— running diagnostics");
  }
  const probes = [
    ["GET 127.0.0.1", "http://127.0.0.1:23119/connector/ping", { method: "GET" }],
    ["GET localhost", "http://localhost:23119/connector/ping", { method: "GET" }],
    ["POST localhost", "http://localhost:23119/connector/ping", { method: "POST", headers: hdrs, body: "{}" }],
    ["GET no-cors", "http://127.0.0.1:23119/connector/ping", { method: "GET", mode: "no-cors" }],
    ["GET no Origin/cookies", "http://127.0.0.1:23119/connector/ping", { method: "GET", credentials: "omit", referrerPolicy: "no-referrer" }],
  ];
  for (const [name, url, opts] of probes) {
    try {
      const res = await fetch(url, opts);
      log("probe", name, "->", res.status, res.type, (await res.text()).slice(0, 100));
    } catch (e) {
      log("probe", name, "-> FAILED", e.message);
    }
  }
  return false;
}

// Downloads the tab's own PDF (with the user's cookies); null if the tab is not a PDF.
async function fetchPdfBytes(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), PDF_TIMEOUT_MS);
  try {
    const res = await fetch(url, { credentials: "include", signal: ctl.signal });
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    return String.fromCharCode(...bytes.slice(0, 4)) === "%PDF" ? bytes : null;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Returns the raw links to import from the active tab, for a web page or a PDF.
async function collectFromTab(tab) {
  let readFailed = false;
  try {
    const [type] = await browser.tabs.executeScript(tab.id, { code: "document.contentType" });
    if (!/pdf/i.test(type)) {
      const [links] = await browser.tabs.executeScript(tab.id, { code: `(${collectLinks})()` });
      log(`Web page: ${links.length} external links`);
      return links;
    }
  } catch (e) {
    readFailed = true; // the built-in PDF viewer may refuse scripts; check for a PDF below
  }

  const bytes = await fetchPdfBytes(tab.url);
  if (!bytes) {
    log(readFailed ? "This tab cannot be read (not a web page or PDF)." : "Could not download this PDF.");
    return [];
  }
  pdfjsLib.GlobalWorkerOptions.workerSrc = browser.runtime.getURL("lib/pdf.worker.min.js");
  const res = await extractReferenceLinks(pdfjsLib, bytes);
  log(
    `PDF: ${res.pageCount} pages, ` +
      (res.referencesFound ? `bibliography found from page ${res.startPage}` : "no References heading found, scanned the whole document") +
      `, ${res.urls.length} links/DOIs`
  );
  const self = cleanUrl(tab.url);
  return res.urls.filter((u) => cleanUrl(u) !== self);
}

async function run(sourceTab) {
  log("started on", sourceTab.url);
  if (!(await pingZotero())) return;

  const rawUrls = await collectFromTab(sourceTab);
  const urls = dedupeLinks(rawUrls);
  claimedDois = new Set();
  lookupCounts = await countLookupEnabled();
  log(`Found ${rawUrls.length} links, ${urls.length} after removing duplicates` + (lookupCounts ? "; citation counts: on" : ""));

  const counts = { saved: 0, skipped: 0, failed: 0, duplicate: 0 };
  const retry = [];
  let next = 0;
  const worker = async () => {
    while (next < urls.length) {
      const url = urls[next++];
      const status = await processUrl(url);
      if (status === "skipped" || status === "failed") retry.push(url);
      else counts[status]++;
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  // Second pass, only for links the regular way could not handle.
  if (retry.length) log(`Retrying ${retry.length} links in a browser tab`);
  let r = 0, rescued = 0;
  const tabWorker = async () => {
    while (r < retry.length) {
      const status = await processInTab(retry[r++]);
      if (status === "saved") rescued++;
      counts[status]++;
    }
  };
  await Promise.all(Array.from({ length: TAB_CONCURRENCY }, tabWorker));
  log("Done:", JSON.stringify({ ...counts, rescuedViaTab: rescued }));
}

browser.browserAction.onClicked.addListener((tab) => {
  browser.browserAction.setBadgeText({ text: "…" });
  run(tab)
    .catch((e) => log("run failed:", e && (e.message || e), e && e.stack))
    .finally(() => browser.browserAction.setBadgeText({ text: "" }));
});
