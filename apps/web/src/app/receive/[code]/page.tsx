"use client";

import { useParams, useRouter } from "next/navigation";
import { ReceiverView } from "@/components/ponswarp/ReceiverView";
import { sanitizeCodeInput } from "@/lib/formatting/code";

export default function ReceiveCodePage() {
  const params = useParams<{ code: string }>();
  const router = useRouter();
  const code = sanitizeCodeInput(String(params.code || ""));

  return (
    <div className="page-center w-full">
      <ReceiverView initialCode={code} onClose={() => router.push("/")} />
    </div>
  );
}
