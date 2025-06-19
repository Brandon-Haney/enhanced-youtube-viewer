(function() {
    // --- INITIALIZATION GUARD ---
    if (window.eyvHasRun) { return; }
    window.eyvHasRun = true;

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

    console.log("[EYV] Content script executing.");

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
            initializeFeatures(playerElement);
        } else if (attempts >= maxAttempts) {
            clearInterval(mainPollInterval);
            console.warn("[EYV] FAILED: Could not find player element (ytd-player) after polling.");
        }
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

            if (playerRightControls && videoElement) {
                clearInterval(controlsPoll);
                stickyButtonElement = playerRightControls.querySelector('.eyv-player-button');
                if (!stickyButtonElement) {
                    stickyButtonElement = createStickyButtonLogic(player, videoElement); 
                    stickyButtonElement.className = 'ytp-button eyv-player-button';
                    stickyButtonElement.title = 'Toggle Sticky Player';
                    stickyButtonElement.setAttribute('aria-label', 'Toggle Sticky Player');
                    stickyButtonElement.innerHTML = pinSVGIcon;
                }
                let pipBtnInstance = playerRightControls.querySelector('.eyv-pip-button');
                if (!pipBtnInstance) {
                    pipBtnInstance = createPiPButtonLogic(videoElement); 
                    pipBtnInstance.className = 'ytp-button eyv-pip-button';
                    pipBtnInstance.title = 'Toggle Picture-in-Picture';
                    pipBtnInstance.setAttribute('aria-label', 'Toggle Picture-in-Picture');
                    pipBtnInstance.innerHTML = pipSVGDefault;
                }
                if (!pipBtnInstance.dataset.eyvPipListenersAttached) {
                    if (document.pictureInPictureElement === videoElement) { pipBtnInstance.classList.add('active'); pipBtnInstance.innerHTML = pipSVGActive; }
                    videoElement.addEventListener('enterpictureinpicture', () => { if (document.pictureInPictureElement === videoElement) { pipBtnInstance.classList.add('active'); pipBtnInstance.innerHTML = pipSVGActive; }});
                    videoElement.addEventListener('leavepictureinpicture', () => { pipBtnInstance.classList.remove('active'); pipBtnInstance.innerHTML = pipSVGDefault; });
                    pipBtnInstance.dataset.eyvPipListenersAttached = "true";
                }
                const settingsButton = playerRightControls.querySelector('.ytp-settings-button');
                if (settingsButton) {
                    if (!playerRightControls.contains(stickyButtonElement)) playerRightControls.insertBefore(stickyButtonElement, settingsButton);
                    if (!playerRightControls.contains(pipBtnInstance)) playerRightControls.insertBefore(pipBtnInstance, settingsButton); 
                    if (playerRightControls.contains(stickyButtonElement) && playerRightControls.contains(pipBtnInstance) && 
                        (stickyButtonElement.nextSibling !== pipBtnInstance && (pipBtnInstance.previousSibling !== stickyButtonElement || !pipBtnInstance.previousSibling))) {
                         playerRightControls.insertBefore(stickyButtonElement, pipBtnInstance);
                    }
                } else { 
                    if (!playerRightControls.contains(pipBtnInstance)) playerRightControls.prepend(pipBtnInstance);
                    if (!playerRightControls.contains(stickyButtonElement)) playerRightControls.prepend(stickyButtonElement);
                }
                if (playerElementRef && !playerStateObserver) { 
                    setupPlayerStateObserver(playerElementRef, videoElement);
                }
            } else if (playerControlsAttempts >= maxPlayerControlsAttempts) {
                clearInterval(controlsPoll);
                if (!playerRightControls) console.warn('[EYV] Could not find .ytp-right-controls.');
                if (!videoElement) console.warn('[EYV] Could not find video.html5-main-video.');
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
        if (!stickyButtonElement || !stickyButtonElement.classList.contains('active')) return; 
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
        button.addEventListener('click', (event) => {
            event.stopPropagation();
            const currentlySticky = button.classList.contains('active');
            if (!currentlySticky) { 
                const ytdAppElement = document.querySelector('ytd-app');
                const isYouTubeMiniplayerActive = ytdAppElement ? ytdAppElement.hasAttribute('miniplayer-is-active') : false;
                const isYouTubeFullscreen = ytdAppElement ? ytdAppElement.hasAttribute('fullscreen') : false;
                // Also check standard fullscreen API as a fallback for OS fullscreen
                const isOSFullscreen = !!document.fullscreenElement;


                if (document.pictureInPictureElement === videoElementForPiPWatch || isYouTubeMiniplayerActive || isYouTubeFullscreen || isOSFullscreen) {
                    console.log("[EYV] Cannot activate sticky while PiP, Miniplayer, or Fullscreen is active.");
                    return; 
                }
                
                const rect = playerElement.getBoundingClientRect(); 
                const initialWidth = rect.width; const initialHeight = rect.height;
                if (initialHeight === 0 || initialWidth === 0) return; 
                originalPlayerAspectRatio = initialHeight / initialWidth;
                if (!playerPlaceholder) { 
                    playerPlaceholder = document.createElement('div');
                    playerPlaceholder.id = 'eyv-player-placeholder';
                    if (playerElement.parentNode) playerElement.parentNode.insertBefore(playerPlaceholder, playerElement);
                    else return;
                }
                playerPlaceholder.style.width = `100%`; playerPlaceholder.style.height = `${initialHeight}px`; 
                playerPlaceholder.style.display = 'block';
                playerElement.classList.add('eyv-player-fixed');
                centerStickyPlayer(playerElement); 
                button.classList.add('active'); 
                button.innerHTML = pinSVGIconActive; 
            } else { 
                deactivateStickyModeInternal(); 
            }
        });
        if (videoElementForPiPWatch) { // OS PiP check
            videoElementForPiPWatch.addEventListener('enterpictureinpicture', () => {
                if (document.pictureInPictureElement === videoElementForPiPWatch && button.classList.contains('active')) {
                    deactivateStickyModeInternal();
                }
            });
        }
        return button;
    }

    // --- PLAYER STATE OBSERVER (Miniplayer, Theater, Fullscreen attributes) ---
    function setupPlayerStateObserver(playerNodeToObserve, videoElement) { // playerNodeToObserve is ytd-player
        if (playerStateObserver) playerStateObserver.disconnect(); 

        const ytdAppElement = document.querySelector('ytd-app');
        const watchFlexyElement = document.querySelector('ytd-watch-flexy');

        const attributeFilterList = ['miniplayer-is-active', 'fullscreen', 'theater', 'class'];
        const observerConfig = { attributes: true, attributeOldValue: true, attributeFilter: attributeFilterList }; 

        const callback = function(mutationsList, observer) {
            if (!stickyButtonElement || !stickyButtonElement.classList.contains('active')) return;

            for (const mutation of mutationsList) {
                if (mutation.type === 'attributes') {
                    const targetElement = mutation.target;
                    const attrName = mutation.attributeName;
                    let shouldDeactivate = false;

                    // Check ytd-app attributes
                    if (targetElement === ytdAppElement) {
                        if (attrName === 'miniplayer-is-active' && ytdAppElement.hasAttribute('miniplayer-is-active')) {
                            console.log("[EYV] YouTube Miniplayer activated (ytd-app attr).");
                            shouldDeactivate = true;
                        } else if (attrName === 'fullscreen' && ytdAppElement.hasAttribute('fullscreen')) {
                            console.log("[EYV] YouTube Fullscreen activated (ytd-app attr).");
                            shouldDeactivate = true;
                        }
                    }
                    // Check ytd-watch-flexy attributes
                    if (!shouldDeactivate && targetElement === watchFlexyElement) {
                        if (attrName === 'theater') { // Theater mode entered OR exited
                            // If theater mode is entered OR if it's exited (meaning it had the attribute and now doesn't)
                            // we deactivate sticky. Default view is the goal after these modes.
                            console.log("[EYV] Theater mode changed (ytd-watch-flexy attr).");
                            shouldDeactivate = true;
                        }
                         // ytd-watch-flexy might also get 'fullscreen' attribute for some YT layouts
                        if (attrName === 'fullscreen' && watchFlexyElement.hasAttribute('fullscreen')) {
                            console.log("[EYV] YouTube Fullscreen activated (watch-flexy attr).");
                            shouldDeactivate = true;
                        }
                    }
                    // Check ytd-player classes for ytp-fullscreen (alternative fullscreen detection)
                    if (!shouldDeactivate && targetElement === playerNodeToObserve && attrName === 'class') {
                        if (playerNodeToObserve.classList.contains('ytp-fullscreen')) {
                            console.log("[EYV] Player entered ytp-fullscreen class.");
                            shouldDeactivate = true;
                        } else if (mutation.oldValue && mutation.oldValue.includes('ytp-fullscreen')) {
                            console.log("[EYV] Player exited ytp-fullscreen class.");
                            shouldDeactivate = true; // Exiting this specific fullscreen class implies going to default/theater
                        }
                    }

                    if (shouldDeactivate) {
                        deactivateStickyModeInternal();
                        return; // Exit after first deactivating event
                    }
                }
            }
        };

        playerStateObserver = new MutationObserver(callback);
        if (ytdAppElement) playerStateObserver.observe(ytdAppElement, observerConfig);
        if (watchFlexyElement) playerStateObserver.observe(watchFlexyElement, observerConfig); // Same config should work
        if (playerNodeToObserve) playerStateObserver.observe(playerNodeToObserve, observerConfig);
        
        console.log("[EYV] PlayerStateObserver setup for ytd-app, ytd-watch-flexy, and ytd-player.");
    }
    
    // --- HANDLE BROWSER/OS FULLSCREEN EXIT ---
    function handleFullscreenChange() {
        // This handles exiting OS-level fullscreen (e.g., pressing Esc)
        if (!document.fullscreenElement && stickyButtonElement && stickyButtonElement.classList.contains('active')) {
            console.log("[EYV] Exited OS fullscreen. Deactivating sticky.");
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
        const primaryColumn = document.querySelector('#primary.ytd-watch-flexy');
        const watchFlexy = document.querySelector('ytd-watch-flexy');
        let newPlayerWidth, newPlayerLeft;

        if (watchFlexy) {
            const flexyRect = watchFlexy.getBoundingClientRect();
            newPlayerWidth = flexyRect.width; newPlayerLeft = flexyRect.left; 
        } else if (primaryColumn) {
            const primaryRect = primaryColumn.getBoundingClientRect();
            newPlayerWidth = primaryRect.width; newPlayerLeft = primaryRect.left;
        } else { 
            newPlayerWidth = window.innerWidth * 0.90; newPlayerLeft = (window.innerWidth - newPlayerWidth) / 2;
        }
        if (isNaN(newPlayerWidth) || newPlayerWidth <= 0) {
            const lastWidth = parseFloat(fixedPlayer.style.width);
            newPlayerWidth = (!isNaN(lastWidth) && lastWidth > 0) ? lastWidth : ((window.innerWidth > 700) ? 640 : window.innerWidth * 0.9);
        }
        const newPlayerHeight = newPlayerWidth * originalPlayerAspectRatio;
        fixedPlayer.style.width = `${newPlayerWidth}px`; fixedPlayer.style.height = `${newPlayerHeight}px`;
        fixedPlayer.style.left = `${newPlayerLeft}px`; fixedPlayer.style.top = `${mastheadOffset}px`;
        fixedPlayer.style.transform = 'translateX(0%)'; 
    }

    // --- CSS INJECTION ---
    function injectAllStyles() {
        const style = document.createElement('style');
        style.id = 'eyv-styles';
        style.textContent = `
            .eyv-player-fixed { 
                position: fixed !important; z-index: 2100 !important; 
                background-color: var(--yt-spec-base-background, #0f0f0f); 
                box-sizing: border-box; box-shadow: 0 2px 10px rgba(0,0,0,0.2);
            }
            .eyv-player-fixed > div#movie_player,
            .eyv-player-fixed > div.html5-video-player {
                width: 100% !important; height: 100% !important;
                max-width: 100% !important; max-height: 100% !important;
                top: 0 !important; left: 0 !important;
                bottom: auto !important; right: auto !important; transform: none !important;
            }
            .eyv-player-fixed .html5-video-container,
            .eyv-player-fixed video.html5-main-video {
                width: 100% !important; height: 100% !important;
                max-width: 100% !important; max-height: 100% !important; 
                object-fit: contain !important;
                top: 0 !important; left: 0 !important;
            }
            #eyv-player-placeholder { display: none; }
            .eyv-player-button, .eyv-pip-button {
                display: inline-flex !important; 
                align-items: center !important; justify-content: center !important;
                padding: 0 !important;
                width: var(--ytp-icon-button-size, 36px) !important; 
                height: var(--ytp-icon-button-size, 36px) !important;
                fill: var(--ytp-icon-color, #cccccc) !important; 
                min-width: auto !important; position: relative; top: -10px; 
                opacity: 0.85; transition: opacity 0.1s ease-in-out;
            }
            .eyv-player-button svg, .eyv-pip-button svg {
                width: 24px !important; height: 24px !important; display: block !important; 
            }
            .eyv-player-button.active, .eyv-pip-button.active { opacity: 1 !important; }
        `;
        document.head.append(style);
    }
})();