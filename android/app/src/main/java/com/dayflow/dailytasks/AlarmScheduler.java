package com.dayflow.dailytasks;

import android.app.ActivityOptions;
import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.media.AudioAttributes;
import android.media.MediaPlayer;
import android.net.Uri;
import android.os.Build;
import android.provider.OpenableColumns;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.Calendar;
import java.util.UUID;

/** Stores the device song library and the pending ring list, and talks to AlarmManager. */
public final class AlarmScheduler {
    static final String PREFS = "dayflow_alarms";
    static final String KEY_PLANS = "plans";
    static final String KEY_EVENTS = "events";
    /** Name of the single song saved before the library existed. Migrated, then removed. */
    static final String KEY_MUSIC_NAME = "music_name";
    /** JSON array of {id, name, size, addedAt}, oldest first. */
    static final String KEY_SONGS = "songs";
    /** Set on a plan while it is snoozed, so a timezone rebuild keeps the snooze time. */
    static final String KEY_SNOOZED = "snoozed";
    /** The single song saved before the library existed. */
    static final String MUSIC_FILE = "reminder-music";
    static final String SONG_DIR = "songs";
    static final String LEGACY_SONG_ID = "legacy";
    static final int MAX_MUSIC_BYTES = 15 * 1024 * 1024;
    static final int MAX_SONGS = 30;

    static final String EXTRA_ID = "id";
    static final String EXTRA_TITLE = "title";
    static final String EXTRA_BODY = "body";
    static final String EXTRA_SOUND = "sound";
    static final String EXTRA_KIND = "kind";
    static final String EXTRA_SNOOZE = "snoozeMinutes";
    static final String EXTRA_NOTIFICATION_ID = "notificationId";
    static final String EXTRA_TIME = "time";
    static final String EXTRA_DAYS = "days";

    private static MediaPlayer previewPlayer;

    private AlarmScheduler() {}

    static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static File legacyMusicFile(Context context) {
        return new File(context.getFilesDir(), MUSIC_FILE);
    }

    static boolean isValidSongId(String id) {
        return id != null && id.matches("[A-Za-z0-9-]{1,64}");
    }

    static File songDir(Context context) {
        File dir = new File(context.getFilesDir(), SONG_DIR);
        if (!dir.exists()) dir.mkdirs();
        return dir;
    }

    static File songFile(Context context, String id) {
        return new File(songDir(context), id);
    }

    static void replace(Context context, JSONArray plans) {
        cancelAll(context);
        prefs(context).edit().putString(KEY_PLANS, plans == null ? "[]" : plans.toString()).apply();
        restore(context);
    }

    static void restore(Context context) {
        JSONArray plans = readPlans(context);
        for (int i = 0; i < plans.length(); i++) {
            JSONObject plan = plans.optJSONObject(i);
            if (plan == null) continue;
            long at = plan.optLong("at", 0);
            if (at <= System.currentTimeMillis()) continue;
            schedule(context, plan, at);
        }
    }

    /**
     * Re-registers the stored plans after the wall clock moved under them. After a
     * timezone change, a repeating alarm's next ring is recomputed from its rule,
     * so 07:00 stays 07:00 local. Task and habit plans keep their instant; the app
     * rebuilds them from its own data the next time it opens.
     */
    static void restoreAfterTimezoneChange(Context context) {
        JSONArray plans = readPlans(context);
        long now = System.currentTimeMillis();
        boolean changed = false;
        for (int i = 0; i < plans.length(); i++) {
            JSONObject plan = plans.optJSONObject(i);
            if (plan == null || !"alarm".equals(plan.optString("kind")) || plan.optBoolean(KEY_SNOOZED, false)) continue;
            long following = nextRepeat(plan.optString("time", ""), daysToCsv(plan.optJSONArray("daysOfWeek")), now);
            if (following <= 0 || following == plan.optLong("at", 0)) continue;
            try {
                plan.put("at", following);
                changed = true;
            } catch (Exception ignored) {
                // Keep the stored instant; the app resyncs the rule when it next opens.
            }
        }
        if (changed) prefs(context).edit().putString(KEY_PLANS, plans.toString()).apply();
        restore(context);
    }

