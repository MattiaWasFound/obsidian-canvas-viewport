import { Plugin, TFile, View, WorkspaceLeaf, Notice, Platform, PluginSettingTab, Setting, App } from 'obsidian';

interface CameraPosition {
    tx: number;
    ty: number;
    tZoom: number;
}

interface CanvasViewportSettings {
    debugMode: boolean;
    useGlobalViewport: boolean;
}

const DEFAULT_SETTINGS: CanvasViewportSettings = {
    debugMode: false,
    useGlobalViewport: false,
};

// The Canvas API is internal/undocumented, so we describe just the bits we rely on.
interface Canvas {
    tx: number;
    ty: number;
    tZoom: number;
    markViewportChanged: () => void;
    requestFrame: () => void;
}

interface CanvasView extends View {
    canvas?: Canvas;
    file: TFile | null;
}

// Number of attempts (and delay between them) used while waiting for a freshly
// opened canvas to finish initializing before we touch its viewport.
const CANVAS_READY_RETRIES = 20;
const CANVAS_READY_DELAY = 50;

export default class CanvasViewportPlugin extends Plugin {
    // Tracks which canvas files are already open so we can tell a genuine
    // "open" apart from the file-open events Canvas fires during edits.
    private openCanvasFiles = new Set<string>();
    private currentDevice = '';
    settings: CanvasViewportSettings;

    // Custom logging function
    private log(...args: any[]) {
        if (this.settings.debugMode) {
            console.log(...args);
        }
    }

    private logGroup(name: string) {
        if (this.settings.debugMode) {
            console.group(name);
        }
    }

    private logGroupEnd() {
        if (this.settings.debugMode) {
            console.groupEnd();
        }
    }

    async onload() {
        await this.loadSettings();
        this.addSettingTab(new CanvasViewportSettingTab(this.app, this));

        this.currentDevice = this.getDeviceIdentifier();

        this.addCommand({
            id: 'save-canvas-viewport',
            name: 'Save current viewport',
            checkCallback: (checking) => {
                const view = this.getActiveCanvasView();
                if (!view) {
                    if (!checking) new Notice('Please open a canvas first');
                    return false;
                }
                if (!checking) this.saveCurrentPosition(view);
                return true;
            }
        });

        this.addCommand({
            id: 'restore-canvas-viewport',
            name: 'Restore saved viewport',
            checkCallback: (checking) => {
                const view = this.getActiveCanvasView();
                if (!view || !view.file) {
                    if (!checking) new Notice('Please open a canvas first');
                    return false;
                }
                if (!checking) this.restoreViewport(view.file);
                return true;
            }
        });

        this.addCommand({
            id: 'delete-canvas-viewport',
            name: 'Delete saved viewport',
            checkCallback: (checking) => {
                const view = this.getActiveCanvasView();
                if (!view) {
                    if (!checking) new Notice('Please open a canvas first');
                    return false;
                }
                if (!checking) {
                    this.deleteSavedPosition(view).then(deleted => {
                        const key = this.getViewportKey();
                        if (deleted) {
                            this.log(`viewport deleted for device: ${key}`);
                            new Notice(`Canvas viewport deleted for ${key}`);
                        } else {
                            this.log(`No viewport found to delete for device: ${key}`);
                            new Notice('No saved viewport found');
                        }
                    });
                }
                return true;
            }
        });

        // The file-open event is triggered not just when opening files, but also during
        // Canvas operations like copy/paste or deleting elements. These operations appear
        // to cause a reload which fires this event. To prevent unwanted viewport
        // restoration during these operations, we maintain a set of already-open canvas
        // files and only restore the viewport when a canvas is truly being opened for
        // the first time.
        this.registerEvent(
            this.app.workspace.on('file-open', async (file) => {
                this.logGroup('Canvas Viewport Plugin - File Open Event');

                const wasAlreadyOpen = file?.extension === 'canvas' && this.openCanvasFiles.has(file.path);
                this.log('File path:', file?.path);
                this.log('File type:', file?.extension);
                this.log('Was already open:', wasAlreadyOpen);

                this.refreshOpenCanvasFiles();
                this.log('Currently open canvas files:', [...this.openCanvasFiles]);

                if (!file || file.extension !== 'canvas' || wasAlreadyOpen) {
                    this.log('Skipping viewport restoration');
                    this.logGroupEnd();
                    return;
                }

                this.log('Proceeding with viewport restoration');
                // Auto-restore on open should be quiet: no notices when there is
                // nothing saved or when it succeeds.
                await this.restoreViewport(file, true);
                this.logGroupEnd();
            })
        );
    }

