import type { Invite } from "@/lib/api";
import { Modal } from "@/components/layout/modal";
import { Button } from "@/components/ui/button";

type InviteModalProps = {
  open: boolean;
  onClose: () => void;
  isGenerating: boolean;
  invite: Invite | null;
  onCopyLink: () => void;
};

export function InviteModal({
  open,
  onClose,
  isGenerating,
  invite,
  onCopyLink,
}: InviteModalProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Invite Link"
      description="Share this invite code to let another user join the guild."
    >
      <div className="space-y-4">
        {isGenerating ? <p>Generating invite...</p> : null}
        {invite ? (
          <>
            <div className="rounded-md border p-3">
              <p className="text-sm">Code</p>
              <p className="font-semibold">{invite.code}</p>
              <p className="text-xs mt-2">
                Link: {`${window.location.origin}/invite/${invite.code}`}
              </p>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={onCopyLink}>
                Copy Link
              </Button>
            </div>
          </>
        ) : null}
      </div>
    </Modal>
  );
}

export default InviteModal;
