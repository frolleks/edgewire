import type { MessagePayload } from "@discord/types";
import AttachmentItem from "./attachment-item";

type MessageAttachment = MessagePayload["attachments"][number];

type AttachmentListProps = {
  attachments: MessageAttachment[];
};

export function AttachmentList({ attachments }: AttachmentListProps) {
  if (attachments.length === 0) {
    return null;
  }

  return (
    <div className="mt-2 space-y-2">
      {attachments.map((attachment) => (
        <AttachmentItem key={attachment.id} attachment={attachment} />
      ))}
    </div>
  );
}

export default AttachmentList;
