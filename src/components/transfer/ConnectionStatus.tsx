"use client";

import { ConnectionPulse } from "@/components/warp/ConnectionPulse";
import type { PeerConnectionMode, TransferViewState } from "@/lib/types";

type Props = {
  state: TransferViewState;
  connectionMode?: PeerConnectionMode;
  errorMessage?: string | null;
  className?: string;
};

export function ConnectionStatus({ state, connectionMode = "unknown", errorMessage, className = "" }: Props) {
  return (
    <div className={className}>
      <ConnectionPulse state={state} connectionMode={connectionMode} />
      {errorMessage ? (
        <p className="mt-2 text-sm text-danger" role="alert">
          {errorMessage}
        </p>
      ) : null}
    </div>
  );
}
