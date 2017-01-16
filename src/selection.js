import log from './utils/log';
import Texture from './gl/texture';
import WorkerBroker from './utils/worker_broker';

export default class FeatureSelection {

    constructor(gl, workers, lock_fn) {
        this.gl = gl;
        this.workers = workers; // pool of workers to request feature look-ups from, keyed by id
        this._lock_fn = (typeof lock_fn === 'function') && lock_fn; // indicates if safe to read/write selection buffer this frame
        this.init();
    }

    init() {
        // Selection state tracking
        this.requests = {}; // pending selection requests
        this.states = {};
        this.feature = null; // currently selected feature
        this.read_delay = 0; // delay time from selection render to framebuffer sample, to avoid CPU/GPU sync lock
        this.read_delay_timer = null; // current timer (setTimeout) for delayed selection reads

        this.pixel = new Uint8Array(4);
        this.pixel32 = new Float32Array(this.pixel.buffer);

        // Frame buffer for selection
        // TODO: initiate lazily in case we don't need to do any selection
        this.fbo = this.gl.createFramebuffer();
        this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.fbo);
        this.fbo_size = { width: 256, height: 256 }; // TODO: make configurable / adaptive based on canvas size
        this.fbo_size.aspect = this.fbo_size.width / this.fbo_size.height;

        // Texture for the FBO color attachment
        var fbo_texture = Texture.create( this.gl, 'selection_fbo', { filtering: 'nearest' });
        fbo_texture.setData(this.fbo_size.width, this.fbo_size.height, null, { filtering: 'nearest' });
        this.gl.framebufferTexture2D(this.gl.FRAMEBUFFER, this.gl.COLOR_ATTACHMENT0, this.gl.TEXTURE_2D, fbo_texture.texture, 0);

        // Renderbuffer for the FBO depth attachment
        var fbo_depth_rb = this.gl.createRenderbuffer();
        this.gl.bindRenderbuffer(this.gl.RENDERBUFFER, fbo_depth_rb);
        this.gl.renderbufferStorage(this.gl.RENDERBUFFER, this.gl.DEPTH_COMPONENT16, this.fbo_size.width, this.fbo_size.height);
        this.gl.framebufferRenderbuffer(this.gl.FRAMEBUFFER, this.gl.DEPTH_ATTACHMENT, this.gl.RENDERBUFFER, fbo_depth_rb);

