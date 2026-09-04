// Utilidades compartidas de WALLEX.
(() => {
  'use strict';

  const wallexStartupSplash = document.getElementById('wallexStartupSplash');
  if (wallexStartupSplash) {
    setTimeout(() => {
      document.documentElement.classList.remove('wallex-splash-active');
      wallexStartupSplash.remove();
    }, 2000);
  }

  // WALLEX always starts offline. Online access is granted only for the
  // current app/page session and is never persisted between launches.
  let networkEnabled = false;

  const activeFetchControllers = new Set();
  const activeXhrs = new Set();
  const activeWebSockets = new Set();
  const activeEventSources = new Set();
  const activeWebTransports = new Set();
  const activeWebSocketStreams = new Set();
  const activePeerConnections = new Set();

  function createNetworkBlockedError() {
    return new DOMException('Network access is disabled by WALLEX offline mode.', 'NetworkError');
  }

  function closeActiveNetworkConnections() {
    activeFetchControllers.forEach(controller => controller.abort(createNetworkBlockedError()));
    activeXhrs.forEach(xhr => {
      try { xhr.abort(); } catch (_) {}
    });
    activeWebSockets.forEach(socket => {
      try { socket.close(1000, 'WALLEX offline mode'); } catch (_) {}
    });
    activeEventSources.forEach(source => {
      try { source.close(); } catch (_) {}
    });
    activeWebTransports.forEach(transport => {
      try { transport.close({ closeCode: 0, reason: 'WALLEX offline mode' }); } catch (_) {}
    });
    activeWebSocketStreams.forEach(stream => {
      try { stream.close?.({ closeCode: 1000, reason: 'WALLEX offline mode' }); } catch (_) {}
    });
    activePeerConnections.forEach(connection => {
      try { connection.close(); } catch (_) {}
    });
    activeFetchControllers.clear();
    activeXhrs.clear();
    activeWebSockets.clear();
    activeEventSources.clear();
    activeWebTransports.clear();
    activeWebSocketStreams.clear();
    activePeerConnections.clear();
    if (navigator.serviceWorker?.getRegistrations) {
      navigator.serviceWorker.getRegistrations().then(registrations => {
        registrations.forEach(registration => registration.unregister());
      }).catch(() => {});
    }
  }

  function isNetworkEnabled() {
    return networkEnabled;
  }

  function isLocalResource(resource) {
    try {
      const rawUrl = resource instanceof Request ? resource.url : String(resource);
      if (/^(?:blob:|data:)/i.test(rawUrl)) return true;
      const url = new URL(rawUrl, document.baseURI);
      if (url.protocol === 'file:') return location.protocol === 'file:';
      const localHost = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
      return localHost && url.origin === location.origin;
    } catch (_) {
      return false;
    }
  }

  function setNetworkEnabled(enabled) {
    networkEnabled = Boolean(enabled);
    try {
      window.WallexNative?.setNetworkEnabled(networkEnabled);
    } catch (_) {
      // The browser version has no native bridge; its JavaScript guard remains active.
    }
    if (!networkEnabled) closeActiveNetworkConnections();
    document.dispatchEvent(new CustomEvent('wallex:network-mode-change', {
      detail: { enabled: networkEnabled }
    }));
  }

  function installNetworkGuard() {
    if (typeof window.fetch === 'function') {
      const nativeFetch = window.fetch.bind(window);
      window.fetch = (input, init = {}) => {
        if (!networkEnabled && !isLocalResource(input)) return Promise.reject(createNetworkBlockedError());
        const controller = new AbortController();
        const requestSignal = init.signal || (input instanceof Request ? input.signal : null);
        if (requestSignal?.aborted) controller.abort(requestSignal.reason);
        else requestSignal?.addEventListener('abort', () => controller.abort(requestSignal.reason), { once: true });
        activeFetchControllers.add(controller);
        return nativeFetch(input, { ...init, signal: controller.signal })
          .finally(() => activeFetchControllers.delete(controller));
      };
    }

    if (typeof window.XMLHttpRequest === 'function') {
      const nativeXhrOpen = XMLHttpRequest.prototype.open;
      const nativeXhrSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function (method, url, ...args) {
        this.__wallexLocalRequest = isLocalResource(url);
        return nativeXhrOpen.call(this, method, url, ...args);
      };
      XMLHttpRequest.prototype.send = function (...args) {
        if (!networkEnabled && !this.__wallexLocalRequest) throw createNetworkBlockedError();
        activeXhrs.add(this);
        this.addEventListener('loadend', () => activeXhrs.delete(this), { once: true });
        return nativeXhrSend.apply(this, args);
      };
    }

    if (typeof window.WebSocket === 'function') {
      const NativeWebSocket = window.WebSocket;
      function GuardedWebSocket(...args) {
        if (!networkEnabled) throw createNetworkBlockedError();
        const socket = Reflect.construct(NativeWebSocket, args, NativeWebSocket);
        activeWebSockets.add(socket);
        socket.addEventListener('close', () => activeWebSockets.delete(socket), { once: true });
        return socket;
      }
      Object.setPrototypeOf(GuardedWebSocket, NativeWebSocket);
      GuardedWebSocket.prototype = NativeWebSocket.prototype;
      window.WebSocket = GuardedWebSocket;
    }

    if (typeof window.EventSource === 'function') {
      const NativeEventSource = window.EventSource;
      function GuardedEventSource(...args) {
        if (!networkEnabled) throw createNetworkBlockedError();
        const source = Reflect.construct(NativeEventSource, args, NativeEventSource);
        activeEventSources.add(source);
        return source;
      }
      Object.setPrototypeOf(GuardedEventSource, NativeEventSource);
      GuardedEventSource.prototype = NativeEventSource.prototype;
      window.EventSource = GuardedEventSource;
    }

    if (typeof navigator.sendBeacon === 'function') {
      const nativeSendBeacon = navigator.sendBeacon.bind(navigator);
      const guardedSendBeacon = (...args) => networkEnabled && nativeSendBeacon(...args);
      try {
        Object.defineProperty(navigator, 'sendBeacon', {
          configurable: true,
          value: guardedSendBeacon
        });
      } catch (_) {
        try {
          Object.defineProperty(Navigator.prototype, 'sendBeacon', {
            configurable: true,
            value: guardedSendBeacon
          });
        } catch (_) {
          // The engine prevents overriding its Beacon implementation.
        }
      }
    }

    if (typeof window.WebTransport === 'function') {
      const NativeWebTransport = window.WebTransport;
      function GuardedWebTransport(...args) {
        if (!networkEnabled) throw createNetworkBlockedError();
        const transport = Reflect.construct(NativeWebTransport, args, NativeWebTransport);
        activeWebTransports.add(transport);
        transport.closed.then(
          () => activeWebTransports.delete(transport),
          () => activeWebTransports.delete(transport)
        );
        return transport;
      }
      Object.setPrototypeOf(GuardedWebTransport, NativeWebTransport);
      GuardedWebTransport.prototype = NativeWebTransport.prototype;
      window.WebTransport = GuardedWebTransport;
    }

    if (typeof window.WebSocketStream === 'function') {
      const NativeWebSocketStream = window.WebSocketStream;
      function GuardedWebSocketStream(...args) {
        if (!networkEnabled) throw createNetworkBlockedError();
        const stream = Reflect.construct(NativeWebSocketStream, args, NativeWebSocketStream);
        activeWebSocketStreams.add(stream);
        stream.closed?.then(
          () => activeWebSocketStreams.delete(stream),
          () => activeWebSocketStreams.delete(stream)
        );
        return stream;
      }
      Object.setPrototypeOf(GuardedWebSocketStream, NativeWebSocketStream);
      GuardedWebSocketStream.prototype = NativeWebSocketStream.prototype;
      window.WebSocketStream = GuardedWebSocketStream;
    }

    if (typeof window.RTCPeerConnection === 'function') {
      const NativePeerConnection = window.RTCPeerConnection;
      function GuardedPeerConnection(...args) {
        if (!networkEnabled) throw createNetworkBlockedError();
        const connection = Reflect.construct(NativePeerConnection, args, NativePeerConnection);
        activePeerConnections.add(connection);
        connection.addEventListener('connectionstatechange', () => {
          if (connection.connectionState === 'closed') activePeerConnections.delete(connection);
        });
        return connection;
      }
      Object.setPrototypeOf(GuardedPeerConnection, NativePeerConnection);
      GuardedPeerConnection.prototype = NativePeerConnection.prototype;
      window.RTCPeerConnection = GuardedPeerConnection;
    }

    if (typeof window.Worker === 'function') {
      const NativeWorker = window.Worker;
      function GuardedWorker(...args) {
        if (!networkEnabled && !isLocalResource(args[0])) throw createNetworkBlockedError();
        const worker = Reflect.construct(NativeWorker, args, NativeWorker);
        return worker;
      }
      Object.setPrototypeOf(GuardedWorker, NativeWorker);
      GuardedWorker.prototype = NativeWorker.prototype;
      window.Worker = GuardedWorker;
    }

    if (typeof window.SharedWorker === 'function') {
      const NativeSharedWorker = window.SharedWorker;
      function GuardedSharedWorker(...args) {
        if (!networkEnabled && !isLocalResource(args[0])) throw createNetworkBlockedError();
        return Reflect.construct(NativeSharedWorker, args, NativeSharedWorker);
      }
      Object.setPrototypeOf(GuardedSharedWorker, NativeSharedWorker);
      GuardedSharedWorker.prototype = NativeSharedWorker.prototype;
      window.SharedWorker = GuardedSharedWorker;
    }

    if (navigator.serviceWorker?.register) {
      const nativeServiceWorkerRegister = navigator.serviceWorker.register.bind(navigator.serviceWorker);
      const guardedServiceWorkerRegister = (...args) => {
        if (!networkEnabled) return Promise.reject(createNetworkBlockedError());
        return nativeServiceWorkerRegister(...args);
      };
      try {
        Object.defineProperty(navigator.serviceWorker, 'register', {
          configurable: true,
          value: guardedServiceWorkerRegister
        });
      } catch (_) {
        try {
          Object.defineProperty(ServiceWorkerContainer.prototype, 'register', {
            configurable: true,
            value: guardedServiceWorkerRegister
          });
        } catch (_) {
          // The engine prevents overriding Service Worker registration.
        }
      }
    }
  }

  installNetworkGuard();

  function clearData(target) {
    if (!target) return;
    if (ArrayBuffer.isView(target) && typeof target.fill === 'function') {
      target.fill(0);
      return;
    }
    if (target instanceof ArrayBuffer) {
      new Uint8Array(target).fill(0);
      return;
    }
    if ('value' in target) {
      target.value = '';
      if ('defaultValue' in target) target.defaultValue = '';
      target.removeAttribute?.('value');
      target._refreshSensitiveMask?.();
    }
  }

  function clearTimer(timers, key) {
    if (!timers.has(key)) return;
    clearTimeout(timers.get(key));
    timers.delete(key);
  }

  function clearTimers(timers) {
    timers.forEach(timer => clearTimeout(timer));
    timers.clear();
  }

  function isSensitiveVisible(element, mode = 'type') {
    if (!element) return false;
    return mode === 'class'
      ? !element.classList.contains('password-masked')
      : element.type === 'text';
  }

  function hideSensitive(element, button, key, timers, mode = 'type') {
    if (!element) return;
    if (mode === 'class') {
      element.classList.add('password-masked');
      if (typeof element.setSelectionRange === 'function') {
        element.setSelectionRange(0, 0);
      }
      if (document.activeElement === element) element.blur();
      window.getSelection?.()?.removeAllRanges();
    } else {
      element.type = 'password';
    }
    element._refreshSensitiveMask?.();
    button?.classList.remove('active');
    clearTimer(timers, key);
  }

  function toggleSensitive(element, button, key, timers, mode = 'type', timeout = 30000) {
    if (isSensitiveVisible(element, mode)) {
      hideSensitive(element, button, key, timers, mode);
      return;
    }
    if (mode === 'class') element.classList.remove('password-masked');
    else element.type = 'text';
    element._refreshSensitiveMask?.();
    button?.classList.add('active');
    clearTimer(timers, key);
    timers.set(key, setTimeout(() => hideSensitive(element, button, key, timers, mode), timeout));
  }

  function scheduleSensitiveHide(element, button, key, timers, mode = 'type', timeout = 30000) {
    clearTimer(timers, key);
    timers.set(key, setTimeout(() => hideSensitive(element, button, key, timers, mode), timeout));
  }

  function restartClassAnimation(element, className) {
    if (!element) return;
    element.classList.remove(className);
    void element.offsetWidth;
    element.classList.add(className);
  }

  function showFieldFeedback(element, stateClass) {
    if (!element) return;
    const companionButton = element.parentElement?.querySelector('button');
    const shakeTarget = companionButton ? element.parentElement : element;
    element.classList.remove('field-error', 'field-invalid', 'field-valid', 'shake');
    companionButton?.classList.remove('shake');
    shakeTarget?.classList.remove('shake');
    void element.offsetWidth;
    if (shakeTarget && shakeTarget !== element) void shakeTarget.offsetWidth;
    element.classList.add(stateClass);
    shakeTarget?.classList.add('shake');
    if (typeof element.setSelectionRange === 'function') {
      const caretPosition = element.value?.length ?? 0;
      try {
        element.setSelectionRange(caretPosition, caretPosition);
      } catch (_) {
        // Algunos tipos de input admiten foco, pero no selección de texto.
      }
    }
  }

  function showFieldError(element) {
    showFieldFeedback(element, 'field-error');
  }

  function showFieldInvalid(element) {
    showFieldFeedback(element, 'field-invalid');
  }

  function clearFieldFeedback(element) {
    if (!element) return;
    const companionButton = element.parentElement?.querySelector('button');
    element.classList.remove('field-error', 'field-invalid', 'field-valid', 'field-success', 'entropy-generated', 'shake');
    element.parentElement?.classList.remove('shake');
    companionButton?.classList.remove('shake');
  }

  function showFieldValid(element) {
    if (!element) return;
    clearFieldFeedback(element);
    void element.offsetWidth;
    element.classList.add('field-valid');
    if (typeof element.setSelectionRange === 'function') {
      const caretPosition = element.value?.length ?? 0;
      try { element.setSelectionRange(caretPosition, caretPosition); } catch (_) {}
    }
  }

  function blinkWhite(element) {
    restartClassAnimation(element, 'blink-white');
  }

  function shakeOnly(element) {
    restartClassAnimation(element, 'shake');
  }

  function isEditableTarget(target) {
    return target instanceof HTMLElement && (
      target.isContentEditable ||
      target.matches('input, textarea, select')
    );
  }

  function protectApplicationNavigation() {
    document.addEventListener('keydown', event => {
      if (event.key === 'Tab') document.documentElement.classList.add('keyboard-navigation');
      if (event.key === 'F12') return;

      const key = event.key.toLowerCase();
      const reloadShortcut = event.key === 'F5' || ((event.ctrlKey || event.metaKey) && key === 'r');
      const historyShortcut = event.key === 'BrowserBack' || event.key === 'BrowserForward' ||
        (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight'));
      const looseBackspace = event.key === 'Backspace' && !isEditableTarget(event.target);

      if (reloadShortcut || historyShortcut || looseBackspace) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }, true);

    const disableKeyboardFocus = () => document.documentElement.classList.remove('keyboard-navigation');
    document.addEventListener('pointerdown', disableKeyboardFocus, true);
    document.addEventListener('touchstart', disableKeyboardFocus, { capture: true, passive: true });

    document.addEventListener('pointerdown', event => {
      const target = event.target;
      if (!(target instanceof Node)) return;

      const activeField = document.activeElement;
      if ((activeField instanceof HTMLInputElement || activeField instanceof HTMLTextAreaElement) && activeField !== target) {
        const selectionEnd = activeField.selectionEnd;
        if (typeof selectionEnd === 'number' && selectionEnd > (activeField.selectionStart ?? selectionEnd)) {
          try { activeField.setSelectionRange(selectionEnd, selectionEnd, 'none'); } catch (_) {}
        }
      }

      const selection = window.getSelection?.();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
      const selectionContainer = selection.getRangeAt(0).commonAncestorContainer;
      const selectionElement = selectionContainer instanceof Element
        ? selectionContainer
        : selectionContainer.parentElement;
      if (!selectionElement?.contains(target)) selection.removeAllRanges();
    }, true);

    let touchStartY = 0;
    document.addEventListener('touchstart', event => {
      if (event.touches.length === 1) touchStartY = event.touches[0].clientY;
    }, { passive: true });

    document.addEventListener('touchmove', event => {
      if (event.touches.length !== 1) return;
      const pullingDown = event.touches[0].clientY > touchStartY;
      const scrollContainer = event.target instanceof Element
        ? event.target.closest('.overlay-panel, [data-scroll-container]')
        : null;
      const containerCanMoveUp = scrollContainer && scrollContainer.scrollTop > 0;

      if (pullingDown && window.scrollY <= 0 && !containerCanMoveUp) {
        event.preventDefault();
      }
    }, { passive: false });
  }

  protectApplicationNavigation();

  window.WallexCommon = Object.freeze({
    isNetworkEnabled,
    setNetworkEnabled,
    clearData,
    clearTimer,
    clearTimers,
    isSensitiveVisible,
    hideSensitive,
    toggleSensitive,
    scheduleSensitiveHide,
    restartClassAnimation,
    showFieldError,
    showFieldInvalid,
    clearFieldFeedback,
    showFieldValid,
    blinkWhite,
    shakeOnly
  });
})();

/* === CREATE PANEL === */
// Interfaz WALLEX: estructura, inicialización, eventos y efectos.
(() => {
'use strict';

const KDF_DEFAULTS = {
  scrypt: { n: 16384, r: 8, p: 1 },
  pbkdf2: { prf: 'hmac-sha-512', iterations: 220000 }
};
const createTimers = new Map();
const common = window.WallexCommon;
const csprng = window.WallexCSPRNG;
const kdf = window.WallexKdf;
const bip39 = window.WallexBip39;
const bip32 = window.WallexBip32;
const bip85 = window.WallexBip85;
const bip38 = window.WallexBip38;
const secp256k1 = window.WallexSecp256k1;
const btc = window.WallexBtc;
const eth = window.WallexEth;
const trx = window.WallexTrx;
const clearData = common.clearData;
const showFieldError = common.showFieldError;
const sensitiveMode = element => element instanceof HTMLTextAreaElement ? 'class' : 'type';
const isPasswordVisible = element => element?.hasAttribute('data-adaptive-secret')
  ? element instanceof HTMLTextAreaElement
  : common.isSensitiveVisible(element, sensitiveMode(element));
const hidePassword = (element, button, key) => element?.hasAttribute('data-adaptive-secret')
  ? hideAdaptiveSecret(element, button, key)
  : (common.hideSensitive(element, button, key, createTimers, sensitiveMode(element)), element);
const togglePasswordVisibility = (element, button, key) => element?.hasAttribute('data-adaptive-secret')
  ? toggleAdaptiveSecret(element, button, key)
  : (common.toggleSensitive(element, button, key, createTimers, sensitiveMode(element)), element);
const clearAllTimers = () => common.clearTimers(createTimers);
const isAnyPasswordVisible = elements => elements.some(isPasswordVisible);
const hideAllPasswords = items => {
  items.forEach(({ element, button, key }) => hidePassword(element, button, key));
  deactivateGlobalSecretReveal();
};
function getIterationsForPrf(prf) {
  return prf === 'hmac-sha-256' ? 600000 : KDF_DEFAULTS.pbkdf2.iterations;
}

const WALLEX_VERSION = 'V26.09.02.2345';
const createPanelMount = document.getElementById('createPanelMount');
if (!createPanelMount) throw new Error('createPanelMount not found');
createPanelMount.innerHTML = `
<div class="overlay" id="createOverlay" aria-hidden="true">
        <div class="panel-stack">
            <header class="wallex-main-bar connection-offline" id="statusBar" aria-label="WALLEX session status">
                <span class="wallex-main-logo" id="textLogo" draggable="false">
                    <span class="wallex-main-wallet-label">WALLET DERIVATION TOOL</span>
                    <span class="wallex-main-connection-line">
                        <span class="wallex-main-connection-indicator" id="connectionIndicator" aria-hidden="true"></span>
                        <span class="wallex-main-connection-status" id="statusMode" aria-live="polite">OFFLINE MODE</span>
                    </span>
                </span>
                <div class="wallex-main-actions" id="iconsContainer">
                    <button type="button" class="wallex-main-action wallex-main-menu" id="connectionControl" aria-label="Toggle WALLEX online or offline mode" aria-pressed="false">
                        <span aria-hidden="true"><svg class="wallex-network-icon" id="connectionControlSVG" viewBox="0 0 24 24"><g class="wallex-menu-inactive-icon"><circle cx="12" cy="12" r="10"></circle><path d="M4.22 19.78 19.78 4.22"></path></g><g class="wallex-menu-active-icon"><circle cx="12" cy="12" r="11"></circle></g></svg></span>
                    </button>
                    <button type="button" class="wallex-main-action wallex-main-expert" id="advancedMode" aria-label="Toggle advanced mode" aria-pressed="false"><span aria-hidden="true"><svg class="wallex-toolbar-icon" id="expertModeSVG" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18"></rect><path d="M12 6.5V17.5M6.5 12H17.5"></path></svg></span></button>
                    <button type="button" class="wallex-main-action wallex-main-reveal" id="revealAllSecrets" aria-label="Reveal all secrets" aria-pressed="false"><span aria-hidden="true"><svg class="wallex-toolbar-icon" id="revealAllSecretsSVG" viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg></span></button>
                    <button type="button" class="wallex-main-action wallex-main-nav" id="navMenu" aria-label="Navigation menu" aria-expanded="false"><span aria-hidden="true"><svg class="wallex-toolbar-icon" id="navMenuSVG" viewBox="0 0 24 24"><g class="wallex-nav-menu-icon"><path d="M3 6H21M3 12H21M3 18H21"></path></g><g class="wallex-nav-close-icon"><path d="M5 5L19 19M19 5L5 19"></path></g></svg></span></button>
                </div>
            </header>
            <div class="overlay-panel" id="derivationPanel" role="dialog" aria-modal="true" aria-label="WALLEX" tabindex="-1">
                <div class="panel-row">
                    <div class="panel-group">
                        <label class="panel-label" for="modeSelect">MODE</label>
                        <select class="panel-select" id="modeSelect">
                            <option value="deterministic" selected>DETERMINISTIC</option>
                            <option value="random">RANDOM</option>
                        </select>
                    </div>
                    <div class="panel-group">
                        <label class="panel-label" for="lengthSelect">LENGTH</label>
                        <select class="panel-select" id="lengthSelect">
                            <option value="12" selected>12 WORDS</option>
                            <option value="15">15 WORDS</option>
                            <option value="18">18 WORDS</option>
                            <option value="21">21 WORDS</option>
                            <option value="24">24 WORDS</option>
                        </select>
                    </div>
                </div>

                <!-- PRIMARY SECRET -->
                <div class="primary-secret-wrapper" id="primarySecretWrapper">
                    <div class="primary-secret-field">
                        <div class="primary-secret-input-wrapper">
                            <label for="primarySecretInput" class="sr-only">Primary Secret</label>
                            <input type="password"
                                   class="primary-secret-input password-masked"
                                   id="primarySecretInput"
                                   placeholder="Enter Primary Secret"
                                   autocomplete="new-password"
                                   autocorrect="off"
                                   spellcheck="false"
                                   autofill="off">
                            <button type="button" class="show-primary-secret-btn" id="showPrimarySecretBtn" aria-label="Show primary secret">
                                <svg class="eye-icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                                    <circle cx="12" cy="12" r="3" />
                                </svg>
                            </button>
                        </div>
                    </div>
                    <div class="primary-secret-field">
                        <div class="primary-secret-input-wrapper">
                            <label for="confirmPrimarySecretInput" class="sr-only">Confirm Primary Secret</label>
                            <input type="password"
                                   class="primary-secret-input password-masked"
                                   id="confirmPrimarySecretInput"
                                   placeholder="Confirm Primary Secret"
                                   autocomplete="new-password"
                                   autocorrect="off"
                                   spellcheck="false"
                                   autofill="off">
                            <button type="button" class="show-primary-secret-btn" id="showConfirmPrimarySecretBtn" aria-label="Show confirmed primary secret">
                                <svg class="eye-icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                                    <circle cx="12" cy="12" r="3" />
                                </svg>
                            </button>
                        </div>
                    </div>
                </div>

                <!-- ADDITIONAL SECRET -->
                <div class="additional-secret-wrapper" id="additionalSecretWrapper">
                    <div class="additional-secret-field">
                        <div class="additional-secret-input-wrapper">
                            <label for="additionalSecretInput" class="sr-only">Additional Secret</label>
                            <input type="password"
                                   class="additional-secret-input password-masked"
                                   id="additionalSecretInput"
                                   placeholder="Enter Additional Secret (optional)"
                                   autocomplete="new-password"
                                   autocorrect="off"
                                   spellcheck="false"
                                   autofill="off">
                            <button type="button" class="show-additional-secret-btn" id="showAdditionalSecretBtn" aria-label="Show additional secret">
                                <svg class="eye-icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                                    <circle cx="12" cy="12" r="3" />
                                </svg>
                            </button>
                        </div>
                    </div>
                    <div class="additional-secret-field">
                        <div class="additional-secret-input-wrapper">
                            <label for="confirmAdditionalSecretInput" class="sr-only">Confirm Additional Secret</label>
                            <input type="password"
                                   class="additional-secret-input password-masked"
                                   id="confirmAdditionalSecretInput"
                                   placeholder="Confirm Additional Secret"
                                   autocomplete="new-password"
                                   autocorrect="off"
                                   spellcheck="false"
                                   autofill="off">
                            <button type="button" class="show-additional-secret-btn" id="showConfirmAdditionalSecretBtn" aria-label="Show confirmed additional secret">
                                <svg class="eye-icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                                    <circle cx="12" cy="12" r="3" />
                                </svg>
                            </button>
                        </div>
                    </div>
                </div>

                <!-- KDF CONTAINER (dinámico) -->
                <div id="kdfContainer"></div>

                <button type="button" class="panel-create-btn" id="deriveBtn">DERIVE</button>
            </div>
            <section class="overlay-panel entropy-panel lower-panel expert-only hidden" id="bip39Panel" aria-labelledby="entropyLabel">
                <label class="panel-label expert-only hidden" id="entropyLabel" for="entropy">BIP39 ENTROPY</label>
                <div class="primary-secret-input-wrapper expert-only hidden">
                    <input type="password"
                           class="primary-secret-input entropy-input password-masked"
                           id="entropy"
                           data-adaptive-secret="entropy"
                           readonly
                           autocomplete="off"
                           autocorrect="off"
                           spellcheck="false"
                           autofill="off">
                    <button type="button" class="show-primary-secret-btn show-entropy-btn" id="showEntropyBtn" aria-label="Show BIP39 entropy">
                        <svg class="eye-icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                            <circle cx="12" cy="12" r="3" />
                        </svg>
                    </button>
                </div>
                <label class="panel-label expert-only hidden" for="mnemonic">BIP39 MNEMONIC</label>
                <div class="primary-secret-input-wrapper expert-only hidden">
                    <input type="password"
                           class="primary-secret-input entropy-input password-masked"
                           id="mnemonic"
                           data-adaptive-secret="mnemonic"
                           readonly
                           autocomplete="off"
                           autocorrect="off"
                           spellcheck="false"
                           autofill="off">
                    <button type="button" class="show-primary-secret-btn show-entropy-btn" id="showMnemonicBtn" aria-label="Show BIP39 mnemonic">
                        <svg class="eye-icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                            <circle cx="12" cy="12" r="3" />
                        </svg>
                    </button>
                </div>
                <div class="panel-checkbox expert-only hidden">
                    <input type="checkbox" id="bip39Passphrase" class="panel-checkbox-input">
                    <label for="bip39Passphrase" class="panel-checkbox-label">BIP39 PASSPHRASE</label>
                </div>
                <div class="passphrase-subpanel expert-only hidden" id="passphraseSubpanel">
                    <div class="additional-secret-input-wrapper">
                        <label for="passphrase" class="sr-only">BIP39 Passphrase</label>
                        <input type="password"
                               class="additional-secret-input password-masked"
                               id="passphrase"
                               placeholder="Enter BIP39 Passphrase"
                               autocomplete="new-password"
                               autocorrect="off"
                               spellcheck="false"
                               autofill="off">
                        <button type="button" class="show-additional-secret-btn" id="showBip39PassphraseBtn" aria-label="Show BIP39 passphrase">
                            <svg class="eye-icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                                <circle cx="12" cy="12" r="3" />
                            </svg>
                        </button>
                    </div>
                    <div class="additional-secret-input-wrapper">
                        <label for="confirmPassphrase" class="sr-only">Confirm BIP39 Passphrase</label>
                        <input type="password"
                               class="additional-secret-input password-masked"
                               id="confirmPassphrase"
                               placeholder="Confirm BIP39 Passphrase"
                               autocomplete="new-password"
                               autocorrect="off"
                               spellcheck="false"
                               autofill="off">
                        <button type="button" class="show-additional-secret-btn" id="showConfirmPassphraseBtn" aria-label="Show BIP39 passphrase confirmation">
                            <svg class="eye-icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                                <circle cx="12" cy="12" r="3" />
                            </svg>
                        </button>
                    </div>
                </div>
                <label class="panel-label expert-only hidden" for="seed">BIP39 SEED</label>
                <div class="primary-secret-input-wrapper expert-only hidden">
                    <input type="password"
                           class="primary-secret-input entropy-input password-masked"
                           id="seed"
                           data-adaptive-secret="seed"
                           readonly
                           autocomplete="off"
                           autocorrect="off"
                           spellcheck="false"
                           autofill="off">
                    <button type="button" class="show-primary-secret-btn show-entropy-btn" id="showSeedBtn" aria-label="Show BIP39 seed">
                        <svg class="eye-icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                            <circle cx="12" cy="12" r="3" />
                        </svg>
                    </button>
                </div>
            </section>
            <section class="overlay-panel entropy-panel lower-panel expert-only hidden" id="bip32Panel" aria-label="BIP32 keys">
                <label class="panel-label" for="rootprv">BIP32 ROOT KEY · XPRV</label>
                <div class="primary-secret-input-wrapper">
                    <input type="password"
                           class="primary-secret-input entropy-input password-masked"
                           id="rootprv"
                           data-adaptive-secret="rootprv"
                           readonly
                           autocomplete="off"
                           autocorrect="off"
                           spellcheck="false"
                           autofill="off">
                    <button type="button" class="show-primary-secret-btn show-entropy-btn" id="showRootprvBtn" aria-label="Show BIP32 root private key">
                        <svg class="eye-icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                            <circle cx="12" cy="12" r="3" />
                        </svg>
                    </button>
                </div>
                <label class="panel-label" for="rootpub">BIP32 ROOT KEY · XPUB</label>
                <div class="primary-secret-input-wrapper">
                    <textarea class="primary-secret-input entropy-input expanding-entropy-input"
                              id="rootpub"
                              rows="1"
                              readonly
                              autocomplete="off"
                              autocorrect="off"
                              spellcheck="false"
                              autofill="off"></textarea>
                </div>
                <div class="panel-checkbox">
                    <input type="checkbox" id="bip85" class="panel-checkbox-input">
                    <label for="bip85" class="panel-checkbox-label">BIP85 DERIVATION</label>
                </div>
                <div class="bip85-fields" id="bip85Subpanel">
                    <div class="bip85-options">
                        <div class="kdf-field-group bip85-derivation-group">
                            <label for="bip85application" class="kdf-label">BIP85 APPLICATION</label>
                            <select class="kdf-select" id="bip85application">
                                <option value="hexadecimal-entropy">HEXADECIMAL ENTROPY</option>
                                <option value="bip39-mnemonic" selected>BIP39 MNEMONIC</option>
                                <option value="bip32-xprv">BIP32 ROOT KEY · XPRV</option>
                                <option value="private-key-wif">PRIVATE KEY · WIF</option>
                            </select>
                        </div>
                        <div class="kdf-field-group bip85-length-group">
                            <label for="bip85length" class="kdf-label">LENGTH</label>
                            <select class="kdf-select" id="bip85length">
                                <option value="12">12</option>
                                <option value="21">21</option>
                                <option value="24">24</option>
                            </select>
                        </div>
                        <div class="kdf-field-group bip85-length-group bip85-bits-group" id="bip85bitsGroup">
                            <label for="bip85bits" class="kdf-label">BITS</label>
                            <select class="kdf-select" id="bip85bits">
                                <option value="128">128</option>
                                <option value="160">160</option>
                                <option value="192">192</option>
                                <option value="224">224</option>
                                <option value="256">256</option>
                                <option value="512">512</option>
                            </select>
                        </div>
                        <div class="kdf-field-group bip85-index-group">
                            <label for="bip85index" class="kdf-label">INDEX</label>
                            <input class="kdf-input" id="bip85index" type="text" inputmode="numeric" value="0" autocomplete="off">
                        </div>
                    </div>
                    <label class="panel-label" for="bip85derived">DERIVED</label>
                    <div class="primary-secret-input-wrapper">
                        <input type="password"
                               class="primary-secret-input entropy-input password-masked"
                               id="bip85derived"
                               data-adaptive-secret="bip85derived"
                               readonly
                               autocomplete="off"
                               autocorrect="off"
                               spellcheck="false"
                               autofill="off">
                        <button type="button" class="show-primary-secret-btn show-entropy-btn" id="showBip85DerivedBtn" aria-label="Show BIP85 derived value">
                            <svg class="eye-icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                                <circle cx="12" cy="12" r="3" />
                            </svg>
                        </button>
                    </div>
                </div>
            </section>
            <section class="overlay-panel wallet-selection-panel lower-panel" id="derivationPathPanel" aria-label="Coin and address type selection">
                <div class="panel-row basic-wallet-selection" id="walletPrimaryFields">
                    <div class="panel-group coin-group">
                        <label class="panel-label" for="coinSelect">COIN</label>
                        <select class="panel-select" id="coinSelect">
                            <option value="btc" selected>BTC</option>
                            <option value="eth">ETH / EVM</option>
                            <option value="trx">TRX</option>
                        </select>
                    </div>
                    <div class="panel-group standard-group expert-only hidden">
                        <label class="panel-label" for="standardSelect">STANDARD</label>
                        <select class="panel-select" id="standardSelect"></select>
                    </div>
                    <div class="panel-group address-type-group">
                        <label class="panel-label" id="addressFormatLabel" for="addressFormat">ADDRESS FORMAT</label>
                        <select class="panel-select" id="addressFormat"></select>
                    </div>
                    <div class="panel-group address-index-group">
                        <label class="panel-label" for="addressIndex">INDEX</label>
                        <input class="kdf-input address-index-input" id="addressIndex" type="text" inputmode="text" value="0" autocomplete="off" autocapitalize="none" spellcheck="false">
                    </div>
                </div>
                <div class="panel-row hidden" id="advancedFields">
                    <div class="panel-group">
                        <label class="panel-label" for="derivationPath">DERIVATION PATH</label>
                        <input type="text"
                               class="main-derivation-path-input"
                               id="derivationPath"
                               value="m"
                               placeholder="Enter Derivation Path"
                               readonly
                               autocomplete="off"
                               autocorrect="off"
                               autocapitalize="off"
                               spellcheck="false">
                    </div>
                    <div class="panel-group change-group">
                        <label class="panel-label" for="change">CHANGE</label>
                        <select class="panel-select" id="change">
                            <option value="0" selected>0</option>
                            <option value="1">1</option>
                        </select>
                    </div>
                </div>
                <div class="panel-checkbox hardened-index-control expert-only hidden">
                    <label for="hardenedIndex" class="panel-checkbox-label">HARDENED INDEX</label>
                    <input type="checkbox" id="hardenedIndex" class="panel-checkbox-input">
                </div>
                <div class="account-key-subpanel expert-only hidden" id="account">
                    <label class="panel-label" for="accountprv">ACCOUNT · XPRV</label>
                    <div class="primary-secret-input-wrapper">
                        <input type="password"
                               class="primary-secret-input entropy-input password-masked"
                               id="accountprv"
                               data-adaptive-secret="accountprv"
                               readonly
                               autocomplete="off"
                               autocorrect="off"
                               spellcheck="false"
                               autofill="off">
                        <button type="button" class="show-primary-secret-btn show-entropy-btn" id="showAccountprvBtn" aria-label="Show account private key">
                            <svg class="eye-icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                                <circle cx="12" cy="12" r="3" />
                            </svg>
                        </button>
                    </div>
                    <label class="panel-label" for="accountpub">ACCOUNT · XPUB</label>
                    <div class="primary-secret-input-wrapper">
                        <textarea class="primary-secret-input entropy-input expanding-entropy-input"
                                  id="accountpub"
                                  rows="1"
                                  readonly
                                  autocomplete="off"
                                  autocorrect="off"
                                  spellcheck="false"
                                  autofill="off"></textarea>
                    </div>
                </div>
                <div class="derived-key-fields expert-only hidden">
                    <label class="panel-label" for="derivedprv">DERIVED · XPRV</label>
                    <div class="primary-secret-input-wrapper">
                        <input type="password"
                               class="primary-secret-input entropy-input password-masked"
                               id="derivedprv"
                               data-adaptive-secret="derivedprv"
                               readonly
                               autocomplete="off"
                               autocorrect="off"
                               spellcheck="false"
                               autofill="off">
                        <button type="button" class="show-primary-secret-btn show-entropy-btn" id="showDerivedprvBtn" aria-label="Show derived private key">
                            <svg class="eye-icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                                <circle cx="12" cy="12" r="3" />
                            </svg>
                        </button>
                    </div>
                    <label class="panel-label" for="derivedpub">DERIVED · XPUB</label>
                    <div class="primary-secret-input-wrapper">
                        <textarea class="primary-secret-input entropy-input expanding-entropy-input"
                                  id="derivedpub"
                                  rows="1"
                                  readonly
                                  autocomplete="off"
                                  autocorrect="off"
                                  spellcheck="false"
                                  autofill="off"></textarea>
                    </div>
                </div>
            </section>
            <section class="overlay-panel entropy-panel lower-panel" id="derivedAddressPanel" aria-label="Private key">
                <div class="private-key-result-header expert-only hidden">
                    <label class="panel-label" for="privateKey">PRIVATE KEY</label>
                    <div class="private-key-result-options expert-only hidden" id="privateKeyResultOptions" aria-label="Bitcoin Legacy key format">
                        <label class="private-key-result-option" for="privateKeyHex">
                            <span>HEX</span>
                            <input class="panel-checkbox-input private-key-result-checkbox" type="checkbox" id="privateKeyHex">
                        </label>
                        <label class="private-key-result-option" for="privateKeyCompressed">
                            <span>C</span>
                            <input class="private-key-result-radio" type="radio" id="privateKeyCompressed" name="privateKeyCompression" value="compressed" checked>
                        </label>
                        <label class="private-key-result-option" for="privateKeyUncompressed">
                            <span>U</span>
                            <input class="private-key-result-radio" type="radio" id="privateKeyUncompressed" name="privateKeyCompression" value="uncompressed">
                        </label>
                    </div>
                </div>
                <div class="primary-secret-input-wrapper expert-only hidden">
                    <input type="password"
                           class="primary-secret-input entropy-input password-masked"
                           id="privateKey"
                           data-adaptive-secret="private-key"
                           readonly
                           autocomplete="off"
                           autocorrect="off"
                           spellcheck="false"
                           autofill="off">
                    <button type="button" class="show-primary-secret-btn show-entropy-btn" id="showPrivateKeyBtn" aria-label="Show private key">
                        <svg class="eye-icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                            <circle cx="12" cy="12" r="3" />
                        </svg>
                    </button>
                </div>
                <div class="derivation-path-bip38 expert-only hidden">
                    <div class="panel-checkbox">
                        <input type="checkbox" id="bip38Encryption" class="panel-checkbox-input">
                        <label for="bip38Encryption" class="panel-checkbox-label">BIP38 ENCRYPTION</label>
                    </div>
                    <div class="bip38-fields" id="bip38Subpanel">
                        <div class="primary-secret-input-wrapper bip38-passphrase-wrapper">
                            <label for="bip38Passphrase" class="sr-only">BIP38 Passphrase</label>
                            <input class="bip38-passphrase-input password-masked" id="bip38Passphrase" type="password" placeholder="Enter BIP38 Passphrase" autocomplete="new-password" autocorrect="off" spellcheck="false">
                            <button type="button" class="show-primary-secret-btn" id="showBip38PassphraseBtn" aria-label="Show BIP38 passphrase">
                                <svg class="eye-icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                                    <circle cx="12" cy="12" r="3" />
                                </svg>
                            </button>
                        </div>
                        <div class="primary-secret-input-wrapper bip38-passphrase-wrapper">
                            <label for="confirmBip38Passphrase" class="sr-only">Confirm BIP38 Passphrase</label>
                            <input class="bip38-passphrase-input password-masked" id="confirmBip38Passphrase" type="password" placeholder="Confirm BIP38 Passphrase" autocomplete="new-password" autocorrect="off" spellcheck="false">
                            <button type="button" class="show-primary-secret-btn" id="showConfirmBip38PassphraseBtn" aria-label="Show BIP38 passphrase confirmation">
                                <svg class="eye-icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                                    <circle cx="12" cy="12" r="3" />
                                </svg>
                            </button>
                        </div>
                        <button type="button" class="panel-create-btn bip38-encrypt-btn" id="encrypt">ENCRYPT</button>
                        <div class="bip38-key-result">
                            <div class="private-key-result-header">
                                <label class="panel-label" for="bip38key">BIP38 ENCRYPTED PRIVATE KEY</label>
                                <div class="private-key-result-options expert-only hidden" id="bip38KeyResultOptions" aria-label="BIP38 key compression">
                                    <label class="private-key-result-option" for="bip38KeyCompressed">
                                        <span>C</span>
                                        <input class="private-key-result-radio" type="radio" id="bip38KeyCompressed" name="bip38KeyCompression" value="compressed" checked>
                                    </label>
                                    <label class="private-key-result-option" for="bip38KeyUncompressed">
                                        <span>U</span>
                                        <input class="private-key-result-radio" type="radio" id="bip38KeyUncompressed" name="bip38KeyCompression" value="uncompressed">
                                    </label>
                                </div>
                            </div>
                            <div class="primary-secret-input-wrapper">
                                <input type="password"
                                       class="primary-secret-input entropy-input password-masked"
                                       id="bip38key"
                                       data-adaptive-secret="bip38-key"
                                       readonly
                                       autocomplete="off"
                                       autocorrect="off"
                                       spellcheck="false"
                                       autofill="off">
                                <button type="button" class="show-primary-secret-btn show-entropy-btn" id="showBip38KeyBtn" aria-label="Show BIP38 encrypted key">
                                    <svg class="eye-icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                                        <circle cx="12" cy="12" r="3" />
                                    </svg>
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
                <div class="private-key-result-header">
                    <label class="panel-label" for="publicKey">PUBLIC KEY</label>
                    <div class="private-key-result-options expert-only hidden" id="publicKeyResultOptions" aria-label="Ethereum and Tron public key format">
                        <label class="private-key-result-option" for="publicKeyCompressed">
                            <span>C</span>
                            <input class="private-key-result-radio" type="radio" id="publicKeyCompressed" name="publicKeyCompression" value="compressed" checked>
                        </label>
                        <label class="private-key-result-option" for="publicKeyUncompressed">
                            <span>U</span>
                            <input class="private-key-result-radio" type="radio" id="publicKeyUncompressed" name="publicKeyCompression" value="uncompressed">
                        </label>
                    </div>
                </div>
                <div class="primary-secret-input-wrapper">
                    <textarea class="primary-secret-input entropy-input expanding-entropy-input"
                              id="publicKey"
                              rows="1"
                              readonly
                              autocomplete="off"
                              autocorrect="off"
                              spellcheck="false"
                              autofill="off"></textarea>
                </div>
                <label class="panel-label" for="address">ADDRESS</label>
                <div class="primary-secret-input-wrapper">
                    <textarea class="primary-secret-input entropy-input expanding-entropy-input"
                              id="address"
                              rows="1"
                              readonly
                              autocomplete="off"
                              autocorrect="off"
                              spellcheck="false"
                              autofill="off"></textarea>
                </div>
                <div class="panel-checkbox address-details-control expert-only hidden">
                    <input type="checkbox" id="addressDetails" class="panel-checkbox-input">
                    <label for="addressDetails" class="panel-checkbox-label">ADDRESS DETAILS</label>
                </div>
                <div class="address-details-subpanel" id="addressDetailsSubpanel">
                    <span>COIN: <span id="addressDetailsCoinValue"></span></span>
                    <span>NETWORK: <span id="addressDetailsNetworkValue"></span></span>
                    <span>FORMAT TYPE: <span id="addressDetailsAddressFormatValue"></span></span>
                    <span>OUTPUT TYPE: <span id="addressDetailsOutputTypeValue"></span></span>
                    <span>ELLIPTIC CURVE: <span id="addressDetailsCurveValue"></span></span>
                    <span>HASH TYPE: <span id="addressDetailsHashTypeValue"></span></span>
                    <span>ENCODING: <span id="addressDetailsEncodingValue"></span></span>
                    <span>PREFIX: <span id="addressDetailsPrefixValue"></span></span>
                    <span>DERIVATION STANDARD: <span id="addressDetailsStandardValue"></span></span>
                    <span>DERIVATION PATH: <span id="addressDetailsPathValue"></span></span>
                </div>
            </section>
        </div>
        <div class="navigation-drawer-layer" id="navigationDrawerLayer" aria-hidden="true">
            <div class="navigation-drawer-backdrop" id="navigationDrawerBackdrop"></div>
            <div class="navigation-drawer-track">
                <aside class="navigation-drawer-panel" aria-label="Navigation menu">
                    <button type="button" class="navigation-drawer-clear-data" id="clearDataBtn"><span class="navigation-drawer-clear-data-content"><svg class="navigation-drawer-clear-data-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18"></rect><path d="M7 7L17 17M17 7L7 17"></path></svg><span class="navigation-drawer-clear-data-label">CLEAR DATA</span></span></button>
                    <button type="button" class="navigation-drawer-clear-data navigation-drawer-clear-data-exit" id="clearDataExitBtn"><span class="navigation-drawer-clear-data-content"><svg class="navigation-drawer-clear-data-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2V12"></path><path d="M6.35 5.65a8 8 0 1 0 11.3 0"></path></svg><span class="navigation-drawer-clear-data-label">CLEAR DATA AND EXIT</span></span></button>
                    <div class="navigation-drawer-identity">
                        <span class="navigation-drawer-name">WALLEX</span>
                        <span class="navigation-drawer-motto"></span>
                        <span class="navigation-drawer-version">${WALLEX_VERSION}</span>
                    </div>
                </aside>
            </div>
        </div>
        </div>
`;

const createOverlay = document.getElementById('createOverlay');
const wallexMainBar = document.getElementById('statusBar');
const wallexMainConnectionIndicator = document.getElementById('connectionIndicator');
const wallexMainStatusMode = document.getElementById('statusMode');
const wallexMainExpertBtn = document.getElementById('advancedMode');
const wallexMainRevealBtn = document.getElementById('revealAllSecrets');
const wallexMainMenuBtn = document.getElementById('connectionControl');
const wallexMainNavBtn = document.getElementById('navMenu');
const navigationDrawerLayer = document.getElementById('navigationDrawerLayer');
const navigationDrawerBackdrop = document.getElementById('navigationDrawerBackdrop');
const navigationDrawerName = document.querySelector('.navigation-drawer-name');
const navigationDrawerMotto = document.querySelector('.navigation-drawer-motto');
let wallexTransientStatusTimer = null;
let wallexTransientStatusActive = false;
const clearDataCompletionStorageKey = 'wallexClearDataComplete';
const mainAdvancedFields = document.getElementById('advancedFields');
const walletPrimaryFields = document.getElementById('walletPrimaryFields');
const mainCoinSelect = document.getElementById('coinSelect');
const hardenedIndexCheck = document.getElementById('hardenedIndex');
const mainAddressTypeSelect = document.getElementById('addressFormat');
const mainAddressFormatLabel = document.getElementById('addressFormatLabel');
const mainAddressIndexInput = document.getElementById('addressIndex');
const mainAddressIndexGroup = mainAddressIndexInput.closest('.address-index-group');
const mainStandardSelect = document.getElementById('standardSelect');
const mainStandardGroup = mainStandardSelect.closest('.standard-group');
const mainDerivationPath = document.getElementById('derivationPath');
const mainChangeSelect = document.getElementById('change');
const bip38EncryptionCheck = document.getElementById('bip38Encryption');
const bip38Subpanel = document.getElementById('bip38Subpanel');
const bip38PassphraseInput = document.getElementById('bip38Passphrase');
const showBip38PassphraseBtn = document.getElementById('showBip38PassphraseBtn');
const confirmBip38PassphraseInput = document.getElementById('confirmBip38Passphrase');
const showConfirmBip38PassphraseBtn = document.getElementById('showConfirmBip38PassphraseBtn');
const bip38KeyResultOptions = document.getElementById('bip38KeyResultOptions');
const bip38KeyCompressedRadio = document.getElementById('bip38KeyCompressed');
const bip38KeyUncompressedRadio = document.getElementById('bip38KeyUncompressed');
let bip38KeyInput = document.getElementById('bip38key');
const showBip38KeyBtn = document.getElementById('showBip38KeyBtn');
const encryptBtn = document.getElementById('encrypt');
const clearDataBtn = document.getElementById('clearDataBtn');
const clearDataExitBtn = document.getElementById('clearDataExitBtn');
const addressDetailsCheck = document.getElementById('addressDetails');
const addressDetailsSubpanel = document.getElementById('addressDetailsSubpanel');
const addressDetailsValueElements = {
  coin: document.getElementById('addressDetailsCoinValue'),
  network: document.getElementById('addressDetailsNetworkValue'),
  outputType: document.getElementById('addressDetailsOutputTypeValue'),
  addressFormat: document.getElementById('addressDetailsAddressFormatValue'),
  curve: document.getElementById('addressDetailsCurveValue'),
  hashType: document.getElementById('addressDetailsHashTypeValue'),
  encoding: document.getElementById('addressDetailsEncodingValue'),
  prefix: document.getElementById('addressDetailsPrefixValue'),
  standard: document.getElementById('addressDetailsStandardValue'),
  path: document.getElementById('addressDetailsPathValue')
};
const expertOnlyComponents = document.querySelectorAll('#createOverlay .expert-only');

const clearDataConfirmOverlay = document.createElement('div');
clearDataConfirmOverlay.className = 'clear-data-confirm-overlay';
clearDataConfirmOverlay.setAttribute('aria-hidden', 'true');
clearDataConfirmOverlay.innerHTML = `
  <div class="clear-data-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="clearDataConfirmTitle" aria-describedby="clearDataConfirmMessage clearDataLimitations">
    <div class="clear-data-confirm-title" id="clearDataConfirmTitle">CLEAR DATA</div>
    <p class="clear-data-confirm-message" id="clearDataConfirmMessage"><strong><span aria-hidden="true">⚠</span> NOTICE:</strong> This will erase all secrets, entropy, mnemonic, seed, derived keys and addresses; clear temporary state and the clipboard when permitted; reset every setting; and reload the APP.</p>
    <p class="clear-data-confirm-message" id="clearDataLimitations"><strong><span aria-hidden="true">⚠</span> DISCLAIMER:</strong> WALLEX deletes the data under its control but cannot guarantee forensic erasure of memory or records managed by the browser and operating system. For verifiable deletion, use specialized tools.</p>
    <div class="clear-data-confirm-actions">
      <button type="button" class="panel-create-btn clear-data-cancel-btn">CANCEL</button>
      <button type="button" class="panel-create-btn clear-data-accept-btn">ACCEPT</button>
    </div>
  </div>
`;
createOverlay.appendChild(clearDataConfirmOverlay);
const clearDataCancelBtn = clearDataConfirmOverlay.querySelector('.clear-data-cancel-btn');
const clearDataAcceptBtn = clearDataConfirmOverlay.querySelector('.clear-data-accept-btn');
['copy', 'cut', 'dragstart', 'selectstart'].forEach(type => {
  clearDataConfirmOverlay.addEventListener(type, event => event.preventDefault());
});

const clearDataExitConfirmOverlay = document.createElement('div');
clearDataExitConfirmOverlay.className = 'clear-data-confirm-overlay';
clearDataExitConfirmOverlay.setAttribute('aria-hidden', 'true');
clearDataExitConfirmOverlay.innerHTML = `
  <div class="clear-data-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="clearDataExitConfirmTitle" aria-describedby="clearDataExitConfirmMessage clearDataExitLimitations">
    <div class="clear-data-confirm-title" id="clearDataExitConfirmTitle">CLEAR DATA</div>
    <p class="clear-data-confirm-message" id="clearDataExitConfirmMessage"><strong><span aria-hidden="true">⚠</span> NOTICE:</strong> This will erase all secrets, entropy, mnemonic, seed, derived keys and addresses; clear temporary state and the clipboard when permitted; reset every setting; and reload the APP.</p>
    <p class="clear-data-confirm-message" id="clearDataExitLimitations"><strong><span aria-hidden="true">⚠</span> DISCLAIMER:</strong> WALLEX deletes the data under its control but cannot guarantee forensic erasure of memory or records managed by the browser and operating system. For verifiable deletion, use specialized tools.</p>
    <div class="clear-data-confirm-actions">
      <button type="button" class="panel-create-btn clear-data-cancel-btn">CANCEL</button>
      <button type="button" class="panel-create-btn clear-data-accept-btn">ACCEPT</button>
    </div>
  </div>
`;
createOverlay.appendChild(clearDataExitConfirmOverlay);
const clearDataExitCancelBtn = clearDataExitConfirmOverlay.querySelector('.clear-data-cancel-btn');
const clearDataExitAcceptBtn = clearDataExitConfirmOverlay.querySelector('.clear-data-accept-btn');
['copy', 'cut', 'dragstart', 'selectstart'].forEach(type => {
  clearDataExitConfirmOverlay.addEventListener(type, event => event.preventDefault());
});

const sensitiveCopyConfirmOverlay = document.createElement('div');
sensitiveCopyConfirmOverlay.className = 'clear-data-confirm-overlay sensitive-copy-confirm-overlay';
sensitiveCopyConfirmOverlay.setAttribute('aria-hidden', 'true');
sensitiveCopyConfirmOverlay.innerHTML = `
  <div class="clear-data-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="sensitiveCopyConfirmTitle" aria-describedby="sensitiveCopyConfirmMessage sensitiveCopyDisclaimer">
    <div class="clear-data-confirm-title" id="sensitiveCopyConfirmTitle">COPY SENSITIVE DATA</div>
    <p class="clear-data-confirm-message" id="sensitiveCopyConfirmMessage"><strong><span aria-hidden="true">⚠</span> NOTICE:</strong> Copying sensitive data to the clipboard may expose it and compromise its security. Entering secrets manually is recommended. If copying is necessary, clear the clipboard immediately after use. Then run CLEAR DATA as an additional security measure.</p>
    <p class="clear-data-confirm-message" id="sensitiveCopyDisclaimer"><strong><span aria-hidden="true">⚠</span> DISCLAIMER:</strong> By accepting, the user assumes full responsibility for the use, handling, and protection of the sensitive data.</p>
    <div class="clear-data-confirm-actions">
      <button type="button" class="panel-create-btn clear-data-cancel-btn sensitive-copy-cancel-btn">CANCEL</button>
      <button type="button" class="panel-create-btn sensitive-copy-accept-btn">ACCEPT</button>
    </div>
  </div>
`;
createOverlay.appendChild(sensitiveCopyConfirmOverlay);
const sensitiveCopyCancelBtn = sensitiveCopyConfirmOverlay.querySelector('.sensitive-copy-cancel-btn');
const sensitiveCopyAcceptBtn = sensitiveCopyConfirmOverlay.querySelector('.sensitive-copy-accept-btn');
['copy', 'cut', 'dragstart', 'selectstart'].forEach(type => {
  sensitiveCopyConfirmOverlay.addEventListener(type, event => event.preventDefault());
});

const mainDerivationPaths = {
  'bip32-root': 'm',
  bip32: "m/0'/0'",
  bip44: "m/44'/0'/0'/0",
  bip49: "m/49'/0'/0'/0",
  bip84: "m/84'/0'/0'/0",
  bip86: "m/86'/0'/0'/0"
};
const mainBasicAddressTypes = {
  btc: [
    ['legacy', 'BIP44 · LEGACY'],
    ['nested-segwit', 'BIP49 · NESTED SEGWIT'],
    ['native-segwit', 'BIP84 · NATIVE SEGWIT'],
    ['taproot', 'BIP86 · TAPROOT']
  ],
  eth: [['standard', 'BIP44 · STANDARD']],
  trx: [['standard', 'BIP44 · STANDARD']]
};
const mainAdvancedAddressTypes = {
  btc: [
    ['legacy', 'LEGACY · P2PKH'],
    ['nested-segwit', 'NESTED SEGWIT · P2SH-P2WPKH'],
    ['native-segwit', 'NATIVE SEGWIT · P2WPKH'],
    ['taproot', 'TAPROOT · P2TR']
  ],
  eth: [['standard', 'STANDARD · EOA']],
  trx: [['standard', 'STANDARD · EOA']]
};
const mainStandardByAddressType = {
  root: 'bip32-root',
  'legacy-direct': 'bip32',
  direct: 'bip32',
  legacy: 'bip44',
  standard: 'bip44',
  'nested-segwit': 'bip49',
  'native-segwit': 'bip84',
  taproot: 'bip86'
};
const mainStandardsByCoin = {
  btc: [['bip32', 'BIP32'], ['bip44', 'BIP44'], ['bip49', 'BIP49'], ['bip84', 'BIP84'], ['bip86', 'BIP86'], ['custom', 'CUSTOM']],
  eth: [['bip32', 'BIP32'], ['bip44', 'BIP44'], ['custom', 'CUSTOM']],
  trx: [['bip32', 'BIP32'], ['bip44', 'BIP44'], ['custom', 'CUSTOM']]
};
const mainExtendedKeyVersions = {
  x: { private: 0x0488ade4, public: 0x0488b21e, privatePrefix: 'XPRV', publicPrefix: 'XPUB' },
  y: { private: 0x049d7878, public: 0x049d7cb2, privatePrefix: 'YPRV', publicPrefix: 'YPUB' },
  z: { private: 0x04b2430c, public: 0x04b24746, privatePrefix: 'ZPRV', publicPrefix: 'ZPUB' }
};

function getMainExtendedKeyVersions() {
  if (mainCoinSelect.value !== 'btc') return mainExtendedKeyVersions.x;
  if (mainAddressTypeSelect.value === 'nested-segwit') return mainExtendedKeyVersions.y;
  if (mainAddressTypeSelect.value === 'native-segwit') return mainExtendedKeyVersions.z;
  return mainExtendedKeyVersions.x;
}

function customPathHasAccountSemantics() {
  if (mainStandardSelect.value !== 'custom') return false;
  const path = mainDerivationPath.value.trim().toLowerCase();
  const patterns = {
    btc: /^m\/(?:44|49|84|86)(?:'|h)\/0(?:'|h)\/0(?:'|h)\/(?:0|1)\/(?:0|[1-9]\d*)(?:'|h)?$/,
    eth: /^m\/44(?:'|h)\/60(?:'|h)\/0(?:'|h)\/0\/(?:0|[1-9]\d*)(?:'|h)?$/,
    trx: /^m\/44(?:'|h)\/195(?:'|h)\/0(?:'|h)\/0\/(?:0|[1-9]\d*)(?:'|h)?$/
  };
  return patterns[mainCoinSelect.value]?.test(path) === true;
}

function updateMainExtendedKeyLabels(versions = getMainExtendedKeyVersions()) {
  const usesAccountLabel = ['bip44', 'bip49', 'bip84', 'bip86'].includes(mainStandardSelect.value)
    || customPathHasAccountSemantics();
  const nodeLabel = usesAccountLabel ? 'ACCOUNT' : 'PARENT NODE';
  rootPrvLabel.textContent = `BIP32 ROOT KEY · ${versions.privatePrefix}`;
  rootPubLabel.textContent = `BIP32 ROOT KEY · ${versions.publicPrefix}`;
  accountPrvLabel.textContent = `${nodeLabel} · ${versions.privatePrefix}`;
  accountPubLabel.textContent = `${nodeLabel} · ${versions.publicPrefix}`;
  derivedPrvLabel.textContent = `DERIVED · ${versions.privatePrefix}`;
  derivedPubLabel.textContent = `DERIVED · ${versions.publicPrefix}`;
  updateMainAddressDetails();
}

function updateMainAddressDetails() {
  const standard = mainStandardSelect.value.toUpperCase();
  const shared = {
    curve: 'secp256k1',
    standard,
    path: mainDerivationPath.value
  };
  let details;

  if (mainCoinSelect.value === 'btc') {
    const formatDetails = {
      legacy: {
        outputType: 'P2PKH',
        addressFormat: 'Legacy',
        hashType: 'HASH160',
        encoding: 'Base58Check',
        prefix: '1...'
      },
      'nested-segwit': {
        outputType: 'P2SH-P2WPKH',
        addressFormat: 'Nested SegWit',
        hashType: 'HASH160',
        encoding: 'Base58Check',
        prefix: '3...'
      },
      'native-segwit': {
        outputType: 'P2WPKH',
        addressFormat: 'Native SegWit',
        hashType: 'HASH160',
        encoding: 'Bech32',
        prefix: 'bc1q...'
      },
      taproot: {
        outputType: 'P2TR',
        addressFormat: 'Taproot',
        hashType: 'TAGGED SHA-256',
        encoding: 'Bech32m',
        prefix: 'bc1p...'
      }
    }[mainAddressTypeSelect.value];
    details = {
      coin: 'BTC - Bitcoin',
      network: 'Mainnet',
      ...formatDetails,
      ...shared
    };
  } else if (mainCoinSelect.value === 'eth') {
    details = {
      coin: 'ETH - Ethereum / EVM',
      network: 'Network-independent',
      outputType: 'EOA',
      addressFormat: 'Standard',
      hashType: 'KECCAK-256',
      encoding: 'HEX · EIP-55',
      prefix: '0x...',
      ...shared
    };
  } else {
    details = {
      coin: 'TRX - Tron',
      network: 'Mainnet',
      outputType: 'EOA',
      addressFormat: 'Standard',
      hashType: 'KECCAK-256 / SHA-256D',
      encoding: 'Base58Check',
      prefix: 'T...',
      ...shared
    };
  }

  Object.entries(addressDetailsValueElements).forEach(([key, element]) => {
    element.textContent = details[key] ?? '';
  });
}

function getMainAddressTypeForStandard(standard) {
  if (standard === 'bip32-root') return 'root';
  if (standard === 'bip32') return mainCoinSelect.value === 'btc' ? 'legacy' : 'standard';
  if (standard === 'bip44') return mainCoinSelect.value === 'btc' ? 'legacy' : 'standard';
  if (standard === 'bip49') return 'nested-segwit';
  if (standard === 'bip84') return 'native-segwit';
  if (standard === 'bip86') return 'taproot';
  return null;
}

const isValidCompleteDerivationPath = value => /^m(?:\/(?:0|[1-9]\d*)['hH]?)*$/.test(value);
const isValidPartialDerivationPath = value => /^m(?:\/(?:(?:0|[1-9]\d*)['hH]?|['hH]?))*$/.test(value);
let mainAddressIndex = '0';
let mainBaseDerivationPath = 'm';
let lastValidDerivationPath = mainDerivationPath.value;
let lastValidDerivationSelectionStart = mainDerivationPath.value.length;
let lastValidDerivationSelectionEnd = mainDerivationPath.value.length;
let derivationPathFocusValue = mainDerivationPath.value;

function rememberValidDerivationPath() {
  if (!isValidCompleteDerivationPath(mainDerivationPath.value)) return;
  lastValidDerivationPath = mainDerivationPath.value;
  lastValidDerivationSelectionStart = mainDerivationPath.selectionStart ?? mainDerivationPath.value.length;
  lastValidDerivationSelectionEnd = mainDerivationPath.selectionEnd ?? lastValidDerivationSelectionStart;
}

function getMainDisplayedIndex() {
  return `${mainAddressIndex}${hardenedIndexCheck.checked ? "'" : ''}`;
}

function setMainDerivationPathFromBase(basePath) {
  mainBaseDerivationPath = basePath.replace(/\/$/, '');
  mainDerivationPath.value = `${mainBaseDerivationPath}/${getMainDisplayedIndex()}`;
  rememberValidDerivationPath();
}

function getMainBaseDerivationPath() {
  if (mainStandardSelect.value !== 'custom') return mainBaseDerivationPath;
  const fullPath = mainDerivationPath.value.trim().replace(/\/$/, '');
  const separatorIndex = fullPath.lastIndexOf('/');
  return separatorIndex > 0 ? fullPath.slice(0, separatorIndex) : 'm';
}

function syncMainDerivationPathFromIndex() {
  const basePath = getMainBaseDerivationPath();
  if (!basePath) return;
  setMainDerivationPathFromBase(basePath);
}

function syncMainIndexFromCustomPath() {
  if (mainStandardSelect.value !== 'custom') return;
  const match = mainDerivationPath.value.match(/\/(0|[1-9]\d*)(['hH]?)$/);
  if (!match) return;
  const nextIndex = Number(match[1]);
  if (!Number.isSafeInteger(nextIndex) || nextIndex >= 0x80000000) return;
  mainBaseDerivationPath = mainDerivationPath.value.slice(0, mainDerivationPath.value.lastIndexOf('/'));
  mainAddressIndex = match[1];
  hardenedIndexCheck.checked = match[2] !== '';
  mainAddressIndexInput.value = `${mainAddressIndex}${match[2]}`;
  rememberValidAddressIndex();
}

function updateMainDerivationPath() {
  const isCustom = mainStandardSelect.value === 'custom';
  const changeEnabled = mainCoinSelect.value === 'btc' && !isCustom && mainStandardSelect.value !== 'bip32';
  mainChangeSelect.disabled = !changeEnabled;
  syncCustomSelect(mainChangeSelect);
  mainDerivationPath.readOnly = !isCustom;
  mainDerivationPath.disabled = !isCustom;
  mainAddressIndexInput.disabled = isCustom;
  mainAddressTypeSelect.disabled = isCustom;
  if (isCustom) {
    rememberValidDerivationPath();
    return;
  }
  const change = changeEnabled ? mainChangeSelect.value : '0';
  if (mainStandardSelect.value === 'bip44') {
    const bip44CoinTypes = { btc: 0, eth: 60, trx: 195 };
    setMainDerivationPathFromBase(`m/44'/${bip44CoinTypes[mainCoinSelect.value]}'/0'/${change}`);
    return;
  }
  const path = mainDerivationPaths[mainStandardSelect.value] || '';
  const basePath = mainCoinSelect.value === 'btc'
    ? path.replace(/\/\d+$/, `/${change}`)
    : path;
  setMainDerivationPathFromBase(basePath);
}

function syncMainStandardFromAddressType() {
  const standard = mainStandardByAddressType[mainAddressTypeSelect.value];
  if (!standard) return;
  mainStandardSelect.value = standard;
  updateMainDerivationPath();
}

function syncMainAddressTypeFromStandard() {
  const addressType = getMainAddressTypeForStandard(mainStandardSelect.value);
  if (!addressType || !mainAddressTypeSelect.querySelector(`option[value="${addressType}"]`)) return false;
  mainAddressTypeSelect.value = addressType;
  return true;
}

function detectBtcAddressTypeFromDerivationPath(path) {
  const normalizedPath = path.trim().toLowerCase().replace(/\s+/g, '');
  const match = normalizedPath.match(/^m\/(44|49|84|86)(?:'|h)\/0(?:'|h)(?:\/|$)/);
  if (!match) return null;
  return {
    44: 'legacy',
    49: 'nested-segwit',
    84: 'native-segwit',
    86: 'taproot'
  }[match[1]] || null;
}

function syncMainAddressTypeFromCustomPath() {
  if (mainCoinSelect.value !== 'btc') {
    mainAddressTypeSelect.value = 'standard';
    syncCustomSelect(mainAddressTypeSelect);
    return;
  }
  if (mainStandardSelect.value !== 'custom') return;
  const detectedAddressType = detectBtcAddressTypeFromDerivationPath(mainDerivationPath.value);
  if (!detectedAddressType || !mainAddressTypeSelect.querySelector(`option[value="${detectedAddressType}"]`)) return;
  mainAddressTypeSelect.value = detectedAddressType;
  syncCustomSelect(mainAddressTypeSelect);
}

function updateMainAddressTypes(expertMode) {
  const addressTypes = expertMode ? mainAdvancedAddressTypes : mainBasicAddressTypes;
  mainAddressTypeSelect.replaceChildren(
    ...addressTypes[mainCoinSelect.value].map(([value, label]) => new Option(label, value))
  );
}

function updateMainStandards(expertMode) {
  const currentStandard = mainStandardSelect.value;
  const standards = mainStandardsByCoin[mainCoinSelect.value]
    .filter(([value]) => expertMode || !['bip32', 'custom'].includes(value));
  mainStandardSelect.replaceChildren(
    ...standards.map(([value, label]) => new Option(label, value))
  );
  mainStandardSelect.value = mainStandardSelect.querySelector(`option[value="${currentStandard}"]`)
    ? currentStandard
    : 'bip44';
  updateMainDerivationPath();
}

function applyWalletSelectionExpertMode(active) {
  mainAdvancedFields.classList.toggle('hidden', !active);
  walletPrimaryFields.classList.toggle('basic-wallet-selection', !active);
  if (active) {
    mainAdvancedFields.prepend(mainStandardGroup);
  } else {
    walletPrimaryFields.insertBefore(mainStandardGroup, mainAddressTypeSelect.closest('.address-type-group'));
  }
  (active ? mainAdvancedFields : walletPrimaryFields).appendChild(mainAddressIndexGroup);
  expertOnlyComponents.forEach(component => component.classList.toggle('hidden', !active));
  mainAddressFormatLabel.textContent = 'ADDRESS FORMAT';
  if (!active) {
    hidePassword(bip38PassphraseInput, showBip38PassphraseBtn, 'bip38-passphrase');
    addressDetailsCheck.checked = false;
    addressDetailsSubpanel.classList.remove('visible', 'mounted');
  }
  updateMainStandards(active);
  updateMainAddressTypes(active);
  if (!syncMainAddressTypeFromStandard()) syncMainStandardFromAddressType();
  updatePrivateKeyResultOptionsVisibility();
  if (active) {
    resizeSensitiveTextarea(accountpubInput);
    resizeSensitiveTextarea(derivedpubInput);
  }
  if (isGlobalSecretRevealActive()) {
    sensitiveFields.forEach(({ element, button, key }) => revealSensitiveField(element, button, key));
  }
}

function getDerivationPathAfterInsertion(insertedText) {
  const start = mainDerivationPath.selectionStart ?? mainDerivationPath.value.length;
  const end = mainDerivationPath.selectionEnd ?? start;
  return mainDerivationPath.value.slice(0, start) + insertedText + mainDerivationPath.value.slice(end);
}

mainDerivationPath.addEventListener('beforeinput', event => {
  if (mainStandardSelect.value !== 'custom' || event.inputType.startsWith('delete')) return;
  if (event.data === null) return;
  if (!isValidPartialDerivationPath(getDerivationPathAfterInsertion(event.data))) event.preventDefault();
});

mainDerivationPath.addEventListener('paste', event => {
  if (mainStandardSelect.value !== 'custom') return;
  const pastedText = event.clipboardData?.getData('text') ?? '';
  if (!isValidPartialDerivationPath(getDerivationPathAfterInsertion(pastedText))) event.preventDefault();
});

mainDerivationPath.addEventListener('drop', event => {
  if (mainStandardSelect.value !== 'custom') return;
  const droppedText = event.dataTransfer?.getData('text') ?? '';
  if (!isValidPartialDerivationPath(getDerivationPathAfterInsertion(droppedText))) event.preventDefault();
});

mainDerivationPath.addEventListener('keydown', event => {
  if (mainStandardSelect.value !== 'custom' || event.key !== 'Backspace') return;
  const start = mainDerivationPath.selectionStart ?? 0;
  const end = mainDerivationPath.selectionEnd ?? start;
  const deletedText = start === end
    ? mainDerivationPath.value.slice(Math.max(0, start - 1), start)
    : mainDerivationPath.value.slice(start, end);
  if (deletedText.includes('/') || deletedText.includes('m')) event.preventDefault();
});

mainDerivationPath.addEventListener('focus', () => {
  if (mainStandardSelect.value !== 'custom') return;
  if (isValidCompleteDerivationPath(mainDerivationPath.value)) {
    derivationPathFocusValue = mainDerivationPath.value;
  }
});

mainDerivationPath.addEventListener('input', () => {
  if (mainStandardSelect.value !== 'custom') return;
  if (isValidPartialDerivationPath(mainDerivationPath.value)) {
    if (isValidCompleteDerivationPath(mainDerivationPath.value)) {
      syncMainIndexFromCustomPath();
      rememberValidDerivationPath();
    }
    return;
  }
  mainDerivationPath.value = lastValidDerivationPath;
  if (document.activeElement === mainDerivationPath) {
    mainDerivationPath.setSelectionRange(lastValidDerivationSelectionStart, lastValidDerivationSelectionEnd);
  }
});

mainDerivationPath.addEventListener('blur', () => {
  if (mainStandardSelect.value !== 'custom' || isValidCompleteDerivationPath(mainDerivationPath.value)) return;
  mainDerivationPath.value = derivationPathFocusValue;
  syncMainIndexFromCustomPath();
  syncMainAddressTypeFromCustomPath();
  updateMainExtendedKeyLabels();
  rememberValidDerivationPath();
  refreshDisplayedWalletDerivation();
});

mainStandardSelect.addEventListener('change', () => {
  updateMainDerivationPath();
  syncMainAddressTypeFromStandard();
});
mainChangeSelect.addEventListener('change', updateMainDerivationPath);
mainAddressTypeSelect.addEventListener('change', syncMainStandardFromAddressType);
mainDerivationPath.addEventListener('input', () => {
  syncMainAddressTypeFromCustomPath();
  updateMainExtendedKeyLabels();
});
mainCoinSelect.addEventListener('change', () => {
  const expertMode = wallexMainExpertBtn.getAttribute('aria-pressed') === 'true';
  updateMainStandards(expertMode);
  updateMainAddressTypes(expertMode);
  if (expertMode) {
    if (!syncMainAddressTypeFromStandard()) syncMainStandardFromAddressType();
  } else {
    syncMainStandardFromAddressType();
  }
});

updateMainAddressTypes(false);
updateMainStandards(false);
syncMainStandardFromAddressType();

function updateWallexMainBar() {
  const networkEnabled = common.isNetworkEnabled();
  wallexMainBar.classList.toggle('connection-online', networkEnabled);
  wallexMainBar.classList.toggle('connection-offline', !networkEnabled);
  wallexMainConnectionIndicator.classList.toggle('online', networkEnabled);
  wallexMainStatusMode.classList.toggle('online', networkEnabled);
  wallexMainMenuBtn.classList.toggle('active', networkEnabled);
  wallexMainMenuBtn.setAttribute('aria-pressed', String(networkEnabled));
  if (!wallexTransientStatusActive) {
    wallexMainConnectionIndicator.classList.remove('hidden');
    wallexMainStatusMode.textContent = networkEnabled ? 'ONLINE MODE' : 'OFFLINE MODE';
  }
}

wallexMainExpertBtn.addEventListener('click', () => {
  const active = wallexMainExpertBtn.getAttribute('aria-pressed') !== 'true';
  wallexMainExpertBtn.setAttribute('aria-pressed', String(active));
  wallexMainExpertBtn.classList.toggle('active', active);
  applyWalletSelectionExpertMode(active);
  updateMainExtendedKeyLabels();
  if (active) {
    requestAnimationFrame(() => {
      [entropyInput, mnemonicInput, seedInput, rootprvInput, rootpubInput, accountpubInput]
        .forEach(resizeSensitiveTextarea);
    });
  }
});
wallexMainMenuBtn.addEventListener('click', () => {
  common.setNetworkEnabled(!common.isNetworkEnabled());
  updateWallexMainBar();
});
function updateNavigationDrawerTop() {
  const edgeSpacing = Number.parseFloat(
    getComputedStyle(createOverlay).getPropertyValue('--app-edge-spacing')
  ) || 10;
  const barBottom = wallexMainBar.getBoundingClientRect().bottom;
  createOverlay.style.setProperty('--navigation-drawer-top', `${barBottom + edgeSpacing}px`);
}

function updateNavigationDrawerIdentityWidths() {
  [
    [navigationDrawerName, '--navigation-drawer-name-width'],
    [navigationDrawerMotto, '--navigation-drawer-motto-width']
  ].forEach(([element, property]) => {
    element.style.transform = 'scaleX(1)';
    const currentWidth = element.getBoundingClientRect().width;
    const targetWidth = Number.parseFloat(getComputedStyle(element).getPropertyValue(property));
    if (currentWidth > 0 && Number.isFinite(targetWidth)) {
      element.style.transform = `scaleX(${targetWidth / currentWidth})`;
    }
  });
}

requestAnimationFrame(() => {
  updateNavigationDrawerTop();
  updateNavigationDrawerIdentityWidths();
});
document.fonts?.ready.then(updateNavigationDrawerIdentityWidths);

function setNavigationDrawerOpen(active) {
  if (active) {
    updateNavigationDrawerTop();
    updateNavigationDrawerIdentityWidths();
    hideAllPasswords(sensitiveFields);
  }
  wallexMainNavBtn.setAttribute('aria-expanded', String(active));
  wallexMainNavBtn.setAttribute('aria-label', active ? 'Close navigation menu' : 'Navigation menu');
  wallexMainNavBtn.classList.toggle('active', active);
  navigationDrawerLayer.classList.toggle('visible', active);
  navigationDrawerLayer.setAttribute('aria-hidden', String(!active));
  createOverlay.classList.toggle('navigation-drawer-open', active);
}
wallexMainNavBtn.addEventListener('click', () => {
  const active = wallexMainNavBtn.getAttribute('aria-expanded') !== 'true';
  setNavigationDrawerOpen(active);
});
navigationDrawerBackdrop.addEventListener('click', () => setNavigationDrawerOpen(false));
window.addEventListener('resize', () => {
  requestAnimationFrame(() => {
    updateNavigationDrawerTop();
    updateNavigationDrawerIdentityWidths();
  });
});
window.addEventListener('online', updateWallexMainBar);
window.addEventListener('offline', updateWallexMainBar);
document.addEventListener('wallex:network-mode-change', updateWallexMainBar);
updateWallexMainBar();
const deriveBtn = document.getElementById('deriveBtn');

const modeSelect = document.getElementById('modeSelect');
const lengthSelect = document.getElementById('lengthSelect');
const primarySecretInput = document.getElementById('primarySecretInput');
const confirmPrimarySecretInput = document.getElementById('confirmPrimarySecretInput');
const primarySecretWrapper = document.getElementById('primarySecretWrapper');
const showPrimarySecretBtn = document.getElementById('showPrimarySecretBtn');
const showConfirmPrimarySecretBtn = document.getElementById('showConfirmPrimarySecretBtn');
const additionalSecretInput = document.getElementById('additionalSecretInput');
const confirmAdditionalSecretInput = document.getElementById('confirmAdditionalSecretInput');
const additionalSecretWrapper = document.getElementById('additionalSecretWrapper');
const showAdditionalSecretBtn = document.getElementById('showAdditionalSecretBtn');
const showConfirmAdditionalSecretBtn = document.getElementById('showConfirmAdditionalSecretBtn');
let entropyInput = document.getElementById('entropy');
const showEntropyBtn = document.getElementById('showEntropyBtn');
let mnemonicInput = document.getElementById('mnemonic');
const showMnemonicBtn = document.getElementById('showMnemonicBtn');
const bip39PassphraseCheck = document.getElementById('bip39Passphrase');
const passphraseSubpanel = document.getElementById('passphraseSubpanel');
const bip39PassphraseInput = document.getElementById('passphrase');
const showBip39PassphraseBtn = document.getElementById('showBip39PassphraseBtn');
const confirmPassphraseInput = document.getElementById('confirmPassphrase');
const showConfirmPassphraseBtn = document.getElementById('showConfirmPassphraseBtn');
let seedInput = document.getElementById('seed');
const showSeedBtn = document.getElementById('showSeedBtn');
let rootprvInput = document.getElementById('rootprv');
const showRootprvBtn = document.getElementById('showRootprvBtn');
const rootpubInput = document.getElementById('rootpub');
let accountprvInput = document.getElementById('accountprv');
const showAccountprvBtn = document.getElementById('showAccountprvBtn');
const accountpubInput = document.getElementById('accountpub');
let derivedprvInput = document.getElementById('derivedprv');
const showDerivedprvBtn = document.getElementById('showDerivedprvBtn');
const derivedpubInput = document.getElementById('derivedpub');
const rootPrvLabel = document.querySelector('label[for="rootprv"]');
const rootPubLabel = document.querySelector('label[for="rootpub"]');
const accountPrvLabel = document.querySelector('label[for="accountprv"]');
const accountPubLabel = document.querySelector('label[for="accountpub"]');
const derivedPrvLabel = document.querySelector('label[for="derivedprv"]');
const derivedPubLabel = document.querySelector('label[for="derivedpub"]');
const bip85Check = document.getElementById('bip85');
const bip85Fields = document.getElementById('bip85Subpanel');
const bip85DerivationSelect = document.getElementById('bip85application');
const bip85LengthGroup = document.querySelector('#bip85Subpanel .bip85-length-group:not(.bip85-bits-group)');
const bip85LengthSelect = document.getElementById('bip85length');
const bip85BitsGroup = document.getElementById('bip85bitsGroup');
const bip85BitsSelect = document.getElementById('bip85bits');
const bip85IndexInput = document.getElementById('bip85index');
const bip85DerivedLabel = document.querySelector('label[for="bip85derived"]');
let bip85DerivedInput = document.getElementById('bip85derived');
const showBip85DerivedBtn = document.getElementById('showBip85DerivedBtn');
let privateKeyInput = document.getElementById('privateKey');
const showPrivateKeyBtn = document.getElementById('showPrivateKeyBtn');
const privateKeyResultOptions = document.getElementById('privateKeyResultOptions');
const privateKeyCompressedRadio = document.getElementById('privateKeyCompressed');
const privateKeyUncompressedRadio = document.getElementById('privateKeyUncompressed');
const privateKeyHexCheck = document.getElementById('privateKeyHex');
const publicKeyInput = document.getElementById('publicKey');
const publicKeyResultOptions = document.getElementById('publicKeyResultOptions');
const publicKeyCompressedRadio = document.getElementById('publicKeyCompressed');
const publicKeyUncompressedRadio = document.getElementById('publicKeyUncompressed');
const addressInput = document.getElementById('address');
addressInput.addEventListener('input', updateMainAddressDetails);
let lastBip85SecondaryMenu = 'length';
const kdfContainer = document.getElementById('kdfContainer');
let createResetTimer = null;
let modeEntryTimer = null;
let derivationControlState = null;
let derivationProgressTimer = null;
let bip38EncryptionControlState = null;

function lockOperationControls() {
  const state = Array.from(
    createOverlay.querySelectorAll('button, input, select, textarea')
  ).map(element => ({
    element,
    id: element.id,
    disabled: element.disabled
  }));

  state.forEach(({ element, disabled }) => {
    if (!disabled) element.classList.add('operation-lock-disabled');
    element.disabled = true;
  });
  return state;
}

function restoreOperationControls(state) {
  state?.forEach(({ element, id, disabled }) => {
    const currentElement = id ? document.getElementById(id) : element;
    if (!currentElement?.isConnected) return;
    currentElement.disabled = disabled;
    currentElement.classList.remove('operation-lock-disabled');
  });
}

const derivationInteractionBlocker = document.createElement('div');
derivationInteractionBlocker.className = 'derivation-interaction-blocker';
derivationInteractionBlocker.setAttribute('aria-hidden', 'true');
let derivationTouchY = null;
['click', 'dblclick', 'contextmenu'].forEach(type => {
  derivationInteractionBlocker.addEventListener(type, event => {
    event.preventDefault();
    event.stopPropagation();
  });
});
derivationInteractionBlocker.addEventListener('wheel', event => {
  event.preventDefault();
  event.stopPropagation();
  createOverlay.scrollTop += event.deltaY;
}, { passive: false });
derivationInteractionBlocker.addEventListener('touchstart', event => {
  if (event.touches.length !== 1) return;
  derivationTouchY = event.touches[0].clientY;
  event.stopPropagation();
}, { passive: true });
derivationInteractionBlocker.addEventListener('touchmove', event => {
  if (derivationTouchY === null || event.touches.length !== 1) return;
  const currentY = event.touches[0].clientY;
  createOverlay.scrollTop += derivationTouchY - currentY;
  derivationTouchY = currentY;
  event.preventDefault();
  event.stopPropagation();
}, { passive: false });
['touchend', 'touchcancel'].forEach(type => {
  derivationInteractionBlocker.addEventListener(type, event => {
    derivationTouchY = null;
    event.stopPropagation();
  }, { passive: true });
});

const mobileSelectOverlay = document.createElement('div');
mobileSelectOverlay.className = 'mobile-select-overlay';
mobileSelectOverlay.id = 'mobile-select';
mobileSelectOverlay.setAttribute('aria-hidden', 'true');
document.body.appendChild(mobileSelectOverlay);
let activeCustomSelect = null;

function syncCustomSelect(select) {
  const trigger = select._customSelectTrigger;
  if (!trigger) return;
  const selectedOption = select.options[select.selectedIndex];
  const valueElement = trigger.querySelector('.custom-select-value');
  const nextText = selectedOption?.textContent || '';
  if (valueElement.textContent !== nextText) valueElement.textContent = nextText;
  if (trigger.disabled !== select.disabled) trigger.disabled = select.disabled;
  const disabledState = String(select.disabled);
  if (trigger.getAttribute('aria-disabled') !== disabledState) {
    trigger.setAttribute('aria-disabled', disabledState);
  }
}

function syncAllCustomSelects() {
  createOverlay.querySelectorAll('select').forEach(syncCustomSelect);
}

function enhanceCustomSelect(select) {
  if (select._customSelectTrigger) {
    syncCustomSelect(select);
    return;
  }
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'custom-select-trigger';
  trigger.id = `${select.id}Control`;
  trigger.setAttribute('role', 'combobox');
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  const label = document.querySelector(`label[for="${select.id}"]`);
  if (label) {
    trigger.setAttribute('aria-label', label.textContent.trim());
    label.addEventListener('click', event => {
      event.preventDefault();
      if (!trigger.disabled) trigger.click();
    });
  }
  trigger.innerHTML = `<span class="custom-select-value"></span><svg class="custom-select-arrow" viewBox="0 0 12 8" aria-hidden="true"><path d="M1 1l5 5 5-5"></path></svg>`;
  select.classList.add('custom-select-native');
  select.tabIndex = -1;
  select.setAttribute('aria-hidden', 'true');
  select.insertAdjacentElement('afterend', trigger);
  select._customSelectTrigger = trigger;
  trigger._nativeSelect = select;
  trigger.addEventListener('click', () => openMobileSelect(select));
  trigger.addEventListener('keydown', event => {
    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault();
    openMobileSelect(select);
  });
  syncCustomSelect(select);
}

function enhanceCustomSelects(root = createOverlay) {
  if (root.matches?.('select')) enhanceCustomSelect(root);
  root.querySelectorAll?.('select').forEach(enhanceCustomSelect);
}

function closeMobileSelect() {
  mobileSelectOverlay.classList.remove('visible');
  mobileSelectOverlay.setAttribute('aria-hidden', 'true');
  mobileSelectOverlay.replaceChildren();
  if (activeCustomSelect?._customSelectTrigger) {
    activeCustomSelect._customSelectTrigger.setAttribute('aria-expanded', 'false');
  }
  activeCustomSelect = null;
}

function openMobileSelect(select) {
  if (select.disabled) return;
  activeCustomSelect = select;
  select._customSelectTrigger?.setAttribute('aria-expanded', 'true');
  mobileSelectOverlay.classList.toggle('subpanel-select', Boolean(select.closest('#kdfSubpanel, #bip85Subpanel')));
  const list = document.createElement('div');
  list.className = 'mobile-select-list';
  list.setAttribute('role', 'radiogroup');

  Array.from(select.options).forEach((option, index) => {
    const row = document.createElement('label');
    row.className = 'mobile-select-option';
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.className = 'mobile-select-radio';
    radio.name = 'mobile-select';
    radio.checked = option.selected;
    radio.disabled = option.disabled;
    radio.value = option.value;
    const text = document.createElement('span');
    text.textContent = option.textContent;
    radio.addEventListener('change', () => {
      select.selectedIndex = index;
      syncCustomSelect(select);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          closeMobileSelect();
          requestAnimationFrame(() => {
            select.dispatchEvent(new Event('change', { bubbles: true }));
          });
        });
      });
    });
    row.append(radio, text);
    list.appendChild(row);
  });

  mobileSelectOverlay.replaceChildren(list);
  mobileSelectOverlay.classList.add('visible');
  mobileSelectOverlay.setAttribute('aria-hidden', 'false');
}

mobileSelectOverlay.addEventListener('pointerdown', event => {
  if (event.target !== mobileSelectOverlay) return;
  event.preventDefault();
  event.stopPropagation();
});
mobileSelectOverlay.addEventListener('click', event => {
  if (event.target !== mobileSelectOverlay) return;
  event.preventDefault();
  event.stopPropagation();
  closeMobileSelect();
});

let selectTouchGesture = null;
createOverlay.addEventListener('touchstart', event => {
  const select = event.target.closest('select');
  if (!select || event.touches.length !== 1) return;
  event.preventDefault();
  selectTouchGesture = {
    select,
    startY: event.touches[0].clientY,
    previousY: event.touches[0].clientY,
    moved: false
  };
}, { capture: true, passive: false });

createOverlay.addEventListener('touchmove', event => {
  if (!selectTouchGesture || event.touches.length !== 1) return;
  const currentY = event.touches[0].clientY;
  if (Math.abs(currentY - selectTouchGesture.startY) > 4) {
    selectTouchGesture.moved = true;
  }
  if (selectTouchGesture.moved) {
    event.preventDefault();
    createOverlay.scrollTop += selectTouchGesture.previousY - currentY;
    selectTouchGesture.previousY = currentY;
  }
}, { capture: true, passive: false });

createOverlay.addEventListener('touchend', event => {
  if (!selectTouchGesture) return;
  event.preventDefault();
  const { select, moved } = selectTouchGesture;
  selectTouchGesture = null;
  if (!moved) openMobileSelect(select);
}, { capture: true, passive: false });

createOverlay.addEventListener('touchcancel', () => {
  selectTouchGesture = null;
}, { capture: true, passive: true });

let kdfSettingsCheck, kdfSettingsWrapper, kdfSettingsFields;
let kdfTypeSelect, kdfNSelect, kdfRInput, kdfPInput, kdfPrfSelect, kdfIterationsInput;
let kdlenSelect;
let kdfScryptFields, kdfPbkdf2Fields;

function resizeSensitiveTextarea(textarea) {
  if (!(textarea instanceof HTMLTextAreaElement)) return;
  const minimumHeight = 42;
  textarea.style.height = 'auto';
  textarea.style.height = textarea.value
    ? `${Math.max(minimumHeight, textarea.scrollHeight)}px`
    : `${minimumHeight}px`;
  textarea._refreshSensitiveMask?.();
}

function installPasswordSelectionGuard(input) {
  if (!input || input._passwordSelectionGuardInstalled) return;
  input._passwordSelectionGuardInstalled = true;
  let clearingMaskedSelection = false;
  const blockMaskedSelection = event => {
    if (!input.classList.contains('password-masked') || clearingMaskedSelection) return;
    if (!input.readOnly && (event.type === 'pointerdown' || event.type === 'mousedown' || event.type === 'selectstart')) return;
    clearingMaskedSelection = true;
    if (event.cancelable) event.preventDefault();
    try {
      input.setSelectionRange(0, 0, 'none');
    } catch (_) {
      // The field may not expose a selection range while it is being hidden.
    }
    if (input.readOnly) input.blur();
    window.getSelection()?.removeAllRanges();
    clearingMaskedSelection = false;
  };
  ['pointerdown', 'mousedown', 'pointerup', 'dblclick', 'selectstart', 'copy', 'cut', 'dragstart', 'contextmenu'].forEach(type => {
    input.addEventListener(type, blockMaskedSelection);
  });
  input.addEventListener('keydown', event => {
    if (!input.classList.contains('password-masked')) return;
    const selectsWithShift = event.shiftKey && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key);
    const selectsAll = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a';
    if (selectsWithShift || selectsAll) event.preventDefault();
  });
}

function getAdaptiveSecretElement(key) {
  if (key === 'entropy') return entropyInput;
  if (key === 'mnemonic') return mnemonicInput;
  if (key === 'seed') return seedInput;
  if (key === 'rootprv') return rootprvInput;
  if (key === 'accountprv') return accountprvInput;
  if (key === 'derivedprv') return derivedprvInput;
  if (key === 'bip85derived') return bip85DerivedInput;
  if (key === 'private-key') return privateKeyInput;
  if (key === 'bip38-key') return bip38KeyInput;
  return null;
}

function setAdaptiveSecretElement(key, element) {
  if (key === 'entropy') entropyInput = element;
  else if (key === 'mnemonic') mnemonicInput = element;
  else if (key === 'seed') seedInput = element;
  else if (key === 'rootprv') rootprvInput = element;
  else if (key === 'accountprv') accountprvInput = element;
  else if (key === 'derivedprv') derivedprvInput = element;
  else if (key === 'bip85derived') bip85DerivedInput = element;
  else if (key === 'private-key') privateKeyInput = element;
  else if (key === 'bip38-key') bip38KeyInput = element;

  const sensitiveField = sensitiveFields.find(field => field.key === key);
  if (sensitiveField) sensitiveField.element = element;
}

function replaceAdaptiveSecretElement(element, visible) {
  const key = element.dataset.adaptiveSecret;
  const replacement = document.createElement(visible ? 'textarea' : 'input');
  Array.from(element.attributes).forEach(attribute => {
    if (attribute.name !== 'type' && attribute.name !== 'rows' && attribute.name !== 'style') {
      replacement.setAttribute(attribute.name, attribute.value);
    }
  });
  replacement.value = element.value;
  replacement.dataset.adaptiveSecret = key;
  if (key === 'entropy') replacement.classList.remove('field-valid');

  if (visible) {
    replacement.rows = 1;
    replacement.classList.remove('password-masked');
    replacement.classList.add('expanding-entropy-input');
    replacement.addEventListener('input', () => resizeSensitiveTextarea(replacement));
  } else {
    replacement.type = 'password';
    replacement.classList.remove('expanding-entropy-input');
    replacement.classList.add('password-masked');
    installPasswordSelectionGuard(replacement);
  }

  element.replaceWith(replacement);
  setAdaptiveSecretElement(key, replacement);
  if (visible) resizeSensitiveTextarea(replacement);
  return replacement;
}

function hideAdaptiveSecret(element, button, key) {
  const wasFocused = document.activeElement === element;
  const hiddenElement = element instanceof HTMLTextAreaElement
    ? replaceAdaptiveSecretElement(element, false)
    : element;
  try { hiddenElement.setSelectionRange(0, 0, 'none'); } catch (_) {}
  if (wasFocused) {
    hiddenElement.blur();
    window.getSelection()?.removeAllRanges();
  }
  button?.classList.remove('active');
  common.clearTimer(createTimers, key);
  return hiddenElement;
}

function toggleAdaptiveSecret(element, button, key) {
  if (element instanceof HTMLTextAreaElement) return hideAdaptiveSecret(element, button, key);
  const visibleElement = replaceAdaptiveSecretElement(element, true);
  button?.classList.add('active');
  common.clearTimer(createTimers, key);
  createTimers.set(key, setTimeout(() => {
    hideAdaptiveSecret(getAdaptiveSecretElement(key), button, key);
  }, 30000));
  return visibleElement;
}

[
  entropyInput,
  mnemonicInput,
  seedInput,
  rootprvInput,
  accountprvInput,
  derivedprvInput,
  bip85DerivedInput,
  privateKeyInput
].forEach(installPasswordSelectionGuard);

[rootpubInput, accountpubInput, derivedpubInput, publicKeyInput, addressInput].forEach(textarea => {
  textarea.addEventListener('input', () => resizeSensitiveTextarea(textarea));
  resizeSensitiveTextarea(textarea);
});

const sensitiveFields = [
  { element: primarySecretInput, button: showPrimarySecretBtn, key: 'primary' },
  { element: confirmPrimarySecretInput, button: showConfirmPrimarySecretBtn, key: 'confirm-primary' },
  { element: additionalSecretInput, button: showAdditionalSecretBtn, key: 'additional' },
  { element: confirmAdditionalSecretInput, button: showConfirmAdditionalSecretBtn, key: 'confirm-additional' },
  { element: entropyInput, button: showEntropyBtn, key: 'entropy' },
  { element: mnemonicInput, button: showMnemonicBtn, key: 'mnemonic' },
  { element: bip39PassphraseInput, button: showBip39PassphraseBtn, key: 'bip39-passphrase' },
  { element: confirmPassphraseInput, button: showConfirmPassphraseBtn, key: 'confirm-bip39-passphrase' },
  { element: seedInput, button: showSeedBtn, key: 'seed' },
  { element: rootprvInput, button: showRootprvBtn, key: 'rootprv' },
  { element: accountprvInput, button: showAccountprvBtn, key: 'accountprv' },
  { element: derivedprvInput, button: showDerivedprvBtn, key: 'derivedprv' },
  { element: bip85DerivedInput, button: showBip85DerivedBtn, key: 'bip85derived' },
  { element: privateKeyInput, button: showPrivateKeyBtn, key: 'private-key' },
  { element: bip38KeyInput, button: showBip38KeyBtn, key: 'bip38-key' },
  { element: bip38PassphraseInput, button: showBip38PassphraseBtn, key: 'bip38-passphrase' },
  { element: confirmBip38PassphraseInput, button: showConfirmBip38PassphraseBtn, key: 'confirm-bip38-passphrase' }
];

let pendingSensitiveCopyText = '';
let confirmationLockedScrollTop = 0;

function setConfirmationScrollLocked(active) {
  if (active) confirmationLockedScrollTop = createOverlay.scrollTop;
  createOverlay.classList.toggle('confirmation-scroll-locked', active);
  if (!active) createOverlay.scrollTop = confirmationLockedScrollTop;
}

function preventConfirmationScroll(event) {
  if (event.cancelable) event.preventDefault();
  event.stopPropagation();
}

[clearDataConfirmOverlay, clearDataExitConfirmOverlay, sensitiveCopyConfirmOverlay].forEach(overlay => {
  overlay.addEventListener('wheel', preventConfirmationScroll, { passive: false });
  overlay.addEventListener('touchmove', preventConfirmationScroll, { passive: false });
});

createOverlay.addEventListener('scroll', () => {
  if (!createOverlay.classList.contains('confirmation-scroll-locked')) return;
  if (createOverlay.scrollTop !== confirmationLockedScrollTop) {
    createOverlay.scrollTop = confirmationLockedScrollTop;
  }
}, { passive: true });

function closeSensitiveCopyConfirmation() {
  sensitiveCopyConfirmOverlay.classList.remove('visible');
  sensitiveCopyConfirmOverlay.setAttribute('aria-hidden', 'true');
  setConfirmationScrollLocked(false);
  pendingSensitiveCopyText = '';
}

async function writeSensitiveClipboardText(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {}
  }

  const clipboardFallback = document.createElement('textarea');
  clipboardFallback.value = text;
  clipboardFallback.setAttribute('readonly', '');
  clipboardFallback.style.position = 'fixed';
  clipboardFallback.style.opacity = '0';
  document.body.appendChild(clipboardFallback);
  clipboardFallback.select();
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch (_) {}
  clipboardFallback.remove();
  return copied;
}

createOverlay.addEventListener('copy', event => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return;
  if (!sensitiveFields.some(field => field.element === target)) return;

  const selectionStart = target.selectionStart ?? 0;
  const selectionEnd = target.selectionEnd ?? selectionStart;
  if (selectionEnd <= selectionStart) return;

  event.preventDefault();
  event.stopImmediatePropagation();
  pendingSensitiveCopyText = target.value.slice(selectionStart, selectionEnd);
  sensitiveCopyConfirmOverlay.classList.add('visible');
  sensitiveCopyConfirmOverlay.setAttribute('aria-hidden', 'false');
  setConfirmationScrollLocked(true);
  sensitiveCopyCancelBtn.focus({ preventScroll: true });
}, true);

sensitiveCopyCancelBtn.addEventListener('click', closeSensitiveCopyConfirmation);
sensitiveCopyAcceptBtn.addEventListener('click', async () => {
  const text = pendingSensitiveCopyText;
  if (!text) {
    closeSensitiveCopyConfirmation();
    return;
  }
  if (await writeSensitiveClipboardText(text)) {
    closeSensitiveCopyConfirmation();
    showStandaloneStatus('SENSITIVE DATA COPIED TO CLIPBOARD');
  }
});

let globalSecretRevealTimer = null;

function deactivateGlobalSecretReveal() {
  if (globalSecretRevealTimer !== null) {
    clearTimeout(globalSecretRevealTimer);
    globalSecretRevealTimer = null;
  }
  wallexMainRevealBtn?.classList.remove('active');
  wallexMainRevealBtn?.setAttribute('aria-pressed', 'false');
  wallexMainRevealBtn?.setAttribute('aria-label', 'Reveal all secrets');
}

function isGlobalSecretRevealActive() {
  return wallexMainRevealBtn?.getAttribute('aria-pressed') === 'true';
}

function revealSensitiveField(element, button, key) {
  const currentElement = element?.hasAttribute('data-adaptive-secret')
    ? getAdaptiveSecretElement(key)
    : element;
  if (!currentElement) return;

  if (!isPasswordVisible(currentElement)) {
    if (currentElement.hasAttribute('data-adaptive-secret')) {
      togglePasswordVisibility(currentElement, button, key);
    } else {
      toggleUpperSecretVisibility(currentElement, button, key);
    }
    common.clearTimer(createTimers, key);
    return;
  }

  button?.classList.add('active');
  common.clearTimer(createTimers, key);
  if (!currentElement.hasAttribute('data-adaptive-secret')) {
    currentElement.classList.remove('password-masked');
  }
}

function revealSensitiveFields(keys) {
  sensitiveFields
    .filter(({ key }) => keys.includes(key))
    .forEach(({ element, button, key }) => revealSensitiveField(element, button, key));
}

function revealAllSecrets() {
  sensitiveFields.forEach(({ element, button, key }) => revealSensitiveField(element, button, key));
  deactivateGlobalSecretReveal();
  wallexMainRevealBtn.classList.add('active');
  wallexMainRevealBtn.setAttribute('aria-pressed', 'true');
  wallexMainRevealBtn.setAttribute('aria-label', 'Hide all secrets');
  globalSecretRevealTimer = setTimeout(() => hideAllPasswords(sensitiveFields), 30000);
}

wallexMainRevealBtn.addEventListener('click', event => {
  event.stopPropagation();
  if (wallexMainRevealBtn.getAttribute('aria-pressed') === 'true') {
    hideAllPasswords(sensitiveFields);
    return;
  }
  revealAllSecrets();
});

createOverlay.addEventListener('click', event => {
  if (!isGlobalSecretRevealActive()) return;
  if (!event.target.closest('.show-primary-secret-btn, .show-additional-secret-btn, .show-entropy-btn')) return;
  event.preventDefault();
  event.stopImmediatePropagation();
}, true);

function clearAllSensitiveData({ preserveEntropy = false } = {}) {
  clearCachedWalletRoot();
  deactivateGlobalSecretReveal();
  sensitiveFields.forEach(({ element, button, key }) => {
    if (preserveEntropy && element === entropyInput) {
      hidePassword(element, button, key);
      common.clearFieldFeedback(element);
      return;
    }

    clearData(element);
    hidePassword(element, button, key);
    common.clearFieldFeedback(element);
    if (element instanceof HTMLTextAreaElement) resizeSensitiveTextarea(element);
  });
  confirmPrimarySecretInput.dataset.matchesPrimary = 'false';
  confirmAdditionalSecretInput.dataset.matchesAdditional = 'false';
  confirmPassphraseInput.dataset.matchesPassphrase = 'false';
  clearBip38EncryptedVariants({ clearField: false });
  clearData(rootpubInput);
  clearData(accountpubInput);
  clearData(derivedpubInput);
  clearData(publicKeyInput);
  clearData(addressInput);
  resizeSensitiveTextarea(rootpubInput);
  resizeSensitiveTextarea(accountpubInput);
  resizeSensitiveTextarea(derivedpubInput);
  resizeSensitiveTextarea(publicKeyInput);
  resizeSensitiveTextarea(addressInput);
  replaceCurrentBip38Keys();
  clearAllTimers();
}

async function performClearData({ reload = true, exit = false } = {}) {
  sensitiveOperationEpoch += 1;
  bip39SeedRevision += 1;
  if (reload || exit) {
    createOverlay.querySelectorAll('button, input, select, textarea').forEach(element => {
      element.disabled = true;
    });
  }

  if (derivationProgressTimer !== null) {
    clearInterval(derivationProgressTimer);
    derivationProgressTimer = null;
  }
  closeMobileSelect();
  clearAllTimers();
  window.getSelection()?.removeAllRanges();
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();

  sensitiveFields.forEach(({ element }) => {
    if (typeof element.setSelectionRange === 'function') {
      try { element.setSelectionRange(0, 0); } catch (_) {}
    }
  });
  clearAllSensitiveData();
  resetPanel();

  try { localStorage.clear(); } catch (_) {}
  try { sessionStorage.clear(); } catch (_) {}
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText('');
  } catch (_) {}

  if (exit) {
    window.WallexNative.closeApp();
    return;
  }

  if (!reload) {
    common.setNetworkEnabled(false);
    wallexMainExpertBtn.setAttribute('aria-pressed', 'false');
    wallexMainExpertBtn.classList.remove('active');
    mainCoinSelect.value = 'btc';
    mainChangeSelect.value = '0';
    mainAddressIndexInput.value = '0';
    privateKeyCompressedRadio.checked = true;
    privateKeyUncompressedRadio.checked = false;
    publicKeyCompressedRadio.checked = true;
    publicKeyUncompressedRadio.checked = false;
    applyWalletSelectionExpertMode(false);
    syncMainStandardFromAddressType();
    updateMainExtendedKeyLabels();
    setNavigationDrawerOpen(false);
    createOverlay.scrollTop = 0;
    lastUserActivityAt = Date.now();
    inactivityClearStarted = false;
    clearTimeout(inactivityClearTimer);
    inactivityClearTimer = setTimeout(runInactivityClearCheck, inactivityClearDelay);
    showStandaloneStatus('CLEAR DATA COMPLETE');
    return;
  }

  try { sessionStorage.setItem(clearDataCompletionStorageKey, 'true'); } catch (_) {}
  location.reload();
}

