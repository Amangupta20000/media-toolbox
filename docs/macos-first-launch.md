## macOS first launch

The current macOS agent release is not Apple-notarized. macOS may therefore show a message that it cannot verify “NativeMedia Agent.app” the first time it is opened.

1. Open **NativeMedia Agent.app** once from the Applications folder.
2. If macOS shows the warning, click **Done**.
3. Open **System Settings → Privacy & Security**.
4. In the Security section, click **Open Anyway** for **NativeMedia Agent.app**, then confirm **Open**.

This approval is normally needed only once for a fresh full installation. Future launches and in-app updates use the existing update flow.

## Installing an upgrade

NativeMedia Agent stays running in the menu bar after its dashboard window is closed. Before replacing an existing copy from a DMG, choose **Quit NativeMedia Agent** from its menu-bar menu. Then drag the new app into **Applications**, choose **Replace**, and launch it from **Applications**. This ensures macOS does not reopen the older process that was already running during the copy.

Newer releases also detect an app-bundle replacement and restart themselves after the copy, but quitting first is still recommended when installing an upgrade from an unsigned DMG.