        this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
    }

    destroy() {
        if (this.gl && this.fbo) {
            this.gl.deleteFramebuffer(this.fbo);
            this.fbo = null;
            this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
        }

        // TODO: free texture?
    }

    // external lock function determines when it's safe to read/write from selection buffer
    get locked () {
        return (this._lock_fn && this._lock_fn()) || false;
    }

    bind() {
        // Switch to FBO
        this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.fbo);
        this.gl.viewport(0, 0, this.fbo_size.width, this.fbo_size.height);
    }

    // Request feature selection
    // Runs asynchronously, schedules selection buffer to be updated
    getFeatureAt(point, state) {
        return new Promise((resolve, reject) => {
            // Queue requests for feature selection, and they will be picked up by the render loop
            this.selection_request_id = (this.selection_request_id + 1) || 0;
            this.requests[this.selection_request_id] = {
                id: this.selection_request_id,
                point,
                state,
                resolve,
                reject
            };
        }).then(selection => {
            if (state) {
                this.states[state] = selection;
            }
            return selection;
        });
    }

    // Any pending selection requests
    pendingRequests() {
        return Object.keys(this.requests).length && this.requests;
    }

    clearPendingRequests() {
        for (var r in this.requests) {
            var request = this.requests[r];

            // This request was already sent to the worker, we're just awaiting its reply
            if (request.sent) {
                continue;
            }

            // Reject request since it will never be fulfilled
            // TODO: pass a reason for rejection?
            request.reject({ request });
            delete this.requests[r];
        }
    }

    // Read pending results from the selection buffer. Called after rendering to selection buffer.
    read() {
        // Delay reading the pixel result from the selection buffer to avoid CPU/GPU sync lock.
        // Calling readPixels synchronously caused a massive performance hit, presumably since it
        // forced this function to wait for the GPU to finish rendering and retrieve the texture contents.
        if (this.read_delay_timer != null) {
            clearTimeout(this.read_delay_timer);
        }
        this.read_delay_timer = setTimeout(() => {
            if (this.locked) {
                return;
            }

            var gl = this.gl;

            gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);

            for (var r in this.requests) {
                var request = this.requests[r];

                // This request was already sent to the worker, we're just awaiting its reply
                if (request.sent) {
                    continue;
                }

                // Check selection map against FBO
                gl.readPixels(
                    Math.floor(request.point.x * this.fbo_size.width),
                    Math.floor((1 - request.point.y) * this.fbo_size.height),
                    1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this.pixel);
                var feature_key = (this.pixel[0] + (this.pixel[1] << 8) + (this.pixel[2] << 16) + (this.pixel[3] << 24)) >>> 0;
                // use pixel32?

                // If feature found, ask appropriate web worker to lookup feature
                var worker_id = this.pixel[3];
                if (worker_id !== 255) { // 255 indicates an empty selection buffer pixel
                    if (this.workers[worker_id] != null) {
                        WorkerBroker.postMessage(
                            this.workers[worker_id],
                            'self.getFeatureSelection',
                            { id: request.id, key: feature_key })
                        .then(message => {
                            // this.finishRead(Object.assign(message, { selection_color: Array.from(this.pixel) }));
                            this.finishRead(message);
                        });
                    }
                }
                // No feature found, but still need to resolve promise
                else {
                    this.finishRead({ id: request.id });
                }

                request.sent = true;
            }

            gl.bindFramebuffer(gl.FRAMEBUFFER, null);

        }, this.read_delay);
    }

    // Called on main thread when a web worker finds a feature in the selection buffer
    finishRead (message) {
        const request = this.requests[message.id];
        if (!request) {
            log('error', "FeatureSelection.finishRead(): could not find message", message);
            return; // request was cleared before it returned
        }

        const feature = message.feature;
        let changed = false;
        if ((feature != null && this.feature == null) ||
            (feature == null && this.feature != null) ||
            (feature != null && this.feature != null &&
                JSON.stringify(feature) !== JSON.stringify(this.feature))) {
            changed = true;
        }

        this.feature = feature; // store the most recently selected feature

        if (feature) {
            let group = message.group;

            // TODO: we can skip sending a message back to the initial worker we got the feature from
            return WorkerBroker.postMessage(this.workers, 'self.getFeatureSelectionGroupColor', group.key)
                .then(selection_colors => {
                    // Resolve the request
                    request.resolve({
                        feature, changed, request, selection_colors, group
                    });
                    delete this.requests[message.id]; // done processing this request
                });
        }
        else {
            request.resolve({ feature, changed, request, selection_colors: [] });
            delete this.requests[message.id]; // done processing this request
        }
    }

    updateState (state_key) {
        // Only request update:
        // - once at a time for each state
        // - if we don't have colors for this state from all worker threads yet
        let state = this.states[state_key];
        if (!state || !state.group ||
            state.update_pending ||
            state.selection_colors.filter(x => x).length === this.workers.length) {
            return Promise.resolve();
        }
        state.update_pending = true;

        return WorkerBroker.postMessage(this.workers, 'self.getFeatureSelectionGroupColor', state.group.key)
            .then(selection_colors => {
                log('debug', 'Updated selection colors from workers', state_key, selection_colors);
                state.selection_colors = selection_colors;
                state.update_pending = false;
            });
    }

    clearState (state_key) {
        this.states[state_key] = null;
    }

    // Selection map generation
    // Each worker will create its own independent, 'local' selection map

    // Create a unique 32-bit color to identify a feature
    // Workers independently create/modify selection colors in their own threads, but we also
    // need the main thread to know where each feature color originated. To accomplish this,
    // we partition the map by setting the 4th component (alpha channel) to the worker's id.
    static createSelector(tile) {
        // 32-bit color key
        this.map_index++;
        var ir = this.map_index & 255;
        var ig = (this.map_index >> 8) & 255;
        var ib = (this.map_index >> 16) & 255;
        var ia = this.map_prefix;
        var r = ir / 255;
        var g = ig / 255;
        var b = ib / 255;
        var a = ia / 255;
        var key = (ir + (ig << 8) + (ib << 16) + (ia << 24)) >>> 0; // need unsigned right shift to convert to positive #

        this.map[key] = {
            color: [r, g, b, a],
        };
        this.map_size++;

        // Initialize tile-specific tracking info
        if (!this.tiles[tile.key]) {
            this.tiles[tile.key] = {
                entries: [],                        // set of feature entries in this thread
                tile: {                             // subset of tile properties to pass back with feature
                    key: tile.key,
                    coords: tile.coords,
                    style_zoom: tile.style_zoom,
                    source: tile.source,
                    generation: tile.generation
                }
            };
        }

        this.tiles[tile.key].entries.push(key);

        return this.map[key];
    }

    // static makeColor(feature, draw, tile, context) {
    static getSelector(feature, draw, tile, context) {
        let selection_prop = draw.selection_prop;
        let group_value, group_key;
        if (typeof selection_prop === 'function') {
            group_value = selection_prop(context);
        }
        else {
            group_value = feature.properties[selection_prop];
        }
        group_key = draw.selection_group + ':' + group_value;

        let selector = this.createSelector(tile);
        selector.feature = {
            properties: feature.properties,
            source_name: context.source,
            source_layer: context.layer,
            layers: context.layers,
            tile: this.tiles[tile.key].tile,
            hover_color: draw.hover_color,
            click_color: draw.click_color
        };

        let group;
        if (group_value) {
            group = this.groups[group_key];
            if (!group) {
                this.group_index++;
                let r = this.group_index & 255;
                let g = (this.group_index >> 8) & 255;
                let b = (this.group_index >> 16) & 255;
                group = this.groups[group_key] = [r, g, b, 255];
            }
        }

        selector.group = {
            index: group || [255, 255, 255, 255],
            key: group_key,
            value: group_value//,
            // hover_color: draw.hover_color,
            // click_color: draw.click_color
        };

        return selector;
    }

    static reset() {
        this.groups = {};
        this.tiles = {};
        this.map = {};
        this.map_size = 0;
        this.map_index = 0;
    }

    static clearTile(key) {
        // TODO: update this to reference count features so we only delete when all refs released
        // if (this.tiles[key]) {
        //     this.tiles[key].entries.forEach(k => delete this.map[k]);
        //     this.map_size -= this.tiles[key].entries.length;
        //     delete this.tiles[key];
        // }
    }

    static getMapSize() {
        return this.map_size;
    }

    static setPrefix(prefix) {
        this.map_prefix = prefix;
    }

}

// Static properties
FeatureSelection.map = {};   // this will be unique per module instance (so unique per worker)
FeatureSelection.tiles = {}; // selection keys, by tile
FeatureSelection.groups = {};
FeatureSelection.group_index = 0;
FeatureSelection.map_size = 0;
FeatureSelection.map_index = 0;
FeatureSelection.map_prefix = 0; // set by worker to worker id #
FeatureSelection.defaultColor = [0, 0, 0, 1];