function closeClearDataConfirmation() {
  clearDataConfirmOverlay.classList.remove('visible');
  clearDataConfirmOverlay.setAttribute('aria-hidden', 'true');
  setConfirmationScrollLocked(false);
}

function closeClearDataExitConfirmation() {
  clearDataExitConfirmOverlay.classList.remove('visible');
  clearDataExitConfirmOverlay.setAttribute('aria-hidden', 'true');
  setConfirmationScrollLocked(false);
}

clearDataBtn.addEventListener('click', () => {
  clearDataConfirmOverlay.classList.add('visible');
  clearDataConfirmOverlay.setAttribute('aria-hidden', 'false');
  setConfirmationScrollLocked(true);
  clearDataCancelBtn.focus();
});

clearDataCancelBtn.addEventListener('click', closeClearDataConfirmation);
clearDataAcceptBtn.addEventListener('click', () => {
  clearDataConfirmOverlay.classList.remove('visible');
  clearDataConfirmOverlay.setAttribute('aria-hidden', 'true');
  setConfirmationScrollLocked(false);
  void performClearData({ reload: false });
});

clearDataExitBtn.addEventListener('click', () => {
  clearDataExitConfirmOverlay.classList.add('visible');
  clearDataExitConfirmOverlay.setAttribute('aria-hidden', 'false');
  setConfirmationScrollLocked(true);
  clearDataExitCancelBtn.focus();
});

