(function () {
    if (window.__MODALFLOW_RUNTIME_LOADED__) {
        return;
    }
    window.__MODALFLOW_RUNTIME_LOADED__ = true;
    
    const API_BASE = "https://mfb.modalsupport.com";

    function hexToRgba(hex, alpha) {
        if (!hex || typeof hex !== 'string') return alpha >= 0 && alpha < 1 ? 'rgba(13,110,253,' + alpha + ')' : 'rgba(13,110,253,0.65)';
        hex = hex.replace(/^#/, '');
        if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
        if (hex.length !== 6) return alpha >= 0 && alpha < 1 ? 'rgba(13,110,253,' + alpha + ')' : 'rgba(13,110,253,0.65)';
        var r = parseInt(hex.slice(0, 2), 16);
        var g = parseInt(hex.slice(2, 4), 16);
        var b = parseInt(hex.slice(4, 6), 16);
        return 'rgba(' + r + ',' + g + ',' + b + ',' + (alpha != null && alpha >= 0 && alpha <= 1 ? alpha : 0.65) + ')';
    }

    const hasRefKey = () => window.__modalFlowRefKey?.hasKey || false;
    const isRefKeyValidated = () => window.__modalFlowRefKey?.validated || false;
    const isOperationAllowed = () => {
        if (!hasRefKey()) {
            return false;
        }
        if (!isRefKeyValidated()) {
            return false;
        }
        return true;
    };

    const sdk = window.modal || {};
    const queue = sdk._queue || [];

    if (!window.modal) {
        window.modal = sdk;
        ['init', 'identify', 'start', 'initModalFlow', 'end'].forEach(method => {
            if (!sdk[method]) {
                sdk[method] = function (...args) {
                    sdk._queue = sdk._queue || [];
                    sdk._queue.push([method, args]);
                };
            }
        });
    }

    sdk._flushQueue = function () {
        if (!isOperationAllowed()) {
            sdk._queue = [];
            return;
        }

        const currentQueue = sdk._queue || [];
        sdk._queue = [];

        for (const [cmd, args] of currentQueue) {
            if (typeof sdk['_' + cmd] === 'function') {
                sdk['_' + cmd].apply(sdk, args);
            }
        }
    };

    sdk._init = function (token) {
        if (!isOperationAllowed()) return;

        if (!token) {
            return;
        }
        sdk._token = token;
        sdk._initialized = true;
    };

    sdk._identify = function (userId, traits = {}) {
        if (!isOperationAllowed()) return;
        sdk.user = { id: userId, ...traits };
    };

    function deriveMasterKeyFromEnvKey(envKey) {
        if (typeof envKey !== 'string' || envKey.length <= 3) {
            throw new Error('Invalid env_key');
        }
        return envKey.slice(3);
    }
    sdk._deriveSecret = async function(envKey, refKey, masterSecret) {
        const key = await crypto.subtle.importKey(
            'raw',
            new TextEncoder().encode(masterSecret),
            { name: 'HMAC', hash: 'SHA-256' },
            false,
            ['sign']
        );

        const derived = await crypto.subtle.sign(
            'HMAC',
            key,
            new TextEncoder().encode(`${envKey}:${refKey}`)
        );

        return [...new Uint8Array(derived)]
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
    };

    sdk._signHmac = async function (payload, hexSecret) {
        const key = await crypto.subtle.importKey(
            'raw',
            new TextEncoder().encode(hexSecret),  // Changed: treat as hex string
            { name: 'HMAC', hash: 'SHA-256' },
            false,
            ['sign']
        );

        const sig = await crypto.subtle.sign(
            'HMAC',
            key,
            new TextEncoder().encode(payload)
        );

        return [...new Uint8Array(sig)]
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
    };

    sdk._loadFlowFromApi = async function (flowId, flowVersionId = null, environmentId = null) {
        if (!isOperationAllowed()) {
            return null;
        }

        // Check if flow data is already loaded
        if (sdk._flowObjects && sdk._flowObjects[flowId]) {
            return {
                flowObjects: sdk._flowObjects[flowId],
                flowsetup: sdk._flowsetup[flowId],
                autoStartSettings: sdk._autoStartSettings[flowId],
                setupConfig: sdk._flowsetup[flowId] || {}
            };
        }

        try {
            // Use flowid in URL path and flow_version_id as query parameter only
            // https://mfb.modalsupport.com/getflowdata?flow_version_id&flow_ref&env_ref
            const flowApiUrl = new URL('https://mfb.modalsupport.com/getflowdata');
            
            // Only add flow_version_id if it's available
            if (flowVersionId) {
                flowApiUrl.searchParams.set('flow_version_id', flowVersionId);
            }
            
            flowApiUrl.searchParams.set('flow_ref', flowId);
            
            // Add environment ID if provided
            if (environmentId) {
                flowApiUrl.searchParams.set('env_ref', environmentId);
            }
            
            const flowRes = await fetch(flowApiUrl.toString(), { 
                cache: "no-store"
            });
            
            if (!flowRes.ok) {
                console.error(`[ModalFlow] Failed to fetch flow ${flowId}: ${flowRes.status}`);
                return null;
            }

            const flowResponse = await flowRes.json();
            
            if (!flowResponse) {
                return null;
            }

            // Handle new API response structure: { message: "Success", data: {...} }
            const flowData = flowResponse.data || flowResponse;
            
            // New format only: { message: "Success", data: {...} }
            const data = flowResponse.data || flowResponse;
            
            // Store steps directly in new format
            const flowSteps = data.steps || [];
            
            // Convert behavior and theme to setup config (for compatibility with existing code)
            const behavior = data.behavior || {};
            const theme = data.theme || {};
            
            const setupConfig = {
                auto_start: {
                    value: behavior.autoStart?.enabled || false,
                    frequency: behavior.autoStart?.frequency || 'once_per_user',
                    conditions: behavior.autoStart?.conditions || []
                },
                temporary_hide: {
                    value: behavior.temporaryHide?.enabled || false,
                    conditions: behavior.temporaryHide?.conditions || []
                },
                theme: theme.mode || 'light',
                themeCSS: theme.css || '',
                prevent_closing: behavior.preventClosing || false,
                allow_restart: behavior.allowRestart || false,
                constrain_flow: behavior.constrain || false
            };

            sdk._autoStartSettings = sdk._autoStartSettings || {};
            sdk._autoStartSettings[flowId] = setupConfig.auto_start || setupConfig.autoStart;
            
            // Store flow objects and setup
            sdk._flowObjects = sdk._flowObjects || {};
            sdk._flowsetup = sdk._flowsetup || {};
            sdk._flowObjects[flowId] = flowSteps;
            sdk._flowsetup[flowId] = setupConfig;

            sdk._flows = sdk._flows || {};
            sdk._flows[flowId] = flowResponse;

            return {
                flowObjects: sdk._flowObjects[flowId],
                flowsetup: sdk._flowsetup[flowId],
                autoStartSettings: sdk._autoStartSettings[flowId],
                setupConfig: setupConfig
            };
        } catch (err) {
            console.error(`[ModalFlow] Failed to load flow data for ${flowId}:`, err);
            return null;
        }
    };

    sdk._loadFlowData = async function (flowId, refKey, options = {}) {
        const flowVersionId = options.flowVersionId || null;
        const environmentId = options.environmentId || sdk._environmentId || window.__modalFlowEnvKey || null;
        return await sdk._loadFlowFromApi(flowId, flowVersionId, environmentId);
    };

    sdk._initModalFlow = async function (flowId, refKey, options = {}) {
        if (!isOperationAllowed()) return;

        const masterSecret =  deriveMasterKeyFromEnvKey(options.envKey);
        if (!masterSecret) {
            console.error('Master secret not provided');
            return;
        }
        const token = sdk._token;
        if (!token) {
            return;
        }
        const { skipAutoStart = false, skipLauncher = false } = options;
        const urlParams = new URLSearchParams(window.location.search);
        const hasForcedStep = urlParams.has('mf_start_step');

        try {
            const envKey = options.envKey || window.__modalFlowEnvKey || '';
            const ts = Date.now().toString();
            const nonce = crypto.randomUUID();

            // Derive the secret (same as backend)
            const derivedSecret = await sdk._deriveSecret(envKey, refKey, masterSecret);

            // Canonical request data
            const method = 'GET';
            const path = '/sdkmodal';
            const query = `env_key=${envKey}&nonce=${nonce}&ref_key=${refKey}&ts=${ts}`;

            const payload = `${method}:${path}:${query}:${ts}:`;
            // Sign with derived secret
            const signature = await sdk._signHmac(payload, derivedSecret);

            const url = new URL('https://mfb.modalsupport.com/sdkmodal');
            url.searchParams.set('env_key', envKey);
            url.searchParams.set('ref_key', refKey);
            url.searchParams.set('ts', ts);
            url.searchParams.set('nonce', nonce);
            url.searchParams.set('sig', signature);

            const res = await fetch(url.toString(), {
                method: 'GET',
                cache: 'no-store'
            });
            if (!res.ok) throw new Error(`Failed to fetch flow: ${res.status}`);

            const data = await res.json();

            // Parse and store flowstyle (base_colors.brand) for flow step UI and launcher tooltips
            try {
                sdk._flowstyle = (typeof data.flowstyle === 'string' ? JSON.parse(data.flowstyle) : data.flowstyle) || {};
            } catch (_) {
                sdk._flowstyle = {};
            }
            if (sdk._flowstyle?.base_colors?.brand && !document.getElementById('modalflow-brand-vars')) {
                const b = sdk._flowstyle.base_colors.brand;
                const parts = [];
                if (b.background) parts.push('--ms-brand-background:' + b.background);
                if (b.backgroundHover) parts.push('--ms-brand-background-hover:' + b.backgroundHover);
                if (b.backgroundClick) parts.push('--ms-brand-background-active:' + b.backgroundClick);
                if (b.text) parts.push('--ms-brand-text:' + b.text);
                if (b.background) {
                    parts.push('--ms-brand-pulse-start:' + hexToRgba(b.background, 0.6));
                    parts.push('--ms-brand-pulse-end:' + hexToRgba(b.background, 0));
                    parts.push('--ms-brand-background-subtle:' + hexToRgba(b.background, 0.12));
                }
                if (parts.length) {
                    const st = document.createElement('style');
                    st.id = 'modalflow-brand-vars';
                    st.textContent = ':root{' + parts.join(';') + '}';
                    document.head.appendChild(st);
                }
            }
            const launchers = Array.isArray(data.launchers) ? data.launchers : [];
            const flowsMeta = data.flows_meta || {};
            sdk._flowsMeta = sdk._flowsMeta || {};
            Object.assign(sdk._flowsMeta, flowsMeta);
            const environmentId = data.environment?.env_ref || null;
            if (environmentId) {
                sdk._environmentId = environmentId;
            }
            
            let relevantLaunchers = flowId
                ? launchers.filter(launcher => launcher.flow_ref === flowId)
                : [...launchers];

            if (flowId && relevantLaunchers.length === 0) {
                relevantLaunchers = [{ flow_ref: flowId, enabled: true }];
            }
            if (relevantLaunchers.length === 0 && Object.keys(flowsMeta).length === 0) {
                return;
            }

            sdk._launchers = sdk._launchers || {};
            sdk._flows = sdk._flows || {};
            sdk._flowsMeta = sdk._flowsMeta || {};
            sdk._flowsetup = sdk._flowsetup || {};
            sdk._flowObjects = sdk._flowObjects || {};
            sdk._autoStartSettings = sdk._autoStartSettings || {};
            sdk._flows[refKey] = refKey;

            // Process each launcher without loading flow data
            for (const launcherData of relevantLaunchers) {
                const currentFlowRef = launcherData.flow_ref;
                if (!currentFlowRef) {
                    continue;
                }

                // Use launcher ID as unique identifier
                const launcherId = launcherData.id;
                if (!launcherId) {
                    console.error("[ModalFlow] Launcher missing required 'id' field:", launcherData);
                    continue;
                }
                
                // Store launcher data for later use (keyed by launcher ID)
                sdk._launchers = sdk._launchers || {};
                sdk._launchers[launcherId] = launcherData;
                
                // Create mapping from flow_ref to array of launcher IDs
                sdk._launcherIdsByFlowRef = sdk._launcherIdsByFlowRef || {};
                if (!sdk._launcherIdsByFlowRef[currentFlowRef]) {
                    sdk._launcherIdsByFlowRef[currentFlowRef] = [];
                }
                if (!sdk._launcherIdsByFlowRef[currentFlowRef].includes(launcherId)) {
                    sdk._launcherIdsByFlowRef[currentFlowRef].push(launcherId);
                }
                
                // Store flow_ref mapping by launcher ID
                sdk._launcherFlowRefs = sdk._launcherFlowRefs || {};
                sdk._launcherFlowRefs[launcherId] = currentFlowRef;
                
                // Store flow_version_id mapping by launcher ID
                sdk._launcherFlowVersionIds = sdk._launcherFlowVersionIds || {};
                if (launcherData.flow_version_id) {
                    sdk._launcherFlowVersionIds[launcherId] = launcherData.flow_version_id;
                }

                // Process launcher if not skipped (without flow data)
                // Note: launcher.enabled property is not used for filtering - it has a different purpose
                if (!skipLauncher) {
                    // Convert new launcher structure to old format for _processLauncher
                    // Pass null for flowData since we'll load it on-demand
                    const convertedLauncher = sdk._convertLauncherToOldFormat(launcherData, null);
                    if (convertedLauncher) {
                        await sdk._processLauncher(convertedLauncher, launcherId, refKey, currentFlowRef);
                    }
                }
                if (!skipAutoStart && hasForcedStep) {
                    const flowDataResult = await sdk._loadFlowData(currentFlowRef, refKey, { envKey });
                    if (flowDataResult && flowDataResult.setupConfig) {
                        await sdk._injectInlineModalflowScript(currentFlowRef, flowDataResult.setupConfig);
                    }
                } else if (!skipAutoStart) {
                    const flowDataResult = await sdk._loadFlowData(currentFlowRef, refKey, { envKey });
                    if (flowDataResult && flowDataResult.autoStartSettings && flowDataResult.autoStartSettings.value === true) {
                        const shouldAutoStart = sdk._checkAutoStartConditions(flowDataResult.autoStartSettings);

                        if (shouldAutoStart) {
                            const delay = parseInt(flowDataResult.autoStartSettings.period) || 0;
                            const delayMs = flowDataResult.autoStartSettings.period_type === 'seconds' ? delay * 1000 : delay * 60000;

                            setTimeout(() => {
                                sdk._executeFlow(currentFlowRef, refKey, {});
                            }, delayMs);
                        }
                    }
                }
            }

            // Process flows_meta for auto-start flows (independent of skipAutoStart flag)
            // flows_meta auto-start is separate from launcher auto-start
            if (Object.keys(flowsMeta).length > 0) {
                await sdk._processAutoStartFlows(flowsMeta, refKey, { envKey });
            }
        } catch (err) {
            console.error("[ModalFlow] Failed to load flow:", err);
        }
    };

    sdk._processAutoStartFlows = async function (flowsMeta, refKey, options = {}) {
        if (!flowsMeta || typeof flowsMeta !== 'object') {
            return;
        }



        const { envKey } = options;

        // Process each flow in flows_meta
        for (const [flowId, flowMeta] of Object.entries(flowsMeta)) {
            try {
                const flowRef = flowMeta.flow_ref || flowId;
                const flowVersionId = flowMeta.active_version_id;

                const autoStart = flowMeta.settings?.behavior?.autoStart;
                
                // Skip if auto-start is not enabled
                if (!autoStart || !autoStart.enabled) {
                    continue;
                }

                // Check frequency (once_per_user)
                const frequency = autoStart.frequency || 'once_per_user';

                if (frequency === 'once_per_user') {
                    const storageKey = `modalflow_autostart_${flowRef}`;
                    const alreadyStarted = localStorage.getItem(storageKey);
                    if (alreadyStarted === 'true') {
                        continue; // Skip if already started for this user
                    }
                }

                // Evaluate conditions
                const conditions = autoStart.conditions || [];
                let shouldStart = true;

                if (conditions.length > 0) {
                    // Evaluate each condition and combine based on condition_type
                    let result = null;
                    for (let i = 0; i < conditions.length; i++) {
                        const condition = conditions[i];
                        const conditionType = String(condition.condition_type || 'if').toLowerCase();

                        const passed = sdk._evaluateAutoStartCondition(condition);

                        if (conditionType === 'or') {
                            result = result === null ? passed : (result || passed);
                        } else {
                            result = result === null ? passed : (result && passed);
                        }
                    }
                    shouldStart = result !== null ? result : true;
                }

                // Start flow if conditions match - use same code path as launcher (_executeFlow)
                if (shouldStart) {
                    // Load flow data
                    const environmentId = sdk._environmentId || window.__modalFlowEnvKey || null;
                    const flowDataResult = await sdk._loadFlowFromApi(flowRef, flowVersionId, environmentId);
                    
                    if (flowDataResult && flowDataResult.setupConfig) {
                        // Mark as started for once_per_user frequency
                        if (frequency === 'once_per_user') {
                            const storageKey = `modalflow_autostart_${flowRef}`;
                            localStorage.setItem(storageKey, 'true');
                        }

                        await sdk._executeFlow(flowRef, refKey, {});
                    } else {
                        console.warn('[ModalFlow] Auto-start: Flow', flowRef, '- failed to load flow data');
                    }
                }
            } catch (err) {
                console.error(`[ModalFlow] Auto-start: Failed to process flow ${flowId}:`, err);
            }
        }
    };

    sdk._injectInlineModalflowScript = async function (flowId, setupConfig) {
        try {
            const existingScripts = document.querySelectorAll(`[id^="modalflow-script-${flowId}"]`);
            existingScripts.forEach(script => {
                script.remove();
            });

            const existingScript = document.getElementById(`modalflow-script-${flowId}`);
            if (existingScript) {
                return;
            }

            let guideData = sdk._flowObjects[flowId];
            if (!guideData || !Array.isArray(guideData)) {
                return;
            }

            let confettiInlineB64 = '';
            function stringToBase64(str) {
                try {
                    return btoa(unescape(encodeURIComponent(str)));
                } catch (e) {
                    return '';
                }
            }

            if (sdk._flowstyle?.base_colors?.brand) {
                setupConfig = { ...setupConfig, brandColors: sdk._flowstyle.base_colors.brand };
            }
            const base64Guide = stringToBase64(JSON.stringify(guideData));
            const base64Setup = stringToBase64(JSON.stringify(setupConfig));

            if (!base64Guide) {
                return;
            }

            // Check if any step in the flow uses confetti
            const hasConfettiStep = Array.isArray(guideData) && guideData.some(step => {
                return step && step.addConfetti === true;
            });

            if (hasConfettiStep) {
                try {
                    const s3Url = 'https://hlptflowbuilder.s3.us-east-1.amazonaws.com/assets/confetti.min.js';

                    const response = await fetch(s3Url);
                    const raw = await response.text();
                    confettiInlineB64 = stringToBase64(raw);
                } catch (err) {
                    confettiInlineB64 = '';
                }
            }

            const scriptContent = `
        (function () {
        const executionId = '${flowId}_' + Date.now();
        if (window.__MF_PREVIEW_ACTIVE__ && !window.__MF_PREVIEW_BOOTSTRAP__) {
          console.log('[MF SDK] Skipping - preview mode is active');
          return;
        }
        
        // Mark SDK as loaded
        if (!window.__MF_PREVIEW_BOOTSTRAP__) {
          window.__MF_SDK_LOADED__ = true;
        }
        if (window.__MF_CURRENT_EXECUTION__ && Date.now() - window.__MF_CURRENT_EXECUTION__.time < 1000) {
          return;
        }
        const scriptExecStartTime = Date.now();
        window.__MF_CURRENT_EXECUTION__ = { id: executionId, time: scriptExecStartTime };

        try {
            function base64ToString(base64) {
              try {
                if (!base64 || base64.length === 0) {
                  return '[]';
                }
                const latin1String = atob(base64);
                const utf8Encoded = latin1String.split('').map(c => {
                    return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
                }).join('');
                return decodeURIComponent(utf8Encoded);
              } catch (e) {
                return '[]';
              }
            }
            const guideData = (function(){ 
              try {
                const decoded = base64ToString('${base64Guide}');
                if (!decoded || decoded === '[]') {
                  return [];
                }
                const parsed = JSON.parse(decoded);
                if (!Array.isArray(parsed)) {
                  return [];
                }
                return parsed;
              } catch(e) { 
                return []; 
              } 
            })();
            
            if (!guideData || guideData.length === 0) {
              return;
            }
            
            const setup = (function(){ 
              try { 
                return JSON.parse(base64ToString('${base64Setup}')); 
              } catch(e) { 
                return {}; 
              } 
            })();
                      
            // Store current flow ID for tracking dismissed flows
            window.__CURRENT_FLOW_ID__ = '${flowId}';
            
            let __lastStepIndex = 0;
            var __MF_CONFETTI_INLINE_B64 = '${confettiInlineB64}';
            let __scrollLockEnabled = false;
            let __originalOverflow = '';
            let __originalScrollY = 0;
            let __scrollLockFirstTime = true;
            let __scrollTracking = {
              beacons: new Map(),
              tooltips: new Map(),
              initialScrollX: null,
              initialScrollY: null,
              scrollableContainer: null
            };
                      
            ${sdk._getInlineModalflowScript()}
            
          } catch(err) {
            console.error("[ModalFlow-Inline] CRITICAL ERROR in script:", err);
          }
        })();
        `;

            const blob = new Blob([scriptContent], { type: "application/javascript" });
            const scriptUrl = URL.createObjectURL(blob);
            const s = document.createElement("script");
            s.id = `modalflow-script-${flowId}`;
            s.src = scriptUrl;
            s.async = true;
            document.head.appendChild(s);

        } catch (err) {
            console.error("[ModalFlow] Failed to inject inline script:", err);
        }
    };

    // Single source for flow + tooltip UI styles. One style element (modalflow-preview-styles) in DOM.
    sdk._getPreviewStyles = function () {
        return [
            '#modalflow-guide-overlay{font-family:sans-serif}',
            '.mf-progress-bar{position:absolute;bottom:0;left:0;right:0;height:4px;background:var(--ms-theme-border);border-radius:0 0 10px 10px;overflow:hidden;}',
            '.mf-progress-fill{height:100%;background:var(--ms-brand-background,var(--ms-theme-primary,#0d6efd));transition:width 0.3s ease;}',
            '.mf-preview-badge{position:absolute;top:12px;left:12px;background:var(--ms-brand-background,var(--ms-theme-primary,#0d6efd));color:var(--ms-brand-text,var(--ms-theme-text-on-primary,#fff));font-size:10px;font-weight:600;padding:4px 8px;border-radius:4px;text-transform:uppercase;letter-spacing:0.5px;z-index:2;}',
            '.mf-step-box{background:var(--ms-theme-background);border-radius:10px;padding:48px 24px 24px 24px !important;box-shadow:0 4px 20px var(--ms-theme-shadow);max-width:400px;width:90vw;position:relative;font-family:system-ui,-apple-system,sans-serif;font-size:14px;line-height:1.5;color:var(--ms-theme-text-primary);border:1px solid var(--ms-theme-border);}',
            '.mf-step-title{font-size:20px;font-weight:600;margin:0 0 12px 0;color:var(--ms-theme-text-primary);line-height:1.3;}',
            '.mf-step-content{color:var(--ms-theme-text-secondary);margin-bottom:20px;font-size:14px;line-height:1.6;}',
            '.mf-btn{background:var(--ms-brand-background,var(--ms-theme-primary,#0d6efd));color:var(--ms-brand-text,var(--ms-theme-text-on-primary,#fff));border:2px solid var(--ms-brand-background,var(--ms-theme-primary,#0d6efd));padding:6px 14px;border-radius:8px;font-size:14px;font-weight:500;cursor:pointer;transition:background 0.2s,border-color 0.2s;outline:none;box-sizing:border-box;}',
            '.mf-btn:hover{background:var(--ms-brand-background-hover,var(--ms-theme-primary-hover,#0b5ed7));border-color:var(--ms-brand-background-hover,var(--ms-theme-primary-hover,#0b5ed7));}',
            '.mf-btn:active{background:var(--ms-brand-background-active,var(--ms-theme-primary-hover,#0a58ca));border-color:var(--ms-brand-background-active,var(--ms-theme-primary-hover,#0a58ca));}',
            '.mf-btn-secondary{border:2px solid var(--ms-brand-background,var(--ms-theme-primary,#0d6efd));background:transparent;color:var(--ms-brand-background,var(--ms-theme-primary,#0d6efd));padding:6px 14px;border-radius:8px;cursor:pointer;font-size:14px;font-weight:500;transition:background 0.2s,color 0.2s,border-color 0.2s;box-sizing:border-box;}',
            '.mf-btn-secondary:hover{background:var(--ms-brand-background,var(--ms-theme-primary,#0d6efd));color:var(--ms-brand-text,var(--ms-theme-text-on-primary,#fff));}',
            '.mf-btn-secondary:active{background:var(--ms-brand-background-active,var(--ms-theme-primary-hover,#0a58ca));border-color:var(--ms-brand-background-active,var(--ms-theme-primary-hover,#0a58ca));color:var(--ms-brand-text,var(--ms-theme-text-on-primary,#fff));}',
            // Close button: add safe fallbacks for dark themes
            '.mf-close-btn{position:absolute;top:6px;right:10px;width:24px;height:24px;border:none;background:transparent;font-size:24px;cursor:pointer;color:var(--ms-theme-text-secondary, rgba(0,0,0,0.55));transition:color 0.2s, background 0.2s;display:flex;align-items:center;justify-content:center;border-radius:6px;z-index:2;line-height:1;}',
            '.mf-close-btn:hover{color:var(--ms-theme-text-primary, #111827);background:var(--ms-theme-close-hover-bg, rgba(0,0,0,0.08));}',
            // When theme vars are missing but the UI background is dark, ensure contrast.
            '@media (prefers-color-scheme: dark){.mf-close-btn{color:var(--ms-theme-text-secondary, rgba(255,255,255,0.78));}.mf-close-btn:hover{color:var(--ms-theme-text-primary, #ffffff);background:var(--ms-theme-close-hover-bg, rgba(255,255,255,0.14));}}',
            '@keyframes mfBounce {0%, 100% { transform: translateY(0); } 50% { transform: translateY(10px); }}',
            '#mf-arrow-styles{animation: mfBounce 1s infinite;}',
            '.mf-actions{display:flex;gap:8px;margin-top:20px;justify-content:flex-end;}',
            '.mf-confetti{position:fixed;top:-10px;width:8px;height:8px;pointer-events:none;z-index:1000002;opacity:.9;border-radius:2px;animation:mfFall 1200ms ease-in forwards}',
            '@keyframes mfFall{0%{transform:translateY(-10px) rotate(0)}100%{transform:translateY(110vh) rotate(720deg)}}',
            '.mf-dancing-arrow{position:fixed;width:40px;height:40px;pointer-events:none;z-index:1000000;display:flex;align-items:center;justify-content:center;animation:mfArrowDance 2s ease-in-out infinite;}',
            '.mf-dancing-arrow svg{width:100%;height:100%;filter:drop-shadow(0 2px 4px rgba(0,0,0,0.3));}',
            '@keyframes mfArrowDance{0%{transform:translateY(0px) scale(1)}25%{transform:translateY(-10px) scale(1.1)}50%{transform:translateY(0px) scale(1)}75%{transform:translateY(-5px) scale(1.05)}100%{transform:translateY(0px) scale(1)}}',
            '.mf-beacon{position:fixed;width:16px;height:16px;border-radius:9999px;background:var(--ms-brand-background,var(--ms-theme-primary,#0d6efd));box-shadow:0 0 0 0 var(--ms-brand-pulse-start,rgba(59,130,246,.65));pointer-events:none;z-index:1000000;animation:mfPulse 1400ms ease-out infinite;transition:opacity 0.3s ease;}',
            '.mf-beacon.hidden{opacity:0;}',
            '@keyframes mfPulse{0%{box-shadow:0 0 0 0 var(--ms-brand-pulse-start,rgba(59,130,246,.6))}70%{box-shadow:0 0 0 18px var(--ms-brand-pulse-end,rgba(59,130,246,0))}100%{box-shadow:0 0 0 0 var(--ms-brand-pulse-end,rgba(59,130,246,0))}}',
            '.mf-tooltip{position:fixed;background:#1f2937;color:#fff;padding:8px 12px;border-radius:6px;z-index:1000001;font-size:13px;max-width:200px;box-shadow:0 4px 12px rgba(0,0,0,0.25);pointer-events:none;font-family:system-ui,-apple-system,sans-serif;}',
            '.mf-tooltip-box {position: fixed;background: #ffffff;color: #1f2937;padding: 16px 20px;border-radius: 8px;z-index: 1000001;font-size: 14px;max-width: 320px;min-width: 200px;box-shadow: 0 4px 20px rgba(0,0,0,0.15);pointer-events: auto;font-family: system-ui, -apple-system, sans-serif;line-height: 1.5;text-align: center;}',
            '.mf-tooltip-box.dark {background: #1f2937;color: #f9fafb;}',
            '.mf-tooltip-arrow {position: absolute;width: 0;height: 0;border-style: solid;}',
            '.mf-tooltip-arrow.arrow-down {bottom: -8px;left: 50%;transform: translateX(-50%);border-width: 8px 8px 0 8px;border-color: #ffffff transparent transparent transparent;}',
            '.mf-tooltip-arrow.arrow-down.dark {border-color: #1f2937 transparent transparent transparent;}',
            '.mf-tooltip-arrow.arrow-up {top: -8px;left: 50%;transform: translateX(-50%);border-width: 0 8px 8px 8px;border-color: transparent transparent #ffffff transparent;}',
            '.mf-tooltip-arrow.arrow-up.dark {border-color: transparent transparent #1f2937 transparent;}',
            '.mf-tooltip-arrow.arrow-right {right: -8px;top: 50%;transform: translateY(-50%);border-width: 8px 0 8px 8px;border-color: transparent transparent transparent #ffffff;}',
            '.mf-tooltip-arrow.arrow-right.dark {border-color: transparent transparent transparent #1f2937;}',
            '.mf-tooltip-arrow.arrow-left {left: -8px;top: 50%;transform: translateY(-50%);border-width: 8px 8px 8px 0;border-color: transparent #ffffff transparent transparent;}',
            '.mf-tooltip-arrow.arrow-left.dark {border-color: transparent #1f2937 transparent transparent;}',
            '.mf-tooltip-content {margin: 0;}',
            '.mf-tooltip-actions {display: flex;gap: 8px;margin-top: 16px;justify-content: center;}'
        ];
    };
    sdk._ensurePreviewStyles = function () {
        if (document.getElementById('modalflow-preview-styles')) return;
        var st = document.createElement('style');
        st.id = 'modalflow-preview-styles';
        st.textContent = sdk._getPreviewStyles().join(' ');
        document.head.appendChild(st);
    };

    sdk._getInlineModalflowScript = function () {
        var previewStylesStr = sdk._getPreviewStyles().map(function (s) { return JSON.stringify(s); }).join(',\n              ');
        return `
      (function ensureStyles(){
        if (document.getElementById('modalflow-preview-styles')) return;
        const st = document.createElement('style');
        st.id = 'modalflow-preview-styles';
        st.textContent = [ ${previewStylesStr} ].join(' ');
        document.head.appendChild(st);
      })();
      (function injectThemeAndBrand(){
        function hexToRgba(hex, alpha) {
          if (!hex || typeof hex !== 'string') return alpha >= 0 && alpha < 1 ? 'rgba(13,110,253,' + alpha + ')' : 'rgba(13,110,253,0.65)';
          hex = hex.replace(/^#/, '');
          if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
          if (hex.length !== 6) return alpha >= 0 && alpha < 1 ? 'rgba(13,110,253,' + alpha + ')' : 'rgba(13,110,253,0.65)';
          var r = parseInt(hex.slice(0, 2), 16);
          var g = parseInt(hex.slice(2, 4), 16);
          var b = parseInt(hex.slice(4, 6), 16);
          return 'rgba(' + r + ',' + g + ',' + b + ',' + (alpha != null && alpha >= 0 && alpha <= 1 ? alpha : 0.65) + ')';
        }
        try {
          var themeMode = 'light';
          try {
            themeMode = String((setup && (setup.theme || (setup.settings && setup.settings.theme))) || 'light').toLowerCase();
          } catch (_) { themeMode = 'light'; }
          if (themeMode !== 'dark') themeMode = 'light';
          try { document.documentElement.setAttribute('data-mf-theme', themeMode); } catch (_) {}
          if (!document.getElementById('modalflow-theme-defaults')) {
            var sd = document.createElement('style');
            sd.id = 'modalflow-theme-defaults';
            sd.textContent = [
              ':root{',
              '  --ms-theme-background:#ffffff;',
              '  --ms-theme-background-secondary:#f8fafc;',
              '  --ms-theme-text-primary:#111827;',
              '  --ms-theme-text-secondary:#667085;',
              '  --ms-theme-question-text:#111827;',
              '  --ms-theme-text-on-primary:#ffffff;',
              '  --ms-theme-border:#eaecf0;',
              '  --ms-theme-shadow:rgba(0,0,0,0.15);',
              '  --ms-theme-close-hover-bg:rgba(0,0,0,0.08);',
              '  --ms-theme-option-bg:#f8fafc;',
              '  --ms-theme-option-bg-active:rgba(13,110,253,0.12);',
              '}',
              ':root[data-mf-theme="dark"]{',
              '  --ms-theme-background:#111827;',
              '  --ms-theme-background-secondary:#1f2937;',
              '  --ms-theme-text-primary:#f9fafb;',
              '  --ms-theme-text-secondary:rgba(255,255,255,0.72);',
              '  --ms-theme-question-text:#ffffff;',
              '  --ms-theme-text-on-primary:#ffffff;',
              '  --ms-theme-border:rgba(255,255,255,0.16);',
              '  --ms-theme-shadow:rgba(0,0,0,0.4);',
              '  --ms-theme-close-hover-bg:rgba(255,255,255,0.14);',
              '  --ms-theme-option-bg:rgba(255,255,255,0.06);',
              '  --ms-theme-option-bg-active:rgba(255,255,255,0.10);',
              '  color-scheme: dark;',
              '}'
            ].join('');
            (document.head || document.documentElement).appendChild(sd);
          }
        } catch (_) {}

        if (!document.getElementById('modalflow-theme-vars') && setup.themeCSS) {
          var st = document.createElement('style');
          st.id = 'modalflow-theme-vars';
          st.textContent = setup.themeCSS;
          document.head.appendChild(st);
        }
        
        try {
          if (!window.__MF_POPOVER_SHIELD__) {
            window.__MF_POPOVER_SHIELD__ = {
              stopBubbleOnBox: function (box) {
                try {
                  var stopBubble = function (e) { try { e.stopPropagation(); } catch (_) { } };
                  box.addEventListener('click', stopBubble, false);
                  box.addEventListener('mousedown', stopBubble, false);
                  box.addEventListener('pointerdown', stopBubble, false);
                  box.addEventListener('touchstart', stopBubble, false);
                } catch (_) { }
              },
              shieldButton: function (btn) {
                try {
                  var shield = function (e) {
                    try { e.stopPropagation(); } catch (_) { }
                    if (e && (e.type === 'pointerdown' || e.type === 'mousedown' || e.type === 'touchstart')) {
                      try { e.preventDefault(); } catch (_) { }
                    }
                  };
                  btn.addEventListener('pointerdown', shield, false);
                  btn.addEventListener('mousedown', shield, false);
                  btn.addEventListener('touchstart', shield, false);
                  btn.addEventListener('click', shield, false);
                } catch (_) { }
              }
            };
          }
        } catch (_) { }
        if (!document.getElementById('modalflow-brand-vars') && setup.brandColors) {
          var b = setup.brandColors;
          var parts = [];
          if (b.background) parts.push('--ms-brand-background:' + b.background);
          if (b.backgroundHover) parts.push('--ms-brand-background-hover:' + b.backgroundHover);
          if (b.backgroundClick) parts.push('--ms-brand-background-active:' + b.backgroundClick);
          if (b.text) parts.push('--ms-brand-text:' + b.text);
          if (b.background) {
            parts.push('--ms-brand-pulse-start:' + hexToRgba(b.background, 0.6));
            parts.push('--ms-brand-pulse-end:' + hexToRgba(b.background, 0));
            parts.push('--ms-brand-background-subtle:' + hexToRgba(b.background, 0.12));
          }
          if (parts.length) {
            var sb = document.createElement('style');
            sb.id = 'modalflow-brand-vars';
            sb.textContent = ':root{' + parts.join(';') + '}';
            document.head.appendChild(sb);
          }
        }
      })();
      
      if (!guideData.length) {
        return;
      }
      
      (function determineStartStepEarly() {
        try {
          function isTruthy(v) { return v === true || v === 'true' || v === 1 || v === '1'; }
          
          function evaluateAutoStartCondition(cond) {
            try {
              const type = String(cond && cond.type || '').toLowerCase();
              if (!type) return false;
              if (type === 'current_page_url') {
                const href = String(window.location && window.location.href || '');
                const matches = Array.isArray(cond.match_values) ? cond.match_values : [];
                const noMatches = Array.isArray(cond.no_match_values) ? cond.no_match_values : [];
                const okMatch = matches.length === 0 ? true : matches.some(v => v && href.includes(String(v)));
                const okNoMatch = noMatches.every(v => !href.includes(String(v)));
                return okMatch && okNoMatch;
              }
              if (type === 'current_time') {
                const now = Date.now();
                const start = Date.parse(cond.initalDateTime || cond.initialDateTime || '');
                const end = Date.parse(cond.finalDateTime || cond.endDateTime || '');
                if (Number.isFinite(start) && Number.isFinite(end)) return now >= start && now <= end;
                if (Number.isFinite(start) && !Number.isFinite(end)) return now >= start;
                if (!Number.isFinite(start) && Number.isFinite(end)) return now <= end;
                return false;
              }
            } catch (_) { }
            return false;
          }
          
          function shouldAutoStartQuick(setup) {
            try {
              const block = (setup && (setup.settings && setup.settings.auto_start || setup.auto_start)) || {};
              const enabled = isTruthy(block.value);
              if (!enabled) return false;
              const conds = Array.isArray(block.conditions) ? block.conditions : [];
              if (conds.length === 0) return true;
              let acc = null;
              for (const c of conds) {
                const pass = evaluateAutoStartCondition(c);
                const op = String(c && (c.condition_type || c.operator || 'if')).toLowerCase();
                if (op === 'or') acc = (acc === null ? pass : (acc || pass));
                else { acc = (acc === null ? pass : (acc && pass)); }
              }
              return !!acc;
            } catch (_) { return false; }
          }
          
          function shouldTemporaryHideQuick(setup) {
            try {
              const block = (setup && (setup.settings && setup.settings.temporary_hide || setup.temporary_hide)) || {};
              const enabled = isTruthy(block.value);
              if (!enabled) return false;
              const conds = Array.isArray(block.conditions) ? block.conditions : [];
              if (conds.length === 0) return enabled;
              let acc = null;
              for (const c of conds) {
                const pass = evaluateAutoStartCondition(c);
                const op = String(c && (c.condition_type || c.operator || 'if')).toLowerCase();
                if (op === 'or') acc = (acc === null ? pass : (acc || pass));
                else { acc = (acc === null ? pass : (acc && pass)); }
              }
              return !!acc;
            } catch (_) { return false; }
          }
          
          const doAutoStart = shouldAutoStartQuick(setup);
          const doTempHide = shouldTemporaryHideQuick(setup);
          const forceStart = setup.__forceStart === true;
          
          let forcedStep = null;
          try {
            const params = new URLSearchParams(window.location.search);
            const urlStep = params.get('mf_start_step');
            if (urlStep) {
              forcedStep = parseInt(urlStep, 10);
            }
          } catch (e) {}
          
          if (!Number.isFinite(forcedStep)) {
            try {
              const stored = localStorage.getItem('MF_START_STEP');
              if (stored) {
                forcedStep = parseInt(stored, 10);
              }
            } catch (e) {}
          }
          
          let configuredStartStep = null;
          try {
            if (setup && setup.launcher_behaviour) {
              let launcherData = setup.launcher_behaviour;
              if (typeof launcherData === 'string') {
                launcherData = JSON.parse(launcherData);
              }
              if (launcherData && Array.isArray(launcherData.action)) {
                const startFlowAction = launcherData.action.find(a => 
                  a && (a.type === 'startFlow' || a.type === 'start_flow' || a.condition_type === 'startflow')
                );
                const stepId = startFlowAction && (startFlowAction.step_id || startFlowAction.stepid);
                if (stepId) {
                  const stepIndex = guideData.findIndex(s => s.id === stepId);
                  if (stepIndex >= 0) {
                    configuredStartStep = stepIndex;
                  }
                }
              }
            }
          } catch (e) {}
          
          const hasForcedStep = Number.isFinite(forcedStep) && forcedStep >= 0 && forcedStep < guideData.length;
          
          let startStep = 0;
          let shouldStart = false;
          
          if (hasForcedStep) {
            startStep = forcedStep;
            shouldStart = true;
          } else if (Number.isFinite(configuredStartStep) && (forceStart || doAutoStart) && !doTempHide) {
            startStep = configuredStartStep;
            shouldStart = true;
          } else if (forceStart && !doTempHide) {
            startStep = 0;
            shouldStart = true;
          } else if (doAutoStart && !doTempHide) {
            startStep = 0;
            shouldStart = true;
          }
          
          window.__MF_EARLY_SHOULD_START__ = shouldStart;
          window.__MF_EARLY_START_STEP__ = startStep;
        } catch (e) {
          console.error('[Modalflow] Error in determineStartStepEarly:', e);
          window.__MF_EARLY_SHOULD_START__ = false;
          window.__MF_EARLY_START_STEP__ = 0;
        }
      })();
      
      function waitForDOMReady() {
      return new Promise((resolve) => {
          if (document.readyState === 'complete' || document.readyState === 'interactive') {
              setTimeout(resolve, 0);
          } else {
              document.addEventListener('DOMContentLoaded', () => {
                  setTimeout(resolve, 0);
              });
          }
      });
  }
  
  function isElementVisible(element) {
      if (!element) return false;
      if (!document.body.contains(element)) return false;
  
      const style = window.getComputedStyle(element);
      if (style.display === 'none' ||
          style.visibility === 'hidden' ||
          style.opacity === '0') {
          return false;
      }
  
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
          return false;
      }
  
      return true;
  }
  
  function isExactElementMatch(element, expectedElement) {
      if (!element || !expectedElement) return false;
  
      if (expectedElement.class) {
          const expectedClasses = expectedElement.class.trim().split(/\s+/).sort().join(' ');
          const actualClasses = element.className.trim().split(/\s+/).sort().join(' ');
          if (expectedClasses === actualClasses) return true;
      }
  
      if (expectedElement.id && element.id === expectedElement.id) return true;
  
      if (expectedElement.tag && expectedElement.text) {
          if (element.tagName === expectedElement.tag.toUpperCase()) {
              const elementText = (element.innerText || element.textContent || '').trim();
              if (elementText === expectedElement.text.trim()) return true;
          }
      }
  
      if (expectedElement.href && element.href) {
          if (element.href.includes(expectedElement.href) || expectedElement.href.includes(element.getAttribute('href'))) {
              return true;
          }
      }
  
      return false;
  }
  function getClassArray(element) {
    if (!element) return [];
  
    if (element.classList && element.classList.length) {
      return Array.from(element.classList);
    }
  
    if (typeof element.class === 'string') {
      return element.class.split(' ').filter(Boolean);
    }
  
    if (typeof element.className === 'string') {
      return element.className.split(' ').filter(Boolean);
    }
  
    return [];
  }
  function buildSpecificSelector(element) {
    const selectors = [];
  
    const tag = element.tag ? element.tag.toLowerCase() : '';
    const classes = getClassArray(element);
  
    if (element.id && element.id.trim()) {
      selectors.push({
        selector: '#' + element.id.trim(),
        unique: true
      });
    }
  
    if (tag && classes.length) {
      selectors.push({
        selector: tag + '.' + classes.join('.'),
        unique: false
      });
    }
  
    if (tag && element.href && classes.length) {
      selectors.push({
        selector:
          tag +
          '[href="' + element.href + '"].' +
          classes.join('.'),
        unique: false
      });
    }
  
    if (tag && element.href) {
      selectors.push({
        selector: tag + '[href="' + element.href + '"]',
        unique: false
      });
    }
  
    return selectors;
  }
  
  async function getElementSelectorFromConfig(config, options = {}) {
      const maxRetries = options.maxRetries || 15;
      const retryDelay = options.retryDelay || 300;
      const timeout = options.timeout || 10000;
  
      await waitForDOMReady();
      await new Promise(resolve => setTimeout(resolve, 200));
  
      const startTime = Date.now();
      let attempts = 0;
  
      while (attempts < maxRetries) {
          attempts++;
  
          if (Date.now() - startTime > timeout) {
              return null;
          }
  
          const element = getElementSelectorFromConfigSync(config);
          if (element && isElementVisible(element)) {
              return element;
          }
  
          if (attempts < maxRetries) {
              await new Promise(resolve => setTimeout(resolve, retryDelay));
          }
      }
  
      return null;
  }
  
  function getElementSelectorFromConfigSync(config) {
      try {
          if (!config) {
              return null;
          }

          let cssSelector = '';
          if (typeof config === 'string') {
              cssSelector = config;
          } else if (config.selector && config.selector.value) {
              cssSelector = config.selector.value;
          } else if (config.value) {
              cssSelector = config.value;
          }

          if (cssSelector && String(cssSelector).trim()) {
              const ifMultiple = config.ifMultiple?.value || 'first';
              return findElementBySelector(cssSelector, ifMultiple);
          }
      } catch (e) {
          console.error('[Modalflow] getElementSelectorFromConfigSync error:', e);
      }
      return null;
  }
  
  function findElementBySelector(selector, matchPreference) {
      try {
          const elements = document.querySelectorAll(selector);
  
          if (elements.length === 0) return null;
          if (elements.length === 1) return elements[0];
  
          const index = typeof matchPreference === 'number' ? matchPreference :
              (matchPreference === 'first' || matchPreference === '0' ? 0 : parseInt(matchPreference) || 0);
  
          if (index >= 0 && index < elements.length) {
              return elements[index];
          }
  
          return elements[0];
      } catch (e) {
          return null;
      }
  }
  
  function findElementByText(text) {
      try {
          const textStr = String(text).trim();
          if (!textStr) return null;

          const startTime = performance.now();
          const maxScanTime = 3000; // 3 second timeout
          
          const walker = document.createTreeWalker(
              document.body,
              NodeFilter.SHOW_ELEMENT,
              null,
              false
          );

          let node;
          while ((node = walker.nextNode())) {
              if (performance.now() - startTime > maxScanTime) {
                  console.warn('[Modalflow] findElementByText timeout after 3s');
                  return null;
              }

              const tagName = node.tagName?.toLowerCase();
              if (tagName === 'script' || tagName === 'style' || tagName === 'noscript') {
                  continue;
              }

              if (elementTextMatches(node, textStr)) {
                  return node;
              }
          }
      } catch (e) {
          console.error('[Modalflow] findElementByText error:', e);
      }
      return null;
  }

  function elementTextMatches(element, searchText) {
      if (!element || !searchText) return false;
      const elText = (element.innerText || element.textContent || '').trim();
      const searchStr = String(searchText).trim();
      if (!elText || !searchStr) return false;
      return elText.includes(searchStr) || elText === searchStr;
  }

  function scrollToElementIfNeeded(element, options = {}) {
      if (!element || !element.getBoundingClientRect) {
          return Promise.resolve(false);
      }
  
      return new Promise((resolve) => {
          try {
              const rect = element.getBoundingClientRect();
              const windowHeight = window.innerHeight || document.documentElement.clientHeight;
              const windowWidth = window.innerWidth || document.documentElement.clientWidth;
  
              // Check for full visibility (no margin) when requireFullVisibility is true
              const requireFullVisibility = options.requireFullVisibility !== false;
              const isFullyVisible = requireFullVisibility ? (
                  rect.top >= 0 &&
                  rect.left >= 0 &&
                  rect.bottom <= windowHeight &&
                  rect.right <= windowWidth
              ) : (
                  rect.top >= -100 &&
                  rect.left >= -100 &&
                  rect.bottom <= windowHeight + 100 &&
                  rect.right <= windowWidth + 100
              );
  
              if (isFullyVisible) {
                  // Element already visible, wait for layout update
                  requestAnimationFrame(() => {
                      requestAnimationFrame(() => {
                          resolve(true);
                      });
                  });
                  return;
              }
  
              const scrollOptions = {
                  behavior: options.smooth !== false ? 'smooth' : 'auto',
                  block: options.block || 'center',
                  inline: options.inline || 'center'
              };
  
              element.scrollIntoView(scrollOptions);
  
              const scrollTimeout = options.smooth !== false ? 800 : 150;
              setTimeout(() => {
                  requestAnimationFrame(() => {
                      requestAnimationFrame(() => {
                          resolve(true);
                      });
                  });
              }, scrollTimeout);
  
          } catch (e) {
              resolve(false);
          }
      });
  }
  
  /**
   * Check if element is in viewport
   */
  function isElementInViewport(element, margin = 100) {
      if (!element || !element.getBoundingClientRect) return false;
  
      try {
          const rect = element.getBoundingClientRect();
          const windowHeight = window.innerHeight || document.documentElement.clientHeight;
          const windowWidth = window.innerWidth || document.documentElement.clientWidth;
  
          return (
              rect.top >= -margin &&
              rect.left >= -margin &&
              rect.bottom <= windowHeight + margin &&
              rect.right <= windowWidth + margin
          );
      } catch (e) {
          return false;
      }
  }
  function findElementByCoordinates(selector, coordinates) {
      try {
          const elements = document.querySelectorAll(selector);
          if (elements.length === 0) return null;
          if (elements.length === 1) return elements[0];
  
          const targetX = coordinates.x + (coordinates.width / 2);
          const targetY = coordinates.y + (coordinates.height / 2);
  
          let closest = null;
          let minDist = Infinity;
  
          elements.forEach((el, idx) => {
              const rect = el.getBoundingClientRect();
              const elX = rect.left + rect.width / 2;
              const elY = rect.top + rect.height / 2;
              const dist = Math.sqrt(Math.pow(elX - targetX, 2) + Math.pow(elY - targetY, 2));
  
              if (dist < minDist) {
                  minDist = dist;
                  closest = el;
              }
          });
          return closest;
      } catch (e) {
          return null;
      }
  }
  function checkBeaconHideConditions(hideBeaconConfig) {
      try {
          if (!hideBeaconConfig || !hideBeaconConfig.value) {
              return false;
          }
  
          const triggers = hideBeaconConfig.triggers || [];
  
          if (triggers.length === 0) {
              return true;
          }
  
          for (const trigger of triggers) {
              const type = String(trigger.type || '').toLowerCase();
              const conditionType = String(trigger.condition_type || '').toLowerCase();
  
              if (type === 'current_time') {
                  const now = Date.now();
                  const start = Date.parse(trigger.initalDateTime || trigger.initialDateTime || '');
                  const end = Date.parse(trigger.finalDateTime || trigger.endDateTime || '');
  
                  let timeMatch = false;
                  if (Number.isFinite(start) && Number.isFinite(end)) {
                      timeMatch = now >= start && now <= end;
                  } else if (Number.isFinite(start) && !Number.isFinite(end)) {
                      timeMatch = now >= start;
                  } else if (!Number.isFinite(start) && Number.isFinite(end)) {
                      timeMatch = now <= end;
                  }
  
                  if (conditionType === 'if' && timeMatch) {
                      return true;
                  }
              } else if (type === 'current_page_url') {
                  const currentUrl = 'window.location.href'; // This will be evaluated on client
                  const matchValues = trigger.match_values || [];
                  const noMatchValues = trigger.no_match_values || [];
                  return {
                      type: 'url_condition',
                      matchValues,
                      noMatchValues,
                      conditionType
                  };
              }
          }
          return false;
      } catch (e) {
          return false;
      }
  }
  // Find scrollable parent container
  function findScrollableContainer(element) {
      if (!element) return window;
  
      let parent = element.parentElement;
      while (parent) {
          const overflow = window.getComputedStyle(parent).overflow;
          const overflowY = window.getComputedStyle(parent).overflowY;
          const overflowX = window.getComputedStyle(parent).overflowX;
  
          if (overflow === 'auto' || overflow === 'scroll' ||
              overflowY === 'auto' || overflowY === 'scroll' ||
              overflowX === 'auto' || overflowX === 'scroll') {
              return parent;
          }
          parent = parent.parentElement;
      }
      return window;
  }
  
  // Get current scroll position
  function getCurrentScrollPosition(container) {
      if (container && container !== window) {
          return {
              x: container.scrollLeft || 0,
              y: container.scrollTop || 0
          };
      }
      return {
          x: window.pageXOffset || document.documentElement.scrollLeft,
          y: window.pageYOffset || document.documentElement.scrollTop
      };
  }
  
  // Initialize scroll tracking for an element
  function initScrollTracking(targetElement) {
      if (!__scrollTracking.scrollableContainer) {
          __scrollTracking.scrollableContainer = findScrollableContainer(targetElement);
      }
  
      if (__scrollTracking.initialScrollX === null) {
          const scroll = getCurrentScrollPosition(__scrollTracking.scrollableContainer);
          __scrollTracking.initialScrollX = scroll.x;
          __scrollTracking.initialScrollY = scroll.y;
      }
  }
  
  // Calculate position with scroll adjustment
  function getPositionWithScroll(targetElement, useAbsoluteCoords, savedCoords) {
      const currentScroll = getCurrentScrollPosition(__scrollTracking.scrollableContainer);
  
      if (useAbsoluteCoords && savedCoords) {
          const scrollDiffX = currentScroll.x - (__scrollTracking.initialScrollX || 0);
          const scrollDiffY = currentScroll.y - (__scrollTracking.initialScrollY || 0);
  
          return {
              left: savedCoords.left - scrollDiffX,
              top: savedCoords.top - scrollDiffY,
              right: savedCoords.right - scrollDiffX,
              bottom: savedCoords.bottom - scrollDiffY,
              width: savedCoords.width,
              height: savedCoords.height,
              centerX: savedCoords.centerX - scrollDiffX,
              centerY: savedCoords.centerY - scrollDiffY
          };
      }
  
      if (targetElement && targetElement.getBoundingClientRect) {
          const rect = targetElement.getBoundingClientRect();
          return {
              left: rect.left,
              top: rect.top,
              right: rect.right,
              bottom: rect.bottom,
              width: rect.width,
              height: rect.height,
              centerX: rect.left + (rect.width / 2),
              centerY: rect.top + (rect.height / 2)
          };
      }
  
      return null;
  }
  // Function to check conditions for showing beacon/tooltip
  function checkElementConditions(conditions) {
      try {
          if (!Array.isArray(conditions) || conditions.length === 0) return true;
  
          for (const condition of conditions) {
              if (!condition || typeof condition !== 'object') continue;
              const type = String(condition.type || '').toLowerCase();
              const conditionType = String(condition.condition_type || '').toLowerCase();
              const matchValues = condition.match_values || [];
              const noMatchValues = condition.no_match_values || [];
  
              if (type === 'current_page_url' || conditionType === 'url') {
                  const currentUrl = window.location.href.toLowerCase();
                  if (matchValues.length > 0) {
                      const matches = matchValues.some(url => {
                          const urlStr = String(url || '').toLowerCase();
                          return currentUrl.includes(urlStr) || currentUrl === urlStr;
                      });
                      if (!matches) return false;
                  }
                  if (noMatchValues.length > 0) {
                      const excluded = noMatchValues.some(url => {
                          const urlStr = String(url || '').toLowerCase();
                          return currentUrl.includes(urlStr) || currentUrl === urlStr;
                      });
                      if (excluded) return false;
                  }
              } else if (type === 'current_time') {
                  const now = Date.now();
                  const start = Date.parse(condition.initalDateTime || condition.initialDateTime || '');
                  const end = Date.parse(condition.finalDateTime || condition.endDateTime || '');
  
                  if (Number.isFinite(start) && Number.isFinite(end)) {
                      if (!(now >= start && now <= end)) return false;
                  } else if (Number.isFinite(start) && !Number.isFinite(end)) {
                      if (now < start) return false;
                  } else if (!Number.isFinite(start) && Number.isFinite(end)) {
                      if (now > end) return false;
                  }
              } else if (type === 'element' || type === 'css_selector') {
                  try {
                      const selector = String(condition.selector || condition.value || '');
                      if (selector) {
                          const element = document.querySelector(selector);
                          if (!element) return false;
                      }
                  } catch (_) { return false; }
              }
          }
          return true;
      } catch (_) {
          return true;
      }
  }
  
  // Function to show beacon on element
  function showBeaconOnElement(element, position) {
      try {
          if (!element) return;
  
          const beacon = document.createElement('div');
          beacon.className = 'mf-beacon';
          beacon.id = 'mf-element-beacon-' + Date.now();
          beacon.style.position = 'fixed';
          beacon.style.zIndex = '1000001';
  
          function findScrollableParent(el) {
              if (!el) return window;
  
              let parent = el.parentElement;
              while (parent) {
                  const overflow = window.getComputedStyle(parent).overflow;
                  const overflowY = window.getComputedStyle(parent).overflowY;
                  const overflowX = window.getComputedStyle(parent).overflowX;
  
                  if (overflow === 'auto' || overflow === 'scroll' ||
                      overflowY === 'auto' || overflowY === 'scroll' ||
                      overflowX === 'auto' || overflowX === 'scroll') {
                      return parent;
                  }
                  parent = parent.parentElement;
              }
              return window;
          }
  
          const scrollableContainer = findScrollableParent(element);
          let scrollEventCount = 0;
  
          function updateBeaconPosition() {
              try {
                  scrollEventCount++;
  
                  const rect = element.getBoundingClientRect ? element.getBoundingClientRect() :
                      (typeof element === 'object' && element.rect ?
                          { left: element.rect.x, top: element.rect.y, width: element.rect.width || 0, height: element.rect.height || 0 } :
                          null);
  
                  if (!rect) return;
  
                  const size = 16;
                  let translateX = rect.left + (rect.width / 2) - (size / 2);
                  let translateY = rect.top - (size / 2);
  
                  if (position) {
                      const posStr = String(position.position || '').toLowerCase();
                      const leftOffset = parseFloat(String(position.left || '0').replace('px', '')) || 0;
                      const topOffset = parseFloat(String(position.top || '0').replace('px', '')) || 0;
                      const rightOffset = parseFloat(String(position.right || '0').replace('px', '')) || 0;
                      const bottomOffset = parseFloat(String(position.bottom || '0').replace('px', '')) || 0;
  
                      if (posStr.includes('bottom')) {
                          translateY = rect.bottom - (size / 2) + bottomOffset;
                      } else if (posStr.includes('center')) {
                          translateY = rect.top + (rect.height / 2) - (size / 2);
                      } else {
                          translateY = rect.top - (size / 2) + topOffset;
                      }
  
                      if (posStr.includes('right')) {
                          translateX = rect.right - (size / 2) + rightOffset;
                      } else if (posStr.includes('center')) {
                          translateX = rect.left + (rect.width / 2) - (size / 2);
                      } else {
                          translateX = rect.left - (size / 2) + leftOffset;
                      }
                  }
  
                  translateX = Math.max(0, Math.min(translateX, window.innerWidth - size));
                  translateY = Math.max(0, Math.min(translateY, window.innerHeight - size));
  
                  beacon.style.transform = 'translate3d(' + translateX + 'px, ' + translateY + 'px, 0px)';
                  beacon.style.left = '0';
                  beacon.style.top = '0';
  
              } catch (e) {
                  console.error('[Modalflow] Beacon position update error:', e);
              }
          }
  
          document.body.appendChild(beacon);
          updateBeaconPosition();
  
          const handleScroll = (event) => {
              updateBeaconPosition();
          };
  
          const handleResize = () => updateBeaconPosition();
  
          if (scrollableContainer === window) {
              window.addEventListener('scroll', handleScroll, { passive: true });
          } else {
              scrollableContainer.addEventListener('scroll', handleScroll, { passive: true });
              window.addEventListener('scroll', handleScroll, { passive: true });
          }
  
          document.addEventListener('scroll', handleScroll, { passive: true });
          window.addEventListener('resize', handleResize, { passive: true });
  
          let lastScrollX, lastScrollY;
  
          if (scrollableContainer && scrollableContainer !== window) {
              lastScrollX = scrollableContainer.scrollLeft || 0;
              lastScrollY = scrollableContainer.scrollTop || 0;
          } else {
              lastScrollX = window.pageXOffset || document.documentElement.scrollLeft;
              lastScrollY = window.pageYOffset || document.documentElement.scrollTop;
          }
  
          const scrollDetectionInterval = setInterval(() => {
              let currentX, currentY;
  
              if (scrollableContainer && scrollableContainer !== window) {
                  currentX = scrollableContainer.scrollLeft || 0;
                  currentY = scrollableContainer.scrollTop || 0;
              } else {
                  currentX = window.pageXOffset || document.documentElement.scrollLeft;
                  currentY = window.pageYOffset || document.documentElement.scrollTop;
              }
  
              if (currentY !== lastScrollY || currentX !== lastScrollX) {
                  updateBeaconPosition();
              }
  
              lastScrollY = currentY;
              lastScrollX = currentX;
          }, 100);
  
          beacon._cleanup = () => {
              window.removeEventListener('scroll', handleScroll);
              window.removeEventListener('resize', handleResize);
              document.removeEventListener('scroll', handleScroll);
  
              if (scrollableContainer && scrollableContainer !== window) {
                  scrollableContainer.removeEventListener('scroll', handleScroll);
              }
  
              clearInterval(scrollDetectionInterval);
          };
  
          return beacon;
      } catch (e) {
          console.error('[Modalflow] showBeaconOnElement error:', e);
      }
      return null;
  }
  function removeAllBoxes() {
      try {
          const beacons = document.querySelectorAll('.mf-beacon');
          beacons.forEach(b => {
              if (b._cleanup) b._cleanup();
              b.remove();
          });
  
          const arrows = document.querySelectorAll('.mf-floating-arrow');
          arrows.forEach(a => a.remove());
  
          const boxes = document.querySelectorAll('[data-modalflow-box="1"]');
          boxes.forEach(e => e.remove());
      } catch (e) {
          console.error('[Modalflow] Error removing boxes:', e);
      }
  }
  // Function to show tooltip on element
  function showTooltipOnElement(element, text, position, elementConfig) {
      try {
          if (!element || !text) return null;
  
          const savedCoords = null;
  
          initScrollTracking(element);
  
          const tooltip = document.createElement('div');
          tooltip.className = 'mf-tooltip';
          tooltip.id = 'mf-element-tooltip-' + Date.now();
          tooltip.textContent = String(text);
          tooltip.style.position = 'fixed';
          tooltip.style.background = '#333';
          tooltip.style.color = '#fff';
          tooltip.style.padding = '8px 12px';
          tooltip.style.borderRadius = '4px';
          tooltip.style.zIndex = '1000001';
          tooltip.style.fontSize = '14px';
          tooltip.style.maxWidth = '200px';
          tooltip.style.boxShadow = '0 2px 8px rgba(0,0,0,0.2)';
          tooltip.style.pointerEvents = 'none';
  
          const updateTooltipPosition = () => {
              try {
                  const rect = getPositionWithScroll(element, useAbsoluteCoords, savedCoords);
                  if (!rect) return;
  
                  let left = rect.centerX;
                  let top = rect.top - 40;
  
                  if (position) {
                      const posStr = String(position.position || '').toLowerCase();
                      const topOffset = parseFloat(String(position.top || '0').replace('px', '')) || 0;
                      const leftOffset = parseFloat(String(position.left || '0').replace('px', '')) || 0;
  
                      if (posStr.includes('bottom')) {
                          top = rect.bottom + 8;
                      } else {
                          top = rect.top - 40 + topOffset;
                      }
  
                      if (posStr.includes('left')) {
                          left = rect.left + leftOffset;
                          tooltip.style.transform = 'translateX(0)';
                      } else if (posStr.includes('right')) {
                          left = rect.right + leftOffset;
                          tooltip.style.transform = 'translateX(-100%)';
                      } else {
                          left = rect.centerX + leftOffset;
                          tooltip.style.transform = 'translateX(-50%)';
                      }
                  } else {
                      tooltip.style.transform = 'translateX(-50%)';
                  }
  
                  tooltip.style.left = left + 'px';
                  tooltip.style.top = top + 'px';
  
              } catch (e) {
                  console.error('[Modalflow] Tooltip position update error:', e);
              }
          };
  
          document.body.appendChild(tooltip);
          updateTooltipPosition();
  
          const handleScroll = () => updateTooltipPosition();
  
          if (__scrollTracking.scrollableContainer === window) {
              window.addEventListener('scroll', handleScroll, { passive: true });
          } else {
              __scrollTracking.scrollableContainer.addEventListener('scroll', handleScroll, { passive: true });
              window.addEventListener('scroll', handleScroll, { passive: true });
          }
          document.addEventListener('scroll', handleScroll, { passive: true });
          window.addEventListener('resize', handleScroll, { passive: true });
  
          let resizeObserver = null;
          if (!useAbsoluteCoords && element.nodeType) {
              try {
                  resizeObserver = new ResizeObserver(updateTooltipPosition);
                  resizeObserver.observe(element);
              } catch (e) {
                  console.warn('[Modalflow] ResizeObserver not supported');
              }
          }
  
          let lastScrollX = getCurrentScrollPosition(__scrollTracking.scrollableContainer).x;
          let lastScrollY = getCurrentScrollPosition(__scrollTracking.scrollableContainer).y;
  
          const scrollDetection = setInterval(() => {
              const current = getCurrentScrollPosition(__scrollTracking.scrollableContainer);
              if (current.x !== lastScrollX || current.y !== lastScrollY) {
                  updateTooltipPosition();
                  lastScrollX = current.x;
                  lastScrollY = current.y;
              }
          }, 100);
  
          tooltip._cleanup = () => {
              window.removeEventListener('scroll', handleScroll);
              window.removeEventListener('resize', handleScroll);
              document.removeEventListener('scroll', handleScroll);
              if (__scrollTracking.scrollableContainer !== window) {
                  __scrollTracking.scrollableContainer.removeEventListener('scroll', handleScroll);
              }
              if (resizeObserver) {
                  resizeObserver.disconnect();
              }
              clearInterval(scrollDetection);
          };
  
          __scrollTracking.tooltips.set(tooltip.id, {
              element: tooltip,
              cleanup: tooltip._cleanup
          });
  
          return tooltip;
      } catch (e) {
          console.error('[Modalflow] showTooltipOnElement error:', e);
      }
      return null;
  }
  
  function initializeElementBeaconsAndTooltips() {
      try {
          guideData.forEach(async (step, stepIndex) => {
              if (!step || typeof step !== 'object') return;
  
              const blocks = Array.isArray(step.blocks) ? step.blocks : [];
              blocks.forEach(async block => {
                  if (!block || typeof block !== 'object' || block.type !== 'launcher') return;

                  if (block.selector && block.selector.value) {
                      const selector = await getElementSelectorFromConfig(block.selector);
  
                      if (selector) {
                          let element = null;
                          if (typeof selector === 'string') {
                              element = document.querySelector(selector);
                          } else if (selector.nodeType) {
                              element = selector;
                          }
  
                          if (element) {
                              const conditions = block.conditions || [];
                              if (checkElementConditions(conditions)) {
                                  const position = block.position || {};
                                  showBeaconOnElement(element, position, block);
                              }
                          }
                      }
                  }
              });
  
          });
      } catch (e) {
          console.error('[Modalflow] Error initializing element beacons/tooltips:', e);
      }
  }
  
  function createEl(tag, attrs = {}, html = "") {
      const el = document.createElement(tag);
      Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
      el.innerHTML = html;
      return el;
  }
  function disableScroll() {
      if (__scrollLockEnabled) return; 

      try {
          if (__scrollLockFirstTime) {
              __scrollLockFirstTime = false;
              __originalScrollY = window.pageYOffset || document.documentElement.scrollTop;
              __originalOverflow = document.body.style.overflow;
              document.body.style.overflow = 'hidden';
              document.body.style.position = 'fixed';
              document.body.style.top = '-' + __originalScrollY + 'px';
              document.body.style.width = '100%';
              __scrollLockEnabled = true;
              return;
          }
          requestAnimationFrame(() => {
              const scrollY = window.pageYOffset || document.documentElement.scrollTop;
              const originalOverflow = document.body.style.overflow;
              requestAnimationFrame(() => {
                  try {
                      document.body.style.overflow = 'hidden';
                      document.body.style.position = 'fixed';
                      document.body.style.top = '-' + scrollY + 'px';
                      document.body.style.width = '100%';
                      __scrollLockEnabled = true;
                      __originalOverflow = originalOverflow;
                      __originalScrollY = scrollY;
                  } catch (e) {
                      console.error('[Modalflow] Error disabling scroll:', e);
                  }
              });
          });
      } catch (e) {
          console.error('[Modalflow] Error disabling scroll:', e);
      }
  }
  
  // Function to re-enable scrolling on the page
  function enableScroll() {
      if (!__scrollLockEnabled) return; // Already enabled
  
      try {
          document.body.style.overflow = __originalOverflow;
          document.body.style.position = '';
          document.body.style.top = '';
          document.body.style.width = '';
  
          window.scrollTo(0, __originalScrollY);
  
          __scrollLockEnabled = false;
      } catch (e) {
          console.error('[Modalflow] Error enabling scroll:', e);
      }
  }
  function setForcedStartStep(stepIndex) {
      try { localStorage.setItem('MF_START_STEP', String(stepIndex)); } catch (_) { }
  }
  function readForcedStartStep() {
      let result = null;
      try {
          const url = new URL(window.location.href);
          const q = url.searchParams.get('mf_start_step');
          if (q != null && q !== '') {
              result = Number(q);
          }
      } catch (e) { }
      if (result !== null && Number.isFinite(result)) return result;
      try {
          const s = localStorage.getItem('MF_START_STEP');
          if (s != null && s !== '') {
              result = Number(s);
              localStorage.removeItem('MF_START_STEP');
              return result;
          }
      } catch (e) { }
      return null;
  }
  function clearForcedStartParam() {
    try {
        const url = new URL(window.location.href);
        if (url.searchParams.has('mf_start_step')) {
            url.searchParams.delete('mf_start_step');
            window.history.replaceState({}, '', url.toString());
        }
    } catch (_) { }
  }
  function addMfStartToUrl(rawUrl, stepIndex) {
      try {
          const u = new URL(String(rawUrl), window.location.href);
          u.searchParams.set('mf_start_step', String(stepIndex));
          return u.toString();
      } catch (_) { return rawUrl; }
  }
  
  function ensureConfettiVendor(src) {
      return new Promise(function (resolve) {
          try {
              if (typeof confetti === 'function') { resolve(true); return; }
              try {
                  if (__MF_CONFETTI_INLINE_B64) {
                      var sc = document.createElement('script');
                      sc.setAttribute('data-mf-confetti', 'inline');
                      sc.text = atob(__MF_CONFETTI_INLINE_B64);
                      document.head.appendChild(sc);
                      if (typeof ConfettiGenerator === 'function' || typeof confetti === 'function') { resolve(true); return; }
                  }
              } catch (_) { /* ignore */ }
              var url = src || (window.__MF_CONFETTI_SRC);
              if (!url) { resolve(false); return; }
              var existScript = document.querySelector('script[data-mf-confetti="1"][src="' + url + '"]');
              if (existScript) { existScript.onload = function () { resolve(true); }; existScript.onerror = function () { resolve(false); }; return; }
              var link = document.querySelector('link[data-mf-confetti-preload="1"][href="' + url + '"]');
              if (!link) {
                  link = document.createElement('link');
                  link.setAttribute('rel', 'modulepreload');
                  link.setAttribute('as', 'script');
                  link.setAttribute('crossorigin', '');
                  link.setAttribute('href', url);
                  link.setAttribute('data-mf-confetti-preload', '1');
                  document.head.appendChild(link);
              }
              var s = document.createElement('script');
              s.async = true;
              s.crossOrigin = 'anonymous';
              s.src = url;
              s.setAttribute('data-mf-confetti', '1');
              s.onload = function () { resolve(true); };
              s.onerror = function () { resolve(false); };
              document.head.appendChild(s);
          } catch (_) { 
              resolve(false); 
          }
      });
  }
  
  function ensureInlineConfetti() {
      if (window.__mfConfettiFire) return window.__mfConfettiFire;
      const canvas = document.createElement('canvas');
      canvas.id = 'mf-confetti-canvas';
      canvas.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:1000002;';
      document.body.appendChild(canvas);
      const ctx = canvas.getContext('2d');
      const resize = () => { canvas.width = Math.max(document.documentElement.clientWidth || 0, window.innerWidth || 0); canvas.height = Math.max(document.documentElement.clientHeight || 0, window.innerHeight || 0); };
      resize();
      window.addEventListener('resize', resize);
      function fire(opts) {
          const count = Math.min(400, Math.max(40, (opts && opts.particleCount) || 150));
          const spread = (opts && opts.spread) || 90;
          const originY = (opts && opts.origin && opts.origin.y) ? opts.origin.y : 0.6;
          const originX = (opts && opts.origin && opts.origin.x) ? opts.origin.x : 0.5;
          const cx = canvas.width * originX;
          const cy = canvas.height * originY;
          const colors = ['#ff6384', '#36a2eb', '#ffcd56', '#4bc0c0', '#9966ff', '#ff9f40'];
          const parts = [];
          for (let i = 0; i < count; i++) {
              const angle = (Math.random() * spread - spread / 2) * (Math.PI / 180);
              const speed = 6 + Math.random() * 6;
              parts.push({ x: cx, y: cy, vx: Math.cos(-Math.PI / 2 + angle) * speed, vy: Math.sin(-Math.PI / 2 + angle) * speed, g: 0.15 + Math.random() * 0.2, size: 3 + Math.random() * 4, color: colors[i % colors.length], life: 1000 + Math.random() * 600, rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.3 });
          }
          const start = performance.now();
          (function frame(t) {
              const elapsed = t - start;
              ctx.clearRect(0, 0, canvas.width, canvas.height);
              parts.forEach(p => { p.vy += p.g; p.x += p.vx; p.y += p.vy; p.rot += p.vr; ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.fillStyle = p.color; ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size); ctx.restore(); });
              if (elapsed < 1600 && parts.some(p => p.y < canvas.height + 20)) requestAnimationFrame(frame); else ctx.clearRect(0, 0, canvas.width, canvas.height);
          })(start);
      }
      window.__mfConfettiFire = fire;
      return fire;
  }
  
  function fireWithConfettiJS() {
      try {
          if (typeof ConfettiGenerator === 'function') {
              var id = 'mf-confetti-canvas';
              var canvas = document.getElementById(id);
              if (!canvas) {
                  canvas = document.createElement('canvas');
                  canvas.id = id;
                  canvas.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:1000002;';
                  document.body.appendChild(canvas);
              }
              var confettiSettings = { target: id, max: 180, size: 1.2, animate: true, respawn: false, props: ['square', 'circle', 'triangle', 'line'] };
              var confettiJs = new ConfettiGenerator(confettiSettings);
              confettiJs.render();
              setTimeout(function () { 
                  try { confettiJs.clear(); } catch (_) { } 
                  try { canvas.remove(); } catch (_) { } 
              }, 1600);
              return true;
          }
      } catch (_) { }
      return false;
  }
  
  function triggerConfetti(opts) {
      var origin = (opts && opts.origin) ? opts.origin : undefined; // {x,y} normalized 0..1
      var z = (opts && opts.zIndex) ? opts.zIndex : 1000000;
      if (fireWithConfettiJS()) return;
      try {
          if (window.tsParticles && typeof window.tsParticles.confetti === 'function') {
              var o = origin || { x: 0.5, y: 0.6 };
              window.tsParticles.confetti({ particleCount: 180, spread: 90, origin: o, position: { x: o.x * (window.innerWidth || 1), y: o.y * (window.innerHeight || 1) } });
              setTimeout(function () { try { document.querySelectorAll('.tsparticles-canvas-el').forEach(function (c) { c.style.zIndex = String(z); c.style.pointerEvents = 'none'; }); } catch (_) { } }, 0);
              return;
          }
      } catch (_) { }
      try { if (typeof confetti === 'function') { confetti({ particleCount: 180, spread: 90, origin: origin || { x: 0.5, y: 0.6 }, zIndex: z }); return; } } catch (_) { }
      try {
          ensureConfettiVendor().then(function () {
              if (fireWithConfettiJS()) return;
              try { if (window.tsParticles && typeof window.tsParticles.confetti === 'function') { var o = origin || { x: 0.5, y: 0.6 }; window.tsParticles.confetti({ particleCount: 180, spread: 90, origin: o, position: { x: o.x * (window.innerWidth || 1), y: o.y * (window.innerHeight || 1) } }); setTimeout(function () { try { document.querySelectorAll('.tsparticles-canvas-el').forEach(function (c) { c.style.zIndex = String(z); c.style.pointerEvents = 'none'; }); } catch (_) { } }, 0); return; } } catch (_) { }
              try { if (typeof confetti === 'function') { confetti({ particleCount: 180, spread: 90, origin: origin || { x: 0.5, y: 0.6 }, zIndex: z }); return; } } catch (_) { }
              try { const fire = ensureInlineConfetti(); var o2 = origin || { x: 0.5, y: 0.6 }; fire({ particleCount: 180, spread: 90, origin: { y: o2.y, x: o2.x } }); } catch (_) { }
          });
      } catch (_) {
          try { const fire = ensureInlineConfetti(); var o3 = origin || { x: 0.5, y: 0.6 }; fire({ particleCount: 180, spread: 90, origin: { y: o3.y, x: o3.x } }); } catch (__) { }
      }
  }
  
  function isTruthy(v) {
      return v === true || v === 'true' || v === 1 || v === '1';
  }
  function getToggleValue(stepSettings, id, label) {
      try {
          const toggles = (stepSettings && (stepSettings.toogle || stepSettings.toggle)) || [];
          const norm = v => (v == null) ? '' : String(v).toLowerCase().trim();
          const targetId = norm(id);
          const targetLabel = norm(label);
          const found = Array.isArray(toggles)
              ? toggles.find(t => t && (norm(t.id) === targetId || (targetLabel && norm(t.label) === targetLabel)))
              : null;
          return found ? found.value : undefined;
      } catch (_) { return undefined; }
  }
  
  // Auto-start evaluator
  function evaluateAutoStartCondition(cond) {
      try {
          const type = String(cond && cond.type || '').toLowerCase();
          if (!type) return false;
          if (type === 'current_page_url') {
              const href = String(window.location && window.location.href || '');
              const matches = Array.isArray(cond.match_values) ? cond.match_values : [];
              const noMatches = Array.isArray(cond.no_match_values) ? cond.no_match_values : [];
              const okMatch = matches.length === 0 ? true : matches.some(v => v && href.includes(String(v)));
              const okNoMatch = noMatches.every(v => !href.includes(String(v)));
              return okMatch && okNoMatch;
          }
          if (type === 'current_time') {
              const now = Date.now();
              const start = Date.parse(cond.initalDateTime || cond.initialDateTime || '');
              const end = Date.parse(cond.finalDateTime || cond.endDateTime || '');
              if (Number.isFinite(start) && Number.isFinite(end)) return now >= start && now <= end;
              if (Number.isFinite(start) && !Number.isFinite(end)) return now >= start;
              if (!Number.isFinite(start) && Number.isFinite(end)) return now <= end;
              return false;
          }
      } catch (_) { }
      return false;
  }
  function evaluateButtonTriggers(triggers) {
      if (!Array.isArray(triggers) || triggers.length === 0) {
          return false;
      }
  
      let result = null;
  
      for (const trigger of triggers) {
          const conditionType = String(trigger.condition_type || 'if').toLowerCase();
          const type = String(trigger.type || '').toLowerCase();
          
          let conditionMet = false;
  
          if (type === 'current_page_url') {
              conditionMet = evaluateUrlCondition(trigger);
          } else if (type === 'current_time') {
              conditionMet = evaluateTimeCondition(trigger);
          } else if (type === 'element_exists' || type === 'css_selector') {
              conditionMet = evaluateElementCondition(trigger);
          }
  
          if (conditionType === 'or') {
              result = result === null ? conditionMet : (result || conditionMet);
          } else {
              result = result === null ? conditionMet : (result && conditionMet);
          }
      }
  
      return !!result;
  }
  
  function evaluateUrlCondition(trigger) {
      const currentUrl = window.location.href.toLowerCase();
      const matchValues = trigger.match_values || [];
      const noMatchValues = trigger.no_match_values || [];
  
      if (matchValues.length > 0) {
          const hasMatch = matchValues.some(url => {
              const urlStr = String(url || '').toLowerCase();
              return currentUrl.includes(urlStr) || currentUrl === urlStr;
          });
          if (!hasMatch) return false;
      }
  
      if (noMatchValues.length > 0) {
          const hasExclusion = noMatchValues.some(url => {
              const urlStr = String(url || '').toLowerCase();
              return currentUrl.includes(urlStr) || currentUrl === urlStr;
          });
          if (hasExclusion) return false;
      }
  
      return true;
  }
  
  function evaluateTimeCondition(trigger) {
      const now = Date.now();
      const start = Date.parse(trigger.initalDateTime || trigger.initialDateTime || '');
      const end = Date.parse(trigger.finalDateTime || trigger.endDateTime || '');
  
      if (Number.isFinite(start) && Number.isFinite(end)) {
          return now >= start && now <= end;
      } else if (Number.isFinite(start) && !Number.isFinite(end)) {
          return now >= start;
      } else if (!Number.isFinite(start) && Number.isFinite(end)) {
          return now <= end;
      }
  
      return false;
  }
  
  function evaluateElementCondition(trigger) {
      try {
          const selector = String(trigger.selector || trigger.value || '');
          if (!selector) return false;
          const element = document.querySelector(selector);
          return !!element;
      } catch (e) {
          return false;
      }
  }
  
  function applyButtonConditions(btnBlock, button) {
      if (!btnBlock || !button) return;

      if (btnBlock.disabled && btnBlock.disabled.enabled === true) {
          const triggers = btnBlock.disabled.conditions || [];
          
          if (triggers.length > 0) {
              const shouldDisable = evaluateButtonTriggers(triggers);
              
              if (shouldDisable) {
                  button.disabled = true;
                  button.style.opacity = '0.5';
                  button.style.cursor = 'not-allowed';
                  button.title = 'This button is currently disabled';
              }
          }
      }
      
      if (btnBlock.hidden && btnBlock.hidden.enabled === true) {
          const triggers = btnBlock.hidden.conditions || [];
          
          if (triggers.length > 0) {
              const shouldHide = evaluateButtonTriggers(triggers);
              
              if (shouldHide) {
                  button.style.display = 'none';
              }
          }
      }
  }
  function shouldAutoStart(setup) {
      try {
          const block = (setup && (setup.settings && setup.settings.auto_start || setup.auto_start)) || {};
          const enabled = isTruthy(block.value);
          if (!enabled) return false;
          const conds = Array.isArray(block.conditions) ? block.conditions : [];
          if (conds.length === 0) return true;
          let acc = null;
          for (const c of conds) {
              const pass = evaluateAutoStartCondition(c);
              const op = String(c && (c.condition_type || c.operator || 'if')).toLowerCase();
              if (op === 'or') acc = (acc === null ? pass : (acc || pass));
              else {
                  acc = (acc === null ? pass : (acc && pass));
              }
          }
          return !!acc;
      } catch (_) { return false; }
  }
  
  function shouldTemporaryHide(setup) {
      try {
          const block = (setup && (setup.settings && setup.settings.temporary_hide || setup.temporary_hide)) || {};
          const enabled = isTruthy(block.value);
          if (!enabled) return false;
          const conds = Array.isArray(block.conditions) ? block.conditions : [];
          if (conds.length === 0) return enabled; 
          let acc = null;
          for (const c of conds) {
              const pass = evaluateAutoStartCondition(c);
              const op = String(c && (c.condition_type || c.operator || 'if')).toLowerCase();
              if (op === 'or') acc = (acc === null ? pass : (acc || pass));
              else { acc = (acc === null ? pass : (acc && pass)); }
          }
          return !!acc;
      } catch (_) { return false; }
  }
  
  function extractTriggersFromBlock(block) {
      try {
          if (!block) return [];
          if (Array.isArray(block.conditions)) return block.conditions;
      } catch (_) { }
      return [];
  }
  function evaluateTriggerBlock(block) {
      try {
          const list = extractTriggersFromBlock(block);
          if (!Array.isArray(list) || list.length === 0) return true; 
          let acc = null;
          for (const c of list) {
              const pass = evaluateAutoStartCondition(c);
              const op = String(c && (c.condition_type || c.operator || 'if')).toLowerCase();
              if (op === 'or') acc = (acc === null ? pass : (acc || pass));
              else { acc = (acc === null ? pass : (acc && pass)); }
          }
          return !!acc;
      } catch (_) { return true; }
  }
  
  function getSelectorValue(selector) {
      if (!selector) return '';
      if (typeof selector === 'string') return selector;
      return selector.value || '';
  }

  function getIfMultipleValue(ifMultiple) {
      if (!ifMultiple) return 'first';
      if (typeof ifMultiple === 'string') return ifMultiple;
      return ifMultiple.value || 'first';
  }

  function selectElementFromArray(elements, ifMultipleValue) {
      if (!elements || elements.length === 0) return null;
      if (ifMultipleValue === 'first' || ifMultipleValue === '0') return elements[0];
      if (ifMultipleValue === 'last') return elements[elements.length - 1];
      if (typeof ifMultipleValue === 'number') return elements[ifMultipleValue] || elements[0];
      return elements[0];
  }
  
  async function getTargetSelectorFromStep(step) {
      try {
          if (step.target && step.target.selector) {
              const selector = getSelectorValue(step.target.selector);
              if (selector) {
                  const element = document.querySelector(selector);
                  if (element) return element;
              }
          }
  
          const legacy = (step.selector || step.target || (step.anchor && step.anchor.selector) || '').trim();
          if (legacy) {
              return legacy;
          }
      } catch (e) {
          console.error('[Modalflow] getTargetSelectorFromStep error:', e);
      }
      return '';
  }
  function cleanupAllBeaconsAndTooltips() {
      try {
          __scrollTracking.beacons.forEach((item) => {
              if (item.cleanup) item.cleanup();
              if (item.element && item.element.parentNode) {
                  item.element.remove();
              }
          });
          __scrollTracking.beacons.clear();
  
          __scrollTracking.tooltips.forEach((item) => {
              if (item.cleanup) item.cleanup();
              if (item.element && item.element.parentNode) {
                  item.element.remove();
              }
          });
          __scrollTracking.tooltips.clear();
  
      } catch (e) {
          console.error('[Modalflow] Cleanup error:', e);
      }
  }
  function getBeaconSelectorFromStep(step) {
      try {
          const blocks = Array.isArray(step && step.blocks) ? step.blocks : [];
          const beacon = blocks.find(b => b && b.type === 'beacon');
          if (!beacon || !beacon.target) return '';
          return getSelectorValue(beacon.target.selector);
      } catch (_) { }
      return '';
  }
  
  async function renderBeaconForStep(step) {
      try {
          const blocks = Array.isArray(step && step.blocks) ? step.blocks : [];
          const beacon = blocks.find(b => b && b.type === 'beacon');

          if (!beacon) {
              return;
          }

          const hideBeaconConfig = beacon.hideBeacon;
          if (hideBeaconConfig && (hideBeaconConfig === true || (hideBeaconConfig.value === true))) {
              const triggers = (hideBeaconConfig.triggers || hideBeaconConfig.conditions || []);
  
              if (triggers.length === 0) {
                  return;
              }
  
              let shouldHide = false;
              for (const trigger of triggers) {
                  const type = String(trigger.type || '').toLowerCase();
                  const conditionType = String(trigger.condition_type || '').toLowerCase();
  
                  if (type === 'current_time') {
                      const now = Date.now();
                      const start = Date.parse(trigger.initalDateTime || trigger.initialDateTime || '');
                      const end = Date.parse(trigger.finalDateTime || trigger.endDateTime || '');
  
                      let timeMatch = false;
                      if (Number.isFinite(start) && Number.isFinite(end)) {
                          timeMatch = now >= start && now <= end;
                      } else if (Number.isFinite(start) && !Number.isFinite(end)) {
                          timeMatch = now >= start;
                      } else if (!Number.isFinite(start) && Number.isFinite(end)) {
                          timeMatch = now <= end;
                      }
  
                      if (conditionType === 'if' && timeMatch) {
                          shouldHide = true;
                          break;
                      }
                  } else if (type === 'current_page_url') {
                      const currentUrl = window.location.href.toLowerCase();
                      const matchValues = trigger.match_values || [];
                      const noMatchValues = trigger.no_match_values || [];
  
                      let urlMatch = false;
  
                      if (matchValues.length > 0) {
                          urlMatch = matchValues.some(url => {
                              const urlStr = String(url || '').toLowerCase();
                              return currentUrl.includes(urlStr) || currentUrl === urlStr;
                          });
                      } else {
                          urlMatch = true;
                      }
  
                      if (noMatchValues.length > 0 && urlMatch) {
                          const excluded = noMatchValues.some(url => {
                              const urlStr = String(url || '').toLowerCase();
                              return currentUrl.includes(urlStr) || currentUrl === urlStr;
                          });
                          if (excluded) urlMatch = false;
                      }
  
                      if (conditionType === 'if' && urlMatch) {
                          shouldHide = true;
                          break;
                      }
                  }
              }
  
              if (shouldHide) {
                  return;
              }
          }
  
          const selector = getSelectorValue(beacon.target.selector);
          let target = null;
          
          if (selector) {
              try {
                  const elementIndex = beacon.target.elementIndex;
                  const hasIndexMap = beacon.target.indexMap && Object.keys(beacon.target.indexMap).length > 0;
                  const hasCssSelectors = Array.isArray(beacon.target.cssSelectors) && beacon.target.cssSelectors.length > 0;
                  
                  if (hasIndexMap || hasCssSelectors || beacon.target.ifMultiple) {
                      const targetElements = Array.from(document.querySelectorAll(selector));
                      if (targetElements.length > 0) {
                          if (elementIndex !== undefined && elementIndex !== null) {
                              const idx = Number(elementIndex);
                              target = targetElements[idx] || targetElements[0];
                          }
                          if (!target && beacon.target.indexMap) {
                              for (const [sel, idx] of Object.entries(beacon.target.indexMap)) {
                                  try {
                                      if (Number(idx) === 0) {
                                          const match = document.querySelector(sel);
                                          if (match) {
                                              target = match;
                                              break;
                                          }
                                      } else {
                                          const matches = Array.from(document.querySelectorAll(sel));
                                          if (matches.length > Number(idx)) {
                                              target = matches[Number(idx)];
                                              break;
                                          }
                                      }
                                  } catch (_) { }
                              }
                          }
                          if (!target && Array.isArray(beacon.target.cssSelectors)) {
                              const idx = elementIndex !== undefined ? Number(elementIndex) : 0;
                              for (const sel of beacon.target.cssSelectors) {
                                  try {
                                      if (idx === 0) {
                                          const match = document.querySelector(sel);
                                          if (match) {
                                              target = match;
                                              break;
                                          }
                                      } else {
                                          const matches = Array.from(document.querySelectorAll(sel));
                                          if (matches.length > 0) {
                                              target = matches[idx] || matches[0];
                                              break;
                                          }
                                      }
                                  } catch (_) { }
                              }
                          }
                          if (!target) {
                              target = selectElementFromArray(targetElements, getIfMultipleValue(beacon.target.ifMultiple));
                          }
                      }
                  } else {
                      target = document.querySelector(selector);
                  }
              } catch (e) {
                  console.error('[Modalflow] Invalid selector for beacon:', selector, e);
              }
          }
          
          if (!target && beacon.target.xpath) {
              try {
                  const xpathResult = document.evaluate(beacon.target.xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                  if (xpathResult.singleNodeValue) {
                      target = xpathResult.singleNodeValue;
                  }
              } catch (e) {
                  console.warn('[Modalflow] Invalid xpath for beacon:', beacon.target.xpath, e);
              }
          }
          
          let useCoordinates = false;
          if (!target && beacon.target.coordinates) {
              const coords = beacon.target.coordinates;
              if (coords.x !== undefined && coords.y !== undefined && coords.width !== undefined && coords.height !== undefined) {
                  useCoordinates = true;
              }
          }
          
          if (!target && !useCoordinates) {
              return;
          }

          const posConfig = beacon.position;
  
          function findScrollableParent(element) {
              if (!element) return window;
  
              let parent = element.parentElement;
              while (parent) {
                  const overflow = window.getComputedStyle(parent).overflow;
                  const overflowY = window.getComputedStyle(parent).overflowY;
                  const overflowX = window.getComputedStyle(parent).overflowX;
  
                  if (overflow === 'auto' || overflow === 'scroll' ||
                      overflowY === 'auto' || overflowY === 'scroll' ||
                      overflowX === 'auto' || overflowX === 'scroll') {
                      return parent;
                  }
                  parent = parent.parentElement;
              }
              return window;
          }
  
          const scrollableContainer = target ? findScrollableParent(target) : window;
          
          let virtualRect = null;
          if (!target && useCoordinates && beacon.target && beacon.target.coordinates) {
              const coords = beacon.target.coordinates;
              virtualRect = {
                  left: coords.x !== undefined ? coords.x : (coords.left || 0),
                  top: coords.y !== undefined ? coords.y : (coords.top || 0),
                  right: (coords.x !== undefined ? coords.x : (coords.left || 0)) + (coords.width || 0),
                  bottom: (coords.y !== undefined ? coords.y : (coords.top || 0)) + (coords.height || 0),
                  width: coords.width || 0,
                  height: coords.height || 0
              };
          }
  
          const arrow = document.createElement('div');
          arrow.className = 'mf-dancing-arrow';
          arrow.style.position = 'fixed';
          arrow.style.zIndex = '1000000';
          arrow.innerHTML = '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 19L12 5M12 5L7 10M12 5L17 10" stroke="#0000ff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="12" r="11" stroke="#0000ff" stroke-width="1.5" fill="transparent" opacity="0.9"/></svg>';
  
          const b = document.createElement('div');
          b.className = 'mf-beacon hidden';
          b.style.position = 'fixed';
          b.style.zIndex = '1000001';
  
          let isScrolling = false;
          let scrollTimeout;
          let lastUpdateTime = 0;
          let isTargetInView = false;
  
          function getTargetRect() {
              if (target) {
                  return target.getBoundingClientRect();
              } else if (virtualRect) {
                  const scrollX = window.pageXOffset || document.documentElement.scrollLeft || 0;
                  const scrollY = window.pageYOffset || document.documentElement.scrollTop || 0;
                  return {
                      left: virtualRect.left - scrollX,
                      top: virtualRect.top - scrollY,
                      right: virtualRect.right - scrollX,
                      bottom: virtualRect.bottom - scrollY,
                      width: virtualRect.width,
                      height: virtualRect.height
                  };
              }
              return null;
          }
  
          function isElementInViewport(el) {
              try {
                  if (el) {
                      const rect = el.getBoundingClientRect();
                      const windowHeight = window.innerHeight || document.documentElement.clientHeight;
                      const windowWidth = window.innerWidth || document.documentElement.clientWidth;
  
                      const vertInView = (rect.top <= windowHeight) && ((rect.top + rect.height) >= 0);
                      const horInView = (rect.left <= windowWidth) && ((rect.left + rect.width) >= 0);
  
                      return vertInView && horInView;
                  } else if (virtualRect) {
                      const rect = getTargetRect();
                      if (!rect) return false;
                      const windowHeight = window.innerHeight || document.documentElement.clientHeight;
                      const windowWidth = window.innerWidth || document.documentElement.clientWidth;
                      
                      const vertInView = (rect.top <= windowHeight) && ((rect.top + rect.height) >= 0);
                      const horInView = (rect.left <= windowWidth) && ((rect.left + rect.width) >= 0);
                      
                      return vertInView && horInView;
                  }
                  return false;
              } catch (e) {
                  return false;
              }
          }
          function positionArrow() {
              try {
                  const rect = getTargetRect();
                  if (!rect) return null;
                  const windowHeight = window.innerHeight || document.documentElement.clientHeight;
                  const windowWidth = window.innerWidth || document.documentElement.clientWidth;
  
                  const size = 16;
                  let beaconX = rect.right - size / 2;
                  let beaconY = rect.top - size / 2;
  
                  if (posConfig && posConfig.value === true) {
                      const opt = posConfig.optionValue || 'topRight';
                      const vOff = Number(posConfig.vertical) || 0;
                      const hOff = Number(posConfig.horizontal) || 0;
  
                      if (opt === 'topLeft') {
                          beaconX = rect.left - size / 2;
                          beaconY = rect.top - size / 2;
                      } else if (opt === 'topRight') {
                          beaconX = rect.right - size / 2;
                          beaconY = rect.top - size / 2;
                      } else if (opt === 'bottomLeft') {
                          beaconX = rect.left - size / 2;
                          beaconY = rect.bottom - size / 2;
                      } else if (opt === 'bottomRight') {
                          beaconX = rect.right - size / 2;
                          beaconY = rect.bottom - size / 2;
                      } else if (opt === 'center') {
                          beaconX = rect.left + (rect.width / 2) - size / 2;
                          beaconY = rect.top + (rect.height / 2) - size / 2;
                      }
  
                      beaconX += hOff;
                      beaconY += vOff;
                  }
  
                  let arrowX, arrowY;
                  let rotation = 0;
  
                  if (beaconY > windowHeight) {
                      arrowX = beaconX;
                      arrowY = windowHeight - 60;
                      rotation = 180;
                  } else if (beaconY < 0) {
                      arrowX = beaconX;
                      arrowY = 20;
                      rotation = 0;
                  } else if (beaconX > windowWidth) {
                      arrowX = windowWidth - 60;
                      arrowY = beaconY;
                      rotation = 90;
                  } else if (beaconX < 0) {
                      arrowX = 20;
                      arrowY = beaconY;
                      rotation = -90;
                  } else {
                      return null;
                  }
                  arrowX = Math.max(20, Math.min(arrowX, windowWidth - 60));
                  arrowY = Math.max(20, Math.min(arrowY, windowHeight - 60));
  
                  arrow.style.left = arrowX + 'px';
                  arrow.style.top = arrowY + 'px';
                  arrow.style.transform = 'rotate(' + rotation + 'deg)';
                  arrow.style.transformOrigin = 'center center';
  
                  return { x: arrowX, y: arrowY, rotation, beaconY, windowHeight };
              } catch (e) {
                  return null;
              }
          }
  
          function updateBeaconPosition() {
              try {
                  const now = Date.now();
                  const timeSinceLastUpdate = now - lastUpdateTime;
                  if (timeSinceLastUpdate < 16) return;
                  lastUpdateTime = now;
  
                  const rect = getTargetRect();
                  if (!rect) return;
                  
                  const size = 16;
                  const inView = isElementInViewport(target);
  
                  if (inView !== isTargetInView) {
                      isTargetInView = inView;
                  }
  
                  if (!inView) {
                      b.classList.add('hidden');
                      arrow.style.display = 'flex';
                      const arrowPos = positionArrow();
                      return;
                  }
                  arrow.style.display = 'none';
                  b.classList.remove('hidden');
                  let translateX = rect.right - size / 2;
                  let translateY = rect.top - size / 2;
  
                  if (posConfig && posConfig.value === true) {
                      const opt = posConfig.optionValue || 'topRight';
                      const vOff = Number(posConfig.vertical) || 0;
                      const hOff = Number(posConfig.horizontal) || 0;
  
                      if (opt === 'topLeft') {
                          translateX = rect.left - size / 2;
                          translateY = rect.top - size / 2;
                      } else if (opt === 'topRight') {
                          translateX = rect.right - size / 2;
                          translateY = rect.top - size / 2;
                      } else if (opt === 'bottomLeft') {
                          translateX = rect.left - size / 2;
                          translateY = rect.bottom - size / 2;
                      } else if (opt === 'bottomRight') {
                          translateX = rect.right - size / 2;
                          translateY = rect.bottom - size / 2;
                      } else if (opt === 'center') {
                          translateX = rect.left + (rect.width / 2) - size / 2;
                          translateY = rect.top + (rect.height / 2) - size / 2;
                      }
  
                      translateX += hOff;
                      translateY += vOff;
                  }
  
                  translateX = Math.max(0, Math.min(translateX, window.innerWidth - size));
                  translateY = Math.max(0, Math.min(translateY, window.innerHeight - size));
  
                  b.style.transform = 'translate3d(' + translateX + 'px, ' + translateY + 'px, 0px)';
                  b.style.left = '0';
                  b.style.top = '0';
  
              } catch (e) {
                  console.error('[Modalflow] Error updating beacon position:', e);
              }
          }
  
          overlay.appendChild(arrow);
          overlay.appendChild(b);
  
          updateBeaconPosition();
  
          const handleScroll = (event) => {
              isScrolling = true;
  
              clearTimeout(scrollTimeout);
              scrollTimeout = setTimeout(() => {
                  isScrolling = false;
              }, 150);
  
              updateBeaconPosition();
          };
  
          const handleResize = () => {
              updateBeaconPosition();
          };
  
          const scrollTargets = [window, document, document.documentElement, document.body];
          scrollTargets.forEach(target => {
              if (target) {
                  target.addEventListener('scroll', handleScroll, { passive: true, capture: true });
              }
          });
  
          window.addEventListener('resize', handleResize, { passive: true });
  
          if (window.visualViewport) {
              window.visualViewport.addEventListener('scroll', handleScroll, { passive: true });
          }
  
          if (scrollableContainer && scrollableContainer !== window) {
              scrollableContainer.addEventListener('scroll', handleScroll, { passive: true });
          }
  
          b._cleanup = () => {
              scrollTargets.forEach(target => {
                  if (target) {
                      target.removeEventListener('scroll', handleScroll, { capture: true });
                  }
              });
  
              window.removeEventListener('resize', handleResize);
  
              if (window.visualViewport) {
                  window.visualViewport.removeEventListener('scroll', handleScroll);
              }
  
              if (scrollableContainer && scrollableContainer !== window) {
                  scrollableContainer.removeEventListener('scroll', handleScroll);
              }
  
              clearInterval(scrollDetectionInterval);
              clearTimeout(scrollTimeout);
  
              if (arrow && arrow.parentNode) arrow.remove();
              if (b && b.parentNode) b.remove();
  
          };
  
      } catch (e) {
          console.error('[Modalflow] renderBeaconForStep error:', e);
      }
  }
  
  function removeAllBoxes() {
      try {
          const els = document.querySelectorAll('[data-modalflow-box="1"]');
          els.forEach(e => {
              if (e._cleanupTooltipListeners && typeof e._cleanupTooltipListeners === 'function') {
                  try {
                      e._cleanupTooltipListeners();
                  } catch (cleanupError) {
                      console.error('[Modalflow] Error cleaning up tooltip listeners:', cleanupError);
                  }
              }
              e.remove();
          });
          
          const avatars = document.querySelectorAll('[data-modalflow-avatar="1"]');
          avatars.forEach(av => av.remove());
      } catch (_) { }
  }
  
  function drawSpotlightAroundTarget(overlayRoot, rect, padding = 0, blockTargetClicks = false, onTargetClick = null) {
      try { overlayRoot.innerHTML = ''; } catch (_) { }
      const vw = Math.max(document.documentElement.clientWidth || 0, window.innerWidth || 0);
      const vh = Math.max(document.documentElement.clientHeight || 0, window.innerHeight || 0);

      const toNums = (val) => {
          if (Array.isArray(val)) return val.map(v => Number(v) || 0);
          const n = Number(val);
          return Number.isFinite(n) ? [n, n, n, n] : [0, 0, 0, 0];
      };
      const pads = toNums(padding);
      const pTop = pads[0];
      const pRight = (pads[1] !== undefined ? pads[1] : pads[0]);
      const pBottom = (pads[2] !== undefined ? pads[2] : pads[0]);
      const pLeft = (pads[3] !== undefined ? pads[3] : (pads[1] !== undefined ? pads[1] : pads[0]));
      const r = {
          top: Math.max(0, rect.top - pTop),
          left: Math.max(0, rect.left - pLeft),
          right: Math.min(vw, rect.right + pRight),
          bottom: Math.min(vh, rect.bottom + pBottom)
      };
      const mk = (t, l, w, h) => {
          const d = document.createElement('div');
          d.style.position = 'fixed';
          d.style.top = t + 'px';
          d.style.left = l + 'px';
          d.style.width = w + 'px';
          d.style.height = h + 'px';
          d.style.background = 'rgba(0,0,0,0.4)';
          d.style.zIndex = '999999';
          d.style.pointerEvents = 'auto';
          return d;
      };
      const topSeg = mk(0, 0, vw, Math.max(0, r.top));
      const leftSeg = mk(r.top, 0, Math.max(0, r.left), Math.max(0, r.bottom - r.top));
      const rightSeg = mk(r.top, Math.max(0, r.right), Math.max(0, vw - r.right), Math.max(0, r.bottom - r.top));
      const bottomSeg = mk(Math.max(0, r.bottom), 0, vw, Math.max(0, vh - r.bottom));
      overlayRoot.appendChild(topSeg); overlayRoot.appendChild(leftSeg); overlayRoot.appendChild(rightSeg); overlayRoot.appendChild(bottomSeg);
      if (blockTargetClicks) {
          const blocker = mk(r.top, r.left, Math.max(0, r.right - r.left), Math.max(0, r.bottom - r.top));
          blocker.style.background = 'rgba(0,0,0,0)';
          if (typeof onTargetClick === 'function') {
              blocker.addEventListener('click', onTargetClick);
          }
          overlayRoot.appendChild(blocker);
      }
  }
  
  try {
      const existingOverlay = document.getElementById('modalflow-guide-overlay');
      if (existingOverlay) {
          if (!window.__MF_FLOW_STACK__) window.__MF_FLOW_STACK__ = [];
          const existingFlowId = existingOverlay.getAttribute('data-flow-id');
          if (existingFlowId && existingOverlay.style.display !== 'none') {
              existingOverlay.style.display = 'none';
              window.__MF_FLOW_STACK__.push({ overlay: existingOverlay, flowId: existingFlowId });
          } else {
              existingOverlay.remove();
          }
      }
      document.querySelectorAll('[data-modalflow-box="1"]').forEach(el => el.remove());
      document.querySelectorAll('.mf-beacon').forEach(el => el.remove());
      document.querySelectorAll('[data-mf-highlight]').forEach(el => el.remove());
  } catch (_) { }
  
  const currentFlowId = window.__CURRENT_FLOW_ID__ || '';
  
  const overlay = createEl("div", {
      id: "modalflow-guide-overlay",
      'data-flow-id': currentFlowId,
      style: "position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; z-index: 999999; font-family: sans-serif;"
  });
  document.body.appendChild(overlay);
  
  let __MF_timers = [];
  function trackTimer(id) { try { __MF_timers.push(id); } catch (_) { } }
  function clearPendingTimers() {
      try {
          (__MF_timers || []).forEach(id => { try { clearTimeout(id); } catch (_) { } });
          __MF_timers = [];
      } catch (_) { }
  }
  function endGuide(opts) {
      opts = opts || {};
      const closeAll = opts.closeAll === true;
      let currentFlowId = null;
      try {
          const ov = document.getElementById('modalflow-guide-overlay');
          if (ov) {
              currentFlowId = ov.getAttribute('data-flow-id');
          }
          
          if (currentFlowId) {
              if (window.modal && typeof window.modal._markAutoStartFlowDismissed === 'function') {
                  const autoStartSettings = window.modal._autoStartSettings?.[currentFlowId];
                  const flowsMeta = window.modal._flowsMeta || {};
                  const isInFlowsMeta = flowsMeta[currentFlowId] || 
                      Object.values(flowsMeta || {}).some(fm => (fm.flow_ref || '') === currentFlowId);
                  
                  if ((autoStartSettings && autoStartSettings.value === true) || isInFlowsMeta) {
                      window.modal._markAutoStartFlowDismissed(currentFlowId);
                  }
              }
          }
      } catch (e) {
          console.error('[ModalFlow] Error tracking dismissed flow:', e);
      }
      
      try { clearPendingTimers(); } catch (_) { }
      try { removeAllBoxes(); } catch (_) { }
      try { cleanupAllBeaconsAndTooltips(); } catch (_) { }
      try { enableScroll(); } catch (_) { }
      
      let prevOverlay = null;
      try {
          if (window.__MF_FLOW_STACK__ && window.__MF_FLOW_STACK__.length > 0) {
              if (closeAll) {
                  while (window.__MF_FLOW_STACK__.length > 0) {
                      const entry = window.__MF_FLOW_STACK__.pop();
                      if (entry && entry.overlay && entry.overlay.parentNode) entry.overlay.remove();
                  }
              } else {
                  const entry = window.__MF_FLOW_STACK__.pop();
                  if (entry && entry.overlay && entry.overlay.parentNode) prevOverlay = entry;
              }
          }
      } catch (_) { }
      
      try {
          let ov;
          while ((ov = document.getElementById('modalflow-guide-overlay')) != null) {
              ov.remove();
          }
      } catch (_) { }
      
      if (prevOverlay) {
          try {
              prevOverlay.overlay.style.display = '';
              const flowId = prevOverlay.flowId;
              if (flowId) {
                  window.__CURRENT_FLOW_ID__ = flowId;
                  try { sessionStorage.setItem('modalflow_active_flow_id', flowId); } catch (_) { }
              }
          } catch (_) { }
      }
      
      if (!prevOverlay) {
          try {
              sessionStorage.removeItem('modalflow_active_flow_id');
              delete window.__CURRENT_FLOW_ID__;
          } catch (e) {}
      }
      
      if (currentFlowId && window.modal && typeof window.modal._updateLauncherVisibilityForFlow === 'function') {
          try {
              window.modal._refreshLauncherVisibilityWithRaf(currentFlowId, [0, 120, 320]);
          } catch (e) {}
      }
  }
  
  function showRestartMenu() {
      try {
          enableScroll();
          const wrap = createEl('div', { style: 'position:fixed; inset:0; display:flex; align-items:center; justify-content:center; z-index:1000002; background:rgba(0,0,0,.25);' });
          const box = createEl('div', { style: 'background:var(--ms-theme-background,#fff); border-radius:12px; padding:20px 24px; min-width:260px; max-width:90vw; box-shadow:0 10px 30px rgba(0,0,0,.25); text-align:center;' });
          const h = createEl('div', { style: 'font-size:22px; font-weight:600; margin-bottom:12px;' }, 'Menu');
          const mkBtn = (txt) => createEl('button', { class: 'mf-btn', style: 'display:block; width:100%; margin:10px 0; font-size:16px;' }, txt);
          const closeBtn = mkBtn('Close guide');
          const restartBtn = mkBtn('Start over');
          const returnBtn = mkBtn('Return to guide');
          closeBtn.onclick = () => {
              try { if (wrap.parentNode) document.body.removeChild(wrap); } catch (_) { }
              try { enableScroll(); endGuide({ closeAll: true }); } catch (_) { }
          };
          restartBtn.onclick = () => { try { document.body.removeChild(wrap); } catch (_) { } try { removeAllBoxes(); renderStep(0); } catch (_) { } };
          returnBtn.onclick = () => { try { document.body.removeChild(wrap); } catch (_) { } try { removeAllBoxes(); renderStep(__lastStepIndex); } catch (_) { } };
          box.append(h, closeBtn, restartBtn, returnBtn);
          wrap.appendChild(box);
          document.body.appendChild(wrap);
      } catch (_) { }
  }
  
  async function renderStep(index) {
      const renderStartTime = Date.now();
      window.__MF_RENDER_START_TIME__ = renderStartTime;
      const step = guideData[index];
      if (!step) {
          return;
      }
      overlay.innerHTML = "";
      overlay.style.pointerEvents = 'none';
      const existingAvatars = document.querySelectorAll('[data-modalflow-avatar="1"]');
      existingAvatars.forEach(av => av.remove());
      __lastStepIndex = index;
      try {
          clearForcedStartParam();
      } catch (_) { }
      try {
          const blocks = Array.isArray(step.blocks) ? step.blocks : [];
          const triggerBlocks = blocks.filter(b => b && b.type === 'trigger');
          if (triggerBlocks.length > 0) {
              let triggerMatched = false;
              for (const trig of triggerBlocks) {
                  const conditionsPass = evaluateTriggerBlock(trig);
                  if (!conditionsPass) continue;
                  triggerMatched = true;
                  try {
                      const actions = Array.isArray(trig.actions) ? trig.actions : [];
                      if (actions.length > 0) {
                          const defaultStepIndex = (index < guideData.length - 1) ? index + 1 : 0;
                          executeStepActions(actions, { sortDismissFirst: false, continueAfterStartFlow: true, defaultStepIndex: defaultStepIndex });
                      }
                  } catch (_) { }
                  break;
              }
              if (triggerMatched) return;
          }
      } catch (_) { }
      setTimeout(() => renderBeaconForStep(step), 0);

      const getStepType = (step) => step.type || "modal";
      
      const getStepTheme = (step) => {
          if (!step.theme) return null;
          return typeof step.theme === 'string' ? step.theme : (step.theme.value || step.theme.mode);
      };
      
      const getStepWidth = (step) => step.width !== undefined ? String(step.width) : null;
      
      const getStepBlocks = (step) => Array.isArray(step.blocks) ? step.blocks : [];
      
      const getStepExplicitCompletion = (step) => step.explicitCompletion !== undefined ? step.explicitCompletion : false;
      
      const getStepAddConfetti = (step) => step.addConfetti !== undefined ? step.addConfetti : false;
      
      const getStepAddBackdrop = (step) => step.addBackdrop !== undefined ? step.addBackdrop : false;

      const stepType = getStepType(step);
      let themeValue = getStepTheme(step);
      const globalThemeSetting = setup?.theme;
      if (!themeValue) {
          themeValue = globalThemeSetting;
      }
      const theme = themeValue ? themeValue : "light";
      if (stepType === "modal") {
          disableScroll();
      } else if (stepType === "tooltip" || stepType === "bubble") {
          enableScroll();
      }
      const widthValue = getStepWidth(step);
      const width = widthValue || ((stepType === "bubble" || stepType === "tooltip") ? 300 : 400);
      const addConfettiFirst = getStepAddConfetti(step);
      if (addConfettiFirst && !step.__confettiShown) {
          try { step.__confettiShown = true; } catch (_) { }
          try {
              var o = { x: 0.5, y: 0.6 };
              if (stepType === 'bubble') {
                  o = { x: 0.06, y: 0.94 };
              } else {
                  try {
                      var rawSel = getTargetSelectorFromStep(step);
                      var sel = rawSel;
                      if (sel && !(sel.startsWith('#') || sel.startsWith('.') || sel.startsWith('['))) sel = '#' + sel;
                      var t = sel ? document.querySelector(sel) : null;
                      if (t) {
                          var r = t.getBoundingClientRect();
                          var vw = Math.max(document.documentElement.clientWidth || 0, window.innerWidth || 1);
                          var vh = Math.max(document.documentElement.clientHeight || 0, window.innerHeight || 1);
                          var cy = (r.top + r.height / 2) / vh;
                          var y = cy < 0.5 ? Math.max(0.05, (r.bottom + 8) / vh) : Math.max(0.05, (r.top - 8) / vh);
                          var x = Math.min(0.98, Math.max(0.02, (r.left + r.width * 0.5) / vw));
                          o = { x: x, y: Math.min(0.98, y) };
                      }
                  } catch (_) { }
              }
              triggerConfetti({ origin: o, zIndex: 999999 });
          } catch (_) { }
          trackTimer(setTimeout(() => { try { renderStep(index); } catch (_) { } }, 600));
          return;
      }
  
      if (stepType === "modal") {
          const hasBackdrop = getStepAddBackdrop(step);
          overlay.style.background = hasBackdrop ? "rgba(0,0,0,0.5)" : "rgba(0,0,0,0.3)";
          overlay.style.pointerEvents = "auto"; // Block clicks on background
      } else {
          overlay.style.background = "transparent";
          overlay.style.pointerEvents = "none";
      }
  
      const progressPercent = ((index + 1) / guideData.length) * 100;
  
      const stepBox = createEl("div", {
          class: "mf-step-box" + (theme === "dark" ? " dark" : " light"),
          "data-modalflow-box": "1"
      });
      try {
          if (window.__MF_POPOVER_SHIELD__ && window.__MF_POPOVER_SHIELD__.stopBubbleOnBox) {
              window.__MF_POPOVER_SHIELD__.stopBubbleOnBox(stepBox);
          }
      } catch (_) { }
      if (stepType === "modal") {
          const modalWidth = width || 400; 
          stepBox.style.minWidth = modalWidth + 'px';
          stepBox.style.width = '90vw'; 
          stepBox.style.maxHeight = '80vh';
          stepBox.style.overflow = 'hidden';
          stepBox.style.display = 'flex';
          stepBox.style.flexDirection = 'column';

      } else if (stepType === "tooltip" || stepType === "bubble") {
          const tooltipWidth = width || 300; 
          stepBox.style.minWidth = tooltipWidth + 'px';
          stepBox.style.width = '90vw'; 
  
      }
      const addProgressBar = (positionPref) => {
          const pb = createEl("div", { class: "mf-progress-bar" });
          const fill = createEl("div", { class: "mf-progress-fill" });
          fill.style.width = progressPercent + "%";
          
          if (!positionPref || positionPref === 'belowTarget') {
              pb.style.bottom = '0';
              pb.style.borderRadius = '0 0 10px 10px';
          } else if (positionPref === 'aboveTarget') {
              pb.style.top = '0';
              pb.style.borderRadius = '10px 10px 0 0';
          } else {
              pb.style.bottom = '0';
              pb.style.borderRadius = '0 0 10px 10px';
          }
          
          pb.appendChild(fill);
          stepBox.appendChild(pb);
      };
      
      function executeStepActions(actions, opts) {
          if (!Array.isArray(actions) || actions.length === 0) return;
          opts = opts || {};
          const sortDismissFirst = opts.sortDismissFirst !== false;
          const continueAfterStartFlow = opts.continueAfterStartFlow === true;
          const defaultStepIndex = opts.defaultStepIndex;
          try {
              const isDismiss = (act) => {
                  if (!act || typeof act !== 'object') return false;
                  const t = String(act.type || act.id || act.action || act.condition_type || '').toLowerCase();
                  return t === 'dismissflow' || t === 'dismiss';
              };
              const list = sortDismissFirst
                  ? [...actions].sort((a, b) => {
                        const aDismiss = isDismiss(a);
                        const bDismiss = isDismiss(b);
                        if (aDismiss && !bDismiss) return -1;
                        if (!aDismiss && bDismiss) return 1;
                        return 0;
                    })
                  : actions;
              for (const act of list) {
                  if (!act || typeof act !== 'object') continue;
                  const actionType = String(act.type || act.id || act.action || act.condition_type || '').toLowerCase();
                  if (actionType === 'dismissflow' || actionType === 'dismiss') {
                      endGuide();
                      continue;
                  }
                  if (actionType === 'navigatetopage') {
                      const url = act.pageUrl || act.url || act.value;
                      if (!url) continue;
                      const newTab = !!(act.openInNewTab || act.newTab);
                      const goToStepAction = list.find(a => {
                          const t = String(a.type || a.id || a.action || '').toLowerCase();
                          return t === 'gotostep' || t === 'next';
                      });
                      let targetIdx = defaultStepIndex;
                      if (goToStepAction) {
                          targetIdx = Number(goToStepAction.stepId || goToStepAction.step_id || goToStepAction.value);
                          if (!Number.isFinite(targetIdx)) {
                              const i = guideData.findIndex(s => String(s.id) === String(goToStepAction.stepId || goToStepAction.step_id || goToStepAction.value));
                              if (i >= 0) targetIdx = i;
                          }
                      }
                      if (Number.isFinite(targetIdx)) {
                          try { setForcedStartStep(targetIdx); localStorage.setItem('MF_START_STEP', String(targetIdx)); } catch (_) { }
                          const newUrl = addMfStartToUrl(url, targetIdx);
                          if (newTab) { window.open(String(newUrl), '_blank'); requestAnimationFrame(() => { removeAllBoxes(); renderStep(targetIdx); }); } else { window.location.href = String(newUrl); }
                          return;
                      }
                      if (newTab) window.open(String(url), '_blank'); else window.location.href = String(url);
                      return;
                  }
                  if (actionType === 'gotostep' || actionType === 'next') {
                      let targetIdx = Number(act.stepId || act.step_id || act.value);
                      if (!Number.isFinite(targetIdx)) {
                          const i = guideData.findIndex(s => String(s.id) === String(act.stepId || act.step_id || act.value));
                          if (i >= 0) targetIdx = i;
                      }
                      if (Number.isFinite(targetIdx)) { requestAnimationFrame(() => { removeAllBoxes(); renderStep(Number(targetIdx)); }); return; }
                  }
                  if (actionType === 'startflow' || actionType === 'start_flow') {
                      const targetFlowId = act.flowRef || act.flowid || act.flowId || act.flow_ref;
                      const targetStepId = act.stepid || act.stepId || act.step_id;
                      const refKey = window.__modalFlowRefKey?.key || '';
                      const envKey = window.__modalFlowEnvKey || '';
                      const sdk = window.modal || {};
                      const flowVersionId = act.flow_version_id || act.flowVersionId || sdk._launcherFlowVersionIds?.[targetFlowId] || null;
                      const environmentId = sdk._environmentId || envKey || null;
                      if (targetFlowId && sdk._loadFlowFromApi) {
                          sdk._loadFlowFromApi(targetFlowId, flowVersionId, environmentId).then((result) => {
                              if (result && sdk._executeFlow) {
                                  if (targetStepId) sdk._executeFlow(targetFlowId, refKey, { startStepId: targetStepId, fromLauncher: true });
                                  else sdk._executeFlow(targetFlowId, refKey);
                              }
                          }).catch(err => { console.error("[ModalFlow] Failed to load flow from API:", err); });
                      }
                      if (!continueAfterStartFlow) return;
                      continue;
                  }
                  if (actionType === 'evaluatejavascript' && act.value) { try { Function(String(act.value))(); } catch (_) { } }
              }
          } catch (e) {
              console.error('[ModalFlow] Error running step actions:', e);
          }
      }
      
      if (stepType !== "tooltip" && stepType !== "bubble") {
          addProgressBar();
      }
  
      if (stepType === "tooltip" || stepType === "bubble") {
          let targetElement = null;
          let positionPref = 'belowTarget';
          let addBackdrop = false;
          let blockTargetClicks = false;
          let backdropPadding = 0;
          let absXY = null;
          try {
              if (step.target) {
                  const isSelectElement = typeof step.target.selector === 'string' || 
                                          step.target.cssSelectors || 
                                          step.target.selectorInfo || 
                                          (step.target.text && typeof step.target.text === 'string') ||
                                          step.target.xpath;
                  
                  const isGoManual = step.target.selector && 
                                     typeof step.target.selector === 'object' && 
                                     step.target.selector.type && 
                                     step.target.selector.value &&
                                     step.target.ifMultiple;
                  
                  if (isSelectElement && !targetElement) {
                      if (!targetElement && step.target.id) {
                          const idValue = step.target.id.trim();
                          try {
                              const element = document.getElementById(idValue);
                              if (element) {
                                  if (step.target.class || step.target.tag || step.target.text || step.target.href) {
                                      if (isExactElementMatch(element, step.target)) {
                                          targetElement = element;
                                      }
                                  } else {
                                      targetElement = element;
                                  }
                              }
                          } catch (e) {
                              console.warn('[Modalflow] Invalid id:', idValue, e);
                          }
                      }
                      
                      if (!targetElement && step.target.selectorInfo && Array.isArray(step.target.selectorInfo)) {
                          const sortedSelectorInfo = [...step.target.selectorInfo].sort((a, b) => {
                              if (b.matches !== a.matches) return b.matches - a.matches;
                              return (b.specificity || 0) - (a.specificity || 0);
                          });
                          
                          for (const info of sortedSelectorInfo) {
                              if (targetElement) break; // Early exit if already found
                              try {
                                  const idx = info.index !== undefined ? info.index : 0;
                                  if (idx === 0) {
                                      const candidate = document.querySelector(info.selector);
                                      if (candidate && isExactElementMatch(candidate, step.target)) {
                                          targetElement = candidate;
                                          break;
                                      }
                                  }
                                  const elements = document.querySelectorAll(info.selector);
                                  if (elements.length > 0) {
                                      const candidate = elements[idx] || elements[0];
                                      if (isExactElementMatch(candidate, step.target)) {
                                          targetElement = candidate;
                                          break;
                                      }
                                      for (let i = 0; i < elements.length; i++) {
                                          if (isExactElementMatch(elements[i], step.target)) {
                                              targetElement = elements[i];
                                              break;
                                          }
                                      }
                                      if (targetElement) break;
                                  }
                              } catch (e) {
                                  // Continue to next selector
                              }
                          }
                      }
                      
                      if (!targetElement && step.target.selector && typeof step.target.selector === 'string') {
                          const cssSelector = step.target.selector.trim();
                          const ifMultiple = step.target.ifMultiple?.value || step.target.ifMultiple || 'first';
                          try {
                              if (ifMultiple === 'first' || ifMultiple === '0') {
                                  const element = document.querySelector(cssSelector);
                                  if (element && isExactElementMatch(element, step.target)) {
                                      targetElement = element;
                                  }
                              } else {
                                  const elements = document.querySelectorAll(cssSelector);
                                  if (elements.length > 0) {
                                      const selected = selectElementFromArray(elements, getIfMultipleValue(ifMultiple));
                                      if (selected && isExactElementMatch(selected, step.target)) {
                                          targetElement = selected;
                                      } else {
                                          for (let i = 0; i < elements.length; i++) {
                                              if (isExactElementMatch(elements[i], step.target)) {
                                                  targetElement = elements[i];
                                                  break;
                                              }
                                          }
                                      }
                                  }
                              }
                          } catch (e) {
                              console.warn('[Modalflow] Invalid CSS selector:', cssSelector, e);
                          }
                      }
                      
                      if (!targetElement && step.target.cssSelectors && Array.isArray(step.target.cssSelectors) && step.target.cssSelectors.length > 0) {
                          const firstSelector = step.target.cssSelectors[0];
                          const elementIndex = step.target.elementIndex !== undefined ? step.target.elementIndex : 0;
                          try {
                              if (elementIndex === 0) {
                                  const candidate = document.querySelector(firstSelector);
                                  if (candidate && isExactElementMatch(candidate, step.target)) {
                                      targetElement = candidate;
                                  }
                              } else {
                                  const elements = document.querySelectorAll(firstSelector);
                                  if (elements.length > 0) {
                                      const candidate = elements[elementIndex] || elements[0];
                                      if (isExactElementMatch(candidate, step.target)) {
                                          targetElement = candidate;
                                      } else {
                                          for (let i = 0; i < elements.length; i++) {
                                              if (isExactElementMatch(elements[i], step.target)) {
                                                  targetElement = elements[i];
                                                  break;
                                              }
                                          }
                                      }
                                  }
                              }
                          } catch (e) {
                              console.warn('[Modalflow] Invalid CSS selector:', firstSelector, e);
                          }
                      }
                      
                      if (!targetElement && (step.target.id || step.target.class || step.target.tag || step.target.href)) {
                          const builtSelectors = buildSpecificSelector({
                              id: step.target.id,
                              class: step.target.class,
                              tag: step.target.tag,
                              href: step.target.href
                          });
                          const elementIndex = step.target.elementIndex !== undefined ? step.target.elementIndex : 0;
                          const indexMap = step.target.indexMap || {};
                          
                          const sortedSelectors = [...builtSelectors].sort((a, b) => {
                              if (a.unique && !b.unique) return -1;
                              if (!a.unique && b.unique) return 1;
                              return 0;
                          });
                          
                          for (const selObj of sortedSelectors) {
                              if (targetElement) break; // Early exit if already found
                              try {
                                  let idx = elementIndex;
                                  if (indexMap[selObj.selector] !== undefined) {
                                      idx = indexMap[selObj.selector];
                                  }
                                  
                                  if (selObj.unique && idx === 0) {
                                      const element = document.querySelector(selObj.selector);
                                      if (element && isExactElementMatch(element, step.target)) {
                                          targetElement = element;
                                          break;
                                      }
                                  } else {
                                      const elements = document.querySelectorAll(selObj.selector);
                                      if (elements.length > 0) {
                                          if (selObj.unique && elements.length === 1) {
                                              if (isExactElementMatch(elements[0], step.target)) {
                                                  targetElement = elements[0];
                                                  break;
                                              }
                                          } else if (elements.length > idx) {
                                              if (isExactElementMatch(elements[idx], step.target)) {
                                                  targetElement = elements[idx];
                                                  break;
                                              }
                                              for (let i = 0; i < elements.length; i++) {
                                                  if (isExactElementMatch(elements[i], step.target)) {
                                                      targetElement = elements[i];
                                                      break;
                                                  }
                                              }
                                              if (targetElement) break;
                                          } else if (elements.length > 0) {
                                              for (let i = 0; i < elements.length; i++) {
                                                  if (isExactElementMatch(elements[i], step.target)) {
                                                      targetElement = elements[i];
                                                      break;
                                                  }
                                              }
                                              if (targetElement) break;
                                          }
                                      }
                                  }
                              } catch (e) {
                                  console.warn('[Modalflow] Error with buildSpecificSelector:', selObj.selector, e);
                                  // Continue to next selector
                              }
                          }
                      }
                      
                      if (!targetElement && step.target.xpath) {
                          try {
                              const xpathResult = document.evaluate(step.target.xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                              if (xpathResult.singleNodeValue) {
                                  if (isExactElementMatch(xpathResult.singleNodeValue, step.target)) {
                                      targetElement = xpathResult.singleNodeValue;
                                  }
                              }
                          } catch (e) {
                              console.warn('[Modalflow] Invalid xpath:', step.target.xpath, e);
                          }
                      }
                      
                      if (!targetElement && step.target.class) {
                          const classSelector = '.' + step.target.class.trim().split(/\s+/).map(c => {
                              return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(c) : c.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
                          }).join('.');
                          try {
                              const firstElement = document.querySelector(classSelector);
                              if (firstElement) {
                                  if (isExactElementMatch(firstElement, step.target)) {
                                      targetElement = firstElement;
                                  } else {
                                      const elements = document.querySelectorAll(classSelector);
                                      for (let i = 0; i < elements.length; i++) {
                                          if (isExactElementMatch(elements[i], step.target)) {
                                              targetElement = elements[i];
                                              break;
                                          }
                                      }
                                  }
                              }
                          } catch (e) {
                              console.warn('[Modalflow] Invalid class selector:', classSelector, e);
                          }
                      }
                      
                      if (!targetElement && step.target.tag) {
                          const tagSelector = step.target.tag.toLowerCase();
                          try {
                              const firstElement = document.querySelector(tagSelector);
                              if (firstElement) {
                                  if (isExactElementMatch(firstElement, step.target)) {
                                      targetElement = firstElement;
                                  } else {
                                      const elements = document.querySelectorAll(tagSelector);
                                      for (let i = 0; i < elements.length; i++) {
                                          if (isExactElementMatch(elements[i], step.target)) {
                                              targetElement = elements[i];
                                              break;
                                          }
                                      }
                                  }
                              }
                          } catch (e) {
                              console.warn('[Modalflow] Invalid tag selector:', tagSelector, e);
                          }
                      }
                      
                      if (!targetElement && step.target.text && typeof step.target.text === 'string') {
                          const textValue = step.target.text;
                          if (textValue) {
                              const found = findElementByText(textValue);
                              if (found && isExactElementMatch(found, step.target)) {
                                  targetElement = found;
                              }
                          }
                      }
                  }
                  
                  if (isGoManual && !targetElement) {
                      const goManualElementConfig = {};
                      if (step.target.id) goManualElementConfig.id = step.target.id;
                      if (step.target.class) goManualElementConfig.class = step.target.class;
                      if (step.target.tag) goManualElementConfig.tag = step.target.tag;
                      if (step.target.text && typeof step.target.text === 'string') goManualElementConfig.text = step.target.text;
                      if (step.target.href) goManualElementConfig.href = step.target.href;
                      const hasValidationData = Object.keys(goManualElementConfig).length > 0;
                      
                      if (step.target.selector && step.target.selector.value) {
                          const cssSelector = step.target.selector.value.trim();
                          const ifMultiple = step.target.ifMultiple?.value || step.target.ifMultiple || 'first';
                          try {
                              if (ifMultiple === 'first' || ifMultiple === '0') {
                                  const element = document.querySelector(cssSelector);
                                  if (element) {
                                      if (hasValidationData) {
                                          if (isExactElementMatch(element, goManualElementConfig)) {
                                              targetElement = element;
                                          }
                                      } else {
                                          targetElement = element;
                                      }
                                  }
                              } else {
                                  const elements = document.querySelectorAll(cssSelector);
                                  if (elements.length > 0) {
                                      const selected = selectElementFromArray(elements, getIfMultipleValue(ifMultiple));
                                      if (hasValidationData && selected) {
                                          if (isExactElementMatch(selected, goManualElementConfig)) {
                                              targetElement = selected;
                                          } else {
                                              for (let i = 0; i < elements.length; i++) {
                                                  if (isExactElementMatch(elements[i], goManualElementConfig)) {
                                                      targetElement = elements[i];
                                                      break;
                                                  }
                                              }
                                          }
                                      } else if (selected) {
                                          targetElement = selected;
                                      }
                                  }
                              }
                          } catch (e) {
                              console.warn('[Modalflow] Invalid CSS selector:', cssSelector, e);
                          }
                      }
                      
                      if (!targetElement && step.target.text && step.target.text.value) {
                          const textValue = step.target.text.value;
                          if (textValue) {
                              const found = findElementByText(textValue);
                              if (found) {
                                  if (hasValidationData) {
                                      if (isExactElementMatch(found, goManualElementConfig)) {
                                          targetElement = found;
                                      }
                                  } else {
                                      targetElement = found;
                                  }
                              }
                          }
                      }
                  }
              }
              
              if (step.ui) {
                  if (step.ui.backdrop !== undefined) addBackdrop = step.ui.backdrop;
                  if (step.ui.blockTargetClicks !== undefined) blockTargetClicks = step.ui.blockTargetClicks;
                  if (step.ui.backdropPadding !== undefined) backdropPadding = step.ui.backdropPadding;
                  if (step.ui.position !== undefined) positionPref = step.ui.position;
              }
              
          } catch (e) {
              console.error('[Modalflow] Error resolving tooltip target:', e);
          }

          if (!targetElement && step.target && step.target.selector) {
              const cssSelector = getSelectorValue(step.target.selector);
              if (cssSelector) {
                  try {
                      const fallbackElementConfig = {};
                      if (step.target.id) fallbackElementConfig.id = step.target.id;
                      if (step.target.class) fallbackElementConfig.class = step.target.class;
                      if (step.target.tag) fallbackElementConfig.tag = step.target.tag;
                      if (step.target.text && typeof step.target.text === 'string') fallbackElementConfig.text = step.target.text;
                      if (step.target.href) fallbackElementConfig.href = step.target.href;
                      const hasValidationData = Object.keys(fallbackElementConfig).length > 0;
                      
                      const firstElement = document.querySelector(cssSelector);
                      if (firstElement) {
                          if (hasValidationData) {
                              if (isExactElementMatch(firstElement, fallbackElementConfig)) {
                                  targetElement = firstElement;
                              } else {
                                  const elements = document.querySelectorAll(cssSelector);
                                  for (let i = 0; i < elements.length; i++) {
                                      if (isExactElementMatch(elements[i], fallbackElementConfig)) {
                                          targetElement = elements[i];
                                          break;
                                      }
                                  }
                              }
                          } else {
                              targetElement = firstElement;
                          }
                      }
                  } catch (e) {
                      console.warn('[Modalflow] Invalid CSS selector:', cssSelector, e);
                  }
              }
          }
  
          if (!targetElement && step.target && step.target.coordinates) {
              const coords = step.target.coordinates;
              if (coords.x !== undefined && coords.y !== undefined) {
                  absXY = { x: coords.x, y: coords.y };
              }
          }
          
          if (targetElement) {
              const rect = targetElement.getBoundingClientRect();
              const windowHeight = window.innerHeight || document.documentElement.clientHeight;
              const windowWidth = window.innerWidth || document.documentElement.clientWidth;
              
              const isFullyVisible = (
                  rect.top >= 0 &&
                  rect.left >= 0 &&
                  rect.bottom <= windowHeight &&
                  rect.right <= windowWidth
              );
              
              const shouldScroll = !isFullyVisible;
              
              const tooltipHeight = 200; // Approximate tooltip height
              if (!positionPref || positionPref === 'belowTarget') {
                  const spaceBelow = windowHeight - rect.bottom;
                  const spaceAbove = rect.top;
                  
                  if (spaceBelow < tooltipHeight + 20 && spaceAbove > spaceBelow) {
                      positionPref = 'aboveTarget';
                  }
              }
  
              renderTooltipContent();
              
              if (shouldScroll) {
                  scrollToElementIfNeeded(targetElement, {
                      smooth: true,
                      block: 'center',
                      inline: 'center',
                      requireFullVisibility: true // Require full visibility for tooltips
                  });
              }
  
              function renderTooltipContent() {
                  try {
                      const tooltipActions = Array.isArray(step.tooltipaction) ? step.tooltipaction : [];
                      const hasAnotherStepAction = tooltipActions.some(function (act) {
                          return act && act.type === 'next';
                      });
                      const runTooltipActions = () => {
                          if (hasAnotherStepAction) {
                              removeAllBoxes();
                              setTimeout(() => {
                                  executeStepActions(tooltipActions);
                              }, 2000);
                          } else {
                              executeStepActions(tooltipActions);
                          }
                      };
                      
                      overlay.style.background = 'transparent';
                      overlay.style.pointerEvents = 'none';
                      
                      // Get fresh coordinates after layout update
                      const tRect = targetElement.getBoundingClientRect();
  
                      if (addBackdrop) {
                          const onTargetClick = (addBackdrop && blockTargetClicks && tooltipActions.length) ? runTooltipActions : undefined;
                          drawSpotlightAroundTarget(overlay, tRect, backdropPadding, blockTargetClicks, onTargetClick);
                      } else {
                          overlay.innerHTML = '';
                      }
  
                      stepBox.style.pointerEvents = 'auto';
  
                      if (stepType === 'tooltip') {
                          stepBox.style.setProperty('padding', '24px 16px 12px 16px', 'important');

                          stepBox.dataset.hasTarget = 'true';
                          stepBox._targetElement = targetElement;
                          stepBox._positionPref = positionPref;
                          const existingTails = stepBox.querySelectorAll('.mf-tooltip-tail');
                          existingTails.forEach(t => t.remove());
  
                          const tail = createEl('div', {});
                          tail.className = 'mf-tooltip-tail';
                          tail.style.position = 'absolute';
                          tail.style.width = '0';
                          tail.style.height = '0';
                          stepBox._tooltipTail = tail;
  
                          const setTailStyle = (pos) => {
                              tail.style.borderLeft = '0';
                              tail.style.borderRight = '0';
                              tail.style.borderTop = '0';
                              tail.style.borderBottom = '0';

                              const tailColor = theme === 'dark' ? '#1f2937' : '#ffffff';
                              if (pos === 'aboveTarget') {
                                  tail.style.left = '20px';
                                  tail.style.top = '100%';
                                  tail.style.borderLeft = '10px solid transparent';
                                  tail.style.borderRight = '10px solid transparent';
                                  tail.style.borderTop = '10px solid ' + tailColor;
                              } else if (pos === 'leftOfTarget') {
                                  tail.style.top = '20px';
                                  tail.style.left = '100%';
                                  tail.style.borderTop = '10px solid transparent';
                                  tail.style.borderBottom = '10px solid transparent';
                                  tail.style.borderLeft = '10px solid ' + tailColor;
                              } else if (pos === 'rightOfTarget') {
                                  tail.style.top = '20px';
                                  tail.style.left = '-10px';
                                  tail.style.borderTop = '10px solid transparent';
                                  tail.style.borderBottom = '10px solid transparent';
                                  tail.style.borderRight = '10px solid ' + tailColor;
                              } else { // belowTarget (default)
                                  tail.style.left = '20px';
                                  tail.style.top = '-10px';
                                  tail.style.borderLeft = '10px solid transparent';
                                  tail.style.borderRight = '10px solid transparent';
                                  tail.style.borderBottom = '10px solid ' + tailColor;
                              }
                          };
  
                          stepBox._setTailStyle = setTailStyle;
                          setTailStyle(positionPref);
                          stepBox.appendChild(tail);
                          addProgressBar(positionPref);
                          try { stepBox._progressBarEl = stepBox.querySelector('.mf-progress-bar'); } catch (_) { }
                          
                          const alignTailToTarget = () => {
                              try {
                                  const target = stepBox._targetElement;
                                  const pos = stepBox._actualPosition || stepBox._positionPref;
                                  const tail = stepBox._tooltipTail;
  
                                  if (!target || !target.getBoundingClientRect || !tail) {
                                      return;
                                  }
  
                                  const tRect2 = target.getBoundingClientRect();
                                  const bRect = stepBox.getBoundingClientRect();
                                  const centerX = tRect2.left + (tRect2.width / 2);
                                  const centerY = tRect2.top + (tRect2.height / 2);
  
                                  if (pos === 'belowTarget' || !pos) {
                                      const rel = Math.max(10, Math.min(bRect.width - 30, centerX - bRect.left));
                                      tail.style.left = (rel - 10) + 'px';
                                      tail.style.top = '-10px';
                                  } else if (pos === 'aboveTarget') {
                                      const rel = Math.max(10, Math.min(bRect.width - 30, centerX - bRect.left));
                                      tail.style.left = (rel - 10) + 'px';
                                      tail.style.top = '100%';
                                  } else if (pos === 'rightOfTarget') {
                                      const rel = Math.max(10, Math.min(bRect.height - 30, centerY - bRect.top));
                                      tail.style.top = (rel - 10) + 'px';
                                      tail.style.left = '-10px';
                                  } else if (pos === 'leftOfTarget') {
                                      const rel = Math.max(10, Math.min(bRect.height - 30, centerY - bRect.top));
                                      tail.style.top = (rel - 10) + 'px';
                                      tail.style.left = '100%';
                                  }
                              } catch (e) {
                                  console.error('[Modalflow] Error aligning tail:', e);
                              }
                          };
                          
                          stepBox._alignTailToTarget = alignTailToTarget;
                          stepBox._positionTooltip = () => {
                              placeNearTarget(targetElement, stepBox, stepType, positionPref, absXY);
                              requestAnimationFrame(() => {
                                  alignTailToTarget();
                              });
                          };
                          
                          const updateTooltipPosition = () => {
                              try {
                                  if (!targetElement || !stepBox._targetElement) return;
                                  
                                  const freshRect = targetElement.getBoundingClientRect();
                                  
                                  if (addBackdrop) {
                                      const onTargetClick = (addBackdrop && blockTargetClicks && tooltipActions.length) ? runTooltipActions : undefined;
                                      drawSpotlightAroundTarget(overlay, freshRect, backdropPadding, blockTargetClicks, onTargetClick);
                                  }
                                  
                                  placeNearTarget(targetElement, stepBox, stepType, positionPref, absXY);
                                  
                                  requestAnimationFrame(() => {
                                      alignTailToTarget();
                                  });
                              } catch (e) {
                                  console.error('[Modalflow] Error updating tooltip position:', e);
                              }
                          };
                          
                          const handleScroll = () => {
                              requestAnimationFrame(updateTooltipPosition);
                          };
                          
                          const handleResize = () => {
                              requestAnimationFrame(updateTooltipPosition);
                          };
                          
                          window.addEventListener('scroll', handleScroll, { passive: true, capture: true });
                          window.addEventListener('resize', handleResize, { passive: true });
                          
                          if (window.visualViewport) {
                              window.visualViewport.addEventListener('scroll', handleScroll, { passive: true });
                              window.visualViewport.addEventListener('resize', handleResize, { passive: true });
                          }
                          
                          if (!blockTargetClicks && tooltipActions.length && targetElement) {
                              targetElement.addEventListener('click', runTooltipActions);
                          }
                          
                          stepBox._cleanupTooltipListeners = () => {
                              window.removeEventListener('scroll', handleScroll, { capture: true });
                              window.removeEventListener('resize', handleResize);
                              if (window.visualViewport) {
                                  window.visualViewport.removeEventListener('scroll', handleScroll);
                                  window.visualViewport.removeEventListener('resize', handleResize);
                              }
                              if (!blockTargetClicks && tooltipActions.length && targetElement) {
                                  targetElement.removeEventListener('click', runTooltipActions);
                              }
                          };
                          
                          placeNearTarget(targetElement, stepBox, stepType, positionPref, absXY);
                          requestAnimationFrame(() => {
                              alignTailToTarget();
                          });
                          requestAnimationFrame(() => {
                              if (stepBox._positionTooltip) stepBox._positionTooltip();
                          });
                      }
                      stepBox.setAttribute('data-modalflow-box', '1');
  
                  } catch (e) {
                      console.error('[Modalflow] Error rendering tooltip:', e);
                  }
              }
          }
      } else {
          stepBox.setAttribute('data-modalflow-box', '1');
          overlay.append(stepBox);
      }
  
          const rawTitle = (step.title || '').trim();
          const titleToShow = (!rawTitle || /^unnamed step$/i.test(rawTitle)) ? '' : rawTitle;
          const title = titleToShow ? createEl("h3", {}, titleToShow) : null;
          const content = createEl("div", {}, step.content?.trim() || "");
          let questionWrap = null;
          let actionsWrap = null;
          let runActions = null; 
          try {
              const ab = getStepBlocks(step);
              const q = ab.find(b => b && b.type === 'question');
              if (q) {
                  const questionType = q.questionType || 'single-line-text';
                  const questionText = q.name || '';
                  const placeholder = q.placeholder || 'Enter your answer';
                  const submitText = q.submitText || 'Submit';
                  const whenAnswerSubmittedItem = q.actions ? { actions: q.actions } : null;

                  const executeQuestionActions = () => {
                      let actionExecuted = false;
                      try {
                          window.__MODALFLOW_ANSWERS__ = window.__MODALFLOW_ANSWERS__ || {};
                          const key = step.id || ('step-' + index);
                          let answerValue = selectedValue;
                          if (input && !selectedValue) {
                              answerValue = String(input.value || '');
                          }
                          window.__MODALFLOW_ANSWERS__[key] = answerValue;
                      } catch (e) {
                      }

                      try {
                          if (whenAnswerSubmittedItem && Array.isArray(whenAnswerSubmittedItem.actions) && whenAnswerSubmittedItem.actions.length > 0) {
                              const actions = whenAnswerSubmittedItem.actions;
                              const navAction = actions.find(act =>
                                  String(act.type || act.id || '').toLowerCase() === 'navigatetopage'
                              );

                              if (navAction && navAction.pageUrl) {
                                  actionExecuted = true;
                                  const url = navAction.pageUrl;
                                  const newTab = !!(navAction.openInNewTab || navAction.newTab);
                                  const goToStepAction = actions.find(act => {
                                      const actType = String(act.type || act.id || '').toLowerCase();
                                      return actType === 'gotostep' || actType === 'next';
                                  });
                                  if (goToStepAction) {
                                      let targetIdx = Number(goToStepAction.stepId || goToStepAction.value);
                                      if (!Number.isFinite(targetIdx)) {
                                          const i = guideData.findIndex(s => String(s.id) === String(goToStepAction.stepId || goToStepAction.value));
                                          if (i >= 0) targetIdx = i;
                                      }

                                      if (Number.isFinite(targetIdx)) {
                                          try {
                                              setForcedStartStep(targetIdx);
                                              localStorage.setItem('MF_START_STEP', String(targetIdx));
                                          } catch (_) { }

                                          const newUrl = addMfStartToUrl(url, targetIdx);

                                          if (newTab) {
                                              window.open(String(newUrl), '_blank');
                                              requestAnimationFrame(() => {
                                                  removeAllBoxes();
                                                  renderStep(targetIdx);
                                              });
                                          } else {
                                              window.location.href = String(newUrl);
                                          }
                                          return;
                                      }
                                  }
                                  if (newTab) {
                                      window.open(String(url), '_blank');
                                  } else {
                                      window.location.href = String(url);
                                  }
                                  return;
                              }

                              for (const act of actions) {
                                  const actionType = String(act.type || act.id || '').toLowerCase();

                                  if (actionType === 'gotostep' || actionType === 'next') {
                                      actionExecuted = true;
                                      let targetIdx = Number(act.stepId || act.step_id || act.value);
                                      if (!Number.isFinite(targetIdx)) {
                                          const i = guideData.findIndex(s => String(s.id) === String(act.stepId || act.step_id || act.value));
                                          if (i >= 0) targetIdx = i;
                                      }
                                      if (Number.isFinite(targetIdx)) {
                                          requestAnimationFrame(() => {
                                              removeAllBoxes();
                                              renderStep(Number(targetIdx));
                                          });
                                          return;
                                      }
                                  } else if (actionType === 'dismissflow' || actionType === 'dismiss') {
                                      actionExecuted = true;
                                      endGuide();
                                      return;
                                  } else if (actionType === 'evaluatejavascript' && act.value) {
                                      try {
                                          Function(String(act.value))();
                                          actionExecuted = true;
                                      } catch (e) {
                                      }
                                  }
                              }
                          }
                      } catch (e) {
                      }
                  };
  
                  const __mfIsDarkTheme = !!(
                      (setup && String(setup.theme || '').toLowerCase() === 'dark') ||
                      (setup && setup.settings && String(setup.settings.theme || '').toLowerCase() === 'dark')
                  );
                  const __mfTextPrimaryFallback = __mfIsDarkTheme ? '#f9fafb' : '#111827';
                  const __mfTextSecondaryFallback = __mfIsDarkTheme ? 'rgba(255,255,255,0.72)' : '#667085';
                  const __mfBorderFallback = __mfIsDarkTheme ? 'rgba(255,255,255,0.16)' : '#eaecf0';
                  const __mfOptionBgFallback = __mfIsDarkTheme ? 'rgba(255,255,255,0.06)' : '#f8fafc';
                  const __mfOptionBgActiveFallback = __mfIsDarkTheme ? 'rgba(255,255,255,0.10)' : 'rgba(13,110,253,0.12)';
                  const __mfInputBgFallback = __mfIsDarkTheme ? 'rgba(255,255,255,0.06)' : '#ffffff';

                  questionWrap = createEl('div', { style: 'margin-top:16px; width:100%; color:var(--ms-theme-text-primary,' + __mfTextPrimaryFallback + ');' });
  
                  if (questionText && String(questionText).trim()) {
                      const qLabel = createEl('label', {
                          style: 'display:block; margin-bottom:8px; font-weight:500; color:var(--ms-theme-question-text, var(--ms-theme-text-primary,' + __mfTextPrimaryFallback + '));'
                      }, String(questionText).trim());
                      questionWrap.appendChild(qLabel);
                  }
  
                  let input;
                  let selectedValue = null;
                  let updateSubmitButtonState;
  
                  if (questionType === 'multiple-choice') {
                      const options = (q.options || []).map(opt => ({ value: opt.value || opt.label || '', labelValue: opt.label || opt.value || '' }));
                      const allowMultiple = q.allowMultipleSelection !== false;
                      const shuffleOrder = q.shuffleOrder || false;
                      const enableOther = q.enableOtherOption || false;
                      const otherPlaceholder = q.otherOptionPlaceholder || 'Other';
  
                      const selectionRange = q.selectionRange || {};
                      const minSelection = selectionRange.min !== undefined ? selectionRange.min : 0;
                      const maxSelection = selectionRange.max !== undefined ? selectionRange.max : null;
  
                      let displayOptions = [...options];
                      if (shuffleOrder) {
                          displayOptions.sort(() => Math.random() - 0.5);
                      }
  
                      const optionsContainer = createEl('div', { style: 'display:flex; flex-direction:column; gap:8px;' });
                      const selectedValues = new Set();
  
                      if (allowMultiple && (minSelection > 0 || maxSelection)) {
                          const helperText = createEl('div', {
                              style: 'font-size:14px; color:var(--ms-theme-text-secondary,' + __mfTextSecondaryFallback + '); margin-bottom:8px;'
                          });
                          let helpMsg = '';
                          if (minSelection > 0 && maxSelection) {
                              helpMsg = "Select between " + minSelection + "and" + maxSelection + "options";
                          } else if (minSelection > 0) {
                              helpMsg = "Select at least " + minSelection + "option" + (minSelection > 1 ? 's' : '');
                          } else if (maxSelection) {
                              helpMsg = "Select up to " + maxSelection + "option" + (maxSelection > 1 ? 's' : '');
                          }
                          helperText.textContent = helpMsg;
                          questionWrap.appendChild(helperText);
                      }
  
                      displayOptions.forEach((opt, idx) => {
                          const optionDiv = createEl('div', {
                              style: 'display:flex; align-items:center; padding:10px 12px; border:1px solid var(--ms-theme-border,' + __mfBorderFallback + '); border-radius:8px; background:var(--ms-theme-option-bg,' + __mfOptionBgFallback + '); cursor:pointer; transition:all 0.2s; color:var(--ms-theme-text-primary,' + __mfTextPrimaryFallback + ');'
                          });
  
                          const radio = createEl('input', {
                              type: allowMultiple ? 'checkbox' : 'radio',
                              name: 'question-option',
                              id: 'opt-' + idx,
                              value: opt.value || '',
                              style: 'margin-right:8px; cursor:pointer; pointer-events:none; accent-color:var(--ms-brand-background,var(--ms-theme-primary,#0d6efd));'
                          });

                          const label = createEl('label', {
                              for: 'opt-' + idx,
                              style: 'margin:0; cursor:pointer; flex:1; pointer-events:none; user-select:none; color:var(--ms-theme-text-primary,' + __mfTextPrimaryFallback + ');'
                          }, opt.labelValue || opt.value || '');

                          radio.onchange = () => {
                              if (allowMultiple) {
                                  if (radio.checked) {
                                      if (maxSelection && selectedValues.size >= maxSelection) {
                                          radio.checked = false;
                                          const feedback = createEl('div', {
                                              style: 'position:fixed; top:20px; left:50%; transform:translateX(-50%); background:rgba(239,68,68,0.9); color:white; padding:12px 24px; border-radius:8px; z-index:1000; box-shadow:0 4px 6px rgba(0,0,0,0.1);'
                                          }, "You can only select up to " + maxSelection + " option" + (maxSelection > 1 ? 's' : ''));
                                          document.body.appendChild(feedback);
                                          setTimeout(() => feedback.remove(), 2000);
                                          return;
                                      }
                                      selectedValues.add(opt.value);
                                      optionDiv.style.borderColor = 'var(--ms-brand-background,var(--ms-theme-primary))';
                                      optionDiv.style.background = 'var(--ms-theme-option-bg-active,' + __mfOptionBgActiveFallback + ')';
                                  } else {
                                      selectedValues.delete(opt.value);
                                      optionDiv.style.borderColor = 'var(--ms-theme-border,' + __mfBorderFallback + ')';
                                      optionDiv.style.background = 'var(--ms-theme-option-bg,' + __mfOptionBgFallback + ')';
                                  }
                                  selectedValue = Array.from(selectedValues);
                              } else {
                                  selectedValue = opt.value;
                                    optionsContainer.querySelectorAll('div').forEach(d => {
                                      d.style.borderColor = 'var(--ms-theme-border,' + __mfBorderFallback + ')';
                                      d.style.background = 'var(--ms-theme-option-bg,' + __mfOptionBgFallback + ')';
                                  });
                                  optionDiv.style.borderColor = 'var(--ms-brand-background,var(--ms-theme-primary))';
                                  optionDiv.style.background = 'var(--ms-theme-option-bg-active,' + __mfOptionBgActiveFallback + ')';
                              }
                              if (updateSubmitButtonState) {
                                  updateSubmitButtonState();
                              }
                          };
  
                          optionDiv.onclick = () => radio.click();
                          optionDiv.appendChild(radio);
                          optionDiv.appendChild(label);
                          optionsContainer.appendChild(optionDiv);
                      });
  
                      if (enableOther) {
                          const otherDiv = createEl('div', {
                              style: 'display:flex; align-items:center; gap:8px; padding:10px 12px; border:1px solid var(--ms-theme-border,' + __mfBorderFallback + '); border-radius:8px; background:var(--ms-theme-option-bg,' + __mfOptionBgFallback + '); color:var(--ms-theme-text-primary,' + __mfTextPrimaryFallback + ');'
                          });
                          const otherRadio = createEl('input', {
                              type: allowMultiple ? 'checkbox' : 'radio',
                              name: 'question-option',
                              id: 'opt-other',
                              style: 'margin-right:8px; accent-color:var(--ms-brand-background,var(--ms-theme-primary,#0d6efd));'
                          });
                          const otherInput = createEl('input', {
                              type: 'text',
                              placeholder: otherPlaceholder + '...',
                              style: 'flex:1; padding:8px 12px; border:1px solid var(--ms-theme-border,' + __mfBorderFallback + '); border-radius:6px; background:var(--ms-theme-background,' + __mfInputBgFallback + '); color:var(--ms-theme-text-primary,' + __mfTextPrimaryFallback + ');'
                          });
  
                          otherRadio.onchange = () => {
                              if (allowMultiple) {
                                  if (otherRadio.checked) {
                                      if (maxSelection && selectedValues.size >= maxSelection) {
                                          otherRadio.checked = false;
                                          const feedback = createEl('div', {
                                              style: 'position:fixed; top:20px; left:50%; transform:translateX(-50%); background:rgba(239,68,68,0.9); color:#fff; padding:12px 24px; border-radius:8px; z-index:1000; box-shadow:0 4px 6px rgba(0,0,0,0.1);'
                                          }, "You can only select up to " + maxSelection + " option" + (maxSelection > 1 ? 's' : ''));
                                          document.body.appendChild(feedback);
                                          setTimeout(() => feedback.remove(), 2000);
                                          return;
                                      }
                                      selectedValues.add(otherInput.value || 'Other');
                                      otherDiv.style.borderColor = 'var(--ms-brand-background,var(--ms-theme-primary))';
                                      otherDiv.style.background = 'var(--ms-theme-option-bg-active,' + __mfOptionBgActiveFallback + ')';
                                  } else {
                                      selectedValues.delete(otherInput.value || 'Other');
                                      otherDiv.style.borderColor = 'var(--ms-theme-border,' + __mfBorderFallback + ')';
                                      otherDiv.style.background = 'var(--ms-theme-option-bg,' + __mfOptionBgFallback + ')';
                                  }
                                  selectedValue = Array.from(selectedValues);
                              } else {
                                  selectedValue = otherInput.value || 'Other';
                              }
                              if (updateSubmitButtonState) {
                                  updateSubmitButtonState();
                              }
                          };
  
                          otherInput.oninput = () => {
                              if (otherRadio.checked && allowMultiple) {
                                  selectedValues.delete('Other');
                                  selectedValues.add(otherInput.value);
                                  selectedValue = Array.from(selectedValues);
                              } else if (otherRadio.checked && !allowMultiple) {
                                  selectedValue = otherInput.value || 'Other';
                              }
                              if (updateSubmitButtonState) {
                                  updateSubmitButtonState();
                              }
                          };
  
                          otherDiv.appendChild(otherRadio);
                          otherDiv.appendChild(otherInput);
                          optionsContainer.appendChild(otherDiv);
                      }
  
                      questionWrap.appendChild(optionsContainer);
                      questionWrap.validateSelection = () => {
                          if (allowMultiple && minSelection > 0 && selectedValues.size < minSelection) {
                              return {
                                  valid: false,
                                  message: "Please select at least " + minSelection + " option" + (minSelection > 1 ? 's' : '')
                              };
                          }
                          return { valid: true };
                      };
                  }
  
                  else if (questionType === 'nps') {
                      const labels = q.labels || {};
                      const label1 = labels.low || 'Not at all likely';
                      const label2 = labels.middle || '';
                      const label3 = labels.high || 'Extremely likely';
  
                      const npsContainer = createEl('div', { style: 'display:flex; flex-direction:column; gap:12px; margin-top:8px;' });
                      const scaleWrapper = createEl('div', {
                          style: 'border:1px solid var(--ms-theme-border,' + __mfBorderFallback + '); border-radius:8px; padding:4px; background:var(--ms-theme-option-bg,' + __mfOptionBgFallback + '); display:flex;'
                      });
                      const scaleContainer = createEl('div', { style: 'display:flex; gap:0; width:100%;' });
  
                      for (let i = 0; i <= 10; i++) {
                          const btn = createEl('button', {
                              style: 'flex:1;min-width:32px; padding:clamp(6px, 1.5vw, 10px) 0; border:none; border-right:' + (i < 10 ? '1px solid var(--ms-theme-border,' + __mfBorderFallback + ')' : 'none') + '; background:transparent; cursor:pointer; font-weight:500; font-size:14px; color:var(--ms-theme-text-secondary,' + __mfTextSecondaryFallback + '); transition:all 0.2s;'
                          }, String(i));
  
                          btn.onclick = () => {
                              selectedValue = i;
                              scaleContainer.querySelectorAll('button').forEach(b => {
                                  b.style.background = 'transparent';
                                  b.style.color = 'var(--ms-theme-text-secondary,' + __mfTextSecondaryFallback + ')';
                              });
                              btn.style.background = 'var(--ms-brand-background,var(--ms-theme-primary))';
                              btn.style.color = 'var(--ms-brand-text,var(--ms-theme-text-on-primary,#fff))';
                              requestAnimationFrame(() => {
                                  setTimeout(() => {
                                      executeQuestionActions();
                                  }, 500);
                              });
                          };
  
                              btn.onmouseenter = () => {
                                  if (selectedValue !== i) {
                                      btn.style.background = 'var(--ms-theme-option-bg-active,' + __mfOptionBgActiveFallback + ')';
                                  }
                              };

                              btn.onmouseleave = () => {
                                  if (selectedValue !== i) {
                                      btn.style.background = 'transparent';
                                  }
                              };
  
                          scaleContainer.appendChild(btn);
                      }
                      scaleWrapper.appendChild(scaleContainer);
                      const labelsContainer = createEl('div', {
                          style: 'display:flex; justify-content:space-between; font-size:13px; color:var(--ms-theme-text-secondary,' + __mfTextSecondaryFallback + ');'
                      });
  
                      const leftLabel = createEl('span', {}, label1);
                      const centerLabel = createEl('span', {}, label2);
                      const rightLabel = createEl('span', {}, label3);
  
                      labelsContainer.appendChild(leftLabel);
                      if (label2) labelsContainer.appendChild(centerLabel);
                      labelsContainer.appendChild(rightLabel);
  
                      npsContainer.appendChild(scaleWrapper);
                      npsContainer.appendChild(labelsContainer);
                      questionWrap.appendChild(npsContainer);
                  }
  
                  // SCALE RANGE
                  else if (questionType === 'scaleRange') {
                      const scale = q.scale || {};
                      const from = parseInt(scale.from || '1');
                      const to = parseInt(scale.to || '10');
  
                      const labels = q.labels || {};
                      const label1 = (labels.low != null && String(labels.low).trim() !== '') ? String(labels.low).trim() : '';
                      const label2 = (labels.middle != null && String(labels.middle).trim() !== '') ? String(labels.middle).trim() : '';
                      const label3 = (labels.high != null && String(labels.high).trim() !== '') ? String(labels.high).trim() : '';
                      const hasLabels = label1 !== '' || label2 !== '' || label3 !== '';

                      const scaleContainer = createEl('div', { style: 'display:flex; flex-direction:column; gap:12px;' });
                      const buttonsContainer = createEl('div', { style: 'display:flex; gap:4px; justify-content:center;' });

                      for (let i = from; i <= to; i++) {
                          const btn = createEl('button', {
                              style: 'min-width:50px; padding:12px; border:1px solid var(--ms-theme-border); border-radius:6px; background:var(--ms-theme-option-bg); cursor:pointer; font-weight:500; transition:all 0.2s; color: var(--ms-theme-text-secondary);'
                          }, String(i));
  
                          btn.onclick = () => {
                              selectedValue = i;
                              buttonsContainer.querySelectorAll('button').forEach(b => {
                                  b.style.background = 'var(--ms-theme-option-bg)';
                                  b.style.borderColor = 'var(--ms-theme-border)';
                                  b.style.color = 'var(--ms-theme-text-secondary)';
                              });
                              btn.style.background = 'var(--ms-brand-background,var(--ms-theme-primary))';
                              btn.style.borderColor = 'var(--ms-brand-background,var(--ms-theme-primary))';
                              btn.style.color = 'var(--ms-brand-text,var(--ms-theme-text-on-primary,#fff))';
                              requestAnimationFrame(() => {
                                  setTimeout(() => {
                                      executeQuestionActions();
                                  }, 500);
                              });
                          };
  
                          buttonsContainer.appendChild(btn);
                      }

                      scaleContainer.appendChild(buttonsContainer);
                      if (hasLabels) {
                          const labelsContainer = createEl('div', {
                              style: 'display:flex; justify-content:space-between; font-size:12px; color:var(--ms-theme-text-secondary);'
                          });
                          labelsContainer.innerHTML = '<span>' + label1 + '</span><span>' + label2 + '</span><span>' + label3 + '</span>';
                          scaleContainer.appendChild(labelsContainer);
                      }
                      questionWrap.appendChild(scaleContainer);
                  }
  
                  else if (questionType === 'star-rating') {
                      const scale = q.scale || {};
                      const maxStars = parseInt(scale.to || '5');
  
                      const labels = q.labels || {};
                      const hasLabels = labels.low || labels.middle || labels.high;

                      const starContainer = createEl('div', { style: 'display:flex; flex-direction:column; gap:12px; align-items:center;' });
                      const starsDiv = createEl('div', { style: 'display:flex; gap:8px;' });

                      for (let i = 1; i <= maxStars; i++) {
                          const starBtn = createEl('button', {
                              style: 'background:none; border:none; cursor:pointer; font-size:32px; transition:all 0.2s; color:var(--ms-theme-text-secondary);'
                          });
                          starBtn.innerHTML = '\u2606';
                          starBtn.dataset.value = i;

                          starBtn.onclick = () => {
                              selectedValue = i;
                              starsDiv.querySelectorAll('button').forEach((s, idx) => {
                                  s.innerHTML = idx < i ? '\u2605' : '\u2606';
                                  s.style.color = idx < i ? 'var(--ms-brand-background,var(--ms-theme-primary))' : 'var(--ms-theme-text-secondary)';
                              });
                              requestAnimationFrame(() => {
                                  setTimeout(() => {
                                      executeQuestionActions();
                                  }, 500);
                              });
                          };

                          starBtn.onmouseenter = () => {
                              starsDiv.querySelectorAll('button').forEach((s, idx) => {
                                  s.innerHTML = idx < i ? '\u2605' : '\u2606';
                                  s.style.color = idx < i ? 'var(--ms-brand-background,var(--ms-theme-primary))' : 'var(--ms-theme-text-secondary)';
                              });
                          };

                          starBtn.onmouseleave = () => {
                              if (selectedValue) {
                                  starsDiv.querySelectorAll('button').forEach((s, idx) => {
                                      s.innerHTML = idx < selectedValue ? '\u2605' : '\u2606';
                                      s.style.color = idx < selectedValue ? 'var(--ms-brand-background,var(--ms-theme-primary))' : 'var(--ms-theme-text-secondary)';
                                  });
                              } else {
                                  starsDiv.querySelectorAll('button').forEach(s => {
                                      s.innerHTML = '\u2606';
                                      s.style.color = 'var(--ms-theme-text-secondary)';
                                  });
                              }
                          };

                          const numberLabel = createEl('div', {
                              style: 'text-align:center; font-size:12px; color:var(--ms-theme-text-secondary,#6b7280); margin-top:-4px;'
                          }, String(i));

                          const starWrapper = createEl('div', { style: 'display:flex; flex-direction:column; align-items:center;' });
                          starWrapper.appendChild(starBtn);
                          starWrapper.appendChild(numberLabel);
                          starsDiv.appendChild(starWrapper);
                      }

                      starContainer.appendChild(starsDiv);
                      
                      if (hasLabels) {
                          const labelsContainer = createEl('div', {
                              style: 'display:flex; justify-content:space-between; width:100%; font-size:12px; color:var(--ms-theme-text-secondary,#6b7280);'
                          });
                          
                          const labelSpans = [];
                          if (labels.low) {
                              labelSpans.push('<span>' + labels.low + '</span>');
                          }
                          if (labels.middle) {
                              labelSpans.push('<span>' + labels.middle + '</span>');
                          }
                          if (labels.high) {
                              labelSpans.push('<span>' + labels.high + '</span>');
                          }
                          
                          labelsContainer.innerHTML = labelSpans.join('');
                          starContainer.appendChild(labelsContainer);
                      }
                      
                      questionWrap.appendChild(starContainer);
                  }
  
                  else if (questionType === 'multi-line-text') {
                      input = createEl('textarea', {
                          placeholder: placeholder,
                          style: 'width:100%; padding:10px 12px; border:1px solid #d1d5db; border-radius:8px; outline:none; resize:vertical; min-height:80px; font-family:inherit; box-sizing:border-box; color:var(--ms-theme-text-primary);background:var(--ms-theme-background);'
                      });
                      questionWrap.appendChild(input);
                  } else {
                      input = createEl('input', {
                          type: 'text',
                          placeholder: placeholder,
                          style: 'width:100%; padding:10px 12px; border:1px solid #d1d5db; border-radius:8px; outline:none; box-sizing:border-box; color:var(--ms-theme-text-primary);background:var(--ms-theme-background);'
                      });
                      questionWrap.appendChild(input);
                  }
  
                  const actions = createEl('div', { style: 'margin-top:12px; width:100%; display:flex; justify-content:flex-end;' });
                  const submitBtn = createEl('button', {
                      class: 'mf-btn',
                      style: 'padding:6px 14px; border-radius:8px;'
                  }, submitText);
  
                  const isRequired = q.required === true;
                  
                  updateSubmitButtonState = () => {
                      if (!isRequired) {
                          submitBtn.disabled = false;
                          submitBtn.style.opacity = '1';
                          submitBtn.style.cursor = 'pointer';
                          return;
                      }
                      
                      let isValid = false;
                      
                      if (questionType === 'multiple-choice') {
                          isValid = selectedValue && (Array.isArray(selectedValue) ? selectedValue.length > 0 : true);
                      } else if (questionType === 'single-line-text' || questionType === 'multi-line-text') {
                          const textValue = input ? String(input.value || '').trim() : '';
                          isValid = !!textValue;
                      }
                      
                      submitBtn.disabled = !isValid;
                      submitBtn.style.opacity = isValid ? '1' : '0.5';
                      submitBtn.style.cursor = isValid ? 'pointer' : 'not-allowed';
                  };
                  
                  if (input && (questionType === 'single-line-text' || questionType === 'multi-line-text')) {
                      input.oninput = () => {
                          updateSubmitButtonState();
                      };
                  }
                  
                  updateSubmitButtonState();
                  
                  submitBtn.onclick = () => {
                      if (submitBtn.disabled) {
                          return;
                      }
                      
                      const showError = (message) => {
                          const feedback = createEl('div', {
                              style: 'position:fixed; top:20px; left:50%; transform:translateX(-50%); background:rgba(239,68,68,0.9); color:#fff; padding:12px 24px; border-radius:8px; z-index:1000; box-shadow:0 4px 6px rgba(0,0,0,0.1);'
                          }, message);
                          document.body.appendChild(feedback);
                          setTimeout(() => feedback.remove(), 2000);
                      };
                      
                      if (questionType === 'multiple-choice' && questionWrap.validateSelection) {
                          const validation = questionWrap.validateSelection();
                          if (!validation.valid) {
                              showError(validation.message);
                              return;
                          }
                      }
  
                      try {
                          window.__MODALFLOW_ANSWERS__ = window.__MODALFLOW_ANSWERS__ || {};
                          const key = step.id || ('step-' + index);
  
                          let answerValue = selectedValue;
                          if (input && !selectedValue) {
                              answerValue = String(input.value || '');
                          }
  
                          window.__MODALFLOW_ANSWERS__[key] = answerValue;
                      } catch (_) { }
  
                      try {
                          let actionExecuted = false;
                          
                          if (whenAnswerSubmittedItem && Array.isArray(whenAnswerSubmittedItem.actions) && whenAnswerSubmittedItem.actions.length > 0) {
                              const actions = whenAnswerSubmittedItem.actions;
                              const navAction = actions.find(act =>
                                  String(act.type || act.id || '').toLowerCase() === 'navigatetopage'
                              );

                              if (navAction && navAction.pageUrl) {
                                  actionExecuted = true;
                                  const url = navAction.pageUrl;
                                  const newTab = !!(navAction.openInNewTab || navAction.newTab);
                                  const goToStepAction = actions.find(act => {
                                      const actType = String(act.type || act.id || '').toLowerCase();
                                      return actType === 'gotostep' || actType === 'next';
                                  });
                                  if (goToStepAction) {
                                      let targetIdx = Number(goToStepAction.stepId || goToStepAction.value);
                                      if (!Number.isFinite(targetIdx)) {
                                          const i = guideData.findIndex(s => String(s.id) === String(goToStepAction.stepId || goToStepAction.value));
                                          if (i >= 0) targetIdx = i;
                                      }

                                      if (Number.isFinite(targetIdx)) {
                                          try {
                                              setForcedStartStep(targetIdx);
                                              localStorage.setItem('MF_START_STEP', String(targetIdx));
                                          } catch (_) { }

                                          const newUrl = addMfStartToUrl(url, targetIdx);

                                          if (newTab) {
                                              window.open(String(newUrl), '_blank');
                                              removeAllBoxes();
                                              renderStep(targetIdx);
                                          } else {
                                              window.location.href = String(newUrl);
                                          }
                                          return;
                                      }
                                  }
                                  if (newTab) {
                                      window.open(String(url), '_blank');
                                  } else {
                                      window.location.href = String(url);
                                  }
                                  return;
                              }

                              for (const act of actions) {
                                  const actionType = String(act.type || act.id || '').toLowerCase();

                                  if (actionType === 'gotostep' || actionType === 'next') {
                                      actionExecuted = true;
                                      let targetIdx = Number(act.stepId || act.step_id || act.value);
                                      if (!Number.isFinite(targetIdx)) {
                                          const i = guideData.findIndex(s => String(s.id) === String(act.stepId || act.step_id || act.value));
                                          if (i >= 0) targetIdx = i;
                                      }
                                      if (Number.isFinite(targetIdx)) {
                                          removeAllBoxes();
                                          renderStep(Number(targetIdx));
                                          return;
                                      }
                                  } else if (actionType === 'dismissflow' || actionType === 'dismiss') {
                                      actionExecuted = true;
                                      endGuide();
                                      return;
                                  } else if (actionType === 'evaluatejavascript' && act.value) {
                                      actionExecuted = true;
                                      try { Function(String(act.value))(); } catch (_) { }
                                  }
                              }
                          }

                          if (actionExecuted) {
                              if (index < guideData.length - 1) {
                                  renderStep(index + 1);
                              } else {
                                  endGuide();
                              }
                          }
                      } catch (_) {
                          if (whenAnswerSubmittedItem && Array.isArray(whenAnswerSubmittedItem.actions) && whenAnswerSubmittedItem.actions.length > 0) {
                              if (index < guideData.length - 1) {
                                  renderStep(index + 1);
                              } else {
                                  endGuide();
                              }
                          }
                      }
                  };
                  if (questionType == "multi-line-text" || questionType == "multiple-choice" || questionType == "single-line-text") {
                      actions.appendChild(submitBtn);
                      questionWrap.appendChild(actions);
                  }
              }
  
               ab.filter(b => b && b.type === 'button').forEach(btnBlock => {
      try {
          // New format only
          const rawLabel = btnBlock.text;
          const buttonStyle = btnBlock.style;
          const buttonActions = Array.isArray(btnBlock.actions) ? btnBlock.actions : [];
          
          if (!rawLabel || !String(rawLabel).trim()) { return; }
          
          const label = String(rawLabel).trim();
          const values = buttonActions;
          
          const btn = createEl('button', {
              class: buttonStyle === 'secondary' ? 'mf-btn-secondary' : 'mf-btn',
              style: 'margin-top:10px; padding:6px 14px; border-radius:8px;'
          }, label);
          applyButtonConditions(btnBlock, btn);
          
          const runBlockActions = () => {
              if (btn.disabled) return;
              try {
                  executeStepActions(values);
              } catch (e) {
                  console.error('[ModalFlow] Error running button actions:', e);
              }
          };
          
          btn.onclick = runBlockActions;
          try {
              if (window.__MF_POPOVER_SHIELD__ && window.__MF_POPOVER_SHIELD__.shieldButton) {
                  window.__MF_POPOVER_SHIELD__.shieldButton(btn);
              }
          } catch (_) { }
          actionsWrap = actionsWrap || createEl('div', { 
              style: 'margin-top:12px; width:100%; display:flex; justify-content:flex-end; gap:8px;' 
          });
          actionsWrap.appendChild(btn);
      } catch (e) {
          console.error('[ModalFlow] Error creating button:', e);
      }
  });
          } catch (_) { }
          const closeBtn = createEl("button", {
              class: "mf-close-btn"
          }, "&times;");
          try {
              if (window.__MF_POPOVER_SHIELD__ && window.__MF_POPOVER_SHIELD__.shieldButton) {
                  window.__MF_POPOVER_SHIELD__.shieldButton(closeBtn);
              }
          } catch (_) { }
  
          closeBtn.onclick = () => {
              enableScroll();
              const allowRestart = !!(
                  (setup && (setup.allow_restart === true || setup.allow_restart === 'true' || setup.allow_restart === 1 || setup.allow_restart === '1')) ||
                  (setup && setup.settings && (setup.settings.allow_restart === true || setup.settings.allow_restart === 'true' || setup.settings.allow_restart === 1 || setup.settings.allow_restart === '1'))
              );
              if (allowRestart) {
                  showRestartMenu();
              } else {
                  try { endGuide(); } catch (_) { }
              }
          };

          if (stepType === "modal") {
              if (title) {
                  title.style.flexShrink = '0';
                  stepBox.append(title);
              }
              const bodyWrap = createEl('div', { class: 'mf-step-body' });
              bodyWrap.style.flex = '1 1 auto';
              bodyWrap.style.minHeight = '0';
              bodyWrap.style.overflowY = 'auto';
              bodyWrap.appendChild(content);
              if (questionWrap) { bodyWrap.appendChild(questionWrap); }
              stepBox.appendChild(bodyWrap);
              if (actionsWrap) {
                  actionsWrap.style.flexShrink = '0';
                  stepBox.appendChild(actionsWrap);
              }
          } else {
              if (title) stepBox.append(title);
              stepBox.append(content);
              if (questionWrap) { stepBox.appendChild(questionWrap); }
              if (actionsWrap) { stepBox.appendChild(actionsWrap); }
          }
          
          if (stepType === "tooltip" || stepType === "bubble") {
              if (stepBox._positionTooltip && typeof stepBox._positionTooltip === 'function') {
                  requestAnimationFrame(() => {
                      stepBox._positionTooltip();
                  });
              }
          }
          let prevent = false;
          try {
              if (setup && typeof setup.prevent_closing !== 'undefined') prevent = !!setup.prevent_closing;
              else if (setup && setup.settings && typeof setup.settings.prevent_closing !== 'undefined') prevent = !!setup.settings.prevent_closing;
          } catch (_) { prevent = false; }
          if (prevent === false) stepBox.appendChild(closeBtn);

          const stepBlocks = getStepBlocks(step);
          const hasButtonBlocks = Array.isArray(stepBlocks) && stepBlocks.filter(b => b && b.type === 'button').length > 0;
          const isLastStep = index >= guideData.length - 1;
          
          if (!actionsWrap && !hasButtonBlocks && isLastStep) {
              const finishBtn = createEl("button", {
                  class: "mf-btn",
                  style: "margin-top:10px; padding:8px 14px; border-radius:6px;"
              }, "Finish");
              try {
                  if (window.__MF_POPOVER_SHIELD__ && window.__MF_POPOVER_SHIELD__.shieldButton) {
                      window.__MF_POPOVER_SHIELD__.shieldButton(finishBtn);
                  }
              } catch (_) { }
              finishBtn.onclick = () => {
                  removeAllBoxes();
                  try { enableScroll(); endGuide(); } catch (_) { }
              };
              const navActions = createEl('div', { class: 'mf-actions', style: 'margin-top:16px; display:flex; justify-content:flex-end;' });
              navActions.appendChild(finishBtn);
              if (stepType === 'modal') { navActions.style.flexShrink = '0'; }
              stepBox.appendChild(navActions);
          }

          function placeNearTarget(target, box, type, position, absXY) {
              const rect = target.getBoundingClientRect();
              box.style.position = "fixed";
              box.style.zIndex = "2147483647";
              const gap = 10;

              if (type === "tooltip" || type === "bubble") {
                  const vw = Math.max(document.documentElement.clientWidth || 0, window.innerWidth || 0);
                  const vh = Math.max(document.documentElement.clientHeight || 0, window.innerHeight || 0);
                  if (!document.body.contains(box)) {
                      document.body.appendChild(box);
                  }

                  const boxW = box.offsetWidth;
                  const boxH = box.offsetHeight;
                  const elW = rect.right - rect.left;
                  const elH = rect.bottom - rect.top;

                  let finalPos;
                  let left = rect.left + (elW - boxW) / 2;
                  let top = rect.bottom + gap;

                  if (absXY && Number.isFinite(absXY.x) && Number.isFinite(absXY.y)) {
                      left = absXY.x;
                      top = absXY.y;
                      finalPos = position || "belowTarget";
                  } else {
                      const positions = [
                          {
                              name: "aboveTarget",
                              left: rect.left + (elW - boxW) / 2,
                              top: rect.top - boxH - gap,
                              fits: rect.top - boxH - gap >= 8
                          },
                          {
                              name: "leftOfTarget",
                              left: rect.left - boxW - gap,
                              top: rect.top + (elH - boxH) / 2,
                              fits: rect.left - boxW - gap >= 8
                          },
                          {
                              name: "rightOfTarget",
                              left: rect.right + gap,
                              top: rect.top + (elH - boxH) / 2,
                              fits: rect.right + gap + boxW <= vw - 8
                          },
                          {
                              name: "belowTarget",
                              left: rect.left + (elW - boxW) / 2,
                              top: rect.bottom + gap,
                              fits: rect.bottom + gap + boxH <= vh - 8
                          }
                      ];

                      if (position) {
                          const preferred = positions.find(p => p.name === position);
                          if (preferred && preferred.fits) {
                              left = preferred.left;
                              top = preferred.top;
                              finalPos = preferred.name;
                          } else {
                              const available = positions.find(p => p.fits) || positions[0];
                              left = available.left;
                              top = available.top;
                              finalPos = available.name;
                          }
                      } else {
                          const available = positions.find(p => p.fits) || positions[3];
                          left = available.left;
                          top = available.top;
                          finalPos = available.name;
                      }
                  }

                  left = Math.max(8, Math.min(left, vw - boxW - 8));
                  top = Math.max(8, Math.min(top, vh - boxH - 8));

                  box.style.left = left + "px";
                  box.style.top = top + "px";

                  try { box._actualPosition = finalPos || position || "belowTarget"; } catch (_) { }
                  try { if (typeof box._setTailStyle === 'function') box._setTailStyle(box._actualPosition); } catch (_) { }
                  try {
                      const pb = box._progressBarEl || box.querySelector('.mf-progress-bar');
                      if (pb) {
                          if (box._actualPosition === 'aboveTarget') {
                              pb.style.top = '0';
                              pb.style.bottom = 'auto';
                              pb.style.borderRadius = '10px 10px 0 0';
                          } else {
                              pb.style.top = 'auto';
                              pb.style.bottom = '0';
                              pb.style.borderRadius = '0 0 10px 10px';
                          }
                      }
                  } catch (_) { }
              }
          }
  
          if ((stepType === "tooltip" || stepType === "bubble") && !stepBox._targetElement) {
              let cssSelector = '';
              let positionPref = 'belowTarget';
              let addBackdrop = false;
              let blockTargetClicks = false;
              let backdropPadding = 0;
              let absXY = null;
              let selectedRect = null;
              
              if (step.target && step.target.selector) {
                  cssSelector = getSelectorValue(step.target.selector);
              }
              
              if (step.ui) {
                  if (step.ui.backdrop !== undefined) addBackdrop = step.ui.backdrop;
                  if (step.ui.blockTargetClicks !== undefined) blockTargetClicks = step.ui.blockTargetClicks;
                  if (step.ui.backdropPadding !== undefined) backdropPadding = step.ui.backdropPadding;
                  if (step.ui.position !== undefined) positionPref = step.ui.position;
              }

              const target = cssSelector ? document.querySelector(cssSelector) : null;
              if (target) {
                  overlay.style.background = 'transparent';
                  overlay.style.pointerEvents = 'none';
                  const tRect = target.getBoundingClientRect();
                  if (addBackdrop) {
                      drawSpotlightAroundTarget(overlay, tRect, backdropPadding, !!blockTargetClicks, absXY);
                  } else {
                      overlay.innerHTML = '';
                  }
                  stepBox.style.pointerEvents = 'auto';
                  if (stepType === 'tooltip') {
                      stepBox.style.setProperty('padding', '24px 16px 12px 16px', 'important');

                      const existingTails = stepBox.querySelectorAll('.mf-tooltip-tail');
                      existingTails.forEach(t => t.remove());
  
                      const tail = createEl('div', {});
                      tail.className = 'mf-tooltip-tail';
                      tail.style.position = 'absolute';
                      const setTail = (pos) => {
                          const tailColor = theme === 'dark' ? '#1f2937' : '#ffffff';
                          if (pos === 'aboveTarget') {
                              tail.style.left = '20px'; tail.style.top = (stepBox.offsetHeight) + 'px';
                              tail.style.borderLeft = '10px solid transparent';
                              tail.style.borderRight = '10px solid transparent';
                              tail.style.borderTop = '10px solid ' + tailColor;
                              tail.style.borderBottom = '0';
                          } else if (pos === 'leftOfTarget') {
                              tail.style.top = '20px'; tail.style.left = (stepBox.offsetWidth) + 'px';
                              tail.style.borderTop = '10px solid transparent';
                              tail.style.borderBottom = '10px solid transparent';
                              tail.style.borderLeft = '10px solid ' + tailColor;
                              tail.style.borderRight = '0';
                          } else if (pos === 'rightOfTarget') {
                              tail.style.top = '20px'; tail.style.left = '-10px';
                              tail.style.borderTop = '10px solid transparent';
                              tail.style.borderBottom = '10px solid transparent';
                              tail.style.borderRight = '10px solid ' + tailColor;
                              tail.style.borderLeft = '0';
                          } else { // belowTarget default
                              tail.style.left = '20px'; tail.style.top = '-10px';
                              tail.style.borderLeft = '10px solid transparent';
                              tail.style.borderRight = '10px solid transparent';
                              tail.style.borderBottom = '10px solid ' + tailColor;
                              tail.style.borderTop = '0';
                          }
                      };
                      setTail(positionPref);
                      stepBox.appendChild(tail);
                      addProgressBar(positionPref);
                      
                      const alignTailToTarget = () => {
                          try {
                              const tRect2 = target.getBoundingClientRect();
                              const bRect = stepBox.getBoundingClientRect();
                              const centerX = tRect2.left + (tRect2.width / 2);
                              const centerY = tRect2.top + (tRect2.height / 2);
                              const pos = stepBox._actualPosition || positionPref;
                              if (pos === 'belowTarget' || !pos) {
                                  const rel = Math.max(10, Math.min(bRect.width - 10, centerX - bRect.left));
                                  tail.style.left = (rel - 10) + 'px'; tail.style.top = '-10px';
                              } else if (pos === 'aboveTarget') {
                                  const rel = Math.max(10, Math.min(bRect.width - 10, centerX - bRect.left));
                                  tail.style.left = (rel - 10) + 'px'; tail.style.top = (stepBox.offsetHeight) + 'px';
                              } else if (pos === 'rightOfTarget') {
                                  const rel = Math.max(10, Math.min(bRect.height - 10, centerY - bRect.top));
                                  tail.style.top = (rel - 10) + 'px'; tail.style.left = '-10px';
                              } else if (pos === 'leftOfTarget') {
                                  const rel = Math.max(10, Math.min(bRect.height - 10, centerY - bRect.top));
                                  tail.style.top = (rel - 10) + 'px'; tail.style.left = (stepBox.offsetWidth) + 'px';
                              }
                          } catch (_) { }
                      };
                      setTimeout(alignTailToTarget, 0);
                  }
                  stepBox.setAttribute('data-modalflow-box', '1');
                  placeNearTarget(target, stepBox, stepType, positionPref, absXY);
                  try { if (stepType === 'tooltip' && stepBox.lastChild) { /* already scheduled above */ } } catch (_) { }
              } else {
                  if (stepType === 'bubble') {
                      const showBackdrop = getStepAddBackdrop(step);
                      overlay.style.background = showBackdrop ? 'rgba(0,0,0,0.5)' : 'transparent';
                      overlay.style.pointerEvents = showBackdrop ? 'auto' : 'none';
                      stepBox.style.position = 'fixed';
                      stepBox.style.left = '20px';
                      stepBox.style.bottom = '90px';
                      stepBox.style.zIndex = 1000001;
                      stepBox.style.pointerEvents = 'auto';
  
                      const existingBubbleTails = stepBox.querySelectorAll('.mf-tooltip-tail');
                      existingBubbleTails.forEach(t => t.remove());
  
                      const tail = createEl('div', {
                          style: 'position:absolute; left:20px; bottom:-10px; width:0; height:0; border-left:10px solid transparent; border-right:10px solid transparent; border-top:10px solid ' + (theme === 'dark' ? '#1f2937' : '#ffffff') + ';'
                      });
                      tail.className = 'mf-tooltip-tail';
                      stepBox.appendChild(tail);
                      addProgressBar('aboveTarget'); // Bubble tail is at bottom, so progress at top
                      
                      stepBox.setAttribute('data-modalflow-box', '1');
                      overlay.appendChild(stepBox);
                      
                      const avatarContainer = createEl('div', {
                          style: 'position:fixed; left:20px; bottom:20px; z-index:1000000; width:56px; height:56px; border-radius:50%; background:var(--ms-theme-background-secondary, #f3f4f6); border:3px solid white; box-shadow:0 2px 8px rgba(0,0,0,0.15); display:flex; align-items:center; justify-content:center; overflow:hidden;'
                      });
                      avatarContainer.setAttribute('data-modalflow-avatar', '1');
                      const avatarUrl = 'https://hlptflowbuilder.s3.us-east-1.amazonaws.com/assets/avatar.svg';
                      const avatar = createEl('img', {
                          src: avatarUrl,
                          alt: 'Avatar',
                          style: 'width:56px; height:56px; border-radius:50%; object-fit:cover;'
                      });
                      
                      avatarContainer.appendChild(avatar);
                      overlay.appendChild(avatarContainer);
                  } else {
                      stepBox.setAttribute('data-modalflow-box', '1');
                      if (absXY || selectedRect) {
                          overlay.style.background = 'transparent';
                          overlay.style.pointerEvents = 'none';
                          document.body.appendChild(stepBox);
                          const px = absXY ? absXY.x : (selectedRect ? selectedRect.x : 0);
                          const py = absXY ? absXY.y : (selectedRect ? selectedRect.y + (selectedRect.height || 0) + 10 : 0);
                          placeNearTarget({ getBoundingClientRect: () => ({ left: px, top: py, right: px, bottom: py }) }, stepBox, stepType, positionPref, { x: px, y: py });
                          try { if (selectedRect) highlightTargetRect({ left: selectedRect.x, top: selectedRect.y, right: selectedRect.x + (selectedRect.width || 0), bottom: selectedRect.y + (selectedRect.height || 0) }, 4); } catch (_) { }
                      } else {
                          const displayTime = Date.now();
                          const renderStart = window.__MF_RENDER_START_TIME__;
                          const scriptExecStart = window.__MF_CURRENT_EXECUTION__?.time;
                          const delayFromRenderStart = renderStart ? (displayTime - renderStart) : 0;
                          const totalDelay = scriptExecStart ? (displayTime - scriptExecStart) : 0;
                          overlay.append(stepBox);
                      }
                  }
              }
          } else {
              stepBox.setAttribute('data-modalflow-box', '1');
              const displayTime = Date.now();
              const renderStart = window.__MF_RENDER_START_TIME__;
              const scriptExecStart = window.__MF_CURRENT_EXECUTION__?.time;
              const delayFromRenderStart = renderStart ? (displayTime - renderStart) : 0;
              const totalDelay = scriptExecStart ? (displayTime - scriptExecStart) : 0;
              overlay.append(stepBox);
          }
      }
      function readForcedStartStep() {
          try {
              const params = new URLSearchParams(window.location.search);
              const step = params.get('mf_start_step');
              if (step) {
                  const parsed = parseInt(step, 10);
                  return parsed;
              }
          } catch (e) {
              console.error('[Modalflow] Error reading mf_start_step:', e);
          }
          return null;
      }
  const doAutoStart = shouldAutoStart(setup);
  const doTempHide = shouldTemporaryHide(setup);
  const forceStart = setup.__forceStart === true;
  
  let configuredStartStep = null;
  try {
      if (setup && setup.launcher_behaviour) {
          let launcherData = setup.launcher_behaviour;
          if (typeof launcherData === 'string') {
              launcherData = JSON.parse(launcherData);
          }
          
          if (launcherData && Array.isArray(launcherData.action)) {
              const startFlowAction = launcherData.action.find(a => 
                  a && (a.type === 'startFlow' || a.type === 'start_flow' || a.condition_type === 'startflow')
              );
              const stepId = startFlowAction && (startFlowAction.step_id || startFlowAction.stepid);
              if (stepId) {
                  const stepIndex = guideData.findIndex(s => s.id === stepId);
                  if (stepIndex >= 0) {
                      configuredStartStep = stepIndex;
                  }
              }
          }
      }
  } catch (e) {
      console.error('[Modalflow] Error parsing launcher_behaviour:', e);
  }
  
  // Check for forced step from URL or localStorage (highest priority)
  let forcedStep = null;
  let urlParamFound = false;
  
  try {
      const params = new URLSearchParams(window.location.search);
      const urlStep = params.get('mf_start_step');
      if (urlStep) {
          forcedStep = parseInt(urlStep, 10);
          urlParamFound = true;
          try {
              sessionStorage.setItem('MF_URL_PARAM_PROCESSED', 'true');
              sessionStorage.setItem('MF_FORCED_STEP', String(forcedStep));
          } catch(_) {}
          
          setTimeout(() => {
              try {
                  const params = new URLSearchParams(window.location.search);
                  params.delete('mf_start_step');
                  const newUrl = window.location.pathname + (params.toString() ? '?' + params.toString() : '') + window.location.hash;
                  window.history.replaceState({}, '', newUrl);
              } catch(_) {}
          }, 500);
      }
  } catch (e) {
      console.error('[Modalflow] Error reading URL param:', e);
  }
  
  if (!Number.isFinite(forcedStep)) {
      try {
          const stored = localStorage.getItem('MF_START_STEP');
          if (stored) {
              forcedStep = parseInt(stored, 10);
              localStorage.removeItem('MF_START_STEP');
          }
      } catch (e) {
          console.error('[Modalflow] Error reading localStorage:', e);
      }
  }
  
  const hasForcedStep = Number.isFinite(forcedStep) && forcedStep >= 0 && forcedStep < guideData.length;
  
  let startStep = 0;
  let shouldStart = false;
  
  if (window.__MF_EARLY_SHOULD_START__ !== undefined && window.__MF_EARLY_START_STEP__ !== undefined) {
    shouldStart = window.__MF_EARLY_SHOULD_START__;
    startStep = window.__MF_EARLY_START_STEP__;
    delete window.__MF_EARLY_SHOULD_START__;
    delete window.__MF_EARLY_START_STEP__;
  } else {
    const doAutoStart = shouldAutoStart(setup);
    const doTempHide = shouldTemporaryHide(setup);
    const forceStart = setup.__forceStart === true;
    
    if (hasForcedStep) {
        startStep = forcedStep;
        shouldStart = true;
    } else if (Number.isFinite(configuredStartStep) && (forceStart || doAutoStart) && !doTempHide) {
        startStep = configuredStartStep;
        shouldStart = true;
    } else if (forceStart && !doTempHide) {
        startStep = 0;
        shouldStart = true;
    } else if (doAutoStart && !doTempHide) {
        startStep = 0;
        shouldStart = true;
    }
  }
  
  if (shouldStart) {
      const globalLockKey = '__MF_GLOBAL_RENDER_LOCK__';
      const flowInstanceKey = '__MF_FLOW_INSTANCE_' + (guideData[0]?.id || 'default');
      
      const lockTime = window[globalLockKey + '_TIME'];
      const now = Date.now();
      if (window[globalLockKey] && lockTime && (now - lockTime) < 2000) {
          return;
      }
      
      window[globalLockKey] = true;
      window[globalLockKey + '_TIME'] = now;
      window[flowInstanceKey] = true;
      
      setTimeout(function() {
          renderStep(startStep);
          
          setTimeout(function() {
              window[globalLockKey] = false;
              window[flowInstanceKey] = false;
              delete window[globalLockKey + '_TIME'];
          }, 1000);
      }, 0);
  }
  
  window.__START_MODALFLOW__ = function(){
    try {
        try {
          const existingOverlay = document.getElementById('modalflow-guide-overlay');
          if (existingOverlay) {
              existingOverlay.remove();
          }
          removeAllBoxes();
          cleanupAllBeaconsAndTooltips();
      } catch(_) {}
      const forced = readForcedStartStep();
      if (Number.isFinite(forced) && forced >= 0 && forced < guideData.length) {
        renderStep(forced);
      } else {
        renderStep(0);
      }
    } catch(err) {
      console.error('[Modalflow] Error in manual start:', err);
    }
  };
  
  window.__START_MODALFLOW_FORCE__ = function(){
    try { 
      try {
          const existingOverlay = document.getElementById('modalflow-guide-overlay');
          if (existingOverlay) {
              existingOverlay.remove();
          }
          removeAllBoxes();
          cleanupAllBeaconsAndTooltips();
      } catch(_) {}
      
      renderStep(0); 
    } catch(err) {
      console.error('[Modalflow] Error in force start:', err);
    }
  };
      `;
    };
    sdk._executeFlow = async function (flowId, refKey, data = {}) {
        if (!isOperationAllowed()) return;

        const token = sdk._token;
        if (!token) {
            return;
        }

        // Track active flowId for URL condition checking
        try {
            sessionStorage.setItem('modalflow_active_flow_id', flowId);
            window.__CURRENT_FLOW_ID__ = flowId;
            document.body.classList.add('modalflow-active');
        } catch (e) {}

        const executionKey = `__MF_EXECUTING_${flowId}`;

        // Clear any stale execution locks (older than 2 seconds)
        if (window[executionKey]) {
            const lockTime = window[executionKey + '_TIME'];
            const now = Date.now();
            if (lockTime && (now - lockTime) < 2000) {
                return;
            }
        }

        window[executionKey] = true;
        const executionStartTime = Date.now();
        window[executionKey + '_TIME'] = executionStartTime;

        try {
            if (!sdk._flowObjects || !sdk._flowObjects[flowId]) {
                const envKey = window.__modalFlowEnvKey || '';
                const flowDataResult = await sdk._loadFlowData(flowId, refKey, { envKey });
                if (!flowDataResult) {
                    console.error(`[ModalFlow] Failed to load flow data for ${flowId}`);
                    window[executionKey] = false;
                    delete window[executionKey + '_TIME'];
                    return;
                }
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            
            if (!sdk._flowObjects || !sdk._flowObjects[flowId]) {
                window[executionKey] = false;
                delete window[executionKey + '_TIME'];
                return;
            }

            // Handle specific step to start from
            if (data && data.startStepId) {
                const flowSteps = sdk._flowObjects[flowId] || [];
                const stepIndex = flowSteps.findIndex(step => String(step.id) === String(data.startStepId));

                if (stepIndex >= 0) {
                    try {
                        localStorage.setItem('MF_START_STEP', String(stepIndex));
                    } catch (_) { }

                    const fromLauncher =
                      !!data.fromLauncher ||
                      !!data.__fromLauncher ||
                      !!data.skipUrlUpdate ||
                      !!data.__skipUrlUpdate ||
                      (function () {
                        try { return sessionStorage.getItem('modalflow_from_launcher') === 'true'; } catch (_) { return false; }
                      })();

                    if (!fromLauncher) {
                        try {
                            const currentUrl = new URL(window.location.href);
                            currentUrl.searchParams.set('mf_start_step', String(stepIndex));
                            window.history.replaceState({}, '', currentUrl.toString());
                        } catch (_) { }
                    }
                } else {
                    console.warn('[ModalFlow] Step ID not found:', data.startStepId);
                }
            }

            const existingScript = document.getElementById(`modalflow-script-${flowId}`);
            if (existingScript) {
                if (window.__START_MODALFLOW__) {
                    existingScript.remove();
                    const oldOverlay = document.getElementById('modalflow-guide-overlay');
                    if (oldOverlay) oldOverlay.remove();

                    let setupConfig = sdk._flowsetup[flowId] || {};
                    setupConfig = { ...setupConfig, __forceStart: true };
                    await sdk._injectInlineModalflowScript(flowId, setupConfig);
                }
            } else {
                let setupConfig = sdk._flowsetup[flowId] || {};
                setupConfig = { ...setupConfig, __forceStart: true };
                await sdk._injectInlineModalflowScript(flowId, setupConfig);
            }

            sdk._refreshLauncherVisibilityWithRaf(flowId, [0, 120, 350, 900]);

            setTimeout(() => {
                window[executionKey] = false;
                delete window[executionKey + '_TIME'];
            }, 1000);

        } catch (err) {
            console.error("[ModalFlow] Flow execution failed:", err);
            window[executionKey] = false;
            delete window[executionKey + '_TIME'];
        }
    };

    sdk._checkAutoStartConditions = function (autoStartConfig) {
        if (!autoStartConfig) {
            return false;
        }

        const conds = autoStartConfig.conditions;
        if (!conds || conds.length === 0) {
            return true;
        }

        let result = null;
        for (let i = 0; i < conds.length; i++) {
            const condition = conds[i];
            const passed = sdk._evaluateAutoStartCondition(condition);
            const conditionType = String(condition.condition_type || 'if').toLowerCase();
            if (conditionType === 'or') {
                result = result === null ? passed : (result || passed);
            } else {
                result = result === null ? passed : (result && passed);
            }
        }
        return result !== null ? result : true;
    };

    sdk._evaluateAutoStartCondition = function (condition) {
        try {
            const type = String(condition && condition.type || '').toLowerCase();
            if (!type) return false;
            
            if (type === 'current_page_url') {
                const currentUrl = window.location.href;
                const matches = Array.isArray(condition.match_values) ? condition.match_values : [];
                const noMatches = Array.isArray(condition.no_match_values) ? condition.no_match_values : [];
                
                const okMatch = matches.length === 0 ? true : matches.some(v => v && sdk._matchesUrlPattern(String(v), currentUrl));
                const okNoMatch = noMatches.every(v => !sdk._matchesUrlPattern(String(v), currentUrl));
                return okMatch && okNoMatch;
            }
            
            if (type === 'current_time') {
                const now = Date.now();
                const start = Date.parse(condition.initalDateTime || condition.initialDateTime || '');
                const end = Date.parse(condition.finalDateTime || condition.endDateTime || '');
                if (Number.isFinite(start) && Number.isFinite(end)) return now >= start && now <= end;
                if (Number.isFinite(start) && !Number.isFinite(end)) return now >= start;
                if (!Number.isFinite(start) && Number.isFinite(end)) return now <= end;
                return false;
            }
        } catch (_) { }
        return false;
    };

    sdk._checkFlowAppUrl = function (flowId) {
        const currentUrl = window.location.href;
        const flowSteps = sdk._flowObjects?.[flowId] || [];

        for (const step of flowSteps) {
            let appUrl = null;

            if (step.tooltipBlock && step.tooltipBlock.content) {
                const content = step.tooltipBlock.content;
                for (const item of content) {
                    if (item.id === 'showTooltipOnThisElement' && item.selectElementValues && item.selectElementValues.appUrl) {
                        appUrl = item.selectElementValues.appUrl.value;
                        break;
                    }
                }
            }

            if (step.additionalBlocks && Array.isArray(step.additionalBlocks)) {
                for (const block of step.additionalBlocks) {
                    if (block.content && Array.isArray(block.content)) {
                        for (const item of block.content) {
                            if (item.id === 'selectBeaconOnElement' && item.selectElementValues && item.selectElementValues.appUrl) {
                                appUrl = item.selectElementValues.appUrl.value;
                                break;
                            }
                        }
                    }
                    if (appUrl) break;
                }
            }

            if (appUrl) {
                const matches = sdk._matchesUrlPattern(appUrl, currentUrl);
                if (matches) {
                    return true;
                }
            }
        }
        return false;
    };

    sdk._convertLauncherToOldFormat = function (newLauncher, flowData) {
        try {
            const launcherSetup = {
                urls_matching: newLauncher.rules?.include_urls || [],
                exclude_urls_matching: newLauncher.rules?.exclude_urls || [],
                only_show_launcher: {
                    value: false,
                    conditions: []
                },
                zIndex: "576",
                theme: newLauncher.theme?.mode || "light",
                themeCSS: newLauncher.theme?.customCSS || ""
            };

            const visibilityConditions = newLauncher.rules?.visibility?.conditions || [];
            if (visibilityConditions.length > 0) {
                launcherSetup.only_show_launcher.value = true;
                launcherSetup.only_show_launcher.conditions = visibilityConditions;
            }

            const hideWhenFlowActive = newLauncher.rules?.visibility?.hide_when_flow_active;
            if (hideWhenFlowActive === true) {
                launcherSetup.showLauncherWhileFlowsActive = true;
            } else {
                launcherSetup.showLauncherWhileFlowsActive = false;
            }

            const visibilityZIndex = newLauncher.rules?.visibility?.zIndex;
            if (visibilityZIndex !== null && visibilityZIndex !== undefined) {
                const parsedZIndex = typeof visibilityZIndex === 'string' 
                    ? parseFloat(visibilityZIndex) 
                    : Number(visibilityZIndex);
                if (Number.isFinite(parsedZIndex)) {
                    launcherSetup.zIndex = String(parsedZIndex);
                }
            }

            const launcherAppearance = {
                type: newLauncher.type || "button",
                value: newLauncher.text || "",
                iconClass: newLauncher.iconClass || "",
                styling: {
                    color: newLauncher.ui?.style?.color || "#ffffff",
                    background: newLauncher.ui?.style?.background || newLauncher.ui?.style?.backgroundColor || "",
                    borderRadius: newLauncher.ui?.style?.borderRadius || "4px",
                    borderColor: newLauncher.ui?.style?.borderColor || "",
                    borderWidth: newLauncher.ui?.style?.borderWidth || "",
                    fontSize: newLauncher.ui?.style?.fontSize || "",
                    textTransform: newLauncher.ui?.style?.textTransform || "",
                    padding: newLauncher.ui?.style?.padding || "",
                    margin: newLauncher.ui?.style?.margin || "",
                    boxShadow: newLauncher.ui?.style?.boxShadow || "",
                    hover: newLauncher.ui?.style?.hover || {}
                },
                launcher_element: (() => {
                    const targetMode = newLauncher.target?.mode || "goManual";
                    
                    if (targetMode === "selectElement" && newLauncher.target?.element) {
                        const element = newLauncher.target.element;
                        return {
                            mode: "selectElement",
                            selectedElementValues: {
                                element: {
                                    cssSelector: element.selector || "",
                                    elementIndex: element.index || 0,
                                    indexMap: element.indexMap || {},
                                    cssSelectors: element.selectors || [],
                                    selectorInfo: element.selectorInfo || [],
                                    targetX1Absolute: newLauncher.target?.absolute?.x || 0,
                                    targetY1Absolute: newLauncher.target?.absolute?.y || 0,
                                    scrollX: 0,
                                    scrollY: 0,
                                    centerX: (newLauncher.target?.absolute?.x || 0) + ((newLauncher.target?.absolute?.width || 0) / 2),
                                    centerY: (newLauncher.target?.absolute?.y || 0) + ((newLauncher.target?.absolute?.height || 0) / 2)
                                },
                                coordinates: {
                                    left: newLauncher.target?.absolute?.x || 0,
                                    top: newLauncher.target?.absolute?.y || 0,
                                    width: newLauncher.target?.absolute?.width || 0,
                                    height: newLauncher.target?.absolute?.height || 0
                                }
                            }
                        };
                    } else {
                        const selectorObj = newLauncher.target?.element?.selector;
                        let selectorValue = "";
                        
                        if (selectorObj && typeof selectorObj === 'object') {
                            selectorValue = selectorObj.value || "";
                        }
                        
                        let ifMultipleValue;
                        const ifMultiple = newLauncher.target?.element?.ifMultiple;
                        if (typeof ifMultiple === 'string') {
                            ifMultipleValue = { type: "labelPopper", value: ifMultiple };
                        } else if (ifMultiple && typeof ifMultiple === 'object') {
                            ifMultipleValue = ifMultiple;
                        } else {
                            ifMultipleValue = { type: "labelPopper", value: "first" };
                        }
                        
                        const elementText = newLauncher.target?.element?.text;
                        
                        return {
                            mode: "goManual",
                            goManualValues: {
                                cssSelector: {
                                    value: selectorValue
                                },
                                ifMultiple: ifMultipleValue,
                                elementText: elementText ? {
                                    value: elementText
                                } : undefined
                            }
                        };
                    }
                })(),
                launcher_position: (() => {
                    const positionAnchor = newLauncher.ui?.position?.anchor || newLauncher.target?.position || "right-top";
                    const offset = newLauncher.ui?.position?.offset || newLauncher.target?.offset || { x: 0, y: 0 };
                    const offsetX = offset.x || 0;
                    const offsetY = offset.y || 0;
                    
                    const positionStr = String(positionAnchor).toLowerCase();
                    const parts = positionStr.split('-');
                    const first = parts[0];
                    const second = parts[1];
                    
                    let vertical, horizontal;
                    if (first === 'left' || first === 'right') {
                        horizontal = first;
                        vertical = second || 'top';
                    } else {
                        vertical = first || 'bottom';
                        horizontal = second || 'right';
                    }
                    
                    const positionObj = {
                        position: `${vertical}-${horizontal}`
                    };
                    
                    if (horizontal === 'left') {
                        positionObj.left = offsetX;
                    } else if (horizontal === 'right') {
                        positionObj.right = offsetX;
                    } else if (horizontal === 'center') {
                        positionObj.left = offsetX;
                    }
                    
                    if (vertical === 'top') {
                        positionObj.top = offsetY;
                    } else if (vertical === 'bottom') {
                        positionObj.bottom = offsetY;
                    } else if (vertical === 'middle' || vertical === 'center') {
                        positionObj.top = offsetY;
                    }
                    
                    return positionObj;
                })()
            };

            const launcherBehaviour = {
                id: "launcher",
                type: "perform_action",
                value: newLauncher.ui?.tooltip?.content || "",
                triggerEvent: newLauncher.trigger || "clicked",
                action: [],
                tooltip: newLauncher.ui?.tooltip || null
            };

            if (newLauncher.ui?.tooltip) {
                const tooltip = newLauncher.ui.tooltip;
                launcherBehaviour.value = tooltip.content || "";
                launcherBehaviour.type = "show_tooltip"; // Set type to show_tooltip so it gets handled correctly
                
                // Add tooltip button actions
                if (tooltip.blocks && Array.isArray(tooltip.blocks)) {
                    tooltip.blocks.forEach(block => {
                        if (block.type === "button" && block.action) {
                            launcherBehaviour.action.push({
                                id: block.id,
                                type: block.action.type === "start_flow" ? "startFlow" : block.action.type,
                                actions: [],
                                flowRef: block.action.flow_ref,
                                stepid: block.action.step_id || "",
                                condition_type: "startflow"
                            });
                        }
                    });
                }
            }

            // Handle launcher action (if not already handled by tooltip)
            if (newLauncher.action === "start_flow" && !newLauncher.ui?.tooltip) {
                launcherBehaviour.action.push({
                    id: Date.now(),
                    type: "startFlow",
                    actions: [],
                    flowRef: newLauncher.flow_ref,
                    stepid: newLauncher.step_id || "",
                    condition_type: "startflow"
                });
            } else if (newLauncher.action === "start_flow" && newLauncher.ui?.tooltip) {
                launcherBehaviour.action.push({
                    id: Date.now(),
                    type: "startFlow",
                    actions: [],
                    flowRef: newLauncher.flow_ref,
                    stepid: newLauncher.step_id || "",
                    condition_type: "startflow"
                });
            }

            return {
                launcher_setup: JSON.stringify(launcherSetup),
                launcher_appearence: JSON.stringify(launcherAppearance),
                launcher_behaviour: JSON.stringify(launcherBehaviour),
                flow_version_id: newLauncher.flow_version_id || null,
                is_enabled: 1
            };
        } catch (e) {
            console.error("[ModalFlow] Failed to convert launcher format:", e);
            return null;
        }
    };

    sdk._processLauncher = async function (launcher, launcherId, refKey, flowRef = null) {
        let setupConfig = {};
        let appearanceConfig = {};
        let behaviourConfig = {};

        try {
            setupConfig = JSON.parse(launcher.launcher_setup || '{}');
            appearanceConfig = JSON.parse(launcher.launcher_appearence || '{}');
            behaviourConfig = JSON.parse(launcher.launcher_behaviour || '{}');
        } catch (e) {
            console.error("[ModalFlow] Failed to parse launcher config:", e);
        }
        
        const actualFlowRef = flowRef || sdk._launcherFlowRefs?.[launcherId] || launcherId;
        sdk._launcherFlowRefs = sdk._launcherFlowRefs || {};
        sdk._launcherFlowRefs[launcherId] = actualFlowRef;
        sdk._launcherFlowVersionIds = sdk._launcherFlowVersionIds || {};
        if (launcher.flow_version_id) {
            sdk._launcherFlowVersionIds[launcherId] = launcher.flow_version_id;
        }
        
        sdk._launcherSetupConfigs = sdk._launcherSetupConfigs || {};
        sdk._launcherSetupConfigs[launcherId] = setupConfig;
        
        const urlParams = new URLSearchParams(window.location.search);
        const hasForcedStep = urlParams.has('mf_start_step');

        if (hasForcedStep) {
            return;
        }
        const urlMatches = sdk._checkLauncherUrlMatching(setupConfig);
        if (!urlMatches) {
            return;
        }
        const shouldShowLauncher = sdk._checkOnlyShowLauncherConditions(setupConfig);
        if (!shouldShowLauncher) {
            return;
        }
        const elementConfig = appearanceConfig.launcher_element;

        if (elementConfig && elementConfig.mode === 'selectElement') {
            sdk._attachLauncherToElement(appearanceConfig, behaviourConfig, launcherId, refKey, actualFlowRef);
        } else if (elementConfig && elementConfig.mode === 'goManual') {
            sdk._attachLauncherToElement(appearanceConfig, behaviourConfig, launcherId, refKey, actualFlowRef);
        } else if (appearanceConfig.type === 'button' || appearanceConfig.type === 'icon' || appearanceConfig.type === 'beacon') {
            sdk._createButtonLauncher(appearanceConfig, behaviourConfig, launcherId, refKey, actualFlowRef);
        }
        sdk._updateLauncherVisibilityForFlow(actualFlowRef);
    };
    sdk._checkOnlyShowLauncherConditions = function (setupConfig) {
        if (!setupConfig.only_show_launcher || !setupConfig.only_show_launcher.value) {
            return true; // If no conditions, always show
        }

        const conditions = setupConfig.only_show_launcher.conditions || [];

        if (conditions.length === 0) {
            return true; // If enabled but no conditions, always show
        }

        const currentUrl = window.location.href;

        // All conditions must pass (AND logic)
        for (const condition of conditions) {
            const conditionType = String(condition.condition_type || '').toLowerCase();
            const type = String(condition.type || '').toLowerCase();

            if (type === 'current_time') {
                const now = Date.now();
                const start = Date.parse(condition.initalDateTime || condition.initialDateTime || '');
                const end = Date.parse(condition.finalDateTime || condition.endDateTime || '');

                let timeMatch = false;
                if (Number.isFinite(start) && Number.isFinite(end)) {
                    timeMatch = now >= start && now <= end;
                } else if (Number.isFinite(start) && !Number.isFinite(end)) {
                    timeMatch = now >= start;
                } else if (!Number.isFinite(start) && Number.isFinite(end)) {
                    timeMatch = now <= end;
                }

                if (conditionType === 'if' && !timeMatch) {
                    return false; // Condition failed
                }
            } else if (type === 'current_page_url') {
                const matchValues = condition.match_values || [];
                const noMatchValues = condition.no_match_values || [];

                let urlMatch = true;

                // Check if URL matches any of the match_values patterns
                if (matchValues.length > 0) {
                    urlMatch = matchValues.some(pattern => {
                        return sdk._matchesUrlPattern(pattern, currentUrl);
                    });
                }

                // Check if URL matches any of the no_match_values patterns (exclusions)
                if (urlMatch && noMatchValues.length > 0) {
                    const excluded = noMatchValues.some(pattern => {
                        return sdk._matchesUrlPattern(pattern, currentUrl);
                    });
                    if (excluded) {
                        urlMatch = false;
                    }
                }

                if (conditionType === 'if' && !urlMatch) {
                    return false; // Condition failed
                }
            }
        }

        return true; // All conditions passed
    };
    sdk._checkLauncherUrlMatching = function (setupConfig) {
        const currentUrl = window.location.href;

        if (setupConfig.urls_matching && setupConfig.urls_matching.length > 0) {
            const matches = setupConfig.urls_matching.some(pattern => {
                // Skip empty strings - they shouldn't match anything
                if (!pattern || pattern.trim() === '') return false;
                return sdk._matchesUrlPattern(pattern, currentUrl);
            });

            if (!matches) {
                return false;
            }
        }

        if (setupConfig.exclude_urls_matching && setupConfig.exclude_urls_matching.length > 0) {
            const excluded = setupConfig.exclude_urls_matching.some(pattern => {
                // Skip empty strings - they shouldn't exclude anything
                if (!pattern || pattern.trim() === '') return false;
                return sdk._matchesUrlPattern(pattern, currentUrl);
            });

            if (excluded) {
                return false;
            }
        }

        return true;
    };
    sdk._getLauncherElementId = function (launcherId, attached = false) {
        const base = 'modal-flow-launcher';
        const normalizedLauncherId = launcherId ? String(launcherId).replace(/[^a-zA-Z0-9-_]/g, '_') : 'default';
        return attached ? `${base}-attached-${normalizedLauncherId}` : `${base}-${normalizedLauncherId}`;
    };

    sdk._getLauncherElementsByLauncherId = function (launcherId) {
        return {
            button: document.getElementById(sdk._getLauncherElementId(launcherId, false)),
            attached: document.getElementById(sdk._getLauncherElementId(launcherId, true))
        };
    };

    // Get launcher elements by flow_ref (returns first matching launcher)
    sdk._getLauncherElementsByFlow = function (flowRef) {
        const launcherIds = sdk._launcherIdsByFlowRef?.[flowRef] || [];
        if (launcherIds.length > 0) {
            return sdk._getLauncherElementsByLauncherId(launcherIds[0]);
        }
        return { button: null, attached: null };
    };

    sdk._removeLauncherElements = function (launcherId) {
        const { button, attached } = sdk._getLauncherElementsByLauncherId(launcherId);
        if (button) {
            button.remove();
        }
        if (attached) {
            if (attached._cleanup) attached._cleanup();
            attached.remove();
        }
    };

    sdk._createButtonLauncher = function (appearance, behaviour, launcherId, refKey, flowRef = null) {
        const tooltipOptions = behaviour?.tooltip?.options || {};
        const dismissAfterFirstActivation = tooltipOptions.dismissAfterFirstActivation || behaviour.dismissAfterFirstActivation === true;
        if (dismissAfterFirstActivation && sdk._isLauncherDismissed(launcherId)) {
            sdk._removeLauncherElements(launcherId);
            return;
        }
        
        sdk._removeLauncherElements(launcherId);

        const launcher = sdk._createLauncherElement(appearance);
        launcher.id = sdk._getLauncherElementId(launcherId, false);
        
        launcher.dataset.launcherId = launcherId;
        const actualFlowRef = flowRef || sdk._launcherFlowRefs?.[launcherId] || launcherId;
        launcher.dataset.flowRef = actualFlowRef;

        const position = appearance.launcher_position || appearance.position || behaviour.position || {};

        const setupConfig = sdk._launcherSetupConfigs?.[launcherId] || {};
        const zIndex = setupConfig.zIndex;

        const posStyles = sdk._getPositionStyles(position, zIndex);
        Object.assign(launcher.style, posStyles);

        // Add event listeners
        launcher.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            sdk._handleLauncherAction(e, 'click', behaviour, launcherId, refKey, actualFlowRef);
        });

        launcher.addEventListener('mouseover', (e) => {
            launcher.dataset.isHovering = 'true';
            sdk._handleLauncherAction(e, 'mouseover', behaviour, launcherId, refKey, actualFlowRef);
        });

        launcher.addEventListener('mouseleave', (e) => {
            delete launcher.dataset.isHovering;
        });

        document.body.appendChild(launcher);
    };

    sdk._getPositionStyles = function (pos, zIndex) {
        let vertical = 'bottom';
        let horizontal = 'right';

        if (pos.position) {
            const posStr = String(pos.position).toLowerCase();
            if (posStr.includes('top')) vertical = 'top';
            if (posStr.includes('bottom')) vertical = 'bottom';
            if (posStr.includes('left')) horizontal = 'left';
            if (posStr.includes('right')) horizontal = 'right';
        }

        const offset = {
            top: parseFloat(pos.top) || 20,
            right: parseFloat(pos.right) || 20,
            bottom: parseFloat(pos.bottom) || 20,
            left: parseFloat(pos.left) || 20
        };

        let effectiveZIndex = '999998';
        if (zIndex !== null && zIndex !== undefined) {
            const parsedZIndex = typeof zIndex === 'string' ? parseFloat(zIndex) : Number(zIndex);
            if (Number.isFinite(parsedZIndex)) {
                effectiveZIndex = String(parsedZIndex);
            }
        }

        const styles = {
            position: 'fixed',
            zIndex: effectiveZIndex
        };

        if (vertical === 'top') {
            styles.top = offset.top + 'px';
        } else {
            styles.bottom = offset.bottom + 'px';
        }

        if (horizontal === 'left') {
            styles.left = offset.left + 'px';
        } else {
            styles.right = offset.right + 'px';
        }

        return styles;
    };
    sdk._isLauncherDismissed = function (launcherId) {
        try {
            const key = `modalflow_launcher_dismissed_${launcherId}`;
            const dismissed = localStorage.getItem(key);
            return dismissed === 'true';
        } catch (e) {
            return false;
        }
    };
    sdk._markLauncherAsDismissed = function (launcherId) {
        try {
            localStorage.setItem(`modalflow_launcher_dismissed_${launcherId}`, 'true');
        } catch (e) {
            console.error('[ModalFlow] Failed to save dismissal state:', e);
        }
    };
    sdk._attachLauncherToElement = async function (appearance, behaviour, launcherId, refKey, flowRef = null) {
        if (!isOperationAllowed()) {
            return;
        }
        
        // Check if dismissAfterFirstActivation exists in launcher object
        const tooltipOptions = behaviour?.tooltip?.options || {};
        const hasDismissAfterFirstActivation = tooltipOptions.hasOwnProperty('dismissAfterFirstActivation');
        const dismissAfterFirstActivationValue = tooltipOptions.dismissAfterFirstActivation;
        
        let isDismissed = false;
        // Only check dismissal if dismissAfterFirstActivation property exists AND is true
        if (hasDismissAfterFirstActivation && dismissAfterFirstActivationValue === true) {
            isDismissed = sdk._isLauncherDismissed(launcherId);
        }
        
        const elementConfig = appearance.launcher_element;

        if (!elementConfig) {
            return;
        }

        const positioningData = sdk._getElementSelectorWithMode(elementConfig);

        if (!positioningData.selector) {
            return;
        }
        
        let targetElement = null;
        try {
            targetElement = await sdk._findElementBySelector(positioningData.selectorData);
        } catch (e) {
            // Continue even if element finding fails
        }
        
        if (isDismissed && refKey) {
            const { button: prevButton, attached: prevAttached } = sdk._getLauncherElementsByLauncherId(launcherId);
            if (prevButton && prevButton._cleanup) prevButton._cleanup();
            if (prevButton) prevButton.remove();
            if (prevAttached) {
                if (prevAttached._cleanup) prevAttached._cleanup();
                prevAttached.remove();
            }
            return;
        }
        
        try {
            if (!targetElement && positioningData.selector) {
                targetElement = await sdk._waitForElement(positioningData.selector, 5000);
                
                if (targetElement && positioningData.selectorData) {
                    const verifiedElement = await sdk._findElementBySelector(positioningData.selectorData);
                    if (verifiedElement) {
                        targetElement = verifiedElement;
                    }
                }
            }

            if (!targetElement) {
                return;
            }
            const { attached: existingLauncher } = sdk._getLauncherElementsByLauncherId(launcherId);
            if (existingLauncher) {
                if (existingLauncher._cleanup) existingLauncher._cleanup();
                existingLauncher.remove();
            }

            const launcher = sdk._createLauncherElement(appearance);
            launcher.id = sdk._getLauncherElementId(launcherId, true);
            
            launcher.dataset.launcherId = launcherId;
            const actualFlowRef = flowRef || sdk._launcherFlowRefs?.[launcherId] || launcherId;
            launcher.dataset.flowRef = actualFlowRef;

            const setupConfig = sdk._launcherSetupConfigs?.[launcherId] || {};
            let effectiveZIndex = '999999';
            if (setupConfig.zIndex !== null && setupConfig.zIndex !== undefined) {
                const parsedZIndex = typeof setupConfig.zIndex === 'string' 
                    ? parseFloat(setupConfig.zIndex) 
                    : Number(setupConfig.zIndex);
                if (Number.isFinite(parsedZIndex)) {
                    effectiveZIndex = String(parsedZIndex);
                }
            }

            launcher.style.position = 'fixed';
            launcher.style.zIndex = effectiveZIndex;
            launcher.style.left = '0';
            launcher.style.top = '0';
            launcher.style.transform = 'translate3d(0px, 0px, 0px)';
            launcher.style.willChange = 'transform';
            launcher.style.opacity = '0';
            launcher.style.pointerEvents = 'none';

            document.body.appendChild(launcher);

            const currentTargetRef = { current: targetElement };

            const resolveElementBySelectorData = (selectorData) => {
                if (!selectorData) return null;
                try {
                    let el = null;
                    if (selectorData.selector) {
                        const matches = document.querySelectorAll(selectorData.selector);
                        const idx = selectorData.index || 0;
                        if (matches.length > idx) el = matches[idx];
                        else if (matches.length > 0 && selectorData.indexMap && Object.keys(selectorData.indexMap).length > 0) {
                            for (const [sel, mapIdx] of Object.entries(selectorData.indexMap)) {
                                try {
                                    const m = document.querySelectorAll(sel);
                                    if (m.length > mapIdx) { el = m[mapIdx]; break; }
                                } catch (e) { continue; }
                            }
                        } else if (matches.length > 0) el = matches[0];
                    }
                    if (!el && selectorData.indexMap && typeof selectorData.indexMap === 'object') {
                        for (const [sel, idx] of Object.entries(selectorData.indexMap)) {
                            try {
                                const m = document.querySelectorAll(sel);
                                if (m.length > idx) { el = m[idx]; break; }
                            } catch (e) { continue; }
                        }
                    }
                    if (!el && selectorData.cssSelectors && Array.isArray(selectorData.cssSelectors) && selectorData.cssSelectors.length > 0) {
                        for (const sel of selectorData.cssSelectors) {
                            if (!sel || sel === selectorData.selector) continue;
                            try {
                                const m = document.querySelectorAll(sel);
                                if (m.length > 0) {
                                    const ti = (selectorData.index || 0) < m.length ? (selectorData.index || 0) : 0;
                                    el = m[ti];
                                    break;
                                }
                            } catch (e) { continue; }
                        }
                    }
                    return (el && document.body.contains(el)) ? el : null;
                } catch (e) { return null; }
            };

            // Setup positioning state
            let initialScrollX = null;
            let initialScrollY = null;
            let apiCoords = null;
            let lastUpdateTime = 0;
            let isTargetInView = false;
            let hasInitializedPosition = false;
            let customViewportBounds = null;
            const isInFixedContainer = currentTargetRef.current ? sdk._isElementInFixedContainer(currentTargetRef.current) : false;
            let lastRect = null; // Track last known rect position for change detection
            let rafId = null; // Track requestAnimationFrame ID for cleanup

            const updatePosition = (forceUpdate) => {
                try {
                    const now = Date.now();
                    if (!forceUpdate && hasInitializedPosition && now - lastUpdateTime < 16) return;
                    lastUpdateTime = now;

                    let rect;
                    const currentScrollX = window.pageXOffset || document.documentElement.scrollLeft;
                    const currentScrollY = window.pageYOffset || document.documentElement.scrollTop;

                    if (positioningData.mode === 'selectElement' && positioningData.savedCoordinates) {
                        const coords = positioningData.savedCoordinates;
                        const element = coords.element || {};
                        const selectorData = positioningData.selectorData;
                        const liveElement = (element.cssSelector && selectorData) ? resolveElementBySelectorData(selectorData) : null;

                        if (liveElement) {
                            const liveRect = liveElement.getBoundingClientRect();
                            rect = {
                                left: liveRect.left,
                                top: liveRect.top,
                                right: liveRect.right,
                                bottom: liveRect.bottom,
                                width: liveRect.width,
                                height: liveRect.height,
                                centerX: liveRect.left + (liveRect.width / 2),
                                centerY: liveRect.top + (liveRect.height / 2)
                            };
                            
                            // Check if position actually changed
                            if (lastRect && 
                                lastRect.top === rect.top &&
                                lastRect.left === rect.left &&
                                lastRect.width === rect.width &&
                                lastRect.height === rect.height) return;
                            lastRect = { ...rect };

                            customViewportBounds = {
                                x: liveRect.left,
                                y: liveRect.top,
                                width: liveRect.width,
                                height: liveRect.height
                            };
                        } else {
                            lastRect = null;
                            if (customViewportBounds === null && element) {
                                customViewportBounds = {
                                    x: element.targetX1Absolute || 0,
                                    y: element.targetY1Absolute || 0,
                                    width: coords.width || 0,
                                    height: coords.height || 0
                                };
                            }

                            if (initialScrollX === null) {
                                initialScrollX = coords.scrollX || element.scrollX || currentScrollX;
                                initialScrollY = coords.scrollY || element.scrollY || currentScrollY;

                                apiCoords = {
                                    left: coords.left || element.targetX1Absolute || 0,
                                    top: coords.top || element.targetY1Absolute || 0,
                                    right: coords.right || element.targetX2Absolute || 0,
                                    bottom: coords.bottom || element.targetY2Absolute || 0,
                                    width: coords.width || 0,
                                    height: coords.height || 0,
                                    centerX: element.centerX || coords.centerX || 0,
                                    centerY: element.centerY || coords.centerY || 0
                                };
                            }

                            let scrollDiffX = 0;
                            let scrollDiffY = 0;
                            if (!isInFixedContainer) {
                                scrollDiffX = currentScrollX - initialScrollX;
                                scrollDiffY = currentScrollY - initialScrollY;
                            }
                            rect = {
                                left: apiCoords.left - scrollDiffX,
                                top: apiCoords.top - scrollDiffY,
                                right: apiCoords.right - scrollDiffX,
                                bottom: apiCoords.bottom - scrollDiffY,
                                width: apiCoords.width,
                                height: apiCoords.height,
                                centerX: apiCoords.centerX - scrollDiffX,
                                centerY: apiCoords.centerY - scrollDiffY
                            };
                        }
                    }
                    else if (positioningData.mode !== 'selectElement') {
                        let currentTarget = currentTargetRef.current;
                        if (!currentTarget || !document.body.contains(currentTarget)) {
                            currentTarget = resolveElementBySelectorData(positioningData.selectorData);
                            if (currentTarget) {
                                currentTargetRef.current = currentTarget;
                                lastRect = null;
                                if (launcher._resizeObserver) {
                                    launcher._resizeObserver.disconnect();
                                    launcher._resizeObserver.observe(currentTarget);
                                }
                            } else {
                                return;
                            }
                        }
                        currentTarget = currentTargetRef.current;
                        const elementRect = currentTarget.getBoundingClientRect();
                        rect = {
                            left: elementRect.left,
                            top: elementRect.top,
                            right: elementRect.right,
                            bottom: elementRect.bottom,
                            width: elementRect.width,
                            height: elementRect.height,
                            centerX: elementRect.left + (elementRect.width / 2),
                            centerY: elementRect.top + (elementRect.height / 2)
                        };
                        
                        // Check if position actually changed (similar to test.html)
                        if (lastRect && 
                            lastRect.top === rect.top &&
                            lastRect.left === rect.left &&
                            lastRect.width === rect.width &&
                            lastRect.height === rect.height) return;
                        lastRect = { ...rect };
                    } else {
                        return;
                    }

                    const position = appearance.launcher_position || elementConfig.launcher_position || {};

                    const parseOffset = (value) => {
                        if (value === undefined || value === null) return 0;
                        const parsed = parseFloat(String(value).replace('px', ''));
                        return isNaN(parsed) ? 0 : parsed;
                    };
                    
                    const leftOffset = parseOffset(position.left);
                    const topOffset = parseOffset(position.top);
                    const rightOffset = parseOffset(position.right);
                    const bottomOffset = parseOffset(position.bottom);
                    const centerOffset = parseOffset(position.center);

                    const positionStr = String(position.position || 'bottom-right').toLowerCase();
                    const parts = positionStr.trim().split('-');
                    const first = parts[0];
                    const second = parts[1];

                    let vertical, horizontal;
                    if (first === 'left' || first === 'right') {
                        horizontal = first;
                        vertical = second;
                    } else {
                        vertical = first;
                        horizontal = second;
                    }

                    const launcherRect = launcher.getBoundingClientRect();
                    const launcherWidth = launcherRect.width;
                    const launcherHeight = launcherRect.height;

                    let translateX = 0;
                    let translateY = 0;

                    if (vertical === 'bottom') {
                        if (bottomOffset < 0) {
                            translateY = rect.bottom + Math.abs(bottomOffset);
                        } else {
                            translateY = rect.bottom + bottomOffset;
                            translateY -= launcherHeight;
                        }
                    } else if (vertical === 'middle' || vertical === 'center') {
                        translateY = rect.centerY + (centerOffset || topOffset || 0);
                        translateY -= launcherHeight / 2;
                    } else if (vertical === 'top') {
                        if (topOffset < 0) {
                            translateY = rect.top - launcherHeight - Math.abs(topOffset);
                        } else {
                            translateY = rect.top + topOffset;
                        }
                    }

                    if (horizontal === 'right') {
                        if (rightOffset < 0) {
                            translateX = rect.right + Math.abs(rightOffset);
                        } else {
                            translateX = rect.right + rightOffset;
                        }
                        translateX -= launcherWidth;
                    } else if (horizontal === 'center') {
                        translateX = rect.centerX + (centerOffset || leftOffset || 0);
                        translateX -= launcherWidth / 2;
                    } else if (horizontal === 'left') {
                        if (leftOffset < 0) {
                            translateX = rect.left - launcherWidth - Math.abs(leftOffset);
                        } else {
                            translateX = rect.left + leftOffset;
                        }
                    }

                    launcher.style.transform = `translate3d(${Math.round(translateX)}px, ${Math.round(translateY)}px, 0px)`;
                    launcher.style.left = '0';
                    launcher.style.top = '0';

                    if (!hasInitializedPosition) {
                        hasInitializedPosition = true;
                        launcher.style.opacity = '1';
                        launcher.style.pointerEvents = 'auto';
                    }

                    let inView = true;
                    if (customViewportBounds && positioningData.mode === 'selectElement') {
                        inView = sdk._isElementInCustomViewport(rect, customViewportBounds);
                    } else if (currentTargetRef.current) {
                        inView = sdk._isElementInStandardViewport(rect);
                    }

                    if (inView !== isTargetInView) {
                        isTargetInView = inView;
                    }
                    const isUserHovering = launcher.dataset.isHovering === 'true';

                    if (hasInitializedPosition) {
                        if (!inView && !isUserHovering) {
                            launcher.style.opacity = '0';
                            launcher.style.pointerEvents = 'none';
                        } else {
                            launcher.style.opacity = '1';
                            launcher.style.pointerEvents = 'auto';
                        }
                    }

                } catch (e) {
                    console.error('[ModalFlow] âŒ updatePosition error: ' + (e ? (e.message || (typeof e.toString === 'function' ? e.toString() : String(e))) : 'unknown'));
                }
            };

            const handleScroll = () => {
                requestAnimationFrame(updatePosition);
            };

            const handleResize = () => {
                clearTimeout(launcher._resizeTimeout);
                launcher._resizeTimeout = setTimeout(() => {
                    requestAnimationFrame(updatePosition);
                }, 100);
            };

            const scrollTargets = [window, document, document.documentElement, document.body];
            scrollTargets.forEach(target => {
                if (target) {
                    target.addEventListener('scroll', handleScroll, { passive: true, capture: true });
                }
            });

            window.addEventListener('resize', handleResize, { passive: true });

            if (window.visualViewport) {
                window.visualViewport.addEventListener('scroll', handleScroll, { passive: true });
            }

            if (currentTargetRef.current) {
                try {
                    const resizeObserver = new ResizeObserver(() => {
                        requestAnimationFrame(updatePosition);
                    });
                    resizeObserver.observe(currentTargetRef.current);
                    launcher._resizeObserver = resizeObserver;

                    if (positioningData.mode === 'selectElement' && positioningData.selectorData) {
                        const liveElement = resolveElementBySelectorData(positioningData.selectorData);
                        if (liveElement && liveElement !== currentTargetRef.current) {
                            resizeObserver.observe(liveElement);
                        }
                    }
                } catch (e) {
                    console.warn('[ModalFlow] âš ï¸ ResizeObserver not supported');
                }
            }

            let lastScrollY = window.pageYOffset || document.documentElement.scrollTop;
            let lastScrollX = window.pageXOffset || document.documentElement.scrollLeft;

            const scrollDetectionInterval = setInterval(() => {
                const currentX = window.pageXOffset || document.documentElement.scrollLeft;
                const currentY = window.pageYOffset || document.documentElement.scrollTop;

                if (currentY !== lastScrollY || currentX !== lastScrollX) {
                    updatePosition();
                }

                lastScrollY = currentY;
                lastScrollX = currentX;
            }, 100);

            launcher.addEventListener('mouseover', (e) => {
                launcher.dataset.isHovering = 'true';
                const actualFlowRef = flowRef || sdk._launcherFlowRefs?.[launcherId] || launcherId;
                launcher.dataset.flowRef = actualFlowRef;
                sdk._handleLauncherAction(e, 'mouseover', behaviour, launcherId, refKey, actualFlowRef);
            });

            launcher.addEventListener('mouseleave', () => {
                delete launcher.dataset.isHovering;
            });

            launcher.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const actualFlowRef = flowRef || sdk._launcherFlowRefs?.[launcherId] || launcherId;
                launcher.dataset.flowRef = actualFlowRef;
                sdk._handleLauncherAction(e, 'click', behaviour, launcherId, refKey, actualFlowRef);
            });

            requestAnimationFrame(() => {
                updatePosition();
                setTimeout(() => {
                    updatePosition();
                }, 50);

                setTimeout(() => {
                    updatePosition();
                }, 200);
            });

            const continuousUpdate = () => {
                if (!document.body.contains(launcher)) {
                    return;
                }
                
                if (positioningData.mode === 'selectElement' && positioningData.savedCoordinates) {
                    if (positioningData.selectorData) {
                        try {
                            const liveElement = resolveElementBySelectorData(positioningData.selectorData);
                            if (liveElement && document.body.contains(liveElement)) {
                                const liveRect = liveElement.getBoundingClientRect();
                                const visible = liveRect.bottom > 0 &&
                                    liveRect.top < window.innerHeight &&
                                    liveRect.right > 0 &&
                                    liveRect.left < window.innerWidth;
                                if (visible) {
                                    if (!lastRect ||
                                        lastRect.top !== liveRect.top ||
                                        lastRect.left !== liveRect.left ||
                                        lastRect.width !== liveRect.width ||
                                        lastRect.height !== liveRect.height) {
                                        updatePosition(true);
                                    }
                                }
                            }
                        } catch (e) {
                            // Continue tracking even if selector fails
                        }
                    }
                } else if (positioningData.mode !== 'selectElement') {
                    const currentTarget = currentTargetRef.current;
                    if (!currentTarget || !document.body.contains(currentTarget)) {
                        updatePosition(true);
                    } else {
                        const elementRect = currentTarget.getBoundingClientRect();
                        const visible = elementRect.bottom > 0 &&
                            elementRect.top < window.innerHeight &&
                            elementRect.right > 0 &&
                            elementRect.left < window.innerWidth;
                        if (visible) {
                            if (!lastRect ||
                                lastRect.top !== elementRect.top ||
                                lastRect.left !== elementRect.left ||
                                lastRect.width !== elementRect.width ||
                                lastRect.height !== elementRect.height) {
                                updatePosition(true);
                            }
                        }
                    }
                }
                
                rafId = requestAnimationFrame(continuousUpdate);
            };
            
            rafId = requestAnimationFrame(continuousUpdate);

            launcher._updatePosition = updatePosition;

            launcher._cleanup = () => {
                if (rafId !== null) {
                    cancelAnimationFrame(rafId);
                    rafId = null;
                }
                
                window.removeEventListener('resize', handleResize);

                scrollTargets.forEach(target => {
                    if (target) {
                        target.removeEventListener('scroll', handleScroll, { capture: true });
                    }
                });

                if (window.visualViewport) {
                    window.visualViewport.removeEventListener('scroll', handleScroll);
                }

                if (launcher._resizeObserver) {
                    launcher._resizeObserver.disconnect();
                }

                clearTimeout(launcher._resizeTimeout);
                clearInterval(scrollDetectionInterval);
            };

        } catch (error) {
            console.error('[ModalFlow] Failed to attach launcher:', error);
        }
    };
    sdk._waitForElement = function (selector, timeout = 10000) {
        return new Promise((resolve, reject) => {
            const element = document.querySelector(selector);
            if (element) {
                return resolve(element);
            }

            const observer = new MutationObserver((mutations, obs) => {
                const element = document.querySelector(selector);
                if (element) {
                    obs.disconnect();
                    resolve(element);
                }
            });

            observer.observe(document.body, {
                childList: true,
                subtree: true
            });

            setTimeout(() => {
                observer.disconnect();
                reject(new Error('Element not found: ' + selector));
            }, timeout);
        });
    };
    sdk._findElementBySelector = async function (selectorData) {
        if (!selectorData) {
            return null;
        }

        const { selector, index = 0, indexMap, cssSelectors = [], text } = selectorData;

        if (selector) {
            let selectorString = selector;
            if (typeof selector !== 'string') {
                if (selector && typeof selector === 'object') {
                    selectorString = selector.value || selector.selector || null;
                } else {
                    selectorString = String(selector);
                }
            }
            
            if (selectorString && typeof selectorString === 'string' && selectorString.trim()) {
                try {
                    const matches = document.querySelectorAll(selectorString);
                    
                    if (matches.length > 1 && text && typeof text === 'string') {
                        const searchText = String(text).trim();
                        if (searchText) {
                            const textMatches = Array.from(matches).filter(el => elementTextMatches(el, searchText));
                            
                            if (textMatches.length > 0) {
                                if (index === -1) {
                                    return textMatches[textMatches.length - 1];
                                } else if (index >= 0 && index < textMatches.length) {
                                    return textMatches[index];
                                } else {
                                    return textMatches[0];
                                }
                            }
                        }
                    }
                    
                    if (matches.length > index) {
                        return matches[index];
                    }
                    if (matches.length > 0 && indexMap && Object.keys(indexMap).length > 0) {
                    } else if (matches.length > 0) {
                        return matches[0];
                    }
                } catch (e) {
                    console.warn('[ModalFlow] ⚠️ Primary selector failed:', selectorString, e);
                }
            }
        }

        if (!selector && text && typeof text === 'string') {
            const textValue = String(text).trim();
            if (textValue) {
                const walker = document.createTreeWalker(
                    document.body,
                    NodeFilter.SHOW_TEXT,
                    null
                );
                
                let node;
                while (node = walker.nextNode()) {
                    if (elementTextMatches(node.parentElement, textValue)) {
                        return node.parentElement;
                    }
                }
                
                if (typeof findElementByText === 'function') {
                    return findElementByText(textValue);
                }
            }
            return null;
        }

        if (indexMap && typeof indexMap === 'object') {
            for (const [sel, idx] of Object.entries(indexMap)) {
                let selString = sel;
                if (typeof sel !== 'string') {
                    if (sel && typeof sel === 'object') {
                        selString = sel.value || sel.selector || null;
                    } else {
                        selString = String(sel);
                    }
                }
                
                if (selString && typeof selString === 'string' && selString.trim()) {
                    try {
                        const matches = document.querySelectorAll(selString);
                        if (matches.length > idx) {
                            return matches[idx];
                        }
                    } catch (e) {
                        continue;
                    }
                }
            }
        }

        if (cssSelectors && Array.isArray(cssSelectors) && cssSelectors.length > 0) {
            for (const sel of cssSelectors) {
                if (!sel) continue; // Skip empty selectors
                
                let selString = sel;
                if (typeof sel !== 'string') {
                    if (sel && typeof sel === 'object') {
                        selString = sel.value || sel.selector || null;
                    } else {
                        selString = String(sel);
                    }
                }
                
                if (!selString || typeof selString !== 'string' || !selString.trim() || selString === selector) {
                    continue;
                }
                
                try {
                    const element = document.querySelector(selString);
                    if (element) {
                        return element;
                    }
                } catch (e) {
                    continue;
                }
            }
        }

        return null;
    };
    sdk._getElementSelectorWithMode = function (elementConfig) {
        if (!elementConfig) {
            return { selector: null, mode: null, useAbsoluteCoordinates: false, savedCoordinates: null, selectorData: null };
        }

        const mode = elementConfig.mode;
        let selector = null;
        let useAbsoluteCoordinates = false;
        let savedCoordinates = null;
        let selectorData = null;

        if (mode === 'selectElement') {
            const coords = elementConfig.selectedElementValues?.coordinates;
            const element = elementConfig.selectedElementValues?.element;

            if (element?.cssSelector) {
                selector = element.cssSelector;

                selectorData = {
                    selector: element.cssSelector,
                    index: element.elementIndex || 0,
                    indexMap: element.indexMap,
                    cssSelectors: element.cssSelectors
                };

                if (coords || element) {
                    useAbsoluteCoordinates = true;
                    savedCoordinates = {
                        left: coords?.left || element?.targetX1Absolute || 0,
                        top: coords?.top || element?.targetY1Absolute || 0,
                        right: coords?.right || element?.targetX2Absolute || 0,
                        bottom: coords?.bottom || element?.targetY2Absolute || 0,
                        width: coords?.width || element?.width || 0,
                        height: coords?.height || element?.height || 0,
                        centerX: element?.centerX || 0,
                        centerY: element?.centerY || 0,
                        scrollX: element?.scrollX || 0,
                        scrollY: element?.scrollY || 0,
                        element: element
                    };
                }
            }
        }
        else if (mode === 'goManual') {
            const goManualValues = elementConfig.goManualValues;

            if (goManualValues?.cssSelector?.value) {
                selector = goManualValues.cssSelector.value;
                useAbsoluteCoordinates = false;

                selectorData = {
                    selector: selector,
                    index: goManualValues.ifMultiple?.value === 'first' ? 0 :
                        goManualValues.ifMultiple?.value === 'last' ? -1 : 0
                };
                
                // Include text if both CSS selector and text are provided
                if (goManualValues?.elementText?.value) {
                    selectorData.text = goManualValues.elementText.value;
                }
            } else if (goManualValues?.elementText?.value) {
                // Text-only selection (no CSS selector)
                selector = null;
                useAbsoluteCoordinates = false;
                selectorData = {
                    text: goManualValues.elementText.value
                };
            }
        }

        return {
            selector,
            mode,
            useAbsoluteCoordinates,
            savedCoordinates,
            selectorData
        };
    };

    sdk._isElementInCustomViewport = function (rect, customViewportBounds) {
        if (!customViewportBounds) {
            return sdk._isElementInStandardViewport(rect);
        }

        try {
            const { x, y, width, height } = customViewportBounds;
            const elementRight = rect.left + rect.width;
            const elementBottom = rect.top + rect.height;
            const viewportRight = x + width;
            const viewportBottom = y + height;

            const vertInView = (rect.top < viewportBottom) && (elementBottom > y);
            const horInView = (rect.left < viewportRight) && (elementRight > x);

            return vertInView && horInView;
        } catch (e) {
            return false;
        }
    };

    sdk._isElementInStandardViewport = function (rect) {
        try {
            const windowHeight = window.innerHeight || document.documentElement.clientHeight;
            const windowWidth = window.innerWidth || document.documentElement.clientWidth;

            const vertInView = (rect.top <= windowHeight) && ((rect.top + rect.height) >= 0);
            const horInView = (rect.left <= windowWidth) && ((rect.left + rect.width) >= 0);

            return vertInView && horInView;
        } catch (e) {
            return false;
        }
    };
    sdk._isElementInFixedContainer = function (el) {
        let current = el;
        while (current && current !== document.body) {
            const style = window.getComputedStyle(current);
            if (style.position === 'fixed') return true;
            current = current.parentElement;
        }
        return false;
    };
    sdk._isElementInViewport = function (el, customViewportBounds) {
        try {
            const rect = el.getBoundingClientRect();
            return customViewportBounds
                ? sdk._isElementInCustomViewport(rect, customViewportBounds)
                : sdk._isElementInStandardViewport(rect);
        } catch (e) {
            return false;
        }
    };
    sdk._createDefaultLauncherSvg = function () {
        const svg = document.createElement('div');
        svg.innerHTML = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" style="width:18px;height:18px;fill:currentColor;pointer-events:none;"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>';
        return svg.firstElementChild;
    };
    sdk._normalizeLauncherIconClass = function (iconClass) {
        return String(iconClass || '').trim().toLowerCase().replace(/\s+/g, ' ');
    };
    sdk._launcherIconClassSvgMap = {
        'fa-solid fa-circle-question': `<svg viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg"><path d="M256 512A256 256 0 1 0 256 0a256 256 0 1 0 0 512zM169.8 165.3c7.9-22.3 29.1-37.3 52.8-37.3h58.3c34.9 0 63.1 28.3 63.1 63.1c0 22.6-12.1 43.5-31.7 54.8L280 264.4c-.2 13-10.9 23.6-24 23.6c-13.3 0-24-10.7-24-24V250.5c0-8.6 4.6-16.5 12.1-20.8l44.3-25.4c4.7-2.7 7.6-7.7 7.6-13.1c0-8.4-6.8-15.1-15.1-15.1H222.6c-3.4 0-6.4 2.1-7.5 5.3l-.4 1.2c-4.4 12.5-18.2 19-30.6 14.6s-19-18.2-14.6-30.6l.4-1.2zM224 352a32 32 0 1 1 64 0 32 32 0 1 1 -64 0z"/></svg>`,
        'fa-solid fa-circle-info': `<svg viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg"><path d="M256 512A256 256 0 1 0 256 0a256 256 0 1 0 0 512zM216 336h24V272H216c-13.3 0-24-10.7-24-24s10.7-24 24-24h48c13.3 0 24 10.7 24 24v88h8c13.3 0 24 10.7 24 24s-10.7 24-24 24H216c-13.3 0-24-10.7-24-24s10.7-24 24-24zm40-208a32 32 0 1 1 0 64 32 32 0 1 1 0-64z"/></svg>`,
        'fa-solid fa-circle-exclamation': `<svg viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg"><path d="M256 512A256 256 0 1 0 256 0a256 256 0 1 0 0 512zm0-384c13.3 0 24 10.7 24 24V264c0 13.3-10.7 24-24 24s-24-10.7-24-24V152c0-13.3 10.7-24 24-24zM224 352a32 32 0 1 1 64 0 32 32 0 1 1 -64 0z"/></svg>`,
        'fa-solid fa-circle-check': `<svg viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg"><path d="M256 512A256 256 0 1 0 256 0a256 256 0 1 0 0 512zM369 209L241 337c-9.4 9.4-24.6 9.4-33.9 0l-64-64c-9.4-9.4-9.4-24.6 0-33.9s24.6-9.4 33.9 0l47 47L335 175c9.4-9.4 24.6-9.4 33.9 0s9.4 24.6 0 33.9z"/></svg>`,
        'fa-solid fa-circle-xmark': `<svg viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg"><path d="M256 512A256 256 0 1 0 256 0a256 256 0 1 0 0 512zM175 175c9.4-9.4 24.6-9.4 33.9 0l47 47 47-47c9.4-9.4 24.6-9.4 33.9 0s9.4 24.6 0 33.9l-47 47 47 47c9.4 9.4 9.4 24.6 0 33.9s-24.6 9.4-33.9 0l-47-47-47 47c-9.4 9.4-24.6 9.4-33.9 0s-9.4-24.6 0-33.9l47-47-47-47c-9.4-9.4-9.4-24.6 0-33.9z"/></svg>`,
        'fa-solid fa-star': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 640"><path d="M341.5 45.1C337.4 37.1 329.1 32 320.1 32C311.1 32 302.8 37.1 298.7 45.1L225.1 189.3L65.2 214.7C56.3 216.1 48.9 222.4 46.1 231C43.3 239.6 45.6 249 51.9 255.4L166.3 369.9L141.1 529.8C139.7 538.7 143.4 547.7 150.7 553C158 558.3 167.6 559.1 175.7 555L320.1 481.6L464.4 555C472.4 559.1 482.1 558.3 489.4 553C496.7 547.7 500.4 538.8 499 529.8L473.7 369.9L588.1 255.4C594.5 249 596.7 239.6 593.9 231C591.1 222.4 583.8 216.1 574.8 214.7L415 189.3L341.5 45.1z"/></svg>`,
        'fa-solid fa-gear': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 640"><path d="M259.1 73.5C262.1 58.7 275.2 48 290.4 48L350.2 48C365.4 48 378.5 58.7 381.5 73.5L396 143.5C410.1 149.5 423.3 157.2 435.3 166.3L503.1 143.8C517.5 139 533.3 145 540.9 158.2L570.8 210C578.4 223.2 575.7 239.8 564.3 249.9L511 297.3C511.9 304.7 512.3 312.3 512.3 320C512.3 327.7 511.8 335.3 511 342.7L564.4 390.2C575.8 400.3 578.4 417 570.9 430.1L541 481.9C533.4 495 517.6 501.1 503.2 496.3L435.4 473.8C423.3 482.9 410.1 490.5 396.1 496.6L381.7 566.5C378.6 581.4 365.5 592 350.4 592L290.6 592C275.4 592 262.3 581.3 259.3 566.5L244.9 496.6C230.8 490.6 217.7 482.9 205.6 473.8L137.5 496.3C123.1 501.1 107.3 495.1 99.7 481.9L69.8 430.1C62.2 416.9 64.9 400.3 76.3 390.2L129.7 342.7C128.8 335.3 128.4 327.7 128.4 320C128.4 312.3 128.9 304.7 129.7 297.3L76.3 249.8C64.9 239.7 62.3 223 69.8 209.9L99.7 158.1C107.3 144.9 123.1 138.9 137.5 143.7L205.3 166.2C217.4 157.1 230.6 149.5 244.6 143.4L259.1 73.5zM320.3 400C364.5 399.8 400.2 363.9 400 319.7C399.8 275.5 363.9 239.8 319.7 240C275.5 240.2 239.8 276.1 240 320.3C240.2 364.5 276.1 400.2 320.3 400z"/></svg>`,
        'fa-solid fa-heart': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path d="M241 87.1l15 20.7 15-20.7C296 52.5 336.2 32 378.9 32 452.4 32 512 91.6 512 165.1l0 2.6c0 112.2-139.9 242.5-212.9 298.2-12.4 9.4-27.6 14.1-43.1 14.1s-30.8-4.6-43.1-14.1C139.9 410.2 0 279.9 0 167.7l0-2.6C0 91.6 59.6 32 133.1 32 175.8 32 216 52.5 241 87.1z"/></svg>`,
        'fa-solid fa-bell': `<svg viewBox="0 0 448 512" xmlns="http://www.w3.org/2000/svg"><path d="M224 512c35.3 0 63.1-28.7 63.1-64H160.9c0 35.3 27.8 64 63.1 64zm215.4-149.9c-19.8-20.9-55.5-52.8-55.5-154.1 0-77.7-54.5-139.9-127.9-155.2V32c0-17.7-14.3-32-32-32s-32 14.3-32 32v20.8C118.5 68.1 64 130.3 64 208c0 101.3-35.8 133.2-55.5 154.1-6 6.3-8.5 14.2-8.5 22.1 0 16.4 13 32 32.1 32h383.8c19.1 0 32.1-15.6 32.1-32 0-7.9-2.5-15.8-8.5-22.1z"/></svg>`,
        'fa-solid fa-home': `<svg viewBox="0 0 576 512" xmlns="http://www.w3.org/2000/svg"><path d="M575.8 255.5L512 199.4V56c0-13.3-10.7-24-24-24h-56c-13.3 0-24 10.7-24 24v72.3L318.5 43c-18.7-16.4-46.3-16.4-64.9 0L.2 255.5c-10.7 9.4-12.6 25.5-4.2 37.3s24.7 14.6 36.6 5.2L64 270.7V456c0 30.9 25.1 56 56 56h112c13.3 0 24-10.7 24-24V344h64v144c0 13.3 10.7 24 24 24h112c30.9 0 56-25.1 56-56V270.7l31.4 27.3c11.9 9.4 28.2 6.6 36.6-5.2s6.5-27.9-4.2-37.3z"/></svg>`,
        'fa-solid fa-user': `<svg viewBox="0 0 448 512" xmlns="http://www.w3.org/2000/svg"><path d="M224 256c70.7 0 128-57.3 128-128S294.7 0 224 0 96 57.3 96 128s57.3 128 128 128zm89.6 32h-11.7c-22.2 10.2-46.8 16-77.9 16s-55.7-5.8-77.9-16h-11.7C60.2 288 0 348.2 0 422.4V464c0 26.5 21.5 48 48 48h352c26.5 0 48-21.5 48-48v-41.6C448 348.2 387.8 288 313.6 288z"/></svg>`,
        'fa-solid fa-envelope': `<svg viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg"><path d="M502.3 190.8L327.4 338c-15.9 13.4-39 13.4-54.9 0L9.7 190.8C3.9 186.1 0 178.9 0 171.1V48c0-26.5 21.5-48 48-48h416c26.5 0 48 21.5 48 48v123.1c0 7.8-3.9 15-9.7 19.7z"/></svg>`,
        'fa-solid fa-phone': `<svg viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg"><path d="M511.1 387.1l-23.1 100.7c-3.1 13.6-15.1 23.3-29.1 23.3C201.4 511.1 0 309.7 0 52.1c0-14 9.7-26 23.3-29.1l100.7-23.1c14.6-3.3 29.3 4.3 35.4 18.1l46.5 108.5c5.4 12.6 1.8 27.3-8.9 35.9l-49.6 40.4c31.3 65.3 83.9 118 149.2 149.2l40.4-49.6c8.6-10.7 23.3-14.3 35.9-8.9l108.5 46.5c13.8 6.1 21.4 20.8 18.1 35.4z"/></svg>`,
        'fa-solid fa-location-dot': `<svg viewBox="0 0 384 512" xmlns="http://www.w3.org/2000/svg"><path d="M168 0C75.2 0 0 75.2 0 168c0 87.2 134.4 261.9 150.6 282.3c9.5 11.9 27.3 11.9 36.8 0C249.6 429.9 384 255.2 384 168 384 75.2 308.8 0 216 0zm0 240c-39.8 0-72-32.2-72-72s32.2-72 72-72 72 32.2 72 72-32.2 72-72 72z"/></svg>`,
        'fa-solid fa-comment': `<svg viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg"><path d="M512 240c0 114.9-114.6 208-256 208c-37.1 0-72.3-6.4-104.1-17.9L0 480l50.1-138.5C18.3 310.9 0 276.4 0 240C0 125.1 114.6 32 256 32s256 93.1 256 208z"/></svg>`,
        'fa-solid fa-message': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path d="M0 352L0 128C0 75 43 32 96 32l320 0c53 0 96 43 96 96l0 224c0 53-43 96-96 96l-120 0c-5.2 0-10.2 1.7-14.4 4.8L166.4 539.2c-4.2 3.1-9.2 4.8-14.4 4.8-13.3 0-24-10.7-24-24l0-72-32 0c-53 0-96-43-96-96z"/></svg>`,
        'fa-solid fa-lightbulb': `<svg viewBox="0 0 352 512" xmlns="http://www.w3.org/2000/svg"><path d="M96.1 454.4c0 6.3 1.3 12.6 3.8 18.4l8.9 21.2c3.2 7.6 10.6 12.5 18.9 12.5h96.5c8.3 0 15.7-4.9 18.9-12.5l8.9-21.2c2.5-5.8 3.8-12.1 3.8-18.4V416H96.1v38.4zM176 0C80.5 0 0 82.5 0 176c0 44.4 16.4 84.9 43.4 116.3c16.5 19.2 42.4 58.2 52.2 91.7c.4 1.5 1.7 2.6 3.3 2.6h154.1c1.6 0 2.9-1.1 3.3-2.6c9.8-33.5 35.7-72.5 52.2-91.7c27-31.4 43.4-71.9 43.4-116.3C352 82.5 271.5 0 176 0z"/></svg>`,
        'fa-solid fa-bookmark': `<svg viewBox="0 0 384 512" xmlns="http://www.w3.org/2000/svg"><path d="M0 48C0 21.5 21.5 0 48 0H336c26.5 0 48 21.5 48 48V512L192 400 0 512V48z"/></svg>`,
        'fa-solid fa-flag': `<svg viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg"><path d="M80 0C53.5 0 32 21.5 32 48V512c0 17.7 14.3 32 32 32s32-14.3 32-32V352H384l-48-96 48-96H96V48C96 21.5 74.5 0 48 0h32z"/></svg>`,
        'fa-solid fa-thumbs-up': `<svg viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg"><path d="M104 224H24c-13.3 0-24 10.7-24 24v240c0 13.3 10.7 24 24 24h80V224zm408 56c0-22.1-17.9-40-40-40H352l18.3-91.7c1.3-6.5 .7-13.2-1.8-19.3c-2.5-6.1-6.8-11.6-12.6-15.7l-11.3-8.5c-9.5-7.1-22.7-8.2-33.3-2.7c-10.6 5.5-17.9 16.7-18.7 28.7L288 240H104v272h272c22.1 0 40-17.9 40-40c0-9.3-3.2-17.8-8.6-24.5c14.3-6.1 24.6-20.4 24.6-37.1c0-10.6-4.1-20.3-10.7-27.5c15.6-5.4 26.7-20.3 26.7-37.6c0-22.1-17.9-40-40-40z"/></svg>`,
        'fa-solid fa-thumbs-down': `<svg viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg"><path d="M104 288H24c-13.3 0-24 10.7-24 24v240c0 13.3 10.7 24 24 24h80V288zm408-56c0 22.1-17.9 40-40 40H352l18.3 91.7c1.3 6.5 .7 13.2-1.8 19.3c-2.5 6.1-6.8 11.6-12.6 15.7l-11.3 8.5c-9.5 7.1-22.7 8.2-33.3 2.7c-10.6-5.5-17.9-16.7-18.7-28.7L288 272H104V0h272c22.1 0 40 17.9 40 40c0 9.3-3.2 17.8-8.6 24.5c14.3 6.1 24.6 20.4 24.6 37.1c0 10.6-4.1 20.3-10.7 27.5c15.6 5.4 26.7 20.3 26.7 37.6z"/></svg>`,
        'fa-solid fa-search': `<svg viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg"><path d="M500.3 443.7L380.7 324.1c27.3-40.2 43.3-88.7 43.3-141.8C424 82.5 341.5 0 240 0S56 82.5 56 182.3s82.5 182.3 184 182.3c53.1 0 101.6-16 141.8-43.3l119.6 119.6c15.6 15.6 40.9 15.6 56.6 0s15.6-40.9 0-56.6z"/></svg>`,
        'fa-solid fa-share': `<svg viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg"><path d="M503.7 189.8L327.4 37.8c-15.1-13.1-39.4-2.4-39.4 18.8V144C144 144 0 273.7 0 432c0 24.3 30.3 35.4 45.6 17.1C94.4 388.7 160 352 288 352v87.4c0 21.2 24.3 31.9 39.4 18.8l176.3-152c11.5-9.9 11.5-27.5 0-37.4z"/></svg>`,
        'fa-solid fa-sliders': `<svg viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg"><path d="M0 416c0 17.7 14.3 32 32 32H80c0 35.3 28.7 64 64 64s64-28.7 64-64H480c17.7 0 32-14.3 32-32s-14.3-32-32-32H208c0-35.3-28.7-64-64-64s-64 28.7-64 64H32c-17.7 0-32 14.3-32 32zM0 256c0 17.7 14.3 32 32 32H240c0 35.3 28.7 64 64 64s64-28.7 64-64H480c17.7 0 32-14.3 32-32s-14.3-32-32-32H368c0-35.3-28.7-64-64-64s-64 28.7-64 64H32c-17.7 0-32 14.3-32 32zM0 96c0 17.7 14.3 32 32 32H80c0 35.3 28.7 64 64 64s64-28.7 64-64H480c17.7 0 32-14.3 32-32S497.7 64 480 64H208c0-35.3-28.7-64-64-64s-64 28.7-64 64H32C14.3 64 0 78.3 0 96z"/></svg>`
    };
    sdk._getHardcodedLauncherSvgByClass = function (iconClass) {
        const classKey = sdk._normalizeLauncherIconClass(iconClass);
        return sdk._launcherIconClassSvgMap[classKey] || '';
    };
    sdk._buildSafeLauncherSvg = function (svgMarkup) {
        if (typeof svgMarkup !== 'string') return null;
        const rawSvg = svgMarkup.trim();
        if (!rawSvg) return null;
        const wrapper = document.createElement('div');
        wrapper.innerHTML = rawSvg;
        const svg = wrapper.querySelector('svg');
        if (!svg) return null;
        svg.setAttribute('width', '1em');
        svg.setAttribute('height', '1em');
        svg.setAttribute('aria-hidden', 'true');
        svg.setAttribute('focusable', 'false');
        svg.style.width = '1em';
        svg.style.height = '1em';
        svg.style.display = 'block';
        svg.style.color = 'inherit';
        svg.style.fill = 'currentColor';
        svg.style.pointerEvents = 'none';
        return svg;
    };
    sdk._createLauncherElement = function (appearance) {
        const type = String(appearance?.type || 'button').toLowerCase();

        const launcher = document.createElement('div');
        launcher.className = 'modal-launcher modal-launcher--' + type + ' modal-launcher--visible';

        const baseStyles = {
            position: 'fixed',
            zIndex: '999999',
            cursor: 'pointer',
            transition: 'color 0.2s ease, background 0.2s ease, border-radius 0.2s ease, border-color 0.2s ease, border-width 0.2s ease',
            fontFamily: 'system-ui, -apple-system, "Helvetica Neue", Helvetica, sans-serif',
            willChange: 'transform',
            fontSize: '14px',
            fontWeight: '500',
            lineHeight: '1.5',
            pointerEvents: 'auto'
        };

        const text = appearance?.value || appearance?.text || 'Launch';

        if (type === 'beacon') {
            sdk._ensurePreviewStyles();
            Object.assign(baseStyles, {
                width: '24px',
                height: '24px',
                borderRadius: '50%',
                background: 'var(--ms-brand-background,var(--ms-theme-primary,#0d6efd))',
                boxShadow: '0 0 0 0 var(--ms-brand-pulse-start,rgba(59,130,246,.65))',
                animation: 'mfPulse 1400ms ease-out infinite',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                pointerEvents: 'auto',
                userSelect: 'none',
                animationFillMode: 'forwards'
            });

            const innerDot = document.createElement('div');
            innerDot.style.cssText = 'width:16px;height:16px;border-radius:50%;background:var(--ms-brand-background,var(--ms-theme-primary,#0d6efd));pointer-events:none;';
            launcher.appendChild(innerDot);
        } else if (type === 'icon') {
            const iconClass = appearance?.iconClass || '';

            Object.assign(baseStyles, {
                padding: '6px 14px',
                borderRadius: '8px',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: '#4579E4',
                color: '#FFFFFF',
                boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
                pointerEvents: 'auto',
                fontSize: '16px',
                height: 'auto'
            });

            const hardcodedSvg = sdk._getHardcodedLauncherSvgByClass(iconClass);
            const safeSvgIcon = sdk._buildSafeLauncherSvg(hardcodedSvg);
            launcher.appendChild(safeSvgIcon || sdk._createDefaultLauncherSvg());
        } else {
            launcher.textContent = text;

            Object.assign(baseStyles, {
                padding: '6px 14px',
                borderRadius: '8px',
                fontSize: '14px',
                fontWeight: '500',
                boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
                background: '#4579E4',
                color: '#FFFFFF',
                border: 'none',
                whiteSpace: 'nowrap',
                height: 'auto',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                pointerEvents: 'auto'
            });
        }

        Object.assign(launcher.style, baseStyles);
        const styling = appearance?.styling || appearance?.styles || {};

        if (type === 'beacon') {
            launcher.style.borderRadius = '50%';
        }
        else {
            if (styling.background) {
                launcher.style.background = styling.background;
            }
            launcher.style.borderStyle = 'solid';
            if (styling.color) launcher.style.color = styling.color;
            if (styling.borderRadius) launcher.style.borderRadius = styling.borderRadius;
            if (styling.borderColor) launcher.style.borderColor = styling.borderColor;
            if (styling.borderWidth) launcher.style.borderWidth = styling.borderWidth;
            if (styling.textTransform) launcher.style.textTransform = styling.textTransform;
            if (styling.margin) launcher.style.margin = styling.margin;
            if (styling.padding) launcher.style.padding = styling.padding;
            if (styling.fontSize) launcher.style.fontSize = styling.fontSize;
            if (styling.fontWeight) launcher.style.fontWeight = styling.fontWeight;
            if (styling.border) launcher.style.border = styling.border;
            if (styling.boxShadow) launcher.style.boxShadow = styling.boxShadow;
            if (styling.hover) {
                const originalStyles = {};

                launcher.addEventListener('mouseenter', () => {
                    for (const key in styling.hover) {
                        originalStyles[key] = launcher.style[key];
                        launcher.style[key] = styling.hover[key];
                    }
                });

                launcher.addEventListener('mouseleave', () => {
                    for (const key in originalStyles) {
                        launcher.style[key] = originalStyles[key];
                    }
                });
            }
        }
        // Hover effects
        launcher.addEventListener('mouseenter', () => {
            const currentTransform = launcher.style.transform || 'translate3d(0px, 0px, 0px)';
            if (!currentTransform.includes('scale')) {
                launcher.style.transform = currentTransform.replace(')', ' scale(1.05))');
            }
        });

        launcher.addEventListener('mouseleave', () => {
            launcher.style.transform = launcher.style.transform.replace(' scale(1.05)', '');
        });

        return launcher;
    };
    sdk._handleLauncherAction = function (event, triggerType, behaviour, launcherId, refKey, flowRef = null) {
        try {
            // Get launcher ID from element dataset or parameter
            const actualLauncherId = event.currentTarget?.dataset?.launcherId || launcherId;
            // Get flow_ref from launcher element dataset, parameter, or lookup
            const actualFlowRef = flowRef || event.currentTarget?.dataset?.flowRef || sdk._launcherFlowRefs?.[actualLauncherId] || actualLauncherId;

            const config = behaviour || {};
            // Check dismissAfterFirstActivation from tooltip options
            const tooltipOptions = config.tooltip?.options || {};
            const dismissAfterFirstActivation = tooltipOptions.dismissAfterFirstActivation || config.dismissAfterFirstActivation === true;
            const configTrigger = String(config.triggerEvent || 'clicked').toLowerCase();
            // Handle both "click"/"clicked" and "hover"/"hovered" variations
            const isClickMatch = triggerType === 'click' && (configTrigger === 'clicked' || configTrigger === 'click');
            const isHoverMatch = triggerType === 'mouseover' && (configTrigger === 'hover' || configTrigger === 'hovered');
            const isTriggerEvent = isClickMatch || isHoverMatch;

            const behaviourType = String(config.type || '').toLowerCase();
            // Show tooltip if type is show_tooltip OR if tooltip data exists (regardless of action type)
            if ((behaviourType === 'show_tooltip' || config.tooltip) && isTriggerEvent) {
                if (triggerType === 'click') {
                    const ov = document.getElementById('modal-launcher-tooltip-overlay');
                    if (ov && ov.dataset.launcherId === actualLauncherId && typeof ov._closeTooltip === 'function') {
                        ov._closeTooltip();
                        return;
                    }
                }
                sdk._showTooltipModal(config, event, triggerType, actualLauncherId, refKey);
                return;
            }
            if (!isTriggerEvent) {
                return;
            }
            const actions = Array.isArray(config.action)
                ? config.action
                : (config.action ? [config.action] : []);
            if (!actions.length) {
                // No actions defined, load flow from API and execute
                const flowVersionId = config.flow_version_id || behaviour.flow_version_id || sdk._launcherFlowVersionIds?.[actualLauncherId] || null;
                const environmentId = sdk._environmentId || window.__modalFlowEnvKey || null;
                sdk._loadFlowFromApi(actualFlowRef, flowVersionId, environmentId).then((result) => {
                    if (result) {
                        sdk._executeFlow(actualFlowRef, refKey);
                        
                        // Handle dismissAfterFirstActivation after flow starts
                        if (dismissAfterFirstActivation && actualLauncherId) {
                            sdk._markLauncherAsDismissed(actualLauncherId);
                            const { button: launcherButton, attached: launcherAttached } = sdk._getLauncherElementsByLauncherId(actualLauncherId);
                            const launcherElement = launcherButton || launcherAttached;
                            if (launcherElement) {
                                launcherElement.remove();
                            }
                        }
                    } else {
                        console.error("[ModalFlow] Failed to load flow data for:", actualFlowRef);
                    }
                }).catch(err => {
                    console.error("[ModalFlow] Failed to load flow from API:", err);
                });
                return;
            }

            for (const action of actions) {
                if (!action || typeof action !== "object") continue;

                const actionType = String(action.condition_type || action.type || '').toLowerCase();

                if (actionType === "startflow" || actionType === "start_flow") {
                    const targetFlowId = action.flowRef || action.flow_ref || action.flowid || actualFlowRef;

                    if (!targetFlowId) {
                        console.warn("[ModalFlow] No target flow ID found in action:", action);
                        continue;
                    }

                    const targetStepId = action.stepid || action.stepId || action.step_id;
                    const flowVersionId = action.flow_version_id || action.flowVersionId || config.flow_version_id || sdk._launcherFlowVersionIds?.[targetFlowId] || null;
                    const environmentId = sdk._environmentId || window.__modalFlowEnvKey || null;

                    // Load flow from individual API endpoint: /flows/{flowid}.json?flow_version_id=...
                    sdk._loadFlowFromApi(targetFlowId, flowVersionId, environmentId).then((result) => {
                        if (result) {
                            if (targetStepId) {
                                sdk._executeFlow(targetFlowId, refKey, { startStepId: targetStepId, fromLauncher: true });
                            } else {
                                sdk._executeFlow(targetFlowId, refKey);
                            }
                            
                            // Handle dismissAfterFirstActivation after flow starts
                            if (dismissAfterFirstActivation && actualLauncherId) {
                                sdk._markLauncherAsDismissed(actualLauncherId);
                                const { button: launcherButton, attached: launcherAttached } = sdk._getLauncherElementsByLauncherId(actualLauncherId);
                                const launcherElement = launcherButton || launcherAttached;
                                if (launcherElement) {
                                    launcherElement.remove();
                                }
                            }
                        } else {
                            console.error("[ModalFlow] Failed to load flow data for:", targetFlowId);
                        }
                    }).catch(err => {
                        console.error("[ModalFlow] Failed to load flow from API:", err);
                    });
                    return; // Exit after handling startflow action
                }

                else if (actionType === "navigatetopage") {
                    const url = action.pageUrl || action.url;
                    const navOption = action.actions?.[0]?.option;

                    const targetUrl = navOption?.pageUrl || url;
                    const openInNewTab = navOption?.openInNewTab || action.openInNewTab || false;

                    if (!targetUrl) {
                        console.warn('[ModalFlow] ⚠️ navigatetopage: No target URL provided', action);
                        continue;
                    }

                    window.open(targetUrl, openInNewTab ? "_blank" : "_self");
                }

                // DISMISS FLOW
                else if (actionType === "dismissflow" || actionType === "dismisslauncher" || actionType === "dismiss") {
                    event.currentTarget.remove();
                }

                // OPEN URL
                else if (actionType === "openurl") {
                    const targetUrl = action.url;
                    const openInNewTab = action.openInNewTab !== false;

                    if (!targetUrl) {
                        console.warn('[ModalFlow] ⚠️ openurl: No target URL provided', action);
                        continue;
                    }

                    window.open(targetUrl, openInNewTab ? "_blank" : "_self");
                }

                else {
                    console.warn("[ModalFlow] Unknown action:", actionType);
                }
            }
        } catch (err) {
            console.error("[ModalFlow] Error in _handleLauncherAction:", err);
        }
    };
    sdk._showTooltipModal = function (behaviour, event, triggerType, launcherId, refKey) {
        // Check if modal already exists
        if (document.getElementById('modal-launcher-tooltip-overlay')) {
            return;
        }

        // Parse behaviour if it's a string
        let parsedBehaviour = behaviour;
        if (typeof behaviour === 'string') {
            try {
                parsedBehaviour = JSON.parse(behaviour);
            } catch (e) {
                console.error('[ModalFlow] Failed to parse behaviour:', e);
                parsedBehaviour = behaviour;
            }
        }

        // Get tooltip content from value or tooltip.content (new format)
        const tooltipText = parsedBehaviour.tooltip?.content || parsedBehaviour.value || 'Start here';

        // Parse behaviour settings (new format only)
        const tooltipOptions = parsedBehaviour.tooltip?.options || {};
        const dismissAfterFirstActivation = tooltipOptions.dismissAfterFirstActivation === true;
        const isLauncherDismissed = (launcherId) => {
            try {
                const dismissed = localStorage.getItem(`modalflow_launcher_dismissed_${launcherId}`);
                return dismissed === 'true';
            } catch (e) {
                return false;
            }
        };

        // Helper function to mark launcher as dismissed
        const markLauncherAsDismissed = (launcherId) => {
            try {
                localStorage.setItem(`modalflow_launcher_dismissed_${launcherId}`, 'true');
            } catch (e) {
                console.error('[ModalFlow] Failed to save dismissal state:', e);
            }
        };
        if (dismissAfterFirstActivation && launcherId) {
            if (isLauncherDismissed(launcherId)) {
                const { button: prevButton, attached: prevAttached } = sdk._getLauncherElementsByLauncherId(launcherId);
                const launcherElement = prevButton || prevAttached;
                if (launcherElement) {
                    launcherElement.remove();
                }
                return;
            }
        }
        const keepOpenWhenHovered = tooltipOptions.keepOpenWhenHovered !== false;
        const hideLauncherWhileDisplayed = tooltipOptions.hideLauncherWhileDisplayed === true;

        // Get positioning configuration (new format only)
        const specifyPosition = tooltipOptions.specifyPosition === true;
        // Read position from tooltip.options.position (new format only)
        const positionValue = tooltipOptions.position || 'below';
        // Normalize position values: "above" -> "above", "below" -> "below", etc.
        const tooltipPosition = String(positionValue).toLowerCase();
        
        // Get tooltip width from ui.tooltip.width (new format)
        const tooltipWidth = parsedBehaviour.tooltip?.width || 400;

        // Get launcher theme from setup config
        const launcherSetup = sdk._launcherSetupConfigs?.[launcherId] || {};
        const themeMode = launcherSetup.theme || 'light';
        if (launcherSetup.themeCSS) {
            let themeEl = document.getElementById('modalflow-theme-vars');
            if (!themeEl) {
                themeEl = document.createElement('style');
                themeEl.id = 'modalflow-theme-vars';
                document.head.appendChild(themeEl);
            }
            themeEl.textContent = launcherSetup.themeCSS;
        }

        // Ensure brand colors are available for tooltip buttons (flow UI consistency)
        const brand = sdk._flowstyle?.base_colors?.brand || launcherSetup.brandColors;
        if (brand && !document.getElementById('modalflow-brand-vars')) {
            const parts = [];
            if (brand.background) parts.push('--ms-brand-background:' + brand.background);
            if (brand.backgroundHover) parts.push('--ms-brand-background-hover:' + brand.backgroundHover);
            if (brand.backgroundClick) parts.push('--ms-brand-background-active:' + brand.backgroundClick);
            if (brand.text) parts.push('--ms-brand-text:' + brand.text);
            if (brand.background) {
                parts.push('--ms-brand-pulse-start:' + hexToRgba(brand.background, 0.6));
                parts.push('--ms-brand-pulse-end:' + hexToRgba(brand.background, 0));
                parts.push('--ms-brand-background-subtle:' + hexToRgba(brand.background, 0.12));
            }
            if (parts.length) {
                const st = document.createElement('style');
                st.id = 'modalflow-brand-vars';
                st.textContent = ':root{' + parts.join(';') + '}';
                document.head.appendChild(st);
            }
        }
        // Ensure single preview-styles block exists (flow + tooltip use same element; no duplicate style nodes)
        sdk._ensurePreviewStyles();

        // Parse additional_block to get button configurations
        let additionalBlocks = [];
        try {
            if (parsedBehaviour.additional_block) {
                const parsed = typeof parsedBehaviour.additional_block === 'string'
                    ? JSON.parse(parsedBehaviour.additional_block)
                    : parsedBehaviour.additional_block;
                additionalBlocks = Array.isArray(parsed) ? parsed : [parsed];
            }
        } catch (e) {
            console.error('[ModalFlow] Failed to parse additional_block:', e);
        }

        // Also check for tooltip.blocks (new format)
        if (parsedBehaviour.tooltip && parsedBehaviour.tooltip.blocks) {
            additionalBlocks = parsedBehaviour.tooltip.blocks;
        }

        // Extract button blocks
        const buttonBlocks = additionalBlocks.filter(block => block.type === 'button');
        const effectiveKeepOpen = buttonBlocks.length > 0 ? true : keepOpenWhenHovered;
        const { button: launcherButton, attached: launcherAttached } = sdk._getLauncherElementsByLauncherId(launcherId);
        const launcherElement = launcherButton || launcherAttached;

        if (hideLauncherWhileDisplayed && launcherElement) {
            launcherElement.dataset.tooltipDisplayed = 'true';
            launcherElement.style.setProperty('opacity', '0', 'important');
            launcherElement.style.setProperty('pointer-events', 'none', 'important');
            launcherElement.style.setProperty('visibility', 'hidden', 'important');
        }

        // Create tooltip container (no overlay backdrop - tooltip style)
        const overlay = document.createElement('div');
        overlay.className = 'modal-launcher-tooltip-overlay';
        overlay.id = 'modal-launcher-tooltip-overlay';
        overlay.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            z-index: 1000000;
            background: transparent;
            pointer-events: none;
        `;

        // Create tooltip box (tooltip-style, not modal-style) with theme support
        const tooltip = document.createElement('div');
        tooltip.className = `modal-launcher-tooltip-box ${themeMode}`;
        // Only set min-width if tooltipWidth is less than 200, otherwise use tooltipWidth as min
        const minWidth = tooltipWidth < 200 ? 200 : tooltipWidth;
        tooltip.style.cssText = `
            position: fixed;
            background: var(--ms-theme-background-secondary, ${themeMode === 'dark' ? '#1f2937' : '#ffffff'});
            color: var(--ms-theme-text-primary, ${themeMode === 'dark' ? '#fff' : '#212529'});
            padding: 12px 16px;
            border-radius: 8px;
            z-index: 1000001;
            font-size: 13px;
            width: ${tooltipWidth}px;
            max-width: ${tooltipWidth}px;
            min-width: ${minWidth}px;
            box-shadow: 0 4px 12px var(--ms-theme-shadow, rgba(0,0,0,0.25));
            pointer-events: auto;
            font-family: system-ui, -apple-system, sans-serif;
            line-height: 1.5;
            border: 1px solid var(--ms-theme-border, ${themeMode === 'dark' ? '#666666' : '#eaecf0'});
        `;

        let isOverTooltip = false;
        let isOverLauncher = false;

        // Create content
        const content = document.createElement('div');
        content.className = 'modal-launcher-tooltip-content';
        content.innerHTML = tooltipText;
        content.style.cssText = `margin: 0; color: var(--ms-theme-text-primary, ${themeMode === 'dark' ? '#fff' : '#212529'});`;

        // Create footer with buttons from additional_block
        const footer = document.createElement('div');
        footer.className = 'modal-launcher-tooltip-footer';
        footer.style.cssText = 'display: flex; gap: 8px; margin-top: 12px; justify-content: flex-end;';

        // Helper function to execute button actions
        const executeButtonActions = (actions) => {
            if (!Array.isArray(actions) || actions.length === 0) {
                return;
            }

            for (const action of actions) {
                if (!action || typeof action !== 'object') continue;

                const actionType = String(action.type || action.id || '').toLowerCase();

                if (actionType === 'startflow' || actionType === 'start_flow') {
                    const flowRef = sdk._launcherFlowRefs?.[launcherId] || null;
                    const targetFlowId = action.flowRef || action.flow_ref || flowRef;
                    const targetStepId = action.stepid || action.stepId || action.step_id;
                    if (targetFlowId) {
                        if (targetStepId) {
                            sdk._executeFlow(targetFlowId, refKey, { startStepId: targetStepId, fromLauncher: true });
                        } else {
                            sdk._executeFlow(targetFlowId, refKey);
                        }
                    } else {
                        console.error('[ModalFlow] No flow ID found in action:', action);
                    }

                    // Handle dismissAfterFirstActivation
                    if (dismissAfterFirstActivation) {
                        markLauncherAsDismissed(launcherId);
                        if (launcherElement) {
                            launcherElement.remove();
                        }
                    }
                } else if (actionType === 'navigatetopage') {
                    const url = action.pageUrl || action.url;
                    if (url) {
                        const openInNewTab = action.openInNewTab || false;
                        const target = openInNewTab ? '_blank' : '_self';
                        window.open(url, target);
                    }

                    if (dismissAfterFirstActivation) {
                        markLauncherAsDismissed(launcherId);
                        if (launcherElement) {
                            launcherElement.remove();
                        }
                    }
                } else if (actionType === 'dismissflow' || actionType === 'dismisslauncher' || actionType === 'dismiss') {
                    if (launcherElement) {
                        launcherElement.remove();
                    }
                }
            }
        };

        // Create buttons from additional_block
        if (buttonBlocks.length > 0) {
            buttonBlocks.forEach((buttonBlock, index) => {
                // New format: direct properties
                let btnText = buttonBlock.text || 'Button';
                let btnStyle = buttonBlock.style || 'primary';
                let btnActions = [];
                    
                // Convert new format action to old format for executeButtonActions
                if (buttonBlock.action) {
                    const action = buttonBlock.action;
                    if (action.type === 'start_flow') {
                        btnActions = [{
                            type: 'startFlow',
                            flowRef: action.flow_ref,
                            stepid: action.step_id || '',
                            condition_type: 'startflow'
                        }];
                    } else {
                        // Handle other action types
                        btnActions = [{
                            type: action.type === 'start_flow' ? 'startFlow' : action.type,
                            flowRef: action.flow_ref,
                            stepid: action.step_id || '',
                            condition_type: 'startflow'
                        }];
                    }
                }

                const btn = document.createElement('button');
                const isPrimary = btnStyle === 'primary' || index === buttonBlocks.length - 1;
                btn.className = isPrimary ? 'mf-btn' : 'mf-btn-secondary';
                btn.textContent = btnText;
                btn.onclick = () => {
                    overlay.remove();
                    if (hideLauncherWhileDisplayed && launcherElement) {
                        delete launcherElement.dataset.tooltipDisplayed;
                        launcherElement.style.removeProperty('opacity');
                        launcherElement.style.removeProperty('pointer-events');
                        launcherElement.style.removeProperty('visibility');
                    }
                    executeButtonActions(btnActions);
                };
                footer.appendChild(btn);
            });
        }

        // Assemble tooltip
        tooltip.appendChild(content);
        if (buttonBlocks.length > 0 || footer.children.length > 0) {
            tooltip.appendChild(footer);
        }
        overlay.appendChild(tooltip);

        // Add to document
        document.body.appendChild(overlay);

        // Position tooltip relative to launcher (always positioned relative to launcher)
        if (launcherElement) {
            const launcherRect = launcherElement.getBoundingClientRect();
            const tooltipRect = tooltip.getBoundingClientRect();
            const gap = 12; // Gap between launcher and tooltip
            const arrowSize = 8; // Size of the arrow pointer

            // Create arrow element
            const arrow = document.createElement('div');
            arrow.style.cssText = `
                position: absolute;
                width: 0;
                height: 0;
                border-style: solid;
            `;
            tooltip.appendChild(arrow);

            let top, left;
            // Use specified position if specifyPosition is true, otherwise default to 'below'
            const effectivePosition = specifyPosition ? tooltipPosition : 'below';

            switch (effectivePosition.toLowerCase()) {
                case 'below':
                case 'bottom':
                    top = launcherRect.bottom + gap;
                    left = launcherRect.left + (launcherRect.width / 2) - (tooltipRect.width / 2);

                    // Arrow pointing up - use CSS variable for background color
                    const arrowColor = themeMode === 'dark' 
                        ? 'var(--ms-theme-background-secondary, #1f2937)' 
                        : 'var(--ms-theme-background-secondary, #ffffff)';
                    arrow.style.cssText += `
                        border-width: 0 ${arrowSize}px ${arrowSize}px ${arrowSize}px;
                        border-color: transparent transparent ${arrowColor} transparent;
                        top: -${arrowSize}px;
                        left: 50%;
                        transform: translateX(-50%);
                    `;
                    break;

                case 'above':
                case 'top':
                    top = launcherRect.top - tooltipRect.height - gap;
                    left = launcherRect.left + (launcherRect.width / 2) - (tooltipRect.width / 2);

                    // Arrow pointing down - use CSS variable for background color
                    const arrowColorTop = themeMode === 'dark' 
                        ? 'var(--ms-theme-background-secondary, #1f2937)' 
                        : 'var(--ms-theme-background-secondary, #ffffff)';
                    arrow.style.cssText += `
                        border-width: ${arrowSize}px ${arrowSize}px 0 ${arrowSize}px;
                        border-color: ${arrowColorTop} transparent transparent transparent;
                        bottom: -${arrowSize}px;
                        left: 50%;
                        transform: translateX(-50%);
                    `;
                    break;

                case 'left':
                    top = launcherRect.top + (launcherRect.height / 2) - (tooltipRect.height / 2);
                    left = launcherRect.left - tooltipRect.width - gap;

                    // Arrow pointing right - use CSS variable for background color
                    const arrowColorLeft = themeMode === 'dark' 
                        ? 'var(--ms-theme-background-secondary, #1f2937)' 
                        : 'var(--ms-theme-background-secondary, #ffffff)';
                    arrow.style.cssText += `
                        border-width: ${arrowSize}px 0 ${arrowSize}px ${arrowSize}px;
                        border-color: transparent transparent transparent ${arrowColorLeft};
                        right: -${arrowSize}px;
                        top: 50%;
                        transform: translateY(-50%);
                    `;
                    break;

                case 'right':
                    top = launcherRect.top + (launcherRect.height / 2) - (tooltipRect.height / 2);
                    left = launcherRect.right + gap;

                    // Arrow pointing left - use CSS variable for background color
                    const arrowColorRight = themeMode === 'dark' 
                        ? 'var(--ms-theme-background-secondary, #1f2937)' 
                        : 'var(--ms-theme-background-secondary, #ffffff)';
                    arrow.style.cssText += `
                        border-width: ${arrowSize}px ${arrowSize}px ${arrowSize}px 0;
                        border-color: transparent ${arrowColorRight} transparent transparent;
                        left: -${arrowSize}px;
                        top: 50%;
                        transform: translateY(-50%);
                    `;
                    break;

                default:
                    // Default to below if position is not recognized
                    top = launcherRect.bottom + gap;
                    left = launcherRect.left + (launcherRect.width / 2) - (tooltipRect.width / 2);

                    const arrowColorDefault = themeMode === 'dark' 
                        ? 'var(--ms-theme-background-secondary, #1f2937)' 
                        : 'var(--ms-theme-background-secondary, #ffffff)';
                    arrow.style.cssText += `
                        border-width: 0 ${arrowSize}px ${arrowSize}px ${arrowSize}px;
                        border-color: transparent transparent ${arrowColorDefault} transparent;
                        top: -${arrowSize}px;
                        left: 50%;
                        transform: translateX(-50%);
                    `;
                    break;
            }

            // Ensure tooltip stays within viewport
            const viewportWidth = window.innerWidth;
            const viewportHeight = window.innerHeight;

            if (left < 10) left = 10;
            if (left + tooltipRect.width > viewportWidth - 10) {
                left = viewportWidth - tooltipRect.width - 10;
            }
            if (top < 10) top = 10;
            if (top + tooltipRect.height > viewportHeight - 10) {
                top = viewportHeight - tooltipRect.height - 10;
            }

            tooltip.style.top = `${top}px`;
            tooltip.style.left = `${left}px`;

            // Adjust arrow position to align with launcher center after viewport constraints
            const adjustArrowPosition = () => {
                try {
                    // Get fresh bounding rects after viewport adjustment
                    const freshLauncherRect = launcherElement.getBoundingClientRect();
                    const freshTooltipRect = tooltip.getBoundingClientRect();
                    
                    const launcherCenterX = freshLauncherRect.left + (freshLauncherRect.width / 2);
                    const launcherCenterY = freshLauncherRect.top + (freshLauncherRect.height / 2);
                    
                    const pos = effectivePosition.toLowerCase();
                    
                    if (pos === 'below' || pos === 'bottom') {
                        const relX = launcherCenterX - freshTooltipRect.left;
                        const constrainedX = Math.max(10, Math.min(freshTooltipRect.width - 30, relX));
                        arrow.style.left = (constrainedX - arrowSize) + 'px';
                        arrow.style.removeProperty('transform');
                        arrow.style.removeProperty('right');
                    } else if (pos === 'above' || pos === 'top') {
                        const relX = launcherCenterX - freshTooltipRect.left;
                        const constrainedX = Math.max(10, Math.min(freshTooltipRect.width - 30, relX));
                        arrow.style.left = (constrainedX - arrowSize) + 'px';
                        arrow.style.removeProperty('transform');
                    } else if (pos === 'left') {
                        const relY = launcherCenterY - freshTooltipRect.top;
                        const constrainedY = Math.max(10, Math.min(freshTooltipRect.height - 30, relY));
                        arrow.style.top = (constrainedY - arrowSize) + 'px';
                        arrow.style.removeProperty('transform');
                    } else if (pos === 'right') {
                        const relY = launcherCenterY - freshTooltipRect.top;
                        const constrainedY = Math.max(10, Math.min(freshTooltipRect.height - 30, relY));
                        arrow.style.top = (constrainedY - arrowSize) + 'px';
                        arrow.style.removeProperty('transform');
                        arrow.style.removeProperty('bottom');
                    }
                } catch (e) {
                    console.error('[ModalFlow] Error adjusting launcher tooltip arrow position:', e);
                }
            };
            
            adjustArrowPosition();
        }

        const closeTooltip = () => {
            requestAnimationFrame(() => {
                overlay.remove();
                if (hideLauncherWhileDisplayed && launcherElement) {
                    // Batch style property removals
                    requestAnimationFrame(() => {
                        delete launcherElement.dataset.tooltipDisplayed;
                        launcherElement.style.removeProperty('opacity');
                        launcherElement.style.removeProperty('pointer-events');
                        launcherElement.style.removeProperty('visibility');
                    });
                }
            });
        };

        overlay.dataset.launcherId = launcherId;
        overlay._closeTooltip = closeTooltip;
        if (triggerType === 'click') {
            overlay.style.pointerEvents = 'auto';
            overlay.addEventListener('click', function (e) {
                if (e.target === overlay) closeTooltip();
            });
        }

        // Check if launcher is visible and can receive mouse events
        const isLauncherVisible = launcherElement && !hideLauncherWhileDisplayed;

        if (effectiveKeepOpen) {
            tooltip.addEventListener('mouseenter', () => {
                isOverTooltip = true;
            });

            tooltip.addEventListener('mouseleave', () => {
                isOverTooltip = false;
                if (triggerType === 'mouseover') {
                    requestAnimationFrame(() => {
                        setTimeout(() => {
                            if (!isLauncherVisible || !isOverLauncher) {
                                closeTooltip();
                            }
                        }, 50);
                    });
                }
            });

            if (isLauncherVisible && triggerType === 'mouseover') {
                const launcherMouseEnter = () => {
                    isOverLauncher = true;
                };
                const launcherMouseLeave = () => {
                    isOverLauncher = false;
                    requestAnimationFrame(() => {
                        setTimeout(() => {
                            if (!isOverTooltip && !isOverLauncher) {
                                closeTooltip();
                            }
                        }, 50);
                    });
                };

                launcherElement.addEventListener('mouseenter', launcherMouseEnter);
                launcherElement.addEventListener('mouseleave', launcherMouseLeave);

                overlay._cleanupLauncherListeners = () => {
                    launcherElement.removeEventListener('mouseenter', launcherMouseEnter);
                    launcherElement.removeEventListener('mouseleave', launcherMouseLeave);
                };
            } else {
                overlay._cleanupLauncherListeners = () => {};
            }
        } else {
            if (triggerType === 'mouseover') {
                const tooltipMouseLeave = () => {
                    requestAnimationFrame(() => {
                        setTimeout(() => {
                            closeTooltip();
                        }, 50);
                    });
                };

                tooltip.addEventListener('mouseleave', tooltipMouseLeave);

                let launcherMouseLeave = null;
                if (isLauncherVisible) {
                    launcherMouseLeave = () => {
                        requestAnimationFrame(() => {
                            setTimeout(() => {
                                closeTooltip();
                            }, 50);
                        });
                    };

                    launcherElement.addEventListener('mouseleave', launcherMouseLeave);
                }

                overlay._cleanupLauncherListeners = () => {
                    tooltip.removeEventListener('mouseleave', tooltipMouseLeave);
                    if (isLauncherVisible && launcherMouseLeave) {
                        launcherElement.removeEventListener('mouseleave', launcherMouseLeave);
                    }
                };
            } else {
                overlay._cleanupLauncherListeners = () => {};
            }
        }

        // Close on Escape key (optional for tooltip)
        const handleEscape = (e) => {
            if (e.key === 'Escape') {
                overlay.remove();
                if (hideLauncherWhileDisplayed && launcherElement) {
                    delete launcherElement.dataset.tooltipDisplayed;
                    launcherElement.style.removeProperty('opacity');
                    launcherElement.style.removeProperty('pointer-events');
                    launcherElement.style.removeProperty('visibility');
                }
                document.removeEventListener('keydown', handleEscape);
            }
        };
        document.addEventListener('keydown', handleEscape);

        // Cleanup when overlay is removed
        const originalRemove = overlay.remove.bind(overlay);
        overlay.remove = function () {
            if (overlay._cleanupLauncherListeners) {
                overlay._cleanupLauncherListeners();
            }
            document.removeEventListener('keydown', handleEscape);
            originalRemove();
        };
    };
    sdk._parsePatternParts = function (pattern) {
        const parts = { scheme: null, domain: null, path: null, query: null, hash: null, protocolRelative: false };
        if (!pattern) return parts;
        
        const p = pattern.trim();
        let remaining = p;
        
        if (p.startsWith('//')) {
            parts.protocolRelative = true;
            remaining = p.substring(2); // Remove //
        }
        // Extract scheme
        else {
            const schemeMatch = p.match(/^([^:]+):\/\//);
            if (schemeMatch) {
                parts.scheme = schemeMatch[1];
                remaining = p.substring(schemeMatch[0].length);
            }
        }
        
        // Extract query and hash
        const qIdx = remaining.indexOf('?');
        const hIdx = remaining.indexOf('#');
        let beforeQueryHash = remaining;
        
        if (qIdx !== -1 && (hIdx === -1 || qIdx < hIdx)) {
            beforeQueryHash = remaining.substring(0, qIdx);
            const afterQ = remaining.substring(qIdx + 1);
            const hashIdx = afterQ.indexOf('#');
            parts.query = hashIdx !== -1 ? afterQ.substring(0, hashIdx) : afterQ;
            if (hashIdx !== -1) parts.hash = afterQ.substring(hashIdx + 1);
        } else if (hIdx !== -1) {
            beforeQueryHash = remaining.substring(0, hIdx);
            parts.hash = remaining.substring(hIdx + 1);
        }
        
        // Extract domain and path
        if (beforeQueryHash.startsWith('/')) {
            parts.path = beforeQueryHash;
        } else if (beforeQueryHash) {
            const slashIdx = beforeQueryHash.indexOf('/');
            const starIdx = beforeQueryHash.indexOf('*');
            
            if (slashIdx !== -1) {
                parts.domain = beforeQueryHash.substring(0, slashIdx);
                parts.path = beforeQueryHash.substring(slashIdx);
            } else if (starIdx !== -1) {
                parts.domain = beforeQueryHash.substring(0, starIdx);
                parts.path = '/' + beforeQueryHash.substring(starIdx); // Add / before * to make it a path pattern
            } else {
                parts.domain = beforeQueryHash;
            }
        }
        
        return parts;
    };
    
    sdk._matchesUrlPattern = function (pattern, url) {
        if (!pattern || pattern === '*') return true;
        
        try {
            const urlObj = new URL(url || window.location.href);
            const patternParts = sdk._parsePatternParts(pattern);
            
            if (patternParts.protocolRelative) {
                // Skip scheme matching for protocol-relative URLs
            } else if (patternParts.scheme && patternParts.scheme.toLowerCase() !== urlObj.protocol.replace(':', '').toLowerCase()) {
                return false;
            }
            if (patternParts.domain && !sdk._matchDomainPattern(patternParts.domain, urlObj.host)) return false;
            if (patternParts.path && !sdk._matchPathPattern(patternParts.path, urlObj.pathname)) return false;
            if (patternParts.query && !sdk._matchQueryPattern(patternParts.query, urlObj.search)) return false;
            if (patternParts.hash && !sdk._matchPathPattern(patternParts.hash, urlObj.hash.replace('#', ''))) return false;
            
            return true;
        } catch (error) {
            return (url || window.location.href).includes(pattern.trim());
        }
    };
    
    sdk._matchDomainPattern = function (pattern, domain) {
        if (!pattern || pattern === '*' || pattern === domain) return true;
        
        try {
            let regexPattern = pattern
                .replace(/:[a-zA-Z0-9_]+/g, '__PARAM__') // :param -> placeholder
                .replace(/\*/g, '__WILDCARD__'); // * -> placeholder
            
            regexPattern = regexPattern.replace(/[.+?${}()|\\\[\]]/g, '\\$&');
            
            regexPattern = regexPattern.replace(/__PARAM__/g, '[^.]+');
            regexPattern = regexPattern.replace(/__WILDCARD__/g, '.*');
            
            return new RegExp('^' + regexPattern + '$', 'i').test(domain);
        } catch {
            return domain.includes(pattern);
        }
    };
    
    sdk._matchPathPattern = function (pattern, path) {
        if (!pattern || pattern === '*') return true;
        
        const cleanPattern = pattern.replace(/\/$/, '');
        const cleanPath = path.replace(/\/$/, '');
        if (cleanPattern === cleanPath) return true;
        
        // Handle /* pattern - matches / and any subpath
        if (pattern === '/*' || pattern === '*') {
            return path === '/' || path.startsWith('/');
        }
        
        // Handle /app* vs /app/* difference
        if (pattern.endsWith('*') && !pattern.endsWith('/*')) {
            const base = pattern.slice(0, -1);
            if (cleanPath === base || cleanPath.startsWith(base + '/') || cleanPath.startsWith(base)) return true;
        } else if (pattern.endsWith('/*')) {
            const base = pattern.slice(0, -2);
            // Special case: if base is empty, /* should match / and any subpath
            if (base === '') {
                return path === '/' || path.startsWith('/');
            }
            if (cleanPath.startsWith(base + '/')) return true;
        }
        
        // Handle :param and * patterns with regex
        try {
            // First replace :param and * patterns with placeholders
            let regexPattern = pattern
                .replace(/:[a-zA-Z0-9_]+/g, '__PARAM__') // :param -> placeholder
                .replace(/\*/g, '__WILDCARD__'); // * -> placeholder
            
            // Escape special regex chars (forward slashes don't need escaping in RegExp)
            regexPattern = regexPattern.replace(/[.+?${}()|\\\[\]]/g, '\\$&');
            
            // Restore placeholders with actual regex patterns
            regexPattern = regexPattern.replace(/__PARAM__/g, '[^/]+');
            regexPattern = regexPattern.replace(/__WILDCARD__/g, '.*');
            
            const regex = new RegExp('^' + regexPattern + '$', 'i');
            const matches = regex.test(cleanPath);
            
            return matches;
        } catch (error) {
            return cleanPath.includes(cleanPattern);
        }
    };
    
    sdk._matchQueryPattern = function (pattern, query) {
        if (!pattern || pattern === '*') return true;
        if (!query) return false;
        
        const urlParams = new URLSearchParams(query.replace(/^\?/, ''));
        const patternParams = new URLSearchParams(pattern.replace(/^\?/, ''));
        
        for (const [key, value] of patternParams.entries()) {
            const urlValue = urlParams.get(key);
            if (urlValue === null && value !== '*') return false;
            if (value === '*') continue;
            if (value.endsWith('*') && !urlValue.startsWith(value.slice(0, -1))) return false;
            if (urlValue !== value) return false;
        }
        return true;
    };
    sdk._start = async function (flowId, refKey, data = {}) {
        if (!isOperationAllowed()) return;

        const token = sdk._token;
        if (!token) {
            return;
        }

        if (!sdk._flows || !sdk._flows[flowId]) {
            await sdk._initModalFlow(flowId, refKey, { skipLauncher: true, skipAutoStart: true });
        }

        const autoStartSettings = sdk._autoStartSettings?.[flowId];

        if (autoStartSettings && autoStartSettings.value === true) {
            const shouldAutoStart = sdk._checkAutoStartConditions(autoStartSettings);

            if (!shouldAutoStart) {
                return;
            }

            const delay = parseInt(autoStartSettings.period) || 0;
            const delayMs = autoStartSettings.period_type === 'seconds' ? delay * 1000 : delay * 60000;

            if (delay > 0) {
                setTimeout(() => {
                    sdk._executeFlow(flowId, refKey, data);
                }, delayMs);
                return;
            }
            sdk._refreshLauncherVisibilityWithRaf(flowId, [0, 120, 320]);
        }
        const shouldShowOnCurrentPage = sdk._checkFlowAppUrl(flowId);
        if (!shouldShowOnCurrentPage) {
            return;
        }

        await sdk._executeFlow(flowId, refKey, data);
    };

    sdk._end = function () {
        if (sdk._flows) {
            Object.keys(sdk._flows).forEach(key => {
                // Skip the refKey entries (which are strings)
                if (sdk._flows[key] && typeof sdk._flows[key] === 'object' && sdk._flows[key].launcher) {
                    setTimeout(() => {
                        sdk._updateLauncherVisibilityForFlow(key);
                    }, 100);
                }
            });
        }
    };
    sdk._isFlowActive = function () {
        // Check if the flow overlay exists
        const overlay = document.getElementById('modalflow-guide-overlay');
        if (overlay) {
            return true;
        }

        // Check if any modalflow boxes exist
        const boxes = document.querySelectorAll('[data-modalflow-box="1"]');
        if (boxes && boxes.length > 0) {
            return true;
        }

        return false;
    };

    sdk._getDismissedAutoStartFlows = function () {
        if (!sdk._dismissedAutoStartFlowIds) sdk._dismissedAutoStartFlowIds = [];
        return sdk._dismissedAutoStartFlowIds;
    };

    sdk._markAutoStartFlowDismissed = function (flowId) {
        try {
            const dismissed = sdk._getDismissedAutoStartFlows();
            if (!dismissed.includes(flowId)) dismissed.push(flowId);
        } catch (e) {}
    };

    sdk._isAutoStartFlowDismissed = function (flowId) {
        return (sdk._dismissedAutoStartFlowIds || []).includes(flowId);
    };

    // Track last valid URL for each flow to detect navigation away/back
    sdk._getLastValidUrlForFlow = function (flowId) {
        try {
            const lastUrls = sessionStorage.getItem('modalflow_last_valid_urls');
            const urls = lastUrls ? JSON.parse(lastUrls) : {};
            return urls[flowId] || null;
        } catch (e) {
            return null;
        }
    };

    sdk._setLastValidUrlForFlow = function (flowId, url) {
        try {
            const lastUrls = sessionStorage.getItem('modalflow_last_valid_urls');
            const urls = lastUrls ? JSON.parse(lastUrls) : {};
            if (url === null) {
                delete urls[flowId];
            } else {
                urls[flowId] = url;
            }
            sessionStorage.setItem('modalflow_last_valid_urls', JSON.stringify(urls));
        } catch (e) {
            console.error('[ModalFlow] Error setting last valid URL:', e);
        }
    };

    sdk._refreshAttachedLauncherPosition = function (attachedLauncher, delays = [0, 120, 350, 900]) {
        if (!attachedLauncher || typeof attachedLauncher._updatePosition !== 'function') return;

        delays.forEach(delay => {
            setTimeout(() => {
                requestAnimationFrame(() => {
                    if (!document.body.contains(attachedLauncher)) return;
                    try {
                        attachedLauncher._updatePosition(true);
                    } catch (e) {}
                });
            }, delay);
        });
    };

    sdk._refreshLauncherVisibilityWithRaf = function (flowId, delays = [0, 120, 320]) {
        if (!flowId) return;

        delays.forEach(delay => {
            setTimeout(() => {
                requestAnimationFrame(() => {
                    try {
                        sdk._updateLauncherVisibilityForFlow(flowId);
                    } catch (e) {}

                    try {
                        const { attached } = sdk._getLauncherElementsByFlow(flowId);
                        if (attached) {
                            sdk._refreshAttachedLauncherPosition(attached, [0, 160]);
                        }
                    } catch (e) {}
                });
            }, delay);
        });
    };

    // Helper function to set launcher display only if it needs to change
    sdk._setLauncherDisplay = function (element, targetDisplay) {
        if (!element) return;
        
        const currentDisplay = element.style.display || window.getComputedStyle(element).display;
        const normalizedCurrent = currentDisplay === 'none' ? 'none' : (targetDisplay === 'inline-flex' ? 'inline-flex' : 'inline-block');
        
        // Only update if the display value actually needs to change
        if (normalizedCurrent !== targetDisplay) {
            element.style.display = targetDisplay;
        }
    };

    sdk._updateLauncherVisibilityForFlow = function (flowId) {
        if (!flowId) return;
        
        // Find launcher setup from new structure
        let setupConfig = {};
        let foundSetup = false;
        
        // Check launcherSetupConfigs by flowRef
        let foundLauncherId = null;
        if (sdk._launcherSetupConfigs) {
            for (const [launcherId, config] of Object.entries(sdk._launcherSetupConfigs)) {
                const launcherFlowRef = sdk._launcherFlowRefs?.[launcherId];
                if (launcherFlowRef === flowId) {
                    setupConfig = config;
                    foundLauncherId = launcherId;
                    foundSetup = true;
                    break;
                }
            }
        }
        
        if (!foundSetup) return;

        // Check if launcher is dismissed (permanently hidden after first activation)
        if (foundLauncherId && sdk._isLauncherDismissed(foundLauncherId)) {
            const { button: buttonLauncher, attached: attachedLauncher } = sdk._getLauncherElementsByFlow(flowId);
            // Permanently hide dismissed launchers
            if (buttonLauncher) {
                buttonLauncher.style.display = 'none';
                buttonLauncher.remove();
            }
            if (attachedLauncher) {
                attachedLauncher.style.display = 'none';
                attachedLauncher.remove();
            }
            return;
        }

        const showWhileActive = setupConfig.showLauncherWhileFlowsActive === true;
        const isFlowActive = sdk._isFlowActive();

        const { button: buttonLauncher, attached: attachedLauncher } = sdk._getLauncherElementsByFlow(flowId);

        // Determine if launcher should be visible
        let shouldShow = false;
        if (isFlowActive) {
            // When flow is active, show launcher only if showLauncherWhileFlowsActive is true
            shouldShow = showWhileActive;
        } else {
            // When flow is not active, check URL/conditions
            const urlMatches = sdk._checkLauncherUrlMatching(setupConfig);
            const conditionsPass = sdk._checkOnlyShowLauncherConditions(setupConfig);
            shouldShow = urlMatches && conditionsPass;
        }

        // Apply visibility only if it needs to change
        if (shouldShow) {
            sdk._setLauncherDisplay(buttonLauncher, 'inline-block');
            sdk._setLauncherDisplay(attachedLauncher, 'inline-flex');
        } else {
            sdk._setLauncherDisplay(buttonLauncher, 'none');
            sdk._setLauncherDisplay(attachedLauncher, 'none');
        }
    };
    
    sdk._dismissActiveFlow = function () {
        try {
            let flowId = null;
            try {
                flowId = sessionStorage.getItem('modalflow_active_flow_id');
                if (!flowId) {
                    var ov = document.getElementById('modalflow-guide-overlay');
                    if (ov && ov.dataset.flowId) flowId = ov.dataset.flowId;
                }
            } catch (e) {}
            if (typeof window.__STOP_MODALFLOW__ === 'function') { try { window.__STOP_MODALFLOW__(); } catch (e) {} }
            try {
                if (window.__MF_FLOW_STACK__) window.__MF_FLOW_STACK__.length = 0;
            } catch (e) {}
            try {
                var o;
                while ((o = document.getElementById('modalflow-guide-overlay')) != null) o.remove();
            } catch (e) {}
            try {
                document.querySelectorAll('[data-modalflow-box="1"], .mf-step-box').forEach(function (el) {
                    try { if (el._cleanupTooltipListeners && typeof el._cleanupTooltipListeners === 'function') el._cleanupTooltipListeners(); } catch (_) {}
                    el.remove();
                });
            } catch (e) {}
            
            // Beacons and tooltips
            try {
                const beacons = document.querySelectorAll('.mf-beacon');
                beacons.forEach(b => {
                    try {
                        if (b._cleanup) b._cleanup();
                        b.remove();
                    } catch (e) {}
                });
            } catch (e) {}
            
            try {
                const tooltips = document.querySelectorAll('.mf-tooltip, .mf-tooltip-box');
                tooltips.forEach(t => {
                    try {
                        t.remove();
                    } catch (e) {}
                });
            } catch (e) {}
            
            if (flowId) {
                try {
                    var scriptEl = document.getElementById('modalflow-script-' + flowId);
                    if (scriptEl) scriptEl.remove();
                    document.querySelectorAll('[id^="modalflow-script-' + flowId + '"]').forEach(function (s) { try { s.remove(); } catch (err) {} });
                } catch (e) {}
            }
            
            try {
                sessionStorage.removeItem('modalflow_active_flow_id');
                delete window.__CURRENT_FLOW_ID__;
                if (window.__MF_FLOW_STACK__) window.__MF_FLOW_STACK__.length = 0;
                window.__START_MODALFLOW__ = null;
                window.__START_MODALFLOW_FORCE__ = null;
                window.__STOP_MODALFLOW__ = null;
                document.body.classList.remove('modalflow-active');
            } catch (e) {}
            
            if (flowId && sdk._updateLauncherVisibilityForFlow) {
                try { sdk._updateLauncherVisibilityForFlow(flowId); } catch (e) {}
            }
        } catch (e) {
            // Silently fail to prevent breaking main site
        }
    };
    
    // Remove stray step (no overlay parent) when no flow is active (Vue keep-alive can restore step only)
    sdk._removeStrayModalFlowDOM = function () {
        try {
            if (sessionStorage.getItem('modalflow_active_flow_id')) return;
            document.body.classList.remove('modalflow-active');
            var e;
            while ((e = document.getElementById('modalflow-guide-overlay')) != null) e.remove();
            document.querySelectorAll('[data-modalflow-box="1"], .mf-step-box').forEach(function (el) {
                try { if (el._cleanupTooltipListeners && typeof el._cleanupTooltipListeners === 'function') el._cleanupTooltipListeners(); } catch (_) {}
                el.remove();
            });
        } catch (err) {}
    };
    
    // Helper function to find refKey from sdk._flows
    sdk._findRefKey = function (flowId) {
        try {
            if (!sdk._flows) return flowId;
            for (const key in sdk._flows) {
                if (typeof sdk._flows[key] === 'string' && sdk._flows[key] === key) {
                    return key;
                }
            }
        } catch (e) {}
        return flowId;
    };
    
    // Helper function to parse launcher config JSON strings
    sdk._parseLauncherConfig = function (launcher) {
        try {
            // Handle both JSON strings and objects
            const parseField = (field) => {
                if (!field) return {};
                if (typeof field === 'string') {
                    try {
                        return JSON.parse(field);
                    } catch (e) {
                        return {};
                    }
                }
                return field; // Already an object
            };
            
            return {
                setup: parseField(launcher.launcher_setup),
                appearance: parseField(launcher.launcher_appearence),
                behaviour: parseField(launcher.launcher_behaviour)
            };
        } catch (e) {
            return { setup: {}, appearance: {}, behaviour: {} };
        }
    };
    
    sdk._checkLauncherUrlConditions = function (setupConfig) {
        try {
            const hasUrlsMatching = setupConfig.urls_matching && setupConfig.urls_matching.length > 0;
            const hasExcludeUrls = setupConfig.exclude_urls_matching && setupConfig.exclude_urls_matching.length > 0;
            if (hasUrlsMatching || hasExcludeUrls) {
                return sdk._checkLauncherUrlMatching(setupConfig);
            }
        } catch (e) {}
        return false;
    };
    
    sdk._loadLauncherConfig = function (launcherIdOrFlowRef) {
        try {
            // Check if it's a launcherId
            const launcherData = sdk._launchers?.[launcherIdOrFlowRef];
            if (launcherData) {
                const convertedLauncher = sdk._convertLauncherToOldFormat(launcherData, null);
                if (convertedLauncher) {
                    return sdk._parseLauncherConfig(convertedLauncher);
                }
            }
            
            // Try to find launcher by flowRef
            const launcherIds = sdk._launcherIdsByFlowRef?.[launcherIdOrFlowRef];
            if (launcherIds && launcherIds.length > 0) {
                // Use first matching launcher
                const launcherDataByFlowRef = sdk._launchers?.[launcherIds[0]];
                if (launcherDataByFlowRef) {
                    const convertedLauncher = sdk._convertLauncherToOldFormat(launcherDataByFlowRef, null);
                    if (convertedLauncher) {
                        return sdk._parseLauncherConfig(convertedLauncher);
                    }
                }
            }
        } catch (e) {}
        return null;
    };
    
    // Helper function to check URL conditions for a flow
    sdk._checkUrlConditionsForActiveFlow = function (flowId) {
        try {
            const currentUrl = window.location.href;
            let shouldKeepFlowActive = false;
            let hasUrlConditions = false;
        
        // Check if flow has launcher with URL conditions
        const launcherConfig = sdk._loadLauncherConfig(flowId);
        if (launcherConfig) {
            const urlMatches = sdk._checkLauncherUrlConditions(launcherConfig.setup);
            if (urlMatches !== false) {
                hasUrlConditions = true;
                if (urlMatches) {
                    shouldKeepFlowActive = true;
                }
            }
        }
        
        // Check sdk._autoStartSettings for autostart URL conditions
        if (!hasUrlConditions && sdk._autoStartSettings?.[flowId]) {
            const autoStartSettings = sdk._autoStartSettings[flowId];
            if (autoStartSettings && autoStartSettings.value === true) {
                const conditions = autoStartSettings.conditions || [];
                const urlConditions = conditions.filter(c => c.type === 'current_page_url');
                
                if (urlConditions.length > 0) {
                    hasUrlConditions = true;
                    const urlMatches = sdk._checkAutoStartConditions(autoStartSettings);
                    if (urlMatches) {
                        shouldKeepFlowActive = true;
                    }
                }
            }
        }
        
        // Check flows_meta for autostart URL conditions
        if (!hasUrlConditions && sdk._flowsMeta?.[flowId]) {
            const flowMeta = sdk._flowsMeta[flowId];
            const autoStart = flowMeta.settings?.behavior?.autoStart;
            if (autoStart && autoStart.enabled) {
                const conditions = autoStart.conditions || [];
                const urlConditions = conditions.filter(c => c.condition_type === 'url' || c.type === 'url' || c.type === 'current_page_url');
                
                if (urlConditions.length > 0) {
                    hasUrlConditions = true;
                    let urlMatches = false;
                    for (const condition of urlConditions) {
                        if (condition.type === 'current_page_url') {
                            const hasMatchValues = condition.match_values && condition.match_values.length > 0;
                            const hasExcludeValues = condition.no_match_values && condition.no_match_values.length > 0;
                            
                            if (hasMatchValues) {
                                const matches = condition.match_values.some(pattern => sdk._matchesUrlPattern(pattern, currentUrl));
                                if (matches && condition.condition_type !== 'if_not') {
                                    urlMatches = true;
                                    break;
                                } else if (!matches && condition.condition_type === 'if') {
                                    urlMatches = false;
                                    break;
                                }
                            }
                            
                            if (hasExcludeValues) {
                                const excluded = condition.no_match_values.some(pattern => sdk._matchesUrlPattern(pattern, currentUrl));
                                if (excluded) {
                                    urlMatches = false;
                                    break;
                                }
                            }
                        }
                    }
                    
                    if (urlMatches) {
                        shouldKeepFlowActive = true;
                    }
                }
            }
        }
        
        return { hasUrlConditions, shouldKeepFlowActive };
        } catch (e) {
            // Return safe defaults if any error occurs
            return { hasUrlConditions: false, shouldKeepFlowActive: false };
        }
    };
    
    sdk._setupUrlChangeMonitoring = function () {
        try {
            let currentUrl = window.location.href;
            const checkUrlChange = () => {
                try {
                    const newUrl = window.location.href;
                    if (newUrl !== currentUrl) {
                        currentUrl = newUrl;
                        sdk._handleUrlChange();
                    }
                } catch (e) {
                    // Silently fail to prevent breaking main site
                }
            };

            // Listen to History API changes (pushState, replaceState)
            try {
                const originalPushState = history.pushState;
                const originalReplaceState = history.replaceState;

                history.pushState = function (...args) {
                    try {
                        originalPushState.apply(this, args);
                    } catch (e) {}
                    checkUrlChange();
                };

                history.replaceState = function (...args) {
                    try {
                        originalReplaceState.apply(this, args);
                    } catch (e) {}
                    checkUrlChange();
                };
            } catch (e) {
                // Silently fail if History API is not available
            }

            // Listen to popstate (back/forward buttons)
            try {
                window.addEventListener('popstate', checkUrlChange);
            } catch (e) {}

            // Listen to hashchange
            try {
                window.addEventListener('hashchange', checkUrlChange);
            } catch (e) {}
            
            // Remove stray step (no overlay) when Vue keep-alive restores cached DOM
            try {
                var strayScheduled = false;
                var strayObs = new MutationObserver(function () {
                    if (sessionStorage.getItem('modalflow_active_flow_id') || strayScheduled) return;
                    strayScheduled = true;
                    requestAnimationFrame(function () { strayScheduled = false; sdk._removeStrayModalFlowDOM(); });
                });
                if (document.body) strayObs.observe(document.body, { childList: true, subtree: true });
                else document.addEventListener('DOMContentLoaded', function () { if (document.body) strayObs.observe(document.body, { childList: true, subtree: true }); });
            } catch (e) {}
        } catch (e) {
            // Silently fail to prevent breaking main site
        }
    };

    sdk._handleUrlChange = async function () {
        try {
            // Check if a flow is currently active and if it still matches URL conditions
            const hasActiveFlow = sdk._isFlowActive();
            let flowWasDismissed = false;
            
            if (hasActiveFlow) {
                // Try to get the active flowId from sessionStorage or overlay data attribute
                let activeFlowId = null;
                try {
                    const overlay = document.getElementById('modalflow-guide-overlay');
                    if (overlay && overlay.dataset.flowId) {
                        activeFlowId = overlay.dataset.flowId;
                    } else {
                        activeFlowId = sessionStorage.getItem('modalflow_active_flow_id');
                    }
                    
                    if (activeFlowId) {
                        // Check URL conditions for this flow
                        const { hasUrlConditions, shouldKeepFlowActive } = sdk._checkUrlConditionsForActiveFlow(activeFlowId);
                        
                        // If flow has URL conditions and doesn't match, dismiss it
                        if (hasUrlConditions && !shouldKeepFlowActive) {
                            sdk._dismissActiveFlow();
                            flowWasDismissed = true;
                        }
                    }
                } catch (e) {
                    // Silently fail to prevent breaking main site
                }
            }
            
            // If flow was dismissed, wait a bit to ensure cleanup is reflected before checking auto-start
            if (flowWasDismissed) {
                try {
                    // Use requestAnimationFrame to ensure DOM updates are complete
                    await new Promise(resolve => requestAnimationFrame(resolve));
                } catch (e) {
                    // Silently fail
                }
            }
            
            // Track processed launcher elements to avoid unnecessary DOM operations
            const processedLauncherElements = new Set();

            // Process launchers from sdk._launchers
            const launcherIds = new Set();
            
            // Collect launcher IDs from sdk._launchers
            if (sdk._launchers) {
                for (const launcherId in sdk._launchers) {
                    launcherIds.add(launcherId);
                }
            }
            
            // Process each launcher sequentially to prevent race conditions
            for (const launcherId of launcherIds) {
                try {
                    // Get launcher data
                    const launcherData = sdk._launchers?.[launcherId];
                    if (!launcherData) {
                        continue;
                    }
                    
                    // Load launcher config
                    const launcherConfig = sdk._loadLauncherConfig(launcherId);
                    if (!launcherConfig) {
                        continue;
                    }
                    
                    const setupConfig = launcherConfig.setup;
                    const appearanceConfig = launcherConfig.appearance;
                    const behaviourConfig = launcherConfig.behaviour;
                    const flowRef = sdk._launcherFlowRefs?.[launcherId] || launcherData.flow_ref || launcherId;
                    const refKey = sdk._findRefKey(flowRef);

                    sdk._launcherSetupConfigs = sdk._launcherSetupConfigs || {};
                    sdk._launcherSetupConfigs[launcherId] = setupConfig;

                    const urlMatches = sdk._checkLauncherUrlMatching(setupConfig);
                    const conditionsPass = sdk._checkOnlyShowLauncherConditions(setupConfig);
                    const shouldShowLauncher = urlMatches && conditionsPass;
                    const { button: buttonLauncher, attached: attachedLauncher } = sdk._getLauncherElementsByLauncherId(launcherId);

                    // Track processed elements
                    if (buttonLauncher) processedLauncherElements.add(buttonLauncher);
                    if (attachedLauncher) processedLauncherElements.add(attachedLauncher);

                    if (shouldShowLauncher) {
                        if (buttonLauncher) {
                            sdk._setLauncherDisplay(buttonLauncher, 'inline-block');
                            // zIndex update only if needed
                            if (setupConfig.zIndex != null && Number.isFinite(parseFloat(setupConfig.zIndex))) {
                                const currentZIndex = buttonLauncher.style.zIndex;
                                const targetZIndex = String(setupConfig.zIndex);
                                if (currentZIndex !== targetZIndex) {
                                    buttonLauncher.style.zIndex = targetZIndex;
                                }
                            }
                        } else if (attachedLauncher) {
                            sdk._setLauncherDisplay(attachedLauncher, 'inline-flex');
                            // zIndex update only if needed
                            if (setupConfig.zIndex != null && Number.isFinite(parseFloat(setupConfig.zIndex))) {
                                const currentZIndex = attachedLauncher.style.zIndex;
                                const targetZIndex = String(setupConfig.zIndex);
                                if (currentZIndex !== targetZIndex) {
                                    attachedLauncher.style.zIndex = targetZIndex;
                                }
                            }
                            sdk._refreshAttachedLauncherPosition(attachedLauncher);
                        } else {
                            const elementConfig = appearanceConfig.launcher_element;

                            if (elementConfig && elementConfig.mode === 'selectElement') {
                                await sdk._attachLauncherToElement(appearanceConfig, behaviourConfig, launcherId, refKey, flowRef);
                            } else if (elementConfig && elementConfig.mode === 'goManual') {
                                await sdk._attachLauncherToElement(appearanceConfig, behaviourConfig, launcherId, refKey, flowRef);
                            } else if (appearanceConfig.type === 'button' || appearanceConfig.type === 'icon' || appearanceConfig.type === 'beacon') {
                                sdk._createButtonLauncher(appearanceConfig, behaviourConfig, launcherId, refKey, flowRef);
                            }
                            const created = sdk._getLauncherElementsByLauncherId(launcherId);
                            if (created.button) processedLauncherElements.add(created.button);
                            if (created.attached) processedLauncherElements.add(created.attached);
                        }
                    } else {
                        try {
                            sdk._removeLauncherElements(launcherId);
                        } catch (_) {
                            try { buttonLauncher && buttonLauncher.remove(); } catch (_) {}
                            try { if (attachedLauncher && attachedLauncher._cleanup) attachedLauncher._cleanup(); } catch (_) {}
                            try { attachedLauncher && attachedLauncher.remove(); } catch (_) {}
                        }
                        
                        if (sdk._isFlowActive()) {
                            try {
                                let activeFlowId = null;
                                const overlay = document.getElementById('modalflow-guide-overlay');
                                if (overlay && overlay.dataset.flowId) {
                                    activeFlowId = overlay.dataset.flowId;
                                } else {
                                    activeFlowId = sessionStorage.getItem('modalflow_active_flow_id');
                                }
                                
                                if (activeFlowId && activeFlowId === flowRef) {
                                    sdk._dismissActiveFlow();
                                }
                            } catch (e) {
                                // Silently fail to prevent breaking main site
                            }
                        }
                    }
                    
                    if (sdk._flows?.[flowRef]) {
                        sdk._updateLauncherVisibilityForFlow(flowRef);
                    }
                } catch (e) {
                    console.error(`[ModalFlow] Error initializing launcher ${launcherId}:`, e);
                }
            }

            try {
                const allLauncherElements = document.querySelectorAll('[id^="modal-flow-launcher"]');
                for (const launcherEl of allLauncherElements) {
                    if (!processedLauncherElements.has(launcherEl)) {
                        try { if (launcherEl._cleanup) launcherEl._cleanup(); } catch (_) {}
                        try { launcherEl.remove(); } catch (_) {}
                    }
                }
            } catch (e) {
                // Silently fail
            }

            const idsForDelayedUpdate = Array.from(launcherIds);
            [300, 900, 1800].forEach(function (delay) {
                setTimeout(function () {
                    idsForDelayedUpdate.forEach(function (launcherId) {
                        var _a = sdk._getLauncherElementsByLauncherId(launcherId), attached = _a.attached;
                        if (attached && typeof attached._updatePosition === 'function' && document.body.contains(attached)) {
                            requestAnimationFrame(() => {
                                if (document.body.contains(attached)) attached._updatePosition(true);
                            });
                        }
                    });
                }, delay);
            });
            
            // Process auto-start flows from sdk._flows
            if (sdk._flows && sdk._autoStartSettings) {
                for (const flowId in sdk._flows) {
                    const flowData = sdk._flows[flowId];
                    if (typeof flowData !== 'object' || flowData === null) {
                        continue;
                    }
                    
                    const autoStartSettings = sdk._autoStartSettings[flowId];
                    if (!autoStartSettings || autoStartSettings.value !== true) {
                        continue;
                    }
                    
                    const refKey = sdk._findRefKey(flowId);

                    const shouldAutoStart = sdk._checkAutoStartConditions(autoStartSettings);
                    const isFlowActive = sdk._isFlowActive();
                    const currentUrl = window.location.href;

                    if (shouldAutoStart) {
                        const wasDismissed = sdk._isAutoStartFlowDismissed(flowId);
                        const lastValidUrl = sdk._getLastValidUrlForFlow(flowId);
                        const navigatedAwayAndBack = lastValidUrl && lastValidUrl !== currentUrl;

                        const frequency = autoStartSettings.frequency || 'once_per_user';
                        let shouldShow = false;

                        if (!isFlowActive && !wasDismissed) {
                            shouldShow = true;
                        } else if (!isFlowActive && wasDismissed && navigatedAwayAndBack && frequency !== 'once_per_user') {
                            const dismissed = sdk._getDismissedAutoStartFlows();
                            const index = dismissed.indexOf(flowId);
                            if (index > -1) dismissed.splice(index, 1);
                            shouldShow = true;
                        }

                        if (shouldShow) {
                            sdk._setLastValidUrlForFlow(flowId, currentUrl);
                            
                            const delay = parseInt(autoStartSettings.period) || 0;
                            const delayMs = autoStartSettings.period_type === 'seconds' ? delay * 1000 : delay * 60000;

                            setTimeout(() => {
                                sdk._executeFlow(flowId, refKey);
                            }, delayMs);
                            
                            break;
                        } else if (shouldAutoStart && !isFlowActive) {
                            sdk._setLastValidUrlForFlow(flowId, currentUrl);
                        }
                    } else {
                        sdk._setLastValidUrlForFlow(flowId, null);
                    }
                }
            }

            if (sdk._flowsMeta && Object.keys(sdk._flowsMeta).length > 0) {
                for (const [flowId, flowMeta] of Object.entries(sdk._flowsMeta)) {
                    try {
                        const flowRef = flowMeta.flow_ref || flowId;
                        const autoStart = flowMeta.settings?.behavior?.autoStart;
                        
                        if (!autoStart || !autoStart.enabled) {
                            continue;
                        }
                        
                        const conditions = autoStart.conditions || [];
                        let shouldBeActive = true;
                        
                        if (conditions.length > 0) {
                            let result = null;
                            for (const condition of conditions) {
                                const conditionType = String(condition.condition_type || 'if').toLowerCase();
                                const passed = sdk._evaluateAutoStartCondition(condition);
                                
                                if (conditionType === 'or') {
                                    result = result === null ? passed : (result || passed);
                                } else {
                                    result = result === null ? passed : (result && passed);
                                }
                            }
                            shouldBeActive = result !== null ? result : true;
                        }
                        
                        const isFlowActive = sdk._isFlowActive();
                        const currentUrl = window.location.href;
                        const frequency = autoStart.frequency || 'once_per_user';
                        
                        if (shouldBeActive) {
                            const wasDismissed = sdk._isAutoStartFlowDismissed(flowRef);


                            let shouldShow = false;
                            if (frequency === 'once_per_user') {
                                let alreadyStarted = false;
                                try { alreadyStarted = localStorage.getItem('modalflow_autostart_' + flowRef) === 'true'; } catch (_) {}
                                shouldShow = !isFlowActive && !alreadyStarted;
                            } else {
                                shouldShow = !isFlowActive && !wasDismissed;
                            }

                            if (shouldShow) {
                                sdk._setLastValidUrlForFlow(flowRef, currentUrl);
                                const refKey = sdk._findRefKey(flowRef) || window.__modalFlowRefKey?.key || flowRef;
                                if (frequency === 'once_per_user') {
                                    try {
                                        localStorage.setItem('modalflow_autostart_' + flowRef, 'true');
                                    } catch (_) {}
                                }
                                await sdk._executeFlow(flowRef, refKey, {});
                                break;
                            } else if (shouldBeActive && !isFlowActive) {
                                sdk._setLastValidUrlForFlow(flowRef, currentUrl);
                            }
                        } else {
                            sdk._setLastValidUrlForFlow(flowRef, null);
                        }
                    } catch (err) {
                    }
                }
            }
            
            if (!sdk._isFlowActive()) sdk._removeStrayModalFlowDOM();
        } catch (e) {
            // Silently fail to prevent breaking main site
        }
    };

    sdk._autoInit = function () {
        const scripts = document.querySelectorAll('script[src*="modal-flowbuilder.js"], script[src*="mf-flowbuilder.js"]');

        for (const script of scripts) {
            const flowId = script.getAttribute('data-flow-id');
            const refKey = script.getAttribute('data-refKey') || script.getAttribute('data-ref-key');
            const autoStart = script.getAttribute('data-auto-start');
            const envKey = script.getAttribute('data-env-key');

            if (refKey) {
                sdk._init(refKey);

                if (envKey) {
                    window.__modalFlowEnvKey = envKey;
                }
                const shouldSkipAutoStart = autoStart !== 'true';
                sdk._initModalFlow(flowId || null, refKey, { skipAutoStart: shouldSkipAutoStart, envKey: envKey });
            }
        }
    };

    sdk.init = function (...args) { return sdk._init.apply(sdk, args); };
    sdk.identify = function (...args) { return sdk._identify.apply(sdk, args); };
    sdk.start = function (...args) { return sdk._start.apply(sdk, args); };
    sdk.initModalFlow = function (...args) { return sdk._initModalFlow.apply(sdk, args); };
    sdk.end = function (...args) { return sdk._end.apply(sdk, args); };

    sdk._onReady = function () {
        try {
            if (!document.getElementById('modalflow-stray-hide-styles')) {
                var st = document.createElement('style');
                st.id = 'modalflow-stray-hide-styles';
                st.textContent = 'body:not(.modalflow-active) > .mf-step-box{visibility:hidden!important;opacity:0!important;pointer-events:none!important;}';
                (document.head || document.documentElement).appendChild(st);
            }
        } catch (e) {}
        sdk._flushQueue();
        sdk._autoInit();
        sdk._setupUrlChangeMonitoring();
    };

    window.modal = sdk;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', sdk._onReady);
    } else {
        setTimeout(sdk._onReady, 0);
    }
})();