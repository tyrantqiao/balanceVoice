import { BalanceDSP } from './dsp.js';

class BalanceNormalizer extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.dsp = new BalanceDSP(sampleRate, options.processorOptions);
    this.frames = 0;
    this.port.onmessage = ({ data }) => this.dsp.configure(data);
  }

  process(inputs, outputs) {
    this.dsp.process(inputs[0] || [], outputs[0]);
    this.frames += outputs[0][0]?.length || 0;
    if (this.frames >= sampleRate / 5) {
      this.port.postMessage(this.dsp.metrics);
      this.frames = 0;
    }
    return true;
  }
}

registerProcessor('balance-normalizer', BalanceNormalizer);
