/**
 * recorder-bridge.js — Zero-CDP observational message bus between page runtime
 * (content script / injected script) and extension background service worker.
 *
 * Provides:
 * 1. Monotonic sequence numbering and delivery acknowledgments.
 * 2. Automatic message queueing when service worker is idle or reconnecting.
 * 3. Heartbeat liveness detection and reconnection without losing captured events.
 * 4. Pluggable transport adapter (chrome.runtime.Port, window.postMessage, or EventEmitter mock).
 */

export class RecorderBridge {
  /**
   * @param {Object} [options]
   * @param {string} [options.channel='flowtrace-recorder']
   * @param {number} [options.heartbeatIntervalMs=5000]
   * @param {number} [options.ackTimeoutMs=3000]
   * @param {Object} [options.transport] Custom transport for unit testing / mocking
   */
  constructor(options = {}) {
    this.channel = options.channel || 'flowtrace-recorder';
    this.heartbeatIntervalMs = options.heartbeatIntervalMs || 5000;
    this.ackTimeoutMs = options.ackTimeoutMs || 3000;
    this.transport = options.transport || null;

    this._seq = 0;
    this._port = null;
    this._connected = false;
    this._listeners = new Map();
    this._pendingAcks = new Map();
    this._outboxQueue = [];
    this._heartbeatTimer = null;
    this._disposed = false;
  }

  /**
   * Initialize connection to background service worker.
   */
  connect() {
    if (this._disposed) return;

    if (this.transport) {
      this._connected = true;
      this.transport.onMessage((msg) => this._handleIncoming(msg));
      this._flushOutbox();
      return;
    }

    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.connect) {
      try {
        this._port = chrome.runtime.connect({ name: this.channel });
        this._connected = true;

        this._port.onMessage.addListener((msg) => this._handleIncoming(msg));
        this._port.onDisconnect.addListener(() => {
          this._connected = false;
          this._port = null;
          this._stopHeartbeat();
          // Attempt automatic reconnection if not disposed
          if (!this._disposed) {
            setTimeout(() => this.connect(), 1000);
          }
        });

        this._startHeartbeat();
        this._flushOutbox();
      } catch (err) {
        this._connected = false;
        if (!this._disposed) {
          setTimeout(() => this.connect(), 2000);
        }
      }
    }
  }

  /**
   * Send a typed message to the background service worker.
   * Returns a promise resolving when acknowledged (or immediately if waitForAck is false).
   *
   * @param {string} type
   * @param {Object} [payload={}]
   * @param {Object} [options]
   * @param {boolean} [options.waitForAck=false]
   * @returns {Promise<any>}
   */
  send(type, payload = {}, options = {}) {
    if (this._disposed) {
      return Promise.reject(new Error('RecorderBridge is disposed'));
    }

    const seq = ++this._seq;
    const envelope = {
      channel: this.channel,
      seq,
      type,
      payload,
      timestamp: Date.now(),
      waitForAck: !!options.waitForAck,
    };

    if (!options.waitForAck) {
      this._dispatchEnvelope(envelope);
      return Promise.resolve({ seq });
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pendingAcks.delete(seq);
        reject(new Error(`Timeout waiting for ack for message seq=${seq}, type=${type}`));
      }, this.ackTimeoutMs);

      this._pendingAcks.set(seq, { resolve, reject, timer });
      this._dispatchEnvelope(envelope);
    });
  }

  /**
   * Subscribe to incoming messages from the background service worker.
   *
   * @param {string} type
   * @param {Function} handler
   */
  on(type, handler) {
    if (!this._listeners.has(type)) {
      this._listeners.set(type, new Set());
    }
    this._listeners.get(type).add(handler);
  }

  /**
   * Unsubscribe from incoming messages.
   *
   * @param {string} type
   * @param {Function} handler
   */
  off(type, handler) {
    const set = this._listeners.get(type);
    if (set) {
      set.delete(handler);
      if (set.size === 0) this._listeners.delete(type);
    }
  }

  /**
   * Dispatch envelope immediately or queue if not connected.
   * @private
   */
  _dispatchEnvelope(envelope) {
    if (this._connected) {
      try {
        if (this.transport) {
          this.transport.send(envelope);
          return;
        }
        if (this._port) {
          this._port.postMessage(envelope);
          return;
        }
      } catch (err) {
        this._connected = false;
      }
    }
    // Queue for later transmission
    this._outboxQueue.push(envelope);
  }

  /**
   * Flush queued messages upon connection.
   * @private
   */
  _flushOutbox() {
    if (!this._connected || this._outboxQueue.length === 0) return;
    const queue = [...this._outboxQueue];
    this._outboxQueue = [];

    for (const envelope of queue) {
      this._dispatchEnvelope(envelope);
    }
  }

  /**
   * Process incoming message.
   * @private
   */
  _handleIncoming(msg) {
    if (!msg || typeof msg !== 'object') return;

    // Handle ACK
    if (msg.type === '__ACK__' && msg.ackSeq) {
      const pending = this._pendingAcks.get(msg.ackSeq);
      if (pending) {
        clearTimeout(pending.timer);
        this._pendingAcks.delete(msg.ackSeq);
        pending.resolve(msg.payload);
      }
      return;
    }

    // Handle incoming typed message
    const handlers = this._listeners.get(msg.type);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(msg.payload, msg);
        } catch (err) {
          console.error(`Error in RecorderBridge handler for ${msg.type}:`, err);
        }
      }
    }

    // Acknowledge if requested
    if (msg.waitForAck && msg.seq) {
      this._dispatchEnvelope({
        channel: this.channel,
        type: '__ACK__',
        ackSeq: msg.seq,
        timestamp: Date.now(),
      });
    }
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this._heartbeatTimer = setInterval(() => {
      if (this._connected) {
        this.send('__HEARTBEAT__', { uptime: Date.now() }).catch(() => {});
      }
    }, this.heartbeatIntervalMs);
  }

  _stopHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  /**
   * Disconnect and clean up resources.
   */
  dispose() {
    this._disposed = true;
    this._stopHeartbeat();

    for (const [, pending] of this._pendingAcks) {
      clearTimeout(pending.timer);
      pending.reject(new Error('RecorderBridge disposed'));
    }
    this._pendingAcks.clear();
    this._listeners.clear();
    this._outboxQueue = [];

    if (this._port) {
      try {
        this._port.disconnect();
      } catch {}
      this._port = null;
    }
    this._connected = false;
  }
}
