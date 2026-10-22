import { readFile } from "node:fs/promises";

export interface PublisherEnvironment {
  readonly apiBaseUrl: string;
  readonly oidcAudience: string;
  readonly oidcRequestUrl: string;
  readonly oidcRequestToken: string;
}

export interface PublishArtifactInput extends PublisherEnvironment {
  readonly product: string;
  readonly version: string;
  readonly commitSha: string;
  readonly archivePath: string;
  readonly sha256: string;
  readonly byteSize: number;
}

interface JsonRecord {
  readonly [key: string]: unknown;
}

function requireHttpsUrl(value: string, label: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:") {
    throw new Error(`${label} must use HTTPS.`);
  }
  if (url.search !== "" || url.hash !== "") {
    throw new Error(`${label} must not include a query or fragment.`);
  }
  return url;
}

function endpointUrl(baseUrl: string, pathname: string): string {
  const url = requireHttpsUrl(baseUrl, "INSTALLER_ARTIFACT_API_URL");
  url.pathname = `${url.pathname.replace(/\/$/u, "")}${pathname}`;
  return url.toString();
}

async function parseJsonResponse(
  response: Response,
  label: string,
): Promise<JsonRecord> {
  const text = await response.text();
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`${label} returned invalid JSON.`, { cause: error });
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must return a JSON object.`);
  }
  if (!response.ok) {
    const code = (value as JsonRecord).error ?? (value as JsonRecord).message;
    throw new Error(
      `${label} returned HTTP ${response.status}${typeof code === "string" ? `: ${code}` : "."}`,
    );
  }
  return value as JsonRecord;
}

export async function requestGithubOidcToken(
  input: Pick<
    PublisherEnvironment,
    "oidcAudience" | "oidcRequestUrl" | "oidcRequestToken"
  >,
): Promise<string> {
  const requestUrl = new URL(input.oidcRequestUrl);
  if (requestUrl.protocol !== "https:") {
    throw new Error("The GitHub OIDC request URL must use HTTPS.");
  }
  requestUrl.searchParams.set("audience", input.oidcAudience);
  const response = await fetch(requestUrl, {
    headers: {
      Authorization: `Bearer ${input.oidcRequestToken}`,
      Accept: "application/json",
    },
  });
  const value = await parseJsonResponse(response, "GitHub OIDC");
  const token = value.value;
  if (typeof token !== "string" || token === "") {
    throw new Error("GitHub OIDC did not return a token.");
  }
  return token;
}

function metadata(input: PublishArtifactInput) {
  return {
    product: input.product,
    version: input.version,
    commitSha: input.commitSha,
    sha256: input.sha256,
    byteSize: input.byteSize,
  };
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value === "") {
    throw new Error(`The artifact API response is missing ${label}.`);
  }
  return value;
}

export async function publishReleaseArtifact(
  input: PublishArtifactInput,
): Promise<JsonRecord> {
  if (!/^[0-9a-f]{64}$/u.test(input.sha256)) {
    throw new Error(
      "The artifact SHA-256 must contain 64 lowercase hex digits.",
    );
  }
  if (!Number.isSafeInteger(input.byteSize) || input.byteSize <= 0) {
    throw new Error("The artifact byte size must be a positive integer.");
  }
  if (!/^[0-9a-f]{40}$/u.test(input.commitSha)) {
    throw new Error(
      "The release commit SHA must contain 40 lowercase hex digits.",
    );
  }

  const token = await requestGithubOidcToken(input);
  const identity = metadata(input);
  const prepareUrl = endpointUrl(
    input.apiBaseUrl,
    "/api/internal/installer-artifacts",
  );
  const prepareResponse = await fetch(prepareUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(identity),
  });
  const prepared = await parseJsonResponse(
    prepareResponse,
    "Artifact preparation",
  );
  const objectKey = requireString(prepared.objectKey, "objectKey");
  const uploadUrl = requireString(prepared.uploadUrl, "uploadUrl");
  const expectedObjectKey = `products/${input.product}/${input.version}/${input.sha256}.tar.gz`;
  if (objectKey !== expectedObjectKey) {
    throw new Error(
      "The artifact API returned an unexpected immutable object key.",
    );
  }

  const archive = await readFile(input.archivePath);
  const uploadResponse = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Type": "application/gzip",
    },
    body: archive,
  }).catch(() => {
    // Network errors can embed the presigned URL; never propagate it.
    throw new Error("The signed artifact upload could not be completed.");
  });
  if (!uploadResponse.ok) {
    throw new Error(
      `The signed artifact upload returned HTTP ${uploadResponse.status}.`,
    );
  }

  const activateUrl = endpointUrl(
    input.apiBaseUrl,
    "/api/internal/installer-artifacts/activate",
  );
  const activateResponse = await fetch(activateUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(identity),
  });
  const activated = await parseJsonResponse(
    activateResponse,
    "Artifact activation",
  );
  const descriptor =
    typeof activated.artifact === "object" &&
    activated.artifact !== null &&
    !Array.isArray(activated.artifact)
      ? (activated.artifact as JsonRecord)
      : activated;
  if (descriptor.activated !== true && descriptor.status !== "active") {
    throw new Error("The artifact API did not confirm artifact activation.");
  }
  for (const [key, expected] of Object.entries(identity)) {
    if (!(key in descriptor)) {
      throw new Error(`The activated artifact is missing ${key}.`);
    }
    if (descriptor[key] !== expected) {
      throw new Error(`The activated artifact has a mismatched ${key}.`);
    }
  }
  return descriptor;
}
