// Shared by the content script and AudioWorklet; no DOM or audio is retained here.
globalThis.BalanceLeveler = class BalanceLeveler {
  constructor() {
    this.energy = 0;
    this.fastEnergy = 0;
    this.gain = 1;
    this.hold = 0;
    this.initialized = false;
  }

  update(energy, seconds, enabled = true) {
    if (!enabled) {
      this.gain = 1;
      this.initialized = false;
      this.hold = 0;
      return 1;
    }
    // Do not learn silence or boost the next sentence after a pause.
    if (energy <= 0.0018 ** 2) return this.gain;
    if (!this.initialized) {
      this.energy = this.fastEnergy = energy;
      this.initialized = true;
      this.gain = Math.max(0.05, Math.min(4, 0.1 / Math.sqrt(energy)));
    }
    this.energy += (energy - this.energy) * (1 - Math.exp(-seconds / (energy > this.energy ? 0.6 : 2)));
    this.fastEnergy += (energy - this.fastEnergy) * (1 - Math.exp(-seconds / 0.025));
    const desired = Math.max(0.05, Math.min(4,
      0.1 / Math.sqrt(this.energy), 0.14 / Math.sqrt(this.fastEnergy)));
    if (desired < this.gain) this.hold = 0.8;
    else this.hold = Math.max(0, this.hold - seconds);
    // A small dead band and slow recovery keep breaths and beats from pumping.
    if (desired < this.gain || (!this.hold && desired > this.gain * 1.02)) {
      this.gain += (desired - this.gain) *
        (1 - Math.exp(-seconds / (desired < this.gain ? 0.035 : 4)));
    }
    return this.gain;
  }
};
