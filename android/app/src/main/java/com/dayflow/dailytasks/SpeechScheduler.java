package com.dayflow.dailytasks;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Spoken reminders: AlarmManager entries that read a reminder aloud with
 * text-to-speech when it fires, even with the app closed. The notification
 * itself still comes from the local-notifications plugin; this only adds the
 * voice. Plans are {id, notificationId, at, text}, replaced as a whole by the app.
 */
public final class SpeechScheduler {
    private static final String PREFS = "dayflow_speech";
    private static final String KEY_PLANS = "plans";
    static final String EXTRA_TEXT = "text";

    private SpeechScheduler() {}

    private static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static void replace(Context context, JSONArray plans) {
        cancelAll(context);
        prefs(context).edit().putString(KEY_PLANS, plans == null ? "[]" : plans.toString()).apply();
        restore(context);
    }

    static void restore(Context context) {
        JSONArray plans = readPlans(context);
        long now = System.currentTimeMillis();
        for (int i = 0; i < plans.length(); i++) {
            JSONObject plan = plans.optJSONObject(i);
            if (plan == null) continue;
            long at = plan.optLong("at", 0);
            if (at <= now) continue;
            schedule(context, plan.optInt("notificationId", 0), plan.optString("text", ""), at);
        }
    }

    private static void schedule(Context context, int requestCode, String text, long at) {
        if (text == null || text.isEmpty()) return;
        Intent intent = new Intent(context, DayflowSpeakReceiver.class);
        intent.putExtra(EXTRA_TEXT, text);
        PendingIntent pending = pending(context, requestCode, intent);
        AlarmManager manager = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (manager == null) return;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                manager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pending);
            } else {
                manager.setExact(AlarmManager.RTC_WAKEUP, at, pending);
            }
        } catch (SecurityException ignored) {
            // No exact-alarm right: inexact, like the notification it goes with.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pending);
            } else {
                manager.set(AlarmManager.RTC_WAKEUP, at, pending);
            }
        }
    }

    private static void cancelAll(Context context) {
        JSONArray plans = readPlans(context);
        AlarmManager manager = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (manager == null) return;
        for (int i = 0; i < plans.length(); i++) {
            JSONObject plan = plans.optJSONObject(i);
            if (plan == null) continue;
            PendingIntent pending = pending(context, plan.optInt("notificationId", 0), new Intent(context, DayflowSpeakReceiver.class));
            manager.cancel(pending);
            pending.cancel();
        }
    }

    private static PendingIntent pending(Context context, int requestCode, Intent intent) {
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getBroadcast(context, requestCode, intent, flags);
    }

    private static JSONArray readPlans(Context context) {
        try {
            return new JSONArray(prefs(context).getString(KEY_PLANS, "[]"));
        } catch (Exception ignored) {
            return new JSONArray();
        }
    }
}
