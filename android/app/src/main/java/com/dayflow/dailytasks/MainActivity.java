package com.dayflow.dailytasks;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(DayflowAlarmPlugin.class);
        registerPlugin(DayflowWidgetPlugin.class);
        registerPlugin(PasswordVaultPlugin.class);
        registerPlugin(DocumentVaultPlugin.class);
        registerSideloadUpdater();
        super.onCreate(savedInstanceState);
    }

    /**
     * The self-updater lives only in the sideloaded (debug) build, in
     * src/debug/java. A Play build has no such class and never self-updates.
     */
    @SuppressWarnings("unchecked")
    private void registerSideloadUpdater() {
        try {
            registerPlugin((Class<? extends com.getcapacitor.Plugin>) Class.forName("com.dayflow.dailytasks.DayflowUpdatePlugin"));
        } catch (ClassNotFoundException ignored) {
            // Not part of this build.
        }
    }
}
