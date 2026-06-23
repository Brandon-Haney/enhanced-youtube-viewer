// Service worker that re-injects content script on YouTube watch pages.
// Handles the case where the extension is installed/updated/reloaded
// while YouTube tabs are already open (content_scripts only runs on fresh loads).

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    // Only act when the page finishes loading on a YouTube watch page
    if (changeInfo.status !== 'complete') return;
    if (!tab.url) return;
    // Parse the URL rather than substring-matching, so a spoofed URL like
    // https://evil.com/?x=youtube.com/watch can't satisfy the gate.
    let url;
    try {
        url = new URL(tab.url);
    } catch {
        return;
    }
    if (url.hostname !== 'youtube.com' && !url.hostname.endsWith('.youtube.com')) return;
    if (url.pathname !== '/watch') return;

    chrome.scripting.executeScript({
        target: { tabId },
        files: ['content.js']
    }).catch(() => {
        // Silently ignore errors (restricted pages, discarded tabs, etc.)
    });
});
