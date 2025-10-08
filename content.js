(function() {
    // --- INITIALIZATION GUARD ---
    if (window.eyvHasRun) { return; }
    window.eyvHasRun = true;

    // --- DEBUG FLAG ---
    const DEBUG = false; // Set to true for verbose debugging

    // --- CLEANUP REGISTRY ---
    // Tracks all event listeners to prevent memory leaks on YouTube SPA navigation
    const cleanupRegistry = {
        listeners: [],
        observers: [],
        intervals: [],

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

            // Reset arrays
            this.listeners = [];
            this.observers = [];
            this.intervals = [];

            if (DEBUG) console.log('[EYV DBG] Cleanup complete: all listeners, observers, and intervals removed.');
        }
    };

    // --- YOUTUBE SPA NAVIGATION HANDLERS ---
    // YouTube is a Single Page Application (SPA) that navigates without full page reloads.
    // We must clean up and reinitialize on navigation to prevent memory leaks.
    window.addEventListener('yt-navigate-start', () => {
        if (DEBUG) console.log('[EYV DBG] YouTube navigation starting, cleaning up...');
        cleanupRegistry.cleanup();
        // Reset initialization guard so we can reinitialize after navigation
        window.eyvHasRun = false;
    });

    window.addEventListener('yt-navigate-finish', () => {
        if (DEBUG) console.log('[EYV DBG] YouTube navigation finished, checking if reinitialization needed...');
        // Only reinitialize if we're on a watch page
        if (window.location.pathname === '/watch' && !window.eyvHasRun) {
            if (DEBUG) console.log('[EYV DBG] On watch page, reinitializing...');
            // Re-run the initialization by resetting the guard and starting the poller
            window.eyvHasRun = true;
            initializeMainPoller();
        }
    });

    // --- CLEANUP OF PREVIOUS INSTANCES ---
    const oldPageControls = document.querySelector('.eyv-controls'); if (oldPageControls) { oldPageControls.remove(); }
    document.querySelectorAll('.eyv-player-button, .eyv-pip-button').forEach(btn => btn.remove());
    const oldStyles = document.getElementById('eyv-styles'); if (oldStyles) { oldStyles.remove(); }
    const oldStickyPlayer = document.querySelector('.eyv-player-fixed');
    if (oldStickyPlayer) {
        oldStickyPlayer.classList.remove('eyv-player-fixed');
        Object.assign(oldStickyPlayer.style, { width: '', height: '', left: '', transform: '', top: '' });
    }
    const oldPlaceholder = document.getElementById('eyv-player-placeholder'); if (oldPlaceholder) { oldPlaceholder.remove(); }

    if (DEBUG) console.log("[EYV DBG] Content script executing (guard passed, cleanup done)."); else console.log("[EYV] Content script executing.");

    // --- GLOBAL VARIABLES & STATE ---
    let attempts = 0;
    const maxAttempts = 40;
    let mainPollInterval;
    let playerPlaceholder = null;
    let originalPlayerAspectRatio = 16 / 9; 
    let stickyButtonElement = null; 
    let playerElementRef = null; 
    let playerStateObserver = null;
    let wasStickyBeforeOsFullscreen = false;
    let wasStickyBeforePiP = false;
    let wasStickyBeforePause = false;
    let isScrubbing = false;
    let inactiveWhenPausedEnabled = false;
    let inactiveAtEndEnabled = false;

    // --- ADD MESSAGE LISTENER FOR POPUP SETTINGS ---
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
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
                } else if (message.key === 'inactiveAtEnd') {
                    inactiveAtEndEnabled = message.value;
                }
                sendResponse({ status: "ok" });
                return true; // Keep channel open for async response
            }
            // Don't return true if we didn't handle the message
        });
    }

    // --- SVG ICON DEFINITIONS ---
    const pinSVGIcon = `<svg viewBox="0 0 24 24" preserveAspectRatio="xMidYMid meet" focusable="false" class="style-scope ytp-button" style="pointer-events: none; display: block; width: 100%; height: 100%;"><g class="style-scope ytp-button"><path d="M16,12V4H17V2H7V4H8V12L6,14V16H11.2V22H12.8V16H18V14L16,12Z" class="style-scope ytp-button" fill="currentColor"></path></g></svg>`;
    const pinSVGIconActive = `<svg viewBox="0 0 24 24" preserveAspectRatio="xMidYMid meet" focusable="false" class="style-scope ytp-button" style="pointer-events: none; display: block; width: 100%; height: 100%;"><g class="style-scope ytp-button"><path d="M16,12V4H17V2H7V4H8V12L6,14V16H11.2V22H12.8V16H18V14L16,12Z" class="style-scope ytp-button" fill="var(--yt-spec-static-brand-red, #FF0000)"></path></g></svg>`;
    const pipSVGDefault = `<svg viewBox="0 0 24 24" preserveAspectRatio="xMidYMid meet" focusable="false" class="style-scope ytp-button" style="pointer-events: none; display: block; width: 100%; height: 100%;"><g fill="currentColor"><path d="M19,11H13V5h6Zm2-8H3A2,2,0,0,0,1,5V19a2,2,0,0,0,2,2H21a2,2,0,0,0,2-2V5A2,2,0,0,0,21,3Zm0,16H3V5H21Z"/></g></svg>`;
    const pipSVGActive = `<svg viewBox="0 0 24 24" preserveAspectRatio="xMidYMid meet" focusable="false" class="style-scope ytp-button" style="pointer-events: none; display: block; width: 100%; height: 100%;"><g fill="var(--yt-spec-static-brand-red, #FF0000)"><path d="M19,11H13V5h6Zm2-8H3A2,2,0,0,0,1,5V19a2,2,0,0,0,2,2H21a2,2,0,0,0,2-2V5A2,2,0,0,0,21,3Zm0,16H3V5H21Z"/></g></svg>`;

    // --- UTILITY FUNCTIONS ---
    function getMastheadOffset() {
        const masthead = document.querySelector('#masthead-container ytd-masthead') || document.querySelector('#masthead-container');
        if (masthead && masthead.offsetHeight > 0) return masthead.offsetHeight;
        const appMasthead = document.querySelector('ytd-app ytd-masthead[persistent]');
        if (appMasthead && appMasthead.offsetHeight > 0) return appMasthead.offsetHeight;
        return 0;
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
        // Reject everything else (including keywords to be extra safe)
        return '#0f0f0f';
    }

    // --- MAIN INITIALIZATION POLLER ---
    function initializeMainPoller() {
        attempts = 0; // Reset attempts counter
        mainPollInterval = setInterval(() => {
            attempts++;
            const playerElement = document.querySelector('ytd-player');
            if (playerElement) {
                clearInterval(mainPollInterval);
                initializeFeatures(playerElement);
            } else if (attempts >= maxAttempts) {
                clearInterval(mainPollInterval);
                console.warn("[EYV] FAILED: Could not find player element.");
            }
        }, 500);
        // Register interval for cleanup
        cleanupRegistry.addInterval(mainPollInterval);
    }

    // Start initial polling
    initializeMainPoller();

    // --- FEATURE INITIALIZATION ---
    function initializeFeatures(player) { 
        playerElementRef = player; 
        if (!document.getElementById('eyv-styles')) injectAllStyles();
        if (!player) { console.error('[EYV] ERROR: Player element not valid.'); return; }
        
        let playerControlsAttempts = 0;
        const maxPlayerControlsAttempts = 30;
        const controlsPoll = setInterval(() => {
            playerControlsAttempts++;
            const playerRightControls = player.querySelector('.ytp-right-controls');
            const videoElement = player.querySelector('video.html5-main-video');
            const progressBar = player.querySelector('.ytp-progress-bar-container');

            if (playerRightControls && videoElement && progressBar) {
                clearInterval(controlsPoll);
                stickyButtonElement = playerRightControls.querySelector('.eyv-player-button');
                if (!stickyButtonElement) {
                    stickyButtonElement = createStickyButtonLogic(player, videoElement);
                    // SECURITY: innerHTML is safe here - pinSVGIcon is a static SVG string constant defined in extension code (no user input)
                    Object.assign(stickyButtonElement, { className: 'ytp-button eyv-player-button', title: 'Toggle Sticky Player', innerHTML: pinSVGIcon });
                    stickyButtonElement.setAttribute('aria-label', 'Toggle Sticky Player');
                }
                let pipBtnInstance = playerRightControls.querySelector('.eyv-pip-button');
                if (!pipBtnInstance) {
                    pipBtnInstance = createPiPButtonLogic(videoElement);
                    // SECURITY: innerHTML is safe here - pipSVGDefault is a static SVG string constant defined in extension code (no user input)
                    Object.assign(pipBtnInstance, { className: 'ytp-button eyv-pip-button', title: 'Toggle Picture-in-Picture', innerHTML: pipSVGDefault });
                    pipBtnInstance.setAttribute('aria-label', 'Toggle Picture-in-Picture');
                }
                
                if (!videoElement.dataset.eyvVideoListenersAttached) {
                    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) {
                        chrome.storage.local.get(['inactiveWhenPaused', 'inactiveAtEnd'], (settings) => {
                            // Double-check Chrome context is still valid after async callback
                            if (!chrome.runtime?.id) {
                                console.error('[EYV] Chrome context invalidated during storage operation');
                                return;
                            }
                            if (chrome.runtime.lastError) {
                                console.error('[EYV] Storage access failed:', chrome.runtime.lastError);
                                return;
                            }
                            inactiveWhenPausedEnabled = !!(settings && settings.inactiveWhenPaused);
                            inactiveAtEndEnabled = !!(settings && settings.inactiveAtEnd);
                            if (DEBUG) console.log(`[EYV DBG] Loaded settings: inactiveWhenPaused=${inactiveWhenPausedEnabled}, inactiveAtEnd=${inactiveAtEndEnabled}`);
                        });
                    }

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
                        if (isScrubbing) {
                            if (DEBUG) console.log("[EYV DBG] Paused, but ignored because user is scrubbing.");
                            return;
                        }
                        if (inactiveWhenPausedEnabled && stickyButtonElement?.classList.contains('active')) {
                            if (DEBUG) console.log("[EYV DBG] Paused. Deactivating sticky mode as per settings.");
                            wasStickyBeforePause = true;
                            deactivateStickyModeInternal();
                        }
                    });

                    cleanupRegistry.addListener(videoElement, 'play', () => {
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
                    });

                    cleanupRegistry.addListener(videoElement, 'ended', () => {
                        if (inactiveAtEndEnabled && stickyButtonElement?.classList.contains('active')) {
                            if (DEBUG) console.log("[EYV DBG] Video ended. Deactivating sticky mode as per settings.");
                            deactivateStickyModeInternal();
                        }
                    });

                    videoElement.dataset.eyvVideoListenersAttached = "true";
                }
                
                if (!pipBtnInstance.dataset.eyvPipListenersAttached) {
                    // SECURITY: innerHTML is safe here - pipSVGActive is a static SVG string constant (no user input)
                    if (document.pictureInPictureElement === videoElement) { pipBtnInstance.classList.add('active'); pipBtnInstance.innerHTML = pipSVGActive; }

                    cleanupRegistry.addListener(videoElement, 'enterpictureinpicture', () => {
                        if (document.pictureInPictureElement === videoElement) {
                            // SECURITY: innerHTML is safe here - pipSVGActive is a static SVG string constant (no user input)
                            pipBtnInstance.classList.add('active'); pipBtnInstance.innerHTML = pipSVGActive;
                            // If sticky is active when PiP is entered (e.g. via browser button/keyboard), deactivate it
                            if (stickyButtonElement?.classList.contains('active')) {
                                wasStickyBeforePiP = true;
                                if (DEBUG) console.log("[EYV DBG] OS PiP entered. Deactivating sticky.");
                                deactivateStickyModeInternal();
                            }
                        }
                    });
                    cleanupRegistry.addListener(videoElement, 'leavepictureinpicture', () => {
                        // SECURITY: innerHTML is safe here - pipSVGDefault is a static SVG string constant (no user input)
                        pipBtnInstance.classList.remove('active'); pipBtnInstance.innerHTML = pipSVGDefault;
                        if (DEBUG) console.log("[EYV DBG] OS 'leavepictureinpicture' event. wasStickyBeforePiP:", wasStickyBeforePiP);
                        tryReactivatingStickyAfterPiPOrMiniplayer(videoElement);
                        wasStickyBeforePiP = false;
                    });
                    pipBtnInstance.dataset.eyvPipListenersAttached = "true";
                }
                const settingsButton = playerRightControls.querySelector('.ytp-settings-button');
                if (settingsButton) {
                    if (!playerRightControls.contains(pipBtnInstance) || (pipBtnInstance.nextSibling !== settingsButton && pipBtnInstance.parentNode === playerRightControls) ) playerRightControls.insertBefore(pipBtnInstance, settingsButton);
                    if (!playerRightControls.contains(stickyButtonElement) || (stickyButtonElement.nextSibling !== pipBtnInstance && stickyButtonElement.parentNode === playerRightControls) ) playerRightControls.insertBefore(stickyButtonElement, pipBtnInstance);
                } else { 
                    if (!playerRightControls.contains(pipBtnInstance)) playerRightControls.prepend(pipBtnInstance);
                    if (!playerRightControls.contains(stickyButtonElement)) playerRightControls.prepend(stickyButtonElement); 
                }
                if (playerElementRef && !playerStateObserver) setupPlayerStateObserver(playerElementRef, videoElement);
                // FIX: Add guard clause before accessing storage
                if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) {
                    chrome.storage.local.get(['defaultStickyEnabled'], (result) => {
                        // Double-check Chrome context is still valid after async callback
                        if (!chrome.runtime?.id) {
                            console.error('[EYV] Chrome context invalidated during storage operation');
                            return;
                        }
                        if (chrome.runtime.lastError) {
                            console.error('[EYV] Storage access failed:', chrome.runtime.lastError);
                            return;
                        }
                        if (result && result.defaultStickyEnabled && stickyButtonElement && !stickyButtonElement.classList.contains('active')) {
                            const ytdApp = document.querySelector('ytd-app');
                            const isMini = ytdApp?.hasAttribute('miniplayer-is-active');
                            const isFull = ytdApp?.hasAttribute('fullscreen') || !!document.fullscreenElement;
                            if (!(document.pictureInPictureElement === videoElement || isMini || isFull)) stickyButtonElement.click();
                        }
                    });
                }
            } else if (playerControlsAttempts >= maxPlayerControlsAttempts) { clearInterval(controlsPoll); console.warn('[EYV] Failed to find player controls/video/progress bar.'); }
        }, 500);
        // Register interval for cleanup
        cleanupRegistry.addInterval(controlsPoll);

        // Register window and document event listeners
        cleanupRegistry.addListener(window, 'resize', () => { if (playerElementRef?.classList.contains('eyv-player-fixed')) centerStickyPlayer(playerElementRef); });
        cleanupRegistry.addListener(document, 'fullscreenchange', handleFullscreenChange);
    }

    // --- STICKY PLAYER HELPER ---
    function deactivateStickyModeInternal() {
        if (!stickyButtonElement || !stickyButtonElement.classList.contains('active')) return;
        if (DEBUG) console.log('[EYV DBG] Deactivating sticky mode.'); else console.log('[EYV] Deactivating sticky mode.');
        if (playerElementRef) {
            playerElementRef.classList.remove('eyv-player-fixed');
            Object.assign(playerElementRef.style, { width: '', height: '', top: '', left: '', transform: '' });
        }
        if (playerPlaceholder) playerPlaceholder.style.display = 'none';
        stickyButtonElement.classList.remove('active');
        // SECURITY: innerHTML is safe here - pinSVGIcon is a static SVG string constant (no user input)
        stickyButtonElement.innerHTML = pinSVGIcon;
        // Reset all state flags to prevent state desynchronization
        wasStickyBeforePiP = false;
        wasStickyBeforePause = false;
        wasStickyBeforeOsFullscreen = false;
    }
    
    // --- STICKY PLAYER LOGIC ---
    function createStickyButtonLogic(playerElement, videoElementForPiPWatch) {
        const button = document.createElement('button');
        const clickHandler = (event) => {
            event.stopPropagation();
            wasStickyBeforePause = false; // Manual click resets pause-related state
            const currentlySticky = button.classList.contains('active');
            if (!currentlySticky) {
                const ytdApp = document.querySelector('ytd-app');
                const watchFlexy = document.querySelector('ytd-watch-flexy');
                if (document.pictureInPictureElement === videoElementForPiPWatch || ytdApp?.hasAttribute('miniplayer-is-active') || ytdApp?.hasAttribute('fullscreen') || !!document.fullscreenElement) {
                    console.log("[EYV] Cannot activate sticky: conflicting mode active."); return;
                }
                const rect = playerElement.getBoundingClientRect();
                const initialWidth = rect.width; const initialHeight = rect.height;
                const initialLeft = rect.left; const initialTop = rect.top;
                if (initialHeight === 0 || initialWidth === 0) return;
                originalPlayerAspectRatio = initialHeight / initialWidth;
                if (!playerPlaceholder) {
                    playerPlaceholder = document.createElement('div'); playerPlaceholder.id = 'eyv-player-placeholder';
                    if (playerElement.parentNode) playerElement.parentNode.insertBefore(playerPlaceholder, playerElement); else return;
                }
                playerPlaceholder.style.width = `${initialWidth}px`; playerPlaceholder.style.height = `${initialHeight}px`;
                // Sanitize CSS color value from YouTube page to prevent injection
                const bgColor = getComputedStyle(document.documentElement).getPropertyValue('--yt-spec-base-background');
                playerPlaceholder.style.backgroundColor = sanitizeColorValue(bgColor);
                playerPlaceholder.style.display = 'block';
                playerElement.classList.add('eyv-player-fixed');
                const isTheater = watchFlexy?.hasAttribute('theater');
                const isYtFull = ytdApp?.hasAttribute('fullscreen');
                if (!isTheater && !isYtFull && !document.fullscreenElement) {
                    Object.assign(playerElement.style, { width: `${initialWidth}px`, height: `${initialHeight}px`, left: `${initialLeft}px`, top: `${initialTop}px`, transform: 'translateX(0%)' });
                } else { centerStickyPlayer(playerElement); }
                // SECURITY: innerHTML is safe here - pinSVGIconActive is a static SVG string constant (no user input)
                button.classList.add('active'); button.innerHTML = pinSVGIconActive;
            } else { deactivateStickyModeInternal(); }
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
        const callback = (mutationsList) => {
            try {
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
                        shouldRecenter = true; if (DEBUG) console.log("[EYV DBG MO] Theater mode toggled (watch-flexy).");
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
        playerStateObserver = new MutationObserver(callback);
        if (ytdApp) playerStateObserver.observe(ytdApp, observerConfig);
        if (watchFlexy) playerStateObserver.observe(watchFlexy, observerConfig);
        if (playerNodeToObserve) playerStateObserver.observe(playerNodeToObserve, observerConfig);
        // Register observer for cleanup
        cleanupRegistry.addObserver(playerStateObserver);
        if (DEBUG) console.log("[EYV DBG] PlayerStateObserver setup.");
    }
    
    // --- HANDLE BROWSER/OS FULLSCREEN EXIT/ENTER ---
    function handleFullscreenChange() {
        if (stickyButtonElement) {
            if (document.fullscreenElement) { 
                if (stickyButtonElement.classList.contains('active')) {
                    wasStickyBeforeOsFullscreen = true; 
                    deactivateStickyModeInternal();
                } else { wasStickyBeforeOsFullscreen = false; }
            } else { 
                tryReactivatingStickyAfterPiPOrMiniplayer(playerElementRef?.querySelector('video.html5-main-video'), true);
                wasStickyBeforeOsFullscreen = false; 
            }
        }
    }
    
    // --- HELPER TO TRY RE-ACTIVATING STICKY ---
    function tryReactivatingStickyAfterPiPOrMiniplayer(videoElement, isExitingOsFullscreen = false) {
        if (!videoElement) {
            if (DEBUG) console.log("[EYV DBG tryReactivating] No videoElement provided.");
            return;
        }
        if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) {
            if (DEBUG) console.log("[EYV DBG] Extension context lost. Cannot access storage.");
            return;
        }
        chrome.storage.local.get(['defaultStickyEnabled'], (result) => {
            // Double-check Chrome context is still valid after async callback
            if (!chrome.runtime?.id) {
                console.error('[EYV] Chrome context invalidated during storage operation');
                return;
            }
            if (chrome.runtime.lastError) {
                console.error('[EYV] Storage access failed:', chrome.runtime.lastError);
                return;
            }
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
        });
    }

    // --- PICTURE-IN-PICTURE (PIP) LOGIC ---
    function createPiPButtonLogic(videoElement) {
        const button = document.createElement('button');
        const pipClickHandler = async (event) => {
            event.stopPropagation(); if (!document.pictureInPictureEnabled) return;
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
            const vpW = window.innerWidth * 0.9, vpL = (window.innerWidth - vpW) / 2, vpH = vpW * originalPlayerAspectRatio;
            Object.assign(fixedPlayer.style, { width: `${vpW}px`, height: `${vpH}px`, left: `${vpL}px`, top: `${mastheadOffset}px`, transform: 'translateX(0%)' }); return;
        }
        let newW = refRect.width, newL = refRect.left;
        if (isNaN(newW) || newW <= 0) newW = parseFloat(fixedPlayer.style.width) || (window.innerWidth > 700 ? 640 : window.innerWidth * 0.9);
        const newH = newW * originalPlayerAspectRatio;
        Object.assign(fixedPlayer.style, { width: `${newW}px`, height: `${newH}px`, left: `${newL}px`, top: `${mastheadOffset}px`, transform: 'translateX(0%)' });
    }

    // --- CSS INJECTION ---
    // Injects all necessary CSS styles into the page for the extension's UI and features.
    function injectAllStyles() {
        const style = document.createElement('style');
        style.id = 'eyv-styles';
        
        style.textContent = `
            .eyv-player-fixed { 
                position: fixed !important; 
                z-index: 2100 !important;
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
                width: var(--ytp-icon-button-size, 36px) !important;
                height: var(--ytp-icon-button-size, 36px) !important;
                fill: var(--ytp-icon-color, #cccccc) !important;
                min-width: auto !important;
                position: relative !important;
                top: -12px !important;
                opacity: 0.85;
                transition: opacity 0.1s ease-in-out;
                cursor: pointer !important;
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