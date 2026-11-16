package com.dayflow.dailytasks;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.pdf.PdfRenderer;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.DocumentsContract;
import android.util.Base64;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.regex.Pattern;

/**
 * Native helpers for the Document Vault.
 *
 * PDFs: the web layer decrypts a PDF and streams it here in base64 chunks. It is
 * written to a private temp file under noBackupFilesDir/document-temp/ (random
 * name, never backed up), opened with PdfRenderer and rendered page by page to
 * PNG. Temp files are deleted on close, on closeAll, when the plugin loads
 * (leftovers from a crash) and when the activity is destroyed.
 *
 * Export: the encrypted backup can be far larger than a single bridge message,
 * so it is written through a Storage Access Framework document in UTF-8 text
 * chunks: beginExport (picker) -> appendExport* -> finishExport, or abortExport,
 * which closes and deletes the partial document.
 */
@CapacitorPlugin(name = "DocumentVault")
public class DocumentVaultPlugin extends Plugin {
    private static final String TEMP_DIR = "document-temp";
    private static final long MAX_PDF_BYTES = 10L * 1024 * 1024;
    private static final int MAX_PDF_CHUNK_BYTES = 1024 * 1024;
    /** Base64 length of a 1 MiB chunk, plus slack for padding and line breaks. */
    private static final int MAX_PDF_CHUNK_CHARS = 1_400_000;
    private static final int MAX_OPEN_PDFS = 8;
    private static final int MAX_RENDER_WIDTH = 2000;
    private static final int MIN_RENDER_WIDTH = 16;
    private static final int MAX_RENDER_HEIGHT = 3000;

    private static final long MAX_EXPORT_BYTES = 256L * 1024 * 1024;
    private static final int MAX_EXPORT_CHUNK_CHARS = 4 * 1024 * 1024;
    private static final int MAX_OPEN_EXPORTS = 4;
    private static final int MAX_FILENAME = 200;
    private static final Pattern MIME_PATTERN = Pattern.compile("^[a-z]+/[a-z0-9][a-z0-9.+-]{0,99}$");
    private static final Pattern ID_PATTERN = Pattern.compile("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$");
    private static final byte[] PDF_MAGIC = { '%', 'P', 'D', 'F', '-' };

    private final Map<String, PdfSession> pdfs = new ConcurrentHashMap<>();
    private final Map<String, ExportSession> exports = new ConcurrentHashMap<>();
    private final Object tempLock = new Object();
    private ExecutorService executor;

    /** One decrypted PDF: a temp file being written, then an open renderer. All access is synchronized on the session. */
    private static final class PdfSession {
        final File file;
        OutputStream output;
        long size;
        ParcelFileDescriptor descriptor;
        PdfRenderer renderer;
        boolean closed;

        PdfSession(File file, OutputStream output) {
            this.file = file;
            this.output = output;
        }

        void close() {
            closed = true;
            if (output != null) {
                try {
                    output.close();
                } catch (IOException ignored) {
                    // Best effort: the file is deleted below.
                }
                output = null;
            }
            if (renderer != null) {
                try {
                    renderer.close();
                } catch (RuntimeException ignored) {
                    // Already closed or in a bad state; the descriptor is closed next.
                }
                renderer = null;
            }
            if (descriptor != null) {
                try {
                    descriptor.close();
                } catch (IOException ignored) {
                    // Best effort.
                }
                descriptor = null;
            }
            if (file.exists() && !file.delete()) file.deleteOnExit();
        }
    }

    /** One SAF document being written. All access is synchronized on the session. */
    private static final class ExportSession {
        final Uri uri;
        OutputStream output;
        long bytes;

        ExportSession(Uri uri, OutputStream output) {
            this.uri = uri;
            this.output = output;
        }
    }

    @Override
    public void load() {
        super.load();
        executor = Executors.newFixedThreadPool(2);
        executor.execute(this::clearTempDir);
    }

    @Override
    protected void handleOnDestroy() {
        closeAllPdfSessions();
        for (String token : new ArrayList<>(exports.keySet())) {
            ExportSession session = exports.remove(token);
            if (session != null) {
                synchronized (session) {
                    discardExport(session);
                }
            }
        }
        if (executor != null) executor.shutdown();
        super.handleOnDestroy();
    }

    // ---------------------------------------------------------------- PDFs

    @PluginMethod
    public void beginPdf(PluginCall call) {
        run(call, () -> {
            if (pdfs.size() >= MAX_OPEN_PDFS) {
                call.reject("Too many documents are open. Close one and try again.");
                return;
            }
            String handle = UUID.randomUUID().toString();
            // Create and register under the temp lock so a concurrent sweep never deletes a new file.
            synchronized (tempLock) {
                try {
                    File file = new File(tempDir(), "pdf-" + UUID.randomUUID() + ".tmp");
                    OutputStream output = new BufferedOutputStream(new FileOutputStream(file));
                    pdfs.put(handle, new PdfSession(file, output));
                } catch (IOException | SecurityException error) {
                    call.reject("Could not prepare the document on this device.");
                    return;
                }
            }
            call.resolve(new JSObject().put("handle", handle));
        });
    }

