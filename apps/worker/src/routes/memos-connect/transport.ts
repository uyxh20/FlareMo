import {
  CompatValidationError,
  isDomainError,
} from "../../memos-compat/errors";
import {
  type BinaryTransport,
  encodeBinaryError,
  ProtoCodecError,
} from "../../memos-compat/proto-wire";
import { loadMemosProtobuf } from "./protobuf-loader";
import type { ConnectContext } from "./shared";

/**
 * The JSON transport still normalizes through the generated descriptors, so it
 * loads the same runtime as the binary one — the split is about keeping the
 * descriptor runtime off the isolate startup graph, not about making the JSON
 * path independent of it.
 */
async function connectJson(c: ConnectContext, value: unknown) {
  const { normalizeMemosJsonResponse } = await loadMemosProtobuf();
  const normalized = normalizeMemosJsonResponse(
    c.req.param("service") ?? "",
    c.req.param("method") ?? "",
    value,
  );
  return c.json(normalized, 200, { "content-type": "application/json" });
}

export async function connectValue(
  c: ConnectContext,
  value: unknown,
  transport?: BinaryTransport,
) {
  if (!transport) return connectJson(c, value);
  const { encodeBinaryResponse } = await loadMemosProtobuf();
  const encoded = encodeBinaryResponse(
    c.req.param("service") ?? "",
    c.req.param("method") ?? "",
    value,
    transport,
  );
  const headers = new Headers({
    "cache-control": "no-store",
    "content-type": binaryContentType(transport),
  });
  if (transport !== "connect-proto") headers.set("grpc-status", "0");
  return new Response(encoded as unknown as BodyInit, { status: 200, headers });
}
export function connectError(
  c: ConnectContext,
  code: string,
  message: string,
  status: 400 | 401 | 403 | 404 | 409 | 415 | 429 | 500 | 501,
) {
  return c.json({ code, message }, status, {
    "content-type": "application/json",
  });
}

/**
 * Binary error envelope. Deliberately synchronous: it is reachable from the
 * `catch` of a request that failed before any descriptor runtime was loaded
 * (a 415, a credential rejection, an unparseable frame), so it must never
 * depend on the lazy protobuf import resolving. The body here is pure framing
 * and google.rpc.Status encoding, which is why encodeBinaryError lives in
 * memos-compat/proto-wire.ts rather than behind the loader.
 */
export function connectErrorForTransport(
  c: ConnectContext,
  transport: BinaryTransport | undefined,
  code: string,
  message: string,
  status: 400 | 401 | 403 | 404 | 409 | 415 | 429 | 500 | 501,
) {
  if (!transport) return connectError(c, code, message, status);
  const headers = new Headers({
    "cache-control": "no-store",
    "content-type": binaryContentType(transport),
    "grpc-message": encodeURIComponent(message),
    "grpc-status": String(grpcStatusForCode(code)),
  });
  return new Response(
    encodeBinaryError(message, transport, grpcStatusForCode(code)),
    {
      status,
      headers,
    },
  );
}

/**
 * Single Connect error envelope: picks the JSON or binary representation
 * from the transport and maps the classified error onto it. Both the legacy
 * connectDomainError and connectBinaryError paths used to re-implement this
 * mapping, and the binary copy silently demoted HTTP 429 to 400 — the
 * resource_exhausted status now survives the binary path like it always did
 * on JSON.
 */
export function connectErrorFrom(
  c: ConnectContext,
  error: unknown,
  transport?: BinaryTransport,
) {
  const status = connectStatusForError(error);
  const code =
    error instanceof CompatValidationError || error instanceof ProtoCodecError
      ? "invalid_argument"
      : isDomainError(error)
        ? domainCode(status)
        : "internal";
  const message =
    error instanceof CompatValidationError ||
    error instanceof ProtoCodecError ||
    isDomainError(error)
      ? error.message
      : "Internal error";
  if (transport) {
    return connectErrorForTransport(c, transport, code, message, status);
  }
  return connectError(c, code, message, status);
}

function connectStatusForError(error: unknown) {
  if (isDomainError(error)) {
    const status = error.status;
    return (
      status === 401 ||
      status === 403 ||
      status === 404 ||
      status === 409 ||
      status === 429
        ? status
        : status >= 500
          ? 500
          : 400
    ) as 400 | 401 | 403 | 404 | 409 | 415 | 429 | 500 | 501;
  }
  if (
    error instanceof CompatValidationError ||
    error instanceof ProtoCodecError
  ) {
    return 400;
  }
  return 500;
}

function binaryContentType(transport: BinaryTransport) {
  if (transport === "connect-proto") return "application/proto";
  if (transport === "grpc-proto") return "application/grpc+proto";
  if (transport === "grpc-web-proto") return "application/grpc-web+proto";
  return "application/grpc-web-text+proto";
}

function grpcStatusForCode(code: string) {
  switch (code) {
    case "invalid_argument":
      return 3;
    case "unauthenticated":
      return 16;
    case "permission_denied":
      return 7;
    case "not_found":
      return 5;
    case "already_exists":
      return 6;
    case "unimplemented":
      return 12;
    default:
      return 13;
  }
}

function domainCode(status: number) {
  if (status === 401) return "unauthenticated";
  if (status === 403) return "permission_denied";
  if (status === 404) return "not_found";
  if (status === 409) return "already_exists";
  if (status === 429) return "resource_exhausted";
  return "invalid_argument";
}
