# Enhanced YouTube Viewer

Enhanced YouTube Viewer is a Chrome browser extension designed to improve your YouTube watching experience. It offers several key features to provide more flexibility and convenience while browsing and watching videos.

## Features

*   **Sticky Player (Scrollable Comments):** Keep the video player fixed to the top of the screen while you scroll down to read comments or the video description. The player dynamically resizes with the browser window.
*   **Picture-in-Picture (PiP):** Launch the video into a separate, resizable floating window that stays on top of other applications, allowing you to multitask effectively.
*   **Integrated Controls:** Feature toggles are conveniently located within YouTube's native player controls for a seamless experience.
*   **Smart Deactivation:** Sticky mode automatically deactivates if YouTube's native Miniplayer or Fullscreen mode is engaged, preventing UI conflicts.

This extension aims to provide a smoother and more productive YouTube viewing session.

---

## Installation

### From Chrome Web Store (Recommended for most users)

**(Coming Soon! This extension is currently under development and not yet published on the Chrome Web Store.)**

Once published, you will be able to install it directly from the Chrome Web Store with a single click.

### For Development / Manual Installation (Loading Unpacked)

If you want to test the latest development version or contribute to the project, you can load the extension manually:

1.  **Download or Clone:**
    *   Download the repository as a ZIP file from GitHub and unzip it to a local folder on your computer.
    *   Alternatively, if you have Git installed, clone the repository:
        ```bash
        git clone https://github.com/Brandon-Haney/enhanced-youtube-viewer.git
        ```

2.  **Open Chrome Extensions Page:**
    *   Open Google Chrome.
    *   Navigate to `chrome://extensions` in your address bar and press Enter.

3.  **Enable Developer Mode:**
    *   In the top right corner of the Extensions page, toggle the "Developer mode" switch to the ON position.

4.  **Load Unpacked Extension:**
    *   Three new buttons should appear: "Load unpacked," "Pack extension," and "Update."
    *   Click the **"Load unpacked"** button.
    *   A file dialog will open. Navigate to and select the folder where you unzipped or cloned the extension files (the folder that directly contains `manifest.json`).
    *   Click "Select Folder."

5.  **Verify Installation:**
    *   The "Enhanced YouTube Viewer" extension should now appear in your list of extensions, and its icon should be visible in your Chrome toolbar.
    *   If you make changes to the code, you'll need to click the "Reload" icon (a circular arrow) for the extension on the `chrome://extensions` page for the changes to take effect.

---

## How to Use

Once installed and active:

1.  Navigate to any YouTube video watch page (e.g., `youtube.com/watch?v=...`).
2.  The extension's features are integrated into the YouTube player's control bar:
    *   **Sticky Player:** Click the **📌 (pin)** icon to toggle the sticky player on or off. When active, the video will stay at the top of your screen as you scroll.
    *   **Picture-in-Picture (PiP):** Click the **<svg viewBox="0 0 24 24" style="width: 0.9em; height: 0.9em; vertical-align: -0.1em; fill: currentColor;"><path d="M19,11H13V5h6Zm2-8H3A2,2,0,0,0,1,5V19a2,2,0,0,0,2,2H21a2,2,0,0,0,2-2V5A2,2,0,0,0,21,3Zm0,16H3V5H21Z"/></svg> (window)** icon to toggle PiP mode.
3.  The sticky player will automatically disable if you activate YouTube's native Miniplayer or Fullscreen modes to prevent conflicts.

---

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.