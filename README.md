# Cites Extractor

Firefox extension that saves papers into Zotero in one click. Click the toolbar button on:

- **a web page** (e.g. an AI answer with citations) - every external link on the page is checked, or
- **a PDF opened in Firefox** - the links, DOIs and arXiv ids in its bibliography are extracted and checked.

For each link it reads the page's `citation_*` meta tags (what Zotero's generic translator uses), saves
the paper to the running Zotero desktop app via its local connector port (`127.0.0.1:23119`), and
attaches the PDF when it is reachable. Links without citation metadata are skipped, as are duplicates.
Links the plain fetch cannot read are retried once in a temporary background tab.

The Zotero Connector itself cannot be called from another extension (tested: "Receiving end does
not exist"), so this talks to Zotero desktop directly.

## Try it
Start Zotero desktop (select the collection you want), then `about:debugging` -> This Firefox ->
Load Temporary Add-on -> `extension/manifest.json`. Click **Inspect** on the entry to see `[P2Z]` log lines.

## How the PDF mode works
`extension/extract.js` uses PDF.js (`extension/lib/`, unmodified, see `extension/lib/NOTICE.txt`) to read the
PDF. It starts at the "References" heading (or the whole document if none is found) and collects clickable
links plus DOIs, arXiv ids and URLs printed as text. Limits: scanned PDFs without a text layer have nothing
to read, and the heading detection is a heuristic.

## Privacy
The extension contacts only (1) the pages linked from the page or PDF you click on, and (2) Zotero desktop
on your own computer (`127.0.0.1:23119`). It does not use CrossRef, PubMed/NCBI, Unpaywall or any
other third-party lookup service, and sends nothing to the developer.
