document.addEventListener('DOMContentLoaded', function() {
    const defaultStickyToggle = document.getElementById('defaultStickyToggle');
    const footerVersion = document.querySelector('footer p');

    // Set version dynamically
    if (footerVersion) {
        const version = chrome.runtime.getManifest().version;
        footerVersion.textContent = `Version ${version}`;
    }

    // Load saved preference for default sticky mode
    chrome.storage.local.get(['defaultStickyEnabled'], function(result) {
        console.log('[EYV Popup] Loaded defaultStickyEnabled:', result.defaultStickyEnabled);
        if (defaultStickyToggle) {
            defaultStickyToggle.checked = !!result.defaultStickyEnabled;
        }
    });

    // Save preference when toggle changes
    if (defaultStickyToggle) {
        defaultStickyToggle.addEventListener('change', function() {
            const isEnabled = defaultStickyToggle.checked;
            console.log('[EYV Popup] defaultStickyEnabled changed to:', isEnabled);
            chrome.storage.local.set({defaultStickyEnabled: isEnabled}, function() {
                if (chrome.runtime.lastError) {
                    console.error('[EYV Popup] Error saving setting:', chrome.runtime.lastError);
                } else {
                    console.log('[EYV Popup] defaultStickyEnabled preference saved.');
                    chrome.tabs.query({active: true, currentWindow: true, url: "*://*.youtube.com/watch*"}, function(tabs) {
                        if (tabs.length > 0) {
                            chrome.tabs.sendMessage(tabs[0].id, {
                                type: "DEFAULT_STICKY_CHANGED",
                                enabled: isEnabled 
                            });
                        }
                    });
                }
            });
        });
    }
});