    private refreshOpenCanvasFiles() {
        this.openCanvasFiles = new Set(
            this.getCanvasLeaves()
                .map(leaf => (leaf.view as CanvasView).file?.path)
                .filter((path): path is string => typeof path === 'string')
        );
    }

    private getCanvasLeaves(): WorkspaceLeaf[] {
        return this.app.workspace.getLeavesOfType('canvas');
    }

    // Finds the canvas view backing a specific file. This is the key to
    // supporting multiple open canvases: we must operate on the leaf that owns
    // the file, not simply the first canvas leaf in the workspace.
    private getCanvasViewForFile(file: TFile): CanvasView | null {
        const leaf = this.getCanvasLeaves()
            .find(leaf => (leaf.view as CanvasView).file?.path === file.path);
        return (leaf?.view as CanvasView) ?? null;
    }

    // Resolves the canvas the user is currently interacting with, preferring the
    // active file and falling back to the only/most recent canvas leaf.
    private getActiveCanvasView(): CanvasView | null {
        const activeFile = this.app.workspace.getActiveFile();
        if (activeFile?.extension === 'canvas') {
            const view = this.getCanvasViewForFile(activeFile);
            if (view) return view;
        }

        const leaves = this.getCanvasLeaves();
        return leaves.length ? (leaves[0].view as CanvasView) : null;
    }

    private getViewportKey(): string {
        return this.settings.useGlobalViewport ? 'global' : this.currentDevice;
    }

    private getDeviceIdentifier(): string {
        this.logGroup('Canvas Viewport Plugin - Device Detection');

        let deviceType = "Unknown";

        if (Platform.isMacOS) {
            deviceType = "MacOS";
        } else if (Platform.isWin) {
            deviceType = "Windows";
        } else if (Platform.isLinux) {
            deviceType = "Linux";
        }

        if (Platform.isMobile) {
            if (Platform.isPhone) {
                deviceType += "_Phone";
            } else if (Platform.isTablet) {
                deviceType += "_Tablet";
            }

            if (Platform.isIosApp) {
                deviceType = "iOS_" + deviceType;
            } else if (Platform.isAndroidApp) {
                deviceType = "Android_" + deviceType;
            }
        } else if (Platform.isDesktopApp) {
            deviceType += "_Desktop";
        }

        const resolution = `${window.screen.width}x${window.screen.height}`;
        const pixelRatio = window.devicePixelRatio;

        const deviceId = `${deviceType}_${resolution}@${pixelRatio}x`;
        this.log('Final device identifier:', deviceId);

        this.logGroupEnd();
        return deviceId;
    }

    // Waits for the canvas that owns `file` to finish initializing. A freshly
    // opened canvas may not have its viewport fields ready on the first frame.
    private async waitForCanvas(file: TFile): Promise<Canvas | null> {
        for (let attempt = 0; attempt < CANVAS_READY_RETRIES; attempt++) {
            const canvas = this.getCanvasViewForFile(file)?.canvas;
            if (canvas && typeof canvas.tZoom === 'number') {
                return canvas;
            }
            await sleep(CANVAS_READY_DELAY);
        }
        return null;
    }

    private async restoreViewport(file: TFile, silent = false) {
        this.logGroup('Canvas Viewport Plugin - Restore Viewport');

        const position = await this.loadSavedPosition(file);
        if (!position) {
            this.log('No saved viewport found');
            if (!silent) new Notice('No saved viewport found');
            this.logGroupEnd();
            return;
        }

        this.log('Loaded position:', position);

        const canvas = await this.waitForCanvas(file);
        if (!canvas) {
            this.log('Canvas not found or not initialized for file:', file.path);
            if (!silent) new Notice('Failed to restore viewport');
            this.logGroupEnd();
            return;
        }

        this.log('Current Position:', canvas.tx, canvas.ty, 'zoom', canvas.tZoom);
        this.log('Target Position', position);

        try {
            // Apply on the next frame so the canvas' own layout pass has settled.
            requestAnimationFrame(() => {
                this.applyViewport(canvas, position);
                this.log('Viewport changes applied successfully');
                if (!silent) new Notice('Canvas viewport restored');
            });
        } catch (error) {
            console.error('Failed to restore viewport:', error);
            if (!silent) new Notice('Failed to restore viewport');
        }

        this.logGroupEnd();
    }

