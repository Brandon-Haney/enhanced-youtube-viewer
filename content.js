(function() {
    // --- INITIALIZATION GUARD ---
    if (window.eyvHasRun) { return; }
    window.eyvHasRun = true;

    // --- DEBUG FLAG ---
    const DEBUG = false; // Set to true for verbose debugging

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

    // --- SVG ICON DEFINITIONS ---
    const pinSVGIcon = `<svg viewBox="0 0 24 24" preserveAspectRatio="xMidYMid meet" focusable="false" class="style-scope ytp-button" style="pointer-events: none; display: block; width: 100%; height: 100%;"><g class="style-scope ytp-button"><path d="M16,12V4H17V2H7V4H8V12L6,14V16H11.2V22H12.8V16H18V14L16,12Z" class="style-scope ytp-button" fill="currentColor"></path></g></svg>`;
    const pinSVGIconActive = `<svg viewBox="0 0 24 24" preserveAspectRatio="xMidYMid meet" focusable="false" class="style-scope ytp-button" style="pointer-events: none; display: block; width: 100%; height: 100%;"><g class="style-scope ytp-button"><path d="M16,12V4H17V2H7V4H8V12L6,14V16H11.2V22H12.8V16H18V14L16,12Z" class="style-scope ytp-button" fill="var(--yt-spec-static-brand-red, #FF0000)"></path></g></svg>`;
    const pipSVGDefault = `<svg viewBox="0 0 24 24" preserveAspectRatio="xMidYMid meet" focusable="false" class="style-scope ytp-button" style="pointer-events: none; display: block; width: 100%; height: 100%;"><g fill="currentColor"><path d="M19,11H13V5h6Zm2-8H3A2,2,0,0,0,1,5V19a2,2,0,0,0,2,2H21a2,2,0,0,0,2-2V5A2,2,0,0,0,21,3Zm0,16H3V5H21Z"/></g></svg>`;
    const pipSVGActive = `<svg viewBox="0 0 24 24" preserveAspectRatio="xMidYMid meet" focusable="false" class="style-scope ytp-button" style="pointer-events: none; display: block; width: 100%; height: 100%;"><g fill="var(--yt-spec-call-to-action, #065FD4)"><path d="M19,11H13V5h6Zm2-8H3A2,2,0,0,0,1,5V19a2,2,0,0,0,2,2H21a2,2,0,0,0,2-2V5A2,2,0,0,0,21,3Zm0,16H3V5H21Z"/></g></svg>`;

    // --- UTILITY FUNCTIONS ---
    function getMastheadOffset() {
        const masthead = document.querySelector('#masthead-container ytd-masthead') || document.querySelector('#masthead-container');
        if (masthead && masthead.offsetHeight > 0) return masthead.offsetHeight;
        const appMasthead = document.querySelector('ytd-app ytd-masthead[persistent]');
        if (appMasthead && appMasthead.offsetHeight > 0) return appMasthead.offsetHeight;
        return 0;
    }

    // --- MAIN INITIALIZATION POLLER ---
    mainPollInterval = setInterval(() => {
        attempts++;
        const playerElement = document.querySelector('ytd-player'); 
        if (playerElement) {
            clearInterval(mainPollInterval);
            if (DEBUG) console.log("[EYV DBG] SUCCESS: Player element (ytd-player) found! Initializing features.");
            initializeFeatures(playerElement);
        } else if (attempts >= maxAttempts) {
            clearInterval(mainPollInterval);
            console.warn("[EYV] FAILED: Could not find player element (ytd-player) after polling.");
        }
    }, 500);

    // --- FEATURE INITIALIZATION ---
    function initializeFeatures(player) { 
        playerElementRef = player; 
        if (DEBUG) console.log("[EYV DBG] initializeFeatures called with player:", player);

        if (!document.getElementById('eyv-styles')) injectAllStyles();
        if (!player) { console.error('[EYV] ERROR: Player element not valid in initializeFeatures.'); return; }
        
        let playerControlsAttempts = 0;
        const maxPlayerControlsAttempts = 30;
        const controlsPoll = setInterval(() => {
            playerControlsAttempts++;
            const playerRightControls = player.querySelector('.ytp-right-controls');
            const videoElement = player.querySelector('video.html5-main-video');

            if (playerRightControls && videoElement) {
                clearInterval(controlsPoll);
                if (DEBUG) console.log('[EYV DBG] Player controls and video element found.');

                stickyButtonElement = playerRightControls.querySelector('.eyv-player-button');
                if (!stickyButtonElement) {
                    if (DEBUG) console.log("[EYV DBG] Sticky button not found, creating...");
                    stickyButtonElement = createStickyButtonLogic(player, videoElement); 
                    stickyButtonElement.className = 'ytp-button eyv-player-button';
                    stickyButtonElement.title = 'Toggle Sticky Player';
                    stickyButtonElement.setAttribute('aria-label', 'Toggle Sticky Player');
                    stickyButtonElement.innerHTML = pinSVGIcon;
                } else {
                    if (DEBUG) console.log('[EYV DBG] Sticky button already exists.');
                }

                let pipBtnInstance = playerRightControls.querySelector('.eyv-pip-button');
                if (!pipBtnInstance) {
                    if (DEBUG) console.log("[EYV DBG] PiP button not found, creating...");
                    pipBtnInstance = createPiPButtonLogic(videoElement); 
                    pipBtnInstance.className = 'ytp-button eyv-pip-button';
                    pipBtnInstance.title = 'Toggle Picture-in-Picture';
                    pipBtnInstance.setAttribute('aria-label', 'Toggle Picture-in-Picture');
                    pipBtnInstance.innerHTML = pipSVGDefault;
                } else {
                     if (DEBUG) console.log('[EYV DBG] PiP button already exists.');
                }
               
                if (!pipBtnInstance.dataset.eyvPipListenersAttached) {
                    if (DEBUG) console.log("[EYV DBG] Attaching PiP listeners to PiP button.");
                    if (document.pictureInPictureElement === videoElement) { 
                        pipBtnInstance.classList.add('active'); 
                        pipBtnInstance.innerHTML = pipSVGActive; 
                    }
                    videoElement.addEventListener('enterpictureinpicture', () => { 
                        if (document.pictureInPictureElement === videoElement) { 
                            pipBtnInstance.classList.add('active'); 
                            pipBtnInstance.innerHTML = pipSVGActive; 
                        }
                    });
                    videoElement.addEventListener('leavepictureinpicture', () => { 
                        pipBtnInstance.classList.remove('active'); 
                        pipBtnInstance.innerHTML = pipSVGDefault; 
                    });
                    pipBtnInstance.dataset.eyvPipListenersAttached = "true";
                }

                // --- Insert Buttons in Correct Order ---
                const settingsButton = playerRightControls.querySelector('.ytp-settings-button');
                if (settingsButton) {
                    // Ensure PiP is before settings (if not already there or not already correctly placed)
                    if (!playerRightControls.contains(pipBtnInstance) || (pipBtnInstance.nextSibling !== settingsButton && pipBtnInstance.parentNode === playerRightControls) ) {
                        playerRightControls.insertBefore(pipBtnInstance, settingsButton);
                    }
                    // Ensure Sticky is before PiP (if not already there or not already correctly placed)
                    if (!playerRightControls.contains(stickyButtonElement) || (stickyButtonElement.nextSibling !== pipBtnInstance && stickyButtonElement.parentNode === playerRightControls) ) {
                        playerRightControls.insertBefore(stickyButtonElement, pipBtnInstance);
                    }
                } else { 
                    // Fallback if settings button isn't found, prepend in order (sticky will be first)
                    if (!playerRightControls.contains(pipBtnInstance)) playerRightControls.prepend(pipBtnInstance);
                    if (!playerRightControls.contains(stickyButtonElement)) playerRightControls.prepend(stickyButtonElement); 
                    if (DEBUG) console.warn("[EYV DBG] Settings button not found for precise button insertion, using prepend.");
                }
                console.log('[EYV] Buttons ensured in player controls.');
                
                if (playerElementRef && !playerStateObserver) { 
                    if (DEBUG) console.log("[EYV DBG] Setting up PlayerStateObserver.");
                    setupPlayerStateObserver(playerElementRef, videoElement);
                }

                chrome.storage.local.get(['defaultStickyEnabled'], function(result) {
                    if (DEBUG) console.log('[EYV DBG] Default sticky preference from storage:', result.defaultStickyEnabled);
                    if (result.defaultStickyEnabled && stickyButtonElement && !stickyButtonElement.classList.contains('active')) {
                        if (DEBUG) console.log('[EYV DBG] Attempting to default to sticky mode.');
                        
                        const ytdAppElement = document.querySelector('ytd-app');
                        const isYouTubeMiniplayerActive = ytdAppElement ? ytdAppElement.hasAttribute('miniplayer-is-active') : false;
                        const isYouTubeFullscreen = ytdAppElement ? ytdAppElement.hasAttribute('fullscreen') : false;
                        const isOSFullscreen = !!document.fullscreenElement;

                        if (!(document.pictureInPictureElement === videoElement || isYouTubeMiniplayerActive || isYouTubeFullscreen || isOSFullscreen)) {
                             if (DEBUG) console.log('[EYV DBG] Conditions met, clicking sticky button to default activate.');
                             stickyButtonElement.click();
                        } else {
                            if (DEBUG) console.log('[EYV DBG] Cannot default to sticky, a conflicting mode is active.');
                        }
                    }
                });

            } else if (playerControlsAttempts >= maxPlayerControlsAttempts) {
                clearInterval(controlsPoll);
                if (!playerRightControls) console.warn('[EYV] Could not find .ytp-right-controls after max attempts.');
                if (!videoElement) console.warn('[EYV] Could not find video.html5-main-video element after max attempts.');
            }
        }, 500);
        window.addEventListener('resize', () => {
            const stickyPlayerElement = document.querySelector('ytd-player.eyv-player-fixed');
            if (stickyPlayerElement) centerStickyPlayer(stickyPlayerElement);
        });
        document.addEventListener('fullscreenchange', handleFullscreenChange);
    }

    // --- STICKY PLAYER HELPER ---
    function deactivateStickyModeInternal() { 
        if (!stickyButtonElement || !stickyButtonElement.classList.contains('active')) {
            if (DEBUG && stickyButtonElement) console.log("[EYV DBG] deactivateStickyModeInternal: Sticky button not active or not found.");
            return;
        } 
        console.log('[EYV] Deactivating sticky mode.');
        if (playerElementRef) { 
            playerElementRef.classList.remove('eyv-player-fixed');
            Object.assign(playerElementRef.style, { width: '', height: '', top: '', left: '', transform: '' });
        }
        if (playerPlaceholder) playerPlaceholder.style.display = 'none';
        stickyButtonElement.classList.remove('active');
        stickyButtonElement.innerHTML = pinSVGIcon;
    }
    
    // --- STICKY PLAYER LOGIC ---
    function createStickyButtonLogic(playerElement, videoElementForPiPWatch) {
        const button = document.createElement('button');
        if (DEBUG) console.log("[EYV DBG] createStickyButtonLogic called for player:", playerElement);

        button.addEventListener('click', (event) => {
            event.stopPropagation();
            const currentlySticky = button.classList.contains('active');
            if (DEBUG) console.log("[EYV DBG] Sticky button clicked. Currently sticky:", currentlySticky);

            if (!currentlySticky) { 
                const ytdAppElement = document.querySelector('ytd-app');
                const watchFlexyElement = document.querySelector('ytd-watch-flexy');
                const isYouTubeMiniplayerActive = ytdAppElement ? ytdAppElement.hasAttribute('miniplayer-is-active') : false;
                const isYouTubeFullscreen = ytdAppElement ? ytdAppElement.hasAttribute('fullscreen') : false;
                const isOSFullscreen = !!document.fullscreenElement;
                const isTheaterMode = watchFlexyElement && watchFlexyElement.hasAttribute('theater');

                if (DEBUG) console.log(`[EYV DBG StickyClick] Checks before activation: OS PiP=${document.pictureInPictureElement === videoElementForPiPWatch}, YT Miniplayer=${isYouTubeMiniplayerActive}, YT Fullscreen=${isYouTubeFullscreen}, OS Fullscreen=${isOSFullscreen}`);

                if (document.pictureInPictureElement === videoElementForPiPWatch || isYouTubeMiniplayerActive || isYouTubeFullscreen || isOSFullscreen) {
                    console.log("[EYV] Cannot activate sticky: conflicting mode (PiP/Miniplayer/Fullscreen) is active.");
                    return; 
                }
                
                if (DEBUG) console.log('[EYV DBG] Activating sticky mode.');
                const rect = playerElement.getBoundingClientRect(); 
                const initialWidth = rect.width; const initialHeight = rect.height; const initialLeft = rect.left; const initialTop = rect.top;
                if (initialHeight === 0 || initialWidth === 0) { if (DEBUG) console.warn("[EYV DBG] Sticky activation aborted: initial dimensions zero."); return; } 
                originalPlayerAspectRatio = initialHeight / initialWidth;
                if (DEBUG) console.log(`[EYV DBG] Stored aspect ratio: ${originalPlayerAspectRatio.toFixed(3)}`);

                if (!playerPlaceholder) { 
                    playerPlaceholder = document.createElement('div'); playerPlaceholder.id = 'eyv-player-placeholder';
                    if (playerElement.parentNode) playerElement.parentNode.insertBefore(playerPlaceholder, playerElement);
                    else { if (DEBUG) console.error("[EYV DBG] Sticky activation failed: player has no parent."); return; }
                }
                playerPlaceholder.style.width = `${initialWidth}px`; playerPlaceholder.style.height = `${initialHeight}px`; 
                playerPlaceholder.style.display = 'block';
                playerElement.classList.add('eyv-player-fixed');
                if (!isTheaterMode && !isYouTubeFullscreen && !isOSFullscreen) { 
                    if (DEBUG) console.log(`[EYV DBG] Initial stick in Default View. W: ${initialWidth}, H: ${initialHeight}, L: ${initialLeft}, T: ${initialTop}`);
                    playerElement.style.width = `${initialWidth}px`; playerElement.style.height = `${initialHeight}px`;
                    playerElement.style.left = `${initialLeft}px`; playerElement.style.top = `${initialTop}px`;
                    playerElement.style.transform = 'translateX(0%)';
                } else {
                    if (DEBUG) console.log("[EYV DBG] Initial stick in Theater/Wide mode. Calling centerStickyPlayer.");
                    centerStickyPlayer(playerElement); 
                }
                button.classList.add('active'); button.innerHTML = pinSVGIconActive; 
            } else { 
                if (DEBUG) console.log("[EYV DBG StickyClick] Calling deactivateStickyModeInternal.");
                deactivateStickyModeInternal(); 
            }
        });
        if (videoElementForPiPWatch) { 
            videoElementForPiPWatch.addEventListener('enterpictureinpicture', () => {
                if (DEBUG) console.log("[EYV DBG] OS PiP 'enterpictureinpicture' event on video.");
                if (document.pictureInPictureElement === videoElementForPiPWatch && button.classList.contains('active')) {
                    if (DEBUG) console.log("[EYV DBG] OS PiP entered for this video. Deactivating sticky mode.");
                    deactivateStickyModeInternal();
                }
            });
        }
        return button;
    }

    // --- PLAYER STATE OBSERVER (Miniplayer, Theater, Fullscreen attributes) ---
    function setupPlayerStateObserver(playerNodeToObserve, videoElement) { 
        if (playerStateObserver) playerStateObserver.disconnect(); 
        const ytdAppElement = document.querySelector('ytd-app');
        const watchFlexyElement = document.querySelector('ytd-watch-flexy');
        const attributeFilterList = ['miniplayer-is-active', 'fullscreen', 'theater', 'class'];
        const observerConfig = { attributes: true, attributeOldValue: true, attributeFilter: attributeFilterList }; 
        const callback = function(mutationsList, observer) {
            if (!stickyButtonElement || !stickyButtonElement.classList.contains('active')) return;
            for (const mutation of mutationsList) {
                if (mutation.type === 'attributes') {
                    const targetElement = mutation.target; const attrName = mutation.attributeName;
                    let shouldDeactivate = false;
                    if (DEBUG) console.log(`[EYV DBG MO] Attribute '${attrName}' changed on ${targetElement.tagName}${targetElement.id ? '#'+targetElement.id : ''}`);
                    if (targetElement === ytdAppElement) {
                        if (attrName === 'miniplayer-is-active' && ytdAppElement.hasAttribute('miniplayer-is-active')) { shouldDeactivate = true; if (DEBUG) console.log("[EYV DBG MO] YT Miniplayer (ytd-app)."); }
                        else if (attrName === 'fullscreen' && ytdAppElement.hasAttribute('fullscreen')) { shouldDeactivate = true; if (DEBUG) console.log("[EYV DBG MO] YT Fullscreen (ytd-app)."); }
                    }
                    if (!shouldDeactivate && targetElement === watchFlexyElement) {
                        if (attrName === 'theater') { shouldDeactivate = true; if (DEBUG) console.log("[EYV DBG MO] Theater mode change (watch-flexy)."); }
                        if (attrName === 'fullscreen' && watchFlexyElement.hasAttribute('fullscreen')) { shouldDeactivate = true; if (DEBUG) console.log("[EYV DBG MO] YT Fullscreen (watch-flexy)."); }
                    }
                    if (!shouldDeactivate && targetElement === playerNodeToObserve && attrName === 'class') {
                        if (playerNodeToObserve.classList.contains('ytp-fullscreen')) { shouldDeactivate = true; if (DEBUG) console.log("[EYV DBG MO] ytp-fullscreen class added."); }
                        else if (mutation.oldValue && mutation.oldValue.includes('ytp-fullscreen')) { shouldDeactivate = true; if (DEBUG) console.log("[EYV DBG MO] ytp-fullscreen class removed."); }
                    }
                    if (shouldDeactivate) { deactivateStickyModeInternal(); return; }
                }
            }
        };
        playerStateObserver = new MutationObserver(callback);
        if (ytdAppElement) playerStateObserver.observe(ytdAppElement, observerConfig);
        if (watchFlexyElement) playerStateObserver.observe(watchFlexyElement, observerConfig); 
        if (playerNodeToObserve) playerStateObserver.observe(playerNodeToObserve, observerConfig);
        if (DEBUG) console.log("[EYV DBG] PlayerStateObserver setup for ytd-app, ytd-watch-flexy, and ytd-player.");
    }
    
    // --- HANDLE BROWSER/OS FULLSCREEN EXIT ---
    function handleFullscreenChange() {
        if (!document.fullscreenElement && stickyButtonElement && stickyButtonElement.classList.contains('active')) {
            if (DEBUG) console.log("[EYV DBG] Exited OS fullscreen. Deactivating sticky.");
            deactivateStickyModeInternal();
        } else if (document.fullscreenElement && stickyButtonElement && stickyButtonElement.classList.contains('active')) {
            if (DEBUG) console.log("[EYV DBG] Entered OS fullscreen. Deactivating sticky.");
            deactivateStickyModeInternal();
        }
    }

    // --- PICTURE-IN-PICTURE (PIP) LOGIC ---
    function createPiPButtonLogic(videoElement) {
        const button = document.createElement('button');
        button.addEventListener('click', async (event) => {
            event.stopPropagation();
            if (!document.pictureInPictureEnabled) return;
            try {
                if (videoElement !== document.pictureInPictureElement) await videoElement.requestPictureInPicture();
                else await document.exitPictureInPicture();
            } catch (error) { console.error('[EYV] PiP Error:', error); }
        });
        return button;
    }

    // --- STICKY PLAYER POSITIONING & RESIZING ---
    function centerStickyPlayer(fixedPlayer) { 
        if (!fixedPlayer || !fixedPlayer.classList.contains('eyv-player-fixed')) return;
        const mastheadOffset = getMastheadOffset();
        const watchFlexyElement = document.querySelector('ytd-watch-flexy');
        const primaryColumnElement = document.querySelector('#primary.ytd-watch-flexy'); 
        let referenceRect; let referenceName = "Viewport Fallback";
        const isTheaterMode = watchFlexyElement && watchFlexyElement.hasAttribute('theater');
        const ytdApp = document.querySelector('ytd-app');
        const isYtAppFullscreen = ytdApp && ytdApp.hasAttribute('fullscreen');
        if (isTheaterMode || isYtAppFullscreen) {
            referenceRect = watchFlexyElement.getBoundingClientRect(); referenceName = "Theater/YT Fullscreen (ytd-watch-flexy)";
        } else if (primaryColumnElement) {
            referenceRect = primaryColumnElement.getBoundingClientRect(); referenceName = "Default View (#primary column)";
        } else if (watchFlexyElement) {
            referenceRect = watchFlexyElement.getBoundingClientRect(); referenceName = "Fallback (ytd-watch-flexy)";
        } else {
            console.warn(`[EYV Sticky] No suitable layout reference. Using viewport percentage.`);
            const newPlayerWidthVP = window.innerWidth * 0.90; const newPlayerLeftVP = (window.innerWidth - newPlayerWidthVP) / 2;
            const newPlayerHeightVP = newPlayerWidthVP * originalPlayerAspectRatio;
            fixedPlayer.style.width = `${newPlayerWidthVP}px`; fixedPlayer.style.height = `${newPlayerHeightVP}px`;
            fixedPlayer.style.left = `${newPlayerLeftVP}px`; fixedPlayer.style.top = `${mastheadOffset}px`;
            fixedPlayer.style.transform = 'translateX(0%)'; return;
        }
        let newPlayerWidth = referenceRect.width; let newPlayerLeft = referenceRect.left;
        if (isNaN(newPlayerWidth) || newPlayerWidth <= 0) {
            const lastWidth = parseFloat(fixedPlayer.style.width); 
            newPlayerWidth = (!isNaN(lastWidth) && lastWidth > 0) ? lastWidth : ((window.innerWidth > 700) ? 640 : window.innerWidth * 0.9);
        }
        const newPlayerHeight = newPlayerWidth * originalPlayerAspectRatio;
        fixedPlayer.style.width = `${newPlayerWidth}px`; fixedPlayer.style.height = `${newPlayerHeight}px`;
        fixedPlayer.style.left = `${newPlayerLeft}px`; fixedPlayer.style.top = `${mastheadOffset}px`;
        fixedPlayer.style.transform = 'translateX(0%)'; 
        if (DEBUG) console.log(`[EYV DBG Sticky] Centered/Resized. Mode: ${referenceName}. W: ${newPlayerWidth.toFixed(0)}, H: ${newPlayerHeight.toFixed(0)}, L: ${newPlayerLeft.toFixed(0)}`);
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
                top: -10px !important;
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