import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";

import {
  BrainPackError,
  brainPackLimits,
  type BrainPackSource,
} from "../src/domain/brain-pack.js";
import { decodeBrainPack, encodeBrainPack } from "../src/domain/brain-pack-codec.js";

async function fixture(): Promise<BrainPackSource> {
  return JSON.parse(
    await readFile(new URL("./fixtures/brain-packs/valid-multilingual.json", import.meta.url), "utf8"),
  ) as BrainPackSource;
}

function tamper(bytes: Uint8Array, mutate: (entries: Record<string, Uint8Array>) => void): Uint8Array {
  const entries = unzipSync(bytes);
  mutate(entries);
  return zipSync(entries, { level: 1 });
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

interface ManifestShape {
  formatVersion: number;
  inventory: { path: string; byteSize: number; sha256: string }[];
}

/** Rewrites one entry and keeps the manifest honest about it, so only the intended defect remains. */
function replaceEntry(entries: Record<string, Uint8Array>, path: string, bytes: Uint8Array): void {
  entries[path] = bytes;
  const manifest = JSON.parse(strFromU8(entries["manifest.json"]!)) as ManifestShape;
  const entry = manifest.inventory.find((item) => item.path === path)!;
  entry.byteSize = bytes.byteLength;
  entry.sha256 = sha256(bytes);
  entries["manifest.json"] = strToU8(JSON.stringify(manifest));
}

function expectCode(bytes: Uint8Array, code: BrainPackError["code"]): BrainPackError {
  try {
    decodeBrainPack(bytes);
  } catch (error) {
    expect(error).toBeInstanceOf(BrainPackError);
    expect((error as BrainPackError).code).toBe(code);
    return error as BrainPackError;
  }
  throw new Error(`Expected ${code}`);
}

describe("Brain Pack codec", () => {
  it("round-trips a multilingual pack byte for byte and deterministically", async () => {
    const source = await fixture();
    const first = encodeBrainPack(source);
    const second = encodeBrainPack(source);

    expect(first.sha256).toBe(second.sha256);
    expect(first.byteSize).toBe(first.bytes.byteLength);
    expect(first.manifest.inventory.map((entry) => entry.path)).toEqual([
      "collections.json",
      "documents.json",
      "documents/architecture-notes.md",
      "documents/guia-de-bienvenida.md",
      "documents/notas-de-arquitetura.md",
      "documents/runbook-deploy.md",
    ]);

    const decoded = decodeBrainPack(first.bytes);
    expect(decoded.manifest).toEqual(first.manifest);
    expect(decoded.collections).toEqual(source.collections);
    expect(decoded.documents.map((document) => document.key)).toEqual(
      source.documents.map((document) => document.key),
    );
    const notas = decoded.documents.find((document) => document.key === "notas-de-arquitetura");
    expect(notas?.content).toBe(
      "# Notas de arquitetura\n\nUm cérebro por implantação. Acentuação: ação, coração, ñ — e emoji 🧠.\n",
    );
    expect(notas?.representation).toBe("reconstructed");
    const guia = decoded.documents.find((document) => document.key === "guia-de-bienvenida");
    expect(guia?.attribution.origin?.publisherNamespace).toBe("upstream.org");
  });

  it("rejects an unknown major format version before anything else", async () => {
    const bytes = encodeBrainPack(await fixture()).bytes;
    const tampered = tamper(bytes, (entries) => {
      const manifest = JSON.parse(strFromU8(entries["manifest.json"]!)) as ManifestShape;
      manifest.formatVersion = 2;
      entries["manifest.json"] = strToU8(JSON.stringify(manifest));
    });
    expectCode(tampered, "PACK_FORMAT_UNSUPPORTED");
  });

  it("rejects hash and size mismatches as integrity failures", async () => {
    const bytes = encodeBrainPack(await fixture()).bytes;
    const changedText = tamper(bytes, (entries) => {
      entries["documents/runbook-deploy.md"] = strToU8("tampered\n");
    });
    expect(expectCode(changedText, "PACK_INTEGRITY_FAILED").details.join(" ")).toContain(
      "documents/runbook-deploy.md",
    );
  });

  it("rejects undeclared, missing, duplicate and unsafe entries", async () => {
    const bytes = encodeBrainPack(await fixture()).bytes;
    expectCode(
      tamper(bytes, (entries) => {
        entries["documents/extra.md"] = strToU8("extra");
      }),
      "PACK_MANIFEST_INVALID",
    );
    expectCode(
      tamper(bytes, (entries) => {
        delete entries["documents/runbook-deploy.md"];
      }),
      "PACK_MANIFEST_INVALID",
    );
    expectCode(
      tamper(bytes, (entries) => {
        entries["../escape.md"] = strToU8("x");
      }),
      "PACK_MANIFEST_INVALID",
    );
    expectCode(
      tamper(bytes, (entries) => {
        entries["documents/nested.brainpack"] = bytes;
      }),
      "PACK_MANIFEST_INVALID",
    );
    expectCode(
      tamper(bytes, (entries) => {
        entries["documents/"] = new Uint8Array(0);
      }),
      "PACK_MANIFEST_INVALID",
    );
    expectCode(new Uint8Array([1, 2, 3]), "PACK_INTEGRITY_FAILED");
  });

  it("rejects duplicate keys and broken references", async () => {
    const source = await fixture();
    const duplicateKeys = {
      ...source,
      documents: [...source.documents, { ...source.documents[3]!, title: "Copy" }],
    };
    expect(() => encodeBrainPack(duplicateKeys)).toThrowError(
      expect.objectContaining({ code: "PACK_MANIFEST_INVALID" }),
    );

    const danglingReference = {
      ...source,
      documents: source.documents.map((document, index) =>
        index === 0 ? { ...document, references: [{ targetKey: "missing", kind: "related" as const }] } : document,
      ),
    };
    expect(() => encodeBrainPack(danglingReference)).toThrowError(
      expect.objectContaining({ code: "PACK_REFERENCE_INVALID" }),
    );

    const bytes = encodeBrainPack(source).bytes;
    const tampered = tamper(bytes, (entries) => {
      const documents = JSON.parse(strFromU8(entries["documents.json"]!)) as {
        documents: { references: { targetKey: string; kind: string }[] }[];
      };
      documents.documents[3]!.references = [{ targetKey: "nowhere", kind: "related" }];
      replaceEntry(entries, "documents.json", strToU8(JSON.stringify(documents)));
    });
    expectCode(tampered, "PACK_REFERENCE_INVALID");
  });

  it("rejects archives and documents over the limits", async () => {
    const source = await fixture();
    const oversized = {
      ...source,
      documents: source.documents.map((document, index) =>
        index === 0 ? { ...document, content: "x".repeat(brainPackLimits.documentCharacters + 1) } : document,
      ),
    };
    expect(() => encodeBrainPack(oversized)).toThrowError(
      expect.objectContaining({ code: "PACK_LIMIT_EXCEEDED" }),
    );

    const tooManyEntries = tamper(encodeBrainPack(source).bytes, (entries) => {
      for (let index = 0; index < brainPackLimits.entries; index += 1) {
        entries[`documents/pad-${index}.md`] = strToU8("pad");
      }
    });
    expectCode(tooManyEntries, "PACK_LIMIT_EXCEEDED");
  });

  it("rejects payloads that are not UTF-8 text", async () => {
    const bytes = encodeBrainPack(await fixture()).bytes;
    const binary = tamper(bytes, (entries) => {
      replaceEntry(entries, "documents/runbook-deploy.md", new Uint8Array([0xff, 0xfe, 0x00, 0x41]));
    });
    expectCode(binary, "PACK_MANIFEST_INVALID");
  });
});
