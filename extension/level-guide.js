// Product starting range for the measured RMS signal, not a medical threshold.
// It surrounds the normalizer's usual output (~-23 dBFS at 70%).
export const OUTPUT_REFERENCE = Object.freeze({ low: -30, high: -18 });

export function assessOutput({ outputRms, muted, stopped }) {
  if (stopped) return { tone: 'unknown', label: '已停止 · 不评估', db: null };
  if (muted) return { tone: 'quiet', label: '已静音', db: null };
  if (!Number.isFinite(outputRms) || outputRms < 0) {
    return { tone: 'unknown', label: '无法评估', db: null };
  }
  if (outputRms === 0) return { tone: 'quiet', label: '当前无输出', db: -Infinity };
  const db = 20 * Math.log10(outputRms);
  if (db > -6) return { tone: 'high', label: '数字电平很高 · 建议调低', db };
  if (db > OUTPUT_REFERENCE.high) return { tone: 'elevated', label: '高于参考 · 建议调低', db };
  if (db < OUTPUT_REFERENCE.low) return { tone: 'quiet', label: '低于数字参考', db };
  return { tone: 'reference', label: '在数字参考范围内', db };
}