    // Restores the viewport by writing the target transform fields directly. We
    // save tx/ty/tZoom, so restoring them 1:1 guarantees a clean round-trip --
    // unlike panTo, which centers on a point rather than setting the translation.
    // markViewportChanged + requestFrame wakes the render loop, which animates the
    // canvas from its current position to these targets.
    private applyViewport(canvas: Canvas, position: CameraPosition) {
        canvas.tx = position.tx;
        canvas.ty = position.ty;
        canvas.tZoom = position.tZoom;
        canvas.markViewportChanged();
        canvas.requestFrame();
    }

    private async saveCurrentPosition(view: CanvasView) {
        this.logGroup('Canvas Viewport Plugin - Save Position');

        if (!view?.file || !view?.canvas) {
            this.log('Invalid view or canvas');
            this.logGroupEnd();
            return;
        }

        const position: CameraPosition = {
            tx: view.canvas.tx,
            ty: view.canvas.ty,
            tZoom: view.canvas.tZoom
        };
        const viewportKey = this.getViewportKey();

        try {
            await this.updateCanvasData(view.file, (canvasData) => {
                if (!canvasData.viewports) {
                    this.log('Initializing viewports object');
                    canvasData.viewports = {};
                }
                canvasData.viewports[viewportKey] = position;
            });

            this.log('Saved position for:', viewportKey, position);
            new Notice('Canvas viewport saved');
        } catch (error) {
            console.error('Failed to save canvas viewport:', error);
            new Notice('Failed to save viewport');
        }

        this.logGroupEnd();
    }

    private async deleteSavedPosition(view: CanvasView): Promise<boolean> {
        this.logGroup('Canvas Viewport Plugin - Delete Position');

        if (!view?.file) {
            this.log('Invalid view');
            this.logGroupEnd();
            return false;
        }

        const viewportKey = this.getViewportKey();

        try {
            let deleted = false;
            await this.updateCanvasData(view.file, (canvasData) => {
                if (!canvasData.viewports?.[viewportKey]) {
                    this.log('No viewport found for:', viewportKey);
                    return false; // abort write
                }

                this.log('Deleting viewport for:', viewportKey);
                delete canvasData.viewports[viewportKey];

                if (Object.keys(canvasData.viewports).length === 0) {
                    this.log('Removing empty viewports object');
                    delete canvasData.viewports;
                }
                deleted = true;
            });

            this.logGroupEnd();
            return deleted;
        } catch (error) {
            console.error('Failed to delete canvas viewport:', error);
            this.logGroupEnd();
            return false;
        }
    }

    private async loadSavedPosition(file: TFile): Promise<CameraPosition | null> {
        this.logGroup('Canvas Viewport Plugin - Load Position');

        try {
            const content = await this.app.vault.read(file);
            const canvasData = this.parseCanvas(content);
            const viewportKey = this.getViewportKey();
            const position = canvasData.viewports?.[viewportKey] ?? null;

            this.log('Loading position for:', viewportKey);
            this.log('Found position:', position);

            this.logGroupEnd();
            return position;
        } catch (error) {
            console.error('Failed to load canvas viewport:', error);
            this.logGroupEnd();
            return null;
        }
    }

    private parseCanvas(content: string): any {
        // Obsidian writes an empty file for a brand new canvas; treat it as {}.
        const trimmed = content.trim();
        return trimmed.length ? JSON.parse(trimmed) : {};
    }

    // Atomically reads, mutates, and writes a canvas file using Vault.process so
    // we never clobber concurrent edits. If `mutate` returns false the write is
    // skipped (used to avoid rewriting a file when there is nothing to delete).
    private async updateCanvasData(file: TFile, mutate: (data: any) => boolean | void): Promise<void> {
        await this.app.vault.process(file, (content) => {
            const canvasData = this.parseCanvas(content);
            const result = mutate(canvasData);
            if (result === false) {
                return content; // no change
            }
            return JSON.stringify(canvasData, null, 2);
        });
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    onunload() {
        this.log('Canvas Viewport Plugin - Unloading');
        this.openCanvasFiles.clear();
    }
}

class CanvasViewportSettingTab extends PluginSettingTab {
    plugin: CanvasViewportPlugin;

    constructor(app: App, plugin: CanvasViewportPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;

        containerEl.empty();

        new Setting(containerEl)
            .setName('Debug mode')
            .setDesc('Enable debug logging in the console')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.debugMode)
                .onChange(async (value) => {
                    this.plugin.settings.debugMode = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Global viewport')
            .setDesc('Use the same viewport across all devices')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.useGlobalViewport)
                .onChange(async (value) => {
                    this.plugin.settings.useGlobalViewport = value;
                    await this.plugin.saveSettings();
                }));
    }
}