    static void schedule(Context context, JSONObject plan, long at) {
        int requestCode = plan.optInt("notificationId", plan.optString("id", "alarm").hashCode());
        Intent intent = new Intent(context, DayflowAlarmReceiver.class);
        intent.putExtra(EXTRA_ID, plan.optString("id"));
        intent.putExtra(EXTRA_TITLE, plan.optString("title", "Alarm"));
        intent.putExtra(EXTRA_BODY, plan.optString("body", ""));
        intent.putExtra(EXTRA_SOUND, plan.optString("sound", "chime"));
        intent.putExtra(EXTRA_KIND, plan.optString("kind", "alarm"));
        intent.putExtra(EXTRA_SNOOZE, plan.optInt("snoozeMinutes", 10));
        intent.putExtra(EXTRA_NOTIFICATION_ID, requestCode);
        intent.putExtra(EXTRA_TIME, plan.optString("time", ""));
        intent.putExtra(EXTRA_DAYS, daysToCsv(plan.optJSONArray("daysOfWeek")));
        PendingIntent pending = alarmPending(context, requestCode, intent);
        AlarmManager manager = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (manager == null) return;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                manager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pending);
            } else {
                manager.setExact(AlarmManager.RTC_WAKEUP, at, pending);
            }
        } catch (SecurityException ignored) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pending);
            } else {
                manager.set(AlarmManager.RTC_WAKEUP, at, pending);
            }
        }
    }

    static void cancelAll(Context context) {
        JSONArray plans = readPlans(context);
        AlarmManager manager = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (manager == null) return;
        for (int i = 0; i < plans.length(); i++) {
            JSONObject plan = plans.optJSONObject(i);
            if (plan == null) continue;
            int requestCode = plan.optInt("notificationId", 0);
            int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
            PendingIntent broadcast = PendingIntent.getBroadcast(
                context,
                requestCode,
                new Intent(context, DayflowAlarmReceiver.class),
                flags
            );
            manager.cancel(broadcast);
            broadcast.cancel();
            PendingIntent activity = ringPending(context, requestCode, new Intent(context, DayflowRingActivity.class));
            manager.cancel(activity);
            activity.cancel();
        }
    }

    private static PendingIntent alarmPending(Context context, int requestCode, Intent intent) {
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getBroadcast(context, requestCode, intent, flags);
    }

    /** Cancels a ringing-screen pending intent left by an older build. */
    private static PendingIntent ringPending(Context context, int requestCode, Intent activity) {
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            ActivityOptions options = ActivityOptions.makeBasic();
            // Only the creator mode may be set while building the pending intent.
            // AlarmManager sends it, so the sender mode is left unset.
            options.setPendingIntentCreatorBackgroundActivityStartMode(
                ActivityOptions.MODE_BACKGROUND_ACTIVITY_START_ALLOWED
            );
            return PendingIntent.getActivity(context, requestCode, activity, flags, options.toBundle());
        }
        return PendingIntent.getActivity(context, requestCode, activity, flags);
    }

    static JSONArray readPlans(Context context) {
        try {
            return new JSONArray(prefs(context).getString(KEY_PLANS, "[]"));
        } catch (Exception ignored) {
            return new JSONArray();
        }
    }

    static void snooze(Context context, Intent fired, int minutes) {
        long at = System.currentTimeMillis() + minutes * 60_000L;
        String id = fired.getStringExtra(EXTRA_ID);
        JSONArray plans = readPlans(context);
        JSONObject matched = null;
        for (int i = 0; i < plans.length(); i++) {
            JSONObject plan = plans.optJSONObject(i);
            if (plan != null && id != null && id.equals(plan.optString("id"))) {
                try {
                    plan.put("at", at);
                    plan.put(KEY_SNOOZED, true);
                } catch (Exception ignored) {
                    // The original plan still rings at its old time if this write fails.
                }
                matched = plan;
                break;
            }
        }
        prefs(context).edit().putString(KEY_PLANS, plans.toString()).apply();
        if (matched != null) schedule(context, matched, at);
        enqueue(context, "snooze", fired, at - minutes * 60_000L);
    }

    static void dismiss(Context context, Intent fired) {
        String id = fired.getStringExtra(EXTRA_ID);
        String kind = fired.getStringExtra(EXTRA_KIND);
        String days = fired.getStringExtra(EXTRA_DAYS);
        String time = fired.getStringExtra(EXTRA_TIME);
        JSONArray plans = readPlans(context);
        JSONArray next = new JSONArray();
        JSONObject kept = null;
        for (int i = 0; i < plans.length(); i++) {
            JSONObject plan = plans.optJSONObject(i);
            if (plan == null) continue;
            if (id != null && id.equals(plan.optString("id")) && "alarm".equals(kind) && days != null && !days.isEmpty()) {
                long following = nextRepeat(time, days, System.currentTimeMillis());
                if (following > 0) {
                    try {
                        plan.put("at", following);
                        plan.remove(KEY_SNOOZED);
                    } catch (Exception ignored) {
                        // Leave the stored time; the app resyncs the rule when it next opens.
                    }
                    kept = plan;
                    next.put(plan);
                }
                continue;
            }
            if (id != null && id.equals(plan.optString("id"))) continue;
            next.put(plan);
        }
        prefs(context).edit().putString(KEY_PLANS, next.toString()).apply();
        if (kept != null) schedule(context, kept, kept.optLong("at"));
        enqueue(context, "dismiss", fired, System.currentTimeMillis());
    }

    static void enqueue(Context context, String type, Intent fired, long at) {
        try {
            JSONArray events;
            synchronized (AlarmScheduler.class) {
                events = new JSONArray(prefs(context).getString(KEY_EVENTS, "[]"));
                JSONObject event = new JSONObject();
                event.put("type", type);
                event.put("id", fired.getStringExtra(EXTRA_ID));
                event.put("kind", fired.getStringExtra(EXTRA_KIND));
                event.put("at", at);
                event.put("snoozeMinutes", fired.getIntExtra(EXTRA_SNOOZE, 10));
                events.put(event);
                prefs(context).edit().putString(KEY_EVENTS, events.toString()).apply();
            }
            DayflowAlarmPlugin.emit(
                type,
                fired.getStringExtra(EXTRA_ID),
                fired.getStringExtra(EXTRA_KIND),
                at,
                fired.getIntExtra(EXTRA_SNOOZE, 10)
            );
        } catch (Exception ignored) {
            // The ringing screen already stopped; the app reconciles on the next open.
        }
    }

    static JSONArray drainEvents(Context context) {
        synchronized (AlarmScheduler.class) {
            JSONArray events;
            try {
                events = new JSONArray(prefs(context).getString(KEY_EVENTS, "[]"));
            } catch (Exception ignored) {
                events = new JSONArray();
            }
            prefs(context).edit().putString(KEY_EVENTS, "[]").apply();
            return events;
        }
    }

    /** Thrown for a picked file that cannot join the library; the message is the reason. */
    static final class SongException extends IOException {
        final String name;

        SongException(String reason, String name) {
            super(reason);
            this.name = name;
        }
    }

    /** Display name of a picked file, or "Song". */
    static String displayName(Context context, Uri uri) {
        try (Cursor cursor = context.getContentResolver().query(
            uri, new String[] {OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                String name = cursor.getString(0);
                if (name != null && !name.isEmpty()) return name;
            }
        } catch (Exception ignored) {
            // Some providers do not report a name.
        }
        return "Song";
    }

    private static JSONArray readSongEntries(Context context) {
        try {
            return new JSONArray(prefs(context).getString(KEY_SONGS, "[]"));
        } catch (Exception ignored) {
            return new JSONArray();
        }
    }

    /** Moves the single pre-library song into the library once. */
    private static void migrateLegacySong(Context context) {
        File legacy = legacyMusicFile(context);
        if (!legacy.exists()) return;
        if (legacy.length() > 0) {
            File dest = songFile(context, LEGACY_SONG_ID);
            if (dest.exists()) dest.delete();
            if (legacy.renameTo(dest)) {
                try {
                    JSONArray entries = readSongEntries(context);
                    JSONObject entry = new JSONObject();
                    entry.put("id", LEGACY_SONG_ID);
                    entry.put("name", prefs(context).getString(KEY_MUSIC_NAME, "Song"));
                    entry.put("size", dest.length());
                    entry.put("addedAt", 0);
                    JSONArray next = new JSONArray();
                    next.put(entry);
                    for (int i = 0; i < entries.length(); i++) {
                        JSONObject other = entries.optJSONObject(i);
                        if (other != null && !LEGACY_SONG_ID.equals(other.optString("id"))) next.put(other);
                    }
                    prefs(context).edit()
                        .putString(KEY_SONGS, next.toString())
                        .remove(KEY_MUSIC_NAME)
                        .apply();
                } catch (Exception ignored) {
                    // The file is in place under songs/; it simply stays unlisted.
                }
                return;
            }
        }
        legacy.delete();
        prefs(context).edit().remove(KEY_MUSIC_NAME).apply();
    }

    /**
     * Guards the song list and folder. Kept apart from AlarmScheduler.class, which
     * dismiss, snooze and the event queue use, so ringing never waits on song I/O.
     */
    private static final Object SONGS_LOCK = new Object();
    /** A temp copy older than this was left by a copy that died; delete it. */
    private static final long STALE_TEMP_MS = 60 * 60 * 1000L;

    /** Songs whose files exist, oldest first. Drops entries whose file is gone and stray files. */
    static JSONArray listSongs(Context context) {
        synchronized (SONGS_LOCK) {
            migrateLegacySong(context);
            JSONArray entries = readSongEntries(context);
            JSONArray kept = new JSONArray();
            java.util.Set<String> keptIds = new java.util.HashSet<>();
            for (int i = 0; i < entries.length(); i++) {
                JSONObject entry = entries.optJSONObject(i);
                if (entry == null) continue;
                String id = entry.optString("id");
                if (!isValidSongId(id) || keptIds.contains(id)) continue;
                File file = songFile(context, id);
                if (file.exists() && file.length() > 0) {
                    kept.put(entry);
                    keptIds.add(id);
                }
            }
            if (kept.length() != entries.length()) prefs(context).edit().putString(KEY_SONGS, kept.toString()).apply();
            deleteStrayFiles(context, keptIds);
            return kept;
        }
    }

    /**
     * Files no entry lists: a finished copy whose entry was never saved, or an old
     * temp copy from a process that was killed mid-copy. A temp file that is still
     * fresh may belong to a copy running right now, so it is left alone.
     */
    private static void deleteStrayFiles(Context context, java.util.Set<String> keptIds) {
        File[] files = songDir(context).listFiles();
        if (files == null) return;
        long now = System.currentTimeMillis();
        for (File file : files) {
            String name = file.getName();
            if (name.endsWith(".tmp")) {
                if (now - file.lastModified() > STALE_TEMP_MS) file.delete();
            } else if (!keptIds.contains(name)) {
                file.delete();
            }
        }
    }

    /**
     * Copies a picked file into the library and returns its entry. The copy (up to
     * 15 MB, maybe a cloud download) runs without any lock; only the final rename
     * and list update take SONGS_LOCK.
     */
    static JSONObject addSong(Context context, Uri uri) throws IOException {
        String name = "Song";
        long reported = -1;
        try (Cursor cursor = context.getContentResolver().query(
            uri,
            new String[] {OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE},
            null,
            null,
            null
        )) {
            if (cursor != null && cursor.moveToFirst()) {
                int nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                int sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE);
                if (nameIndex >= 0 && cursor.getString(nameIndex) != null) name = cursor.getString(nameIndex);
                if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) reported = cursor.getLong(sizeIndex);
            }
        } catch (Exception ignored) {
            // Size is checked again while copying.
        }
        if (reported > MAX_MUSIC_BYTES) throw new SongException("too-large", name);
        if (listSongs(context).length() >= MAX_SONGS) throw new SongException("limit", name);

        String id = UUID.randomUUID().toString();
        File temp = new File(songDir(context), id + ".tmp");
        long total = 0;
        try (InputStream in = context.getContentResolver().openInputStream(uri);
             OutputStream out = new FileOutputStream(temp)) {
            if (in == null) throw new SongException("empty", name);
            byte[] buffer = new byte[8192];
            int read;
            while ((read = in.read(buffer)) >= 0) {
                total += read;
                if (total > MAX_MUSIC_BYTES) throw new SongException("too-large", name);
                if (read > 0) out.write(buffer, 0, read);
            }
        } catch (SongException error) {
            temp.delete();
            throw error;
        } catch (Exception error) {
            temp.delete();
            throw new SongException("failed", name);
        }
        if (total <= 0) {
            temp.delete();
            throw new SongException("empty", name);
        }

        synchronized (SONGS_LOCK) {
            JSONArray songs = listSongs(context);
            if (songs.length() >= MAX_SONGS) {
                temp.delete();
                throw new SongException("limit", name);
            }
            File dest = songFile(context, id);
            if (!temp.renameTo(dest)) {
                temp.delete();
                throw new SongException("failed", name);
            }
            try {
                JSONObject entry = new JSONObject();
                entry.put("id", id);
                entry.put("name", name);
                entry.put("size", total);
                entry.put("addedAt", System.currentTimeMillis());
                songs.put(entry);
                // commit(): the file is in place, so the entry must be on disk before
                // anything else lists the folder, or the file would look stray.
                prefs(context).edit().putString(KEY_SONGS, songs.toString()).commit();
                return entry;
            } catch (Exception error) {
                dest.delete();
                throw new SongException("failed", name);
            }
        }
    }

    static JSONArray removeSong(Context context, String id) {
        stopPreview();
        synchronized (SONGS_LOCK) {
            JSONArray songs = listSongs(context);
            if (!isValidSongId(id)) return songs;
            songFile(context, id).delete();
            JSONArray kept = new JSONArray();
            for (int i = 0; i < songs.length(); i++) {
                JSONObject entry = songs.optJSONObject(i);
                if (entry != null && !id.equals(entry.optString("id"))) kept.put(entry);
            }
            prefs(context).edit().putString(KEY_SONGS, kept.toString()).apply();
            return kept;
        }
    }

    /**
     * The file for a ring sound: `music:<id>` plays that song; a plain "music",
     * or a song that is no longer here, plays the oldest song. Null without songs.
     */
    static File resolveSongFile(Context context, String sound) {
        if (sound == null || !sound.startsWith("music")) return null;
        String id = sound.startsWith("music:") ? sound.substring("music:".length()) : "";
        if (isValidSongId(id)) {
            File chosen = songFile(context, id);
            if (chosen.exists() && chosen.length() > 0) return chosen;
        }
        JSONArray songs = listSongs(context);
        for (int i = 0; i < songs.length(); i++) {
            JSONObject entry = songs.optJSONObject(i);
            if (entry == null) continue;
            File file = songFile(context, entry.optString("id"));
            if (file.exists() && file.length() > 0) return file;
        }
        return null;
    }

    static void preview(Context context, String sound) {
        stopPreview();
        MediaPlayer player = buildPlayer(context, sound, false);
        if (player == null) return;
        previewPlayer = player;
        player.setOnCompletionListener(completed -> stopPreview());
        player.start();
    }

    static void stopPreview() {
        if (previewPlayer == null) return;
        try {
            previewPlayer.stop();
        } catch (Exception ignored) {
            // already stopped
        }
        previewPlayer.release();
        previewPlayer = null;
    }

    /** A prepared player for a ring sound. A song that cannot play falls back to the chime. */
    static MediaPlayer buildPlayer(Context context, String sound, boolean loop) {
        File song = resolveSongFile(context, sound);
        if (song != null) {
            MediaPlayer player = preparePlayer(context, song, 0, loop);
            if (player != null) return player;
            return preparePlayer(context, null, R.raw.chime, loop);
        }
        MediaPlayer player = preparePlayer(context, null, rawFor(sound), loop);
        return player != null ? player : preparePlayer(context, null, R.raw.chime, loop);
    }

    private static MediaPlayer preparePlayer(Context context, File file, int raw, boolean loop) {
        MediaPlayer player = new MediaPlayer();
        try {
            player.setAudioAttributes(new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ALARM)
                .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                .build());
            if (file != null) {
                player.setDataSource(file.getAbsolutePath());
            } else {
                android.content.res.AssetFileDescriptor fd = context.getResources().openRawResourceFd(raw);
                player.setDataSource(fd.getFileDescriptor(), fd.getStartOffset(), fd.getLength());
                fd.close();
            }
            player.setLooping(loop);
            player.prepare();
            return player;
        } catch (Exception ignored) {
            player.release();
            return null;
        }
    }

    static int rawFor(String sound) {
        if ("bell".equals(sound)) return R.raw.bell;
        if ("digital".equals(sound)) return R.raw.digital;
        if ("gentle".equals(sound)) return R.raw.gentle;
        return R.raw.chime;
    }

    private static String daysToCsv(JSONArray days) {
        if (days == null || days.length() == 0) return "";
        StringBuilder builder = new StringBuilder();
        for (int i = 0; i < days.length(); i++) {
            if (builder.length() > 0) builder.append(',');
            builder.append(days.optInt(i));
        }
        return builder.toString();
    }

    /** Next matching weekday strictly after `after`. Returns 0 when the rule is once. */
    static long nextRepeat(String time, String daysCsv, long after) {
        if (time == null || !time.contains(":") || daysCsv == null || daysCsv.isEmpty()) return 0;
        String[] parts = time.split(":");
        int hours;
        int minutes;
        try {
            hours = Integer.parseInt(parts[0]);
            minutes = Integer.parseInt(parts[1]);
        } catch (Exception ignored) {
            return 0;
        }
        boolean[] allowed = new boolean[7];
        for (String piece : daysCsv.split(",")) {
            try {
                int day = Integer.parseInt(piece.trim());
                if (day >= 0 && day <= 6) allowed[day] = true;
            } catch (Exception ignored) {
                // skip a bad day token
            }
        }
        Calendar calendar = Calendar.getInstance();
        calendar.setTimeInMillis(after);
        for (int offset = 0; offset < 8; offset++) {
            Calendar candidate = (Calendar) calendar.clone();
            candidate.add(Calendar.DATE, offset);
            candidate.set(Calendar.HOUR_OF_DAY, hours);
            candidate.set(Calendar.MINUTE, minutes);
            candidate.set(Calendar.SECOND, 0);
            candidate.set(Calendar.MILLISECOND, 0);
            if (candidate.getTimeInMillis() <= after) continue;
            int javaDay = candidate.get(Calendar.DAY_OF_WEEK);
            int jsDay = javaDay - 1;
            if (allowed[jsDay]) return candidate.getTimeInMillis();
        }
        return 0;
    }
}
