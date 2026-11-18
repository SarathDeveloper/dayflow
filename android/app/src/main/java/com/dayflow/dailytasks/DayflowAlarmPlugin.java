package com.dayflow.dailytasks;

import android.app.Activity;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.UriPermission;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;

import androidx.core.content.FileProvider;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

@CapacitorPlugin(name = "DayflowAlarm")
public class DayflowAlarmPlugin extends Plugin {
    private static final String BACKUP_PREFS = "dayflow_backup";
    private static final String KEY_TREE = "tree_uri";
    private static final String KEY_NAME = "folder_name";
    private static final String BACKUP_FILE = "dayflow-backup.json";
    private static final int PERSIST_FLAGS =
            Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION;

    private static DayflowAlarmPlugin instance;

    @Override
    public void load() {
        instance = this;
    }

    static void emit(String type, String id, String kind, long at, int snoozeMinutes) {
        DayflowAlarmPlugin plugin = instance;
        if (plugin == null) return;
        JSObject event = new JSObject();
        event.put("type", type);
        event.put("id", id);
        event.put("kind", kind);
        event.put("at", at);
        event.put("snoozeMinutes", snoozeMinutes);
        plugin.notifyListeners("alarmEvent", event);
    }

    /** Opens the audio picker; several files may be chosen. Cancelling resolves with nothing added. */
    @PluginMethod
    public void addSongs(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("audio/*");
        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        startActivityForResult(call, intent, "songsResult");
    }

