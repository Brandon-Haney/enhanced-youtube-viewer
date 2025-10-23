(function() {
    // --- INITIALIZATION GUARD ---
    if (window.eyvHasRun) { return; }
    window.eyvHasRun = true;

    // --- DEBUG FLAG ---
    const DEBUG = false; // Set to true for verbose debugging

    // --- INITIALIZATION STATE ---
    let isInitializing = false; // Tracks if main poller is currently running

    // --- CLEANUP REGISTRY ---
    // Tracks all event listeners to prevent memory leaks on YouTube SPA navigation
    const cleanupRegistry = {
        listeners: [],
        observers: [],
        intervals: [],
        timeouts: [],

        // Register an event listener for cleanup
        addListener(target, event, handler, options) {
            target.addEventListener(event, handler, options);
            this.listeners.push({ target, event, handler, options });
        },

        // Register a MutationObserver for cleanup
        addObserver(observer) {
            this.observers.push(observer);
        },

        // Register an interval for cleanup
        addInterval(intervalId) {
            this.intervals.push(intervalId);
        },

        // Register a timeout for cleanup
        addTimeout(timeoutId) {
            this.timeouts.push(timeoutId);
        },

        // Clean up all registered resources
        cleanup() {
            // Remove all event listeners
            this.listeners.forEach(({ target, event, handler, options }) => {
                if (target && target.removeEventListener) {
                    target.removeEventListener(event, handler, options);
                }
            });

            // Disconnect all observers
            this.observers.forEach(observer => {
                if (observer && observer.disconnect) {
                    observer.disconnect();
                }
            });

            // Clear all intervals
            this.intervals.forEach(intervalId => {
                clearInterval(intervalId);
            });

            // Clear all timeouts
            this.timeouts.forEach(timeoutId => {
                clearTimeout(timeoutId);
            });

            // Remove extension UI elements from DOM
            document.querySelectorAll('.eyv-player-button, .eyv-pip-button').forEach(btn => btn.remove());
            const placeholder = document.getElementById('eyv-player-placeholder');
            if (placeholder) placeholder.remove();

            // NOTE: We don't clean up the sticky player element here during navigation-start
            // because doing so would interfere with YouTube's miniplayer activation when
            // navigating away from a watch page. Sticky player cleanup happens during
            // navigation-finish when arriving at a new watch page instead.

            // Reset arrays
            this.listeners = [];
            this.observers = [];
            this.intervals = [];
            this.timeouts = [];

            // Reset state flags to prevent stuck states
            isScrubbing = false;
            wasStickyBeforePause = false;
            wasStickyBeforePiP = false;
            wasStickyBeforeOsFullscreen = false;
            wasStickyBeforeEnd = false;
            wasStickyDuringCurrentVideo = false;
            isInitializing = false;

            // Null interval variables to prevent memory leaks
            mainPollInterval = null;
            playerStateObserver = null;
            videoElementObserver = null;
            stickyResizeObserver = null;
            currentVideoElement = null;
            stickyButtonElement = null; // Clear button reference too

            if (DEBUG) console.log('[EYV DBG] Cleanup complete: all listeners, observers, intervals, state flags, and UI elements removed.');
        }
    };

    // --- YOUTUBE SPA NAVIGATION HANDLERS ---
    // YouTube is a Single Page Application (SPA) that navigates without full page reloads.
    // We must clean up and reinitialize on navigation to prevent memory leaks.
    window.addEventListener('yt-navigate-start', () => {
        try {
            if (DEBUG) console.log('[EYV DBG] YouTube navigation starting, cleaning up...');

            // Only clean up if sticky mode was actually active
            if (stickyButtonElement?.classList.contains('active')) {
                if (DEBUG) console.log('[EYV DBG] Sticky mode was active, deactivating before navigation');

                // Use playerElementRef if available
                if (playerElementRef && playerElementRef.isConnected) {
                    playerElementRef.classList.remove('eyv-player-fixed');
                    // Only clear inline styles if the element has our class
                    playerElementRef.style.removeProperty('width');
                    playerElementRef.style.removeProperty('height');
                    playerElementRef.style.removeProperty('left');
                    playerElementRef.style.removeProperty('top');
                    playerElementRef.style.removeProperty('transform');
                    if (DEBUG) console.log('[EYV DBG] Cleared sticky styles from player');
                }

                const placeholder = document.getElementById('eyv-player-placeholder');
                if (placeholder) placeholder.style.display = 'none';
            } else {
                if (DEBUG) console.log('[EYV DBG] Sticky mode not active, skipping cleanup');
            }

            cleanupRegistry.cleanup();
            // Reset initialization guard so we can reinitialize after navigation
            window.eyvHasRun = false;
        } catch (error) {
            console.error('[EYV] Navigation start handler error:', error);
        }
    });

    window.addEventListener('yt-navigate-finish', () => {
        try {
            if (DEBUG) console.log('[EYV DBG] YouTube navigation finished, checking if reinitialization needed...');
            // Only reinitialize if we're on a watch page
            if (window.location.pathname === '/watch' && !window.eyvHasRun) {
                if (DEBUG) console.log('[EYV DBG] On watch page, reinitializing...');

                // Clean up sticky player from previous video to prevent interference
                const stickyPlayer = document.querySelector('.eyv-player-fixed');
                if (stickyPlayer) {
                    stickyPlayer.classList.remove('eyv-player-fixed');
                    Object.assign(stickyPlayer.style, {
                        width: '',
                        height: '',
                        left: '',
                        top: '',
                        transform: '',
                        position: '',
                        zIndex: ''
                    });
                }

                // Re-run the initialization by resetting the guard and starting the poller
                window.eyvHasRun = true;
                initializeMainPoller();
            }
        } catch (error) {
            console.error('[EYV] Navigation finish handler error:', error);
        }
    });

    // --- CLEANUP OF PREVIOUS INSTANCES ---
    document.querySelectorAll('.eyv-player-button, .eyv-pip-button').forEach(btn => btn.remove());
    const oldStyles = document.getElementById('eyv-styles'); if (oldStyles) { oldStyles.remove(); }
    const oldStickyPlayer = document.querySelector('.eyv-player-fixed');
    if (oldStickyPlayer) {
        oldStickyPlayer.classList.remove('eyv-player-fixed');
        Object.assign(oldStickyPlayer.style, { width: '', height: '', left: '', transform: '', top: '' });
    }
    const oldPlaceholder = document.getElementById('eyv-player-placeholder'); if (oldPlaceholder) { oldPlaceholder.remove(); }

    if (DEBUG) console.log("[EYV DBG] Content script executing (guard passed, cleanup done)."); else console.log("[EYV] Content script executing.");

    // --- CONSTANTS ---
    const MAIN_POLL_INTERVAL_MS = 500; // Check for ytd-player every 500ms
    const MAX_POLL_ATTEMPTS = 40; // Give up after 20 seconds (40 * 500ms)
    const CONTROLS_POLL_INTERVAL_MS = 500; // Check for player controls every 500ms
    const MAX_CONTROLS_POLL_ATTEMPTS = 30; // Give up after 15 seconds
    const RESIZE_DEBOUNCE_MS = 100; // Debounce window resize events
    const STORAGE_WRITE_DEBOUNCE_MS = 150; // Debounce storage writes in popup
    const BUTTON_TRANSITION_MS = 300; // Prevent rapid sticky button clicks
    const PIP_TRANSITION_MS = 500; // Prevent rapid PiP button clicks

    // --- GLOBAL VARIABLES & STATE ---
    let attempts = 0;
    const maxAttempts = MAX_POLL_ATTEMPTS;
    let mainPollInterval;
    let playerPlaceholder = null;
    let originalPlayerAspectRatio = 16 / 9;
    let stickyButtonElement = null;
    let playerElementRef = null;
    let playerStateObserver = null;
    let videoElementObserver = null;
    let stickyResizeObserver = null;
    let currentVideoElement = null;
    let wasStickyBeforeOsFullscreen = false;
    let wasStickyBeforePiP = false;
    let wasStickyBeforePause = false;
    let isScrubbing = false;
    let inactiveWhenPausedEnabled = false;
    let inactiveAtEndEnabled = false;
    let stickyPlayerEnabled = true; // Feature enable/disable
    let pipEnabled = true; // Feature enable/disable
    let wasStickyBeforeEnd = false; // Track if sticky was active when video ended
    let wasStickyDuringCurrentVideo = false; // Track if sticky was EVER active during current video playback

    // WeakSets to track elements with attached listeners (survives element replacement)
    const videoElementsWithListeners = new WeakSet();
    const pipButtonsWithListeners = new WeakSet();

    // --- ADD MESSAGE LISTENER FOR POPUP SETTINGS ---
    // Validate Chrome context before registering listener
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage && chrome.runtime.id) {
        chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
            // Validate sender: only accept messages from this extension
            if (!sender || sender.id !== chrome.runtime.id) {
                console.warn('[EYV] Rejected message from unauthorized sender:', sender?.id);
                sendResponse({ status: "error", message: "Unauthorized sender" });
                return true;
            }

            if (message.type === "SETTING_CHANGED") {
                if (DEBUG) console.log(`[EYV DBG] Received setting change: ${message.key} = ${message.value}`);
                // Validate message.value is a boolean
                if (typeof message.value !== 'boolean') {
                    console.warn('[EYV] Invalid message value type:', typeof message.value);
                    sendResponse({ status: "error", message: "Invalid value type" });
                    return true;
                }
                if (message.key === 'inactiveWhenPaused') {
                    inactiveWhenPausedEnabled = message.value;
                    settingsCache.inactiveWhenPaused = message.value;
                } else if (message.key === 'inactiveAtEnd') {
                    inactiveAtEndEnabled = message.value;
                    settingsCache.inactiveAtEnd = message.value;
                }
                sendResponse({ status: "ok" });
                return true; // Keep channel open for async response
            }

            if (message.type === "FEATURE_TOGGLE") {
                if (DEBUG) console.log(`[EYV DBG] Received feature toggle: ${message.feature} = ${message.enabled}`);
                // Validate message.enabled is a boolean
                if (typeof message.enabled !== 'boolean') {
                    console.warn('[EYV] Invalid enabled value type:', typeof message.enabled);
                    sendResponse({ status: "error", message: "Invalid value type" });
                    return true;
                }

                if (message.feature === 'stickyPlayer') {
                    stickyPlayerEnabled = message.enabled;
                    const stickyBtn = document.querySelector('.eyv-player-button');

                    if (message.enabled) {
                        // ENABLE: Create button if it doesn't exist
                        if (!stickyBtn) {
                            const player = document.querySelector('ytd-player');
                            const playerRightControls = player?.querySelector('.ytp-right-controls');
                            const videoElement = player?.querySelector('video.html5-main-video');

                            if (player && playerRightControls && videoElement) {
                                // Create the button
                                stickyButtonElement = createStickyButtonLogic(player, videoElement);
                                Object.assign(stickyButtonElement, {
                                    className: 'ytp-button eyv-player-button',
                                    title: 'Toggle Sticky Player',
                                    innerHTML: pinSVGIcon
                                });
                                stickyButtonElement.setAttribute('aria-label', 'Toggle Sticky Player');

                                // Insert it in the correct position
                                const settingsButton = playerRightControls.querySelector('.ytp-settings-button');
                                const pipBtn = playerRightControls.querySelector('.eyv-pip-button');

                                if (settingsButton && settingsButton.parentNode === playerRightControls) {
                                    playerRightControls.insertBefore(stickyButtonElement, pipBtn || settingsButton);
                                } else {
                                    playerRightControls.prepend(stickyButtonElement);
                                }

                                if (DEBUG) console.log('[EYV DBG] Sticky player button created');
                            } else {
                                if (DEBUG) console.log('[EYV DBG] Cannot create sticky button - player elements not found');
                            }
                        }
                    } else {
                        // DISABLE: Remove button if it exists
                        if (stickyBtn) {
                            // Deactivate sticky mode if active
                            if (stickyBtn.classList.contains('active')) {
                                stickyBtn.click();
                            }
                            stickyBtn.remove();
                            stickyButtonElement = null;
                            if (DEBUG) console.log('[EYV DBG] Sticky player button removed');
                        }
                    }
                } else if (message.feature === 'pip') {
                    pipEnabled = message.enabled;
                    const pipBtn = document.querySelector('.eyv-pip-button');

                    if (message.enabled) {
                        // ENABLE: Create button if it doesn't exist
                        if (!pipBtn) {
                            const player = document.querySelector('ytd-player');
                            const playerRightControls = player?.querySelector('.ytp-right-controls');
                            const videoElement = player?.querySelector('video.html5-main-video');

                            if (player && playerRightControls && videoElement) {
                                // Create the button
                                const pipBtnInstance = createPiPButtonLogic(videoElement);
                                Object.assign(pipBtnInstance, {
                                    className: 'ytp-button eyv-pip-button',
                                    title: 'Toggle Picture-in-Picture',
                                    innerHTML: pipSVGDefault
                                });
                                pipBtnInstance.setAttribute('aria-label', 'Toggle Picture-in-Picture');

                                // Attach PiP event listeners
                                if (!pipButtonsWithListeners.has(pipBtnInstance)) {
                                    if (document.pictureInPictureElement === videoElement) {
                                        pipBtnInstance.classList.add('active');
                                        pipBtnInstance.innerHTML = pipSVGActive;
                                    }

                                    cleanupRegistry.addListener(videoElement, 'enterpictureinpicture', () => {
                                        try {
                                            if (document.pictureInPictureElement === videoElement && pipBtnInstance) {
                                                pipBtnInstance.classList.add('active');
                                                pipBtnInstance.innerHTML = pipSVGActive;
                                                if (stickyButtonElement?.classList.contains('active')) {
                                                    wasStickyBeforePiP = true;
                                                    if (DEBUG) console.log("[EYV DBG] OS PiP entered. Deactivating sticky.");
                                                    deactivateStickyModeInternal();
                                                }
                                            }
                                        } catch (error) {
                                            console.error('[EYV] Enter PiP handler error:', error);
                                        }
                                    });

                                    cleanupRegistry.addListener(videoElement, 'leavepictureinpicture', () => {
                                        try {
                                            if (pipBtnInstance) {
                                                pipBtnInstance.classList.remove('active');
                                                pipBtnInstance.innerHTML = pipSVGDefault;
                                            }
                                            if (DEBUG) console.log("[EYV DBG] OS 'leavepictureinpicture' event. wasStickyBeforePiP:", wasStickyBeforePiP);
                                            tryReactivatingStickyAfterPiPOrMiniplayer(videoElement);
                                            wasStickyBeforePiP = false;
                                        } catch (error) {
                                            console.error('[EYV] Leave PiP handler error:', error);
                                        }
                                    });

                                    pipButtonsWithListeners.add(pipBtnInstance);
                                }

                                // Insert it in the correct position
                                const settingsButton = playerRightControls.querySelector('.ytp-settings-button');

                                if (settingsButton && settingsButton.parentNode === playerRightControls) {
                                    playerRightControls.insertBefore(pipBtnInstance, settingsButton);
                                } else {
                                    playerRightControls.prepend(pipBtnInstance);
                                }

                                if (DEBUG) console.log('[EYV DBG] PiP button created');
                            } else {
                                if (DEBUG) console.log('[EYV DBG] Cannot create PiP button - player elements not found');
                            }
                        }
                    } else {
                        // DISABLE: Remove button if it exists
                        if (pipBtn) {
                            pipBtn.remove();
                            if (DEBUG) console.log('[EYV DBG] PiP button removed');
                        }
                    }
                }
                sendResponse({ status: "ok" });
                return true;
            }

            // Send error response for unrecognized message types
            console.warn('[EYV] Unrecognized message type:', message.type);
            sendResponse({ status: "error", message: "Unknown message type" });
            return true;
        });
    } else {
        console.warn('[EYV] Chrome runtime context invalid or not available - message listener not registered. Extension may need reload.');
    }

    // --- SVG ICON DEFINITIONS ---
    const pinSVGIcon = `<svg viewBox="0 0 24 24" preserveAspectRatio="xMidYMid meet" focusable="false" class="style-scope ytp-button" style="pointer-events: none; display: block; width: 100%; height: 100%;"><g class="style-scope ytp-button"><path d="M16,12V4H17V2H7V4H8V12L6,14V16H11.2V22H12.8V16H18V14L16,12Z" class="style-scope ytp-button" fill="currentColor"></path></g></svg>`;
    const pinSVGIconActive = `<svg viewBox="0 0 24 24" preserveAspectRatio="xMidYMid meet" focusable="false" class="style-scope ytp-button" style="pointer-events: none; display: block; width: 100%; height: 100%;"><g class="style-scope ytp-button"><path d="M16,12V4H17V2H7V4H8V12L6,14V16H11.2V22H12.8V16H18V14L16,12Z" class="style-scope ytp-button" fill="var(--yt-spec-static-brand-red, #FF0000)"></path></g></svg>`;
    const pipSVGDefault = `<svg viewBox="0 0 24 24" preserveAspectRatio="xMidYMid meet" focusable="false" class="style-scope ytp-button" style="pointer-events: none; display: block; width: 100%; height: 100%;"><g fill="currentColor"><path d="M19,11H13V5h6Zm2-8H3A2,2,0,0,0,1,5V19a2,2,0,0,0,2,2H21a2,2,0,0,0,2-2V5A2,2,0,0,0,21,3Zm0,16H3V5H21Z"/></g></svg>`;
    const pipSVGActive = `<svg viewBox="0 0 24 24" preserveAspectRatio="xMidYMid meet" focusable="false" class="style-scope ytp-button" style="pointer-events: none; display: block; width: 100%; height: 100%;"><g fill="var(--yt-spec-static-brand-red, #FF0000)"><path d="M19,11H13V5h6Zm2-8H3A2,2,0,0,0,1,5V19a2,2,0,0,0,2,2H21a2,2,0,0,0,2-2V5A2,2,0,0,0,21,3Zm0,16H3V5H21Z"/></g></svg>`;

    // --- UTILITY FUNCTIONS ---
    function debounce(func, wait) {
        let timeout;
        return function executedFunction(...args) {
            const later = () => {
                clearTimeout(timeout);
                func(...args);
            };
            clearTimeout(timeout);
            timeout = setTimeout(later, wait);
        };
    }

    function getMastheadOffset() {
        const masthead = document.querySelector('#masthead-container ytd-masthead') || document.querySelector('#masthead-container');
        if (masthead?.offsetHeight > 0) return masthead.offsetHeight;
        const appMasthead = document.querySelector('ytd-app ytd-masthead[persistent]');
        if (appMasthead?.offsetHeight > 0) return appMasthead.offsetHeight;
        return 0;
    }

    function isAdPlaying() {
        // Check if YouTube is currently playing an ad
        const player = document.querySelector('.html5-video-player');
        if (!player) return false;

        // YouTube adds 'ad-showing' or 'ad-interrupting' class when ad is playing
        if (player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting')) {
            return true;
        }

        // Check for ad container
        const adModule = document.querySelector('.video-ads.ytp-ad-module');
        if (adModule?.childElementCount > 0) {
            return true;
        }

        return false;
    }

    // Sanitize CSS color values from YouTube page to prevent injection attacks
    function sanitizeColorValue(value) {
        if (!value || typeof value !== 'string') return '#0f0f0f';
        const trimmed = value.trim();
        // Allow hex colors: #fff, #ffffff, #ffffffff
        if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(trimmed)) return trimmed;
        // Allow rgb/rgba: rgb(0,0,0), rgba(0,0,0,1)
        if (/^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*[\d.]+\s*)?\)$/.test(trimmed)) return trimmed;
        // Allow hsl/hsla: hsl(0,0%,0%), hsla(0,0%,0%,1)
        if (/^hsla?\(\s*\d{1,3}\s*,\s*\d{1,3}%\s*,\s*\d{1,3}%\s*(,\s*[\d.]+\s*)?\)$/.test(trimmed)) return trimmed;
        // Allow CSS variables: var(--variable-name) or var(--variable-name, fallback)
        if (/^var\(--[a-zA-Z0-9-]+(?:,\s*[^)]+)?\)$/.test(trimmed)) return trimmed;
        // Reject everything else (including keywords to be extra safe)
        return '#0f0f0f';
    }

    // Settings cache to avoid repeated storage access
    const settingsCache = {
        defaultStickyEnabled: null,
        inactiveWhenPaused: null,
        inactiveAtEnd: null,
        stickyPlayerEnabled: null,
        pipEnabled: null,
        loaded: false
    };

    // Unified settings loader to prevent race conditions
    function loadSettings(keys, useCache = true) {
        // Return cached values if available and requested
        if (useCache && settingsCache.loaded) {
            const result = {};
            keys.forEach(key => {
                if (settingsCache[key] !== null) {
                    result[key] = settingsCache[key];
                }
            });
            return Promise.resolve(result);
        }

        return new Promise((resolve, reject) => {
            // Validate Chrome context before making storage call
            if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) {
                reject(new Error('Chrome runtime context invalid'));
                return;
            }

            chrome.storage.local.get(keys, (result) => {
                // Double-check Chrome context after async callback
                if (!chrome.runtime?.id) {
                    reject(new Error('Chrome context invalidated during storage operation'));
                    return;
                }
                if (chrome.runtime.lastError) {
                    reject(chrome.runtime.lastError);
                    return;
                }

                // Update cache
                keys.forEach(key => {
                    if (result[key] !== undefined) {
                        settingsCache[key] = result[key];
                    }
                });
                settingsCache.loaded = true;

                resolve(result);
            });
        });
    }

    // --- MAIN INITIALIZATION POLLER ---
    function initializeMainPoller() {
        // Prevent race condition: don't start if already initializing
        if (isInitializing) {
            if (DEBUG) console.log('[EYV DBG] Already initializing, skipping duplicate call.');
            return;
        }

        isInitializing = true;
        attempts = 0;

        mainPollInterval = setInterval(() => {
            attempts++;
            const playerElement = document.querySelector('ytd-player');
            if (playerElement) {
                clearInterval(mainPollInterval);
                isInitializing = false;
                initializeFeatures(playerElement);
            } else if (attempts >= maxAttempts) {
                clearInterval(mainPollInterval);
                isInitializing = false;
                console.warn("[EYV] FAILED: Could not find player element.");
            }
        }, MAIN_POLL_INTERVAL_MS);
        cleanupRegistry.addInterval(mainPollInterval);
    }

    // Start initial polling only if we're on a watch page
    if (window.location.pathname === '/watch') {
        if (DEBUG) console.log('[EYV DBG] On watch page at initial load, starting initialization...');
        initializeMainPoller();
    } else {
        if (DEBUG) console.log('[EYV DBG] Not on watch page, waiting for navigation...');
    }

    // --- FEATURE INITIALIZATION ---
    function initializeFeatures(player) {
        playerElementRef = player;
        if (!document.getElementById('eyv-styles')) injectAllStyles();
        if (!player) { console.error('[EYV] ERROR: Player element not valid.'); return; }

        // Try to find controls immediately first
        let playerRightControls = player.querySelector('.ytp-right-controls');
        let videoElement = player.querySelector('video.html5-main-video');
        let progressBar = player.querySelector('.ytp-progress-bar-container');

        // Function to initialize when all controls are found
        const initializeControls = () => {
            if (DEBUG) console.log('[EYV DBG] All controls found, initializing features...');

                // Load ALL settings FIRST (in one call to avoid cache issues), then create buttons
                loadSettings(['stickyPlayerEnabled', 'pipEnabled', 'defaultStickyEnabled', 'inactiveWhenPaused', 'inactiveAtEnd'])
                    .then(settings => {
                        stickyPlayerEnabled = settings.stickyPlayerEnabled !== false; // Default to true
                        pipEnabled = settings.pipEnabled !== false; // Default to true
                        inactiveWhenPausedEnabled = !!(settings && settings.inactiveWhenPaused);
                        inactiveAtEndEnabled = !!(settings && settings.inactiveAtEnd);
                        const defaultStickyEnabled = !!(settings && settings.defaultStickyEnabled);
                        if (DEBUG) console.log(`[EYV DBG] Loaded all settings: stickyPlayerEnabled=${stickyPlayerEnabled}, pipEnabled=${pipEnabled}, defaultStickyEnabled=${defaultStickyEnabled}, inactiveWhenPaused=${inactiveWhenPausedEnabled}, inactiveAtEnd=${inactiveAtEndEnabled}`);

                        // Only create sticky player button if enabled
                        stickyButtonElement = playerRightControls.querySelector('.eyv-player-button');
                        if (!stickyButtonElement && stickyPlayerEnabled) {
                            stickyButtonElement = createStickyButtonLogic(player, videoElement);
                            // SECURITY: innerHTML is safe here - pinSVGIcon is a static SVG string constant defined in extension code (no user input)
                            Object.assign(stickyButtonElement, { className: 'ytp-button eyv-player-button', title: 'Toggle Sticky Player', innerHTML: pinSVGIcon });
                            stickyButtonElement.setAttribute('aria-label', 'Toggle Sticky Player');
                        } else if (stickyButtonElement && !stickyPlayerEnabled) {
                            // Button exists but should be hidden
                            stickyButtonElement.remove();
                            stickyButtonElement = null;
                        }

                        // Only create PiP button if enabled
                        let pipBtnInstance = playerRightControls.querySelector('.eyv-pip-button');
                        if (!pipBtnInstance && pipEnabled) {
                            pipBtnInstance = createPiPButtonLogic(videoElement);
                            // SECURITY: innerHTML is safe here - pipSVGDefault is a static SVG string constant defined in extension code (no user input)
                            Object.assign(pipBtnInstance, { className: 'ytp-button eyv-pip-button', title: 'Toggle Picture-in-Picture', innerHTML: pipSVGDefault });
                            pipBtnInstance.setAttribute('aria-label', 'Toggle Picture-in-Picture');
                        } else if (pipBtnInstance && !pipEnabled) {
                            // Button exists but should be hidden
                            pipBtnInstance.remove();
                            pipBtnInstance = null;
                        }

                        // Continue with the rest of initialization
                        initializeControlsContinued(pipBtnInstance, defaultStickyEnabled);
                    })
                    .catch(error => {
                        console.error('[EYV] Failed to load feature settings:', error);
                        // Default to enabled on error
                        stickyPlayerEnabled = true;
                        pipEnabled = true;
                        inactiveWhenPausedEnabled = false;
                        inactiveAtEndEnabled = false;
                        const defaultStickyEnabled = false;

                        // Create buttons with default enabled state
                        stickyButtonElement = playerRightControls.querySelector('.eyv-player-button');
                        if (!stickyButtonElement) {
                            stickyButtonElement = createStickyButtonLogic(player, videoElement);
                            Object.assign(stickyButtonElement, { className: 'ytp-button eyv-player-button', title: 'Toggle Sticky Player', innerHTML: pinSVGIcon });
                            stickyButtonElement.setAttribute('aria-label', 'Toggle Sticky Player');
                        }

                        let pipBtnInstance = playerRightControls.querySelector('.eyv-pip-button');
                        if (!pipBtnInstance) {
                            pipBtnInstance = createPiPButtonLogic(videoElement);
                            Object.assign(pipBtnInstance, { className: 'ytp-button eyv-pip-button', title: 'Toggle Picture-in-Picture', innerHTML: pipSVGDefault });
                            pipBtnInstance.setAttribute('aria-label', 'Toggle Picture-in-Picture');
                        }

                        initializeControlsContinued(pipBtnInstance, defaultStickyEnabled);
                    });
        };

        // Continuation of initialization after settings are loaded
        const initializeControlsContinued = (pipBtnInstance, defaultStickyEnabled) => {

                if (!videoElementsWithListeners.has(videoElement)) {
                    // Settings already loaded in initializeControls(), no need to load again

                    if (!progressBar.dataset.eyvScrubListener) {
                        cleanupRegistry.addListener(progressBar, 'mousedown', () => {
                            isScrubbing = true;
                            if (DEBUG) console.log("[EYV DBG] Scrubbing started (mousedown on progress bar).");
                        });
                        // Listen on the whole document for mouseup, as the user might drag outside the bar
                        cleanupRegistry.addListener(document, 'mouseup', () => {
                            if (isScrubbing) {
                                isScrubbing = false;
                                if (DEBUG) console.log("[EYV DBG] Scrubbing finished (mouseup).");
                            }
                        });
                        // Reset scrubbing flag if mouse leaves window or focus is lost
                        cleanupRegistry.addListener(document, 'mouseleave', () => {
                            if (isScrubbing) {
                                isScrubbing = false;
                                if (DEBUG) console.log("[EYV DBG] Scrubbing reset (mouse left document).");
                            }
                        });
                        cleanupRegistry.addListener(window, 'blur', () => {
                            if (isScrubbing) {
                                isScrubbing = false;
                                if (DEBUG) console.log("[EYV DBG] Scrubbing reset (window lost focus).");
                            }
                        });
                        progressBar.dataset.eyvScrubListener = "true";
                    }
                    
                    cleanupRegistry.addListener(videoElement, 'pause', () => {
                        try {
                            if (isScrubbing) {
                                if (DEBUG) console.log("[EYV DBG] Paused, but ignored because user is scrubbing.");
                                return;
                            }
                            if (isAdPlaying()) {
                                if (DEBUG) console.log("[EYV DBG] Paused, but ignored because ad is playing.");
                                return;
                            }

                            // Check if video ended (video is paused AND currentTime is at or very near the end)
                            const isVideoEnded = videoElement.currentTime >= videoElement.duration - 0.5;
                            if (isVideoEnded) {
                                if (DEBUG) console.log("[EYV DBG] Paused because video ended (currentTime >= duration). Ignoring pause deactivation.");
                                return;
                            }

                            if (inactiveWhenPausedEnabled && stickyButtonElement?.classList.contains('active')) {
                                if (DEBUG) console.log("[EYV DBG] Paused. Deactivating sticky mode as per settings.");
                                // Set flag AFTER deactivating to prevent it from being reset
                                deactivateStickyModeInternal(true); // Pass true to preserve pause flag
                                wasStickyBeforePause = true;
                            }
                        } catch (error) {
                            console.error('[EYV] Video pause handler error:', error);
                        }
                    });

                    cleanupRegistry.addListener(videoElement, 'play', () => {
                        try {
                            // Handle re-activation after pause
                            if (inactiveWhenPausedEnabled && wasStickyBeforePause) {
                                wasStickyBeforePause = false; // Consume the flag
                                const ytdApp = document.querySelector('ytd-app');
                                const isMini = ytdApp?.hasAttribute('miniplayer-is-active');
                                const isFull = ytdApp?.hasAttribute('fullscreen') || !!document.fullscreenElement;
                                if (!(document.pictureInPictureElement === videoElement || isMini || isFull)) {
                                    if (stickyButtonElement && !stickyButtonElement.classList.contains('active')) {
                                        if (DEBUG) console.log("[EYV DBG] Resuming play. Re-activating sticky mode.");
                                        stickyButtonElement.click();
                                    }
                                }
                            }

                            // Note: Re-activation after video ended is now handled in 'loadeddata' event
                            // which is more reliable for autoplay scenarios where URL changes
                        } catch (error) {
                            console.error('[EYV] Video play handler error:', error);
                        }
                    });

                    cleanupRegistry.addListener(videoElement, 'ended', () => {
                        try {
                            if (DEBUG) console.log("[EYV DBG] Video ended. inactiveAtEndEnabled:", inactiveAtEndEnabled, "sticky currently active:", stickyButtonElement?.classList.contains('active'), "wasStickyDuringCurrentVideo:", wasStickyDuringCurrentVideo);

                            // Check if sticky was EVER active during this video, not just currently active
                            // This handles the case where "Pause Deactivation" already turned off sticky
                            if (inactiveAtEndEnabled && wasStickyDuringCurrentVideo) {
                                if (DEBUG) console.log("[EYV DBG] Video ended and sticky was active during playback. Setting re-activation flag.");
                                wasStickyBeforeEnd = true; // Remember that sticky was active during this video
                                // Persist to sessionStorage so it survives YouTube SPA navigation
                                try {
                                    sessionStorage.setItem('eyv-wasStickyBeforeEnd', 'true');
                                    if (DEBUG) console.log('[EYV DBG] Set sessionStorage flag: eyv-wasStickyBeforeEnd = true');
                                } catch (e) {
                                    console.error('[EYV] Could not set sessionStorage:', e);
                                }
                                // Only deactivate if it's still active
                                if (stickyButtonElement?.classList.contains('active')) {
                                    deactivateStickyModeInternal();
                                }
                            }
                        } catch (error) {
                            console.error('[EYV] Video ended handler error:', error);
                        }
                    });

                    videoElementsWithListeners.add(videoElement);
                }
                
                if (pipBtnInstance && !pipButtonsWithListeners.has(pipBtnInstance)) {
                    // SECURITY: innerHTML is safe here - pipSVGActive is a static SVG string constant (no user input)
                    if (document.pictureInPictureElement === videoElement) { pipBtnInstance.classList.add('active'); pipBtnInstance.innerHTML = pipSVGActive; }

                    cleanupRegistry.addListener(videoElement, 'enterpictureinpicture', () => {
                        try {
                            if (document.pictureInPictureElement === videoElement && pipBtnInstance) {
                                // SECURITY: innerHTML is safe here - pipSVGActive is a static SVG string constant (no user input)
                                pipBtnInstance.classList.add('active'); pipBtnInstance.innerHTML = pipSVGActive;
                                // If sticky is active when PiP is entered (e.g. via browser button/keyboard), deactivate it
                                if (stickyButtonElement?.classList.contains('active')) {
                                    wasStickyBeforePiP = true;
                                    if (DEBUG) console.log("[EYV DBG] OS PiP entered. Deactivating sticky.");
                                    deactivateStickyModeInternal();
                                }
                            }
                        } catch (error) {
                            console.error('[EYV] Enter PiP handler error:', error);
                        }
                    });
                    cleanupRegistry.addListener(videoElement, 'leavepictureinpicture', () => {
                        try {
                            if (pipBtnInstance) {
                                // SECURITY: innerHTML is safe here - pipSVGDefault is a static SVG string constant (no user input)
                                pipBtnInstance.classList.remove('active'); pipBtnInstance.innerHTML = pipSVGDefault;
                            }
                            if (DEBUG) console.log("[EYV DBG] OS 'leavepictureinpicture' event. wasStickyBeforePiP:", wasStickyBeforePiP);
                            tryReactivatingStickyAfterPiPOrMiniplayer(videoElement);
                            wasStickyBeforePiP = false;
                        } catch (error) {
                            console.error('[EYV] Leave PiP handler error:', error);
                        }
                    });
                    pipButtonsWithListeners.add(pipBtnInstance);
                }
                // Insert buttons into player controls with fallback logic for YouTube DOM changes
                const settingsButton = playerRightControls.querySelector('.ytp-settings-button');

                // Check if settings button is a direct child of playerRightControls
                const isSettingsButtonDirectChild = settingsButton && settingsButton.parentNode === playerRightControls;

                if (isSettingsButtonDirectChild) {
                    // Settings button is a direct child, safe to use insertBefore
                    if (pipBtnInstance && !playerRightControls.contains(pipBtnInstance)) {
                        playerRightControls.insertBefore(pipBtnInstance, settingsButton);
                    } else if (pipBtnInstance && pipBtnInstance.nextSibling !== settingsButton) {
                        // PiP button exists but not in correct position
                        playerRightControls.insertBefore(pipBtnInstance, settingsButton);
                    }

                    if (stickyButtonElement && !playerRightControls.contains(stickyButtonElement)) {
                        playerRightControls.insertBefore(stickyButtonElement, pipBtnInstance || settingsButton);
                    } else if (stickyButtonElement && pipBtnInstance && stickyButtonElement.nextSibling !== pipBtnInstance) {
                        // Sticky button exists but not in correct position
                        playerRightControls.insertBefore(stickyButtonElement, pipBtnInstance);
                    }
                } else {
                    // Fallback: prepend buttons if settings button structure changed
                    if (DEBUG) console.log('[EYV DBG] Settings button not direct child or not found, using prepend fallback');
                    if (pipBtnInstance && !playerRightControls.contains(pipBtnInstance)) playerRightControls.prepend(pipBtnInstance);
                    if (stickyButtonElement && !playerRightControls.contains(stickyButtonElement)) playerRightControls.prepend(stickyButtonElement);
                }

                // Sync our button dimensions with YouTube's native buttons
                syncButtonDimensions();

                if (playerElementRef && !playerStateObserver) setupPlayerStateObserver(playerElementRef, videoElement);
                if (playerElementRef && !videoElementObserver) setupVideoElementObserver(playerElementRef);

                // Initialize current video element reference
                currentVideoElement = videoElement;

                // Check sessionStorage for re-activation after video ended
                let shouldReactivateAfterEnd = false;
                try {
                    const storageValue = sessionStorage.getItem('eyv-wasStickyBeforeEnd');
                    if (DEBUG) console.log('[EYV DBG] Checking sessionStorage for wasStickyBeforeEnd:', storageValue);

                    if (storageValue === 'true') {
                        shouldReactivateAfterEnd = true;
                        sessionStorage.removeItem('eyv-wasStickyBeforeEnd');
                        if (DEBUG) console.log('[EYV DBG] Found flag in sessionStorage - will re-activate sticky mode');
                    }
                } catch (e) {
                    console.error('[EYV] Could not read sessionStorage:', e);
                }

                // Auto-activate sticky mode if defaultStickyEnabled is true OR if previous video ended with sticky active
                if ((defaultStickyEnabled || (inactiveAtEndEnabled && shouldReactivateAfterEnd)) && stickyButtonElement && !stickyButtonElement.classList.contains('active')) {
                    const ytdApp = document.querySelector('ytd-app');
                    const isMini = ytdApp?.hasAttribute('miniplayer-is-active');
                    const isFull = ytdApp?.hasAttribute('fullscreen') || !!document.fullscreenElement;
                    if (!(document.pictureInPictureElement === videoElement || isMini || isFull)) {
                        if (defaultStickyEnabled) {
                            if (DEBUG) console.log('[EYV DBG] Auto-activating sticky mode (defaultStickyEnabled=true)');
                        }
                        if (shouldReactivateAfterEnd) {
                            if (DEBUG) console.log('[EYV DBG] Auto-activating sticky mode (re-activating after video ended)');
                        }

                        // Delay activation to ensure player is fully ready
                        // Use longer delay for autoplay scenarios where player may still be initializing
                        const activationDelay = shouldReactivateAfterEnd ? 500 : 200;
                        if (DEBUG) console.log(`[EYV DBG] Scheduling sticky activation in ${activationDelay}ms...`);

                        setTimeout(() => {
                            if (DEBUG) console.log('[EYV DBG] Auto-activation timer fired. Checking button state...');
                            if (!stickyButtonElement) {
                                if (DEBUG) console.log('[EYV DBG] Button no longer exists, skipping activation');
                                return;
                            }
                            if (stickyButtonElement.classList.contains('active')) {
                                if (DEBUG) console.log('[EYV DBG] Button already active, skipping click');
                                return;
                            }

                            // Double-check player is ready
                            const playerReady = playerElementRef && videoElement && !videoElement.paused;
                            if (DEBUG) console.log(`[EYV DBG] Player ready check: playerRef=${!!playerElementRef}, video=${!!videoElement}, playing=${videoElement && !videoElement.paused}`);

                            if (DEBUG) console.log('[EYV DBG] Clicking sticky button to activate...');
                            stickyButtonElement.click();
                        }, activationDelay);
                    } else {
                        if (DEBUG) console.log('[EYV DBG] Cannot auto-activate: conflicting mode active (PiP/mini/fullscreen)');
                    }
                } else if (DEBUG) {
                    if (!stickyButtonElement) {
                        console.log('[EYV DBG] No auto-activation: button does not exist');
                    } else if (stickyButtonElement.classList.contains('active')) {
                        console.log('[EYV DBG] No auto-activation: button already active');
                    } else {
                        console.log('[EYV DBG] No auto-activation: conditions not met');
                    }
                }
        }; // End of initializeControlsContinued

        // Check if controls are already present
        if (playerRightControls && videoElement && progressBar) {
            initializeControls();
        } else {
            // Use MutationObserver to watch for controls to appear
            if (DEBUG) console.log('[EYV DBG] Controls not yet loaded, setting up MutationObserver...');

            let controlsObserverAttempts = 0;
            const maxAttempts = MAX_CONTROLS_POLL_ATTEMPTS;

            const controlsObserver = new MutationObserver(() => {
                controlsObserverAttempts++;

                // Re-query for controls
                if (!playerRightControls) playerRightControls = player.querySelector('.ytp-right-controls');
                if (!videoElement) videoElement = player.querySelector('video.html5-main-video');
                if (!progressBar) progressBar = player.querySelector('.ytp-progress-bar-container');

                // If all controls found, initialize and disconnect
                if (playerRightControls && videoElement && progressBar) {
                    controlsObserver.disconnect();
                    initializeControls();
                } else if (controlsObserverAttempts >= maxAttempts) {
                    controlsObserver.disconnect();
                    console.warn('[EYV] Failed to find player controls/video/progress bar after waiting.');
                }
            });

            // Observe player element for child changes
            if (player.isConnected) {
                controlsObserver.observe(player, {
                    childList: true,
                    subtree: true
                });
                cleanupRegistry.addObserver(controlsObserver);

                // Fallback timeout in case MutationObserver doesn't catch it
                const fallbackTimeout = setTimeout(() => {
                    if (!playerRightControls || !videoElement || !progressBar) {
                        console.warn('[EYV] Controls observer timeout, falling back to final check...');
                        playerRightControls = player.querySelector('.ytp-right-controls');
                        videoElement = player.querySelector('video.html5-main-video');
                        progressBar = player.querySelector('.ytp-progress-bar-container');

                        if (playerRightControls && videoElement && progressBar) {
                            controlsObserver.disconnect();
                            initializeControls();
                        } else {
                            controlsObserver.disconnect();
                            console.warn('[EYV] Failed to find player controls even with fallback.');
                        }
                    }
                }, MAX_CONTROLS_POLL_ATTEMPTS * CONTROLS_POLL_INTERVAL_MS);

                cleanupRegistry.addTimeout(fallbackTimeout);
            }
        }

        // Register window and document event listeners (debounce resize for performance)
        const debouncedResize = debounce(() => {
            // Sync button dimensions on resize
            syncButtonDimensions();

            if (playerElementRef?.classList.contains('eyv-player-fixed')) {
                // Use requestAnimationFrame to ensure layout is complete before reading dimensions
                requestAnimationFrame(() => {
                    centerStickyPlayer(playerElementRef);
                });
            }
        }, RESIZE_DEBOUNCE_MS);
        cleanupRegistry.addListener(window, 'resize', debouncedResize);
        cleanupRegistry.addListener(document, 'fullscreenchange', handleFullscreenChange);
    }

    // --- STICKY PLAYER HELPER ---
    function deactivateStickyModeInternal(preservePauseFlag = false) {
        if (!stickyButtonElement || !stickyButtonElement.classList.contains('active')) return;
        if (DEBUG) console.log('[EYV DBG] Deactivating sticky mode.'); else console.log('[EYV] Deactivating sticky mode.');
        if (playerElementRef) {
            playerElementRef.classList.remove('eyv-player-fixed');
            Object.assign(playerElementRef.style, { width: '', height: '', top: '', left: '', transform: '' });
        }
        if (playerPlaceholder && playerPlaceholder.isConnected) playerPlaceholder.style.display = 'none';
        // Disconnect ResizeObserver when sticky mode is deactivated
        if (stickyResizeObserver) {
            stickyResizeObserver.disconnect();
            stickyResizeObserver = null;
            if (DEBUG) console.log('[EYV DBG] ResizeObserver disconnected');
        }
        stickyButtonElement.classList.remove('active');
        // SECURITY: innerHTML is safe here - pinSVGIcon is a static SVG string constant (no user input)
        stickyButtonElement.innerHTML = pinSVGIcon;
        // Reset state flags to prevent desynchronization (optionally preserve pause flag)
        wasStickyBeforePiP = false;
        if (!preservePauseFlag) {
            wasStickyBeforePause = false;
        }
        wasStickyBeforeOsFullscreen = false;
    }
    
    // --- SYNC BUTTON DIMENSIONS WITH YOUTUBE ---
    function syncButtonDimensions() {
        // Find a native YouTube button to copy dimensions from
        const nativeButton = document.querySelector('.ytp-settings-button') ||
                             document.querySelector('.ytp-fullscreen-button');

        if (!nativeButton) return;

        const computedStyle = getComputedStyle(nativeButton);
        const width = computedStyle.width;
        const height = computedStyle.height;

        // Apply to all our buttons
        const ourButtons = document.querySelectorAll('.eyv-player-button, .eyv-pip-button');
        ourButtons.forEach(btn => {
            btn.style.width = width;
            btn.style.height = height;
        });

        if (DEBUG) console.log(`[EYV DBG] Synced button dimensions to ${width} x ${height}`);
    }

    // --- STICKY PLAYER LOGIC ---
    function createStickyButtonLogic(playerElement, videoElementForPiPWatch) {
        const button = document.createElement('button');
        let isTransitioning = false;

        const clickHandler = (event) => {
            try {
                if (DEBUG) console.log('[EYV DBG Click] Click handler entered');
                event.stopPropagation();

                // Prevent rapid clicking during transitions
                if (isTransitioning) {
                    if (DEBUG) console.log('[EYV DBG Click] Button click ignored - transition in progress');
                    return;
                }

                isTransitioning = true;
                setTimeout(() => { isTransitioning = false; }, BUTTON_TRANSITION_MS);

                wasStickyBeforePause = false; // Manual click resets pause-related state
                const currentlySticky = button.classList.contains('active');
                if (DEBUG) console.log(`[EYV DBG Click] currentlySticky=${currentlySticky}`);
            if (!currentlySticky) {
                if (DEBUG) console.log('[EYV DBG Click] Attempting to activate sticky mode');
                const ytdApp = document.querySelector('ytd-app');
                const watchFlexy = document.querySelector('ytd-watch-flexy');

                const isPiP = document.pictureInPictureElement === videoElementForPiPWatch;
                const isMini = ytdApp?.hasAttribute('miniplayer-is-active');
                const isYtFull = ytdApp?.hasAttribute('fullscreen');
                const isOsFull = !!document.fullscreenElement;

                if (DEBUG) console.log(`[EYV DBG Click] Conflict check: PiP=${isPiP}, mini=${isMini}, ytFull=${isYtFull}, osFull=${isOsFull}`);

                if (isPiP || isMini || isYtFull || isOsFull) {
                    console.log("[EYV] Cannot activate sticky: conflicting mode active.");
                    if (DEBUG) console.log('[EYV DBG Click] Returning early due to conflicting mode');
                    return;
                }

                if (DEBUG) console.log('[EYV DBG Click] Getting player dimensions...');
                const rect = playerElement.getBoundingClientRect();
                const initialWidth = rect.width; const initialHeight = rect.height;
                const initialLeft = rect.left; const initialTop = rect.top;
                if (DEBUG) console.log(`[EYV DBG Click] Player dimensions: ${initialWidth}x${initialHeight} at (${initialLeft},${initialTop})`);

                if (initialHeight === 0 || initialWidth === 0) {
                    console.warn('[EYV] Cannot activate sticky: player dimensions are zero (may be transitioning)');
                    if (DEBUG) console.log('[EYV DBG Click] Returning early due to zero dimensions');
                    return;
                }

                // Calculate and validate aspect ratio to prevent Infinity/NaN
                const calculatedAspectRatio = initialHeight / initialWidth;
                if (isFinite(calculatedAspectRatio) && calculatedAspectRatio > 0) {
                    originalPlayerAspectRatio = calculatedAspectRatio;
                } else {
                    console.warn('[EYV] Invalid aspect ratio calculated, using default 9:16');
                    originalPlayerAspectRatio = 9 / 16; // Default aspect ratio
                }
                if (!playerPlaceholder || !playerPlaceholder.isConnected) {
                    playerPlaceholder = document.createElement('div'); playerPlaceholder.id = 'eyv-player-placeholder';
                    if (playerElement.parentNode?.isConnected) {
                        playerElement.parentNode.insertBefore(playerPlaceholder, playerElement);
                    } else {
                        console.warn('[EYV] Cannot create placeholder - parent node not connected');
                        return;
                    }
                }
                if (playerPlaceholder.isConnected) {
                    playerPlaceholder.style.width = `${initialWidth}px`; playerPlaceholder.style.height = `${initialHeight}px`;
                    // Sanitize CSS color value from YouTube page to prevent injection
                    const bgColor = getComputedStyle(document.documentElement).getPropertyValue('--yt-spec-base-background');
                    playerPlaceholder.style.backgroundColor = sanitizeColorValue(bgColor);
                    playerPlaceholder.style.display = 'block';
                }
                playerElement.classList.add('eyv-player-fixed');
                const isTheater = watchFlexy?.hasAttribute('theater');
                // Re-use isYtFull already declared above
                if (!isTheater && !isYtFull && !document.fullscreenElement) {
                    Object.assign(playerElement.style, { width: `${initialWidth}px`, height: `${initialHeight}px`, left: `${initialLeft}px`, top: `${initialTop}px`, transform: 'translateX(0%)' });
                } else { centerStickyPlayer(playerElement); }
                // SECURITY: innerHTML is safe here - pinSVGIconActive is a static SVG string constant (no user input)
                button.classList.add('active'); button.innerHTML = pinSVGIconActive;

                // Track that sticky was active during this video for "End Deactivation" re-activation
                wasStickyDuringCurrentVideo = true;
                if (DEBUG) console.log('[EYV DBG] Sticky activated - set wasStickyDuringCurrentVideo = true');

                // Setup ResizeObserver for smooth real-time resizing
                if (!stickyResizeObserver) {
                    stickyResizeObserver = new ResizeObserver(() => {
                        if (playerElementRef?.classList.contains('eyv-player-fixed')) {
                            // Use requestAnimationFrame to ensure smooth resize
                            requestAnimationFrame(() => {
                                centerStickyPlayer(playerElementRef);
                            });
                        }
                    });

                    // Observe the elements that determine player size
                    const watchFlexy = document.querySelector('ytd-watch-flexy');
                    const primaryCol = document.querySelector('#primary.ytd-watch-flexy');
                    if (watchFlexy?.isConnected) stickyResizeObserver.observe(watchFlexy);
                    if (primaryCol?.isConnected) stickyResizeObserver.observe(primaryCol);

                    if (DEBUG) console.log('[EYV DBG] ResizeObserver setup for smooth resizing');
                }
            } else { deactivateStickyModeInternal(); }
            } catch (error) {
                console.error('[EYV] Sticky button click error:', error);
                isTransitioning = false; // Reset flag on error
            }
        };
        cleanupRegistry.addListener(button, 'click', clickHandler);
        // Note: PiP event listener is added in initializeFeatures() to avoid duplication
        return button;
    }

    // --- PLAYER STATE OBSERVER ---
    function setupPlayerStateObserver(playerNodeToObserve, videoElement) {
        if (playerStateObserver) playerStateObserver.disconnect();
        const ytdApp = document.querySelector('ytd-app');
        const watchFlexy = document.querySelector('ytd-watch-flexy');
        const observerConfig = { attributes: true, attributeOldValue: true, attributeFilter: ['miniplayer-is-active', 'fullscreen', 'theater', 'class'] };

        let rafId = null;
        let pendingMutations = [];

        const processMutations = () => {
            const mutationsList = pendingMutations;
            pendingMutations = [];
            rafId = null;
            try {
                // Early exit if critical elements are disconnected (observer fired after cleanup)
                if (!playerNodeToObserve || !playerNodeToObserve.isConnected) {
                    if (DEBUG) console.log('[EYV DBG MO] Player node disconnected, skipping callback');
                    return;
                }
                if (!stickyButtonElement || !stickyButtonElement.isConnected) {
                    if (DEBUG) console.log('[EYV DBG MO] Sticky button disconnected, skipping callback');
                    return;
                }

                let shouldDeactivate = false;
                let shouldRecenter = false;
                let isExitingMiniplayer = false;
                for (const m of mutationsList) {
                if (m.type !== 'attributes') continue;
                const target = m.target; const attr = m.attributeName;
                if (DEBUG) console.log(`[EYV DBG MO] Attr '${attr}' on ${target.tagName}${target.id?'#'+target.id:''}. OldValue: ${m.oldValue}`);
                if (target === ytdApp) {
                    if (attr === 'miniplayer-is-active') {
                        if (ytdApp.hasAttribute(attr)) {
                            if (DEBUG) console.log("[EYV DBG MO] YT Miniplayer (ytd-app) ACTIVATED.");
                            if (stickyButtonElement?.classList.contains('active')) {
                                wasStickyBeforePiP = true;
                                shouldDeactivate = true;
                            }
                        } else if (m.oldValue !== null) {
                            if (DEBUG) console.log("[EYV DBG MO] YT Miniplayer (ytd-app) EXITED.");
                            isExitingMiniplayer = true;
                        }
                    } else if (attr === 'fullscreen' && ytdApp.hasAttribute(attr)) {
                        shouldDeactivate = true; if (DEBUG) console.log("[EYV DBG MO] YT Fullscreen (ytd-app) ACTIVATED.");
                    }
                } else if (target === watchFlexy) {
                    if (attr === 'fullscreen' && watchFlexy.hasAttribute(attr)) {
                        shouldDeactivate = true; if (DEBUG) console.log("[EYV DBG MO] YT Fullscreen (watch-flexy) ACTIVATED.");
                    } else if (attr === 'theater') {
                        shouldRecenter = true;
                        if (DEBUG) console.log("[EYV DBG MO] Theater mode toggled (watch-flexy).");
                        // Sync button dimensions when theater mode toggles
                        syncButtonDimensions();
                    }
                } else if (target === playerNodeToObserve && attr === 'class') {
                    if (playerNodeToObserve.classList.contains('ytp-fullscreen')) {
                        shouldDeactivate = true; if (DEBUG) console.log("[EYV DBG MO] ytp-fullscreen class ADDED.");
                    } else if (m.oldValue?.includes('ytp-fullscreen')) {
                        shouldRecenter = true; if (DEBUG) console.log("[EYV DBG MO] ytp-fullscreen class REMOVED.");
                    }
                }
                if (shouldDeactivate && stickyButtonElement?.isConnected && stickyButtonElement.classList.contains('active')) {
                    deactivateStickyModeInternal();
                    return;
                }
            }
                if (isExitingMiniplayer) {
                    tryReactivatingStickyAfterPiPOrMiniplayer(videoElement);
                    wasStickyBeforePiP = false;
                } else if (shouldRecenter && playerElementRef?.isConnected && playerElementRef.classList.contains('eyv-player-fixed')) {
                    centerStickyPlayer(playerElementRef);
                }
            } catch (error) {
                console.error('[EYV] MutationObserver callback error:', error);
            }
        };

        const callback = (mutationsList) => {
            // Batch mutations using requestAnimationFrame for better performance
            pendingMutations.push(...mutationsList);
            if (!rafId) {
                rafId = requestAnimationFrame(processMutations);
            }
        };

        playerStateObserver = new MutationObserver(callback);
        // Only observe if elements are connected
        if (ytdApp?.isConnected) playerStateObserver.observe(ytdApp, observerConfig);
        if (watchFlexy?.isConnected) playerStateObserver.observe(watchFlexy, observerConfig);
        if (playerNodeToObserve?.isConnected) playerStateObserver.observe(playerNodeToObserve, observerConfig);
        // Register observer for cleanup
        cleanupRegistry.addObserver(playerStateObserver);
        if (DEBUG) console.log("[EYV DBG] PlayerStateObserver setup.");
    }

    // --- VIDEO ELEMENT OBSERVER ---
    // Watches for YouTube replacing the video element (e.g., during ads or quality changes)
    function setupVideoElementObserver(playerElement) {
        if (videoElementObserver) videoElementObserver.disconnect();

        const callback = (mutations) => {
            // Early exit if elements disconnected
            if (!playerElement || !playerElement.isConnected) {
                if (DEBUG) console.log('[EYV DBG Video Observer] Player disconnected, skipping');
                return;
            }

            const newVideoElement = playerElement.querySelector('video.html5-main-video');

            // If video element changed, reattach listeners
            if (newVideoElement && newVideoElement !== currentVideoElement) {
                if (DEBUG) console.log('[EYV DBG Video Observer] Video element replaced, reattaching listeners');
                currentVideoElement = newVideoElement;

                // Video element was replaced - listeners need to be reattached
                // This happens during ad insertion or quality changes
                // The WeakSet check will fail for the new element, causing listeners to be reattached
                // No action needed here - the next controls poll iteration will detect and reattach
            }
        };

        videoElementObserver = new MutationObserver(callback);

        // Only observe if element is connected
        if (playerElement?.isConnected) {
            videoElementObserver.observe(playerElement, {
                childList: true,
                subtree: true
            });
        } else {
            if (DEBUG) console.log('[EYV DBG] Skipping videoElementObserver setup - playerElement not connected');
        }

        // Register observer for cleanup
        cleanupRegistry.addObserver(videoElementObserver);

        if (DEBUG) console.log("[EYV DBG] VideoElementObserver setup.");
    }

    // --- HANDLE BROWSER/OS FULLSCREEN EXIT/ENTER ---
    function handleFullscreenChange() {
        try {
            if (stickyButtonElement) {
                if (document.fullscreenElement) {
                    if (stickyButtonElement.classList.contains('active')) {
                        wasStickyBeforeOsFullscreen = true;
                        deactivateStickyModeInternal();
                    } else { wasStickyBeforeOsFullscreen = false; }
                } else {
                    const videoElement = playerElementRef?.querySelector('video.html5-main-video');
                    if (videoElement?.isConnected) {
                        tryReactivatingStickyAfterPiPOrMiniplayer(videoElement, true);
                    }
                    wasStickyBeforeOsFullscreen = false;
                }
            }
        } catch (error) {
            console.error('[EYV] Fullscreen change handler error:', error);
        }
    }
    
    // --- HELPER TO TRY RE-ACTIVATING STICKY ---
    function tryReactivatingStickyAfterPiPOrMiniplayer(videoElement, isExitingOsFullscreen = false) {
        if (!videoElement) {
            if (DEBUG) console.log("[EYV DBG tryReactivating] No videoElement provided.");
            return;
        }
        loadSettings(['defaultStickyEnabled'])
            .then(result => {
                const shouldTryReactivate = (isExitingOsFullscreen && (wasStickyBeforeOsFullscreen || (result && result.defaultStickyEnabled))) ||
                                          (!isExitingOsFullscreen && (wasStickyBeforePiP || (result && result.defaultStickyEnabled)));
                if (shouldTryReactivate) {
                    if (DEBUG) console.log(`[EYV DBG tryReactivating] Attempting re-activation. wasStickyPiP: ${wasStickyBeforePiP}, wasStickyOsFS: ${wasStickyBeforeOsFullscreen}, default: ${result.defaultStickyEnabled}`);
                    const ytdApp = document.querySelector('ytd-app');
                    const isMini = ytdApp?.hasAttribute('miniplayer-is-active');
                    const isYtFull = ytdApp?.hasAttribute('fullscreen');
                    const isCurrentlyOsFull = !!document.fullscreenElement;
                    if (!(document.pictureInPictureElement === videoElement || isMini || isYtFull || isCurrentlyOsFull)) {
                        if (stickyButtonElement && !stickyButtonElement.classList.contains('active')) {
                            if (DEBUG) console.log("[EYV DBG tryReactivating] Conditions met, clicking sticky button.");
                            stickyButtonElement.click();
                        } else if (stickyButtonElement?.classList.contains('active')) {
                            if (DEBUG) console.log("[EYV DBG tryReactivating] Sticky already active, ensuring it's centered.");
                            if(playerElementRef) centerStickyPlayer(playerElementRef);
                        }
                    } else { if (DEBUG) console.log("[EYV DBG tryReactivating] Cannot re-activate sticky, another conflicting mode active or re-entering OS fullscreen.");}
                } else if (playerElementRef?.classList.contains('eyv-player-fixed')) {
                    if (DEBUG && !isExitingOsFullscreen) console.log("[EYV DBG tryReactivating] No re-activation criteria. Centering if fixed (after PiP/Miniplayer exit).");
                    if (DEBUG && isExitingOsFullscreen) console.log("[EYV DBG tryReactivating] No re-activation criteria. Centering if fixed (after OS Fullscreen exit).");
                    centerStickyPlayer(playerElementRef);
                }
            })
            .catch(error => {
                if (DEBUG) console.log("[EYV DBG] Failed to load settings for reactivation:", error);
            });
    }

    // --- PICTURE-IN-PICTURE (PIP) LOGIC ---
    function createPiPButtonLogic(videoElement) {
        const button = document.createElement('button');
        let isTransitioning = false;

        const pipClickHandler = async (event) => {
            event.stopPropagation();
            if (!document.pictureInPictureEnabled) return;

            // Prevent rapid clicking during transitions
            if (isTransitioning) {
                if (DEBUG) console.log('[EYV DBG] PiP button click ignored - transition in progress');
                return;
            }

            isTransitioning = true;
            setTimeout(() => { isTransitioning = false; }, PIP_TRANSITION_MS);
            try {
                if (videoElement !== document.pictureInPictureElement) {
                    if (stickyButtonElement?.classList.contains('active')) {
                        wasStickyBeforePiP = true;
                        if (DEBUG) console.log("[EYV DBG] PiP requested while sticky active. Deactivating sticky.");
                        deactivateStickyModeInternal();
                        await new Promise(resolve => setTimeout(resolve, 50));
                    } else { wasStickyBeforePiP = false; }
                    await videoElement.requestPictureInPicture();
                } else {
                    await document.exitPictureInPicture();
                }
            } catch (error) {
                console.error('[EYV] PiP Error:', error);
                wasStickyBeforePiP = false;
            }
        };
        cleanupRegistry.addListener(button, 'click', pipClickHandler);
        return button;
    }

    // --- STICKY PLAYER POSITIONING & RESIZING ---
    function centerStickyPlayer(fixedPlayer) { 
        if (!fixedPlayer?.classList.contains('eyv-player-fixed')) return;
        const mastheadOffset = getMastheadOffset();
        const watchFlexy = document.querySelector('ytd-watch-flexy');
        const primaryCol = document.querySelector('#primary.ytd-watch-flexy');
        let refRect;
        const isTheater = watchFlexy?.hasAttribute('theater');
        const isYtFull = document.querySelector('ytd-app')?.hasAttribute('fullscreen');
        if (isTheater || isYtFull) { refRect = watchFlexy.getBoundingClientRect(); }
        else if (primaryCol) { refRect = primaryCol.getBoundingClientRect(); }
        else if (watchFlexy) { refRect = watchFlexy.getBoundingClientRect(); }
        else {
            const vpW = window.innerWidth * 0.9;
            const vpL = (window.innerWidth - vpW) / 2;
            const vpH = vpW * (isFinite(originalPlayerAspectRatio) && originalPlayerAspectRatio > 0 ? originalPlayerAspectRatio : 9/16);
            Object.assign(fixedPlayer.style, { width: `${vpW}px`, height: `${vpH}px`, left: `${vpL}px`, top: `${mastheadOffset}px`, transform: 'translateX(0%)' }); return;
        }
        let newW = refRect.width, newL = refRect.left;
        if (isNaN(newW) || newW <= 0) newW = parseFloat(fixedPlayer.style.width) || (window.innerWidth > 700 ? 640 : window.innerWidth * 0.9);

        // Calculate height with validation to prevent NaN/Infinity
        const validAspectRatio = (isFinite(originalPlayerAspectRatio) && originalPlayerAspectRatio > 0) ? originalPlayerAspectRatio : 9/16;
        const newH = newW * validAspectRatio;

        // Final validation before applying styles
        if (!isFinite(newW) || !isFinite(newH) || newW <= 0 || newH <= 0) {
            console.warn('[EYV] Invalid dimensions in centerStickyPlayer, aborting');
            return;
        }

        Object.assign(fixedPlayer.style, { width: `${newW}px`, height: `${newH}px`, left: `${newL}px`, top: `${mastheadOffset}px`, transform: 'translateX(0%)' });
    }

    // --- CSS INJECTION ---
    // Injects all necessary CSS styles into the page for the extension's UI and features.
    function injectAllStyles() {
        const style = document.createElement('style');
        style.id = 'eyv-styles';

        // Calculate appropriate z-index - should be above main content but below YouTube's sidebar drawer
        // YouTube's sidebar drawer (tp-yt-app-drawer) has z-index 2030
        // Setting sticky player to 2020 ensures it appears above content but below sidebar/modals
        const zIndex = 2020;

        style.textContent = `
            .eyv-player-fixed {
                position: fixed !important;
                z-index: ${zIndex} !important;
                background-color: var(--yt-spec-base-background, #0f0f0f);
                box-sizing: border-box !important; 
                box-shadow: 0 2px 10px rgba(0,0,0,0.2);
            }

            .eyv-player-fixed > div#movie_player,
            .eyv-player-fixed > div.html5-video-player {
                width: 100% !important; 
                height: 100% !important;
                max-width: 100% !important;
                max-height: 100% !important;
                top: 0 !important;
                left: 0 !important;
                bottom: auto !important;
                right: auto !important;
                transform: none !important;
            }

            .eyv-player-fixed .html5-video-container,
            .eyv-player-fixed video.html5-main-video {
                width: 100% !important; 
                height: 100% !important;
                max-width: 100% !important; 
                max-height: 100% !important; 
                object-fit: contain !important;
                top: 0 !important;
                left: 0 !important;
            }

            #eyv-player-placeholder { 
                display: none;
            }

            .eyv-player-button, .eyv-pip-button {
                display: inline-flex !important;
                align-items: center !important;
                justify-content: center !important;
                padding: 0 !important;
                /* Width and height set dynamically via JavaScript to match YouTube's buttons */
                fill: var(--ytp-icon-color, #cccccc) !important;
                min-width: auto !important;
                position: relative !important;
                top: 0px !important;
                margin: 0 !important;
                cursor: pointer !important;
                overflow: visible !important;
            }

            .eyv-player-button svg, .eyv-pip-button svg { 
                width: 24px !important;
                height: 24px !important; 
                display: block !important;
            }

            .eyv-player-button.active, 
            .eyv-pip-button.active { 
                opacity: 1 !important;
            }
        `;
        document.head.append(style);
        if (DEBUG) console.log("[EYV DBG] Injected CSS styles."); else console.log("[EYV] Injected CSS styles.");
    }
})();