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
    const stickyPlayerToggle = document.getElementById('stickyPlayerToggle');
    const pipToggle = document.getElementById('pipToggle');
    const pinChildren = document.getElementById('pinChildren');
    const defaultStickyToggle = document.getElementById('defaultStickyToggle');
    const stickyOnScrollToggle = document.getElementById('stickyOnScrollToggle');
    const inactiveWhenPausedToggle = document.getElementById('inactiveWhenPausedToggle');
    const inactiveAtEndToggle = document.getElementById('inactiveAtEndToggle');
    const ambientTabGlowToggle = document.getElementById('ambientTabGlowToggle');
    const versionText = document.getElementById('versionText');
    const saveIndicator = document.getElementById('saveIndicator');

    // Validate critical DOM elements exist
    if (!stickyPlayerToggle || !pipToggle || !defaultStickyToggle || !stickyOnScrollToggle || !inactiveWhenPausedToggle || !inactiveAtEndToggle) {
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

    // Per-key debounce timers to prevent write race conditions
    const timers = {};

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

    // Dim + lock the nested pin automations to mirror whether the Pin Video button exists.
    // (Reads the live checkbox state, so callers don't need to pass the value.)
    function updatePinChildrenState() {
        const on = !!stickyPlayerToggle.checked;
        if (pinChildren) pinChildren.classList.toggle('disabled', !on);
        [defaultStickyToggle, stickyOnScrollToggle, inactiveWhenPausedToggle, inactiveAtEndToggle].forEach(el => {
            if (el) el.disabled = !on;
        });
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
                // DEV frosted-tab tuning slider values (defaults mirror DEV_AMBIENT in content.js).
                ambTabBlur: 6,
                ambTabBrightness: 0.9,
                ambTabSaturation: 1.2
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
        if (DEBUG) console.log('[EYV Popup] Loaded settings:', result);

        stickyPlayerToggle.checked = result.stickyPlayerEnabled;
        pipToggle.checked = result.pipEnabled;
        defaultStickyToggle.checked = result.defaultStickyEnabled;
        stickyOnScrollToggle.checked = result.stickyOnScroll;
        inactiveWhenPausedToggle.checked = result.inactiveWhenPaused;
        inactiveAtEndToggle.checked = result.inactiveAtEnd;
        if (ambientTabGlowToggle) ambientTabGlowToggle.checked = result.ambientTabGlow;

        updatePinChildrenState();          // reflect Pin Video state onto the nested automations
        setupAmbientSliders(result);       // DEV: initialize ambient-tuning sliders from saved values
    })
    .catch(error => {
        console.error('[EYV Popup] Storage error or timeout:', error);
        showStatus('Failed to load settings. Please reopen the popup.', true);
    });

    // Wire a checkbox to a storage key + (optional) content-script message, with per-key debounce,
    // save confirmation, error handling, and UI revert on failure.
    //   storageKey   - chrome.storage.local key to persist
    //   buildMessage - (value) => message object for the content script, or null to skip messaging
    //   onSaved      - optional (value) => void run after a successful save AND after a revert,
    //                  so dependent UI (e.g. the nested automations) stays in sync either way
    //   onChangeImmediate - optional (value) => void run synchronously the instant the toggle
    //                  flips (before the debounced write), so dependent UI never lags the switch
    function bindToggle(toggle, storageKey, buildMessage, onSaved, onChangeImmediate) {
        if (!toggle) return;
        toggle.addEventListener('change', function() {
            const newValue = this.checked;

            // Reflect dependent UI right away; the debounced save (and any revert) re-syncs later.
            if (onChangeImmediate) onChangeImmediate(newValue);

            if (timers[storageKey]) clearTimeout(timers[storageKey]);
            timers[storageKey] = setTimeout(() => {
                storageWithTimeout(() => {
                    return new Promise((resolve, reject) => {
                        chrome.storage.local.set({ [storageKey]: newValue }, () => {
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
                    if (buildMessage) sendMessageToContentScript(buildMessage(newValue));
                    if (onSaved) onSaved(newValue);
                })
                .catch(error => {
                    console.error('[EYV Popup] Storage error or timeout:', error);
                    toggle.checked = !newValue; // Revert UI - the write failed
                    if (onSaved) onSaved(!newValue);
                    if (error.message && error.message.includes('QUOTA')) {
                        showStatus('Storage quota exceeded. Clear some browser data and try again.', true);
                    } else if (error.message && error.message.includes('timeout')) {
                        showStatus('Storage operation timed out. Please try again.', true);
                    }
                });
            }, DEBOUNCE_MS);
        });
    }

    // Player buttons (master toggles that add a control to YouTube's player)
    bindToggle(stickyPlayerToggle, 'stickyPlayerEnabled',
        v => ({ type: 'FEATURE_TOGGLE', feature: 'stickyPlayer', enabled: v }),
        updatePinChildrenState,   // re-sync after save / revert
        updatePinChildrenState);  // dim the nested automations instantly on toggle
    bindToggle(pipToggle, 'pipEnabled',
        v => ({ type: 'FEATURE_TOGGLE', feature: 'pip', enabled: v }));

    // Pin Video automations
    bindToggle(defaultStickyToggle, 'defaultStickyEnabled',
        v => ({ type: 'SETTING_CHANGED', key: 'defaultStickyEnabled', value: v }));
    bindToggle(stickyOnScrollToggle, 'stickyOnScroll',
        v => ({ type: 'SETTING_CHANGED', key: 'stickyOnScroll', value: v }));
    bindToggle(inactiveWhenPausedToggle, 'inactiveWhenPaused',
        v => ({ type: 'SETTING_CHANGED', key: 'inactiveWhenPaused', value: v }));
    bindToggle(inactiveAtEndToggle, 'inactiveAtEnd',
        v => ({ type: 'SETTING_CHANGED', key: 'inactiveAtEnd', value: v }));

    // Experimental
    bindToggle(ambientTabGlowToggle, 'ambientTabGlow',
        v => ({ type: 'SETTING_CHANGED', key: 'ambientTabGlow', value: v }));

    // --- DEV / Experimental: frosted-tab tuning sliders ------------------------------------------
    // Live-preview while dragging (throttled SETTING_CHANGED messages), persist on a short debounce.
    // "Copy values" puts a ready-to-hardcode DEV_AMBIENT snippet on the clipboard. Remove this whole
    // block (and the markup/styles) once the chosen values are baked into content.js.
    const AMBIENT_SLIDERS = [
        { id: 'ambTabBlurSlider',       key: 'ambTabBlur',       field: 'tabBlur',       def: 6,    dec: 0 },
        { id: 'ambTabBrightnessSlider', key: 'ambTabBrightness', field: 'tabBrightness', def: 0.9,  dec: 2 },
        { id: 'ambTabSaturationSlider', key: 'ambTabSaturation', field: 'tabSaturation', def: 1.2,  dec: 2 }
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
