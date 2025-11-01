import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Gettext from 'gettext';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import { ClipboardManager } from './features/Clipboard/logic/clipboardManager.js';
import { createThemedIcon } from './utilities/utilityThemedIcon.js';
import { positionMenu } from './utilities/utilityMenuPositioner.js';
import { getAutoPaster, destroyAutoPaster } from './utilities/utilityAutoPaste.js';
import { getGifCacheManager, destroyGifCacheManager } from './features/GIF/logic/gifCacheManager.js';

/**
 * Creates a simple, predictable identifier from a tab name.
 */
function getTabIdentifier(tabName) {
    return tabName.replace(/\s+/g, '');
}

/**
 * Maps main tab names to their corresponding icon filenames.
 */
const TAB_DEFINITIONS = [
    {
        id: 'recently-used',
        name: "Recently Used",
        settingKey: 'enable-recently-used-tab',
        icon: 'utility-recents-symbolic.svg'
    },
    {
        id: 'emoji',
        name: "Emoji",
        settingKey: 'enable-emoji-tab',
        icon: 'main-emoji-symbolic.svg'
    },
    {
        id: 'gif',
        name: "GIF",
        settingKey: 'enable-gif-tab',
        icon: 'main-gif-symbolic.svg'
    },
    {
        id: 'kaomoji',
        name: "Kaomoji",
        settingKey: 'enable-kaomoji-tab',
        icon: 'main-kaomoji-symbolic.svg'
    },
    {
        id: 'symbols',
        name: "Symbols",
        settingKey: 'enable-symbols-tab',
        icon: 'main-symbols-symbolic.svg'
    },
    {
        id: 'clipboard',
        name: "Clipboard",
        settingKey: 'enable-clipboard-tab',
        icon: 'main-clipboard-symbolic.svg'
    }
];

/**
 * Tabs that function as "full-view" and should hide the main tab bar.
 */
const FULL_VIEW_TAB_IDS = new Set([
    'emoji',
    'gif',
    'kaomoji',
    'symbols'
]);

/**
 * The main panel indicator and menu for the All-in-One Clipboard extension.
 * This class is responsible for building the main UI, managing the tab bar,
 * and dynamically loading the content for each selected tab.
 */
