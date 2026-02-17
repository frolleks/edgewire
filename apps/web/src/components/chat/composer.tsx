import type { ChangeEvent } from "react";
import { useEffect, useRef } from "react";
import { ArrowUp, Paperclip } from "lucide-react";
import type { ComposerAttachment } from "@/app/types";
import { formatBytes } from "@/components/utils/format";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

type ComposerProps = {
  value: string;
  onValueChange: (value: string) => void;
  canSendInActiveChannel: boolean;
  routeMode: "dm" | "guild";
  dmUsername?: string;
  channelName?: string | null;
  attachments: ComposerAttachment[];
  isSendingMessage: boolean;
  isSendMutationPending: boolean;
  onAttachmentInputChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onRemoveAttachment: (localId: string) => void;
  onSend: () => void;
  onTriggerTyping: () => void;
};

export function Composer({
  value,
  onValueChange,
  canSendInActiveChannel,
  routeMode,
  dmUsername,
  channelName,
  attachments,
  isSendingMessage,
  isSendMutationPending,
  onAttachmentInputChange,
  onRemoveAttachment,
  onSend,
  onTriggerTyping,
}: ComposerProps) {
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isSendDisabled =
    isSendingMessage || isSendMutationPending || !canSendInActiveChannel;
  const maxTextareaHeight = 144;

  const autosize = (textarea: HTMLTextAreaElement): void => {
    textarea.style.height = "0px";
    const nextHeight = Math.min(textarea.scrollHeight, maxTextareaHeight);
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY =
      textarea.scrollHeight > maxTextareaHeight ? "auto" : "hidden";
  };

  useEffect(() => {
    if (textareaRef.current) {
      autosize(textareaRef.current);
    }
  }, [value]);

  return (
    <footer className="shrink-0 p-4 bg-card">
      <div className="relative">
        <Textarea
          ref={textareaRef}
          rows={1}
          value={value}
          onChange={(event) => {
            onValueChange(event.target.value);
            onTriggerTyping();
            autosize(event.target);
          }}
          disabled={!canSendInActiveChannel || isSendingMessage}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              onSend();
            }
          }}
          placeholder={
            routeMode === "dm"
              ? `Message @${dmUsername ?? "user"}`
              : `Message #${channelName ?? "channel"}`
          }
          className="min-h-10 max-h-36 resize-none pl-12 pr-12 py-2.5 leading-5"
        />
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={() => attachmentInputRef.current?.click()}
          disabled={isSendingMessage || !canSendInActiveChannel}
          aria-label="Attach"
          title="Attach"
          className="absolute bottom-1 left-1"
        >
          <Paperclip />
        </Button>
        <Button
          onClick={onSend}
          size="icon-sm"
          disabled={isSendDisabled}
          aria-label={
            isSendingMessage || isSendMutationPending ? "Sending..." : "Send"
          }
          title={
            isSendingMessage || isSendMutationPending ? "Sending..." : "Send"
          }
          className="absolute bottom-1 right-1"
        >
          <ArrowUp />
        </Button>
      </div>
      <input
        ref={attachmentInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={onAttachmentInputChange}
      />
      {!canSendInActiveChannel && routeMode === "guild" ? (
        <p className="mt-2 text-xs">
          You do not have permission to send messages in this server.
        </p>
      ) : null}
      {attachments.length > 0 ? (
        <div className="mt-3 space-y-2">
          {attachments.map((attachment) => (
            <div
              key={attachment.local_id}
              className="flex items-center justify-between gap-3 rounded-md border px-3 py-2"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">
                  {attachment.filename}
                </p>
                <p className="text-xs">
                  {formatBytes(attachment.size)} · {attachment.status}
                  {attachment.error ? ` · ${attachment.error}` : ""}
                </p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => onRemoveAttachment(attachment.local_id)}
                disabled={isSendingMessage || attachment.status === "uploading"}
              >
                Remove
              </Button>
            </div>
          ))}
        </div>
      ) : null}
    </footer>
  );
}

export default Composer;
