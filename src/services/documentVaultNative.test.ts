import { describe, expect, it, vi } from 'vitest';
import { NATIVE_PDF_CHUNK_BYTES, sendFileWith, UPDATE_APP_MESSAGE } from './documentVaultNative';

function fakePlugin() {
  return {
    beginFile: vi.fn(async () => ({ handle: 'h-1' })),
    appendFile: vi.fn(async () => undefined),
    saveFile: vi.fn(async () => ({ saved: true })),
    shareFile: vi.fn(async () => undefined),
    printFile: vi.fn(async () => undefined),
    discardFile: vi.fn(async () => undefined),
  };
}

describe('sendFileWith', () => {
  it('streams the file in chunks, then saves it', async () => {
    const plugin = fakePlugin();
    const bytes = new Uint8Array(NATIVE_PDF_CHUNK_BYTES * 2 + 5).fill(1);
    await expect(sendFileWith(plugin, bytes, { kind: 'save', filename: 'a.pdf', mimeType: 'application/pdf' })).resolves.toBe(true);
    expect(plugin.appendFile).toHaveBeenCalledTimes(3);
    expect(plugin.saveFile).toHaveBeenCalledWith({ handle: 'h-1', filename: 'a.pdf', mimeType: 'application/pdf' });
    expect(plugin.discardFile).not.toHaveBeenCalled();
  });

  it('reports a cancelled save', async () => {
    const plugin = fakePlugin();
    plugin.saveFile.mockResolvedValueOnce({ saved: false });
    await expect(sendFileWith(plugin, new Uint8Array(10), { kind: 'save', filename: 'a.png', mimeType: 'image/png' })).resolves.toBe(false);
  });

  it('shares and prints', async () => {
    const plugin = fakePlugin();
    await sendFileWith(plugin, new Uint8Array(10), { kind: 'share', filename: 'a.jpg', mimeType: 'image/jpeg', title: 'Passport' });
    expect(plugin.shareFile).toHaveBeenCalledWith({ handle: 'h-1', filename: 'a.jpg', mimeType: 'image/jpeg', title: 'Passport' });
    await sendFileWith(plugin, new Uint8Array(10), { kind: 'print', mimeType: 'application/pdf', jobName: 'Passport' });
    expect(plugin.printFile).toHaveBeenCalledWith({ handle: 'h-1', mimeType: 'application/pdf', jobName: 'Passport' });
  });

  it('discards the prepared copy when streaming fails', async () => {
    const plugin = fakePlugin();
    plugin.appendFile.mockRejectedValueOnce(new Error('Disk full.'));
    await expect(sendFileWith(plugin, new Uint8Array(10), { kind: 'save', filename: 'a.pdf', mimeType: 'application/pdf' })).rejects.toThrow('Disk full.');
    expect(plugin.discardFile).toHaveBeenCalledWith({ handle: 'h-1' });
  });

  it('asks for an app update when the installed app lacks the methods', async () => {
    const plugin = fakePlugin();
    plugin.beginFile.mockRejectedValueOnce(Object.assign(new Error('not implemented'), { code: 'UNIMPLEMENTED' }));
    await expect(sendFileWith(plugin, new Uint8Array(10), { kind: 'print', mimeType: 'image/png', jobName: 'x' })).rejects.toThrow(UPDATE_APP_MESSAGE);
  });

  it('refuses empty and oversized files', async () => {
    const plugin = fakePlugin();
    await expect(sendFileWith(plugin, new Uint8Array(0), { kind: 'print', mimeType: 'image/png', jobName: 'x' })).rejects.toThrow('empty');
    await expect(sendFileWith(plugin, new Uint8Array(10 * 1024 * 1024 + 1), { kind: 'print', mimeType: 'image/png', jobName: 'x' })).rejects.toThrow('10 MB');
    expect(plugin.beginFile).not.toHaveBeenCalled();
  });
});
