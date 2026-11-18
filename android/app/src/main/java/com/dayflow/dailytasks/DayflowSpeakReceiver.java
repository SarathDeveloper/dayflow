package com.dayflow.dailytasks;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Fired by a spoken-reminder alarm; hands the text to the speaking service. */
public class DayflowSpeakReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) return;
        DayflowSpeakService.start(context, intent.getStringExtra(SpeechScheduler.EXTRA_TEXT));
    }
}
