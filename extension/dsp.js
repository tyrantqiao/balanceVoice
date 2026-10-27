import { sanitizeSettings } from './settings.js';

/** Block RMS auto gain plus a stereo-linked peak limiter. No audio is retained. */
export class BalanceDSP {
  constructor(sampleRate, settings) {
    this.sampleRate = sampleRate;
    this.settings = sanitizeSettings(settings);
    this.energy = 0;
    this.gain = 1;
    this.limiter = 1;
    this.volume = this.settings.volume / 100;
    this.metrics = { inputRms: 0, outputRms: 0, gain: 1 };
  }

  configure(settings) { this.settings = sanitizeSettings(settings); }

  process(input, output) {
    const length = output[0]?.length || 0;
    if (!length) return;
    let energy = 0;
    let peak = 0;
    for (const channel of input) {
      for (let i = 0; i < length; i++) {
        const sample = Number.isFinite(channel[i]) ? channel[i] : 0;
        energy += sample * sample;
        peak = Math.max(peak, Math.abs(sample));
      }
    }
    const blockEnergy = energy / Math.max(1, length * input.length);
    const seconds = length / this.sampleRate;
    this.energy += (blockEnergy - this.energy) * (1 - Math.exp(-seconds / 0.12));
    const rms = Math.sqrt(this.energy);
    // Freeze gain during silence, so pauses do not amplify background noise.
    let desired = this.gain;
    if (!this.settings.normalize) desired = 1;
    else if (Math.sqrt(blockEnergy) > 0.0018) desired = Math.max(0.05, Math.min(4, 0.1 / Math.max(rms, 0.001)));
    const gainEnd = this.gain + (desired - this.gain) *
      (1 - Math.exp(-seconds / (desired < this.gain ? 0.025 : 0.8)));
    const volumeEnd = this.volume + (this.settings.volume / 100 - this.volume) *
      (1 - Math.exp(-seconds / 0.015));
    // Look ahead over the current render block; one envelope preserves stereo.
    const maxGain = Math.max(this.gain, gainEnd) * Math.max(this.volume, volumeEnd);
    const ceiling = Math.min(0.95, 10 ** (this.settings.maxDbfs / 20));
    const limit = Math.min(1, ceiling / Math.max(peak * maxGain, 1e-12));
    const release = this.limiter + (1 - this.limiter) * (1 - Math.exp(-seconds / 0.08));
    this.limiter = Math.min(limit, release);
    let outputEnergy = 0;
    let outputPeak = 0;
    for (let c = 0; c < output.length; c++) {
      const channel = input[Math.min(c, input.length - 1)];
      for (let i = 0; i < length; i++) {
        const fraction = (i + 1) / length;
        const gain = this.gain + (gainEnd - this.gain) * fraction;
        const volume = this.volume + (volumeEnd - this.volume) * fraction;
        const sample = Number.isFinite(channel?.[i]) ? channel[i] : 0;
        output[c][i] = sample * gain * volume * this.limiter;
        outputEnergy += output[c][i] * output[c][i];
        outputPeak = Math.max(outputPeak, Math.abs(output[c][i]));
      }
    }
    this.gain = gainEnd;
    this.volume = volumeEnd;
    this.metrics.inputRms = Math.sqrt(blockEnergy);
    this.metrics.outputRms = Math.sqrt(outputEnergy / Math.max(1, length * output.length));
    this.metrics.gain = this.gain * this.limiter;
    this.metrics.outputPeak = outputPeak;
  }
}