const AllInOneClipboardIndicator = GObject.registerClass(
class AllInOneClipboardIndicator extends PanelMenu.Button {
        constructor(settings, extension, clipboardManager) {
        super(0.5, _("All-in-One Clipboard"), false);

        this._settings = settings;
        this._extension = extension;
        this._clipboardManager = clipboardManager;

        this._tabDefinitions = TAB_DEFINITIONS.map(definition => ({
            ...definition,
            translatedName: _(definition.name)
        }));
        this._tabDefinitionByTranslatedName = new Map();
        this._tabDefinitions.forEach(definition => {
            this._tabDefinitionByTranslatedName.set(definition.translatedName, definition);
        });

        // Create the translated list of full-view tabs now that gettext is initialized.
        this._fullViewTabs = new Set(
            this._tabDefinitions
                .filter(definition => FULL_VIEW_TAB_IDS.has(definition.id))
                .map(definition => definition.translatedName)
        );

        this._tabButtons = {};
        this._activeTabName = null;
        this._lastActiveTabName = null;
        this._tabContentArea = null;
        this._currentTabActor = null;
        this._mainTabBar = null;
        this._explicitTabTarget = null;
        this._isOpeningViaShortcut = false;

        this._currentTabVisibilitySignalId = 0;
        this._currentTabNavigateSignalId = 0;
        this._selectTabTimeoutId = 0;
        this._loadingIndicatorTimeoutId = 0;
        this._tabSettingsSignalIds = [];
        this._hasMultipleTabs = true;

        this.TAB_NAMES = this._tabDefinitions.map(definition => definition.translatedName);

        const icon = new St.Icon({ icon_name: 'edit-copy-symbolic', style_class: 'system-status-icon' });
        this.add_child(icon);

        this._buildMenu();

        this._tabDefinitions.forEach(definition => {
            const signalId = this._settings.connect(`changed::${definition.settingKey}`, () => {
                this._updateTabButtonsVisibility();
            });
            this._tabSettingsSignalIds.push(signalId);
        });

        this._updateTabButtonsVisibility();
    }

    /**
     * Constructs the main menu layout with a tab bar and content area.
     * @private
     */
    _buildMenu() {
        this.menu.removeAll();

        const mainVerticalBox = new St.BoxLayout({
            vertical: true,
            width: 420,
            height: 420,
            style_class: 'aio-clipboard-container'
        });
        this.menu.box.add_child(mainVerticalBox);

        this._mainTabBar = new St.BoxLayout();
        mainVerticalBox.add_child(this._mainTabBar);

        this._tabContentArea = new St.Bin({
            style_class: 'aio-clipboard-content-area',
            x_expand: true,
            y_expand: true,
            y_align: Clutter.ActorAlign.FILL,
            x_align: Clutter.ActorAlign.FILL
        });
        mainVerticalBox.add_child(this._tabContentArea);

        // Build tab buttons with themed icons
        this._tabDefinitions.forEach(definition => {
            const translatedName = definition.translatedName;

            // Use the helper function to create themed icon
            const iconWidget = createThemedIcon(this._extension.path, definition.icon, 16);

            const button = new St.Button({
                style_class: 'aio-clipboard-tab-button button',
                can_focus: true,
                child: iconWidget,
                x_expand: true,
            });

            button.tooltip_text = translatedName;

            button.connect('clicked', () => this._selectTab(translatedName));
            this._tabButtons[translatedName] = button;
            this._mainTabBar.add_child(button);
        });

        this._mainTabBar.set_reactive(true);
        this._mainTabBar.connect('key-press-event', this._onMainTabBarKeyPress.bind(this));

        // Handle menu open/close events
        this.menu.connect('open-state-changed', (menu, isOpen) => {
            if (isOpen) {
                // If we're opening via a shortcut, do not interfere with the tab selection.
                if (this._isOpeningViaShortcut) {
                    this._isOpeningViaShortcut = false;
                    return;
                }

                // Otherwise, this is a general open (e.g., panel click), so run default logic.
                const rememberLastTab = this._settings.get_boolean('remember-last-tab');
                const enabledTabNames = this._getEnabledTabNames();
                const defaultTab = enabledTabNames[0];
                if (!defaultTab) {
                    return;
                }

                let targetTab = defaultTab;
                if (rememberLastTab && this._lastActiveTabName && enabledTabNames.includes(this._lastActiveTabName)) {
                    targetTab = this._lastActiveTabName;
                }

                // If an explicit tab target was set (e.g., by a specific-tab shortcut), use that.
                GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    if (this.menu.isOpen) {
                        this._selectTab(targetTab);
                    }
                    return GLib.SOURCE_REMOVE;
                });

            } else {
                this._currentTabActor?.onMenuClosed?.();
            }
        });
    }

    /**
     * Sets the visibility of the main tab bar.
     * @param {boolean} isVisible - Whether the tab bar should be visible.
     * @private
     */
    _setMainTabBarVisibility(isVisible) {
        if (this._mainTabBar && this._mainTabBar.visible !== isVisible) {
            this._mainTabBar.visible = isVisible;
        }
    }

    /**
     * Determines if the tab bar should be visible for the given tab.
     * @param {string|null} tabName - The translated tab name.
     * @returns {boolean} Whether the tab bar should be shown.
     * @private
     */
    _shouldShowTabBarForTab(tabName) {
        if (!this._hasMultipleTabs) {
            return false;
        }

        if (!tabName) {
            return true;
        }

        return !this._fullViewTabs.has(tabName);
    }

    /**
     * Returns the list of tab definitions that are currently enabled.
     * Ensures at least one tab remains enabled by re-enabling the default tab if necessary.
     * @returns {Array<object>} Enabled tab definition objects.
     * @private
     */
    _getEnabledTabDefinitions() {
        if (!this._settings) {
            return this._tabDefinitions;
        }

        const enabledDefinitions = this._tabDefinitions.filter(definition => {
            try {
                return this._settings.get_boolean(definition.settingKey);
            } catch (e) {
                return true;
            }
        });

        if (enabledDefinitions.length === 0 && this._tabDefinitions.length > 0) {
            const fallbackDefinition = this._tabDefinitions[0];
            this._settings.set_boolean(fallbackDefinition.settingKey, true);
            return [fallbackDefinition];
        }

        return enabledDefinitions;
    }

    /**
     * Returns the translated names for all enabled tabs.
     * @returns {string[]} Enabled tab names.
     * @private
     */
    _getEnabledTabNames() {
        return this._getEnabledTabDefinitions().map(definition => definition.translatedName);
    }

    /**
     * Determines if a specific tab is currently enabled.
     * @param {string} tabName - The translated tab name.
     * @returns {boolean} Whether the tab is enabled.
     * @private
     */
    _isTabEnabled(tabName) {
        const definition = this._tabDefinitionByTranslatedName.get(tabName);
        if (!definition) {
            return false;
        }

        if (!this._settings) {
            return true;
        }

        try {
            return this._settings.get_boolean(definition.settingKey);
        } catch (e) {
            return true;
        }
    }

    /**
     * Updates button visibility to reflect the current tab enablement state.
     * Ensures the active tab remains valid.
     * @private
     */
    _updateTabButtonsVisibility() {
        if (!this._tabButtons) {
            return;
        }

        const enabledTabNames = this._getEnabledTabNames();
        const enabledTabSet = new Set(enabledTabNames);
        this._hasMultipleTabs = enabledTabNames.length > 1;

        Object.entries(this._tabButtons).forEach(([tabName, button]) => {
            const isEnabled = enabledTabSet.has(tabName);
            button.visible = isEnabled;
            button.reactive = isEnabled;
            button.can_focus = isEnabled;
        });

        if (enabledTabNames.length === 0) {
            return;
        }

        if (!enabledTabSet.has(this._activeTabName)) {
            const fallbackTab = enabledTabNames[0];
            if (fallbackTab) {
                if (this.menu?.isOpen) {
                    this._selectTab(fallbackTab).catch(e => {
                        console.error(`[AIO-Clipboard] Failed to switch to fallback tab '${fallbackTab}': ${e.message}`);
                    });
                } else {
                    if (this._currentTabActor) {
                        this._disconnectTabSignals(this._currentTabActor);
                        this._currentTabActor.destroy();
                        this._currentTabActor = null;
                    }
                    this._tabContentArea?.set_child?.(null);
                }
                this._activeTabName = fallbackTab;
                this._lastActiveTabName = fallbackTab;
                this._setMainTabBarVisibility(this._shouldShowTabBarForTab(this._activeTabName));
            }
        }

        if (!enabledTabSet.has(this._lastActiveTabName)) {
            this._lastActiveTabName = enabledTabNames[0];
        }

        this._setMainTabBarVisibility(this._shouldShowTabBarForTab(this._activeTabName));
    }

    /**
     * Disconnects signals from the previously active tab's content actor.
     * @param {St.Actor} tabActor - The actor of the tab content being deactivated.
     * @private
     */
    _disconnectTabSignals(tabActor) {
        if (!tabActor?.constructor.$gtype) return;

        try {
            if (this._currentTabVisibilitySignalId > 0 && GObject.signal_lookup('set-main-tab-bar-visibility', tabActor.constructor.$gtype)) {
                tabActor.disconnect(this._currentTabVisibilitySignalId);
            }
            if (this._currentTabNavigateSignalId > 0 && GObject.signal_lookup('navigate-to-main-tab', tabActor.constructor.$gtype)) {
                tabActor.disconnect(this._currentTabNavigateSignalId);
            }
        } catch (e) {
            // Errors on disconnect are usually safe to ignore
        } finally {
            this._currentTabVisibilitySignalId = 0;
            this._currentTabNavigateSignalId = 0;
        }
    }

    /**
     * Exposes the current tab enablement state for external checks.
     * @param {string} tabName - The translated tab name.
     * @returns {boolean} Whether the tab is enabled.
     */
    isTabEnabled(tabName) {
        return this._isTabEnabled(tabName);
    }

    /**
     * Selects and loads the specified tab, updating the UI accordingly.
     * @param {string} tabName - The name of the tab to select.
     * @private
     */
    async _selectTab(tabName) {
        if (!this._isTabEnabled(tabName)) {
            const enabledTabNames = this._getEnabledTabNames();
            const fallbackTab = enabledTabNames.find(name => name !== tabName) ?? enabledTabNames[0];
            if (!fallbackTab || fallbackTab === tabName) {
                return;
            }
            return this._selectTab(fallbackTab);
        }

        // Initial Checks and State Setup
        if (this._activeTabName === tabName && this._currentTabActor) {
            // If clicking the same tab, just call its onSelected method.
            this._currentTabActor.onTabSelected?.();
            return;
        }

        // Store references to old state
        const oldActor = this._currentTabActor;

        // Update state
        this._activeTabName = tabName;
        this._lastActiveTabName = tabName;
        const tabId = getTabIdentifier(tabName);
        const shouldShowTabBar = this._shouldShowTabBarForTab(tabName);

        // Visibility Management
        this._setMainTabBarVisibility(shouldShowTabBar);

        // Asynchronous Content Loading
        if (this._loadingIndicatorTimeoutId) {
            GLib.source_remove(this._loadingIndicatorTimeoutId);
            this._loadingIndicatorTimeoutId = 0;
        }

        try {
            this._loadingIndicatorTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
                if (this._tabContentArea) {
                    // Create a Bin container that will expand and hold its space.
                    const loadingContainer = new St.Bin({
                        style_class: 'aio-clipboard-content-area',
                        x_expand: true,
                        y_expand: true,
                        // Center the label inside the expanding container.
                        child: new St.Label({
                            text: _("Loading %s...").format(tabName),
                            x_align: Clutter.ActorAlign.CENTER,
                            y_align: Clutter.ActorAlign.CENTER
                        })
                    });

                    this._tabContentArea.set_child(loadingContainer);
                    this._currentTabActor = loadingContainer;
                    oldActor?.destroy();
                }
                this._loadingIndicatorTimeoutId = 0;
                return GLib.SOURCE_REMOVE;
            });

            // Dynamically import and create the new tab content actor
            let newContentActor;
            // Import paths for tab modules
            if (tabName === _("Recently Used")) {
                const moduleUrl = `file://${this._extension.path}/features/RecentlyUsed/tabRecentlyUsed.js`;
                const tabModule = await import(moduleUrl);
                newContentActor = new tabModule.RecentlyUsedTabContent(this._extension, this._settings, this._clipboardManager);
            } else {
                const moduleUrl = `file://${this._extension.path}/features/${tabId}/tab${tabId}.js`;
                const tabModule = await import(moduleUrl);
                const className = `${tabId}TabContent`;

                if (!tabModule[className]) {
                    throw new Error(`Class '${className}' not found in module: ${moduleUrl}`);
                }

                if (tabName === _("Clipboard")) {
                    newContentActor = new tabModule[className](this._extension, this._settings, this._clipboardManager);
                } else {
                    newContentActor = new tabModule[className](this._extension, this._settings);
                }
            }

            if (this._activeTabName !== tabName) {
                newContentActor?.destroy();
                if (this._loadingIndicatorTimeoutId) {
                    GLib.source_remove(this._loadingIndicatorTimeoutId);
                    this._loadingIndicatorTimeoutId = 0;
                }
                return;
            }

            if (this._loadingIndicatorTimeoutId) {
                GLib.source_remove(this._loadingIndicatorTimeoutId);
                this._loadingIndicatorTimeoutId = 0;
            }

            // Synchronous UI Update
            this._disconnectTabSignals(oldActor);
            this._tabContentArea.set_child(newContentActor);

            // Adjust tab bar visibility based on full-view status
            this._setMainTabBarVisibility(this._shouldShowTabBarForTab(this._activeTabName));

            // Reconnect signals for the new tab actor
            oldActor?.destroy();
            this._currentTabActor = newContentActor;

            // Connect signals to the new actor
            if (newContentActor.constructor.$gtype) {
                if (GObject.signal_lookup('set-main-tab-bar-visibility', newContentActor.constructor.$gtype)) {
                    this._currentTabVisibilitySignalId = newContentActor.connect('set-main-tab-bar-visibility', (actor, isVisible) => {
                        this._setMainTabBarVisibility(isVisible);
                    });
                }
                if (GObject.signal_lookup('navigate-to-main-tab', newContentActor.constructor.$gtype)) {
                    this._currentTabNavigateSignalId = newContentActor.connect('navigate-to-main-tab', (actor, targetTabName) => {
                        if (this._isTabEnabled(targetTabName)) {
                            this._selectTab(targetTabName);
                        }
                    });
                }
            }

            if (this._selectTabTimeoutId) {
                GLib.source_remove(this._selectTabTimeoutId);
            }
            this._selectTabTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT_IDLE, 10, () => {
                this._currentTabActor?.onTabSelected?.();
                this._selectTabTimeoutId = 0;
                return GLib.SOURCE_REMOVE;
            });

        } catch (e) {
            console.error(`[AIO-Clipboard] Failed to load tab '${tabName}': ${e.message}\n${e.stack}`);

            if (this._loadingIndicatorTimeoutId) {
                GLib.source_remove(this._loadingIndicatorTimeoutId);
                this._loadingIndicatorTimeoutId = 0;
            }

            oldActor?.destroy();
            this._setMainTabBarVisibility(this._shouldShowTabBarForTab(this._activeTabName));

            if (this._tabContentArea && this._activeTabName === tabName) {
                const errorLabel = new St.Label({
                    text: `Error loading tab: ${e.message}`,
                    style_class: 'aio-clipboard-error-label',
                    x_align: Clutter.ActorAlign.CENTER,
                    y_align: Clutter.ActorAlign.CENTER,
                    x_expand: true,
                    y_expand: true
                });
                this._tabContentArea.set_child(errorLabel);
                this._currentTabActor = errorLabel;
            }
        }
    }

    /**
     * Handles left/right arrow key navigation within the main tab bar.
     * Prevents focus from moving out of the tab bar when at the edges.
     * @param {Clutter.Actor} actor - The actor receiving the event.
     * @param {Clutter.Event} event - The key press event.
     * @returns {Clutter.EVENT_STOP|Clutter.EVENT_PROPAGATE} Whether to stop or propagate the event.
     * @private
    */
    _onMainTabBarKeyPress(actor, event) {
        const symbol = event.get_key_symbol();
        if (symbol !== Clutter.KEY_Left && symbol !== Clutter.KEY_Right) {
            return Clutter.EVENT_PROPAGATE;
        }

        const buttons = Object.values(this._tabButtons);
        if (buttons.length === 0) {
            return Clutter.EVENT_PROPAGATE;
        }

        const currentFocus = global.stage.get_key_focus();
        const currentIndex = buttons.indexOf(currentFocus);

        if (currentIndex === -1) {
            return Clutter.EVENT_PROPAGATE;
        }

        if (currentIndex === 0 && symbol === Clutter.KEY_Left) {
            return Clutter.EVENT_STOP;
        }

        if (currentIndex === buttons.length - 1 && symbol === Clutter.KEY_Right) {
            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
    }

    /**
     * Opens the menu, respecting the positioning settings for a hidden icon.
     * The 'open-state-changed' signal handler will manage which tab to display.
     */
    openMenu() {
        if (this.menu.isOpen) {
            return;
        }

        // If the menu is hidden, open it manually and position it.
        if (!this.visible) {
            this.menu.open(false); // Open without animation for manual positioning
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                if (this.menu.actor) {
                    positionMenu(this.menu.actor, this._settings);
                }
                return GLib.SOURCE_REMOVE;
            });
        } else {
            this.menu.open();
        }
    }

    /**
     * Toggles the menu's visibility. Called by the main toggle shortcut and mouse clicks.
     * This is a general open, so we do not set a specific tab target.
     */
    toggleMenu() {
        if (this.menu.isOpen) {
            this.menu.close();
        } else {
            // Reset the target tab when opening the menu generally.
            this._explicitTabTarget = null;
            this.openMenu();
        }
    }

    /**
     * Opens the menu and ensures a specific tab is selected.
     * Used by the specific-tab keyboard shortcuts.
     * @param {string} tabName - The name of the tab to open.
     */
    async openMenuAndSelectTab(tabName) {
        await this._selectTab(tabName);

        // Tell the 'open-state-changed' handler to not interfere.
        this._isOpeningViaShortcut = true;
        this.openMenu();
    }

    /**
     * Cleans up resources when the indicator is destroyed.
     * @override
     */
    destroy() {
        // Clean up any pending timeouts
        if (this._selectTabTimeoutId) {
            GLib.source_remove(this._selectTabTimeoutId);
            this._selectTabTimeoutId = 0;
        }
        if (this._loadingIndicatorTimeoutId) {
            GLib.source_remove(this._loadingIndicatorTimeoutId);
            this._loadingIndicatorTimeoutId = 0;
        }
        if (this._currentTabActor) {
            this._disconnectTabSignals(this._currentTabActor);
        }
        this._currentTabActor?.destroy();
        this._currentTabActor = null;

        if (this._settings && Array.isArray(this._tabSettingsSignalIds)) {
            this._tabSettingsSignalIds.forEach(signalId => {
                if (signalId > 0) {
                    this._settings.disconnect(signalId);
                }
            });
            this._tabSettingsSignalIds = [];
        }

        this._tabButtons = null;
        this._mainTabBar = null;
        this._tabContentArea = null;
        this._settings = null;
        this._extension = null;

        super.destroy();
    }
});

