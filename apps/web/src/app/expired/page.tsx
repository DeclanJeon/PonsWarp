"use client";

import Link from "next/link";
import { AlertCircle } from "lucide-react";

export default function ExpiredPage() {
  return (
    <div className="mx-auto flex max-w-lg flex-col items-center gap-4 px-4 py-20 text-center">
      <div className="flex h-20 w-20 items-center justify-center rounded-full border border-red-500/30 bg-red-500/10">
        <AlertCircle className="text-red-400" size={36} />
      </div>
      <h1 className="brand-font text-2xl font-bold tracking-widest text-white">ROOM EXPIRED</h1>
      <p className="text-sm text-gray-400">
        This warp key is gone or never existed. Ask the sender for a fresh code.
      </p>
      <div className="flex flex-wrap justify-center gap-2 pt-2">
        <Link href="/" className="rounded-full bg-cyan-400 px-5 py-2.5 text-sm font-bold tracking-wider text-black">
          HOME
        </Link>
        <Link
          href="/receive"
          className="rounded-full border border-white/10 px-5 py-2.5 text-sm tracking-wider text-gray-300 hover:bg-white/5"
        >
          ENTER KEY
        </Link>
      </div>
    </div>
  );
}
