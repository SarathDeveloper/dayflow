package com.dayflow.dailytasks;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.appcompat.app.AppCompatActivity;
import androidx.core.content.FileProvider;
import androidx.lifecycle.Lifecycle;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;

/**
 * Downloads a newer Dayflow APK from the project's GitHub Releases and hands it
 * to Android's installer. Android shows its own Install screen; nothing installs
 * silently. The installer also refuses an APK signed with a different key.
 */
@CapacitorPlugin(name = "DayflowUpdate")
public class DayflowUpdatePlugin extends Plugin {
    private static final String ALLOWED_PREFIX = "https://github.com/SarathDeveloper/dayflow/releases/download/";
    private static final long MAX_APK_BYTES = 100L * 1024 * 1024;
    private static volatile boolean downloading = false;
    /** A verified download waiting for Dayflow to come back to the foreground. UI thread only. */
    private File waitingApk;

    /** Whether Android lets Dayflow open the installer ("Install unknown apps"). */
    @PluginMethod
    public void canInstall(PluginCall call) {
        JSObject payload = new JSObject();
        payload.put("allowed", canRequestInstalls());
        call.resolve(payload);
    }

    /** Opens Android's "Install unknown apps" page for Dayflow. */
    @PluginMethod
    public void openInstallSettings(PluginCall call) {
        try {
            Intent intent = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getContext().getPackageName()))
                : new Intent(Settings.ACTION_SECURITY_SETTINGS);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception error) {
            call.reject("Could not open settings");
        }
    }

    /**
     * Downloads `url` (a release asset of this project only), checks its SHA-256,
     * then opens the installer. Resolves `{ shown }`: false when Dayflow was in the
     * background (Android blocks starting screens then); the installer then opens
     * as soon as Dayflow is back in front.
     */
    @PluginMethod
    public void installApk(PluginCall call) {
        String url = call.getString("url", "");
        String expected = call.getString("sha256", "");
        if (url == null || !url.startsWith(ALLOWED_PREFIX) || !url.endsWith(".apk")) {
            call.reject("bad-url");
            return;
        }
        if (expected == null || !expected.matches("[0-9a-f]{64}")) {
            call.reject("bad-checksum");
            return;
        }
        if (!canRequestInstalls()) {
            call.reject("install-permission");
            return;
        }
        if (downloading) {
            call.reject("busy");
            return;
        }
        downloading = true;
        Context context = getContext().getApplicationContext();
        new Thread(() -> {
            try {
                File apk = download(context, url, expected);
                getBridge().executeOnMainThread(() -> {
                    JSObject result = new JSObject();
                    boolean shown = false;
                    if (isForeground()) {
                        try {
                            openInstaller(getActivity(), apk);
                            shown = true;
                        } catch (Exception ignored) {
                            // Fall back to opening it on the next resume.
                        }
                    }
                    if (!shown) waitingApk = apk;
                    result.put("shown", shown);
                    call.resolve(result);
                });
            } catch (IOException error) {
                String message = error.getMessage();
                call.reject(message == null || message.isEmpty() ? "download-failed" : message);
            } catch (Exception error) {
                call.reject("download-failed");
            } finally {
                downloading = false;
            }
        }).start();
    }

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        File apk = waitingApk;
        if (apk == null) return;
        waitingApk = null;
        if (!apk.exists()) return;
        try {
            openInstaller(getActivity(), apk);
        } catch (Exception ignored) {
            // The person can start the update again from Settings.
        }
    }

    private boolean isForeground() {
        AppCompatActivity activity = getActivity();
        return activity != null
            && !activity.isFinishing()
            && activity.getLifecycle().getCurrentState().isAtLeast(Lifecycle.State.RESUMED);
    }

    private boolean canRequestInstalls() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return true;
        return getContext().getPackageManager().canRequestPackageInstalls();
    }

    private static File download(Context context, String url, String expected) throws Exception {
        File dir = new File(context.getCacheDir(), "updates");
        if (!dir.exists() && !dir.mkdirs()) throw new IOException("download-failed");
        File[] old = dir.listFiles();
        if (old != null) for (File file : old) file.delete();
        File target = new File(dir, "dayflow-update.apk");

        HttpURLConnection connection = open(url);
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        long total = 0;
        try (InputStream in = connection.getInputStream(); OutputStream out = new FileOutputStream(target)) {
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = in.read(buffer)) >= 0) {
                total += read;
                if (total > MAX_APK_BYTES) throw new IOException("download-failed");
                digest.update(buffer, 0, read);
                out.write(buffer, 0, read);
            }
        } finally {
            connection.disconnect();
        }
        StringBuilder hex = new StringBuilder();
        for (byte b : digest.digest()) hex.append(String.format("%02x", b));
        if (total == 0 || !expected.equals(hex.toString())) {
            target.delete();
            throw new IOException("checksum");
        }
        return target;
    }

    /** GitHub redirects release downloads to its file host; follow https redirects only. */
    private static HttpURLConnection open(String url) throws IOException {
        String current = url;
        for (int hop = 0; hop < 5; hop++) {
            HttpURLConnection connection = (HttpURLConnection) new URL(current).openConnection();
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(20_000);
            connection.setReadTimeout(30_000);
            int status = connection.getResponseCode();
            if (status >= 300 && status < 400) {
                String location = connection.getHeaderField("Location");
                connection.disconnect();
                if (location == null) throw new IOException("download-failed");
                URL next = new URL(new URL(current), location);
                if (!"https".equals(next.getProtocol())) throw new IOException("download-failed");
                current = next.toString();
                continue;
            }
            if (status != HttpURLConnection.HTTP_OK) {
                connection.disconnect();
                throw new IOException("download-failed");
            }
            return connection;
        }
        throw new IOException("download-failed");
    }

    private static void openInstaller(Context context, File apk) {
        Uri uri = FileProvider.getUriForFile(context, context.getPackageName() + ".fileprovider", apk);
        Intent intent = new Intent(Intent.ACTION_VIEW);
        intent.setDataAndType(uri, "application/vnd.android.package-archive");
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        context.startActivity(intent);
    }
}
