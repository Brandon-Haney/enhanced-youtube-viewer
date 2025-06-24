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
    let wasStickyBeforeOsFullscreen = false;
    let wasStickyBeforePiP = false;
    let wasStickyBeforePause = false;
    let isScrubbing = false;
    let inactiveWhenPausedEnabled = false;
    let inactiveAtEndEnabled = false;

    // --- SVG ICON DEFINITIONS ---
    const pinSVGIcon = `<svg viewBox="0 0 24 24" preserveAspectRatio="xMidYMid meet" focusable="false" class="style-scope ytp-button" style="pointer-events: none; display: block; width: 100%; height: 100%;"><g class="style-scope ytp-button"><path d="M16,12V4H17V2H7V4H8V12L6,14V16H11.2V22H12.8V16H18V14L16,12Z" class="style-scope ytp-button" fill="currentColor"></path></g></svg>`;
    const pinSVGIconActive = `<svg viewBox="0 0 24 24" preserveAspectRatio="xMidYMid meet" focusable="false" class="style-scope ytp-button" style="pointer-events: none; display: block; width: 100%; height: 100%;"><g class="style-scope ytp-button"><path d="M16,12V4H17V2H7V4H8V12L6,14V16H11.2V22H12.8V16H18V14L16,12Z" class="style-scope ytp-button" fill="var(--yt-spec-static-brand-red, #FF0000)"></path></g></svg>`;
    // const pinSVGIconActive = `<svg viewBox="0 0 24 24" preserveAspectRatio="xMidYMid meet" focusable="false" class="style-scope ytp-button" style="pointer-events: none; display: block; width: 100%; height: 100%;"><g class="style-scope ytp-button"><path d="M16,12V4H17V2H7V4H8V12L6,14V16H11.2V22H12.8V16H18V14L16,12Z" class="style-scope ytp-button" fill="var(--yt-spec-call-to-action, #065FD4)"></path></g></svg>`;   
    const pipSVGDefault = `<svg viewBox="0 0 24 24" preserveAspectRatio="xMidYMid meet" focusable="false" class="style-scope ytp-button" style="pointer-events: none; display: block; width: 100%; height: 100%;"><g fill="currentColor"><path d="M19,11H13V5h6Zm2-8H3A2,2,0,0,0,1,5V19a2,2,0,0,0,2,2H21a2,2,0,0,0,2-2V5A2,2,0,0,0,21,3Zm0,16H3V5H21Z"/></g></svg>`;
    // const pipSVGActive = `<svg viewBox="0 0 24 24" preserveAspectRatio="xMidYMid meet" focusable="false" class="style-scope ytp-button" style="pointer-events: none; display: block; width: 100%; height: 100%;"><g fill="var(--yt-spec-call-to-action, #065FD4)"><path d="M19,11H13V5h6Zm2-8H3A2,2,0,0,0,1,5V19a2,2,0,0,0,2,2H21a2,2,0,0,0,2-2V5A2,2,0,0,0,21,3Zm0,16H3V5H21Z"/></g></svg>`;
    const pipSVGActive = `<svg viewBox="0 0 24 24" preserveAspectRatio="xMidYMid meet" focusable="false" class="style-scope ytp-button" style="pointer-events: none; display: block; width: 100%; height: 100%;"><g fill="var(--yt-spec-static-brand-red, #FF0000)"><path d="M19,11H13V5h6Zm2-8H3A2,2,0,0,0,1,5V19a2,2,0,0,0,2,2H21a2,2,0,0,0,2-2V5A2,2,0,0,0,21,3Zm0,16H3V5H21Z"/></g></svg>`;

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
            initializeFeatures(playerElement);
        } else if (attempts >= maxAttempts) { clearInterval(mainPollInterval); console.warn("[EYV] FAILED: Could not find player element."); }
    }, 500);

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
                    Object.assign(stickyButtonElement, { className: 'ytp-button eyv-player-button', title: 'Toggle Sticky Player', innerHTML: pinSVGIcon });
                    stickyButtonElement.setAttribute('aria-label', 'Toggle Sticky Player');
                }
                let pipBtnInstance = playerRightControls.querySelector('.eyv-pip-button');
                if (!pipBtnInstance) {
                    pipBtnInstance = createPiPButtonLogic(videoElement); 
                    Object.assign(pipBtnInstance, { className: 'ytp-button eyv-pip-button', title: 'Toggle Picture-in-Picture', innerHTML: pipSVGDefault });
                    pipBtnInstance.setAttribute('aria-label', 'Toggle Picture-in-Picture');
                }
                
                if (!videoElement.dataset.eyvVideoListenersAttached) {
                    chrome.storage.local.get(['inactiveWhenPaused', 'inactiveAtEnd'], (settings) => {
                        inactiveWhenPausedEnabled = !!settings.inactiveWhenPaused;
                        inactiveAtEndEnabled = !!settings.inactiveAtEnd;
                        if (DEBUG) console.log(`[EYV DBG] Loaded settings: inactiveWhenPaused=${inactiveWhenPausedEnabled}, inactiveAtEnd=${inactiveAtEndEnabled}`);
                    });

                    if (!progressBar.dataset.eyvScrubListener) {
                        progressBar.addEventListener('mousedown', () => {
                            isScrubbing = true;
                            if (DEBUG) console.log("[EYV DBG] Scrubbing started (mousedown on progress bar).");
                        });
                        // Listen on the whole document for mouseup, as the user might drag outside the bar
                        document.addEventListener('mouseup', () => {
                            if (isScrubbing) {
                                isScrubbing = false;
                                if (DEBUG) console.log("[EYV DBG] Scrubbing finished (mouseup).");
                            }
                        });
                        progressBar.dataset.eyvScrubListener = "true";
                    }
                    
                    videoElement.addEventListener('pause', () => {
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

                    videoElement.addEventListener('play', () => {
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

                    videoElement.addEventListener('ended', () => {
                        if (inactiveAtEndEnabled && stickyButtonElement?.classList.contains('active')) {
                            if (DEBUG) console.log("[EYV DBG] Video ended. Deactivating sticky mode as per settings.");
                            deactivateStickyModeInternal();
                        }
                    });

                    videoElement.dataset.eyvVideoListenersAttached = "true";
                }
                
                if (!pipBtnInstance.dataset.eyvPipListenersAttached) {
                    if (document.pictureInPictureElement === videoElement) { pipBtnInstance.classList.add('active'); pipBtnInstance.innerHTML = pipSVGActive; }
                    
                    videoElement.addEventListener('enterpictureinpicture', () => { 
                        if (document.pictureInPictureElement === videoElement) { 
                            pipBtnInstance.classList.add('active'); pipBtnInstance.innerHTML = pipSVGActive; 
                        }
                    });
                    videoElement.addEventListener('leavepictureinpicture', () => { 
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
                chrome.storage.local.get(['defaultStickyEnabled'], (result) => {
                    if (result.defaultStickyEnabled && stickyButtonElement && !stickyButtonElement.classList.contains('active')) {
                        const ytdApp = document.querySelector('ytd-app');
                        const isMini = ytdApp?.hasAttribute('miniplayer-is-active');
                        const isFull = ytdApp?.hasAttribute('fullscreen') || !!document.fullscreenElement;
                        if (!(document.pictureInPictureElement === videoElement || isMini || isFull)) stickyButtonElement.click();
                    }
                });
            } else if (playerControlsAttempts >= maxPlayerControlsAttempts) { clearInterval(controlsPoll); console.warn('[EYV] Failed to find player controls/video/progress bar.'); }
        }, 500);
        window.addEventListener('resize', () => { if (playerElementRef?.classList.contains('eyv-player-fixed')) centerStickyPlayer(playerElementRef); });
        document.addEventListener('fullscreenchange', handleFullscreenChange);
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
        stickyButtonElement.innerHTML = pinSVGIcon;
    }
    
    // --- STICKY PLAYER LOGIC ---
    function createStickyButtonLogic(playerElement, videoElementForPiPWatch) {
        const button = document.createElement('button');
        button.addEventListener('click', (event) => {
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
                playerPlaceholder.style.backgroundColor = getComputedStyle(document.documentElement).getPropertyValue('--yt-spec-base-background').trim() || '#0f0f0f';
                playerPlaceholder.style.display = 'block';
                playerElement.classList.add('eyv-player-fixed');
                const isTheater = watchFlexy?.hasAttribute('theater');
                const isYtFull = ytdApp?.hasAttribute('fullscreen');
                if (!isTheater && !isYtFull && !document.fullscreenElement) { 
                    Object.assign(playerElement.style, { width: `${initialWidth}px`, height: `${initialHeight}px`, left: `${initialLeft}px`, top: `${initialTop}px`, transform: 'translateX(0%)' });
                } else { centerStickyPlayer(playerElement); }
                button.classList.add('active'); button.innerHTML = pinSVGIconActive; 
            } else { deactivateStickyModeInternal(); }
        });
        if (videoElementForPiPWatch) { 
            videoElementForPiPWatch.addEventListener('enterpictureinpicture', () => { 
                if (document.pictureInPictureElement === videoElementForPiPWatch && button.classList.contains('active')) {
                    if (DEBUG) console.log("[EYV DBG] OS PiP entered. Deactivating sticky.");
                    deactivateStickyModeInternal();
                }
            }); 
        }
        return button;
    }

    // --- PLAYER STATE OBSERVER ---
    function setupPlayerStateObserver(playerNodeToObserve, videoElement) { 
        if (playerStateObserver) playerStateObserver.disconnect(); 
        const ytdApp = document.querySelector('ytd-app');
        const watchFlexy = document.querySelector('ytd-watch-flexy');
        const observerConfig = { attributes: true, attributeOldValue: true, attributeFilter: ['miniplayer-is-active', 'fullscreen', 'theater', 'class'] }; 
        const callback = (mutationsList) => {
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
                if (shouldDeactivate && stickyButtonElement?.classList.contains('active')) {
                    deactivateStickyModeInternal();
                    return;
                }
            }
            if (isExitingMiniplayer) {
                tryReactivatingStickyAfterPiPOrMiniplayer(videoElement);
                wasStickyBeforePiP = false;
            } else if (shouldRecenter && playerElementRef?.classList.contains('eyv-player-fixed')) {
                centerStickyPlayer(playerElementRef);
            }
        };
        playerStateObserver = new MutationObserver(callback);
        if (ytdApp) playerStateObserver.observe(ytdApp, observerConfig);
        if (watchFlexy) playerStateObserver.observe(watchFlexy, observerConfig); 
        if (playerNodeToObserve) playerStateObserver.observe(playerNodeToObserve, observerConfig);
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
        chrome.storage.local.get(['defaultStickyEnabled'], (result) => {
            const shouldTryReactivate = (isExitingOsFullscreen && (wasStickyBeforeOsFullscreen || result.defaultStickyEnabled)) ||
                                      (!isExitingOsFullscreen && (wasStickyBeforePiP || result.defaultStickyEnabled));
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
        button.addEventListener('click', async (event) => {
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
        });
        return button;
    }

    // --- STICKY PLAYER POSITIONING & RESIZING ---
    function centerStickyPlayer(fixedPlayer) { 
        if (!fixedPlayer?.classList.contains('eyv-player-fixed')) return;
        const mastheadOffset = getMastheadOffset();
        const watchFlexy = document.querySelector('ytd-watch-flexy');
        const primaryCol = document.querySelector('#primary.ytd-watch-flexy'); 
        let refRect, refName = "VP Fallback";
        const isTheater = watchFlexy?.hasAttribute('theater');
        const isYtFull = document.querySelector('ytd-app')?.hasAttribute('fullscreen');
        if (isTheater || isYtFull) { refRect = watchFlexy.getBoundingClientRect(); refName = "Theater/Full"; }
        else if (primaryCol) { refRect = primaryCol.getBoundingClientRect(); refName = "Default"; }
        else if (watchFlexy) { refRect = watchFlexy.getBoundingClientRect(); refName = "Fallback"; }
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