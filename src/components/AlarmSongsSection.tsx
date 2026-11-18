import React, { useEffect, useState } from 'react';
import { Music, Pause, Play, Plus, Trash2 } from 'lucide-react';
import { addSongs, previewSong, removeSong, stopSongPreview, useSongs } from '../lib/songLibrary';
import { MAX_SONGS, describeSkippedSongs, formatSongSize, songTitle } from '../lib/songs';
import { isNativeAndroid } from '../lib/platform';
import { showConfirm } from './ui/AppDialog';

/** Settings: the device's alarm songs. Any task, habit or alarm set to Local music picks one. */
export const AlarmSongsSection: React.FC = () => {
  const { songs, ready } = useSongs();
  const [playing, setPlaying] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [note, setNote] = useState('');

  // Stop a preview when Settings closes.
  useEffect(() => () => void stopSongPreview(), []);

  // Called straight from the tap: the browser only opens its file picker during a gesture.
  const add = () => {
    setNote('');
    setAdding(true);
    addSongs()
      .then((result) => {
        const skipped = describeSkippedSongs(result.skipped);
        const added = result.added.length;
        setNote([added > 0 ? `Added ${added} ${added === 1 ? 'song' : 'songs'}.` : '', skipped].filter(Boolean).join(' '));
      })
      .catch(() => setNote('Could not add songs.'))
      .finally(() => setAdding(false));
  };

  const togglePlay = (id: string) => {
    if (playing === id) {
      void stopSongPreview();
      setPlaying(null);
      return;
    }
    setPlaying(id);
    const clear = () => setPlaying((current) => (current === id ? null : current));
    void previewSong(id, clear).then((result) => {
      if (result !== 'failed') return;
      clear();
      setNote('That song could not play on this device. Try another file.');
    });
  };

  const remove = async (id: string, name: string) => {
    const ok = await showConfirm({
      title: 'Remove this song?',
      message: `${songTitle(name)} will be removed. Its alarms will use your first song, or the chime.`,
      confirmLabel: 'Remove',
      tone: 'danger',
    });
    if (!ok) return;
    if (playing === id) setPlaying(null);
    try {
      await removeSong(id);
    } catch {
      setNote('Could not remove the song.');
    }
  };

  return (
    <section aria-labelledby="settings-alarm-songs" className="space-y-2 border-t border-slate-200 pt-3 dark:border-slate-800">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="settings-alarm-songs" className="flex items-center gap-2 text-sm font-semibold">
          <Music aria-hidden="true" className="size-4 text-indigo-500" />
          Alarm songs
        </h3>
        <button
          type="button"
          onClick={add}
          disabled={adding || songs.length >= MAX_SONGS}
          className="flex min-h-10 shrink-0 items-center gap-1 rounded-lg px-2.5 font-semibold text-indigo-700 hover:bg-indigo-50 disabled:opacity-50 dark:text-indigo-300 dark:hover:bg-indigo-950"
        >
          <Plus className="w-3.5 h-3.5" />
          {adding ? 'Adding…' : 'Add songs'}
        </button>
      </div>
      <p className="text-xs leading-relaxed text-slate-600 dark:text-slate-400">
        {ready && songs.length === 0 ? 'Add a song to use it as an alarm.' : 'Choose Local music to use a song for a task, habit, or alarm.'}
      </p>
      <details className="text-xs text-slate-600 dark:text-slate-400">
        <summary className="w-fit cursor-pointer rounded py-1 font-medium text-indigo-700 focus-visible:outline-2 focus-visible:outline-indigo-500 dark:text-indigo-300">Song limits and storage</summary>
        <p className="mt-2 leading-relaxed">
          Up to {MAX_SONGS} songs, 15 MB each. Songs stay on this device.
          {!isNativeAndroid() && ' On the website, alarms ring only while Dayflow is open.'}
        </p>
      </details>

      {songs.length > 0 && (
        <ul className="divide-y divide-slate-200 dark:divide-slate-800 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
          {songs.map((song) => (
            <li key={song.id} className="flex items-center gap-2 px-2.5 py-2">
              <button
                type="button"
                onClick={() => togglePlay(song.id)}
                aria-label={playing === song.id ? `Stop ${songTitle(song.name)}` : `Play ${songTitle(song.name)}`}
                className="shrink-0 p-2 rounded-full bg-indigo-50 dark:bg-indigo-950 text-indigo-700 dark:text-indigo-300"
              >
                {playing === song.id ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
              </button>
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-semibold text-slate-800 dark:text-slate-200">{songTitle(song.name)}</p>
                <p className="text-[10px] text-slate-400">{formatSongSize(song.size)}</p>
              </div>
              <button
                type="button"
                onClick={() => void remove(song.id, song.name)}
                aria-label={`Remove ${songTitle(song.name)}`}
                className="shrink-0 p-2 rounded-lg text-slate-400 hover:text-rose-600"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {note && <p className="text-[11px] text-slate-600 dark:text-slate-300">{note}</p>}
    </section>
  );
};
