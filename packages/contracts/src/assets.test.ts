import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  AssetCreateUrlsInput,
  AssetCreateUrlsResult,
  AssetWorkspaceAssetNotFoundError,
  AttachmentCreateUploadUrlInput,
} from "./assets.ts";
import {
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "./chatAttachment.ts";

const isUploadInput = Schema.is(AttachmentCreateUploadUrlInput);

const uploadInput = {
  name: "screenshot.png",
  mimeType: "image/png",
  sizeBytes: 3,
} as const;

describe("AttachmentCreateUploadUrlInput", () => {
  it("accepts supported image attachments", () => {
    expect(isUploadInput(uploadInput)).toBe(true);
  });

  it("rejects image types that providers do not support", () => {
    expect(isUploadInput({ ...uploadInput, mimeType: "image/svg+xml" })).toBe(false);
  });

  it("accepts generic files without treating them as provider images", () => {
    expect(
      isUploadInput({
        type: "file",
        name: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: PROVIDER_SEND_TURN_MAX_IMAGE_BYTES + 1,
      }),
    ).toBe(true);
    expect(
      isUploadInput({
        type: "file",
        name: "diagram.svg",
        mimeType: "image/svg+xml",
        sizeBytes: 3,
      }),
    ).toBe(true);
  });

  it("rejects empty and oversized uploads", () => {
    expect(isUploadInput({ ...uploadInput, sizeBytes: 0 })).toBe(false);
    expect(
      isUploadInput({ ...uploadInput, sizeBytes: PROVIDER_SEND_TURN_MAX_IMAGE_BYTES + 1 }),
    ).toBe(false);
    expect(
      isUploadInput({
        type: "file",
        name: "archive.zip",
        mimeType: "application/zip",
        sizeBytes: PROVIDER_SEND_TURN_MAX_FILE_BYTES + 1,
      }),
    ).toBe(false);
  });
});

describe("asset URL batches", () => {
  it("bounds batches and validates every resource", () => {
    const isBatch = Schema.is(AssetCreateUrlsInput);
    const resource = { _tag: "attachment", attachmentId: "file" } as const;
    expect(isBatch({ resources: [] })).toBe(false);
    expect(isBatch({ resources: Array.from({ length: 64 }, () => ({ ...resource })) })).toBe(true);
    expect(isBatch({ resources: Array.from({ length: 65 }, () => ({ ...resource })) })).toBe(false);
    expect(isBatch({ resources: [resource, { _tag: "unknown" }] })).toBe(false);
  });
  it("round-trips ordered successes and typed per-file errors", () => {
    const schema = Schema.fromJsonString(Schema.toCodecJson(AssetCreateUrlsResult));
    const results = [
      Result.succeed({ relativeUrl: "/api/assets/one", expiresAt: 100 }),
      Result.fail(
        new AssetWorkspaceAssetNotFoundError({
          resource: { _tag: "attachment", attachmentId: "missing" },
        }),
      ),
    ];
    expect(Schema.decodeSync(schema)(Schema.encodeSync(schema)(results))).toEqual(results);
  });
});
