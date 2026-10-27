export const DEFAULT_SETTINGS = Object.freeze({ volume: 70, normalize: true, autoEnable: true, maxDbfs: -1 });

export function sanitizeSettings(value = {}) {
  if (!value || typeof value !== 'object') value = {};
  return {
    volume: Number.isFinite(value.volume)
      ? Math.round(Math.min(100, Math.max(0, value.volume)))
      : DEFAULT_SETTINGS.volume,
    normalize: typeof value.normalize === 'boolean' ? value.normalize : DEFAULT_SETTINGS.normalize,
    autoEnable: typeof value.autoEnable === 'boolean' ? value.autoEnable : DEFAULT_SETTINGS.autoEnable,
    maxDbfs: Number.isFinite(value.maxDbfs)
      ? Math.round(Math.max(-60, Math.min(0, value.maxDbfs))) : DEFAULT_SETTINGS.maxDbfs,
  };
}
