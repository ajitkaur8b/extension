(function () {
    try {

        /* --------------------------------------------------
           GLOBAL LOAD GUARD
        -------------------------------------------------- */
        if (window.__MODAL_FLOW_LOADED__) return;
        window.__MODAL_FLOW_LOADED__ = true;

        /* --------------------------------------------------
           SAFE SCRIPT DETECTION
        -------------------------------------------------- */
        const scripts = document.getElementsByTagName('script');
        const currentScript =
            document.currentScript ||
            scripts[scripts.length - 1];

        if (!currentScript) return;

        /* --------------------------------------------------
           READ CONFIG
        -------------------------------------------------- */
        const projectToken = currentScript.getAttribute('data-token') || '';
        const autoStart = currentScript.getAttribute('data-auto-start') === 'true';
        const flowId = currentScript.getAttribute('data-flow-id') || '';
        const envKey = currentScript.getAttribute('data-env-key') || '';
        const userId = currentScript.getAttribute('data-user-id') || '';
        const userName = currentScript.getAttribute('data-user-name') || '';
        const userEmail = currentScript.getAttribute('data-user-email') || '';
        const refKey =
            currentScript.getAttribute('data-refkey') ||
            currentScript.getAttribute('data-ref-key') ||
            '';

        /* --------------------------------------------------
           BASE PATH (DYNAMIC)
        -------------------------------------------------- */
        const BASE_URL = new URL('.', currentScript.src).href;

        let initializedViaDataAttributes = false;

        /* --------------------------------------------------
           SAFE NAMESPACE (NO window.modal COLLISION)
        -------------------------------------------------- */
        const NAMESPACE = '__ModalFlowSDK__';
        window[NAMESPACE] = window[NAMESPACE] || {};

        const MF = window[NAMESPACE];

        /* --------------------------------------------------
           REF KEY AUTH MODULE
        -------------------------------------------------- */
        const RefKeyAuth = {
            validated: false,
            validating: false,
            pendingCallbacks: [],

            getRefKey() {
                if (refKey) return refKey;

                const lockoutElement = document.querySelector('#mflows-lockout');
                if (lockoutElement && lockoutElement.hasAttribute('data-ark')) {
                    return lockoutElement.getAttribute('data-ark');
                }
                return '';
            },

            hasRefKey() {
                return !!this.getRefKey();
            },

            validate(callback) {
                try {
                    const key = this.getRefKey();
                    if (!key) return callback(false);

                    if (this.validated) return callback(true);

                    if (this.validating) {
                        this.pendingCallbacks.push(callback);
                        return;
                    }

                    this.validating = true;

                    fetch(
                        'https://auth.locationapi.co/resources1?k=' +
                        key +
                        '&v=' +
                        Date.now()
                    )
                        .then(res => res.json())
                        .then(result => {
                            this.validated = !!result.e;
                            this.validating = false;

                            callback(this.validated);

                            while (this.pendingCallbacks.length) {
                                this.pendingCallbacks.shift()(this.validated);
                            }
                        })
                        .catch(() => {
                            this.validated = false;
                            this.validating = false;
                            callback(false);
                        });
                } catch (e) {
                    console.error('[ModalFlow]', e);
                    callback(false);
                }
            }
        };

        /* --------------------------------------------------
           LOADER OBJECT
        -------------------------------------------------- */
        MF.queue = [];
        MF._loaded = false;
        MF._sdkReady = false;
        MF._refKeyValidated = false;

        MF.init = function () {
            if (!initializedViaDataAttributes) return MF;
            if (!RefKeyAuth.hasRefKey() || !MF._refKeyValidated) return MF;

            loadRuntime();
            return MF;
        };

        MF.identify = function (userId, traits) {
            if (!initializedViaDataAttributes) return MF;
            if (!MF._refKeyValidated) return MF;

            MF.queue.push(['identify', [userId, traits]]);
            return MF;
        };

        MF.start = function (flowId, refKey, data) {
            if (!initializedViaDataAttributes) return MF;
            if (!MF._refKeyValidated) return MF;

            MF.queue.push(['start', [flowId, refKey, data]]);
            loadRuntime();
            return MF;
        };

        MF.end = function () {
            MF.queue.push(['end', []]);
            return MF;
        };

        MF.initModalFlow = function (flowId, refKey) {
            if (!initializedViaDataAttributes) return MF;
            if (!MF._refKeyValidated) return MF;

            MF.queue.push(['initModalFlow', [flowId, refKey]]);
            loadRuntime();
            return MF;
        };

        /* --------------------------------------------------
           RUNTIME LOADER (SAFE + DYNAMIC)
        -------------------------------------------------- */
        function loadRuntime() {
            if (MF._loaded) return;

            if (document.getElementById('mf-runtime-js')) {
                MF._loaded = true;
                return;
            }

            MF._loaded = true;

            const s = document.createElement('script');
            s.id = 'mf-runtime-js';
            s.async = true;
            s.src = 'https://hlptflowbuilder.s3.us-east-1.amazonaws.com/mf-runtime.js';

            s.onload = function () {
                MF._sdkReady = true;
            };

            s.onerror = function () {
                console.error('[ModalFlow] Failed to load runtime');
            };

            document.head.appendChild(s);
        }

        /* --------------------------------------------------
           SDK READY WAIT (WITH TIMEOUT)
        -------------------------------------------------- */
        function waitForSDKReady(callback, timeout = 10000) {
            const start = Date.now();

            function check() {
                if (MF._sdkReady) {
                    callback();
                } else if (Date.now() - start > timeout) {
                    console.error('[ModalFlow] SDK load timeout');
                } else {
                    setTimeout(check, 100);
                }
            }

            check();
        }

        /* --------------------------------------------------
           AUTO INIT
        -------------------------------------------------- */
        function initAuto() {
            if (!flowId && !envKey) return;
            if (!RefKeyAuth.hasRefKey()) return;

            RefKeyAuth.validate((isValid) => {
                if (!isValid) return;

                MF._refKeyValidated = true;
                initializedViaDataAttributes = true;

                MF.init();

                if (userId) {
                    const traits = {};
                    if (userName) traits.name = userName;
                    if (userEmail) traits.email = userEmail;

                    MF.identify(userId, traits);
                }

                waitForSDKReady(() => {
                    if (envKey) window.__modalFlowEnvKey = envKey;

                    MF.initModalFlow(flowId, refKey);

                    if (autoStart) {
                        setTimeout(() => {
                            MF.start(flowId, refKey);
                        }, 1000);
                    }
                });
            });
        }

        /* --------------------------------------------------
           SPA ROUTE DETECTION
        -------------------------------------------------- */
        let lastUrl = location.href;

        setInterval(() => {
            if (location.href !== lastUrl) {
                lastUrl = location.href;

                if (MF._sdkReady && flowId) {
                    MF.initModalFlow(flowId, refKey);
                }
            }
        }, 500);

        /* --------------------------------------------------
           INIT ON DOM READY
        -------------------------------------------------- */
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', initAuto);
        } else {
            initAuto();
        }

        /* --------------------------------------------------
           PUBLIC HELPER
        -------------------------------------------------- */
        window.ModalFlow = {
            startFlow: function (flowId, data = {}) {
                MF.start(flowId, refKey, data);
            },
            endFlow: function () {
                MF.end();
            },
            identify: function (userId, traits = {}) {
                MF.identify(userId, traits);
            },
            validateRefKey: function (cb) {
                RefKeyAuth.validate(cb);
            }
        };

    } catch (err) {
        console.error('[ModalFlow SDK Fatal Error]', err);
    }
})();