clearDataExitCancelBtn.addEventListener('click', closeClearDataExitConfirmation);
clearDataExitAcceptBtn.addEventListener('click', () => {
  clearDataExitConfirmOverlay.classList.remove('visible');
  clearDataExitConfirmOverlay.setAttribute('aria-hidden', 'true');
  setConfirmationScrollLocked(false);
  clearDataExitConfirmOverlay.style.display = 'none';
  void performClearData({ reload: false, exit: true });
});
document.addEventListener('wallex:native-background', () => {
  hideAllPasswords(sensitiveFields);
});

let interactiveTouchDrag = null;
let suppressInteractiveClickUntil = 0;
createOverlay.addEventListener('pointerdown', event => {
  if (event.pointerType !== 'touch') return;
  if (createOverlay.classList.contains('confirmation-scroll-locked')) return;
  const touchedSelect = event.target.closest('select');
  if (touchedSelect) event.preventDefault();
  interactiveTouchDrag = {
    pointerId: event.pointerId,
    previousY: event.clientY,
    startY: event.clientY,
    dragging: false,
    select: touchedSelect
  };
});

createOverlay.addEventListener('pointermove', event => {
  if (createOverlay.classList.contains('confirmation-scroll-locked')) return;
  if (!interactiveTouchDrag || event.pointerId !== interactiveTouchDrag.pointerId) return;
  if (interactiveTouchDrag.select && selectTouchGesture) return;
  const totalMovement = Math.abs(event.clientY - interactiveTouchDrag.startY);
  if (!interactiveTouchDrag.dragging && totalMovement > 3) {
    interactiveTouchDrag.dragging = true;
    createOverlay.setPointerCapture(event.pointerId);
  }
  if (!interactiveTouchDrag.dragging) return;
  event.preventDefault();
  createOverlay.scrollTop += interactiveTouchDrag.previousY - event.clientY;
  interactiveTouchDrag.previousY = event.clientY;
});

