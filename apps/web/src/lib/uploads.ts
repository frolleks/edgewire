import { api, type CompleteUploadResponse, type UploadInitResponse } from "./api";

const MAX_PARALLEL_UPLOADS = 3;

const inferContentType = (file: File): string => file.type || "application/octet-stream";

export const initAvatarUpload = (file: File): Promise<UploadInitResponse> =>
  api.initAvatarUpload({
    filename: file.name,
    content_type: inferContentType(file),
    size: file.size,
  });

export const initAttachmentUpload = (channelId: string, file: File): Promise<UploadInitResponse> =>
  api.initAttachmentUpload({
    channel_id: channelId,
    filename: file.name,
    content_type: inferContentType(file),
    size: file.size,
  });

export const completeUpload = (uploadId: string): Promise<CompleteUploadResponse> => api.completeUpload(uploadId);

export const putToS3 = async (
  putUrl: string,
  file: File,
  headers: Record<string, string>,
): Promise<void> => {
  const response = await fetch(putUrl, {
    method: "PUT",
    headers,
    body: file,
  });

  if (!response.ok) {
    throw new Error(`Upload failed with status ${response.status}.`);
  }
};

export const runUploadsWithLimit = async <T>(
  items: T[],
  worker: (item: T, index: number) => Promise<void>,
  concurrency = MAX_PARALLEL_UPLOADS,
): Promise<void> => {
  if (items.length === 0) {
    return;
  }

  const limit = Math.max(1, Math.min(concurrency, MAX_PARALLEL_UPLOADS));
  let index = 0;

  const runWorker = async (): Promise<void> => {
    while (true) {
      const currentIndex = index;
      index += 1;

      if (currentIndex >= items.length) {
        return;
      }

      await worker(items[currentIndex]!, currentIndex);
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => runWorker()));
};
