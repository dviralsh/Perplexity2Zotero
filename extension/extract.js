// Finds the links in a PDF's bibliography using PDF.js (lib/pdf.min.js).
// Collects clickable link annotations plus DOIs, arXiv ids and URLs printed as plain text,
// starting at the "References" heading (or from page 1 if no heading is found).

const REF_HEADING = /^(?:\d+(?:\.\d+)*\.?\s*|[ivxlc]+\.\s*)?(?:references|bibliography|literature cited|works cited|reference list)\s*:?$/i;
const DOI_TEXT_RE = /\b10\.\d{4,9}\/[^\s"<>]+/g;
const ARXIV_TEXT_RE = /arxiv\s*:?\s*(\d{4}\.\d{4,5})(?:v\d+)?/gi;
const URL_TEXT_RE = /https?:\/\/[^\s"<>]+/g;

// Trailing punctuation is not part of an identifier; keep a closing bracket only if it is balanced.
function trimIdentifier(s) {
  s = s.replace(/[.,;:'"\]}]+$/, "");
  while (s.endsWith(")") && (s.match(/\)/g) || []).length > (s.match(/\(/g) || []).length) s = s.slice(0, -1);
  return s.replace(/[.,;:]+$/, "");
}

// Page text as lines; a line ending in "-", "/" or "_" is glued to the next so wrapped DOIs/URLs stay whole.
function pageLines(textContent) {
  const lines = [];
  let cur = "";
  for (const it of textContent.items) {
    cur += it.str;
    if (it.hasEOL) { lines.push(cur); cur = ""; }
  }
  if (cur) lines.push(cur);
  return lines;
}

function joinWrapped(lines) {
  let out = "";
  lines.forEach((l, i) => {
    const t = l.trim();
    if (i > 0 && !/[-/_]$/.test(lines[i - 1].trim())) out += "\n";
    out += t;
  });
  return out;
}

async function extractReferenceLinks(pdfjsLib, data) {
  const doc = await pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const [annots, text] = await Promise.all([page.getAnnotations(), page.getTextContent()]);
    const lines = pageLines(text);
    pages.push({
      lines,
      hasHeading: lines.some((l) => REF_HEADING.test(l.trim())),
      links: annots.filter((a) => a.subtype === "Link" && (a.url || a.unsafeUrl)).map((a) => a.url || a.unsafeUrl),
    });
  }
  await doc.destroy();

  // First "References" heading in the latter part of the document (skips a table of contents),
  // else the last heading found, else the whole document.
  const candidates = pages.map((p, i) => (p.hasHeading ? i : -1)).filter((i) => i >= 0);
  const floor = Math.floor(pages.length * 0.3);
  const start = candidates.length ? (candidates.find((i) => i >= floor) ?? candidates[candidates.length - 1]) : 0;

  const found = new Set();
  for (const p of pages.slice(start)) {
    p.links.forEach((u) => found.add(u));
    const text = joinWrapped(p.lines);
    for (const m of text.match(DOI_TEXT_RE) || []) found.add("https://doi.org/" + trimIdentifier(m));
    for (const m of text.matchAll(ARXIV_TEXT_RE)) found.add("https://arxiv.org/abs/" + m[1]);
    for (const m of text.match(URL_TEXT_RE) || []) found.add(trimIdentifier(m));
  }
  const urls = [...found].filter((u) => /^https?:\/\//i.test(u));
  return { urls, referencesFound: candidates.length > 0, startPage: start + 1, pageCount: pages.length };
}

if (typeof module !== "undefined") module.exports = { extractReferenceLinks, trimIdentifier };
