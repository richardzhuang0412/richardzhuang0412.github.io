// Service worker: toolbar button opens the side panel; right-click menu on
// images sends them to the studio.
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  chrome.contextMenus.create({ id: "tryon-image", title: "👗 试穿这件", contexts: ["image"] });
  chrome.contextMenus.create({ id: "tryon-page", title: "👗 把这个商品加入试衣间", contexts: ["page", "link"] });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  // Ask the content script for page context (title / price / category), then
  // let it push the item and open the in-page panel.
  const msg = info.menuItemId === "tryon-image" ? { type: "tryon-add", imageUrl: info.srcUrl } : { type: "tryon-add-page", linkUrl: info.linkUrl };
  try {
    await chrome.tabs.sendMessage(tab.id, msg);
  } catch (e) {
    // Content script not present (e.g. chrome:// pages or before reload): store directly + open side panel.
    if (info.srcUrl) {
      const id = "inbox:" + Date.now().toString(36);
      await chrome.storage.local.set({ [id]: { imageUrl: info.srcUrl, pageUrl: info.pageUrl, title: tab && tab.title, wear: true, t: Date.now() } });
    }
    chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg && msg.type === "open-side-panel" && sender.tab) chrome.sidePanel.open({ windowId: sender.tab.windowId }).catch(() => {});
});