/**
 * The main extension class, responsible for the enable/disable lifecycle.
 */
export default class AllInOneClipboardExtension extends Extension {
    constructor(metadata) {
        super(metadata);
        this._indicator = null;
        this._settings = null;
        this._clipboardManager = null;
        this._settingsSignalIds = [];
    }

    /**
     * Updates the visibility of the panel indicator based on user settings.
     * @private
     */
    _updateIndicatorVisibility() {
        if (!this._indicator) {
            return; // Safety check
        }
        const hide = this._settings.get_boolean('hide-panel-icon');
        this._indicator.visible = !hide;
    }

    /**
     * Handles the signal for the 'clear-recents-trigger' GSettings key.
     * Deletes the appropriate recent items cache file based on the key's value.
     * @private
     */
    _onClearRecentsTrigger() {
        const trigger = this._settings.get_string('clear-recents-trigger');

        // Ignore if the trigger is empty (which happens when we reset it)
        if (trigger === '') {
            return;
        }

        const RECENT_FILES_MAP = {
            'emoji': 'recent_emojis.json',
            'gif': 'recent_gifs.json',
            'kaomoji': 'recent_kaomojis.json',
            'symbols': 'recent_symbols.json'
        };

        if (trigger === 'all') {
            // Delete all known recent files
            for (const filename of Object.values(RECENT_FILES_MAP)) {
                this._clearRecentFile(filename);
            }
        } else if (RECENT_FILES_MAP[trigger]) {
            // Delete a specific recent file
            this._clearRecentFile(RECENT_FILES_MAP[trigger]);
        } else if (trigger === 'clipboard-history' && this._clipboardManager) {
            this._clipboardManager.clearHistory();
        } else if (trigger === 'clipboard-pinned' && this._clipboardManager) {
            this._clipboardManager.clearPinned();
        } else if (trigger === 'gif-cache') {
            getGifCacheManager().clearCache();
        }

        // Reset the trigger back to empty so it can be used again.
        this._settings.set_string('clear-recents-trigger', '');
    }

