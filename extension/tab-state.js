export function sanitizeTabControl(value = {}) {
  return {
    volume: Number.isFinite(value.volume) ? Math.round(Math.max(0, Math.min(100, value.volume))) : null,
    stopped: value.stopped === true,
  };
}

export function effectiveSettings(settings, control, muted = false) {
  return { ...settings, volume: muted ? 0 : control.volume ?? settings.volume,
    autoEnable: settings.autoEnable && !control.stopped };
}

export function aggregateFrames(frames) {
  const result = { mediaCount: 0, playingCount: 0, inputRms: 0, outputRms: 0, estimated: true };
  let unknown = false;
  for (const frame of frames) {
    result.mediaCount += frame.mediaCount;
    result.playingCount += frame.playingCount;
    if (frame.playingCount && (frame.inputRms === null || frame.outputRms === null)) unknown = true;
    result.inputRms += (frame.inputRms || 0) ** 2;
    result.outputRms += (frame.outputRms || 0) ** 2;
  }
  result.inputRms = unknown ? null : Math.sqrt(result.inputRms);
  result.outputRms = unknown ? null : Math.sqrt(result.outputRms);
  return result;
}
