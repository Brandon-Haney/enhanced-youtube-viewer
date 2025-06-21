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

    // Load saved preferences for all settings
    chrome.storage.local.get(['defaultStickyEnabled', 'inactiveWhenPaused', 'inactiveAtEnd'], function(result) {
        console.log('[EYV Popup] Loaded settings:', result);
        if (defaultStickyToggle) {
            defaultStickyToggle.checked = !!result.defaultStickyEnabled;
        }
        if (inactiveWhenPausedToggle) {
            inactiveWhenPausedToggle.checked = !!result.inactiveWhenPaused;
        }
        if (inactiveAtEndToggle) {
            inactiveAtEndToggle.checked = !!result.inactiveAtEnd;
        }
    });

    // Save preference when 'defaultStickyToggle' changes
    if (defaultStickyToggle) {
        defaultStickyToggle.addEventListener('change', function() {
            const isEnabled = defaultStickyToggle.checked;
            chrome.storage.local.set({defaultStickyEnabled: isEnabled}, function() {
                if (chrome.runtime.lastError) {
                    console.error('[EYV Popup] Error saving setting:', chrome.runtime.lastError);
                } else {
                    console.log('[EYV Popup] defaultStickyEnabled preference saved.');
                }
            });
        });
    }

    // Save preference when 'inactiveWhenPausedToggle' changes
    if (inactiveWhenPausedToggle) {
        inactiveWhenPausedToggle.addEventListener('change', function() {
            const isEnabled = inactiveWhenPausedToggle.checked;
            chrome.storage.local.set({inactiveWhenPaused: isEnabled}, function() {
                 if (chrome.runtime.lastError) {
                    console.error('[EYV Popup] Error saving setting:', chrome.runtime.lastError);
                } else {
                    console.log('[EYV Popup] inactiveWhenPaused preference saved.');
                }
            });
        });
    }

    // Save preference when 'inactiveAtEndToggle' changes
    if (inactiveAtEndToggle) {
        inactiveAtEndToggle.addEventListener('change', function() {
            const isEnabled = inactiveAtEndToggle.checked;
            chrome.storage.local.set({inactiveAtEnd: isEnabled}, function() {
                 if (chrome.runtime.lastError) {
                    console.error('[EYV Popup] Error saving setting:', chrome.runtime.lastError);
                } else {
                    console.log('[EYV Popup] inactiveAtEnd preference saved.');
                }
            });
        });
    }
});