    @ActivityCallback
    private void songsResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        java.util.List<Uri> uris = new java.util.ArrayList<>();
        Intent data = result.getData();
        if (result.getResultCode() == Activity.RESULT_OK && data != null) {
            ClipData clip = data.getClipData();
            if (clip != null) {
                for (int i = 0; i < clip.getItemCount(); i++) {
                    Uri uri = clip.getItemAt(i).getUri();
                    if (uri != null) uris.add(uri);
                }
            } else if (data.getData() != null) {
                uris.add(data.getData());
            }
        }
        Context context = getContext().getApplicationContext();
        // Copying up to 15 MB per song: keep it off the main thread.
        new Thread(() -> {
            JSArray added = new JSArray();
            JSArray skipped = new JSArray();
            for (Uri uri : uris) {
                try {
                    added.put(AlarmScheduler.addSong(context, uri).optString("id"));
                } catch (AlarmScheduler.SongException error) {
                    skipped.put(skip(error.name, error.getMessage()));
                } catch (Exception error) {
                    skipped.put(skip(AlarmScheduler.displayName(context, uri), "failed"));
                }
            }
            JSObject payload = songsPayload(context);
            payload.put("added", added);
            payload.put("skipped", skipped);
            call.resolve(payload);
        }).start();
    }

    private static JSObject skip(String name, String reason) {
        JSObject item = new JSObject();
        item.put("name", name == null ? "Song" : name);
        item.put("reason", reason == null ? "failed" : reason);
        return item;
    }

    private static JSObject songsPayload(Context context) {
        JSObject payload = new JSObject();
        try {
            payload.put("songs", new JSArray(AlarmScheduler.listSongs(context).toString()));
        } catch (Exception error) {
            payload.put("songs", new JSArray());
        }
        return payload;
    }

    @PluginMethod
    public void listSongs(PluginCall call) {
        call.resolve(songsPayload(getContext()));
    }

    @PluginMethod
    public void removeSong(PluginCall call) {
        AlarmScheduler.removeSong(getContext(), call.getString("id", ""));
        call.resolve(songsPayload(getContext()));
    }

    @PluginMethod
    public void preview(PluginCall call) {
        AlarmScheduler.preview(getContext(), call.getString("sound", "chime"));
        call.resolve();
    }

    @PluginMethod
    public void stopPreview(PluginCall call) {
        AlarmScheduler.stopPreview();
        call.resolve();
    }

    @PluginMethod
    public void sync(PluginCall call) {
        try {
            JSArray plans = call.getArray("plans");
            AlarmScheduler.replace(getContext(), plans == null ? new JSONArray() : plans);
            call.resolve();
        } catch (Exception error) {
            call.reject("Could not update alarms", error);
        }
    }

    /** Replaces the spoken-reminder schedule: [{id, notificationId, at, text}]. */
    @PluginMethod
    public void syncSpeech(PluginCall call) {
        try {
            JSArray plans = call.getArray("plans");
            SpeechScheduler.replace(getContext(), plans == null ? new JSONArray() : plans);
            call.resolve();
        } catch (Exception error) {
            call.reject("Could not update spoken reminders", error);
        }
    }

    /** Reads `text` aloud now, even on silent (the "Test voice" button). */
    @PluginMethod
    public void speak(PluginCall call) {
        String text = call.getString("text");
        if (text == null || text.trim().isEmpty()) {
            call.reject("empty");
            return;
        }
        DayflowSpeakService.start(getContext(), text.trim(), true);
        call.resolve();
    }

    /**
     * Whether Android lets this app run its alarms in the background. False means
     * battery optimisation is on, which on many phones (Xiaomi, Vivo, Oppo, Realme,
     * OnePlus, Samsung "sleeping apps") deletes reminders once the app is swiped away.
     */
    @PluginMethod
    public void getBatteryStatus(PluginCall call) {
        JSObject result = new JSObject();
        boolean unrestricted = true;
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.M) {
            android.os.PowerManager power = (android.os.PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
            unrestricted = power == null || power.isIgnoringBatteryOptimizations(getContext().getPackageName());
        }
        result.put("unrestricted", unrestricted);
        result.put("manufacturer", android.os.Build.MANUFACTURER == null ? "" : android.os.Build.MANUFACTURER);
        call.resolve(result);
    }

    /** Opens this app's system page, where Battery / Autostart live on every brand. */
    @PluginMethod
    public void openAppSettings(PluginCall call) {
        Intent intent = new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
        intent.setData(Uri.fromParts("package", getContext().getPackageName(), null));
        startSettings(call, intent);
    }

    /** Opens this app's notification settings (channels, sound, lock screen). */
    @PluginMethod
    public void openNotificationSettings(PluginCall call) {
        Intent intent;
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
            intent = new Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS);
            intent.putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, getContext().getPackageName());
        } else {
            intent = new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
            intent.setData(Uri.fromParts("package", getContext().getPackageName(), null));
        }
        startSettings(call, intent);
    }

    private void startSettings(PluginCall call, Intent intent) {
        Activity activity = getActivity();
        if (activity == null) {
            call.reject("Could not open settings");
            return;
        }
        try {
            activity.startActivity(intent);
            call.resolve();
        } catch (Exception error) {
            call.reject("Could not open settings", error);
        }
    }

    @PluginMethod
    public void shareBackup(PluginCall call) {
        String contents = call.getString("contents");
        if (contents == null) {
            call.reject("empty");
            return;
        }
        String requested = call.getString("filename", "dayflow-backup.json");
        String filename = requested == null ? "dayflow-backup.json" : requested.replaceAll("[^A-Za-z0-9._-]", "");
        if (filename.isEmpty()) filename = "dayflow-backup.json";
        if (getActivity() == null) {
            call.reject("Could not share the backup");
            return;
        }
        try {
            File dir = new File(getContext().getCacheDir(), "backups");
            if (!dir.exists() && !dir.mkdirs()) {
                call.reject("Could not share the backup");
                return;
            }
            File file = new File(dir, filename);
            try (FileOutputStream out = new FileOutputStream(file)) {
                out.write(contents.getBytes(StandardCharsets.UTF_8));
            }
            String authority = getContext().getPackageName() + ".fileprovider";
            Uri uri = FileProvider.getUriForFile(getContext(), authority, file);
            Intent send = new Intent(Intent.ACTION_SEND);
            String mimeType = call.getString("mimeType", "application/json");
            send.setType(mimeType == null ? "application/json" : mimeType);
            send.putExtra(Intent.EXTRA_STREAM, uri);
            send.setClipData(ClipData.newRawUri("", uri));
            send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            String title = call.getString("title", "Save Dayflow backup");
            Intent chooser = Intent.createChooser(send, title == null ? "Save Dayflow backup" : title);
            chooser.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            getActivity().startActivity(chooser);
            call.resolve();
        } catch (Exception error) {
            call.reject("Could not share the backup", error);
        }
    }

    @PluginMethod
    public void pickBackupFolder(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(
                PERSIST_FLAGS
                        | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
                        | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION
        );
        startActivityForResult(call, intent, "backupFolderResult");
    }

    @ActivityCallback
    private void backupFolderResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            call.reject("cancelled");
            return;
        }
        Uri uri = result.getData().getData();
        if (uri == null) {
            call.reject("cancelled");
            return;
        }
        int takeFlags = result.getData().getFlags() & PERSIST_FLAGS;
        if (takeFlags == 0) takeFlags = PERSIST_FLAGS;
        try {
            releaseStoredFolder();
            getContext().getContentResolver().takePersistableUriPermission(uri, takeFlags);
        } catch (SecurityException error) {
            call.reject("Could not keep access to that folder");
            return;
        }
        String name = folderDisplayName(uri);
        backupPrefs().edit().putString(KEY_TREE, uri.toString()).putString(KEY_NAME, name).apply();
        JSObject payload = new JSObject();
        payload.put("name", name);
        call.resolve(payload);
    }

    @PluginMethod
    public void getBackupFolder(PluginCall call) {
        String stored = backupPrefs().getString(KEY_TREE, null);
        boolean has = stored != null && !stored.isEmpty() && hasWritePermission(stored);
        if (!has && stored != null) {
            backupPrefs().edit().remove(KEY_TREE).remove(KEY_NAME).apply();
        }
        JSObject payload = new JSObject();
        payload.put("has", has);
        payload.put("lost", stored != null && !has);
        payload.put("name", has ? backupPrefs().getString(KEY_NAME, "Chosen folder") : "");
        call.resolve(payload);
    }

    @PluginMethod
    public void clearBackupFolder(PluginCall call) {
        releaseStoredFolder();
        backupPrefs().edit().remove(KEY_TREE).remove(KEY_NAME).apply();
        call.resolve();
    }

    @PluginMethod
    public void writeBackupFile(PluginCall call) {
        String contents = call.getString("contents");
        if (contents == null) {
            call.reject("empty");
            return;
        }
        String stored = backupPrefs().getString(KEY_TREE, null);
        if (stored == null || stored.isEmpty()) {
            call.reject("no-folder");
            return;
        }
        if (!hasWritePermission(stored)) {
            backupPrefs().edit().remove(KEY_TREE).remove(KEY_NAME).apply();
            call.reject("permission-lost");
            return;
        }
        try {
            writeBackupJson(Uri.parse(stored), contents);
            call.resolve();
        } catch (Exception error) {
            call.reject("Could not save the backup", error);
        }
    }

    private SharedPreferences backupPrefs() {
        return getContext().getSharedPreferences(BACKUP_PREFS, Context.MODE_PRIVATE);
    }

    private boolean hasWritePermission(String uriString) {
        Uri stored = Uri.parse(uriString);
        for (UriPermission permission : getContext().getContentResolver().getPersistedUriPermissions()) {
            if (permission.isWritePermission() && stored.equals(permission.getUri())) return true;
        }
        return false;
    }

    private void releaseStoredFolder() {
        String stored = backupPrefs().getString(KEY_TREE, null);
        if (stored == null || stored.isEmpty()) return;
        try {
            getContext().getContentResolver().releasePersistableUriPermission(Uri.parse(stored), PERSIST_FLAGS);
        } catch (SecurityException ignored) {
            // The grant is already gone.
        }
    }

    private String folderDisplayName(Uri treeUri) {
        ContentResolver resolver = getContext().getContentResolver();
        Uri document = DocumentsContract.buildDocumentUriUsingTree(
                treeUri,
                DocumentsContract.getTreeDocumentId(treeUri)
        );
        try (Cursor cursor = resolver.query(
                document,
                new String[]{DocumentsContract.Document.COLUMN_DISPLAY_NAME},
                null,
                null,
                null
        )) {
            if (cursor != null && cursor.moveToFirst()) {
                String name = cursor.getString(0);
                if (name != null && !name.isEmpty()) return name;
            }
        } catch (Exception ignored) {
            // Some providers only return a tree URI. The folder still works.
        }
        return "Chosen folder";
    }

    private void writeBackupJson(Uri treeUri, String contents) throws IOException {
        ContentResolver resolver = getContext().getContentResolver();
        byte[] bytes = contents.getBytes(StandardCharsets.UTF_8);
        Uri existing = findBackupFile(treeUri);
        if (existing != null && writeStream(resolver, existing, bytes, true)) return;
        if (existing != null) {
            try {
                DocumentsContract.deleteDocument(resolver, existing);
            } catch (Exception ignored) {
                // Create a new file below if the old one cannot be removed.
            }
        }
        String treeId = DocumentsContract.getTreeDocumentId(treeUri);
        Uri parent = DocumentsContract.buildDocumentUriUsingTree(treeUri, treeId);
        Uri created = DocumentsContract.createDocument(resolver, parent, "application/json", BACKUP_FILE);
        if (created == null || !writeStream(resolver, created, bytes, false)) {
            throw new IOException("Could not write " + BACKUP_FILE);
        }
    }

    private Uri findBackupFile(Uri treeUri) {
        ContentResolver resolver = getContext().getContentResolver();
        String treeId = DocumentsContract.getTreeDocumentId(treeUri);
        Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, treeId);
        try (Cursor cursor = resolver.query(
                children,
                new String[]{
                        DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                        DocumentsContract.Document.COLUMN_DISPLAY_NAME
                },
                null,
                null,
                null
        )) {
            if (cursor == null) return null;
            int idColumn = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_DOCUMENT_ID);
            int nameColumn = cursor.getColumnIndex(DocumentsContract.Document.COLUMN_DISPLAY_NAME);
            while (cursor.moveToNext()) {
                if (nameColumn < 0 || idColumn < 0) continue;
                if (!BACKUP_FILE.equals(cursor.getString(nameColumn))) continue;
                return DocumentsContract.buildDocumentUriUsingTree(treeUri, cursor.getString(idColumn));
            }
        } catch (Exception ignored) {
            return null;
        }
        return null;
    }

    private boolean writeStream(ContentResolver resolver, Uri target, byte[] bytes, boolean truncate) {
        String mode = truncate ? "wt" : "w";
        try (OutputStream out = resolver.openOutputStream(target, mode)) {
            if (out == null) return false;
            out.write(bytes);
            return true;
        } catch (Exception error) {
            return false;
        }
    }

    @PluginMethod
    public void consumeEvents(PluginCall call) {
        JSONArray drained = AlarmScheduler.drainEvents(getContext());
        JSObject payload = new JSObject();
        try {
            payload.put("events", new JSArray(drained.toString()));
        } catch (Exception error) {
            payload.put("events", new JSArray());
        }
        call.resolve(payload);
    }
}
