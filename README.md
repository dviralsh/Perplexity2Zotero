# Perplexity2Zotero

Firefox extension: click the toolbar button on any page (e.g. a Perplexity thread) and it opens
each link in a background tab, asks your installed Zotero Connector to save it, and closes the tab.
Pages the Connector can't handle are simply not saved. No filtering is done by this extension.

## Try it
`about:debugging` → This Firefox → Load Temporary Add-on → `extension/manifest.json`.
Open the Browser Console (Ctrl+Shift+J) to see per-link results.

## Known risk
The Zotero Connector has no documented API for other extensions. `saveWithConnector` in
`extension/background.js` sends a guessed message; if the Connector ignores it, the console will
show failures and that function is the only thing to change (e.g. a different message, or
falling back to keeping tabs open for manual saving).
