/**
 * Memos protobuf transport boundary.
 *
 * Every upstream service/method encodes and decodes through the generated
 * `@bufbuild/protobuf` descriptor runtime in memos-generated/ (protoc-gen-es
 * from the pinned upstream Memos proto snapshot), so oneof, timestamps,
 * enums, repeated fields, int64, bytes, and optional fields all follow the
 * official upstream schema for both the protobuf-JSON and the binary
 * (Connect proto / gRPC / gRPC-Web / gRPC-Web-text) transports.
 *
 * The generated set already covers every method the Worker serves, including
 * the canonical `GetMemoByShare` request (field 1 = share_id); FlareMo's
 * historical `GetSharedMemo` alias dispatches to the same canonical request
 * schema, so no hand-written message codec remains.
 *
 * The wire-level primitives (framing, base64) live in
 * memos-compat/proto-wire.ts.
 */

import type { DescMessage, JsonValue } from "@bufbuild/protobuf";
import { fromBinary, fromJson, toBinary, toJson } from "@bufbuild/protobuf";
import {
  type BinaryTransport,
  decodeBase64,
  decodeGrpcUnaryFrame,
  decodeGrpcWebUnaryResponse,
  encodeBase64,
  encodeGrpcUnaryFrame,
  encodeGrpcWebResponse,
  ProtoCodecError,
  type ProtoMessage,
} from "./memos-compat/proto-wire";
import { AIService } from "./memos-generated/api/v1/ai_service_pb";
import { AttachmentService } from "./memos-generated/api/v1/attachment_service_pb";
import { AuthService } from "./memos-generated/api/v1/auth_service_pb";
import { IdentityProviderService } from "./memos-generated/api/v1/idp_service_pb";
import { InstanceService } from "./memos-generated/api/v1/instance_service_pb";
import { MemoService } from "./memos-generated/api/v1/memo_service_pb";
import { ShortcutService } from "./memos-generated/api/v1/shortcut_service_pb";
import { UserService } from "./memos-generated/api/v1/user_service_pb";

type GeneratedUnaryMethod = {
  input: DescMessage;
  output: DescMessage;
  methodKind: string;
};

type GeneratedService = {
  method: Record<string, GeneratedUnaryMethod>;
};

const generatedServices: Record<string, GeneratedService> = {
  "memos.api.v1.AIService": AIService,
  "memos.api.v1.AttachmentService": AttachmentService,
  "memos.api.v1.AuthService": AuthService,
  "memos.api.v1.IdentityProviderService": IdentityProviderService,
  "memos.api.v1.InstanceService": InstanceService,
  "memos.api.v1.MemoService": MemoService,
  "memos.api.v1.ShortcutService": ShortcutService,
  "memos.api.v1.UserService": UserService,
};

export type { BinaryTransport, ProtoMessage } from "./memos-compat/proto-wire";
export {
  detectBinaryTransport,
  encodeBinaryError,
  ProtoCodecError,
} from "./memos-compat/proto-wire";

/**
 * Normalize a handler response to the canonical protobuf-JSON shape.
 *
 * The domain handlers keep the historical oneof representation
 * (`{ case, value }`) internally. The generated runtime and upstream Memos
 * clients use the protobuf-JSON representation (`{ generalSetting: {...} }`).
 * Running the value through the generated descriptor makes the boundary
 * validate field names and apply the official enum, timestamp, int64, bytes,
 * and oneof rules for both JSON and binary transports.
 */
