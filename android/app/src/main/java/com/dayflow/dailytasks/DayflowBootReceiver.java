package com.dayflow.dailytasks;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * Puts the native alarm plans back into AlarmManager whenever the system may
 * have dropped them or the clock moved under them.
 */
public class DayflowBootReceiver extends BroadcastReceiver {
    static final String ACTION_EXACT_ALARM_PERMISSION_CHANGED =
        "android.app.action.SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || intent.getAction() == null) return;
        switch (intent.getAction()) {
            case Intent.ACTION_TIMEZONE_CHANGED:
                AlarmScheduler.restoreAfterTimezoneChange(context);
                break;
            case Intent.ACTION_BOOT_COMPLETED:
            case Intent.ACTION_MY_PACKAGE_REPLACED:
            case Intent.ACTION_TIME_CHANGED:
            case ACTION_EXACT_ALARM_PERMISSION_CHANGED:
                // Same request codes, so this replaces rather than duplicates. After the
                // exact-alarm grant it also upgrades any inexact fallback to exact.
                AlarmScheduler.restore(context);
                break;
            default:
                break;
        }
    }
}