function finishInteractiveTouchDrag(event) {
  if (!interactiveTouchDrag || event.pointerId !== interactiveTouchDrag.pointerId) return;
  const selectToOpen = !interactiveTouchDrag.dragging ? interactiveTouchDrag.select : null;
  if (interactiveTouchDrag.dragging) suppressInteractiveClickUntil = performance.now() + 350;
  if (createOverlay.hasPointerCapture(event.pointerId)) createOverlay.releasePointerCapture(event.pointerId);
  interactiveTouchDrag = null;
  if (selectToOpen) {
    suppressInteractiveClickUntil = performance.now() + 500;
    openMobileSelect(selectToOpen);
  }
}

createOverlay.addEventListener('pointerup', finishInteractiveTouchDrag);
createOverlay.addEventListener('pointercancel', event => {
  if (!interactiveTouchDrag || event.pointerId !== interactiveTouchDrag.pointerId) return;
  interactiveTouchDrag = null;
});
createOverlay.addEventListener('click', event => {
  const touchedSelect = event.target.closest('select');
  if (touchedSelect) {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!mobileSelectOverlay.classList.contains('visible')) openMobileSelect(touchedSelect);
    return;
  }
  if (performance.now() < suppressInteractiveClickUntil) {
    event.preventDefault();
    event.stopPropagation();
  }
}, true);

