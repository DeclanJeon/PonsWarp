"use client";

import Link from "next/link";
import { useParams } from "next/navigation";

export default function TransferSessionPage() {
  const params = useParams<{ sessionId: string }>();

  return (
    <div className="mx-auto flex max-w-lg flex-col items-center gap-4 px-4 py-20 text-center">
      <p className="text-xs font-bold uppercase tracking-[0.22em] text-cyan-300">Session</p>
      <h1 className="brand-font text-2xl font-bold tracking-widest text-white">WARP ROOM</h1>
      <p className="font-mono text-sm text-gray-400">{params.sessionId}</p>
      <p className="text-sm text-gray-500">
        Live transfers run on the Send or Receive gates. Use a warp key if you have one.
      </p>
      <div className="flex gap-2 pt-2">
        <Link href="/send" className="rounded-full bg-cyan-400 px-5 py-2.5 text-sm font-bold text-black">
          SEND
        </Link>
        <Link href="/receive" className="rounded-full border border-white/10 px-5 py-2.5 text-sm text-gray-300">
          RECEIVE
        </Link>
      </div>
    </div>
  );
}
