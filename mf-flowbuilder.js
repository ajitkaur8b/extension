(function () {
    // Guard: ensure we're running in a proper browser window context
    try {
        if (typeof window === 'undefined' || typeof document === 'undefined') return;
    } catch (e) { return; }

    try { if (window.__MODAL_FLOW_LOADED__) { return; } } catch (e) { return; }
    try { window.__MODAL_FLOW_LOADED__ = true; } catch (e) {}

    //let autoStartTriggered = false;
    //let initTriggered = false;
    // Get reference to the current script tag (may be null in some async-loaded contexts)
    var currentScript;
    try { currentScript = document.currentScript; } catch (e) { currentScript = null; }

    // Safe attribute reader
    function getAttr(el, name, fallback) {
        try { return (el && el.getAttribute(name)) || fallback || ''; } catch (e) { return fallback || ''; }
    }

    // Read configuration from script attributes
    const projectToken = getAttr(currentScript, 'data-token');
    const autoStart = getAttr(currentScript, 'data-auto-start') === 'true';
    const flowId = getAttr(currentScript, 'data-flow-id');
    const envKey = getAttr(currentScript, 'data-env-key');
    const userId = getAttr(currentScript, 'data-user-id');
    const userName = getAttr(currentScript, 'data-user-name');
    const userEmail = getAttr(currentScript, 'data-user-email');
    const refKey = getAttr(currentScript, 'data-refkey') || getAttr(currentScript, 'data-ref-key');

    // Flag to track if initialized via data attributes
    let initializedViaDataAttributes = false;

    // Reference Key Authentication Module
    const RefKeyAuth = {
        validated: false,
        validating: false,
        pendingCallbacks: [],

        loadEmbed: function (url, cb) {
            try {
                let xmlhttp = new XMLHttpRequest();
                xmlhttp.onreadystatechange = function () {
                    try {
                        if (xmlhttp.readyState == 4 && xmlhttp.status == 200) {
                            cb(xmlhttp.responseText);
                        } else if (xmlhttp.readyState == 4) {
                            cb(null);
                        }
                    } catch (e) { try { cb(null); } catch (_) {} }
                };
                xmlhttp.open('GET', url, true);
                xmlhttp.send();
            } catch (e) {
                try { cb(null); } catch (_) {}
            }
        },

        getRefKey: function () {
            // First check data-refkey attribute on the script tag
            if (refKey) return refKey;

            // Fallback to #mflows-lockout element - only if DOM is ready
            try {
                if (!document.body) {
                    return '';
                }

                const lockoutElement = document.querySelector('#mflows-lockout');
                if (lockoutElement && lockoutElement.hasAttribute('data-ark')) {
                    return lockoutElement.getAttribute('data-ark');
                }
            } catch (e) {
                return '';
            }

            return '';
        },

        validate: function (callback) {
            var safeCallback = function(result) {
                try { callback(result); } catch (e) {}
            };
            try {
            const key = this.getRefKey();

            if (!key) {
                this.validated = false;
                safeCallback(false);
                return;
            }

            if (this.validated) {
                safeCallback(true);
                return;
            }

            if (this.validating) {
                this.pendingCallbacks.push(safeCallback);
                return;
            }
            this.validating = true;
            this.loadEmbed(
                'https://auth.locationapi.co/resources1?k=' + key + '&v=' + Date.now(),
                (response) => {
                    try {
                        if (!response) {
                            this.validated = false;
                            this.validating = false;
                            safeCallback(false);
                            while (this.pendingCallbacks.length > 0) {
                                const cb = this.pendingCallbacks.shift();
                                try { cb(false); } catch (_) {}
                            }
                            return;
                        }
                        let result = JSON.parse(response);
                        if (result.e) {
                            this.validated = true;
                            this.validating = false;
                            safeCallback(true);
                            while (this.pendingCallbacks.length > 0) {
                                const cb = this.pendingCallbacks.shift();
                                try { cb(true); } catch (_) {}
                            }
                        } else {
                            this.validated = false;
                            this.validating = false;
                            safeCallback(false);
                            while (this.pendingCallbacks.length > 0) {
                                const cb = this.pendingCallbacks.shift();
                                try { cb(false); } catch (_) {}
                            }
                        }
                    } catch (error) {
                        this.validated = false;
                        this.validating = false;
                        safeCallback(false);
                        while (this.pendingCallbacks.length > 0) {
                            const cb = this.pendingCallbacks.shift();
                            try { cb(false); } catch (_) {}
                        }
                    }
                }
            );
            } catch (e) {
                this.validating = false;
                safeCallback(false);
            }
        },

        isRequired: function () {
            return true;
        },

        hasRefKey: function () {
            return !!this.getRefKey();
        }
    };
    window.__modalFlowRefKey = {
        required: true, // ALWAYS REQUIRED
        validated: false,
        key: '',
        hasKey: false
    };
    const updateRefKeyStatus = function () {
        window.__modalFlowRefKey.key = RefKeyAuth.getRefKey();
        window.__modalFlowRefKey.hasKey = RefKeyAuth.hasRefKey();
    };

    function addModalStyles() {
        try {
        if (document.getElementById('modal-flow-styles')) {
            return;
        }

        const styleTag = document.createElement('style');
        styleTag.id = 'modal-flow-styles';
        styleTag.innerHTML = `
        /* Add your custom modal styles here */
        .light {
            --mf-theme-primary: #0d6efd;
            --mf-theme-primary-hover: #0b5ed7;
            --mf-theme-background: #ffffff;
            --mf-theme-background-secondary: #f8f9fa;
            --mf-theme-text-primary: #212529;
            --mf-theme-text-secondary: #667085;
            --mf-theme-border: #eaecf0;
            --mf-theme-border-focus: #528bff;
            --mf-theme-shadow: rgba(0, 0, 0, 0.15);
            --mf-theme-close-hover-bg: rgba(0, 0, 0, 0.08);
        }
        .dark {
            --mf-theme-primary: #0d6efd;
            --mf-theme-primary-hover: #0b5ed7;
            --mf-theme-background: #111111;
            --mf-theme-background-secondary: #353535;
            --mf-theme-text-primary: #e0e0e0;
            --mf-theme-text-secondary: #e0e0e0;
            --mf-theme-border: #666666;
            --mf-theme-border-focus: #528bff;
            --mf-theme-shadow: rgba(0, 0, 0, 0.3);
            --mf-theme-close-hover-bg: #374151;
        }
        .modal-flow-launcher {
          position: fixed;
          bottom: 20px;
          right: 20px;
          z-index: 999999;
        }
        
        .modal-fixed-widget {
          position: fixed !important;
          top: 0 !important;
          left: 0 !important;
          z-index: 999999 !important;
        }
        
        .modal-flow-launcher-attached {
          position: fixed !important;
        }
        
        .modal-flow-hidden {
          display: none !important;
        }
        
        .modal-flow-blocked {
          display: none !important;
        }
        .modal-launcher{position:fixed;z-index:999998;cursor:pointer;left:0;top:0}
          .modal-launcher-button{padding:12px 24px;border-radius:8px;font-family:sans-serif;font-size:14px;font-weight:500;border:none;box-shadow:0 4px 12px rgba(0,0,0,0.15);background:#3b82f6;color:white;}
          .modal-launcher-beacon{width:16px;height:16px;border-radius:9999px;background:#3b82f6;box-shadow:0 0 0 0 rgba(59,130,246,.65);animation:modalPulse 1400ms ease-out infinite;}
          @keyframes modalPulse{0%{box-shadow:0 0 0 0 rgba(59,130,246,.6)}70%{box-shadow:0 0 0 18px rgba(59,130,246,0)}100%{box-shadow:0 0 0 0 rgba(59,130,246,0)}}
          .modal-launcher-icon{width:48px;height:48px;border-radius:50%;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 12px rgba(0,0,0,0.15);background:#3b82f6;color:white;}
          .modal-launcher-icon svg{width:24px;height:24px;fill:currentColor;},
          .modal-launcher-tooltip-overlay{position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.3);z-index:999997;display:flex;align-items:center;justify-content:center;animation:fadeIn 0.2s ease;}
          @keyframes fadeIn{from{opacity:0}to{opacity:1}},
          .modal-launcher-tooltip-modal{position:relative;background:white;border-radius:16px;padding:32px;min-width:300px;max-width:400px;box-shadow:0 20px 25px -5px rgba(0,0,0,0.1), 0 10px 10px -5px rgba(0,0,0,0.04);animation:slideUp 0.3s ease;}
          @keyframes slideUp{from{transform:translateY(20px);opacity:0}to{transform:translateY(0);opacity:1}}
          .modal-launcher-tooltip-header{position:absolute;top:16px;right:16px;display:flex;align-items:center;gap:8px;}
          .modal-launcher-tooltip-badge{font-size:11px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;background:#f3f4f6;padding:4px 8px;border-radius:4px;}
          .modal-launcher-tooltip-close{width:24px;height:24px;display:flex;align-items:center;justify-content:center;cursor:pointer;border:none;background:transparent;color:#9ca3af;border-radius:4px;transition:all 0.2s;}
          .modal-launcher-tooltip-close:hover{background:#f3f4f6;color:#374151;}
          .modal-launcher-tooltip-content{margin-top:8px;font-size:16px;color:#111827;line-height:1.5;min-height:60px;}
          .modal-launcher-tooltip-footer{margin-top:24px;display:flex;justify-content:flex-end;gap:12px;}
          .modal-launcher-tooltip-btn{padding:10px 20px;border-radius:8px;font-size:14px;font-weight:500;cursor:pointer;transition:all 0.2s;border:none;font-family:inherit;}
          .modal-launcher-tooltip-btn-primary{background:rgb(69, 121, 228);color:white;box-shadow:0 1px 2px 0 rgba(0,0,0,0.05);}
          .modal-launcher-tooltip-btn-primary:hover{background:#4338ca;}
          .modal-launcher-tooltip-btn-secondary{background:#f3f4f6;color:#374151;}
          .modal-launcher-tooltip-btn-secondary:hover{background:#e5e7eb;}
      `;

        (document.head || document.documentElement).appendChild(styleTag);
        } catch (e) {} // silently ignore style injection failures
    }
    function loadModalLoader() {
        const w = window, d = document;
        const q = [];

        w.modal = {
            _queue: q,
            _loaded: false,
            _sdkReady: false,
            _token: null,
            _refKeyValidated: false,

            init: function (token) {
                if (this._initialized) return this;
                this._initialized = true;
                if (!initializedViaDataAttributes) {
                    return this;
                }

                this._token = token;
                if (!RefKeyAuth.hasRefKey() || !this._refKeyValidated) {
                    return this;
                }
                this._load();
                return this;
            },

            _load: function () {
                if (this._loaded) {
                    return;
                }
                const existingScript = document.getElementById('mf-runtime-js');
                if (existingScript) {
                    this._loaded = true;
                    return;
                } else {
                    this._loaded = true;
                    const s = d.createElement('script');
                    s.id = 'mf-runtime-js';
                    s.async = true;
                    // s.src = "http://localhost:3000/modal-runtime.js";
                    s.src = 'https://hlptflowbuilder.s3.us-east-1.amazonaws.com/test/mf-runtime.js';
                    s.onload = function () {
                        if (typeof w.modal._onReady === 'function') {
                            // w.modal._onReady();
                        }
                        w.modal._sdkReady = true;
                    };
                    s.onerror = function () {
                        console.error('[ModalFlow] Failed to load runtime from S3');
                    };
                    (d.head || d.documentElement).appendChild(s);
                }

            },

            identify: function (userId, traits) {
                if (!initializedViaDataAttributes) {
                    return this;
                }

                if (!RefKeyAuth.hasRefKey() || !this._refKeyValidated) {
                    return this;
                }

                q.push(['identify', [userId, traits]]);
                return this;
            },

            start: function (flowId, refKey, data) {
                if (!initializedViaDataAttributes) {
                    return this;
                }

                if (!RefKeyAuth.hasRefKey() || !this._refKeyValidated) {
                    return this;
                }

                q.push(['start', [flowId, refKey, data]]);
                if (!this._loaded) {
                    this._load();
                }
                return this;
            },

            end: function () {
                q.push(['end', []]);
                return this;
            },

            initModalFlow: function (flowId, refKey) {
                if (!initializedViaDataAttributes) {
                    return this;
                }

                if (!RefKeyAuth.hasRefKey() || !this._refKeyValidated) {
                    return this;
                }
                q.push(['initModalFlow', [flowId, refKey]]);
                if (!this._loaded) {
                    this._load();
                }
                return this;
            }
        };
    }

    function initModalFlowAuto() {
        // if (initTriggered) return;
        // initTriggered = true;    
        addModalStyles();
        updateRefKeyStatus();
        // if (!projectToken) {
        //   return;
        // }
        if (!flowId && !envKey) {
            return;
        }
        if (!RefKeyAuth.hasRefKey()) {
            return;
        }
        RefKeyAuth.validate((isValid) => {
            if (isValid) {
                window.modal._refKeyValidated = true;
                window.__modalFlowRefKey.validated = true;
                proceedWithInit();
            } else {
                window.__modalFlowRefKey.validated = false;
            }
        });
    }

    function proceedWithInit() {
        initializedViaDataAttributes = true;

        window.modal.init();

        if (userId) {
            const traits = {};
            if (userName) traits.name = userName;
            if (userEmail) traits.email = userEmail;

            window.modal.identify(userId, traits);
        }

        if (flowId) {
            waitForSDKReady(() => {
                if (envKey) {
                    window.__modalFlowEnvKey = envKey;
                }
                window.modal.initModalFlow(flowId, refKey, { envKey: envKey });

                if (autoStart) {
                    //autoStartTriggered = true;
                    setTimeout(() => {
                        window.modal.start(flowId, refKey);
                    }, 1000);
                }
            });
        }
    }

    // Wait for SDK to be fully ready (with timeout to prevent infinite loops)
    function waitForSDKReady(callback) {
        const startTime = Date.now();
        const maxWait = 30000; // 30 second timeout
        const checkReady = function () {
            try {
                if (window.modal && window.modal._sdkReady) {
                    callback();
                } else if (Date.now() - startTime > maxWait) {
                    console.warn('[ModalFlow] waitForSDKReady timed out after 30s');
                } else {
                    setTimeout(checkReady, 100);
                }
            } catch (e) {
                // silently fail
            }
        };
        checkReady();
    }

    // Initialize modal object first (always)
    try { loadModalLoader(); } catch (e) {}
    try { addModalStyles(); } catch (e) {}

    // Then check for auto-initialization
    try {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', function() {
                try { initModalFlowAuto(); } catch (e) {}
            });
        } else {
            try { initModalFlowAuto(); } catch (e) {}
        }
    } catch (e) {}

    // Expose helper functions globally
    try {
    window.ModalFlow = {
        startFlow: function (flowId, data) {
        },

        endFlow: function () {
            try {
                if (window.modal && window.modal.end) {
                    window.modal.end();
                }
            } catch (e) {}
        },

        identify: function (userId, traits) {
        },

        validateRefKey: function (callback) {
            try { RefKeyAuth.validate(callback); } catch (e) { try { callback(false); } catch (_) {} }
        },

        isRefKeyValidated: function () {
            try { return window.__modalFlowRefKey.validated; } catch (e) { return false; }
        },

        hasRefKey: function () {
            try { return window.__modalFlowRefKey.hasKey; } catch (e) { return false; }
        },

        debug: function () {
        }
    };
    } catch (e) {}

})();