import { SoundType } from '../types';

class AudioService {
  private ctx: AudioContext | null = null;
  private loopTimer: number | null = null;
  private fileAudio: HTMLAudioElement | null = null;
  private fileUrl: string | null = null;

  private getAudioContext(): AudioContext {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AudioCtx();
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
    return this.ctx;
  }

  public playSound(soundType: SoundType, speechText?: string) {
    try {
      if (soundType === 'voice' && speechText && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(`Reminder: ${speechText}`);
        utterance.rate = 1.0;
        utterance.pitch = 1.0;
        utterance.volume = 1.0;
        window.speechSynthesis.speak(utterance);
        return;
      }

      const ctx = this.getAudioContext();
      const now = ctx.currentTime;

      switch (soundType) {
        case 'bell':
          this.playBell(ctx, now);
          break;
        case 'digital':
          this.playDigital(ctx, now);
          break;
        case 'gentle':
          this.playGentle(ctx, now);
          break;
        case 'chime':
        default:
          this.playChime(ctx, now);
          break;
      }
    } catch (e) {
      console.warn('Audio playback restricted or unsupported:', e);
    }
  }

  private playChime(ctx: AudioContext, now: number) {
    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const gain = ctx.createGain();

    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(880, now); // A5
    osc1.frequency.exponentialRampToValueAtTime(1760, now + 0.3); // A6

    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(1318.5, now + 0.1); // E6

    gain.gain.setValueAtTime(0.01, now);
    gain.gain.linearRampToValueAtTime(0.3, now + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.8);

    osc1.connect(gain);
    osc2.connect(gain);
    gain.connect(ctx.destination);

    osc1.start(now);
    osc2.start(now + 0.1);
    osc1.stop(now + 0.8);
    osc2.stop(now + 0.8);
  }

  private playBell(ctx: AudioContext, now: number) {
    const freqs = [523.25, 659.25, 783.99]; // C5, E5, G5
    freqs.forEach((f) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(f, now);

      gain.gain.setValueAtTime(0.15, now);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 1.2);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(now);
      osc.stop(now + 1.2);
    });
  }

  private playDigital(ctx: AudioContext, now: number) {
    [0, 0.15, 0.3].forEach((delay) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'square';
      osc.frequency.setValueAtTime(1046.5, now + delay); // C6

      gain.gain.setValueAtTime(0.1, now + delay);
      gain.gain.exponentialRampToValueAtTime(0.001, now + delay + 0.08);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(now + delay);
      osc.stop(now + delay + 0.09);
    });
  }

  private playGentle(ctx: AudioContext, now: number) {
    const freqs = [329.63, 440, 523.25]; // E4, A4, C5
    freqs.forEach((f, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(f, now + idx * 0.12);

      gain.gain.setValueAtTime(0.01, now + idx * 0.12);
      gain.gain.linearRampToValueAtTime(0.2, now + idx * 0.12 + 0.05);
      gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.12 + 0.9);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(now + idx * 0.12);
      osc.stop(now + idx * 0.12 + 0.95);
    });
  }

  /**
   * Play a picked song. `loop` keeps it going until `stopLoop`. Resolves false
   * when the browser refuses (unsupported file, or playback blocked).
   */
  public async playFile(
    blob: Blob,
    loop: boolean,
    options: {
      /** Checked before starting and after play() settles; a cancelled call never keeps playing. */
      isCancelled?: () => boolean;
      /** Called when a non-looping file plays to the end. */
      onEnded?: () => void;
    } = {}
  ): Promise<boolean> {
    if (options.isCancelled?.()) return false;
    this.stopLoop();
    let audio: HTMLAudioElement | null = null;
    try {
      const url = URL.createObjectURL(blob);
      audio = new Audio(url);
      audio.loop = loop;
      const own = audio;
      if (options.onEnded) {
        own.addEventListener('ended', () => {
          if (this.fileAudio === own) options.onEnded?.();
        });
      }
      this.fileAudio = own;
      this.fileUrl = url;
      await own.play();
      // A newer call replaced this one: leave its audio alone.
      if (this.fileAudio !== own) return false;
      if (options.isCancelled?.()) {
        this.stopLoop();
        return false;
      }
      return true;
    } catch (e) {
      // Only report failures of the current file; a replaced one rejects with AbortError.
      if (audio && this.fileAudio === audio) console.warn('Song playback failed:', e);
      return false;
    }
  }

  /** Repeat a built-in chime until `stopLoop`. Local music uses `playFile`. */
  public startLoop(soundType: SoundType, speechText?: string): void {
    this.stopLoop();
    const tick = () => this.playSound(soundType === 'music' || soundType === 'voice' ? 'chime' : soundType, speechText);
    tick();
    this.loopTimer = window.setInterval(tick, 1600);
  }

  public stopLoop(): void {
    if (this.loopTimer !== null) {
      window.clearInterval(this.loopTimer);
      this.loopTimer = null;
    }
    if (this.fileAudio) {
      this.fileAudio.pause();
      this.fileAudio.src = '';
      this.fileAudio = null;
    }
    if (this.fileUrl) {
      URL.revokeObjectURL(this.fileUrl);
      this.fileUrl = null;
    }
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  }

  public playAmbientNoise(type: 'rain' | 'focus', durationSec: number = 30): () => void {
    try {
      const ctx = this.getAudioContext();
      const bufferSize = ctx.sampleRate * 2;
      const noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
      const output = noiseBuffer.getChannelData(0);

      for (let i = 0; i < bufferSize; i++) {
        output[i] = Math.random() * 2 - 1;
      }

      const whiteNoise = ctx.createBufferSource();
      whiteNoise.buffer = noiseBuffer;
      whiteNoise.loop = true;

      const filter = ctx.createBiquadFilter();
      filter.type = type === 'rain' ? 'lowpass' : 'bandpass';
      filter.frequency.setValueAtTime(type === 'rain' ? 800 : 400, ctx.currentTime);

      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.05, ctx.currentTime);

      whiteNoise.connect(filter);
      filter.connect(gain);
      gain.connect(ctx.destination);

      whiteNoise.start();

      return () => {
        try {
          whiteNoise.stop();
          whiteNoise.disconnect();
        } catch {
          // ignore cleanup errors
        }
      };
    } catch (e) {
      console.warn('Ambient noise failed:', e);
      return () => {};
    }
  }
}

export const audioService = new AudioService();
