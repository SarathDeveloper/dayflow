package com.dayflow.dailytasks;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.PersistableBundle;
import android.util.AtomicFile;
import android.view.WindowManager;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Objects;

@CapacitorPlugin(name = "PasswordVault")
public class PasswordVaultPlugin extends Plugin {
    private static final Object FILE_LOCK = new Object();
    private static final int MAX_FILE_BYTES = 2 * 1024 * 1024;

    private AtomicFile vaultFile() {
        return new AtomicFile(new File(getContext().getNoBackupFilesDir(), "password-vault.v1"));
    }

    private String readFile(AtomicFile file) throws IOException {
        try {
            return new String(file.readFully(), StandardCharsets.UTF_8);
        } catch (FileNotFoundException error) {
            if (file.getBaseFile().exists()) throw error;
            return null;
        }
    }

    @PluginMethod
    public void read(PluginCall call) {
        synchronized (FILE_LOCK) {
            try {
                String contents = readFile(vaultFile());
                JSObject result = new JSObject();
                if (contents != null) result.put("contents", contents);
                call.resolve(result);
            } catch (IOException error) {
                call.reject("Could not read the vault on this device.");
            }
        }
    }

    @PluginMethod
    public void write(PluginCall call) {
        byte[] bytes = backupBytes(call);
        if (bytes == null) return;
        synchronized (FILE_LOCK) {
            AtomicFile file = vaultFile();
            FileOutputStream output = null;
            try {
                if (!Objects.equals(readFile(file), call.getString("previous"))) {
                    call.reject("The vault changed. Reopen it and try again.");
                    return;
                }
                output = file.startWrite();
                output.write(bytes);
                output.getFD().sync();
                file.finishWrite(output);
                output = null;
                if (!Objects.equals(readFile(file), call.getString("contents"))) {
                    call.reject("Could not save the vault on this device.");
                    return;
                }
                call.resolve();
            } catch (IOException error) {
                if (output != null) file.failWrite(output);
                call.reject("Could not save the vault on this device.");
            }
        }
    }

    @PluginMethod
    public void setScreenProtected(PluginCall call) {
        boolean enabled = Boolean.TRUE.equals(call.getBoolean("enabled"));
        getActivity().runOnUiThread(() -> {
            if (enabled) getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
            else getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
            call.resolve();
        });
    }

    @PluginMethod
    public void copySecret(PluginCall call) {
        String text = call.getString("text");
        if (text == null || text.isEmpty() || text.length() > 1024) {
            call.reject("There is no password to copy.");
            return;
        }
        getActivity().runOnUiThread(() -> {
            if (!getActivity().hasWindowFocus()) {
                call.reject("Open the vault to copy a password.");
                return;
            }
            ClipboardManager manager = (ClipboardManager) getContext().getSystemService(Context.CLIPBOARD_SERVICE);
            ClipData clip = ClipData.newPlainText("Dayflow password", text);
            PersistableBundle extras = new PersistableBundle();
            extras.putBoolean("android.content.extra.IS_SENSITIVE", true);
            clip.getDescription().setExtras(extras);
            manager.setPrimaryClip(clip);
            call.resolve();
        });
    }

    @PluginMethod
    public void exportBackup(PluginCall call) {
        if (backupBytes(call) == null) return;
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("application/json");
        intent.putExtra(Intent.EXTRA_TITLE, call.getString("filename", "dayflow-vault.json"));
        startActivityForResult(call, intent, "writeBackupDocument");
    }

    @ActivityCallback
    private void writeBackupDocument(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            call.resolve(new JSObject().put("saved", false));
            return;
        }
        Uri uri = result.getData().getData();
        byte[] bytes = backupBytes(call);
        if (bytes == null) return;
        if (uri == null) {
            call.reject("Choose a location for the vault backup.");
            return;
        }
        try (OutputStream output = getContext().getContentResolver().openOutputStream(uri, "w")) {
            if (output == null) throw new IOException();
            output.write(bytes);
        } catch (IOException | SecurityException error) {
            call.reject("Could not write the encrypted backup.");
            return;
        }
        call.resolve(new JSObject().put("saved", true));
    }

    private byte[] backupBytes(PluginCall call) {
        String contents = call.getString("contents");
        if (contents != null && contents.length() <= MAX_FILE_BYTES) {
            byte[] bytes = contents.getBytes(StandardCharsets.UTF_8);
            if (bytes.length <= MAX_FILE_BYTES) return bytes;
        }
        call.reject("The encrypted vault file is missing or too large.");
        return null;
    }
}
