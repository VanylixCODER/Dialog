// ============================================================================
// Secret DMs — end-to-end encryption core.  window.E2E.*
//
// Device-only keys: the private identity key is generated with WebCrypto as a
// NON-EXTRACTABLE CryptoKey and kept in IndexedDB, so neither the page's JS nor
// an injected script can read it, and it never leaves the device. The server
// only ever sees public keys and opaque ciphertext.
//
// Scope: 1-to-1 "Secret DMs" only. Not groups, not bots, not channels.
//
// Crypto: ECDH on P-256 (chosen over X25519 for old-Android-WebView support).
// Per message: a random AES-GCM content key encrypts the text once; the content
// key is wrapped to each recipient device via a per-message EPHEMERAL ECDH →
// HKDF-SHA256 → AES-GCM. The ephemeral key gives the wrap forward secrecy
// against a later identity-key compromise. Honest limitation: this is not a full
// Double Ratchet (no per-message chain / future secrecy) — a documented
// follow-up. Metadata (who/when/size) is NOT hidden; E2E protects content only.
// ============================================================================
(function () {
  const SUBTLE = (window.crypto && window.crypto.subtle) || null;
  const enc = new TextEncoder(), dec = new TextDecoder();
  const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

  // ── IndexedDB: one record holding the device's identity keypair ──
  const DB = "dlg-e2e", STORE = "keys";
  function idb() {
    return new Promise((res, rej) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  async function idbGet(k) {
    const db = await idb();
    return new Promise((res, rej) => {
      const t = db.transaction(STORE, "readonly").objectStore(STORE).get(k);
      t.onsuccess = () => res(t.result); t.onerror = () => rej(t.error);
    });
  }
  async function idbPut(k, v) {
    const db = await idb();
    return new Promise((res, rej) => {
      const t = db.transaction(STORE, "readwrite").objectStore(STORE).put(v, k);
      t.onsuccess = () => res(); t.onerror = () => rej(t.error);
    });
  }

  function deviceId() {
    let id = null;
    try { id = localStorage.getItem("dialog_device_id"); } catch {}
    if (!id) { id = b64(crypto.getRandomValues(new Uint8Array(16))).replace(/[^a-zA-Z0-9]/g, "").slice(0, 22);
      try { localStorage.setItem("dialog_device_id", id); } catch {} }
    return id;
  }

  // The identity keypair. WebCrypto's `extractable` flag applies to both halves
  // of a pair, so to keep the PRIVATE key non-extractable while still publishing
  // the PUBLIC one: generate extractable, export the public SPKI, then re-import
  // just the private key as NON-extractable and discard the extractable original.
  // The persisted private CryptoKey can never be exported again — not by this
  // page, not by injected script.
  let _ident = null;
  async function identity() {
    if (_ident) return _ident;
    const stored = await idbGet("identity").catch(() => null);
    if (stored && stored.priv && stored.spki) { _ident = stored; return _ident; }
    const kp = await SUBTLE.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    const spki = b64(await SUBTLE.exportKey("spki", kp.publicKey));
    const jwk = await SUBTLE.exportKey("jwk", kp.privateKey);
    const priv = await SUBTLE.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    _ident = { priv, spki };                 // no extractable private key retained
    await idbPut("identity", _ident);
    return _ident;
  }

  function available() { return !!SUBTLE && !!window.indexedDB; }

  async function importPeerPub(spkiB64) {
    return SUBTLE.importKey("spki", unb64(spkiB64), { name: "ECDH", namedCurve: "P-256" }, false, []);
  }
  // ECDH(priv, peerPub) → HKDF-SHA256 → AES-GCM key for wrapping the content key.
  async function wrapKeyFor(priv, peerPub, salt, usage) {
    const bits = await SUBTLE.deriveBits({ name: "ECDH", public: peerPub }, priv, 256);
    const hk = await SUBTLE.importKey("raw", bits, "HKDF", false, ["deriveKey"]);
    return SUBTLE.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt, info: enc.encode("dlg-e2e-wrap") },
      hk, { name: "AES-GCM", length: 256 }, false, usage);
  }

  // Encrypt plaintext to a set of devices: [{deviceId, spki}].
  async function encrypt(plaintext, devices) {
    await identity();   // ensure this device is initialised/registered
    const eph = await SUBTLE.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    const ephSpki = b64(await SUBTLE.exportKey("spki", eph.publicKey));
    const contentKey = await SUBTLE.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await SUBTLE.encrypt({ name: "AES-GCM", iv }, contentKey, enc.encode(plaintext));
    const rawContent = await SUBTLE.exportKey("raw", contentKey);
    const wraps = {};
    for (const d of devices) {
      if (!d || !d.spki || !d.deviceId) continue;
      try {
        const peer = await importPeerPub(d.spki);
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const wk = await wrapKeyFor(eph.privateKey, peer, salt, ["encrypt"]);
        const wiv = crypto.getRandomValues(new Uint8Array(12));
        const wrapped = await SUBTLE.encrypt({ name: "AES-GCM", iv: wiv }, wk, rawContent);
        wraps[d.deviceId] = { s: b64(salt), iv: b64(wiv), k: b64(wrapped) };
      } catch {}
    }
    return JSON.stringify({ v: 1, epk: ephSpki, iv: b64(iv), ct: b64(ct), wraps });
  }

  // Decrypt an envelope with THIS device's identity key. Returns null when this
  // device has no wrap (the device-only trade-off) or on any failure.
  async function decrypt(envelopeStr) {
    let env; try { env = JSON.parse(envelopeStr); } catch { return null; }
    if (!env || env.v !== 1 || !env.wraps) return null;
    const mine = env.wraps[deviceId()];
    if (!mine) return null;
    try {
      const id = await identity();
      const eph = await importPeerPub(env.epk);
      const wk = await wrapKeyFor(id.priv, eph, unb64(mine.s), ["decrypt"]);
      const rawContent = await SUBTLE.decrypt({ name: "AES-GCM", iv: unb64(mine.iv) }, wk, unb64(mine.k));
      const contentKey = await SUBTLE.importKey("raw", rawContent, { name: "AES-GCM" }, false, ["decrypt"]);
      const pt = await SUBTLE.decrypt({ name: "AES-GCM", iv: unb64(env.iv) }, contentKey, unb64(env.ct));
      return dec.decode(pt);
    } catch { return null; }
  }

  // Short safety-number so two people can verify out-of-band (compare in person).
  async function fingerprint(spkiList) {
    const joined = spkiList.slice().sort().join("|");
    const h = await SUBTLE.digest("SHA-256", enc.encode(joined));
    const hex = [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
    return hex.slice(0, 40).replace(/(.{5})/g, "$1 ").trim();
  }

  window.E2E = { available, identity, deviceId, encrypt, decrypt, fingerprint, spki: async () => (await identity()).spki };
})();
