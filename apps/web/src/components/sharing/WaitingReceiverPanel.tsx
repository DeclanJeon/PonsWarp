"use client";

import { ShareCode } from "@/components/sharing/ShareCode";
import { ShareLink } from "@/components/sharing/ShareLink";
import { ShareQrCode } from "@/components/sharing/ShareQrCode";

type Props = {
  code: string;
  shareUrl: string;
  expiresAt?: number | null;
  className?: string;
};

export function WaitingReceiverPanel({ code, shareUrl, expiresAt, className = "" }: Props) {
  const remaining =
    expiresAt != null
      ? Math.max(0, Math.floor((expiresAt - Date.now()) / 60000))
      : null;

  return (
    <div className={`space-y-3 ${className}`}>
      <p className="text-sm text-text-secondary">상대방에게 코드, QR 또는 링크를 보내세요</p>
      <ShareCode code={code} />
      <ShareQrCode url={shareUrl} />
      <ShareLink url={shareUrl} />
      {remaining != null ? (
        <p className="text-xs text-text-muted">세션 만료까지 약 {remaining}분</p>
      ) : null}
    </div>
  );
}
