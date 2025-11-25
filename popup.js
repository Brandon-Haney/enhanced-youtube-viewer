document.addEventListener('DOMContentLoaded', function() {
    // --- CONSTANTS ---
    const DEBUG = false; // Set to true to enable debug logging
    const DEBOUNCE_MS = 150; // Debounce storage writes to prevent race conditions

    // Check Chrome API availability (all required APIs)
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.storage || !chrome.tabs) {
        console.error('[EYV Popup] Chrome API not available');
        return;
    }

    // Get DOM elements
    const stickyPlayerCard = document.getElementById('stickyPlayerCard');
    const pipCard = document.getElementById('pipCard');
    const defaultStickyToggle = document.getElementById('defaultStickyToggle');
    const inactiveWhenPausedToggle = document.getElementById('inactiveWhenPausedToggle');
    const inactiveAtEndToggle = document.getElementById('inactiveAtEndToggle');
    const versionText = document.getElementById('versionText');
    const saveIndicator = document.getElementById('saveIndicator');

    // Validate critical DOM elements exist
    if (!stickyPlayerCard || !pipCard || !defaultStickyToggle || !inactiveWhenPausedToggle || !inactiveAtEndToggle) {
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
    // Uses a settled flag to prevent race condition between timeout and operation completion
    function storageWithTimeout(operation, timeoutMs = 5000) {
        return new Promise((resolve, reject) => {
            let settled = false;

            const timer = setTimeout(() => {
                if (!settled) {
                    settled = true;
                    reject(new Error('Storage operation timed out'));
                }
            }, timeoutMs);

            operation()
                .then(result => {
                    if (!settled) {
                        settled = true;
                        clearTimeout(timer);
                        resolve(result);
                    }
                })
                .catch(error => {
                    if (!settled) {
                        settled = true;
                        clearTimeout(timer);
                        reject(error);
                    }
                });
        });
    }

    // Debounce timers for settings to prevent write race conditions
    let defaultStickyTimer = null;
    let inactiveWhenPausedTimer = null;
    let inactiveAtEndTimer = null;

    // Set version dynamically with error handling
    if (versionText) {
        try {
            const version = chrome.runtime.getManifest().version;
            versionText.textContent = `v${version} • Active on YouTube`;
        } catch (error) {
            console.error('[EYV Popup] Failed to get manifest version:', error);
            versionText.textContent = 'v1.4 • Active on YouTube';
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
                if (DEBUG) console.log('[EYV Popup] No YouTube watch page currently open - settings saved for next page load');
                return;
            }

            // Send message to all YouTube watch tabs
            let successCount = 0;
            let completeTabsCount = 0;
            tabs.forEach(tab => {
                // Skip tabs that are still loading
                if (tab.status !== 'complete') {
                    if (DEBUG) console.log(`[EYV Popup] Skipping tab ${tab.id} - still loading`);
                    return;
                }

                completeTabsCount++;
                chrome.tabs.sendMessage(tab.id, message, (response) => {
                    if (chrome.runtime.lastError) {
                        if (DEBUG) console.log(`[EYV Popup] Tab ${tab.id} not ready:`, chrome.runtime.lastError.message);
                    } else if (response && response.status === 'ok') {
                        successCount++;
                        if (DEBUG) console.log(`[EYV Popup] Message sent successfully to tab ${tab.id}`);
                    }
                });
            });

            // Only warn if we had tabs to message but none responded
            if (DEBUG && successCount === 0 && completeTabsCount > 0) {
                console.log('[EYV Popup] Settings saved - will apply when you refresh YouTube pages');
            }
        });
    }

    // Update action card UI based on enabled state
    function updateActionCardUI(card, statusElement, isEnabled) {
        if (isEnabled) {
            card.classList.add('active');
            statusElement.textContent = 'Enabled';
        } else {
            card.classList.remove('active');
            statusElement.textContent = 'Disabled';
        }
    }

    // Load saved preferences for all settings with explicit defaults
    storageWithTimeout(() => {
        return new Promise((resolve, reject) => {
            chrome.storage.local.get({
                stickyPlayerEnabled: true,
                pipEnabled: true,
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

        // Update action cards with null checks
        const stickyStatus = stickyPlayerCard.querySelector('.action-status');
        const pipStatus = pipCard.querySelector('.action-status');
        if (!stickyStatus || !pipStatus) {
            console.error('[EYV Popup] Action status elements not found');
            return;
        }
        updateActionCardUI(stickyPlayerCard, stickyStatus, result.stickyPlayerEnabled);
        updateActionCardUI(pipCard, pipStatus, result.pipEnabled);

        // Update checkboxes
        defaultStickyToggle.checked = result.defaultStickyEnabled;
        inactiveWhenPausedToggle.checked = result.inactiveWhenPaused;
        inactiveAtEndToggle.checked = result.inactiveAtEnd;
    })
    .catch(error => {
        console.error('[EYV Popup] Storage error or timeout:', error);
        alert('Failed to load settings. Please refresh the popup.');
    });

    // Handle Sticky Player card click
    stickyPlayerCard.addEventListener('click', function() {
        const currentState = this.classList.contains('active');
        const newState = !currentState;
        const statusElement = this.querySelector('.action-status');

        // Update UI immediately for responsiveness
        updateActionCardUI(this, statusElement, newState);

        // Save to storage
        storageWithTimeout(() => {
            return new Promise((resolve, reject) => {
                chrome.storage.local.set({stickyPlayerEnabled: newState}, () => {
                    if (chrome.runtime.lastError) {
                        reject(chrome.runtime.lastError);
                    } else {
                        resolve();
                    }
                });
            });
        })
        .then(() => {
            if (!isChromeContextValid()) {
                updateActionCardUI(stickyPlayerCard, statusElement, !newState);
                return;
            }
            showSaveConfirmation();
            sendMessageToContentScript({ type: "FEATURE_TOGGLE", feature: 'stickyPlayer', enabled: newState });
        })
        .catch(error => {
            console.error('[EYV Popup] Storage error:', error);
            updateActionCardUI(stickyPlayerCard, statusElement, !newState);
            if (error.message && error.message.includes('QUOTA')) {
                alert('Storage quota exceeded. Please clear some browser data or disable other extensions.');
            }
        });
    });

    // Handle PiP card click
    pipCard.addEventListener('click', function() {
        const currentState = this.classList.contains('active');
        const newState = !currentState;
        const statusElement = this.querySelector('.action-status');

        // Update UI immediately for responsiveness
        updateActionCardUI(this, statusElement, newState);

        // Save to storage
        storageWithTimeout(() => {
            return new Promise((resolve, reject) => {
                chrome.storage.local.set({pipEnabled: newState}, () => {
                    if (chrome.runtime.lastError) {
                        reject(chrome.runtime.lastError);
                    } else {
                        resolve();
                    }
                });
            });
        })
        .then(() => {
            if (!isChromeContextValid()) {
                updateActionCardUI(pipCard, statusElement, !newState);
                return;
            }
            showSaveConfirmation();
            sendMessageToContentScript({ type: "FEATURE_TOGGLE", feature: 'pip', enabled: newState });
        })
        .catch(error => {
            console.error('[EYV Popup] Storage error:', error);
            updateActionCardUI(pipCard, statusElement, !newState);
            if (error.message && error.message.includes('QUOTA')) {
                alert('Storage quota exceeded. Please clear some browser data or disable other extensions.');
            }
        });
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
                    // Notify content script so it can immediately activate sticky if enabled
                    sendMessageToContentScript({ type: "SETTING_CHANGED", key: 'defaultStickyEnabled', value: newValue });
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
