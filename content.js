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
            const snapPreview = document.getElementById('eyv-snap-preview');
            if (snapPreview) snapPreview.remove();
            const resizeHandle = document.getElementById('eyv-resize-handle');
            if (resizeHandle) resizeHandle.remove();

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
            isAutoPauseResumeActive = false;
            stickyActivatedByScroll = false;
            scrollStickSuppressed = false;
            stickyMode = 'top';
            pendingStickyMode = 'top';
            cornerDragState = null;
            cornerResizeState = null;
            suppressNextCornerClick = false;
            // Finalize any in-flight transition so a stuck transform/class can't survive nav.
            cancelStickyFlip();
            endCornerSnapAnim();
            // Remove any dangling drag/resize listeners from an interrupted gesture.
            document.removeEventListener('mousemove', onCornerMouseMove, true);
            document.removeEventListener('mouseup', onCornerMouseUp, true);
            document.removeEventListener('mousemove', onCornerResizeMouseMove, true);
            document.removeEventListener('mouseup', onCornerResizeMouseUp, true);
            originalPlayerParent = null;
            originalPlayerNextSibling = null;

            // Cancel any pending RAF callbacks
            if (playerStateObserverRafId) {
                cancelAnimationFrame(playerStateObserverRafId);
                playerStateObserverRafId = null;
            }

            // Clear sticky recalc rAF ID
            if (stickyRecalcRafId) {
                cancelAnimationFrame(stickyRecalcRafId);
                stickyRecalcRafId = null;
            }

            // Clear scroll-stick rAF ID
            if (scrollStickRafId) {
                cancelAnimationFrame(scrollStickRafId);
                scrollStickRafId = null;
            }

            if (chatToggleRafId) {
                cancelAnimationFrame(chatToggleRafId);
                chatToggleRafId = null;
            }

            // Clear delayed resize recalculation timeouts
            delayedRecalcTimeouts.forEach(id => clearTimeout(id));
            delayedRecalcTimeouts = [];

            // Null interval variables to prevent memory leaks
            mainPollInterval = null;
            activeSyncInterval = null;
            playerStateObserver = null;
            videoElementObserver = null;
            stickyResizeObserver = null;
            currentVideoElement = null;
            stickyButtonElement = null; // Clear button reference too

            // Clear the scrub-listener dataset guard so listeners re-attach after SPA
            // navigation. YouTube reuses the same progress bar across watch->watch navs,
            // so the dataset would otherwise stay 'true' while cleanup() removed the
            // listeners, leaving scrubbing detection permanently un-wired.
            document.querySelectorAll('.ytp-progress-bar-container').forEach(pb => {
                delete pb.dataset.eyvScrubListener;
            });

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
        staleElementCleanupObserver.observe(document.body, { childList: true, subtree: true });

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
    const BUTTON_TRANSITION_MS = 300; // Prevent rapid sticky button clicks
    const PIP_TRANSITION_MS = 500; // Prevent rapid PiP button clicks
    const CORNER_DEFAULT_WIDTH = 640; // Default width (px) of the scroll-stick mini-player (~2x the old 400)
    const CORNER_MIN_WIDTH = 240; // Smallest width (px) the user can shrink the mini-player to
    const CORNER_MARGIN = 16; // Gap (px) from the viewport edges for the corner mini-player

    // --- GLOBAL VARIABLES & STATE ---
    let attempts = 0;
    let mainPollInterval;
    let playerPlaceholder = null;
    // Stored as height/width (a 16:9 video is 9/16 = 0.5625). Used as
    // height = width * originalPlayerAspectRatio, so the default MUST be 9/16,
    // not 16/9 — an inverted default produces a box taller than it is wide,
    // letterboxing the video with a black band below it.
    let originalPlayerAspectRatio = 9 / 16;
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
    let stickyOnScrollEnabled = false; // Auto-stick the player when it scrolls out of view
    let stickyActivatedByScroll = false; // Sticky was auto-activated by scroll (not manual / auto-on-load)
    let scrollStickSuppressed = false; // User manually unstuck while scrolled down; wait until home to re-stick
    let scrollStickRafId = null; // rAF throttle for the scroll-stick handler
    let stickyMode = 'top'; // Active sticky layout: 'top' (manual/auto-activate) or 'corner' (scroll-stick floating mini)
    let pendingStickyMode = 'top'; // Mode to apply on the NEXT activation (scroll-stick sets 'corner' before clicking)
    let cornerAnchor = 'br'; // Remembered corner for the mini-player: 'tl' | 'tr' | 'bl' | 'br'
    let cornerWidth = CORNER_DEFAULT_WIDTH; // Current mini-player width (px), persisted as stickyCornerWidth
    let cornerDragState = null; // Bookkeeping for an in-progress corner-player drag
    let cornerResizeState = null; // Bookkeeping for an in-progress corner-player resize
    let stickyFlipCleanup = null; // Finalizer for an in-flight FLIP transition (clears the temp transform)
    let stickyFlipTimeoutId = null; // Safety-net timer to end a FLIP if transitionend never fires
    let cornerSnapTimeoutId = null; // Safety-net timer to end the drag-release snap transition
    let suppressNextCornerClick = false; // Swallow the click event that ends a drag (so it doesn't toggle play)
    let lastInlinePlayerWidth = 0; // Player's inline size captured at activation (for the corner placeholder)
    let lastInlinePlayerHeight = 0; // Accurate for both default and theater, where width*aspect differs from actual
    let delayedRecalcTimeouts = []; // Track delayed resize recalculation timeouts for cancellation
    let cachedButtonWidth = null; // Cached button dimensions for dynamic insertion
    let cachedButtonHeight = null;
    let lastSyncedWidth = null; // Track last synced dimensions to detect changes
    let lastSyncedHeight = null;
    let activeSyncInterval = null; // Track active sync polling to prevent overlaps
    let playerStateObserverRafId = null; // Track RAF ID for playerStateObserver to cancel on cleanup
    let stickyRecalcRafId = null; // Shared rAF ID for both resize sources (window resize + ResizeObserver) so they dedupe each other
    let chatToggleRafId = null; // Track live-chat ResizeObserver rAF ID for cleanup
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
                } else if (message.key === 'stickyOnScroll') {
                    stickyOnScrollEnabled = message.value;
                    settingsCache.stickyOnScroll = message.value;
                    // Clear any leftover suppression and evaluate the current scroll
                    // position so toggling on takes effect immediately.
                    scrollStickSuppressed = false;
                    if (message.value) handleScrollStick();
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
                            const player = findActivePlayer();
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
                            const player = findActivePlayer();
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
                                                    deactivateStickyModeInternal(false, true);
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
    // Find the live YouTube player element. Prefer the populated/relocated player
    // over the first ytd-player in the DOM: once sticky mode moves the real player
    // to <body>, YouTube leaves an empty ytd-player shell behind in
    // #player-container. A plain querySelector('ytd-player') returns that empty
    // shell first (it appears earlier in document order), so init binds to a player
    // with no controls/video and waits out the full 15s controls timeout.
    function findActivePlayer() {
        const players = [...document.querySelectorAll('ytd-player')];
        if (players.length === 0) return null;
        // Prefer the relocated sticky player if one is active
        for (const p of players) {
            if (p.classList.contains('eyv-player-fixed')) return p;
        }
        // Otherwise prefer a player that actually contains the video chrome
        for (const p of players) {
            if (p.querySelector('.html5-video-player') && p.querySelector('video.html5-main-video')) return p;
        }
        // Never bind to YouTube's inline hover-preview player (#inline-player): on a
        // watch page it's an empty shell, and in a background/hidden tab it can be
        // created (or ordered) before the real #ytd-player is populated. Binding to
        // it strands the extension — its controls never materialize, so init waits
        // out the 15s timeout and dies. This is the intermittent "no controls in a
        // middle-click-opened tab" bug. Fall back to the first NON-inline player; if
        // only the inline shell exists so far, return null so the poller keeps
        // waiting for the real player instead of binding to the dead one.
        const mainPlayer = players.find(p => p.id !== 'inline-player');
        return mainPlayer || null;
    }

    function getMastheadOffset() {
        const masthead = document.querySelector('#masthead-container ytd-masthead') || document.querySelector('#masthead-container');
        if (masthead?.offsetHeight > 0) return masthead.offsetHeight;
        const appMasthead = document.querySelector('ytd-app ytd-masthead[persistent]');
        if (appMasthead?.offsetHeight > 0) return appMasthead.offsetHeight;
        return 0;
    }

    // --- SCROLL-TO-STICK (shrink the player into a floating corner mini on scroll) ---
    // The player's "home" area rect, stable whether stuck (the placeholder fills the
    // spot at the original inline size) or unstuck (the player fills it).
    function getScrollHomeRect() {
        const stuck = stickyButtonElement?.classList.contains('active');
        const marker = (stuck && playerPlaceholder?.isConnected) ? playerPlaceholder
                     : (!stuck && playerElementRef?.isConnected) ? playerElementRef
                     : document.querySelector('#player-container');
        return marker ? marker.getBoundingClientRect() : null;
    }

    // For manual-unpin suppression: is the player's home scrolled up off the top?
    function isScrolledPastHome() {
        const rect = getScrollHomeRect();
        return rect != null && rect.top < getMastheadOffset() - 2;
    }

    // Decide whether to pop the mini to a corner or restore it inline, based on scroll.
    // Hysteresis: activate only once the inline player is essentially scrolled out
    // (its bottom passes under the masthead); deactivate once the home area scrolls
    // back near the top. The gap between the two thresholds prevents flicker.
    function handleScrollStick() {
        if (!stickyOnScrollEnabled) return;
        if (window.location.pathname !== '/watch') return;
        if (!stickyButtonElement || !playerElementRef?.isConnected) return;
        // Works in default AND theater view (both scroll). Excluded only in fullscreen,
        // where the page doesn't scroll and the player owns the whole screen.
        const ytdApp = document.querySelector('ytd-app');
        if (ytdApp?.hasAttribute('fullscreen') || document.fullscreenElement) return;

        const rect = getScrollHomeRect();
        if (!rect) return;
        const masthead = getMastheadOffset();
        const isSticky = stickyButtonElement.classList.contains('active');
        const backHome = rect.top >= masthead - 2;       // home area scrolled back into view
        const scrolledOut = rect.bottom < masthead + 8;  // inline player essentially gone

        if (backHome) scrollStickSuppressed = false;

        if (!isSticky) {
            if (scrolledOut && !scrollStickSuppressed) {
                pendingStickyMode = 'corner'; // scroll-stick uses the floating corner mini
                stickyActivatedByScroll = true;
                stickyButtonElement.click(); // programmatic; conflict-guarded inside the handler
                // If a conflicting mode (PiP/mini/fullscreen) blocked activation, drop the flags.
                if (!stickyButtonElement.classList.contains('active')) {
                    stickyActivatedByScroll = false;
                    pendingStickyMode = 'top';
                }
            }
        } else if (backHome && stickyActivatedByScroll) {
            // Restore inline once scrolled back home, but only if WE auto-stuck it.
            stickyActivatedByScroll = false;
            stickyButtonElement.click(); // programmatic deactivate
        }
    }

    // rAF-throttled scroll handler; cheap no-op when the feature is off.
    function onScrollStick() {
        if (!stickyOnScrollEnabled) return;
        if (scrollStickRafId) return;
        scrollStickRafId = requestAnimationFrame(() => {
            scrollStickRafId = null;
            handleScrollStick();
        });
    }

    // --- CORNER MINI-PLAYER (scroll-stick floating window: drag + snap-to-corner) ---
    // Compute the top/left for a mini-player of size w x h anchored to a corner.
    function getCornerPosition(anchor, w, h, margin, mastheadOffset) {
        const topEdge = Math.max(margin, mastheadOffset + margin);
        const left = anchor.includes('l')
            ? margin
            : Math.max(margin, window.innerWidth - w - margin);
        const top = anchor.includes('t')
            ? topEdge
            : Math.max(topEdge, window.innerHeight - h - margin);
        return { left, top };
    }

    function saveCornerAnchor(anchor) {
        settingsCache.stickyCorner = anchor;
        if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) {
            try { chrome.storage.local.set({ stickyCorner: anchor }); } catch (e) { /* context gone */ }
        }
    }

    function saveCornerWidth(width) {
        settingsCache.stickyCornerWidth = width;
        if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) {
            try { chrome.storage.local.set({ stickyCornerWidth: width }); } catch (e) { /* context gone */ }
        }
    }

    // The resize grabber lives at the mini-player's INNER corner (diagonally opposite the
    // anchored corner) so dragging it toward screen center grows the box while the docked
    // corner stays put. Created on demand and repositioned whenever the anchor changes.
    function ensureCornerResizeHandle() {
        if (!playerElementRef) return null;
        let handle = playerElementRef.querySelector('#eyv-resize-handle');
        if (!handle) {
            handle = document.createElement('div');
            handle.id = 'eyv-resize-handle';
            handle.title = 'Drag to resize';
            handle.addEventListener('mousedown', onCornerResizeMouseDown, true);
            playerElementRef.appendChild(handle);
        }
        positionResizeHandle(handle);
        return handle;
    }

    function positionResizeHandle(handle) {
        handle = handle || playerElementRef?.querySelector('#eyv-resize-handle');
        if (!handle) return;
        const onLeft = cornerAnchor.includes('l'); // anchor on left → handle on right
        const onTop = cornerAnchor.includes('t');  // anchor on top → handle on bottom
        handle.style.left = onLeft ? 'auto' : '0';
        handle.style.right = onLeft ? '0' : 'auto';
        handle.style.top = onTop ? 'auto' : '0';
        handle.style.bottom = onTop ? '0' : 'auto';
        // Diagonal cursor matching the handle's corner (opposite the anchor).
        const nwse = (cornerAnchor === 'br' || cornerAnchor === 'tl');
        handle.style.cursor = nwse ? 'nwse-resize' : 'nesw-resize';
        // The arrow icon is drawn along the NW-SE diagonal; mirror it for NE-SW corners.
        handle.style.transform = nwse ? 'none' : 'scaleX(-1)';
    }

    function removeCornerResizeHandle() {
        playerElementRef?.querySelector('#eyv-resize-handle')?.remove();
    }

    // Resize keeps the docked corner fixed (via getCornerPosition) and drives the box off the
    // pointer's horizontal distance from that corner; height follows the live aspect ratio.
    function onCornerResizeMouseDown(e) {
        if (stickyMode !== 'corner' || e.button !== 0 || !playerElementRef) return;
        e.preventDefault();
        e.stopPropagation();
        const rect = playerElementRef.getBoundingClientRect();
        cornerResizeState = {
            anchorX: cornerAnchor.includes('l') ? rect.left : rect.right,
            aspect: rect.width > 0 ? rect.height / rect.width : 9 / 16
        };
        document.addEventListener('mousemove', onCornerResizeMouseMove, true);
        document.addEventListener('mouseup', onCornerResizeMouseUp, true);
    }

    function onCornerResizeMouseMove(e) {
        if (!cornerResizeState || !playerElementRef) return;
        e.preventDefault();
        const aspect = cornerResizeState.aspect;
        const maxW = window.innerWidth - CORNER_MARGIN * 2;
        const maxH = window.innerHeight - CORNER_MARGIN * 2;
        let w = Math.abs(e.clientX - cornerResizeState.anchorX);
        w = Math.max(CORNER_MIN_WIDTH, Math.min(maxW, w));
        let h = w * aspect;
        if (h > maxH) { h = maxH; w = h / aspect; }
        cornerWidth = w;
        const pos = getCornerPosition(cornerAnchor, w, h, CORNER_MARGIN, getMastheadOffset());
        Object.assign(playerElementRef.style, { width: `${w}px`, height: `${h}px`, left: `${pos.left}px`, top: `${pos.top}px` });
    }

    function onCornerResizeMouseUp(e) {
        document.removeEventListener('mousemove', onCornerResizeMouseMove, true);
        document.removeEventListener('mouseup', onCornerResizeMouseUp, true);
        if (!cornerResizeState) return;
        cornerResizeState = null;
        saveCornerWidth(cornerWidth);
    }

    // Drag is only live in corner mode. Initiating on the controls/buttons is ignored so
    // scrubbing and the OSD buttons still work; a movement threshold distinguishes a drag
    // from a click (which YouTube uses to toggle play).
    function onCornerMouseDown(e) {
        if (stickyMode !== 'corner' || e.button !== 0 || !playerElementRef) return;
        if (e.target.closest('#eyv-resize-handle, .ytp-chrome-bottom, .ytp-chrome-controls, .ytp-progress-bar-container, .eyv-player-button, .eyv-pip-button, button, a, input')) return;
        endCornerSnapAnim(); // a fresh grab must be instant, never mid-snap-transition
        const rect = playerElementRef.getBoundingClientRect();
        cornerDragState = { startX: e.clientX, startY: e.clientY, origLeft: rect.left, origTop: rect.top, moved: false };
        document.addEventListener('mousemove', onCornerMouseMove, true);
        document.addEventListener('mouseup', onCornerMouseUp, true);
    }

    function onCornerMouseMove(e) {
        if (!cornerDragState || !playerElementRef) return;
        const dx = e.clientX - cornerDragState.startX;
        const dy = e.clientY - cornerDragState.startY;
        if (!cornerDragState.moved && Math.hypot(dx, dy) < 5) return; // below threshold: still a click
        cornerDragState.moved = true;
        e.preventDefault();
        const w = playerElementRef.offsetWidth, h = playerElementRef.offsetHeight;
        let left = cornerDragState.origLeft + dx;
        let top = cornerDragState.origTop + dy;
        left = Math.max(0, Math.min(window.innerWidth - w, left));
        top = Math.max(0, Math.min(window.innerHeight - h, top));
        playerElementRef.style.left = `${left}px`;
        playerElementRef.style.top = `${top}px`;
        showSnapPreview(); // highlight the corner it will snap to on release
    }

    function onCornerMouseUp(e) {
        document.removeEventListener('mousemove', onCornerMouseMove, true);
        document.removeEventListener('mouseup', onCornerMouseUp, true);
        hideSnapPreview();
        if (!cornerDragState) return;
        const dragged = cornerDragState.moved;
        cornerDragState = null;
        if (!dragged || !playerElementRef) return; // a plain click: let YouTube handle it
        // Swallow the click that fires right after the drag so it doesn't toggle play.
        suppressNextCornerClick = true;
        // Snap to the nearest corner based on the mini-player's center, then remember it.
        cornerAnchor = nearestCornerForRect(playerElementRef.getBoundingClientRect());
        saveCornerAnchor(cornerAnchor);
        // Glide to the snapped corner: arm the position transition BEFORE centerStickyPlayer
        // applies the new left/top so the change animates instead of jumping.
        startCornerSnapAnim();
        centerStickyPlayer(playerElementRef);
    }

    function onCornerClickCapture(e) {
        if (suppressNextCornerClick) {
            suppressNextCornerClick = false;
            e.preventDefault();
            e.stopPropagation();
        }
    }

    // While dragging, show a highlight outline at the corner the mini will snap to.
    function nearestCornerForRect(rect) {
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        return (cy < window.innerHeight / 2 ? 't' : 'b') + (cx < window.innerWidth / 2 ? 'l' : 'r');
    }

    function showSnapPreview() {
        if (!playerElementRef) return;
        let preview = document.getElementById('eyv-snap-preview');
        if (!preview) {
            preview = document.createElement('div');
            preview.id = 'eyv-snap-preview';
            document.body.appendChild(preview);
        }
        const w = playerElementRef.offsetWidth, h = playerElementRef.offsetHeight;
        const anchor = nearestCornerForRect(playerElementRef.getBoundingClientRect());
        const pos = getCornerPosition(anchor, w, h, CORNER_MARGIN, getMastheadOffset());
        Object.assign(preview.style, { display: 'block', width: `${w}px`, height: `${h}px`, left: `${pos.left}px`, top: `${pos.top}px` });
    }

    function hideSnapPreview() {
        document.getElementById('eyv-snap-preview')?.remove();
    }

    // --- TRANSITION POLISH (FLIP travel + drag-release snap glide) ---
    // Respect the OS "reduce motion" preference for every sticky animation.
    function prefersReducedMotion() {
        try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
    }

    // Cancel/finalize any in-flight FLIP, clearing its temporary transform/transition.
    function cancelStickyFlip() {
        if (stickyFlipCleanup) { try { stickyFlipCleanup(); } catch (e) { /* ignore */ } }
    }

    // FLIP: animate `element` from a previously-captured `firstRect` to its CURRENT
    // (already-applied) position and size. Used for the scroll corner-mini <-> full-size
    // transition, where the player also moves between document.body (fixed) and its in-flow
    // parent — a plain CSS transition can't span that DOM move, but a transform can. Uses
    // GPU transform only (no reflow), so the video stays crisp as the whole player scales.
    function flipStickyTransition(element, firstRect) {
        if (!element || !firstRect || prefersReducedMotion()) return;
        cancelStickyFlip(); // finalize any previous flip before starting a new one
        const lastRect = element.getBoundingClientRect();
        if (!(firstRect.width > 0 && firstRect.height > 0 && lastRect.width > 0 && lastRect.height > 0)) return;
        const dx = firstRect.left - lastRect.left;
        const dy = firstRect.top - lastRect.top;
        const sx = firstRect.width / lastRect.width;
        const sy = firstRect.height / lastRect.height;
        // Skip an imperceptible animation (avoids a pointless one-frame flicker).
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(sx - 1) < 0.01 && Math.abs(sy - 1) < 0.01) return;

        // Invert: paint the element at its old position/size first...
        element.style.transformOrigin = 'top left';
        element.style.transition = 'none';
        element.style.transform = `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;
        void element.offsetWidth; // commit the start state before transitioning

        const finish = () => {
            element.removeEventListener('transitionend', onEnd);
            if (stickyFlipTimeoutId) { clearTimeout(stickyFlipTimeoutId); stickyFlipTimeoutId = null; }
            stickyFlipCleanup = null;
            element.style.transition = '';
            element.style.transform = '';
            element.style.transformOrigin = '';
        };
        const onEnd = (e) => { if (e.target === element && e.propertyName === 'transform') finish(); };
        stickyFlipCleanup = finish;

        // ...then play: release the transform so it glides to its real position/size.
        requestAnimationFrame(() => {
            if (stickyFlipCleanup !== finish) return; // superseded/cancelled before we ran
            element.style.transition = 'transform 240ms cubic-bezier(0.22, 0.61, 0.36, 1)';
            element.style.transform = 'none';
            element.addEventListener('transitionend', onEnd);
            stickyFlipTimeoutId = setTimeout(finish, 400); // safety net if transitionend is missed
        });
    }

    // Drag-release snap: arm a brief position/size transition on the corner player so the
    // snap to the nearest corner glides instead of jumping. Toggled per-gesture (a class),
    // so live dragging/resizing — which set styles every frame — stay instant.
    function startCornerSnapAnim() {
        if (prefersReducedMotion() || !playerElementRef) return;
        endCornerSnapAnim();
        playerElementRef.classList.add('eyv-corner-snapping');
        const done = () => {
            playerElementRef?.removeEventListener('transitionend', onSnapEnd);
            if (cornerSnapTimeoutId) { clearTimeout(cornerSnapTimeoutId); cornerSnapTimeoutId = null; }
            playerElementRef?.classList.remove('eyv-corner-snapping');
        };
        const onSnapEnd = (e) => { if (e.target === playerElementRef) done(); };
        playerElementRef.addEventListener('transitionend', onSnapEnd);
        cornerSnapTimeoutId = setTimeout(done, 320); // safety net
    }

    function endCornerSnapAnim() {
        if (cornerSnapTimeoutId) { clearTimeout(cornerSnapTimeoutId); cornerSnapTimeoutId = null; }
        playerElementRef?.classList.remove('eyv-corner-snapping');
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
        stickyOnScroll: null,
        stickyCorner: null,
        stickyCornerWidth: null,
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
            const playerElement = findActivePlayer();
            if (playerElement) {
                clearInterval(mainPollInterval);
                isInitializing = false;
                initializeFeatures(playerElement);
            } else if (attempts >= MAX_POLL_ATTEMPTS) {
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

        // Guard so initializeControls only ever wires buttons/listeners once,
        // even if both the observer and a visibility retry race to call it.
        let controlsInitialized = false;

        // Function to initialize when all controls are found
        const initializeControls = () => {
            if (controlsInitialized) return;
            controlsInitialized = true;
            if (DEBUG) console.log('[EYV DBG] All controls found, initializing features...');

                // Load ALL settings FIRST (in one call to avoid cache issues), then create buttons
                loadSettings(['stickyPlayerEnabled', 'pipEnabled', 'defaultStickyEnabled', 'inactiveWhenPaused', 'inactiveAtEnd', 'stickyOnScroll', 'stickyCorner', 'stickyCornerWidth'])
                    .then(settings => {
                        stickyPlayerEnabled = settings.stickyPlayerEnabled !== false; // Default to true
                        pipEnabled = settings.pipEnabled !== false; // Default to true
                        inactiveWhenPausedEnabled = !!(settings && settings.inactiveWhenPaused);
                        inactiveAtEndEnabled = !!(settings && settings.inactiveAtEnd);
                        stickyOnScrollEnabled = !!(settings && settings.stickyOnScroll);
                        if (settings && typeof settings.stickyCorner === 'string') cornerAnchor = settings.stickyCorner;
                        if (settings && typeof settings.stickyCornerWidth === 'number' && settings.stickyCornerWidth > 0) cornerWidth = settings.stickyCornerWidth;
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
                                    deactivateStickyModeInternal(false, true);
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

                // Scroll-to-stick: listen always (cheap no-op when disabled) and evaluate
                // the current scroll position once, so enabling it on an already-scrolled
                // page (or reload while scrolled down) sticks immediately.
                cleanupRegistry.addListener(window, 'scroll', onScrollStick, { passive: true });
                handleScrollStick();

                // Corner mini-player drag (capture phase). Handlers no-op unless stickyMode
                // is 'corner', so they're harmless for the top-pinned modes.
                if (playerElementRef) {
                    cleanupRegistry.addListener(playerElementRef, 'mousedown', onCornerMouseDown, true);
                    cleanupRegistry.addListener(playerElementRef, 'click', onCornerClickCapture, true);
                }
        }; // End of initializeControlsContinued

        // When a watch page loads in a BACKGROUND/hidden tab (e.g. opened via
        // middle-click), YouTube defers building the player control bar and the
        // browser throttles timers, so the controls observer + 15s fallback can
        // give up before the controls exist. Without recovery the extension stays
        // dead even after the tab is focused.
        //
        // Recovery: once a give-up has happened, poll for the controls WHENEVER the
        // tab is visible, until they appear. A single check (or one delayed retry)
        // is unreliable because the control-bar build finishes at a variable time
        // around focus — that timing jitter is exactly why it worked "most of the
        // time". Polling every 300ms while visible removes the race; the listener
        // stays armed across hide/show cycles and self-removes once initialized.
        let visibilityRetryArmed = false;
        let controlsRetryPoll = null;
        const stopControlsRetry = () => {
            if (controlsRetryPoll) { clearInterval(controlsRetryPoll); controlsRetryPoll = null; }
            if (visibilityRetryArmed) {
                document.removeEventListener('visibilitychange', onVisibleRetry);
                visibilityRetryArmed = false;
            }
        };
        const pollForControlsWhileVisible = () => {
            if (controlsInitialized || controlsRetryPoll) return;
            if (document.visibilityState !== 'visible') return;
            const startedAt = Date.now();
            controlsRetryPoll = setInterval(() => {
                if (controlsInitialized || !player.isConnected || document.visibilityState !== 'visible') {
                    clearInterval(controlsRetryPoll); controlsRetryPoll = null; return;
                }
                playerRightControls = player.querySelector('.ytp-right-controls');
                videoElement = player.querySelector('video.html5-main-video');
                progressBar = player.querySelector('.ytp-progress-bar-container');
                if (playerRightControls && videoElement && progressBar) {
                    if (DEBUG) console.log('[EYV DBG] Controls found via visible-retry poll; initializing.');
                    stopControlsRetry();
                    initializeControls();
                } else if (Date.now() - startedAt > 15000) {
                    // Give up this poll but stay armed for a future focus/rebuild.
                    clearInterval(controlsRetryPoll); controlsRetryPoll = null;
                }
            }, 300);
            cleanupRegistry.addInterval(controlsRetryPoll);
        };
        function onVisibleRetry() {
            if (controlsInitialized) { stopControlsRetry(); return; }
            if (document.visibilityState === 'visible') pollForControlsWhileVisible();
        }
        const scheduleControlsRetryWhenVisible = () => {
            if (controlsInitialized) return;
            if (!visibilityRetryArmed) {
                visibilityRetryArmed = true;
                cleanupRegistry.addListener(document, 'visibilitychange', onVisibleRetry);
            }
            // If already visible (e.g. tab was focused at/just before give-up), the
            // controls may simply have built late — start polling immediately.
            pollForControlsWhileVisible();
        };

        // Check if controls are already present
        if (playerRightControls && videoElement && progressBar) {
            initializeControls();
        } else {
            // Use MutationObserver to watch for controls to appear
            if (DEBUG) console.log('[EYV DBG] Controls not yet loaded, setting up MutationObserver...');

            let controlsObserverAttempts = 0;

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
                } else if (controlsObserverAttempts >= MAX_CONTROLS_POLL_ATTEMPTS) {
                    controlsObserver.disconnect();
                    console.warn('[EYV] Failed to find player controls/video/progress bar after waiting.');
                    scheduleControlsRetryWhenVisible();
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
                            scheduleControlsRetryWhenVisible();
                        }
                    }
                }, MAX_CONTROLS_POLL_ATTEMPTS * CONTROLS_POLL_INTERVAL_MS);

                cleanupRegistry.addTimeout(fallbackTimeout);
            }
        }

        // Register window and document event listeners (rAF-throttled for smooth 60fps updates)
        const resizeHandler = (e) => {
            // Stop the infinite loop: if we caused this resize event, ignore it
            if (window.eyvIsDispatching) return;
            // Throttle to one recalculation per animation frame, shared with the
            // stickyResizeObserver so the two sources don't double the work per frame.
            scheduleStickyRecalc();
        };
        cleanupRegistry.addListener(window, 'resize', resizeHandler);
        cleanupRegistry.addListener(document, 'fullscreenchange', handleFullscreenChange);
    }

    // --- STICKY PLAYER HELPER ---
    function deactivateStickyModeInternal(preservePauseFlag = false, preserveModeFlags = false) {
        if (!stickyButtonElement || !stickyButtonElement.classList.contains('active')) return;
        if (DEBUG) console.log('[EYV DBG] Deactivating sticky mode.'); else console.log('[EYV] Deactivating sticky mode.');

        // Scroll corner-mini only: capture where the mini is NOW (before it returns inline) so
        // we can FLIP it back to full size after restoration. Top-pin teardown stays instant.
        const cornerFlipFromRect = (stickyMode === 'corner' && playerElementRef?.isConnected && !prefersReducedMotion())
            ? playerElementRef.getBoundingClientRect() : null;

        // Reset corner floating-mini state (scroll-stick) on any deactivation. Drag handlers
        // are gated on stickyMode, so resetting to 'top' disarms them automatically.
        endCornerSnapAnim();
        if (playerElementRef) playerElementRef.classList.remove('eyv-player-corner');
        removeCornerResizeHandle();
        stickyMode = 'top';
        cornerDragState = null;
        cornerResizeState = null;
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
        if (!preservePauseFlag) {
            wasStickyBeforePause = false;
        }
        // The PiP/fullscreen/miniplayer enter paths set their "was sticky" flag right
        // before calling deactivate; preserveModeFlags lets them keep it so it survives
        // to drive re-activation on exit. Manual/conflict deactivations leave it false.
        if (!preserveModeFlags) {
            wasStickyBeforePiP = false;
            wasStickyBeforeOsFullscreen = false;
        }

        // Now that the player is back in its inline spot and laid out, glide it from the
        // corner-mini rect up to full size (scroll-back-home restore).
        if (cornerFlipFromRect && playerElementRef?.isConnected) {
            flipStickyTransition(playerElementRef, cornerFlipFromRect);
        }
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

                // The scroll-stick corner mini exists to keep playing while you browse, so
                // Pause Deactivation (meant for the top pin) must not tear it down on pause —
                // otherwise it vanishes until the next scroll re-sticks it.
                if (stickyMode === 'corner') {
                    if (DEBUG) console.log("[EYV DBG] Paused in corner mini - keeping it shown (Pause Deactivation ignored).");
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
                // Remember the inline size for the corner-mode placeholder (accurate in
                // theater, where the actual height differs from width * aspect).
                if (initialWidth > 0 && initialHeight > 0) {
                    lastInlinePlayerWidth = initialWidth;
                    lastInlinePlayerHeight = initialHeight;
                }
                if (DEBUG) console.log(`[EYV DBG Click] Player dimensions: ${initialWidth}x${initialHeight} at (${initialLeft},${initialTop})`);

                if (initialHeight === 0 || initialWidth === 0) {
                    console.warn('[EYV] Cannot activate sticky: player dimensions are zero (may be transitioning)');
                    if (DEBUG) console.log('[EYV DBG Click] Returning early due to zero dimensions');
                    return;
                }

                // Calculate and validate aspect ratio to prevent Infinity/NaN.
                // Prefer the video's INTRINSIC dimensions (true frame ratio, e.g. 16:9)
                // over the player BOX rect: in theater mode the box is height-constrained,
                // so the box ratio is not the video ratio and would distort later resizes.
                let calculatedAspectRatio = initialHeight / initialWidth;
                const videoForRatio = playerElement.querySelector('video.html5-main-video');
                if (videoForRatio && videoForRatio.videoWidth > 0 && videoForRatio.videoHeight > 0) {
                    calculatedAspectRatio = videoForRatio.videoHeight / videoForRatio.videoWidth;
                }
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

                // Apply the requested sticky layout: 'corner' (scroll-stick floating mini)
                // or 'top' (manual button / Auto-Activate). pendingStickyMode is set by the
                // scroll-stick path before its programmatic click; it resets to 'top' here so
                // manual/auto activations always use the top-pinned layout.
                stickyMode = pendingStickyMode;
                pendingStickyMode = 'top';
                playerElement.classList.toggle('eyv-player-corner', stickyMode === 'corner');

                // Always use centerStickyPlayer to calculate dimensions after moving to body
                // This ensures proper sizing regardless of view mode (default, theater, fullscreen)
                // centerStickyPlayer also handles placeholder dimensions correctly (with constraints)
                centerStickyPlayer(playerElement);
                // Scroll corner-mini only: glide from the (inline) home rect into the corner.
                // `rect` is the player's inline position captured above, before the move to body.
                if (stickyMode === 'corner') flipStickyTransition(playerElement, rect);
                // SECURITY: innerHTML is safe here - pinSVGIconActive is a static SVG string constant (no user input)
                button.classList.add('active'); button.innerHTML = pinSVGIconActive;

                // Track that sticky was active during this video for "End Deactivation" re-activation
                wasStickyDuringCurrentVideo = true;
                if (DEBUG) console.log('[EYV DBG] Sticky activated - set wasStickyDuringCurrentVideo = true');

                // Setup ResizeObserver for smooth real-time resizing
                if (!stickyResizeObserver) {
                    stickyResizeObserver = new ResizeObserver(() => {
                        if (playerElementRef?.classList.contains('eyv-player-fixed')) {
                            // Shared throttle with the window 'resize' listener (one rAF for both)
                            scheduleStickyRecalc();
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

            // Scroll-stick bookkeeping. A genuine user click (event.isTrusted) overrides
            // scroll automation: pinning manually means scroll-up won't auto-unpin it;
            // unpinning manually while scrolled down suppresses scroll re-stick until the
            // user scrolls back home. Programmatic .click() (auto-on-load, scroll-stick)
            // has isTrusted === false and is handled by the scroll-stick flags directly.
            if (event?.isTrusted) {
                stickyActivatedByScroll = false;
                const nowSticky = button.classList.contains('active');
                if (!nowSticky && stickyOnScrollEnabled && isScrolledPastHome()) {
                    scrollStickSuppressed = true;
                }
            }
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
                            window.dispatchEvent(new Event('resize'));
                            if (DEBUG) console.log('[EYV DBG] Dispatched resize event for theater mode toggle');

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
                    deactivateStickyModeInternal(false, true);
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

                // NOTE: Do NOT reset wasStickyDuringCurrentVideo / wasStickyBeforeEnd here.
                // YouTube can swap the media element in-place mid-playback (some ad/quality/
                // codec changes) without any actual navigation; clearing the flags then would
                // disarm "Inactive At End" re-activation for the current video. Genuine
                // navigation already resets both flags in cleanup() on yt-navigate-start.

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

                            chatToggleRafId = requestAnimationFrame(() => {
                                chatToggleRafId = null;
                                // Bail if the player was torn down between scheduling and this frame
                                // (e.g. an SPA navigation arrived after the chat toggle).
                                if (!playerElementRef?.isConnected) return;
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
                                            console.warn('[EYV] Auto-resume failed:', err.name, '- retrying');
                                            // Retry once after a brief delay in case the error was transient
                                            const retryTimeout = setTimeout(() => {
                                                video.play().catch(() => {
                                                    console.warn('[EYV] Auto-resume retry failed, video may remain paused');
                                                });
                                            }, 100);
                                            pendingChatToggleTimeouts.push(retryTimeout);
                                            cleanupRegistry.addTimeout(retryTimeout);
                                        }).finally(() => {
                                            // Clear flag after play attempt completes
                                            const clearFlagTimeout = setTimeout(() => {
                                                isAutoPauseResumeActive = false;
                                                if (DEBUG) console.log('[EYV DBG] Auto pause/resume complete');
                                            }, 150);
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
                        deactivateStickyModeInternal(false, true);
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
        // Snapshot the flags synchronously now: loadSettings resolves on a later
        // microtask, and callers reset these flags on the line right after calling us,
        // which runs before the .then(). Reading the live globals there would always
        // observe false. Consume the snapshot instead.
        const wasStickyPiP = wasStickyBeforePiP;
        const wasStickyOsFull = wasStickyBeforeOsFullscreen;
        loadSettings(['defaultStickyEnabled'])
            .then(result => {
                const shouldTryReactivate = (isExitingOsFullscreen && (wasStickyOsFull || (result && result.defaultStickyEnabled))) ||
                                          (!isExitingOsFullscreen && (wasStickyPiP || (result && result.defaultStickyEnabled)));
                if (shouldTryReactivate) {
                    if (DEBUG) console.log(`[EYV DBG tryReactivating] Attempting re-activation. wasStickyPiP: ${wasStickyPiP}, wasStickyOsFS: ${wasStickyOsFull}, default: ${result.defaultStickyEnabled}`);
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
                        deactivateStickyModeInternal(false, true);
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

    // Schedule a full YouTube sync (setSize, video recalc) after resize activity settles.
    // During continuous resize we deliberately skip YouTube sync to avoid a race where
    // YouTube resets the inner <video> to stale dimensions. This re-asserts the correct
    // size once the layout stops changing - without it, the container resizes but the
    // video element stays stale until a pause/unpause forces YouTube's own setSize.
    // Staggered recalcs (150/300/500ms) win the race against YouTube's deferred layout
    // handlers. Each call cancels pending recalcs, so during continuous activity the
    // settle keeps getting pushed out and only fires once dragging stops.
    // Single throttled recalc shared by the window 'resize' listener and the
    // stickyResizeObserver. Both observe the same underlying viewport change and would
    // otherwise each run the full recalc on their own rAF every frame; sharing one rAF id
    // means whichever fires first does the work and the other dedupes against it.
    function scheduleStickyRecalc() {
        if (stickyRecalcRafId) return;
        stickyRecalcRafId = requestAnimationFrame(() => {
            stickyRecalcRafId = null;
            if (playerElementRef?.classList.contains('eyv-player-fixed')) {
                centerStickyPlayer(playerElementRef, true);
                // Re-assert a full YouTube sync once resize activity settles
                scheduleStickyResizeSettle();
            }
            // Sync our custom buttons (cheap no-op when none are present)
            syncButtonDimensions();
        });
    }

    function scheduleStickyResizeSettle() {
        delayedRecalcTimeouts.forEach(id => clearTimeout(id));
        delayedRecalcTimeouts = [];
        [150, 300, 500].forEach(delay => {
            const id = setTimeout(() => {
                if (playerElementRef?.classList.contains('eyv-player-fixed')) {
                    centerStickyPlayer(playerElementRef);
                    syncButtonDimensions();
                }
            }, delay);
            delayedRecalcTimeouts.push(id);
        });
    }

    // --- STICKY PLAYER POSITIONING & RESIZING ---
    function centerStickyPlayer(fixedPlayer, skipYouTubeSync = false) {
        if (!fixedPlayer?.classList.contains('eyv-player-fixed')) return;
        const mastheadOffset = getMastheadOffset();

        // Aspect ratio (height/width): prefer the video's live intrinsic ratio so the box
        // always matches the real frame regardless of how it was captured at activation.
        let validAspectRatio = (isFinite(originalPlayerAspectRatio) && originalPlayerAspectRatio > 0) ? originalPlayerAspectRatio : 9/16;
        {
            const liveVideoForRatio = fixedPlayer.querySelector('video.html5-main-video');
            if (liveVideoForRatio && liveVideoForRatio.videoWidth > 0 && liveVideoForRatio.videoHeight > 0) {
                validAspectRatio = liveVideoForRatio.videoHeight / liveVideoForRatio.videoWidth;
            }
        }

        let newW, newH, newL, newTop = mastheadOffset;

        // CORNER MODE (scroll-stick floating mini-player): a small box docked to a corner
        // and draggable. The placeholder keeps the ORIGINAL inline space so scrolling back
        // up returns the player without a layout jump.
        if (stickyMode === 'corner') {
            const margin = CORNER_MARGIN;
            // Use the user's chosen width (drag-to-resize), clamped to the viewport.
            const desiredW = (isFinite(cornerWidth) && cornerWidth > 0) ? cornerWidth : CORNER_DEFAULT_WIDTH;
            newW = Math.min(desiredW, Math.max(CORNER_MIN_WIDTH, window.innerWidth - margin * 2));
            newH = newW * validAspectRatio;
            const maxMiniHeight = window.innerHeight - margin * 2;
            if (maxMiniHeight > 0 && newH > maxMiniHeight) { newH = maxMiniHeight; newW = newH / validAspectRatio; }
            const pos = getCornerPosition(cornerAnchor, newW, newH, margin, mastheadOffset);
            newL = pos.left; newTop = pos.top;

            if (!isFinite(newW) || !isFinite(newH) || newW <= 0 || newH <= 0) {
                console.warn('[EYV] Invalid corner dimensions in centerStickyPlayer, aborting');
                return;
            }
            Object.assign(fixedPlayer.style, { width: `${newW}px`, height: `${newH}px`, left: `${newL}px`, top: `${newTop}px`, transform: 'translateX(0%)' });

            // Add/position the drag-to-resize grabber on the mini-player's inner corner.
            ensureCornerResizeHandle();

            // Keep the placeholder at the player's ORIGINAL inline size (not the mini size)
            // so the page layout and scroll position are preserved while the mini floats.
            // Prefer the size captured at activation (accurate in theater, where the actual
            // player height differs from width * aspect); fall back to the primary column.
            const cornerPlaceholder = document.getElementById('eyv-player-placeholder');
            if (cornerPlaceholder && cornerPlaceholder.isConnected) {
                let inlineW = lastInlinePlayerWidth;
                let inlineH = lastInlinePlayerHeight;
                if (!(inlineW > 0 && inlineH > 0)) {
                    const primaryColForPh = document.querySelector('#primary.ytd-watch-flexy');
                    inlineW = primaryColForPh ? primaryColForPh.getBoundingClientRect().width : newW;
                    if (!isFinite(inlineW) || inlineW <= 0) inlineW = parseFloat(cornerPlaceholder.style.width) || newW;
                    inlineH = inlineW * validAspectRatio;
                }
                cornerPlaceholder.style.display = 'block';
                cornerPlaceholder.style.width = `${inlineW}px`;
                cornerPlaceholder.style.height = `${inlineH}px`;
            }
        } else {
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
        newW = refRect.width; newL = refRect.left;
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

        // Height from the shared validAspectRatio computed at the top of the function.
        newH = newW * validAspectRatio;

        // Constrain height to viewport to prevent OSD controls from being pushed off screen
        // Leave some margin (100px) to ensure controls are fully visible. Clamp to a small
        // positive minimum so a very short viewport still applies a valid height instead of
        // computing a negative one that trips the final guard and aborts (leaving the player
        // frozen at stale oversized dimensions).
        const availableHeight = Math.max(120, window.innerHeight - mastheadOffset - 100);
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
        } // end top-pin (non-corner) geometry branch

        if (!skipYouTubeSync) {
            // Force YouTube to acknowledge the new size immediately
            // Set flag to tell our resize listener to ignore this dispatch (prevents infinite loops)
            window.eyvIsDispatching = true;
            window.dispatchEvent(new Event('resize', { bubbles: true }));
            window.eyvIsDispatching = false;

            // Force YouTube's internal video player to recalculate dimensions
            // This addresses the issue where the outer container resizes but the video element doesn't
            const moviePlayer = fixedPlayer.querySelector('#movie_player');
            const videoElement = fixedPlayer.querySelector('video.html5-main-video');

            if (moviePlayer) {
                // Use YouTube's internal player API to trigger a proper size recalculation
                // This is the same mechanism YouTube uses when pausing triggers a correct resize
                if (typeof moviePlayer.setSize === 'function') {
                    try {
                        moviePlayer.setSize(newW, newH);
                        if (DEBUG) console.log(`[EYV DBG] Called moviePlayer.setSize(${newW}, ${newH})`);
                    } catch(e) {
                        if (DEBUG) console.log('[EYV DBG] moviePlayer.setSize failed:', e);
                    }
                }

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

        // Schedule a double-rAF cleanup to override any YouTube-set inline dimensions
        // YouTube's own resize handler may run after ours and set stale pixel values;
        // double-rAF ensures we run 2 frames later, catching deferred YouTube handlers
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                if (!fixedPlayer?.classList.contains('eyv-player-fixed')) return;
                const vc = fixedPlayer.querySelector('.html5-video-container');
                const ve = fixedPlayer.querySelector('video.html5-main-video');
                if (vc) {
                    vc.style.setProperty('width', '100%', 'important');
                    vc.style.setProperty('height', '100%', 'important');
                    vc.style.setProperty('left', '0', 'important');
                    vc.style.setProperty('top', '0', 'important');
                }
                if (ve) {
                    ve.style.setProperty('width', '100%', 'important');
                    ve.style.setProperty('height', '100%', 'important');
                    ve.style.setProperty('left', '0', 'important');
                    ve.style.setProperty('top', '0', 'important');
                    // Forcing the video element to 100%/100% gives it the box's aspect
                    // ratio, not the video's. YouTube's object-fit defaults to 'cover',
                    // which then crops/zooms the frame to fill a non-16:9 box (e.g. theater,
                    // or a leftover override after deactivation). 'contain' letterboxes the
                    // full frame instead, matching YouTube's native sizing.
                    ve.style.setProperty('object-fit', 'contain', 'important');
                }
            });
        });
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

            /* Corner mini-player (scroll-stick): rounded floating window, draggable. */
            .eyv-player-corner {
                border-radius: 12px !important;
                overflow: hidden !important;
                box-shadow: 0 8px 28px rgba(0,0,0,0.55) !important;
            }
            .eyv-player-corner .html5-video-player,
            .eyv-player-corner .html5-video-container,
            .eyv-player-corner video.html5-main-video {
                cursor: move !important;
            }
            /* Drag-release snap glide: armed only for the one frame the snap is applied,
               so live dragging/resizing (which set styles every frame) stay instant. */
            .eyv-player-corner.eyv-corner-snapping {
                transition: left 0.2s ease-out, top 0.2s ease-out, width 0.2s ease-out, height 0.2s ease-out !important;
            }

            /* Drag-to-resize grabber on the corner mini-player's inner corner: a small
               translucent chip with a diagonal double-arrow, revealed on hover. */
            #eyv-resize-handle {
                position: absolute !important;
                width: 26px !important;
                height: 26px !important;
                margin: 6px !important;
                border-radius: 7px !important;
                background-color: rgba(0,0,0,0.55) !important;
                background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23ffffff' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M7 7L17 17M7 7L7 12M7 7L12 7M17 17L17 12M17 17L12 17'/%3E%3C/svg%3E") !important;
                background-repeat: no-repeat !important;
                background-position: center !important;
                background-size: 17px 17px !important;
                box-shadow: 0 0 0 1px rgba(255,255,255,0.45) inset, 0 1px 3px rgba(0,0,0,0.4) !important;
                opacity: 0 !important;
                transition: opacity 0.15s ease !important;
                pointer-events: auto !important;
                z-index: 2147483647 !important;
            }
            .eyv-player-corner:hover #eyv-resize-handle {
                opacity: 0.85 !important;
            }
            #eyv-resize-handle:hover {
                opacity: 1 !important;
                background-color: rgba(0,0,0,0.7) !important;
            }

            /* Snap-target highlight shown while dragging the corner mini-player. */
            #eyv-snap-preview {
                position: fixed !important;
                z-index: ${zIndex - 1} !important;
                box-sizing: border-box !important;
                border: 3px solid rgba(255,255,255,0.95) !important;
                border-radius: 12px !important;
                background: rgba(255,255,255,0.14) !important;
                box-shadow: 0 0 0 2px rgba(0,0,0,0.35), 0 0 18px rgba(255,255,255,0.35) !important;
                pointer-events: none !important;
                transition: left 0.12s ease, top 0.12s ease !important;
            }

            /* FIX: Removed '>' to select descendants, not just direct children */
            /* FIX: Add #container and direct child div to the allow-list for click-through */
            .eyv-player-fixed > div:not(#eyv-resize-handle),
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