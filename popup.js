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
    const stickyOnScrollToggle = document.getElementById('stickyOnScrollToggle');
    const inactiveWhenPausedToggle = document.getElementById('inactiveWhenPausedToggle');
    const inactiveAtEndToggle = document.getElementById('inactiveAtEndToggle');
    const ambientTabGlowToggle = document.getElementById('ambientTabGlowToggle');
    const ambilightHaloToggle = document.getElementById('ambilightHaloToggle');
    const versionText = document.getElementById('versionText');
    const saveIndicator = document.getElementById('saveIndicator');

    // Validate critical DOM elements exist
    if (!stickyPlayerCard || !pipCard || !defaultStickyToggle || !stickyOnScrollToggle || !inactiveWhenPausedToggle || !inactiveAtEndToggle) {
        console.error('[EYV Popup] Critical DOM elements missing');
        return;
    }

    // Show a transient inline status message (non-blocking, replaces alert()).
    let statusHideTimer = null;
    function showStatus(message, isError = false) {
        if (!saveIndicator) return;
        saveIndicator.textContent = message;
        saveIndicator.classList.toggle('error', isError);
        saveIndicator.style.display = 'block';
        if (statusHideTimer) clearTimeout(statusHideTimer);
        statusHideTimer = setTimeout(() => {
            saveIndicator.style.display = 'none';
        }, isError ? 4000 : 2000);
    }

    // Function to show save confirmation
    function showSaveConfirmation() {
        showStatus('✓ Settings saved', false);
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
    let stickyOnScrollTimer = null;
    let inactiveWhenPausedTimer = null;
    let inactiveAtEndTimer = null;
    let ambientTabGlowTimer = null;
    let ambilightHaloTimer = null;

    // Set version dynamically with error handling
    if (versionText) {
        try {
            const version = chrome.runtime.getManifest().version;
            versionText.textContent = `v${version} • Active on YouTube`;
        } catch (error) {
            console.error('[EYV Popup] Failed to get manifest version:', error);
            versionText.textContent = 'Active on YouTube';
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
                stickyOnScroll: false,
                inactiveWhenPaused: false,
                inactiveAtEnd: false,
                ambientTabGlow: false,
                ambilightHalo: false,
                // DEV ambient-tuning slider values (defaults mirror DEV_AMBIENT in content.js).
                ambHaloGrow: 0.02,
                ambHaloBlur: 14,
                ambHaloOpacity: 0.7,
                ambTabSmoothing: 0.16,
                ambTabVibrancy: 0.6,
                ambTabGlowAlpha: 0.6,
                ambPulseSpeed: 2.4,
                ambPulseAmp: 16
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

        // Initialize checkboxes first - independent of the action-card status spans, so a
        // missing status span never leaves the toggles displaying their HTML default.
        defaultStickyToggle.checked = result.defaultStickyEnabled;
        stickyOnScrollToggle.checked = result.stickyOnScroll;
        inactiveWhenPausedToggle.checked = result.inactiveWhenPaused;
        inactiveAtEndToggle.checked = result.inactiveAtEnd;
        if (ambientTabGlowToggle) ambientTabGlowToggle.checked = result.ambientTabGlow;
        if (ambilightHaloToggle) ambilightHaloToggle.checked = result.ambilightHalo;
        setupAmbientSliders(result); // DEV: initialize ambient-tuning sliders from saved values

        // Update action cards with null checks
        const stickyStatus = stickyPlayerCard.querySelector('.action-status');
        const pipStatus = pipCard.querySelector('.action-status');
        if (!stickyStatus || !pipStatus) {
            console.error('[EYV Popup] Action status elements not found');
            return;
        }
        updateActionCardUI(stickyPlayerCard, stickyStatus, result.stickyPlayerEnabled);
        updateActionCardUI(pipCard, pipStatus, result.pipEnabled);
    })
    .catch(error => {
        console.error('[EYV Popup] Storage error or timeout:', error);
        showStatus('Failed to load settings. Please reopen the popup.', true);
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
            // The write already succeeded; if the context is now gone, just skip the
            // follow-up message/indicator. Do NOT revert the UI - the value is persisted.
            if (!isChromeContextValid()) return;
            showSaveConfirmation();
            sendMessageToContentScript({ type: "FEATURE_TOGGLE", feature: 'stickyPlayer', enabled: newState });
        })
        .catch(error => {
            console.error('[EYV Popup] Storage error:', error);
            updateActionCardUI(stickyPlayerCard, statusElement, !newState);
            if (error.message && error.message.includes('QUOTA')) {
                showStatus('Storage quota exceeded. Clear some browser data and try again.', true);
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
            // The write already succeeded; if the context is now gone, just skip the
            // follow-up message/indicator. Do NOT revert the UI - the value is persisted.
            if (!isChromeContextValid()) return;
            showSaveConfirmation();
            sendMessageToContentScript({ type: "FEATURE_TOGGLE", feature: 'pip', enabled: newState });
        })
        .catch(error => {
            console.error('[EYV Popup] Storage error:', error);
            updateActionCardUI(pipCard, statusElement, !newState);
            if (error.message && error.message.includes('QUOTA')) {
                showStatus('Storage quota exceeded. Clear some browser data and try again.', true);
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
                    // The write already succeeded; if the context is now gone, just skip
                    // the follow-up message/indicator. Do NOT revert - the value is saved.
                    if (!isChromeContextValid()) return;
                    showSaveConfirmation();
                    // Notify content script so it can immediately activate sticky if enabled
                    sendMessageToContentScript({ type: "SETTING_CHANGED", key: 'defaultStickyEnabled', value: newValue });
                })
                .catch(error => {
                    console.error('[EYV Popup] Storage error or timeout:', error);
                    toggle.checked = !newValue; // Revert UI - the write failed
                    if (error.message && error.message.includes('QUOTA')) {
                        showStatus('Storage quota exceeded. Clear some browser data and try again.', true);
                    } else if (error.message && error.message.includes('timeout')) {
                        showStatus('Storage operation timed out. Please try again.', true);
                    }
                });
            }, DEBOUNCE_MS);
        });
    }

    // Save preference when 'stickyOnScrollToggle' changes
    if (stickyOnScrollToggle) {
        stickyOnScrollToggle.addEventListener('change', function() {
            const newValue = this.checked;
            const toggle = this;

            // Debounce to prevent rapid concurrent writes
            if (stickyOnScrollTimer) clearTimeout(stickyOnScrollTimer);
            stickyOnScrollTimer = setTimeout(() => {
                storageWithTimeout(() => {
                    return new Promise((resolve, reject) => {
                        chrome.storage.local.set({stickyOnScroll: newValue}, () => {
                            if (chrome.runtime.lastError) {
                                reject(chrome.runtime.lastError);
                            } else {
                                resolve();
                            }
                        });
                    });
                })
                .then(() => {
                    // The write already succeeded; if the context is now gone, just skip
                    // the follow-up message/indicator. Do NOT revert - the value is saved.
                    if (!isChromeContextValid()) return;
                    showSaveConfirmation();
                    sendMessageToContentScript({ type: "SETTING_CHANGED", key: 'stickyOnScroll', value: newValue });
                })
                .catch(error => {
                    console.error('[EYV Popup] Storage error or timeout:', error);
                    toggle.checked = !newValue; // Revert UI - the write failed
                    if (error.message && error.message.includes('QUOTA')) {
                        showStatus('Storage quota exceeded. Clear some browser data and try again.', true);
                    } else if (error.message && error.message.includes('timeout')) {
                        showStatus('Storage operation timed out. Please try again.', true);
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
                    // The write already succeeded; if the context is now gone, just skip
                    // the follow-up message/indicator. Do NOT revert - the value is saved.
                    if (!isChromeContextValid()) return;
                    showSaveConfirmation();
                    sendMessageToContentScript({ type: "SETTING_CHANGED", key: 'inactiveWhenPaused', value: newValue });
                })
                .catch(error => {
                    console.error('[EYV Popup] Storage error or timeout:', error);
                    toggle.checked = !newValue; // Revert UI - the write failed
                    if (error.message && error.message.includes('QUOTA')) {
                        showStatus('Storage quota exceeded. Clear some browser data and try again.', true);
                    } else if (error.message && error.message.includes('timeout')) {
                        showStatus('Storage operation timed out. Please try again.', true);
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
                    // The write already succeeded; if the context is now gone, just skip
                    // the follow-up message/indicator. Do NOT revert - the value is saved.
                    if (!isChromeContextValid()) return;
                    showSaveConfirmation();
                    sendMessageToContentScript({ type: "SETTING_CHANGED", key: 'inactiveAtEnd', value: newValue });
                })
                .catch(error => {
                    console.error('[EYV Popup] Storage error or timeout:', error);
                    toggle.checked = !newValue; // Revert UI - the write failed
                    if (error.message && error.message.includes('QUOTA')) {
                        showStatus('Storage quota exceeded. Clear some browser data and try again.', true);
                    } else if (error.message && error.message.includes('timeout')) {
                        showStatus('Storage operation timed out. Please try again.', true);
                    }
                });
            }, DEBOUNCE_MS);
        });
    }

    // Save preference when 'ambientTabGlowToggle' changes (dev/experimental)
    if (ambientTabGlowToggle) {
        ambientTabGlowToggle.addEventListener('change', function() {
            const newValue = this.checked;
            const toggle = this;

            // Debounce to prevent rapid concurrent writes
            if (ambientTabGlowTimer) clearTimeout(ambientTabGlowTimer);
            ambientTabGlowTimer = setTimeout(() => {
                storageWithTimeout(() => {
                    return new Promise((resolve, reject) => {
                        chrome.storage.local.set({ambientTabGlow: newValue}, () => {
                            if (chrome.runtime.lastError) {
                                reject(chrome.runtime.lastError);
                            } else {
                                resolve();
                            }
                        });
                    });
                })
                .then(() => {
                    if (!isChromeContextValid()) return;
                    showSaveConfirmation();
                    sendMessageToContentScript({ type: "SETTING_CHANGED", key: 'ambientTabGlow', value: newValue });
                })
                .catch(error => {
                    console.error('[EYV Popup] Storage error or timeout:', error);
                    toggle.checked = !newValue; // Revert UI - the write failed
                    if (error.message && error.message.includes('QUOTA')) {
                        showStatus('Storage quota exceeded. Clear some browser data and try again.', true);
                    } else if (error.message && error.message.includes('timeout')) {
                        showStatus('Storage operation timed out. Please try again.', true);
                    }
                });
            }, DEBOUNCE_MS);
        });
    }

    // Save preference when 'ambilightHaloToggle' changes (dev/experimental)
    if (ambilightHaloToggle) {
        ambilightHaloToggle.addEventListener('change', function() {
            const newValue = this.checked;
            const toggle = this;

            // Debounce to prevent rapid concurrent writes
            if (ambilightHaloTimer) clearTimeout(ambilightHaloTimer);
            ambilightHaloTimer = setTimeout(() => {
                storageWithTimeout(() => {
                    return new Promise((resolve, reject) => {
                        chrome.storage.local.set({ambilightHalo: newValue}, () => {
                            if (chrome.runtime.lastError) {
                                reject(chrome.runtime.lastError);
                            } else {
                                resolve();
                            }
                        });
                    });
                })
                .then(() => {
                    if (!isChromeContextValid()) return;
                    showSaveConfirmation();
                    sendMessageToContentScript({ type: "SETTING_CHANGED", key: 'ambilightHalo', value: newValue });
                })
                .catch(error => {
                    console.error('[EYV Popup] Storage error or timeout:', error);
                    toggle.checked = !newValue; // Revert UI - the write failed
                    if (error.message && error.message.includes('QUOTA')) {
                        showStatus('Storage quota exceeded. Clear some browser data and try again.', true);
                    } else if (error.message && error.message.includes('timeout')) {
                        showStatus('Storage operation timed out. Please try again.', true);
                    }
                });
            }, DEBOUNCE_MS);
        });
    }

    // --- DEV / Experimental: ambient-tuning sliders ----------------------------------------------
    // Live-preview while dragging (throttled SETTING_CHANGED messages), persist on a short debounce.
    // "Copy values" puts a ready-to-hardcode DEV_AMBIENT snippet on the clipboard. Remove this whole
    // block (and the markup/styles) once the chosen values are baked into content.js.
    const AMBIENT_SLIDERS = [
        { id: 'ambHaloGrowSlider',     key: 'ambHaloGrow',     field: 'haloGrow',     def: 0.02, dec: 3 },
        { id: 'ambHaloBlurSlider',     key: 'ambHaloBlur',     field: 'haloBlur',     def: 14,   dec: 0 },
        { id: 'ambHaloOpacitySlider',  key: 'ambHaloOpacity',  field: 'haloOpacity',  def: 0.7,  dec: 2 },
        { id: 'ambTabSmoothingSlider', key: 'ambTabSmoothing', field: 'tabSmoothing', def: 0.16, dec: 2 },
        { id: 'ambTabVibrancySlider',  key: 'ambTabVibrancy',  field: 'tabVibrancy',  def: 0.6,  dec: 2 },
        { id: 'ambTabGlowAlphaSlider', key: 'ambTabGlowAlpha', field: 'tabGlowAlpha', def: 0.6,  dec: 2 },
        { id: 'ambPulseSpeedSlider',   key: 'ambPulseSpeed',   field: 'pulseSpeed',   def: 2.4,  dec: 1 },
        { id: 'ambPulseAmpSlider',     key: 'ambPulseAmp',     field: 'pulseAmp',     def: 16,   dec: 0 }
    ];

    function setupAmbientSliders(saved) {
        AMBIENT_SLIDERS.forEach(cfg => {
            const slider = document.getElementById(cfg.id);
            if (!slider) return;
            const out = document.getElementById(cfg.id + 'Val');
            const savedVal = saved && saved[cfg.key];
            const initial = (savedVal != null && !Number.isNaN(Number(savedVal))) ? Number(savedVal) : cfg.def;
            slider.value = initial;
            if (out) out.textContent = Number(initial).toFixed(cfg.dec);

            let sendThrottle = null;
            let saveTimer = null;
            slider.addEventListener('input', function() {
                const value = Number(slider.value);
                if (out) out.textContent = value.toFixed(cfg.dec);

                // Live preview: throttle to ~25fps so a fast drag doesn't flood the content script.
                // Trailing edge reads slider.value at fire time, so the final value is always sent.
                if (sendThrottle == null) {
                    sendThrottle = setTimeout(() => {
                        sendThrottle = null;
                        sendMessageToContentScript({ type: 'SETTING_CHANGED', key: cfg.key, value: Number(slider.value) });
                    }, 40);
                }

                // Persist on a longer debounce (separate from the live preview).
                if (saveTimer) clearTimeout(saveTimer);
                saveTimer = setTimeout(() => {
                    if (!isChromeContextValid()) return;
                    chrome.storage.local.set({ [cfg.key]: Number(slider.value) }, () => {
                        if (chrome.runtime.lastError) console.error('[EYV Popup] Slider save failed:', chrome.runtime.lastError);
                    });
                }, 350);
            });
        });

        const copyBtn = document.getElementById('ambCopyValuesBtn');
        if (copyBtn) {
            copyBtn.addEventListener('click', function() {
                // Emit in the DEV_AMBIENT shape (content.js field names) for a direct paste.
                const dev = {};
                AMBIENT_SLIDERS.forEach(cfg => {
                    const slider = document.getElementById(cfg.id);
                    if (slider) dev[cfg.field] = Number(Number(slider.value).toFixed(cfg.dec));
                });
                const snippet = JSON.stringify(dev, null, 4);
                console.log('[EYV Popup] DEV_AMBIENT values:\n' + snippet);
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(snippet)
                        .then(() => showStatus('✓ Copied tuning values to clipboard'))
                        .catch(() => showStatus('Copy failed — values logged to console', true));
                } else {
                    showStatus('Values logged to console (clipboard unavailable)', true);
                }
            });
        }
    }
});
