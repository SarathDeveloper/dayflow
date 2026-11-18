package com.dayflow.dailytasks;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.AudioManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;

import androidx.core.app.NotificationCompat;

import java.util.Locale;

/**
 * Reads one reminder aloud with the phone's text-to-speech engine, then stops.
 * Runs as a short foreground service so it works with the app closed (an exact
 * alarm may start one from the background). Stays silent when the phone is on
 * silent, vibrate or Do Not Disturb, like the reminder's chime would.
 */
public class DayflowSpeakService extends Service {
    private static final String CHANNEL_ID = "dayflow_speech";
    private static final int NOTICE_ID = 43;
    private static final String EXTRA_FORCE = "force";
    private static final long MAX_RUN_MS = 30_000L;

    private TextToSpeech tts;
    private boolean ready;
    /** Texts waiting for the engine to start, then utterances not yet finished. */
    private final java.util.ArrayList<String> waiting = new java.util.ArrayList<>();
    private int speaking;
    private PowerManager.WakeLock wakeLock;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable timeout = this::finish;

    /** `force` speaks even on silent (the "Test voice" button). */
    static void start(Context context, String text) {
        start(context, text, false);
    }

    static void start(Context context, String text, boolean force) {
        if (text == null || text.isEmpty()) return;
        Intent service = new Intent(context, DayflowSpeakService.class);
        service.putExtra(SpeechScheduler.EXTRA_TEXT, text);
        service.putExtra(EXTRA_FORCE, force);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(service);
            } else {
                context.startService(service);
            }
        } catch (Exception ignored) {
            // Background start refused (no exact-alarm exemption): the notification still shows.
        }
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // Every startForegroundService call must be answered with startForeground.
        ensureChannel();
        Notification notice = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_icon)
            .setContentTitle("Reading a reminder")
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setSilent(true)
            .build();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTICE_ID, notice, android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        } else {
            startForeground(NOTICE_ID, notice);
        }

        String text = intent == null ? null : intent.getStringExtra(SpeechScheduler.EXTRA_TEXT);
        boolean force = intent != null && intent.getBooleanExtra(EXTRA_FORCE, false);
        if (text == null || text.isEmpty() || (!force && isMuted())) {
            // Nothing to say; only stop when nothing else is being read.
            if (speaking <= 0 && waiting.isEmpty()) finish();
            return START_NOT_STICKY;
        }

        acquireWakeLock();
        handler.removeCallbacks(timeout);
        handler.postDelayed(timeout, MAX_RUN_MS);
        if (ready) {
            speak(text);
            return START_NOT_STICKY;
        }
        waiting.add(text);
        if (tts != null) return START_NOT_STICKY;
        tts = new TextToSpeech(getApplicationContext(), status -> {
            if (status != TextToSpeech.SUCCESS) {
                finish();
                return;
            }
            int language = tts.setLanguage(Locale.getDefault());
            if (language == TextToSpeech.LANG_MISSING_DATA || language == TextToSpeech.LANG_NOT_SUPPORTED) {
                tts.setLanguage(Locale.ENGLISH);
            }
            tts.setAudioAttributes(new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build());
            tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                @Override
                public void onStart(String utteranceId) {}

                @Override
                public void onDone(String utteranceId) {
                    handler.post(DayflowSpeakService.this::utteranceEnded);
                }

                @Override
                public void onError(String utteranceId) {
                    handler.post(DayflowSpeakService.this::utteranceEnded);
                }
            });
            ready = true;
            for (String queued : waiting) speak(queued);
            waiting.clear();
        });
        return START_NOT_STICKY;
    }

    private void speak(String text) {
        speaking++;
        // A short pause lets the notification's vibration or chime go first.
        handler.postDelayed(() -> {
            if (tts == null) return;
            if (tts.speak(text, TextToSpeech.QUEUE_ADD, null, "dayflow-" + System.nanoTime()) != TextToSpeech.SUCCESS) {
                utteranceEnded();
            }
        }, 600);
    }

    private void utteranceEnded() {
        speaking--;
        if (speaking <= 0) finish();
    }

    /** Silent, vibrate or Do Not Disturb: a reminder chime would not sound either. */
    private boolean isMuted() {
        AudioManager audio = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        if (audio != null && audio.getRingerMode() != AudioManager.RINGER_MODE_NORMAL) return true;
        NotificationManager notifications = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        return notifications != null
            && Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
            && notifications.getCurrentInterruptionFilter() > NotificationManager.INTERRUPTION_FILTER_ALL;
    }

    private void ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null || manager.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "Spoken reminders", NotificationManager.IMPORTANCE_MIN);
        channel.setDescription("Shown for a moment while a reminder is read aloud");
        channel.setSound(null, null);
        manager.createNotificationChannel(channel);
    }

    private void acquireWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) return;
        PowerManager manager = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (manager == null) return;
        wakeLock = manager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "dayflow:speak");
        wakeLock.acquire(MAX_RUN_MS + 5_000L);
    }

    private void finish() {
        handler.removeCallbacksAndMessages(null);
        stopForeground(true);
        stopSelf();
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        if (tts != null) {
            tts.stop();
            tts.shutdown();
            tts = null;
        }
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        super.onDestroy();
    }
}
