import type { MessagePayload } from "@discord/types";
import { formatBytes, isImageAttachment } from "@/components/utils/format";

type MessageAttachment = MessagePayload["attachments"][number];

type AttachmentItemProps = {
  attachment: MessageAttachment;
};

export function AttachmentItem({ attachment }: AttachmentItemProps) {
  if (isImageAttachment(attachment.content_type)) {
    return (
      <a
        href={attachment.url}
        target="_blank"
        rel="noreferrer"
        className="block max-w-sm overflow-hidden rounded-md border bg-card"
      >
        <img
          src={attachment.url}
          alt={attachment.filename}
          className="max-h-80 w-full object-cover"
          loading="lazy"
        />
      </a>
    );
  }

  return (
    <a
      href={attachment.url}
      target="_blank"
      rel="noreferrer"
      className="block rounded-md border px-3 py-2 text-sm hover:bg-accent"
    >
      <p className="font-medium truncate">{attachment.filename}</p>
      <p className="text-xs mt-1">
        {formatBytes(attachment.size)}
        {attachment.content_type ? ` · ${attachment.content_type}` : ""}
      </p>
    </a>
  );
}

export default AttachmentItem;
