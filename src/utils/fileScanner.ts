import { FileNode } from '../types/types';

export interface ScannedFile {
  file: File;
  path: string; // 전체 상대 경로 (예: "folder/subfolder/image.png")
}

/**
 * FileSystemEntry API를 사용한 재귀적 파일 스캔
 * 드래그 앤 드롭 시 폴더 구조를 완벽하게 보존하기 위해 필수적입니다.
 */
export const scanFiles = async (
  items: DataTransferItemList
): Promise<ScannedFile[]> => {
  console.log(
    '[fileScanner] 🚀 [DEBUG] scanFiles called with',
    items.length,
    'items'
  );

  const scannedFiles: ScannedFile[] = [];

  // 비동기 큐 처리
  const entries: FileSystemEntry[] = [];
  for (let i = 0; i < items.length; i++) {
    const entry = items[i].webkitGetAsEntry();
    if (entry) {
      console.log('[fileScanner] 📁 [DEBUG] Found entry:', {
        index: i,
        name: entry.name,
        isFile: entry.isFile,
        isDirectory: entry.isDirectory,
        fullPath: entry.fullPath,
      });
      entries.push(entry);
    }
  }

  console.log(
    '[fileScanner] 🔄 [DEBUG] Starting to scan',
    entries.length,
    'entries'
  );
  await Promise.all(entries.map(entry => scanEntry(entry, '', scannedFiles)));

  console.log(
    '[fileScanner] ✅ [DEBUG] scanFiles completed, found',
    scannedFiles.length,
    'files'
  );
  return scannedFiles;
};

const scanEntry = async (
  entry: FileSystemEntry,
  basePath: string,
  list: ScannedFile[]
): Promise<void> => {
  console.log('[fileScanner] 🔍 [DEBUG] scanEntry called:', {
    name: entry.name,
    isFile: entry.isFile,
    isDirectory: entry.isDirectory,
    basePath,
  });

  if (entry.isFile) {
    await new Promise<void>((resolve, reject) => {
      (entry as FileSystemFileEntry).file(
        file => {
          // 숨겨진 파일(.DS_Store 등) 제외
          if (file.name.startsWith('.')) {
            console.log(
              '[fileScanner] ⏭️ [DEBUG] Skipping hidden file:',
              file.name
            );
            resolve();
            return;
          }

          const fullPath = basePath ? `${basePath}${entry.name}` : entry.name;
          console.log('[fileScanner] 📄 [DEBUG] Adding file:', {
            name: file.name,
            size: file.size,
            path: fullPath,
          });
          list.push({ file, path: fullPath });
          resolve();
        },
        err => {
          console.warn(
            '[fileScanner] ❌ [DEBUG] Failed to read file:',
            entry.name,
            err
          );
          resolve(); // 에러 발생해도 계속 진행
        }
      );
    });
  } else if (entry.isDirectory) {
    console.log('[fileScanner] 📂 [DEBUG] Scanning directory:', entry.name);
    const dirReader = (entry as FileSystemDirectoryEntry).createReader();
    const currentPath = basePath
      ? `${basePath}${entry.name}/`
      : `${entry.name}/`;

    // 디렉토리 엔트리 읽기 (한 번에 최대 100개씩 반환될 수 있으므로 루프 필요)
    const readEntries = async () => {
      const entries = await new Promise<FileSystemEntry[]>(
        (resolve, reject) => {
          dirReader.readEntries(resolve, reject);
        }
      );

      console.log(
        '[fileScanner] 📂 [DEBUG] Read',
        entries.length,
        'entries from directory:',
        entry.name
      );

      if (entries.length > 0) {
        await Promise.all(entries.map(e => scanEntry(e, currentPath, list)));
        await readEntries(); // 더 있을 수 있으므로 재귀 호출
      }
    };

    await readEntries();
  }
};

/**
 * 일반 Input Element (<input type="file" multiple />) 처리용
 * webkitRelativePath가 있는 경우 이를 우선 사용합니다.
 */
export const processInputFiles = (fileList: FileList): ScannedFile[] => {
  console.log(
    '[fileScanner] 🚀 [DEBUG] processInputFiles called with',
    fileList.length,
    'files'
  );

  const files: ScannedFile[] = [];

  for (let i = 0; i < fileList.length; i++) {
    const file = fileList[i];
    // webkitRelativePath가 있으면 사용, 없으면 파일명 (단일 파일 선택 시)
    const path = (file as any).webkitRelativePath || file.name;

    console.log('[fileScanner] 📁 [DEBUG] Processing file', i, ':', {
      name: file.name,
      size: file.size,
      type: file.type,
      webkitRelativePath: (file as any).webkitRelativePath,
      finalPath: path,
    });

    files.push({ file, path });
  }

  console.log(
    '[fileScanner] ✅ [DEBUG] processInputFiles completed, returning',
    files.length,
    'files'
  );
  return files;
};
