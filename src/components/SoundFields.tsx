import React, { useEffect, useState } from 'react';
import { Plus, Volume2 } from 'lucide-react';
import type { SoundType } from '../types';
import { SOUND_OPTIONS } from '../lib/sounds';
import { describeSkippedSongs, pickSong, songTitle } from '../lib/songs';
import { addSongs, previewSong, stopSongPreview, useSongs } from '../lib/songLibrary';
import { isNativeAndroid } from '../lib/platform';
import { audioService } from '../services/audioService';

interface SoundFieldsProps {
  sound: SoundType;
  onSound: (sound: SoundType) => void;
  /** The chosen alarm song, used when `sound` is Local music. */
  songId?: string;
  onSongId: (songId: string | undefined) => void;
  ring: boolean;
  onRing: (ring: boolean) => void;
  /** Previews a built-in sound. Songs are previewed here. */
  onPreview: () => void;
  /** Clock alarms always loop, so the checkbox stays on. */
  alwaysRing?: boolean;
}

const selectClass =
  'flex-1 min-w-0 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg px-2.5 py-1.5 text-slate-900 dark:text-slate-200';

export const SoundFields: React.FC<SoundFieldsProps> = ({
  sound,
  onSound,
  songId,
  onSongId,
  ring,
  onRing,
  onPreview,
  alwaysRing = false,
}) => {
  const { songs, ready } = useSongs();
  const [note, setNote] = useState('');
  const [adding, setAdding] = useState(false);
  const selectedSong = pickSong(songId, songs.map((song) => song.id));

  // A full song may be previewing: stop it when the editor closes.
  useEffect(() => () => void stopSongPreview(), []);

  const preview = () => {
    if (sound !== 'music') {
      onPreview();
      return;
    }
    if (!selectedSong) {
      audioService.playSound('chime');
      return;
    }
    void previewSong(selectedSong).then((result) => {
      if (result === 'failed') setNote('This song could not play on this device. Try another file.');
    });
  };

  // Called straight from the tap: the browser only opens its file picker during a gesture.
  const add = () => {
    setNote('');
    setAdding(true);
    addSongs()
      .then((result) => {
        if (result.added.length > 0) onSongId(result.added[0].id);
        setNote(describeSkippedSongs(result.skipped));
      })
      .catch(() => setNote('Could not add songs.'))
      .finally(() => setAdding(false));
  };

  return (
    <div className="space-y-2">
      <div>
        <label className="block text-[11px] text-slate-500 dark:text-slate-400 mb-1">Sound</label>
        <div className="flex items-center gap-1.5">
          <select
            value={sound}
            onChange={(event) => {
              const next = event.target.value as SoundType;
              onSound(next);
              if (next === 'voice') onRing(false);
            }}
            className={selectClass}
          >
            {SOUND_OPTIONS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={preview}
            title="Preview sound"
            aria-label="Preview sound"
            className="p-2 rounded-lg bg-indigo-50 dark:bg-indigo-950 text-indigo-700 dark:text-indigo-300 hover:bg-indigo-100 dark:hover:bg-indigo-900 border border-indigo-200 dark:border-indigo-700/60"
          >
            <Volume2 className="w-4 h-4" />
          </button>
        </div>
      </div>

      {sound === 'music' && (
        <div className="space-y-1.5">
          {songs.length > 0 ? (
            <div>
              <label className="block text-[11px] text-slate-500 dark:text-slate-400 mb-1">Song</label>
              <div className="flex items-center gap-1.5">
                <select
                  value={selectedSong ?? ''}
                  onChange={(event) => onSongId(event.target.value || undefined)}
                  className={selectClass}
                  aria-label="Song"
                >
                  {songs.map((song) => (
                    <option key={song.id} value={song.id}>
                      {songTitle(song.name)}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={add}
                  disabled={adding}
                  title="Add songs"
                  aria-label="Add songs"
                  className="p-2 rounded-lg bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 disabled:opacity-50"
                >
                  <Plus className="w-4 h-4" />
                </button>
              </div>
            </div>
          ) : (
            ready && (
              <div className="flex items-center justify-between gap-2 rounded-lg border border-amber-200 dark:border-amber-800/60 bg-amber-50 dark:bg-amber-950/40 px-2.5 py-2">
                <p className="text-[11px] text-amber-800 dark:text-amber-200">No songs on this device yet. Until you add one, the chime plays.</p>
                <button
                  type="button"
                  onClick={add}
                  disabled={adding}
                  className="shrink-0 rounded-lg bg-indigo-600 px-2.5 py-1.5 text-[11px] font-semibold text-white disabled:opacity-50"
                >
                  {adding ? 'Adding…' : 'Add songs'}
                </button>
              </div>
            )
          )}
          <p className="text-[11px] text-slate-500 dark:text-slate-400">
            Plays until you dismiss or snooze it. Songs stay on this device.
            {!isNativeAndroid() && ' On the website, it rings only while Dayflow is open.'}
          </p>
          {note && <p className="text-[11px] text-amber-700 dark:text-amber-300">{note}</p>}
        </div>
      )}

      {sound === 'voice' && (
        <p className="text-[11px] text-slate-500 dark:text-slate-400">Voice plays once in the app and is not looped.</p>
      )}
      <label className="flex items-center justify-between gap-3 text-[11px] text-slate-600 dark:text-slate-300">
        <span>Ring until dismissed</span>
        <input
          type="checkbox"
          checked={alwaysRing || ring || sound === 'music'}
          disabled={alwaysRing || sound === 'music' || sound === 'voice'}
          onChange={(event) => onRing(event.target.checked)}
          aria-label="Ring until dismissed"
          className="w-4 h-4 rounded border-slate-300 disabled:opacity-60"
        />
      </label>
    </div>
  );
};
