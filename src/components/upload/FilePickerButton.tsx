"use client";

import { useRef } from "react";

type Props = {
  onFiles: (files: File[]) => void;
  multiple?: boolean;
  label?: string;
  className?: string;
  variant?: "primary" | "ghost";
};

export function FilePickerButton({
  onFiles,
  multiple = true,
  label = "파일 선택",
  className = "",
  variant = "primary",
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);

  const base =
    variant === "primary"
      ? "bg-warp-violet text-white hover:bg-warp-violet/90"
      : "border border-space-border bg-transparent text-text-secondary hover:bg-white/5";

  return (
    <>
      <button
        type="button"
        className={`rounded-full px-5 py-2.5 text-sm font-medium transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-warp-cyan ${base} ${className}`}
        onClick={() => inputRef.current?.click()}
      >
        {label}
      </button>
      <input
        ref={inputRef}
        type="file"
        className="sr-only"
        multiple={multiple}
        onChange={(e) => {
          const list = e.target.files ? Array.from(e.target.files) : [];
          if (list.length) onFiles(list);
          e.target.value = "";
        }}
      />
    </>
  );
}
