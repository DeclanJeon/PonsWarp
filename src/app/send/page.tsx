"use client";

import { useRouter } from "next/navigation";
import { SenderView } from "@/components/ponswarp/SenderView";

export default function SendPage() {
  const router = useRouter();
  return (
    <div className="page-center w-full">
      <SenderView
        onAbort={() => {
          (window as Window & { __warpspaceFiles?: File[] }).__warpspaceFiles = undefined;
          router.push("/");
        }}
      />
    </div>
  );
}