    /**
     * Clears a specified recent items file by overwriting it with an empty array.
     * This avoids race conditions that can occur with file deletion.
     * @param {string} filename - The name of the file to clear.
     * @private
     */
    _clearRecentFile(filename) {
        try {
            const cacheDir = GLib.build_filenamev([GLib.get_user_cache_dir(), this.uuid]);
            const filePath = GLib.build_filenamev([cacheDir, filename]);
            const file = Gio.File.new_for_path(filePath);

            const emptyContent = new GLib.Bytes(new TextEncoder().encode('[]'));

            // Asynchronously replace the file's contents. This is a fire-and-forget operation.
            file.replace_contents_bytes_async(
                emptyContent,
                null, // etag
                false, // make_backup
                Gio.FileCreateFlags.REPLACE_DESTINATION | Gio.FileCreateFlags.PRIVATE,
                null, // cancellable
                (source, res) => {
                    try {
                        // Finalize the async operation.
                        source.replace_contents_finish(res);
                    } catch (e) {
                        // Safely ignore NOT_FOUND errors, as the desired state is the same.
                        if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)) {
                            console.warn(`[AIO-Clipboard] Could not clear recent file '${filename}': ${e.message}`);
                        }
                    }
                }
            );
        } catch (e) {
            // Handles synchronous errors like invalid paths.
            console.error(`[AIO-Clipboard] Failed to initiate clearing of recent file '${filename}': ${e.message}`);
        }
    }

    /**
     * Enables the extension, initializing settings, clipboard manager, and UI components.
     * Also binds keyboard shortcuts for quick access.
     * @async
     */
    async enable() {
        // Initialize translations
        this.initTranslations('all-in-one-clipboard');
        Gettext.bindtextdomain('all-in-one-clipboard-content', this.dir.get_child('locale').get_path());

        // Load settings
        this._settings = this.getSettings();

        // Initialize singleton managers
        getGifCacheManager(this.uuid, this._settings).runCleanupImmediately();
        getAutoPaster();

        this._settingsSignalIds = [];

        try {
            this._clipboardManager = new ClipboardManager(this.uuid, this._settings);
        } catch (e) {
            console.error('[AIO-Clipboard] FATAL: FAILED to initialize ClipboardManager:', e);
            return;
        }

        const isLoadSuccessful = await this._clipboardManager.loadAndPrepare();

        // Clear data at login if the setting is enabled
        if (this._settings.get_boolean('clear-data-at-login')) {
            // Clear Clipboard History if enabled
            if (this._settings.get_boolean('clear-clipboard-history-at-login')) {
                this._clipboardManager.clearHistory();
            }

            // Define and clear all other recent item types if enabled
            const recentsToClear = [
                { setting: 'clear-recent-emojis-at-login', file: 'recent_emojis.json' },
                { setting: 'clear-recent-gifs-at-login', file: 'recent_gifs.json' },
                { setting: 'clear-recent-kaomojis-at-login', file: 'recent_kaomojis.json' },
                { setting: 'clear-recent-symbols-at-login', file: 'recent_symbols.json' },
            ];

            for (const item of recentsToClear) {
                if (this._settings.get_boolean(item.setting)) {
                    // Clear the recent items file
                    this._clearRecentFile(item.file);
                }
            }
        }

        // Run garbage collection if the clipboard data loaded successfully
        if (isLoadSuccessful) {
            this._clipboardManager.runGarbageCollection();
        }

        // Start auto-paste functionality
        this._indicator = new AllInOneClipboardIndicator(this._settings, this, this._clipboardManager);
        Main.panel.addToStatusArea(this.uuid, this._indicator, 1);

        this._updateIndicatorVisibility();

        this._settingsSignalIds.push(
            this._settings.connect('changed::hide-panel-icon', () => this._updateIndicatorVisibility())
        );

        this._settingsSignalIds.push(
            this._settings.connect('changed::clear-recents-trigger', () => this._onClearRecentsTrigger())
        );

        this._bindKeyboardShortcuts();
    }

    /**
     * Binds keyboard shortcuts defined in the settings to their respective actions.
     * @private
     */
    _bindKeyboardShortcuts() {
        this._shortcutIds = [];

        // Main toggle shortcut simply calls the toggle method.
        this._addKeybinding('shortcut-toggle-main', async () => {
            await this._indicator.toggleMenu();
        });

        const tabMap = {
            'shortcut-open-clipboard': _("Clipboard"),
            'shortcut-open-emoji': _("Emoji"),
            'shortcut-open-gif': _("GIF"),
            'shortcut-open-kaomoji': _("Kaomoji"),
            'shortcut-open-symbols': _("Symbols")
        };

        Object.entries(tabMap).forEach(([shortcutKey, tabName]) => {
            this._addKeybinding(shortcutKey, async () => {
                if (!this._indicator?.isTabEnabled(tabName)) {
                    return;
                }

                if (this._indicator.menu.isOpen) {
                    // If the menu is already open, just switch tabs.
                    await this._indicator._selectTab(tabName);
                } else {
                    // If the menu is closed, open it and select the tab.
                    await this._indicator.openMenuAndSelectTab(tabName);
                }
            });
        });
    }

    /**
     * Helper to add a keybinding and track its ID for later removal.
     * @param {string} name - The name of the keybinding.
     * @param {Function} callback - The function to call when the keybinding is activated.
     * @private
     */
    _addKeybinding(name, callback) {
        const ModeType = Shell.hasOwnProperty('ActionMode')
            ? Shell.ActionMode
            : Shell.KeyBindingMode;

        Main.wm.addKeybinding(
            name,
            this._settings,
            Meta.KeyBindingFlags.NONE,
            ModeType.ALL,
            callback
        );

        this._shortcutIds.push(name);
    }

    /**
     * Unbinds all keyboard shortcuts that were previously bound.
     * @private
     */
    _unbindKeyboardShortcuts() {
        if (!this._shortcutIds) {
            return;
        }

        this._shortcutIds.forEach(id => {
            Main.wm.removeKeybinding(id);
        });

        this._shortcutIds = null;
    }

    /**
     * Disables the extension, cleaning up all resources and UI components.
     * @override
     */
    disable() {
        this._unbindKeyboardShortcuts();

        this._settingsSignalIds.forEach(id => {
            if (this._settings) {
                this._settings.disconnect(id);
            }
        });
        this._settingsSignalIds = [];

        // Destroy singleton managers
        destroyAutoPaster();
        destroyGifCacheManager();

        this._indicator?.destroy();
        this._indicator = null;

        this._clipboardManager?.destroy();
        this._clipboardManager = null;

        this._settings = null;
    }
}
