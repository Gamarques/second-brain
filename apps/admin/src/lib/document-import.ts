/** The document contract is counted in characters; transport is counted in bytes (UTF-8 can take four per character). */
export const maximumDocumentImportCharacters = 1_000_000;
export const maximumDocumentImportBytes = 4 * maximumDocumentImportCharacters;

export class DocumentImportError extends Error {
  constructor(readonly code: "FILE_TOO_LARGE" | "FILE_READ_FAILED", cause?: unknown) {
    super(code === "FILE_TOO_LARGE" ? "The document file is too large." : "The document file could not be read.", { cause });
    this.name = "DocumentImportError";
  }
}

interface ReadableDocumentFile {
  readonly name: string;
  readonly size: number;
  text(): Promise<string>;
}

export async function readDocumentImport(file: ReadableDocumentFile): Promise<{ content: string; suggestedTitle: string }> {
  if (file.size > maximumDocumentImportBytes) throw new DocumentImportError("FILE_TOO_LARGE");
  let content: string;
  try {
    content = await file.text();
  } catch (cause) {
    throw new DocumentImportError("FILE_READ_FAILED", cause);
  }
  if (content.length > maximumDocumentImportCharacters) throw new DocumentImportError("FILE_TOO_LARGE");
  return {
    content,
    suggestedTitle: file.name.replace(/\.[^.]+$/u, ""),
  };
}