export function normalizeMemosJsonResponse(
  service: string,
  method: string,
  value: unknown,
): unknown {
  const descriptor = getGeneratedUnaryMethod(service, method);
  if (!descriptor) {
    return toProtoJsonValue(value);
  }

  try {
    const canonical = toCanonicalProtoJsonValue(value);
    // Validate through the generated schema, but return the canonical input
    // rather than toJson's default-omitting output. The existing FlareMo
    // Connect facade deliberately includes selected default-valued fields
    // such as `needsSetup: false`, and omitting them would be a needless
    // compatibility regression for JSON clients.
    fromJson(descriptor.output, canonical);
    return canonical;
  } catch (error) {
    throw new ProtoCodecError(
      `Failed to normalize generated protobuf JSON response for ${service}/${method}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function decodeBinaryRequest(
  service: string,
  method: string,
  input: Uint8Array,
  transport: BinaryTransport,
) {
  const payload =
    transport === "connect-proto"
      ? input
      : decodeGrpcUnaryFrame(
          transport === "grpc-web-text-proto" ? decodeBase64(input) : input,
        );
  const descriptor = getGeneratedUnaryMethod(service, method);
  if (descriptor) return decodeGeneratedMessage(descriptor.input, payload);
  throw new ProtoCodecError(
    `Unsupported protobuf service or method: ${service}/${method}`,
  );
}

export function encodeBinaryResponse(
  service: string,
  method: string,
  value: unknown,
  transport: BinaryTransport,
): Uint8Array | string {
  const payload = encodeResponseMessage(service, method, value);
  if (transport === "connect-proto") return payload;
  const framed =
    transport === "grpc-web-proto" || transport === "grpc-web-text-proto"
      ? encodeGrpcWebResponse(payload, 0)
      : encodeGrpcUnaryFrame(payload);
  return transport === "grpc-web-text-proto" ? encodeBase64(framed) : framed;
}

/**
 * Decode a unary response with the same wire framing rules used by the
 * Worker. This is intentionally exported for contract tests and local
 * compatibility probes; request handlers never need to decode their own
 * response. Keeping the inverse here makes binary tests assert message
 * fields, rather than only checking that a response contains some text.
 */
export function decodeBinaryResponse(
  service: string,
  method: string,
  input: Uint8Array,
  transport: BinaryTransport,
): ProtoMessage {
  const payload =
    transport === "connect-proto"
      ? input
      : transport === "grpc-web-proto" || transport === "grpc-web-text-proto"
        ? decodeGrpcWebUnaryResponse(
            transport === "grpc-web-text-proto" ? decodeBase64(input) : input,
          )
        : decodeGrpcUnaryFrame(input);
  const descriptor = getGeneratedUnaryMethod(service, method);
  if (descriptor) return decodeGeneratedMessage(descriptor.output, payload);
  throw new ProtoCodecError(
    `Unsupported protobuf service or method: ${service}/${method}`,
  );
}

function encodeResponseMessage(
  service: string,
  method: string,
  value: unknown,
): Uint8Array {
  const descriptor = getGeneratedUnaryMethod(service, method);
  if (!descriptor) {
    throw new ProtoCodecError(
      `Unsupported protobuf service or method: ${service}/${method}`,
    );
  }
  try {
    const message = fromJson(
      descriptor.output,
      toCanonicalProtoJsonValue(value),
    );
    return toBinary(descriptor.output, message);
  } catch (error) {
    throw new ProtoCodecError(
      `Failed to encode generated protobuf response for ${service}/${method}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function getGeneratedUnaryMethod(
  service: string,
  method: string,
): GeneratedUnaryMethod | undefined {
  const serviceDescriptor = generatedServices[service];
  if (!serviceDescriptor) return undefined;
  const localName = method.charAt(0).toLowerCase() + method.slice(1);
  const descriptor = serviceDescriptor.method[localName];
  return descriptor?.methodKind === "unary" ? descriptor : undefined;
}

export function decodeGeneratedMessage(
  descriptor: DescMessage,
  payload: Uint8Array,
): ProtoMessage {
  try {
    const json = toJson(descriptor, fromBinary(descriptor, payload));
    if (!isProtoMessage(json)) {
      throw new Error("generated protobuf JSON value is not an object");
    }
    return json;
  } catch (error) {
    throw new ProtoCodecError(
      `Failed to decode generated protobuf message: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function toProtoJsonValue(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return encodeBase64Bytes(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (Array.isArray(value)) {
    return value.map((item) => toProtoJsonValue(item));
  }
  if (typeof value === "object") {
    const object: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) object[key] = toProtoJsonValue(item);
    }
    return object;
  }
  return null;
}

function toCanonicalProtoJsonValue(value: unknown): JsonValue {
  return canonicalizeLegacyOneof(toProtoJsonValue(value));
}

function canonicalizeLegacyOneof(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeLegacyOneof(item));
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, JsonValue>;
    if (
      typeof record.case === "string" &&
      record.case.length > 0 &&
      Object.hasOwn(record, "value")
    ) {
      return {
        [record.case]: canonicalizeLegacyOneof(record.value ?? null),
      };
    }
    const result: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(record)) {
      if (
        key === "value" &&
        item &&
        typeof item === "object" &&
        !Array.isArray(item) &&
        typeof (item as Record<string, JsonValue>).case === "string" &&
        Object.hasOwn(item, "value")
      ) {
        const oneof = item as Record<string, JsonValue>;
        result[oneof.case as string] = canonicalizeLegacyOneof(
          oneof.value ?? null,
        );
        continue;
      }
      result[key] = canonicalizeLegacyOneof(item);
    }
    return result;
  }
  return value;
}

function isProtoMessage(value: unknown): value is ProtoMessage {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function encodeBase64Bytes(input: Uint8Array) {
  let binary = "";
  for (const byte of input) binary += String.fromCharCode(byte);
  return btoa(binary);
}
