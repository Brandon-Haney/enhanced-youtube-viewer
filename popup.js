document.addEventListener('DOMContentLoaded', function() {
    const defaultStickyToggle = document.getElementById('defaultStickyToggle');
    const inactiveWhenPausedToggle = document.getElementById('inactiveWhenPausedToggle');
    const inactiveAtEndToggle = document.getElementById('inactiveAtEndToggle');
    const footerVersion = document.querySelector('footer p');

    // Set version dynamically
    if (footerVersion) {
        const version = chrome.runtime.getManifest().version;
        footerVersion.textContent = `Version ${version}`;
    }

    // Function to message the content script
    function sendMessageToContentScript(message) {
        chrome.tabs.query({active: true, currentWindow: true, url: "*://*.youtube.com/watch*"}, function(tabs) {
            if (tabs.length > 0) {
                chrome.tabs.sendMessage(tabs[0].id, message);
            }
        });
    }

    // Load saved preferences for all settings
    chrome.storage.local.get(['defaultStickyEnabled', 'inactiveWhenPaused', 'inactiveAtEnd', 'stickySize'], function(result) {
        console.log('[EYV Popup] Loaded settings:', result);
        if (defaultStickyToggle) defaultStickyToggle.checked = !!result.defaultStickyEnabled;
        if (inactiveWhenPausedToggle) inactiveWhenPausedToggle.checked = !!result.inactiveWhenPaused;
        if (inactiveAtEndToggle) inactiveAtEndToggle.checked = !!result.inactiveAtEnd;
    });

    // Save preference when 'defaultStickyToggle' changes
    if (defaultStickyToggle) {
        defaultStickyToggle.addEventListener('change', function() {
            chrome.storage.local.set({defaultStickyEnabled: this.checked});
        });
    }

    // Save preference when 'inactiveWhenPausedToggle' changes
    if (inactiveWhenPausedToggle) {
        inactiveWhenPausedToggle.addEventListener('change', function() {
            chrome.storage.local.set({inactiveWhenPaused: this.checked}, () => {
                sendMessageToContentScript({ type: "SETTING_CHANGED", key: 'inactiveWhenPaused', value: this.checked });
            });
        });
    }

    // Save preference when 'inactiveAtEndToggle' changes
    if (inactiveAtEndToggle) {
        inactiveAtEndToggle.addEventListener('change', function() {
            chrome.storage.local.set({inactiveAtEnd: this.checked}, () => {
                sendMessageToContentScript({ type: "SETTING_CHANGED", key: 'inactiveAtEnd', value: this.checked });
            });
        });
    }
});