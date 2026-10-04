/**
 * Wire-level primitives shared by the Memos compatibility codecs.
 *
 * The upstream request/response messages are encoded and decoded through the
 * generated @bufbuild/protobuf runtime in memos-generated/ (see
 * memos-protobuf.ts). Only the transports that the generated runtime does not
 * cover remain hand-written here: the media-type gate that selects a binary
 * transport, the Connect/gRPC/gRPC-Web unary framing, the base64 helpers used
 * by the framed transports, the google.rpc.Status body writer used for Connect
 * binary errors, and the trailer-only frame for gRPC-Web application errors.
 * The wire format produced and accepted here is part of the Memos client
 * contract — one byte changed here is a compatibility regression, so treat
 * edits as wire-format changes.
 *
 * This module deliberately has no imports at all. The request handlers reach
 * it statically, so anything it pulled in would be pinned into the isolate
 * startup graph; the generated descriptor runtime instead stays behind the
 * dynamic import in routes/memos-connect/protobuf-loader.ts.
 */

export type ProtoMessage = Record<string, unknown>;

export type BinaryTransport =
  | "connect-proto"
  | "grpc-proto"
  | "grpc-web-proto"
  | "grpc-web-text-proto";

export class ProtoCodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtoCodecError";
  }
}

export function decodeGrpcUnaryFrame(input: Uint8Array) {
  if (input.length < 5) throw new ProtoCodecError("Truncated gRPC frame");
  const flags = input[0] ?? 255;
  if (flags !== 0)
    throw new ProtoCodecError("Compressed gRPC frames are unsupported");
  const length = new DataView(
    input.buffer,
    input.byteOffset,
    input.byteLength,
  ).getUint32(1);
  if (length !== input.length - 5)
    throw new ProtoCodecError("Expected one unary gRPC frame");
  return input.subarray(5);
}

export function encodeGrpcUnaryFrame(payload: Uint8Array) {
  const frame = new Uint8Array(payload.length + 5);
  frame[0] = 0;
  new DataView(frame.buffer).setUint32(1, payload.length);
  frame.set(payload, 5);
  return frame;
}

export function decodeGrpcWebUnaryResponse(input: Uint8Array) {
  let offset = 0;
  let data: Uint8Array | undefined;
  while (offset < input.length) {
    if (input.length - offset < 5) {
      throw new ProtoCodecError("Truncated gRPC-Web frame");
    }
    const flags = input[offset] ?? 255;
    const length = new DataView(
      input.buffer,
      input.byteOffset + offset,
      input.byteLength - offset,
    ).getUint32(1);
    offset += 5;
    if (length > input.length - offset) {
      throw new ProtoCodecError("Truncated gRPC-Web frame payload");
    }
    const payload = input.subarray(offset, offset + length);
    offset += length;

    if (flags === 0) {
      if (data) throw new ProtoCodecError("Expected one gRPC-Web data frame");
      data = payload;
      continue;
    }
    if ((flags & 0x80) !== 0) continue;
    throw new ProtoCodecError("Unsupported gRPC-Web frame flags");
  }
  return data ?? new Uint8Array();
}

export function encodeGrpcWebResponse(payload: Uint8Array, code: number) {
  return concatBytes(
    encodeGrpcWebFrame(0, payload),
    encodeGrpcWebTrailerFrame(code),
  );
}

export function encodeGrpcWebTrailerFrame(code: number, message?: string) {
  const lines = [`grpc-status: ${code}`];
  if (message) lines.push(`grpc-message: ${encodeURIComponent(message)}`);
  const payload = new TextEncoder().encode(`${lines.join("\r\n")}\r\n`);
  return encodeGrpcWebFrame(0x80, payload);
}

export function encodeGrpcWebFrame(flags: number, payload: Uint8Array) {
  const frame = new Uint8Array(payload.length + 5);
  frame[0] = flags;
  new DataView(frame.buffer).setUint32(1, payload.length);
  frame.set(payload, 5);
  return frame;
}

export function concatBytes(...values: Uint8Array[]) {
  const output = new Uint8Array(
    values.reduce((length, value) => length + value.length, 0),
  );
  let offset = 0;
  for (const value of values) {
    output.set(value, offset);
    offset += value.length;
  }
  return output;
}

/**
 * Encode a google.rpc.Status body (Connect binary error payload): field 1 =
 * int32 code, field 2 = string message. Fields with default values are
 * omitted, matching the canonical protobuf encoding.
 */
export function encodeGoogleRpcStatus(code: number, message: string) {
  const chunks: Uint8Array[] = [];
  if (code !== 0) {
    chunks.push(
      Uint8Array.from([...encodeVarint((1 << 3) | 0), ...encodeVarint(code)]),
    );
  }
  if (message) {
    const bytes = new TextEncoder().encode(message);
    chunks.push(
      Uint8Array.from([
        ...encodeVarint((2 << 3) | 2),
        ...encodeVarint(bytes.length),
      ]),
      bytes,
    );
  }
  return concatBytes(...chunks);
}

export function detectBinaryTransport(
  contentType: string,
): BinaryTransport | undefined {
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType === "application/proto") return "connect-proto";
  // Native gRPC commonly uses application/grpc while gRPC-Web uses the
  // explicit +proto subtype. Memos uses protobuf as its wire codec, so both
  // media-type forms select the same unary protobuf framing.
  if (
    mediaType === "application/grpc" ||
    mediaType === "application/grpc+proto"
  ) {
    return "grpc-proto";
  }
  if (
    mediaType === "application/grpc-web" ||
    mediaType === "application/grpc-web+proto"
  ) {
    return "grpc-web-proto";
  }
  if (
    mediaType === "application/grpc-web-text" ||
    mediaType === "application/grpc-web-text+proto"
  ) {
    return "grpc-web-text-proto";
  }
  return undefined;
}

export function encodeBinaryError(
  message: string,
  transport: BinaryTransport,
  code = 3,
) {
  // google.rpc.Status: code=1, message=2. The HTTP status and transport
  // headers remain authoritative for Connect/gRPC clients, but the body must
  // carry the same status code instead of always pretending every failure is
  // INVALID_ARGUMENT.
  const status = encodeGoogleRpcStatus(code, message);
  if (transport === "connect-proto") return status;
  // gRPC-Web application errors are carried in a trailers-only frame. A
  // protobuf google.rpc.Status data frame would be interpreted as a normal
  // response message by generated browser clients.
  const framed =
    transport === "grpc-web-proto" || transport === "grpc-web-text-proto"
      ? encodeGrpcWebTrailerFrame(code, message)
      : encodeGrpcUnaryFrame(status);
  return transport === "grpc-web-text-proto" ? encodeBase64(framed) : framed;
}

function encodeVarint(value: number) {
  const output: number[] = [];
  let current = BigInt(value);
  while (current > 127n) {
    output.push(Number((current & 127n) | 128n));
    current >>= 7n;
  }
  output.push(Number(current));
  return output;
}

export function decodeBase64(input: Uint8Array) {
  const binary = atob(new TextDecoder().decode(input).trim());
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function encodeBase64(input: Uint8Array) {
  let binary = "";
  for (const byte of input) binary += String.fromCharCode(byte);
  return btoa(binary);
}
