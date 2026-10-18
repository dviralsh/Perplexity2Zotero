// Clicking the toolbar button collects all links on the active page, opens each
// in a background tab, asks the Zotero Connector to save it, then closes the tab.
// Pages the Connector cannot translate are simply not saved.

const CONCURRENCY = 3;
const SETTLE_MS = 2500;    // let the Connector's translators detect the page after load
const LOAD_TIMEOUT_MS = 30000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function collectLinks() {
  const seen = new Set();
  for (const a of document.querySelectorAll("a[href]")) {
    try {
      const u = new URL(a.href, location.href);
      if (!/^https?:$/.test(u.protocol)) continue;
      u.hash = "";
      seen.add(u.href);
    } catch (e) {}
  }
  seen.delete(location.href.split("#")[0]);
  return [...seen];
}

function waitForLoad(tabId) {
  return new Promise((resolve) => {
    const done = () => { browser.tabs.onUpdated.removeListener(onUpdated); clearTimeout(timer); resolve(); };
    const onUpdated = (id, info) => { if (id === tabId && info.status === "complete") done(); };
    const timer = setTimeout(done, LOAD_TIMEOUT_MS);
    browser.tabs.onUpdated.addListener(onUpdated);
    browser.tabs.get(tabId).then((t) => { if (t.status === "complete") done(); });
  });
}

// Finds the installed Zotero Connector so we can message it.
async function findConnector() {
  const all = await browser.management.getAll();
  return all.find((e) => /zotero/i.test(e.name) && e.type === "extension" && e.id !== browser.runtime.id);
}

// Asks the Connector to save the given tab. Returns true on success.
// NOTE: the Connector does not document an external API; the message shape below is a
// best guess and is the part most likely to need adjusting (see README).
async function saveWithConnector(connectorId, tab) {
  try {
    const res = await browser.runtime.sendMessage(connectorId, { command: "saveTab", tabId: tab.id, url: tab.url });
    console.log("[P2Z] Connector replied", tab.url, res);
    return true;
  } catch (e) {
    console.warn("[P2Z] Connector call failed", tab.url, e.message);
    return false;
  }
}

async function processUrl(connectorId, url, windowId) {
  const tab = await browser.tabs.create({ url, active: false, windowId });
  try {
    await waitForLoad(tab.id);
    await sleep(SETTLE_MS);
    return await saveWithConnector(connectorId, await browser.tabs.get(tab.id));
  } finally {
    await browser.tabs.remove(tab.id).catch(() => {});
  }
}

async function run(sourceTab) {
  console.log("[P2Z] started on", sourceTab.url);
  const connector = await findConnector();
  if (!connector) { console.error("[P2Z] Zotero Connector not found"); return; }
  console.log("[P2Z] using connector", connector.name, connector.id);

  const [urls] = await browser.tabs.executeScript(sourceTab.id, { code: `(${collectLinks})()` });
  console.log(`[P2Z] Found ${urls.length} links`);

  let next = 0, ok = 0;
  const worker = async () => {
    while (next < urls.length) {
      if (await processUrl(connector.id, urls[next++], sourceTab.windowId)) ok++;
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  console.log(`[P2Z] Done: ${ok}/${urls.length} calls succeeded`);
}

browser.browserAction.onClicked.addListener((tab) => {
  browser.browserAction.setBadgeText({ text: "…" });
  run(tab).catch((e) => console.error("[P2Z] run failed:", e && (e.message || e), e && e.stack)).finally(() => browser.browserAction.setBadgeText({ text: "" }));
});
