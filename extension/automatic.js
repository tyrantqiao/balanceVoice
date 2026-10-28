(() => {
  const elements = new Map();
  const roots = new Set();
  let settings = { volume: 70, normalize: true, autoEnable: true, maxDbfs: -1 };
  let captured = false;
  let ready = false;
  let engine;
  let timer;
  let alive = true;
  let documentActive = true;
  let presenceTimer;
  let lastPresence = -1;

  function presence() {
    const mediaCount = documentActive ? [...elements.keys()].filter(media => media.isConnected).length : 0;
    if (mediaCount === lastPresence) return;
    lastPresence = mediaCount;
    chrome.runtime.sendMessage({ target: 'background', type: 'PAGE_PRESENCE',
      mediaCount,
    }).catch(() => { lastPresence = -1; });
  }

  function schedulePresence() {
    if (presenceTimer) return;
    presenceTimer = setTimeout(() => { presenceTimer = undefined; presence(); }, 50);
  }

  function requestedVolume(entry) {
    const requested = settings.volume / 100 * (settings.normalize ? entry.gain : 1);
    // Until analysis is available, conservatively attenuate by the full-scale cap.
    // A quiet snapshot must never remove headroom for the next loud passage.
    const peak = Math.max(1, entry.peak || 0);
    return Math.min(requested, 10 ** (settings.maxDbfs / 20) / peak);
  }

  const active = () => ready && settings.autoEnable && !captured;

  function write(media, entry, volume) {
    entry.applied = Math.max(0, Math.min(1, volume));
    if (Math.abs(media.volume - entry.applied) > 0.0001) media.volume = entry.applied;
  }

  function release(entry) {
    if (!entry.meter) return;
    entry.meter.source.disconnect();
    entry.meter.analyser.disconnect();
    entry.meter.stream.getTracks().forEach(track => track.stop());
    entry.meter = undefined;
  }

  function analyse(media, entry) {
    if (!active() || media.paused || entry.meter || entry.failed) return;
    let stream;
    try {
      // Unlike createMediaElementSource, captureStream never takes over playback.
      // If CORS/DRM prevents analysis, the original player keeps playing normally.
      if (!media.captureStream) return;
      stream = media.captureStream();
      stream.getVideoTracks().forEach(track => track.stop());
      if (!stream.getAudioTracks().length) { stream.getTracks().forEach(track => track.stop()); return; }
      engine ||= new AudioContext();
      engine.resume().catch(() => {});
      const source = engine.createMediaStreamSource(stream);
      const analyser = engine.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      entry.meter = { stream, source, analyser, samples: new Float32Array(analyser.fftSize) };
      timer ||= setInterval(tick, 25);
    } catch {
      stream?.getTracks().forEach(track => track.stop());
      entry.failed = true;
    }
  }

  function apply(media, entry) {
    if (active()) {
      write(media, entry, requestedVolume(entry));
      analyse(media, entry);
    } else {
      release(entry);
      entry.gain = 1;
      entry.leveler = new globalThis.BalanceLeveler();
      write(media, entry, entry.original);
    }
  }

  function tick() {
    let meters = 0;
    for (const [media, entry] of elements) {
      if (!media.isConnected) { release(entry); media.removeEventListener('volumechange', entry.onVolume); elements.delete(media); continue; }
      if (!active() || media.paused || media.ended) { release(entry); continue; }
      if (!entry.meter) continue;
      meters++;
      if (engine.state !== 'running') continue;
      const { analyser, samples } = entry.meter;
      analyser.getFloatTimeDomainData(samples);
      let energy = 0;
      let peak = 0;
      for (const sample of samples) { energy += sample * sample; peak = Math.max(peak, Math.abs(sample)); }
      const now = performance.now();
      // Background timer delays are not evidence of seconds of quiet audio.
      const seconds = Math.min(0.1, Math.max(0.001, (now - (entry.lastTick ?? now - 25)) / 1000));
      entry.lastTick = now;
      entry.peak = Math.max(peak, (entry.peak || 0) * Math.exp(-seconds / 2));
      const rms = Math.sqrt(energy / samples.length);
      // Captured media volume is independent of the element's volume setting.
      entry.gain = entry.leveler.update(rms * rms, seconds, settings.normalize);
      // Limit sampled peaks even if loudness normalization is disabled.
      write(media, entry, requestedVolume(entry));
    }
    if (!meters) { clearInterval(timer); timer = undefined; }
  }

  function track(media) {
    if (!(media instanceof HTMLMediaElement) || elements.has(media)) return;
    const entry = { original: media.volume, applied: media.volume, gain: 1,
      leveler: new globalThis.BalanceLeveler() };
    entry.onVolume = () => {
      if (Math.abs(media.volume - entry.applied) < 0.0001) return;
      entry.original = media.volume;
      if (active()) apply(media, entry);
      else entry.applied = media.volume;
    };
    media.addEventListener('volumechange', entry.onVolume);
    elements.set(media, entry);
    apply(media, entry);
    schedulePresence();
  }

  function discover(node) {
    if (node instanceof HTMLMediaElement) track(node);
    if (node.shadowRoot) observe(node.shadowRoot);
    if (!node.querySelectorAll) return;
    node.querySelectorAll('audio,video').forEach(track);
    node.querySelectorAll('*').forEach(element => { if (element.shadowRoot) observe(element.shadowRoot); });
  }

  const observer = new MutationObserver(records => {
    if (!alive) return;
    for (const record of records) record.addedNodes.forEach(discover);
    // Release removed players even when no analyser interval is running.
    for (const [media, entry] of elements) {
      if (!media.isConnected) {
        release(entry);
        write(media, entry, entry.original);
        media.removeEventListener('volumechange', entry.onVolume);
        elements.delete(media);
      }
    }
    schedulePresence();
  });

  function observe(root) {
    if (roots.has(root)) return;
    roots.add(root);
    observer.observe(root, { childList: true, subtree: true });
    root.addEventListener('play', onPlay, true);
    root.addEventListener('playing', onPlay, true);
    root.addEventListener('loadedmetadata', onMetadata, true);
    discover(root);
  }

  function onPlay(event) {
    const media = event.target;
    if (!(media instanceof HTMLMediaElement)) return;
    track(media);
    const entry = elements.get(media);
    apply(media, entry);
    engine?.resume().catch(() => {});
  }

  function onMetadata(event) {
    const entry = elements.get(event.target);
    if (entry) {
      release(entry);
      entry.failed = false;
      entry.peak = undefined;
      entry.lastTick = undefined;
      // Keep attenuation across playlist changes; do not restart the next clip loud.
      apply(event.target, entry);
    }
  }

  function update(data) {
    if (!alive) return;
    settings = { ...settings, ...data.settings };
    captured = Boolean(data.captured);
    ready = true;
    for (const [media, entry] of elements) apply(media, entry);
    if (!active() && engine) {
      engine.close().catch(() => {});
      engine = undefined;
    }
    schedulePresence();
  }

  function report() {
    let inputEnergy = 0;
    let outputEnergy = 0;
    let playingCount = 0;
    let unknown = false;
    for (const [media, entry] of elements) {
      if (!media.isConnected || media.paused || media.ended) continue;
      playingCount++;
      if (!entry.meter || engine?.state !== 'running' || !entry.meter.stream.getAudioTracks().some(track => track.readyState === 'live' && !track.muted)) {
        unknown = true;
        continue;
      }
      const { analyser, samples } = entry.meter;
      analyser.getFloatTimeDomainData(samples);
      let energy = 0;
      for (const sample of samples) energy += sample * sample;
      const rms = Math.sqrt(energy / samples.length);
      inputEnergy += rms * rms;
      outputEnergy += (media.muted ? 0 : rms * media.volume) ** 2;
    }
    chrome.runtime.sendMessage({ target: 'background', type: 'PAGE_REPORT', data: {
      title: document.title, mediaCount: [...elements.keys()].filter(media => media.isConnected).length,
      playingCount, inputRms: unknown ? null : Math.sqrt(inputEnergy),
      outputRms: unknown ? null : Math.sqrt(outputEnergy),
    } }).catch(() => {});
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || message?.target !== 'automatic') return;
    if (message.type === 'INSPECT') { report(); respond({ ok: true }); return; }
    update(message);
    respond({ ok: true });
  });
  observe(document);
  chrome.runtime.sendMessage({ target: 'background', type: 'PAGE_STATE' }).then(response => {
    // A push update can arrive before the startup reply; don't overwrite it.
    if (!ready && response?.ok) update(response.data);
  }).catch(() => {});
  window.addEventListener('pageshow', event => {
    documentActive = true;
    schedulePresence();
    if (event.persisted) chrome.runtime.sendMessage({ target: 'background', type: 'PAGE_STATE' })
      .then(response => { if (response?.ok) update(response.data); }).catch(() => {});
  });
  window.addEventListener('pagehide', () => {
    documentActive = false;
    clearTimeout(presenceTimer);
    presenceTimer = undefined;
    presence();
  });
})();
