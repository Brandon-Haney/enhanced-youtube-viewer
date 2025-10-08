document.addEventListener('DOMContentLoaded', function() {
    // Check Chrome API availability
    if (typeof chrome === 'undefined' || !chrome.runtime) {
        console.error('[EYV Popup] Chrome API not available');
        return;
    }

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
            if (chrome.runtime.lastError) {
                console.error('[EYV Popup] Query error:', chrome.runtime.lastError);
                return;
            }
            if (tabs.length > 0) {
                chrome.tabs.sendMessage(tabs[0].id, message, (response) => {
                    if (chrome.runtime.lastError) {
                        console.error('[EYV Popup] Message error:', chrome.runtime.lastError.message);
                    } else if (response && response.status === 'ok') {
                        if (console.log) console.log('[EYV Popup] Message sent successfully');
                    }
                });
            }
        });
    }

    // Load saved preferences for all settings
    chrome.storage.local.get(['defaultStickyEnabled', 'inactiveWhenPaused', 'inactiveAtEnd'], function(result) {
        if (chrome.runtime.lastError) {
            console.error('[EYV Popup] Storage error:', chrome.runtime.lastError);
            return;
        }
        console.log('[EYV Popup] Loaded settings:', result);
        if (defaultStickyToggle) defaultStickyToggle.checked = !!(result && result.defaultStickyEnabled);
        if (inactiveWhenPausedToggle) inactiveWhenPausedToggle.checked = !!(result && result.inactiveWhenPaused);
        if (inactiveAtEndToggle) inactiveAtEndToggle.checked = !!(result && result.inactiveAtEnd);
    });

    // Save preference when 'defaultStickyToggle' changes
    if (defaultStickyToggle) {
        defaultStickyToggle.addEventListener('change', function() {
            chrome.storage.local.set({defaultStickyEnabled: this.checked}, () => {
                if (chrome.runtime.lastError) {
                    console.error('[EYV Popup] Storage error:', chrome.runtime.lastError);
                }
            });
        });
    }

    // Save preference when 'inactiveWhenPausedToggle' changes
    if (inactiveWhenPausedToggle) {
        inactiveWhenPausedToggle.addEventListener('change', function() {
            chrome.storage.local.set({inactiveWhenPaused: this.checked}, () => {
                if (chrome.runtime.lastError) {
                    console.error('[EYV Popup] Storage error:', chrome.runtime.lastError);
                    return;
                }
                sendMessageToContentScript({ type: "SETTING_CHANGED", key: 'inactiveWhenPaused', value: this.checked });
            });
        });
    }

    // Save preference when 'inactiveAtEndToggle' changes
    if (inactiveAtEndToggle) {
        inactiveAtEndToggle.addEventListener('change', function() {
            chrome.storage.local.set({inactiveAtEnd: this.checked}, () => {
                if (chrome.runtime.lastError) {
                    console.error('[EYV Popup] Storage error:', chrome.runtime.lastError);
                    return;
                }
                sendMessageToContentScript({ type: "SETTING_CHANGED", key: 'inactiveAtEnd', value: this.checked });
            });
        });
    }
});