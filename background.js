// Service worker that re-injects content script on YouTube watch pages.
// Handles the case where the extension is installed/updated/reloaded
// while YouTube tabs are already open (content_scripts only runs on fresh loads).

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    // Only act when the page finishes loading on a YouTube watch page
    if (changeInfo.status !== 'complete') return;
    if (!tab.url || !tab.url.includes('youtube.com/watch')) return;

    chrome.scripting.executeScript({
        target: { tabId },
        files: ['content.js']
    }).catch(() => {
        // Silently ignore errors (restricted pages, discarded tabs, etc.)
    });
});