createOverlay.addEventListener('mousedown', event => {
  const touchedSelect = event.target.closest('select');
  if (!touchedSelect) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  openMobileSelect(touchedSelect);
}, true);

createOverlay.addEventListener('keydown', event => {
  const touchedSelect = event.target.closest('select');
  if (!touchedSelect || !['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(event.key)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  openMobileSelect(touchedSelect);
}, true);

enhanceCustomSelects();
const customSelectObserver = new MutationObserver(mutations => {
  mutations.forEach(mutation => {
    if (mutation.type === 'childList') {
      mutation.addedNodes.forEach(node => {
        if (node instanceof Element) enhanceCustomSelects(node);
      });
    } else if (mutation.target instanceof HTMLSelectElement) {
      syncCustomSelect(mutation.target);
    }
  });
  syncAllCustomSelects();
});
customSelectObserver.observe(createOverlay, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ['disabled']
});
document.addEventListener('change', () => queueMicrotask(syncAllCustomSelects));

const lengthToKdlen = Object.freeze({
  '12': '16',
  '15': '20',
  '18': '24',
  '21': '28',
  '24': '32'
});
const kdlenToLength = Object.freeze(
  Object.fromEntries(Object.entries(lengthToKdlen).map(([length, kdlen]) => [kdlen, length]))
);

function syncKdlenFromLength() {
  if (kdlenSelect) kdlenSelect.value = lengthToKdlen[lengthSelect.value] || '16';
}

function syncLengthFromKdlen() {
  if (kdlenSelect) lengthSelect.value = kdlenToLength[kdlenSelect.value] || '12';
}

function buildKdfHTML() {
  return `
    <div class="kdf-settings-wrapper" id="kdfSettingsWrapper">
      <div class="panel-checkbox">
        <input type="checkbox" id="kdfSettingsCheck" class="panel-checkbox-input">
        <label for="kdfSettingsCheck" class="panel-checkbox-label">KDF SETTINGS</label>
      </div>
      <div class="kdf-settings-fields" id="kdfSubpanel">
        <div class="kdf-options">
          <div class="kdf-field-group">
            <label for="kdfAlgorithmSelect" class="kdf-label">ALGORITHM</label>
            <select class="kdf-select" id="kdfAlgorithmSelect">
              <option value="scrypt" selected>SCRYPT</option>
              <option value="pbkdf2">PBKDF2</option>
            </select>
          </div>
          <div class="kdf-dynamic-wrapper">
            <div class="kdf-dynamic-scrypt" id="kdfScryptFields">
              <div class="kdf-left-group">
                <div class="kdf-field-group">
                  <label for="scryptN" class="kdf-label">N</label>
                  <select class="kdf-select" id="scryptN">
                    <option value="1024">1024</option>
                    <option value="2048">2048</option>
                    <option value="4096">4096</option>
                    <option value="8192">8192</option>
                    <option value="16384" selected>16384</option>
                    <option value="32768">32768</option>
                    <option value="65536">65536</option>
                    <option value="131072">131072</option>
                    <option value="262144">262144</option>
                  </select>
                </div>
              </div>
              <div class="kdf-right-group">
                <div class="kdf-field-group">
                  <label for="scryptR" class="kdf-label">R</label>
                  <input type="number" class="kdf-input" id="scryptR" value="8" min="1" step="1">
                </div>
                <div class="kdf-field-group">
                  <label for="scryptP" class="kdf-label">P</label>
                  <input type="number" class="kdf-input" id="scryptP" value="1" min="1" step="1">
                </div>
              </div>
            </div>
            <div class="kdf-dynamic-pbkdf2 hidden" id="kdfPbkdf2Fields">
              <div class="kdf-left-group">
                <div class="kdf-field-group">
                  <label for="pbkdf2iter" class="kdf-label">ITER</label>
                  <input type="number" class="kdf-input kdf-input-iterations" id="pbkdf2iter" value="220000" min="1" step="1">
                </div>
                <div class="kdf-field-group">
                  <label for="pbkdf2hash" class="kdf-label">HASH</label>
                  <select class="kdf-select" id="pbkdf2hash">
                    <option value="hmac-sha-256">HMAC-SHA-256</option>
                    <option value="hmac-sha-512" selected>HMAC-SHA-512</option>
                  </select>
                </div>
              </div>
            </div>
          </div>
          <div class="kdf-field-group kdf-kdlen-group">
            <label for="kdlen" class="kdf-label">KDLEN</label>
            <select class="kdf-select" id="kdlen">
              <option value="16" selected>16</option>
              <option value="20">20</option>
              <option value="24">24</option>
              <option value="28">28</option>
              <option value="32">32</option>
            </select>
          </div>
        </div>
      </div>
    </div>
  `;
}

function bindKdfEvents() {
  kdfSettingsCheck = document.getElementById('kdfSettingsCheck');
  kdfSettingsWrapper = document.getElementById('kdfSettingsWrapper');
  kdfSettingsFields = document.getElementById('kdfSubpanel');
  kdfTypeSelect = document.getElementById('kdfAlgorithmSelect');
  kdfNSelect = document.getElementById('scryptN');
  kdfRInput = document.getElementById('scryptR');
  kdfPInput = document.getElementById('scryptP');
  kdfPrfSelect = document.getElementById('pbkdf2hash');
  kdfIterationsInput = document.getElementById('pbkdf2iter');
  kdlenSelect = document.getElementById('kdlen');
  kdfScryptFields = document.getElementById('kdfScryptFields');
  kdfPbkdf2Fields = document.getElementById('kdfPbkdf2Fields');

  if (kdfSettingsCheck) {
    kdfSettingsCheck.addEventListener('change', toggleKdfSettings);
  }
  if (kdfTypeSelect) {
    kdfTypeSelect.addEventListener('change', updateKdfFields);
  }
  if (kdfPrfSelect) {
    kdfPrfSelect.addEventListener('change', updateIterations);
  }
  if (kdlenSelect) {
    kdlenSelect.addEventListener('change', syncLengthFromKdlen);
    syncKdlenFromLength();
  }
  if (kdfRInput) {
    setupKdfInput(kdfRInput, '8');
  }
  if (kdfPInput) {
    setupKdfInput(kdfPInput, '1');
  }
  if (kdfIterationsInput) {
    setupKdfInput(kdfIterationsInput, '220000');
  }
  if (kdfSettingsCheck && kdfSettingsCheck.checked) {
    toggleKdfSettings();
  }
  if (kdfTypeSelect) {
    updateKdfFields();
  }
}

function removeKdf() {
  if (kdfContainer) {
    kdfContainer.innerHTML = '';
    kdfContainer.classList.remove('flex', 'block');
    kdfContainer.classList.add('hidden');
  }
  kdfSettingsCheck = null;
  kdfSettingsWrapper = null;
  kdfSettingsFields = null;
  kdfTypeSelect = null;
  kdfNSelect = null;
  kdfRInput = null;
  kdfPInput = null;
  kdfPrfSelect = null;
  kdfIterationsInput = null;
  kdlenSelect = null;
  kdfScryptFields = null;
  kdfPbkdf2Fields = null;
}

function resetPanel() {
  deactivateGlobalSecretReveal();
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  modeSelect.value = 'deterministic';
  lengthSelect.value = '12';
  primarySecretInput.value = '';
  primarySecretInput.type = 'password';
  primarySecretInput.classList.add('password-masked');
  showPrimarySecretBtn.classList.remove('active');
  primarySecretInput.classList.remove('field-error', 'field-invalid', 'field-valid', 'field-success', 'shake');

  confirmPrimarySecretInput.value = '';
  confirmPrimarySecretInput.type = 'password';
  confirmPrimarySecretInput.classList.add('password-masked');
  showConfirmPrimarySecretBtn.classList.remove('active');
  confirmPrimarySecretInput.classList.remove('field-error', 'field-invalid', 'field-valid', 'secret-mismatch', 'shake');
  confirmPrimarySecretInput.dataset.matchesPrimary = 'false';

  additionalSecretInput.value = '';
  additionalSecretInput.type = 'password';
  additionalSecretInput.classList.add('password-masked');
  showAdditionalSecretBtn.classList.remove('active');

  confirmAdditionalSecretInput.value = '';
  confirmAdditionalSecretInput.type = 'password';
  confirmAdditionalSecretInput.classList.add('password-masked');
  showConfirmAdditionalSecretBtn.classList.remove('active');
  confirmAdditionalSecretInput.classList.remove('field-error', 'field-invalid', 'field-valid', 'secret-mismatch', 'shake');
  confirmAdditionalSecretInput.dataset.matchesAdditional = 'false';

  clearData(bip39PassphraseInput);
  hidePassword(bip39PassphraseInput, showBip39PassphraseBtn, 'bip39-passphrase');
  clearData(confirmPassphraseInput);
  hidePassword(confirmPassphraseInput, showConfirmPassphraseBtn, 'confirm-bip39-passphrase');
  confirmPassphraseInput.dataset.matchesPassphrase = 'false';
  bip39PassphraseCheck.checked = false;
  passphraseSubpanel.classList.remove('visible', 'mounted');

  clearData(bip38PassphraseInput);
  hidePassword(bip38PassphraseInput, showBip38PassphraseBtn, 'bip38-passphrase');
  clearData(confirmBip38PassphraseInput);
  hidePassword(confirmBip38PassphraseInput, showConfirmBip38PassphraseBtn, 'confirm-bip38-passphrase');
  confirmBip38PassphraseInput.dataset.matchesBip38Passphrase = 'false';
  clearBip38EncryptedVariants();
  bip38KeyCompressedRadio.checked = true;
  bip38KeyUncompressedRadio.checked = false;
  hardenedIndexCheck.checked = false;
  bip38EncryptionCheck.checked = false;
  bip38Subpanel.classList.remove('visible', 'mounted');
  addressDetailsCheck.checked = false;
  addressDetailsSubpanel.classList.remove('visible', 'mounted');

  removeKdf();

  handleModeChange();
  queueMicrotask(syncAllCustomSelects);
}

function openCreateOverlay() {
  if (createResetTimer !== null) {
    clearTimeout(createResetTimer);
    createResetTimer = null;
  }
  createOverlay.classList.add('active');
  createOverlay.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
}

function clearCreatePanelFeedback() {
  createOverlay.querySelectorAll('.shake, .field-error, .field-invalid, .field-valid, .field-success, .blink-white')
    .forEach(element => {
      element.classList.remove('shake', 'field-error', 'field-invalid', 'field-valid', 'field-success', 'blink-white');
    });
}

function closeCreateOverlay() {
  setNavigationDrawerOpen(false);
  hideAllPasswords(sensitiveFields);
  clearAllTimers();
  createOverlay.classList.remove('active');
  createOverlay.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
}

function handleModeChange() {
  const mode = modeSelect.value;
  deriveBtn.textContent = mode === 'deterministic' ? 'DERIVE' : 'GENERATE';
  if (mode === 'deterministic') {
    if (modeEntryTimer !== null) clearTimeout(modeEntryTimer);
    createOverlay.classList.add('mode-entering-deterministic');
    clearCreatePanelFeedback();
    primarySecretInput.type = 'password';
    primarySecretInput.classList.add('password-masked');
    showPrimarySecretBtn.classList.remove('active');
    primarySecretInput.classList.remove('field-error', 'field-invalid', 'field-valid', 'field-success', 'shake');

    confirmPrimarySecretInput.type = 'password';
    confirmPrimarySecretInput.classList.add('password-masked');
    showConfirmPrimarySecretBtn.classList.remove('active');
    confirmPrimarySecretInput.classList.remove('field-error', 'field-invalid', 'field-valid', 'secret-mismatch', 'shake');
    confirmPrimarySecretInput.dataset.matchesPrimary = 'false';

    additionalSecretInput.type = 'password';
    additionalSecretInput.classList.add('password-masked');
    showAdditionalSecretBtn.classList.remove('active');

    confirmAdditionalSecretInput.type = 'password';
    confirmAdditionalSecretInput.classList.add('password-masked');
    showConfirmAdditionalSecretBtn.classList.remove('active');
    confirmAdditionalSecretInput.classList.remove('field-error', 'field-invalid', 'field-valid', 'secret-mismatch', 'shake');
    confirmAdditionalSecretInput.dataset.matchesAdditional = 'false';

    if (kdfContainer) {
      kdfContainer.innerHTML = buildKdfHTML();
      kdfContainer.classList.remove('hidden');
      kdfContainer.classList.add('block');
      bindKdfEvents();
      if (kdfSettingsFields && additionalSecretWrapper) {
        kdfSettingsFields.appendChild(additionalSecretWrapper);
      }
      if (kdfSettingsWrapper) {
        kdfSettingsWrapper.classList.add('show');
      }
      if (kdfSettingsFields) {
        kdfSettingsFields.classList.remove('visible', 'mounted');
      }
      if (kdfTypeSelect) kdfTypeSelect.value = 'scrypt';
      if (kdfNSelect) kdfNSelect.value = '16384';
      if (kdfRInput) kdfRInput.value = '8';
      if (kdfPInput) kdfPInput.value = '1';
      if (kdfPrfSelect) kdfPrfSelect.value = 'hmac-sha-512';
      if (kdfIterationsInput) {
        kdfIterationsInput.value = '220000';
        kdfIterationsInput.dataset.defaultValue = '220000';
      }
      syncKdlenFromLength();
      if (kdfSettingsCheck) kdfSettingsCheck.checked = false;
      updateKdfFields();
    }

    primarySecretWrapper.classList.remove('hidden');
    primarySecretWrapper.classList.add('flex');
    additionalSecretWrapper.classList.remove('hidden');
    additionalSecretWrapper.classList.add('flex');
    clearAllTimers();
    setTimeout(clearCreatePanelFeedback, 50);
    modeEntryTimer = setTimeout(() => {
      clearCreatePanelFeedback();
      createOverlay.classList.remove('mode-entering-deterministic');
      modeEntryTimer = null;
    }, 120);
  } else {
    if (modeEntryTimer !== null) {
      clearTimeout(modeEntryTimer);
      modeEntryTimer = null;
    }
    createOverlay.classList.remove('mode-entering-deterministic');
    primarySecretInput.type = 'password';
    primarySecretInput.classList.add('password-masked');
    showPrimarySecretBtn.classList.remove('active');
    primarySecretInput.classList.remove('field-error', 'field-invalid', 'field-valid', 'field-success', 'shake');

    confirmPrimarySecretInput.type = 'password';
    confirmPrimarySecretInput.classList.add('password-masked');
    showConfirmPrimarySecretBtn.classList.remove('active');
    confirmPrimarySecretInput.classList.remove('field-error', 'field-invalid', 'field-valid', 'secret-mismatch', 'shake');
    confirmPrimarySecretInput.dataset.matchesPrimary = 'false';

    additionalSecretInput.type = 'password';
    additionalSecretInput.classList.add('password-masked');
    showAdditionalSecretBtn.classList.remove('active');

    confirmAdditionalSecretInput.type = 'password';
    confirmAdditionalSecretInput.classList.add('password-masked');
    showConfirmAdditionalSecretBtn.classList.remove('active');
    confirmAdditionalSecretInput.classList.remove('field-error', 'field-invalid', 'field-valid', 'secret-mismatch', 'shake');
    confirmAdditionalSecretInput.dataset.matchesAdditional = 'false';

    removeKdf();

    primarySecretWrapper.classList.remove('flex', 'block');
    primarySecretWrapper.classList.add('hidden');
    additionalSecretWrapper.classList.remove('flex', 'block');
    additionalSecretWrapper.classList.add('hidden');
    clearAllTimers();
  }
  if (isGlobalSecretRevealActive()) {
    sensitiveFields.forEach(({ element, button, key }) => revealSensitiveField(element, button, key));
  }
}

function toggleUpperSecretVisibility(element, button, key) {
  togglePasswordVisibility(element, button, key);
  element.classList.toggle('password-masked', element.type !== 'text');
}

showPrimarySecretBtn.addEventListener('click', function(e) {
  e.stopPropagation();
  toggleUpperSecretVisibility(primarySecretInput, showPrimarySecretBtn, 'primary');
});

showConfirmPrimarySecretBtn.addEventListener('click', function(e) {
  e.stopPropagation();
  toggleUpperSecretVisibility(confirmPrimarySecretInput, showConfirmPrimarySecretBtn, 'confirm-primary');
});

showAdditionalSecretBtn.addEventListener('click', function(e) {
  e.stopPropagation();
  toggleUpperSecretVisibility(additionalSecretInput, showAdditionalSecretBtn, 'additional');
});

showConfirmAdditionalSecretBtn.addEventListener('click', function(e) {
  e.stopPropagation();
  toggleUpperSecretVisibility(confirmAdditionalSecretInput, showConfirmAdditionalSecretBtn, 'confirm-additional');
});

showEntropyBtn.addEventListener('click', function(e) {
  e.stopPropagation();
  togglePasswordVisibility(entropyInput, showEntropyBtn, 'entropy');
});

showMnemonicBtn.addEventListener('click', function(e) {
  e.stopPropagation();
  togglePasswordVisibility(mnemonicInput, showMnemonicBtn, 'mnemonic');
});

showBip39PassphraseBtn.addEventListener('click', function(e) {
  e.stopPropagation();
  toggleUpperSecretVisibility(bip39PassphraseInput, showBip39PassphraseBtn, 'bip39-passphrase');
});

showConfirmPassphraseBtn.addEventListener('click', function(e) {
  e.stopPropagation();
  toggleUpperSecretVisibility(confirmPassphraseInput, showConfirmPassphraseBtn, 'confirm-bip39-passphrase');
});

showSeedBtn.addEventListener('click', function(e) {
  e.stopPropagation();
  togglePasswordVisibility(seedInput, showSeedBtn, 'seed');
});

showRootprvBtn.addEventListener('click', function(e) {
  e.stopPropagation();
  togglePasswordVisibility(rootprvInput, showRootprvBtn, 'rootprv');
});

showAccountprvBtn.addEventListener('click', function(e) {
  e.stopPropagation();
  togglePasswordVisibility(accountprvInput, showAccountprvBtn, 'accountprv');
});

showDerivedprvBtn.addEventListener('click', function(e) {
  e.stopPropagation();
  togglePasswordVisibility(derivedprvInput, showDerivedprvBtn, 'derivedprv');
});

showBip85DerivedBtn.addEventListener('click', function(e) {
  e.stopPropagation();
  togglePasswordVisibility(bip85DerivedInput, showBip85DerivedBtn, 'bip85derived');
});

showPrivateKeyBtn.addEventListener('click', function(e) {
  e.stopPropagation();
  togglePasswordVisibility(privateKeyInput, showPrivateKeyBtn, 'private-key');
});

showBip38PassphraseBtn.addEventListener('click', function(e) {
  e.stopPropagation();
  toggleUpperSecretVisibility(bip38PassphraseInput, showBip38PassphraseBtn, 'bip38-passphrase');
});

showConfirmBip38PassphraseBtn.addEventListener('click', function(e) {
  e.stopPropagation();
  toggleUpperSecretVisibility(confirmBip38PassphraseInput, showConfirmBip38PassphraseBtn, 'confirm-bip38-passphrase');
});

showBip38KeyBtn.addEventListener('click', function(e) {
  e.stopPropagation();
  togglePasswordVisibility(bip38KeyInput, showBip38KeyBtn, 'bip38-key');
});

let bip38EncryptionRequestRevision = 0;
const emptyBip38EncryptedVariants = () => ({
  normal: { compressed: '', uncompressed: '' },
  hardened: { compressed: '', uncompressed: '' }
});
let bip38EncryptedVariants = emptyBip38EncryptedVariants();
let suppressBip38PassphraseInvalidation = false;

function clearBip38EncryptedVariants({ clearField = true } = {}) {
  bip38EncryptionRequestRevision += 1;
  bip38EncryptedVariants = emptyBip38EncryptedVariants();
  if (!clearField) return;
  clearData(bip38KeyInput);
  hidePassword(bip38KeyInput, showBip38KeyBtn, 'bip38-key');
}

function showSelectedBip38EncryptedKey() {
  const indexMode = hardenedIndexCheck.checked ? 'hardened' : 'normal';
  const variants = bip38EncryptedVariants[indexMode];
  const selectedKey = bip38KeyCompressedRadio.checked
    ? variants.compressed
    : variants.uncompressed;
  bip38KeyInput.value = selectedKey;
  bip38KeyInput.dispatchEvent(new Event('input', { bubbles: true }));
  if (isGlobalSecretRevealActive()) {
    revealSensitiveFields(['bip38-key']);
  }
}

function setBip38EncryptionProgress(value) {
  const normalized = Math.max(0, Math.min(1, Number(value) || 0));
  const current = Number.parseFloat(encryptBtn.style.getPropertyValue('--derivation-progress')) || 0;
  encryptBtn.style.setProperty('--derivation-progress', String(Math.max(current, normalized)));
}

async function setBip38EncryptionBusy(isBusy) {
  if (isBusy) {
    if (bip38EncryptionControlState) return;
    hideAllPasswords(sensitiveFields);
    bip38EncryptionControlState = lockOperationControls();
    createOverlay.appendChild(derivationInteractionBlocker);
    document.body.classList.add('derivation-busy-global');
    createOverlay.classList.add('derivation-busy');
    encryptBtn.classList.add('deriving-progress');
    encryptBtn.setAttribute('aria-busy', 'true');
    const progressLabel = document.createElement('span');
    progressLabel.className = 'deriving-progress-label';
    progressLabel.textContent = 'ENCRYPTING…';
    encryptBtn.replaceChildren(progressLabel);
    encryptBtn.style.setProperty('--derivation-progress', '0');
    return;
  }

  setBip38EncryptionProgress(1);
  await new Promise(resolve => setTimeout(resolve, 140));
  restoreOperationControls(bip38EncryptionControlState);
  bip38EncryptionControlState = null;
  derivationInteractionBlocker.remove();
  document.body.classList.remove('derivation-busy-global');
  createOverlay.classList.remove('derivation-busy');
  encryptBtn.classList.remove('deriving-progress');
  encryptBtn.removeAttribute('aria-busy');
  encryptBtn.style.removeProperty('--derivation-progress');
  encryptBtn.textContent = 'ENCRYPT';
}

let lastBip38EncryptPointerTime = 0;
function updateBip38PassphraseConfirmation() {
  const passphrase = bip38PassphraseInput.value;
  const confirmation = confirmBip38PassphraseInput.value;
  const wasExactMatch = confirmBip38PassphraseInput.dataset.matchesBip38Passphrase === 'true';

  bip38PassphraseInput.classList.remove('field-valid');
  confirmBip38PassphraseInput.classList.remove('field-valid', 'field-invalid', 'secret-mismatch');

  if (confirmation === '') {
    confirmBip38PassphraseInput.dataset.matchesBip38Passphrase = 'false';
    return false;
  }

  if (!passphrase.startsWith(confirmation)) {
    confirmBip38PassphraseInput.dataset.matchesBip38Passphrase = 'false';
    confirmBip38PassphraseInput.classList.add('secret-mismatch');
    return false;
  }

  const isExactMatch = passphrase !== '' && confirmation === passphrase;
  confirmBip38PassphraseInput.dataset.matchesBip38Passphrase = String(isExactMatch);

  if (isExactMatch && !wasExactMatch) {
    [bip38PassphraseInput, confirmBip38PassphraseInput].forEach(field => {
      field.classList.remove('field-valid');
      void field.offsetWidth;
      field.classList.add('field-valid');
    });
  }
  return isExactMatch;
}

function validateBip38Passphrase() {
  const hasPassphrase = bip38PassphraseInput.value.trim() !== '';
  const passphrasesMatch = updateBip38PassphraseConfirmation();
  if (!hasPassphrase) showFieldError(bip38PassphraseInput);
  if (!passphrasesMatch) {
    if (confirmBip38PassphraseInput.value === '' || bip38PassphraseInput.value.startsWith(confirmBip38PassphraseInput.value)) {
      showFieldError(confirmBip38PassphraseInput);
    } else {
      confirmBip38PassphraseInput.classList.add('secret-mismatch');
      common.shakeOnly(confirmBip38PassphraseInput.parentElement || confirmBip38PassphraseInput);
    }
  }
  return hasPassphrase && passphrasesMatch;
}
encryptBtn.addEventListener('pointerdown', function() {
  lastBip38EncryptPointerTime = performance.now();
  validateBip38Passphrase();
});
encryptBtn.addEventListener('click', async function() {
  if (performance.now() - lastBip38EncryptPointerTime > 500) validateBip38Passphrase();
  if (bip38PassphraseInput.value.trim() === '' || confirmBip38PassphraseInput.value !== bip38PassphraseInput.value) return;
  const normalSource = currentBip38Keys.find(entry => !entry.hardened);
  const hardenedSource = currentBip38Keys.find(entry => entry.hardened);
  if (mainCoinSelect.value !== 'btc' || !normalSource || !hardenedSource) {
    common.showFieldInvalid(privateKeyInput);
    setTimeout(() => {
      privateKeyInput.classList.remove('field-invalid');
      privateKeyInput.parentElement?.classList.remove('shake');
    }, 650);
    showStandaloneStatus('BIP38 encryption requires derived private keys.');
    return;
  }
  if (!bip38 || typeof bip38.encrypt !== 'function') {
    showStandaloneStatus('The local BIP38 module is unavailable.');
    return;
  }

  showStandaloneStatus('Encrypting Private Key...', { duration: null });
  clearBip38EncryptedVariants();
  const requestRevision = bip38EncryptionRequestRevision;
  const encryptionRevision = walletDerivationRevision;
  const encryptionPassphrase = bip38PassphraseInput.value;
  const variantProgress = {
    normalCompressed: 0,
    normalUncompressed: 0,
    hardenedCompressed: 0,
    hardenedUncompressed: 0
  };
  const encryptVariant = async (source, compressed, variant) => {
    const key = source.key.slice();
    try {
      const publicKeyBytes = secp256k1.privateToPublic(key, compressed);
      const bip38Address = await btc.address(publicKeyBytes, 'legacy', key);
      return await bip38.encrypt(key, encryptionPassphrase, bip38Address, compressed, progress => {
        variantProgress[variant] = progress;
        const totalProgress = Object.values(variantProgress).reduce((total, current) => total + current, 0);
        setBip38EncryptionProgress(totalProgress / 4);
      });
    } finally {
      key.fill(0);
    }
  };

  let completedBip38Variants = null;
  await setBip38EncryptionBusy(true);
  try {
    const [normalCompressed, normalUncompressed, hardenedCompressed, hardenedUncompressed] = await Promise.all([
      encryptVariant(normalSource, true, 'normalCompressed'),
      encryptVariant(normalSource, false, 'normalUncompressed'),
      encryptVariant(hardenedSource, true, 'hardenedCompressed'),
      encryptVariant(hardenedSource, false, 'hardenedUncompressed')
    ]);
    if (requestRevision !== bip38EncryptionRequestRevision) return;
    if (encryptionRevision !== walletDerivationRevision) {
      showStandaloneStatus('Wallet selection changed. Run BIP38 encryption again.');
      return;
    }

    suppressBip38PassphraseInvalidation = true;
    clearData(bip38PassphraseInput);
    hidePassword(bip38PassphraseInput, showBip38PassphraseBtn, 'bip38-passphrase');
    clearData(confirmBip38PassphraseInput);
    hidePassword(confirmBip38PassphraseInput, showConfirmBip38PassphraseBtn, 'confirm-bip38-passphrase');
    bip38PassphraseInput.classList.remove('field-error', 'field-invalid', 'field-valid', 'field-success', 'secret-mismatch', 'shake');
    confirmBip38PassphraseInput.classList.remove('field-error', 'field-invalid', 'field-valid', 'field-success', 'secret-mismatch', 'shake');
    confirmBip38PassphraseInput.dataset.matchesBip38Passphrase = 'false';
    completedBip38Variants = {
      normal: { compressed: normalCompressed, uncompressed: normalUncompressed },
      hardened: { compressed: hardenedCompressed, uncompressed: hardenedUncompressed }
    };
    bip38EncryptedVariants = completedBip38Variants;
    showSelectedBip38EncryptedKey();
    showStandaloneStatus('BIP38 ENCRYPTION COMPLETE');
  } catch (error) {
    if (requestRevision !== bip38EncryptionRequestRevision) return;
    showStandaloneStatus(error instanceof Error ? error.message : 'Unable to encrypt private keys.');
  } finally {
    await setBip38EncryptionBusy(false);
    suppressBip38PassphraseInvalidation = false;
    if (completedBip38Variants) {
      bip38EncryptedVariants = completedBip38Variants;
      showSelectedBip38EncryptedKey();
    }
  }
});

bip38PassphraseInput.addEventListener('input', function() {
  common.clearFieldFeedback(this);
  updateBip38PassphraseConfirmation();
  if (suppressBip38PassphraseInvalidation) return;
  if (this.value === '') return;
  clearBip38EncryptedVariants({ clearField: false });
  clearData(bip38KeyInput);
});

confirmBip38PassphraseInput.addEventListener('input', function() {
  this.classList.remove('field-error', 'field-invalid', 'field-valid', 'shake');
  updateBip38PassphraseConfirmation();
});

const subpanelHideTimers = new WeakMap();

function setSubpanelVisible(subpanel, visible) {
  const currentTimer = subpanelHideTimers.get(subpanel);
  if (currentTimer) clearTimeout(currentTimer);

  if (visible) {
    subpanel.classList.add('mounted');
    void subpanel.offsetWidth;
    subpanel.classList.add('visible');
    return;
  }

  subpanel.classList.remove('visible', 'mounted');
  subpanelHideTimers.delete(subpanel);
}

bip85Check.addEventListener('change', function() {
  setSubpanelVisible(bip85Fields, this.checked);
});

bip39PassphraseCheck.addEventListener('change', function() {
  setSubpanelVisible(passphraseSubpanel, this.checked);
  if (this.checked) return;

  clearData(bip39PassphraseInput);
  hidePassword(bip39PassphraseInput, showBip39PassphraseBtn, 'bip39-passphrase');
  clearData(confirmPassphraseInput);
  hidePassword(confirmPassphraseInput, showConfirmPassphraseBtn, 'confirm-bip39-passphrase');
  confirmPassphraseInput.dataset.matchesPassphrase = 'false';
  updateBip39Seed().catch(() => {});
});

bip38EncryptionCheck.addEventListener('change', function() {
  setSubpanelVisible(bip38Subpanel, this.checked);
  if (this.checked) {
    if (isGlobalSecretRevealActive()) {
      revealSensitiveFields(['bip38-passphrase', 'confirm-bip38-passphrase', 'bip38-key']);
    }
    return;
  }
  clearData(bip38PassphraseInput);
  hidePassword(bip38PassphraseInput, showBip38PassphraseBtn, 'bip38-passphrase');
  clearData(confirmBip38PassphraseInput);
  hidePassword(confirmBip38PassphraseInput, showConfirmBip38PassphraseBtn, 'confirm-bip38-passphrase');
  confirmBip38PassphraseInput.dataset.matchesBip38Passphrase = 'false';
  clearBip38EncryptedVariants();
});

addressDetailsCheck.addEventListener('change', function() {
  setSubpanelVisible(addressDetailsSubpanel, this.checked);
});

function updateBip85DerivationFields() {
  const derivation = bip85DerivationSelect.value;
  bip85DerivedLabel.textContent = ({
    'hexadecimal-entropy': 'DERIVED HEX ENTROPY',
    'bip39-mnemonic': 'DERIVED BIP39 MNEMONIC',
    'bip32-xprv': 'DERIVED BIP32 XPRV',
    'private-key-wif': 'DERIVED WIF'
  })[derivation] || 'DERIVED';
  const usesBits = derivation === 'hexadecimal-entropy';
  const isMnemonic = derivation === 'bip39-mnemonic';
  const isLocked = derivation === 'bip32-xprv' || derivation === 'private-key-wif';

  if (usesBits) {
    lastBip85SecondaryMenu = 'bits';
    const bitValues = ['128', '160', '192', '224', '256', '512'];
    bip85BitsSelect.replaceChildren(...bitValues.map(value => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = value;
      return option;
    }));
  } else if (isMnemonic) {
    lastBip85SecondaryMenu = 'length';
  }

  const showBits = isLocked
    ? lastBip85SecondaryMenu === 'bits'
    : usesBits;
  bip85LengthGroup.classList.toggle('hidden', showBits);
  bip85BitsGroup.classList.toggle('visible', showBits);

  bip85LengthSelect.disabled = isLocked || showBits;
  bip85BitsSelect.disabled = isLocked || !showBits;
}

