export function readerAccessOf(settings: unknown) {
  const access = (settings as { readerAccess?: { protectCopy?: unknown; allowDownload?: unknown } } | null)?.readerAccess;
  return {
    protectCopy: access?.protectCopy === true,
    allowDownload: access?.allowDownload === true,
  };
}
