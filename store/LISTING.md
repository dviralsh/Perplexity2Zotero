# Add-on store submission text (AMO)

Do not mention a model or tool vendor anywhere in these fields.

## Name
Perplexity2Zotero
(If Mozilla objects to the trademarks in the name, use "Page Links to Zotero" and state in the
description that the add-on is not affiliated with Zotero or Perplexity.)

## Summary (max 250 chars)
Click the button on any page (e.g. an AI answer with citations) and every linked paper is saved into your Zotero library, with metadata and PDF when available. Non-paper links are skipped.

## Description
Perplexity2Zotero saves all the papers linked from the page you are viewing into Zotero in one click.

How it works
- Click the toolbar button. The add-on reads the external links on the current page.
- Each link is opened in the background (using your own browser session, so subscribed sites work) and its citation metadata (the standard citation_* tags used by publishers and Google Scholar) is read.
- Papers are sent to the Zotero desktop app running on your computer, with the PDF attached when it is accessible. Bare PDF links are added as PDFs and Zotero identifies them itself.
- Links that are not papers (home pages, GitHub, blogs) have no citation data and are skipped, so only real, existing sources are added.
- Duplicate links to the same paper are merged.

Requirements
- Zotero desktop must be running. Select the collection you want first; items are saved into the currently selected collection.

Limits
- Some publishers block automated access or show a login page; those papers are saved without a PDF or skipped.
- It checks that a source exists and has citation data, not that it supports the claim it was cited for.

Privacy
- The add-on contacts only the pages linked from the page you click on, and Zotero on your own computer (127.0.0.1:23119).
- It collects no data and sends nothing to the developer or any other service.

Not affiliated with Zotero or Perplexity.

## Category
Other (or "Search Tools")

## Version notes (0.1.6)
First public release. Click the toolbar button to save all papers linked from the current page into the running Zotero desktop app.

## Notes to reviewer
No account or login is needed to test. The add-on sends no data to the developer or to any server of ours.

What it does: on toolbar-button click it reads the links of the active tab, fetches each linked page with fetch() (credentials included so the user's own subscriptions work), parses the <meta name="citation_*"> tags, and POSTs the result to the Zotero desktop app's local connector server at http://127.0.0.1:23119/connector/ (saveItems, saveAttachment, saveStandaloneAttachment, ping). For links the plain fetch cannot read, it loads the page in a temporary background tab, reads the rendered DOM with tabs.executeScript, and closes the tab. It calls no other third-party service.

Permissions: <all_urls> is needed to fetch arbitrary linked publisher pages, to read the rendered page in the fallback tab, and to reach 127.0.0.1:23119. activeTab is used to read the links on the page where the user clicked.

Data collection: data_collection_permissions is "none" because nothing is transmitted to the developer or to any third party; page content read from linked pages is sent only to the user's local Zotero.

To test: install the free Zotero desktop app (https://www.zotero.org/download/) and keep it running. Open a page that links to papers, e.g. https://arxiv.org/list/cs.CL/recent, and click the toolbar button. Papers appear in Zotero; progress is logged in the add-on's console (about:debugging -> Inspect), lines starting with [P2Z].

Source: plain unminified JavaScript, no build step. The submitted zip is the contents of extension/ unchanged.

## Source code question
"Do you use code generators, minifiers, bundlers, template engines or any tool that processes files?" -> No.