bip85DerivationSelect.addEventListener('change', updateBip85DerivationFields);
updateBip85DerivationFields();

bip85IndexInput.addEventListener('input', function() {
  const digits = this.value.replace(/\D/g, '');
  this.value = digits.replace(/^0+(?=\d)/, '');
  if (this.value !== '') refreshBip85Derivation();
});

function toggleKdfSettings() {
  if (!kdfSettingsCheck || !kdfSettingsFields) return;
  setSubpanelVisible(kdfSettingsFields, kdfSettingsCheck.checked);
  if (kdfSettingsCheck.checked) return;

  clearData(additionalSecretInput);
  hidePassword(additionalSecretInput, showAdditionalSecretBtn, 'additional');
  clearData(confirmAdditionalSecretInput);
  hidePassword(confirmAdditionalSecretInput, showConfirmAdditionalSecretBtn, 'confirm-additional');
  additionalSecretInput.classList.remove('field-error', 'field-invalid', 'field-valid', 'field-success', 'secret-mismatch', 'shake');
  confirmAdditionalSecretInput.classList.remove('field-error', 'field-invalid', 'field-valid', 'field-success', 'secret-mismatch', 'shake');
  confirmAdditionalSecretInput.dataset.matchesAdditional = 'false';
}

function updateKdfFields() {
  if (!kdfTypeSelect || !kdfScryptFields || !kdfPbkdf2Fields) return;
  const type = kdfTypeSelect.value;
  if (type === 'scrypt') {
    kdfScryptFields.classList.remove('hidden');
    kdfScryptFields.classList.add('flex');
    kdfPbkdf2Fields.classList.remove('flex');
    kdfPbkdf2Fields.classList.add('hidden');
  } else {
    kdfScryptFields.classList.remove('flex');
    kdfScryptFields.classList.add('hidden');
    kdfPbkdf2Fields.classList.remove('hidden');
    kdfPbkdf2Fields.classList.add('flex');
    updateIterations();
  }
}

function updateIterations() {
  if (!kdfPrfSelect || !kdfIterationsInput) return;
  const prf = kdfPrfSelect.value;
  let value = getIterationsForPrf(prf);
  kdfIterationsInput.value = value;
  kdfIterationsInput.dataset.defaultValue = value;
}

function normalizeKdfInput(input) {
  let val = input.value.trim();
  let defaultValue = input.dataset.defaultValue || '8';
  if (val === '' || val === '0' || val === '00' || val === '000' || val === '01' || val === '001' || val === '02' || val === '002') {
    input.value = defaultValue;
    return;
  }
  let num = parseInt(val, 10);
  if (isNaN(num) || num < 1) {
    input.value = defaultValue;
    return;
  }
  input.value = String(num);
}

function setupKdfInput(input, defaultValue) {
  input.dataset.defaultValue = defaultValue || '8';
  input.addEventListener('blur', function() {
    normalizeKdfInput(this);
  });
  input.addEventListener('input', function() {
    let val = this.value;
    if (val === '0') {
      this.value = '';
      return;
    }
    if (val.startsWith('0') && val.length > 1) {
      let num = parseInt(val, 10);
      if (!isNaN(num)) {
        this.value = String(num);
      }
    }
    let num = parseInt(this.value, 10);
    if (!isNaN(num) && num >= 1) {
      this.value = String(num);
    }
  });
}

