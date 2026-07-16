"use client";

import { QRCodeSVG } from "qrcode.react";

type Props = {
  url: string;
  className?: string;
};

export function ShareQrCode({ url, className = "" }: Props) {
  return (
    <div className={`glass-panel flex flex-col items-center p-4 ${className}`}>
      <p className="mb-3 text-xs text-text-muted">QR 코드</p>
      <div className="relative rounded-2xl bg-white p-3">
        <div className="pointer-events-none absolute -inset-2 rounded-3xl border border-warp-violet/20" aria-hidden />
        <QRCodeSVG value={url} size={148} level="M" includeMargin={false} bgColor="#ffffff" fgColor="#0b1020" />
      </div>
      <a href={url} className="mt-3 text-xs text-warp-blue hover:underline" target="_blank" rel="noreferrer">
        QR과 동일한 공유 링크 열기
      </a>
    </div>
  );
}
