import { sanitizeSettings } from './settings.js';
import './leveler.js';

/** Programme leveling with a 10 ms stereo-linked lookahead limiter. */
export class BalanceDSP {
  constructor(sampleRate, settings) {
    this.sampleRate = sampleRate;
    this.settings = sanitizeSettings(settings);
    this.outputEnergy = 0;
    this.leveler = new globalThis.BalanceLeveler();
    this.gain = 1;
    this.limiter = 1;
    this.volume = this.settings.volume / 100;
    this.delayLength = Math.ceil(sampleRate * 0.01);
    this.delay = [];
    this.cursor = 0;
    this.frame = 0;
    this.peaks = new Float64Array(this.delayLength + 2);
    this.times = new Float64Array(this.delayLength + 2);
    this.head = 0;
    this.tail = 0;
    this.attack = 1 - Math.exp(-1 / (sampleRate * 0.001));
    this.release = 1 - Math.exp(-1 / (sampleRate * 0.3));
    this.metrics = { inputRms: 0, outputRms: 0, gain: 1 };
  }

  configure(settings) { this.settings = sanitizeSettings(settings); }

  process(input, output) {
    const length = output[0]?.length || 0;
    if (!length) return;
    let energy = 0;
    for (const channel of input) {
      for (let i = 0; i < length; i++) {
        const sample = Number.isFinite(channel[i]) ? channel[i] : 0;
        energy += sample * sample;
      }
    }
    const blockEnergy = energy / Math.max(1, length * input.length);
    const seconds = length / this.sampleRate;
    const gainEnd = this.leveler.update(blockEnergy, seconds, this.settings.normalize);
    const volumeEnd = this.volume + (this.settings.volume / 100 - this.volume) *
      (1 - Math.exp(-seconds / 0.015));
    const ceiling = Math.min(0.95, 10 ** (this.settings.maxDbfs / 20));
    // The normalizer also limits transient headroom relative to listening volume.
    const transientCeiling = this.settings.normalize ? Math.min(ceiling, 0.22 * Math.max(this.volume, volumeEnd)) : ceiling;
    let outputEnergy = 0;
    let outputPeak = 0;
    // Allocate only when the channel layout changes, never per render sample.
    if (this.delay.length !== output.length) {
      this.delay = Array.from({ length: output.length }, () => new Float32Array(this.delayLength));
      this.head = this.tail = 0;
    }
    const capacity = this.peaks.length;
    for (let i = 0; i < length; i++) {
      const fraction = (i + 1) / length;
      const gain = this.gain + (gainEnd - this.gain) * fraction;
      const volume = this.volume + (volumeEnd - this.volume) * fraction;
      let peak = 0;
      let delayedPeak = 0;
      for (let c = 0; c < output.length; c++) {
        const channel = input[Math.min(c, input.length - 1)];
        const sample = Number.isFinite(channel?.[i]) ? channel[i] : 0;
        output[c][i] = this.delay[c][this.cursor];
        delayedPeak = Math.max(delayedPeak, Math.abs(output[c][i]));
        this.delay[c][this.cursor] = sample * gain * volume;
        peak = Math.max(peak, Math.abs(this.delay[c][this.cursor]));
      }
      // Monotonic queue: maximum of the delayed sample and its future 10 ms.
      while (this.head !== this.tail && this.times[this.head] < this.frame - this.delayLength) this.head = (this.head + 1) % capacity;
      while (this.head !== this.tail && this.peaks[(this.tail - 1 + capacity) % capacity] <= peak) this.tail = (this.tail - 1 + capacity) % capacity;
      this.peaks[this.tail] = peak;
      this.times[this.tail] = this.frame++;
      this.tail = (this.tail + 1) % capacity;
      const limit = this.peaks[this.head] > 0 ? Math.min(1, transientCeiling / this.peaks[this.head]) : 1;
      this.limiter += (limit - this.limiter) * (limit < this.limiter ? this.attack : this.release);
      // Guard immediate ceiling edits and extreme overload, linked across channels.
      const safeGain = delayedPeak > 0 ? Math.min(this.limiter, transientCeiling / delayedPeak) : this.limiter;
      for (let c = 0; c < output.length; c++) {
        output[c][i] *= safeGain;
        outputEnergy += output[c][i] * output[c][i];
        outputPeak = Math.max(outputPeak, Math.abs(output[c][i]));
      }
      this.cursor = (this.cursor + 1) % this.delayLength;
    }
    this.gain = gainEnd;
    this.volume = volumeEnd;
    this.metrics.inputRms = Math.sqrt(blockEnergy);
    this.outputEnergy += (outputEnergy / Math.max(1, length * output.length) - this.outputEnergy) * (1 - Math.exp(-seconds / 0.015));
    this.metrics.outputRms = Math.sqrt(this.outputEnergy);
    this.metrics.gain = this.gain * this.limiter;
    this.metrics.outputPeak = outputPeak;
  }
}
