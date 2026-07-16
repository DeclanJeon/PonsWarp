"use client";

type Props = {
  role: "sender" | "receiver";
  receivedFiles?: { id: string; name: string; url: string }[];
  onAddMore?: () => void;
  onNewSession?: () => void;
  onEnd?: () => void;
  className?: string;
};

export function CompletionPanel({
  role,
  receivedFiles = [],
  onAddMore,
  onNewSession,
  onEnd,
  className = "",
}: Props) {
  return (
    <div className={`glass-panel space-y-4 p-5 ${className}`}>
      <div>
        <h2 className="text-lg font-medium text-text-primary">
          {role === "sender" ? "모든 파일이 도착했습니다" : "모든 파일을 받았습니다"}
        </h2>
        <p className="mt-1 text-sm text-text-secondary">
          {role === "sender"
            ? "수신 기기에서 파일 저장이 완료되었습니다."
            : "아래에서 받은 파일을 확인할 수 있습니다."}
        </p>
      </div>

      {role === "receiver" && receivedFiles.length > 0 ? (
        <ul className="space-y-2">
          {receivedFiles.map((f) => (
            <li key={f.id}>
              <a
                href={f.url}
                download={f.name}
                className="block truncate rounded-xl border border-space-border px-3 py-2 text-sm text-warp-blue hover:bg-white/5"
              >
                {f.name}
              </a>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {role === "sender" && onAddMore ? (
          <button type="button" onClick={onAddMore} className="rounded-full bg-warp-violet px-4 py-2 text-sm text-white">
            추가 파일 전송
          </button>
        ) : null}
        {role === "receiver" && receivedFiles[0] ? (
          <a
            href={receivedFiles[0].url}
            download={receivedFiles[0].name}
            className="rounded-full bg-warp-cyan px-4 py-2 text-sm font-medium text-space-bg"
          >
            파일 확인하기
          </a>
        ) : null}
        {onNewSession ? (
          <button
            type="button"
            onClick={onNewSession}
            className="rounded-full border border-space-border px-4 py-2 text-sm text-text-secondary hover:bg-white/5"
          >
            {role === "sender" ? "새 전송 공간 만들기" : "새 파일 받기"}
          </button>
        ) : null}
        {onEnd ? (
          <button
            type="button"
            onClick={onEnd}
            className="rounded-full border border-space-border px-4 py-2 text-sm text-text-secondary hover:bg-white/5"
          >
            전송 종료
          </button>
        ) : null}
      </div>
    </div>
  );
}
