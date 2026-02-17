export const formatTime = (timestamp: string, locale?: string): string =>
  new Date(timestamp).toLocaleTimeString(locale ? [locale] : [], {
    hour: "2-digit",
    minute: "2-digit",
  });

export const formatBytes = (value: number): string => {
  if (value < 1024) {
    return `${value} B`;
  }

  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }

  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
};

export const getDisplayInitial = (displayName: string): string =>
  displayName.trim().slice(0, 1).toUpperCase() || "?";

export const isImageAttachment = (contentType?: string | null): boolean =>
  Boolean(contentType?.startsWith("image/"));
