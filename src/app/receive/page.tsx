"use client";

import { useRouter } from "next/navigation";
import { ReceiverView } from "@/components/ponswarp/ReceiverView";

export default function ReceivePage() {
  const router = useRouter();
  return (
    <div className="page-center w-full">
      <ReceiverView onClose={() => router.push("/")} />
    </div>
  );
}