    @PluginMethod
    public void appendPdf(PluginCall call) {
        run(call, () -> {
            String handle = call.getString("handle");
            PdfSession session = pdfSession(call, handle);
            if (session == null) return;
            String chunk = call.getString("chunk");
            if (chunk == null || chunk.isEmpty() || chunk.length() > MAX_PDF_CHUNK_CHARS) {
                call.reject("The document data is invalid.");
                return;
            }
            byte[] bytes;
            try {
                bytes = Base64.decode(chunk, Base64.DEFAULT);
            } catch (IllegalArgumentException error) {
                call.reject("The document data is invalid.");
                return;
            }
            if (bytes.length == 0 || bytes.length > MAX_PDF_CHUNK_BYTES) {
                call.reject("The document data is invalid.");
                return;
            }
            synchronized (session) {
                if (session.closed || session.output == null) {
                    call.reject(session.closed ? "This document was closed." : "This document is already open.");
                    return;
                }
                if (session.size + bytes.length > MAX_PDF_BYTES) {
                    dropPdf(handle, session);
                    call.reject("This PDF is larger than 10 MB and cannot be shown.");
                    return;
                }
                try {
                    session.output.write(bytes);
                    session.size += bytes.length;
                } catch (IOException error) {
                    dropPdf(handle, session);
                    call.reject("Could not prepare the document on this device. Free some storage and try again.");
                    return;
                }
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void openPdf(PluginCall call) {
        run(call, () -> {
            String handle = call.getString("handle");
            PdfSession session = pdfSession(call, handle);
            if (session == null) return;
            synchronized (session) {
                if (session.closed) {
                    call.reject("This document was closed.");
                    return;
                }
                if (session.renderer != null) {
                    call.resolve(new JSObject().put("pageCount", session.renderer.getPageCount()));
                    return;
                }
                try {
                    if (session.output != null) session.output.close();
                    session.output = null;
                } catch (IOException error) {
                    dropPdf(handle, session);
                    call.reject("Could not prepare the document on this device. Free some storage and try again.");
                    return;
                }
                if (session.size == 0 || !hasPdfMagic(session.file)) {
                    dropPdf(handle, session);
                    call.reject("This file is not a valid PDF.");
                    return;
                }
                try {
                    session.descriptor = ParcelFileDescriptor.open(session.file, ParcelFileDescriptor.MODE_READ_ONLY);
                    session.renderer = new PdfRenderer(session.descriptor);
                } catch (SecurityException error) {
                    dropPdf(handle, session);
                    call.reject("This PDF is password-protected and cannot be shown here.");
                    return;
                } catch (IOException | RuntimeException error) {
                    dropPdf(handle, session);
                    call.reject("This PDF is damaged or uses a format this device cannot show.");
                    return;
                }
                int pageCount = session.renderer.getPageCount();
                if (pageCount < 1) {
                    dropPdf(handle, session);
                    call.reject("This PDF has no pages.");
                    return;
                }
                call.resolve(new JSObject().put("pageCount", pageCount));
            }
        });
    }

    @PluginMethod
    public void renderPdfPage(PluginCall call) {
        run(call, () -> {
            String handle = call.getString("handle");
            PdfSession session = pdfSession(call, handle);
            if (session == null) return;
            Double pageValue = call.getDouble("page");
            Double widthValue = call.getDouble("width");
            if (pageValue == null || widthValue == null || pageValue.isNaN() || widthValue.isNaN()
                    || pageValue.isInfinite() || widthValue.isInfinite()) {
                call.reject("Choose a page to show.");
                return;
            }
            synchronized (session) {
                if (session.closed || session.renderer == null) {
                    call.reject(session.closed ? "This document was closed." : "Open the document first.");
                    return;
                }
                int pageCount = session.renderer.getPageCount();
                int index = (int) Math.max(0, Math.min(pageCount - 1, Math.floor(pageValue)));
                int width = (int) Math.max(MIN_RENDER_WIDTH, Math.min(MAX_RENDER_WIDTH, Math.round(widthValue)));
                PdfRenderer.Page page = null;
                Bitmap bitmap = null;
                try {
                    page = session.renderer.openPage(index);
                    int pageWidth = Math.max(1, page.getWidth());
                    int pageHeight = Math.max(1, page.getHeight());
                    int height = (int) Math.max(1, Math.round((double) width * pageHeight / pageWidth));
                    if (height > MAX_RENDER_HEIGHT) {
                        width = (int) Math.max(1, Math.round((double) width * MAX_RENDER_HEIGHT / height));
                        height = MAX_RENDER_HEIGHT;
                    }
                    bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
                    bitmap.eraseColor(Color.WHITE);
                    page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY);
                    page.close();
                    page = null;
                    ByteArrayOutputStream png = new ByteArrayOutputStream();
                    if (!bitmap.compress(Bitmap.CompressFormat.PNG, 100, png)) {
                        call.reject("Could not show this page.");
                        return;
                    }
                    JSObject result = new JSObject();
                    result.put("png", Base64.encodeToString(png.toByteArray(), Base64.NO_WRAP));
                    result.put("width", width);
                    result.put("height", height);
                    result.put("page", index);
                    call.resolve(result);
                } catch (OutOfMemoryError error) {
                    call.reject("This page is too large to show on this device.");
                } catch (RuntimeException error) {
                    call.reject("Could not show this page.");
                } finally {
                    if (page != null) {
                        try {
                            page.close();
                        } catch (RuntimeException ignored) {
                            // Already closed.
                        }
                    }
                    if (bitmap != null) bitmap.recycle();
                }
            }
        });
    }

    @PluginMethod
    public void closePdf(PluginCall call) {
        String handle = call.getString("handle");
        if (!isId(handle)) {
            call.reject("Unknown document.");
            return;
        }
        run(call, () -> {
            PdfSession session = pdfs.remove(handle);
            // Closing an already closed handle is fine: the goal state is reached.
            if (session != null) {
                synchronized (session) {
                    session.close();
                }
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void closeAllPdfs(PluginCall call) {
        run(call, () -> {
            closeAllPdfSessions();
            call.resolve();
        });
    }

    // -------------------------------------------------------------- Export

    @PluginMethod
    public void beginExport(PluginCall call) {
        String filename = call.getString("filename");
        String mimeType = call.getString("mimeType");
        if (filename == null || filename.trim().isEmpty() || filename.length() > MAX_FILENAME
                || filename.contains("/") || filename.contains("\\") || filename.indexOf('\0') >= 0) {
            call.reject("The backup file name is invalid.");
            return;
        }
        if (mimeType == null || !MIME_PATTERN.matcher(mimeType).matches()) {
            call.reject("The backup file type is invalid.");
            return;
        }
        if (exports.size() >= MAX_OPEN_EXPORTS) {
            call.reject("Another export is still running. Wait for it to finish and try again.");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(mimeType);
        intent.putExtra(Intent.EXTRA_TITLE, filename.trim());
        try {
            startActivityForResult(call, intent, "exportDocumentCreated");
        } catch (RuntimeException error) {
            call.reject("Could not open the file picker on this device.");
        }
    }

    @ActivityCallback
    private void exportDocumentCreated(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            call.resolve(new JSObject().put("saved", false));
            return;
        }
        Uri uri = result.getData().getData();
        if (uri == null) {
            call.reject("Choose a location for the backup.");
            return;
        }
        run(call, () -> {
            OutputStream output;
            try {
                output = openExportStream(uri);
            } catch (IOException | SecurityException | IllegalArgumentException error) {
                deleteDocument(uri);
                call.reject("Could not write the backup to that location.");
                return;
            }
            String token = UUID.randomUUID().toString();
            exports.put(token, new ExportSession(uri, new BufferedOutputStream(output)));
            JSObject response = new JSObject();
            response.put("saved", true);
            response.put("token", token);
            call.resolve(response);
        });
    }

    @PluginMethod
    public void appendExport(PluginCall call) {
        run(call, () -> {
            String token = call.getString("token");
            ExportSession session = exportSession(call, token);
            if (session == null) return;
            String chunk = call.getString("chunk");
            if (chunk == null || chunk.isEmpty() || chunk.length() > MAX_EXPORT_CHUNK_CHARS) {
                call.reject("The backup data is invalid.");
                return;
            }
            byte[] bytes = chunk.getBytes(StandardCharsets.UTF_8);
            synchronized (session) {
                if (session.output == null) {
                    call.reject("This export was already finished.");
                    return;
                }
                if (session.bytes + bytes.length > MAX_EXPORT_BYTES) {
                    exports.remove(token);
                    discardExport(session);
                    call.reject("The backup is too large to export.");
                    return;
                }
                try {
                    session.output.write(bytes);
                    session.bytes += bytes.length;
                } catch (IOException | RuntimeException error) {
                    exports.remove(token);
                    discardExport(session);
                    call.reject("Could not write the backup. Check the storage location and try again.");
                    return;
                }
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void finishExport(PluginCall call) {
        run(call, () -> {
            String token = call.getString("token");
            ExportSession session = exportSession(call, token);
            if (session == null) return;
            synchronized (session) {
                exports.remove(token);
                if (session.output == null) {
                    call.reject("This export was already finished.");
                    return;
                }
                try {
                    session.output.flush();
                    session.output.close();
                    session.output = null;
                } catch (IOException | RuntimeException error) {
                    discardExport(session);
                    call.reject("Could not finish writing the backup. Check the storage location and try again.");
                    return;
                }
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void abortExport(PluginCall call) {
        String token = call.getString("token");
        if (!isId(token)) {
            call.reject("Unknown export.");
            return;
        }
        run(call, () -> {
            ExportSession session = exports.remove(token);
            // Aborting an export that already ended is fine: there is nothing left to clean up.
            if (session != null) {
                synchronized (session) {
                    discardExport(session);
                }
            }
            call.resolve();
        });
    }

    // ------------------------------------------------------------- Helpers

    /** Runs heavy work off the UI and bridge threads; never leaves a call unanswered. */
    private void run(PluginCall call, Runnable work) {
        try {
            executor.execute(() -> {
                try {
                    work.run();
                } catch (RuntimeException error) {
                    call.reject("Something went wrong with the document. Try again.");
                }
            });
        } catch (RejectedExecutionException | NullPointerException error) {
            call.reject("The document vault is not ready. Reopen the app and try again.");
        }
    }

    private static boolean isId(String value) {
        return value != null && ID_PATTERN.matcher(value).matches();
    }

    private PdfSession pdfSession(PluginCall call, String handle) {
        PdfSession session = isId(handle) ? pdfs.get(handle) : null;
        if (session == null) call.reject("This document is no longer open. Open it again.");
        return session;
    }

    private ExportSession exportSession(PluginCall call, String token) {
        ExportSession session = isId(token) ? exports.get(token) : null;
        if (session == null) call.reject("This export is no longer running. Start the export again.");
        return session;
    }

    /** Must be called while holding the session's lock. */
    private void dropPdf(String handle, PdfSession session) {
        pdfs.remove(handle);
        session.close();
    }

    private void closeAllPdfSessions() {
        for (String handle : new ArrayList<>(pdfs.keySet())) {
            PdfSession session = pdfs.remove(handle);
            if (session != null) {
                synchronized (session) {
                    session.close();
                }
            }
        }
        // Sweep anything not tracked by a session (for example after a crash mid-write).
        clearTempDir();
    }

    private File tempDir() throws IOException {
        synchronized (tempLock) {
            File dir = new File(getContext().getNoBackupFilesDir(), TEMP_DIR);
            if (!dir.isDirectory() && !dir.mkdirs() && !dir.isDirectory()) {
                throw new IOException("Could not create the temp folder.");
            }
            return dir;
        }
    }

    /** Deletes temp files that no open session owns. */
    private void clearTempDir() {
        synchronized (tempLock) {
            File dir = new File(getContext().getNoBackupFilesDir(), TEMP_DIR);
            File[] files = dir.listFiles();
            if (files == null) return;
            ArrayList<String> owned = new ArrayList<>();
            for (PdfSession session : pdfs.values()) owned.add(session.file.getName());
            for (File file : files) {
                if (owned.contains(file.getName())) continue;
                if (!file.delete() && file.exists()) file.deleteOnExit();
            }
        }
    }

    private static boolean hasPdfMagic(File file) {
        byte[] header = new byte[PDF_MAGIC.length];
        try (InputStream input = new FileInputStream(file)) {
            int read = 0;
            while (read < header.length) {
                int count = input.read(header, read, header.length - read);
                if (count < 0) return false;
                read += count;
            }
        } catch (IOException error) {
            return false;
        }
        for (int i = 0; i < PDF_MAGIC.length; i++) {
            if (header[i] != PDF_MAGIC[i]) return false;
        }
        return true;
    }

    private OutputStream openExportStream(Uri uri) throws IOException {
        OutputStream output;
        try {
            // "wt" truncates an existing document; some providers only support "w".
            output = getContext().getContentResolver().openOutputStream(uri, "wt");
        } catch (FileNotFoundException | IllegalArgumentException | UnsupportedOperationException error) {
            output = getContext().getContentResolver().openOutputStream(uri, "w");
        }
        if (output == null) throw new IOException("No output stream.");
        return output;
    }

    /** Closes the stream and deletes the partial document. Must be called while holding the session's lock. */
    private void discardExport(ExportSession session) {
        if (session.output != null) {
            try {
                session.output.close();
            } catch (IOException | RuntimeException ignored) {
                // The document is deleted next.
            }
            session.output = null;
        }
        deleteDocument(session.uri);
    }

    private void deleteDocument(Uri uri) {
        try {
            DocumentsContract.deleteDocument(getContext().getContentResolver(), uri);
        } catch (FileNotFoundException | RuntimeException ignored) {
            // The provider may not support deletion; the partial file then stays where the user chose.
        }
    }
}
