chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    // Check if the URL is a YouTube watch page and the tab is completely loaded
    if (tab.url && tab.url.includes("youtube.com/watch") && changeInfo.status === 'complete') {
        console.log("[BG SCRIPT] YouTube watch page update complete. Injecting content script for tab:", tabId, "URL:", tab.url);
        
        chrome.scripting.executeScript(
            {
                target: { tabId: tabId },
                files: ["content.js"]
            },
            () => {
                if (chrome.runtime.lastError) {
                    if (chrome.runtime.lastError.message.includes("Cannot access a chrome:// URL") || 
                        chrome.runtime.lastError.message.includes("No tab with id") ||
                        chrome.runtime.lastError.message.includes("The tab was closed") ||
                        chrome.runtime.lastError.message.includes("Cannot access contents of page")) {
                    } else {
                        console.error("[BG SCRIPT] ERROR INJECTING content.js: ", chrome.runtime.lastError.message);
                    }
                } else {
                    console.log("[BG SCRIPT] SUCCESS: content.js injected into tab:", tabId);
                }
            }
        );
    } 
});