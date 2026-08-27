let audioContext: AudioContext | null = null;

function scheduleNote(context: AudioContext, frequency: number, startAt: number): void {
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  const endAt = startAt + 0.16;

  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(frequency, startAt);
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.exponentialRampToValueAtTime(0.12, startAt + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, endAt);
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start(startAt);
  oscillator.stop(endAt);
}

export async function playSessionFinishSound(): Promise<void> {
  try {
    audioContext ??= new AudioContext();
    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }
    const startAt = audioContext.currentTime;
    scheduleNote(audioContext, 660, startAt);
    scheduleNote(audioContext, 880, startAt + 0.12);
  } catch {
    // Audio can be unavailable or blocked until a user gesture. Completion
    // signals must never interrupt the session UI.
  }
}
