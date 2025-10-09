document.addEventListener('DOMContentLoaded', function() {
    // --- CONSTANTS ---
    const DEBUG = false; // Set to true to enable debug logging
    const DEBOUNCE_MS = 150; // Debounce storage writes to prevent race conditions

    // Check Chrome API availability (all required APIs)
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.storage || !chrome.tabs) {
        console.error('[EYV Popup] Chrome API not available');
        return;
    }

    const defaultStickyToggle = document.getElementById('defaultStickyToggle');
    const inactiveWhenPausedToggle = document.getElementById('inactiveWhenPausedToggle');
    const inactiveAtEndToggle = document.getElementById('inactiveAtEndToggle');
    const footerVersion = document.querySelector('footer p');
    const saveIndicator = document.getElementById('saveIndicator');

    // Validate critical DOM elements exist
    if (!defaultStickyToggle || !inactiveWhenPausedToggle || !inactiveAtEndToggle) {
        console.error('[EYV Popup] Critical DOM elements missing');
        return;
    }

    // Function to show save confirmation
    function showSaveConfirmation() {
        if (saveIndicator) {
            saveIndicator.style.display = 'block';
            setTimeout(() => {
                saveIndicator.style.display = 'none';
            }, 2000);
        }
    }

    // Helper to check if Chrome context is still valid
    function isChromeContextValid() {
        if (!chrome.runtime?.id) {
            console.error('[EYV Popup] Chrome context invalidated during storage operation');
            return false;
        }
        return true;
    }

    // Helper to wrap storage operations with timeout (5 second max)
    function storageWithTimeout(operation, timeoutMs = 5000) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new Error('Storage operation timed out'));
            }, timeoutMs);

            operation()
                .then(result => {
                    clearTimeout(timer);
                    resolve(result);
                })
                .catch(error => {
                    clearTimeout(timer);
                    reject(error);
                });
        });
    }

    // Debounce timers for settings to prevent write race conditions
    let defaultStickyTimer = null;
    let inactiveWhenPausedTimer = null;
    let inactiveAtEndTimer = null;

    // Set version dynamically with error handling
    if (footerVersion) {
        try {
            const version = chrome.runtime.getManifest().version;
            footerVersion.textContent = `Version ${version}`;
        } catch (error) {
            console.error('[EYV Popup] Failed to get manifest version:', error);
            footerVersion.textContent = 'Version: Error';
        }
    }

    // Function to message the content script with validation
    // Sends to ALL YouTube watch tabs to keep state synchronized across tabs
    function sendMessageToContentScript(message) {
        chrome.tabs.query({url: "*://*.youtube.com/watch*"}, function(tabs) {
            if (chrome.runtime.lastError) {
                console.error('[EYV Popup] Query error:', chrome.runtime.lastError);
                return;
            }
            if (tabs.length === 0) {
                console.warn('[EYV Popup] No YouTube watch page found');
                return;
            }

            // Send message to all YouTube watch tabs
            let successCount = 0;
            tabs.forEach(tab => {
                // Skip tabs that are still loading
                if (tab.status !== 'complete') {
                    if (DEBUG) console.log(`[EYV Popup] Skipping tab ${tab.id} - still loading`);
                    return;
                }

                chrome.tabs.sendMessage(tab.id, message, (response) => {
                    if (chrome.runtime.lastError) {
                        console.warn(`[EYV Popup] Message error for tab ${tab.id}:`, chrome.runtime.lastError.message);
                    } else if (response && response.status === 'ok') {
                        successCount++;
                        if (DEBUG) console.log(`[EYV Popup] Message sent successfully to tab ${tab.id}`);
                    }
                });
            });

            if (successCount === 0 && tabs.length > 0) {
                console.warn('[EYV Popup] Content script may not be loaded in any tabs. Try refreshing.');
            }
        });
    }

    // Load saved preferences for all settings with explicit defaults
    storageWithTimeout(() => {
        return new Promise((resolve, reject) => {
            chrome.storage.local.get({
                defaultStickyEnabled: false,
                inactiveWhenPaused: false,
                inactiveAtEnd: false
            }, function(result) {
                if (chrome.runtime.lastError) {
                    reject(chrome.runtime.lastError);
                } else {
                    resolve(result);
                }
            });
        });
    })
    .then(result => {
        // Double-check Chrome context is still valid after async callback
        if (!isChromeContextValid()) {
            return;
        }
        console.log('[EYV Popup] Loaded settings:', result);
        defaultStickyToggle.checked = result.defaultStickyEnabled;
        inactiveWhenPausedToggle.checked = result.inactiveWhenPaused;
        inactiveAtEndToggle.checked = result.inactiveAtEnd;
    })
    .catch(error => {
        console.error('[EYV Popup] Storage error or timeout:', error);
        alert('Failed to load settings. Please refresh the popup.');
    });

    // Save preference when 'defaultStickyToggle' changes
    if (defaultStickyToggle) {
        defaultStickyToggle.addEventListener('change', function() {
            const newValue = this.checked;
            const toggle = this;

            // Debounce to prevent rapid concurrent writes
            if (defaultStickyTimer) clearTimeout(defaultStickyTimer);
            defaultStickyTimer = setTimeout(() => {
                storageWithTimeout(() => {
                    return new Promise((resolve, reject) => {
                        chrome.storage.local.set({defaultStickyEnabled: newValue}, () => {
                            if (chrome.runtime.lastError) {
                                reject(chrome.runtime.lastError);
                            } else {
                                resolve();
                            }
                        });
                    });
                })
                .then(() => {
                    // Double-check Chrome context is still valid after async callback
                    if (!isChromeContextValid()) {
                        toggle.checked = !newValue; // Revert UI on error
                        return;
                    }
                    showSaveConfirmation();
                })
                .catch(error => {
                    console.error('[EYV Popup] Storage error or timeout:', error);
                    toggle.checked = !newValue; // Revert UI on error
                    // Check for quota errors
                    if (error.message && error.message.includes('QUOTA')) {
                        alert('Storage quota exceeded. Please clear some browser data or disable other extensions.');
                    } else if (error.message && error.message.includes('timeout')) {
                        alert('Storage operation timed out. Please try again.');
                    }
                });
            }, DEBOUNCE_MS);
        });
    }

    // Save preference when 'inactiveWhenPausedToggle' changes
    if (inactiveWhenPausedToggle) {
        inactiveWhenPausedToggle.addEventListener('change', function() {
            const newValue = this.checked;
            const toggle = this;

            // Debounce to prevent rapid concurrent writes
            if (inactiveWhenPausedTimer) clearTimeout(inactiveWhenPausedTimer);
            inactiveWhenPausedTimer = setTimeout(() => {
                storageWithTimeout(() => {
                    return new Promise((resolve, reject) => {
                        chrome.storage.local.set({inactiveWhenPaused: newValue}, () => {
                            if (chrome.runtime.lastError) {
                                reject(chrome.runtime.lastError);
                            } else {
                                resolve();
                            }
                        });
                    });
                })
                .then(() => {
                    // Double-check Chrome context is still valid after async callback
                    if (!isChromeContextValid()) {
                        toggle.checked = !newValue; // Revert UI on error
                        return;
                    }
                    showSaveConfirmation();
                    sendMessageToContentScript({ type: "SETTING_CHANGED", key: 'inactiveWhenPaused', value: newValue });
                })
                .catch(error => {
                    console.error('[EYV Popup] Storage error or timeout:', error);
                    toggle.checked = !newValue; // Revert UI on error
                    // Check for quota errors
                    if (error.message && error.message.includes('QUOTA')) {
                        alert('Storage quota exceeded. Please clear some browser data or disable other extensions.');
                    } else if (error.message && error.message.includes('timeout')) {
                        alert('Storage operation timed out. Please try again.');
                    }
                });
            }, DEBOUNCE_MS);
        });
    }

    // Save preference when 'inactiveAtEndToggle' changes
    if (inactiveAtEndToggle) {
        inactiveAtEndToggle.addEventListener('change', function() {
            const newValue = this.checked;
            const toggle = this;

            // Debounce to prevent rapid concurrent writes
            if (inactiveAtEndTimer) clearTimeout(inactiveAtEndTimer);
            inactiveAtEndTimer = setTimeout(() => {
                storageWithTimeout(() => {
                    return new Promise((resolve, reject) => {
                        chrome.storage.local.set({inactiveAtEnd: newValue}, () => {
                            if (chrome.runtime.lastError) {
                                reject(chrome.runtime.lastError);
                            } else {
                                resolve();
                            }
                        });
                    });
                })
                .then(() => {
                    // Double-check Chrome context is still valid after async callback
                    if (!isChromeContextValid()) {
                        toggle.checked = !newValue; // Revert UI on error
                        return;
                    }
                    showSaveConfirmation();
                    sendMessageToContentScript({ type: "SETTING_CHANGED", key: 'inactiveAtEnd', value: newValue });
                })
                .catch(error => {
                    console.error('[EYV Popup] Storage error or timeout:', error);
                    toggle.checked = !newValue; // Revert UI on error
                    // Check for quota errors
                    if (error.message && error.message.includes('QUOTA')) {
                        alert('Storage quota exceeded. Please clear some browser data or disable other extensions.');
                    } else if (error.message && error.message.includes('timeout')) {
                        alert('Storage operation timed out. Please try again.');
                    }
                });
            }, DEBOUNCE_MS);
        });
    }
});