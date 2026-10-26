const box = document.getElementById("count");
const status = document.getElementById("status");

async function load() {
  const { countCitations } = await browser.storage.local.get("countCitations");
  const allowed = await browser.permissions.contains({ data_collection: ["browsingActivity"] }).catch(() => false);
  box.checked = !!countCitations && allowed;
}

box.addEventListener("change", async () => {
  status.textContent = "";
  try {
    if (box.checked) {
      // Firefox asks the user to agree to the optional data collection.
      const ok = await browser.permissions.request({ data_collection: ["browsingActivity"] });
      if (!ok) { box.checked = false; status.textContent = "Permission was not granted."; }
    }
    await browser.storage.local.set({ countCitations: box.checked });
  } catch (e) {
    box.checked = false;
    status.textContent = "Could not enable: " + e.message;
  }
});

load();
