package com.dayflow.dailytasks;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.PersistableBundle;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyPermanentlyInvalidatedException;
import android.security.keystore.KeyProperties;
import android.util.AtomicFile;
import android.util.Base64;
import android.view.WindowManager;

import androidx.activity.result.ActivityResult;
import androidx.annotation.NonNull;
import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import androidx.fragment.app.FragmentActivity;

import org.json.JSONException;
import org.json.JSONObject;

import java.security.KeyStore;
import java.util.Arrays;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

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

    // -----------------------------------------------------------------------
    // Fingerprint unlock
    // -----------------------------------------------------------------------
    // The vault's data key (32 bytes, sent by the app after a passphrase unlock)
    // is encrypted with an AES key in the Android Keystore that only works right
    // after a strong biometric check, and is invalidated when fingerprints change.
    // The encrypted copy stays on this device (noBackupFilesDir), never synced.

    private static final String BIO_KEY_ALIAS = "dayflow_password_vault_biometric";
    private static final int AUTHENTICATORS = BiometricManager.Authenticators.BIOMETRIC_STRONG;

    private AtomicFile bioFile() {
        return new AtomicFile(new File(getContext().getNoBackupFilesDir(), "password-vault-bio.v1"));
    }

    private boolean biometricReady() {
        return BiometricManager.from(getContext()).canAuthenticate(AUTHENTICATORS) == BiometricManager.BIOMETRIC_SUCCESS;
    }

    private SecretKey bioKey(boolean createNew) throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (createNew) {
            store.deleteEntry(BIO_KEY_ALIAS);
            KeyGenParameterSpec.Builder spec = new KeyGenParameterSpec.Builder(
                BIO_KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setUserAuthenticationRequired(true)
                .setInvalidatedByBiometricEnrollment(true);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                spec.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG);
            }
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(spec.build());
            return generator.generateKey();
        }
        return (SecretKey) store.getKey(BIO_KEY_ALIAS, null);
    }

    private void clearBiometric() {
        synchronized (FILE_LOCK) {
            bioFile().delete();
        }
        try {
            KeyStore store = KeyStore.getInstance("AndroidKeyStore");
            store.load(null);
            store.deleteEntry(BIO_KEY_ALIAS);
        } catch (Exception ignored) {
            // Nothing saved to remove.
        }
    }

    private JSONObject readBio() {
        synchronized (FILE_LOCK) {
            try {
                String text = readFile(bioFile());
                return text == null ? null : new JSONObject(text);
            } catch (IOException | JSONException error) {
                return null;
            }
        }
    }

    @PluginMethod
    public void biometricStatus(PluginCall call) {
        JSONObject saved = readBio();
        JSObject result = new JSObject();
        result.put("available", biometricReady());
        result.put("vaultId", saved == null ? null : saved.optString("vaultId", null));
        call.resolve(result);
    }

    @PluginMethod
    public void disableBiometric(PluginCall call) {
        clearBiometric();
        call.resolve();
    }

    @PluginMethod
    public void enableBiometric(PluginCall call) {
        String secret = call.getString("secret");
        String vaultId = call.getString("vaultId");
        byte[] raw = secret == null ? null : Base64.decode(secret, Base64.NO_WRAP);
        if (raw == null || raw.length != 32 || vaultId == null || vaultId.isEmpty() || vaultId.length() > 64) {
            call.reject("The vault key is missing.");
            return;
        }
        if (!biometricReady()) {
            call.reject("Set up a fingerprint in the phone's settings first.");
            return;
        }
        Cipher cipher;
        try {
            cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, bioKey(true));
        } catch (Exception error) {
            Arrays.fill(raw, (byte) 0);
            call.reject("Fingerprint unlock is not available on this phone.");
            return;
        }
        prompt(call, cipher, "Turn on fingerprint unlock", (result) -> {
            try {
                Cipher done = Objects.requireNonNull(result.getCryptoObject()).getCipher();
                byte[] sealed = Objects.requireNonNull(done).doFinal(raw);
                JSONObject saved = new JSONObject();
                saved.put("vaultId", vaultId);
                saved.put("iv", Base64.encodeToString(done.getIV(), Base64.NO_WRAP));
                saved.put("data", Base64.encodeToString(sealed, Base64.NO_WRAP));
                synchronized (FILE_LOCK) {
                    AtomicFile file = bioFile();
                    FileOutputStream output = file.startWrite();
                    try {
                        output.write(saved.toString().getBytes(StandardCharsets.UTF_8));
                        file.finishWrite(output);
                    } catch (IOException error) {
                        file.failWrite(output);
                        throw error;
                    }
                }
                call.resolve();
            } catch (Exception error) {
                clearBiometric();
                call.reject("Could not turn on fingerprint unlock.");
            } finally {
                Arrays.fill(raw, (byte) 0);
            }
        }, () -> Arrays.fill(raw, (byte) 0));
    }

    @PluginMethod
    public void unlockBiometric(PluginCall call) {
        String vaultId = call.getString("vaultId");
        JSONObject saved = readBio();
        if (saved == null || vaultId == null || !vaultId.equals(saved.optString("vaultId"))) {
            call.reject("Fingerprint unlock is not set up for this vault.");
            return;
        }
        Cipher cipher;
        byte[] data;
        try {
            byte[] iv = Base64.decode(saved.getString("iv"), Base64.NO_WRAP);
            data = Base64.decode(saved.getString("data"), Base64.NO_WRAP);
            cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, bioKey(false), new GCMParameterSpec(128, iv));
        } catch (KeyPermanentlyInvalidatedException error) {
            clearBiometric();
            call.reject("Your fingerprints changed. Unlock with the passphrase and turn fingerprint unlock on again.", "INVALIDATED");
            return;
        } catch (Exception error) {
            clearBiometric();
            call.reject("Fingerprint unlock stopped working. Unlock with the passphrase and turn it on again.", "INVALIDATED");
            return;
        }
        prompt(call, cipher, "Unlock Password Vault", (result) -> {
            byte[] raw = null;
            try {
                raw = Objects.requireNonNull(Objects.requireNonNull(result.getCryptoObject()).getCipher()).doFinal(data);
                call.resolve(new JSObject().put("secret", Base64.encodeToString(raw, Base64.NO_WRAP)));
            } catch (Exception error) {
                call.reject("Could not unlock with the fingerprint.");
            } finally {
                if (raw != null) Arrays.fill(raw, (byte) 0);
            }
        }, null);
    }

    private interface OnAuthenticated {
        void run(BiometricPrompt.AuthenticationResult result);
    }

    private void prompt(PluginCall call, Cipher cipher, String title, OnAuthenticated onSuccess, Runnable onEnd) {
        getActivity().runOnUiThread(() -> {
            FragmentActivity activity = getActivity();
            BiometricPrompt prompt = new BiometricPrompt(activity, ContextCompat.getMainExecutor(activity),
                new BiometricPrompt.AuthenticationCallback() {
                    @Override
                    public void onAuthenticationSucceeded(@NonNull BiometricPrompt.AuthenticationResult result) {
                        onSuccess.run(result);
                    }

                    @Override
                    public void onAuthenticationError(int code, @NonNull CharSequence message) {
                        if (onEnd != null) onEnd.run();
                        boolean canceled = code == BiometricPrompt.ERROR_USER_CANCELED
                            || code == BiometricPrompt.ERROR_NEGATIVE_BUTTON
                            || code == BiometricPrompt.ERROR_CANCELED;
                        call.reject(canceled ? "Canceled." : message.toString(), canceled ? "CANCELED" : "FAILED");
                    }
                });
            BiometricPrompt.PromptInfo info = new BiometricPrompt.PromptInfo.Builder()
                .setTitle(title)
                .setNegativeButtonText("Use passphrase")
                .setAllowedAuthenticators(AUTHENTICATORS)
                .build();
            prompt.authenticate(info, new BiometricPrompt.CryptoObject(cipher));
        });
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
