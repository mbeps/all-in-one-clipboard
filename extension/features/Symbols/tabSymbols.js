import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import { CategorizedItemViewer } from '../../utilities/utilityCategorizedItemViewer.js';
import { SymbolsJsonParser } from './parsers/symbolsJsonParser.js';
import { AutoPaster, getAutoPaster } from '../../utilities/utilityAutoPaste.js';

/**
 * A content widget for the "Symbols" tab.
 *
 * This class acts as a controller that configures and manages a
 * `CategorizedItemViewer` component to display and interact with symbols.
 */
export const SymbolsTabContent = GObject.registerClass(
class SymbolsTabContent extends St.Bin {
    constructor(extension, settings) {
        super({
            style_class: 'symbols-tab-content',
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.FILL
        });

        // Store settings for later use
        this._settings = settings;

        const config = {
            jsonPath: 'data/symbols.json',
            parserClass: SymbolsJsonParser,
            recentsFilename: 'recent_symbols.json',
            recentsMaxItemsKey: 'symbols-recents-max-items',
            itemsPerRow: 9,
            categoryPropertyName: 'category',
            enableTabScrolling: true,
            sortCategories: false,
            // Ensure the payload is consistent for both old and new item formats.
            createSignalPayload: itemData => ({
                'symbol': itemData.symbol || itemData.char || itemData.value || '',
                'name': itemData.name || ''
            }),
            searchFilterFn: this._searchFilter.bind(this),
            renderGridItemFn: this._renderGridItem.bind(this),
            renderCategoryButtonFn: this._renderCategoryButton.bind(this),
            showBackButton: false
        };

        this._viewer = new CategorizedItemViewer(extension, settings, config);
        this.set_child(this._viewer);

        // Connect to Viewer Signals
        this._viewer.connect('item-selected', (source, jsonPayload) => {
            this._onItemSelected(jsonPayload, extension);
        });
    }

    /**
     * Handles the 'item-selected' signal from the viewer.
     * Copies the selected symbol string to the clipboard.
     * @param {string} jsonPayload - The JSON string payload from the signal.
     * @param {Extension} extension - The main extension instance.
     * @private
     */
    async _onItemSelected(jsonPayload, extension) {
        try {
            const data = JSON.parse(jsonPayload);
            // Get the symbol string to copy
            const symbolToCopy = data.symbol;
            if (!symbolToCopy) return;

            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, symbolToCopy);

            // Check if auto-paste is enabled
            if (AutoPaster.shouldAutoPaste(this._settings, 'auto-paste-symbols')) {
                await getAutoPaster().trigger();
            }

            extension._indicator.menu?.close();
        } catch (e) {
            console.error('[AIO-Clipboard] Error in symbols item selection:', e);
        }
    }

    // =====================================================================
    // Functions for Viewer Configuration
    // =====================================================================

    /**
     * Search filter function passed to the viewer.
     * @param {object} item - The symbol data object.
     * @param {string} searchText - The user's search text.
     * @returns {boolean} True if the item matches the search.
     * @private
     */
    _searchFilter(item, searchText) {
        // Prepare the user's input once, stripping any prefixes.
        const cleanSearchText = searchText.toLowerCase().replace(/^(u\+|0x)/i, '');

        // Check keywords first if available.
        if (item.keywords && Array.isArray(item.keywords)) {
            // Compare the clean search text against all keywords.
            return item.keywords.some(k => k.toLowerCase().includes(cleanSearchText));
        }

        // Check symbol string and name.
        const symbolString = item.char || item.value || '';
        return symbolString.toLowerCase().includes(cleanSearchText) ||
               (item.name && item.name.toLowerCase().includes(cleanSearchText));
    }

    _renderGridItem(itemData) {
        // Get the symbol string to display
        const displayString = itemData.symbol || itemData.char || itemData.value;
        if (!displayString) return new St.Button();

        const button = new St.Button({
            style_class: 'symbol-grid-button button',
            label: displayString,
            can_focus: true,
            x_expand: false
        });

        // Set tooltip to the name if available, otherwise use the symbol itself.
        button.tooltip_text = itemData.name || displayString;
        return button;
    }

    /**
     * Renders a category tab button, passed to the viewer.
     * @param {string} categoryId - The name of the category.
     * @returns {St.Button} The configured button for the category tab bar.
     * @private
     */
    _renderCategoryButton(categoryId) {
        const button = new St.Button({
            style_class: 'symbol-category-tab-button button',
            can_focus: true,
            label: _(categoryId),
            x_expand: false,
            x_align: Clutter.ActorAlign.START
        });
        button.tooltip_text = _(categoryId);
        return button;
    }

    // =====================================================================
    // Public Methods & Lifecycle
    // =====================================================================

    /**
     * Called by the parent when this tab is selected.
     */
    onTabSelected() {
        this._viewer?.onSelected();
    }

    /**
     * Cleans up resources when the widget is destroyed.
     */
    destroy() {
        this._viewer?.destroy();
        super.destroy();
    }
});
