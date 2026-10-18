# Perplexity2Zotero

Firefox extension: click the toolbar button on any page (e.g. a Perplexity thread). It collects the
external links, reads each page's `citation_*` meta tags (what the Zotero Connector's generic
translator uses), and saves the result to the running Zotero desktop app via its local connector
port (`127.0.0.1:23119`). Links without citation metadata are skipped.

The Zotero Connector itself cannot be called from another extension (tested: "Receiving end does
not exist"), so this talks to Zotero desktop directly.

## Try it
Start Zotero desktop, then `about:debugging` → This Firefox → Load Temporary Add-on →
`extension/manifest.json`. Click **Inspect** on the entry to see `[P2Z]` log lines.
Items land in whichever collection is selected in Zotero.

## Privacy
The extension contacts only (1) the pages linked from the page you click on, and (2) Zotero desktop
on your own computer (`127.0.0.1:23119`). It does not use CrossRef, PubMed/NCBI, Unpaywall or any
other third-party lookup service, and sends nothing to the developer.