function getParamsFromUI() {
  if (!kdfTypeSelect) return null;
  if (kdfTypeSelect.value === 'scrypt') {
    return {
      algorithm: 'scrypt',
      n: Number.parseInt(kdfNSelect?.value || KDF_DEFAULTS.scrypt.n, 10),
      r: Number.parseInt(kdfRInput?.value || KDF_DEFAULTS.scrypt.r, 10),
      p: Number.parseInt(kdfPInput?.value || KDF_DEFAULTS.scrypt.p, 10),
      kdlen: Number.parseInt(kdlenSelect?.value || '16', 10)
    };
  }
  return {
    algorithm: 'pbkdf2',
    prf: kdfPrfSelect?.value || KDF_DEFAULTS.pbkdf2.prf,
    iterations: Number.parseInt(kdfIterationsInput?.value || KDF_DEFAULTS.pbkdf2.iterations, 10),
    kdlen: Number.parseInt(kdlenSelect?.value || '16', 10)
  };
}

function updatePrimarySecretConfirmation() {
  const primarySecret = primarySecretInput.value;
  const confirmation = confirmPrimarySecretInput.value;
  const wasExactMatch = confirmPrimarySecretInput.dataset.matchesPrimary === 'true';

  primarySecretInput.classList.remove('field-valid');
  confirmPrimarySecretInput.classList.remove('field-valid');
  confirmPrimarySecretInput.classList.remove('field-invalid', 'secret-mismatch');

  if (confirmation === '') {
    confirmPrimarySecretInput.dataset.matchesPrimary = 'false';
    return;
  }

  if (!primarySecret.startsWith(confirmation)) {
    confirmPrimarySecretInput.dataset.matchesPrimary = 'false';
    confirmPrimarySecretInput.classList.add('secret-mismatch');
    return;
  }

  const isExactMatch = primarySecret !== '' && confirmation === primarySecret;
  confirmPrimarySecretInput.dataset.matchesPrimary = String(isExactMatch);

  if (isExactMatch && !wasExactMatch) {
    [primarySecretInput, confirmPrimarySecretInput].forEach(field => {
      field.classList.remove('field-valid');
      void field.offsetWidth;
      field.classList.add('field-valid');
    });
  }
}

function updateAdditionalSecretConfirmation() {
  const additionalSecret = additionalSecretInput.value;
  const confirmation = confirmAdditionalSecretInput.value;
  const wasExactMatch = confirmAdditionalSecretInput.dataset.matchesAdditional === 'true';

  additionalSecretInput.classList.remove('field-valid');
  confirmAdditionalSecretInput.classList.remove('field-valid', 'field-invalid', 'secret-mismatch');

  if (confirmation === '') {
    confirmAdditionalSecretInput.dataset.matchesAdditional = 'false';
    return;
  }

  if (!additionalSecret.startsWith(confirmation)) {
    confirmAdditionalSecretInput.dataset.matchesAdditional = 'false';
    confirmAdditionalSecretInput.classList.add('secret-mismatch');
    return;
  }

  const isExactMatch = additionalSecret !== '' && confirmation === additionalSecret;
  confirmAdditionalSecretInput.dataset.matchesAdditional = String(isExactMatch);

  if (isExactMatch && !wasExactMatch) {
    [additionalSecretInput, confirmAdditionalSecretInput].forEach(field => {
      field.classList.remove('field-valid');
      void field.offsetWidth;
      field.classList.add('field-valid');
    });
  }
}

function updatePassphraseConfirmation() {
  const passphrase = bip39PassphraseInput.value;
  const confirmation = confirmPassphraseInput.value;
  const wasExactMatch = confirmPassphraseInput.dataset.matchesPassphrase === 'true';

  bip39PassphraseInput.classList.remove('field-valid');
  confirmPassphraseInput.classList.remove('field-valid', 'field-invalid', 'secret-mismatch');

  if (confirmation === '') {
    confirmPassphraseInput.dataset.matchesPassphrase = String(passphrase === '');
    return passphrase === '';
  }

  if (!passphrase.startsWith(confirmation)) {
    confirmPassphraseInput.dataset.matchesPassphrase = 'false';
    confirmPassphraseInput.classList.add('secret-mismatch');
    return false;
  }

  const isExactMatch = confirmation === passphrase;
  confirmPassphraseInput.dataset.matchesPassphrase = String(isExactMatch);

  if (isExactMatch && !wasExactMatch) {
    [bip39PassphraseInput, confirmPassphraseInput].forEach(field => {
      field.classList.remove('field-valid');
      void field.offsetWidth;
      field.classList.add('field-valid');
    });
  }
  return isExactMatch;
}

function refreshBip39PassphraseDerivation() {
  if (!updatePassphraseConfirmation()) {
    bip39SeedRevision += 1;
    walletDerivationRevision += 1;
    return;
  }
  updateBip39Seed().catch(() => {});
}

function showStandaloneStatus(message, { duration = 1500 } = {}) {
  clearTimeout(wallexTransientStatusTimer);
  wallexTransientStatusActive = true;
  wallexMainConnectionIndicator.classList.add('hidden');
  wallexMainStatusMode.textContent = String(message).toUpperCase();
  if (duration === null) return;
  wallexTransientStatusTimer = setTimeout(() => {
    wallexTransientStatusActive = false;
    wallexMainConnectionIndicator.classList.remove('hidden');
    updateWallexMainBar();
  }, duration);
}

function reportSensitiveToggle(button, element, label) {
  if (isGlobalSecretRevealActive()) return true;
  const message = `${label} ${isPasswordVisible(element) ? 'Hidden' : 'Shown'}`;
  queueMicrotask(() => showStandaloneStatus(message));
  return true;
}

document.addEventListener('click', event => {
  if (!event.isTrusted) return;
  const button = event.target instanceof Element ? event.target.closest('button') : null;
  if (!button || (!createOverlay.contains(button) && !clearDataConfirmOverlay.contains(button))) return;
  const reportCompletedAction = (message, options) => {
    queueMicrotask(() => showStandaloneStatus(message, options));
  };

  const sensitiveActions = new Map([
    [showPrimarySecretBtn, [() => primarySecretInput, 'Primary Secret']],
    [showConfirmPrimarySecretBtn, [() => confirmPrimarySecretInput, 'Primary Secret Confirmation']],
    [showAdditionalSecretBtn, [() => additionalSecretInput, 'Additional Secret']],
    [showConfirmAdditionalSecretBtn, [() => confirmAdditionalSecretInput, 'Additional Secret Confirmation']],
    [showEntropyBtn, [() => entropyInput, 'BIP39 Entropy']],
    [showMnemonicBtn, [() => mnemonicInput, 'BIP39 Mnemonic']],
    [showBip39PassphraseBtn, [() => bip39PassphraseInput, 'BIP39 Passphrase']],
    [showConfirmPassphraseBtn, [() => confirmPassphraseInput, 'BIP39 Passphrase Confirmation']],
    [showSeedBtn, [() => seedInput, 'BIP39 Seed']],
    [showRootprvBtn, [() => rootprvInput, 'BIP32 Root Private Key']],
    [showAccountprvBtn, [() => accountprvInput, 'Account Private Key']],
    [showDerivedprvBtn, [() => derivedprvInput, 'Derived Private Key']],
    [showBip85DerivedBtn, [() => bip85DerivedInput, 'BIP85 Derived Value']],
    [showPrivateKeyBtn, [() => privateKeyInput, 'Private Key']],
    [showBip38PassphraseBtn, [() => bip38PassphraseInput, 'BIP38 Passphrase']],
    [showConfirmBip38PassphraseBtn, [() => confirmBip38PassphraseInput, 'BIP38 Passphrase Confirmation']],
    [showBip38KeyBtn, [() => bip38KeyInput, 'BIP38 Encrypted Private Key']]
  ]);
  const sensitiveAction = sensitiveActions.get(button);
  if (sensitiveAction) {
    reportSensitiveToggle(button, sensitiveAction[0](), sensitiveAction[1]);
    return;
  }

  if (button === wallexMainExpertBtn) {
    reportCompletedAction(`Advanced Mode ${button.getAttribute('aria-pressed') === 'true' ? 'Disabled' : 'Enabled'}`);
  } else if (button === wallexMainRevealBtn) {
    reportCompletedAction(`All Secrets ${button.getAttribute('aria-pressed') === 'true' ? 'Hidden' : 'Revealed'}`);
  }
}, true);

document.addEventListener('change', event => {
  const control = event.target;
  if (!(control instanceof HTMLInputElement)) return;
  if (!createOverlay.contains(control)) return;

  if (control === privateKeyHexCheck) {
    privateKeyCompressedRadio.disabled = control.checked;
    privateKeyUncompressedRadio.disabled = control.checked;
    showStandaloneStatus(`Private Key HEX ${control.checked ? 'Enabled' : 'Disabled'}`);
    return;
  }

  if (control.type === 'radio') {
    if (control.name === 'privateKeyCompression') {
      showStandaloneStatus(`Private Key: ${control.value === 'compressed' ? 'Compressed' : 'Uncompressed'}`);
    } else if (control.name === 'publicKeyCompression') {
      showStandaloneStatus(`Public Key: ${control.value === 'compressed' ? 'Compressed' : 'Uncompressed'}`);
    } else if (control.name === 'bip38KeyCompression') {
      showStandaloneStatus(`BIP38 Private Key: ${control.value === 'compressed' ? 'Compressed' : 'Uncompressed'}`);
    }
  }
});

let entropyGeneratedFeedbackTimer = null;

function showEntropyGeneratedFeedback() {
  if (entropyInput.getClientRects().length === 0) return;
  clearTimeout(entropyGeneratedFeedbackTimer);
  const wrapper = entropyInput.parentElement;
  entropyInput.classList.remove('field-valid');
  wrapper?.classList.remove('shake');
  void entropyInput.offsetWidth;
  if (wrapper) void wrapper.offsetWidth;
  entropyInput.classList.add('field-valid');
  wrapper?.classList.add('shake');
  const feedbackElement = entropyInput;
  entropyGeneratedFeedbackTimer = setTimeout(() => {
    feedbackElement.classList.remove('field-valid');
    wrapper?.classList.remove('shake');
    entropyGeneratedFeedbackTimer = null;
  }, 650);
}

let bip39SeedRevision = 0;
let sensitiveOperationEpoch = 0;
let walletDerivationRevision = 0;
let currentBip38Keys = [];
let cachedWalletRoot = null;
let cachedWalletRootPromise = null;
let walletRootCacheEpoch = 0;

function clearWalletRoot(root) {
  root?.key?.fill(0);
  root?.chainCode?.fill(0);
  root?.parentFingerprint?.fill(0);
}

function clearCachedWalletRoot() {
  walletRootCacheEpoch += 1;
  clearWalletRoot(cachedWalletRoot);
  cachedWalletRoot = null;
  cachedWalletRootPromise = null;
}

function getCachedWalletRoot() {
  if (cachedWalletRoot) return Promise.resolve(cachedWalletRoot);
  if (cachedWalletRootPromise) return cachedWalletRootPromise;

  const cacheEpoch = walletRootCacheEpoch;
  const rootPromise = bip32.master(seedInput.value).then(root => {
    if (cacheEpoch !== walletRootCacheEpoch) {
      clearWalletRoot(root);
      throw new Error('Wallet root cache invalidated.');
    }
    cachedWalletRoot = root;
    return root;
  }).finally(() => {
    if (cachedWalletRootPromise === rootPromise) cachedWalletRootPromise = null;
  });
  cachedWalletRootPromise = rootPromise;
  return rootPromise;
}

function replaceCurrentBip38Keys(nextKeys = [], { preserveEncryptedVariants = false } = {}) {
  if (!preserveEncryptedVariants) clearBip38EncryptedVariants();
  currentBip38Keys.forEach(entry => entry.key.fill(0));
  currentBip38Keys = nextKeys;
}

function updatePrivateKeyResultOptionsVisibility() {
  const expertMode = wallexMainExpertBtn.getAttribute('aria-pressed') === 'true';
  const usesLegacyBitcoin = mainCoinSelect.value === 'btc' && mainAddressTypeSelect.value === 'legacy';
  const usesEthTrxKeyFormats = mainCoinSelect.value === 'eth' || mainCoinSelect.value === 'trx';
  privateKeyResultOptions.classList.toggle('hidden', !expertMode || !usesLegacyBitcoin);
  publicKeyResultOptions.classList.toggle('hidden', !expertMode || !usesEthTrxKeyFormats);
}

async function refreshLegacyBitcoinResults() {
  updatePrivateKeyResultOptionsVisibility();
  if (mainCoinSelect.value !== 'btc' || mainAddressTypeSelect.value !== 'legacy' || currentBip38Keys.length === 0) return;

  const revision = ++walletDerivationRevision;
  const source = currentBip38Keys.find(entry => entry.hardened === hardenedIndexCheck.checked);
  if (!source) return;
  const key = source.key.slice();
  const compressed = privateKeyCompressedRadio.checked;
  try {
    const publicKeyBytes = secp256k1.privateToPublic(key, compressed);
    const privateKey = privateKeyHexCheck.checked ? btc.hex(key) : await btc.wif(key, compressed);
    const publicKey = btc.hex(publicKeyBytes);
    const address = await btc.address(publicKeyBytes, 'legacy', key);
    if (revision !== walletDerivationRevision) return;

    source.bip38Address = address;
    source.compressed = compressed;
    privateKeyInput.value = privateKey;
    publicKeyInput.value = publicKey;
    addressInput.value = address;
    privateKeyInput.dispatchEvent(new Event('input', { bubbles: true }));
    publicKeyInput.dispatchEvent(new Event('input', { bubbles: true }));
    addressInput.dispatchEvent(new Event('input', { bubbles: true }));
  } finally {
    key.fill(0);
  }
}

async function updateBip39Seed(expectedEpoch = sensitiveOperationEpoch) {
  const revision = ++bip39SeedRevision;
  walletDerivationRevision += 1;
  replaceCurrentBip38Keys();
  const mnemonic = mnemonicInput.value;
  if (mnemonic === '') {
    clearCachedWalletRoot();
    bip85DerivationRevision += 1;
    seedInput.value = '';
    seedInput.dispatchEvent(new Event('input', { bubbles: true }));
    rootprvInput.value = '';
    rootpubInput.value = '';
    accountprvInput.value = '';
    accountpubInput.value = '';
    derivedprvInput.value = '';
    derivedpubInput.value = '';
    bip85DerivedInput.value = '';
    privateKeyInput.value = '';
    publicKeyInput.value = '';
    addressInput.value = '';
    privateKeyInput.dispatchEvent(new Event('input', { bubbles: true }));
    publicKeyInput.dispatchEvent(new Event('input', { bubbles: true }));
    addressInput.dispatchEvent(new Event('input', { bubbles: true }));
    accountprvInput.dispatchEvent(new Event('input', { bubbles: true }));
    accountpubInput.dispatchEvent(new Event('input', { bubbles: true }));
    derivedprvInput.dispatchEvent(new Event('input', { bubbles: true }));
    derivedpubInput.dispatchEvent(new Event('input', { bubbles: true }));
    replaceCurrentBip38Keys();
    return;
  }
  if (!bip39 || typeof bip39.mnemonicToSeed !== 'function') {
    throw new Error('The local BIP39 seed module is unavailable.');
  }
  if (bip39PassphraseCheck.checked && bip39PassphraseInput.value !== confirmPassphraseInput.value) return;
  const passphrase = bip39PassphraseCheck.checked ? bip39PassphraseInput.value : '';
  const nextSeed = await bip39.mnemonicToSeed(mnemonic, passphrase);
  if (revision !== bip39SeedRevision || expectedEpoch !== sensitiveOperationEpoch) return;
  clearCachedWalletRoot();
  seedInput.value = nextSeed;
  seedInput.dispatchEvent(new Event('input', { bubbles: true }));
  await updateWalletDerivation(expectedEpoch);
}

async function updateWalletDerivation(
  expectedEpoch = sensitiveOperationEpoch,
  { preserveBip38EncryptedVariants = false } = {}
) {
  const revision = ++walletDerivationRevision;
  if (!seedInput.value) return;
  const preservedScrollTop = createOverlay.scrollTop;
  if (!bip32 || !secp256k1 || !btc || !eth || !trx) {
    throw new Error('The local wallet derivation modules are unavailable.');
  }

  // Prevent BIP38 from acting on keys belonging to the previous selection
  // while this derivation is still in progress.
  replaceCurrentBip38Keys([], { preserveEncryptedVariants: preserveBip38EncryptedVariants });
  accountprvInput.value = '';
  accountpubInput.value = '';
  derivedprvInput.value = '';
  derivedpubInput.value = '';

  const root = await getCachedWalletRoot();
  if (revision !== walletDerivationRevision || expectedEpoch !== sensitiveOperationEpoch) return;
  const extendedKeyVersions = getMainExtendedKeyVersions();
  updateMainExtendedKeyLabels(extendedKeyVersions);
  const coin = mainCoinSelect.value;
  const addressType = mainAddressTypeSelect.value;
  const basePath = getMainBaseDerivationPath();
  const accountPath = basePath === 'm' ? 'm' : basePath.slice(0, basePath.lastIndexOf('/'));
  const normalPath = `${basePath}/${mainAddressIndex}`;
  const hardenedPath = `${basePath}/${mainAddressIndex}'`;
  const nextBip38Keys = [];
  const addressNodesPromise = coin === 'btc'
    ? Promise.all([
      bip32.derive(root, normalPath),
      bip32.derive(root, hardenedPath)
    ])
    : bip32.derive(root, hardenedIndexCheck.checked ? hardenedPath : normalPath);
  const [rootPrv, rootPub, accountNode, derivedNode, addressNodes] = await Promise.all([
    bip32.serialize(root, true, extendedKeyVersions.private),
    bip32.serialize(root, false, extendedKeyVersions.public),
    bip32.derive(root, accountPath),
    bip32.derive(root, basePath),
    addressNodesPromise
  ]);
  if (revision !== walletDerivationRevision || expectedEpoch !== sensitiveOperationEpoch) return;
  const [accountPrv, accountPub, derivedPrv, derivedPub] = await Promise.all([
    bip32.serialize(accountNode, true, extendedKeyVersions.private),
    bip32.serialize(accountNode, false, extendedKeyVersions.public),
    bip32.serialize(derivedNode, true, extendedKeyVersions.private),
    bip32.serialize(derivedNode, false, extendedKeyVersions.public)
  ]);
  if (revision !== walletDerivationRevision || expectedEpoch !== sensitiveOperationEpoch) return;

  rootprvInput.value = rootPrv;
  rootpubInput.value = rootPub;
  accountprvInput.value = accountPrv;
  accountpubInput.value = accountPub;
  derivedprvInput.value = derivedPrv;
  derivedpubInput.value = derivedPub;
  rootprvInput.dispatchEvent(new Event('input', { bubbles: true }));
  rootpubInput.dispatchEvent(new Event('input', { bubbles: true }));
  accountprvInput.dispatchEvent(new Event('input', { bubbles: true }));
  accountpubInput.dispatchEvent(new Event('input', { bubbles: true }));
  derivedprvInput.dispatchEvent(new Event('input', { bubbles: true }));
  derivedpubInput.dispatchEvent(new Event('input', { bubbles: true }));
  let normalNode = null;
  let hardenedNode = null;
  let node;
  if (coin === 'btc') {
    [normalNode, hardenedNode] = addressNodes;
    node = hardenedIndexCheck.checked ? hardenedNode : normalNode;
  } else {
    node = addressNodes;
  }
  const compressedPublicKey = secp256k1.privateToPublic(node.key, true);
  let privateKey;
  let publicKey;
  let address;

  if (coin === 'btc') {
    const usesLegacyOptions = addressType === 'legacy';
    const compressed = !usesLegacyOptions || privateKeyCompressedRadio.checked;
    const publicKeyBytes = compressed ? compressedPublicKey : secp256k1.privateToPublic(node.key, false);
    publicKey = btc.hex(publicKeyBytes);
    [privateKey, address] = await Promise.all([
      usesLegacyOptions && privateKeyHexCheck.checked
        ? Promise.resolve(btc.hex(node.key))
        : btc.wif(node.key, compressed),
      btc.address(publicKeyBytes, addressType, node.key)
    ]);
    nextBip38Keys.push(
      { key: normalNode.key.slice(), hardened: false },
      { key: hardenedNode.key.slice(), hardened: true }
    );
  } else if (coin === 'eth') {
    const privateKeyHex = btc.hex(node.key);
    const publicKeyHex = btc.hex(secp256k1.privateToPublic(node.key, publicKeyCompressedRadio.checked));
    privateKey = privateKeyHex;
    publicKey = publicKeyHex;
    address = eth.address(node.key);
  } else {
    const privateKeyHex = btc.hex(node.key);
    const publicKeyHex = btc.hex(secp256k1.privateToPublic(node.key, publicKeyCompressedRadio.checked));
    privateKey = privateKeyHex;
    publicKey = publicKeyHex;
    address = await trx.address(node.key);
  }

  if (revision !== walletDerivationRevision || expectedEpoch !== sensitiveOperationEpoch) {
    nextBip38Keys.forEach(entry => entry.key.fill(0));
    return;
  }
  replaceCurrentBip38Keys(nextBip38Keys, { preserveEncryptedVariants: preserveBip38EncryptedVariants });
  privateKeyInput.value = privateKey;
  publicKeyInput.value = publicKey;
  addressInput.value = address;
  privateKeyInput.dispatchEvent(new Event('input', { bubbles: true }));
  publicKeyInput.dispatchEvent(new Event('input', { bubbles: true }));
  addressInput.dispatchEvent(new Event('input', { bubbles: true }));
  await updateBip85Derivation(root, expectedEpoch);
  const restoreScrollPosition = () => {
    createOverlay.scrollTop = preservedScrollTop;
  };
  restoreScrollPosition();
  requestAnimationFrame(restoreScrollPosition);
}

let bip85DerivationRevision = 0;

async function updateBip85Derivation(existingRoot = null, expectedEpoch = sensitiveOperationEpoch) {
  if (!bip85Check.checked || !seedInput.value) return;
  if (!bip85 || typeof bip85.derive !== 'function') {
    throw new Error('The local BIP85 module is unavailable.');
  }

  const revision = ++bip85DerivationRevision;
  const type = bip85DerivationSelect.value;
  const root = existingRoot || await getCachedWalletRoot();
  const result = await bip85.derive(root, {
    type,
    words: bip85LengthSelect.value,
    bits: bip85BitsSelect.value,
    index: bip85IndexInput.value || '0'
  });

  if (revision !== bip85DerivationRevision || expectedEpoch !== sensitiveOperationEpoch) return;
  bip85DerivedInput.value = result.value;
  bip85DerivedInput.dispatchEvent(new Event('input', { bubbles: true }));
}

function refreshBip85Derivation() {
  if (!bip85Check.checked || !seedInput.value) return;
  updateBip85Derivation().catch(() => {});
}

bip85Check.addEventListener('change', refreshBip85Derivation);
[bip85DerivationSelect, bip85LengthSelect, bip85BitsSelect]
  .forEach(element => element.addEventListener('change', refreshBip85Derivation));

function refreshDisplayedWalletDerivation({ preserveBip38EncryptedVariants = false } = {}) {
  updatePrivateKeyResultOptionsVisibility();
  updateMainExtendedKeyLabels();
  if (!seedInput.value) return;
  updateWalletDerivation(sensitiveOperationEpoch, { preserveBip38EncryptedVariants }).catch(() => {});
}

[privateKeyCompressedRadio, privateKeyUncompressedRadio, privateKeyHexCheck]
  .forEach(element => element.addEventListener('change', () => {
    refreshLegacyBitcoinResults().catch(error => {
      showStandaloneStatus(error instanceof Error ? error.message : 'Unable to update the Bitcoin key format.');
    });
  }));

[publicKeyCompressedRadio, publicKeyUncompressedRadio]
  .forEach(element => element.addEventListener('change', refreshDisplayedWalletDerivation));

const privateKeyCompressionRadios = [privateKeyCompressedRadio, privateKeyUncompressedRadio];
let privateKeyRadioTabDirection = 1;
const publicKeyCompressionRadios = [publicKeyCompressedRadio, publicKeyUncompressedRadio];
let publicKeyRadioTabDirection = 1;
const bip38KeyCompressionRadios = [bip38KeyCompressedRadio, bip38KeyUncompressedRadio];
let bip38KeyRadioTabDirection = 1;

bip38KeyCompressionRadios.forEach(radio => {
  radio.addEventListener('change', showSelectedBip38EncryptedKey);
});

createOverlay.addEventListener('keydown', event => {
  if (event.key !== 'Tab') return;
  privateKeyRadioTabDirection = event.shiftKey ? -1 : 1;
  publicKeyRadioTabDirection = event.shiftKey ? -1 : 1;
  bip38KeyRadioTabDirection = event.shiftKey ? -1 : 1;
}, true);

