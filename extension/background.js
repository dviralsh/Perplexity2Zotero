// Clicking the toolbar button collects all external links on the active page, reads each
// page's citation metadata (the same <meta name="citation_*"> tags Zotero uses), and saves
// it into the running Zotero desktop app through its local connector port.
// Links with no citation metadata are skipped.

const ZOTERO = "http://127.0.0.1:23119/connector";
const CONCURRENCY = 4;
const FETCH_TIMEOUT_MS = 20000;

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

// arxiv.org/pdf/ID and /html/ID carry no metadata; the /abs/ page does.
function metadataUrl(url) {
  const m = url.match(/^https?:\/\/(?:www\.)?arxiv\.org\/(?:pdf|html)\/([^?#]+?)(?:\.pdf)?$/);
  return m ? `https://arxiv.org/abs/${m[1]}` : url;
}

async function fetchDoc(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { credentials: "include", signal: ctl.signal });
    if (!res.ok || !/html/.test(res.headers.get("content-type") || "")) return null;
    return new DOMParser().parseFromString(await res.text(), "text/html");
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
  if (pdf) item.attachments.push({ title: "Full Text PDF", url: pdf, mimeType: "application/pdf" });
  return item;
}

async function saveToZotero(item, pageUrl) {
  const res = await fetch(`${ZOTERO}/saveItems`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Zotero-Connector-API-Version": "3" },
    body: JSON.stringify({
      sessionID: Math.random().toString(36).slice(2),
      uri: pageUrl,
      items: [item],
    }),
  });
  if (!res.ok) throw new Error(`Zotero responded ${res.status}`);
}

async function processUrl(url) {
  try {
    const metaUrl = metadataUrl(url);
    const doc = await fetchDoc(metaUrl);
    const item = doc && buildItem(doc, metaUrl);
    if (!item) { log("skipped (no citation metadata)", url); return "skipped"; }
    await saveToZotero(item, metaUrl);
    log("saved", item.title);
    return "saved";
  } catch (e) {
    log("failed", url, e.message);
    return "failed";
  }
}

async function run(sourceTab) {
  log("started on", sourceTab.url);
  try {
    const ping = await fetch(`${ZOTERO}/ping`, { method: "POST" });
    if (!ping.ok) throw new Error(String(ping.status));
  } catch (e) {
    log("Zotero desktop not reachable on 127.0.0.1:23119 — is it running?", e.message);
    return;
  }

  const [urls] = await browser.tabs.executeScript(sourceTab.id, { code: `(${collectLinks})()` });
  log(`Found ${urls.length} external links`);

  const counts = { saved: 0, skipped: 0, failed: 0 };
  let next = 0;
  const worker = async () => {
    while (next < urls.length) counts[await processUrl(urls[next++])]++;
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  log("Done:", JSON.stringify(counts));
}

browser.browserAction.onClicked.addListener((tab) => {
  browser.browserAction.setBadgeText({ text: "…" });
  run(tab)
    .catch((e) => log("run failed:", e && (e.message || e), e && e.stack))
    .finally(() => browser.browserAction.setBadgeText({ text: "" }));
});
