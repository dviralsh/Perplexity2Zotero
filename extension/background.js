// Clicking the toolbar button collects all external links on the active page, reads each
// page's citation metadata (the same <meta name="citation_*"> tags Zotero uses), and saves
// it into the running Zotero desktop app through its local connector port.
// Links with no citation metadata are skipped.

const ZOTERO = "http://127.0.0.1:23119/connector";
const CONCURRENCY = 4;
const FETCH_TIMEOUT_MS = 10000;

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

const NCBI = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";

async function pubmedItem(pmid) {
  const res = await fetch(`${NCBI}/efetch.fcgi?db=pubmed&id=${pmid}&retmode=xml`);
  if (!res.ok) return null;
  const x = new DOMParser().parseFromString(await res.text(), "text/xml");
  const art = x.querySelector("PubmedArticle");
  if (!art) return null;
  const t = (sel) => (art.querySelector(sel) || {}).textContent || "";
  const creators = [...art.querySelectorAll("AuthorList > Author")].map((a) => {
    const last = (a.querySelector("LastName") || {}).textContent;
    return last
      ? { firstName: (a.querySelector("ForeName") || {}).textContent || "", lastName: last, creatorType: "author" }
      : { lastName: (a.querySelector("CollectiveName") || {}).textContent || "", creatorType: "author", fieldMode: 1 };
  });
  const doi = (art.querySelector('ELocationID[EIdType="doi"]') || art.querySelector('ArticleId[IdType="doi"]') || {}).textContent || "";
  const date = [t("JournalIssue PubDate Year"), t("JournalIssue PubDate Month"), t("JournalIssue PubDate Day")].filter(Boolean).join("-") || t("JournalIssue PubDate MedlineDate");
  return {
    id: Math.random().toString(36).slice(2),
    itemType: "journalArticle",
    title: t("ArticleTitle"),
    creators,
    date,
    DOI: doi,
    publicationTitle: t("Journal Title"),
    volume: t("JournalIssue Volume"),
    issue: t("JournalIssue Issue"),
    pages: t("Pagination MedlinePgn"),
    abstractNote: [...art.querySelectorAll("Abstract AbstractText")].map((e) => e.textContent).join("\n"),
    url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
    attachments: [],
  };
}

// PubMed / PubMed Central pages (often served an anti-bot page to scripts) via NCBI's public API.
async function itemFromNcbi(url) {
  const pm = url.match(/pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)/);
  if (pm) return pubmedItem(pm[1]);
  const pmc = url.match(/ncbi\.nlm\.nih\.gov\/(?:pmc\/)?articles\/(PMC\d+)/i);
  if (!pmc) return undefined; // not an NCBI link
  const res = await fetch(`https://pmc.ncbi.nlm.nih.gov/tools/idconv/api/v1/articles/?ids=${pmc[1]}&format=json`);
  if (!res.ok) return null;
  const rec = ((await res.json()).records || [])[0] || {};
  if (rec.pmid) return pubmedItem(rec.pmid);
  return rec.doi ? itemFromDoi(`https://doi.org/${rec.doi}`) : null;
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

// Fallback for pages without citation_* tags: a DOI in the URL, looked up on CrossRef.
async function itemFromDoi(url) {
  const m = decodeURIComponent(url).match(/10\.\d{4,9}\/[^\s?#]+/);
  if (!m) return null;
  const doi = m[0].replace(/[.,;)]+$/, "");
  const res = await fetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}`);
  if (!res.ok) return null;
  const w = (await res.json()).message;
  if (!w.title || !w.title[0]) return null;
  const parts = (w.issued && w.issued["date-parts"] && w.issued["date-parts"][0]) || [];
  const itemType = { "journal-article": "journalArticle", "proceedings-article": "conferencePaper", "posted-content": "preprint" }[w.type];
  if (!itemType) return null;
  const item = {
    id: Math.random().toString(36).slice(2),
    itemType,
    title: w.title[0],
    creators: (w.author || []).map((a) => ({ firstName: a.given || "", lastName: a.family || a.name || "", creatorType: "author" })),
    date: parts.join("-"),
    DOI: w.DOI,
    url: w.URL,
    attachments: [],
  };
  const venue = (w["container-title"] || [])[0] || "";
  if (itemType === "conferencePaper") item.proceedingsTitle = venue;
  else if (itemType === "journalArticle") Object.assign(item, { publicationTitle: venue, volume: w.volume || "", issue: w.issue || "", pages: w.page || "" });
  return item;
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

async function saveOnce(item, pageUrl) {
  const doi = (item.DOI || "").toLowerCase();
  if (doi) {
    if (claimedDois.has(doi)) { log("skipped (duplicate DOI)", item.title); return "skipped"; }
    claimedDois.add(doi);
  }
  await saveToZotero(item, pageUrl);
  log("saved", item.title);
  return "saved";
}

async function processUrl(url) {
  try {
    const metaUrl = metadataUrl(url);
    const ncbi = await itemFromNcbi(metaUrl);
    if (ncbi !== undefined) {
      if (!ncbi || !ncbi.title) { log("skipped (NCBI lookup found nothing)", url); return "skipped"; }
      return await saveOnce(ncbi, metaUrl);
    }
    const page = await fetchPage(metaUrl);
    if (!page) { log("skipped (unreachable / not HTML or PDF)", url); return "skipped"; }
    if (page.pdf) {
      await saveStandalonePdf(page.pdf, metaUrl);
      log("saved PDF (Zotero will retrieve metadata)", url);
      return "saved";
    }
    const item = buildItem(page.doc, metaUrl) || (await itemFromDoi(metaUrl));
    if (!item) { log("skipped (no citation metadata)", url); return "skipped"; }
    return await saveOnce(item, metaUrl);
  } catch (e) {
    log("failed", url, e.message);
    return "failed";
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

async function run(sourceTab) {
  log("started on", sourceTab.url);
  if (!(await pingZotero())) return;

  const [rawUrls] = await browser.tabs.executeScript(sourceTab.id, { code: `(${collectLinks})()` });
  const urls = dedupeLinks(rawUrls);
  claimedDois = new Set();
  log(`Found ${rawUrls.length} external links, ${urls.length} after removing duplicates`);

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