publicKeyResultOptions.addEventListener('focusin', event => {
  if (!document.documentElement.classList.contains('keyboard-navigation')) return;
  if (!publicKeyCompressionRadios.includes(event.target)) return;
  if (publicKeyCompressionRadios.includes(event.relatedTarget)) return;

  const entryRadio = publicKeyRadioTabDirection < 0
    ? publicKeyUncompressedRadio
    : publicKeyCompressedRadio;
  if (event.target !== entryRadio) entryRadio.focus({ preventScroll: true });
});

publicKeyCompressionRadios.forEach(radio => {
  radio.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    if (radio === publicKeyCompressedRadio && !event.shiftKey) {
      event.preventDefault();
      publicKeyUncompressedRadio.focus({ preventScroll: true });
    } else if (radio === publicKeyUncompressedRadio && event.shiftKey) {
      event.preventDefault();
      publicKeyCompressedRadio.focus({ preventScroll: true });
    }
  });
});

bip38KeyResultOptions.addEventListener('focusin', event => {
  if (!document.documentElement.classList.contains('keyboard-navigation')) return;
  if (!bip38KeyCompressionRadios.includes(event.target)) return;
  if (bip38KeyCompressionRadios.includes(event.relatedTarget)) return;

  const entryRadio = bip38KeyRadioTabDirection < 0
    ? bip38KeyUncompressedRadio
    : bip38KeyCompressedRadio;
  if (event.target !== entryRadio) entryRadio.focus({ preventScroll: true });
});

bip38KeyCompressionRadios.forEach(radio => {
  radio.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    if (radio === bip38KeyCompressedRadio && !event.shiftKey) {
      event.preventDefault();
      bip38KeyUncompressedRadio.focus({ preventScroll: true });
    } else if (radio === bip38KeyUncompressedRadio && event.shiftKey) {
      event.preventDefault();
      bip38KeyCompressedRadio.focus({ preventScroll: true });
    }
  });
});

privateKeyResultOptions.addEventListener('focusin', event => {
  if (!document.documentElement.classList.contains('keyboard-navigation')) return;
  if (!privateKeyCompressionRadios.includes(event.target)) return;
  if (privateKeyCompressionRadios.includes(event.relatedTarget)) return;

  const entryRadio = privateKeyRadioTabDirection < 0
    ? privateKeyUncompressedRadio
    : privateKeyCompressedRadio;
  if (event.target !== entryRadio) entryRadio.focus({ preventScroll: true });
});

privateKeyCompressionRadios.forEach(radio => {
  radio.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    if (radio === privateKeyCompressedRadio && !event.shiftKey) {
      event.preventDefault();
      privateKeyUncompressedRadio.focus({ preventScroll: true });
    } else if (radio === privateKeyUncompressedRadio && event.shiftKey) {
      event.preventDefault();
      privateKeyCompressedRadio.focus({ preventScroll: true });
    }
  });
});

[mainCoinSelect, mainAddressTypeSelect, mainStandardSelect, mainChangeSelect].forEach(element => {
  element.addEventListener('change', refreshDisplayedWalletDerivation);
});

const isValidPartialAddressIndex = value => value === '' || /^\d+['hH]?$/.test(value);
let lastValidAddressIndexValue = mainAddressIndexInput.value;
let lastValidAddressIndexSelectionStart = mainAddressIndexInput.value.length;
let lastValidAddressIndexSelectionEnd = mainAddressIndexInput.value.length;

function rememberValidAddressIndex() {
  lastValidAddressIndexValue = mainAddressIndexInput.value;
  lastValidAddressIndexSelectionStart = mainAddressIndexInput.selectionStart ?? mainAddressIndexInput.value.length;
  lastValidAddressIndexSelectionEnd = mainAddressIndexInput.selectionEnd ?? lastValidAddressIndexSelectionStart;
}

function getAddressIndexAfterInsertion(insertedText) {
  const start = mainAddressIndexInput.selectionStart ?? mainAddressIndexInput.value.length;
  const end = mainAddressIndexInput.selectionEnd ?? start;
  return mainAddressIndexInput.value.slice(0, start) + insertedText + mainAddressIndexInput.value.slice(end);
}

mainAddressIndexInput.addEventListener('beforeinput', event => {
  if (event.inputType.startsWith('delete') || event.data === null) return;
  if (!isValidPartialAddressIndex(getAddressIndexAfterInsertion(event.data))) event.preventDefault();
});

mainAddressIndexInput.addEventListener('paste', event => {
  const pastedText = event.clipboardData?.getData('text') ?? '';
  if (!isValidPartialAddressIndex(getAddressIndexAfterInsertion(pastedText))) event.preventDefault();
});

mainAddressIndexInput.addEventListener('drop', event => {
  const droppedText = event.dataTransfer?.getData('text') ?? '';
  if (!isValidPartialAddressIndex(getAddressIndexAfterInsertion(droppedText))) event.preventDefault();
});

mainAddressIndexInput.addEventListener('input', function() {
  if (!isValidPartialAddressIndex(this.value)) {
    this.value = lastValidAddressIndexValue;
    this.setSelectionRange(lastValidAddressIndexSelectionStart, lastValidAddressIndexSelectionEnd);
    return;
  }

  if (this.value === '') {
    rememberValidAddressIndex();
    if (!hardenedIndexCheck.checked) return;
    hardenedIndexCheck.checked = false;
    syncMainDerivationPathFromIndex();
    showSelectedBip38EncryptedKey();
    refreshDisplayedWalletDerivation({ preserveBip38EncryptedVariants: true });
    return;
  }

  const suffix = this.value.match(/['hH]$/)?.[0] ?? '';
  const digits = this.value.slice(0, suffix ? -1 : undefined).replace(/^0+(?=\d)/, '');
  const normalizedValue = digits + suffix;
  if (normalizedValue !== this.value) this.value = normalizedValue;
  rememberValidAddressIndex();

  const nextIndex = Number(digits);
  if (!Number.isSafeInteger(nextIndex) || nextIndex >= 0x80000000) return;
  const indexChanged = mainAddressIndex !== digits;
  const nextHardened = suffix !== '';
  const hardenedChanged = hardenedIndexCheck.checked !== nextHardened;
  mainAddressIndex = digits;
  hardenedIndexCheck.checked = nextHardened;
  syncMainDerivationPathFromIndex();

  if (indexChanged) {
    refreshDisplayedWalletDerivation();
  } else if (hardenedChanged) {
    showSelectedBip38EncryptedKey();
    refreshDisplayedWalletDerivation({ preserveBip38EncryptedVariants: true });
  }
});
mainAddressIndexInput.addEventListener('blur', function() {
  if (this.value !== '') return;
  this.value = '0';
  mainAddressIndex = '0';
  hardenedIndexCheck.checked = false;
  rememberValidAddressIndex();
  syncMainDerivationPathFromIndex();
  refreshDisplayedWalletDerivation();
});
hardenedIndexCheck.addEventListener('change', () => {
  const displayedIndex = mainAddressIndexInput.value.match(/^\d+/)?.[0] ?? mainAddressIndex;
  mainAddressIndexInput.value = hardenedIndexCheck.checked ? `${displayedIndex}'` : displayedIndex;
  rememberValidAddressIndex();
  syncMainDerivationPathFromIndex();
  showSelectedBip38EncryptedKey();
  refreshDisplayedWalletDerivation({ preserveBip38EncryptedVariants: true });
});
mainDerivationPath.addEventListener('change', refreshDisplayedWalletDerivation);
let customDerivationRefreshTimer = 0;
mainDerivationPath.addEventListener('input', () => {
  if (mainStandardSelect.value !== 'custom') return;
  clearTimeout(customDerivationRefreshTimer);
  try {
    bip32.parsePath(mainDerivationPath.value);
  } catch (_) {
    return;
  }
  customDerivationRefreshTimer = setTimeout(() => {
    customDerivationRefreshTimer = 0;
    refreshDisplayedWalletDerivation();
  }, 120);
});
updatePrivateKeyResultOptionsVisibility();
updateMainExtendedKeyLabels();

async function updateBip39FromEntropy(expectedEpoch = sensitiveOperationEpoch) {
  if (!bip39 || typeof bip39.entropyToMnemonic !== 'function') {
    throw new Error('The local BIP39 mnemonic module is unavailable.');
  }
  const nextMnemonic = await bip39.entropyToMnemonic(entropyInput.value);
  if (expectedEpoch !== sensitiveOperationEpoch) return;
  mnemonicInput.value = nextMnemonic;
  mnemonicInput.dispatchEvent(new Event('input', { bubbles: true }));
  await updateBip39Seed(expectedEpoch);
}

function setDerivationProgress(value) {
  const normalized = Math.max(0, Math.min(1, Number(value) || 0));
  const current = Number.parseFloat(deriveBtn.style.getPropertyValue('--derivation-progress')) || 0;
  deriveBtn.style.setProperty('--derivation-progress', String(Math.max(current, normalized)));
}

async function setDeterministicDerivationBusy(isBusy) {
  if (isBusy) {
    if (derivationControlState) return;
    hideAllPasswords(sensitiveFields);
    derivationControlState = lockOperationControls();
    createOverlay.appendChild(derivationInteractionBlocker);
    document.body.classList.add('derivation-busy-global');
    createOverlay.classList.add('derivation-busy');
    deriveBtn.classList.add('deriving-progress');
    deriveBtn.setAttribute('aria-busy', 'true');
    const progressLabel = document.createElement('span');
    progressLabel.className = 'deriving-progress-label';
    progressLabel.textContent = 'DERIVING…';
    deriveBtn.replaceChildren(progressLabel);
    deriveBtn.style.setProperty('--derivation-progress', '0');
    derivationProgressTimer = setInterval(() => {
      const current = Number.parseFloat(deriveBtn.style.getPropertyValue('--derivation-progress')) || 0;
      setDerivationProgress(Math.min(0.92, current + Math.max(0.004, (0.92 - current) * 0.03)));
    }, 140);
    return;
  }

  if (derivationProgressTimer !== null) {
    clearInterval(derivationProgressTimer);
    derivationProgressTimer = null;
  }
  setDerivationProgress(1);
  await new Promise(resolve => setTimeout(resolve, 140));
  restoreOperationControls(derivationControlState);
  derivationControlState = null;
  derivationInteractionBlocker.remove();
  document.body.classList.remove('derivation-busy-global');
  createOverlay.classList.remove('derivation-busy');
  deriveBtn.classList.remove('deriving-progress');
  deriveBtn.removeAttribute('aria-busy');
  deriveBtn.style.removeProperty('--derivation-progress');
  deriveBtn.textContent = modeSelect.value === 'deterministic' ? 'DERIVE' : 'GENERATE';
}

function completeLocalCreateRequest(mode, length, kdfParams) {
  // Punto privado de integración para el futuro motor. Nunca publica secretos
  // en document, window, atributos HTML ni almacenamiento persistente.
  void kdfParams;
  queueMicrotask(() => {
    openCreateOverlay();
    showStandaloneStatus(`${mode === 'deterministic' ? 'DETERMINISTIC' : 'RANDOM'} · ${length} WORDS · REQUEST READY`);
  });
}

async function handlePanelCreate() {
  const mode = modeSelect.value;
  const length = lengthSelect.value;
  const operationEpoch = sensitiveOperationEpoch;

  if (mode === 'random') {
    try {
      if (!csprng || typeof csprng.generateEntropy !== 'function') {
        throw new Error('The local CSPRNG entropy generator is unavailable.');
      }
      showStandaloneStatus('Generating Entropy...', { duration: null });
      entropyInput.value = csprng.generateEntropy(length);
      entropyInput.dispatchEvent(new Event('input', { bubbles: true }));
      await updateBip39FromEntropy(operationEpoch);
      showEntropyGeneratedFeedback();
      showStandaloneStatus(`RANDOM · ${length} WORDS · ENTROPY GENERATED`);
    } catch (error) {
      showStandaloneStatus(error instanceof Error ? error.message : 'Unable to generate random entropy.');
      common.shakeOnly(deriveBtn);
    }
    return;
  }

  if (mode === 'deterministic') {
    const primarySecret = primarySecretInput.value;
    const primarySecretMissing = primarySecret.trim() === '';
    const confirmPrimarySecretMissing = confirmPrimarySecretInput.value.trim() === '';
    if (primarySecretMissing || confirmPrimarySecretMissing) {
      if (primarySecretMissing) showFieldError(primarySecretInput);
      if (confirmPrimarySecretMissing) showFieldError(confirmPrimarySecretInput);
      return;
    }
    if (confirmPrimarySecretInput.value !== primarySecret) {
      confirmPrimarySecretInput.classList.add('secret-mismatch');
      common.shakeOnly(confirmPrimarySecretInput.parentElement || confirmPrimarySecretInput);
      return;
    }
    const additionalSecret = additionalSecretInput.value;
    const additionalConfirmation = confirmAdditionalSecretInput.value;
    if (additionalSecret.trim() !== '' && additionalConfirmation.trim() === '') {
      showFieldError(confirmAdditionalSecretInput);
      return;
    }
    if (additionalConfirmation !== additionalSecret) {
      confirmAdditionalSecretInput.classList.add('secret-mismatch');
      common.shakeOnly(confirmAdditionalSecretInput.parentElement || confirmAdditionalSecretInput);
      return;
    }

    try {
      if (!kdf || typeof kdf.deriveEntropy !== 'function') {
        throw new Error('The local KDF module is unavailable.');
      }
      const kdfParams = getParamsFromUI();
      showStandaloneStatus('Deriving Entropy...', { duration: null });
      setDeterministicDerivationBusy(true);
      const nextEntropy = await kdf.deriveEntropy({
        ...kdfParams,
        primarySecret,
        additionalSecret,
        onProgress: setDerivationProgress
      });
      if (operationEpoch !== sensitiveOperationEpoch) return;
      entropyInput.value = nextEntropy;
      entropyInput.dispatchEvent(new Event('input', { bubbles: true }));
      await updateBip39FromEntropy(operationEpoch);

      clearData(primarySecretInput);
      hidePassword(primarySecretInput, showPrimarySecretBtn, 'primary');
      clearData(confirmPrimarySecretInput);
      hidePassword(confirmPrimarySecretInput, showConfirmPrimarySecretBtn, 'confirm-primary');
      primarySecretInput.classList.remove('field-error', 'field-invalid', 'field-valid', 'field-success', 'secret-mismatch', 'shake');
      confirmPrimarySecretInput.classList.remove('field-error', 'field-invalid', 'field-valid', 'field-success', 'secret-mismatch', 'shake');
      confirmPrimarySecretInput.dataset.matchesPrimary = 'false';

      clearData(additionalSecretInput);
      hidePassword(additionalSecretInput, showAdditionalSecretBtn, 'additional');
      clearData(confirmAdditionalSecretInput);
      hidePassword(confirmAdditionalSecretInput, showConfirmAdditionalSecretBtn, 'confirm-additional');
      additionalSecretInput.classList.remove('field-error', 'field-invalid', 'field-valid', 'field-success', 'secret-mismatch', 'shake');
      confirmAdditionalSecretInput.classList.remove('field-error', 'field-invalid', 'field-valid', 'field-success', 'secret-mismatch', 'shake');
      confirmAdditionalSecretInput.dataset.matchesAdditional = 'false';

      showEntropyGeneratedFeedback();
      showStandaloneStatus(`DETERMINISTIC · ${length} WORDS · ENTROPY DERIVED`);
    } catch (error) {
      showStandaloneStatus(error instanceof Error ? error.message : 'Unable to derive entropy.');
      common.shakeOnly(deriveBtn);
    } finally {
      await setDeterministicDerivationBusy(false);
    }
    return;
  }

  let kdfParams = null;
  if (kdfContainer && !kdfContainer.classList.contains('hidden')) {
    kdfParams = getParamsFromUI();
  }

  completeLocalCreateRequest(mode, length, kdfParams);
  closeCreateOverlay();
}

function initCreatePanel() {
  resetPanel();
  requestAnimationFrame(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });

  deriveBtn.addEventListener('click', handlePanelCreate);
  modeSelect.addEventListener('change', handleModeChange);
  lengthSelect.addEventListener('change', syncKdlenFromLength);

  primarySecretInput.addEventListener('input', function() {
    this.classList.remove('field-error', 'shake');
    updatePrimarySecretConfirmation();
  });
  confirmPrimarySecretInput.addEventListener('input', function() {
    this.classList.remove('field-error', 'field-invalid', 'shake');
    updatePrimarySecretConfirmation();
  });
  additionalSecretInput.addEventListener('input', function() {
    this.classList.remove('field-error', 'field-valid', 'shake');
    updateAdditionalSecretConfirmation();
  });
  confirmAdditionalSecretInput.addEventListener('input', function() {
    this.classList.remove('field-error', 'field-invalid', 'field-valid', 'shake');
    updateAdditionalSecretConfirmation();
  });
  bip39PassphraseInput.addEventListener('input', function() {
    this.classList.remove('field-error', 'field-valid', 'shake');
    refreshBip39PassphraseDerivation();
  });
  confirmPassphraseInput.addEventListener('input', function() {
    this.classList.remove('field-error', 'field-invalid', 'field-valid', 'shake');
    refreshBip39PassphraseDerivation();
  });

  try {
    if (sessionStorage.getItem(clearDataCompletionStorageKey) === 'true') {
      sessionStorage.removeItem(clearDataCompletionStorageKey);
      requestAnimationFrame(() => showStandaloneStatus('CLEAR DATA COMPLETE'));
    }
  } catch (_) {}
}

window.openCreateOverlay = openCreateOverlay;
window.closeCreateOverlay = closeCreateOverlay;
window.initCreatePanel = initCreatePanel;
document.addEventListener('wallex:open-create', openCreateOverlay);

const inactivityClearDelay = 5 * 60 * 1000;
let inactivityClearTimer = null;
let lastUserActivityAt = Date.now();
let inactivityClearStarted = false;

function runInactivityClearCheck() {
  if (inactivityClearStarted) return;
  const remainingTime = inactivityClearDelay - (Date.now() - lastUserActivityAt);
  if (remainingTime > 0) {
    clearTimeout(inactivityClearTimer);
    inactivityClearTimer = setTimeout(runInactivityClearCheck, remainingTime);
    return;
  }
  inactivityClearStarted = true;
  inactivityClearTimer = null;
  void performClearData();
}

function registerUserActivity(event) {
  if (!event.isTrusted || inactivityClearStarted || document.visibilityState === 'hidden') return;
  const now = Date.now();
  if (event.type === 'pointermove' && now - lastUserActivityAt < 1000) return;
  lastUserActivityAt = now;
  clearTimeout(inactivityClearTimer);
  inactivityClearTimer = setTimeout(runInactivityClearCheck, inactivityClearDelay);
}

['pointerdown', 'pointermove', 'touchstart', 'keydown', 'input', 'wheel', 'scroll'].forEach(eventType => {
  document.addEventListener(eventType, registerUserActivity, { capture: true, passive: true });
});
inactivityClearTimer = setTimeout(runInactivityClearCheck, inactivityClearDelay);

function handleCreateVisibility() {
  if (document.visibilityState === 'hidden') {
    hideAllPasswords(sensitiveFields);
    return;
  }
  runInactivityClearCheck();
}

document.addEventListener('visibilitychange', handleCreateVisibility);
window.addEventListener('blur', () => hideAllPasswords(sensitiveFields));
window.addEventListener('focus', runInactivityClearCheck);
window.addEventListener('pagehide', () => {
  hideAllPasswords(sensitiveFields);
});
document.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
    const activeElement = document.activeElement;
    const isFieldFocused = activeElement instanceof HTMLInputElement || activeElement instanceof HTMLTextAreaElement;
    const isProtectedResult = activeElement?.matches('input[type="password"][readonly].password-masked');
    if (!isFieldFocused || isProtectedResult) {
      event.preventDefault();
      window.getSelection()?.removeAllRanges();
      return;
    }
  }
  if (event.key === 'Escape' && wallexMainNavBtn.getAttribute('aria-expanded') === 'true') {
    setNavigationDrawerOpen(false);
    return;
  }
  if (event.key === 'Escape' && createOverlay.classList.contains('active')) closeCreateOverlay();
});

let bip39SelectionField = null;
let suppressBip39OutsideHideUntil = 0;

createOverlay.addEventListener('pointerdown', event => {
  bip39SelectionField = event.target.matches(
    '#entropy:not(.password-masked), #mnemonic:not(.password-masked), #seed:not(.password-masked), #rootprv:not(.password-masked), #accountprv:not(.password-masked), #derivedprv:not(.password-masked), #bip85derived:not(.password-masked), #privateKey:not(.password-masked), #bip38key:not(.password-masked)'
  ) ? event.target : null;
});

document.addEventListener('pointerup', () => {
  if (!bip39SelectionField) return;
  const hasSelection = typeof bip39SelectionField.selectionStart === 'number' &&
    typeof bip39SelectionField.selectionEnd === 'number' &&
    bip39SelectionField.selectionEnd > bip39SelectionField.selectionStart;
  if (hasSelection) suppressBip39OutsideHideUntil = performance.now() + 350;
  bip39SelectionField = null;
});

document.addEventListener('click', event => {
  if (isGlobalSecretRevealActive()) return;
  const target = event.target;
  if (target.closest('.show-primary-secret-btn, .show-additional-secret-btn, .show-entropy-btn')) return;
  if (performance.now() < suppressBip39OutsideHideUntil) return;
  const fields = [
    { element: primarySecretInput, button: showPrimarySecretBtn, key: 'primary' },
    { element: confirmPrimarySecretInput, button: showConfirmPrimarySecretBtn, key: 'confirm-primary' },
    { element: additionalSecretInput, button: showAdditionalSecretBtn, key: 'additional' },
    { element: confirmAdditionalSecretInput, button: showConfirmAdditionalSecretBtn, key: 'confirm-additional' },
    { element: entropyInput, button: showEntropyBtn, key: 'entropy' },
    { element: mnemonicInput, button: showMnemonicBtn, key: 'mnemonic' },
    { element: bip39PassphraseInput, button: showBip39PassphraseBtn, key: 'bip39-passphrase' },
    { element: confirmPassphraseInput, button: showConfirmPassphraseBtn, key: 'confirm-bip39-passphrase' },
    { element: seedInput, button: showSeedBtn, key: 'seed' },
    { element: rootprvInput, button: showRootprvBtn, key: 'rootprv' },
    { element: accountprvInput, button: showAccountprvBtn, key: 'accountprv' },
    { element: derivedprvInput, button: showDerivedprvBtn, key: 'derivedprv' },
    { element: bip85DerivedInput, button: showBip85DerivedBtn, key: 'bip85derived' },
    { element: privateKeyInput, button: showPrivateKeyBtn, key: 'private-key' },
    { element: bip38KeyInput, button: showBip38KeyBtn, key: 'bip38-key' },
    { element: bip38PassphraseInput, button: showBip38PassphraseBtn, key: 'bip38-passphrase' },
    { element: confirmBip38PassphraseInput, button: showConfirmBip38PassphraseBtn, key: 'confirm-bip38-passphrase' },
  ];
  fields.forEach(({ element, button, key }) => {
    const wrapper = element.closest('.primary-secret-input-wrapper, .additional-secret-input-wrapper');
    if (isPasswordVisible(element) && wrapper && !wrapper.contains(target)) {
      hidePassword(element, button, key);
    }
  });
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initCreatePanel, { once: true });
} else {
  initCreatePanel();
}
})();

/* === STANDALONE MODE === */
(() => {
  'use strict';

  let panelResizeObserver = null;

  function updatePanelScale() {
    const panelStack = document.querySelector('#createOverlay .panel-stack');
    if (!panelStack) return;
    const overlayStyle = window.getComputedStyle(createOverlay);
    const horizontalPadding = parseFloat(overlayStyle.paddingLeft) + parseFloat(overlayStyle.paddingRight);
    const widthScale = (window.innerWidth - horizontalPadding) / panelStack.offsetWidth;
    const scale = Math.max(0.1, Math.min(1, widthScale));
    document.documentElement.style.setProperty('--panel-scale', String(scale));
  }

  updatePanelScale();

  function observePanelSize() {
    const panelStack = document.querySelector('#createOverlay .panel-stack');
    if (!panelStack) return;
    updatePanelScale();
    if ('ResizeObserver' in window) {
      panelResizeObserver?.disconnect();
      panelResizeObserver = new ResizeObserver(updatePanelScale);
      panelResizeObserver.observe(panelStack);
    }
  }

  function keepPanelVisible() {
    const overlay = document.getElementById('createOverlay');
    if (!overlay) return;
    overlay.classList.add('active');
    overlay.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    observePanelSize();
  }

  window.addEventListener('resize', updatePanelScale, { passive: true });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', keepPanelVisible, { once: true });
  } else {
    keepPanelVisible();
  }
})();
