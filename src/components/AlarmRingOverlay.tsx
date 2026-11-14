import React, { useEffect } from 'react';
import { AlarmClock } from 'lucide-react';
import type { SoundType } from '../types';
import { audioService } from '../services/audioService';
import { loopSong } from '../lib/songLibrary';
import { Button } from './ui/Button';

interface AlarmRingOverlayProps {
  title: string;
  body: string;
  sound: SoundType;
  /** With Local music: the song to loop. */
  songId?: string | null;
  snoozeMinutes: number;
  onDismiss: () => void;
  onSnooze: () => void;
}

export const AlarmRingOverlay: React.FC<AlarmRingOverlayProps> = ({
  title,
  body,
  sound,
  songId,
  snoozeMinutes,
  onDismiss,
  onSnooze,
}) => {
  useEffect(() => {
    let cancelled = false;
    if (sound === 'music') {
      // A cancelled ring never starts its song and never stops a newer ring's audio.
      void loopSong(songId, () => cancelled).then((started) => {
        if (!cancelled && !started) audioService.startLoop('chime', title);
      });
    } else {
      audioService.startLoop(sound, title);
    }
    return () => {
      cancelled = true;
      audioService.stopLoop();
    };
  }, [sound, songId, title]);

  return (
    <div className="fixed inset-0 z-[80] bg-slate-950/90 text-white flex flex-col items-center justify-center p-6">
      <AlarmClock className="w-12 h-12 text-indigo-300 mb-4" />
      <p className="text-xs uppercase tracking-[0.2em] text-indigo-200">Alarm</p>
      <h2 className="mt-2 text-3xl font-black text-center">{title}</h2>
      {body && <p className="mt-2 text-sm text-slate-300">{body}</p>}
      <div className="mt-8 flex w-full max-w-sm gap-3">
        <Button type="button" variant="secondary" className="flex-1" onClick={onSnooze}>
          Snooze {snoozeMinutes}m
        </Button>
        <Button type="button" className="flex-1" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
    </div>
  );
};
