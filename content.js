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
            originalPlayerParent = null;
            originalPlayerNextSibling = null;

            // Cancel any pending RAF callbacks
            if (playerStateObserverRafId) {
                cancelAnimationFrame(playerStateObserverRafId);
                playerStateObserverRafId = null;
            }

            // Clear sticky resize timeout
            if (stickyResizeTimeout) {
                clearTimeout(stickyResizeTimeout);
                stickyResizeTimeout = null;
            }

            // Null interval variables to prevent memory leaks
            mainPollInterval = null;
            playerStateObserver = null;
            videoElementObserver = null;
            stickyResizeObserver = null;
            currentVideoElement = null;
            stickyButtonElement = null; // Clear button reference too

            // FIX: Reset WeakSets to prevent "already attached" detection on navigation back
            // WeakSets can't be cleared, so we create new ones
            videoElementsWithListeners = new WeakSet();
            pipButtonsWithListeners = new WeakSet();

            // Remove chrome.runtime.onMessage listener to prevent accumulation
            if (messageListenerRef && typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
                try {
                    chrome.runtime.onMessage.removeListener(messageListenerRef);
                    if (DEBUG) console.log('[EYV DBG] Removed chrome.runtime.onMessage listener');
                } catch (e) {
                    // Context may be invalidated, ignore errors
                    if (DEBUG) console.log('[EYV DBG] Could not remove message listener:', e.message);
                }
                messageListenerRef = null;
            }

            if (DEBUG) console.log('[EYV DBG] Cleanup complete: all listeners, observers, intervals, state flags, WeakSets, and UI elements removed.');
        }
    };

    // --- YOUTUBE SPA NAVIGATION HANDLERS ---
    // YouTube is a Single Page Application (SPA) that navigates without full page reloads.
    // We must clean up and reinitialize on navigation to prevent memory leaks.
    window.addEventListener('yt-navigate-start', () => {
        try {
            if (DEBUG) console.log('[EYV DBG] YouTube navigation starting, cleaning up...');

            // FIX: Check for the fixed class directly, not just the button state
            // This handles the case where the button was removed but the player is still sticky
            const fixedPlayer = document.querySelector('.eyv-player-fixed');
            const isStickyActive = stickyButtonElement?.classList.contains('active') || fixedPlayer;

            if (isStickyActive) {
                if (DEBUG) console.log('[EYV DBG] Sticky mode detected, cleaning up...');

                // Use the found element or the ref
                const targetPlayer = fixedPlayer || playerElementRef;

                if (targetPlayer && targetPlayer.isConnected) {
                    // Restore player to original DOM position if it was moved to body
                    if (originalPlayerParent && originalPlayerParent.isConnected) {
                        if (originalPlayerNextSibling && originalPlayerNextSibling.isConnected) {
                            originalPlayerParent.insertBefore(targetPlayer, originalPlayerNextSibling);
                        } else {
                            originalPlayerParent.appendChild(targetPlayer);
                        }
                        if (DEBUG) console.log('[EYV DBG] Restored player to original DOM position during cleanup');
                    } else if (targetPlayer.parentElement === document.body) {
                        // Fallback: find the player-container and move it back
                        const playerContainer = document.querySelector('#player-container');
                        if (playerContainer && playerContainer.isConnected) {
                            playerContainer.appendChild(targetPlayer);
                            if (DEBUG) console.log('[EYV DBG] Restored player to #player-container during cleanup');
                        }
                    }
                    originalPlayerParent = null;
                    originalPlayerNextSibling = null;

                    targetPlayer.classList.remove('eyv-player-fixed');
                    targetPlayer.style.removeProperty('width');
                    targetPlayer.style.removeProperty('height');
                    targetPlayer.style.removeProperty('left');
                    targetPlayer.style.removeProperty('top');
                    targetPlayer.style.removeProperty('transform');

                    // Also clear styles on internal elements that may have been affected
                    const moviePlayer = targetPlayer.querySelector('#movie_player');
                    const videoElement = targetPlayer.querySelector('video.html5-main-video');
                    const videoContainer = targetPlayer.querySelector('.html5-video-container');

                    if (moviePlayer) {
                        moviePlayer.style.removeProperty('width');
                        moviePlayer.style.removeProperty('height');
                    }
                    if (videoElement) {
                        videoElement.style.removeProperty('width');
                        videoElement.style.removeProperty('height');
                        videoElement.style.removeProperty('left');
                        videoElement.style.removeProperty('top');
                    }
                    if (videoContainer) {
                        videoContainer.style.removeProperty('width');
                        videoContainer.style.removeProperty('height');
                    }

                    if (DEBUG) console.log('[EYV DBG] Cleared sticky styles from player and internal elements');
                }

                const placeholder = document.getElementById('eyv-player-placeholder');
                if (placeholder) placeholder.style.display = 'none';
            } else {
                if (DEBUG) console.log('[EYV DBG] Sticky mode not active, skipping cleanup');
            }

            // Only clean up video element styles when navigating FROM a watch page
            // This prevents breaking Shorts and other YouTube pages that use different video players
            if (window.location.pathname === '/watch') {
                const allVideoElements = document.querySelectorAll('video.html5-main-video');
                allVideoElements.forEach(video => {
                    video.style.removeProperty('width');
                    video.style.removeProperty('height');
                    video.style.removeProperty('left');
                    video.style.removeProperty('top');
                    video.style.removeProperty('transform');
                    video.style.width = '';
                    video.style.height = '';
                    video.style.left = '';
                    video.style.top = '';
                });

                const allVideoContainers = document.querySelectorAll('.html5-video-container');
                allVideoContainers.forEach(container => {
                    container.style.removeProperty('width');
                    container.style.removeProperty('height');
                    container.style.width = '';
                    container.style.height = '';
                });

                if (DEBUG) console.log('[EYV DBG] Cleared all video element styles on navigation from watch page');
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
                    // Restore player to original DOM position if it was moved to body
                    if (stickyPlayer.parentElement === document.body) {
                        const playerContainer = document.querySelector('#player-container');
                        if (playerContainer && playerContainer.isConnected) {
                            playerContainer.appendChild(stickyPlayer);
                            if (DEBUG) console.log('[EYV DBG] Restored player to #player-container during nav-finish');
                        }
                    }
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

                    // Also clear styles on internal elements
                    const moviePlayer = stickyPlayer.querySelector('#movie_player');
                    const videoElement = stickyPlayer.querySelector('video.html5-main-video');
                    const videoContainer = stickyPlayer.querySelector('.html5-video-container');

                    if (moviePlayer) {
                        moviePlayer.style.width = '';
                        moviePlayer.style.height = '';
                    }
                    if (videoElement) {
                        videoElement.style.width = '';
                        videoElement.style.height = '';
                        videoElement.style.left = '';
                        videoElement.style.top = '';
                    }
                    if (videoContainer) {
                        videoContainer.style.width = '';
                        videoContainer.style.height = '';
                    }
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

    // Check for player directly in body (our DOM relocation) - must clean this up
    const playerInBody = document.body.querySelector(':scope > ytd-player');
    if (playerInBody) {
        console.log('[EYV] Found ytd-player in body, cleaning up...');
        const playerContainer = document.querySelector('#player-container');
        if (playerContainer && playerContainer.isConnected) {
            playerContainer.appendChild(playerInBody);
            console.log('[EYV] Moved ytd-player back to #player-container');
        }
        playerInBody.classList.remove('eyv-player-fixed');
        Object.assign(playerInBody.style, { width: '', height: '', left: '', transform: '', top: '', position: '', zIndex: '' });
    }

    // Also check by class (fallback)
    const oldStickyPlayer = document.querySelector('.eyv-player-fixed');
    if (oldStickyPlayer && oldStickyPlayer !== playerInBody) {
        if (oldStickyPlayer.parentElement === document.body) {
            const playerContainer = document.querySelector('#player-container');
            if (playerContainer && playerContainer.isConnected) {
                playerContainer.appendChild(oldStickyPlayer);
            }
        }
        oldStickyPlayer.classList.remove('eyv-player-fixed');
        Object.assign(oldStickyPlayer.style, { width: '', height: '', left: '', transform: '', top: '' });
    }

    // Only clean up video elements on watch pages (prevents breaking Shorts and other pages)
    // This catches back button navigation from sticky mode
    if (window.location.pathname === '/watch') {
        const allVideos = document.querySelectorAll('video.html5-main-video');
        const allContainers = document.querySelectorAll('.html5-video-container');
        const allMoviePlayers = document.querySelectorAll('#movie_player');

        allVideos.forEach(video => {
            video.style.width = '';
            video.style.height = '';
            video.style.left = '';
            video.style.top = '';
            video.style.transform = '';
        });
        allContainers.forEach(container => {
            container.style.width = '';
            container.style.height = '';
        });
        allMoviePlayers.forEach(mp => {
            mp.style.width = '';
            mp.style.height = '';
        });

        if (allVideos.length > 0) {
            console.log(`[EYV] Cleaned up ${allVideos.length} video element(s) on script load`);
        }
    }

    // Set up a temporary MutationObserver to catch video elements with stale styles
    // Player cleanup is handled by delayed checks below (more reliable)
    const staleElementCleanupObserver = new MutationObserver((mutations) => {
        const videos = document.querySelectorAll('video.html5-main-video');
        videos.forEach(video => {
            const top = parseInt(video.style.top, 10);
            if (top < 0) {
                video.style.width = '';
                video.style.height = '';
                video.style.left = '';
                video.style.top = '';
                video.style.transform = '';
                console.log('[EYV] Cleaned stale video styles via MutationObserver');
            }
        });
    });

    // Only observe if we're NOT on a watch page and NOT on Shorts
    // This cleanup logic is only needed for pages that might have stale sticky player state
    if (window.location.pathname !== '/watch' && !window.location.pathname.startsWith('/shorts')) {
        staleElementCleanupObserver.observe(document.body, { childList: true, subtree: true, attributes: true });

        // Also run cleanup checks with delays to catch elements already present
        // (MutationObserver only fires on changes, not existing elements)
        const runCleanupCheck = () => {
            const playerInBody = document.body.querySelector(':scope > ytd-player');
            if (playerInBody) {
                console.log('[EYV] Delayed check: Found ytd-player in body, cleaning up...');
                playerInBody.classList.remove('eyv-player-fixed');
                playerInBody.style.display = 'none';
                Object.assign(playerInBody.style, { width: '', height: '', left: '', transform: '', top: '', position: '', zIndex: '' });
                // Try to move it back if container exists
                const playerContainer = document.querySelector('ytd-watch-flexy #player-container');
                if (playerContainer && playerContainer.isConnected) {
                    playerContainer.appendChild(playerInBody);
                    playerInBody.style.display = '';
                    console.log('[EYV] Delayed check: Moved ytd-player back to container');
                }
            }
        };

        // Run checks at various delays
        setTimeout(runCleanupCheck, 100);
        setTimeout(runCleanupCheck, 500);
        setTimeout(runCleanupCheck, 1000);
        setTimeout(runCleanupCheck, 2000);

        // Disconnect observer after 5 seconds
        setTimeout(() => {
            staleElementCleanupObserver.disconnect();
        }, 5000);
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
    let isAutoPauseResumeActive = false; // Flag to prevent interference with user pause/play
    let isResizingPlayer = false; // Flag to prevent resize event loops
    let cachedButtonWidth = null; // Cached button dimensions for dynamic insertion
    let cachedButtonHeight = null;
    let lastSyncedWidth = null; // Track last synced dimensions to detect changes
    let lastSyncedHeight = null;
    let activeSyncInterval = null; // Track active sync polling to prevent overlaps
    let playerStateObserverRafId = null; // Track RAF ID for playerStateObserver to cancel on cleanup
    let stickyResizeTimeout = null; // Track ResizeObserver debounce timeout for cleanup
    let originalPlayerParent = null; // Store original parent before moving to body for sticky mode
    let originalPlayerNextSibling = null; // Store next sibling for correct reinsertion when deactivating

    // FIX: Move buttonsToInsert to global scope so onMessage can update it dynamically
    const buttonsToInsert = { sticky: null, pip: null };

    // WeakSets to track elements with attached listeners (survives element replacement)
    // Using 'let' instead of 'const' so we can reset them in cleanup()
    let videoElementsWithListeners = new WeakSet();
    let pipButtonsWithListeners = new WeakSet();

    // Store message listener reference for cleanup
    let messageListenerRef = null;

    // --- ADD MESSAGE LISTENER FOR POPUP SETTINGS ---
    // Named handler function so it can be removed during cleanup
    const handleChromeMessage = (message, sender, sendResponse) => {
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
                } else if (message.key === 'defaultStickyEnabled') {
                    settingsCache.defaultStickyEnabled = message.value;

                    // If enabled and video is currently playing, activate sticky mode immediately
                    if (message.value === true) {
                        const videoElement = document.querySelector('video.html5-main-video');
                        const ytdApp = document.querySelector('ytd-app');
                        const isMini = ytdApp?.hasAttribute('miniplayer-is-active');
                        const isFull = ytdApp?.hasAttribute('fullscreen') || !!document.fullscreenElement;
                        const isPiP = document.pictureInPictureElement === videoElement;

                        // Only activate if: button exists, not already active, no conflicting modes, and video is playing
                        if (stickyButtonElement &&
                            !stickyButtonElement.classList.contains('active') &&
                            !isMini && !isFull && !isPiP &&
                            videoElement && !videoElement.paused) {
                            if (DEBUG) console.log('[EYV DBG] Auto-Activate enabled while video playing - activating sticky mode');
                            stickyButtonElement.click();
                        } else if (DEBUG) {
                            console.log('[EYV DBG] Auto-Activate enabled but conditions not met for immediate activation');
                        }
                    }
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
                                stickyButtonElement.style.display = 'inline-flex';

                                // FIX: Sync dimension immediately
                                if (cachedButtonWidth) {
                                    stickyButtonElement.style.width = cachedButtonWidth;
                                    stickyButtonElement.style.height = cachedButtonHeight;
                                }

                                // Insert it in the correct position
                                const settingsButton = playerRightControls.querySelector('.ytp-settings-button');
                                const pipBtn = playerRightControls.querySelector('.eyv-pip-button');

                                if (settingsButton && settingsButton.parentNode === playerRightControls) {
                                    playerRightControls.insertBefore(stickyButtonElement, pipBtn || settingsButton);
                                } else {
                                    playerRightControls.prepend(stickyButtonElement);
                                }

                                // FIX: Update global reference for hover logic
                                buttonsToInsert.sticky = stickyButtonElement;

                                // FIX: Add animation class so it becomes visible
                                setTimeout(() => stickyButtonElement?.classList.add('eyv-animate-in'), 10);

                                // FIX: Check if auto-activate is enabled and activate immediately
                                if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) {
                                    chrome.storage.local.get(['defaultStickyEnabled'], (result) => {
                                        // Check for errors and context invalidation
                                        if (chrome.runtime.lastError) {
                                            console.error('[EYV] Storage error:', chrome.runtime.lastError.message);
                                            return;
                                        }
                                        if (!chrome.runtime?.id) {
                                            console.warn('[EYV] Chrome context invalidated during storage operation');
                                            return;
                                        }
                                        if (result?.defaultStickyEnabled && stickyButtonElement && !stickyButtonElement.classList.contains('active')) {
                                            setTimeout(() => {
                                                stickyButtonElement.click();
                                                if (DEBUG) console.log('[EYV DBG] Auto-activated sticky player (defaultStickyEnabled is true)');
                                            }, 100);
                                        }
                                    });
                                }

                                if (DEBUG) console.log('[EYV DBG] Sticky player button created');
                            } else {
                                if (DEBUG) console.log('[EYV DBG] Cannot create sticky button - player elements not found');
                            }
                        }
                    } else {
                        // DISABLE

                        // 1. Handle Deactivation (Check in-memory element if DOM element is missing)
                        const targetBtn = stickyBtn || stickyButtonElement || buttonsToInsert.sticky;
                        if (targetBtn && targetBtn.classList.contains('active')) {
                            targetBtn.click(); // Deactivate sticky mode
                        }

                        // 2. Remove from DOM - check both queried element and in-memory references
                        // Button may be in DOM (stickyBtn) or stored in buttonsToInsert for hover re-insertion
                        if (stickyBtn && stickyBtn.parentNode) {
                            stickyBtn.remove();
                        }
                        if (buttonsToInsert.sticky && buttonsToInsert.sticky.parentNode) {
                            buttonsToInsert.sticky.remove();
                        }
                        if (stickyButtonElement && stickyButtonElement.parentNode) {
                            stickyButtonElement.remove();
                        }

                        // 3. Clear ALL references to prevent hover re-insertion
                        stickyButtonElement = null;
                        buttonsToInsert.sticky = null;

                        if (DEBUG) console.log('[EYV DBG] Sticky player button disabled and removed');
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
                                // Create the button - pass player container, not videoElement
                                const pipBtnInstance = createPiPButtonLogic(player);
                                Object.assign(pipBtnInstance, {
                                    className: 'ytp-button eyv-pip-button',
                                    title: 'Toggle Picture-in-Picture',
                                    innerHTML: pipSVGDefault
                                });
                                pipBtnInstance.setAttribute('aria-label', 'Toggle Picture-in-Picture');
                                pipBtnInstance.style.display = 'inline-flex';

                                // FIX: Sync dimension immediately
                                if (cachedButtonWidth) {
                                    pipBtnInstance.style.width = cachedButtonWidth;
                                    pipBtnInstance.style.height = cachedButtonHeight;
                                }

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

                                // FIX: Update global reference for hover logic
                                buttonsToInsert.pip = pipBtnInstance;

                                // FIX: Add animation class so it becomes visible
                                setTimeout(() => pipBtnInstance?.classList.add('eyv-animate-in'), 10);

                                if (DEBUG) console.log('[EYV DBG] PiP button created');
                            } else {
                                if (DEBUG) console.log('[EYV DBG] Cannot create PiP button - player elements not found');
                            }
                        }
                    } else {
                        // DISABLE

                        // 1. Remove from DOM - check both queried element and in-memory reference
                        // Button may be in DOM (pipBtn) or stored in buttonsToInsert for hover re-insertion
                        if (pipBtn && pipBtn.parentNode) {
                            pipBtn.remove();
                        }
                        if (buttonsToInsert.pip && buttonsToInsert.pip.parentNode) {
                            buttonsToInsert.pip.remove();
                        }

                        // 2. Clear reference to prevent hover re-insertion
                        buttonsToInsert.pip = null;

                        if (DEBUG) console.log('[EYV DBG] PiP button disabled and removed');
                    }
                }
                sendResponse({ status: "ok" });
                return true;
            }

        // Send error response for unrecognized message types
        console.warn('[EYV] Unrecognized message type:', message.type);
        sendResponse({ status: "error", message: "Unknown message type" });
        return true;
    };

    // Register the message listener and store reference for cleanup
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage && chrome.runtime.id) {
        messageListenerRef = handleChromeMessage;
        chrome.runtime.onMessage.addListener(messageListenerRef);
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

                        // FORCE TOUCH FIX: Create buttons but don't add to DOM until hover
                        // This prevents interference with macOS Force Touch pause/play functionality

                        stickyButtonElement = playerRightControls.querySelector('.eyv-player-button');
                        if (!stickyButtonElement && stickyPlayerEnabled) {
                            stickyButtonElement = createStickyButtonLogic(player, videoElement);
                            stickyButtonElement.className = 'ytp-button eyv-player-button';
                            stickyButtonElement.innerHTML = pinSVGIcon;
                            stickyButtonElement.title = 'Toggle Sticky Player';
                            stickyButtonElement.setAttribute('aria-label', 'Toggle Sticky Player');
                            // Set display (will be shown when inserted on hover)
                            stickyButtonElement.style.display = 'inline-flex';
                        } else if (stickyButtonElement && !stickyPlayerEnabled) {
                            stickyButtonElement.remove();
                            stickyButtonElement = null;
                        }

                        let pipBtnInstance = playerRightControls.querySelector('.eyv-pip-button');
                        if (!pipBtnInstance && pipEnabled) {
                            pipBtnInstance = createPiPButtonLogic(player);
                            pipBtnInstance.className = 'ytp-button eyv-pip-button';
                            pipBtnInstance.innerHTML = pipSVGDefault;
                            pipBtnInstance.title = 'Toggle Picture-in-Picture';
                            pipBtnInstance.setAttribute('aria-label', 'Toggle Picture-in-Picture');
                            // Set display (will be shown when inserted on hover)
                            pipBtnInstance.style.display = 'inline-flex';
                        } else if (pipBtnInstance && !pipEnabled) {
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
                            pipBtnInstance = createPiPButtonLogic(player);
                            Object.assign(pipBtnInstance, { className: 'ytp-button eyv-pip-button', title: 'Toggle Picture-in-Picture', innerHTML: pipSVGDefault });
                            pipBtnInstance.setAttribute('aria-label', 'Toggle Picture-in-Picture');
                        }

                        initializeControlsContinued(pipBtnInstance, defaultStickyEnabled);
                    });
        };

        // Continuation of initialization after settings are loaded
        const initializeControlsContinued = (pipBtnInstance, defaultStickyEnabled) => {

                // Attach video event listeners (pause, play, ended) using the helper function
                // This will be called when video element is replaced (ads, quality changes)
                attachVideoListeners(videoElement, progressBar);

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

                // FORCE TOUCH FIX: Dynamically add/remove buttons on hover
                // Buttons are only added to DOM when hovering over controls, preventing
                // interference with macOS Force Touch pause/play functionality

                // FIX: Assign to the global object instead of creating a local one
                buttonsToInsert.sticky = stickyButtonElement;
                buttonsToInsert.pip = pipBtnInstance;

                // Add hover listeners to dynamically insert/remove buttons
                const insertButtons = () => {
                    // Insert at the beginning of RIGHT controls (leftmost position within right controls)
                    const firstButton = playerRightControls.firstChild;

                    // Insert sticky button first (leftmost in right controls)
                    // Check stickyPlayerEnabled flag to respect feature toggle from popup
                    if (stickyPlayerEnabled && buttonsToInsert.sticky && !playerRightControls.contains(buttonsToInsert.sticky)) {
                        if (firstButton) {
                            playerRightControls.insertBefore(buttonsToInsert.sticky, firstButton);
                        } else {
                            playerRightControls.appendChild(buttonsToInsert.sticky);
                        }
                        buttonsToInsert.sticky.style.display = 'inline-flex';
                        // Apply cached button dimensions immediately
                        if (cachedButtonWidth && cachedButtonHeight) {
                            buttonsToInsert.sticky.style.width = cachedButtonWidth;
                            buttonsToInsert.sticky.style.height = cachedButtonHeight;
                        }
                        // Trigger animation after a tiny delay to ensure CSS transition works
                        setTimeout(() => buttonsToInsert.sticky?.classList.add('eyv-animate-in'), 10);
                    }

                    // Insert PiP button after sticky (second from left in right controls)
                    // Check pipEnabled flag to respect feature toggle from popup
                    if (pipEnabled && buttonsToInsert.pip && !playerRightControls.contains(buttonsToInsert.pip)) {
                        // Insert after sticky button if it exists, otherwise at the beginning
                        const referenceNode = buttonsToInsert.sticky && playerRightControls.contains(buttonsToInsert.sticky)
                            ? buttonsToInsert.sticky.nextSibling
                            : firstButton;

                        if (referenceNode) {
                            playerRightControls.insertBefore(buttonsToInsert.pip, referenceNode);
                        } else {
                            playerRightControls.appendChild(buttonsToInsert.pip);
                        }
                        buttonsToInsert.pip.style.display = 'inline-flex';
                        // Apply cached button dimensions immediately
                        if (cachedButtonWidth && cachedButtonHeight) {
                            buttonsToInsert.pip.style.width = cachedButtonWidth;
                            buttonsToInsert.pip.style.height = cachedButtonHeight;
                        }
                        // Trigger animation after a tiny delay to ensure CSS transition works
                        setTimeout(() => buttonsToInsert.pip?.classList.add('eyv-animate-in'), 10);
                    }

                    // CRITICAL: Sync dimensions from YouTube's current button sizes
                    // This ensures our buttons match YouTube's size at the moment of insertion,
                    // not stale cached values from before YouTube updated
                    syncButtonDimensions();
                };

                const removeButtons = () => {
                    // Remove buttons from DOM and reset animation
                    if (buttonsToInsert.pip && buttonsToInsert.pip.parentNode) {
                        buttonsToInsert.pip.classList.remove('eyv-animate-in');
                        buttonsToInsert.pip.remove();
                    }
                    if (buttonsToInsert.sticky && buttonsToInsert.sticky.parentNode) {
                        buttonsToInsert.sticky.classList.remove('eyv-animate-in');
                        buttonsToInsert.sticky.remove();
                    }
                };

                // Listen for mouse enter/leave on right control bar
                cleanupRegistry.addListener(playerRightControls, 'mouseenter', insertButtons);
                cleanupRegistry.addListener(playerRightControls, 'mouseleave', removeButtons);

                // FIX: Add focusin listener for keyboard accessibility
                // Users navigating with Tab key need buttons to be inserted when they focus into the control bar
                cleanupRegistry.addListener(playerRightControls, 'focusin', insertButtons);

                // Sync our button dimensions with YouTube's native buttons
                syncButtonDimensions();

                if (playerElementRef && !playerStateObserver) setupPlayerStateObserver(playerElementRef, videoElement);
                if (playerElementRef && !videoElementObserver) setupVideoElementObserver(playerElementRef);
                setupLiveChatObserver(); // Setup chat observer (will retry if not ready)

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
                            // Clear the in-memory flag regardless of activation success
                            // to prevent stale state from persisting
                            wasStickyBeforeEnd = false;

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
            // Prevent infinite loop from centerStickyPlayer dispatching resize events
            if (isResizingPlayer) {
                if (DEBUG) console.log('[EYV DBG] Already resizing, ignoring nested resize event');
                return;
            }

            if (DEBUG) console.log('[EYV DBG] ========== WINDOW RESIZE EVENT FIRED ==========');

            // STEP 1: Resize the player container FIRST
            if (playerElementRef?.classList.contains('eyv-player-fixed')) {
                // Set flag to prevent infinite loop
                isResizingPlayer = true;

                // We run this synchronously (no requestAnimationFrame) to ensure
                // styles are set before we ask YouTube to recalculate
                centerStickyPlayer(playerElementRef);

                // Force a browser reflow/layout calc so the DOM updates immediately
                void playerElementRef.offsetHeight;

                // STEP 1b: Schedule additional recalculations to catch delayed YouTube layout updates
                // YouTube's layout may not have fully updated by the time our first calculation runs
                const recalcDelays = [150, 300, 500];
                recalcDelays.forEach(delay => {
                    setTimeout(() => {
                        if (playerElementRef?.classList.contains('eyv-player-fixed')) {
                            centerStickyPlayer(playerElementRef);
                            syncButtonDimensions();
                        }
                    }, delay);
                });

                // Clear flag after all recalculations complete
                setTimeout(() => { isResizingPlayer = false; }, 600);
            }

            // STEP 2: Sync our custom buttons
            syncButtonDimensions();

            // STEP 3: Dispatch resize event to update YouTube OSD
            if (DEBUG) console.log('[EYV DBG] Dispatching resize event to update OSD');

            // CRITICAL FIX: Wrap this dispatch in the flag to prevent infinite loops
            window.eyvIsDispatching = true;
            window.dispatchEvent(new Event('resize', { bubbles: true }));
            window.eyvIsDispatching = false;

        }, RESIZE_DEBOUNCE_MS);

        // FIX: Wrapped handler to prevent infinite loops from our own dispatchEvent calls
        const resizeHandler = (e) => {
            // Stop the infinite loop: if we caused this resize event, ignore it
            if (window.eyvIsDispatching) return;
            debouncedResize();
        };
        cleanupRegistry.addListener(window, 'resize', resizeHandler);
        cleanupRegistry.addListener(document, 'fullscreenchange', handleFullscreenChange);
    }

    // --- STICKY PLAYER HELPER ---
    function deactivateStickyModeInternal(preservePauseFlag = false) {
        if (!stickyButtonElement || !stickyButtonElement.classList.contains('active')) return;
        if (DEBUG) console.log('[EYV DBG] Deactivating sticky mode.'); else console.log('[EYV] Deactivating sticky mode.');
        if (playerElementRef) {
            // Restore player to original DOM position (moved to body during activation)
            if (originalPlayerParent && originalPlayerParent.isConnected) {
                if (originalPlayerNextSibling && originalPlayerNextSibling.isConnected) {
                    originalPlayerParent.insertBefore(playerElementRef, originalPlayerNextSibling);
                } else {
                    originalPlayerParent.appendChild(playerElementRef);
                }
                if (DEBUG) console.log('[EYV DBG] Restored player to original DOM position');
            }
            originalPlayerParent = null;
            originalPlayerNextSibling = null;

            // In theater mode with chat open, calculate and preserve dimensions to prevent player from expanding
            const watchFlexy = document.querySelector('ytd-watch-flexy');
            const isTheater = watchFlexy?.hasAttribute('theater');
            const liveChat = document.querySelector('ytd-live-chat-frame');
            const isChatOpen = liveChat && liveChat.getBoundingClientRect().height > 200;

            if (isTheater && isChatOpen && preservePauseFlag) {
                // Calculate the width that accounts for chat BEFORE removing sticky class
                const watchRect = watchFlexy.getBoundingClientRect();
                const chatRect = liveChat.getBoundingClientRect();
                // Use Math.max to prevent negative width if chat overlaps
                const availableWidth = Math.max(0, watchRect.width - chatRect.width);

                // Calculate height maintaining aspect ratio
                const validAspectRatio = (isFinite(originalPlayerAspectRatio) && originalPlayerAspectRatio > 0) ? originalPlayerAspectRatio : 9/16;
                const calculatedHeight = availableWidth * validAspectRatio;

                if (DEBUG) console.log(`[EYV DBG] Preserving dimensions in theater with chat: ${availableWidth}px x ${calculatedHeight}px (chat width: ${chatRect.width}px)`);

                // Remove sticky class first, then set dimensions
                playerElementRef.classList.remove('eyv-player-fixed');
                Object.assign(playerElementRef.style, {
                    width: `${availableWidth}px`,
                    height: `${calculatedHeight}px`,
                    top: '',
                    left: '',
                    transform: ''
                });
            } else {
                // Normal deactivation - clear all styles and force layout recalc
                playerElementRef.classList.remove('eyv-player-fixed');
                Object.assign(playerElementRef.style, { width: '', height: '', top: '', left: '', transform: '' });

                // Force browser to recalculate layout by triggering a reflow
                // This ensures the player immediately takes its correct size from YouTube's layout
                if (DEBUG) console.log(`[EYV DBG] Forcing layout recalc after deactivation`);
                void playerElementRef.offsetHeight; // Force reflow

                // Dispatch resize event to ensure YouTube recalculates everything
                window.dispatchEvent(new Event('resize', { bubbles: true }));
            }
        }
        if (playerPlaceholder && playerPlaceholder.isConnected) playerPlaceholder.style.display = 'none';

        // NOTE: Known issue with "Inactive When Paused" feature:
        // When sticky is deactivated on pause, the player loses position:fixed and returns to document flow.
        // When reactivated on resume, position:fixed is reapplied with top:mastheadOffset, causing a visual jump.
        // This is the expected behavior of the feature - the player becomes scrollable when paused.
        // To avoid the jump, users should disable "Inactive When Paused" in settings.
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
    
    // --- ATTACH VIDEO EVENT LISTENERS ---
    // Helper to attach listeners to the specific video element
    // This is called both during initialization and when video element is replaced (ads, quality changes)
    function attachVideoListeners(videoElement, progressBar) {
        if (!videoElement || videoElementsWithListeners.has(videoElement)) {
            if (DEBUG) console.log('[EYV DBG] Skipping listener attachment - already attached or no element');
            return;
        }

        if (DEBUG) console.log('[EYV] Attaching listeners to video element', videoElement);

        // 1. Scrubbing Listener (checking if already attached via dataset to be safe)
        if (progressBar && !progressBar.dataset.eyvScrubListener) {
            cleanupRegistry.addListener(progressBar, 'mousedown', () => {
                isScrubbing = true;
                if (DEBUG) console.log("[EYV DBG] Scrubbing started.");
            });
            cleanupRegistry.addListener(document, 'mouseup', () => {
                if (isScrubbing) isScrubbing = false;
            });
            progressBar.dataset.eyvScrubListener = "true";
        }

        // 2. Pause Listener
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

                // Only deactivate on pause if it's a real user pause, not our automatic pause/resume
                if (inactiveWhenPausedEnabled && stickyButtonElement?.classList.contains('active') && !isAutoPauseResumeActive) {
                    if (DEBUG) console.log("[EYV DBG] Paused. Deactivating sticky mode as per settings.");
                    // Set flag AFTER deactivating to prevent it from being reset
                    deactivateStickyModeInternal(true); // Pass true to preserve pause flag
                    wasStickyBeforePause = true;
                } else if (isAutoPauseResumeActive) {
                    if (DEBUG) console.log("[EYV DBG] Paused during auto pause/resume - skipping deactivation");
                }
            } catch (error) {
                console.error('[EYV] Video pause handler error:', error);
            }
        });

        // 3. Play Listener
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

                            // After reactivating sticky, trigger YouTube's OSD recalculation
                            // This ensures OSD controls reposition correctly if chat was opened/closed while paused
                            setTimeout(() => {
                                window.dispatchEvent(new Event('resize', { bubbles: true }));
                                if (DEBUG) console.log('[EYV DBG] Dispatched resize after sticky reactivation');
                            }, 150);
                            setTimeout(() => {
                                window.dispatchEvent(new Event('resize', { bubbles: true }));
                                syncButtonDimensions();
                            }, 300);
                        }
                    }
                }

                // Note: Re-activation after video ended is now handled in 'loadeddata' event
                // which is more reliable for autoplay scenarios where URL changes
            } catch (error) {
                console.error('[EYV] Video play handler error:', error);
            }
        });

        // 4. Ended Listener
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
        if (DEBUG) console.log('[EYV] Video listeners attached successfully');
    }

    // --- SYNC BUTTON DIMENSIONS WITH YOUTUBE ---
    function syncButtonDimensions() {
        if (DEBUG) console.log(`[EYV DBG] ====== syncButtonDimensions() ======`);

        // Find ALL native YouTube buttons to compare sizes
        const settingsBtn = document.querySelector('.ytp-settings-button');
        const fullscreenBtn = document.querySelector('.ytp-fullscreen-button');
        const subtitlesBtn = document.querySelector('.ytp-subtitles-button');

        if (DEBUG) console.log(`[EYV DBG] Found native buttons: settings=${!!settingsBtn}, fullscreen=${!!fullscreenBtn}, subtitles=${!!subtitlesBtn}`);

        // Show ALL native button sizes to detect inconsistencies
        if (DEBUG) {
            if (settingsBtn) {
                const s = getComputedStyle(settingsBtn);
                console.log(`  YT Settings button: ${s.width} x ${s.height}`);
            } else {
                console.log(`  YT Settings button: NOT FOUND`);
            }

            if (fullscreenBtn) {
                const f = getComputedStyle(fullscreenBtn);
                console.log(`  YT Fullscreen button: ${f.width} x ${f.height}`);
            } else {
                console.log(`  YT Fullscreen button: NOT FOUND`);
            }

            if (subtitlesBtn) {
                const c = getComputedStyle(subtitlesBtn);
                console.log(`  YT Subtitles button: ${c.width} x ${c.height}`);
            } else {
                console.log(`  YT Subtitles button: NOT FOUND`);
            }
        }

        const nativeButton = settingsBtn || fullscreenBtn;
        if (!nativeButton) {
            if (DEBUG) console.log('[EYV DBG] NO NATIVE BUTTONS FOUND - YOUTUBE CONTROLS NOT IN DOM!');
            return false;
        }

        const computedStyle = getComputedStyle(nativeButton);
        const width = computedStyle.width;
        const height = computedStyle.height;

        // Check if dimensions actually changed since last sync
        const dimensionsChanged = (width !== lastSyncedWidth || height !== lastSyncedHeight);

        if (DEBUG) {
            const watchFlexy = document.querySelector('ytd-watch-flexy');
            const isTheater = watchFlexy?.hasAttribute('theater');
            const playerEl = document.querySelector('#movie_player');
            const isFullscreen = playerEl?.classList.contains('ytp-fullscreen');

            console.log(`  Mode: Theater=${isTheater}, Fullscreen=${isFullscreen}`);
            console.log(`  Using: ${width} x ${height} (from ${settingsBtn ? 'settings' : 'fullscreen'} button)`);
            console.log(`  Last synced: ${lastSyncedWidth} x ${lastSyncedHeight}`);
            console.log(`  ✨ CHANGED: ${dimensionsChanged}`);
        }

        // Cache the dimensions
        cachedButtonWidth = width;
        cachedButtonHeight = height;
        lastSyncedWidth = width;
        lastSyncedHeight = height;

        // Apply to all our buttons that are currently in the DOM
        const ourButtons = document.querySelectorAll('.eyv-player-button, .eyv-pip-button');
        if (DEBUG) console.log(`  Found ${ourButtons.length} of our buttons in DOM`);

        if (DEBUG && ourButtons.length === 0) {
            console.log(`  ⚠️ Our buttons NOT in DOM (removed on mouseout)`);
            console.log(`  ✅ Cached for next insertion: ${cachedButtonWidth} x ${cachedButtonHeight}`);
        }

        if (ourButtons.length > 0) {
            if (DEBUG) {
                const firstButton = ourButtons[0];
                const beforeComputed = window.getComputedStyle(firstButton);
                console.log(`  Our button BEFORE: ${beforeComputed.width} x ${beforeComputed.height}`);
            }

            ourButtons.forEach(btn => {
                btn.style.width = width;
                btn.style.height = height;
            });

            if (DEBUG) {
                const firstButton = ourButtons[0];
                const afterComputed = window.getComputedStyle(firstButton);
                console.log(`  Our button AFTER: ${afterComputed.width} x ${afterComputed.height}`);

                // Visual indicator if sizes don't match
                if (afterComputed.width !== width || afterComputed.height !== height) {
                    console.log(`  ❌ SIZE MISMATCH! Set ${width}x${height} but got ${afterComputed.width}x${afterComputed.height}`);
                } else {
                    console.log(`  ✅ Sizes match perfectly`);
                }
            }
        }

        if (DEBUG) console.log(`[EYV DBG] ============================`);
        return dimensionsChanged;
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
                    // Sanitize CSS color value from YouTube page to prevent injection
                    const bgColor = getComputedStyle(document.documentElement).getPropertyValue('--yt-spec-base-background');
                    playerPlaceholder.style.backgroundColor = sanitizeColorValue(bgColor);
                }

                // Store original DOM position before moving to body (fixes z-index stacking issues)
                originalPlayerParent = playerElement.parentElement;
                originalPlayerNextSibling = playerElement.nextSibling;

                // Move player to document.body to escape ytd-app stacking context
                // This ensures the fixed player appears above all YouTube content
                document.body.appendChild(playerElement);
                if (DEBUG) console.log('[EYV DBG] Moved player to document.body for proper z-index stacking');

                playerElement.classList.add('eyv-player-fixed');

                // Always use centerStickyPlayer to calculate dimensions after moving to body
                // This ensures proper sizing regardless of view mode (default, theater, fullscreen)
                // centerStickyPlayer also handles placeholder dimensions correctly (with constraints)
                centerStickyPlayer(playerElement);
                // SECURITY: innerHTML is safe here - pinSVGIconActive is a static SVG string constant (no user input)
                button.classList.add('active'); button.innerHTML = pinSVGIconActive;

                // Track that sticky was active during this video for "End Deactivation" re-activation
                wasStickyDuringCurrentVideo = true;
                if (DEBUG) console.log('[EYV DBG] Sticky activated - set wasStickyDuringCurrentVideo = true');

                // Setup ResizeObserver for smooth real-time resizing
                if (!stickyResizeObserver) {
                    stickyResizeObserver = new ResizeObserver(() => {
                        if (playerElementRef?.classList.contains('eyv-player-fixed')) {
                            // Debounce resize events to prevent constant recalculation that blocks clicks
                            if (stickyResizeTimeout) clearTimeout(stickyResizeTimeout);
                            stickyResizeTimeout = setTimeout(() => {
                                requestAnimationFrame(() => {
                                    centerStickyPlayer(playerElementRef);
                                    // Sync button dimensions when player resizes
                                    syncButtonDimensions();
                                });
                            }, 100); // Wait 100ms after last resize before recalculating
                            // Register timeout for cleanup
                            cleanupRegistry.addTimeout(stickyResizeTimeout);
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
        // Cancel any pending RAF from previous observer before disconnecting
        if (playerStateObserverRafId) {
            cancelAnimationFrame(playerStateObserverRafId);
            playerStateObserverRafId = null;
        }
        if (playerStateObserver) playerStateObserver.disconnect();
        const ytdApp = document.querySelector('ytd-app');
        const watchFlexy = document.querySelector('ytd-watch-flexy');
        const observerConfig = { attributes: true, attributeOldValue: true, attributeFilter: ['miniplayer-is-active', 'fullscreen', 'theater'] };

        let pendingMutations = [];

        const processMutations = () => {
            const mutationsList = pendingMutations;
            pendingMutations = [];
            playerStateObserverRafId = null;
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
                // Only log important attribute changes to reduce console spam
                // if (DEBUG && (attr === 'fullscreen' || attr === 'theater' || attr === 'miniplayer-is-active')) {
                //     console.log(`[EYV DBG MO] Attr '${attr}' on ${target.tagName}${target.id?'#'+target.id:''}. OldValue: ${m.oldValue}`);
                // }
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
                        // Dispatch resize event to trigger YouTube's OSD recalculation
                        setTimeout(() => {
                            if (!window.eyvResizing) {
                                window.eyvResizing = true;
                                window.dispatchEvent(new Event('resize'));
                                if (DEBUG) console.log('[EYV DBG] Dispatched resize event for theater mode toggle');
                                setTimeout(() => { window.eyvResizing = false; }, 50);
                            }

                            // Clear any existing polling interval to prevent overlaps
                            if (activeSyncInterval) {
                                clearInterval(activeSyncInterval);
                                activeSyncInterval = null;
                                if (DEBUG) console.log('[EYV DBG] Cleared previous sync interval for theater toggle');
                            }

                            // Sync immediately first
                            syncButtonDimensions();

                            // Then poll for changes until dimensions stabilize
                            let attempts = 0;
                            const maxAttempts = 25; // Try for up to 5 seconds
                            let unchangedCount = 0;

                            activeSyncInterval = setInterval(() => {
                                attempts++;
                                const changed = syncButtonDimensions();

                                if (changed) {
                                    unchangedCount = 0;
                                    if (DEBUG) console.log(`[EYV DBG] Theater sync - dimensions updated on attempt ${attempts}`);
                                } else {
                                    unchangedCount++;
                                }

                                // Stop if we've had 3 consecutive unchanged syncs or hit max attempts
                                if (unchangedCount >= 3 || attempts >= maxAttempts) {
                                    clearInterval(activeSyncInterval);
                                    activeSyncInterval = null;
                                    if (DEBUG) console.log(`[EYV DBG] Theater sync stopped: ${unchangedCount >= 3 ? 'stabilized' : 'max attempts'} after ${attempts} checks`);
                                }
                            }, 200); // Check every 200ms

                            // Register interval for cleanup on navigation
                            cleanupRegistry.addInterval(activeSyncInterval);
                        }, 100);
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
            if (!playerStateObserverRafId) {
                playerStateObserverRafId = requestAnimationFrame(processMutations);
            }
        };

        playerStateObserver = new MutationObserver(callback);
        // Only observe if elements are connected
        if (ytdApp?.isConnected) playerStateObserver.observe(ytdApp, observerConfig);
        if (watchFlexy?.isConnected) playerStateObserver.observe(watchFlexy, observerConfig);
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
                if (DEBUG) console.log('[EYV DBG Video Observer] Video element replaced (ad or quality change), reattaching listeners');
                currentVideoElement = newVideoElement;

                // FIX: Reset wasStickyDuringCurrentVideo when video changes to prevent
                // wrong re-activation behavior between videos
                wasStickyDuringCurrentVideo = false;
                wasStickyBeforeEnd = false;
                if (DEBUG) console.log('[EYV DBG] Reset sticky tracking flags for new video');

                // FIX: Video element was replaced - reattach listeners immediately
                // This happens during ad insertion or quality changes
                const progressBar = playerElement.querySelector('.ytp-progress-bar-container');
                attachVideoListeners(newVideoElement, progressBar);
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

    // --- LIVE CHAT OBSERVER ---
    // Watches for live chat frame size changes to detect when chat is opened/closed
    // Track pending chat toggle timeouts to clear on navigation
    let pendingChatToggleTimeouts = [];

    function setupLiveChatObserver() {
        const liveChatFrame = document.querySelector('ytd-live-chat-frame');
        if (liveChatFrame?.isConnected) {
            let lastChatWidth = Math.round(liveChatFrame.getBoundingClientRect().width);
            let lastChatHeight = Math.round(liveChatFrame.getBoundingClientRect().height);
            // Use height as the indicator - chat is "open" when height is substantial (> 200px)
            let wasChatOpen = lastChatHeight > 200;

            if (DEBUG) console.log(`[EYV DBG] LiveChatObserver initialized - chat ${wasChatOpen ? 'open' : 'closed'} (${lastChatWidth}x${lastChatHeight})`);

            const liveChatResizeObserver = new ResizeObserver((entries) => {
                for (const entry of entries) {
                    const newWidth = Math.round(entry.contentRect.width);
                    const newHeight = Math.round(entry.contentRect.height);
                    // Use height as the indicator - chat is "open" when height is substantial (> 200px)
                    const isChatOpenNow = newHeight > 200;
                    const chatToggledState = wasChatOpen !== isChatOpenNow; // Only trigger on open/close, not resize

                    const widthChanged = Math.abs(newWidth - lastChatWidth) > 10;
                    const heightChanged = Math.abs(newHeight - lastChatHeight) > 200;

                    if (DEBUG && (widthChanged || heightChanged)) {
                        console.log(`[EYV DBG] Chat resize detected: ${lastChatWidth}x${lastChatHeight} → ${newWidth}x${newHeight}, toggled=${chatToggledState}, wasChatOpen=${wasChatOpen}, isChatOpenNow=${isChatOpenNow}`);
                    }

                    if ((widthChanged || heightChanged) && chatToggledState) {
                        if (DEBUG) console.log(`[EYV DBG] Live chat toggled: ${wasChatOpen ? 'open' : 'closed'} → ${isChatOpenNow ? 'open' : 'closed'} (${lastChatWidth}x${lastChatHeight} → ${newWidth}x${newHeight})`);
                        lastChatWidth = newWidth;
                        lastChatHeight = newHeight;
                        wasChatOpen = isChatOpenNow;

                        // Clear any pending timeouts from previous chat toggle
                        pendingChatToggleTimeouts.forEach(id => clearTimeout(id));
                        pendingChatToggleTimeouts = [];

                        // Handle chat toggle for both sticky active and inactive states
                        if (playerElementRef?.isConnected) {
                            const isStickyActive = playerElementRef.classList.contains('eyv-player-fixed');

                            requestAnimationFrame(() => {
                                // Recenter sticky player if active
                                if (isStickyActive) {
                                    centerStickyPlayer(playerElementRef);
                                    if (DEBUG) console.log('[EYV DBG] Recentered sticky player for chat toggle');
                                } else {
                                    // Player is paused/not in sticky - clear preserved dimensions when chat closes
                                    if (!isChatOpenNow) {
                                        if (DEBUG) console.log('[EYV DBG] Chat closed while paused - clearing preserved dimensions');
                                        Object.assign(playerElementRef.style, { width: '', height: '' });
                                    }
                                }

                                // Imperceptible pause/resume to force YouTube's OSD recalculation
                                const video = playerElementRef.querySelector('video');
                                if (video && !video.paused) {
                                    if (DEBUG) console.log('[EYV DBG] Auto pause/resume for OSD fix');
                                    // Set flag to prevent pause handler from deactivating sticky
                                    isAutoPauseResumeActive = true;
                                    video.pause();
                                    const resumeTimeout = setTimeout(() => {
                                        video.play().catch(err => {
                                            if (DEBUG) console.log('[EYV DBG] Auto-resume blocked:', err.name);
                                        }).finally(() => {
                                            // Clear flag after play attempt completes
                                            const clearFlagTimeout = setTimeout(() => {
                                                isAutoPauseResumeActive = false;
                                                if (DEBUG) console.log('[EYV DBG] Auto pause/resume complete');
                                            }, 50);
                                            pendingChatToggleTimeouts.push(clearFlagTimeout);
                                            cleanupRegistry.addTimeout(clearFlagTimeout);
                                        });
                                    }, 10); // Very brief 10ms pause - imperceptible to user
                                    pendingChatToggleTimeouts.push(resumeTimeout);
                                    cleanupRegistry.addTimeout(resumeTimeout);
                                }

                                // Trigger YouTube's OSD recalculation by dispatching resize events
                                // This is what fixes the OSD button positioning when chat opens/closes
                                if (DEBUG) console.log('[EYV DBG] Dispatching resize events to fix OSD positioning');

                                // Dispatch multiple resize events with delays to ensure YouTube catches it
                                window.dispatchEvent(new Event('resize', { bubbles: true }));

                                // Schedule resize events and track their timeout IDs
                                const resizeDelays = [50, 150, 300, 500];
                                resizeDelays.forEach((delay, i) => {
                                    const timeoutId = setTimeout(() => {
                                        window.dispatchEvent(new Event('resize', { bubbles: true }));
                                        if (DEBUG) console.log(`[EYV DBG] Resize event ${i + 1}`);
                                    }, delay);
                                    pendingChatToggleTimeouts.push(timeoutId);
                                    cleanupRegistry.addTimeout(timeoutId);
                                });

                                // Sync button dimensions to match YouTube's final size
                                const syncDelays = [100, 300, 500, 700];
                                syncDelays.forEach(delay => {
                                    const timeoutId = setTimeout(() => syncButtonDimensions(), delay);
                                    pendingChatToggleTimeouts.push(timeoutId);
                                    cleanupRegistry.addTimeout(timeoutId);
                                });
                            });
                        }
                    }
                }
            });

            liveChatResizeObserver.observe(liveChatFrame);
            cleanupRegistry.addObserver(liveChatResizeObserver);
            if (DEBUG) console.log("[EYV DBG] LiveChatResizeObserver setup.");
        } else {
            // Live chat frame not loaded yet, retry after delay
            if (DEBUG) console.log("[EYV DBG] Live chat frame not found, will retry in 1s...");
            const retryTimeout = setTimeout(setupLiveChatObserver, 1000);
            cleanupRegistry.addTimeout(retryTimeout);
        }
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
                    // Sync button dimensions when entering fullscreen
                    setTimeout(() => {
                        syncButtonDimensions();
                    }, 150);
                } else {
                    // Exiting fullscreen - add delay to ensure YouTube's layout settles
                    setTimeout(() => {
                        const videoElement = playerElementRef?.querySelector('video.html5-main-video');
                        if (videoElement?.isConnected) {
                            tryReactivatingStickyAfterPiPOrMiniplayer(videoElement, true);
                        }
                        wasStickyBeforeOsFullscreen = false;
                        // Sync button dimensions when exiting fullscreen
                        syncButtonDimensions();
                    }, 100);
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
    function createPiPButtonLogic(playerContainer) { // Changed argument to playerContainer
        const button = document.createElement('button');
        let isTransitioning = false;

        const pipClickHandler = async (event) => {
            event.stopPropagation();
            if (!document.pictureInPictureEnabled) return;

            // FIX: Get the CURRENT video element dynamically at the moment of click
            const currentVideo = playerContainer.querySelector('video.html5-main-video');

            // FIX: Check if video exists and has loaded metadata
            if (!currentVideo || currentVideo.readyState === 0) {
                if (DEBUG) console.log('[EYV DBG] PiP request ignored: Video not ready.');
                return;
            }

            // Prevent rapid clicking during transitions
            if (isTransitioning) {
                if (DEBUG) console.log('[EYV DBG] PiP button click ignored - transition in progress');
                return;
            }

            isTransitioning = true;
            setTimeout(() => { isTransitioning = false; }, PIP_TRANSITION_MS);
            try {
                if (currentVideo !== document.pictureInPictureElement) {
                    if (stickyButtonElement?.classList.contains('active')) {
                        wasStickyBeforePiP = true;
                        if (DEBUG) console.log("[EYV DBG] PiP requested while sticky active. Deactivating sticky.");
                        deactivateStickyModeInternal();
                        await new Promise(resolve => setTimeout(resolve, 50));
                    } else { wasStickyBeforePiP = false; }

                    await currentVideo.requestPictureInPicture();
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

        // In theater/fullscreen mode, check if chat is open and account for its width
        if (isTheater || isYtFull) {
            const liveChat = document.querySelector('ytd-live-chat-frame');
            const isChatOpen = liveChat && liveChat.getBoundingClientRect().height > 200;

            if (isChatOpen) {
                // Chat is open - calculate available width
                const watchRect = watchFlexy.getBoundingClientRect();
                const chatRect = liveChat.getBoundingClientRect();
                // Use Math.max to prevent negative width if chat overlaps
                const availableWidth = Math.max(0, watchRect.width - chatRect.width);

                refRect = {
                    width: availableWidth,
                    left: watchRect.left
                };
                if (DEBUG) console.log(`[EYV DBG] Theater/fullscreen with chat: ${availableWidth}px (watch: ${watchRect.width}px - chat: ${chatRect.width}px)`);
            } else {
                // Chat is closed - use full width
                refRect = watchFlexy.getBoundingClientRect();
                if (DEBUG) console.log('[EYV DBG] Theater/fullscreen without chat: using full watchFlexy width');
            }
        }
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

        // Apply max-width constraint in default view to prevent player from getting too large
        // Read YouTube's actual max-width from primaryCol element
        if (!isTheater && !isYtFull && primaryCol) {
            const primaryColStyles = getComputedStyle(primaryCol);
            const maxWidthStr = primaryColStyles.maxWidth;

            if (maxWidthStr && maxWidthStr !== 'none' && maxWidthStr !== 'auto') {
                const maxWidth = parseFloat(maxWidthStr);
                // Validate parseFloat result to handle CSS keywords that return NaN
                if (isFinite(maxWidth) && maxWidth > 0 && newW > maxWidth) {
                    if (DEBUG) console.log(`[EYV DBG] Limiting player width from ${newW}px to YouTube's max: ${maxWidth}px`);
                    newW = maxWidth;
                    // Keep player aligned with primary column (don't center in default view)
                    // newL stays as refRect.left
                }
            }
        }

        // Calculate height with validation to prevent NaN/Infinity
        const validAspectRatio = (isFinite(originalPlayerAspectRatio) && originalPlayerAspectRatio > 0) ? originalPlayerAspectRatio : 9/16;
        let newH = newW * validAspectRatio;

        // Constrain height to viewport to prevent OSD controls from being pushed off screen
        // Leave some margin (100px) to ensure controls are fully visible
        const availableHeight = window.innerHeight - mastheadOffset - 100;
        if (newH > availableHeight) {
            if (DEBUG) console.log(`[EYV DBG] Limiting player height from ${newH}px to ${availableHeight}px to keep controls visible`);
            newH = availableHeight;

            // In theater/fullscreen mode, keep full width to cover sidebar content
            // The video element inside will maintain aspect ratio with letterboxing
            if (isTheater || isYtFull) {
                // Keep newW and newL as-is (full watchFlexy width)
                if (DEBUG) console.log(`[EYV DBG] Theater/fullscreen: keeping full width ${newW}px, height constrained to ${newH}px`);
            } else {
                // In default view, recalculate width to maintain aspect ratio
                newW = newH / validAspectRatio;
                // newL stays as refRect.left (aligned with primary column)
                if (DEBUG) console.log(`[EYV DBG] Default view: width adjusted to ${newW}px to maintain aspect ratio`);
            }
        }

        // Final validation before applying styles
        if (!isFinite(newW) || !isFinite(newH) || newW <= 0 || newH <= 0) {
            console.warn('[EYV] Invalid dimensions in centerStickyPlayer, aborting');
            return;
        }

        Object.assign(fixedPlayer.style, { width: `${newW}px`, height: `${newH}px`, left: `${newL}px`, top: `${mastheadOffset}px`, transform: 'translateX(0%)' });

        // Hide placeholder in theater/fullscreen mode to prevent layout gaps
        const placeholder = document.getElementById('eyv-player-placeholder');
        if (placeholder && placeholder.isConnected) {
            if (isTheater || isYtFull) {
                placeholder.style.display = 'none';
                if (DEBUG) console.log(`[EYV DBG] Hiding placeholder in theater/fullscreen mode`);
            } else {
                placeholder.style.display = 'block';
                placeholder.style.width = `${newW}px`;
                placeholder.style.height = `${newH}px`;
                if (DEBUG) console.log(`[EYV DBG] Updated placeholder to ${newW}px x ${newH}px`);
            }
        }

        // Force YouTube to acknowledge the new size immediately
        // FIX: Use flag to prevent infinite resize loop
        if (window.getComputedStyle(fixedPlayer).width === `${newW}px`) {
            // Set flag to tell our listener to ignore this specific event
            window.eyvIsDispatching = true;
            window.dispatchEvent(new Event('resize', { bubbles: true }));
            window.eyvIsDispatching = false;
        }

        // Force YouTube's internal video player to recalculate dimensions
        // This addresses the issue where the outer container resizes but the video element doesn't
        const moviePlayer = fixedPlayer.querySelector('#movie_player');
        const videoElement = fixedPlayer.querySelector('video.html5-main-video');

        if (moviePlayer) {
            // Force reflow on movie_player to trigger layout recalculation
            void moviePlayer.offsetHeight;

            // Dispatch resize event on movie_player (non-bubbling to avoid interfering with clicks)
            moviePlayer.dispatchEvent(new Event('resize', { bubbles: false }));
        }

        if (videoElement) {
            // Force the video element to recalculate
            void videoElement.offsetHeight;
        }
    }

    // --- CSS INJECTION ---
    // Injects all necessary CSS styles into the page for the extension's UI and features.
    function injectAllStyles() {
        const style = document.createElement('style');
        style.id = 'eyv-styles';

        // z-index for sticky player - player is moved to document.body to escape ytd-app stacking context
        // 9999 ensures it appears above all YouTube content while still being below critical browser UI
        const zIndex = 9999;

        style.textContent = `
            .eyv-player-fixed {
                position: fixed !important;
                z-index: ${zIndex} !important;
                background-color: var(--yt-spec-base-background, #0f0f0f);
                box-sizing: border-box !important;
                box-shadow: 0 2px 10px rgba(0,0,0,0.2);
                pointer-events: none !important; /* Lets clicks pass through the wrapper */
            }

            /* FIX: Removed '>' to select descendants, not just direct children */
            /* FIX: Add #container and direct child div to the allow-list for click-through */
            .eyv-player-fixed > div,
            .eyv-player-fixed #container,
            .eyv-player-fixed #movie_player,
            .eyv-player-fixed .html5-video-player {
                width: 100% !important;
                height: 100% !important;
                max-width: 100% !important;
                max-height: 100% !important;
                top: 0 !important;
                left: 0 !important;
                bottom: auto !important;
                right: auto !important;
                transform: none !important;
                pointer-events: auto !important; /* Re-enable clicks on the actual player */
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
                pointer-events: auto !important;
            }

            .eyv-player-fixed .ytp-chrome-bottom,
            .eyv-player-fixed .ytp-gradient-bottom,
            .eyv-player-fixed .ytp-chrome-top,
            .eyv-player-fixed .ytp-gradient-top {
                pointer-events: auto !important;
            }

            #eyv-player-placeholder {
                pointer-events: none !important;
            }

            /* In theater mode with sticky active, shrink player-container to match sticky player height */
            ytd-watch-flexy[theater] #player-container:has(.eyv-player-fixed) {
                height: auto !important;
                min-height: 0 !important;
            }

            .eyv-player-button, .eyv-pip-button {
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
                /* Slide-in animation from right to left */
                transform: translateX(40px) !important;
                opacity: 0 !important;
                transition: transform 0.2s cubic-bezier(0.4, 0.0, 0.2, 1), opacity 0.2s cubic-bezier(0.4, 0.0, 0.2, 1) !important;
            }

            .eyv-player-button.eyv-animate-in, .eyv-pip-button.eyv-animate-in {
                transform: translateX(0) !important;
                opacity: 1 !important;
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

            /* Ensure YouTube popups/dialogs/sidebar appear above sticky player */
            ytd-popup-container,
            tp-yt-paper-dialog,
            tp-yt-iron-dropdown,
            ytd-menu-popup-renderer,
            ytd-unified-share-panel-renderer,
            ytd-add-to-playlist-renderer,
            ytd-modal-with-title-and-button-renderer,
            yt-dropdown-menu,
            iron-dropdown,
            paper-dialog,
            tp-yt-app-drawer,
            #guide,
            #guide-inner-content,
            ytd-guide-renderer {
                z-index: 10000 !important;
            }
        `;
        document.head.append(style);
        if (DEBUG) console.log("[EYV DBG] Injected CSS styles."); else console.log("[EYV] Injected CSS styles.");
    }
})();